/**
 * Regression for the rows ImportModal builds before the dry-run.
 *
 * A mapped-but-blank cell must reach `products:bulkUpsert` as an explicit null.
 * It used to be dropped from the row object, which made the server-side
 * Overwrite policy behave like Merge for every blank cell — so "blank cells
 * overwrite existing values" was never true. Merge ignores the null; Overwrite
 * clears the field.
 *
 * Drives the real component with the established hook harness.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function hookHarness() {
  let cursor = 0;
  let dirty = false;
  let output = null;
  const hooks = [];
  const pendingEffects = [];
  const depsChanged = (p, n) => !p || !n || p.length !== n.length || n.some((v, i) => !Object.is(v, p[i]));
  const React = {
    useState(initial) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, (next) => {
        const value = typeof next === 'function' ? next(hooks[i].value) : next;
        if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; if (!hooks[i]) hooks[i] = { current: initial }; return hooks[i]; },
    useEffect(effect, deps) {
      const i = cursor++;
      const previous = hooks[i];
      const changed = !previous || depsChanged(previous.deps, deps);
      hooks[i] = { deps, cleanup: previous?.cleanup };
      if (changed) pendingEffects.push({ index: i, effect, previous });
    },
    useMemo(factory, deps) {
      const i = cursor++;
      const previous = hooks[i];
      if (!previous || depsChanged(previous.deps, deps)) hooks[i] = { deps, value: factory() };
      return hooks[i].value;
    },
  };
  const jsxRuntime = { Fragment: Symbol('Fragment'), jsx: (t, p) => ({ type: t, props: p || {} }), jsxs: (t, p) => ({ type: t, props: p || {} }) };
  function render(Component, props) {
    cursor = 0; dirty = false; pendingEffects.length = 0;
    output = Component(props);
    for (const { index, effect, previous } of pendingEffects) {
      if (typeof previous?.cleanup === 'function') previous.cleanup();
      hooks[index].cleanup = effect();
    }
  }
  async function settle(Component, props) {
    for (let i = 0; i < 20; i += 1) {
      render(Component, props);
      if (!dirty) return output;
      await Promise.resolve();
    }
    return output;
  }
  return { React, jsxRuntime, settle, getOutput: () => output };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((item) => walk(item, visit));
    else if (v && typeof v === 'object') walk(v, visit);
  }
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
}

function findClickable(root, text) {
  let found = null;
  walk(root, (n) => {
    if (found) return;
    if (n && typeof n === 'object' && n.props && typeof n.props.onClick === 'function' && textOf(n).includes(text)) found = n;
  });
  return found;
}

test('ImportModal keeps a mapped-but-blank cell so Overwrite can clear it', async () => {
  const workbook = {
    fileName: 'blank-cell.xlsx',
    sheets: [{
      name: 'Sheet1',
      headers: ['SKU', 'Name'],
      rowCount: 2,
      rows: [
        { SKU: 'SKU-1', Name: 'Imported' },
        { SKU: 'SKU-2', Name: '' },
      ],
    }],
  };
  const captured = { rows: null };
  const storeState = {
    activeCompanyId: 'company-1',
    brands: [],
    categories: [],
    addToast: () => {},
    async refreshBrands() {}, async refreshCategories() {}, async refreshProducts() {}, async refreshDashboard() {},
    async createBrand({ name }) { return { id: 'brand', name }; },
    async createCategory({ name }) { return { id: 'cat', name }; },
  };
  function useAppStore(selector) { return selector(storeState); }
  useAppStore.getState = () => storeState;

  const api = {
    files: { pickWorkbook: async () => '/tmp/blank-cell.xlsx', parseWorkbook: async () => workbook },
    samples: { generateProductSheet: async () => null },
    products: {
      bulkUpsert: async (_companyId, rows, opts) => {
        captured.rows = rows;
        captured.policy = opts?.conflictPolicy;
        return { inserted: 0, updated: 0, skips: [], changes: [], dryRun: !!opts?.dryRun, conflictPolicy: opts?.conflictPolicy };
      },
    },
  };
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  global.document = { body: { appendChild: () => {}, removeChild: () => {}, classList: { add: () => {}, remove: () => {} } }, documentElement: { setAttribute: () => {} }, createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {} }) };
  global.window = { api, addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) };
  global.navigator = global.navigator || { userAgent: 'node', platform: 'darwin' };

  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/ProductLibrary/ImportModal.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand', '@imgly/background-removal'],
    plugins: [{
      name: 'import-rows-harness',
      setup(build) {
        build.onResolve({ filter: /store\/index\.js$/ }, () => ({ path: 'store-shim', namespace: 'test' }));
        build.onLoad({ filter: /^store-shim$/, namespace: 'test' }, () => ({
          contents: 'module.exports = { useAppStore: globalThis.__useAppStore };',
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  global.__useAppStore = useAppStore;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-import-rows-'));
  const bundlePath = path.join(dir, 'bundle.cjs');
  fs.writeFileSync(bundlePath, out.outputFiles[0].text);
  const harness = hookHarness();
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return harness.React;
    if (request === 'react/jsx-runtime') return harness.jsxRuntime;
    if (request === 'zustand') return { create: () => () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { ImportModal } = require(bundlePath);
    const props = { open: true, onClose: () => {} };
    await harness.settle(ImportModal, props);

    const choose = findClickable(harness.getOutput(), 'Choose file');
    assert.ok(choose, 'Choose file button not found');
    await choose.props.onClick();
    await harness.settle(ImportModal, props);

    const preview = findClickable(harness.getOutput(), 'Preview');
    assert.ok(preview, 'Preview button not found');
    await preview.props.onClick();
    await harness.settle(ImportModal, props);

    assert.ok(Array.isArray(captured.rows) && captured.rows.length === 2, 'both rows must be built');
    const blankRow = captured.rows.find((r) => r.sku === 'SKU-2');
    assert.ok(blankRow, 'the blank-name row must survive');
    assert.ok('name' in blankRow, 'a mapped-but-blank cell must keep its key');
    assert.equal(blankRow.name, null, 'a blank cell must be an explicit null');
    const filledRow = captured.rows.find((r) => r.sku === 'SKU-1');
    assert.equal(filledRow.name, 'Imported', 'a supplied value must be preserved');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
