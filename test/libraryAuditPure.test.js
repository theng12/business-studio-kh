/* 0.1.94 Product Library / Image Workspace audit — the pure rules behind the
 * fixes, plus source checks for wiring that only a rendered app could
 * exercise. DB-backed cases are in test/libraryAuditNative.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Bundle one renderer ES module to CJS (React stubbed; nothing renders here). */
function loadEsm(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react/jsx-runtime', 'zustand'],
  });
  const mod = { exports: {} };
  const fakeReact = new Proxy({}, { get: () => () => {} });
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(
    (id) => (id === 'react' || id === 'react/jsx-runtime' || id === 'zustand' ? fakeReact : require(id)), mod, mod.exports,
  );
  return mod.exports;
}

/* ── #16 search: words ANDed, SKU separators ignored, exact barcode, Khmer ── */

function loadSearch() {
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === './index' && /main\/db\/search\.js$/.test(parent?.filename)) return { getDb: () => null };
    return original.call(this, request, parent, isMain);
  };
  try { return require('../main/db/search'); } finally { Module._load = original; }
}

test('search: every word must match, in any order, across SKU / name / colour', () => {
  const s = loadSearch();
  const row = { sku: 'MP-6101', name: 'MACEPRO Floor tile', color: 'Matte Blue' };
  assert.ok(s.matchProductSearch(s.compileProductSearch('blue mace'), row));
  assert.ok(s.matchProductSearch(s.compileProductSearch('tile 6101'), row));
  assert.equal(s.matchProductSearch(s.compileProductSearch('blue red'), row), null, 'a word that matches nothing excludes the row');
});

test('search: a SKU matches with its separators left out', () => {
  const s = loadSearch();
  for (const q of ['avm8101', 'AV M8101', 'av_m8101', 'AV-M8101']) {
    assert.deepEqual(s.matchProductSearch(s.compileProductSearch(q), { sku: 'AV-M8101' }), { rank: 0, via: 'text' }, q);
  }
  assert.deepEqual(s.matchProductSearch(s.compileProductSearch('avm81'), { sku: 'AV-M8101' }), { rank: 1, via: 'text' });
});

test('search: a barcode matches exactly, never as a substring, and says so', () => {
  const s = loadSearch();
  const row = { sku: 'X-1', name: 'Thing', barcode: '885 1234 567890' };
  assert.deepEqual(s.matchProductSearch(s.compileProductSearch('8851234567890'), row), { rank: 0, via: 'barcode' });
  assert.equal(s.matchProductSearch(s.compileProductSearch('885123'), row), null);
});

test('search: Khmer is compared NFC-normalised and without zero-width characters', () => {
  const s = loadSearch();
  const stored = 'ក្រ​ឡា‌ប្រ'; // as pasted from another keyboard
  assert.ok(s.matchProductSearch(s.compileProductSearch('ក្រឡាប្រ'), { sku: 'K-1', name: stored }));
  assert.ok(s.matchProductSearch(s.compileProductSearch('ក្រ‍ឡា'), { sku: 'K-1', name: 'ក្រឡា' }));
  // NFC: a decomposed é still finds the composed one.
  assert.ok(s.matchProductSearch(s.compileProductSearch('Épice'), { sku: 'E', name: 'Épice' }));
  assert.equal(s.compileProductSearch('   ​ '), null, 'a blank query is no filter');
});

test('products.list and ⌘K share the one matching rule', () => {
  assert.match(read('main/db/products.js'), /const \{ compileProductSearch, matchProductSearch \} = require\('\.\/search'\)/);
  assert.match(read('main/db/search.js'), /matchProductSearch\(compiled, \{ sku: p\.sku, name: p\.name, color: p\.color_finish, barcode: p\.barcode \}\)/);
  const palette = read('renderer/components/SearchPalette.jsx');
  assert.match(palette, /setEnterQueued\(true\)/, '⌘K must queue an Enter typed before the results arrive');
});

/* ── #18 stable order, #17 ranges, #15 sort keys ───────────────────────── */

