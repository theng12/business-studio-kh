/* 0.1.95 audit leftovers, items 2–5: Library "Use in ▾", the house exchange
 * rate, ⌘S in editors, and the What's new dot. Pure rules plus source checks
 * for wiring only a rendered app could exercise. No database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
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

/* ── 2. Library "Use in ▾" ─────────────────────────────────────────── */

test('use in: the selection travels in the Library order, hidden ticks after', () => {
  const { orderedSelectionIds } = loadEsm('renderer/modules/ProductLibrary/useInHandoff.js');
  assert.deepEqual(orderedSelectionIds(new Set(['c', 'a', 'z']), ['a', 'b', 'c']), ['a', 'c', 'z']);
  assert.deepEqual(orderedSelectionIds(new Set(), ['a']), []);
});

test('use in: adding to a hand-picked catalog appends without duplicates; "all active" is left alone', () => {
  const { catalogAddPatch } = loadEsm('renderer/modules/ProductLibrary/useInHandoff.js');
  assert.deepEqual(
    catalogAddPatch({ selectionMode: 'explicit', productIds: ['a', 'gone'] }, ['b', 'a', 'c']),
    { patch: { selectionMode: 'explicit', productIds: ['a', 'gone', 'b', 'c'] }, added: 2, allActive: false },
  );
  assert.deepEqual(catalogAddPatch({ selectionMode: 'explicit', productIds: ['a'] }, ['a']), { patch: null, added: 0, allActive: false });
  assert.deepEqual(catalogAddPatch({ selectionMode: 'all' }, ['a']), { patch: null, added: 0, allActive: true });
  // An empty hand-picked catalog takes the products.
  assert.deepEqual(catalogAddPatch({ selectionMode: 'explicit', productIds: [] }, ['x']).patch, { selectionMode: 'explicit', productIds: ['x'] });
});

