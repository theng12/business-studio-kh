/**
 * Home grid + per-module sidebar (owner, 2026-10-08: "i want the 'module' to
 * be a square grid instead"). The module registry (renderer/lib/modules.js) is
 * the one list the Home tiles, the sidebar, the ⌘ shortcuts, the shortcuts
 * sheet and ⌘K's "Go to" all read, so these pin it against the route table,
 * the navigation allow-list and the UI crawl.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function load(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const reg = load('renderer/lib/modules.js');
const layout = load('renderer/modules/Home/layout.js');

function routedPages() {
  const block = strip(read('renderer/App.jsx')).match(/const PAGES\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'PAGES map not found');
  return [...block[1].matchAll(/^\s*([a-z0-9]+):/gm)].map((m) => m[1]);
}
function allowList() {
  const block = strip(read('renderer/store/navigation.js')).match(/const MODULES\s*=\s*\[([\s\S]*?)\]/);
  return [...block[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
}

/** A storage whose every call throws (private window, blocked site data). */
const throwingStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('the registry covers every routed page exactly once, Home aside', () => {
  const ids = reg.allPages().map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], 'a page is listed in two modules');
  const routed = routedPages();
  assert.ok(routed.length >= 25, `PAGES looks truncated (${routed.length})`);
  assert.equal(routed[0], 'home');
  assert.deepEqual([...ids].sort(), routed.filter((id) => id !== 'home').sort());
  assert.deepEqual([...allowList()].sort(), [...routed].sort(), 'MODULES allow-list and PAGES disagree');
  assert.match(read('renderer/store/navigation.js'), /ALWAYS_AVAILABLE = new Set\(\['home',/);
  assert.match(read('renderer/store/navigation.js'), /activeModule: 'home',/);
});

test('the grouping the owner sees, and no tile for an unbuilt module', () => {
  assert.deepEqual(reg.APP_MODULES.map((m) => m.id), ['products', 'media', 'labels', 'purchasing', 'fuel', 'assets', 'people', 'finance', 'system']);
  for (const m of reg.APP_MODULES) {
    assert.ok(m.name && m.description && m.icon, `${m.id} has a name, a description and an icon`);
    assert.ok(m.description.length <= 60, `${m.id}: the description fits a tile in one or two lines`);
    assert.ok(reg.allPages().some((p) => p.moduleId === m.id && !p.hidden), `${m.id} has a page`);
  }
  const icons = read('renderer/components/navIcons.jsx');
  for (const key of new Set([...reg.APP_MODULES.map((m) => m.icon), ...reg.allPages().map((p) => p.icon)])) {
    assert.match(icons, new RegExp(`\\n  ${key}: Icon\\w+,`), `icon "${key}" is drawn in navIcons.jsx`);
  }
});

test('which module a page belongs to is derived from its id', () => {
  assert.equal(reg.moduleOfPage('fuelfills').id, 'fuel');
  assert.equal(reg.moduleOfPage('labelgenerate').id, 'labels');
  assert.equal(reg.moduleOfPage('catalogstudio').id, 'labels', 'the old catalog id stays in its module');
  assert.equal(reg.moduleOfPage('support').id, 'system');
  assert.equal(reg.moduleOfPage('socialgrid').id, 'media');
  assert.equal(reg.moduleOfPage('staff').id, 'people');
  assert.equal(reg.moduleOfPage('home'), null);
  assert.equal(reg.moduleOfPage('nope'), null);
  // The sidebar derives it every render; nothing in the store holds a module.
  assert.match(read('renderer/components/Sidebar.jsx'), /const currentModule = moduleOfPage\(activeModule\);/);
  assert.doesNotMatch(read('renderer/store/navigation.js'), /activeModuleGroup|currentModuleId/);
});

