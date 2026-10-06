const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const ROOT = path.join(__dirname, '..');
const deferred = () => { let resolve; const promise = new Promise((ok) => { resolve = ok; }); return { promise, resolve }; };

// Exercise the real component handlers with React's hook contract. Browser
// rendering is checked by the release crawl; no DOM package is needed here.
function hooks() {
  let cursor; let output;
  const values = []; const effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  const React = {
    useState(initial) { const i = cursor++; values[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [values[i].value, (next) => { values[i].value = typeof next === 'function' ? next(values[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; values[i] ||= { current: initial }; return values[i]; },
    useMemo(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) values[i] = { value: fn(), deps }; return values[i].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) effects.push(() => { values[i]?.cleanup?.(); values[i] = { deps, cleanup: fn() }; }); },
  };
  const runtime = { Fragment: 'Fragment', jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  return { React, runtime, render(Component, props) { cursor = 0; output = Component(props); for (const effect of effects.splice(0)) effect(); return output; }, get output() { return output; }, cleanup() { for (const value of values) value?.cleanup?.(); } };
}
function find(root, predicate) {
  if (!root || typeof root !== 'object') return null;
  if (predicate(root)) return root;
  for (const value of Object.values(root)) { const result = Array.isArray(value) ? value.map((v) => find(v, predicate)).find(Boolean) : find(value, predicate); if (result) return result; }
  return null;
}
function component(root, name) { return find(root, (n) => n.type?.name === name); }
function control(root, label) {
  const field = find(root, (n) => n.type?.name === 'Field' && n.props.label === label);
  assert.ok(field, `Missing field: ${label}`);
  return field.props.children({ id: label }).props;
}
function button(root, label) { return find(root, (n) => n.type?.name === 'Button' && n.props.children === label).props; }
async function load(name, hook, environment) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, `renderer/modules/CatalogStudio/${name}.jsx`)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
    plugins: [{ name: 'editor-environment', setup(build) {
      build.onResolve({ filter: /store\/index\.js$/ }, () => ({ path: 'store', namespace: 'test' }));
      build.onResolve({ filter: /components\/(ui|PageHeader|SaveStatus|ConfirmModal)\.jsx$/ }, (args) => ({ path: path.basename(args.path, '.jsx'), namespace: 'test' }));
      build.onResolve({ filter: /CatalogPreview\.jsx$/ }, () => ({ path: 'preview', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: name }) => ({ contents: name === 'store' ? 'export const useAppStore = (select) => select(globalThis.__catalogEnvironment.store);' : name === 'ConfirmModal' ? 'export const confirm = (options) => globalThis.__catalogEnvironment.confirm(options);' : name === 'preview' ? 'export function CatalogPreview() {}' : 'export function Button() {} export function Input() {} export function Textarea() {} export function Select() {} export function Field() {} export function Modal() {} export function PageHeader() {} export function SaveStatus() {} export function EmptyState() {} export function Pagination() {} export function paginate(total) { return { pageStart: 0, pageEnd: total, currentPage: 0, maxPage: 0 }; }', loader: 'js' }));
      // Use the actual conflict resolver, replacing only the interactive choice.
      build.onLoad({ filter: /ConflictModal\.jsx$/ }, (args) => ({ contents: fs.readFileSync(args.path, 'utf8').replace('choose = showConflict', 'choose = globalThis.__catalogEnvironment.choose'), loader: 'jsx' }));
      build.onResolve({ filter: /companySwitch\.js$/ }, () => ({ path: 'switch', namespace: 'guard' }));
      build.onLoad({ filter: /.*/, namespace: 'guard' }, () => ({ contents: 'export const registerCompanySwitchFlusher = (fn) => { globalThis.__catalogEnvironment.guard = fn; return () => { globalThis.__catalogEnvironment.guard = null; }; };', loader: 'js' }));
    } }],
  });
  global.__catalogEnvironment = environment;
  global.window = { api: { catalogStudio: environment.api } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => id === 'react' ? hook.React : id === 'react/jsx-runtime' ? hook.runtime : require(id), mod, mod.exports);
  return mod.exports[name === 'TemplateBuilder' ? 'CatalogTemplateBuilder' : name === 'index' ? 'CatalogTemplates' : name];
}
async function builder(options = {}) {
  const hook = hooks(); const requests = []; const toasts = []; let closed = 0;
  const environment = { store: { activeCompanyId: 'company', companies: [], addToast: (...args) => toasts.push(args) }, confirm: async () => false, choose: async () => 'cancel', api: { previewTemplate: async () => ({ html: '<p>preview</p>', total: 1, sampleCount: 1 }), updateTemplate: async (id, patch) => { requests.push(patch); return { id, ...patch, updatedAt: 8 }; }, ...options.api }, ...options.environment };
  const Component = await load('TemplateBuilder', hook, environment);
  const props = { draft: { id: 'template', name: 'Original', updatedAt: 7, config: {} }, onClose: () => { closed += 1; }, onSaved: () => { closed += 1; } };
  const render = () => hook.render(Component, props); render();
  return { hook, render, environment, requests, toasts, get closed() { return closed; }, edit(label, value) { control(hook.output, label).onChange({ target: { value } }); } };
}

