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

function hookHarness() {
  let cursor = 0;
  let dirty = false;
  let output = null;
  const hooks = [];
  const pendingEffects = [];

  function depsChanged(previous, next) {
    if (!previous || !next || previous.length !== next.length) return true;
    return next.some((value, i) => !Object.is(value, previous[i]));
  }

  const React = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next;
        if (!Object.is(value, hooks[index].value)) {
          hooks[index].value = value;
          dirty = true;
        }
      };
      return [hooks[index].value, setValue];
    },
    useRef(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      const changed = !previous || depsChanged(previous.deps, deps);
      hooks[index] = { deps, cleanup: previous?.cleanup };
      if (changed) pendingEffects.push({ index, effect, previous });
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || depsChanged(previous.deps, deps)) {
        hooks[index] = { deps, value: factory() };
      }
      return hooks[index].value;
    },
  };

  const jsxRuntime = {
    Fragment: Symbol('Fragment'),
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
  };

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
    for (const hook of hooks) {
      if (typeof hook?.cleanup === 'function') {
        hook.cleanup();
        hook.cleanup = null;
      }
    }
  }

  return { React, jsxRuntime, render, settle, cleanup, getOutput: () => output };
}

function findNode(root, predicate) {
  if (!root || typeof root !== 'object') return null;
  if (predicate(root)) return root;
  for (const value of Object.values(root)) {
    const found = Array.isArray(value)
      ? value.map((item) => findNode(item, predicate)).find(Boolean)
      : findNode(value, predicate);
    if (found) return found;
  }
  return null;
}

function installBrowser(api) {
  const storage = new Map();
  const noop = () => {};
  global.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  global.document = {
    body: { appendChild: noop, removeChild: noop, classList: { add: noop, remove: noop } },
    documentElement: { setAttribute: noop },
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop }),
  };
  global.window = {
    api,
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  global.navigator = global.navigator || { userAgent: 'node', platform: 'darwin' };
}

async function loadWorkspace(api, hook) {
  installBrowser(api);
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  let storeHook;
  const zustand = {
    create(factory) {
      let state;
      const set = (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        if (patch) state = { ...state, ...patch };
      };
      state = factory(set, () => state);
      storeHook = (selector = (value) => value) => selector(state);
      storeHook.getState = () => state;
      storeHook.setState = set;
      return storeHook;
    },
  };
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/ImageWorkspace/index.jsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand', '@imgly/background-removal'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn((id) => {
    if (id === 'react') return hook.React;
    if (id === 'react/jsx-runtime') return hook.jsxRuntime;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    if (id === 'zustand') return zustand;
    return req(id);
  }, mod, mod.exports);
  return { Component: mod.exports.ImageWorkspace, store: storeHook };
}

