const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MUTATE_GUARDS = process.env.OPERATIONS_FRESHNESS_MUTATION === '1';
const MUTATE_MANUAL_COST = process.env.OPERATIONS_FRESHNESS_MUTATION === 'manual-cost';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function hookHarness() {
  let cursor = 0;
  let dirty = false;
  let output = null;
  const hooks = [];
  const pendingEffects = [];
  const depsChanged = (previous, next) => !previous || !next || previous.length !== next.length
    || next.some((value, i) => !Object.is(value, previous[i]));
  const React = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, (next) => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next;
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      hooks[index] = { deps, cleanup: previous?.cleanup };
      if (depsChanged(previous?.deps, deps)) pendingEffects.push({ index, effect, previous });
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (depsChanged(hooks[index]?.deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useCallback(callback, deps) { return React.useMemo(() => callback, deps); },
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const jsxRuntime = { Fragment: Symbol('Fragment'), jsx, jsxs: jsx };

  function render(Component) {
    cursor = 0;
    dirty = false;
    pendingEffects.length = 0;
    output = Component();
    for (const { index, effect, previous } of pendingEffects) {
      if (typeof previous?.cleanup === 'function') previous.cleanup();
      hooks[index].cleanup = effect();
    }
    return output;
  }

  async function settle(Component) {
    for (let i = 0; i < 10; i += 1) {
      render(Component);
      if (!dirty) return output;
      await Promise.resolve();
    }
    assert.fail('component did not settle');
  }

  function cleanup() {
    for (const hook of hooks) if (typeof hook?.cleanup === 'function') hook.cleanup();
  }

  return { React, jsxRuntime, settle, cleanup, getOutput: () => output };
}

function findAll(node, predicate, found = []) {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found; }
  if (predicate(node)) found.push(node);
  for (const value of Object.values(node.props || {})) findAll(value, predicate, found);
  return found;
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return Object.values(node.props || {}).map(textOf).join('');
}

function installBrowser(api) {
  const noop = () => {};
  global.window = { api, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) };
  global.document = { body: { classList: { add: noop, remove: noop } }, documentElement: { setAttribute: noop } };
  global.navigator = global.navigator || { userAgent: 'node', platform: 'darwin' };
}

function removeResponseGuards(source) {
  const changed = source
    .replaceAll('if (request !== costRequestRef.current || companyRequest !== productRequestRef.current) return;', 'if (false) return;')
    .replaceAll('if (request !== listRequestRef.current) return;', 'if (false) return;')
    .replaceAll('if (request !== supplierRequestRef.current) return;', 'if (false) return;')
    .replaceAll('if (request !== spendRequestRef.current) return;', 'if (false) return;');
  assert.notEqual(changed, source, 'the mutation must remove a production freshness guard');
  return changed;
}

function removeManualCostGuards(source) {
  const changed = source.replaceAll('!manualCostEditRef.current', 'true');
  assert.notEqual(changed, source, 'the mutation must remove the manual-cost protection');
  return changed;
}

async function loadComponent(file, exportName, api, hook) {
  installBrowser(api);
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const entry = path.join(ROOT, file);
  let storeHook;
  const zustand = {
    create(factory) {
      let state;
      const set = (update) => { const patch = typeof update === 'function' ? update(state) : update; if (patch) state = { ...state, ...patch }; };
      state = factory(set, () => state);
      storeHook = (selector = (value) => value) => selector(state);
      storeHook.setState = set;
      return storeHook;
    },
  };
  const out = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand'], logLevel: 'silent',
    plugins: MUTATE_GUARDS || (MUTATE_MANUAL_COST && exportName === 'CostCalculator') ? [{ name: 'remove-response-guards', setup(build) {
      build.onLoad({ filter: new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({ contents: (MUTATE_MANUAL_COST ? removeManualCostGuards : removeResponseGuards)(fs.readFileSync(entry, 'utf8')), loader: 'jsx' }));
    } }] : [],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => {
    if (id === 'react') return hook.React;
    if (id === 'react/jsx-runtime') return hook.jsxRuntime;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    if (id === 'zustand') return zustand;
    return req(id);
  }, mod, mod.exports);
  return { Component: mod.exports[exportName], store: storeHook };
}