test('caps hide pages, empty sections and whole tiles', () => {
  const ids = (mods) => mods.map((m) => m.id);
  assert.deepEqual(ids(reg.visibleModules(['*'])), ['products', 'media', 'labels', 'purchasing', 'fuel', 'assets', 'people', 'finance', 'system']);
  // Fixed Assets: view or manage; the count-only role (stage A3, phone) has no desktop page yet.
  assert.deepEqual(ids(reg.visibleModules(['assets.view'])), ['products', 'assets', 'system']);
  assert.deepEqual(ids(reg.visibleModules(['assets.count'])), ['products', 'system']);
  assert.deepEqual(ids(reg.visibleModules([])), ['products', 'system'], 'a viewer sees only the ungated modules');
  assert.deepEqual(ids(reg.visibleModules(['fuel.record'])), ['products', 'fuel', 'system']);
  const finance = reg.getModule('finance');
  assert.deepEqual(reg.visiblePages(finance, ['finance.record']).map((p) => p.id), ['financeexpenses']);
  assert.deepEqual(reg.visiblePages(finance, ['finance.view']).map((p) => p.id), ['financeexpenses', 'financeaccounts', 'financereports']);
  const fuel = reg.getModule('fuel');
  assert.deepEqual(reg.visiblePages(fuel, ['fuel.record']).map((p) => p.id), ['fuelassets', 'fuelfills', 'fueltanks', 'fuelprices']);
  const media = reg.getModule('media');
  assert.deepEqual(reg.visibleSections(media, ['catalog.design']).map((s) => s.label), ['Social'], 'an empty section is dropped');
  assert.ok(!reg.visiblePages(reg.getModule('labels'), ['*']).some((p) => p.id === 'catalogstudio'), 'hidden pages are not listed');
  assert.deepEqual(reg.visiblePages(reg.getModule('system'), []).map((p) => p.id), ['settings'], 'Settings is never gated (§5)');
});

test('a tile opens the last page visited there, else the first it may open', () => {
  const fuel = reg.getModule('fuel');
  assert.equal(reg.entryPage(fuel, { caps: ['*'] }), 'fueloverview');
  assert.equal(reg.entryPage(fuel, { caps: ['*'], lastPages: { fuel: 'fueltanks' } }), 'fueltanks');
  assert.equal(reg.entryPage(fuel, { caps: ['fuel.record'], lastPages: { fuel: 'fuelreports' } }), 'fuelassets', 'a page the account lost falls back');
  assert.equal(reg.entryPage(fuel, { caps: ['*'], isAvailable: () => false }), null, 'nothing available without a company');
  const products = reg.getModule('products');
  const always = new Set(['dashboard', 'company']);
  assert.equal(reg.entryPage(products, { caps: ['*'], isAvailable: (id) => always.has(id), lastPages: { products: 'library' } }), 'dashboard');
});

test('last-page memory survives a storage that throws', () => {
  assert.deepEqual(reg.loadLastPages(throwingStorage), {});
  assert.deepEqual(reg.loadLastPages(undefined), {});
  const next = reg.rememberPage('fuelfills', {}, throwingStorage);
  assert.deepEqual(next, { fuel: 'fuelfills' }, 'kept in memory when it cannot be saved');
  const store = memoryStorage();
  store.setItem(reg.LAST_PAGES_KEY, '{not json');
  assert.deepEqual(reg.loadLastPages(store), {});
  store.setItem(reg.LAST_PAGES_KEY, '[1,2]');
  assert.deepEqual(reg.loadLastPages(store), {});
  let pages = reg.rememberPage('fueltanks', reg.loadLastPages(store), store);
  pages = reg.rememberPage('library', pages, store);
  pages = reg.rememberPage('support', pages, store);
  reg.rememberPage('home', pages, store);
  assert.deepEqual(reg.loadLastPages(store), { fuel: 'fueltanks', products: 'library' }, 'hidden pages and Home are not remembered');
  // The navigation slice records it on every completed navigation.
  assert.match(read('renderer/store/navigation.js'), /if \(patch\?\.activeModule\) rememberPage\(patch\.activeModule\);/);
});

