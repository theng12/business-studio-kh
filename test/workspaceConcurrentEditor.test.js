const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// The existing autosave test keeps this harness private. Keep the concurrent-
// editor reproduction self-contained until its test helpers become public.
function hookHarness() {
  let cursor = 0;
  let dirty = false;
  let output = null;
  const hooks = [];
  const pendingEffects = [];
  const depsChanged = (previous, next) => !previous || !next || previous.length !== next.length || next.some((value, i) => !Object.is(value, previous[i]));
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
      const changed = !previous || depsChanged(previous.deps, deps);
      hooks[index] = { deps, cleanup: previous?.cleanup };
      if (changed) pendingEffects.push({ index, effect, previous });
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || depsChanged(previous.deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
  };
  const jsxRuntime = { Fragment: Symbol('Fragment'), jsx: (type, props) => ({ type, props: props || {} }), jsxs: (type, props) => ({ type, props: props || {} }) };
  function render(Component) {
    cursor = 0;
    dirty = false;
    pendingEffects.length = 0;
    output = Component();
    for (const { index, effect, previous } of pendingEffects) {
      if (typeof previous?.cleanup === 'function') previous.cleanup();
      hooks[index].cleanup = effect();
    }
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
      if (typeof hook?.cleanup === 'function') { hook.cleanup(); hook.cleanup = null; }
    }
  }
  return { React, jsxRuntime, settle, cleanup, getOutput: () => output };
}

function findNode(root, predicate) {
  if (!root || typeof root !== 'object') return null;
  if (predicate(root)) return root;
  for (const value of Object.values(root)) {
    const found = Array.isArray(value) ? value.map((item) => findNode(item, predicate)).find(Boolean) : findNode(value, predicate);
    if (found) return found;
  }
  return null;
}

