const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function makeReactHarness(storeState) {
  const hooks = []; const effects = []; let index = 0;
  const changed = (previous, deps) => !previous || (deps || []).some((dep, i) => !Object.is(dep, previous.deps[i]));
  const useState = (initial) => { const i = index++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; };
  const useRef = (initial) => { const i = index++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; };
  const useMemo = (factory, deps) => { const i = index++; if (changed(hooks[i], deps)) hooks[i] = { deps, value: factory() }; return hooks[i].value; };
  const useEffect = (effect, deps) => { const i = index++; if (changed(effects[i], deps)) { effects[i]?.cleanup?.(); effects[i] = { deps, effect, cleanup: null, pending: true }; } };
  const jsx = (type, props, key) => ({ type, key, props: props || {} });
  return {
    react: { useState, useRef, useMemo, useCallback: (fn, deps) => useMemo(() => fn, deps), useEffect, createElement: jsx },
    zustand: { create: () => (selector) => selector(storeState) }, jsxRuntime: { jsx, jsxs: jsx, Fragment: 'fragment' },
    render(Component, props) { index = 0; const output = Component(props); for (const entry of effects) if (entry?.pending) { entry.pending = false; entry.cleanup = entry.effect(); } return output; },
    unmount() { for (const entry of effects) entry?.cleanup?.(); },
  };
}

function findAll(node, predicate, found = []) {
  if (node == null) return found;
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found; }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  // Expand a `<Field>{({ id }) => <Input id={id} />}</Field>` render prop: the
  // shallow harness never renders Field itself.
  for (const [key, value] of Object.entries(node.props || {})) findAll(key === 'children' && typeof value === 'function' ? value({ id: 'field' }) : value, predicate, found);
  return found;
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function loadEditors(harness, includeCompanies = false) {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const source = `
    import { CatalogEditor } from './renderer/modules/CatalogStudio/index.jsx';
    import { PresetEditor } from './renderer/modules/SocialGrid/index.jsx';
    import { ConflictModalHost } from './renderer/components/ConflictModal.jsx';
    export { CatalogEditor, PresetEditor };
    export function CatalogEditorWithConflict(props) { return [ConflictModalHost(), CatalogEditor(props)]; }
    export function PresetEditorWithConflict(props) { return [ConflictModalHost(), PresetEditor(props)]; }
    ${includeCompanies ? "export { createCompaniesSlice } from './renderer/store/companies.js';" : ''}
  `;
  const out = await esbuild.build({ stdin: { contents: source, resolveDir: ROOT }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'zustand', 'react-dom/client'], logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => {
    if (id === 'react') return harness.react;
    if (id === 'react/jsx-runtime') return harness.jsxRuntime;
    if (id === 'zustand') return harness.zustand;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    return req(id);
  }, mod, mod.exports);
  return mod.exports;
}

function makeRow(kind, name = 'Original') {
  return kind === 'catalog'
    ? { id: 'draft-1', companyId: 'company-1', name, description: '', updatedAt: 1, config: { fields: [] } }
    : { id: 'draft-1', companyId: 'company-1', name, updatedAt: 1, config: { width: 1080, height: 1080, columns: 2, rows: 2, productIds: [] } };
}

