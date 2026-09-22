const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function makeReactHarness(storeState) {
  const hooks = [];
  const effects = [];
  let index = 0;

  function useState(initial) {
    const i = index++;
    if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
  }
  function useRef(initial) {
    const i = index++;
    if (!(i in hooks)) hooks[i] = { current: initial };
    return hooks[i];
  }
  function depsChanged(previous, deps) {
    return !previous || (deps || []).some((dep, i) => !Object.is(dep, previous.deps[i]));
  }
  function useMemo(factory, deps) {
    const i = index++;
    if (depsChanged(hooks[i], deps)) hooks[i] = { deps, value: factory() };
    return hooks[i].value;
  }
  function useCallback(callback, deps) { return useMemo(() => callback, deps); }
  function useEffect(effect, deps) {
    const i = index++;
    if (depsChanged(effects[i], deps)) {
      if (effects[i]?.cleanup) effects[i].cleanup();
      effects[i] = { deps, effect, cleanup: null, pending: true };
    }
  }
  const jsx = (type, props, key) => ({ type, key, props: props || {} });
  const react = { useState, useRef, useMemo, useCallback, useEffect, createElement: jsx };
  const zustand = { create: () => (selector) => selector(storeState) };
  return {
    react,
    zustand,
    jsxRuntime: { jsx, jsxs: jsx, Fragment: 'fragment' },
    render(Component, props) {
      index = 0;
      const output = Component(props);
      for (const entry of effects) {
        if (entry?.pending) {
          entry.pending = false;
          entry.cleanup = entry.effect();
        }
      }
      return output;
    },
    unmount() {
      for (const entry of effects) {
        if (entry?.cleanup) entry.cleanup();
      }
    },
  };
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function findAll(node, predicate, found = []) {
  if (node == null) return found;
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found; }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  for (const [key, value] of Object.entries(node.props || {})) {
    if (key !== 'children') findAll(value, predicate, found);
  }
  return found;
}

async function loadComponent(file, exportName, harness) {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)], bundle: true, write: false, format: 'cjs',
    platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'zustand', 'react-dom/client'], logLevel: 'silent',
  });
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn((id) => id === 'react' ? harness.react : id === 'react/jsx-runtime' ? harness.jsxRuntime : id === 'zustand' ? harness.zustand : id === 'react-dom/client' ? { createRoot: () => ({ render() {}, unmount() {} }) } : req(id), mod, mod.exports);
  return mod.exports[exportName];
}

/**
 * v0.1.64: the label designer added window-level listeners (keyboard shortcuts)
 * and a ResizeObserver (fit-to-view zoom). The harness stands in for a browser,
 * so it has to provide them — this is a stub gap, not a product change.
 */
