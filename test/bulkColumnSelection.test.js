/**
 * v0.1.71: the bulk table's column-selection rules.
 *
 * Two of them are the owner's explicit decisions, and both are the kind that
 * fail silently if a later refactor "helpfully" filters by the visible columns:
 *
 *   1. **SKU is always sent on save**, even when its column is hidden — it is
 *      the key bulkUpsert matches on, so hiding is visual only.
 *   2. **Hiding a column keeps its unsaved edits** (they are keyed by product +
 *      field), and the toolbar reports how many are tucked away.
 *
 * Plus the selection mechanics: Everything stays the default, built-in sets
 * resolve against the live catalogue, reordering is ordered, and unknown or
 * removed keys in a saved set are dropped rather than fatal.
 *
 * Pure modules, so this runs anywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const esbuild = require('esbuild');

function loader(entry) {
  return esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
}

const colsP = loader('renderer/modules/ProductLibrary/bulkColumns.js');
const rowsP = loader('renderer/modules/ProductLibrary/bulkTableRows.js');

function run(out) {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}
const C = (async () => run(await colsP))();
const R = (async () => run(await rowsP))();

const CATALOGUE = [
  'name', 'sku', 'brandId', 'categoryId', 'subcategory', 'colorFinish', 'unit',
  'variant', 'description', 'tags', 'status', 'stockQty',
  'priceRetail', 'priceRetailCurrency', 'priceWholesale', 'priceWholesaleCurrency',
  'price:export', 'priceCurrency:export', 'custom:Finish',
  'supplierSku', 'hsCode', 'cartonWCm', 'cartonHCm', 'cartonDCm', 'weightPerUnitKg',
  'image',
];

/** A localStorage stub — node has none, and save/load are part of the contract. */
function withStorage(fn) {
  const store = new Map();
  const prev = global.localStorage;
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try { return fn(store); } finally { global.localStorage = prev; }
}

/* ── the two save rules ─────────────────────────────────────────────── */

test('a hidden SKU is still sent on save', async () => {
  const { buildSaveRows } = await R;
  const rows = [{ id: 'p1', sku: 'ABC-1', subcategory: null }];
  // Only a non-SKU cell was edited; the SKU column is not even in the edit map,
  // let alone on screen. The row must still carry its key.
  const { saveRows, meta, problems } = buildSaveRows(rows, { '0:subcategory': 'Taps' });
  assert.deepEqual(problems, []);
  assert.deepEqual(saveRows, [{ sku: 'ABC-1', subcategory: 'Taps' }]);
  assert.equal(meta[0].sku, 'ABC-1');
});

test('an edited SKU travels as a rename', async () => {
  const { buildSaveRows } = await R;
  const rows = [{ id: 'p1', sku: 'ABC-1' }];
  const { saveRows, meta } = buildSaveRows(rows, { '0:sku': 'ABC-2' });
  assert.deepEqual(saveRows, [{ sku: 'ABC-2' }]);
  assert.equal(meta[0].skuEdited, true);
  assert.equal(meta[0].onlySku, true);
});

test('an edit in a hidden column is kept and saved', async () => {
  const { buildSaveRows } = await R;
  const rows = [{ id: 'p1', sku: 'ABC-1', prices: {} }];
  // price:export is hidden (it is not in the visible selection below) but the
  // edit is keyed by product+field, so it still becomes a prices patch.
  const edits = { '0:price:export': '12.5', '0:custom:Finish': 'Gold' };
  const selection = ['sku', 'name']; // export price + custom field hidden
  const { saveRows } = buildSaveRows(rows, edits);
  assert.deepEqual(saveRows[0].prices, { export: { amount: 12.5 } });
  assert.deepEqual(saveRows[0].customFields, { Finish: 'Gold' });
  const { hiddenEditedColumns } = await C;
  assert.equal(hiddenEditedColumns(edits, CATALOGUE, selection), 2,
    'the toolbar must be able to say how many hidden edits are being kept');
  assert.equal(hiddenEditedColumns({ '0:subcategory': 'x' }, CATALOGUE, selection), 1);
});

test('a numeric problem still refuses the whole row', async () => {
  const { buildSaveRows } = await R;
  const rows = [{ id: 'p1', sku: 'ABC-1' }];
  const { saveRows, problems } = buildSaveRows(rows, { '0:stockQty': 'lots' });
  assert.equal(saveRows.length, 0);
  assert.match(problems[0].reason, /not a number/);
});

