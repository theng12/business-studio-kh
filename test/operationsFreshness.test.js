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
    memo: (component) => component,
    // 0.1.94: the Library's list views render ConnImg, a forwardRef component.
    forwardRef: (render) => render,
    // Fuel F1: Settings lazy-loads its Fuel tab. The harness never mounts a
    // lazy child, so a placeholder component is enough.
    lazy: () => function LazyPlaceholder() { return null; },
    Suspense: function Suspense(props) { return props.children; },
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

async function loadComponent(file, exportName, api, hook, extraSource = '') {
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
    plugins: MUTATE_GUARDS || (MUTATE_MANUAL_COST && exportName === 'CostCalculator') || extraSource ? [{ name: 'remove-response-guards', setup(build) {
      build.onLoad({ filter: new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({ contents: (extraSource ? fs.readFileSync(entry, 'utf8') + extraSource : (MUTATE_MANUAL_COST ? removeManualCostGuards : removeResponseGuards)(fs.readFileSync(entry, 'utf8'))), loader: 'jsx' }));
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
  return { Component: mod.exports[exportName], ConflictHost: mod.exports.ConflictModalHost, store: storeHook };
}

function setStore(store, patch) {
  store.setState({ addToast() {}, openPurchaseOrdersForSupplier() {}, clearPendingPoNav() {}, pendingPoId: null, pendingPoSupplierId: null, ...patch });
}

function input(output, predicate) {
  const node = findAll(output, (node) => node.type?.name === 'Input' && predicate(node.props))[0];
  assert.ok(node, 'expected input');
  return node;
}

/** The Cost Calculator's product picker (a SearchableSelect since 0.1.94). */
function productPicker(output) {
  const node = findAll(output, (node) => node.type?.name === 'SearchableSelect')[0];
  assert.ok(node, 'expected the product picker');
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
    // The picker is a SearchableSelect now (0.1.94): its rows are the
    // `options` prop rather than <option> text.
    const pickerNames = () => productPicker(hook.getOutput()).props.options.map((p) => p.name).join(' ');
    assert.match(pickerNames(), /B current/);
    assert.doesNotMatch(pickerNames(), /A stale/);

    setStore(store, { activeCompanyId: 'company-a' });
    await hook.settle(Component);
    products.a2.resolve([{ id: 'product-a', sku: 'A-2', name: 'A selected' }]);
    await flush(); await hook.settle(Component);
    productPicker(hook.getOutput()).props.onChange('product-a');
    await hook.settle(Component);

    setStore(store, { activeCompanyId: 'company-b' });
    await hook.settle(Component);
    products.b2.resolve([{ id: 'product-b', sku: 'B-2', name: 'B selected' }]);
    await flush(); await hook.settle(Component);
    productPicker(hook.getOutput()).props.onChange('product-b');
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
    productPicker(hook.getOutput()).props.onChange('product-b');
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
    input(hook.getOutput(), (props) => props.placeholder === 'Search PO number, supplier, SKU or product…').props.onChange({ target: { value: 'B' } });
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

test('CostCalculator refreshes PO history without replacing a manual cost, and reports lookup errors truthfully', async () => {
  let event;
  let amount = 10;
  let failure = null;
  const api = {
    products: { list: async () => [{ id: 'product', sku: 'A', name: 'Apple' }] },
    events: { onCatalogChanged: (handler) => { event = handler; return () => {}; } },
    purchaseOrders: { getProductCost: async () => { if (failure) throw new Error(failure); return amount == null ? null : { latestLandedCostUsd: amount }; } },
  };
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/CostCalculator/index.jsx', 'CostCalculator', api, hook);
  try {
    setStore(store, { activeCompanyId: 'company' });
    await hook.settle(Component); await flush(); await hook.settle(Component);
    productPicker(hook.getOutput()).props.onChange('product');
    await hook.settle(Component); await flush(); await hook.settle(Component);
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.0001').props.value, '10.0000');
    assert.equal(typeof event, 'function', 'selected costs subscribe to PO updates');
    amount = 22; event({ kind: 'purchaseOrder' });
    await hook.settle(Component); await flush(); await hook.settle(Component);
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.0001').props.value, '22.0000');
    input(hook.getOutput(), (props) => props.step === '0.0001').props.onChange({ target: { value: '9.50' } });
    await hook.settle(Component);
    amount = 30; event({ kind: 'purchaseOrder' });
    await hook.settle(Component); await flush(); await hook.settle(Component);
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.0001').props.value, '9.50');
    assert.ok(findAll(hook.getOutput(), (node) => node.props?.label === 'Latest landed' && node.props.value === '$30.00').length);
    failure = 'Server connection lost'; event({ kind: 'purchaseOrder' });
    await hook.settle(Component); await flush(); await hook.settle(Component);
    assert.match(textOf(hook.getOutput()), /Server connection lost/);
    assert.doesNotMatch(textOf(hook.getOutput()), /No received-PO cost history/);
    failure = null; amount = null;
    findAll(hook.getOutput(), (node) => node.type?.name === 'Button' && node.props.children === 'Retry')[0].props.onClick();
    await hook.settle(Component); await flush(); await hook.settle(Component);
    assert.match(textOf(hook.getOutput()), /No received-PO cost history/);
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.0001').props.value, '9.50');
  } finally { hook.cleanup(); }
});

test('CostCalculator realized margin uses rounded retail while the target remains unchanged', async () => {
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/CostCalculator/index.jsx', 'CostCalculator', { products: { list: async () => [] } }, hook);
  try {
    setStore(store, { activeCompanyId: 'company' });
    await hook.settle(Component);
    input(hook.getOutput(), (props) => props.step === '0.0001').props.onChange({ target: { value: '0.01' } });
    await hook.settle(Component);
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.01').props.value, '0.02');
    assert.equal(input(hook.getOutput(), (props) => props.step === '0.1').props.value, '40');
    assert.ok(findAll(hook.getOutput(), (node) => node.props?.label === 'Realized margin' && node.props.value === '50.00%').length);
  } finally { hook.cleanup(); }
});

test('Settings failed config load ends loading and Retry can render ready without a company', async () => {
  let fail = true;
  const api = { settings: { getAll: async () => { if (fail) throw new Error('Config unavailable'); return { mode: 'standalone' }; } }, app: { getVersionInfo: async () => null } };
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/Settings/index.jsx', 'Settings', api, hook);
  try {
    setStore(store, { activeCompanyId: null });
    await hook.settle(Component); await flush(); await hook.settle(Component);
    assert.match(textOf(hook.getOutput()), /Config unavailable/);
    assert.doesNotMatch(textOf(hook.getOutput()), /Loading…/);
    fail = false;
    findAll(hook.getOutput(), (node) => node.type?.name === 'Button' && node.props.children === 'Retry')[0].props.onClick();
    await hook.settle(Component); await flush(); await hook.settle(Component);
    assert.match(textOf(hook.getOutput()), /General/);
    assert.doesNotMatch(textOf(hook.getOutput()), /Config unavailable/);
  } finally { hook.cleanup(); }
});

const poSnapshot = (notes = 'Original', updatedAt = 1, poNumber = 'PO-1') => ({
  header: { id: 'po', companyId: 'company', poNumber, notes, updatedAt, currency: 'USD', exchangeRateToUsd: 1, status: 'draft', incoterm: 'FOB' },
  lines: [], components: [], payments: [], calc: {},
});

test('PO metadata stays controlled across a remote refresh, saves unchanged blur once, and preserves a failed draft for retry', async () => {
  let snapshot = poSnapshot(); let event; let failure = true; const saves = []; const toasts = [];
  const api = {
    events: { onCatalogChanged(handler) { event = handler; return () => {}; } },
    purchaseOrders: {
      getDetail: async () => structuredClone(snapshot),
      update: async (_id, patch) => { saves.push(patch); if (failure) throw new Error('PO offline'); snapshot = { ...snapshot, header: { ...snapshot.header, ...patch, updatedAt: 3 } }; return snapshot.header; },
    },
  };
  const hook = hookHarness();
  const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook);
  const render = () => Component({ poId: 'po', onBack() {} });
  const notes = () => findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0];
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }], addToast: (...args) => toasts.push(args) });
    await hook.settle(render); await flush(); await hook.settle(render);
    assert.equal(notes().props.value, 'Original', 'metadata has a controlled draft');
    notes().props.onChange({ target: { value: 'Pending' } }); await hook.settle(render);
    snapshot = poSnapshot('Remote', 2, 'REMOTE-PO'); event({ kind: 'purchaseOrder', poId: 'po' });
    await delay(270); await flush(); await hook.settle(render);
    assert.equal(notes().props.value, 'Pending');
    assert.equal(input(hook.getOutput(), (props) => props.value === 'REMOTE-PO').props.value, 'REMOTE-PO', 'nonedited metadata refreshes');
    const status = () => findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0];
    await status().props.onSave(); await hook.settle(render);
    assert.equal(status().props.state, 'error');
    assert.equal(notes().props.value, 'Pending');
    assert.equal(saves[0].expectedUpdatedAt, 1, 'remote refresh cannot advance a pending draft token');
    assert.match(toasts.at(-1)[0], /PO offline/);
    failure = false; await status().props.onSave(); await hook.settle(render);
    assert.equal(status().props.state, 'saved');
    const count = saves.length; notes().props.onBlur?.(); await delay(550); await hook.settle(render);
    assert.equal(saves.length, count, 'unchanged blur sends nothing');
  } finally { hook.cleanup(); }
});