test('the app opens on Home unless one module is all this account can reach', () => {
  assert.equal(reg.startPage({ caps: ['*'] }), 'home');
  assert.equal(reg.startPage({ caps: [] }), 'dashboard', 'a view-only role reaches Products alone (System aside)');
  assert.equal(reg.startPage({ caps: ['fuel.record'] }), 'home', 'Products + Fuel: Home');
  const fuelOnly = [reg.getModule('fuel'), reg.getModule('system')];
  assert.equal(reg.startPage({ caps: ['fuel.record'], modules: fuelOnly }), 'fuelassets');
  assert.equal(reg.startPage({ caps: ['fuel.record'], modules: fuelOnly, lastPages: { fuel: 'fuelfills' } }), 'fuelfills');
  assert.equal(reg.startPage({ caps: ['fuel.record'], modules: fuelOnly, isAvailable: () => false }), 'home');
  assert.match(read('renderer/App.jsx'), /const target = startPage\(\{ caps: userCaps/);
});

test('the shortcut map is unchanged by the move, and ⌘⇧H is Home', () => {
  const map = reg.shortcutMap();
  assert.deepEqual(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.module])), {
    1: 'dashboard', 2: 'library', 3: 'workspace', 4: 'aistudio', 5: 'overlay', 6: 'export',
    7: 'history', 8: 'suppliers', 9: 'purchaseorders', ',': 'settings',
  });
  assert.deepEqual(map['3'].caps, ['images.manage'], 'shortcuts keep their caps');
  assert.equal(map[','].caps, undefined, 'Settings is ungated');
  assert.equal(reg.isHomeShortcut({ metaKey: true, shiftKey: true, key: 'H' }), true);
  assert.equal(reg.isHomeShortcut({ ctrlKey: true, shiftKey: true, key: 'h' }), true);
  assert.equal(reg.isHomeShortcut({ metaKey: true, key: 'h' }), false, '⌘H is macOS Hide');
  assert.equal(reg.isHomeShortcut({ metaKey: true, shiftKey: true, altKey: true, key: 'H' }), false);
  assert.match(read('renderer/App.jsx'), /const SHORTCUTS = shortcutMap\(\);/);
  assert.match(read('renderer/App.jsx'), /if \(isHomeShortcut\(e\)\) \{\s*if \(shortcutBlocked\(e\.target, document\)\) return;/);
});

test('⌘K lists modules and pages the account may open', () => {
  const fuel = reg.searchNav('fuel', ['*']);
  assert.deepEqual(fuel[0], { kind: 'module', id: 'fuel', label: 'Go to Fuel', sublabel: reg.getModule('fuel').description, exact: true });
  assert.deepEqual(reg.searchNav('purchas', ['*']).map((r) => `${r.kind}:${r.id}`), ['module:purchasing', 'page:purchaseorders'], 'module first, then its matching pages');
  assert.deepEqual(reg.searchNav('fill', ['*']).map((r) => r.id), ['fuelfills']);
  assert.deepEqual(reg.searchNav('label hist', ['*']).map((r) => r.id), ['labeljobs']);
  assert.deepEqual(reg.searchNav('fuel', []), [], 'no Fuel for an account without fuel caps');
  assert.deepEqual(reg.searchNav('', ['*']), []);
  assert.deepEqual(reg.searchNav('8851234567890', ['*']), [], 'a scanned barcode never matches a module');
  assert.ok(reg.searchNav('s', ['*']).length <= 4);
  const palette = read('renderer/components/SearchPalette.jsx');

  assert.match(palette, /r\.kind === 'module' \? await openModule\?\.\(r\.id, userCaps\)/);
});

test('tile badges are gated, cached per company and silent on failure', async () => {
  reg.clearBadgeCache();
  const fuel = reg.getModule('fuel');
  let calls = 0;
  const api = { fuel: { getOverview: async () => { calls += 1; return { openFlags: { red: 3 } }; } } };
  assert.equal(await reg.loadBadge(fuel, { api, caps: ['fuel.record'], companyId: 'a' }), null, 'needs fuel.manage');
  assert.equal(await reg.loadBadge(fuel, { api, caps: ['*'], companyId: null }), null, 'needs a company');
  assert.deepEqual(await reg.loadBadge(fuel, { api, caps: ['*'], companyId: 'a', now: 1000 }), { count: 3, label: '3 red flags', tone: 'rose' });
  await reg.loadBadge(fuel, { api, caps: ['*'], companyId: 'a', now: 2000 });
  assert.equal(calls, 1, 'cached for a minute');
  await reg.loadBadge(fuel, { api, caps: ['*'], companyId: 'a', now: 70_000 });
  assert.equal(calls, 2);
  const broken = { fuel: { getOverview: async () => { throw new Error('offline'); } } };
  assert.equal(await reg.loadBadge(fuel, { api: broken, caps: ['*'], companyId: 'b' }), null);
  const po = reg.getModule('purchasing');
  const none = { purchaseOrders: { list: async (_c, f) => { assert.deepEqual(f, { status: 'open' }); return []; } } };
  assert.equal(await reg.loadBadge(po, { api: none, caps: ['*'], companyId: 'c' }), null, 'zero shows nothing');
  const one = { purchaseOrders: { list: async () => [{}] } };
  assert.equal((await reg.loadBadge(po, { api: one, caps: ['costing.view'], companyId: 'd' })).label, '1 open order');
});