function installBrowser(api) {
  const noop = () => {};
  global.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  global.document = {
    body: { appendChild: noop, removeChild: noop, classList: { add: noop, remove: noop } },
    documentElement: { setAttribute: noop },
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop }),
  };
  global.window = { api, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) };
  global.navigator = global.navigator || { userAgent: 'node', platform: 'darwin' };
  global.__workspaceRegisterCompanySwitchFlusher ||= () => () => {};
  global.__workspaceConflictChoice ||= async () => 'cancel';
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
      const set = (update) => { const patch = typeof update === 'function' ? update(state) : update; if (patch) state = { ...state, ...patch }; };
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
    plugins: [{
      name: 'company-switch-test-shim',
      setup(build) {
        build.onResolve({ filter: /companySwitch\.js$/ }, () => ({ path: 'company-switch', namespace: 'test' }));
        build.onResolve({ filter: /ConflictModal\.jsx$/ }, () => ({ path: 'conflict-modal', namespace: 'test' }));
        build.onLoad({ filter: /^company-switch$/, namespace: 'test' }, () => ({
          contents: `
            export const registerCompanySwitchFlusher = globalThis.__workspaceRegisterCompanySwitchFlusher;
            export const flushCompanySwitches = async () => {};
          `,
          loader: 'js',
        }));
        build.onLoad({ filter: /^conflict-modal$/, namespace: 'test' }, () => ({
          contents: `
            export function parseConflictError(error) {
              const marker = error?.message?.indexOf('CONFLICT|') ?? -1;
              if (marker < 0) return null;
              try { return JSON.parse(error.message.slice(marker + 9)); } catch { return null; }
            }
            export async function resolveSaveConflict(error, { refresh, overwrite }) {
              if (!parseConflictError(error)) throw error;
              const choice = await globalThis.__workspaceConflictChoice();
              if (choice === 'refresh') return { choice, row: await refresh() };
              if (choice === 'overwrite') return { choice, row: await overwrite() };
              return { choice: 'cancel' };
            }
          `,
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => {
    if (id === 'react') return hook.React;
    if (id === 'react/jsx-runtime') return hook.jsxRuntime;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    if (id === 'zustand') return zustand;
    return req(id);
  }, mod, mod.exports);
  return { Component: mod.exports.ImageWorkspace, store: storeHook };
}

async function loadWorkspaceSlice() {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    stdin: { contents: "export { createWorkspaceSlice } from './renderer/store/workspace.js';", resolveDir: ROOT },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', out.outputFiles[0].text)(mod, mod.exports);
  return mod.exports.createWorkspaceSlice;
}

function settingsPanel(hook) {
  return findNode(hook.getOutput(), (node) => node.type?.name === 'SettingsPanel');
}

function canvasView(hook) {
  return findNode(hook.getOutput(), (node) => node.type?.name === 'CanvasView');
}

async function readyCrop(hook, Component) {
  canvasView(hook).props.onToggleCropMode();
  await hook.settle(Component);
  await delay(205);
  await hook.settle(Component);
  assert.ok(canvasView(hook).props.cropPreview);
  canvasView(hook).props.onCropReady(canvasView(hook).props.cropPreview.url);
  await hook.settle(Component);
}

/* UI pass, 2026-10: the save state and the explicit Save live in the header's
 * shared SaveStatus (`status` + `onSave`), no longer on the settings panel. */
function saveBadge(hook) {
  return findNode(hook.getOutput(), (node) => node.type?.name === 'SaveStatus');
}

function seed(store, image) {
  store.setState({
    activeProductId: 'product-1',
    workspaceImages: [image],
    workspaceImageIndex: 0,
    workspaceLoading: false,
    loadWorkspaceForProduct: async () => {},
    refreshProducts: async () => {},
  });
}

function apiWith(saveSettings) {
  return {
    workspace: { saveSettings, processImage: async () => ({}) },
    products: { get: async () => ({ sku: 'SKU', name: 'Product' }) },
    images: { listByProduct: async () => [], cropPreview: async () => ({ bytes: new Uint8Array([1]), outW: 400, outH: 200 }) },
  };
}

for (const switchProduct of [false, true]) test(`crop completion preserves a newer ${switchProduct ? 'product' : 'image'} draft`, async () => {
  const first = { id: 'crop-first', filepath: '1.png', contentHash: 'first-hash', workspaceSettings: {}, workspaceRevision: 1 };
  const second = { id: 'crop-second', filepath: '2.png', contentHash: 'second-hash', workspaceSettings: {}, workspaceRevision: 1 };
  const crop = deferred();
  const writes = [];
  const api = apiWith(async (_productId, imageId, _hash, settings) => {
    writes.push({ imageId, settings });
    return [{ ...(imageId === first.id ? first : second), workspaceSettings: settings, workspaceRevision: 2 }];
  });
  api.images.cropImage = () => crop.promise;
  api.images.listByProduct = async () => [first, second];
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, sourceCropRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } });
    await hook.settle(Component);
    await readyCrop(hook, Component);
    const run = canvasView(hook).props.onApplyCrop('newImage');
    store.setState(switchProduct ? { activeProductId: 'product-2', workspaceImages: [second], workspaceImageIndex: 0 } : { workspaceImageIndex: 1 });
    await hook.settle(Component);
    assert.equal(settingsPanel(hook).props.cropLocked, false, 'a different image remains editable while the old crop runs');
    const newRect = { x: 0.2, y: 0.3, width: 0.6, height: 0.4 };
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, sourceCropRect: newRect, cropStraighten: 9 });
    await hook.settle(Component);
    crop.resolve({ outW: 40, outH: 40 });
    await run;
    await hook.settle(Component);
    assert.deepEqual(settingsPanel(hook).props.settings.sourceCropRect, newRect);
    assert.equal(settingsPanel(hook).props.settings.cropStraighten, 9);
    assert.equal(store.getState().workspaceImageIndex, switchProduct ? 0 : 1);
    assert.equal(canvasView(hook).props.cropMode, true, 'old crop completion cannot close the new crop editor');
    await delay(560);
    assert.ok(writes.some((write) => write.imageId === second.id));
    for (const write of writes.filter((write) => write.imageId === second.id)) {
      assert.deepEqual(write.settings.sourceCropRect, newRect, 'only the new image’s own draft is autosaved');
      assert.equal(write.settings.cropStraighten, 9);
    }
  } finally { hook.cleanup(); }
});

