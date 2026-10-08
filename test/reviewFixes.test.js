/* 2026-10-08 review fixes — the pure rules. DB-backed cases are in
 * test/reviewFixesNative.test.js (npm run test:native); the desktop/phone
 * search agreement is in test/searchParity.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

/* ── 1. auto-match make-main rides on the add ───────────────────────── */

test('client auto-match sends makeMain on the add, never a set-main by filepath afterwards', () => {
  const client = read('main/client/index.js');
  const start = client.indexOf("handleLocal('images:autoMatchBySku'");
  const batch = client.slice(start, client.indexOf('// v0.17.1: progress events', start));
  assert.match(batch, /rpc\('images:importFromBytes', \{[\s\S]*?makeMain: true/);
  assert.doesNotMatch(batch, /images:setMainImage/, 'a filepath set-main after the add can hit a renumbered photo');
  const ipc = read('main/ipc/images.js');
  assert.match(ipc, /addFromBytes\(productId, bytes, ext, \{ makeMain: makeMain === true \}\)/);
  assert.match(read('main/db/productImages.js'), /makeMainInLock\(productId, res, makeMain\)/);
});

test('makeMain on importFromBytes needs the set-main permission too', () => {
  const { impliedChannels, allowedByCaps } = require('../main/util/permissions');
  assert.deepEqual(impliedChannels('images:importFromBytes', { makeMain: true }), ['images:setMainImage']);
  assert.deepEqual(impliedChannels('images:importFromBytes', { makeMain: false }), []);
  assert.deepEqual(impliedChannels('images:importFromBytes', {}), []);
  const photographer = new Set(['images.add']);
  assert.equal(allowedByCaps(photographer, 'images:importFromBytes'), true);
  assert.equal(allowedByCaps(photographer, 'images:setMainImage'), false, 'so makeMain is refused for this role');
  assert.match(read('main/server/index.js'), /\(impliedChannels\?\.\(channel, body\.args\) \?\? \[\]\)\.some\(\(c\) => !isAllowed\(user\.role, c\)\)/);
});

test('validators: makeMain / withEntry booleans, auto-match modes cannot fall through to the one-shot import', () => {
  const { getValidator } = require('../main/server/validators');
  const add = getValidator('images:importFromBytes');
  assert.equal(add({ productId: 'p', bytes: [1], makeMain: true }), true);
  assert.match(String(add({ productId: 'p', bytes: [1], makeMain: 'yes' })), /makeMain/);
  const rm = getValidator('images:removeFromProduct');
  assert.equal(rm({ productId: 'p', imageId: 'i', withEntry: true }), true);
  assert.match(String(rm({ productId: 'p', imageId: 'i', withEntry: 1 })), /withEntry/);
  const am = getValidator('images:autoMatchBySku');
  const base = { companyId: 'c', folderPath: '/x' };
  assert.equal(am(base), true, 'legacy one-shot call still accepted');
  assert.equal(am({ ...base, dryRun: true }), true);
  assert.match(String(am({ ...base, dryRun: 'true' })), /dryRun must be a boolean/);
  assert.match(String(am({ ...base, files: 'a.jpg' })), /files must be an array/);
  assert.match(String(am({ ...base, files: ['a.jpg'] })), /productId and sourcePath/);
  assert.match(String(am({ ...base, files: [{ productId: 'p', sourcePath: '/x/a.jpg', makeMain: 'y' }] })), /makeMain/);
  assert.equal(am({ ...base, files: [{ productId: 'p', sourcePath: '/x/a.jpg', makeMain: true, sku: 'A' }] }), true);
  assert.match(String(am({ ...base, files: Array.from({ length: 201 }, () => ({ productId: 'p', sourcePath: '/x/a' })) })), /max 200/);
});

/* ── 2. undo restores exactly the entries the delete created ────────── */

test('undo: entry ids come from the delete result, never guessed from the bin', () => {
  const u = loadEsm('renderer/modules/ProductLibrary/undoDelete.js');
  assert.deepEqual(u.entryIdsFrom({ deletedEntryId: 'e1' }), ['e1']);
  assert.deepEqual(u.entryIdsFrom({ deletedEntryIds: ['a', 'b', 'a', null] }, { deletedEntryId: 'c' }), ['a', 'b', 'c']);
  assert.deepEqual(u.entryIdsFrom([{ id: 'image-row' }], null, undefined, true), [], 'a bare photo list (older server) carries no id');
  assert.equal(u.pickImageEntries, undefined, 'the newest-N guess is gone');
  const form = read('renderer/modules/ProductLibrary/ProductForm.jsx');
  assert.match(form, /removeFromProduct\(productId, tile\.id, tile\.contentHash \?\? null, \{ withEntry: true \}\)/);
  assert.match(form, /undoRemovedImages\(productId, entryIds\)/);
  assert.match(read('renderer/modules/ProductLibrary/index.jsx'), /entryIdsFrom\(res\)/);
  assert.match(read('main/ipc/products.js'), /deletedEntryIds: result\.deletedEntryIds/);
});

test('undo: restores each given id once and nothing else', async () => {
  const u = loadEsm('renderer/modules/ProductLibrary/undoDelete.js');
  const restored = [];
  const toasts = [];
  global.window = { api: { deleted: { restore: async (id) => { restored.push(id); }, list: async () => { throw new Error('must not list'); } } } };
  try {
    let refreshed = 0;
    await u.undoImageDeletes({ entryIds: ['e2', 'e5'], addToast: (m, v) => toasts.push([m, v]), onRestored: () => { refreshed += 1; } });
    assert.deepEqual(restored, ['e2', 'e5']);
    assert.equal(refreshed, 1);
    assert.deepEqual(toasts, [['Restored 2 photos.', 'success']]);
  } finally { delete global.window; }
});

/* ── 3. bulk price edit ─────────────────────────────────────────────── */

test('bulk price: clearing a group removes it, unknown currencies stay unknown, rows carry a conflict token', () => {
  const { priceChangeFor, buildPriceRows } = loadEsm('renderer/modules/ProductLibrary/bulkPriceEdit.js');
  const p = { sku: 'A', updatedAt: 111, priceRetail: 10, priceRetailCurrency: null, prices: { vip: 8, khr: { amount: 41000, currency: 'KHR' }, nul: { amount: 5, currency: null } } };
  // Clear → {amount:null,currency:null}, which Overwrite deletes.
  assert.deepEqual(buildPriceRows([p], { source: 'khr', mode: 'set', value: null }).rows,
    [{ sku: 'A', prices: { khr: { amount: null, currency: null } }, expectedUpdatedAt: 111 }]);
  // Legacy bare number: written without a currency, not stamped USD.
  assert.deepEqual(buildPriceRows([p], { source: 'vip', mode: 'set', value: 9 }).rows,
    [{ sku: 'A', prices: { vip: { amount: 9 } }, expectedUpdatedAt: 111 }]);
  assert.deepEqual(priceChangeFor(p, { source: 'vip', mode: 'set', value: 9 }).after, { amount: 9, currency: null });
  // % on an unknown currency rounds by the app default (USD 0.05) and stays unknown.
  assert.deepEqual(priceChangeFor(p, { source: 'nul', mode: 'increase', value: 7 }).after, { amount: 5.35, currency: null });
  assert.deepEqual(buildPriceRows([p], { source: 'nul', mode: 'increase', value: 7 }).rows[0].prices, { nul: { amount: 5.35 } });
  // Known currency is kept.
  assert.deepEqual(buildPriceRows([p], { source: 'khr', mode: 'decrease', value: 10 }).rows[0].prices, { khr: { amount: 36900, currency: 'KHR' } });
  // Columns: the amount only, plus the token.
  assert.deepEqual(buildPriceRows([p], { source: 'retail', mode: 'increase', value: 10 }).rows, [{ sku: 'A', priceRetail: 11, expectedUpdatedAt: 111 }]);
});

test('bulk price modal recomputes from a fresh read and reports conflicts', () => {
  const modal = read('renderer/modules/ProductLibrary/BulkEditModal.jsx');
  const apply = modal.slice(modal.indexOf('async function applyPrice'), modal.indexOf('async function handleApply'));
  assert.match(apply, /await window\.api\.products\.list\(activeCompanyId, \{\}\)/);
  assert.match(apply, /buildPriceRows\(current, priceOpts\)/);
  assert.match(apply, /category === 'conflict'/);
});

/* ── 4. autosave merge vs an in-flight list ─────────────────────────── */

test('a list response never puts back a row older than a merged save', () => {
  const { preferNewerRows } = loadEsm('renderer/store/products.js');
  const merged = new Map([['a', { row: { id: 'a', name: 'saved', updatedAt: 20 }, updatedAt: 20, at: 1000 }]]);
  const stale = [{ id: 'a', name: 'old', updatedAt: 10 }, { id: 'b', name: 'b', updatedAt: 5 }];
  const out = preferNewerRows(stale, merged, 2000);
  assert.equal(out[0].name, 'saved');
  assert.equal(out[0].updatedAt, 20, 'the conflict token is the saved one');
  assert.equal(out[1], stale[1], 'other rows untouched');
  assert.ok(merged.has('a'), 'kept until a list catches up');
  const caughtUp = [{ id: 'a', name: 'newer elsewhere', updatedAt: 30 }];
  assert.equal(preferNewerRows(caughtUp, merged, 2000)[0].name, 'newer elsewhere');
  assert.equal(merged.has('a'), false, 'dropped once the list is at least as new');
  const expired = new Map([['a', { row: { id: 'a', name: 'saved' }, updatedAt: 20, at: 0 }]]);
  assert.equal(preferNewerRows(stale, expired, 10 * 60_000)[0].name, 'old', 'entries expire');
  const store = read('renderer/store/products.js');
  assert.match(store, /const list = preferNewerRows\(rawList, mergedRows\)/);
  assert.match(store, /set\(\{ allProducts: preferNewerRows\(list, mergedRows\) \}\)/);
});

/* ── 5. stall watchdog ─────────────────────────────────────────────── */

function loadClientModule() {
  const originalLoad = Module._load;
  const clientPath = require.resolve('../main/client');
  delete require.cache[clientPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain: { handle() {}, on() {} }, app: { getVersion: () => 'test' }, BrowserWindow: { getAllWindows: () => [] }, shell: {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../main/client'); }
  finally { Module._load = originalLoad; delete require.cache[clientPath]; }
}

test('stall watchdog: one missed ping is retried; a pending write reads as busy, not offline', () => {
  const { stallProbeVerdict } = loadClientModule();
  assert.equal(stallProbeVerdict(1, ['products:bulkUpsert']), 'retry');
  assert.equal(stallProbeVerdict(1, ['products:list']), 'retry');
  assert.equal(stallProbeVerdict(2, ['products:list', 'products:bulkUpsert']), 'busy');
  assert.equal(stallProbeVerdict(2, ['products:list']), 'down');
});

/* ── 6. Show in Finder never launches a package ─────────────────────── */

test('revealPath: plain folders open, packages and files are revealed', async () => {
  const { revealPath, isPackageDirectory } = require('../main/util/openPath');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-reveal-'));
  const plain = path.join(tmp, 'Exports'); fs.mkdirSync(plain);
  const app = path.join(tmp, 'Evil.app'); fs.mkdirSync(app);
  const pkgDir = path.join(tmp, 'Thing.PKG'); fs.mkdirSync(pkgDir);
  const bundle = path.join(tmp, 'NoExt'); fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<plist/>');
  const file = path.join(tmp, 'a.jpg'); fs.writeFileSync(file, 'x');
  const calls = [];
  const shellApi = { openPath: async (p) => { calls.push(['open', p]); return ''; }, showItemInFolder: (p) => calls.push(['reveal', p]) };
  for (const p of [plain, app, pkgDir, bundle, file]) await revealPath(p, { shellApi });
  assert.deepEqual(calls, [['open', plain], ['reveal', app], ['reveal', pkgDir], ['reveal', bundle], ['reveal', file]]);
  assert.equal(isPackageDirectory(plain), false);
  await assert.rejects(revealPath(path.join(tmp, 'missing'), { shellApi }), /Not found/);
  const failing = { openPath: async () => 'no access', showItemInFolder() {} };
  await assert.rejects(revealPath(plain, { shellApi: failing }), /Could not open the folder: no access/);
  for (const rel of ['main/ipc/files.js', 'main/client/index.js']) {
    const src = read(rel);
    const at = src.indexOf("'files:revealPath'");
    assert.match(src.slice(at, at + 400), /revealPath\(absPath\)/, `${rel} uses the shared rule`);
  }
});

/* ── 7. auto-match containment follows symlinks ─────────────────────── */

test('auto-match: a symlink inside the folder that points outside is refused', () => {
  const { isInsideFolder, importEntryProblem } = require('../main/util/autoMatchPlan');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msk-am-')));
  const root = path.join(tmp, 'photos'); fs.mkdirSync(root);
  const outside = path.join(tmp, 'secret'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'AB-1.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'AB-2.jpg'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(outside, 'AB-1.jpg'), path.join(root, 'AB-1.jpg'));
  assert.equal(isInsideFolder(root, path.join(root, 'AB-2.jpg')), true);
  assert.equal(isInsideFolder(root, path.join(root, 'link', 'AB-1.jpg')), false, 'symlinked folder');
  assert.equal(isInsideFolder(root, path.join(root, 'AB-1.jpg')), false, 'symlinked file');
  assert.equal(isInsideFolder(root, path.join(root, 'missing.jpg')), false, 'nothing to import');
  assert.equal(isInsideFolder(root, path.join(root, '..', 'secret', 'AB-1.jpg')), false, 'lexical escape');
  assert.match(importEntryProblem(root, { productId: 'p', sourcePath: path.join(root, 'link', 'AB-1.jpg') }), /not inside/);
  // A folder picked THROUGH a symlink still works for its own files.
  fs.symlinkSync(root, path.join(tmp, 'alias'));
  assert.equal(isInsideFolder(path.join(tmp, 'alias'), path.join(tmp, 'alias', 'AB-2.jpg')), true);
});

/* ── 9. ⌘K LIKE escaping, invisible characters, query cap ───────────── */

function loadSearch() {
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === './index' && /main\/db\/search\.js$/.test(parent?.filename)) return { getDb: () => null };
    return original.call(this, request, parent, isMain);
  };
  try { return require('../main/db/search'); } finally { Module._load = original; }
}

test('search: LIKE wildcards are literal, U+2060 / U+00AD are invisible, queries are capped', () => {
  const s = loadSearch();
  assert.equal(s.likeContains('100%_a\\b'), '%100\\%\\_a\\\\b%');
  assert.equal(s.normalizeSearchText('ក⁠ខ­គ'), 'កខគ');
  assert.equal(s.clampSearchQuery(`  ${'x'.repeat(500)}  `).length, s.MAX_SEARCH_QUERY);
  assert.equal(s.MAX_SEARCH_QUERY, 200);
  const src = read('main/db/search.js');
  assert.equal((src.match(/LIKE \? ESCAPE '\\\\'/g) || []).length, 5, 'supplier name+contact, PO number, catalog name+description');
  assert.doesNotMatch(src, /LIKE \? COLLATE NOCASE/);
});

test('company switch with a half-typed new product says it was discarded', () => {
  const form = read('renderer/modules/ProductLibrary/ProductForm.jsx');
  assert.match(form, /if \(!isCreating\) return undefined;\s*return registerCompanySwitchFlusher\(/);
  assert.match(form, /Unsaved new product discarded/);
});

/* ── 10. the rule file says what auto-match does now ────────────────── */

test('AGENTS.md §13 says matched photos append unless make-main is ticked', () => {
  const doc = read('AGENTS.md');
  const s13 = doc.slice(doc.indexOf('## 13.'), doc.indexOf('## 14.'));
  assert.match(s13, /APPENDED after the product's existing photos/);
  assert.match(s13, /Make the first matched photo the main image/);
  assert.match(s13, /\(verified 2026-10-08\)/);
  assert.doesNotMatch(s13, /`<key>\.ext` → position 0 \(main\)/);
});

/* ── layout: PO totals at 1280, label canvas breaking like print ────── */

test('PO lines: numeric headers may wrap so LINE TOTAL is not under the sticky actions column', () => {
  const css = read('renderer/index.css');
  assert.match(css, /\.po-lines-table th\.is-num \{ white-space: normal;/);
  assert.match(css, /\.po-lines-table td\.is-num \{ white-space: nowrap; \}/);
  assert.match(css, /\.po-lines-table \.po-lines__name \{ min-width: 180px; \}/);
});

test('label canvas never splits inside a word (print does not either)', () => {
  const canvas = read('renderer/modules/LabelStudio/DesignerCanvas.jsx');
  assert.doesNotMatch(canvas, /wordBreak: element\.wrap === false \? 'normal' : 'break-word'/);
  assert.match(canvas, /wordBreak: 'normal',\s*overflowWrap: 'normal'/);
  const labelText = read('main/studioRenderer.js').split('\n').find((l) => l.includes('white-space:$' + "{el.wrap === false ? 'nowrap' : 'normal'}"));
  assert.ok(labelText, 'the label text element in the print document');
  assert.doesNotMatch(labelText, /word-break|overflow-wrap/, 'print uses the default breaking the canvas now matches');
});