test('the new logistics fields are numeric and travel through the save', async () => {
  const { buildSaveRows } = await R;
  const rows = [{ id: 'p1', sku: 'ABC-1' }];
  const { saveRows, problems } = buildSaveRows(rows, {
    '0:supplierSku': 'SUP-9', '0:hsCode': '8481.80', '0:cartonWCm': '30', '0:weightPerUnitKg': '1.25',
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(saveRows[0], {
    sku: 'ABC-1', supplierSku: 'SUP-9', hsCode: '8481.80', cartonWCm: 30, weightPerUnitKg: 1.25,
  });
});

/* ── the selection mechanics ───────────────────────────────────────── */

test('Everything is the default and stays catalogue order', async () => {
  const { resolveSelection, selectionColumns, isEverything } = await C;
  assert.equal(resolveSelection(undefined, CATALOGUE), null);
  assert.equal(resolveSelection('nonsense', CATALOGUE), null);
  assert.deepEqual(selectionColumns(null, CATALOGUE), CATALOGUE);
  assert.equal(isEverything(null, CATALOGUE), true);
  assert.equal(isEverything([...CATALOGUE], CATALOGUE), true);
  assert.equal(isEverything(['sku'], CATALOGUE), false);
});

test('built-in sets resolve against the live catalogue', async () => {
  const { builtinSetColumns, BUILTIN_SETS } = await C;
  assert.ok(BUILTIN_SETS.find((s) => s.key === 'everything'), 'Everything must exist');
  assert.deepEqual(builtinSetColumns('basics', CATALOGUE), ['name', 'sku', 'brandId', 'categoryId', 'status', 'stockQty']);
  assert.deepEqual(builtinSetColumns('logistics', CATALOGUE),
    ['name', 'sku', 'supplierSku', 'hsCode', 'cartonWCm', 'cartonHCm', 'cartonDCm', 'weightPerUnitKg']);
  // Prices: retail + wholesale with currencies, plus every price group pair.
  const prices = builtinSetColumns('prices', CATALOGUE);
  for (const key of ['sku', 'name', 'priceRetail', 'priceRetailCurrency', 'priceWholesale', 'priceWholesaleCurrency', 'price:export', 'priceCurrency:export']) {
    assert.ok(prices.includes(key), `Prices set is missing ${key}`);
  }
  assert.deepEqual(builtinSetColumns('nope', CATALOGUE), null);
});

test('unknown / removed keys in a saved set are ignored gracefully', async () => {
  const { resolveSelection, orderedCatalogue } = await C;
  const stored = ['sku', 'custom:Deleted', 'not-a-column', 'name', 'sku', 5, null];
  assert.deepEqual(resolveSelection(stored, CATALOGUE), ['sku', 'name'],
    'a set saved before a custom field was removed must still load');
  // An empty explicit selection is legal (the user hid every column).
  assert.deepEqual(resolveSelection([], CATALOGUE), []);
  // The picker shows selected-first in chosen order, then the rest.
  const order = orderedCatalogue(CATALOGUE, ['name', 'sku']);
  assert.deepEqual(order.slice(0, 2), ['name', 'sku']);
  assert.equal(order.length, CATALOGUE.length);
  assert.equal(new Set(order).size, CATALOGUE.length);
});

test('toggling appends, un-toggling removes; arrows move one slot', async () => {
  const { toggleColumn, moveColumn, isEverything } = await C;
  const on = toggleColumn(['sku', 'name'], 'status', CATALOGUE);
  assert.deepEqual(on, ['sku', 'name', 'status']);
  const off = toggleColumn(on, 'name', CATALOGUE);
  assert.deepEqual(off, ['sku', 'status']);
  // Toggling off the last column gives an empty (but explicit) selection.
  assert.deepEqual(toggleColumn(['sku'], 'sku', CATALOGUE), []);
  assert.deepEqual(moveColumn(['sku', 'name', 'status'], 'name', -1, CATALOGUE), ['name', 'sku', 'status']);
  assert.deepEqual(moveColumn(['sku', 'name', 'status'], 'name', 1, CATALOGUE), ['sku', 'status', 'name']);
  // At the edges the move is a no-op, not a wrap.
  assert.deepEqual(moveColumn(['sku', 'name'], 'sku', -1, CATALOGUE), ['sku', 'name']);
  assert.deepEqual(moveColumn(['sku', 'name'], 'name', 1, CATALOGUE), ['sku', 'name']);
  void isEverything;
});

test('the last-used selection is stored separately from the widths', async () => {
  const { loadColumnSelection, saveColumnSelection, COLUMNS_STORAGE_KEY } = await C;
  await withStorage((store) => {
    // A remembered width map, as the resize feature writes it.
    store.set('BulkTable.columnWidths', JSON.stringify({ name: 260 }));
    saveColumnSelection(['sku', 'name']);
    assert.deepEqual(loadColumnSelection(), ['sku', 'name']);
    assert.deepEqual(JSON.parse(store.get('BulkTable.columnWidths')), { name: 260 },
      'saving a column selection must not touch the width map');
    // Everything is stored by absence, so a new column still auto-appears.
    saveColumnSelection(null);
    assert.equal(store.has(COLUMNS_STORAGE_KEY), false);
    assert.equal(loadColumnSelection(), null);
  });
});

test('a group price is read from either stored shape', async () => {
  // v0.1.79: prices[group] is `{ amount, currency }` normally, but rows written
  // before v0.1.55 hold a bare number. Reading `.amount` off those showed an
  // empty cell for a price the product actually has — and the bulk table is
  // where prices get edited, so a blank cell there reads as "no price set".
  const { productValue } = await R;
  const mixed = {
    prices: {
      vip: { amount: 1234.5, currency: 'USD' },
      dealer: 55,
      empty: { amount: null, currency: 'USD' },
    },
  };
  assert.equal(productValue(mixed, 'price:vip'), 1234.5);
  assert.equal(productValue(mixed, 'price:dealer'), 55, 'the legacy bare number is not blank');
  assert.equal(productValue(mixed, 'price:empty'), '');
  assert.equal(productValue(mixed, 'price:missing'), '');

  assert.equal(productValue(mixed, 'priceCurrency:vip'), 'USD');
  assert.equal(productValue(mixed, 'priceCurrency:dealer'), 'USD', 'a bare number has no currency: the default');
});