test('crop requires the latest authoritative preview and shares the process/flip operation guard', async () => {
  const image = { id: 'preview-image', filepath: 'source.png', contentHash: 'source-hash', workspaceSettings: {}, workspaceRevision: 1 };
  const pendingPreview = deferred(), pendingCrop = deferred();
  let previews = 0, crops = 0, processes = 0, flips = 0;
  const api = apiWith(async (_p, _i, _h, settings) => [{ ...image, workspaceSettings: settings, workspaceRevision: 2 }]);
  api.images.cropPreview = async () => { previews++; return previews === 1 ? { bytes: new Uint8Array([1]), outW: 400, outH: 200 } : pendingPreview.promise; };
  api.images.cropImage = async () => { crops++; return pendingCrop.promise; };
  api.workspace.processImage = async () => { processes++; return {}; };
  api.images.flipSource = async () => { flips++; return image; };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, image);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, sourceCropRect: { x: 0, y: 0, width: 0.5, height: 0.5 } });
    await hook.settle(Component);
    await readyCrop(hook, Component);
    canvasView(hook).props.onRotationChange(90);
    await hook.settle(Component);
    assert.equal(canvasView(hook).props.cropPreview, null);
    await canvasView(hook).props.onApplyCrop('newImage');
    assert.equal(crops, 0, 'Apply cannot use old preview dimensions after rotation changes');
    await delay(205);
    pendingPreview.resolve({ bytes: new Uint8Array([2]), outW: 200, outH: 400 });
    await delay(0);
    await hook.settle(Component);
    canvasView(hook).props.onCropReady(canvasView(hook).props.cropPreview.url);
    await hook.settle(Component);
    const run = canvasView(hook).props.onApplyCrop('newImage');
    await hook.settle(Component);
    assert.equal(settingsPanel(hook).props.cropLocked, true);
    await settingsPanel(hook).props.onApplyThis();
    await settingsPanel(hook).props.onApplyAll();
    await findNode(hook.getOutput(), (node) => node.props?.['aria-label'] === 'Flip horizontally').props.onClick();
    await canvasView(hook).props.onApplyCrop('newImage');
    assert.deepEqual([crops, processes, flips], [1, 0, 0]);
    pendingCrop.reject(new Error('Synthetic failed crop'));
    await run;
    await hook.settle(Component);
    assert.ok(settingsPanel(hook).props.settings.sourceCropRect, 'failed crop retains the draft');
    assert.equal(settingsPanel(hook).props.settings.rotation, 90);
    assert.equal(settingsPanel(hook).props.cropLocked, false);
  } finally { hook.cleanup(); }
});

test('active overwrite-crop adopts rotation zero without clearing legacy canvas crop or other settings', async () => {
  const legacyRect = { x: 0, y: 0, width: 0.8, height: 1 };
  const image = { id: 'overwrite-image', filepath: 'source.png', contentHash: 'source-hash', workspaceSettings: { brightness: 8, rotation: 90, cropRect: legacyRect }, workspaceRevision: 1 };
  let savedImage = image;
  const api = apiWith(async (_p, _i, _h, settings) => [{ ...image, workspaceSettings: settings, workspaceRevision: 2 }]);
  api.images.cropImage = async () => {
    savedImage = { ...image, contentHash: 'cropped-hash', workspaceSettings: { ...image.workspaceSettings, rotation: 0, sourceCropRect: null, cropStraighten: 0 }, workspaceRevision: 3 };
    return { outW: 40, outH: 40, image: savedImage };
  };
  api.images.listByProduct = async () => [savedImage];
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, image);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, sourceCropRect: { x: 0, y: 0, width: 0.4, height: 0.5 } });
    await hook.settle(Component);
    await readyCrop(hook, Component);
    global.window.confirm = () => true;
    await canvasView(hook).props.onApplyCrop('overwrite');
    await hook.settle(Component);
    const settings = settingsPanel(hook).props.settings;
    assert.deepEqual([settings.rotation, settings.sourceCropRect, settings.cropStraighten, settings.brightness], [0, null, 0, 8]);
    assert.deepEqual(settings.cropRect, legacyRect);
  } finally { hook.cleanup(); }
});

