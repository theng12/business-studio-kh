/**
 * v0.1.25 — Social Grid settings.
 *
 * Split out of index.jsx because the recipe has a lot of independent knobs and
 * one file with the whole editor in it stops being readable. Every control here
 * is a plain patch into `config`; the actual meaning of each field (and every
 * clamp) lives in main/util/socialGridModel.js, so this file never has to
 * re-implement a rule — it only displays one.
 */
import { useState } from 'react';
import { Button, Input, Select } from '../../components/ui.jsx';

/** Sizes that Facebook and Instagram actually accept. Square is first and is
 *  the default: the customer asked for square posts. */
export const CANVAS_PRESETS = [
  { id: 'square',    name: 'Square',          width: 1080, height: 1080, hint: 'Facebook + Instagram feed — the default' },
  { id: 'portrait',  name: 'Portrait',        width: 1080, height: 1350, hint: 'Instagram portrait — room for more rows' },
  { id: 'landscape', name: 'Landscape',       width: 1200, height: 630,  hint: 'Facebook link preview' },
  { id: 'story',     name: 'Story / Reel',    width: 1080, height: 1920, hint: 'Instagram or Facebook story' },
];

/** Common grid shapes, so the user picks "9 products per image" instead of
 *  doing multiplication in their head. */
export const GRID_PRESETS = [
  { id: '2x2', label: '2 × 2', columns: 2, rows: 2 },
  { id: '3x2', label: '3 × 2', columns: 3, rows: 2 },
  { id: '3x3', label: '3 × 3', columns: 3, rows: 3 },
  { id: '4x3', label: '4 × 3', columns: 4, rows: 3 },
  { id: '4x4', label: '4 × 4', columns: 4, rows: 4 },
  { id: '5x5', label: '5 × 5', columns: 5, rows: 5 },
];

export const SORT_OPTIONS = [
  { value: 'name',      label: 'Product name (A–Z)' },
  { value: 'sku',       label: 'SKU' },
  { value: 'brand',     label: 'Brand name, then product name' },
  { value: 'stockHigh', label: 'Stock — most first' },
  { value: 'stockLow',  label: 'Stock — fewest first' },
  { value: 'priceHigh', label: 'Price — highest first' },
  { value: 'priceLow',  label: 'Price — lowest first' },
  { value: 'newest',    label: 'Newest products first' },
];

/** The stock filters. `any` is the default so the grid still works for a
 *  catalogue whose stock numbers have not been filled in yet. */
export const STOCK_OPTIONS = [
  { value: 'any',       label: 'Any stock level' },
  { value: 'in',        label: 'In stock (above the low-stock level)' },
  { value: 'low',       label: 'Running low' },
  { value: 'out',       label: 'Out of stock' },
  { value: 'counted',   label: 'Only products I have counted' },
  { value: 'uncounted', label: 'Only products with no count' },
  { value: 'range',     label: 'Between two numbers' },
];