test('PO delayed save retains newer input including a revert, and Back waits for the latest acknowledgment', async () => {
  const first = deferred(); const saves = []; let back = 0;
  const api = { purchaseOrders: {
    getDetail: async () => poSnapshot(),
    update: (_id, patch) => { saves.push(patch); return saves.length === 1 ? first.promise : Promise.resolve({ ...poSnapshot().header, ...patch, updatedAt: 3 }); },
  } };
  const hook = hookHarness(); const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook);
  const render = () => Component({ poId: 'po', onBack() { back += 1; } });
  const notes = () => findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0];
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
    await hook.settle(render); await flush(); await hook.settle(render);
    notes().props.onChange({ target: { value: 'Changed' } }); await hook.settle(render);
    const saving = findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
    await hook.settle(render);
    notes().props.onChange({ target: { value: 'Original' } }); await hook.settle(render);
    const header = findAll(hook.getOutput(), (node) => node.props?.backTo)[0];
    const leaving = header.props.backTo.onClick();
    assert.equal(back, 0, 'Back waits while save is in flight');
    first.resolve({ ...poSnapshot().header, notes: 'Changed', updatedAt: 2 });
    await saving; await leaving; await hook.settle(render);
    assert.equal(saves.at(-1).notes, 'Original', 'the local revert is saved after the delayed first write');
    assert.equal(saves.at(-1).expectedUpdatedAt, 2);
    assert.equal(notes().props.value, 'Original'); assert.equal(back, 1);
  } finally { hook.cleanup(); }
});