test('the Library keeps the shown order while the same view is open', () => {
  const { sortProducts, stableOrder, selectionRange } = loadEsm('renderer/modules/ProductLibrary/librarySort.js');
  const a = { id: 'a', updatedAt: 3 }; const b = { id: 'b', updatedAt: 2 }; const c = { id: 'c', updatedAt: 1 };
  const shown = sortProducts([a, b, c], { key: 'updated', dir: 'desc' }).map((p) => p.id);
  assert.deepEqual(shown, ['a', 'b', 'c']);
  // c is saved and jumps to the top of a fresh sort — the screen keeps it in place.
  const cEdited = { ...c, updatedAt: 9 };
  const resorted = sortProducts([a, b, cEdited], { key: 'updated', dir: 'desc' });
  assert.deepEqual(resorted.map((p) => p.id), ['c', 'a', 'b']);
  const kept = stableOrder(shown, resorted);
  assert.deepEqual(kept.map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(kept[2], cEdited, 'the row object is the fresh one');
  // A new product appears first; a deleted one drops out.
  assert.deepEqual(stableOrder(shown, [{ id: 'n', updatedAt: 10 }, a, c]).map((p) => p.id), ['n', 'a', 'c']);
  // A new view starts from the real sort.
  assert.deepEqual(stableOrder(null, resorted).map((p) => p.id), ['c', 'a', 'b']);
  assert.deepEqual(selectionRange(['a', 'b', 'c', 'd'], 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(selectionRange(['a', 'b'], 'zz', 'b'), ['b']);
});

test('price and stock columns sort by amount, empty last in both directions', () => {
  const { sortProducts } = loadEsm('renderer/modules/ProductLibrary/librarySort.js');
  const rows = [
    { id: 'none' },
    { id: 'ten', priceRetail: 10, priceRetailCurrency: 'USD', stockQty: 5, prices: { vip: { amount: 7, currency: 'USD' } } },
    { id: 'two', priceRetail: 2, priceRetailCurrency: 'USD', stockQty: 0, prices: { vip: 9 } },
  ];
  assert.deepEqual(sortProducts(rows, { key: 'retail', dir: 'asc' }).map((p) => p.id), ['two', 'ten', 'none']);
  assert.deepEqual(sortProducts(rows, { key: 'retail', dir: 'desc' }).map((p) => p.id), ['ten', 'two', 'none']);
  assert.deepEqual(sortProducts(rows, { key: 'price:vip', dir: 'asc' }).map((p) => p.id), ['ten', 'two', 'none'], 'a bare-number group price is read too');
  assert.deepEqual(sortProducts(rows, { key: 'stock', dir: 'desc' }).map((p) => p.id), ['ten', 'two', 'none']);
  const defaults = loadEsm('renderer/store/productsDefaults.js');
  for (const key of ['retail', 'wholesale', 'barcode', 'stock', 'price:vip']) assert.ok(defaults.isValidSortKey(key), key);
  assert.equal(defaults.isValidSortKey('price: x'), false);
});

/* ── #23 bulk price edit ───────────────────────────────────────────────── */

test('bulk price: rounding is USD 0.05, KHR 100, else 0.01', () => {
  const { roundPrice } = loadEsm('renderer/modules/ProductLibrary/bulkPriceEdit.js');
  assert.equal(roundPrice(10.524, 'USD'), 10.5);
  assert.equal(roundPrice(10.526, 'USD'), 10.55);
  assert.equal(roundPrice(12345, 'KHR'), 12300);
  assert.equal(roundPrice(12350, 'KHR'), 12400);
  assert.equal(roundPrice(1.234, 'THB'), 1.23);
});

test('bulk price: Set / Increase % / Decrease %, read through priceEntry', () => {
  const { priceChangeFor, parsePriceInput, buildPriceRows } = loadEsm('renderer/modules/ProductLibrary/bulkPriceEdit.js');
  const p = { sku: 'A', priceRetail: 10, priceRetailCurrency: 'USD', priceWholesale: 41000, priceWholesaleCurrency: 'KHR', prices: { vip: 8 } };
  assert.deepEqual(priceChangeFor(p, { source: 'retail', mode: 'increase', value: 7 }).after, { amount: 10.7, currency: 'USD' });
  assert.deepEqual(priceChangeFor(p, { source: 'wholesale', mode: 'decrease', value: 10 }).after, { amount: 36900, currency: 'KHR' });
  assert.deepEqual(priceChangeFor(p, { source: 'vip', mode: 'set', value: 9 }).after, { amount: 9, currency: 'USD' }, 'a legacy bare number reads as USD');
  assert.equal(priceChangeFor({ sku: 'B' }, { source: 'retail', mode: 'increase', value: 5 }), null, 'no price, nothing to raise');
  assert.equal(priceChangeFor(p, { source: 'retail', mode: 'set', value: 10 }), null, 'unchanged is not a change');
  assert.deepEqual(parsePriceInput('set', ''), { ok: true, value: null });
  assert.equal(parsePriceInput('decrease', '100').ok, false);
  assert.equal(parsePriceInput('increase', '-1').ok, false);
  const { rows, skipped } = buildPriceRows([p, { sku: 'B' }], { source: 'vip', mode: 'increase', value: 50 });
  assert.deepEqual(rows, [{ sku: 'A', prices: { vip: { amount: 12, currency: 'USD' } } }]);
  assert.equal(skipped.length, 1);
  assert.deepEqual(buildPriceRows([p], { source: 'retail', mode: 'set', value: null }).rows, [{ sku: 'A', priceRetail: '' }], 'clearing goes through overwrite as a blank');
});

/* ── #13 auto-match plan ────────────────────────────────────────────────── */

test('auto-match plans before importing, appends, and reports the cap', () => {
  const { buildAutoMatchPlan, summarizeUnmatched, isInsideFolder, importEntryProblem } = require('../main/util/autoMatchPlan');
  const root = '/photos';
  const groups = new Map([
    ['a-1', [{ sourcePath: '/photos/a-1.jpg' }, { sourcePath: '/photos/a-1-2.jpg' }]],
    ['full', [{ sourcePath: '/photos/full.jpg' }, { sourcePath: '/photos/full-2.jpg' }]],
    ['gone', [{ sourcePath: '/photos/gone.jpg' }]],
  ]);
  const skuToProduct = new Map([
    ['a-1', { id: 'p1', sku: 'A-1', name: 'One', imageCount: 3 }],
    ['full', { id: 'p2', sku: 'FULL', imageCount: 49 }],
  ]);
  const plan = buildAutoMatchPlan({ groups, skuToProduct, imageCountOf: (p) => p.imageCount, max: 50, folderPath: root });
  assert.equal(plan.files, 3);
  assert.equal(plan.capSkipped, 1);
  assert.deepEqual(plan.products.map((p) => [p.sku, p.existingCount, p.files.map((f) => f.rel), p.capSkipped]), [
    ['A-1', 3, ['a-1.jpg', 'a-1-2.jpg'], []],
    ['FULL', 49, ['full.jpg'], ['full-2.jpg']],
  ]);
  const un = summarizeUnmatched(['/photos/x/b.PNG', '/photos/a.jpg'], root);
  assert.deepEqual(un.unmatchedSamples, ['a.jpg', 'x/b.PNG']);
  assert.deepEqual(un.unmatchedExtCounts, { '.jpg': 1, '.png': 1 });
  assert.ok(isInsideFolder(root, '/photos/sub/a.jpg'));
  assert.equal(isInsideFolder(root, '/photos/../etc/passwd'), false);
  assert.equal(isInsideFolder(root, '/photosX/a.jpg'), false);
  assert.match(importEntryProblem(root, { productId: 'p1', sourcePath: '/etc/hosts' }), /not inside/);
  assert.equal(importEntryProblem(root, { productId: 'p1', sourcePath: '/photos/a.jpg' }), null);
});

test('auto-match: both handlers offer dryRun + files, and the modal previews before importing', () => {
  const ipc = read('main/ipc/images.js');
  const client = read('main/client/index.js');
  for (const src of [ipc, client]) {
    assert.match(src, /images:autoMatchBySku', async \(\{ companyId, folderPath, dryRun, files \} = \{\}\)/);
    assert.match(src, /buildAutoMatchPlan\(/);
    assert.match(src, /importEntryProblem\(folderPath, entry\)/);
  }
  assert.match(ipc, /setMainById\(entry\.productId, image\.id\)/, 'make-main must go by row id');
  const modal = read('renderer/modules/ProductLibrary/AutoMatchModal.jsx');
  assert.match(modal, /\{ dryRun: true \}/);
  assert.match(modal, /makeMain: makeMain && i === 0/);
  assert.match(modal, /useState\(false\); *\n/, 'make-main defaults off');
  assert.match(modal, /busy=\{busy\}/);
  assert.match(read('main/preload.js'), /autoMatchBySku: +\(companyId, folderPath, opts\)/);
});

/* ── #24 toast action, #20 pagination, #8/#24 undo pickers, #21 drop ───── */

test('toasts accept one action and stay longer with it', () => {
  const t = loadEsm('renderer/store/toasts.js');
  const onClick = () => {};
  assert.deepEqual(t.toastAction({ label: ' Undo ', onClick }), { label: 'Undo', onClick });
  assert.equal(t.toastAction({ label: '', onClick }), null);
  assert.equal(t.toastAction({ label: 'Undo' }), null);
  assert.ok(t.ACTION_TOAST_DURATION_MS >= 5000);
  assert.match(read('renderer/components/Toast.jsx'), /e\.stopPropagation\(\);\s*dismiss\(t\.id\);\s*t\.action\.onClick\(\);/);
});

test('page box clamps a typed page to the list', () => {
  const ui = loadEsm('renderer/components/ui.jsx');
  assert.equal(ui.pageIndexFromInput('3', 9), 2);
  assert.equal(ui.pageIndexFromInput('99', 9), 9);
  assert.equal(ui.pageIndexFromInput('0', 9), 0);
  assert.equal(ui.pageIndexFromInput('', 9), null);
  assert.equal(ui.pageIndexFromInput('x', 9), null);
});

test('undo picks the newest bin entries of the deleted product / photos', () => {
  const u = loadEsm('renderer/modules/ProductLibrary/undoDelete.js');
  const items = [
    { id: 'i3', kind: 'image', productId: 'P', label: 'p-002.jpg' },
    { id: 'i2', kind: 'image', productId: 'P', label: 'p-002.jpg' },
    { id: 'x', kind: 'image', productId: 'Q', label: 'q.jpg' },
    { id: 'i1', kind: 'image', productId: 'P', label: 'p-001.jpg' },
    { id: 'd1', kind: 'product', productId: 'A' },
    { id: 'd0', kind: 'product', productId: 'A' },
  ];
  assert.deepEqual(u.pickImageEntries(items, 'P', 2).map((i) => i.id), ['i3', 'i2']);
  assert.deepEqual(u.pickProductEntries(items, ['A', 'missing']).map((i) => i.id), ['d1']);
});

test('dropped / pasted files: images only, the right extension, text fields left alone', () => {
  const d = loadEsm('renderer/modules/ProductLibrary/imageDrop.js');
  assert.deepEqual(d.importableImageFiles([{ name: 'a.JPG', type: '' }, { name: 'b.pdf', type: 'application/pdf' }, { name: 'c', type: 'image/png' }]).map((f) => f.name), ['a.JPG', 'c']);
  assert.equal(d.extOfImageFile({ name: 'x.jpeg' }), '.jpg');
  assert.equal(d.extOfImageFile({ name: 'clip', type: 'image/png' }), '.png');
  assert.equal(d.extOfImageFile({ name: 'p.HEIC' }), '.heic');
  assert.equal(d.pasteTargetIsTextField({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(d.pasteTargetIsTextField({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(d.pasteTargetIsTextField({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(d.pasteTargetIsTextField({ tagName: 'TR' }), false);
});

/* ── #3 Workspace navigation snapshot, #10 table order ─────────────────── */

test('Workspace ◀ ▶ step a frozen list, not the live store order', () => {
  const { workspaceNavList } = loadEsm('renderer/modules/ImageWorkspace/index.jsx');
  const all = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const frozen = { current: null };
  // Opened from the Library with a filtered + sorted list.
  assert.deepEqual(workspaceNavList({ navIds: ['c', 'a'], allProducts: all, activeProductId: 'a', companyId: 'k', frozen }).map((p) => p.id), ['c', 'a']);
  // Processing moved 'a' to the top of the live list — the frozen list does not move.
  const reordered = [all[0], all[3], all[2], all[1]];
  assert.deepEqual(workspaceNavList({ navIds: ['c', 'a'], allProducts: reordered, activeProductId: 'a', companyId: 'k', frozen }).map((p) => p.id), ['c', 'a']);
  // Opened another way: the whole company, frozen the first time it is needed.
  const first = workspaceNavList({ navIds: null, allProducts: all, activeProductId: 'b', companyId: 'k', frozen }).map((p) => p.id);
  const later = workspaceNavList({ navIds: null, allProducts: reordered, activeProductId: 'b', companyId: 'k', frozen }).map((p) => p.id);
  assert.deepEqual(first, ['a', 'b', 'c', 'd']);
  assert.deepEqual(later, first);
  const ws = read('renderer/modules/ImageWorkspace/index.jsx');
  assert.match(ws, /<ProductCombobox/, 'the 2,500-option native select is gone');
  assert.doesNotMatch(ws, /className="ws-prodnav__select/);
  assert.match(read('renderer/store/navigation.js'), /workspaceNavIds: navIds/);
  assert.match(read('renderer/modules/ProductLibrary/index.jsx'), /openProductInWorkspace\(processingProduct\.id, \{ navIds: orderedIdsRef\.current\.slice\(\) \}\)/);
});

test('Edit in table follows the Library order and pages by 200', () => {
  const { orderLikeLibrary } = loadEsm('renderer/modules/ProductLibrary/BulkTableModal.jsx');
  const rows = ['a', 'b', 'c'].map((id) => ({ id, sku: id.toUpperCase() }));
  assert.deepEqual(orderLikeLibrary(rows, ['c', 'a'], null).map((p) => p.id), ['c', 'a', 'b'], 'unknown rows go last, in their own order');
  assert.deepEqual(orderLikeLibrary(rows.slice().reverse(), null, { key: 'sku', dir: 'asc' }).map((p) => p.id), ['a', 'b', 'c']);
  const modal = read('renderer/modules/ProductLibrary/BulkTableModal.jsx');
  assert.match(modal, /Previous \{GRID_MAX_ROWS\}/);
  assert.match(modal, /setPagePrompt\(\{ start \}\)/, 'moving with unsaved edits must ask first');
  assert.match(modal, /CSS\.supports\('field-sizing', 'content'\)/);
  assert.match(read('renderer/index.css'), /\.bulk-table__textarea \{ field-sizing: content;/);
});

/* ── Wiring checks for the rest ─────────────────────────────────────────── */

test('Library: company switch forgets the panel and the selection', () => {
  const lib = read('renderer/modules/ProductLibrary/index.jsx');
  const block = lib.slice(lib.indexOf('const companyRef = useRef(activeCompanyId);'));
  assert.match(block.slice(0, 600), /setEditing\(null\);\s*setSelectedIds\(new Set\(\)\);/);
});

test('Modal: busy blocks Esc, the backdrop and the X', () => {
  const ui = read('renderer/components/ui.jsx');
  assert.match(ui, /if \(busyRef\.current\) return;\s*onClose\?\.\(\);/);
  assert.match(ui, /if \(!closeOnBackdrop \|\| busy\) return;/);
  assert.match(ui, /onClick=\{busy \? undefined : onClose\}/);
  for (const file of ['AutoMatchModal', 'ImportModal', 'BulkOverlayRunModal', 'BulkSocialRunModal', 'BulkEditModal']) {
    assert.match(read(`renderer/modules/ProductLibrary/${file}.jsx`), /busy=\{/, `${file} must pass busy`);
  }
});

test('Apply overlay: confirm before overwrite, reset to Append, the 1,000 cap, All products', () => {
  const src = read('renderer/modules/ProductLibrary/BulkOverlayRunModal.jsx');
  assert.match(src, /setDestination\('append'\);/);
  assert.match(src, /if \(destination === 'overwrite'\) \{[\s\S]{0,200}confirm\(\{/);
  assert.match(src, /OVERLAY_MAX_PRODUCTS = 1000/);
  assert.match(src, /filters \? 'Current Library filter' : 'All products'/);
  assert.match(read('renderer/modules/ProductLibrary/index.jsx'), /label: 'Non-destructive by default · original kept'/);
});

test('Product panel: footer, Close label, remove selected, inline create, multi-add, paste, drop', () => {
  const form = read('renderer/modules/ProductLibrary/ProductForm.jsx');
  assert.match(form, /\{isCreate \? 'Cancel' : 'Close'\}/);
  assert.match(form, /handleDuplicate\(\); \}\}/, 'Duplicate lives in the ⋯ menu');
  assert.doesNotMatch(form, /window\.prompt\(/);
  assert.match(form, /Remove selected…/);
  assert.match(form, /removeFromProduct\(productId, t\.id, t\.contentHash \?\? null\)/);
  assert.match(form, /pickImageFile\(\{ multiple: true \}\)/);
  assert.match(form, /document\.addEventListener\('paste', onDocPaste\)/);
  assert.match(form, /onDrop=\{handleDrop\}/);
  assert.match(form, /<ConnImg /);
  assert.doesNotMatch(read('renderer/modules/ImageWorkspace/SettingsPanel.jsx'), /window\.(prompt|alert)\(/);
  const css = read('renderer/index.css');
  assert.match(css, /\.lib-panel__footer \{ flex-wrap: wrap;/);
});

test('Library table: ConnImg, button headers with aria-sort, keyboard rows, data columns', () => {
  const table = read('renderer/modules/ProductLibrary/LibraryTable.jsx');
  assert.match(table, /<ConnImg src=\{appImageSrc\(p\.mainImagePath/);
  assert.match(table, /aria-sort=/);
  assert.match(table, /className="lib-th-sort__btn"/);
  assert.match(table, /tabIndex=\{tabbable \? 0 : -1\}/);
  assert.match(table, /formatPriceEntry\(priceEntry\(product, source\)\)/);
  assert.match(table, /onDoubleClick=/);
  assert.match(read('renderer/modules/ProductLibrary/LibraryGrid.jsx'), /<ConnImg src=\{thumbSrc\}/);
  const cols = read('renderer/modules/ProductLibrary/LibraryColumns.jsx');
  for (const key of ['barcode', 'retail', 'wholesale', 'stock']) assert.match(cols, new RegExp(`key: '${key}'`));
});

test('bg removal runs in a module worker with a main-thread fallback', () => {
  const lib = read('renderer/lib/bgRemoval.js');
  assert.match(lib, /new Worker\(new URL\('\.\/bgRemoval\.worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.match(lib, /WorkerStartError/);
  assert.match(read('renderer/lib/bgRemoval.worker.js'), /import\('@imgly\/background-removal'\)/);
  assert.match(read('vite.config.js'), /worker: \{ format: 'es' \}/);
});

test('a product save merges the row and refreshes in the background', () => {
  const store = read('renderer/store/products.js');
  const update = store.slice(store.indexOf('async updateProduct('), store.indexOf('mergeProductRow(row) {'));
  assert.match(update, /get\(\)\.mergeProductRow\(updated\);\s*scheduleBackgroundProductsRefresh\(get\);/);
  assert.doesNotMatch(update, /await get\(\)\.refreshProducts\(\)/);
  assert.match(store, /if \(get\(\)\.productsFreshThrough\(backgroundRefreshMark\)\) return;/);
});
