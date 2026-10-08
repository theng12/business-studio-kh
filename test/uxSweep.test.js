/**
 * v0.1.89: the UX sweep — export names, Social Grid, AI deletes, company
 * delete, shortcuts, search, History and the phone viewer's permissions.
 *
 * Pure JS: everything here runs under plain `npm test`. The cases that need a
 * real database (an export run end to end, brand/category audit rows, the
 * capability-aware search) live in test/uxSweepNative.test.js.
 *
 * Renderer helpers are loaded the way test/screens.smoke.test.js loads a
 * screen: bundled with esbuild and evaluated with a minimal browser stub, so
 * the function under test is the shipped one, not a copy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── renderer loader (same approach as screens.smoke) ─────────────────── */

function installBrowserStubs() {
  const noop = () => {};
  const storage = { getItem: () => null, setItem: noop, removeItem: noop };
  const apiStub = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });
  globalThis.localStorage = globalThis.localStorage || storage;
  globalThis.sessionStorage = globalThis.sessionStorage || storage;
  globalThis.document = globalThis.document || {
    addEventListener: noop,
    removeEventListener: noop,
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { style: {}, classList: { add: noop, remove: noop } },
  };
  globalThis.window = globalThis.window || {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: storage,
    location: { href: '', origin: 'app://local' },
    innerWidth: 1400,
    innerHeight: 900,
    api: apiStub,
    visualViewport: null,
  };
  globalThis.navigator = globalThis.navigator || { userAgent: 'node', platform: 'darwin' };
}

const bundles = new Map();
async function loadRenderer(entry) {
  if (bundles.has(entry)) return bundles.get(entry);
  installBrowserStubs();
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn(req, mod, mod.exports);
  bundles.set(entry, mod.exports);
  return mod.exports;
}

/* ── 1. export names keep Khmer ───────────────────────────────────────── */

test('the Unicode export slug keeps Khmer; the asset slug is unchanged', () => {
  const { slugify, slugifyUnicode } = require('../main/util/slug');
  assert.equal(slugifyUnicode('សៀវភៅ ខ្មែរ'), 'សៀវភៅ-ខ្មែរ');
  assert.equal(slugifyUnicode('Nike Air / Max'), 'Nike-Air-Max');
  assert.equal(slugifyUnicode('BF-R5232-GD'), 'BF-R5232-GD', 'an ASCII SKU names its files exactly as before');
  assert.equal(slugifyUnicode('  !!  ', 'x'), 'x');
  // Asset folders depend on the ASCII rule — it must not have moved.
  assert.equal(slugify('សៀវភៅ ខ្មែរ'), '');
  assert.equal(slugify('BF R5232 GD'), 'BF-R5232-GD');
  // The 60-character cap never leaves a base letter without its marks.
  const long = 'ក្ខ'.repeat(40);
  const cut = slugifyUnicode(long);
  assert.ok(Array.from(cut).length <= 60);
  // 'ក្ខ' is base + coeng (a mark) + base: a cut may end on a base letter,
  // never on a dangling coeng.
  assert.ok(!cut.endsWith('\u17D2'), 'the cut split a letter from its mark');
  assert.ok(!/^\p{M}/u.test(cut));
});

test('{NAME} and {BRAND} survive in Khmer, so names stop collapsing to 001.jpg', () => {
  const { buildFilename } = require('../main/exportRunner');
  const ctx = (name, i) => ({
    product: { sku: 'SKU-1', name }, brand: { name: 'ម៉ាក' }, imageIndex: i, dateStr: '2026-10-02', profile: {},
  });
  assert.equal(buildFilename('{NAME}-{INDEX}', ctx('អាវយឺត', 0)), 'អាវយឺត-001');
  assert.equal(buildFilename('{BRAND}_{NAME}', ctx('អាវ', 0)), 'ម៉ាក_អាវ');
});

