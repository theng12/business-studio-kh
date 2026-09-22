import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input } from '../../components/ui.jsx';

/**
 * v0.1.55: named price groups for the active company.
 *
 * This is the missing half of "custom price": the catalog/social renderers
 * have always been able to read `product.prices[priceGroup]`, but nothing ever
 * wrote that map, and there was no UI to name a group — so the feature was
 * unreachable. Groups defined here become extra amount + currency rows on the
 * product form, and can be chosen when rendering a catalog or a social post.
 *
 * `key` is derived from the label once and then kept stable, because it is
 * stored per product in `prices` and referenced by `config.priceGroup`.
 * Edits are local until committed (blur / Add / Remove) so typing a name does
 * not write a row per keystroke.
 */
function slugKey(label, taken) {
  const base = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'group';
  let key = base;
  let n = 2;
  while (taken.has(key)) { key = `${base}-${n}`; n += 1; }
  return key;
}

export function PriceGroupsPanel() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companies = useAppStore((s) => s.companies) ?? [];
  const updateCompany = useAppStore((s) => s.updateCompany);
  const addToast = useAppStore((s) => s.addToast);

  const company = companies.find((c) => c.id === activeCompanyId) || null;

  const [rows, setRows] = useState(() => company?.priceGroups ?? []);
  const [draftLabel, setDraftLabel] = useState('');
  const [busy, setBusy] = useState(false);

  // Adopt the company's stored list on first load and on company switch.
  // Kept keyed on the id so an in-progress rename is not clobbered.
  useEffect(() => {
    setRows(company?.priceGroups ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id]);

  if (!company) {
    return (
      <div className="settings-note" role="note">
        Select a company first — price groups belong to a company.
      </div>
    );
  }

  async function persist(next, message) {
    setBusy(true);
    try {
      await updateCompany(company.id, { priceGroups: next });
      if (message) addToast(message, 'success');
    } catch (err) {
      addToast(err.message, 'error');
      setRows(company.priceGroups ?? []);
    } finally {
      setBusy(false);
    }
  }

  function addGroup() {
    const label = draftLabel.trim();
    if (!label) return;
    const key = slugKey(label, new Set(rows.map((g) => g.key)));
    const next = [...rows, { key, label }];
    setRows(next);
    setDraftLabel('');
    void persist(next, `Price group “${label}” added`);
  }

  function renameGroup(key, label) {
    setRows((cur) => cur.map((g) => (g.key === key ? { ...g, label } : g)));
  }

  function commitRename() {
    void persist(rows, null);
  }

  function removeGroup(key, label) {
    const next = rows.filter((g) => g.key !== key);
    setRows(next);
    void persist(next, `Price group “${label}” removed`);
  }

  return (
    <div className="price-groups">
      <p className="settings-note" role="note">
        A price group is an extra price a product can carry — for example
        {' '}<strong>Retail</strong>, <strong>Wholesale</strong> or <strong>Export</strong>.
        Once a group exists here, every product gets an amount + currency row for it,
        and you can pick the group when rendering a catalog or a social post.
      </p>

      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5 }}>
          No price groups yet. Add one below — for example “Wholesale” or “Export”.
        </p>
      ) : (
        <ul className="price-groups__list">
          {rows.map((g) => (
            <li key={g.key} className="price-groups__row">
              <Input
                value={g.label}
                aria-label={`Rename ${g.label}`}
                onChange={(e) => renameGroup(g.key, e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <span className="price-groups__key" title="Stored key — products reference this">{g.key}</span>
              <Button variant="ghost" disabled={busy} onClick={() => removeGroup(g.key, g.label)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}

      <div className="price-groups__add">
        <Input
          value={draftLabel}
          placeholder="New price group name (e.g. Export)"
          onChange={(e) => setDraftLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } }}
        />
        <Button variant="primary" disabled={busy || !draftLabel.trim()} onClick={addGroup}>
          Add group
        </Button>
      </div>
    </div>
  );
}
