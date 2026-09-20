const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

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

function immediateCompanyApi() {
  return {
    app: { getVersion: async () => 'test', getPlatform: async () => 'darwin' },
    settings: { getAll: async () => ({ mode: 'standalone', theme: 'light' }) },
    companies: {
      list: async () => [{ id: 'company-a' }],
      getActiveId: async () => 'company-a',
      setActive: async () => {},
    },
    brands: { list: async (id) => [{ id: `brand-${id}` }] },
    categories: { list: async (id) => [{ id: `category-${id}` }] },
    products: { list: async (id) => [{ id: `product-${id}` }] },
    dashboard: {
      stats: async (id) => ({ companyId: id }),
      recentBrands: async (id) => [{ id: `recent-brand-${id}` }],
      recentProducts: async (id) => [{ id: `recent-product-${id}` }],
      completeness: async (id) => ({ companyId: id }),
    },
    exports: { listProfiles: async (id) => [{ id: `profile-${id}` }] },
    ai: {
      listModels: async () => [],
      listPrompts: async (id) => [{ id: `prompt-${id}` }],
      listTasks: async (id) => [{ id: `task-${id}` }],
      onTaskUpdate: () => () => {},
      onGalleryAdded: () => () => {},
    },
    users: { listForAttribution: async () => [], presence: async () => [] },
    events: {
      onCatalogChanged: () => () => {},
      onServerHello: () => () => {},
      onPresenceChanged: () => () => {},
      onProgress: () => () => {},
    },
  };
}

test('company switch rejects delayed prior-company rows and clears context-bound selections', async () => {
  const gates = new Map();
  const productCalls = [];
  const pending = (kind, companyId, value) => {
    if (companyId !== 'company-a') return Promise.resolve(value);
    const gate = deferred();
    gates.set(kind, { gate, value });
    return gate.promise;
  };
  const api = immediateCompanyApi();
  api.brands.list = (id) => pending('brands', id, [{ id: `brand-${id}` }]);
  api.categories.list = (id) => pending('categories', id, [{ id: `category-${id}` }]);
  api.products.list = (id) => {
    productCalls.push(id);
    return pending('products', id, [{ id: `product-${id}` }]);
  };
  api.dashboard.stats = (id) => pending('dashboard', id, { companyId: id });
  api.exports.listProfiles = (id) => pending('exports', id, [{ id: `profile-${id}` }]);
  api.ai.listPrompts = (id) => pending('prompts', id, [{ id: `prompt-${id}` }]);
  api.ai.listTasks = (id) => pending('tasks', id, [{ id: `task-${id}` }]);

  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  useAppStore.setState({
    activeCompanyId: 'company-a',
    activeProductId: 'product-a',
    aiSourceProductId: 'product-a',
    aiSourceImagePath: 'assets/a.jpg',
    aiGalleryByProduct: { 'product-a': [{ id: 'gallery-a' }] },
    exportQueueIds: ['product-a'],
    selectedExportProfileId: 'profile-a',
    pendingPoId: 'po-a',
    pendingPoSupplierId: 'supplier-a',
    pendingCatalogProjectId: 'catalog-a',
  });
  const state = useAppStore.getState();
  const oldReads = Promise.all([
    state.refreshBrands(),
    state.refreshCategories(),
    state.refreshProducts(),
    state.refreshDashboard(),
    state.refreshExportProfiles(),
    state.refreshAiPrompts(),
    state.refreshAiTasks(),
  ]);
  await Promise.resolve();

  await state.setActiveCompany('company-b');
  const switched = useAppStore.getState();
  assert.deepEqual(switched.brands, [{ id: 'brand-company-b' }]);
  assert.deepEqual(switched.categories, [{ id: 'category-company-b' }]);
  assert.deepEqual(switched.products, [{ id: 'product-company-b' }]);
  assert.deepEqual(switched.allProducts, [{ id: 'product-company-b' }]);
  assert.equal(switched.dashboardStats.companyId, 'company-b');
  assert.deepEqual(switched.exportProfiles, [{ id: 'profile-company-b' }]);
  assert.deepEqual(switched.aiPrompts, [{ id: 'prompt-company-b' }]);
  assert.deepEqual(switched.aiTasks, [{ id: 'task-company-b' }]);
  assert.equal(productCalls.filter((id) => id === 'company-b').length, 1);
  for (const key of ['activeProductId', 'aiSourceProductId', 'aiSourceImagePath', 'pendingPoId', 'pendingPoSupplierId', 'pendingCatalogProjectId']) {
    assert.equal(switched[key], null, key);
  }
  assert.equal(switched.selectedExportProfileId, 'profile-company-b');
  assert.deepEqual(switched.aiGalleryByProduct, {});
  assert.deepEqual(switched.exportQueueIds, []);

  for (const { gate, value } of gates.values()) gate.resolve(value);
  await oldReads;
  const final = useAppStore.getState();
  assert.deepEqual(final.brands, [{ id: 'brand-company-b' }]);
  assert.deepEqual(final.categories, [{ id: 'category-company-b' }]);
  assert.deepEqual(final.products, [{ id: 'product-company-b' }]);
  assert.equal(final.dashboardStats.companyId, 'company-b');
  assert.deepEqual(final.exportProfiles, [{ id: 'profile-company-b' }]);
  assert.deepEqual(final.aiPrompts, [{ id: 'prompt-company-b' }]);
  assert.deepEqual(final.aiTasks, [{ id: 'task-company-b' }]);
});

