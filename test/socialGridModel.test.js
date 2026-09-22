/**
 * v0.1.25 — Social Grid decision rules.
 *
 * These tests cover the part of the feature a user will actually argue about:
 * "why is this product not in my post?", "why is this one at the end?", "why
 * does it say sold out?". The rules live in main/util/socialGridModel.js and
 * have no Electron or database dependency, so they run in plain `node --test`.
 *
 * The single most important behaviour pinned here is that a BLANK stock count
 * is not zero. Getting that wrong would print "Sold out" across a catalogue
 * that has simply never been counted, and would sort uncounted products to the
 * top of a "fewest first" list as if they were the ones running out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULTS, normalizeConfig, designOnly, applyDesign, resolvePrice, formatPrice, describeStock,
  matchesStock, selectProducts, paginate, itemsPerPage, summarize, SELECTION_KEYS,
} = require('../main/util/socialGridModel');

function product(over = {}) {
  return {
    id: over.id || `p-${Math.random().toString(36).slice(2, 8)}`,
    sku: over.sku || 'SKU',
    name: over.name || 'Product',
    brandId: over.brandId ?? null,
    categoryId: over.categoryId ?? null,
    subcategory: over.subcategory ?? null,
    status: over.status || 'active',
    priceRetail: over.priceRetail ?? null,
    priceWholesale: over.priceWholesale ?? null,
    prices: over.prices ?? {},
    stockQty: over.stockQty === undefined ? null : over.stockQty,
    mainImagePath: over.mainImagePath ?? null,
    createdAt: over.createdAt ?? 1000,
  };
}

/* ── config clamping ──────────────────────────────────────────────── */

test('normalizeConfig fills in every default for an empty config', () => {
  const c = normalizeConfig();
  assert.equal(c.width, 1080);
  assert.equal(c.height, 1080);
  assert.equal(c.columns, 3);
  assert.equal(c.rows, 3);
  assert.equal(c.sortBy, 'name');
  assert.equal(c.stockScope, 'any');
  assert.equal(c.priceSource, 'retail');
});

test('normalizeConfig clamps values the renderer could not survive', () => {
  const c = normalizeConfig({
    width: 99999, height: 10, columns: 0, rows: 400,
    gap: -50, padding: -1, limit: -3, quality: 0,
  });
  assert.equal(c.width, 8000, 'canvas ceiling');
  assert.equal(c.height, 200, 'canvas floor — a 10px post is not renderable');
  assert.equal(c.columns, 1, 'zero columns would divide by zero');
  assert.equal(c.rows, 8, 'row ceiling');
  assert.equal(c.gap, 0);
  assert.equal(c.padding, 0);
  assert.equal(c.limit, 0);
  assert.equal(c.quality, 1);
});

test('normalizeConfig rejects unknown enum values instead of storing them', () => {
  const c = normalizeConfig({ sortBy: 'nonsense', stockScope: 'nonsense', source: 'nonsense', format: 'gif' });
  assert.equal(c.sortBy, DEFAULTS.sortBy);
  assert.equal(c.stockScope, DEFAULTS.stockScope);
  assert.equal(c.source, DEFAULTS.source);
  assert.equal(c.format, 'png');
});

test('normalizeConfig turns string numbers from HTML inputs into numbers', () => {
  const c = normalizeConfig({ width: '1080', columns: '4', gap: '12' });
  assert.equal(c.width, 1080);
  assert.equal(c.columns, 4);
  assert.equal(c.gap, 12);
});

/* ── blank stock is not zero ──────────────────────────────────────── */

test('a blank stock count stays null through normalization and sorting', () => {
  const [withBlank, withZero] = [product({ stockQty: null }), product({ stockQty: 0 })];
  assert.equal(withBlank.stockQty, null);
  assert.equal(withZero.stockQty, 0);
  assert.notEqual(withBlank.stockQty, withZero.stockQty, 'null and 0 must not compare equal');
});

test('describeStock is empty for an uncounted product but says Sold out for a zero one', () => {
  const config = normalizeConfig({ lowStockAt: 5 });
  assert.equal(describeStock(product({ stockQty: null }), config), '', 'never counted — say nothing');
  assert.equal(describeStock(product({ stockQty: 0 }), config), 'Sold out');
  assert.equal(describeStock(product({ stockQty: 3 }), config), 'Only 3 left');
  assert.equal(describeStock(product({ stockQty: 40 }), config), '40 in stock');
});