test('ImageWorkspace adopts a newer same-image refresh after another editor saves and this editor is idle', async () => {
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(apiWith(async () => []), hook);
  try {
    const image = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 10 };
    seed(store, image);
    await hook.settle(Component);

    store.setState({ workspaceImages: [{ ...image, workspaceSettings: { brightness: 7 }, workspaceRevision: 11 }] });
    await hook.settle(Component);

    assert.equal(settingsPanel(hook).props.settings.brightness, 7, 'an idle editor must show the other editor’s acknowledged settings');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace keeps its unsaved same-image draft when another editor refreshes the row', async () => {
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(apiWith(async () => []), hook);
  try {
    const image = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 10 };
    seed(store, image);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);

    store.setState({ workspaceImages: [{ ...image, workspaceSettings: { brightness: 7 }, workspaceRevision: 11 }] });
    await hook.settle(Component);

    assert.equal(settingsPanel(hook).props.settings.brightness, 9, 'a remote refresh must not overwrite a local draft');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace ignores an older refresh without suppressing the next autosave', async () => {
  const calls = [];
  const original = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 10 };
  const api = apiWith(async (...args) => {
    calls.push(args);
    return [{ ...original, workspaceSettings: args[3], workspaceRevision: 12 }];
  });
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, original);
    await hook.settle(Component);
    store.setState({ workspaceImages: [{ ...original, workspaceSettings: { brightness: 7 }, workspaceRevision: 11 }] });
    await hook.settle(Component);
    store.setState({ workspaceImages: [original] });
    await hook.settle(Component);
    assert.equal(settingsPanel(hook).props.settings.brightness, 7, 'the older row must not replace the acknowledged settings');

    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 8 });
    await hook.settle(Component);
    await delay(550);

    assert.equal(calls.length, 1, 'the seed guard must not swallow the next real edit');
    assert.equal(calls[0][3].brightness, 8);
    assert.equal(calls[0][4], 11);
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace waits for the newest queued draft before processing the same image', async () => {
  const saves = [];
  const processes = [];
  const api = apiWith((...args) => {
    const gate = deferred();
    saves.push({ args, gate });
    return gate.promise;
  });
  api.workspace.processImage = async (...args) => { processes.push(args); return {}; };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    const image = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceRevision: 4, workspaceSettings: { brightness: 1, removeBackground: false } };
    seed(store, image);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 2 });
    await hook.settle(Component);
    await delay(550);
    assert.equal(saves.length, 1, 'the earlier autosave is in flight');
    assert.equal(saves[0].args[4], 4, 'the first autosave sends its image revision');

    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 3 });
    await hook.settle(Component);
    const apply = settingsPanel(hook).props.onApplyThis();
    await Promise.resolve();

    assert.equal(processes.length, 0, 'processing must wait until the latest draft is acknowledged');
    saves[0].gate.resolve([{ ...image, workspaceRevision: 5, workspaceSettings: { brightness: 2, removeBackground: false } }]);
    await delay(0);
    assert.equal(saves.length, 2, 'the newest draft is saved after the earlier ACK');
    assert.equal(saves[1].args[4], 5, 'the queued draft uses the first ACK revision');
    saves[1].gate.resolve([{ ...image, workspaceRevision: 6, workspaceSettings: { brightness: 3, removeBackground: false } }]);
    await apply;
    assert.equal(processes.length, 1);
    assert.equal(processes[0][5], 6, 'processing pins the revision acknowledged for this image');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace Apply to all shares current settings while guarding each image revision', async () => {
  const saves = [];
  const processes = [];
  const first = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceRevision: 4, workspaceSettings: { brightness: 1, removeBackground: false } };
  const second = { id: 'image-2', filepath: '2.jpg', contentHash: 'hash-2', workspaceRevision: 9, workspaceSettings: { brightness: 2, removeBackground: false } };
  const api = apiWith(async (...args) => {
    saves.push(args);
    return [{ ...first, workspaceRevision: 5, workspaceSettings: args[3] }, second];
  });
  api.workspace.processImage = async (...args) => {
    processes.push(args);
    const target = args[1] === first.id ? first : second;
    return {
      images: [
        args[1] === first.id ? { ...first, workspaceRevision: 6, workspaceSettings: args[3] } : first,
        args[1] === second.id ? { ...second, workspaceRevision: 10, workspaceSettings: args[3] } : second,
      ],
      processedRelativePath: `processed/${target.id}.jpg`,
    };
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 8 });
    await hook.settle(Component);

    await settingsPanel(hook).props.onApplyAll();

    assert.equal(saves.length, 1, 'the active draft is acknowledged before batch processing');
    assert.deepEqual(processes.map((call) => call[3].brightness), [8, 8]);
    assert.deepEqual(processes.map((call) => call[5]), [5, 9]);
  } finally {
    hook.cleanup();
  }
});

test('workspace refresh preserves the selected image when server order is unchanged', async () => {
  const createWorkspaceSlice = await loadWorkspaceSlice();
  const first = { id: 'first' };
  const second = { id: 'second' };
  const state = { activeProductId: 'product-1' };
  Object.assign(state, createWorkspaceSlice((patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch), () => state));
  Object.assign(state, { workspaceImages: [first, second], workspaceImageIndex: 1 });
  global.window = { api: { images: { listByProduct: async () => [first, second] } } };

  await state.refreshWorkspaceImages('product-1');

  assert.equal(state.workspaceImageIndex, 1, 'a catalog refresh must not switch the editor from the second image to the first');
});

