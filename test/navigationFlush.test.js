const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

async function loadNavigation() {
  const esbuild = require('esbuild');
  const source = `
    export { createNavigationSlice } from './renderer/store/navigation.js';
    export { registerCompanySwitchFlusher } from './renderer/lib/companySwitch.js';
  `;
  const out = await esbuild.build({ stdin: { contents: source, resolveDir: ROOT }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('module navigation waits for editor flush before changing routes', async () => {
  const { createNavigationSlice, registerCompanySwitchFlusher } = await loadNavigation();
  const gate = deferred();
  const state = { activeCompanyId: 'company-1', addToast() {} };
  Object.assign(state, createNavigationSlice((patch) => Object.assign(state, patch), () => state));
  const unregister = registerCompanySwitchFlusher(() => gate.promise);
  try {
    const navigation = state.setActiveModule('socialgrid');
    assert.equal(state.activeModule, 'dashboard');
    gate.resolve();
    assert.equal(await navigation, true);
    assert.equal(state.activeModule, 'socialgrid');
  } finally { unregister(); }
});

test('failed editor flush keeps the current route and reports the error', async () => {
  const { createNavigationSlice, registerCompanySwitchFlusher } = await loadNavigation();
  const messages = [];
  const state = { activeCompanyId: 'company-1', addToast(message, variant) { messages.push({ message, variant }); } };
  Object.assign(state, createNavigationSlice((patch) => Object.assign(state, patch), () => state));
  const unregister = registerCompanySwitchFlusher(async () => { throw new Error('draft save failed'); });
  try {
    assert.equal(await state.setActiveModule('socialgrid'), false);
    assert.equal(state.activeModule, 'dashboard');
    assert.deepEqual(messages, [{ message: "Couldn't leave this editor: draft save failed", variant: 'error' }]);
  } finally { unregister(); }
});

test('context navigation helpers use the same successful flush barrier', async () => {
  const { createNavigationSlice, registerCompanySwitchFlusher } = await loadNavigation();
  const gate = deferred();
  const state = { activeCompanyId: 'company-1', addToast() {} };
  Object.assign(state, createNavigationSlice((patch) => Object.assign(state, patch), () => state));
  const unregister = registerCompanySwitchFlusher(() => gate.promise);
  try {
    const navigation = state.openCatalogProject('catalog-1');
    assert.equal(state.pendingCatalogProjectId, null);
    gate.resolve();
    assert.equal(await navigation, true);
    assert.equal(state.pendingCatalogProjectId, 'catalog-1');
    assert.equal(state.activeModule, 'catalogprojects');
  } finally { unregister(); }
});

test('the latest module request wins while an older navigation is flushing', async () => {
  const { createNavigationSlice, registerCompanySwitchFlusher } = await loadNavigation();
  const gate = deferred();
  const state = { activeCompanyId: 'company-1', addToast() {} };
  Object.assign(state, createNavigationSlice((patch) => Object.assign(state, patch), () => state));
  const unregister = registerCompanySwitchFlusher(() => gate.promise);
  try {
    const staleNavigation = state.setActiveModule('socialgrid');
    assert.equal(await state.setActiveModule('dashboard'), true);
    gate.resolve();
    assert.equal(await staleNavigation, false);
    assert.equal(state.activeModule, 'dashboard');
  } finally { unregister(); }
});

test('a newer context-navigation request invalidates an older awaited route', async () => {
  const { createNavigationSlice, registerCompanySwitchFlusher } = await loadNavigation();
  const gate = deferred();
  const state = { activeCompanyId: 'company-1', addToast() {} };
  Object.assign(state, createNavigationSlice((patch) => Object.assign(state, patch), () => state));
  const unregister = registerCompanySwitchFlusher(() => gate.promise);
  try {
    const first = state.openCatalogProject('catalog-1');
    const second = state.openProductInWorkspace('product-2');
    gate.resolve();
    assert.equal(await first, false);
    assert.equal(await second, true);
    assert.equal(state.activeModule, 'workspace');
    assert.equal(state.activeProductId, 'product-2');
    assert.equal(state.pendingCatalogProjectId, null);
  } finally { unregister(); }
});
