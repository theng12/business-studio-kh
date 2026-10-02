/**
 * Renderer performance invariants — the ones that regress silently.
 *
 * None of these break a feature when they go wrong; they make the app slower
 * (a re-render per RPC, a refetch per edit, 200 timers on one page) or, in the
 * Overlay Studio case, make a shortcut act on stale state. `npm test` mounts
 * almost no screens, so the source-scan half pins the shape of each fix, and
 * the store half drives the real slices through esbuild with a fake zustand
 * (the same harness as test/storeFreshness.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('renderer/App.jsx');
const SIDEBAR = read('renderer/components/Sidebar.jsx');
const BOOTSTRAP = read('renderer/store/bootstrap.js');
const TEMPLATE_EDITOR = read('renderer/modules/OverlayStudio/TemplateEditor.jsx');
const WORKSPACE = read('renderer/modules/ImageWorkspace/index.jsx');
const ATTRIBUTION = read('renderer/components/Attribution.jsx');
const BULK_TABLE = read('renderer/modules/ProductLibrary/BulkTableModal.jsx');
const SOCIAL_GRID = read('renderer/modules/SocialGrid/index.jsx');
const LIST_TOOLS = read('renderer/lib/listTools.js');

/** The body of the named top-level function, up to the next top-level one. */
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} not found`);
  const rest = src.slice(at + 1);
  const next = rest.search(/\n(export )?(async )?function \w+\(|\nconst \w+ = memo\(/);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
}

/* ── source scans ──────────────────────────────────────────────────────── */

test('the shell never subscribes to the whole clientConnection object', () => {
  // Main pushes that object on every successful RPC; subscribing to it
  // re-rendered the shell, the sidebar and the active page per request.
  for (const [name, src] of [['App.jsx', APP], ['Sidebar.jsx', SIDEBAR]]) {
    assert.doesNotMatch(src, /useAppStore\(\(s\) => s\.clientConnection\)/,
      `${name} subscribes to the whole clientConnection object`);
  }
  assert.match(SIDEBAR, /export function useUserCaps\(\)/, 'the shared stable-caps hook is gone');
  assert.match(SIDEBAR, /useShallow\(\(s\) => s\.clientConnection\?\.user\?\.caps/,
    'caps are not selected shallowly, so the array identity changes per push');
  assert.match(APP, /const userCaps = useUserCaps\(\);/, 'App derives caps without the stable hook');
  assert.doesNotMatch(APP, /\[appMode, clientConnection\]/,
    'a memo/effect is keyed on the whole connection object again');
});

test('bootstrap drops connection pushes that only moved lastOkAt', () => {
  assert.match(BOOTSTRAP, /isConnectionPushWorthStoring\(get\(\)\.clientConnection, clientConnection\)/,
    'the connection subscriber stores every push again');
});

test('the Sidebar network chip pauses its 1 s tick while the window is hidden', () => {
  const chip = fnBody(SIDEBAR, 'NetworkChip');
  assert.match(chip, /visibilitychange/, 'the chip no longer listens for visibility changes');
  assert.match(chip, /document\.visibilityState === 'hidden'/, 'the chip does not check for a hidden window');
});

test('Overlay Studio shortcuts read the current render through a ref', () => {
  // The bug: the keydown effect was keyed on [selectedId] only, so ⌘Z called
  // the undo() from the render where the selection last changed.
  assert.match(TEMPLATE_EDITOR, /keyHandlerRef\.current = function onKey\(e\)/,
    'the shortcut handler is not refreshed every render');
  assert.match(TEMPLATE_EDITOR, /const onKey = \(e\) => keyHandlerRef\.current\?\.\(e\);\s*window\.addEventListener\('keydown', onKey\);[\s\S]{0,120}\}, \[\]\);/,
    'the keydown listener must be registered once and call through the ref');
  assert.doesNotMatch(TEMPLATE_EDITOR, /\}, \[selectedId\]\);/,
    'a shortcut effect keyed on selectedId is back — its closures go stale');
});

test('the save badges tick themselves; the editors do not re-render for a timestamp', () => {
  for (const [name, src, badge] of [
    ['TemplateEditor', TEMPLATE_EDITOR, 'SaveStatus'],
    ['ImageWorkspace', WORKSPACE, 'SaveIndicator'],
  ]) {
    const ticks = src.match(/setInterval\(\(\) => setTick/g) || [];
    assert.equal(ticks.length, 1, `${name} should have exactly one 30 s tick`);
    assert.match(fnBody(src, badge), /setInterval\(\(\) => setTick/,
      `${name}'s tick is not inside ${badge}`);
  }
});

