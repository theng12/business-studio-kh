const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function makeHarness() {
  let cursor = 0;
  let dirty = false;
  let output = null;
  const hooks = [];
  const pendingEffects = [];
  const depsChanged = (previous, next) => !previous || !next || previous.length !== next.length
    || next.some((value, index) => !Object.is(value, previous[index]));
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
    for (let i = 0; i < 12; i += 1) {
      render(Component);
      if (!dirty) return output;
      await Promise.resolve();
    }
    assert.fail('component did not settle');
  }

  function cleanup() {
    for (const hook of hooks) {
      if (typeof hook?.cleanup === 'function') hook.cleanup();
    }
  }

  return { React, jsxRuntime: { Fragment: Symbol('Fragment'), jsx, jsxs: jsx }, settle, cleanup, getOutput: () => output };
}

function findAll(node, predicate, found = []) {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found; }
  if (predicate(node)) found.push(node);
  for (const value of Object.values(node.props || {})) findAll(value, predicate, found);
  return found;
}

function installBrowser(api) {
  const noop = () => {};
  global.window = { api, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) };
  global.document = { body: { classList: { add: noop, remove: noop } }, documentElement: { setAttribute: noop } };
  global.navigator = global.navigator || { userAgent: 'node', platform: 'darwin' };
}