test('the Home grid fits 1280 × 800 and keeps rows even', () => {
  // 1280 × 800 window: ~1000 px of content width, ~600 px under the header.
  const small = layout.gridLayout({ width: 1000, height: 600, count: 7 });
  assert.equal(small.cols, 4);
  assert.ok(small.rows * small.size + (small.rows - 1) * layout.TILE_GAP <= 600, 'two rows fit');
  const ten = layout.gridLayout({ width: 1000, height: 600, count: 10 });
  assert.ok(ten.rows * ten.size + (ten.rows - 1) * layout.TILE_GAP <= 600, 'ten tiles still fit without scrolling');
  assert.equal(layout.gridLayout({ width: 1650, height: 880, count: 7 }).cols, 4, '7 tiles are 4 + 3, not 5 + 2');
  assert.equal(layout.gridLayout({ width: 1650, height: 880, count: 10 }).cols, 5);
  assert.equal(layout.gridLayout({ width: 700, height: 600, count: 7 }).cols, 3);
  assert.ok(layout.gridLayout({ width: 4000, height: 3000, count: 2 }).size <= layout.MAX_TILE);
  const g = { cols: 4, count: 7 };
  assert.equal(layout.moveFocus(0, 'ArrowRight', g), 1);
  assert.equal(layout.moveFocus(0, 'ArrowLeft', g), 0);
  assert.equal(layout.moveFocus(1, 'ArrowDown', g), 5);
  assert.equal(layout.moveFocus(3, 'ArrowDown', g), 3, 'no tile below: stay');
  assert.equal(layout.moveFocus(5, 'ArrowUp', g), 1);
  assert.equal(layout.moveFocus(2, 'End', g), 6);
  assert.equal(layout.moveFocus(6, 'ArrowRight', g), 6);
});

