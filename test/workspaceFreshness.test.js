const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function loadSlice(api) {
  global.window = { api };
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'renderer/store/workspace.js')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports.createWorkspaceSlice;
}

function fakeStore(initial) {
  let state = { ...initial };
  const set = (update) => {
    const patch = typeof update === 'function' ? update(state) : update;
    state = { ...state, ...patch };
  };
  const get = () => state;
  return { set, get, state: () => state };
}

test('workspace load and refresh ignore delayed responses from another product', async () => {
  const productGates = new Map();
  const imageGates = new Map();
  const gateFor = (map, id) => {
    if (!map.has(id)) map.set(id, deferred());
    return map.get(id);
  };
  const api = {
    products: { get: (id) => gateFor(productGates, id).promise },
    images: { listByProduct: (id) => gateFor(imageGates, id).promise },
  };
  const createWorkspaceSlice = await loadSlice(api);
  const store = fakeStore({ activeProductId: 'product-a', addToast() {} });
  const slice = createWorkspaceSlice(store.set, store.get);
  store.set(slice);

  const loadA = store.get().loadWorkspaceForProduct('product-a');
  store.set({ activeProductId: 'product-b' });
  const loadB = store.get().loadWorkspaceForProduct('product-b');
  productGates.get('product-b').resolve({ sku: 'B', name: 'Product B' });
  imageGates.get('product-b').resolve([{ id: 'image-b', filepath: 'b.jpg' }]);
  await loadB;
  productGates.get('product-a').resolve({ sku: 'A', name: 'Product A' });
  imageGates.get('product-a').resolve([{ id: 'image-a', filepath: 'a.jpg' }]);
  await loadA;
  assert.deepEqual(store.state().workspaceImages, [{ id: 'image-b', filepath: 'b.jpg' }]);
  assert.equal(store.state().workspaceProductSku, 'B');
  assert.equal(store.state().workspaceLoading, false);

  store.set({ activeProductId: 'product-a', workspaceImages: [{ id: 'image-a-old' }] });
  const staleRefresh = store.get().refreshWorkspaceImages('product-a');
  store.set({ activeProductId: 'product-b', workspaceImages: [{ id: 'image-b-current' }] });
  productGates.delete('product-b');
  imageGates.delete('product-b');
  const loadB2 = store.get().loadWorkspaceForProduct('product-b');
  productGates.get('product-b').resolve({ sku: 'B2', name: 'Product B2' });
  imageGates.get('product-b').resolve([{ id: 'image-b2', filepath: 'b2.jpg' }]);
  await loadB2;
  imageGates.get('product-a').resolve([{ id: 'image-a-late' }]);
  await staleRefresh;
  assert.deepEqual(store.state().workspaceImages, [{ id: 'image-b2', filepath: 'b2.jpg' }]);
});

test('workspace ignores stale refresh errors without changing current loading state', async () => {
  const oldGate = deferred();
  const newGate = deferred();
  const createWorkspaceSlice = await loadSlice({
    products: { get: async (id) => ({ sku: id, name: id }) },
    images: { listByProduct: (id) => id === 'product-a' ? oldGate.promise : newGate.promise },
  });
  const store = fakeStore({ activeProductId: 'product-a', workspaceImages: [{ id: 'current' }], workspaceLoading: false, addToast() {} });
  const slice = createWorkspaceSlice(store.set, store.get);
  store.set(slice);
  const refresh = store.get().refreshWorkspaceImages('product-a');
  store.set({ activeProductId: 'product-b', workspaceImages: [{ id: 'product-b' }], workspaceLoading: true });
  const next = store.get().loadWorkspaceForProduct('product-b');
  // The shared API gate is intentionally rejected for the obsolete request;
  // the next product's loader has a separate generation and will not commit it.
  oldGate.reject(new Error('old request failed'));
  await refresh;
  assert.deepEqual(store.state().workspaceImages, []);
  assert.equal(store.state().workspaceLoading, true);
  // Leave the second loader pending only until its own call is superseded;
  // no assertion depends on its response.
  assert.ok(next instanceof Promise);
});