test('a name produced twice in one run is kept with a suffix, never replaced or skipped', () => {
  const { resolveOutputPath, claimKey } = require('../main/exportRunner');
  const onDisk = new Set(['/out/old.jpg']);
  const exists = (p) => onDisk.has(p);
  for (const mode of ['replace', 'skip', 'keepBoth']) {
    const claimed = new Set();
    const first = resolveOutputPath('/out', 'x', '.jpg', mode, claimed, exists);
    assert.deepEqual(first, { outPath: '/out/x.jpg', action: 'write' }, mode);
    claimed.add(claimKey(first.outPath));
    const second = resolveOutputPath('/out', 'x', '.jpg', mode, claimed, exists);
    assert.equal(second.outPath, '/out/x-2.jpg', `${mode}: image 2 must not land on image 1`);
    assert.equal(second.action, 'keepBoth');
    assert.equal(second.inRun, true);
    claimed.add(claimKey(second.outPath));
    // Case-insensitive, like the Mac's disk.
    const third = resolveOutputPath('/out', 'X', '.jpg', mode, claimed, exists);
    assert.equal(third.outPath, '/out/X-3.jpg');
  }
  // A file that was there BEFORE the run still follows the user's choice.
  assert.equal(resolveOutputPath('/out', 'old', '.jpg', 'replace', new Set(), exists).action, 'replace');
  assert.equal(resolveOutputPath('/out', 'old', '.jpg', 'skip', new Set(), exists).action, 'skip');
});