function fakeWindow(api) {
  const listeners = new Map();
  return {
    api,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
    dispatch: (type, event) => { for (const fn of listeners.get(type) ?? []) fn(event); },
    // Not used by the tests, but the components may poke at them.
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
}
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('CatalogEditor serializes delayed saves and export flushes the latest draft', async () => {
  const saves = [];
  const project = { id: 'project-1', name: 'Original', description: '', updatedAt: 1, config: { fields: [] } };
  const api = {
    catalogStudio: {
      get: async () => ({ ...project }),
      preview: async () => ({ html: '<p>preview</p>' }),
      update: (id, value) => { const gate = deferred(); saves.push({ id, value: { ...value }, gate }); return gate.promise.then(() => ({ ...value, updatedAt: saves.length + 1 })); },
      exportPdf: async () => ({ outputPath: '/tmp/catalog.pdf' }),
    },
    files: { pickFolder: async () => '/tmp/catalog' },
    events: { onCatalogChanged: () => () => {}, onServerHello: () => () => {} },
  };
  global.window = fakeWindow(api);
  global.ResizeObserver = global.ResizeObserver || FakeResizeObserver;
  const storeState = { products: [], addToast() {} };
  const harness = makeReactHarness(storeState);
  const CatalogEditor = await loadComponent('renderer/modules/CatalogStudio/index.jsx', 'CatalogEditor', harness);
  let output = harness.render(CatalogEditor, { projectId: 'project-1', onBack() {} });
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(CatalogEditor, { projectId: 'project-1', onBack() {} });
  const layout = findAll(output, (n) => n.type === 'button' && textOf(n).includes('Layout & design'))[0];
  layout.props.onClick();
  output = harness.render(CatalogEditor, { projectId: 'project-1', onBack() {} });
  const editName = (name, saveNow = true) => {
    const previous = name === 'A' ? 'Original' : name === 'B' ? 'A' : name === 'C' ? 'B' : name === 'D' ? 'C' : 'D';
    const input = findAll(output, (n) => n.type?.name === 'Input' && n.props.value === previous)[0];
    assert.ok(input, `name input for ${name}`);
    input.props.onChange({ target: { value: name } });
    output = harness.render(CatalogEditor, { projectId: 'project-1', onBack() {} });
    if (saveNow) findAll(output, (n) => n.type?.name === 'SaveStatus')[0].props.onSave();
  };
  editName('A');
  assert.deepEqual(saves.map((x) => x.value.name), ['A']);
  editName('B', false);
  assert.deepEqual(saves.map((x) => x.value.name), ['A']);
  saves[0].gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(CatalogEditor, { projectId: 'project-1', onBack() {} });
  assert.ok(findAll(output, (n) => n.type?.name === 'Input' && n.props.value === 'B').length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 570));
  assert.deepEqual(saves.map((x) => x.value.name), ['A', 'B']);
  editName('C');
  saves[1].gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saves.map((x) => x.value.name), ['A', 'B', 'C']);
  saves[2].gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(CatalogEditor, { projectId: 'project-1', onBack() {} });
  assert.ok(findAll(output, (n) => n.type?.name === 'Input' && n.props.value === 'C').length >= 1);

  editName('D');
  const exportButton = findAll(output, (n) => n.type?.name === 'Button' && textOf(n) === 'Export PDF')[0];
  assert.ok(exportButton);
  const exportRequest = exportButton.props.onClick();
  await Promise.resolve();
  assert.equal(saves.at(-1).value.name, 'D');
  saves.at(-1).gate.resolve();
  await exportRequest;
  assert.equal(saves.length, 4, 'export flushes the in-flight latest save once');
  editName('E', false);
  harness.unmount();
  assert.equal(saves.at(-1).value.name, 'E', 'unmount flushes the latest dirty draft');
  saves.at(-1).gate.resolve();
});

test('LabelTemplates refreshes live rows while preserving an edited draft', async () => {
  const makeRow = (id, name) => ({ id, companyId: 'company-1', name, widthMm: 60, heightMm: 40, backgroundColor: '#fff', elements: [], updatedAt: 1 });
  const row1 = makeRow('label-1', 'First label');
  const row2 = makeRow('label-2', 'Second label');
  let rows = [row1];
  let catalogChanged;
  let getCalls = 0;
  let listCalls = 0;
  const api = {
    labels: {
      listTemplates: async () => { listCalls += 1; return rows.map((row) => ({ ...row })); },
      getTemplate: async (id) => { getCalls += 1; return { ...(id === row2.id ? row2 : row1) }; },
      updateTemplate: async (id, value) => ({ ...value, updatedAt: 2 }),
    },
    events: { onCatalogChanged: (callback) => { catalogChanged = callback; return () => { if (catalogChanged === callback) catalogChanged = null; }; }, onServerHello: () => () => {} },
  };
  global.window = fakeWindow(api);
  global.ResizeObserver = global.ResizeObserver || FakeResizeObserver;
  const storeState = { activeCompanyId: 'company-1', products: [], addToast() {} };
  const harness = makeReactHarness(storeState);
  const LabelTemplates = await loadComponent('renderer/modules/LabelStudio/LabelTemplates.jsx', 'LabelTemplates', harness);
  let output;
  harness.render(LabelTemplates, {});
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(LabelTemplates, {});
  assert.equal(listCalls, 1);
  assert.equal(findAll(output, (node) => node.type?.name === 'TemplateCard' && node.props.item.id === row1.id).length, 1);

  rows = [row1, row2];
  catalogChanged({ kind: 'labels', op: 'create', id: row2.id });
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(LabelTemplates, {});
  assert.equal(findAll(output, (node) => node.type?.name === 'TemplateCard' && node.props.item.id === row2.id).length, 1);

  rows = [row2];
  catalogChanged({ kind: 'labels', op: 'delete', id: row1.id });
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(LabelTemplates, {});
  assert.equal(findAll(output, (node) => node.type?.name === 'TemplateCard' && node.props.item.id === row1.id).length, 0);

  const card = findAll(output, (node) => node.type?.name === 'TemplateCard' && node.props.item.id === row2.id)[0];
  assert.ok(card);
  const cardOutput = card.type(card.props);
  findAll(cardOutput, (node) => node.type?.name === 'Button' && textOf(node.props.children) === 'Open')[0].props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(LabelTemplates, {});
  const nameInput = findAll(output, (node) => node.type?.name === 'Input' && node.props.value === row2.name)[0];
  assert.ok(nameInput);
  nameInput.props.onChange({ target: { value: 'Edited draft' } });
  harness.render(LabelTemplates, {});
  rows = [{ ...row2, name: 'Remote replacement' }];
  catalogChanged({ kind: 'labels', op: 'update', id: row2.id });
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(LabelTemplates, {});
  assert.equal(getCalls, 1, 'dirty editor does not refetch the remote row');
  assert.ok(findAll(output, (node) => node.type?.name === 'Input' && node.props.value === 'Edited draft').length >= 1);
  harness.unmount();
});