function setStore(store, patch) {
  store.setState({ addToast() {}, openPurchaseOrdersForSupplier() {}, clearPendingPoNav() {}, pendingPoId: null, pendingPoSupplierId: null, ...patch });
}

function input(output, predicate) {
  const node = findAll(output, (node) => node.type?.name === 'Input' && predicate(node.props))[0];
  assert.ok(node, 'expected input');
  return node;
}

function select(output, predicate) {
  const node = findAll(output, (node) => node.type?.name === 'Select' && predicate(node.props))[0];
  assert.ok(node, 'expected select');
  return node;
}

function pageAction(output, title) {
  const header = findAll(output, (node) => node.props?.title === title && node.props?.actions)[0];
  assert.ok(header, `expected ${title} page header action`);
  return header.props.actions;
}

test('CostCalculator prevents an old company cost failure from clearing the current manual cost', async () => {
  const products = { a: deferred(), b: deferred(), a2: deferred(), b2: deferred() };
  const costs = { a: deferred(), b: deferred() };
  const productQueues = { 'company-a': [products.a, products.a2], 'company-b': [products.b, products.b2] };
  const api = {
    products: { list: (companyId) => productQueues[companyId].shift().promise },
    purchaseOrders: { getProductCost: (id) => costs[id === 'product-a' ? 'a' : 'b'].promise },
  };
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/CostCalculator/index.jsx', 'CostCalculator', api, hook);
  try {
    setStore(store, { activeCompanyId: 'company-a' });
    await hook.settle(Component);
    setStore(store, { activeCompanyId: 'company-b' });
    await hook.settle(Component);
    products.b.resolve([{ id: 'product-b', sku: 'B-1', name: 'B current' }]);
    await flush(); await hook.settle(Component);
    products.a.resolve([{ id: 'product-a', sku: 'A-1', name: 'A stale' }]);
    await flush(); await hook.settle(Component);
    assert.match(textOf(hook.getOutput()), /B current/);
    assert.doesNotMatch(textOf(hook.getOutput()), /A stale/);

    setStore(store, { activeCompanyId: 'company-a' });
    await hook.settle(Component);
    products.a2.resolve([{ id: 'product-a', sku: 'A-2', name: 'A selected' }]);
    await flush(); await hook.settle(Component);
    select(hook.getOutput(), (props) => props.value === '').props.onChange({ target: { value: 'product-a' } });
    await hook.settle(Component);

    setStore(store, { activeCompanyId: 'company-b' });
    await hook.settle(Component);
    products.b2.resolve([{ id: 'product-b', sku: 'B-2', name: 'B selected' }]);
    await flush(); await hook.settle(Component);
    select(hook.getOutput(), (props) => props.value === '').props.onChange({ target: { value: 'product-b' } });
    await hook.settle(Component);
    input(hook.getOutput(), (props) => props.step === '0.0001').props.onChange({ target: { value: '9.50' } });
    await hook.settle(Component);
    costs.b.resolve({ latestLandedCostUsd: 17 });
    await flush(); await hook.settle(Component);
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.0001').props.value, '9.50', 'the current B success must preserve input made while it was pending');
    assert.ok(findAll(hook.getOutput(), (node) => node.type?.name === 'CostStat' && node.props.label === 'Latest landed' && node.props.value === '$17.00').length, 'B history updates independently of the manual cost');
    costs.a.reject(new Error('old company unavailable'));
    await flush(); await hook.settle(Component);

    assert.ok(findAll(hook.getOutput(), (node) => node.type?.name === 'CostStat' && node.props.label === 'Latest landed' && node.props.value === '$17.00').length, 'the B cost history remains visible');
    assert.equal(input(hook.getOutput(), (props) => props.value === '9.50').props.value, '9.50', 'manual B cost survives an old A error');
  } finally { hook.cleanup(); }
});