async function loadLabelTemplates(api, harness) {
  installBrowser(api);
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  let store;
  const zustand = {
    create(factory) {
      let state;
      const set = (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        if (patch) state = { ...state, ...patch };
      };
      state = factory(set, () => state);
      store = (selector = (value) => value) => selector(state);
      store.setState = set;
      return store;
    },
  };
  const out = await esbuild.build({
    stdin: {
      contents: "export { LabelTemplates } from './renderer/modules/LabelStudio/LabelTemplates.jsx'; export { flushCompanySwitches } from './renderer/lib/companySwitch.js';",
      resolveDir: ROOT,
      sourcefile: 'label-editor-lifetime-entry.jsx',
      loader: 'jsx',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand'], logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => {
    if (id === 'react') return harness.React;
    if (id === 'react/jsx-runtime') return harness.jsxRuntime;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    if (id === 'zustand') return zustand;
    return req(id);
  }, mod, mod.exports);
  return { ...mod.exports, store };
}

function row(id, companyId, name) {
  return { id, companyId, name, widthMm: 60, heightMm: 40, backgroundColor: '#fff', elements: [], updatedAt: 1 };
}

function input(output, value) {
  const node = findAll(output, (item) => item.type?.name === 'Input' && item.props.value === value)[0];
  assert.ok(node, `expected input with ${value}`);
  return node;
}

function save(output) {
  const node = findAll(output, (item) => item.type?.name === 'SaveStatus')[0];
  assert.ok(node, 'expected save status');
  node.props.onSave();
}

async function open(harness, Component, id) {
  const card = findAll(harness.getOutput(), (item) => item.type?.name === 'TemplateCard' && item.props.item.id === id)[0];
  assert.ok(card, `expected template card ${id}`);
  card.props.onOpen();
  await tick();
  await harness.settle(Component);
}

async function mount(api, companyId = 'company-a') {
  const harness = makeHarness();
  const loaded = await loadLabelTemplates(api, harness);
  loaded.store.setState({ activeCompanyId: companyId, products: [], addToast() {} });
  await harness.settle(loaded.LabelTemplates);
  await tick();
  await harness.settle(loaded.LabelTemplates);
  return { harness, ...loaded };
}

function server(rows) {
  const records = new Map(rows.map((item) => [item.id, { ...item }]));
  const calls = [];
  let catalogChanged;
  const api = {
    labels: {
      listTemplates: async (companyId) => [...records.values()].filter((item) => item.companyId === companyId).map((item) => ({ ...item })),
      getTemplate: async (id) => ({ ...records.get(id) }),
      updateTemplate(id, value) {
        const gate = deferred();
        calls.push({ id, value: { ...value }, gate });
        return gate.promise.then(() => {
          const current = records.get(id);
          if (Object.hasOwn(value, 'expectedUpdatedAt') && Number(value.expectedUpdatedAt) !== Number(current.updatedAt)) {
            throw new Error(`CONFLICT|${JSON.stringify({ kind: 'labelTemplate', id, name: current.name, updatedAt: current.updatedAt })}`);
          }
          const { expectedUpdatedAt, ...editable } = value;
          const saved = { ...current, ...editable, updatedAt: current.updatedAt + 1 };
          records.set(id, saved);
          return { ...saved };
        });
      },
    },
    events: {
      onCatalogChanged(callback) { catalogChanged = callback; return () => { if (catalogChanged === callback) catalogChanged = null; }; },
      onServerHello: () => () => {},
    },
  };
  return { api, records, calls, emit(event) { catalogChanged?.(event); } };
}

test('LabelTemplates prevents an unmounted old instance from overwriting a freshly reopened template', async () => {
  const fixture = server([row('label-a', 'company-a', 'Original')]);
  const oldEditor = await mount(fixture.api);
  await open(oldEditor.harness, oldEditor.LabelTemplates, 'label-a');
  input(oldEditor.harness.getOutput(), 'Original').props.onChange({ target: { value: 'Old draft' } });
  await oldEditor.harness.settle(oldEditor.LabelTemplates);
  oldEditor.harness.cleanup();
  assert.equal(fixture.calls.length, 1);

  const freshEditor = await mount(fixture.api);
  try {
    await open(freshEditor.harness, freshEditor.LabelTemplates, 'label-a');
    input(freshEditor.harness.getOutput(), 'Original').props.onChange({ target: { value: 'Fresh draft' } });
    await freshEditor.harness.settle(freshEditor.LabelTemplates);
    save(freshEditor.harness.getOutput());
    assert.equal(fixture.calls.length, 2);

    fixture.calls[1].gate.resolve();
    await tick(); await freshEditor.harness.settle(freshEditor.LabelTemplates);
    fixture.calls[0].gate.resolve();
    await tick(); await freshEditor.harness.settle(freshEditor.LabelTemplates);

    assert.equal(fixture.records.get('label-a').name, 'Fresh draft', 'the later reopened edit must remain the persisted template');
  } finally { freshEditor.harness.cleanup(); }
});

test('LabelTemplates ignores an old-company save acknowledgement after opening a new-company template', async () => {
  const fixture = server([row('label-a', 'company-a', 'A'), row('label-b', 'company-a', 'B')]);
  fixture.records.set('label-b', row('label-b', 'company-b', 'B'));
  const { harness, LabelTemplates, store } = await mount(fixture.api);
  try {
    await open(harness, LabelTemplates, 'label-a');
    input(harness.getOutput(), 'A').props.onChange({ target: { value: 'Saved A' } });
    await harness.settle(LabelTemplates);
    save(harness.getOutput());

    store.setState({ activeCompanyId: 'company-b' });
    await harness.settle(LabelTemplates); await tick(); await harness.settle(LabelTemplates);
    await open(harness, LabelTemplates, 'label-b');
    fixture.calls[0].gate.resolve();
    await tick(); await harness.settle(LabelTemplates);
    assert.equal(input(harness.getOutput(), 'B').props.value, 'B');
    input(harness.getOutput(), 'B').props.onChange({ target: { value: 'Saved B' } });
    await harness.settle(LabelTemplates);
    save(harness.getOutput());
    assert.equal(fixture.calls[1].value.expectedUpdatedAt, 1);
    fixture.calls[1].gate.resolve();
    await tick(); await harness.settle(LabelTemplates);
    assert.equal(fixture.records.get('label-b').name, 'Saved B');
  } finally { harness.cleanup(); }
});

test('LabelTemplates serializes typing during an in-flight save', async () => {
  const fixture = server([row('label-a', 'company-a', 'Original')]);
  const { harness, LabelTemplates } = await mount(fixture.api);
  try {
    await open(harness, LabelTemplates, 'label-a');
    input(harness.getOutput(), 'Original').props.onChange({ target: { value: 'A' } });
    await harness.settle(LabelTemplates);
    save(harness.getOutput());
    input(harness.getOutput(), 'A').props.onChange({ target: { value: 'B' } });
    await harness.settle(LabelTemplates);
    save(harness.getOutput());
    assert.equal(fixture.calls.length, 1, 'B waits behind the in-flight A save');

    fixture.calls[0].gate.resolve();
    await tick();
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[1].value.name, 'B');
    fixture.calls[1].gate.resolve();
    await tick(); await harness.settle(LabelTemplates);
    assert.equal(fixture.records.get('label-a').name, 'B');
    assert.equal(input(harness.getOutput(), 'B').props.value, 'B');
  } finally { harness.cleanup(); }
});

