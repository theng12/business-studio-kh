import { useMemo } from 'react';
import { Field, Input, Select } from '../../components/ui.jsx';
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
      <section className="catalog-sidebar__section">
        <h3 className="section-title">Cover</h3>
        <label className="catalog-check">
          <input
            type="checkbox"
            checked={c.coverEnabled !== false && c.cover?.enabled !== false}
            onChange={(e) => onChange({ coverEnabled: e.target.checked, cover: { ...(c.cover || {}), enabled: e.target.checked } })}
          />
          <span>Include cover page</span>
        </label>
        {coverTitle ? (
          <Field label="Title">{({ id }) => <Input id={id} value={c.cover?.title ?? coverTitle.value} onChange={(e) => coverTitle.onChange(e.target.value)} />}</Field>
        ) : null}
        {coverSubtitle ? (
          <Field label="Subtitle">{({ id }) => <Input id={id} value={c.cover?.subtitle ?? coverSubtitle.value} onChange={(e) => coverSubtitle.onChange(e.target.value)} />}</Field>
        ) : null}
        {!coverTitle ? (
          <p className="catalog-sidebar__note">
            The cover title and subtitle come from each catalog, so a template can be reused without renaming anything.
          </p>
        ) : null}
      </section>

      <section className="catalog-sidebar__section">
        <h3 className="section-title">Layout</h3>
        <div className="catalog-field-grid">
          <Field label="Layout mode" span="full">
            {({ id }) => <Select id={id} value={c.layoutMode ?? 'cards'} onChange={(e) => onChange({ layoutMode: e.target.value })}>
              <option value="cards">Product cards</option>
              <option value="list">Compact price list</option>
            </Select>}
          </Field>
          <Field label="Page">
            {({ id }) => (
              <Select id={id} value={c.pageSize || 'A4'} onChange={(e) => onChange({ pageSize: e.target.value })}>
                <option>A4</option>
                <option>Letter</option>
              </Select>
            )}
          </Field>
          <Field label="Orientation">
            {({ id }) => (
              <Select id={id} value={c.orientation || 'portrait'} onChange={(e) => onChange({ orientation: e.target.value })}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            )}
          </Field>
          <Field label="Columns">
            {({ id }) => (
              <Select id={id} disabled={c.layoutMode === 'list'} value={c.columns || 3} onChange={(e) => onChange({ columns: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Gap (mm)">
            {({ id }) => <Input id={id} type="number" min={0} max={30} value={c.gapMm ?? 5} onChange={(e) => onChange({ gapMm: Number(e.target.value) })} />}
          </Field>
          <Field label="Page margin (mm)">
            {({ id }) => <Input id={id} type="number" min={0} max={40} value={c.marginMm ?? 10} onChange={(e) => onChange({ marginMm: Number(e.target.value) })} />}
          </Field>
          <Field label="Group products">
            {({ id }) => (
              <Select id={id} value={c.groupBy || 'none'} onChange={(e) => onChange({ groupBy: e.target.value })}>
                <option value="none">No grouping</option>
                <option value="category">By category</option>
                <option value="brand">By brand</option>
              </Select>
            )}
          </Field>
          <Field label="Sort by">
            {({ id }) => (
              <Select id={id} value={c.sortBy || 'manual'} onChange={(e) => onChange({ sortBy: e.target.value })}>
                <option value="manual">Catalog order</option>
                <option value="sku">SKU</option>
                <option value="name">Product name</option>
              </Select>
            )}
          </Field>
          <Field label="Price group">
            {({ id }) => (
              <Select id={id} value={c.priceGroup || 'retail'} onChange={(e) => onChange({ priceGroup: e.target.value })}>
                <option value="retail">Retail</option>
                <option value="wholesale">Wholesale</option>
                {priceGroups.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Currency fallback" hint="Used when a price has no currency of its own." span="full">
            {({ id }) => <Input id={id} value={c.currencySymbol || '$'} onChange={(e) => onChange({ currencySymbol: e.target.value })} placeholder="$" />}
          </Field>
        </div>
      </section>

      <section className="catalog-sidebar__section">
        <h3 className="section-title">Photos and text</h3>
        <label className="catalog-check">
          <input type="checkbox" aria-label="Show product photos" checked={c.showImages !== false} onChange={(e) => onChange({ showImages: e.target.checked })} />
          <span>Show product photos</span>
        </label>
        <div className="catalog-field-grid">
          <Field label="Photo height (mm)" hint="0 uses a square; fixed heights are 10–100 mm." span="full">
            {({ id }) => <Input id={id} type="number" min={0} max={100} disabled={c.showImages === false} value={c.imageHeightMm ?? 0} onChange={(e) => onChange({ imageHeightMm: Number(e.target.value) })} />}
          </Field>
          <Field label="Photo fit">
            {({ id }) => <Select id={id} disabled={c.showImages === false} value={c.imageFit ?? 'contain'} onChange={(e) => onChange({ imageFit: e.target.value })}>
              <option value="contain">Show whole photo</option><option value="cover">Fill and crop</option>
            </Select>}
          </Field>
          <Field label="Card padding (mm)">
            {({ id }) => <Input id={id} type="number" min={0} max={20} step={0.5} value={c.cardPaddingMm ?? 4} onChange={(e) => onChange({ cardPaddingMm: Number(e.target.value) })} />}
          </Field>
          <Field label="Regular font (pt)">
            {({ id }) => <Input id={id} type="number" min={6} max={24} step={0.5} value={c.fontSizePt ?? 8.5} onChange={(e) => onChange({ fontSizePt: Number(e.target.value) })} />}
          </Field>
          <Field label="Bold font (pt)">
            {({ id }) => <Input id={id} type="number" min={6} max={32} step={0.5} value={c.boldFontSizePt ?? 11} onChange={(e) => onChange({ boldFontSizePt: Number(e.target.value) })} />}
          </Field>
        </div>
        <label className="catalog-check">
          <input type="checkbox" aria-label="Show brand" checked={c.showBrand !== false} onChange={(e) => onChange({ showBrand: e.target.checked })} />
          <span>Show brand</span>
        </label>
      </section>

      <section className="catalog-sidebar__section">
        <h3 className="section-title">Page header and footer</h3>
        <Field label="Header text" hint="Optional plain text on each page.">
          {({ id }) => <Input id={id} maxLength={200} value={c.headerText ?? ''} onChange={(e) => onChange({ headerText: e.target.value })} />}
        </Field>
        <Field label="Footer text">
          {({ id }) => <Input id={id} maxLength={200} value={c.footerText ?? ''} onChange={(e) => onChange({ footerText: e.target.value })} />}
        </Field>
        <label className="catalog-check">
          <input type="checkbox" aria-label="Page numbers" checked={!!c.pageNumbers} onChange={(e) => onChange({ pageNumbers: e.target.checked })} />
          <span>Page numbers</span>
        </label>
      </section>

      <section className="catalog-sidebar__section">
        <h3 className="section-title">Style</h3>
        <div className="theme-choices">
          {CATALOG_THEMES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={(c.theme || 'modern') === t.id ? 'is-active' : ''}
              aria-pressed={(c.theme || 'modern') === t.id}
              onClick={() => onChange({ theme: t.id })}
            >
              <strong>{t.name}</strong>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
        <div className="catalog-field-grid">
          <Field label="Primary color">{({ id }) => <Input id={id} type="color" value={c.primaryColor || '#111827'} onChange={(e) => onChange({ primaryColor: e.target.value })} />}</Field>
          <Field label="Accent color">{({ id }) => <Input id={id} type="color" value={c.accentColor || '#6366f1'} onChange={(e) => onChange({ accentColor: e.target.value })} />}</Field>
        </div>
      </section>

      <section className="catalog-sidebar__section">
        <h3 className="section-title">Card fields</h3>
        <p className="catalog-sidebar__note">
          Choose the source fields to print. Edit their print labels and use the arrows to change the order.
        </p>
        <div className="catalog-field-list">
          {fields.map((f) => {
            const on = included.has(f.key);
            const entry = (c.fields || []).find((x) => x.key === f.key) || f;
            return (
              <div className={`catalog-field-row${on ? '' : ' is-off'}`} key={f.key}>
                <label className="catalog-field-row__include">
                  <input type="checkbox" checked={on} aria-label={`Include ${labelFor(f.key)} (${f.key})`} onChange={(e) => toggleField(f.key, e.target.checked)} />
                  <span className="catalog-field-row__source">
                    <strong>{labelFor(f.key)}</strong>
                    <code>{f.key}</code>
                  </span>
                </label>
                {on ? <>
                  <Field label="Print label">
                    {({ id }) => <Input id={id} className="catalog-field-row__label" value={entry.label ?? ''} aria-label={`Print label for ${f.key}`} placeholder={labelFor(f.key)} onChange={(e) => patchField(f.key, { label: e.target.value })} />}
                  </Field>
                  <Field label="Alignment">
                    {({ id }) => <Select id={id} value={entry.align ?? 'left'} aria-label={`Alignment for ${f.key}`} onChange={(e) => patchField(f.key, { align: e.target.value })}>
                      <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                    </Select>}
                  </Field>
                  <div className="catalog-field-row__options">
                    <label className="catalog-check">
                      <input type="checkbox" checked={!!entry.bold} aria-label={`Print ${f.key} in bold`} onChange={(e) => patchField(f.key, { bold: e.target.checked })} /> Bold
                    </label>
                    <label className="catalog-check">
                      <input type="checkbox" checked={entry.showLabel !== false} aria-label={`Print label before ${f.key} value`} onChange={(e) => patchField(f.key, { showLabel: e.target.checked })} /> Show label
                    </label>
                    <span className="catalog-field-row__move">
                      <button type="button" className="catalog-icon-btn" aria-label={`Move ${labelFor(f.key)} (${f.key}) up`} title="Move field up" disabled={includedOrder.indexOf(f.key) <= 0} onClick={() => moveField(f.key, -1)}>↑</button>
                      <button type="button" className="catalog-icon-btn" aria-label={`Move ${labelFor(f.key)} (${f.key}) down`} title="Move field down" disabled={includedOrder.indexOf(f.key) >= includedOrder.length - 1} onClick={() => moveField(f.key, 1)}>↓</button>
                    </span>
                  </div>
                </> : null}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