test('template saves use the revision from the opened draft', async () => {
  const editor = await builder();
  try { await button(editor.hook.output, 'Save template').onClick(); assert.equal(editor.requests[0].expectedUpdatedAt, 7); assert.equal(editor.closed, 1); }
  finally { editor.hook.cleanup(); }
});

for (const choice of ['cancel', 'refresh', 'overwrite']) test(`template conflict ${choice} preserves the intended draft and revision`, async () => {
  let calls = 0; const writes = [];
  const remote = { id: 'template', name: 'Remote', description: 'Remote description', config: { columns: 5 }, updatedAt: 12 };
  const editor = await builder({ environment: { choose: async () => choice }, api: { getTemplate: async () => remote, updateTemplate: async (id, patch) => { calls += 1; writes.push(patch); if (calls === 1) throw new Error('IPC: CONFLICT|{"updatedAt":12}'); return { ...remote, ...patch, updatedAt: 13 }; } } });
  try {
    editor.edit('Name', 'Local'); editor.render();
    await button(editor.hook.output, 'Save template').onClick(); editor.render();
    assert.equal(control(editor.hook.output, 'Name').value, choice === 'refresh' ? 'Remote' : 'Local');
    assert.equal(editor.closed, choice === 'overwrite' ? 1 : 0);
    if (choice === 'overwrite') { assert.equal(writes.length, 2); assert.equal(writes[1].expectedUpdatedAt, undefined); }
    if (choice === 'cancel') { assert.equal(component(editor.hook.output, 'SaveStatus').props.state, 'dirty'); }
    if (choice === 'refresh') { await button(editor.hook.output, 'Save template').onClick(); assert.equal(writes[1].expectedUpdatedAt, 12); }
  } finally { editor.hook.cleanup(); }
});

test('sidebar and company guards see edits immediately and keep drafts on cancel', async () => {
  const editor = await builder();
  try {
    editor.edit('Name', 'Unsaved');
    assert.equal(typeof editor.environment.guard, 'function');
    await assert.rejects(editor.environment.guard(), /template|editing/i);
    assert.equal(editor.closed, 0);
    await component(editor.hook.output, 'PageHeader').props.backTo.onClick(); assert.equal(editor.closed, 0);
    editor.environment.confirm = async () => true;
    await editor.environment.guard();
  } finally { editor.hook.cleanup(); }
  assert.equal(editor.environment.guard, null);
});

test('saving prevents Back, Cancel and sidebar/company transitions until acknowledged', async () => {
  const pending = deferred(); const editor = await builder({ api: { updateTemplate: () => pending.promise } });
  try {
    const save = button(editor.hook.output, 'Save template').onClick();
    await component(editor.hook.output, 'PageHeader').props.backTo.onClick();
    await button(editor.hook.output, 'Cancel').onClick();
    assert.equal(editor.closed, 0);
    await assert.rejects(editor.environment.guard(), /sav/i);
    pending.resolve({ id: 'template', name: 'Original', updatedAt: 8 }); await save;
    assert.equal(editor.closed, 1);
  } finally { editor.hook.cleanup(); }
});