test('the export run checks for Cancel between images and reports it', () => {
  const runner = read('main/exportRunner.js');
  assert.match(runner, /isCancelled = null/);
  assert.match(runner, /for \(let i = 0; i < images\.length; i\+\+\) \{\s*if \(cancelRequested\(\)\) break;/);
  assert.match(runner, /cancelled,\s*\n\s*productsDone,/);
  const ipc = read('main/ipc/exports.js');
  assert.match(ipc, /expose\('exports:cancel'/);
  assert.match(ipc, /isCancelled: \(\) => run\.cancelled/);
  // Registered on every path a channel needs (AGENTS.md §15).
  assert.match(read('main/server/validators.js'), /'exports:cancel':\s+requireStringArg/);
  assert.match(read('main/preload.js'), /cancel: \(runId\) => invoke\('exports:cancel', runId\)/);
  assert.ok(read('main/client/index.js').includes("'exports:cancel',"));
  const screen = read('renderer/modules/ExportCenter/index.jsx');
  assert.match(screen, /window\.api\.exports\.cancel\(runId\)/);
  assert.doesNotMatch(screen, /Unprocessed images are skipped/, 'the subtitle described a rule export no longer has');
});

test('the Export Center names the filter that emptied its list', async () => {
  const { emptyFilterMessage } = await loadRenderer('renderer/modules/ExportCenter/index.jsx');
  assert.equal(emptyFilterMessage('', 'Shoes'), 'No products in the category “Shoes”.');
  assert.equal(emptyFilterMessage('nike', ''), 'No products match “nike”.');
  assert.equal(emptyFilterMessage('nike', 'Shoes'), 'No products in “Shoes” match “nike”.');
  assert.doesNotMatch(emptyFilterMessage('', 'Shoes'), /“”/);
});

/* ── 2–3. Social Grid ─────────────────────────────────────────────────── */

test('a Social Grid export never overwrites, and keeps a series together', () => {
  const { seriesSlug, freeSeriesSlug, fileNameFor } = require('../main/socialGridRenderer');
  assert.equal(seriesSlug([], { title: 'ផលិតផល ថ្មី' }), 'ផលិតផល-ថ្មី');
  assert.equal(seriesSlug([{ name: 'Nike Air' }], {}), 'nike-air');
  assert.equal(seriesSlug([], {}), 'social-grid');

  const taken = new Set([fileNameFor('post', 1, 3, 'png')]); // post-2.png exists
  const slug = freeSeriesSlug('post', 3, 'png', (n) => taken.has(n));
  assert.equal(slug, 'post-2', 'one page taken moves the WHOLE series');
  assert.equal(freeSeriesSlug('post', 1, 'png', () => false), 'post');

  // Both export paths use it, and neither writes over a file.
  const ipc = read('main/ipc/socialGrid.js');
  assert.match(ipc, /freeSeriesSlug\(seriesSlug\(pages\[0\], ctx\.config\)/);
  assert.match(ipc, /writeFile\(target, bytes, \{ flag: 'wx' \}\)/);
  const client = read('main/client/index.js');
  assert.match(client, /const \{ freeSeriesSlug, fileNameFor \} = require\('\.\.\/socialGridRenderer'\)/);
  assert.match(client, /Buffer\.from\(files\[i\]\.bytes\), \{ flag: 'wx' \}/);
});

test('Social Grid embeds fonts for every string it draws', () => {
  const { renderedText } = require('../main/socialGridRenderer');
  const config = {
    title: 'T', showBrand: true, showPrice: true, showStock: false, priceSource: 'retail',
    overlays: [{ type: 'text', text: '@ហាង' }, { type: 'image', src: 'x.png' }],
  };
  const brandMap = new Map([['b1', { name: 'ម៉ាក' }]]);
  const text = renderedText(config, [{ name: 'n', sku: 's', brandId: 'b1', priceRetail: 5 }, null], brandMap);
  assert.match(text, /ម៉ាក/, 'brand names were missed');
  assert.match(text, /@ហាង/, 'overlay text was missed');
});

test('the Social Grid name field keeps a trailing space while typing', async () => {
  const { withLocalName } = await loadRenderer('renderer/modules/SocialGrid/index.jsx');
  const row = { id: 'p', name: 'Summer', config: {} };
  assert.equal(withLocalName(row, { name: 'Summer ' }).name, 'Summer ');
  assert.equal(withLocalName(row, { name: 'Winter' }).name, 'Summer', 'a real server change still wins');
  const screen = read('renderer/modules/SocialGrid/index.jsx');
  assert.doesNotMatch(screen, /if \(!confirm\(/, 'deletes must use the app confirm(), not window.confirm');
  assert.match(screen, /updateTemplate\(renaming\.id/, 'templates can be renamed');
  const picker = read('renderer/modules/SocialGrid/GridControls.jsx');
  assert.doesNotMatch(picker, /slice\(0, 300\)/, 'the picker must not stop at 300 products');
  assert.match(picker, /<Pagination/);
});

/* ── 4. AI deletes go to the Trash ────────────────────────────────────── */

test('deleting an AI generation moves its file to the Trash and never reuses its name', () => {
  const ai = read('main/ipc/ai.js');
  const start = ai.indexOf("expose('ai:removeGallery'");
  const body = ai.slice(start, ai.indexOf('expose(', start + 10));
  assert.doesNotMatch(body, /unlinkSync|rmSync|fs\.rm\(/, 'a delete must not erase the file');
  assert.match(body, /trashPathInBackground\(abs\)/);

  const { galleryFileName } = require('../main/ai/queueRunner');
  assert.equal(galleryFileName('shoe', '-1', '3f2a9c1b-0000-4000', '.png'), 'shoe-1-3f2a9c1b.png');
  assert.notEqual(galleryFileName('shoe', '', 'aaaaaaaa-1', '.png'), galleryFileName('shoe', '', 'bbbbbbbb-1', '.png'));

  for (const rel of ['renderer/modules/AIStudio/index.jsx', 'renderer/modules/AIStudio/BulkGallery.jsx',
    'renderer/modules/AIStudio/PromoteToProductDialog.jsx']) {
    const src = read(rel);
    assert.doesNotMatch(src, /`app-image:\/\/local\/\$\{encodeURIComponent/, `${rel} draws an unstamped full-size image`);
    assert.match(src, /appImageSrc\([^)]*\{ w: \d+ \}\)/, `${rel} should ask for a thumbnail`);
  }
  assert.doesNotMatch(read('renderer/modules/AIStudio/index.jsx'), /The image file is removed from disk/);
});

/* ── 6 + 8. company delete, permissions wording ───────────────────────── */

test('deleting a company is admin only; editing stays with System settings', () => {
  const { channelCapability, ADMIN_ONLY } = require('../main/util/capabilities');
  const { allowedByCaps } = require('../main/util/permissions');
  assert.equal(channelCapability('companies:remove'), ADMIN_ONLY);
  assert.equal(channelCapability('companies:update'), 'system.manage');
  assert.equal(channelCapability('companies:create'), 'system.manage');
  assert.equal(allowedByCaps(new Set(['system.manage', 'users.manage']), 'companies:remove'), false);
  assert.equal(allowedByCaps(new Set(['*']), 'companies:remove'), true);
});

test('the company delete says what it really does and asks for the name', async () => {
  const { companyDeleteCopy } = await loadRenderer('renderer/modules/Companies/index.jsx');
  const copy = companyDeleteCopy({ name: 'Acme', productCount: 3, brandCount: 1 });
  assert.equal(copy.requireText, 'Acme');
  assert.match(copy.message, /3 products, 1 brand/);
  assert.match(copy.detail, /does not go to Recently deleted/);
  assert.match(copy.detail, /not deleted or moved to the Trash/);
  assert.doesNotMatch(`${copy.message} ${copy.detail}`, /image files on disk/);
  const screen = read('renderer/modules/Companies/index.jsx');
  assert.match(screen, /extra: <BackupReminder \/>/);
  assert.match(screen, /onDelete=\{canDelete \? handleDelete : null\}/);
});

test('a refused RPC reads as a sentence, without the role or channel', () => {
  const server = read('main/server/index.js');
  assert.match(server, /const FORBIDDEN_MESSAGE = "Your account doesn't have permission to do that\. Ask the admin\.";/);
  assert.doesNotMatch(server, /error: `Forbidden: role/);
});

/* ── 9. History ───────────────────────────────────────────────────────── */

test('History filters by who, when and text, and no longer claims to be append-only', async () => {
  const { historyQuery, NO_USER } = await loadRenderer('renderer/modules/History/index.jsx');
  assert.deepEqual(historyQuery({}), {});
  const q = historyQuery({ entityType: 'brand', userId: NO_USER, from: '2026-10-01', to: '2026-10-01', q: ' 50% ' });
  assert.equal(q.entityType, 'brand');
  assert.equal(q.userId, '@local');
  assert.equal(q.until - q.since, 24 * 60 * 60 * 1000, '"to" includes the whole day');
  assert.equal(q.q, '50%');
  const screen = read('renderer/modules/History/index.jsx');
  assert.doesNotMatch(screen, /append-only/);
  assert.match(screen, /canClear \? \(/, 'Clear history is hidden from accounts the server would refuse');

  const { recentWhere } = require('../main/db/auditLog');
  const built = recentWhere({ userId: '@local', since: 1, until: 2, q: '50%_' });
  assert.match(built.whereSql, /user_id IS NULL/);
  assert.match(built.whereSql, /created_at >= @since/);
  assert.equal(built.params.q, '%50\\%\\_%', 'LIKE wildcards typed by the user are literal');
  assert.match(built.whereSql, /SELECT id FROM brands WHERE name LIKE @q/);
});

test('brands and categories write to the audit log', () => {
  for (const rel of ['main/db/brands.js', 'main/db/categories.js']) {
    const src = read(rel);
    assert.match(src, /action: 'create'/, `${rel} create`);
    assert.match(src, /a\.logUpdate\(/, `${rel} update`);
    assert.match(src, /action: 'delete'/, `${rel} delete`);
  }
});

/* ── 10. shortcuts ────────────────────────────────────────────────────── */

test('page shortcuts do nothing under a dialog or inside a text field', async () => {
  const { shortcutBlocked, isTextEntry } = await loadRenderer('renderer/components/ShortcutsModal.jsx');
  const dialogDoc = { querySelector: (sel) => (sel === '[role="dialog"][aria-modal="true"]' ? {} : null) };
  const plainDoc = { querySelector: () => null };
  assert.equal(shortcutBlocked({ tagName: 'DIV' }, dialogDoc), true);
  assert.equal(shortcutBlocked({ tagName: 'DIV' }, plainDoc), false);
  assert.equal(shortcutBlocked({ tagName: 'INPUT', type: 'text' }, plainDoc), true);
  assert.equal(shortcutBlocked({ tagName: 'TEXTAREA' }, plainDoc), true);
  assert.equal(shortcutBlocked({ tagName: 'DIV', isContentEditable: true }, plainDoc), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
  const app = read('renderer/App.jsx');
  assert.match(app, /if \(shortcutBlocked\(e\.target, document\)\) return;/);
});

test('the shortcuts list comes from the nav and follows the account', async () => {
  const { navShortcutRows } = await loadRenderer('renderer/components/ShortcutsModal.jsx');
  const { NAV } = await loadRenderer('renderer/lib/modules.js');
  const all = navShortcutRows(NAV, ['*'], '⌘').map((r) => r.keys[0]);
  for (const k of ['⌘1', '⌘6', '⌘7', '⌘8', '⌘9', '⌘,']) assert.ok(all.includes(k), `${k} missing`);
  assert.equal(all[all.length - 1], '⌘,');
  const viewer = navShortcutRows(NAV, [], '⌘').map((r) => r.action);
  assert.ok(viewer.includes('Dashboard'));
  assert.ok(!viewer.includes('AI Studio'), 'a module this account cannot open is not advertised');
});

/* ── 11. search ───────────────────────────────────────────────────────── */

test('search shows its errors and reaches suppliers and POs only with costing.view', () => {
  const palette = read('renderer/components/SearchPalette.jsx');
  assert.match(palette, /Search failed: \{searchError\}/);
  assert.match(palette, /toggleBrandFilter\?\.\(r\.id\)/, 'a brand result opens that brand');
  assert.match(palette, /openPurchaseOrder\?\.\(r\.id\)/);
  const ipc = read('main/ipc/search.js');
  assert.match(ipc, /isAllowed\(user\.role, 'suppliers:list'\)/);
  assert.match(ipc, /includeCosting: callerMayViewCosting\(\)/);
  const db = read('main/db/search.js');
  assert.match(db, /if \(opts\.includeCosting\)/);
});

/* ── 12. Settings ─────────────────────────────────────────────────────── */

test('Settings: no stale v0.14 hint, and Recently deleted is paged', () => {
  assert.doesNotMatch(read('renderer/modules/Settings/index.jsx'), /Networking ships across v0\.14/);
  const panel = read('renderer/modules/Settings/DeletedItemsPanel.jsx');
  assert.match(panel, /<Pagination/);
  assert.match(panel, /visibleItems\.map/);
});

/* ── 7. the phone viewer ──────────────────────────────────────────────── */

function viewerCaps() {
  const html = read('webclient/index.html');
  const start = html.indexOf('/* caps:begin');
  const end = html.indexOf('/* caps:end */');
  assert.ok(start > 0 && end > start, 'the caps block markers are gone');
  const ctx = {};
  vm.runInNewContext(`${html.slice(start, end)}
    this.capsFromWhoami = capsFromWhoami; this.capsAllow = capsAllow;
    this.gatedCapList = gatedCapList; this.deleteImageConfirmText = deleteImageConfirmText;`, ctx);
  return { html, ...ctx };
}

test('the viewer asks for capabilities, not role names', () => {
  const { html, capsFromWhoami, capsAllow, gatedCapList } = viewerCaps();
  const custom = capsFromWhoami({ user: { role: 'packer', caps: ['overlay.use'] } });
  assert.equal(capsAllow(custom, 'overlay.use'), true);
  assert.equal(capsAllow(custom, 'products.delete'), false);
  // The block runs in its own realm, so compare copies.
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(gatedCapList(['*'])), ['images.add', 'images.manage', 'products.delete', 'overlay.use', 'ai.run']);
  assert.deepEqual(plain(gatedCapList(capsFromWhoami({ user: { role: 'viewer' } }))), []);
  assert.deepEqual(plain(capsFromWhoami({ user: { role: 'editor' } })), ['*'], 'an older server without caps');
  assert.doesNotMatch(html, /body\[data-role="(viewer|photographer)"\]/, 'role-name CSS gating is back');
  assert.doesNotMatch(html, /function isWriter\(\)/);
  assert.match(html, /if \(can\('products\.delete'\)\) list\.appendChild\(menuRow\('🗑 {2}Delete'/);
});

test('the viewer image delete says where the photo goes', () => {
  const { html, deleteImageConfirmText } = viewerCaps();
  const text = deleteImageConfirmText(0);
  assert.match(text, /Recently deleted/);
  assert.doesNotMatch(text, /can.t be undone/i);
  assert.doesNotMatch(html, /This can\\'t be undone\./);
});

test('the viewer previews the same "main image" the apply uses, at a capped size', () => {
  const html = read('webclient/index.html');
  const fnStart = html.indexOf('function overlayPreviewPosition(o)');
  const fnEnd = html.indexOf('function overlayTargetLabel', fnStart);
  const ctx = {};
  vm.runInNewContext(`
    function overlayPositionNumber(o) { return o.position; }
    function overlaySelectedPositions(o) { return o.picks || []; }
    ${html.slice(fnStart, fnEnd)}
    this.args = overlayPreviewArgs;`, ctx);
  const main = ctx.args({ templateId: 't', productId: 'p', scope: 'main' });
  assert.equal('position' in main, false, 'main must use the server\'s processed-first rule, not position 1');
  assert.equal(main.maxPx, 1080);
  assert.equal(ctx.args({ templateId: 't', productId: 'p', scope: 'position', position: 3 }).position, 3);
});