test('clearing the active company invalidates pending reads instead of restoring stale rows', async () => {
  const brandGate = deferred();
  const productGate = deferred();
  const dashboardGate = deferred();
  const api = immediateCompanyApi();
  api.brands.list = () => brandGate.promise;
  api.products.list = () => productGate.promise;
  api.dashboard.stats = () => dashboardGate.promise;

  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  useAppStore.setState({ activeCompanyId: 'company-a', activeProductId: 'product-a' });
  const state = useAppStore.getState();
  const pendingReads = Promise.all([state.refreshBrands(), state.refreshProducts(), state.refreshDashboard()]);
  await Promise.resolve();
  await state.setActiveCompany(null);
  brandGate.resolve([{ id: 'stale-brand' }]);
  productGate.resolve([{ id: 'stale-product' }]);
  dashboardGate.resolve({ companyId: 'company-a' });
  await pendingReads;

  const final = useAppStore.getState();
  assert.equal(final.activeCompanyId, null);
  assert.equal(final.activeProductId, null);
  assert.deepEqual(final.brands, []);
  assert.deepEqual(final.products, []);
  assert.deepEqual(final.allProducts, []);
  assert.equal(final.dashboardStats, null);
});

test('rapid company switches preserve the latest user choice on the server and in the store', async () => {
  const firstSwitch = deferred();
  const setCalls = [];
  let serverActiveId = 'company-original';
  const api = immediateCompanyApi();
  api.companies.setActive = async (id) => {
    setCalls.push(id);
    if (id === 'company-a') await firstSwitch.promise;
    serverActiveId = id;
  };
  api.companies.getActiveId = async () => serverActiveId;

  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  useAppStore.setState({ activeCompanyId: 'company-original' });
  const chooseA = useAppStore.getState().setActiveCompany('company-a');
  const chooseB = useAppStore.getState().setActiveCompany('company-b');

  await delay(10);
  firstSwitch.resolve();
  await Promise.all([chooseA, chooseB]);
  assert.equal(serverActiveId, 'company-b');
  assert.equal(useAppStore.getState().activeCompanyId, 'company-b');
  assert.deepEqual(setCalls, ['company-a', 'company-b']);
});

