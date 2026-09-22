/**
 * Catalog design defaults + card fields (renderer mirror).
 *
 * Kept in sync with `main/util/catalogModel.js` — main is CommonJS and this is
 * ESM, so the values are duplicated rather than imported, exactly like
 * `renderer/lib/currencies.js`. `test/catalogModel.test.js` compares both lists
 * and fails on any drift.
 *
 * The DEFAULTS matter at runtime, not just for documentation: the template
 * builder opens on a blank draft, and a blank draft that does not carry the
 * standard four card fields produces a catalog with NO text on its cards.
 * (Found by the UI crawl — the builder saved a template whose only field was
 * the one the test had ticked.)
 *
 * `productValue()` in main/studioRenderer.js can read any product property, and
 * `custom.*` / `price.*` resolve a custom field or a named price group. The key
 * list below is the curated set the builder offers as check-boxes.
 */

export const CATALOG_FIELD_KEYS = [
  { key: 'sku', label: 'SKU' },
  { key: 'name', label: 'Name' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'secondaryCode', label: 'Secondary code' },
  { key: 'colorFinish', label: 'Color / Finish' },
  { key: 'subcategory', label: 'Subcategory' },
  { key: 'variant', label: 'Variant' },
  { key: 'unit', label: 'Unit' },
  { key: 'price', label: 'Price' },
  { key: 'description', label: 'Description' },
  { key: 'countryOfOrigin', label: 'Country of origin' },
  { key: 'tags', label: 'Tags' },
  { key: 'taxRate', label: 'Tax rate' },
  { key: 'stockQty', label: 'Stock on hand' },
  { key: 'supplierSku', label: 'Supplier SKU' },
];

const DEFAULT_FIELDS = [
  { key: 'sku', label: 'SKU', visible: true },
  { key: 'name', label: 'Name', visible: true, bold: true },
  { key: 'colorFinish', label: 'Color / Finish', visible: true },
  { key: 'price', label: 'Price', visible: true, bold: true },
];

/** Mirror of DESIGN_DEFAULTS in main/util/catalogModel.js (renderer subset). */
export const CATALOG_DESIGN_DEFAULTS = {
  pageSize: 'A4',
  orientation: 'portrait',
  columns: 3,
  gapMm: 5,
  marginMm: 10,
  groupBy: 'none',
  sortBy: 'manual',
  theme: 'modern',
  primaryColor: '#111827',
  accentColor: '#6366f1',
  fields: DEFAULT_FIELDS,
  priceGroup: 'retail',
  currencySymbol: '$',
  coverEnabled: true,
};

/** A fresh, safe copy — module-level arrays must never be edited in place. */
export function blankCatalogDesign() {
  return { ...CATALOG_DESIGN_DEFAULTS, fields: DEFAULT_FIELDS.map((f) => ({ ...f })) };
}

const KNOWN = new Set(CATALOG_FIELD_KEYS.map((f) => f.key));

/** True for a key the card can actually print. */
export function isPrintableFieldKey(key) {
  return KNOWN.has(key) || String(key).startsWith('custom.') || String(key).startsWith('price.');
}

/**
 * Every row the field editor should show, in this order:
 *
 *   1. the fields the config already includes, in the order it lists them
 *      (so the card order on the page is the order on screen),
 *   2. then the rest of the curated keys, off by default.
 *
 * A `custom.*` field that is in the config stays visible and editable; it
 * appears in the second group only if it was never added.
 */
export function catalogFieldRows(configFields) {
  const list = Array.isArray(configFields) ? configFields : [];
  const included = list.filter((f) => f && isPrintableFieldKey(f.key));
  const seen = new Set(included.map((f) => f.key));
  const rest = CATALOG_FIELD_KEYS.filter((f) => !seen.has(f.key));
  return [...included, ...rest];
}