test('CostCalculator preserves manual cost when the current pending lookup fails', async () => {
  const cost = deferred();
  const api = {
    products: { list: async () => [{ id: 'product-b', sku: 'B', name: 'B current' }] },
    purchaseOrders: { getProductCost: () => cost.promise },
  };
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/CostCalculator/index.jsx', 'CostCalculator', api, hook);
  try {
    setStore(store, { activeCompanyId: 'company-b' });
    await hook.settle(Component); await flush(); await hook.settle(Component);
    select(hook.getOutput(), (props) => props.value === '').props.onChange({ target: { value: 'product-b' } });
    await hook.settle(Component);
    input(hook.getOutput(), (props) => props.step === '0.0001').props.onChange({ target: { value: '9.50' } });
    await hook.settle(Component);
    cost.reject(new Error('current lookup unavailable'));
    await flush(); await hook.settle(Component);
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.0001').props.value, '9.50', 'a current lookup failure must not erase the manual draft');
    assert.equal(findAll(hook.getOutput(), (node) => node.type?.name === 'CostStat' && node.props.label === 'Latest landed').length, 0, 'a failed current lookup has no cost history');
  } finally { hook.cleanup(); }
});

test('Suppliers keeps B search rows and spend after A resolves following a save refresh', async () => {
  const listCalls = [];
  const spendCalls = [];
  const toasts = [];
  const api = {
    suppliers: {
      list(companyId, query) { const gate = deferred(); listCalls.push({ companyId, query, gate }); return gate.promise; },
      create: async () => ({ id: 'created-b' }),
    },
    purchaseOrders: { supplierSpendRollup(companyId) { const gate = deferred(); spendCalls.push({ companyId, gate }); return gate.promise; } },
  };
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/Suppliers/index.jsx', 'Suppliers', api, hook);
  try {
    setStore(store, { activeCompanyId: 'company-a' });
    await hook.settle(Component); await delay(210);
    setStore(store, { activeCompanyId: 'company-b', addToast: (...args) => toasts.push(args) });
    await hook.settle(Component); await delay(210);
    const search = findAll(hook.getOutput(), (node) => node.type === 'input' && node.props.placeholder === 'Search supplier name, contact or country…')[0];
    search.props.onChange({ target: { value: 'B' } });
    await hook.settle(Component); await delay(210);
    listCalls.find((call) => call.companyId === 'company-b' && call.query.search === '').gate.reject(new Error('obsolete search failed'));
    await flush(); await hook.settle(Component);
    assert.match(textOf(hook.getOutput()), /Loading…/, 'stale search failure cannot finish the current loading state');
    assert.deepEqual(toasts, [], 'stale search errors must not notify the current company');
    listCalls.at(-1).gate.resolve([{ id: 'supplier-b', name: 'B matched', status: 'active', defaultCurrency: 'USD' }]);
    spendCalls.find((call) => call.companyId === 'company-b').gate.resolve({ 'supplier-b': { poCount: 2, receivedCount: 1, totalSpendUsd: 42 } });
    await flush(); await hook.settle(Component);

    const create = pageAction(hook.getOutput(), 'Suppliers');
    create.props.onClick();
    await hook.settle(Component);
    await findAll(hook.getOutput(), (node) => node.type?.name === 'SupplierFormModal')[0].props.onSave({ name: 'B new' });
    await hook.settle(Component); await delay(210);
    listCalls.at(-1).gate.resolve([{ id: 'supplier-b', name: 'B fresh', status: 'active', defaultCurrency: 'USD' }]);
    spendCalls.at(-1).gate.resolve({ 'supplier-b': { poCount: 2, receivedCount: 1, totalSpendUsd: 42 } });
    await flush(); await hook.settle(Component);
    listCalls.find((call) => call.companyId === 'company-a').gate.resolve([{ id: 'supplier-a', name: 'A stale', status: 'active', defaultCurrency: 'USD' }]);
    spendCalls.find((call) => call.companyId === 'company-a').gate.resolve({ 'supplier-a': { poCount: 99, receivedCount: 99, totalSpendUsd: 9900 } });
    await flush(); await hook.settle(Component);

    assert.match(textOf(hook.getOutput()), /B fresh/);
    assert.match(textOf(hook.getOutput()), /\$42/);
    assert.doesNotMatch(textOf(hook.getOutput()), /A stale|\$9,900\.00/);
  } finally { hook.cleanup(); }
});

