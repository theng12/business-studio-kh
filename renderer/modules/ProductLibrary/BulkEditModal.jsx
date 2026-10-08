/**
 * v0.18.1: BulkEditModal — set the same fields on many products at
 * once. Used by the Library's "Edit selected (N)" toolbar action.
 *
 * Each field has a leading checkbox: only checked fields are
 * included in the patch sent to the server. This lets the user
 * change ONLY the brand without accidentally blanking the category
 * by leaving the dropdown at its default. Clear semantics:
 *   - field unchecked → that field is left untouched on every row
 *   - field checked + value set → that value applied to every row
 *   - field checked + value cleared (empty option) → set to NULL
 *     on every row (intentional "clear this field" workflow)
 *
 * 0.1.94: the two "Retail / Wholesale price" rows became one Price row —
 * pick retail, wholesale or a company price group, then Set it, or raise or
 * lower it by a percentage (rounded: USD to 0.05, KHR to 100), with a
 * three-product before → after preview. The arithmetic is in bulkPriceEdit.js;
 * the write is one bulkUpsert (overwrite, keyed by SKU, only that price field),
 * dry-run first so a SKU that changed elsewhere can never create a product.
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Select, Input, Textarea } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { formatPriceEntry } from '../../lib/prices.js';
import { PRICE_MODES, buildPriceRows, parsePriceInput, priceChangeFor } from './bulkPriceEdit.js';

const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'draft',    label: 'Draft' },
];

const INITIAL_ENABLED = {
  brandId: false, categoryId: false, status: false,
  subcategory: false, colorFinish: false, variant: false, unit: false,
  price: false, description: false,
};
const INITIAL_VALUES = {
  brandId: '', categoryId: '', status: 'active',
  subcategory: '', colorFinish: '', variant: '', unit: '',
  description: '',
};
const INITIAL_PRICE = { source: 'retail', mode: 'set', value: '' };

export function BulkEditModal({ open, count, productIds, onClose, onDone }) {
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const companies = useAppStore((s) => s.companies);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);

  // Per-field "include in patch" toggles + current values.
  const [enabled, setEnabled] = useState(INITIAL_ENABLED);
  const [values, setValues] = useState(INITIAL_VALUES);
  const [price, setPrice] = useState(INITIAL_PRICE);
  const [saving, setSaving] = useState(false);

  // Start clean each time it opens: a stale ticked field is how a second
  // bulk edit overwrites something the user did not mean to touch.
  useEffect(() => {
    if (!open) return;
    setEnabled(INITIAL_ENABLED);
    setValues(INITIAL_VALUES);
    setPrice(INITIAL_PRICE);
  }, [open]);

  const priceGroups = useMemo(
    () => (companies || []).find((c) => c.id === activeCompanyId)?.priceGroups ?? [],
    [companies, activeCompanyId],
  );
  const priceSources = useMemo(() => [
    { value: 'retail', label: 'Retail price' },
    { value: 'wholesale', label: 'Wholesale price' },
    ...priceGroups.filter((g) => g && g.key).map((g) => ({ value: g.key, label: g.label || g.key })),
  ], [priceGroups]);

  /** The selected products, from the store (the freshest copy of each). */
  const selectedProducts = useMemo(() => {
    if (!open) return [];
    const state = useAppStore.getState();
    const byId = new Map();
    for (const p of state.allProducts ?? []) byId.set(p.id, p);
    for (const p of state.products ?? []) byId.set(p.id, p);
    return (productIds ?? []).map((id) => byId.get(id)).filter(Boolean);
  }, [open, productIds]);

  const parsedPrice = parsePriceInput(price.mode, price.value);
  const priceOpts = parsedPrice.ok ? { source: price.source, mode: price.mode, value: parsedPrice.value } : null;
  const pricePreview = useMemo(() => {
    if (!enabled.price || !priceOpts) return { rows: [], changed: 0 };
    const rows = [];
    let changed = 0;
    for (const p of selectedProducts) {
      const change = priceChangeFor(p, priceOpts);
      if (!change) continue;
      changed += 1;
      if (rows.length < 3) rows.push({ id: p.id, sku: p.sku, ...change });
    }
    return { rows, changed };
    // priceOpts is rebuilt every render; its three parts are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled.price, selectedProducts, price.source, price.mode, parsedPrice.ok, parsedPrice.value]);

  function setField(key, val) {
    setValues((v) => ({ ...v, [key]: val }));
  }
  function toggleField(key) {
    setEnabled((e) => ({ ...e, [key]: !e[key] }));
  }

  function buildPatch() {
    const patch = {};
    if (enabled.brandId)     patch.brandId      = values.brandId || null;
    if (enabled.categoryId)  patch.categoryId   = values.categoryId || null;
    if (enabled.status)      patch.status       = values.status;
    if (enabled.subcategory) patch.subcategory  = values.subcategory.trim() || null;
    if (enabled.colorFinish) patch.colorFinish  = values.colorFinish.trim() || null;
    if (enabled.variant)     patch.variant      = values.variant.trim() || null;
    if (enabled.unit)        patch.unit         = values.unit.trim() || null;
    if (enabled.description) patch.description  = values.description.trim() || null;
    return patch;
  }

  /** Write the price change. Returns the number of products changed. */
  async function applyPrice() {
    /* Compute from the products as they are NOW, not as the store had them
     * when the modal opened: a percentage applied to a price that another Mac
     * changed meanwhile would overwrite that edit. Each row also carries the
     * fresh `expectedUpdatedAt`, so a change landing between this read and
     * the write is skipped by the server (reported below) instead of lost. */
    const fresh = await window.api.products.list(activeCompanyId, {});
    const freshById = new Map((Array.isArray(fresh) ? fresh : []).map((p) => [p.id, p]));
    const current = (productIds ?? []).map((id) => freshById.get(id)).filter(Boolean);
    const { rows } = buildPriceRows(current, priceOpts);
    if (rows.length === 0) return 0;
    const dry = await window.api.products.bulkUpsert(activeCompanyId, rows, { conflictPolicy: 'overwrite', dryRun: true });
    const unsafe = (dry?.changes ?? []).find((c) => c && c.action !== 'update' && c.action !== 'no_change');
    if (unsafe) {
      throw new Error(`Prices not changed — ${unsafe.sku || 'a product'} ${unsafe.action === 'insert' ? 'no longer has that SKU (it changed elsewhere)' : unsafe.reason || 'could not be updated'}. Refresh and try again.`);
    }
    const live = await window.api.products.bulkUpsert(activeCompanyId, rows, { conflictPolicy: 'overwrite', dryRun: false });
    const conflicts = (live?.skips ?? []).filter((sk) => sk?.category === 'conflict');
    if (conflicts.length > 0) {
      addToast(`${conflicts.length} price${conflicts.length === 1 ? ' was' : 's were'} not changed — ${conflicts[0].sku || 'a product'} ${conflicts[0].reason}. Refresh and try again.`, 'info');
    }
    return live?.updated ?? rows.length;
  }

  async function handleApply() {
    const patch = buildPatch();
    if (Object.keys(patch).length === 0 && !enabled.price) {
      addToast('Tick at least one field to apply.', 'info');
      return;
    }
    if (enabled.price && !parsedPrice.ok) {
      addToast(parsedPrice.reason, 'info');
      return;
    }
    setSaving(true);
    try {
      const parts = [];
      let failed = 0;
      if (Object.keys(patch).length > 0) {
        const result = await window.api.products.bulkUpdate(productIds, patch);
        failed += result?.failed?.length ?? 0;
        parts.push(`updated ${result.updated} product${result.updated === 1 ? '' : 's'}`);
      }
      if (enabled.price) {
        const changed = await applyPrice();
        const label = priceSources.find((s) => s.value === price.source)?.label?.toLowerCase() ?? 'price';
        parts.push(changed === 0 ? `no ${label} needed changing` : `changed the ${label} of ${changed}`);
      }
      const text = parts.join(' · ');
      const sentence = text.charAt(0).toUpperCase() + text.slice(1);
      addToast(failed === 0 ? `${sentence}.` : `${sentence} — ${failed} failed.`, failed === 0 ? 'success' : 'info');
      // Refresh the Library list so the changes show up.
      useAppStore.getState().refreshProducts();
      useAppStore.getState().refreshAllProducts?.();
      onDone?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const anyEnabled = Object.values(enabled).some(Boolean);
  const priceInputLabel = price.mode === 'set' ? 'New price (blank clears it)' : 'Percent';

  return (
    <Modal
      open={open}
      title={`Bulk edit · ${count} product${count === 1 ? '' : 's'}`}
      onClose={onClose}
      busy={saving}
    >
      <div className="bulk-edit">
        <p className="bulk-edit__intro">
          Tick the fields you want to apply to all {count} selected products. Unchecked fields are
          left untouched. Setting a value to <em>(blank)</em> clears that field on every selected row.
        </p>

        <BulkRow label="Brand" enabled={enabled.brandId} onToggle={() => toggleField('brandId')}>
          <Select value={values.brandId} onChange={(e) => setField('brandId', e.target.value)} disabled={!enabled.brandId}>
            <option value="">— Unassigned —</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </BulkRow>

        <BulkRow label="Category" enabled={enabled.categoryId} onToggle={() => toggleField('categoryId')}>
          <Select value={values.categoryId} onChange={(e) => setField('categoryId', e.target.value)} disabled={!enabled.categoryId}>
            <option value="">— Unassigned —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </BulkRow>

        <BulkRow label="Status" enabled={enabled.status} onToggle={() => toggleField('status')}>
          <Select value={values.status} onChange={(e) => setField('status', e.target.value)} disabled={!enabled.status}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </BulkRow>

        <BulkRow label="Color / Finish" enabled={enabled.colorFinish} onToggle={() => toggleField('colorFinish')}>
          <Input value={values.colorFinish} onChange={(e) => setField('colorFinish', e.target.value)} disabled={!enabled.colorFinish} />
        </BulkRow>

        <BulkRow label="Variant" enabled={enabled.variant} onToggle={() => toggleField('variant')}>
          <Input value={values.variant} onChange={(e) => setField('variant', e.target.value)} disabled={!enabled.variant} />
        </BulkRow>

        <BulkRow label="Unit" enabled={enabled.unit} onToggle={() => toggleField('unit')}>
          <Input value={values.unit} onChange={(e) => setField('unit', e.target.value)} disabled={!enabled.unit} />
        </BulkRow>

        <BulkRow label="Subcategory" enabled={enabled.subcategory} onToggle={() => toggleField('subcategory')}>
          <Input value={values.subcategory} onChange={(e) => setField('subcategory', e.target.value)} disabled={!enabled.subcategory} />
        </BulkRow>

        <BulkRow label="Price" enabled={enabled.price} onToggle={() => toggleField('price')}>
          <div className="bulk-edit__price">
            <div className="bulk-edit__price-row">
              <Select
                aria-label="Which price"
                value={price.source}
                onChange={(e) => setPrice((p) => ({ ...p, source: e.target.value }))}
                disabled={!enabled.price}
              >
                {priceSources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
              <div className="segments" role="radiogroup" aria-label="How to change the price">
                {PRICE_MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={price.mode === m.value}
                    className={`segment${price.mode === m.value ? ' is-active' : ''}`}
                    disabled={!enabled.price}
                    onClick={() => setPrice((p) => ({ ...p, mode: m.value, value: '' }))}
                  >{m.label}</button>
                ))}
              </div>
              <Input
                type="number"
                min="0"
                step="any"
                aria-label={priceInputLabel}
                placeholder={price.mode === 'set' ? 'Blank clears it' : 'e.g. 10'}
                value={price.value}
                onChange={(e) => setPrice((p) => ({ ...p, value: e.target.value }))}
                disabled={!enabled.price}
                className="bulk-edit__price-input"
              />
              {price.mode !== 'set' ? <span className="muted">%</span> : null}
            </div>
            {enabled.price ? (
              <div className="bulk-edit__price-preview" aria-live="polite">
                {!parsedPrice.ok && price.value !== '' ? (
                  <span className="muted">{parsedPrice.reason}</span>
                ) : pricePreview.changed === 0 ? (
                  <span className="muted">
                    {price.mode === 'set' ? 'No product would change.' : 'No selected product has this price yet, so there is nothing to raise or lower.'}
                  </span>
                ) : (
                  <>
                    <ul className="bulk-edit__price-list">
                      {pricePreview.rows.map((r) => (
                        <li key={r.id}>
                          <span className="bulk-edit__price-sku">{r.sku}</span>
                          <span>{formatPriceEntry(r.before) || '—'}</span>
                          <span aria-hidden>→</span>
                          <span className="bulk-edit__price-after">{formatPriceEntry(r.after) || 'cleared'}</span>
                        </li>
                      ))}
                    </ul>
                    <span className="muted">
                      {pricePreview.changed} of {selectedProducts.length} product{selectedProducts.length === 1 ? '' : 's'} change.
                      {price.mode !== 'set' ? ' Rounded: USD to 0.05, KHR to 100. Products with no price are left alone.' : ''}
                    </span>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </BulkRow>

        <BulkRow label="Description" enabled={enabled.description} onToggle={() => toggleField('description')}>
          <Textarea rows={3} value={values.description} onChange={(e) => setField('description', e.target.value)} disabled={!enabled.description} />
        </BulkRow>

        <footer className="bulk-edit__footer">
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            disabled={!anyEnabled || saving || (enabled.price && !parsedPrice.ok)}
            onClick={handleApply}
          >
            {saving ? 'Applying…' : `Apply to ${count}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

function BulkRow({ label, enabled, onToggle, children }) {
  return (
    <div className={`bulk-edit__row${enabled ? ' is-enabled' : ''}`}>
      <label className="bulk-edit__toggle">
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        <span>{label}</span>
      </label>
      <div className="bulk-edit__value">{children}</div>
    </div>
  );
}