test('PO save conflict Cancel keeps the draft and blocks Back without an implicit overwrite', async () => {
  let back = 0; const writes = [];
  const hook = hookHarness();
  const api = { purchaseOrders: { getDetail: async () => poSnapshot(), update: async (_id, patch) => { writes.push(patch); throw new Error('CONFLICT|{"kind":"purchaseOrder","id":"po","updatedAt":2}'); } } };
  const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook);
  const render = () => Component({ poId: 'po', onBack() { back += 1; } });
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
    await hook.settle(render); await flush(); await hook.settle(render);
    findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0].props.onChange({ target: { value: 'Keep my draft' } });
    await hook.settle(render);
    await findAll(hook.getOutput(), (node) => node.props?.backTo)[0].props.backTo.onClick(); await hook.settle(render);
    assert.equal(back, 0);
    assert.equal(findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0].props.value, 'Keep my draft');
    assert.equal(writes.length, 1); assert.equal(writes[0].expectedUpdatedAt, 1);
    assert.equal(findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.state, 'error');
  } finally { hook.cleanup(); }
});

test('PO conflict Refresh uses the latest detail and Overwrite requires the explicit choice', async () => {
  for (const choice of ['Refresh', 'Overwrite']) {
    let snapshot = poSnapshot(); const writes = []; let conflict = true;
    const hook = hookHarness();
    const api = { purchaseOrders: {
      getDetail: async () => structuredClone(snapshot),
      update: async (_id, patch) => {
        writes.push(patch);
        if (conflict) { snapshot = poSnapshot('Remote', 2); throw new Error('CONFLICT|{"kind":"purchaseOrder","id":"po","updatedAt":2}'); }
        snapshot = { ...snapshot, header: { ...snapshot.header, ...patch, updatedAt: 3 } }; return snapshot.header;
      },
    } };
    const { Component, ConflictHost, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook, "\nexport { ConflictModalHost } from '../../components/ConflictModal.jsx';");
    const render = () => ({ type: 'div', props: { children: [Component({ poId: 'po', onBack() {} }), ConflictHost()] } });
    const notes = () => findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0];
    try {
      setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
      await hook.settle(render); await flush(); await hook.settle(render);
      notes().props.onChange({ target: { value: 'Local' } }); await hook.settle(render);
      const saving = findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
      await flush(); await hook.settle(render);
      assert.equal(writes.length, 1, 'conflict waits for a choice');
      conflict = false;
      findAll(hook.getOutput(), (node) => node.type?.name === 'Button' && node.props.children === choice)[0].props.onClick();
      await saving; await hook.settle(render);
      assert.equal(notes().props.value, choice === 'Refresh' ? 'Remote' : 'Local');
      assert.equal(findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.state, 'saved');
      if (choice === 'Overwrite') { assert.equal(writes.length, 2); assert.equal('expectedUpdatedAt' in writes[1], false); }
      else assert.equal(writes.length, 1);
    } finally { hook.cleanup(); }
  }
});