test('Settings is one click away on every screen, and Home on every screen', () => {
  const sidebar = read('renderer/components/Sidebar.jsx');
  assert.match(sidebar, /currentModule\?\.id !== 'system' \? \(\s*<nav className="sidebar__nav sidebar__nav--pinned"/);
  assert.match(sidebar, /\{renderPage\(getPage\('settings'\)\)\}/);
  assert.match(sidebar, /className=\{`sidebar__item sidebar__home/);
  assert.match(sidebar, /<span>What's new<\/span>/, 'What\'s new stays in the footer (§3)');
  assert.match(sidebar, /<span>Support this app<\/span>/, 'Support stays in the footer (§4)');
  assert.doesNotMatch(sidebar, /Sidebar\.closedSections/, 'the old collapsible-section state is gone');
});

test('the UI crawl reaches every listed page through its own module', () => {
  const crawl = read('scripts/probe-ui-crawl.js');
  const block = crawl.match(/const PAGE_LABELS = \[([\s\S]*?)\n\];/)[1];
  const rows = [...block.matchAll(/\['([a-z0-9]+)', '([^']+)', '([a-z]+)'\]/g)].map((m) => ({ id: m[1], label: m[2], mod: m[3] }));
  const listed = reg.allPages().filter((p) => !p.hidden && p.id !== 'settings');
  assert.deepEqual(rows.map((r) => r.id).sort(), listed.map((p) => p.id).sort(), 'the crawl visits every listed page (Settings has its own leg)');
  for (const r of rows) {
    const page = reg.getPage(r.id);
    assert.equal(r.label, page.name, `${r.id}: the crawl clicks the sidebar label`);
    assert.equal(r.mod, page.moduleId, `${r.id}: the crawl opens the right tile`);
  }
  for (const step of ['launcher: Home renders module tiles', 'launcher: a tile opens its module', 'launcher: the Home item returns to the grid',
    'launcher: ⌘K "Go to" switches the sidebar to that module', 'launcher: arrow keys move between tiles, Enter opens one',
    'first run: Home welcomes with one action above the grid', 'first run: locked tiles say "Create a company first"',
    'first run: the action opens the Company page']) {
    assert.ok(crawl.includes(step), step);
  }
});

/* ── review follow-ups (2026-10-08) ─────────────────────────────────────── */

/** Render Home to static HTML with a stub store — no Electron, no zustand. */
let homeModule = null;
async function renderHome(state) {
  const stubs = {
    store: `export const useAppStore = (sel) => sel(globalThis.__homeState);`,
    sidebar: `export const useUserCaps = () => globalThis.__homeState.caps;`,
  };
  if (!homeModule) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/Home/index.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    plugins: [{
      name: 'stubs',
      setup(build) {
        build.onResolve({ filter: /store\/index\.js$/ }, () => ({ path: 'store', namespace: 'stub' }));
        build.onResolve({ filter: /components\/Sidebar\.jsx$/ }, () => ({ path: 'sidebar', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  homeModule = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, homeModule, homeModule.exports);
  }
  const mod = homeModule;
  globalThis.__homeState = {
    caps: ['*'], platform: 'darwin', openModule() {}, setActiveModule() {},
    isModuleAvailable: (id) => ['home', 'dashboard', 'company', 'settings', 'support', 'overlay', 'history'].includes(id) || !!state.activeCompanyId,
    ...state,
  };
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const origError = console.error;
  console.error = () => {}; // useLayoutEffect's server-render warning
  try { return renderToStaticMarkup(React.createElement(mod.exports.Home)); } finally { console.error = origError; }
}

test('first run: Home welcomes, offers one action, and the locked tiles say why', async () => {
  const noCo = load('renderer/modules/Home/noCompany.js');
  assert.deepEqual(noCo.noCompanyState(0), {
    title: 'Welcome to Media Studio KH',
    body: 'Create a company to start building one shared product library for images, labels, catalogs, and operations.',
    action: '+ Create your first company',
  });
  assert.equal(noCo.noCompanyState(2).title, 'No company selected');
  assert.equal(reg.noCompanyReason(0), 'Create a company first');
  assert.equal(reg.noCompanyReason(3), 'Choose a company first');
  // The Dashboard reads the same copy (one source).
  assert.match(read('renderer/modules/Dashboard/index.jsx'), /const noCompany = noCompanyState\(companies\.length\);/);

  const first = await renderHome({ activeCompanyId: null, companies: [] });
  assert.match(first, /Welcome to Media Studio KH/);
  assert.equal((first.match(/btn--primary/g) || []).length, 1, 'one primary action');
  assert.match(first, /\+ Create your first company/);
  assert.ok(first.indexOf('Welcome to Media Studio KH') < first.indexOf('home-grid'), 'the message sits above the grid');
  assert.match(first, /data-module="fuel"[^>]*aria-disabled="true"[^>]*title="Create a company first"/);
  assert.match(first, /Create a company first\./);

  const none = await renderHome({ activeCompanyId: null, companies: [{ id: 'a', name: 'A' }] });
  assert.match(none, /No company selected/);
  assert.match(none, /Choose a company first\./);
  assert.doesNotMatch(none, /Create a company first/);

  const open = await renderHome({ activeCompanyId: 'a', companies: [{ id: 'a', name: 'Shop A' }] });
  assert.doesNotMatch(open, /Welcome to Media Studio KH|No company selected/);
  assert.doesNotMatch(open, /aria-disabled/);
  assert.match(open, /context-chip">Shop A</);
  // The action opens the Company page; the sidebar uses the same reason.
  assert.match(read('renderer/modules/Home/index.jsx'), /onClick=\{\(\) => setActiveModule\('company'\)\}>\{intro\.action\}/);
  assert.match(read('renderer/components/Sidebar.jsx'), /const lockedReason = noCompanyReason\(companyCount\);/);
});

test('⌘K: page rows only when they can open; a module that cannot says why', () => {
  const none = () => false;
  assert.deepEqual(reg.searchNav('fill', ['*'], { isAvailable: none }), [], 'Fill-ups needs a company');
  assert.deepEqual(reg.searchNav('fuel', ['*'], { isAvailable: none }).map((r) => r.kind), ['module'], 'the module row stays');
  assert.deepEqual(reg.searchNav('settings', ['*'], { isAvailable: (id) => id === 'settings' }).map((r) => r.id), ['settings']);
  const palette = read('renderer/components/SearchPalette.jsx');
  assert.match(palette, /const navHits = searchNav\(query, userCaps, \{ isAvailable: canOpen \}\);/);
  assert.match(palette, /if \(r\.kind === 'module' && !entryPage\(getModule\(r\.id\), \{ caps: userCaps, isAvailable: canOpen \}\)\) \{\s*addToast\?\.\([^\n]*noCompanyReason\(companyCount\)/);
});

test('⌘K: records lead when there are any, unless the query is a module name', () => {
  const product = { kind: 'product', id: 'p1', label: 'Barcode scanner' };
  const page = reg.searchNav('barcode', ['*'])[0];
  assert.equal(page.id, 'barcodes');
  assert.deepEqual(reg.paletteRows([page], [product]).map((r) => r.id), ['p1', 'barcodes'], 'Enter on "barcode" opens the product');
  assert.deepEqual(reg.paletteRows([page], []).map((r) => r.id), ['barcodes'], 'no records: Go to leads');
  const fuel = reg.searchNav('fuel', ['*']);
  assert.equal(fuel[0].exact, true);
  assert.equal(reg.searchNav('fue', ['*'])[0].exact, false);
  assert.deepEqual(reg.paletteRows(fuel, [product]).map((r) => r.id), ['fuel', 'p1'], 'an exact module name leads');
  assert.equal(reg.searchNav('media studio', ['*'])[0].exact, true);
  const palette = read('renderer/components/SearchPalette.jsx');
  assert.match(palette, /const rows = paletteRows\(navHits, visibleResults\);/);
  assert.match(palette, /const first = paletteRows\(navHits, visibleResults\)\[0\];/, 'a queued Enter opens the same first row');
  assert.match(palette, /\(!pending \|\| picked\.exact \|\| highlight > 0\)/, 'a leading Go to row waits for pending records');
});

test('badges: a failure is not cached; the cache clears on mount and on change events', async () => {
  reg.clearBadgeCache();
  const fuel = reg.getModule('fuel');
  let fail = true;
  let calls = 0;
  const api = { fuel: { getOverview: async () => { calls += 1; if (fail) throw new Error('offline'); return { openFlags: { red: 2 } }; } } };
  assert.equal(await reg.loadBadge(fuel, { api, caps: ['*'], companyId: 'x', now: 1 }), null);
  fail = false;
  assert.equal((await reg.loadBadge(fuel, { api, caps: ['*'], companyId: 'x', now: 2 })).count, 2, 'the next look tries again');
  assert.equal(calls, 2);
  const po = reg.getModule('purchasing');
  const poApi = { purchaseOrders: { list: async () => [{}, {}] } };
  await reg.loadBadge(po, { api: poApi, caps: ['*'], companyId: 'x', now: 3 });
  reg.clearBadgeCache('fuel');
  await reg.loadBadge(fuel, { api, caps: ['*'], companyId: 'x', now: 4 });
  assert.equal(calls, 3, 'clearing fuel refetches fuel');
  let poCalls = 0;
  await reg.loadBadge(po, { api: { purchaseOrders: { list: async () => { poCalls += 1; return []; } } }, caps: ['*'], companyId: 'x', now: 5 });
  assert.equal(poCalls, 0, 'clearing fuel kept the purchasing badge');
  const home = read('renderer/modules/Home/index.jsx');
  assert.match(home, /useState\(\(\) => \{ clearBadgeCache\(\); return 0; \}\)/, 'cleared when Home mounts');
  assert.match(home, /window\.api\?\.fuel\?\.onChanged\?\.\(\(\) => stale\(BADGE_EVENTS\.fuel\)\)/);
  assert.match(home, /window\.api\?\.events\?\.onCatalogChanged\?\.\(/);
  assert.match(home, /export const BADGE_EVENTS = \{ fuel: 'fuel', purchaseOrder: 'purchasing', hr: 'people', assets: 'assets' \};/);
  assert.match(home, /window\.api\?\.hr\?\.onChanged\?\.\(\(\) => stale\(BADGE_EVENTS\.hr\)\)/, 'HR1: People\'s count refreshes on hr:changed');
  assert.match(home, /window\.api\?\.assets\?\.onChanged\?\.\(\(\) => stale\(BADGE_EVENTS\.assets\)\)/);
  // The PO event really is catalog:changed with kind 'purchaseOrder'.
  assert.match(read('renderer/store/catalogEvents.js'), /case 'purchaseOrder':/);
});