test('ImageWorkspace makes a failed pending save block company-switch navigation', async () => {
  const calls = [];
  const flushers = new Set();
  global.__workspaceRegisterCompanySwitchFlusher = (flush) => {
    flushers.add(flush);
    return () => flushers.delete(flush);
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(apiWith((...args) => {
    calls.push(args);
    return Promise.reject(new Error('draft cannot be saved'));
  }), hook);
  try {
    const image = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 } };
    seed(store, image);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);

    assert.equal(flushers.size, 1, 'the Workspace participates in the shared navigation flush barrier');
    await assert.rejects(Promise.all([...flushers].map((flush) => flush())), /draft cannot be saved/);
    assert.equal(calls.length, 1, 'leaving must attempt the pending Workspace save');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace retries the retained draft when navigation flush follows a failed autosave', async () => {
  const calls = [];
  const flushers = new Set();
  global.__workspaceRegisterCompanySwitchFlusher = (flush) => {
    flushers.add(flush);
    return () => flushers.delete(flush);
  };
  const image = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 3 };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(apiWith((...args) => {
    calls.push(args);
    if (calls.length === 1) return Promise.reject(new Error('temporary save failure'));
    return Promise.resolve([{ ...image, workspaceSettings: args[3], workspaceRevision: 4 }]);
  }), hook);
  try {
    seed(store, image);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    await delay(550);
    await hook.settle(Component);

    assert.equal(calls.length, 1, 'the autosave attempt failed once');
    await Promise.all([...flushers].map((flush) => flush()));
    assert.equal(calls.length, 2, 'navigation retries the retained dirty draft');
    assert.equal(calls[1][3].brightness, 9);
    assert.equal(calls[1][4], 3, 'a transport failure keeps the last acknowledged revision');
  } finally {
    hook.cleanup();
  }
});

test('ImageWorkspace keeps the current image selected when its pending save fails', async () => {
  const hook = hookHarness();
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  const { Component, store } = await loadWorkspace(apiWith(async () => {
    throw new Error('selection save failed');
  }), hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    const strip = findNode(hook.getOutput(), (node) => node.type?.name === 'ImageStrip');

    await strip.props.onSelect(1);

    assert.equal(store.getState().workspaceImageIndex, 0, 'a rejected flush must block the image switch');
    assert.equal(settingsPanel(hook).props.settings.brightness, 9);
  } finally {
    hook.cleanup();
  }
});

async function runConflictChoice(choice) {
  const conflict = new Error('CONFLICT|{"kind":"workspaceImage","id":"image-1","workspaceRevision":11}');
  const calls = [];
  const original = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 10 };
  const fresh = { ...original, workspaceSettings: { brightness: 7 }, workspaceRevision: 11 };
  const api = apiWith((...args) => {
    calls.push(args);
    if (calls.length === 1) return Promise.reject(conflict);
    return Promise.resolve([{ ...original, workspaceSettings: args[3], workspaceRevision: 12 }]);
  });
  api.images.listByProduct = async () => [fresh];
  global.__workspaceConflictChoice = async () => choice;
  const hook = hookHarness();
  const workspace = await loadWorkspace(api, hook);
  seed(workspace.store, original);
  await hook.settle(workspace.Component);
  settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
  await hook.settle(workspace.Component);
  await saveBadge(hook).props.onSave();
  await hook.settle(workspace.Component);
  return { ...workspace, hook, calls };
}

test('ImageWorkspace Cancel keeps the dirty draft after an explicit-save conflict', async () => {
  const result = await runConflictChoice('cancel');
  try {
    assert.equal(settingsPanel(result.hook).props.settings.brightness, 9);
    assert.equal(result.calls.length, 1);
    assert.equal(saveBadge(result.hook).props.status.state, 'error');
  } finally {
    result.hook.cleanup();
  }
});

test('ImageWorkspace Refresh adopts fresh settings and revision after an explicit-save conflict', async () => {
  const result = await runConflictChoice('refresh');
  try {
    assert.equal(settingsPanel(result.hook).props.settings.brightness, 7);
    settingsPanel(result.hook).props.onChange({ ...settingsPanel(result.hook).props.settings, brightness: 8 });
    await result.hook.settle(result.Component);
    await saveBadge(result.hook).props.onSave();
    assert.equal(result.calls[1][4], 11, 'the next save starts from the refreshed revision');
  } finally {
    result.hook.cleanup();
  }
});

test('ImageWorkspace Overwrite deliberately omits revision after an explicit-save conflict', async () => {
  const result = await runConflictChoice('overwrite');
  try {
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0][4], 10, 'the normal save is guarded');
    assert.equal(result.calls[1][4], undefined, 'only the chosen overwrite omits the revision');
    assert.equal(result.calls[1][3].brightness, 9);
  } finally {
    result.hook.cleanup();
  }
});