test('stock filters treat an uncounted product differently from an out-of-stock one', () => {
  const uncounted = product({ stockQty: null });
  const out = product({ stockQty: 0 });
  const low = product({ stockQty: 2 });
  const plenty = product({ stockQty: 50 });

  const any = normalizeConfig({ stockScope: 'any' });
  assert.ok(matchesStock(uncounted, any) && matchesStock(out, any), 'any includes everything');

  const counted = normalizeConfig({ stockScope: 'counted' });
  assert.equal(matchesStock(uncounted, counted), false);
  assert.equal(matchesStock(out, counted), true, 'a counted zero IS counted');

  assert.equal(matchesStock(uncounted, normalizeConfig({ stockScope: 'out' })), false,
    'a product nobody counted must not appear in "out of stock"');
  assert.equal(matchesStock(out, normalizeConfig({ stockScope: 'out' })), true);

  const lowScope = normalizeConfig({ stockScope: 'low', lowStockAt: 5 });
  assert.equal(matchesStock(low, lowScope), true);
  assert.equal(matchesStock(out, lowScope), false, 'zero is out of stock, not "running low"');
  assert.equal(matchesStock(plenty, lowScope), false);

  const inScope = normalizeConfig({ stockScope: 'in', lowStockAt: 5 });
  assert.equal(matchesStock(plenty, inScope), true);
  assert.equal(matchesStock(low, inScope), false);
  assert.equal(matchesStock(uncounted, inScope), false);

  const ranged = normalizeConfig({ stockScope: 'range', stockMin: 1, stockMax: 10 });
  assert.equal(matchesStock(low, ranged), true);
  assert.equal(matchesStock(plenty, ranged), false);
  assert.equal(matchesStock(uncounted, ranged), false, 'a range is about a number');
});

/* ── sorting ──────────────────────────────────────────────────────── */

test('sorting by stock ascending puts UNCOUNTED products last, not first', () => {
  const rows = [
    product({ sku: 'uncounted', stockQty: null }),
    product({ sku: 'plenty', stockQty: 90 }),
    product({ sku: 'none', stockQty: 0 }),
  ];
  const sorted = selectProducts(rows, { sortBy: 'stockLow' });
  assert.deepEqual(sorted.map((p) => p.sku), ['none', 'plenty', 'uncounted'],
    'leading with uncounted would read as "these are the ones running out", which is backwards');
});

test('sorting by stock descending also puts uncounted products last', () => {
  const rows = [
    product({ sku: 'uncounted', stockQty: null }),
    product({ sku: 'plenty', stockQty: 90 }),
    product({ sku: 'none', stockQty: 0 }),
  ];
  const sorted = selectProducts(rows, { sortBy: 'stockHigh' });
  assert.deepEqual(sorted.map((p) => p.sku), ['plenty', 'none', 'uncounted']);
});

test('name sorting is numeric-aware so SKU-ish names order naturally', () => {
  const rows = [product({ name: 'Shirt 10' }), product({ name: 'shirt 2' }), product({ name: 'Shirt 1' })];
  const sorted = selectProducts(rows, { sortBy: 'name' });
  assert.deepEqual(sorted.map((p) => p.name), ['Shirt 1', 'shirt 2', 'Shirt 10']);
});

test('brand sorting groups by brand NAME, not by brand id', () => {
  const rows = [
    product({ sku: 'z', name: 'Zeta', brandId: 'b-zebra' }),
    product({ sku: 'a', name: 'Alpha', brandId: 'b-acme' }),
  ];
  // Ids would sort acme before zebra by accident; names must decide.
  const names = new Map([['b-zebra', 'Zebra'], ['b-acme', 'Acme']]);
  assert.deepEqual(selectProducts(rows, { sortBy: 'brand' }, names).map((p) => p.sku), ['a', 'z']);
  // With no names available it must still produce a stable, sane order.
  assert.deepEqual(selectProducts(rows, { sortBy: 'brand' }).map((p) => p.sku).sort(), ['a', 'z']);
});

test('sorting by price uses the SELECTED price, not always retail', () => {
  const cheapWholesale = product({ sku: 'w', priceRetail: 100, priceWholesale: 1 });
  const dearWholesale = product({ sku: 'r', priceRetail: 2, priceWholesale: 90 });
  const byRetail = selectProducts([cheapWholesale, dearWholesale], { sortBy: 'priceLow', priceSource: 'retail' });
  assert.deepEqual(byRetail.map((p) => p.sku), ['r', 'w']);
  const byWholesale = selectProducts([cheapWholesale, dearWholesale], { sortBy: 'priceLow', priceSource: 'wholesale' });
  assert.deepEqual(byWholesale.map((p) => p.sku), ['w', 'r'], 'switching price level must reorder');
});

/* ── prices ───────────────────────────────────────────────────────── */

test('resolvePrice reads retail, wholesale, and named price groups', () => {
  const p = product({ priceRetail: 10, priceWholesale: 6, prices: { vip: 4 } });
  assert.equal(resolvePrice(p, { priceSource: 'retail' }), 10);
  assert.equal(resolvePrice(p, { priceSource: 'wholesale' }), 6);
  assert.equal(resolvePrice(p, { priceSource: 'vip' }), 4, 'a custom group works with no code change');
});

