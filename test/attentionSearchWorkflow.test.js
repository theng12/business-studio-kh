const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { getValidator } = require('../main/server/validators');
const root = path.join(__dirname, '..');
const deferred = () => { let resolve; const promise = new Promise((ok) => { resolve = ok; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function load(file, stubs, timers = {}) {
  const code = esbuild.transformSync(fs.readFileSync(path.join(root, file), 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs', jsx: 'automatic' }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', code)((id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`Unexpected import ${id}`);
  }, mod, mod.exports, timers.setTimeout || setTimeout, timers.clearTimeout || clearTimeout);
  return mod.exports;
}
function hooks() {
  let cursor = 0; const values = []; const effects = [];
  const changed = (a, b) => !a || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  const React = {
    useState(initial) { const i = cursor++; values[i] ||= { value: initial }; return [values[i].value, (next) => { values[i].value = typeof next === 'function' ? next(values[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; return values[i] ||= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) effects.push(() => { values[i]?.cleanup?.(); values[i] = { deps, cleanup: fn() }; }); },
  };
  return { React, runtime: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, render(fn, props) { cursor = 0; const out = fn(props); for (const effect of effects.splice(0)) effect(); return out; }, cleanup() { values.forEach((v) => v?.cleanup?.()); } };
}
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach((n) => findAll(n, predicate, out)); else findAll(value, predicate, out); }
  return out;
}

test('company queues clear conflicts; clearing attention keeps user refinements; allProducts stays unfiltered', async () => {
  const defaults = load('renderer/store/productsDefaults.js', {}).DEFAULT_FILTERS;
  let state;
  const requests = [];
  const slice = load('renderer/store/products.js', { './productsDefaults.js': { DEFAULT_FILTERS: defaults, DEFAULT_SORT: {}, loadProductSort: () => ({}), saveProductSort() {} } }).createProductsSlice;
  const set = (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  state = { activeCompanyId: 'active', addToast() {}, ...slice(set, () => state) };
  global.window = { api: { products: { list: async (companyId, filters) => { requests.push({ companyId, filters }); return [{ id: filters.attentionFilter ? 'missing' : 'full' }]; } } } };
  state.productFilters = { ...defaults, search: 'wrong', brandIds: ['wrong'], hasImages: 'with', status: 'archived', processStatus: 'exported' };
  state.page = 7;
  await state.setCompanyAttentionFilter('missingBarcode');
  assert.deepEqual(state.productFilters, { ...defaults, attentionFilter: 'missingBarcode' });
  assert.equal(state.page, 0);
  assert.deepEqual(state.products, [{ id: 'missing' }]);
  assert.deepEqual(state.allProducts, [{ id: 'full' }]);
  assert.equal(requests[0].companyId, 'active');
  state.productFilters = { ...state.productFilters, search: 'refinement' };
  await state.clearAttentionFilter();
  assert.equal(state.productFilters.attentionFilter, null);
  assert.equal(state.productFilters.search, 'refinement');
});

test('new criteria and search company scopes validate at the RPC boundary', () => {
  const products = getValidator('products:list');
  for (const attentionFilter of [null, 'missingBarcode', 'missingPrice', 'notExported']) assert.equal(products({ filters: { attentionFilter } }), true);
  assert.notEqual(products({ filters: { attentionFilter: 'allCompanies' } }), true);
  assert.notEqual(products({ filters: 'wrong' }), true);
  assert.notEqual(getValidator('search:global')({ query: 'needle', companyId: 42 }), true);
});

test('search RPC checks catalog permission and rejects an obsolete requested company', () => {
  let allowed = false; let captured;
  const { register } = load('main/ipc/search.js', {
    '../db/companies': { getActiveId: () => 'active' },
    '../server': { getCurrentUserId: () => 'viewer' },
    '../db/users': { get: () => ({ role: 'custom' }) },
    '../util/permissions': { isAllowed: (_, channel) => channel === 'catalogStudio:list' && allowed },
    '../db/search': { globalSearch: (...args) => { captured = args; return ['result']; } },
  });
  let handler;
  register({ expose: (_, fn) => { handler = fn; } });
  assert.deepEqual(handler({ query: 'needle', companyId: 'obsolete' }), []);
  assert.equal(captured, undefined);
  assert.deepEqual(handler({ query: 'needle', companyId: 'active' }), ['result']);
  assert.equal(captured[3].includeCatalog, false);
  allowed = true;
  handler({ query: 'needle', companyId: 'active' });
  assert.equal(captured[3].includeCatalog, true);
  assert.equal(captured[3].includeCosting, false);
});

test('palette ignores obsolete companies and closed searches, and opens saved records through the draft guard', async () => {
  const hook = hooks(); const callbacks = new Map(); let nextTimer = 0;
  const timers = { setTimeout: (fn) => { callbacks.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id) => callbacks.delete(id) };
  const fire = async () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((fn) => void fn()); await settle(); };
  const requests = []; const opened = []; let closed = 0; let allowNavigation = false; let caps = ['catalog.design'];
  const state = { activeCompanyId: 'a', openLibraryProduct: async (...args) => { opened.push(['product', ...args]); return allowNavigation; }, openCatalogProject: async (...args) => { opened.push(['project', ...args]); return allowNavigation; }, openCatalogTemplate: async (...args) => { opened.push(['template', ...args]); return allowNavigation; } };
  const useAppStore = (select) => select(state); useAppStore.getState = () => state;
  const Component = load('renderer/components/SearchPalette.jsx', { react: hook.React, 'react/jsx-runtime': hook.runtime, '../store/index.js': { useAppStore }, './Sidebar.jsx': { useUserCaps: () => caps }, '../lib/capabilities.js': { hasCap: (values, cap) => values.includes(cap) } }, timers).SearchPalette;
  global.window = { api: { search: { global: (...args) => { const gate = deferred(); requests.push({ args, gate }); return gate.promise; } } } };
  const props = { open: true, onClose: () => { closed++; } }; let output;
  const render = () => { output = hook.render(Component, props); };
  const input = () => findAll(output, (n) => n.type === 'input')[0];
  const rows = () => findAll(output, (n) => n.props?.role === 'option');
  try {
    render(); render(); input().props.onChange({ target: { value: 'needle' } }); render(); await fire();
    assert.deepEqual(requests[0].args, ['needle', 30, 'a']);
    state.activeCompanyId = 'b'; render(); render(); await fire();
    requests[0].gate.resolve([{ kind: 'catalogTemplate', id: 'old', label: 'Old company' }]); await settle(); render();
    assert.equal(rows().length, 0);
    requests[1].gate.resolve([{ kind: 'catalogTemplate', id: 'saved', label: 'Saved template' }]); await settle(); render();
    assert.equal(rows().length, 1);
    await rows()[0].props.onClick(); assert.equal(closed, 0, 'a failed draft guard keeps the palette open');
    allowNavigation = true; await rows()[0].props.onClick(); assert.deepEqual(opened.at(-1), ['template', 'saved', 'b']); assert.equal(closed, 1);
    input().props.onChange({ target: { value: 'other' } }); render(); await fire();
    props.open = false; render(); requests[2].gate.resolve([{ kind: 'product', id: 'late', productId: 'late' }]); await settle();
    props.open = true; render(); render(); assert.equal(rows().length, 0);
    input().props.onChange({ target: { value: 'privileged' } }); render(); await fire();
    caps = []; render(); render(); await fire();
    requests[3].gate.resolve([{ kind: 'catalogProject', id: 'old-cap' }]);
    requests[4].gate.resolve([{ kind: 'catalogProject', id: 'denied' }, { kind: 'product', id: 'p', productId: 'p', label: 'Visible product' }]);
    await settle(); render(); assert.equal(rows().length, 1); await rows()[0].props.onClick(); assert.deepEqual(opened.at(-1), ['product', 'p', 'b']);
  } finally { hook.cleanup(); }
});
