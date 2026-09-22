/**
 * v0.1.25 — Social Grid: the pure part.
 *
 * This module decides WHICH products go into a post, in WHAT ORDER, and how
 * they split across images. It deliberately has no `require` of electron,
 * better-sqlite3 or sharp, so the whole decision layer is unit-testable in
 * plain `node --test` (see test/socialGridModel.test.js) without Electron's
 * ABI. The HTML/imaging half lives in main/socialGridRenderer.js.
 *
 * The split matters because this is the part with rules a user will argue
 * about — "why is this product not in my post?" — and rules like that should
 * be testable without booting an app.
 */

/** What a fresh grid starts as. 1080x1080 is the square Instagram/Facebook
 *  post size, which is what the feature exists to produce. */
const { priceEntry, formatPriceEntry } = require('./prices');

const DEFAULTS = {
  // ── which products ──────────────────────────────────────────────
  source: 'all',          // all | brand | category | subcategory | picked
  brandId: null,
  categoryId: null,
  subcategory: null,
  productIds: [],
  excludeInactive: true,
  // Stock scope. 'any' ignores stock entirely, so a user who never fills in
  // stock numbers still gets a working grid.
  stockScope: 'any',      // any | counted | uncounted | in | low | out | range
  lowStockAt: 5,          // "low" means 1..lowStockAt remaining
  stockMin: null,         // used only when stockScope === 'range'
  stockMax: null,

  // ── in what order ───────────────────────────────────────────────
  sortBy: 'name',         // name | sku | brand | stockHigh | stockLow
                          // | priceHigh | priceLow | newest
  limit: 0,               // 0 = no cap

  // ── canvas ──────────────────────────────────────────────────────
  width: 1080,
  height: 1080,
  background: '#ffffff',
  padding: 40,
  gap: 16,
  radius: 16,
  tileBackground: '#f1f5f9',
  photoFit: 'contain',    // contain = never crop | cover = fill the cell

  // ── grid ────────────────────────────────────────────────────────
  columns: 3,
  rows: 3,

  // ── what each tile shows ────────────────────────────────────────
  showPhoto: true,
  showName: true,
  showPrice: true,
  showBrand: false,
  showStock: false,
  showSku: false,

  // ── price ───────────────────────────────────────────────────────
  // 'retail' and 'wholesale' are real columns; any other string is looked up
  // in the product's `prices` map, so custom price groups work here later
  // without touching this file.
  priceSource: 'retail',
  currencySymbol: '$',

  // ── text ────────────────────────────────────────────────────────
  nameSize: 28,
  priceSize: 28,
  metaSize: 18,
  title: '',
  subtitle: '',
  footer: '',
  titleSize: 56,
  subtitleSize: 28,
  footerSize: 24,

  // ── output ──────────────────────────────────────────────────────
  format: 'png',          // png | jpeg
  quality: 92,
};

/* 'asSelected' keeps the order the products arrived in. In the editor that is
 * the catalogue order; when a template is applied to a hand-picked selection in
 * the Product Library it is the order the user ticked them, which is the whole
 * point of picking by hand. */
const SORT_KEYS = ['name', 'sku', 'brand', 'stockHigh', 'stockLow', 'priceHigh', 'priceLow', 'newest', 'asSelected'];
const STOCK_SCOPES = ['any', 'counted', 'uncounted', 'in', 'low', 'out', 'range'];
const SOURCES = ['all', 'brand', 'category', 'subcategory', 'picked'];

/**
 * v0.1.62: every config key is either part of the LOOK or part of WHICH
 * PRODUCTS. The two lists below are the definition, and main/db/socialGridTemplates.js
 * stores only the look — that is what lets a template be applied to whatever
 * the user has selected in the Product Library instead of to the products it
 * happened to be designed on.
 *
 * `sortBy` is deliberately a DESIGN key: "newest first" or "cheapest first" is
 * part of how a post reads, not of which products qualify. `excludeInactive`
 * and the stock filters are selection keys, because they decide membership.
 */
const UI_DESIGN_KEYS = [
  'width', 'height', 'background', 'padding', 'gap', 'radius', 'tileBackground', 'photoFit',
  'columns', 'rows',
  'showPhoto', 'showName', 'showPrice', 'showBrand', 'showStock', 'showSku',
  'priceSource', 'currencySymbol',
  'nameSize', 'priceSize', 'metaSize',
  'title', 'subtitle', 'footer', 'titleSize', 'subtitleSize', 'footerSize',
  'format', 'quality',
  'sortBy',
];
const SELECTION_KEYS = [
  'source', 'brandId', 'categoryId', 'subcategory', 'productIds',
  'excludeInactive', 'stockScope', 'lowStockAt', 'stockMin', 'stockMax', 'limit',
];

