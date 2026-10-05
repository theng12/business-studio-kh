/**
 * v0.1.63 — Catalog Studio: which config keys are the LOOK and which are the
 * PRODUCTS.
 *
 * The customer's report was "we can't build a template for the catalog too —
 * it doesn't have a builder at all". Catalog layout settings only existed
 * inside a project: the five "Catalog Templates" were a hard-coded array in the
 * renderer, and nothing could save a layout for reuse.
 *
 * This module is the one definition of the split, shared by the templates table
 * and the builder, exactly like main/util/socialGridModel.js does for Social
 * Grid. A catalog template stores the look; which products appear stays with
 * the project.
 *
 * Pure: no electron, no database, no sharp — so the rules run under plain
 * `node --test`.
 */

/** Config keys the builder owns: page, grid, style, cover, card fields, prices. */
const CATALOG_DESIGN_KEYS = [
  'pageSize', 'orientation', 'columns', 'gapMm', 'marginMm',
  'groupBy', 'sortBy',
  'theme', 'primaryColor', 'accentColor',
  'fields', 'layoutMode', 'showImages', 'imageHeightMm', 'imageFit',
  'cardPaddingMm', 'fontSizePt', 'boldFontSizePt', 'showBrand',
  'headerText', 'footerText', 'pageNumbers',
  // Which price to print and the fallback symbol are print settings, the same
  // call socialGridModel makes for its priceSource / currencySymbol.
  'priceGroup', 'currencySymbol',
  // Whether there is a cover at all is design; the cover's TITLE is content and
  // belongs to the project (a template reused across three catalogs must not
  // rename them all).
  'coverEnabled',
];

/** Config keys that decide WHICH products are in the catalog. */
const CATALOG_SELECTION_KEYS = [
  'selectionMode', 'productIds', 'brandIds', 'categoryIds',
];

/** The card fields a brand-new catalog starts with. */
const DEFAULT_FIELDS = [
  { key: 'sku', label: 'SKU', visible: true },
  { key: 'name', label: 'Name', visible: true, bold: true },
  { key: 'colorFinish', label: 'Color / Finish', visible: true },
  { key: 'price', label: 'Price', visible: true, bold: true },
];

/**
 * The fields a card can print, in the order the builder offers them.
 *
 * `productValue()` in main/studioRenderer.js can read any product property, and
 * `custom.*` / `price.*` resolve custom fields and named price groups. This list
 * is the curated set a person would actually put on a catalog card; the builder
 * shows exactly these as check-boxes, plus whatever the config already carries
 * from a custom field.
 */