test('attribution chips share one minute ticker instead of one timer per row', () => {
  assert.match(ATTRIBUTION, /useSyncExternalStore\(subscribeMinute, getMinuteTick\)/,
    'the shared ticker is gone');
  const intervals = ATTRIBUTION.match(/setInterval\(/g) || [];
  assert.equal(intervals.length, 1, 'only the shared ticker may start an interval');
  for (const name of ['Attribution', 'CompactAttribution']) {
    assert.doesNotMatch(fnBody(ATTRIBUTION, name), /setInterval\(/, `${name} starts its own timer again`);
  }
});

test('the bulk table renders rows through a memoised component with stable callbacks', () => {
  assert.match(BULK_TABLE, /const BulkTableRowCells = memo\(function BulkTableRowCells\(/,
    'the row cells are no longer memoised');
  assert.match(BULK_TABLE, /\}, sameRowCells\);/, 'the per-row comparator is not used');
  assert.match(BULK_TABLE, /onCellChange=\{setCellStable\}/, 'the row gets an unstable change handler');
  assert.match(BULK_TABLE, /onCellFocus=\{focusCell\}/, 'the row gets an unstable focus handler');
  assert.match(BULK_TABLE, /const focusCell = useCallback\(/, 'focusCell is recreated every render');
  assert.match(BULK_TABLE, /const setCellStable = useCallback\(/, 'setCell is passed without a stable wrapper');
});

test('Social Grid keeps its own config object when the saved copy is equal', () => {
  assert.match(SOCIAL_GRID, /function withLocalConfig\(row, local\)/, 'the identity-preserving merge is gone');
  const uses = SOCIAL_GRID.match(/withLocalConfig\(row, /g) || [];
  assert.ok(uses.length >= 2, 'the save paths adopt the server row without keeping the local config');
});

test('the list sort uses one shared collator', () => {
  assert.match(LIST_TOOLS, /const NAME_COLLATOR = new Intl\.Collator\(/, 'the shared collator is gone');
  assert.doesNotMatch(LIST_TOOLS, /localeCompare\(/, 'a per-comparison localeCompare is back');
});

/* ── store behaviour ───────────────────────────────────────────────────── */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installBrowser(api) {
  const storage = new Map();
  global.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  global.document = { documentElement: { setAttribute() {} } };
  global.window = {
    api,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
}

function fakeZustand() {
  return {
    create(factory) {
      let state;
      const get = () => state;
      const set = (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        if (patch) state = { ...state, ...patch };
      };
      state = factory(set, get);
      const useStore = (selector = (value) => value) => selector(state);
      useStore.getState = get;
      useStore.setState = set;
      return useStore;
    },
  };
}

async function loadRendererModule(entry, api) {
  installBrowser(api);
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn((id) => id === 'zustand' ? fakeZustand() : req(id), mod, mod.exports);
  return mod.exports;
}

function fakeApi() {
  const calls = { list: 0, dashboard: 0 };
  const api = {
    products: {
      list: async (id) => { calls.list += 1; return [{ id: `product-${id}` }]; },
      update: async (id) => ({ id }),
    },
    dashboard: {
      stats: async () => { calls.dashboard += 1; return {}; },
      recentBrands: async () => [],
      recentProducts: async () => [],
      completeness: async () => null,
    },
  };
  return { api, calls };
}

test('a connection push that only moves lastOkAt is not stored, anything else is', async () => {
  const { isConnectionPushWorthStoring: worth } = await loadRendererModule('renderer/store/bootstrap.js', {});
  const base = { status: 'connected', lastOkAt: 1_000_000, lastError: null, serverVersion: '0.1.86', user: { id: 'u', caps: ['*'] } };
  assert.equal(worth(base, { ...base, lastOkAt: base.lastOkAt + 200 }), false, 'a per-RPC lastOkAt bump was stored');
  assert.equal(worth(base, { ...base, lastOkAt: base.lastOkAt + 20_000 }), true, 'lastOkAt never refreshes');
  assert.equal(worth(base, { ...base, status: 'degraded' }), true);
  assert.equal(worth(base, { ...base, lastError: 'boom' }), true);
  assert.equal(worth(base, { ...base, serverVersion: '0.1.87' }), true);
  assert.equal(worth(base, { ...base, user: { id: 'u', caps: ['products.edit'] } }), true, 'a caps change was dropped');
  assert.equal(worth(base, { ...base, user: { id: 'u', caps: ['*'] } }), false, 'an equal user object counts as a change');
});

test('an own product edit refetches once, not again for its catalog echo', async () => {
  const { api, calls } = fakeApi();
  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  const { applyCatalogEvent } = await loadRendererModule('renderer/store/catalogEvents.js', api);
  useAppStore.setState({ activeCompanyId: 'company-a', activeModule: 'library' });

  // Local mode: main sends `catalog:changed` before the update reply lands.
  applyCatalogEvent(useAppStore.getState, { kind: 'product', id: 'p1' });
  await useAppStore.getState().updateProduct('p1', { name: 'x' });
  assert.equal(calls.list, 1, 'updateProduct must still refresh before it resolves');
  await delay(320);
  assert.equal(calls.list, 1, 'the edit\'s own catalog echo refetched the list a second time');
  assert.equal(calls.dashboard, 0, 'the dashboard was fetched while it is not on screen');
});

test('a change from another Mac still refreshes, and so does a change after the last fetch', async () => {
  const { api, calls } = fakeApi();
  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  const { applyCatalogEvent } = await loadRendererModule('renderer/store/catalogEvents.js', api);
  useAppStore.setState({ activeCompanyId: 'company-a', activeModule: 'library' });

  await useAppStore.getState().refreshProducts();
  assert.equal(calls.list, 1);
  applyCatalogEvent(useAppStore.getState, { kind: 'product', id: 'remote' });
  await delay(320);
  assert.equal(calls.list, 2, 'a remote edit (no local fetch after it) was skipped');
});

test('the dashboard refetches only while it is the active page', async () => {
  const { api, calls } = fakeApi();
  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  useAppStore.setState({ activeCompanyId: 'company-a', activeModule: 'library' });
  await useAppStore.getState().refreshDashboard();
  assert.equal(calls.dashboard, 0);
  useAppStore.setState({ activeModule: 'dashboard' });
  await useAppStore.getState().refreshDashboard();
  assert.equal(calls.dashboard, 1, 'the Dashboard page itself could not load its stats');
});

test('a background product refresh does not flip the Library back to "Loading…"', async () => {
  const { api } = fakeApi();
  const seen = [];
  const list = api.products.list;
  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  api.products.list = async (...args) => { seen.push(useAppStore.getState().productsLoading); return list(...args); };
  useAppStore.setState({ activeCompanyId: 'company-a', products: [], productsLoading: false });

  await useAppStore.getState().refreshProducts();
  assert.equal(seen[0], true, 'the first load (no rows yet) must show loading');
  await useAppStore.getState().refreshProducts();
  assert.equal(seen[1], false, 'a refresh with rows on screen flipped productsLoading');
  assert.equal(useAppStore.getState().productsLoading, false);
});
