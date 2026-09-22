/**
 * v0.1.67: the search / sort / selection rules for the Brands, Categories and
 * Suppliers tabs. Pure module, so the range-selection edge cases (which are
 * where list UIs actually break) are testable without a DOM.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const esbuild = require('esbuild');
const bundlePromise = esbuild.build({
  entryPoints: [path.join(ROOT, 'renderer/lib/listTools.js')],
  bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
}).then((out) => out.outputFiles[0].text);

async function load() {
  const text = await bundlePromise;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', text)(require, mod, mod.exports);
  return mod.exports;
}

const ROWS = [
  { id: 'a', name: 'Nike', productCount: 3 },
  { id: 'b', name: 'acme', productCount: 40 },
  { id: 'c', name: 'Brand 10', productCount: 7 },
  { id: 'd', name: 'Brand 2', productCount: 0 },
];

test('an empty query keeps every row', async () => {
  const M = await load();
  assert.equal(M.filterRows(ROWS, '', ['name']).length, 4);
  assert.equal(M.filterRows(ROWS, '   ', ['name']).length, 4);
});

test('search is case-insensitive and covers every given key', async () => {
  const M = await load();
  assert.deepEqual(M.filterRows(ROWS, 'NIK', ['name']).map((r) => r.id), ['a']);
  assert.deepEqual(M.filterRows(ROWS, 'ac', ['name']).map((r) => r.id), ['b']);
  assert.deepEqual(M.filterRows(ROWS, '3', ['name', 'productCount']).map((r) => r.id), ['a']);
  assert.deepEqual(M.filterRows(ROWS, 'nothing here', ['name']), []);
});

test('sorting is by name by default, and never invents an unsorted list', async () => {
  const M = await load();
  assert.deepEqual(M.sortRows(ROWS, undefined).map((r) => r.id), ['b', 'd', 'c', 'a']);
  assert.deepEqual(M.sortRows(ROWS, 'from-an-older-version').map((r) => r.id), ['b', 'd', 'c', 'a']);
});

test('name order ignores case and reads numbers as numbers', async () => {
  const M = await load();
  // "Brand 2" before "Brand 10" — string order would put 10 first.
  assert.deepEqual(M.sortRows(ROWS, 'name').map((r) => r.name), ['acme', 'Brand 2', 'Brand 10', 'Nike']);
  assert.deepEqual(M.sortRows(ROWS, 'nameDesc').map((r) => r.name), ['Nike', 'Brand 10', 'Brand 2', 'acme']);
});

test('a screen can add its own comparator without touching the shared ones', async () => {
  const M = await load();
  const sorted = M.sortRows(ROWS, 'usage', { usage: (a, b) => b.productCount - a.productCount });
  assert.deepEqual(sorted.map((r) => r.name), ['acme', 'Brand 10', 'Nike', 'Brand 2']);
  // And the input array is left alone (the store's arrays are shared).
  assert.equal(ROWS[0].name, 'Nike');
});

test('a plain click selects one row', async () => {
  const M = await load();
  const ids = M.allIds(ROWS);
  const next = M.nextSelection({ selected: [], ids, index: 2 });
  assert.deepEqual(next.selected, ['c']);
  assert.equal(next.lastIndex, 2);
});

test('⌘-click adds and removes without disturbing the rest', async () => {
  const M = await load();
  const ids = M.allIds(ROWS);
  const added = M.nextSelection({ selected: ['a'], ids, index: 3, metaKey: true });
  assert.deepEqual(added.selected, ['a', 'd']);
  const removed = M.nextSelection({ selected: added.selected, ids, index: 0, metaKey: true });
  assert.deepEqual(removed.selected, ['d']);
});

test('shift-click selects the range, forwards and backwards', async () => {
  const M = await load();
  const ids = M.allIds(ROWS);
  const down = M.nextSelection({ selected: ['a'], ids, index: 3, lastIndex: 0, shiftKey: true });
  assert.deepEqual(down.selected, ['a', 'b', 'c', 'd']);
  const up = M.nextSelection({ selected: ['d'], ids, index: 1, lastIndex: 3, shiftKey: true });
  assert.deepEqual(up.selected, ['d', 'b', 'c']);
  // The anchor stays put, so clicking again extends from the same row.
  assert.equal(up.lastIndex, 3);
});

test('shift-click with no previous click behaves like a plain click', async () => {
  const M = await load();
  const ids = M.allIds(ROWS);
  assert.deepEqual(M.nextSelection({ selected: [], ids, index: 1, shiftKey: true }).selected, ['b']);
});

test('a click past the end of the list changes nothing', async () => {
  const M = await load();
  const ids = M.allIds(ROWS);
  const next = M.nextSelection({ selected: ['a'], ids, index: 99 });
  assert.deepEqual(next.selected, ['a']);
});

test('select all is the rows in view, not the whole database', async () => {
  const M = await load();
  assert.deepEqual(M.allIds(ROWS), ['a', 'b', 'c', 'd']);
  assert.deepEqual(M.allIds([]), []);
});