function makeApi(kind, server, updates, listeners = {}) {
  const domain = {
    get: async () => {
      const snapshot = structuredClone(server.row);
      const gate = server.nextGetGate;
      server.nextGetGate = null;
      if (gate) await gate.promise;
      return structuredClone(gate?.row || snapshot);
    },
    preview: async () => kind === 'catalog' ? { html: '<p>preview</p>' } : { pageIndex: 0, dataUrl: 'data:image/png;base64,AA==', summary: { total: 1, pages: 1, perPage: 1 } },
    update: (id, patch) => {
      const gate = deferred();
      updates.push({ id, patch: structuredClone(patch), gate });
      return gate.promise.then(() => {
        if (server.activeCompany && server.activeCompany() !== server.row.companyId) throw new Error('Draft belongs to a different company');
        if (server.enforceRevision && Object.hasOwn(patch, 'expectedUpdatedAt') && Number(patch.expectedUpdatedAt) !== Number(server.row.updatedAt)) {
          throw new Error(`CONFLICT|${JSON.stringify({ kind: kind === 'catalog' ? 'catalogProject' : 'socialGridPreset', id, name: server.row.name, updatedAt: server.row.updatedAt })}`);
        }
        const { expectedUpdatedAt, ...editable } = patch;
        server.row = { ...server.row, ...editable, config: { ...server.row.config, ...(editable.config || {}) }, updatedAt: server.row.updatedAt + 1 };
        return structuredClone(server.row);
      });
    },
  };
  if (kind === 'catalog') {
    domain.exportPdf = async () => {
      server.row = { ...server.row, lastExportedAt: 100, updatedAt: server.row.updatedAt + 1 };
      return { outputPath: '/tmp/output/catalog.pdf' };
    };
  } else {
    domain.exportImages = async () => {
      server.row = { ...server.row, lastExportedAt: 100, updatedAt: server.row.updatedAt + 1 };
      return { pageCount: 1, outputPaths: ['/tmp/output/social.png'] };
    };
  }
  return {
    [kind === 'catalog' ? 'catalogStudio' : 'socialGrid']: domain,
    files: { pickFolder: async () => '/tmp/output' },
    events: {
      onCatalogChanged(callback) { listeners.catalogChanged = callback; return () => { if (listeners.catalogChanged === callback) listeners.catalogChanged = null; }; },
      onServerHello: () => () => {},
    },
  };
}

async function openEditor(kind, Component, harness, id = 'draft-1', onBack = () => {}) {
  let output = harness.render(Component, { [kind === 'catalog' ? 'projectId' : 'presetId']: id, onBack });
  await tick();
  output = harness.render(Component, { [kind === 'catalog' ? 'projectId' : 'presetId']: id, onBack });
  if (kind === 'catalog') {
    findAll(output, (node) => node.type === 'button' && textOf(node).includes('Layout & design'))[0].props.onClick();
    output = harness.render(Component, { projectId: id, onBack });
  }
  return { get output() { return output; }, render() { output = harness.render(Component, { [kind === 'catalog' ? 'projectId' : 'presetId']: id, onBack }); return output; } };
}

function editName(session, from, to, save = false) {
  const input = findAll(session.output, (node) => node.type?.name === 'Input' && node.props.value === from)[0];
  assert.ok(input, `name input with ${from}`);
  input.props.onChange({ target: { value: to } });
  session.render();
  if (save) findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
}

function storeState() {
  return { activeCompanyId: 'company-1', products: [], brands: [], categories: [], addToast() {}, refreshBrands: async () => {}, refreshCategories: async () => {} };
}

for (const [kind, exported] of [['catalog', 'CatalogEditor'], ['social', 'PresetEditor']]) {
  test(`${kind} editor keeps an immediate reopened draft ahead of an older unmounted save`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const firstHarness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(firstHarness);
    const first = await openEditor(kind, Editor, firstHarness);
    editName(first, 'Original', 'Old draft', true);
    assert.equal(updates.length, 1);
    firstHarness.unmount();

    const reopenedHarness = makeReactHarness(storeState());
    const { [exported]: ReopenedEditor } = await loadEditors(reopenedHarness);
    const reopened = await openEditor(kind, ReopenedEditor, reopenedHarness);
    editName(reopened, 'Original', 'New draft', true);
    assert.equal(updates.length, 2);
    updates[1].gate.resolve(); await tick();
    updates[0].gate.resolve(); await tick();

    assert.equal(server.row.name, 'New draft', 'a reopened draft must outlive an older unmounted queue');
    reopenedHarness.unmount();
  });

  test(`${kind} editor keeps a newer local draft queued behind an in-flight save`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const harness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(harness);
    const session = await openEditor(kind, Editor, harness);
    editName(session, 'Original', 'First', true);
    editName(session, 'First', 'Second', true);
    assert.equal(updates.length, 1, 'the real queue has one in-flight save');
    updates[0].gate.resolve(); await tick();
    assert.equal(updates.length, 2);
    updates[1].gate.resolve(); await tick();
    assert.equal(server.row.name, 'Second');
    harness.unmount();
  });
}