test('LabelTemplates ignores a remote template update while its local draft is dirty', async () => {
  const fixture = server([row('label-a', 'company-a', 'Original')]);
  const { harness, LabelTemplates } = await mount(fixture.api);
  try {
    await open(harness, LabelTemplates, 'label-a');
    input(harness.getOutput(), 'Original').props.onChange({ target: { value: 'Local draft' } });
    await harness.settle(LabelTemplates);
    fixture.records.set('label-a', row('label-a', 'company-a', 'Remote replacement'));
    fixture.emit({ kind: 'labels', id: 'label-a', op: 'update' });
    await tick(); await harness.settle(LabelTemplates);
    assert.equal(input(harness.getOutput(), 'Local draft').props.value, 'Local draft');
  } finally { harness.cleanup(); }
});

test('LabelTemplates company flush includes typing that occurs during its in-flight save', async () => {
  const fixture = server([row('label-a', 'company-a', 'Original'), row('label-b', 'company-b', 'Other company')]);
  const { harness, LabelTemplates, flushCompanySwitches } = await mount(fixture.api);
  try {
    await open(harness, LabelTemplates, 'label-a');
    input(harness.getOutput(), 'Original').props.onChange({ target: { value: 'A' } });
    await harness.settle(LabelTemplates);
    save(harness.getOutput());
    const flush = flushCompanySwitches();
    let settled = false;
    flush.then(() => { settled = true; });

    input(harness.getOutput(), 'A').props.onChange({ target: { value: 'B' } });
    await harness.settle(LabelTemplates);
    fixture.calls[0].gate.resolve();
    await tick(); await Promise.resolve();

    assert.equal(settled, false, 'company navigation must not continue while B is still only a dirty draft');
  } finally { harness.cleanup(); }
});

test('LabelTemplates Back waits for a successful latest-draft flush', async () => {
  const fixture = server([row('label-a', 'company-a', 'Original')]);
  const { harness, LabelTemplates } = await mount(fixture.api);
  try {
    await open(harness, LabelTemplates, 'label-a');
    input(harness.getOutput(), 'Original').props.onChange({ target: { value: 'Saved before Back' } });
    await harness.settle(LabelTemplates);
    // UI pass, 2026-10: Back is the PageHeader's `backTo` (docs/UI_GUIDE.md),
    // no longer a "Back to templates" button among the actions.
    const header = findAll(harness.getOutput(), (item) => item.type?.name === 'PageHeader')[0];
    assert.ok(header?.props.backTo?.onClick, 'expected the header back link');
    const leaving = header.props.backTo.onClick();
    await harness.settle(LabelTemplates);
    assert.ok(input(harness.getOutput(), 'Saved before Back'));
    assert.equal(fixture.calls.length, 1);
    fixture.calls[0].gate.resolve();
    await leaving;
    await tick(); await harness.settle(LabelTemplates);
    assert.equal(fixture.records.get('label-a').name, 'Saved before Back');
    assert.equal(findAll(harness.getOutput(), (item) => item.type?.name === 'TemplateCard').length, 1);
  } finally { harness.cleanup(); }
});