test('PO child conflict Refresh rebinds the actual row and its PO revision before retry', async () => {
  const line = { id: 'line', productId: 'product', productSku: 'A', qty: 1, unitPriceSupplierCurrency: 5 };
  let snapshot = { ...poSnapshot(), lines: [line] }; let conflict = true; const writes = [];
  const hook = hookHarness();
  const api = { purchaseOrders: {
    getDetail: async () => structuredClone(snapshot),
    updateLine: async (_id, patch) => {
      writes.push(patch);
      if (conflict) { snapshot = { ...poSnapshot('Remote', 2), lines: [{ ...line, qty: 8 }] }; throw new Error('CONFLICT|{"kind":"purchaseOrder","id":"po","updatedAt":2}'); }
      snapshot = { ...poSnapshot('Remote', 3), lines: [{ ...line, ...patch }] }; return snapshot;
    },
  } };
  const { Component, ConflictHost, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook, "\nexport { ConflictModalHost } from '../../components/ConflictModal.jsx';");
  const render = () => ({ type: 'div', props: { children: [Component({ poId: 'po', onBack() {} }), ConflictHost()] } });
  const modal = () => findAll(hook.getOutput(), (node) => node.type?.name === 'LineModal')[0];
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
    await hook.settle(render); await flush(); await hook.settle(render);
    findAll(hook.getOutput(), (node) => node.type?.name === 'Button' && node.props.children === 'Edit')[0].props.onClick(); await hook.settle(render);
    const saving = modal().props.onSave({ qty: 2 }); await flush(); await hook.settle(render);
    assert.equal(writes[0].expectedUpdatedAt, 1);
    findAll(hook.getOutput(), (node) => node.type?.name === 'Button' && node.props.children === 'Refresh')[0].props.onClick();
    await saving; await hook.settle(render);
    assert.equal(modal().props.line.qty, 8); assert.equal(modal().props.line.expectedUpdatedAt, 2);
    conflict = false; await modal().props.onSave({ qty: 9 }); await hook.settle(render);
    assert.equal(writes[1].expectedUpdatedAt, 2); assert.equal(modal(), undefined);
  } finally { hook.cleanup(); }
});

test('PO acknowledgments and remote reads from an old context cannot replace the current order', async () => {
  const first = deferred(); const reads = []; let poId = 'po-a';
  const api = { purchaseOrders: {
    getDetail: async (id) => { reads.push(id); return { ...poSnapshot(id, id === 'po-a' ? 1 : 10), header: { ...poSnapshot(id, id === 'po-a' ? 1 : 10).header, id } }; },
    update: () => first.promise,
  } };
  const hook = hookHarness(); const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook);
  const render = () => Component({ poId, onBack() {} });
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
    await hook.settle(render); await flush(); await hook.settle(render);
    findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0].props.onChange({ target: { value: 'Pending A' } }); await hook.settle(render);
    const saving = findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
    poId = 'po-b'; await hook.settle(render); await flush(); await hook.settle(render);
    findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0].props.onChange({ target: { value: 'Pending B' } }); await hook.settle(render);
    first.resolve({ ...poSnapshot('Saved A', 2).header, id: 'po-a' });
    await saving; await flush(); await hook.settle(render);
    assert.equal(findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0].props.value, 'Pending B');
    assert.deepEqual(reads, ['po-a', 'po-b'], 'old ack cannot launch a fresh read into the current editor');
  } finally { hook.cleanup(); }
});