test('use in: navigation carries company-scoped hand-offs and the export queue', async () => {
  const { createNavigationSlice, handoffIds } = loadEsm('renderer/store/navigation.js');
  assert.deepEqual(handoffIds(['a', '', 'a', 3, 'b']), ['a', 'b']);
  let state = { activeCompanyId: 'co1', activeModule: 'library', addToast() {} };
  const set = (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const slice = createNavigationSlice(set, () => state);
  state = { ...slice, ...state };
  assert.equal(await slice.sendProductsToLabels(['p1', 'p2']), true);
  assert.deepEqual(state.pendingLabelProducts, { companyId: 'co1', ids: ['p1', 'p2'] });
  assert.equal(state.activeModule, 'labelgenerate');
  assert.equal(await slice.startCatalogFromProducts(['p3']), true);
  assert.deepEqual(state.pendingCatalogProducts, { companyId: 'co1', ids: ['p3'] });
  assert.equal(state.activeModule, 'catalogtemplates');
  assert.equal(await slice.sendProductsToExport(['p4', 'p4', 'p5']), true);
  assert.deepEqual(state.exportQueueIds, ['p4', 'p5']);
  assert.equal(state.activeModule, 'export');
  assert.equal(await slice.sendProductsToLabels([]), false, 'nothing to send is not a navigation');
});

test('use in: wiring — menu, receivers subscribe to the store, company switch clears', () => {
  const lib = read('renderer/modules/ProductLibrary/index.jsx');
  assert.match(lib, /label="Use in ▾"/);
  assert.match(lib, /sendProductsToLabels\(selectionInListOrder\(\)\)/);
  assert.match(lib, /sendProductsToExport\(ids\)/);
  assert.match(lib, /<UseInCatalogModal/);
  const labels = read('renderer/modules/LabelStudio/LabelGenerate.jsx');
  assert.match(labels, /useAppStore\(\(s\) => s\.pendingLabelProducts\)/);
  // Declared after the company effect that clears the selection, so it wins on mount.
  assert.ok(labels.indexOf('pendingLabelProducts') > labels.indexOf('[companyId, addToast]);'));
  const catalog = read('renderer/modules/CatalogStudio/index.jsx');
  assert.match(catalog, /useAppStore\(\(s\) => s\.pendingCatalogProducts\)/);
  assert.match(catalog, /selectionMode: 'explicit', productIds: \[\.\.\.handoffIds\]/);
  const companies = read('renderer/store/companies.js');
  assert.match(companies, /pendingLabelProducts: null,/);
  assert.match(companies, /pendingCatalogProducts: null,/);
});

test('use in: leaving Catalog Templates for any other module drops the catalog hand-off', () => {
  const { withHandoffScope } = loadEsm('renderer/store/navigation.js');
  assert.deepEqual(withHandoffScope({ activeModule: 'library' }), { activeModule: 'library', pendingCatalogProducts: null });
  assert.deepEqual(withHandoffScope({ activeModule: 'catalogtemplates' }), { activeModule: 'catalogtemplates' });
  const start = { activeModule: 'catalogtemplates', pendingCatalogProducts: { companyId: 'c', ids: ['a'] } };
  assert.equal(withHandoffScope(start), start);
  assert.deepEqual(withHandoffScope({ pendingPoId: 'x' }), { pendingPoId: 'x' }, 'no module change, nothing dropped');
  assert.match(read('renderer/store/navigation.js'), /set\(withHandoffScope\(patch\)\)/);
});

test('use in: a catalog that changed elsewhere is re-read and retried once', async () => {
  const { addProductsToCatalog } = loadEsm('renderer/modules/ProductLibrary/useInHandoff.js');
  const conflict = new Error('CONFLICT|{"current":{}}');
  const rows = [
    { id: 'cat', name: 'Cat', updatedAt: 1, config: { selectionMode: 'explicit', productIds: ['a'] } },
    { id: 'cat', name: 'Cat', updatedAt: 2, config: { selectionMode: 'explicit', productIds: ['a', 'x'] } },
  ];
  const updates = [];
  let reads = 0;
  const api = {
    get: async () => rows[Math.min(reads++, 1)],
    update: async (id, patch) => { updates.push(patch); if (updates.length === 1) throw conflict; },
    isConflict: (e) => String(e.message).startsWith('CONFLICT|'),
  };
  const out = await addProductsToCatalog(api, 'cat', ['b']);
  assert.equal(out.added, 1);
  assert.deepEqual(updates[1], { config: { selectionMode: 'explicit', productIds: ['a', 'x', 'b'] }, expectedUpdatedAt: 2 },
    'the retry appends to the newer list with the newer revision');
  // A second conflict is not retried forever; a plain error is not retried at all.
  await assert.rejects(addProductsToCatalog({ ...api, get: async () => rows[0], update: async () => { throw conflict; } }, 'cat', ['b']), /CONFLICT/);
  let calls = 0;
  await assert.rejects(addProductsToCatalog({ ...api, get: async () => rows[0], update: async () => { calls += 1; throw new Error('disk full'); } }, 'cat', ['b']), /disk full/);
  assert.equal(calls, 1);
  assert.match(read('renderer/modules/ProductLibrary/UseInCatalogModal.jsx'), /parseConflictError\(e\) \? 'This catalog changed elsewhere/);
});

/* ── 3. House exchange rate ───────────────────────────────────────── */

test('exchange rate: validation, default and the one-time migration', () => {
  const { validRate, houseRateFrom, migrateLocalKhrRate, DEFAULT_KHR_PER_USD, formatRate } = loadEsm('renderer/lib/exchangeRate.js');
  assert.equal(DEFAULT_KHR_PER_USD, 4100);
  assert.equal(validRate('4,100'), 4100);
  for (const bad of [0, -1, '', 'abc', null, true, Infinity]) assert.equal(validRate(bad), null, String(bad));
  assert.equal(houseRateFrom({ exchangeRateKhrPerUsd: 4050 }), 4050);
  assert.equal(houseRateFrom({ exchangeRateKhrPerUsd: -3 }), 4100);
  assert.equal(houseRateFrom(null), 4100);
  assert.equal(formatRate(4100), '4,100');
  // An old per-Mac KHR rate becomes the house rate only while the house rate is the default.
  assert.deepEqual(migrateLocalKhrRate({ KHR: '4000', THB: '36' }, 4100), { write: 4000, rest: { THB: '36' } });
  assert.deepEqual(migrateLocalKhrRate({ KHR: '4000' }, 4080), { write: null, rest: {} });
  assert.deepEqual(migrateLocalKhrRate({ KHR: 'junk' }, 4100), { write: null, rest: {} });
  assert.deepEqual(migrateLocalKhrRate({ THB: '36' }, 4100), { write: null, rest: { THB: '36' } });
});

test('exchange rate: the Library price sort compares USD and KHR in one currency', () => {
  const { sortProducts } = loadEsm('renderer/modules/ProductLibrary/librarySort.js');
  const rows = [
    { id: 'khr41k', priceRetail: 41000, priceRetailCurrency: 'KHR' },
    { id: 'usd12', priceRetail: 12, priceRetailCurrency: 'USD' },
    { id: 'usd9', priceRetail: 9 }, // pre-v0.1.55 rows carry no currency: USD
    { id: 'none' },
  ];
  const asc = sortProducts(rows, { key: 'retail', dir: 'asc' }, new Map(), new Map(), { khrPerUsd: 4100 }).map((p) => p.id);
  assert.deepEqual(asc, ['usd9', 'khr41k', 'usd12', 'none'], '41,000 KHR ≈ $10 sorts between $9 and $12; missing stays last');
  const cheapRiel = sortProducts(rows, { key: 'retail', dir: 'asc' }, new Map(), new Map(), { khrPerUsd: 2000 }).map((p) => p.id);
  assert.deepEqual(cheapRiel, ['usd9', 'usd12', 'khr41k', 'none'], 'the house rate drives it');
});

function loadConfig(userDataRoot) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userDataRoot } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../main/config')];
    return require('../main/config');
  } finally {
    Module._load = originalLoad;
  }
}