test('SocialGrid export flushes a newer debounce draft after an earlier save', async () => {
  const preset = { id: 'preset-1', companyId: 'company-1', name: 'Original', updatedAt: 1, config: { canvas: 'square', productIds: [] } };
  let saved = { ...preset };
  const updates = [];
  const exports = [];
  const api = {
    socialGrid: {
      get: async () => ({ ...saved, config: { ...saved.config } }),
      preview: async () => ({ pageIndex: 0, dataUrl: 'data:image/png;base64,AA==' }),
      update: (id, value) => { assert.equal(id, preset.id); const gate = deferred(); updates.push({ value: { ...value }, gate }); return gate.promise.then(() => { saved = { ...preset, ...value, updatedAt: updates.length + 1 }; return { ...saved }; }); },
      exportImages: async (config, folder, id) => { exports.push({ config: { ...config }, folder, id }); return { pageCount: 1, outputPaths: ['/tmp/social.png'] }; },
    },
    files: { pickFolder: async () => '/tmp/social' },
    events: { onCatalogChanged: () => () => {}, onServerHello: () => () => {} },
  };
  global.window = fakeWindow(api);
  global.ResizeObserver = global.ResizeObserver || FakeResizeObserver;
  const storeState = { activeCompanyId: 'company-1', brands: [], categories: [], products: [], addToast() {}, refreshBrands() {}, refreshCategories() {} };
  const harness = makeReactHarness(storeState);
  const PresetEditor = await loadComponent('renderer/modules/SocialGrid/index.jsx', 'PresetEditor', harness);
  let output = harness.render(PresetEditor, { presetId: preset.id, onBack() {} });
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(PresetEditor, { presetId: preset.id, onBack() {} });
  const editName = (name, saveNow = false) => {
    const previous = name === 'A' ? 'Original' : 'A';
    const input = findAll(output, (node) => node.type?.name === 'Input' && node.props.value === previous)[0];
    assert.ok(input, `name input for ${name}`);
    input.props.onChange({ target: { value: name } });
    output = harness.render(PresetEditor, { presetId: preset.id, onBack() {} });
    if (saveNow) findAll(output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
  };
  editName('A', true);
  assert.deepEqual(updates.map((entry) => entry.value.name), ['A']);
  updates[0].gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  output = harness.render(PresetEditor, { presetId: preset.id, onBack() {} });
  editName('B');
  const exportButton = findAll(output, (node) => node.type?.name === 'Button' && textOf(node.props.children) === 'Export images')[0];
  assert.ok(exportButton);
  const exportPromise = exportButton.props.onClick();
  await Promise.resolve();
  assert.deepEqual(updates.map((entry) => entry.value.name), ['A', 'B']);
  updates[1].gate.resolve();
  await exportPromise;
  assert.equal(exports.length, 1);
  assert.equal(exports[0].id, preset.id);
  assert.equal(saved.name, 'B');
  harness.unmount();
});
