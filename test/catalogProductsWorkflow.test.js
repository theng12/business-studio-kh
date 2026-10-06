const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function loadSelection() {
  const out = require('esbuild').buildSync({ entryPoints: [path.join(ROOT, 'renderer/modules/CatalogStudio/catalogSelection.js')], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}
const rules = loadSelection();

// Same shallow hook/JSX approach as catalogSocialLifetime.test.js: invoke real
// component handlers without a browser, while keeping each render's hook state.
async function productSession(products, config) {
  const hooks = []; const effects = []; let index = 0;
  const changed = (previous, deps) => !previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]));
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initial) { const i = index++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
    useRef(initial) { const i = index++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useMemo(factory, deps) { const i = index++; if (changed(hooks[i], deps)) hooks[i] = { deps, value: factory() }; return hooks[i].value; },
    useEffect(effect, deps) { const i = index++; if (changed(effects[i], deps)) effects[i] = { deps, effect, pending: true }; },
  };
  assert.ok(require('node:fs').existsSync(path.join(ROOT, 'renderer/modules/CatalogStudio/ProductManager.jsx')), 'the extracted product manager exists');
  const out = await require('esbuild').build({ entryPoints: [path.join(ROOT, 'renderer/modules/CatalogStudio/ProductManager.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom/client'], logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => id === 'react' ? react : id === 'react/jsx-runtime' ? { jsx, jsxs: jsx, Fragment: 'fragment' } : id === 'react-dom/client' ? {} : require(id), mod, mod.exports);
  const patches = []; const props = { products, config, onChange(patch) { patches.push(patch); props.config = { ...props.config, ...patch }; } };
  let tree;
  return { props, patches, render() { index = 0; tree = mod.exports.ProductManager(props); for (const entry of effects) if (entry?.pending) { entry.pending = false; entry.effect(); } return tree; }, get tree() { return tree; } };
}
function nodes(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach((child) => nodes(child, predicate, found)); return found; }
  if (!node.props) return found;
  if (predicate(node)) found.push(node);
  for (const [key, value] of Object.entries(node.props || {})) nodes(key === 'children' && typeof value === 'function' ? value({ id: 'field' }) : value, predicate, found);
  return found;
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
}
const button = (session, label) => { const found = nodes(session.tree, (n) => n.type?.name === 'Button' && text(n) === label)[0]; assert.ok(found, `button: ${label}`); return found.props; };

test('catalog filters combine search, brand and category without changing source order', () => {
  const products = [
    { id: 'a', sku: 'Abc-1', name: 'Kettle', barcode: '001', brandId: 'b1', categoryId: 'c1' },
    { id: 'b', sku: 'Abc-2', name: 'Cup', brandId: 'b2', categoryId: 'c1' },
    { id: 'c', sku: 'Abc-3', name: 'Kettle', brandId: 'b1', categoryId: 'c2' },
  ];
  assert.equal(typeof rules.filterCatalogProducts, 'function');
  assert.deepEqual(rules.filterCatalogProducts(products, { query: ' ABC ', brandId: 'b1', categoryId: 'c1' }).map((p) => p.id), ['a']);
  assert.deepEqual(rules.filterCatalogProducts(products, { query: 'kettle' }).map((p) => p.id), ['a', 'c']);
  assert.deepEqual(rules.filterCatalogProducts(products, { query: '001' }).map((p) => p.id), ['a']);
  assert.deepEqual(rules.pruneCatalogSelection(['c', 'a', 'gone', 'a'], ['a', 'b']), ['a']);
});

test('paste SKUs is case insensitive, ordered, duplicate safe and refuses ambiguous or inactive matches', () => {
  const products = [
    { id: 'a', sku: 'A-1' }, { id: 'b', sku: 'B-2' },
    { id: 'dup1', sku: 'DUP' }, { id: 'dup2', sku: 'dup' },
    { id: 'off', sku: 'OFF', status: 'inactive' }, { id: 'c', sku: 'C-3' },
  ];
  assert.equal(typeof rules.matchCatalogSkus, 'function');
  const result = rules.matchCatalogSkus(' b-2, A-1\tB-2\nmissing\r\nDUP\nOFF\n C-3 ', products, ['a']);
  assert.deepEqual(result.addIds, ['b', 'c']);
  assert.deepEqual(result.includedSkus, ['A-1']);
  assert.deepEqual(result.unmatchedSkus, ['missing']);
  assert.deepEqual(result.ambiguousSkus, ['DUP']);
  assert.deepEqual(result.inactiveSkus, ['OFF']);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(rules.matchCatalogSkus('dup', [products[2], { ...products[3], status: 'inactive' }]).addIds, [], 'inactive collision cannot pick the wrong brand');
});

test('selected block moves to a one-based final position in catalog order and preserves hidden slots', () => {
  assert.equal(typeof rules.moveCatalogBlock, 'function');
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rules.moveCatalogBlock(ids, ['d', 'b'], 1), ['b', 'd', 'a', 'c', 'e']);
  assert.deepEqual(rules.moveCatalogBlock(ids, ['d', 'b'], 3), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(rules.moveCatalogBlock(ids, ['d', 'b'], 5), ['a', 'c', 'e', 'b', 'd']);
  assert.deepEqual(rules.moveCatalogBlock(ids, ['unknown'], 2), ids);
  assert.deepEqual(rules.moveCatalogBlock(ids, ['b'], ''), ids);
  const next = rules.moveCatalogBlock(['a', 'b', 'c'], ['c', 'b'], 1);
  assert.deepEqual(rules.mergeCatalogIds(['a', 'inactive', 'b', 'missing', 'c'], next, ['inactive', 'missing']), ['b', 'inactive', 'c', 'missing', 'a']);
});

test('page add affects 50 rows while all matching uses the entire filtered library', async () => {
  const products = Array.from({ length: 75 }, (_, i) => ({ id: `p${i}`, sku: `SKU-${i}`, name: 'Item', brandId: i < 60 ? 'brand' : 'other' }));
  const session = await productSession(products, { selectionMode: 'explicit', productIds: [] });
  session.props.brands = [{ id: 'brand', name: 'Brand' }]; session.render();
  button(session, 'Add this page (50)').onClick(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, products.slice(0, 50).map((p) => p.id));
  button(session, 'Add all matching (25)').onClick(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, products.map((p) => p.id));
  assert.equal(session.patches.at(-1).selectionMode, 'explicit');
});

test('filtered included actions use catalog positions and batches retain inactive and missing ids', async () => {
  const products = [
    { id: 'a', sku: 'A' }, { id: 'h', sku: 'H', status: 'inactive' },
    { id: 'b', sku: 'B' }, { id: 'c', sku: 'C' },
  ];
  const session = await productSession(products, { selectionMode: 'explicit', productIds: ['a', 'h', 'b', 'gone', 'c'] }); session.render();
  nodes(session.tree, (n) => n.type?.name === 'Input' && n.props['aria-label'] === 'Search included products')[0].props.onChange({ target: { value: 'C' } }); session.render();
  const row = nodes(session.tree, (n) => n.type === 'article' && text(n).includes('C'))[0];
  assert.equal(nodes(row, (n) => n.props.className === 'catalog-order-number')[0].props.children, 3);
  nodes(row, (n) => n.props['aria-label'] === 'Move C up')[0].props.onClick(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, ['a', 'h', 'c', 'gone', 'b']);
  assert.equal(session.patches.at(-1).sortBy, 'manual');
  button(session, 'Select this page (1)').onClick(); session.render();
  button(session, 'Remove selected (1)').onClick(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, ['a', 'h', 'b', 'gone']);
});

test('selection remains across filters and is pruned when a product leaves its underlying list', async () => {
  const products = [{ id: 'a', sku: 'A' }, { id: 'b', sku: 'B' }];
  const session = await productSession(products, { selectionMode: 'explicit', productIds: [] }); session.render();
  nodes(session.tree, (n) => n.props['aria-label'] === 'Select A from the product library')[0].props.onChange(); session.render();
  nodes(session.tree, (n) => n.type?.name === 'Input' && n.props['aria-label'] === 'Search the product library')[0].props.onChange({ target: { value: 'B' } }); session.render();
  assert.equal(Boolean(button(session, 'Add selected (1)').disabled), false);
  session.props.products = [products[1]]; session.render(); session.render();
  assert.equal(nodes(session.tree, (n) => n.type?.name === 'Button' && text(n).startsWith('Add selected')).length, 0);
});

test('brand and category filters constrain the all-matching action without altering saved selection', async () => {
  const products = [
    { id: 'a', sku: 'A', brandId: 'b1', categoryId: 'c1' },
    { id: 'b', sku: 'B', brandId: 'b2', categoryId: 'c1' },
    { id: 'c', sku: 'C', brandId: 'b1', categoryId: 'c2' },
  ];
  const session = await productSession(products, { selectionMode: 'explicit', productIds: ['missing'] });
  session.props.brands = [{ id: 'b1', name: 'Brand' }]; session.props.categories = [{ id: 'c1', name: 'Category' }]; session.render();
  nodes(session.tree, (n) => n.type?.name === 'Select' && text(n).startsWith('All brands'))[0].props.onChange({ target: { value: 'b1' } }); session.render();
  nodes(session.tree, (n) => n.type?.name === 'Select' && text(n).startsWith('All categories'))[0].props.onChange({ target: { value: 'c1' } }); session.render();
  assert.equal(session.patches.length, 0, 'local filters do not edit the catalog');
  button(session, 'Add all matching (1)').onClick(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, ['missing', 'a']);
});

test('SKU modal adds only unambiguous new matches and shows actionable mismatch feedback', async () => {
  const products = [{ id: 'a', sku: 'A' }, { id: 'b', sku: 'B' }, { id: 'd1', sku: 'DUP' }, { id: 'd2', sku: 'dup' }];
  const session = await productSession(products, { selectionMode: 'explicit', productIds: ['a', 'missing'] }); session.render();
  button(session, 'Paste SKUs…').onClick(); session.render();
  const modal = () => nodes(session.tree, (n) => n.type?.name === 'Modal' && n.props.title === 'Add products by SKU')[0];
  assert.equal(modal().props.open, true);
  nodes(session.tree, (n) => n.type?.name === 'Textarea')[0].props.onChange({ target: { value: ' b, B\nA\tDUP\nunknown' } }); session.render();
  assert.match(text(modal()), /1 ready to add · 1 already included · 1 repeated entries skipped/);
  assert.match(text(modal()), /Ambiguous \(1\): DUP/);
  assert.match(text(modal()), /Not found \(1\): unknown/);
  button(session, 'Add matched (1)').onClick(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, ['a', 'missing', 'b']);
  assert.equal(modal().props.open, false);
});

test('selected block UI keeps catalog order rather than click order at the requested position', async () => {
  const products = ['a', 'b', 'c', 'd'].map((id) => ({ id, sku: id.toUpperCase() }));
  const session = await productSession(products, { selectionMode: 'explicit', productIds: ['a', 'missing', 'b', 'c', 'd'] }); session.render();
  for (const sku of ['D', 'B']) {
    nodes(session.tree, (n) => n.props['aria-label'] === `Select ${sku} in the catalog`)[0].props.onChange(); session.render();
  }
  nodes(session.tree, (n) => n.type?.name === 'Input' && n.props.type === 'number')[0].props.onChange({ target: { value: '2' } }); session.render();
  button(session, 'Move selected (2)').onClick(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, ['a', 'missing', 'b', 'd', 'c']);
  assert.equal(session.patches.at(-1).sortBy, 'manual');
});


test('catalog selected actions are conditional while direct Add scopes stay in a labeled disclosure', async () => {
  const session = await productSession([{ id: 'a', sku: 'A' }, { id: 'b', sku: 'B' }], { selectionMode: 'explicit', productIds: ['b', 'missing'] }); session.render();
  const selectedActions = () => nodes(session.tree, (n) => n.type?.name === 'Button' && /^(Add|Move|Remove) selected/.test(text(n)));
  assert.equal(selectedActions().length, 0);
  const disclosure = nodes(session.tree, (n) => n.type === 'details' && text(n).includes('Add this page'))[0];
  assert.ok(disclosure, 'direct additions are grouped');
  assert.ok(nodes(disclosure, (n) => n.type === 'summary' && text(n) === 'Add products')[0], 'native summary is the keyboard launcher');
  assert.equal(button(session, 'Add this page (1)').disabled, false);
  nodes(session.tree, (n) => n.props['aria-label'] === 'Select A from the product library')[0].props.onChange(); session.render();
  assert.equal(button(session, 'Add selected (1)').variant, 'primary');
  button(session, 'Add selected (1)').onClick(); session.render(); session.render();
  assert.deepEqual(session.patches.at(-1).productIds, ['b', 'missing', 'a']);
  assert.equal(selectedActions().length, 0);
  nodes(session.tree, (n) => n.props['aria-label'] === 'Select B in the catalog')[0].props.onChange(); session.render();
  assert.ok(button(session, 'Move selected (1)'));
  assert.ok(button(session, 'Remove selected (1)'));
});

test('add and remove actions move focus to the panel search before their controls disappear', async () => {
  const session = await productSession([{ id: 'a', sku: 'A' }, { id: 'b', sku: 'B' }], { selectionMode: 'explicit', productIds: ['b'] }); session.render();
  let focused = 0;
  const panels = nodes(session.tree, (n) => n.type === 'section' && n.props.className?.includes('catalog-product-panel'));
  for (const panel of panels) panel.props.ref.current = { querySelector: () => ({ focus() { focused += 1; } }) };
  const action = { contains: () => true };
  const oldDocument = global.document;
  global.document = { activeElement: action };
  try {
    nodes(session.tree, (n) => n.props['aria-label'] === 'Add A to the catalog')[0].props.onClick({ currentTarget: action }); session.render();
    assert.equal(focused, 1);
    nodes(session.tree, (n) => n.props['aria-label'] === 'Select B in the catalog')[0].props.onChange(); session.render();
    button(session, 'Remove selected (1)').onClick({ currentTarget: action }); session.render();
    assert.equal(focused, 2);
  } finally { global.document = oldDocument; }
});