test('company switching flushes a newer catalog draft typed while an earlier save is in flight', async () => {
  const server = { row: makeRow('catalog'), enforceRevision: true }; const updates = [];
  let backendCompany = 'company-1';
  global.window = { api: { ...makeApi('catalog', server, updates), companies: {
    async setActive(id) { assert.equal(backendCompany, 'company-1'); backendCompany = id; },
    async getActiveId() { return backendCompany; },
  } } };
  const state = { ...storeState(), applyActiveCompanyContext(id) { state.activeCompanyId = id; }, refreshProducts: async () => {}, refreshDashboard: async () => {}, refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {} };
  const harness = makeReactHarness(state);
  const { CatalogEditor, createCompaniesSlice } = await loadEditors(harness, true);
  Object.assign(state, createCompaniesSlice((patch) => Object.assign(state, patch), () => state));
  const session = await openEditor('catalog', CatalogEditor, harness);
  editName(session, 'Original', 'First', true);
  const switchPromise = state.setActiveCompany('company-2');
  await tick();
  editName(session, 'First', 'Second');
  updates[0].gate.resolve();
  await tick();
  assert.equal(updates.length, 2, 'the flush must observe and save text typed while it was waiting');
  updates[1].gate.resolve();
  await switchPromise;
  assert.equal(backendCompany, 'company-2');
  assert.equal(server.row.name, 'Second');
  harness.unmount();
  updates.at(-1)?.gate.resolve();
});

for (const [kind, exported, eventKind] of [['catalog', 'CatalogEditor', 'catalogStudio'], ['social', 'PresetEditor', 'socialGrid']]) {
  test(`${kind} preserves a remote replacement when the dirty draft has an older revision`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = []; const listeners = {};
    global.window = { api: makeApi(kind, server, updates, listeners) };
    const harness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(harness);
    const session = await openEditor(kind, Editor, harness);
    editName(session, 'Original', 'Local draft');
    server.row = { ...server.row, name: 'Remote draft', updatedAt: 2 };
    listeners.catalogChanged({ kind: eventKind, id: server.row.id, op: 'update' });
    await tick();
    assert.ok(findAll(session.output, (node) => node.type?.name === 'Input' && node.props.value === 'Local draft').length, 'the local draft remains available for a conflict decision');
    findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
    updates[0].gate.resolve(); await tick();
    assert.equal(server.row.name, 'Remote draft', 'a stale save must carry an expected revision and not erase the remote row');
    harness.unmount();
  });
}

for (const [kind, exported] of [['catalog', 'CatalogEditor'], ['social', 'PresetEditor']]) {
  test(`${kind} Back waits for the latest dirty draft before leaving the editor`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const harness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(harness);
    let backs = 0;
    const session = await openEditor(kind, Editor, harness, 'draft-1', () => { backs += 1; });
    editName(session, 'Original', 'Saved before Back');
    // Both editors go back through the house header (`PageHeader backTo`,
    // docs/UI_GUIDE.md) instead of a "← …" ghost Button in the page body.
    const header = findAll(session.output, (node) => node.type?.name === 'PageHeader' && node.props.backTo)[0];
    const leaving = header.props.backTo.onClick();
    assert.equal(backs, 0);
    assert.equal(updates.length, 1);
    updates[0].gate.resolve();
    await leaving;
    assert.equal(backs, 1);
    assert.equal(server.row.name, 'Saved before Back');
    harness.unmount();
  });
}

test('company switch makes the old-company editor inert while backend acknowledgement is pending', async () => {
  let backendCompany = 'company-1';
  const server = { row: makeRow('catalog'), enforceRevision: true, activeCompany: () => backendCompany }; const updates = [];
  const switchGate = deferred();
  global.window = { api: { ...makeApi('catalog', server, updates), companies: {
    async setActive(id) { backendCompany = id; await switchGate.promise; },
    async getActiveId() { return backendCompany; },
  } } };
  const state = { ...storeState(), applyActiveCompanyContext(id) { state.activeCompanyId = id; }, refreshProducts: async () => {}, refreshDashboard: async () => {}, refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {} };
  const harness = makeReactHarness(state);
  const { CatalogEditor, createCompaniesSlice } = await loadEditors(harness, true);
  Object.assign(state, createCompaniesSlice((patch) => Object.assign(state, patch), () => state));
  const session = await openEditor('catalog', CatalogEditor, harness);
  editName(session, 'Original', 'First', true);
  const switching = state.setActiveCompany('company-2');
  updates[0].gate.resolve();
  await tick();
  assert.equal(backendCompany, 'company-2');
  session.render();
  editName(session, 'First', 'Typed during switch');
  assert.ok(findAll(session.output, (node) => node.type?.name === 'Input' && node.props.value === 'First').length);
  switchGate.resolve();
  await switching;
  harness.unmount();
  await tick();
  assert.equal(updates.length, 1);
  assert.equal(server.row.name, 'First');
});

