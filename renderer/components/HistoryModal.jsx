/**
 * v0.22.6: History modal — full audit trail for one entity.
 *
 * Opens from the "History" button in the product side panel and from
 * any future caller that wants per-entity history (brands, categories,
 * etc.). Lists every recorded edit, newest first, with:
 *   - relative time + absolute timestamp tooltip
 *   - editor name (or "Server admin" if NULL user)
 *   - action label
 *   - for updates: a small "before → after" diff for each changed field
 *
 * For products we also surface image events (add/remove/set-main/reorder)
 * in the same feed — server-side `audit:listForEntity` interleaves
 * `entity_type='image' AND entity_id=<productId>` rows automatically.
 *
 * Standalone Macs and server-admin renderers will see edits attributed
 * to "Server admin" because the audit log stores NULL user for any
 * non-client-RPC mutation. Client-mode users get proper names via the
 * `attributionUsers` map.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from './ui.jsx';
import { useAppStore } from '../store/index.js';
import { formatDateTime, timeAgo } from '../lib/format.js';

// Human-readable label for an audit row's action. Falls back to the raw
// action string if we don't have a friendlier name — keeps the modal
// useful on future actions added without a UI update.
const ACTION_LABELS = {
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  'bulk-update': 'Bulk edited',
  'image:add': 'Added image',
  'image:remove': 'Removed image',
  'image:set-main': 'Set as main image',
  'image:reorder': 'Reordered images',
  'image:promote': 'Promoted AI variant',
};
function actionLabel(action) { return ACTION_LABELS[action] ?? action; }

// Field labels: convert camelCase → "Title Case". Kept tiny — the audit
// table only has product/brand/category fields, all of which are
// straightforward to humanize.
function fieldLabel(key) {
  if (!key) return '';
  // Special cases that don't humanize cleanly.
  const SPECIAL = {
    sku: 'SKU',
    brandId: 'Brand',
    categoryId: 'Category',
    colorFinish: 'Color / Finish',
    priceRetail: 'Retail price',
    priceWholesale: 'Wholesale price',
    // v0.1.80: a change to any custom price group is recorded as one `prices`
    // map (main/db/products.js), so without this the drawer said "Prices" and
    // printed a JSON blob — useless for "who changed the VIP price?".
    prices: 'Price groups',
    processStatus: 'Process status',
    secondaryCode: 'Secondary code',
  };
  if (SPECIAL[key]) return SPECIAL[key];
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());
}

/* v0.1.80: a price-group map, readable. `prices` arrives as
 * `{ vip: { amount, currency } }` (or a bare number on rows written before
 * v0.1.55), so render "VIP 1,234.50 USD" per group instead of JSON. Labels come
 * from the company's own groups when they are loaded, falling back to the key. */
function priceGroupsText(map, labelFor) {
  if (!map || typeof map !== 'object') return null;
  const parts = [];
  for (const [key, raw] of Object.entries(map)) {
    const amount = (raw && typeof raw === 'object') ? raw.amount : raw;
    const currency = (raw && typeof raw === 'object') ? raw.currency : null;
    if (amount == null || amount === '') continue;
    parts.push(`${labelFor(key)} ${amount}${currency ? ` ${currency}` : ''}`);
  }
  return parts.length ? parts.join(', ') : null;
}

// Compact JSON-ish display of a single field value. Strings stay as-is;
// arrays/objects get JSON.stringify'd but truncated; null shows as "—".
function displayValue(v) {
  if (v == null || v === '') return <span className="muted">—</span>;
  if (typeof v === 'string') {
    if (v.length > 80) return <span title={v}>{v.slice(0, 77)}…</span>;
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    if (s.length > 80) return <span title={s}>{s.slice(0, 77)}…</span>;
    return s;
  } catch { return String(v); }
}

function displayField(key, value, groupLabel) {
  if (key === 'prices') {
    const text = priceGroupsText(value, groupLabel || ((k) => k));
    if (text) return text;
  }
  return displayValue(value);
}

function UpdateDiff({ before, after, groupLabel }) {
  const keys = Array.from(new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]));
  if (keys.length === 0) return null;
  return (
    <ul className="history-row__diff">
      {keys.map((key) => (
        <li key={key} className="history-row__diff-row">
          <span className="history-row__diff-field">{fieldLabel(key)}:</span>
          <span className="history-row__diff-before">{displayField(key, before?.[key], groupLabel)}</span>
          <span className="history-row__diff-arrow" aria-hidden>→</span>
          <span className="history-row__diff-after">{displayField(key, after?.[key], groupLabel)}</span>
        </li>
      ))}
    </ul>
  );
}

