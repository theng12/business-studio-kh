/**
 * v0.1.65: the mapper must offer a destination for a custom price group.
 *
 * This is half of the reported bug — "he added a new price group and he can't
 * import it because there's no column to add it". The sample sheet now carries
 * the column (test/importSampleWorkbook.test.js) and the database now stores it
 * (test/importPriceGroups.test.js); this pins the middle link: the column has to
 * map to something, or it can only be sent to Skip.
 *
 * The module is ESM/JSX, so it is bundled through esbuild and its exports are
 * exercised directly. No rendering is involved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const esbuild = require('esbuild');

/* esbuild forbids plugins in its synchronous API, so this one awaits the async
 * build once and shares the bundle with every case. */
const bundlePromise = esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/ProductLibrary/ImportModal.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand', '@imgly/background-removal'],
    plugins: [{
      name: 'mapping-harness',
      setup(build) {
        build.onResolve({ filter: /store\/index\.js$/ }, () => ({ path: 'store-shim', namespace: 'test' }));
        build.onLoad({ filter: /^store-shim$/, namespace: 'test' }, () => ({
          contents: 'module.exports = { useAppStore: () => ({}) };',
          loader: 'js',
        }));
      },
    }],
  logLevel: 'silent',
}).then((out) => out.outputFiles[0].text);

async function loadImportModal() {
  const text = await bundlePromise;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', text)(require, mod, mod.exports);
  return mod.exports;
}
const GROUPS = [
  { key: 'export', label: 'Export' },
  { key: 'dealer-net', label: 'Dealer net' },
];

test('a price group gets an amount target and a currency target', async () => {
  const M = await loadImportModal();
  const fields = M.buildProductFields(GROUPS, []);
  const byKey = new Map(fields.map((f) => [f.key, f.label]));
  assert.equal(byKey.get('price.export'), 'Export price');
  assert.equal(byKey.get('price.export.currency'), 'Export currency');
  assert.equal(byKey.get('price.dealer-net'), 'Dealer net price');
  // The built-in currencies are offered too.
  assert.ok(byKey.has('priceRetailCurrency'));
  assert.ok(byKey.has('priceWholesaleCurrency'));
});

test('the column header a user would type maps onto its group', async () => {
  const M = await loadImportModal();
  assert.equal(M.autoGuess('Export price', GROUPS), 'price.export');
  assert.equal(M.autoGuess('Price Export', GROUPS), 'price.export');
  assert.equal(M.autoGuess('Export amount', GROUPS), 'price.export');
  assert.equal(M.autoGuess('export', GROUPS), 'price.export');
  assert.equal(M.autoGuess('Export currency', GROUPS), 'price.export.currency');
  assert.equal(M.autoGuess('Dealer net price', GROUPS), 'price.dealer-net');
});

test('a group named like a built-in price wins over the built-in rule', async () => {
  const M = await loadImportModal();
  // "Export wholesale" must not be read as the wholesale column.
  const groups = [{ key: 'export-wholesale', label: 'Export wholesale' }];
  assert.equal(M.autoGuess('Export wholesale price', groups), 'price.export-wholesale');
  // …while the plain wholesale column still resolves as before.
  assert.equal(M.autoGuess('Wholesale price', groups), 'priceWholesale');
});

test('retail and wholesale currencies map to their own columns', async () => {
  const M = await loadImportModal();
  assert.equal(M.autoGuess('Retail currency', GROUPS), 'priceRetailCurrency');
  assert.equal(M.autoGuess('Wholesale currency', GROUPS), 'priceWholesaleCurrency');
  assert.equal(M.autoGuess('Retail price', GROUPS), 'priceRetail');
});

test('a custom-field column maps by its key, and cannot be stolen', async () => {
  const M = await loadImportModal();
  const keys = ['custom.material', 'custom.voltage'];
  assert.equal(M.autoGuess('custom.material', GROUPS, keys), 'custom.material');
  assert.equal(M.autoGuess('Material', GROUPS, keys), 'custom.material');
  assert.equal(M.autoGuess('voltage', GROUPS, keys), 'custom.voltage');
  const fields = M.buildProductFields([], keys);
  assert.ok(fields.some((f) => f.key === 'custom.material'));
});

test('an unknown column is still Skip, so nothing is guessed into a price', async () => {
  const M = await loadImportModal();
  assert.equal(M.autoGuess('Random column', GROUPS), '__skip__');
  assert.equal(M.autoGuess('', GROUPS), '__skip__');
});