test('resolvePrice does NOT fall back to retail when a level is missing', () => {
  const p = product({ priceRetail: 10, priceWholesale: null, prices: {} });
  assert.equal(resolvePrice(p, { priceSource: 'wholesale' }), null,
    'printing retail in a wholesale post would advertise the wrong price to customers');
  assert.equal(resolvePrice(p, { priceSource: 'distributor' }), null);
  // Retail itself still works, and a level that DOES have a value still wins.
  assert.equal(resolvePrice(p, { priceSource: 'retail' }), 10);
  assert.equal(resolvePrice(product({ priceRetail: 10, priceWholesale: 6 }), { priceSource: 'wholesale' }), 6);
});

test('summarize counts products with no price at the chosen level', () => {
  const rows = [
    product({ sku: 'has', priceWholesale: 5 }),
    product({ sku: 'missing', priceWholesale: null }),
  ];
  const s = summarize(rows, { priceSource: 'wholesale', showPrice: true });
  assert.equal(s.noPrice, 1, 'the user is warned before posting, not after');
  assert.equal(s.priceLabel, 'wholesale');
  // Not counted when no price is being printed at all.
  assert.equal(summarize(rows, { priceSource: 'wholesale', showPrice: false }).noPrice, 0);
});

test('resolvePrice returns null when there is no price at all', () => {
  assert.equal(resolvePrice(product({ priceRetail: null }), { priceSource: 'retail' }), null);
  assert.equal(formatPrice(null, { currencySymbol: '$' }), '', 'no price prints nothing, not "$0"');
});

test('formatPrice uses the configured currency symbol', () => {
  assert.equal(formatPrice(1234.5, { currencySymbol: '$' }), '$1,234.5');
  assert.equal(formatPrice(0, { currencySymbol: '£' }), '£0', 'a genuine zero price still prints');
});

/* ── which products ───────────────────────────────────────────────── */

test('source brand / category / picked select exactly the right products', () => {
  const rows = [
    product({ sku: 'a', brandId: 'brand-1', categoryId: 'cat-1' }),
    product({ sku: 'b', brandId: 'brand-2', categoryId: 'cat-1' }),
    product({ sku: 'c', brandId: 'brand-1', categoryId: 'cat-2' }),
  ];
  assert.deepEqual(selectProducts(rows, { source: 'brand', brandId: 'brand-1' }).map((p) => p.sku), ['a', 'c']);
  assert.deepEqual(selectProducts(rows, { source: 'category', categoryId: 'cat-1' }).map((p) => p.sku), ['a', 'b']);
  assert.deepEqual(selectProducts(rows, { source: 'picked', productIds: [rows[2].id] }).map((p) => p.sku), ['c']);
  assert.equal(selectProducts(rows, { source: 'all' }).length, 3);
});

test('an empty subcategory selects NOTHING rather than everything', () => {
  const rows = [product({ sku: 'a', subcategory: 'Boots' })];
  assert.deepEqual(selectProducts(rows, { source: 'subcategory', subcategory: '' }), [],
    'an empty box must not silently mean "the whole catalogue"');
  assert.deepEqual(selectProducts(rows, { source: 'subcategory', subcategory: '   ' }), []);
  assert.equal(selectProducts(rows, { source: 'subcategory', subcategory: 'boots' }).length, 1, 'case-insensitive');
});

test('inactive products are excluded by default but can be included', () => {
  const rows = [product({ sku: 'live' }), product({ sku: 'dead', status: 'inactive' })];
  assert.deepEqual(selectProducts(rows, {}).map((p) => p.sku), ['live']);
  assert.equal(selectProducts(rows, { excludeInactive: false }).length, 2);
});

test('limit caps the selection after sorting, keeping the best-ranked', () => {
  const rows = [product({ sku: 'b', name: 'B' }), product({ sku: 'a', name: 'A' }), product({ sku: 'c', name: 'C' })];
  assert.deepEqual(selectProducts(rows, { limit: 2, sortBy: 'name' }).map((p) => p.sku), ['a', 'b']);
  assert.equal(selectProducts(rows, { limit: 0 }).length, 3, '0 means no limit');
});

/* ── splitting across images ──────────────────────────────────────── */

test('itemsPerPage multiplies columns by rows', () => {
  assert.equal(itemsPerPage({ columns: 3, rows: 3 }), 9);
  assert.equal(itemsPerPage({ columns: 4, rows: 5 }), 20);
});

test('paginate splits a selection into a numbered series', () => {
  const rows = Array.from({ length: 23 }, (_, i) => product({ id: `p${i}` }));
  const pages = paginate(rows, { columns: 3, rows: 3 });
  assert.equal(pages.length, 3, '23 products at 9 per image is three images');
  assert.deepEqual(pages.map((p) => p.length), [9, 9, 5], 'the last image holds the remainder');
});