test('preview replies are rejected immediately after editing and after unmount', async () => {
  const pending = deferred(); const editor = await builder({ api: { previewTemplate: () => pending.promise } });
  try {
    const preview = component(editor.hook.output, 'CatalogPreview');
    assert.ok(preview, 'Template and project use the same preview component');
    const refresh = preview.props.onRefresh(); editor.edit('Name', 'New name');
    pending.resolve({ html: 'outdated', total: 1, sampleCount: 1 }); await refresh; editor.render();
    assert.notEqual(component(editor.hook.output, 'CatalogPreview').props.preview, 'outdated');
    const late = deferred(); editor.environment.api.previewTemplate = () => late.promise;
    const refreshAfter = component(editor.hook.output, 'CatalogPreview').props.onRefresh(); editor.hook.cleanup();
    late.resolve({ html: 'unmounted', total: 1, sampleCount: 1 }); await refreshAfter; editor.render();
    assert.notEqual(component(editor.hook.output, 'CatalogPreview').props.preview, 'unmounted');
  } finally { editor.hook.cleanup(); }
});

test('shared design controls expose bounded print options and retain field source identity', async () => {
  const hook = hooks(); const patches = [];
  const environment = { store: { products: [{ customFields: { 'Long original source title': 'value' } }] } };
  const Controls = await load('DesignControls', hook, environment);
  const root = hook.render(Controls, { config: { fields: [{ key: 'custom.Long original source title', label: 'Renamed', align: 'right' }] }, onChange: (patch) => patches.push(patch) });
  for (const [label, value, patch] of [ ['Layout mode', 'list', { layoutMode: 'list' }], ['Photo height (mm)', '0', { imageHeightMm: 0 }], ['Photo fit', 'cover', { imageFit: 'cover' }], ['Card padding (mm)', '0', { cardPaddingMm: 0 }], ['Regular font (pt)', '9', { fontSizePt: 9 }], ['Bold font (pt)', '12', { boldFontSizePt: 12 }], ['Header text', 'Example', { headerText: 'Example' }], ['Footer text', 'End', { footerText: 'End' }] ]) { control(root, label).onChange({ target: { value } }); assert.deepEqual(patches.pop(), patch); }
  assert.equal(control(root, 'Header text').maxLength, 200);
  assert.equal(control(root, 'Regular font (pt)').min, 6); assert.equal(control(root, 'Regular font (pt)').max, 24);
  assert.equal(control(root, 'Bold font (pt)').max, 32);
  for (const [label, key] of [['Show product photos', 'showImages'], ['Show brand', 'showBrand'], ['Page numbers', 'pageNumbers']]) { const check = find(root, (n) => n.type === 'input' && n.props['aria-label'] === label); assert.ok(check, label); check.props.onChange({ target: { checked: false } }); assert.deepEqual(patches.pop(), { [key]: false }); }
  const source = find(root, (n) => n.props?.className === 'catalog-field-row__source');
  assert.ok(source); assert.ok(find(source, (n) => n.props?.children === 'Long original source title'));
  const align = control(root, 'Alignment');
  assert.equal(align['aria-label'], 'Alignment for custom.Long original source title');
  align.onChange({ target: { value: 'center' } }); assert.equal(patches.pop().fields[0].align, 'center');
});


test('design disclosures retain independent open state while current summaries track edits', async () => {
  const hook = hooks(); const Controls = await load('DesignControls', hook, { store: { products: [] } });
  let config = { columns: 3, fields: [] };
  const render = () => hook.render(Controls, { config, onChange: (patch) => { config = { ...config, ...patch }; } });
  const group = (root, label) => find(root, (n) => n.type === 'details' && find(n.props.children?.[0], (child) => child.props?.children === label));
  let root = render();
  const layout = group(root, 'Layout'); assert.ok(layout, 'native Layout disclosure'); assert.equal(layout.props.open, true);
  const style = group(root, 'Style'); assert.equal(style.props.open, false);
  style.props.onToggle({ currentTarget: { open: true } }); root = render();
  assert.equal(group(root, 'Style').props.open, true); assert.equal(group(root, 'Layout').props.open, true);
  group(root, 'Layout').props.onToggle({ currentTarget: { open: false } });
  control(root, 'Columns').onChange({ target: { value: '5' } }); root = render();
  assert.equal(group(root, 'Layout').props.open, false); assert.equal(group(root, 'Style').props.open, true);
  const summary = group(root, 'Layout').props.children[0];
  assert.ok(find(summary, (n) => typeof n.props?.children === 'string' && n.props.children.includes('5 columns')), 'collapsed summary tracks the edited value');
  for (const label of ['Cover', 'Photos and text', 'Page header and footer', 'Card fields']) assert.ok(group(root, label), label);
});


