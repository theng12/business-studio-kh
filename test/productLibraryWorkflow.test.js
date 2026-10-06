const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function hooks() {
  let cursor = 0; const values = []; const effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  const React = {
    memo: (fn) => fn,
    useState(initial) { const i = cursor++; values[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [values[i].value, (next) => { values[i].value = typeof next === 'function' ? next(values[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; return values[i] ||= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) values[i] = { value: fn(), deps }; return values[i].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) effects.push(() => { values[i]?.cleanup?.(); values[i] = { deps, cleanup: fn() }; }); },
  };
  return { React, runtime: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, render(fn, props) { cursor = 0; const out = fn(props); for (const effect of effects.splice(0)) effect(); return out; }, cleanup() { values.forEach((v) => v?.cleanup?.()); } };
}
function findAll(node, pred, out = []) { if (!node || typeof node !== 'object') return out; if (pred(node)) out.push(node); for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach((n) => findAll(n, pred, out)); else findAll(v, pred, out); } return out; }
const named = (out, name) => findAll(out, (n) => n.type?.name === name);
const field = (out, label) => named(out, 'Field').find((n) => n.props.label === label).props.children({ id: label }).props;
function load(file, stubs) {
  const source = esbuild.transformSync(fs.readFileSync(path.join(root, file), 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs', jsx: 'automatic' }).code;
  const mod = { exports: {} }; new Function('require', 'module', 'exports', source)((id) => { if (id in stubs) return stubs[id]; if (id.endsWith('listTools.js')) return load('renderer/lib/listTools.js', {}); if (id.endsWith('latestSaveQueue.js')) return load('renderer/lib/latestSaveQueue.js', {}); if (id.endsWith('currencies.js')) return { CURRENCIES: [] }; if (id.endsWith('imageUrl.js')) return { appImageSrc: (p) => p }; return new Proxy({}, { get: (_, key) => ({ [key]: function () {} })[key] }); }, mod, mod.exports); return mod.exports;
}
const A = { id: 'A', sku: 'A', updatedAt: 7 };
const B = { id: 'B', sku: 'B', updatedAt: 12 };
const photos = (id) => [1, 2].map((n) => ({ id: `${id}-${n}`, filepath: `${id}/${n}.jpg`, contentHash: `${id}-${n}-hash` }));
async function editor(options = {}) {
  const hook = hooks(); const toasts = []; const writes = []; let output; let guard;
  const state = { brands: [], categories: [], companies: [], products: [A, B], allProducts: [A, B], refreshProducts: async () => {}, addToast: (...a) => toasts.push(a), updateProduct: async (id, patch) => { writes.push({ id, patch }); return { id, ...patch, updatedAt: patch.expectedUpdatedAt + 1 }; }, ...options.store };
  const useAppStore = (select) => select(state); useAppStore.getState = () => state;
  const parseConflictError = (e) => e.message.startsWith('CONFLICT|') ? JSON.parse(e.message.slice(9)) : null;
  const Component = load('renderer/modules/ProductLibrary/ProductForm.jsx', { react: hook.React, 'react/jsx-runtime': hook.runtime, '../../store/index.js': { useAppStore }, '../../components/ConfirmModal.jsx': { confirm: options.confirm || (async () => true) }, '../../components/ConflictModal.jsx': { parseConflictError, showConflict: options.choose || (async () => 'cancel') }, '../../lib/companySwitch.js': { registerCompanySwitchFlusher: (fn) => { guard = fn; return () => { guard = null; }; } } }).ProductForm;
  global.window = { api: { images: { listByProduct: async (id) => photos(id), importForProduct: async () => ({ images: photos('A') }), setMainImage: async () => photos('A').reverse(), reorderImages: async () => photos('A').reverse(), removeFromProduct: async () => photos('A').slice(1), importFromBytes: async () => ({ images: photos('A') }), ...options.images }, files: { pickImageFile: async () => '/tmp/photo.jpg' }, products: { get: async () => A }, suppliers: { list: async () => [] } }, addEventListener() {}, removeEventListener() {} };
  global.document = { addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };
  const props = { product: A, onClose() {}, onRegisterFlush: (fn) => { guard = fn; } };
  const render = () => output = hook.render(Component, props);
  render(); await settle(); render(); render();
  return { hook, props, render, state, toasts, writes, tiles: () => named(output, 'ImageTile'), edit: (value) => { field(output, 'Name').onChange({ target: { value } }); render(); }, save: () => named(output, 'Button').find((n) => n.props.children === 'Save' || n.props.children === 'Saving…').props.onClick(), flush: () => guard(), output: () => output };
}
for (const [operation, invoke, api] of [
  ['set main', (e) => e.tiles()[1].props.onSetMain(), 'setMainImage'],
  ['reorder', (e) => e.tiles()[1].props.onMoveLeft(), 'reorderImages'],
  ['remove', (e) => e.tiles()[0].props.onRemove(), 'removeFromProduct'],
  ['add', (e) => named(e.output(), 'Button').find((n) => n.props.children === '+ Add image').props.onClick(), 'importForProduct'],
  ['paste', (e) => findAll(e.output(), (n) => typeof n.props?.onPaste === 'function')[0].props.onPaste({ clipboardData: { items: [{ type: 'image/png', getAsFile: () => ({ type: 'image/png', arrayBuffer: async () => new ArrayBuffer(1) }) }] }, preventDefault() {} }), 'importFromBytes'],
]) test(`${operation} reply for A does not repaint B`, async () => {
  const reply = deferred(); const e = await editor({ images: { [api]: () => reply.promise } });
  try { const running = invoke(e); await settle(); e.props.product = B; e.render(); await settle(); e.render(); reply.resolve(api.startsWith('import') ? { images: photos('A') } : photos('A')); await running; e.render(); assert.deepEqual(e.tiles().map((n) => n.props.image.id), ['B-1', 'B-2']); } finally { e.hook.cleanup(); }
});
test('selection survives slot renumbering and remove sends the confirmed identity', async () => {
  const confirm = deferred(); const removed = [];
  const e = await editor({ confirm: () => confirm.promise, images: { setMainImage: async () => [{ ...photos('A')[1], filepath: 'A/1.jpg' }, { ...photos('A')[0], filepath: 'A/2.jpg' }], removeFromProduct: async (...a) => { removed.push(a); return []; } } });
  try { e.tiles()[1].props.onToggleSelected(); e.render(); const removing = e.tiles()[0].props.onRemove(); await e.tiles()[1].props.onSetMain(); e.render(); e.render(); assert.equal(e.tiles()[0].props.selected, true); assert.equal(e.tiles()[1].props.selected, false); confirm.resolve(true); await removing; assert.deepEqual(removed[0], ['A', 'A-1', 'A-1-hash']); } finally { e.hook.cleanup(); }
});
test('queue serializes advancing tokens and navigation flush includes edits typed during a save', async () => {
  const first = deferred(); const second = deferred(); const writes = [];
  const e = await editor({ store: { updateProduct: (id, patch) => { writes.push({ id, patch }); return writes.length === 1 ? first.promise : second.promise; } } });
  try { e.edit('First'); const saving = e.save(); await settle(); e.edit('Latest'); const leaving = e.flush(); assert.equal(writes.length, 1); first.resolve({ ...A, name: 'First', updatedAt: 8 }); await settle(); assert.equal(writes.length, 2); assert.equal(writes[1].patch.name, 'Latest'); assert.equal(writes[1].patch.expectedUpdatedAt, 8); second.resolve({ ...A, name: 'Latest', updatedAt: 9 }); await Promise.all([saving, leaving]); } finally { e.hook.cleanup(); }
});
test('failed flush retains a retryable draft and rejects navigation', async () => {
  let fail = true; const writes = [];
  const e = await editor({ store: { updateProduct: async (id, patch) => { writes.push(patch); if (fail) throw new Error('Link unavailable'); return { ...A, ...patch, updatedAt: 8 }; } } });
  try { e.edit('Keep me'); await assert.rejects(e.flush(), /Link unavailable/); e.render(); assert.equal(field(e.output(), 'Name').value, 'Keep me'); assert.ok(e.toasts.some((t) => t[0].includes('Link unavailable'))); fail = false; await e.flush(); assert.equal(writes.at(-1).name, 'Keep me'); assert.equal(writes.at(-1).expectedUpdatedAt, 7); } finally { e.hook.cleanup(); }
});
test('image remove explains recovery and uses one-based position copy', () => {
  const source = fs.readFileSync(path.join(root, 'renderer/modules/ProductLibrary/ProductForm.jsx'), 'utf8');
  const remove = source.slice(source.indexOf('async function handleRemoveImage'), source.indexOf('/* ───', source.indexOf('async function handleRemoveImage')));
  assert.match(remove, /Settings → Recently deleted/); assert.match(remove, /Position 1/); assert.doesNotMatch(remove, /can't be undone|deleted from disk|Position 0/);
});
test('copy and drag resolve the selected row IDs to their current paths', async () => {
  const copied = []; const dragged = [];
  const e = await editor({ images: { setMainImage: async () => [{ ...photos('A')[1], filepath: 'A/1.jpg' }, { ...photos('A')[0], filepath: 'A/2.jpg' }], copyImagesToFolder: async (args) => { copied.push(args); return { canceled: true }; }, prepareDrag: async (id, paths) => { dragged.push(paths); return { files: ['/tmp/prepared.jpg'] }; }, startDragOut() {} } });
  try {
    e.tiles()[1].props.onToggleSelected(); e.render(); await e.tiles()[1].props.onSetMain(); e.render(); e.render();
    const copy = named(e.output(), 'Button').find((n) => n.props.children === 'Copy to folder…'); assert.ok(copy); await copy.props.onClick();
    assert.deepEqual(copied[0].filepaths, ['A/1.jpg']);
    const drag = findAll(e.output(), (n) => typeof n.props?.onDragStart === 'function')[0]; await drag.props.onDragStart({ preventDefault() {} });
    assert.deepEqual(dragged[0], ['A/1.jpg']);
  } finally { e.hook.cleanup(); }
});
test('Dashboard no-image navigation resets unrelated filters while Library image filtering composes', () => {
  const defaults = { search: '', brandIds: [], categoryIds: [], status: null, processStatus: null, hasImages: null };
  let refreshes = 0; let state = { productFilters: { ...defaults, search: 'wrong', brandIds: ['brand'], categoryIds: ['category'], status: 'draft' }, productSort: { key: 'name', dir: 'asc' }, page: 9 };
  const factory = load('renderer/store/products.js', { './productsDefaults.js': { DEFAULT_FILTERS: defaults, DEFAULT_SORT: {}, loadProductSort: () => ({}), saveProductSort() {} } }).createProductsSlice;
  const slice = factory((patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; }, () => ({ ...state, refreshProducts: () => { refreshes++; } }));
  slice.setHasImagesFilter('without'); assert.equal(state.productFilters.search, 'wrong'); assert.deepEqual(state.productFilters.brandIds, ['brand']);
  slice.setCompanyNoImagesFilter(); assert.deepEqual(state.productFilters, { ...defaults, hasImages: 'without' }); assert.equal(state.page, 0); assert.deepEqual(state.productSort, { key: 'name', dir: 'asc' }); assert.equal(refreshes, 1);
  assert.match(fs.readFileSync(path.join(root, 'renderer/modules/Dashboard/index.jsx'), 'utf8'), /setCompanyNoImagesFilter\(\)/);
});
test('Company form stays open after Refresh or Cancel', async () => {
  const hook = hooks(); let closed = 0;
  const Component = load('renderer/modules/Companies/CompanyForm.jsx', { react: hook.React, 'react/jsx-runtime': hook.runtime }).CompanyForm;
  const props = { open: true, company: { id: 'company', name: 'Draft', updatedAt: 7 }, onSubmit: async () => false, onClose: () => { closed++; } };
  hook.render(Component, props); let out = hook.render(Component, props);
  await named(out, 'Button').find((n) => n.props.children === 'Save').props.onClick(); assert.equal(closed, 0);
  props.company = { ...props.company, name: 'Fresh', updatedAt: 8 }; hook.render(Component, props); out = hook.render(Component, props); assert.equal(field(out, 'Name').value, 'Fresh');
  hook.cleanup();
});
for (const choice of ['refresh', 'cancel', 'overwrite']) test(`Company ${choice} rereads its row or preserves the stale draft deliberately`, async () => {
  const hook = hooks(); const writes = []; const original = { id: 'company', name: 'Original', updatedAt: 7, sectors: [] }; const fresh = { ...original, name: 'Fresh', updatedAt: 8 };
  const state = { companies: [original], addToast() {}, updateCompany: async (id, patch) => { writes.push(patch); if (patch.expectedUpdatedAt != null) throw new Error('CONFLICT|{}'); return { ...fresh, ...patch }; }, refreshCompanies: async () => { state.companies = [fresh]; } };
  const useAppStore = (select) => select(state); useAppStore.getState = () => state;
  const conflict = load('renderer/components/ConflictModal.jsx', {});
  global.window = { api: { companies: { get: async () => fresh } } };
  const Component = load('renderer/modules/Companies/index.jsx', { react: hook.React, 'react/jsx-runtime': hook.runtime, '../../store/index.js': { useAppStore }, '../../components/Sidebar.jsx': { useUserCaps: () => ['*'] }, '../../lib/capabilities.js': { hasCap: () => true }, '../../components/ConflictModal.jsx': { resolveSaveConflict: (error, callbacks) => conflict.resolveSaveConflict(error, { ...callbacks, choose: async () => choice }) } }).Companies;
  let out = hook.render(Component); named(out, 'Button').find((n) => n.props.children === 'Edit').props.onClick(); out = hook.render(Component);
  const result = await named(out, 'CompanyForm')[0].props.onSubmit({ name: 'Draft', color: '#333', sectors: [] }); out = hook.render(Component);
  assert.equal(writes[0].expectedUpdatedAt, 7);
  if (choice === 'refresh') { assert.equal(result, false); assert.equal(named(out, 'CompanyForm')[0].props.company.name, 'Fresh'); assert.equal(named(out, 'CompanyForm')[0].props.company.updatedAt, 8); }
  if (choice === 'cancel') { assert.equal(result, false); assert.equal(named(out, 'CompanyForm')[0].props.company.name, 'Original'); }
  if (choice === 'overwrite') { assert.equal(writes.length, 2); assert.equal(writes[1].expectedUpdatedAt, undefined); assert.notEqual(result, false); }
  hook.cleanup();
});
for (const choice of ['refresh', 'cancel', 'overwrite']) test(`Category ${choice} uses the begin-edit token and keeps the inline edit for Refresh/Cancel`, async () => {
  const hook = hooks(); const writes = []; const original = { id: 'category', name: 'Original', updatedAt: 7 }; const fresh = { ...original, name: 'Fresh', updatedAt: 8 };
  const state = { activeCompanyId: 'company', allProducts: [], categories: [original], addToast() {}, refreshCategories: async () => { state.categories = [fresh]; }, updateCategory: async (id, patch) => { writes.push(patch); if (patch.expectedUpdatedAt != null) throw new Error('CONFLICT|{}'); return { ...fresh, ...patch }; } };
  const useAppStore = (select) => select(state); useAppStore.getState = () => state;
  const conflict = load('renderer/components/ConflictModal.jsx', {});
  global.window = { api: { categories: { list: async () => [fresh] } }, addEventListener() {}, removeEventListener() {} };
  const ui = new Proxy({ paginate: (len, page, size) => ({ currentPage: page, maxPage: 0, pageStart: 0, pageEnd: size }) }, { get: (target, key) => target[key] || ({ [key]: function () {} })[key] });
  const Component = load('renderer/modules/Categories/index.jsx', { react: hook.React, 'react/jsx-runtime': hook.runtime, '../../store/index.js': { useAppStore }, '../../components/ui.jsx': ui, '../../components/ConflictModal.jsx': { resolveSaveConflict: (error, callbacks) => conflict.resolveSaveConflict(error, { ...callbacks, choose: async () => choice }) } }).CategoriesBody;
  hook.render(Component, {}); let out = hook.render(Component, {});
  named(out, 'Button').find((n) => n.props.children === 'Rename').props.onClick(); out = hook.render(Component, {});
  named(out, 'Input').find((n) => n.props['aria-label'] === 'Rename Original').props.onChange({ target: { value: 'Draft' } });
  // Another editor refreshes the list while this inline snapshot remains open.
  state.categories = [fresh]; out = hook.render(Component, {});
  await named(out, 'Button').find((n) => n.props.children === 'Save').props.onClick(); out = hook.render(Component, {});
  assert.equal(writes[0].expectedUpdatedAt, 7);
  if (choice === 'refresh') assert.equal(named(out, 'Input').find((n) => n.props['aria-label'] === 'Rename Fresh').props.value, 'Fresh');
  if (choice === 'cancel') assert.equal(named(out, 'Input').find((n) => n.props['aria-label'] === 'Rename Fresh').props.value, 'Draft');
  if (choice === 'overwrite') { assert.equal(writes.length, 2); assert.equal(writes[1].expectedUpdatedAt, undefined); assert.equal(named(out, 'Button').some((n) => n.props.children === 'Save'), false); }
  hook.cleanup();
});
test('phone delete captures row identity when its tile menu opens', () => {
  const source = fs.readFileSync(path.join(root, 'webclient/index.html'), 'utf8');
  assert.match(source, /openTileMenu\(\{ productId: productId, imageId: img.id, expectedContentHash: img.contentHash/);
  assert.match(source, /confirmAndDeleteImage\(ctx.productId, ctx.imageId, ctx.expectedContentHash, ctx.index\)/);
  assert.match(source, /rpc\('images:removeFromProduct', \{ productId: productId, imageId: imageId, expectedContentHash: expectedContentHash \}\)/);
});