const CATALOG_FIELD_KEYS = [
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

/** Everything a project needs; a template carries the design subset. */
const DESIGN_DEFAULTS = {
  pageSize: 'A4',
  orientation: 'portrait',
  columns: 3,
  gapMm: 5,
  marginMm: 10,
  groupBy: 'none',          // none | category | brand
  sortBy: 'manual',         // manual | sku | name
  theme: 'modern',          // modern | minimal | retail
  primaryColor: '#111827',
  accentColor: '#6366f1',
  fields: DEFAULT_FIELDS,
  priceGroup: 'retail',
  currencySymbol: '$',
  coverEnabled: true,
  layoutMode: 'cards',
  showImages: true,
  imageHeightMm: 0, // Auto: square photo.
  imageFit: 'contain',
  cardPaddingMm: 4,
  fontSizePt: 8.5,
  boldFontSizePt: 11,
  showBrand: true,
  headerText: '',
  footerText: '',
  pageNumbers: false,
};

const SELECTION_DEFAULTS = {
  selectionMode: 'explicit', // explicit | all
  productIds: [],
  brandIds: [],
  categoryIds: [],
};

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const pickEnum = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

const KNOWN_FIELD_KEYS = new Set(CATALOG_FIELD_KEYS.map((f) => f.key));
const isKnownFieldKey = (key) => KNOWN_FIELD_KEYS.has(key) || key.startsWith('custom.') || key.startsWith('price.');

/**
 * The card-field list, cleaned: known keys only, one entry per key, in the order
 * the caller listed them. `custom.*` / `price.*` survive because those resolve a
 * custom field or a named price group; an unknown bare key is dropped rather
 * than stored as a row that would print an empty cell forever.
 */
function normalizeFields(raw) {
  if (Array.isArray(raw) && raw.length === 0) return [];
  const source = Array.isArray(raw) ? raw : DEFAULT_FIELDS;
  const seen = new Set();
  const out = [];
  for (const field of source) {
    const key = typeof field?.key === 'string' ? field.key.trim() : '';
    if (!key || seen.has(key) || !isKnownFieldKey(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: typeof field.label === 'string' && field.label.trim() ? field.label.trim() : key,
      visible: field.visible !== false,
      bold: field.bold === true,
      showLabel: field.showLabel !== false,
      align: pickEnum(field.align, ['left', 'center', 'right'], 'left'),
    });
  }
  return out.length ? out : normalizeFields(DEFAULT_FIELDS);
}

/**
 * Merge a stored or partial config over the defaults, clamping what the
 * renderer cannot survive. Every read of a stored template or project goes
 * through here rather than trusting the JSON.
 *
 * `coverEnabled` is accepted in BOTH shapes on purpose: the builder and the
 * templates table deal in a flat boolean, while buildCatalogHtml and every
 * saved project read `cover.enabled`. Writing both keeps one story.
 */
function normalizeCatalogConfig(raw) {
  const c = { ...DESIGN_DEFAULTS, ...SELECTION_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const out = { ...c };

  out.pageSize = pickEnum(c.pageSize, ['A4', 'Letter'], DESIGN_DEFAULTS.pageSize);
  out.orientation = pickEnum(c.orientation, ['portrait', 'landscape'], DESIGN_DEFAULTS.orientation);
  out.columns = clampInt(c.columns, 1, 5, DESIGN_DEFAULTS.columns);
  out.gapMm = clampInt(c.gapMm, 0, 60, DESIGN_DEFAULTS.gapMm);
  out.marginMm = clampInt(c.marginMm, 0, 60, DESIGN_DEFAULTS.marginMm);
  out.groupBy = pickEnum(c.groupBy, ['none', 'category', 'brand'], DESIGN_DEFAULTS.groupBy);
  out.sortBy = pickEnum(c.sortBy, ['manual', 'sku', 'name'], DESIGN_DEFAULTS.sortBy);
  out.theme = pickEnum(c.theme, ['modern', 'minimal', 'retail'], DESIGN_DEFAULTS.theme);
  out.primaryColor = typeof c.primaryColor === 'string' && c.primaryColor ? c.primaryColor : DESIGN_DEFAULTS.primaryColor;
  out.accentColor = typeof c.accentColor === 'string' && c.accentColor ? c.accentColor : DESIGN_DEFAULTS.accentColor;
  out.fields = normalizeFields(c.fields);
  out.layoutMode = pickEnum(c.layoutMode, ['cards', 'list'], DESIGN_DEFAULTS.layoutMode);
  out.showImages = c.showImages !== false;
  const height = Number(c.imageHeightMm);
  out.imageHeightMm = height === 0 ? 0 : clampNumber(c.imageHeightMm, 10, 100, DESIGN_DEFAULTS.imageHeightMm);
  out.imageFit = pickEnum(c.imageFit, ['contain', 'cover'], DESIGN_DEFAULTS.imageFit);
  out.cardPaddingMm = clampNumber(c.cardPaddingMm, 0, 20, DESIGN_DEFAULTS.cardPaddingMm);
  out.fontSizePt = clampNumber(c.fontSizePt, 6, 24, DESIGN_DEFAULTS.fontSizePt);
  out.boldFontSizePt = clampNumber(c.boldFontSizePt, 6, 32, DESIGN_DEFAULTS.boldFontSizePt);
  out.showBrand = c.showBrand !== false;
  out.headerText = typeof c.headerText === 'string' ? c.headerText.slice(0, 200) : '';
  out.footerText = typeof c.footerText === 'string' ? c.footerText.slice(0, 200) : '';
  out.pageNumbers = c.pageNumbers === true;
  out.priceGroup = typeof c.priceGroup === 'string' && c.priceGroup ? c.priceGroup : DESIGN_DEFAULTS.priceGroup;
  out.currencySymbol = typeof c.currencySymbol === 'string' && c.currencySymbol ? c.currencySymbol : DESIGN_DEFAULTS.currencySymbol;

  // Cover: honour either shape, then write both so nothing downstream has to
  // know which one this row came from.
  const coverEnabled = c.cover && typeof c.cover === 'object'
    ? c.cover.enabled !== false
    : c.coverEnabled !== false;
  out.coverEnabled = coverEnabled;
  out.cover = { ...(c.cover && typeof c.cover === 'object' ? c.cover : {}), enabled: coverEnabled };

  out.selectionMode = pickEnum(c.selectionMode, ['explicit', 'all'], SELECTION_DEFAULTS.selectionMode);
  out.productIds = Array.isArray(c.productIds) ? c.productIds.filter((id) => typeof id === 'string') : [];
  out.brandIds = Array.isArray(c.brandIds) ? c.brandIds.filter((id) => typeof id === 'string') : [];
  out.categoryIds = Array.isArray(c.categoryIds) ? c.categoryIds.filter((id) => typeof id === 'string') : [];

  return out;
}

/**
 * The look, without the products — what a template stores.
 *
 * Returns a FULL normalized config (selection keys at their defaults) so the
 * stored JSON is self-describing and can be handed straight to a new project or
 * to `catalogStudio:previewTemplate`.
 */
function catalogDesignOnly(rawConfig) {
  const normalized = normalizeCatalogConfig(rawConfig);
  const out = { ...normalized };
  for (const key of CATALOG_SELECTION_KEYS) out[key] = SELECTION_DEFAULTS[key];
  out.cover = { enabled: normalized.coverEnabled };
  return out;
}

/** A template's look over a fresh (or supplied) selection. */
function applyCatalogDesign(design, selection = {}) {
  return normalizeCatalogConfig({ ...design, ...selection });
}

/** PDF and screen pagination share the same reserved header/footer space. */
function catalogPageMarginsMm(rawConfig) {
  const c = normalizeCatalogConfig(rawConfig);
  return {
    top: Math.max(c.marginMm, c.headerText ? 10 : 0),
    bottom: Math.max(c.marginMm, c.footerText || c.pageNumbers ? 10 : 0),
    left: c.marginMm, right: c.marginMm,
  };
}

/** Native Chromium page counters: the exported PDF is also the print document. */
function catalogPdfOptions(rawConfig) {
  const c = normalizeCatalogConfig(rawConfig);
  const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const margins = catalogPageMarginsMm(c);
  const style = `font-family:Arial,sans-serif;font-size:8px;color:#475569;width:100%;padding:0 ${Math.max(2, c.marginMm)}mm;box-sizing:border-box;`;
  return {
    pageSize: c.pageSize, orientation: c.orientation,
    margins: Object.fromEntries(Object.entries(margins).map(([key, mm]) => [key, mm / 25.4])),
    displayHeaderFooter: !!(c.headerText || c.footerText || c.pageNumbers),
    // Empty templates suppress Chromium's automatic title, URL and date.
    headerTemplate: `<div style="${style}">${escape(c.headerText)}</div>`,
    footerTemplate: !c.footerText && !c.pageNumbers ? `<div style="${style}"></div>` : `<div style="${style}display:flex;gap:4mm;"><span style="flex:1">${escape(c.footerText)}</span>${c.pageNumbers ? '<span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span>' : ''}</div>`,
  };
}

module.exports = {
  CATALOG_DESIGN_KEYS, CATALOG_SELECTION_KEYS, CATALOG_FIELD_KEYS,
  DESIGN_DEFAULTS, SELECTION_DEFAULTS, DEFAULT_FIELDS,
  normalizeCatalogConfig, catalogDesignOnly, applyCatalogDesign, normalizeFields, isKnownFieldKey, catalogPdfOptions, catalogPageMarginsMm,
};
