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
    refreshDashboard: async () => {}, refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {}, refreshHouseRate: async () => {},
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
    refreshDashboard: async () => {}, refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {}, refreshHouseRate: async () => {},
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

test('company switch locks old-company editors only after their stable flush and unlocks after acknowledgement', async () => {
  const { createCompaniesSlice, registerCompanySwitchFlusher } = await loadSwitchSlice();
  let resolveSwitch;
  const switchGate = new Promise((resolve) => { resolveSwitch = resolve; });
  const state = {
    activeCompanyId: 'company-1', addToast() {}, applyActiveCompanyContext(id) { state.activeCompanyId = id; },
    refreshBrands: async () => {}, refreshCategories: async () => {}, refreshProducts: async () => {}, refreshDashboard: async () => {},
    refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {}, refreshHouseRate: async () => {},
  };
  Object.assign(state, createCompaniesSlice((patch) => Object.assign(state, patch), () => state));
  global.window = { api: { companies: { setActive: async () => switchGate, getActiveId: async () => state.activeCompanyId } } };
  let sawUnlockedFlush = false;
  const unregister = registerCompanySwitchFlusher(async () => { sawUnlockedFlush = state.companySwitching === false; });
  try {
    const switching = state.setActiveCompany('company-2');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sawUnlockedFlush, true);
    assert.equal(state.companySwitching, true);
    resolveSwitch();
    await switching;
    assert.equal(state.companySwitching, false);
  } finally { unregister(); }
});

test('failed backend company switch unlocks the current editor', async () => {
  const { createCompaniesSlice } = await loadSwitchSlice();
  const state = {
    activeCompanyId: 'company-1', addToast() {}, applyActiveCompanyContext(id) { state.activeCompanyId = id; },
    refreshBrands: async () => {}, refreshCategories: async () => {}, refreshProducts: async () => {}, refreshDashboard: async () => {},
    refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {}, refreshHouseRate: async () => {},
  };
  Object.assign(state, createCompaniesSlice((patch) => Object.assign(state, patch), () => state));
  state.activeCompanyId = 'company-1';
  global.window = { api: { companies: {
    setActive: async () => { throw new Error('offline'); }, getActiveId: async () => 'company-1',
  } } };
  await state.setActiveCompany('company-2');
  assert.equal(state.companySwitching, false);
  assert.equal(state.activeCompanyId, 'company-1');
});

test('queued company switches stay locked until the latest backend company is applied', async () => {
  const { createCompaniesSlice } = await loadSwitchSlice();
  const gates = [];
  const state = {
    activeCompanyId: 'company-1', addToast() {}, applyActiveCompanyContext(id) { state.activeCompanyId = id; },
    refreshBrands: async () => {}, refreshCategories: async () => {}, refreshProducts: async () => {}, refreshDashboard: async () => {},
    refreshExportProfiles: async () => {}, refreshAiPrompts: async () => {}, refreshAiTasks: async () => {}, refreshHouseRate: async () => {},
  };
  Object.assign(state, createCompaniesSlice((patch) => Object.assign(state, patch), () => state));
  state.activeCompanyId = 'company-1';
  global.window = { api: { companies: {
    setActive: async () => new Promise((resolve) => gates.push(resolve)),
    getActiveId: async () => state.activeCompanyId,
  } } };
  const first = state.setActiveCompany('company-2');
  const second = state.setActiveCompany('company-3');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.companySwitching, true);
  gates[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.companySwitching, true);
  assert.equal(state.activeCompanyId, 'company-1');
  gates[1]();
  await Promise.all([first, second]);
  assert.equal(state.activeCompanyId, 'company-3');
  assert.equal(state.companySwitching, false);
});
