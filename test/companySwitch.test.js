const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

async function loadSwitchSlice() {
  const esbuild = require('esbuild');
  const source = `
    import { createCompaniesSlice } from './renderer/store/companies.js';
    import { registerCompanySwitchFlusher } from './renderer/lib/companySwitch.js';
    export { createCompaniesSlice, registerCompanySwitchFlusher };
  `;
  const out = await esbuild.build({ stdin: { contents: source, resolveDir: ROOT }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test('company switch flushes dirty editor work before the backend active company changes', async () => {
  const { createCompaniesSlice, registerCompanySwitchFlusher } = await loadSwitchSlice();
  let backendCompany = 'company-1';
  let setActiveCalls = 0;
  let flushCalls = 0;
  const errors = [];
  const state = {
    activeCompanyId: 'company-1',
    addToast(message) { errors.push(message); },
    applyActiveCompanyContext(id) { state.activeCompanyId = id; },
    refreshBrands: async () => {}, refreshCategories: async () => {}, refreshProducts: async () => {},
    refreshDashboard: async () => {}, refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {},
  };
  const set = (patch) => Object.assign(state, patch);
  const get = () => state;
  const slice = createCompaniesSlice(set, get);
  Object.assign(state, slice);
  global.window = { api: { companies: {
    async setActive(id) { setActiveCalls += 1; assert.equal(backendCompany, 'company-1'); backendCompany = id; },
    async getActiveId() { return backendCompany; },
  } } };
  const unregister = registerCompanySwitchFlusher(async () => {
    flushCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(backendCompany, 'company-1');
  });

  await state.setActiveCompany('company-2');
  unregister();
  assert.equal(flushCalls, 1);
  assert.equal(setActiveCalls, 1);
  assert.equal(backendCompany, 'company-2');
  assert.equal(state.activeCompanyId, 'company-2');
  assert.deepEqual(errors, []);
});

test('failed pre-switch flush leaves the backend and renderer on the old company', async () => {
  const { createCompaniesSlice, registerCompanySwitchFlusher } = await loadSwitchSlice();
  let backendCompany = 'company-1';
  let setActiveCalls = 0;
  const errors = [];
  const state = {
    activeCompanyId: 'company-1',
    addToast(message) { errors.push(message); },
    applyActiveCompanyContext(id) { state.activeCompanyId = id; },
    refreshBrands: async () => {}, refreshCategories: async () => {}, refreshProducts: async () => {},
    refreshDashboard: async () => {}, refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {},
  };
  const set = (patch) => Object.assign(state, patch);
  const get = () => state;
  const slice = createCompaniesSlice(set, get);
  Object.assign(state, slice);
  global.window = { api: { companies: {
    async setActive() { setActiveCalls += 1; backendCompany = 'company-2'; },
    async getActiveId() { return backendCompany; },
  } } };
  const unregister = registerCompanySwitchFlusher(async () => { throw new Error('draft save failed'); });
  await state.setActiveCompany('company-2');
  unregister();
  assert.equal(setActiveCalls, 0);
  assert.equal(backendCompany, 'company-1');
  assert.equal(state.activeCompanyId, 'company-1');
  assert.match(errors[0], /Couldn't switch company/);
});