function CreateOrDeleteSnapshot({ payload, mode, groupLabel }) {
  // For creates: show the after-snapshot as a small key/value list.
  // For deletes: same but with the before-snapshot. Both are best-effort
  // — the underlying db modules only store a handful of fields to keep
  // log rows compact, so we just iterate whatever's there.
  if (!payload || typeof payload !== 'object') return null;
  const keys = Object.keys(payload);
  if (keys.length === 0) return null;
  return (
    <ul className={`history-row__snapshot history-row__snapshot--${mode}`}>
      {keys.map((key) => (
        <li key={key}>
          <span className="history-row__snapshot-field">{fieldLabel(key)}:</span>
          <span>{displayField(key, payload[key], groupLabel)}</span>
        </li>
      ))}
    </ul>
  );
}

function ImageEventBody({ action, after }) {
  // Image events store a single { filename } payload (or { count } for
  // reorder). Render a one-liner; no diff needed.
  if (!after) return null;
  if (action === 'image:reorder') {
    return <div className="history-row__image">Reordered {after.count ?? '?'} images</div>;
  }
  if (after.filename) {
    return <div className="history-row__image">{after.filename}</div>;
  }
  return null;
}

function HistoryRow({ entry }) {
  const attributionUsers = useAppStore((s) => s.attributionUsers);
  const companies = useAppStore((s) => s.companies);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  // v0.1.80: a price-group change reads as the group's own label when we can
  // find it, so the drawer answers "who changed the VIP price?" in words.
  const groupLabel = useCallback((key) => {
    const groups = (companies ?? []).find((c) => c.id === activeCompanyId)?.priceGroups ?? [];
    return groups.find((g) => g.key === key)?.label || key;
  }, [companies, activeCompanyId]);
  const name = entry.userId
    ? (attributionUsers?.[entry.userId] ?? 'Unknown user')
    : 'Server admin';
  const isImage = entry.action.startsWith('image:');
  const tip = formatDateTime(entry.createdAt);
  return (
    <li className="history-row" data-action={entry.action}>
      <div className="history-row__head">
        <span className="history-row__action">{actionLabel(entry.action)}</span>
        <span className="history-row__by">by <strong>{name}</strong></span>
        <span className="history-row__when" title={tip}>{timeAgo(entry.createdAt)}</span>
      </div>
      {entry.action === 'update' ? (
        <UpdateDiff before={entry.before} after={entry.after} groupLabel={groupLabel} />
      ) : entry.action === 'create' ? (
        <CreateOrDeleteSnapshot payload={entry.after} mode="create" groupLabel={groupLabel} />
      ) : entry.action === 'delete' ? (
        <CreateOrDeleteSnapshot payload={entry.before} mode="delete" groupLabel={groupLabel} />
      ) : isImage ? (
        <ImageEventBody action={entry.action} after={entry.after} />
      ) : null}
    </li>
  );
}

export function HistoryModal({ open, onClose, entityType, entityId, title }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !entityType || !entityId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      window.api.audit.listForEntity(entityType, entityId, 200),
      window.api.audit.countForEntity(entityType, entityId),
    ])
      .then(([list, n]) => {
        if (cancelled) return;
        setEntries(Array.isArray(list) ? list : []);
        setTotal(Number(n) || 0);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, entityType, entityId]);

  const headerLabel = useMemo(() => {
    if (!entries.length) return null;
    return `Showing ${entries.length} of ${total}`;
  }, [entries.length, total]);

  return (
    <Modal open={open} onClose={onClose} title={title || 'Edit history'} size="lg">
      <div className="history">
        {loading ? (
          <p className="muted">Loading history…</p>
        ) : error ? (
          <p className="history__error">{error}</p>
        ) : entries.length === 0 ? (
          <p className="muted">
            No history recorded yet. Edit attribution started in v0.15.3; the
            full audit trail starts from v0.22.6. Anything done before that
            won&apos;t show up here.
          </p>
        ) : (
          <>
            {headerLabel ? (
              <p className="history__counter muted">{headerLabel}</p>
            ) : null}
            <ul className="history__list">
              {entries.map((e) => <HistoryRow key={e.id} entry={e} />)}
            </ul>
            {total > entries.length ? (
              <p className="history__cap muted">
                Older events are kept on disk but not shown here. Reach out if
                you need them — they can be pulled directly from
                <code> &lt;dataDir&gt;/database.sqlite </code>(<code>audit_log</code> table).
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