test('PurchaseOrders keeps B supplier choices and rows when A and older searches resolve after refresh', async () => {
  const supplierCalls = [];
  const listCalls = [];
  const toasts = [];
  const api = {
    suppliers: { list(companyId) { const gate = deferred(); supplierCalls.push({ companyId, gate }); return gate.promise; } },
    purchaseOrders: {
      list(companyId, query) { const gate = deferred(); listCalls.push({ companyId, query, gate }); return gate.promise; },
      create: async () => ({ id: 'po-created-b' }),
    },
  };
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/index.jsx', 'PurchaseOrders', api, hook);
  try {
    setStore(store, { activeCompanyId: 'company-a' });
    await hook.settle(Component); await delay(210);
    setStore(store, { activeCompanyId: 'company-b', addToast: (...args) => toasts.push(args) });
    await hook.settle(Component); await delay(210);
    supplierCalls.find((call) => call.companyId === 'company-b').gate.resolve([{ id: 'supplier-b', name: 'B supplier', defaultCurrency: 'USD', defaultIncoterm: 'FOB' }]);
    await flush(); await hook.settle(Component);
    input(hook.getOutput(), (props) => props.placeholder === 'Search by PO number or supplier name…').props.onChange({ target: { value: 'B' } });
    await hook.settle(Component); await delay(210);
    listCalls.find((call) => call.companyId === 'company-b' && call.query.search === '').gate.reject(new Error('obsolete search failed'));
    await flush(); await hook.settle(Component);
    assert.match(textOf(hook.getOutput()), /Loading…/, 'stale search failure cannot finish the current loading state');
    assert.deepEqual(toasts, [], 'stale search errors must not notify the current company');
    listCalls.at(-1).gate.resolve([{ id: 'po-b-match', poNumber: 'PO-B-match', status: 'draft', totalValueUsd: 10 }]);
    await flush(); await hook.settle(Component);

    const create = pageAction(hook.getOutput(), 'Purchase Orders');
    create.props.onClick();
    await hook.settle(Component);
    supplierCalls.find((call) => call.companyId === 'company-a').gate.resolve([{ id: 'supplier-a', name: 'A stale', defaultCurrency: 'USD', defaultIncoterm: 'FOB' }]);
    await flush(); await hook.settle(Component);
    const modal = findAll(hook.getOutput(), (node) => node.type?.name === 'NewPOModal')[0];
    assert.deepEqual(modal.props.suppliers.map((supplier) => supplier.id), ['supplier-b'], 'only B is available for a new B purchase order');
    await modal.props.onCreate({ supplierId: 'supplier-b', currency: 'USD' });
    await hook.settle(Component);
    findAll(hook.getOutput(), (node) => node.type?.name === 'PODetail')[0].props.onBack();
    await hook.settle(Component); await delay(210);

    listCalls.at(-1).gate.resolve([{ id: 'po-b-fresh', poNumber: 'PO-B-fresh', status: 'draft', totalValueUsd: 25 }]);
    await flush(); await hook.settle(Component);
    for (const call of listCalls.slice(0, -1).filter((call) => call.companyId === 'company-b')) call.gate.resolve([{ id: 'po-b-old', poNumber: 'PO-B-old', status: 'draft', totalValueUsd: 2 }]);
    for (const call of listCalls.filter((call) => call.companyId === 'company-a')) call.gate.resolve([{ id: 'po-a', poNumber: 'PO-A-stale', status: 'draft', totalValueUsd: 1 }]);
    await flush(); await hook.settle(Component);

    assert.match(textOf(hook.getOutput()), /PO-B-fresh/);
    assert.doesNotMatch(textOf(hook.getOutput()), /PO-A-stale|PO-B-old/);
  } finally { hook.cleanup(); }
});