test('searched catalog template opens its editor and ignores stale cross-company replies', async () => {
  const hook = hooks(); const first = deferred(); const requests = []; const toasts = [];
  const store = { activeCompanyId: 'company-a', pendingCatalogTemplateId: 'template-a', addToast: (message) => toasts.push(message), clearPendingCatalogTemplateNav() { store.pendingCatalogTemplateId = null; } };
  const environment = { store, api: { listTemplates: async () => [], getTemplate: (id) => { requests.push(id); return first.promise; } } };
  const Templates = await load('index', hook, environment); hook.render(Templates, {});
  assert.deepEqual(requests, ['template-a']);
  store.activeCompanyId = 'company-b'; store.pendingCatalogTemplateId = 'template-b';
  environment.api.getTemplate = async () => ({ id: 'template-b', companyId: 'company-b', name: 'Second', config: {} }); hook.render(Templates, {});
  await new Promise(setImmediate); hook.render(Templates, {});
  assert.equal(component(hook.output, 'CatalogTemplateBuilder').props.draft.id, 'template-b');
  first.resolve({ id: 'template-a', companyId: 'company-a', name: 'First', config: {} }); await new Promise(setImmediate); hook.render(Templates, {});
  assert.equal(component(hook.output, 'CatalogTemplateBuilder').props.draft.id, 'template-b');
  assert.equal(store.pendingCatalogTemplateId, null); assert.deepEqual(toasts, []); hook.cleanup();
});


test('design field summary matches default print fields and respects deliberately empty fields', async () => {
  const hook = hooks(); const Controls = await load('DesignControls', hook, { store: { products: [] } });
  let root = hook.render(Controls, { config: {}, onChange() {} });
  assert.ok(find(root, (n) => n.props?.className === 'catalog-design-section__value' && n.props.children === '4 fields printed'));
  root = hook.render(Controls, { config: { fields: [] }, onChange() {} });
  assert.ok(find(root, (n) => n.props?.className === 'catalog-design-section__value' && n.props.children === '0 fields printed'));
});


for (const [action, expectedId, expectedName] of [
  ['+ New template', undefined, ''],
  ['Edit', 'template-b', 'Manual B'],
  ['Open in builder', undefined, 'Modern product grid (mine)'],
]) test(`delayed searched template cannot replace manual ${action} builder intent`, async () => {
  const hook = hooks(); const delayed = deferred(); const toasts = [];
  const store = { activeCompanyId: 'company-a', pendingCatalogTemplateId: 'template-a', addToast: (message) => toasts.push(message), clearPendingCatalogTemplateNav() { store.pendingCatalogTemplateId = null; } };
  const environment = { store, api: {
    listTemplates: async () => [{ id: 'template-b', companyId: 'company-a', name: 'Manual B', config: {}, updatedAt: 5 }],
    getTemplate: () => delayed.promise,
  } };
  const Templates = await load('index', hook, environment); hook.render(Templates, {}); await new Promise(setImmediate); hook.render(Templates, {});
  button(hook.output, action).onClick();
  // Reply before the next parent render: the old effect has not cleaned up yet.
  delayed.resolve({ id: 'template-a', companyId: 'company-a', name: 'Searched A', config: {} }); await new Promise(setImmediate); hook.render(Templates, {});
  const builder = component(hook.output, 'CatalogTemplateBuilder'); assert.ok(builder);
  assert.equal(builder.props.draft.id, expectedId); assert.equal(builder.props.draft.name, expectedName);
  const enteredDraft = builder.props.draft;
  hook.render(Templates, {}); assert.equal(component(hook.output, 'CatalogTemplateBuilder').props.draft, enteredDraft, 'manual draft identity is retained for its typed editor state');
  assert.equal(store.pendingCatalogTemplateId, null); assert.deepEqual(toasts, []); hook.cleanup();
});
