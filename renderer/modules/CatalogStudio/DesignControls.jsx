import { useMemo } from 'react';
import { Input, Select } from '../../components/ui.jsx';
import { CATALOG_THEMES } from './catalogThemes.js';
import { CATALOG_FIELD_KEYS, catalogFieldRows } from '../../lib/catalogDesign.js';
import { useAppStore } from '../../store/index.js';
import { extraFieldRows } from './catalogSelection.js';

/**
 * v0.1.63: the catalog design controls, in ONE place.
 *
 * These controls used to live inline in the project editor's "Layout & design"
 * tab. The customer's complaint was that a catalog template could not be built
 * at all, so the same controls now back the template builder — and the way to
 * keep them honest is to have exactly one copy: a builder that drifts from the
 * editor would produce templates that do not look like what they promised.
 *
 * Cover title/subtitle are content, not design, so they are only rendered when
 * the caller passes handlers for them (the project editor does, the template
 * builder does not).
 */
export function DesignControls({ config, onChange, priceGroups = [], coverTitle = null, coverSubtitle = null }) {
  const c = config || {};
  const products = useAppStore((s) => s.products);
  const extras = useMemo(() => extraFieldRows(priceGroups, products ?? []), [priceGroups, products]);
  const baseRows = catalogFieldRows(c.fields);
  const fields = [...baseRows, ...extras.filter((x) => !baseRows.some((f) => f.key === x.key))];
  const included = new Set((c.fields || []).map((f) => f.key));
  const includedOrder = (c.fields || []).map((f) => f.key);

  /** Toggle a field on/off, keeping the config's own order and per-field flags. */
  function toggleField(key, on) {
    const current = Array.isArray(c.fields) ? c.fields : [];
    if (on) {
      if (current.some((f) => f.key === key)) return;
      onChange({ fields: [...current, { key, label: labelFor(key), visible: true }] });
    } else {
      onChange({ fields: current.filter((f) => f.key !== key) });
    }
  }

  function patchField(key, patch) {
    const current = Array.isArray(c.fields) ? c.fields : [];
    onChange({ fields: current.map((f) => (f.key === key ? { ...f, ...patch } : f)) });
  }

  /** Move an included field one place up (-1) or down (+1) on the card. */
  function moveField(key, direction) {
    const current = Array.isArray(c.fields) ? [...c.fields] : [];
    const index = current.findIndex((f) => f.key === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    [current[index], current[target]] = [current[target], current[index]];
    onChange({ fields: current });
  }

  function labelFor(key) {
    const known = CATALOG_FIELD_KEYS.find((f) => f.key === key);
    if (known) return known.label;
    const extra = extras.find((f) => f.key === key);
    if (extra) return extra.label;
    return String(key).replace(/^(custom|price)\./, '').replace(/[_-]+/g, ' ');
  }

  return (
    <>
      <section>
        <h3>Cover</h3>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={c.coverEnabled !== false && c.cover?.enabled !== false}
            onChange={(e) => onChange({ coverEnabled: e.target.checked, cover: { ...(c.cover || {}), enabled: e.target.checked } })}
          />
          <span>Include cover page</span>
        </label>
        {coverTitle ? (
          <label>Title<Input value={c.cover?.title ?? coverTitle.value} onChange={(e) => coverTitle.onChange(e.target.value)} /></label>
        ) : null}
        {coverSubtitle ? (
          <label>Subtitle<Input value={c.cover?.subtitle ?? coverSubtitle.value} onChange={(e) => coverSubtitle.onChange(e.target.value)} /></label>
        ) : null}
        {!coverTitle ? (
          <p className="catalog-controls__note">
            The cover title and subtitle come from each catalog, so a template can be reused without renaming anything.
          </p>
        ) : null}
      </section>

      <section>
        <h3>Layout</h3>
        <div className="control-grid">
          <label>Page
            <Select value={c.pageSize || 'A4'} onChange={(e) => onChange({ pageSize: e.target.value })}>
              <option>A4</option>
              <option>Letter</option>
            </Select>
          </label>
          <label>Orientation
            <Select value={c.orientation || 'portrait'} onChange={(e) => onChange({ orientation: e.target.value })}>
              <option value="portrait">portrait</option>
              <option value="landscape">landscape</option>
            </Select>
          </label>
          <label>Columns
            <Select value={c.columns || 3} onChange={(e) => onChange({ columns: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
            </Select>
          </label>
          <label>Gap (mm)
            <Input type="number" value={c.gapMm ?? 5} onChange={(e) => onChange({ gapMm: Number(e.target.value) })} />
          </label>
          <label>Page margin (mm)
            <Input type="number" value={c.marginMm ?? 10} onChange={(e) => onChange({ marginMm: Number(e.target.value) })} />
          </label>
          <label>Group products
            <Select value={c.groupBy || 'none'} onChange={(e) => onChange({ groupBy: e.target.value })}>
              <option value="none">No grouping</option>
              <option value="category">By category</option>
              <option value="brand">By brand</option>
            </Select>
          </label>
          <label>Sort by
            <Select value={c.sortBy || 'manual'} onChange={(e) => onChange({ sortBy: e.target.value })}>
              <option value="manual">Catalog order</option>
              <option value="sku">SKU</option>
              <option value="name">Product name</option>
            </Select>
          </label>
          <label>Price group
            <Select value={c.priceGroup || 'retail'} onChange={(e) => onChange({ priceGroup: e.target.value })}>
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
              {priceGroups.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </Select>
          </label>
          <label>Currency fallback
            <Input value={c.currencySymbol || '$'} onChange={(e) => onChange({ currencySymbol: e.target.value })} placeholder="$" />
          </label>
        </div>
      </section>

      <section>
        <h3>Style</h3>
        <div className="theme-choices">
          {CATALOG_THEMES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={(c.theme || 'modern') === t.id ? 'is-active' : ''}
              onClick={() => onChange({ theme: t.id })}
            >
              <strong>{t.name}</strong>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
        <div className="control-grid">
          <label>Primary<Input type="color" value={c.primaryColor || '#111827'} onChange={(e) => onChange({ primaryColor: e.target.value })} /></label>
          <label>Accent<Input type="color" value={c.accentColor || '#6366f1'} onChange={(e) => onChange({ accentColor: e.target.value })} /></label>
        </div>
      </section>

      <section>
        <h3>Card fields</h3>
        <p className="catalog-controls__note">
          Tick what each product card prints. Included fields print in the order below — use the arrows to move them, and edit the text to rename a field's label.
        </p>
        <div className="catalog-field-list">
          {fields.map((f) => {
            const on = included.has(f.key);
            const entry = (c.fields || []).find((x) => x.key === f.key) || f;
            return (
              <div className={`catalog-field-row${on ? '' : ' is-off'}`} key={f.key}>
                <input
                  type="checkbox"
                  checked={on}
                  aria-label={`Show ${entry.label || f.label}`}
                  onChange={(e) => toggleField(f.key, e.target.checked)}
                />
                {on ? (
                  <Input
                    className="catalog-field-row__label"
                    value={entry.label ?? ''}
                    aria-label={`Label for ${f.label}`}
                    placeholder={f.label}
                    onChange={(e) => patchField(f.key, { label: e.target.value })}
                  />
                ) : <span>{entry.label || f.label}</span>}
                <label>
                  <input type="checkbox" disabled={!on} checked={!!entry.bold} onChange={(e) => patchField(f.key, { bold: e.target.checked })} /> Bold
                </label>
                <label>
                  <input type="checkbox" disabled={!on} checked={entry.showLabel !== false} onChange={(e) => patchField(f.key, { showLabel: e.target.checked })} /> Label
                </label>
                <span className="catalog-field-row__move">
                  <button type="button" aria-label={`Move ${entry.label || f.label} up`} disabled={!on || includedOrder.indexOf(f.key) <= 0} onClick={() => moveField(f.key, -1)}>↑</button>
                  <button type="button" aria-label={`Move ${entry.label || f.label} down`} disabled={!on || includedOrder.indexOf(f.key) >= includedOrder.length - 1} onClick={() => moveField(f.key, 1)}>↓</button>
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