test('ImageWorkspace exposes explicit conflict recovery after processing the current image conflicts', async () => {
  const conflict = new Error('CONFLICT|{"kind":"workspaceImage","id":"image-1","workspaceRevision":5}');
  const calls = [];
  const original = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1, removeBackground: false }, workspaceRevision: 4 };
  const fresh = { ...original, workspaceSettings: { brightness: 7, removeBackground: false }, workspaceRevision: 5 };
  const api = apiWith(async (...args) => {
    calls.push(args);
    throw conflict;
  });
  api.workspace.processImage = async () => { throw conflict; };
  api.images.listByProduct = async () => [fresh];
  global.__workspaceConflictChoice = async () => 'refresh';
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, original);
    await hook.settle(Component);
    await settingsPanel(hook).props.onApplyThis();
    await hook.settle(Component);
    assert.equal(saveBadge(hook).props.status.state, 'error');

    await saveBadge(hook).props.onSave();
    await hook.settle(Component);

    assert.equal(calls.length, 1, 'Save retries with the acknowledged revision before offering recovery');
    assert.equal(calls[0][4], 4);
    assert.equal(settingsPanel(hook).props.settings.brightness, 7);
  } finally {
    hook.cleanup();
  }
});

test('review follow-up: a process conflict is explained, not shown as a raw sentinel', async () => {
  const conflict = new Error('CONFLICT|{"kind":"workspaceImage","id":"image-1","workspaceRevision":5}');
  const original = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1, removeBackground: false }, workspaceRevision: 4 };
  const api = apiWith(async () => [{ ...original, workspaceRevision: 5 }]);
  api.workspace.processImage = async () => { throw conflict; };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, original);
    await hook.settle(Component);
    await settingsPanel(hook).props.onApplyThis();
    await hook.settle(Component);
    const toasts = store.getState().toasts;
    const last = toasts[toasts.length - 1];
    assert.ok(last, 'a toast explains the process conflict');
    assert.match(last.message, /changed while processing/i);
    assert.doesNotMatch(last.message, /CONFLICT\|/, 'the raw sentinel must not reach the user');
  } finally {
    hook.cleanup();
  }
});

test('review follow-up: a retained failing context on another image does not lock the strip', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  const api = apiWith(async () => { throw new Error('disk is full'); });
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    // Remote removal selects B; A's outgoing save fails and its draft is kept.
    api.images.listByProduct = async () => [second];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    await delay(0);
    // A is restored (reachable) while B stays the active image.
    api.images.listByProduct = async () => [second, first];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    const selected = await findNode(hook.getOutput(), (node) => node.type?.name === 'ImageStrip').props.onSelect(1);
    assert.equal(selected, true, 'another image\u2019s retained failing context must not block the strip');
  } finally {
    hook.cleanup();
  }
});

test('review follow-up: a conflicting save on the image being left says why the strip is blocked', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  const api = apiWith(async () => { throw new Error('CONFLICT|{"kind":"workspaceImage","id":"first","workspaceRevision":3}'); });
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    const selected = await findNode(hook.getOutput(), (node) => node.type?.name === 'ImageStrip').props.onSelect(1);
    assert.equal(selected, false, 'the active image\u2019s conflicting draft still blocks the switch');
    const toasts = store.getState().toasts;
    assert.ok(toasts.some((t) => /changed elsewhere/i.test(t.message)), 'the blocked switch must explain itself');
  } finally {
    hook.cleanup();
  }
});

test('review follow-up: overwrite-crop flushes the pending draft before rewriting the source', async () => {
  const original = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 4 };
  const calls = [];
  const api = apiWith(async (...args) => {
    calls.push(['save', ...args]);
    return [{ ...original, workspaceRevision: 5 }];
  });
  api.images.cropImage = async (...args) => {
    calls.push(['crop', ...args]);
    return { outW: 10, outH: 10 };
  };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, original);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({
      ...settingsPanel(hook).props.settings,
      brightness: 9,
      sourceCropRect: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    await hook.settle(Component);
    global.window.confirm = () => true;
    await readyCrop(hook, Component);
    const canvas = findNode(hook.getOutput(), (node) => typeof node.props?.onApplyCrop === 'function');
    await canvas.props.onApplyCrop('overwrite');
    await hook.settle(Component);
    const saveIndex = calls.findIndex((c) => c[0] === 'save');
    const cropIndex = calls.findIndex((c) => c[0] === 'crop');
    assert.ok(saveIndex >= 0, 'the pending draft must be saved');
    assert.ok(cropIndex >= 0, 'the crop must still run');
    assert.ok(saveIndex < cropIndex, 'the draft save must complete before the source is overwritten');
  } finally {
    hook.cleanup();
  }
});