test('exchange rate: config default 4100, and the shared guard refuses a non-positive rate', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-rate-'));
  try {
    const config = loadConfig(root);
    assert.equal(config.loadConfig().exchangeRateKhrPerUsd, 4100);
    // assertKnownConfigKeys is what BOTH modes' settings:setOne / setMany call.
    assert.doesNotThrow(() => config.assertKnownConfigKeys({ exchangeRateKhrPerUsd: 4050 }));
    for (const bad of [0, -5, 'abc', null, '']) {
      assert.throws(() => config.assertKnownConfigKeys({ exchangeRateKhrPerUsd: bad }), /Exchange rate must be a number above 0/, String(bad));
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('exchange rate: Settings shows it, Cost Calculator uses the house rate', () => {
  assert.match(read('renderer/modules/Settings/index.jsx'), /<ExchangeRateControl \/>/);
  assert.match(read('renderer/modules/Settings/ExchangeRateControl.jsx'), /1 USD =/);
  const calc = read('renderer/modules/CostCalculator/index.jsx');
  assert.match(calc, /KHR: houseKhrPerUsd/);
  assert.match(calc, /migrateLocalKhrRate\(stored/);
  assert.match(read('renderer/store/bootstrap.js'), /houseKhrPerUsd: houseRateFrom\(settings\)/);
});

/* ── 4. ⌘S ────────────────────────────────────────────────────────── */

test('⌘S: the newest registered editor saves; nothing under a dialog; default always prevented', () => {
  const s = loadEsm('renderer/lib/saveShortcut.js');
  const calls = [];
  const offA = s.registerSaveHandler(() => calls.push('a'));
  const offB = s.registerSaveHandler(() => calls.push('b'));
  let prevented = 0;
  const key = (extra = {}) => ({ key: 's', metaKey: true, preventDefault: () => { prevented += 1; }, ...extra });
  assert.equal(s.handleSaveShortcut(key()), true);
  assert.deepEqual(calls, ['b']);
  assert.equal(s.handleSaveShortcut(key(), { dialogOpen: true }), true);
  assert.deepEqual(calls, ['b'], 'a modal owns the keyboard');
  offB();
  s.handleSaveShortcut(key({ key: 'S', metaKey: false, ctrlKey: true }));
  assert.deepEqual(calls, ['b', 'a'], 'the editor beneath takes over');
  assert.equal(prevented, 3);
  assert.equal(s.handleSaveShortcut(key({ shiftKey: true })), false);
  assert.equal(s.handleSaveShortcut({ key: 's', preventDefault() {} }), false);
  offA();
  assert.equal(s.activeSaveHandler(), null);
  // A rejected save does not escape as an unhandled rejection.
  const off = s.registerSaveHandler(() => Promise.reject(new Error('x')));
  assert.equal(s.handleSaveShortcut(key()), true);
  off();
});

test('⌘S: a focused field is blurred first so its typed value commits, then saved and refocused', () => {
  const s = loadEsm('renderer/lib/saveShortcut.js');
  const log = [];
  const off = s.registerSaveHandler(() => log.push('save'));
  const field = {
    tagName: 'INPUT', isConnected: true,
    blur() { log.push('blur'); },
    focus(opts) { log.push(`focus:${opts?.preventScroll}`); },
  };
  const deferred = [];
  const e = { key: 's', metaKey: true, preventDefault() {} };
  assert.equal(s.handleSaveShortcut(e, { doc: { activeElement: field }, defer: (fn) => deferred.push(fn) }), true);
  assert.deepEqual(log, ['blur'], 'the save waits for the next tick');
  deferred.forEach((fn) => fn());
  assert.deepEqual(log, ['blur', 'save', 'focus:true']);
  // A field that went away is not refocused; a non-field (a button) saves at once.
  log.length = 0;
  field.isConnected = false;
  s.handleSaveShortcut(e, { doc: { activeElement: field }, defer: (fn) => fn() });
  assert.deepEqual(log, ['blur', 'save']);
  log.length = 0;
  s.handleSaveShortcut(e, { doc: { activeElement: { tagName: 'BUTTON', blur() { log.push('blur'); } } } });
  assert.deepEqual(log, ['save']);
  assert.equal(s.isEditableElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(s.isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
  // Nothing registered: no blur, nothing to save.
  off();
  log.length = 0;
  s.handleSaveShortcut(e, { doc: { activeElement: field } });
  assert.deepEqual(log, []);
});

test('⌘S: one mechanism — App listens, SaveStatus registers, editors without onSave opt in', () => {
  assert.match(read('renderer/App.jsx'), /handleSaveShortcut\(e, \{ dialogOpen: modalDialogOpen\(document\) \}\)/);
  assert.match(read('renderer/components/SaveStatus.jsx'), /useSaveShortcut\(\(\) => \{ if \(!busy\) onSave\?\.\(\); \}, Boolean\(onSave\)\)/);
  assert.match(read('renderer/modules/ProductLibrary/ProductForm.jsx'), /useSaveShortcut\(/);
  assert.match(read('renderer/modules/CatalogStudio/TemplateBuilder.jsx'), /useSaveShortcut\(/);
  // Every listed editor shows SaveStatus with onSave, so ⌘S reaches it.
  for (const rel of [
    'renderer/modules/ImageWorkspace/index.jsx',
    'renderer/modules/OverlayStudio/TemplateEditor.jsx',
    'renderer/modules/LabelStudio/LabelTemplates.jsx',
    'renderer/modules/CatalogStudio/index.jsx',
    'renderer/modules/SocialGrid/index.jsx',
    'renderer/modules/PurchaseOrders/PODetail.jsx',
  ]) assert.match(read(rel), /<SaveStatus[^>]*onSave=/, rel);
});

/* ── 5. What's new dot ────────────────────────────────────────────── */

test("what's new dot: shown until the running version has been opened; storage failures are safe", () => {
  const w = loadEsm('renderer/lib/whatsNewSeen.js');
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(w.hasUnseenWhatsNew('0.1.95', w.loadLastSeenVersion(storage)), true);
  w.saveLastSeenVersion('0.1.95', storage);
  assert.equal(w.hasUnseenWhatsNew('0.1.95', w.loadLastSeenVersion(storage)), false);
  assert.equal(w.hasUnseenWhatsNew('0.1.96', w.loadLastSeenVersion(storage)), true, 'the next update brings it back');
  assert.equal(w.hasUnseenWhatsNew('', ''), false, 'no version yet, no dot');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(w.loadLastSeenVersion(broken), '');
  assert.doesNotThrow(() => w.saveLastSeenVersion('0.1.95', broken));
  const side = read('renderer/components/Sidebar.jsx');
  assert.match(side, /className="sidebar__new-dot"/);
  assert.match(side, /onClick=\{openWhatsNew\}/);
});