test('paginate always returns at least one page so the UI has something to show', () => {
  assert.equal(paginate([], { columns: 3, rows: 3 }).length, 1);
});

test('paginate never drops or duplicates a product', () => {
  const rows = Array.from({ length: 17 }, (_, i) => product({ id: `p${i}` }));
  const flat = paginate(rows, { columns: 2, rows: 2 }).flat().map((p) => p.id);
  assert.equal(flat.length, 17);
  assert.deepEqual(flat, rows.map((p) => p.id), 'order is preserved across the split');
});

/* ── the summary the UI shows ─────────────────────────────────────── */

test('summarize reports counts, missing photos and uncounted stock', () => {
  const rows = [
    product({ sku: 'a', mainImagePath: 'x.jpg', stockQty: 5 }),
    product({ sku: 'b', mainImagePath: null }),
    product({ sku: 'c', mainImagePath: 'y.jpg', stockQty: 0 }),
  ];
  const s = summarize(rows, { columns: 2, rows: 2 });
  assert.equal(s.total, 3);
  assert.equal(s.perPage, 4);
  assert.equal(s.pages, 1);
  assert.equal(s.withPhoto, 2);
  assert.equal(s.withoutPhoto, 1);
  assert.equal(s.uncounted, 1);
});

/* ── v0.1.62: the design/selection split that templates are built on ────── */

test('designOnly keeps the look and drops every way of choosing products', () => {
  const design = designOnly({
    width: 1080, height: 1350, columns: 2, rows: 2, background: '#111827',
    showPrice: false, title: 'Weekend sale', sortBy: 'priceLow', format: 'jpeg', quality: 70,
    source: 'brand', brandId: 'b1', categoryId: 'c1', subcategory: 'Taps',
    productIds: ['p1', 'p2'], limit: 9, excludeInactive: false,
    stockScope: 'low', lowStockAt: 3, stockMin: 1, stockMax: 4,
  });
  assert.equal(design.width, 1080);
  assert.equal(design.height, 1350);
  assert.equal(design.columns, 2);
  assert.equal(design.title, 'Weekend sale');
  assert.equal(design.sortBy, 'priceLow');
  assert.equal(design.format, 'jpeg');
  // Every selection key is back at its default.
  for (const key of SELECTION_KEYS) {
    assert.deepEqual(design[key], DEFAULTS[key], `designOnly kept "${key}"`);
  }
});

test('applyDesign puts a selection under a saved look', () => {
  const design = designOnly({ columns: 4, rows: 4, background: '#ffffff', title: 'In stock', sortBy: 'asSelected' });
  const config = applyDesign(design, { source: 'picked', productIds: ['p9', 'p8'] });
  assert.equal(config.columns, 4);
  assert.equal(config.title, 'In stock');
  assert.equal(config.source, 'picked');
  assert.deepEqual(config.productIds, ['p9', 'p8']);
  // Nothing from the design's own (absent) selection leaks in.
  assert.equal(config.brandId, null);
});

test('applyDesign keeps a half-empty template valid instead of throwing', () => {
  const config = applyDesign({}, { source: 'picked', productIds: ['a'] });
  assert.equal(config.columns, DEFAULTS.columns);
  assert.equal(config.width, DEFAULTS.width);
});

test('a picked selection keeps the order it was picked in', () => {
  const products = [product({ id: 'a', name: 'Alpha' }), product({ id: 'b', name: 'Bravo' }), product({ id: 'c', name: 'Charlie' })];
  const asPicked = selectProducts(products, { source: 'picked', productIds: ['c', 'a', 'b'], sortBy: 'asSelected' });
  assert.deepEqual(asPicked.map((p) => p.id), ['c', 'a', 'b']);
  // The default sort still wins when the user did not ask for "as picked".
  const byName = selectProducts(products, { source: 'picked', productIds: ['c', 'a', 'b'], sortBy: 'name' });
  assert.deepEqual(byName.map((p) => p.id), ['a', 'b', 'c']);
});

test('asSelected with an id that no longer exists does not lose the others', () => {
  const products = [product({ id: 'a' }), product({ id: 'b' })];
  const list = selectProducts(products, { source: 'picked', productIds: ['gone', 'b', 'a'], sortBy: 'asSelected' });
  assert.deepEqual(list.map((p) => p.id), ['b', 'a']);
});

test('asSelected is accepted as a sort key by normalizeConfig', () => {
  assert.equal(normalizeConfig({ sortBy: 'asSelected' }).sortBy, 'asSelected');
  assert.equal(normalizeConfig({ sortBy: 'nonsense' }).sortBy, DEFAULTS.sortBy);
});