function Section({ title, hint, children }) {
  return (
    <section className="social-controls__section">
      <h3>{title}</h3>
      {hint ? <p className="social-controls__hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** Hand-picked mode: a searchable tick list. Deliberately NOT a drag-to-order
 *  list — the order still comes from the "Arrange by" setting, so the user has
 *  one place that decides ordering instead of two that can disagree. */
function ProductPicker({ products, selectedIds, onChange }) {
  const [query, setQuery] = useState('');
  const selected = new Set(selectedIds);
  const q = query.trim().toLowerCase();
  const shown = products
    .filter((p) => !q || `${p.sku} ${p.name || ''} ${p.barcode || ''}`.toLowerCase().includes(q))
    .slice(0, 300);

  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    // Preserve the order the user ticked them in; the sort setting reorders
    // them at render time anyway.
    onChange(selectedIds.filter((x) => next.has(x)).concat([...next].filter((x) => !selectedIds.includes(x))));
  }

  return (
    <div className="social-picker">
      <div className="social-picker__bar">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU, name or barcode" />
        <Button variant="ghost" onClick={() => onChange([])} disabled={!selectedIds.length}>Clear</Button>
      </div>
      <p className="social-picker__count">
        {selectedIds.length} picked
        {shown.length < products.length ? ` · showing ${shown.length} of ${products.length}` : ''}
      </p>
      <div className="social-picker__list">
        {shown.length ? shown.map((p) => (
          <label key={p.id} className="social-picker__row">
            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
            <span className="social-picker__sku">{p.sku}</span>
            <span className="social-picker__name">{p.name || 'Unnamed product'}</span>
            <span className={`social-picker__img${p.mainImagePath ? '' : ' is-missing'}`}>
              {p.mainImagePath ? 'photo' : 'no photo'}
            </span>
          </label>
        )) : <p className="social-picker__empty">No products match “{query}”.</p>}
      </div>
    </div>
  );
}

export function GridControls({ config, onChange, brands, categories, products, priceGroups = [] }) {
  const c = config;
  const set = (patch) => onChange(patch);
  const canvasId = CANVAS_PRESETS.find((p) => p.width === c.width && p.height === c.height)?.id
    ?? (c.width === c.height ? 'custom-square' : 'custom');
  const gridId = GRID_PRESETS.find((p) => p.columns === c.columns && p.rows === c.rows)?.id ?? 'custom';

  return (
    <aside className="social-controls">
      <Section title="Which products" hint="A saved post is a recipe — the products are worked out fresh every time you open it, so new stock and new products appear automatically.">
        <label className="field">
          <span className="field__label">Choose by</span>
          <Select value={c.source} onChange={(e) => set({ source: e.target.value })}>
            <option value="all">Everything in the catalogue</option>
            <option value="brand">One brand</option>
            <option value="category">One category</option>
            <option value="subcategory">One subcategory</option>
            <option value="picked">Hand-picked products</option>
          </Select>
        </label>

        {c.source === 'brand' ? (
          <label className="field">
            <span className="field__label">Brand</span>
            <Select value={c.brandId || ''} onChange={(e) => set({ brandId: e.target.value || null })}>
              <option value="">— Pick a brand —</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </label>
        ) : null}

        {c.source === 'category' ? (
          <label className="field">
            <span className="field__label">Category</span>
            <Select value={c.categoryId || ''} onChange={(e) => set({ categoryId: e.target.value || null })}>
              <option value="">— Pick a category —</option>
              {categories.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </label>
        ) : null}

        {c.source === 'subcategory' ? (
          <label className="field">
            <span className="field__label">Subcategory</span>
            <Input value={c.subcategory || ''} onChange={(e) => set({ subcategory: e.target.value })} placeholder="e.g. Running shoes" />
            <span className="field__hint">Must match the subcategory text on the product exactly (capitalisation is ignored).</span>
          </label>
        ) : null}

        {c.source === 'picked' ? (
          <ProductPicker
            products={products}
            selectedIds={c.productIds || []}
            onChange={(ids) => set({ productIds: ids })}
          />
        ) : null}

        <label className="field">
          <span className="field__label">Stock level</span>
          <Select value={c.stockScope} onChange={(e) => set({ stockScope: e.target.value })}>
            {STOCK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </label>

        {(c.stockScope === 'in' || c.stockScope === 'low') ? (
          <label className="field">
            <span className="field__label">Treat as “running low” at or below</span>
            <Input type="number" min="0" value={c.lowStockAt} onChange={(e) => set({ lowStockAt: e.target.value })} />
          </label>
        ) : null}

        {c.stockScope === 'range' ? (
          <div className="control-grid">
            <label className="field"><span className="field__label">From</span><Input type="number" value={c.stockMin ?? ''} onChange={(e) => set({ stockMin: e.target.value })} /></label>
            <label className="field"><span className="field__label">To</span><Input type="number" value={c.stockMax ?? ''} onChange={(e) => set({ stockMax: e.target.value })} /></label>
          </div>
        ) : null}

        {c.stockScope === 'any' ? (
          <p className="social-controls__note">
            Stock is ignored. Products you have not counted still appear — a blank count is not treated as zero.
          </p>
        ) : null}

        <label className="field">
          <span className="field__label">Maximum products</span>
          <Input type="number" min="0" value={c.limit} onChange={(e) => set({ limit: e.target.value })} />
          <span className="field__hint">0 means no limit. Anything past the grid size becomes another image.</span>
        </label>

        <label className="field">
          <span className="field__label">Include inactive products</span>
          <span className="field__row">
            <input type="checkbox" checked={!c.excludeInactive} onChange={(e) => set({ excludeInactive: !e.target.checked })} />
            <span>Yes, include products marked inactive</span>
          </span>
        </label>
      </Section>

      <Section title="What order">
        <label className="field">
          <span className="field__label">Arrange by</span>
          <Select value={c.sortBy} onChange={(e) => set({ sortBy: e.target.value })}>
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </label>
      </Section>

      <Section title="Image size">
        <div className="social-choices">
          {CANVAS_PRESETS.map((p) => (
            <button type="button" key={p.id} className={canvasId === p.id ? 'is-active' : ''} onClick={() => set({ width: p.width, height: p.height })}>
              <strong>{p.name}</strong>
              <span>{p.width} × {p.height}</span>
              <small>{p.hint}</small>
            </button>
          ))}
        </div>
        <div className="control-grid">
          <label className="field"><span className="field__label">Width (px)</span><Input type="number" value={c.width} onChange={(e) => set({ width: e.target.value })} /></label>
          <label className="field"><span className="field__label">Height (px)</span><Input type="number" value={c.height} onChange={(e) => set({ height: e.target.value })} /></label>
        </div>
        <label className="field">
          <span className="field__label">Background</span>
          <Input type="color" value={c.background} onChange={(e) => set({ background: e.target.value })} />
        </label>
      </Section>

      <Section title="Grid" hint="One image holds this many products. Any extras continue on a second image.">
        <div className="social-choices social-choices--compact">
          {GRID_PRESETS.map((g) => (
            <button type="button" key={g.id} className={gridId === g.id ? 'is-active' : ''} onClick={() => set({ columns: g.columns, rows: g.rows })}>
              <strong>{g.label}</strong>
              <span>{g.columns * g.rows} per image</span>
            </button>
          ))}
        </div>
        <div className="control-grid">
          <label className="field"><span className="field__label">Columns</span><Input type="number" min="1" max="8" value={c.columns} onChange={(e) => set({ columns: e.target.value })} /></label>
          <label className="field"><span className="field__label">Rows</span><Input type="number" min="1" max="8" value={c.rows} onChange={(e) => set({ rows: e.target.value })} /></label>
          <label className="field"><span className="field__label">Gap (px)</span><Input type="number" min="0" value={c.gap} onChange={(e) => set({ gap: e.target.value })} /></label>
          <label className="field"><span className="field__label">Edge padding (px)</span><Input type="number" min="0" value={c.padding} onChange={(e) => set({ padding: e.target.value })} /></label>
        </div>
        <label className="field">
          <span className="field__label">Photos</span>
          <Select value={c.photoFit} onChange={(e) => set({ photoFit: e.target.value })}>
            <option value="contain">Show the whole photo (no cropping)</option>
            <option value="cover">Fill the cell (crops the edges)</option>
          </Select>
        </label>
      </Section>

      <Section title="What each tile shows">
        <div className="social-toggles">
          {[
            ['showPhoto', 'Product photo'],
            ['showName', 'Product name'],
            ['showPrice', 'Price'],
            ['showBrand', 'Brand name'],
            ['showStock', 'Stock note'],
            ['showSku', 'SKU'],
          ].map(([key, label]) => (
            <label key={key} className="switch-row">
              <input type="checkbox" checked={!!c[key]} onChange={(e) => set({ [key]: e.target.checked })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {c.showPrice ? (
          <>
            <label className="field">
              <span className="field__label">Which price</span>
              <Select value={c.priceSource} onChange={(e) => set({ priceSource: e.target.value })}>
                <option value="retail">Retail</option>
                <option value="wholesale">Wholesale</option>
                {priceGroups.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </Select>
              <span className="field__hint">Make one post with retail prices and another with wholesale from the same products — nothing is overwritten. Custom groups come from Settings → General → Price groups.</span>
            </label>
            <label className="field">
              <span className="field__label">Currency fallback</span>
              <Input value={c.currencySymbol} onChange={(e) => set({ currencySymbol: e.target.value })} placeholder="$" />
              <span className="field__hint">Used only when a product has no currency of its own.</span>
            </label>
          </>
        ) : null}
        <div className="control-grid">
          <label className="field"><span className="field__label">Name size</span><Input type="number" value={c.nameSize} onChange={(e) => set({ nameSize: e.target.value })} /></label>
          <label className="field"><span className="field__label">Price size</span><Input type="number" value={c.priceSize} onChange={(e) => set({ priceSize: e.target.value })} /></label>
          <label className="field"><span className="field__label">Small text size</span><Input type="number" value={c.metaSize} onChange={(e) => set({ metaSize: e.target.value })} /></label>
          <label className="field"><span className="field__label">Corner rounding</span><Input type="number" min="0" value={c.radius} onChange={(e) => set({ radius: e.target.value })} /></label>
        </div>
        <p className="social-controls__note">Text sizes are for a 3-column grid and shrink automatically when you add more columns.</p>
      </Section>

      <Section title="Heading and footer" hint="Optional. Leave them blank for a clean grid of just products.">
        <label className="field"><span className="field__label">Title</span><Input value={c.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. New arrivals" /></label>
        <label className="field"><span className="field__label">Subtitle</span><Input value={c.subtitle} onChange={(e) => set({ subtitle: e.target.value })} placeholder="e.g. Nike — spring range" /></label>
        <label className="field"><span className="field__label">Footer</span><Input value={c.footer} onChange={(e) => set({ footer: e.target.value })} placeholder="e.g. order at shop.example.com" /></label>
        <div className="control-grid">
          <label className="field"><span className="field__label">Title size</span><Input type="number" value={c.titleSize} onChange={(e) => set({ titleSize: e.target.value })} /></label>
          <label className="field"><span className="field__label">Footer size</span><Input type="number" value={c.footerSize} onChange={(e) => set({ footerSize: e.target.value })} /></label>
        </div>
      </Section>

      <Section title="Output file">
        <label className="field">
          <span className="field__label">Format</span>
          <Select value={c.format} onChange={(e) => set({ format: e.target.value })}>
            <option value="png">PNG — sharpest text</option>
            <option value="jpeg">JPG — smaller file</option>
          </Select>
        </label>
      </Section>
    </aside>
  );
}