test('PO final input replaces an intermediate autosave that queued while the first write was held', async () => {
  for (const finalNotes of ['A', 'Original']) {
    const first = deferred(); const writes = []; let snapshot = poSnapshot(); let back = 0;
    const api = { purchaseOrders: {
      getDetail: async () => structuredClone(snapshot),
      update: async (_id, patch) => {
        writes.push(patch);
        if (writes.length === 1) await first.promise;
        snapshot = { ...snapshot, header: { ...snapshot.header, ...patch, updatedAt: writes.length + 1 } };
        return snapshot.header;
      },
    } };
    const hook = hookHarness(); const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook);
    const render = () => Component({ poId: 'po', onBack() { back += 1; } });
    const notes = () => findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0];
    try {
      setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
      await hook.settle(render); await flush(); await hook.settle(render);
      notes().props.onChange({ target: { value: 'A' } }); await hook.settle(render);
      const saving = findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.onSave(); await hook.settle(render);
      notes().props.onChange({ target: { value: 'B' } }); await hook.settle(render);
      await delay(550); await hook.settle(render); // B really reaches the pending queue before the final input.
      notes().props.onChange({ target: { value: finalNotes } }); await hook.settle(render);
      assert.equal(notes().props.value, finalNotes, 'the unacknowledged final input stays visible');
      const leaving = findAll(hook.getOutput(), (node) => node.props?.backTo)[0].props.backTo.onClick();
      assert.equal(back, 0);
      first.resolve(); await saving; await leaving; await hook.settle(render);
      assert.equal(snapshot.header.notes, finalNotes); assert.equal(notes().props.value, finalNotes);
      assert.equal(writes.some((patch) => patch.notes === 'B'), false, 'queued B must never persist');
      assert.equal(writes.length, finalNotes === 'A' ? 1 : 2);
      assert.equal(back, 1);
      assert.equal(findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.state, 'saved');
    } finally { hook.cleanup(); }
  }
});

test('PO autosave-only live drafts drop a reverted field from a queued multi-field patch', async () => {
  const first = deferred(); const writes = []; let snapshot = poSnapshot();
  const api = { purchaseOrders: {
    getDetail: async () => structuredClone(snapshot),
    update: async (_id, patch) => {
      writes.push(patch); if (writes.length === 1) await first.promise;
      snapshot = { ...snapshot, header: { ...snapshot.header, ...patch, updatedAt: writes.length + 1 } }; return snapshot.header;
    },
  } };
  const hook = hookHarness(); const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook);
  const render = () => Component({ poId: 'po', onBack() {} });
  const notes = () => findAll(hook.getOutput(), (node) => node.type?.name === 'Textarea')[0];
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
    await hook.settle(render); await flush(); await hook.settle(render);
    notes().props.onChange({ target: { value: 'A' } }); await hook.settle(render);
    await delay(550); await hook.settle(render); // Start A through the actual autosave path, without Save/Back.
    assert.equal(writes.length, 1);
    notes().props.onChange({ target: { value: 'B' } }); await hook.settle(render);
    input(hook.getOutput(), (props) => props.value === 'PO-1').props.onChange({ target: { value: 'PO-final' } }); await hook.settle(render);
    await delay(550); await hook.settle(render);
    notes().props.onChange({ target: { value: 'A' } }); await hook.settle(render);
    assert.equal(notes().props.value, 'A');
    first.resolve(); await flush(); await hook.settle(render); await delay(550); await hook.settle(render);
    assert.deepEqual(writes, [{ notes: 'A', expectedUpdatedAt: 1 }, { poNumber: 'PO-final', expectedUpdatedAt: 2 }]);
    assert.equal(snapshot.header.notes, 'A'); assert.equal(snapshot.header.poNumber, 'PO-final');
    assert.equal(findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0].props.state, 'saved');
  } finally { hook.cleanup(); }
});