test('a reconnect lookup started before an explicit switch cannot restore the old company', async () => {
  const listeners = listenerRegistry();
  const reconnectLookup = deferred();
  let activeLookupCount = 0;
  let serverActiveId = 'company-a';
  const api = immediateCompanyApi();
  api.settings.getAll = async () => ({ mode: 'client', theme: 'light' });
  api.client = {
    connectionState: async () => ({ status: 'connected', user: { id: 'user-a', caps: [] } }),
    onConnectionState: listeners.subscribe('connection'),
  };
  api.companies.getActiveId = async () => {
    activeLookupCount += 1;
    if (activeLookupCount === 1) return serverActiveId;
    return reconnectLookup.promise;
  };
  api.companies.setActive = async (id) => { serverActiveId = id; };
  api.events.onCatalogChanged = listeners.subscribe('catalog');
  api.events.onServerHello = listeners.subscribe('hello');
  api.events.onPresenceChanged = listeners.subscribe('presence');
  api.events.onProgress = listeners.subscribe('progress');

  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  await useAppStore.getState().bootstrap();
  listeners.emit('hello', { user: { id: 'user-a', caps: [] } });
  await waitFor(() => activeLookupCount === 2, 'reconnect active-company lookup did not start');
  await useAppStore.getState().setActiveCompany('company-b');
  reconnectLookup.resolve('company-a');
  await delay(20);

  assert.equal(serverActiveId, 'company-b');
  assert.equal(useAppStore.getState().activeCompanyId, 'company-b');
});

test('product invalidations use one query per distinct view and queue one follow-up while in flight', async () => {
  const requests = [];
  const api = immediateCompanyApi();
  api.products.list = (companyId, filters) => {
    const gate = deferred();
    requests.push({ companyId, filters, gate });
    return gate.promise;
  };
  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  const { applyCatalogEvent } = await loadRendererModule('renderer/store/catalogEvents.js', api);
  useAppStore.setState({ activeCompanyId: 'company-a' });

  applyCatalogEvent(useAppStore.getState, { kind: 'product', id: 'one' });
  applyCatalogEvent(useAppStore.getState, { kind: 'product', id: 'two' });
  await delay(300);
  assert.equal(requests.length, 1, 'one burst should start one default product query');

  applyCatalogEvent(useAppStore.getState, { kind: 'product', id: 'three' });
  await delay(300);
  assert.equal(requests.length, 1, 'an in-flight invalidation should queue instead of duplicating the request');

  requests[0].gate.resolve([{ id: 'first-snapshot' }]);
  await waitFor(() => requests.length === 2, 'queued product refresh did not run');
  requests[1].gate.resolve([{ id: 'fresh-snapshot' }]);
  await waitFor(() => useAppStore.getState().products[0]?.id === 'fresh-snapshot', 'fresh product snapshot did not commit');
  assert.deepEqual(useAppStore.getState().allProducts, [{ id: 'fresh-snapshot' }]);
});

test('a filtered invalidation performs only the filtered and full-list queries', async () => {
  const requests = [];
  const api = immediateCompanyApi();
  api.products.list = async (companyId, filters) => {
    requests.push({ companyId, filters });
    return [{ id: filters.search ? 'filtered' : 'full' }];
  };
  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  const { applyCatalogEvent } = await loadRendererModule('renderer/store/catalogEvents.js', api);
  useAppStore.setState({
    activeCompanyId: 'company-a',
    productFilters: { ...useAppStore.getState().productFilters, search: 'needle' },
  });

  applyCatalogEvent(useAppStore.getState, { kind: 'product', id: 'changed' });
  await waitFor(() => useAppStore.getState().allProducts[0]?.id === 'full', 'full product snapshot did not load');
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(({ filters }) => filters.search === 'needle').length, 1);
  assert.equal(requests.filter(({ filters }) => Object.keys(filters).length === 0).length, 1);
});

test('a prior full-list response cannot overwrite a newer default-view snapshot', async () => {
  const requests = [];
  const api = immediateCompanyApi();
  api.products.list = (companyId, filters) => {
    const gate = deferred();
    requests.push({ companyId, filters, gate });
    return gate.promise;
  };
  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  const defaults = useAppStore.getState().productFilters;
  useAppStore.setState({
    activeCompanyId: 'company-a',
    productFilters: { ...defaults, search: 'needle' },
  });

  const oldFullList = useAppStore.getState().refreshAllProducts();
  await waitFor(() => requests.length === 1, 'old full-list request did not start');
  useAppStore.setState({ productFilters: { ...defaults } });
  const newestDefault = useAppStore.getState().refreshProducts();
  await waitFor(() => requests.length === 2, 'new default-view request did not start');

  requests[1].gate.resolve([{ id: 'newest-default' }]);
  await newestDefault;
  assert.deepEqual(useAppStore.getState().allProducts, [{ id: 'newest-default' }]);
  requests[0].gate.resolve([{ id: 'stale-full-list' }]);
  await oldFullList;
  assert.deepEqual(useAppStore.getState().allProducts, [{ id: 'newest-default' }]);
});