test('ImageWorkspace keeps debounced saves attached to the image that owns the settings', async () => {
  const calls = [];
  const api = {
    workspace: {
      saveSettings: (productId, imageId, expectedContentHash, settings) => {
        const gate = deferred();
        calls.push({ productId, imageId, expectedContentHash, settings, gate });
        return gate.promise.then(() => [{
          id: imageId,
          filepath: `${imageId}.jpg`,
          contentHash: expectedContentHash,
          workspaceSettings: settings,
          workspaceRevision: 1,
        }]);
      },
      processImage: async () => ({}),
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const imageA = { id: 'a', filepath: 'a.jpg', contentHash: 'hash-a', workspaceSettings: { brightness: 1 } };
  const imageB = { id: 'b', filepath: 'b.jpg', contentHash: 'hash-b', workspaceSettings: { brightness: 2 } };
  const imageC = { id: 'c', filepath: 'c.jpg', contentHash: 'hash-c', workspaceSettings: { brightness: 3 } };
  const imageD = { id: 'd', filepath: 'd.jpg', contentHash: 'hash-d', workspaceSettings: { brightness: 4 } };
  store.setState({
    activeProductId: 'product-1',
    workspaceImages: [imageA],
    workspaceImageIndex: 0,
    workspaceLoading: false,
    loadWorkspaceForProduct: async () => {},
  });
  await hook.settle(Component);

  let settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
  settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 11 });
  await hook.settle(Component);

  store.setState({ workspaceImages: [imageB] });
  await hook.settle(Component);
  assert.equal(calls.length, 1, 'leaving A flushes the pending A edit once');
  assert.equal(calls[0].imageId, 'a');
  assert.equal(calls[0].expectedContentHash, 'hash-a');
  assert.equal(calls[0].settings.brightness, 11);

  calls[0].gate.resolve();
  await Promise.resolve();
  await hook.settle(Component);
  const bStatus = findNode(hook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
  assert.equal(bStatus.props.status.state, 'idle', 'late A completion must not mark B saved');

  settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
  settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 22 });
  await hook.settle(Component);
  await delay(550);
  assert.equal(calls.length, 2, 'B edit is saved after its own debounce');
  assert.equal(calls[1].imageId, 'b');
  assert.equal(calls[1].expectedContentHash, 'hash-b');
  assert.equal(calls[1].settings.brightness, 22);

  store.setState({ workspaceImages: [imageC] });
  await hook.settle(Component);
  calls[1].gate.resolve();
  await Promise.resolve();
  await hook.settle(Component);
  const cStatus = findNode(hook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
  assert.equal(cStatus.props.status.state, 'idle', 'late B completion must not mark C saved');

  settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
  settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 33 });
  await hook.settle(Component);
  settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
  await delay(550);
  assert.equal(calls.length, 3, 'C edit is saved after its own debounce');
  assert.equal(calls[2].imageId, 'c');
  assert.equal(calls[2].expectedContentHash, 'hash-c');
  assert.equal(calls[2].settings.brightness, 33);
  settingsPanel.props.onSave();
  await Promise.resolve();
  assert.equal(calls.length, 3, 'explicit Save does not duplicate an identical in-flight autosave');

  store.setState({ workspaceImages: [imageD] });
  await hook.settle(Component);
  calls[2].gate.resolve();
  await Promise.resolve();
  await hook.settle(Component);
  const dStatus = findNode(hook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
  assert.equal(dStatus.props.status.state, 'idle', 'late C saves must not mark D saved');

  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace serializes a newer manual save behind an in-flight autosave', async () => {
  const calls = [];
  let persistedBrightness = 1;
  const api = {
    workspace: {
      saveSettings: (productId, imageId, expectedContentHash, settings) => {
        const gate = deferred();
        const workspaceRevision = calls.length + 1;
        calls.push({ productId, imageId, expectedContentHash, settings, gate });
        return gate.promise.then(() => {
          persistedBrightness = settings.brightness;
          return [{
            id: imageId,
            filepath: `${imageId}.jpg`,
            contentHash: expectedContentHash,
            workspaceSettings: settings,
            workspaceRevision,
          }];
        });
      },
      processImage: async () => ({}),
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const image = { id: 'a', filepath: 'a.jpg', contentHash: 'hash-a', workspaceSettings: { brightness: 1 } };
    store.setState({
      activeProductId: 'product-1',
      workspaceImages: [image],
      workspaceImageIndex: 0,
      workspaceLoading: false,
      loadWorkspaceForProduct: async () => {},
    });
    await hook.settle(Component);

    let settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 2 });
    await hook.settle(Component);
    await delay(550);
    assert.equal(calls.length, 1, 'the first edit is now in flight');

    settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 3 });
    await hook.settle(Component);
    settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    settingsPanel.props.onSave();
    await Promise.resolve();
    assert.equal(calls.length, 1, 'manual Save queues the newer draft behind A');

    calls[0].gate.resolve();
    await delay(0);
    assert.equal(calls.length, 2, 'the newer draft starts after A completes');
    assert.equal(calls[1].settings.brightness, 3);
    calls[1].gate.resolve();
    await delay(0);
    await hook.settle(Component);
    assert.equal(persistedBrightness, 3, 'the older autosave must not persist after the newer manual save');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace does not mark a newer editor errored when an older autosave rejects', async () => {
  const firstSave = deferred();
  const api = {
    workspace: {
      saveSettings: () => firstSave.promise,
      processImage: async () => ({}),
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const imageA = { id: 'a', filepath: 'a.jpg', contentHash: 'hash-a', workspaceSettings: { brightness: 1 } };
    const imageB = { id: 'b', filepath: 'b.jpg', contentHash: 'hash-b', workspaceSettings: { brightness: 2 } };
    store.setState({
      activeProductId: 'product-1',
      workspaceImages: [imageA],
      workspaceImageIndex: 0,
      workspaceLoading: false,
      loadWorkspaceForProduct: async () => {},
    });
    await hook.settle(Component);

    const settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 11 });
    await hook.settle(Component);
    await delay(550);

    store.setState({ workspaceImages: [imageB] });
    await hook.settle(Component);
    firstSave.reject(new Error('stale image'));
    await delay(0);
    await hook.settle(Component);

    const status = findNode(hook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
    assert.equal(status.props.status.state, 'idle');
    assert.deepEqual(store.getState().toasts, [], 'the old failure must not toast in the newer editor');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace does not toast when an older manual save rejects after switching editors', async () => {
  const calls = [];
  const api = {
    workspace: {
      saveSettings: (productId, imageId, expectedContentHash, settings) => {
        const gate = deferred();
        calls.push({ productId, imageId, expectedContentHash, settings, gate });
        return gate.promise;
      },
      processImage: async () => ({}),
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const imageA = { id: 'a', filepath: 'a.jpg', contentHash: 'hash-a', workspaceSettings: { brightness: 1 } };
    const imageB = { id: 'b', filepath: 'b.jpg', contentHash: 'hash-b', workspaceSettings: { brightness: 2 } };
    store.setState({
      activeProductId: 'product-1',
      workspaceImages: [imageA],
      workspaceImageIndex: 0,
      workspaceLoading: false,
      loadWorkspaceForProduct: async () => {},
    });
    await hook.settle(Component);

    let settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 11 });
    await hook.settle(Component);
    settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    const manualSave = settingsPanel.props.onSave();
    await delay(0);
    assert.equal(calls.length, 1, 'manual Save starts a deferred write for image A');

    store.setState({ workspaceImages: [imageB] });
    await hook.settle(Component);
    calls[0].gate.reject(new Error('stale image'));
    await manualSave;
    await hook.settle(Component);

    const status = findNode(hook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
    assert.equal(status.props.status.state, 'idle');
    assert.deepEqual(store.getState().toasts, [], 'the stale manual-save failure must not toast in the newer editor');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace surfaces a current manual save failure', async () => {
  const gate = deferred();
  const api = {
    workspace: {
      saveSettings: async () => gate.promise,
      processImage: async () => ({}),
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const image = { id: 'a', filepath: 'a.jpg', contentHash: 'hash-a', workspaceSettings: { brightness: 1 } };
    store.setState({
      activeProductId: 'product-1',
      workspaceImages: [image],
      workspaceImageIndex: 0,
      workspaceLoading: false,
      loadWorkspaceForProduct: async () => {},
    });
    await hook.settle(Component);

    let settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 11 });
    await hook.settle(Component);
    settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    const manualSave = settingsPanel.props.onSave();
    await delay(0);
    gate.reject(new Error('current save unavailable'));
    await manualSave;
    await hook.settle(Component);

    const status = findNode(hook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
    assert.equal(status.props.status.state, 'error');
    assert.deepEqual(
      store.getState().toasts.map(({ message, variant }) => ({ message, variant })),
      [{ message: 'Save failed: current save unavailable', variant: 'error' }],
    );
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace flushes a pending save for the old context without updating the new context', async () => {
  const calls = [];
  const api = {
    workspace: {
      saveSettings: (productId, imageId, expectedContentHash, settings) => {
        const gate = deferred();
        calls.push({ productId, imageId, expectedContentHash, settings, gate });
        return gate.promise;
      },
      processImage: async () => ({}),
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const oldImage = { id: 'old-image', filepath: 'old.jpg', contentHash: 'old-hash', workspaceSettings: { brightness: 1 } };
    const newImage = { id: 'new-image', filepath: 'new.jpg', contentHash: 'new-hash', workspaceSettings: { brightness: 2 } };
    store.setState({
      activeProductId: 'old-product',
      workspaceImages: [oldImage],
      workspaceImageIndex: 0,
      workspaceLoading: false,
      loadWorkspaceForProduct: async () => {},
    });
    await hook.settle(Component);

    const settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    settingsPanel.props.onChange({ ...settingsPanel.props.settings, brightness: 11 });
    await hook.settle(Component);

    store.setState({ activeProductId: 'new-product', workspaceImages: [newImage] });
    await hook.settle(Component);
    assert.equal(calls.length, 1, 'leaving the old context flushes its pending draft once');
    assert.deepEqual(
      {
        productId: calls[0].productId,
        imageId: calls[0].imageId,
        expectedContentHash: calls[0].expectedContentHash,
        brightness: calls[0].settings.brightness,
      },
      {
        productId: 'old-product',
        imageId: 'old-image',
        expectedContentHash: 'old-hash',
        brightness: 11,
      },
    );

    calls[0].gate.reject(new Error('old context unavailable'));
    await delay(0);
    await hook.settle(Component);

    const status = findNode(hook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
    assert.equal(status.props.status.state, 'idle');
    assert.deepEqual(store.getState().toasts, [], 'old-context failure stays out of the new context UI');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace unmount flushes its pending save without affecting a remounted editor', async () => {
  const calls = [];
  const api = {
    workspace: {
      saveSettings: (productId, imageId, expectedContentHash, settings) => {
        const gate = deferred();
        calls.push({ productId, imageId, expectedContentHash, settings, gate });
        return gate.promise;
      },
      processImage: async () => ({}),
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const oldHook = hookHarness();
  const oldWorkspace = await loadWorkspace(api, oldHook);
  const oldImage = { id: 'old-image', filepath: 'old.jpg', contentHash: 'old-hash', workspaceSettings: { brightness: 1 } };
  oldWorkspace.store.setState({
    activeProductId: 'old-product',
    workspaceImages: [oldImage],
    workspaceImageIndex: 0,
    workspaceLoading: false,
    loadWorkspaceForProduct: async () => {},
  });
  await oldHook.settle(oldWorkspace.Component);
  const oldSettings = findNode(oldHook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
  oldSettings.props.onChange({ ...oldSettings.props.settings, brightness: 11 });
  await oldHook.settle(oldWorkspace.Component);
  oldHook.cleanup();
  await Promise.resolve();

  assert.equal(calls.length, 1, 'unmount flushes the pending old draft once');
  assert.equal(calls[0].productId, 'old-product');
  assert.equal(calls[0].settings.brightness, 11);

  const newHook = hookHarness();
  const newWorkspace = await loadWorkspace(api, newHook);
  try {
    const newImage = { id: 'new-image', filepath: 'new.jpg', contentHash: 'new-hash', workspaceSettings: { brightness: 2 } };
    newWorkspace.store.setState({
      activeProductId: 'new-product',
      workspaceImages: [newImage],
      workspaceImageIndex: 0,
      workspaceLoading: false,
      loadWorkspaceForProduct: async () => {},
    });
    await newHook.settle(newWorkspace.Component);

    calls[0].gate.reject(new Error('old unmounted context unavailable'));
    await delay(0);
    await newHook.settle(newWorkspace.Component);

    const status = findNode(newHook.getOutput(), (node) => node.type?.name === 'SaveIndicator');
    assert.equal(status.props.status.state, 'idle');
    assert.deepEqual(newWorkspace.store.getState().toasts, []);
  } finally {
    newHook.cleanup();
  }
});

test('ImageWorkspace processes the selected image by immutable identity', async () => {
  const calls = [];
  const api = {
    workspace: {
      saveSettings: async () => [],
      processImage: async (...args) => {
        calls.push(args);
        return {};
      },
    },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [] },
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const image = {
      id: 'selected-image',
      filepath: 'old-position.jpg',
      contentHash: 'hash-selected',
      workspaceSettings: { removeBackground: false },
    };
    store.setState({
      activeProductId: 'product-1',
      workspaceImages: [image],
      workspaceImageIndex: 0,
      workspaceLoading: false,
      loadWorkspaceForProduct: async () => {},
      refreshProducts: async () => {},
    });
    await hook.settle(Component);

    const settingsPanel = findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
    await settingsPanel.props.onApplyThis();

    assert.deepEqual(calls[0].slice(0, 3), ['product-1', 'selected-image', 'hash-selected']);
  } finally {
    hook.cleanup();
  }
});