test('PO FX unchanged blur and Save send no IPC; invalid rates retain retryable drafts and valid rates use the revision', async () => {
  const writes = []; const toasts = []; let snapshot = poSnapshot();
  const api = { purchaseOrders: {
    getDetail: async () => structuredClone(snapshot),
    update: async (_id, patch) => { writes.push(patch); snapshot = { ...snapshot, header: { ...snapshot.header, ...patch, updatedAt: 2 } }; return snapshot.header; },
  } };
  const hook = hookHarness(); const { Component, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook);
  const render = () => Component({ poId: 'po', onBack() {} });
  const fx = () => input(hook.getOutput(), (props) => props.step === '0.0001');
  const status = () => findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0];
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }], addToast: (...args) => toasts.push(args) });
    await hook.settle(render); await flush(); await hook.settle(render);
    fx().props.onBlur?.({ target: { value: '1' } }); await status().props.onSave();
    await delay(550); await hook.settle(render);
    assert.deepEqual(writes, [], 'focusing/leaving an unchanged FX field and Save cannot create a mutation');
    for (const value of ['', '0', '-1', 'invalid', 'Infinity']) {
      fx().props.onChange({ target: { value } }); await hook.settle(render);
      assert.equal(await status().props.onSave(), false); await hook.settle(render);
      assert.equal(fx().props.value, value, 'invalid input stays available to correct');
      assert.equal(status().props.state, 'error');
      assert.match(status().props.error, /FX rate must be a number above 0/);
      assert.match(toasts.at(-1)[0], /FX rate must be a number above 0/);
      assert.deepEqual(writes, [], 'invalid rates are rejected before IPC');
    }
    fx().props.onChange({ target: { value: '0.15' } }); await hook.settle(render);
    assert.equal(await status().props.onSave(), true); await hook.settle(render);
    assert.equal(writes.length, 1); assert.equal(writes[0].exchangeRateToUsd, 0.15); assert.equal(writes[0].expectedUpdatedAt, 1);
    assert.ok(Number.isFinite(writes[0].exchangeRateDate)); assert.equal(status().props.state, 'saved');
    fx().props.onBlur?.({ target: { value: '0.15' } }); await status().props.onSave(); await hook.settle(render);
    assert.equal(writes.length, 1, 'unchanged persisted FX does not repeat its write');
  } finally { hook.cleanup(); }
});

test('PO FX explicit Overwrite revalidates the latest draft before omitting its revision', async () => {
  const writes = []; let snapshot = poSnapshot();
  const api = { purchaseOrders: {
    getDetail: async () => structuredClone(snapshot),
    update: async (_id, patch) => {
      writes.push(patch);
      if ('expectedUpdatedAt' in patch) { snapshot = poSnapshot('Remote', 2); throw new Error('CONFLICT|{"kind":"purchaseOrder","id":"po","updatedAt":2}'); }
      snapshot = { ...snapshot, header: { ...snapshot.header, ...patch, updatedAt: 3 } }; return snapshot.header;
    },
  } };
  const hook = hookHarness();
  const { Component, ConflictHost, store } = await loadComponent('renderer/modules/PurchaseOrders/PODetail.jsx', 'PODetail', api, hook, "\nexport { ConflictModalHost } from '../../components/ConflictModal.jsx';");
  const render = () => ({ type: 'div', props: { children: [Component({ poId: 'po', onBack() {} }), ConflictHost()] } });
  const fx = () => input(hook.getOutput(), (props) => props.step === '0.0001');
  const status = () => findAll(hook.getOutput(), (node) => node.type?.name === 'SaveStatus')[0];
  const overwrite = () => findAll(hook.getOutput(), (node) => node.type?.name === 'Button' && node.props.children === 'Overwrite')[0];
  try {
    setStore(store, { activeCompanyId: 'company', allProducts: [{ id: 'product' }] });
    await hook.settle(render); await flush(); await hook.settle(render);
    fx().props.onChange({ target: { value: '0.20' } }); await hook.settle(render);
    const saving = status().props.onSave(); await flush(); await hook.settle(render);
    assert.equal(writes[0].expectedUpdatedAt, 1);
    fx().props.onChange({ target: { value: '' } }); await hook.settle(render);
    overwrite().props.onClick(); assert.equal(await saving, false); await hook.settle(render);
    assert.equal(writes.length, 1, 'a newly invalid draft must never reach overwrite IPC');
    assert.equal(fx().props.value, ''); assert.equal(status().props.state, 'error'); assert.match(status().props.error, /FX rate must be a number above 0/);
    fx().props.onChange({ target: { value: '0.25' } }); await hook.settle(render);
    const retry = status().props.onSave(); await flush(); await hook.settle(render);
    overwrite().props.onClick(); assert.equal(await retry, true); await hook.settle(render);
    assert.equal(writes.at(-1).exchangeRateToUsd, 0.25); assert.equal('expectedUpdatedAt' in writes.at(-1), false);
    assert.equal(status().props.state, 'saved'); assert.equal(fx().props.value, 0.25);
  } finally { hook.cleanup(); }
});