function listenerRegistry() {
  const active = new Map();
  const subscribe = (name) => (callback) => {
    if (!active.has(name)) active.set(name, new Set());
    active.get(name).add(callback);
    return () => active.get(name).delete(callback);
  };
  return {
    active,
    subscribe,
    emit(name, payload) {
      for (const callback of active.get(name) || []) callback(payload);
    },
    count(name) { return active.get(name)?.size ?? 0; },
  };
}

test('bootstrap subscribes before initial reads and optional data cannot block the active page', async () => {
  const listeners = listenerRegistry();
  const version = deferred();
  const optional = deferred();
  const api = immediateCompanyApi();
  api.app.getVersion = () => version.promise;
  api.exports.listProfiles = () => optional.promise.then(() => []);
  api.ai.listModels = () => optional.promise.then(() => []);
  api.ai.listPrompts = () => optional.promise.then(() => []);
  api.ai.listTasks = () => optional.promise.then(() => []);
  api.events.onCatalogChanged = listeners.subscribe('catalog');
  api.events.onServerHello = listeners.subscribe('hello');
  api.events.onPresenceChanged = listeners.subscribe('presence');
  api.events.onProgress = listeners.subscribe('progress');

  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  const boot = useAppStore.getState().bootstrap();
  assert.equal(listeners.count('catalog'), 1);
  assert.equal(listeners.count('hello'), 1);

  version.resolve('test');
  const result = await Promise.race([boot.then(() => 'ready'), delay(200).then(() => 'blocked')]);
  assert.equal(result, 'ready');
  assert.equal(useAppStore.getState().dashboardStats.companyId, 'company-a');
  optional.resolve();
  await Promise.resolve();
});

test('server hello coalesces reconnect reconciliation and repeated bootstraps keep one listener', async () => {
  const listeners = listenerRegistry();
  let generation = 1;
  let productCalls = 0;
  const api = immediateCompanyApi();
  api.settings.getAll = async () => ({ mode: 'client', theme: 'dark' });
  api.client = {
    connectionState: async () => ({ status: 'connected', user: { id: 'old', caps: [] } }),
    onConnectionState: listeners.subscribe('connection'),
  };
  api.products.list = async () => {
    productCalls += 1;
    return [{ id: `product-v${generation}` }];
  };
  api.events.onCatalogChanged = listeners.subscribe('catalog');
  api.events.onServerHello = listeners.subscribe('hello');
  api.events.onPresenceChanged = listeners.subscribe('presence');
  api.events.onProgress = listeners.subscribe('progress');

  const { useAppStore } = await loadRendererModule('renderer/store/index.js', api);
  useAppStore.setState({ catalogDraft: { dirty: true, title: 'local draft' } });
  await useAppStore.getState().bootstrap();
  await waitFor(() => productCalls > 0, 'background product load did not start');
  const beforeReconnect = productCalls;

  generation = 2;
  listeners.emit('hello', { user: { id: 'current-user', caps: ['products.edit'] } });
  listeners.emit('hello', { user: { id: 'current-user', caps: ['products.edit'] } });
  await waitFor(() => useAppStore.getState().products[0]?.id === 'product-v2', 'reconnect did not reconcile products');
  assert.equal(productCalls - beforeReconnect, 1);
  assert.deepEqual(useAppStore.getState().catalogDraft, { dirty: true, title: 'local draft' });
  assert.equal(useAppStore.getState().clientConnection.user.id, 'current-user');

  await useAppStore.getState().bootstrap();
  assert.equal(listeners.count('catalog'), 1);
  assert.equal(listeners.count('hello'), 1);
  assert.equal(listeners.count('connection'), 1);
});