/** Numbers arrive from HTML inputs as strings, and NULL means "not counted"
 *  which must stay distinct from 0 ("counted, none left"). */
function num(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(num(value) ?? fallback);
  return Math.max(min, Math.min(max, n));
}

function clampFloat(value, min, max, fallback) {
  const n = num(value) ?? fallback;
  return Math.max(min, Math.min(max, n));
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Merge a stored/partial config over the defaults, clamping anything the
 *  renderer could not survive (a 0-column grid, a negative canvas). Stored
 *  presets are user data that may predate a new field, so every read goes
 *  through here rather than trusting the JSON. */
function normalizeConfig(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const out = { ...c };
  out.source = pickEnum(c.source, SOURCES, DEFAULTS.source);
  out.stockScope = pickEnum(c.stockScope, STOCK_SCOPES, DEFAULTS.stockScope);
  out.sortBy = pickEnum(c.sortBy, SORT_KEYS, DEFAULTS.sortBy);
  out.photoFit = c.photoFit === 'cover' ? 'cover' : 'contain';
  out.format = c.format === 'jpeg' ? 'jpeg' : 'png';
  out.excludeInactive = c.excludeInactive !== false;

  // Canvas: 200px floor, 8000px ceiling — past that Chromium refuses the
  // window and the user just sees a failure with no explanation.
  out.width = clampInt(c.width, 200, 8000, DEFAULTS.width);
  out.height = clampInt(c.height, 200, 8000, DEFAULTS.height);
  // 6x6 = 36 tiles is already unreadable at post size; 8 is a hard ceiling
  // so a stored preset with columns: 400 cannot render a thousand cells.
  out.columns = clampInt(c.columns, 1, 8, DEFAULTS.columns);
  out.rows = clampInt(c.rows, 1, 8, DEFAULTS.rows);
  out.padding = clampInt(c.padding, 0, 400, DEFAULTS.padding);
  out.gap = clampInt(c.gap, 0, 200, DEFAULTS.gap);
  out.radius = clampInt(c.radius, 0, 200, DEFAULTS.radius);
  out.limit = clampInt(c.limit, 0, 5000, DEFAULTS.limit);
  out.lowStockAt = clampFloat(c.lowStockAt, 0, 1e9, DEFAULTS.lowStockAt);
  out.stockMin = num(c.stockMin);
  out.stockMax = num(c.stockMax);
  out.quality = clampInt(c.quality, 1, 100, DEFAULTS.quality);
  out.nameSize = clampInt(c.nameSize, 6, 400, DEFAULTS.nameSize);
  out.priceSize = clampInt(c.priceSize, 6, 400, DEFAULTS.priceSize);
  out.metaSize = clampInt(c.metaSize, 6, 400, DEFAULTS.metaSize);
  out.titleSize = clampInt(c.titleSize, 6, 600, DEFAULTS.titleSize);
  out.subtitleSize = clampInt(c.subtitleSize, 6, 400, DEFAULTS.subtitleSize);
  out.footerSize = clampInt(c.footerSize, 6, 400, DEFAULTS.footerSize);

  out.showPhoto = c.showPhoto !== false;
  out.showName = c.showName !== false;
  out.showPrice = c.showPrice !== false;
  out.showBrand = c.showBrand === true;
  out.showStock = c.showStock === true;
  out.showSku = c.showSku === true;

  out.productIds = Array.isArray(c.productIds) ? c.productIds.filter((x) => typeof x === 'string') : [];
  out.priceSource = typeof c.priceSource === 'string' && c.priceSource.trim() ? c.priceSource.trim() : 'retail';
  out.currencySymbol = typeof c.currencySymbol === 'string' ? c.currencySymbol : DEFAULTS.currencySymbol;
  for (const key of ['background', 'tileBackground']) {
    out[key] = typeof c[key] === 'string' && c[key].trim() ? c[key] : DEFAULTS[key];
  }
  for (const key of ['title', 'subtitle', 'footer']) {
    out[key] = c[key] == null ? '' : String(c[key]);
  }
  return out;
}

/**
 * The price to print on a tile.
 *
 * Retail and wholesale are real columns. Anything else is a named price group
 * looked up in the product's `prices` map — that map already exists and is
 * already read this way by the catalog renderer, so custom price groups become
 * a UI change later rather than a data migration.
 *
 * NO FALLBACK between levels, deliberately, and unlike the catalog renderer
 * (which falls back to retail). This grid produces a PUBLIC post: if the user
 * builds a "wholesale prices" post, quietly printing retail for the products
 * that lack a wholesale price would advertise the wrong number to customers,
 * and they would only find out from a complaint. A missing price prints
 * nothing, and `summarize()` counts how many tiles that affects so the user
 * sees it before posting rather than after.
 */
/**
 * The look, without the product recipe — what a template stores.
 *
 * Returns a FULL normalized config (selection keys at their defaults) so the
 * stored JSON is self-describing and can be handed straight back to
 * `socialGrid:create` / `socialGrid:preview` later.
 */
function designOnly(rawConfig) {
  const normalized = normalizeConfig(rawConfig);
  const out = { ...normalized };
  for (const key of SELECTION_KEYS) out[key] = DEFAULTS[key];
  return out;
}

/** A template's look over a fresh (or supplied) selection. */
function applyDesign(design, selection = {}) {
  const base = normalizeConfig({ ...design, ...selection });
  return base;
}

function resolvePrice(product, config) {
  return priceEntry(product, config?.priceSource || 'retail').amount;
}

/** The full entry (amount + the product's own currency) for formatting. */
function resolvePriceEntry(product, config) {
  return priceEntry(product, config?.priceSource || 'retail');
}

function formatPrice(value, config) {
  const n = num(value);
  if (n == null) return '';
  const symbol = config?.currencySymbol ?? DEFAULTS.currencySymbol;
  return `${symbol}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** v0.1.55: format using the product's own currency, falling back to the
 *  catalog's `currencySymbol` setting for rows that predate currencies. */
function formatPriceWithEntry(entry, config) {
  return formatPriceEntry(entry, config?.currencySymbol ?? DEFAULTS.currencySymbol);
}

/** The small line under a product name, e.g. "3 left" / "Sold out".
 *  Returns '' when the product has never been counted, so an uncounted
 *  catalogue does not show a wall of "Sold out". */
function describeStock(product, config) {
  const qty = num(product?.stockQty);
  if (qty == null) return '';
  if (qty <= 0) return 'Sold out';
  const lowAt = num(config?.lowStockAt) ?? DEFAULTS.lowStockAt;
  if (qty <= lowAt) return `Only ${trimNumber(qty)} left`;
  return `${trimNumber(qty)} in stock`;
}

function trimNumber(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** True when the product passes the stock rule. Kept separate from the main
 *  filter so the UI can label each option with the same logic the export uses. */
function matchesStock(product, config) {
  const scope = config?.stockScope || 'any';
  if (scope === 'any') return true;
  const qty = num(product?.stockQty);
  if (scope === 'counted') return qty != null;
  if (scope === 'uncounted') return qty == null;
  // Every remaining scope is about a number, so an uncounted product cannot
  // satisfy any of them.
  if (qty == null) return false;
  if (scope === 'in') {
    const lowAt = num(config?.lowStockAt) ?? DEFAULTS.lowStockAt;
    return qty > lowAt;
  }
  if (scope === 'low') {
    const lowAt = num(config?.lowStockAt) ?? DEFAULTS.lowStockAt;
    return qty > 0 && qty <= lowAt;
  }
  if (scope === 'out') return qty <= 0;
  if (scope === 'range') {
    const min = num(config?.stockMin);
    const max = num(config?.stockMax);
    if (min != null && qty < min) return false;
    if (max != null && qty > max) return false;
    return true;
  }
  return true;
}

function matchesSource(product, config) {
  switch (config?.source) {
    case 'brand': return !!config.brandId && product.brandId === config.brandId;
    case 'category': return !!config.categoryId && product.categoryId === config.categoryId;
    case 'subcategory': {
      const want = String(config.subcategory || '').trim().toLowerCase();
      if (!want) return false;   // empty subcategory must not mean "everything"
      return String(product.subcategory || '').trim().toLowerCase() === want;
    }
    case 'picked': return (config.productIds || []).includes(product.id);
    case 'all':
    default: return true;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byText = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

/**
 * Sort helpers. Every comparator that sorts on a number puts "not counted"
 * LAST regardless of direction — otherwise sorting by stock ascending would
 * lead with every product that has no count at all, which reads as "these are
 * the ones running out" and is exactly backwards.
 */
function comparatorFor(sortBy, config, brandNames) {
  const nullsLast = (av, bv, cmp) => {
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return cmp(av, bv);
  };
  const priceOf = (p) => resolvePrice(p, config);
  const stockOf = (p) => num(p.stockQty);
  switch (sortBy) {
    // Stable sort + "everything is equal" = keep the incoming order.
    case 'asSelected': return () => 0;
    case 'sku': return (a, b) => byText(a.sku, b.sku);
    case 'brand': return (a, b) => byText(brandNames?.get(a.brandId) || '\uffff', brandNames?.get(b.brandId) || '\uffff') || byText(a.name || a.sku, b.name || b.sku);
    case 'stockHigh': return (a, b) => nullsLast(stockOf(a), stockOf(b), (x, y) => y - x);
    case 'stockLow': return (a, b) => nullsLast(stockOf(a), stockOf(b), (x, y) => x - y);
    case 'priceHigh': return (a, b) => nullsLast(priceOf(a), priceOf(b), (x, y) => y - x);
    case 'priceLow': return (a, b) => nullsLast(priceOf(a), priceOf(b), (x, y) => x - y);
    case 'newest': return (a, b) => nullsLast(num(a.createdAt), num(b.createdAt), (x, y) => y - x);
    case 'name':
    default: return (a, b) => byText(a.name || a.sku, b.name || b.sku);
  }
}

/**
 * Apply the whole recipe: source → stock → sort → cap.
 *
 * `brandNames` is an optional Map of brandId → name, used only by the
 * 'brand' sort so products group by brand name rather than by the brand id
 * (which would order them essentially at random).
 */
function selectProducts(products, rawConfig, brandNames) {
  const config = normalizeConfig(rawConfig);
  let list = Array.isArray(products) ? products.slice() : [];
  if (config.excludeInactive) list = list.filter((p) => p.status !== 'inactive');
  list = list.filter((p) => matchesSource(p, config));
  list = list.filter((p) => matchesStock(p, config));
  if (config.sortBy === 'asSelected' && config.source === 'picked') {
    /* matchesSource filters the CATALOGUE list, so the hand-picked order is
     * lost by the time we get here. Restore it from productIds. */
    const rank = new Map((config.productIds || []).map((id, i) => [String(id), i]));
    list.sort((a, b) => (rank.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
  } else {
    list.sort(comparatorFor(config.sortBy, config, brandNames));
  }
  if (config.limit > 0) list = list.slice(0, config.limit);
  return list;
}

/** How many tiles one image holds. */
function itemsPerPage(rawConfig) {
  const config = normalizeConfig(rawConfig);
  return config.columns * config.rows;
}

/**
 * Split the selection across images.
 *
 * The customer asked for "one grid image", but a brand with 200 products
 * cannot be read as one square post. Rather than silently dropping products or
 * shrinking tiles into illegibility, the selection is chunked into a numbered
 * series of images — each one postable on its own.
 */
function paginate(products, rawConfig) {
  const perPage = itemsPerPage(rawConfig);
  const out = [];
  for (let i = 0; i < products.length; i += perPage) out.push(products.slice(i, i + perPage));
  return out.length ? out : [[]];
}

/** Everything the UI needs to describe the result before rendering anything. */
function summarize(products, rawConfig, brandNames) {
  const config = normalizeConfig(rawConfig);
  const selected = selectProducts(products, config, brandNames);
  const perPage = itemsPerPage(config);
  const pages = Math.ceil(selected.length / perPage) || 0;
  const tiles = selected.reduce((acc, p) => acc + (p.mainImagePath ? 1 : 0), 0);
  // Only meaningful when a price is actually being printed. Counted here (not
  // in the UI) because resolvePrice's no-fallback rule means a product can be
  // selected and still have nothing to show for the chosen price level.
  const noPrice = config.showPrice
    ? selected.reduce((acc, p) => acc + (resolvePrice(p, config) == null ? 1 : 0), 0)
    : 0;
  return {
    total: selected.length,
    perPage,
    pages,
    withPhoto: tiles,
    withoutPhoto: selected.length - tiles,
    uncounted: selected.reduce((acc, p) => acc + (num(p.stockQty) == null ? 1 : 0), 0),
    noPrice,
    priceLabel: config.priceSource === 'retail' ? 'retail'
      : config.priceSource === 'wholesale' ? 'wholesale' : `“${config.priceSource}”`,
    config,
  };
}

module.exports = {
  DEFAULTS, SORT_KEYS, STOCK_SCOPES, SOURCES, UI_DESIGN_KEYS, SELECTION_KEYS,
  normalizeConfig, designOnly, applyDesign, resolvePrice, resolvePriceEntry, formatPrice, formatPriceWithEntry,
  describeStock, matchesStock, matchesSource, selectProducts, paginate, itemsPerPage, summarize,
  num,
};