for (const [kind, exported] of [['catalog', 'CatalogEditor'], ['social', 'PresetEditor']]) {
  test(`${kind} own export metadata advances the token without replacing typing during refresh`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const harness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(harness);
    const session = await openEditor(kind, Editor, harness);
    try {
      const getGate = deferred();
      server.nextGetGate = getGate;
      const exportButton = findAll(session.output, (node) => node.type?.name === 'Button' && textOf(node) === (kind === 'catalog' ? 'Export PDF' : 'Export images'))[0];
      const exporting = exportButton.props.onClick();
      await tick();
      editName(session, 'Original', 'Typed during export');
      getGate.resolve();
      await exporting;
      session.render();
      assert.ok(findAll(session.output, (node) => node.type?.name === 'Input' && node.props.value === 'Typed during export').length);
      assert.equal(findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.state, 'dirty');
      const saving = findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
      assert.equal(updates[0].patch.expectedUpdatedAt, 2);
      updates[0].gate.resolve();
      assert.equal(await saving, true);
      session.render();
      assert.equal(server.row.name, 'Typed during export');
      assert.equal(server.row.lastExportedAt, 100);
      assert.ok(findAll(session.output, (node) => node.type?.name === 'Input' && node.props.value === 'Typed during export').length);
      assert.equal(findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.state, 'saved');
    } finally {
      harness.unmount();
      await tick();
      for (const update of updates) update.gate.resolve();
      await tick();
    }
  });

  test(`${kind} export does not adopt metadata revision over a competing remote edit`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const harness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(harness);
    const session = await openEditor(kind, Editor, harness);
    try {
      const getGate = deferred();
      server.nextGetGate = getGate;
      const exportButton = findAll(session.output, (node) => node.type?.name === 'Button' && textOf(node) === (kind === 'catalog' ? 'Export PDF' : 'Export images'))[0];
      const exporting = exportButton.props.onClick();
      await tick();
      editName(session, 'Original', 'Local during export');
      server.row = { ...server.row, name: 'Remote during export', updatedAt: server.row.updatedAt + 1 };
      getGate.row = structuredClone(server.row);
      getGate.resolve();
      await exporting;
      session.render();
      assert.equal(findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.state, 'dirty');
      const saving = findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
      assert.equal(updates[0].patch.expectedUpdatedAt, 1);
      updates[0].gate.resolve();
      assert.equal(await saving, false);
      session.render();
      assert.equal(server.row.name, 'Remote during export');
      assert.ok(findAll(session.output, (node) => node.type?.name === 'Input' && node.props.value === 'Local during export').length);
      assert.equal(findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.state, 'dirty');
    } finally {
      harness.unmount();
      await tick();
      for (const update of updates) update.gate.resolve();
      await tick();
    }
  });

  test(`${kind} stale export refresh cannot roll back a newer acknowledged overwrite`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const harness = makeReactHarness(storeState());
    const wrapped = `${exported}WithConflict`;
    const { [wrapped]: Editor } = await loadEditors(harness);
    const session = await openEditor(kind, Editor, harness);
    try {
      const getGate = deferred();
      server.nextGetGate = getGate;
      const exportButton = findAll(session.output, (node) => node.type?.name === 'Button' && textOf(node) === (kind === 'catalog' ? 'Export PDF' : 'Export images'))[0];
      const exporting = exportButton.props.onClick();
      await tick();
      editName(session, 'Original', 'Local overwrite');
      const firstSave = findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
      assert.equal(updates[0].patch.expectedUpdatedAt, 1);
      updates[0].gate.resolve();
      await tick();
      session.render();
      findAll(session.output, (node) => node.type?.name === 'Button' && textOf(node) === 'Overwrite')[0].props.onClick();
      await tick();
      assert.equal(Object.hasOwn(updates[1].patch, 'expectedUpdatedAt'), false);
      updates[1].gate.resolve();
      assert.equal(await firstSave, true);
      session.render();
      editName(session, 'Local overwrite', 'After stale refresh');
      getGate.resolve();
      await exporting;
      session.render();
      const finalSave = findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
      assert.equal(updates[2].patch.expectedUpdatedAt, 3);
      updates[2].gate.resolve();
      assert.equal(await finalSave, true);
      session.render();
      assert.equal(server.row.name, 'After stale refresh');
      assert.equal(findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.state, 'saved');
    } finally {
      harness.unmount();
      await tick();
      for (const update of updates) update.gate.resolve();
      await tick();
    }
  });

  test(`${kind} clean export row advances the token used by the next edit`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const harness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(harness);
    const session = await openEditor(kind, Editor, harness);
    const exportButton = findAll(session.output, (node) => node.type?.name === 'Button' && textOf(node) === (kind === 'catalog' ? 'Export PDF' : 'Export images'))[0];
    await exportButton.props.onClick();
    session.render();
    editName(session, 'Original', 'After export', true);
    assert.equal(updates[0].patch.expectedUpdatedAt, 2);
    updates[0].gate.resolve();
    await tick();
    assert.equal(server.row.name, 'After export');
    harness.unmount();
  });
}