test('review follow-up: a crop blocked by a conflict explains the conflict', async () => {
  const original = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 4 };
  let cropCalls = 0;
  const api = apiWith(async () => { throw new Error('CONFLICT|{"kind":"workspaceImage","id":"image-1","workspaceRevision":5}'); });
  api.images.cropImage = async () => { cropCalls += 1; return { outW: 1, outH: 1 }; };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, original);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({
      ...settingsPanel(hook).props.settings,
      brightness: 9,
      sourceCropRect: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    await hook.settle(Component);
    global.window.confirm = () => true;
    await readyCrop(hook, Component);
    const canvas = findNode(hook.getOutput(), (node) => typeof node.props?.onApplyCrop === 'function');
    await canvas.props.onApplyCrop('overwrite');
    await hook.settle(Component);
    assert.equal(cropCalls, 0, 'the crop must not run while the pending draft conflicts');
    const messages = store.getState().toasts.map((t) => t.message);
    assert.ok(messages.some((m) => /changed elsewhere/i.test(m)), 'the conflict must be explained');
    assert.ok(!messages.some((m) => /CONFLICT\|/.test(m)), 'the raw sentinel must not reach the user');
  } finally {
    hook.cleanup();
  }
});

test('review follow-up: a failed post-process refresh is not reported as a failed process', async () => {
  const original = { id: 'image-1', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1, removeBackground: false }, workspaceRevision: 4 };
  const api = apiWith(async () => [{ ...original, workspaceRevision: 5 }]);
  api.workspace.processImage = async () => ({
    images: [{ ...original, workspaceRevision: 5 }],
    processedRelativePath: 'processed.jpg',
  });
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, original);
    await hook.settle(Component);
    api.images.listByProduct = async () => { throw new Error('refresh unavailable'); };
    await settingsPanel(hook).props.onApplyThis();
    await hook.settle(Component);
    const messages = store.getState().toasts.map((t) => t.message);
    assert.ok(messages.some((m) => /Processed, but the image list did not refresh/.test(m)),
      'the refresh failure must be reported separately');
    assert.ok(messages.some((m) => /Image processed/.test(m)),
      'the process itself must still be reported as successful');
  } finally {
    hook.cleanup();
  }
});

test('review: a source flip must not leave an unreachable dirty context blocking navigation', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  let rows = [first, second];
  const calls = [];
  const flushers = new Set();
  global.__workspaceRegisterCompanySwitchFlusher = (flush) => { flushers.add(flush); return () => flushers.delete(flush); };
  const api = apiWith(async (...args) => {
    calls.push(args);
    const target = rows.find((row) => row.id === args[1]);
    if (target.contentHash !== args[2]) throw new Error('Image changed; reload and try again');
    rows = rows.map((row) => row.id === args[1] ? { ...row, workspaceSettings: args[3], workspaceRevision: row.workspaceRevision + 1 } : row);
    return rows;
  });
  let brightnessBeforeFlip;
  api.images.flipSource = async () => {
    brightnessBeforeFlip = rows.find((row) => row.id === first.id).workspaceSettings.brightness;
    rows = rows.map((row) => row.id === first.id ? { ...row, contentHash: 'flipped-hash' } : row);
  };
  api.images.listByProduct = async () => rows;
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: rows });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    await findNode(hook.getOutput(), (node) => node.props?.['aria-label'] === 'Flip horizontally').props.onClick();
    await hook.settle(Component);
    await delay(0);
    assert.equal(brightnessBeforeFlip, 9, 'the original dirty draft must be acknowledged before flipping its source');
    // Explicitly saving a NEW valid draft must not leave an inaccessible old
    // hash's failure in the global navigation barrier.
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 8 });
    await hook.settle(Component);
    await saveBadge(hook).props.onSave();
    await hook.settle(Component);
    assert.equal(saveBadge(hook).props.status.state, 'saved');
    const selected = await findNode(hook.getOutput(), (node) => node.type?.name === 'ImageStrip').props.onSelect(1);
    assert.equal(selected, true, 'valid current image is saved, but stale original-hash context blocks the strip');
    await Promise.all([...flushers].map((flush) => flush()));
  } finally { hook.cleanup(); }
});

test('review: selecting an image while save is delayed must follow target ID across reorder', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  const third = { id: 'third', filepath: '3.jpg', contentHash: 'hash-3', workspaceSettings: { brightness: 3 }, workspaceRevision: 5 };
  const gate = deferred();
  const hook = hookHarness();
  const api = apiWith(() => gate.promise);
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second, third] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    const select = findNode(hook.getOutput(), (node) => node.type?.name === 'ImageStrip').props.onSelect(1);
    api.images.listByProduct = async () => [first, third, second];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    gate.resolve([{ ...first, workspaceSettings: { brightness: 9 }, workspaceRevision: 3 }, third, second]);
    await select;
    assert.equal(store.getState().workspaceImages[store.getState().workspaceImageIndex].id, 'second');
  } finally { hook.cleanup(); }
});

