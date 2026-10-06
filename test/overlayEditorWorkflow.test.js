const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

// Invoke the real editor handlers. Native persistence is covered separately;
// the release crawl owns geometry and actual browser keyboard behavior.
function hooks() {
  let cursor = 0; let output;
  const values = []; const effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  const React = {
    useState(initial) { const i = cursor++; values[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [values[i].value, (next) => { values[i].value = typeof next === 'function' ? next(values[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; values[i] ||= { current: initial }; return values[i]; },
    useMemo(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) values[i] = { value: fn(), deps }; return values[i].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) effects.push(() => { values[i]?.cleanup?.(); values[i] = { deps, cleanup: fn() }; }); },
  };
  return { React, runtime: { Fragment: 'Fragment', jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, render(Component, props) { cursor = 0; output = Component(props); for (const effect of effects.splice(0)) effect(); return output; }, get output() { return output; }, cleanup() { for (const value of values) value?.cleanup?.(); } };
}
function find(root, predicate) {
  if (!root || typeof root !== 'object') return null;
  if (predicate(root)) return root;
  for (const value of Object.values(root)) { const match = Array.isArray(value) ? value.map((v) => find(v, predicate)).find(Boolean) : find(value, predicate); if (match) return match; }
  return null;
}
const component = (root, name) => find(root, (n) => n.type?.name === name);
const button = (root, label) => find(root, (n) => (n.type?.name === 'Button' && n.props.children === label) || n.props?.['aria-label'] === label).props;
const field = (root, label) => find(root, (n) => n.type?.name === 'Field' && n.props.label === label).props.children({ id: label }).props;
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const row = { id: 'template-B', name: 'Original', canvasWidth: 2000, canvasHeight: 2000, elements: [{ id: 'el', type: 'text', content: '0', x: 0 }], tags: [], updatedAt: 7 };

async function editor(options = {}) {
  const hook = hooks(); const writes = []; const toasts = []; const listeners = {}; let closed = 0;
  const environment = { store: { products: [{ id: 'product', sku: 'P' }], brands: [], categories: [], companies: [], addToast: (...args) => toasts.push(args) }, choose: async () => 'cancel', ...options.environment };
  const out = await esbuild.build({ entryPoints: [path.join(__dirname, '../renderer/modules/OverlayStudio/TemplateEditor.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent', plugins: [{ name: 'overlay-environment', setup(build) {
    build.onResolve({ filter: /store\/index\.js$/ }, () => ({ path: 'store', namespace: 'test' }));
    build.onResolve({ filter: /components\/(ui|PageHeader|SaveStatus|ConfirmModal)\.jsx$|\/(EditorCanvas|Inspector|BulkOverlayRunModal)\.jsx$/ }, (args) => ({ path: path.basename(args.path, '.jsx'), namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: name }) => ({ contents: name === 'store' ? 'export const useAppStore = (select) => select(globalThis.__overlayEnvironment.store);' : name === 'ConfirmModal' ? 'export const confirm = async () => true;' : `export function ${name}() {} export function Button() {} export function Field() {} export function Input() {} export function Select() {} export function SliderField() {} export function Modal() {}`, loader: 'js' }));
    build.onLoad({ filter: /ConflictModal\.jsx$/ }, (args) => ({ contents: fs.readFileSync(args.path, 'utf8').replace('choose = showConflict', 'choose = globalThis.__overlayEnvironment.choose'), loader: 'jsx' }));
    build.onResolve({ filter: /companySwitch\.js$/ }, () => ({ path: 'guard', namespace: 'guard' }));
    build.onLoad({ filter: /.*/, namespace: 'guard' }, () => ({ contents: 'export const registerCompanySwitchFlusher = (fn) => { globalThis.__overlayEnvironment.guard = fn; return () => { globalThis.__overlayEnvironment.guard = null; }; };', loader: 'js' }));
  } }] });
  global.__overlayEnvironment = environment;
  global.window = { api: { templates: { get: async () => structuredClone(row), update: async (id, patch) => { writes.push(patch); return { ...row, ...patch, updatedAt: 8 }; }, ...options.api }, images: { listByProduct: async () => [], ...options.images } }, addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: (name) => { delete listeners[name]; } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => id === 'react' ? hook.React : id === 'react/jsx-runtime' ? hook.runtime : require(id), mod, mod.exports);
  const props = { templateId: row.id, onClose: () => { closed += 1; } };
  const render = () => hook.render(mod.exports.TemplateEditor, props); render(); await settle(); render(); await settle(); render();
  return { hook, render, props, environment, writes, toasts, listeners, get closed() { return closed; }, edit(name) { field(hook.output, 'Template name').onChange({ target: { value: name } }); }, change(patch) { component(hook.output, 'EditorCanvas').props.onChangeElement('el', patch); }, template() { return component(hook.output, 'EditorCanvas').props.template; } };
}

test('Apply waits for the newest acknowledged draft and passes the current template', async () => {
  const first = deferred(); const second = deferred(); const writes = [];
  const e = await editor({ api: { update: (id, patch) => { writes.push({ id, patch }); return writes.length === 1 ? first.promise : second.promise; } } });
  try {
    e.edit('First'); e.render(); const saving = component(e.hook.output, 'SaveStatus').props.onSave();
    e.edit('Latest'); e.render(); const applying = button(e.hook.output, 'Apply…').onClick();
    assert.equal(writes.length, 1); assert.equal(writes[0].patch.expectedUpdatedAt, 7);
    first.resolve({ ...row, name: 'First', updatedAt: 8 }); await settle(); e.render();
    assert.equal(e.template().name, 'Latest'); assert.notEqual(component(e.hook.output, 'SaveStatus').props.status.state, 'saved');
    assert.equal(component(e.hook.output, 'BulkOverlayRunModal').props.open, false);
    assert.equal(writes.length, 2); assert.equal(writes[1].patch.expectedUpdatedAt, 8);
    second.resolve({ ...row, name: 'Latest', updatedAt: 9 }); await Promise.all([saving, applying]); e.render();
    assert.equal(component(e.hook.output, 'BulkOverlayRunModal').props.open, true);
    assert.equal(component(e.hook.output, 'BulkOverlayRunModal').props.initialTemplateId, row.id);
    assert.equal(component(e.hook.output, 'SaveStatus').props.status.state, 'saved');
  } finally { e.hook.cleanup(); }
});

test('failed saves retain the draft and block Apply, Done, Back and navigation', async () => {
  const e = await editor({ api: { update: async () => { throw new Error('Disk unavailable'); } } });
  try {
    e.edit('Keep me'); e.render();
    await button(e.hook.output, 'Apply…').onClick(); e.render();
    assert.equal(component(e.hook.output, 'BulkOverlayRunModal').props.open, false);
    await button(e.hook.output, 'Done').onClick(); await component(e.hook.output, 'PageHeader').props.backTo.onClick();
    assert.equal(e.closed, 0); assert.equal(e.template().name, 'Keep me');
    await assert.rejects(e.environment.guard(), /save|Disk/i);
  } finally { e.hook.cleanup(); }
});

test('history captures complete bursts and Undo followed by editing creates a new checkpoint', async (t) => {
  const e = await editor(); t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const x of [1, 2, 3]) { e.change({ x }); e.render(); }
    button(e.hook.output, 'Undo').onClick(); e.render(); assert.equal(e.template().elements[0].x, 0);
    t.mock.timers.tick(300); e.render();
    button(e.hook.output, 'Redo').onClick(); e.render(); assert.equal(e.template().elements[0].x, 3);
    button(e.hook.output, 'Undo').onClick(); e.render();
    e.change({ content: 'new' }); e.render(); t.mock.timers.tick(300); e.render();
    assert.equal(button(e.hook.output, 'Redo').disabled, true);
    e.listeners.keydown({ key: 'z', metaKey: true, target: { tagName: 'DIV' }, preventDefault() {} }); e.render();
    assert.equal(e.template().elements[0].content, '0');
    for (const name of ['a', 'ab', 'abc']) { e.edit(name); e.render(); }
    t.mock.timers.tick(300); e.render();
    e.edit('second gesture'); e.render(); t.mock.timers.tick(300); e.render();
    button(e.hook.output, 'Undo').onClick(); e.render(); assert.equal(e.template().name, 'abc');
    button(e.hook.output, 'Undo').onClick(); e.render(); assert.equal(e.template().name, 'Original');
  } finally { e.hook.cleanup(); }
});

for (const choice of ['cancel', 'refresh', 'overwrite']) test(`conflict ${choice} keeps the intended template state`, async () => {
  let calls = 0; const writes = [];
  const e = await editor({ environment: { choose: async () => choice }, api: { get: async () => calls ? { ...row, name: 'Remote', updatedAt: 12 } : structuredClone(row), update: async (id, patch) => { writes.push(patch); if (++calls === 1) throw new Error('IPC: CONFLICT|{"updatedAt":12}'); return { ...row, ...patch, updatedAt: 13 }; } } });
  try {
    e.edit('Local'); e.render(); await component(e.hook.output, 'SaveStatus').props.onSave(); e.render();
    assert.equal(e.template().name, choice === 'refresh' ? 'Remote' : 'Local');
    if (choice === 'cancel') assert.notEqual(component(e.hook.output, 'SaveStatus').props.status.state, 'saved');
    if (choice === 'overwrite') { assert.equal(writes.length, 2); assert.equal(writes[1].expectedUpdatedAt, undefined); }
    if (choice === 'refresh') { e.edit('After refresh'); e.render(); await component(e.hook.output, 'SaveStatus').props.onSave(); assert.equal(writes[1].expectedUpdatedAt, 12); }
  } finally { e.hook.cleanup(); }
});

test('returning to the original value still restores it after an active save', async () => {
  const pending = deferred(); const writes = [];
  const e = await editor({ api: { update: async (id, patch) => { writes.push(patch); if (writes.length === 1) return pending.promise; return { ...row, ...patch, updatedAt: 9 }; } } });
  try {
    e.edit('Temporary'); e.render(); const saving = component(e.hook.output, 'SaveStatus').props.onSave();
    e.edit('Original'); e.render();
    pending.resolve({ ...row, name: 'Temporary', updatedAt: 8 }); await saving; e.render();
    assert.equal(writes.length, 2); assert.equal(writes[1].name, 'Original'); assert.equal(writes[1].expectedUpdatedAt, 8);
    assert.equal(e.template().name, 'Original'); assert.equal(component(e.hook.output, 'SaveStatus').props.status.state, 'saved');
  } finally { e.hook.cleanup(); }
});

test('one conflict resolution saves edits made while its overwrite acknowledgment is pending', async (t) => {
  const choice = deferred(); const overwrite = deferred(); const writes = []; let choices = 0;
  const e = await editor({ environment: { choose: () => { choices += 1; return choice.promise; } }, api: { update: async (id, patch) => { writes.push(patch); if (writes.length === 1) throw new Error('CONFLICT|{"updatedAt":12}'); if (writes.length === 2) return overwrite.promise; return { ...row, ...patch, updatedAt: 14 }; } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    e.edit('Before dialog'); e.render(); const saving = component(e.hook.output, 'SaveStatus').props.onSave(); await settle();
    const applying = button(e.hook.output, 'Apply…').onClick();
    e.edit('Chosen overwrite'); e.render(); t.mock.timers.tick(500); await settle(); assert.equal(writes.length, 1);
    choice.resolve('overwrite'); await settle(); assert.equal(writes[1].name, 'Chosen overwrite');
    e.edit('Newest'); e.render(); t.mock.timers.tick(500); await settle(); assert.equal(writes.length, 2);
    overwrite.resolve({ ...row, name: 'Chosen overwrite', updatedAt: 13 }); await Promise.all([saving, applying]); e.render();
    assert.equal(choices, 1); assert.equal(writes.length, 3); assert.equal(writes[2].name, 'Newest'); assert.equal(writes[2].expectedUpdatedAt, 13);
    assert.equal(e.template().name, 'Newest'); assert.equal(component(e.hook.output, 'BulkOverlayRunModal').props.open, true);
  } finally { e.hook.cleanup(); }
});

test('an old save or backdrop-image reply cannot replace the newly opened context', async () => {
  const oldImages = deferred(); const oldSave = deferred(); const newRead = deferred();
  const e = await editor({ environment: { store: { products: [{ id: 'product', sku: 'P' }, { id: 'second', sku: 'S' }], brands: [], categories: [], companies: [], addToast() {} } }, images: { listByProduct: (id) => id === 'product' ? oldImages.promise : Promise.resolve([{ filepath: 'second.jpg' }]) }, api: { update: () => oldSave.promise } });
  try {
    find(e.hook.output, (n) => n.props?.['aria-label'] === 'Preview against').props.onChange({ target: { value: 'second' } }); e.render(); await settle(); e.render();
    oldImages.resolve([{ filepath: 'wrong.jpg' }]); await settle(); e.render();
    assert.equal(component(e.hook.output, 'EditorCanvas').props.productContext.productImages[0].filepath, 'second.jpg');
    e.edit('Old draft'); e.render(); const saving = component(e.hook.output, 'SaveStatus').props.onSave();
    global.window.api.templates.get = () => newRead.promise; e.props.templateId = 'template-C'; e.render();
    oldSave.resolve({ ...row, name: 'Old acknowledgment', updatedAt: 8 }); await saving;
    newRead.resolve({ ...row, id: 'template-C', name: 'New context', updatedAt: 20 }); await settle(); e.render();
    assert.equal(e.template().id, 'template-C'); assert.equal(e.template().name, 'New context');
    assert.equal(button(e.hook.output, 'Undo').disabled, true);
  } finally { e.hook.cleanup(); }
});

test('Apply modal initializes the editor template on every open and preserves Library defaults', async () => {
  const hook = hooks(); const requests = [];
  global.__overlayEnvironment = { store: { addToast() {}, refreshProducts() {}, allProducts: [] } };
  global.window = { api: { templates: { list: async () => [{ id: 'A', name: 'First' }, { id: 'B', name: 'Current' }], applyBulk: async (request) => { requests.push(request); return { done: [], failed: [], skipped: [], total: 1 }; } } } };
  const out = await esbuild.build({ entryPoints: [path.join(__dirname, '../renderer/modules/ProductLibrary/BulkOverlayRunModal.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent', plugins: [{ name: 'modal-environment', setup(build) {
    build.onResolve({ filter: /store\/index\.js$/ }, () => ({ path: 'store', namespace: 'test' }));
    build.onResolve({ filter: /components\/ui\.jsx$/ }, () => ({ path: 'ui', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: name }) => ({ contents: name === 'store' ? 'export const useAppStore = (select) => select(globalThis.__overlayEnvironment.store);' : 'export function Button() {} export function Field() {} export function Select() {} export function Modal() {}', loader: 'js' }));
  } }] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => id === 'react' ? hook.React : id === 'react/jsx-runtime' ? hook.runtime : require(id), mod, mod.exports);
  const props = { open: true, productIds: ['product'], initialTemplateId: 'B' };
  const render = () => hook.render(mod.exports.BulkOverlayRunModal, props);
  try {
    render(); await settle(); render(); assert.equal(field(hook.output, 'Template').value, 'B');
    await button(hook.output, 'Apply to 1 product').onClick(); assert.equal(requests[0].templateId, 'B');
    field(hook.output, 'Template').onChange({ target: { value: 'A' } }); render();
    props.open = false; render(); props.open = true; render(); await settle(); render(); assert.equal(field(hook.output, 'Template').value, 'B');
    props.open = false; render(); props.initialTemplateId = undefined; props.open = true; render(); await settle(); render();
    assert.equal(field(hook.output, 'Template').value, 'B', 'Library retains the remembered choice');
    field(hook.output, 'Template').onChange({ target: { value: '' } }); render(); props.open = false; render(); props.open = true; render(); await settle(); render();
    assert.equal(field(hook.output, 'Template').value, 'A', 'Library still falls back to the first template');
  } finally { hook.cleanup(); }
});

test('canvas rejects a previous draft during the next preview debounce and after unmount', async (t) => {
  const hook = hooks(); const pending = []; let urls = 0;
  const createObjectURL = URL.createObjectURL; const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:preview-${++urls}`; URL.revokeObjectURL = () => {};
  global.window = { addEventListener() {}, removeEventListener() {}, api: { templates: { renderPreview: () => { const request = deferred(); pending.push(request); return request.promise; } } } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  const out = await esbuild.build({ entryPoints: [path.join(__dirname, '../renderer/modules/OverlayStudio/EditorCanvas.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'bwip-js'], logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => id === 'react' ? hook.React : id === 'react/jsx-runtime' ? hook.runtime : require(id), mod, mod.exports);
  const props = { template: { ...row, elements: [] }, backdropProductId: 'product', onSelectElement() {} };
  const render = () => hook.render(mod.exports.EditorCanvas, props);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    render(); t.mock.timers.tick(250); assert.equal(pending.length, 1);
    props.template = { ...props.template, name: 'New draft' }; render();
    pending[0].resolve({ bytes: new Uint8Array([1]) }); await settle(); render(); assert.equal(urls, 0);
    t.mock.timers.tick(250); pending[1].resolve({ bytes: new Uint8Array([2]) }); await settle(); render(); assert.equal(urls, 1);
    props.template = { ...props.template, name: 'Later draft' }; render(); t.mock.timers.tick(250);
    hook.cleanup(); pending[2].resolve({ bytes: new Uint8Array([3]) }); await settle(); assert.equal(urls, 1);
  } finally { hook.cleanup(); URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL; delete global.document; }
});