for (const [kind, exported, choice] of [
  ['catalog', 'CatalogEditorWithConflict', 'Refresh'],
  ['social', 'PresetEditorWithConflict', 'Overwrite'],
  ['catalog', 'CatalogEditorWithConflict', 'Cancel'],
]) {
  test(`${kind} deliberate Save conflict supports ${choice}`, async () => {
    const server = { row: makeRow(kind), enforceRevision: true }; const updates = [];
    global.window = { api: makeApi(kind, server, updates) };
    const harness = makeReactHarness(storeState());
    const { [exported]: Editor } = await loadEditors(harness);
    const session = await openEditor(kind, Editor, harness);
    editName(session, 'Original', 'Local draft');
    server.row = { ...server.row, name: 'Remote draft', updatedAt: 2 };
    const saving = findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
    updates[0].gate.resolve();
    await tick();
    session.render();
    findAll(session.output, (node) => node.type?.name === 'Button' && textOf(node) === choice)[0].props.onClick();
    if (choice === 'Overwrite') {
      await tick();
      assert.equal(Object.hasOwn(updates[1].patch, 'expectedUpdatedAt'), false);
      updates[1].gate.resolve();
    }
    assert.equal(await saving, choice !== 'Cancel');
    session.render();
    const expected = choice === 'Refresh' ? 'Remote draft' : 'Local draft';
    assert.ok(findAll(session.output, (node) => node.type?.name === 'Input' && node.props.value === expected).length);
    assert.equal(server.row.name, choice === 'Overwrite' ? 'Local draft' : 'Remote draft');
    harness.unmount();
  });
}

test('catalog ignores a conflict Refresh result after its editor unmounts', async () => {
  const server = { row: makeRow('catalog'), enforceRevision: true }; const updates = [];
  global.window = { api: makeApi('catalog', server, updates) };
  const harness = makeReactHarness(storeState());
  const { CatalogEditorWithConflict } = await loadEditors(harness);
  const session = await openEditor('catalog', CatalogEditorWithConflict, harness);
  editName(session, 'Original', 'Local draft');
  server.row = { ...server.row, name: 'Remote draft', updatedAt: 2 };
  const saving = findAll(session.output, (node) => node.type?.name === 'SaveStatus')[0].props.onSave();
  updates[0].gate.resolve();
  await tick();
  session.render();
  const refreshGate = deferred();
  server.nextGetGate = refreshGate;
  findAll(session.output, (node) => node.type?.name === 'Button' && textOf(node) === 'Refresh')[0].props.onClick();
  await tick();
  harness.unmount();
  refreshGate.resolve();
  assert.equal(await saving, false);
  await tick();
  for (const update of updates.slice(1)) update.gate.resolve();
  await tick();
  assert.equal(server.row.name, 'Remote draft');
});
