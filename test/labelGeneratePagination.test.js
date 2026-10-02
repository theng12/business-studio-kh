const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function makeReactHarness(storeState) {
  const hookValues = [];
  const effectValues = [];
  let hookIndex = 0;
  let output = null;

  function useState(initial) {
    const index = hookIndex++;
    if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial;
    return [hookValues[index], (next) => {
      hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next;
    }];
  }

  function useRef(initial) {
    const index = hookIndex++;
    if (!(index in hookValues)) hookValues[index] = { current: initial };
    return hookValues[index];
  }

  function useMemo(factory, deps) {
    const index = hookIndex++;
    const previous = hookValues[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hookValues[index] = { deps, value: factory() };
    }
    return hookValues[index].value;
  }

  function useCallback(callback, deps) {
    return useMemo(() => callback, deps);
  }

  function useEffect(effect, deps) {
    const index = hookIndex++;
    const previous = effectValues[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      if (previous?.cleanup) previous.cleanup();
      effectValues[index] = { deps, effect, ran: false };
    }
  }

  const jsx = (type, props, key) => ({ type, key, props: props || {} });
  const react = { useState, useRef, useMemo, useCallback, useEffect, createElement: jsx };
  const zustand = {
    create: () => {
      const store = (selector) => selector(storeState);
      store.getState = () => storeState;
      return store;
    },
  };

  return {
    react,
    zustand,
    jsxRuntime: { jsx, jsxs: jsx, Fragment: 'fragment' },
    render(Component) {
      hookIndex = 0;
      output = Component();
      for (const entry of effectValues) {
        if (entry && !entry.ran) {
          entry.ran = true;
          entry.cleanup = entry.effect();
        }
      }
      return output;
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
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

async function loadComponent(harness) {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/LabelStudio/LabelGenerate.jsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  const wrappedRequire = (id) => {
    if (id === 'react') return harness.react;
    if (id === 'react/jsx-runtime') return harness.jsxRuntime;
    if (id === 'zustand') return harness.zustand;
    return req(id);
  };
  fn(wrappedRequire, mod, mod.exports);
  return mod.exports.LabelGenerate;
}

test('label generator paginates and Add visible targets only the displayed page', async () => {
  const products = Array.from({ length: 251 }, (_, i) => ({ id: `product-${i}`, sku: `SKU-${i}`, name: `Product ${i}` }));
  const storeState = { activeCompanyId: 'company-a', products, addToast() {} };
  let generatedIds = null;
  const api = {
    events: { onProgress: () => () => {} },
    files: { pickFolder: async () => '/tmp/labels' },
    labels: {
      listTemplates: async () => [{ id: 'template-a', name: 'A', widthMm: 40, heightMm: 20 }],
      listPrinters: async () => [],
      generate: async ({ productIds }) => { generatedIds = productIds; return { files: ['labels.pdf'] }; },
    },
  };
  global.window = { api };
  const harness = makeReactHarness(storeState);
  const LabelGenerate = await loadComponent(harness);
  let output = harness.render(LabelGenerate);
  for (let i = 0; i < 5; i += 1) {
    const paginator = findAll(output, (node) => node.type?.name === 'Pagination')[0];
    assert.ok(paginator, 'expected shared Pagination in the product picker');
    const paginationTree = paginator.type(paginator.props);
    const next = findAll(paginationTree, (node) => node.type === 'button' && textOf(node).includes('Next'))[0];
    next.props.onClick();
    output = harness.render(LabelGenerate);
  }

  const visibleLabels = findAll(output, (node) => node.type === 'label' && textOf(node).startsWith('SKU-'));
  assert.equal(visibleLabels.length, 1);
  assert.equal(textOf(visibleLabels[0]), 'SKU-250Product 250No barcode');

  const selectVisible = findAll(output, (node) => node.type === 'button' && textOf(node) === 'Add visible')[0];
  selectVisible.props.onClick();
  output = harness.render(LabelGenerate);
  const selectedLabels = findAll(output, (node) => node.type === 'label' && node.props.className === 'is-selected');
  assert.equal(selectedLabels.length, 1);
  assert.equal(textOf(selectedLabels[0]), 'SKU-250Product 250No barcode');

  const folderButton = findAll(output, (node) => node.type?.name === 'Button' && textOf(node).includes('Choose output folder'))[0];
  await folderButton.props.onClick();
  output = harness.render(LabelGenerate);
  const generateButton = findAll(output, (node) => node.type?.name === 'Button' && textOf(node) === 'Generate files')[0];
  await generateButton.props.onClick();
  assert.deepEqual(generatedIds, ['product-250']);
});

test('label generator clears old selection/template and ignores delayed prior-company templates', async () => {
  const storeState = { activeCompanyId: 'company-a', products: [{ id: 'product-a', sku: 'A', name: 'A' }], addToast() {} };
  const pending = new Map();
  const api = {
    events: { onProgress: () => () => {} },
    labels: {
      listTemplates: (companyId) => new Promise((resolve) => pending.set(companyId, resolve)),
      listPrinters: async () => [],
    },
  };
  global.window = { api };
  const harness = makeReactHarness(storeState);
  const LabelGenerate = await loadComponent(harness);
  let output = harness.render(LabelGenerate);
  const firstCheckbox = findAll(output, (node) => node.type === 'input' && node.props.type === 'checkbox')[0];
  firstCheckbox.props.onChange();
  output = harness.render(LabelGenerate);
  assert.equal(findAll(output, (node) => node.type === 'label' && node.props.className === 'is-selected').length, 1);

  storeState.activeCompanyId = 'company-b';
  harness.render(LabelGenerate);
  output = harness.render(LabelGenerate);
  assert.equal(findAll(output, (node) => node.type === 'label' && node.props.className === 'is-selected').length, 0);

  pending.get('company-b')([{ id: 'template-b', name: 'B', widthMm: 40, heightMm: 20 }]);
  await Promise.resolve();
  pending.get('company-a')([{ id: 'template-a', name: 'A', widthMm: 40, heightMm: 20 }]);
  await Promise.resolve();
  output = harness.render(LabelGenerate);
  const templateSelect = findAll(output, (node) => node.type?.name === 'Select')[0];
  assert.equal(templateSelect.props.value, 'template-b');
  assert.equal(textOf(templateSelect), 'B · 40×20mm');
});