test('review: revisiting a dirty context restores its own draft after remote remove and restore', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  const hook = hookHarness();
  const api = apiWith(async () => { throw new Error('Image changed; reload and try again'); });
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    // Remote deletion followed by undo + deletion of the intervening image
    // drives the same component A -> B -> A through actual refresh calls.
    api.images.listByProduct = async () => [second];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    await delay(0);
    assert.equal(settingsPanel(hook).props.settings.brightness, 2);
    api.images.listByProduct = async () => [{ ...first, workspaceRevision: 3 }];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    assert.equal(settingsPanel(hook).props.settings.brightness, 9, 'A must restore its retained draft, not B settings');
  } finally { hook.cleanup(); }
});

test('review follow-up: a restored dirty context retries its draft and surfaces a failed retry as an error', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  const hook = hookHarness();
  const api = apiWith(async () => { throw new Error('Image changed; reload and try again'); });
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    // Remote deletion drives A's pending draft out through a save that fails.
    api.images.listByProduct = async () => [second];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    await delay(0);
    // Restore A: its draft returns and is retried, so 'saving' is truthful while
    // the retry is scheduled.
    api.images.listByProduct = async () => [{ ...first, workspaceRevision: 3 }];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    assert.equal(settingsPanel(hook).props.settings.brightness, 9);
    assert.equal(saveBadge(hook).props.status.state, 'saving');
    // The retry fails (same rejection), and the failure must surface as an
    // error while the draft stays on screen for explicit recovery.
    await delay(600);
    await hook.settle(Component);
    assert.equal(saveBadge(hook).props.status.state, 'error');
    assert.equal(settingsPanel(hook).props.settings.brightness, 9, 'a failed retry must keep the draft');
  } finally { hook.cleanup(); }
});

test('review: delayed process flush must prevent duplicate processing clicks', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1, removeBackground: false }, workspaceRevision: 2 };
  const gate = deferred();
  const processGate = deferred();
  const processes = [];
  const api = apiWith(() => gate.promise);
  api.workspace.processImage = (...args) => { processes.push(args); return processGate.promise; };
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    const apply = settingsPanel(hook).props.onApplyThis();
    await delay(0);
    const pendingProcessing = store.getState().workspaceProcessing;
    // Capture both the store lock and the rendered button state during the barrier.
    await hook.settle(Component);
    const renderedProcessing = settingsPanel(hook).props.processing;
    const applyAgain = settingsPanel(hook).props.onApplyThis();
    gate.resolve([{ ...first, workspaceRevision: 3, workspaceSettings: { brightness: 9, removeBackground: false } }]);
    await delay(0);
    const observations = { pendingProcessing, renderedProcessing, processCount: processes.length, revisions: processes.map((args) => args[5]) };
    processGate.resolve({});
    await Promise.all([apply, applyAgain]);
    assert.equal(pendingProcessing, true, JSON.stringify(observations));
    assert.equal(renderedProcessing, true, 'processing buttons must be disabled while the save ACK is pending');
    assert.equal(processes.length, 1, JSON.stringify(observations));
  } finally { gate.resolve([]); processGate.resolve({}); hook.cleanup(); }
});

test('review: cancelling old conflict after remote image removal does not poison current image status', async () => {
  const first = { id: 'first', filepath: '1.jpg', contentHash: 'hash-1', workspaceSettings: { brightness: 1 }, workspaceRevision: 2 };
  const second = { id: 'second', filepath: '2.jpg', contentHash: 'hash-2', workspaceSettings: { brightness: 2 }, workspaceRevision: 5 };
  const choice = deferred();
  global.__workspaceConflictChoice = () => choice.promise;
  const api = apiWith(async () => { throw new Error('CONFLICT|{"kind":"workspaceImage","id":"first","workspaceRevision":3}'); });
  const hook = hookHarness();
  const { Component, store } = await loadWorkspace(api, hook);
  try {
    seed(store, first);
    store.setState({ workspaceImages: [first, second] });
    await hook.settle(Component);
    settingsPanel(hook).props.onChange({ ...settingsPanel(hook).props.settings, brightness: 9 });
    await hook.settle(Component);
    const saving = saveBadge(hook).props.onSave();
    await delay(0);
    api.images.listByProduct = async () => [second];
    await store.getState().refreshWorkspaceImages('product-1');
    await hook.settle(Component);
    assert.equal(saveBadge(hook).props.status.state, 'idle');
    choice.resolve('cancel');
    await saving;
    await hook.settle(Component);
    assert.equal(saveBadge(hook).props.status.state, 'idle', 'old modal cancellation must leave image B status alone');
  } finally { choice.resolve('cancel'); hook.cleanup(); }
});
