/**
 * v0.1.66: the bulk table's paste rules.
 *
 * Two of them are the owner's explicit decisions (refuse a wide paste and say
 * why; refuse a tall one whole), and one is the non-destructive default (a blank
 * clipboard cell leaves the field alone). Pure module, so this runs anywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const esbuild = require('esbuild');
const bundlePromise = esbuild.build({
  entryPoints: [path.join(ROOT, 'renderer/modules/ProductLibrary/bulkGridPaste.js')],
  bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
}).then((out) => out.outputFiles[0].text);

async function load() {
  const text = await bundlePromise;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', text)(require, mod, mod.exports);
  return mod.exports;
}

const COLUMNS = ['name', 'sku', 'brand', 'priceRetail'];

test('tab-separated text becomes rows of cells', async () => {
  const M = await load();
  assert.deepEqual(M.parseClipboardTable('a\tb\nc\td'), [['a', 'b'], ['c', 'd']]);
  // CRLF and a trailing newline (what Excel actually puts on the clipboard).
  assert.deepEqual(M.parseClipboardTable('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(M.parseClipboardTable(''), []);
});

test('a paste that fits maps onto the columns from the focused cell', async () => {
  const M = await load();
  const plan = M.planPaste({ text: 'x\ty', rowIndex: 1, colIndex: 2, columns: COLUMNS, rowCount: 5 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.cells, [
    { row: 1, col: 2, key: 'brand', value: 'x' },
    { row: 1, col: 3, key: 'priceRetail', value: 'y' },
  ]);
});

test('a paste wider than the room left is refused, and says why', async () => {
  const M = await load();
  const plan = M.planPaste({ text: 'a\tb\tc', rowIndex: 0, colIndex: 2, columns: COLUMNS, rowCount: 5 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /3 columns wide/);
  assert.match(plan.reason, /only 2 fit from here/);
  assert.match(plan.reason, /brand → priceRetail/);
  assert.match(plan.reason, /drop the extra columns/);
});

test('a paste taller than the products left is refused whole', async () => {
  const M = await load();
  const plan = M.planPaste({ text: 'a\nb\nc', rowIndex: 3, colIndex: 0, columns: COLUMNS, rowCount: 5 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /3 rows/);
  assert.match(plan.reason, /2 products below this cell/);
});

test('blank clipboard cells leave the field alone', async () => {
  const M = await load();
  // 'a\t\tb' has three cells, the middle one empty: columns 0, 1, 2 — so the
  // blank lands on `sku` and is skipped, not written as an empty string.
  const plan = M.planPaste({ text: 'a\t\tb', rowIndex: 0, colIndex: 0, columns: COLUMNS, rowCount: 1 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.cells.map((c) => c.key), ['name', 'brand']);
  assert.deepEqual(plan.cells.map((c) => c.value), ['a', 'b']);
});

test('several images on the clipboard are refused, one at a time', async () => {
  const M = await load();
  const plan = M.planPaste({ text: '', rowIndex: 0, colIndex: 0, columns: COLUMNS, rowCount: 1, imageCount: 3 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /3 images/);
  assert.match(plan.reason, /one at a time/);
});

test('an empty clipboard says so instead of writing nothing quietly', async () => {
  const M = await load();
  assert.equal(M.planPaste({ text: '', rowIndex: 0, colIndex: 0, columns: COLUMNS, rowCount: 1 }).ok, false);
  assert.equal(M.planPaste({ text: '\t\t', rowIndex: 0, colIndex: 0, columns: COLUMNS, rowCount: 1 }).ok, false);
});

test('a row copies out as one tab-separated line', async () => {
  const M = await load();
  const values = { name: 'Widget', sku: 'P-1', brand: 'Acme', priceRetail: 12.5 };
  assert.equal(M.rowToTsv(COLUMNS, (key) => values[key]), 'Widget\tP-1\tAcme\t12.5');
  assert.equal(M.rowToTsv(COLUMNS, () => undefined), '\t\t\t');
});
