const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { build } = require('esbuild');
const { runInNewContext } = require('node:vm');
const testUrl = require('node:url').pathToFileURL(__filename);
let buildSettingsPatch, createCompanySaveQueue, amountToMinor, minorToAmount,
  isUnknownMutationOutcome, rateSetMatchesPayload, policyConfirmationPatch,
  salaryTaxDraft, serializeRateSetDraft, rateSetToDraft;
test.before(async () => {
  ({ buildSettingsPatch, createCompanySaveQueue, amountToMinor, minorToAmount,
    isUnknownMutationOutcome, rateSetMatchesPayload, policyConfirmationPatch,
    salaryTaxDraft, serializeRateSetDraft, rateSetToDraft } = await import('../renderer/modules/People/payrollSettingsModel.js'));
});

test('deduction percentages accept fractions within bounds and blank optional sources become null', () => {
  assert.deepEqual(buildSettingsPatch({ maxDeductionPercent: '12.5', rateSource: ' ', nssfRateSource: '', loanRateSource: null }),
    { maxDeductionPercent: 12.5, rateSource: null, nssfRateSource: null, loanRateSource: null });
  for (const value of ['', -1, 101, Infinity]) assert.equal(buildSettingsPatch({ maxDeductionPercent: value }), null);
});

test('tax fields require explicit values while explicit zero remains valid', () => {
  for (const key of ['spouseAllowanceKhr', 'dependentAllowanceKhr', 'nonResidentPercent', 'fringeBenefitPercent']) {
    const draft = salaryTaxDraft();
    draft.tax[key] = '';
    assert.throws(() => serializeRateSetDraft(draft), /required/);
    draft.tax[key] = '0';
    assert.equal(serializeRateSetDraft(draft).tax[key], 0);
  }
});

test('rate sets round trip shared and overriding NSSF bands without inventing component overrides', () => {
  const nssf = { bands: [{ upperKhr: null, baseKhr: 1200000 }], components: [
    { key: 'health', employeePercent: 0, employerPercent: 2.6 },
    { key: 'pension', employeePercent: 2, employerPercent: 2, bands: [{ upperKhr: null, baseKhr: 1500000 }] },
  ] };
  const saved = { name: 'Shared', effectiveFrom: '2026-01-01', nssf, tax: null };
  assert.deepEqual(serializeRateSetDraft(rateSetToDraft(saved)).nssf, nssf);
});

test('editing an existing rate set sends its shared and component NSSF tables through the actual save handler', async () => {
  const saved = { id: 'existing', status: 'draft', name: 'Shared', effectiveFrom: '2026-01-01', tax: null, nssf: {
    bands: [{ upperKhr: null, baseKhr: 1200000 }],
    components: [{ key: 'health', employeePercent: 0, employerPercent: 2.6 }, { key: 'pension', employeePercent: 2, employerPercent: 2, bands: [{ upperKhr: null, baseKhr: 1500000 }] }],
  } };
  let input;
  const h = await settingsHarness({ listRateSets: async () => [saved], saveRateSet: async (next) => { input = next; return { ...next, id: 'new', status: 'draft' }; } });
  h.change('Rate-set name', 'Renamed'); await h.button('Save statutory draft').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(input.nssf)), saved.nssf);
  assert.equal(input.id, 'existing');
});

test('reconciliation ignores component and object-key ordering but preserves band and bracket ordering', () => {
  const payload = { name: 'Draft', nssf: { components: [
    { key: 'pension', employeePercent: 2, employerPercent: 2 },
    { key: 'health', employeePercent: 0, employerPercent: 2.6 },
  ], bands: [{ upperKhr: 500000, baseKhr: 475000 }, { upperKhr: null, baseKhr: 1200000 }] }, tax: { brackets: [{ upperKhr: 1500000, ratePercent: 0 }, { upperKhr: null, ratePercent: 20 }] } };
  const saved = structuredClone(payload);
  saved.nssf.components.reverse();
  saved.nssf.components[0] = { employerPercent: 2.6, key: 'health', employeePercent: 0 };
  assert.equal(rateSetMatchesPayload(saved, payload), true);
  saved.nssf.bands.reverse();
  assert.equal(rateSetMatchesPayload(saved, payload), false);
  saved.nssf.bands.reverse();
  saved.tax.brackets.reverse();
  assert.equal(rateSetMatchesPayload(saved, payload), false);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Controlled hooks run the actual JSX and async handlers; only store, IPC and shared UI boundaries are substituted.
async function settingsHarness(api = {}) {
  const slots = [], effects = [], timers = new Map();
  let cursor = 0, nextId = 0, tree;
  const context = { company: 'a', admin: true };
  const element = (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children.length ? children : props?.children } });
  const react = {
    createElement: element, Fragment: 'fragment',
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback: (fn) => fn, useId: () => `control-${++nextId}`,
    useEffect(fn, deps) { const i = cursor++; const old = slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const ui = Object.fromEntries(['Badge', 'Button', 'Input', 'Select', 'Textarea'].map((name) => [name, (props) => element(name.toLowerCase(), props)]));
  ui.Field = ({ label, children }) => { const id = react.useId(); return element('field', {}, element('label', { htmlFor: id }, label), children({ id })); };
  const store = (select) => select({ activeCompanyId: context.company, addToast() {} });
  store.getState = () => ({ activeCompanyId: context.company });
  const defaults = { payday: 10, maxDeductionPercent: 100, payCycle: 'monthly', monthlyDivisor: 'scheduled_working_days', installmentCurrency: 'USD' };
  const payroll = { getSettings: async () => ({ ...defaults }), listRateSets: async () => [], updateSettings: async ({ patch }) => ({ ...defaults, ...patch }), ...api };
  const result = await build({ entryPoints: [new URL('../renderer/modules/People/PayrollSettings.jsx', testUrl).pathname], bundle: true, write: false, format: 'cjs', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', banner: { js: 'const React = require("react");' }, plugins: [{ name: 'boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, importer }) => importer && !path.endsWith('payrollSettingsModel.js') ? { path, external: true } : undefined);
  } }] });
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date, Intl, setTimeout: (fn) => { const id = ++nextId; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id), window: { api: { payroll } }, require(path) {
    if (path === 'react') return react;
    if (path.endsWith('/ui.jsx')) return ui;
    if (path.endsWith('/store/index.js')) return { useAppStore: store };
    if (path.endsWith('/Sidebar.jsx')) return { useUserCaps: () => context.admin ? ['*'] : ['payroll.manage'] };
    if (path.endsWith('/capabilities.js')) return { hasCap: (caps, cap) => caps.includes('*') || caps.includes(cap) };
    if (path.endsWith('/companySwitch.js')) return { registerCompanySwitchFlusher: () => () => {} };
    if (path.endsWith('/hrHooks.js')) return { useHrTick: () => 0 };
    if (path.endsWith('/ConfirmModal.jsx')) return { confirm: async () => true };
    if (path.endsWith('/SaveStatus.jsx')) return { SaveStatus: (props) => element('save-status', props) };
    if (path.endsWith('/PageHeader.jsx')) return { PageHeader: (props) => element('header', {}, props.actions) };
    throw new Error(path);
  } });
  function expand(node) {
    if (Array.isArray(node)) return node.flatMap(expand);
    if (!node || typeof node !== 'object') return node == null ? [] : [node];
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return [{ ...node, props: { ...node.props, children: expand(node.props.children) } }];
  }
  const nodes = () => { const all = []; const visit = (node) => { if (typeof node !== 'object') return; all.push(node); node.props.children?.forEach(visit); }; tree.forEach(visit); return all; };
  const text = (node) => typeof node === 'object' ? (node.props.children || []).map(text).join('') : String(node);
  const render = (runEffects = true) => { cursor = 0; tree = expand(module.exports.PayrollSettings()); if (runEffects) effects.splice(0).forEach((fn) => fn()); return tree; };
  const settle = async () => { await new Promise(setImmediate); render(); await new Promise(setImmediate); render(); };
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node) === label);
  const change = (label, value) => {
    const row = nodes().find((node) => node.props.className === 'setting-row' && text(node).startsWith(label));
    const field = nodes().find((node) => node.type === 'field' && text(node).startsWith(label));
    const root = row || field;
    const descend = (node) => ['input', 'select', 'textarea'].includes(node.type) ? node : node.props?.children?.map(descend).find(Boolean);
    descend(root).props.onChange({ target: { value } }); render();
  };
  render(); await settle();
  return { context, render, settle, button, change, nodes, text, fireTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); }, save: () => nodes().find((node) => node.type === 'save-status') };
}

test('statutory save completion keeps later editor edits and uses the returned draft ID', async () => {
  const pending = deferred(), calls = [];
  const h = await settingsHarness({ saveRateSet: (input) => { calls.push(input); return calls.length === 1 ? pending.promise : Promise.resolve({ ...input, id: 'second', status: 'draft' }); } });
  await h.button('Use sourced salary-tax draft').props.onClick(); h.render();
  const task = h.button('Save statutory draft').props.onClick();
  h.change('Rate-set name', 'Later edits');
  pending.resolve({ ...serializeRateSetDraft(salaryTaxDraft()), id: 'saved', status: 'draft' });
  await task; h.render();
  assert.equal(h.nodes().find((n) => n.type === 'input' && n.props.value === 'Later edits')?.props.value, 'Later edits');
  assert.equal(h.button('Save statutory draft').props.disabled, false);
  assert.equal(h.button('Confirm after professional review').props.disabled, true);
  await h.button('Save statutory draft').props.onClick(); h.render();
  assert.equal(calls[1].id, 'saved');
  assert.equal(calls[1].name, 'Later edits');
});

for (const outcome of ['success', 'known failure']) {
  test(`ordinary autosave resumes after statutory ${outcome} consumes its debounce`, async () => {
    const pending = deferred(), calls = [];
    const h = await settingsHarness({
      saveRateSet: () => pending.promise,
      updateSettings: async (input) => { calls.push(input); return { payday: input.patch.payday }; },
    });
    await h.button('Use sourced salary-tax draft').props.onClick(); h.render();
    const task = h.button('Save statutory draft').props.onClick();
    h.change('Monthly payday', '12'); h.fireTimers(); await h.settle();
    assert.equal(calls.length, 0);
    assert.equal(h.save().props.state, 'dirty');
    if (outcome === 'success') pending.resolve({ ...serializeRateSetDraft(salaryTaxDraft()), id: 'saved', status: 'draft' });
    else pending.reject(new Error('Draft rejected'));
    await task; h.render(); h.fireTimers(); await h.settle();
    assert.deepEqual(calls.map((input) => [input.companyId, input.patch.payday]), [['a', 12]]);
    assert.equal(h.save().props.state, 'saved');
    h.fireTimers(); await h.settle(); assert.equal(calls.length, 1);
  });
}

test('consumed autosave stays frozen after an unknown statutory save until exact reconciliation', async () => {
  const pending = deferred(), calls = [];
  let saved = [], readFailure = false;
  const h = await settingsHarness({
    saveRateSet: () => pending.promise,
    listRateSets: async () => { if (readFailure) throw new Error('Read failed'); return saved; },
    updateSettings: async (input) => { calls.push(input); return { payday: input.patch.payday }; },
  });
  await h.button('Use sourced salary-tax draft').props.onClick(); h.render();
  const task = h.button('Save statutory draft').props.onClick();
  h.change('Monthly payday', '12'); h.fireTimers(); await h.settle();
  pending.reject(Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' }));
  await task; h.render(); h.fireTimers(); await h.settle(); assert.equal(calls.length, 0);
  for (const fail of [true, false]) {
    readFailure = fail;
    await h.button('Refresh saved versions').props.onClick(); h.render();
    h.fireTimers(); await h.settle(); assert.equal(calls.length, 0);
  }
  saved = [{ ...serializeRateSetDraft(salaryTaxDraft()), id: 'saved', status: 'draft' }];
  await h.button('Refresh saved versions').props.onClick(); h.render();
  h.fireTimers(); await h.settle();
  assert.deepEqual(calls.map((input) => input.patch.payday), [12]);
  assert.equal(h.save().props.state, 'saved');
});

test('consumed autosave resumes after the exact statutory confirmation retry, not an unresolved retry', async () => {
  const pending = deferred(), calls = [], confirmations = [];
  const saved = { ...serializeRateSetDraft(salaryTaxDraft()), id: 'saved', status: 'draft' };
  const h = await settingsHarness({
    listRateSets: async () => [saved],
    confirmRateSet: (input) => {
      confirmations.push(input);
      if (confirmations.length === 1) return pending.promise;
      if (confirmations.length === 2) return Promise.reject(new Error('Still unavailable'));
      return Promise.resolve({ ...saved, status: 'confirmed' });
    },
    updateSettings: async (input) => { calls.push(input); return { payday: input.patch.payday }; },
  });
  const task = h.button('Confirm after professional review').props.onClick();
  h.change('Monthly payday', '12'); h.fireTimers(); await h.settle();
  pending.reject(Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' }));
  await task; h.render();
  await h.button('Retry same confirmation').props.onClick(); h.render();
  h.fireTimers(); await h.settle(); assert.equal(calls.length, 0);
  await h.button('Retry same confirmation').props.onClick(); h.render();
  h.fireTimers(); await h.settle();
  assert.deepEqual(confirmations[0], confirmations[1]);
  assert.deepEqual(confirmations[0], confirmations[2]);
  assert.deepEqual(calls.map((input) => input.patch.payday), [12]);
  assert.equal(h.save().props.state, 'saved');
});

for (const cancel of ['revoke admin', 'switch company', 'return to company']) {
  test(`resumed autosave cannot write after ${cancel}`, async () => {
    const pending = deferred(), calls = [];
    const h = await settingsHarness({ saveRateSet: () => pending.promise, updateSettings: async (input) => { calls.push(input); return {}; } });
    await h.button('Use sourced salary-tax draft').props.onClick(); h.render();
    const task = h.button('Save statutory draft').props.onClick();
    h.change('Monthly payday', '12'); h.fireTimers(); await h.settle();
    pending.resolve({ ...serializeRateSetDraft(salaryTaxDraft()), id: 'saved', status: 'draft' });
    await task; h.render();
    if (cancel === 'revoke admin') h.context.admin = false;
    else h.context.company = 'b';
    h.render(); await h.settle();
    if (cancel === 'return to company') { h.context.company = 'a'; h.render(); await h.settle(); }
    h.fireTimers(); await h.settle(); assert.equal(calls.length, 0);
  });
}

test('a rate save may update history but cannot replace a different editor opened while awaiting it', async () => {
  const pending = deferred();
  const h = await settingsHarness({ saveRateSet: () => pending.promise });
  await h.button('Use sourced salary-tax draft').props.onClick(); h.render();
  const task = h.button('Save statutory draft').props.onClick();
  h.button('New rate-set draft').props.onClick(); await h.settle(); h.change('Rate-set name', 'Different editor');
  pending.resolve({ ...serializeRateSetDraft(salaryTaxDraft()), id: 'saved', status: 'draft' });
  await task; h.render();
  assert.ok(h.nodes().some((n) => n.type === 'input' && n.props.value === 'Different editor'), JSON.stringify(h.nodes().filter((n) => n.type === 'input').map((n) => n.props.value)));
  assert.equal(h.button('Confirm after professional review').props.disabled, true);
});

test('A to B to A rejects an old statutory save completion', async () => {
  const pending = deferred();
  const h = await settingsHarness({ saveRateSet: () => pending.promise });
  await h.button('Use sourced salary-tax draft').props.onClick(); h.render();
  const task = h.button('Save statutory draft').props.onClick();
  h.context.company = 'b'; h.render(); await h.settle();
  h.context.company = 'a'; h.render(); await h.settle();
  await h.button('Use sourced salary-tax draft').props.onClick(); h.render(); h.change('Rate-set name', 'New visit');
  pending.resolve({ ...serializeRateSetDraft(salaryTaxDraft()), id: 'old', status: 'draft' });
  await task; h.render();
  assert.ok(h.nodes().some((n) => n.type === 'input' && n.props.value === 'New visit'));
});

test('an unknown v1 settings save freezes new writes, preserves v2, and retries only v1', async () => {
  const pending = deferred(), calls = [];
  const h = await settingsHarness({ updateSettings: ({ companyId, patch }) => { calls.push({ companyId, patch }); return calls.length === 1 ? pending.promise : Promise.resolve({ payday: patch.payday }); } });
  h.change('Monthly payday', '11'); h.fireTimers(); await h.settle();
  h.change('Monthly payday', '12');
  pending.reject(Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' })); await h.settle();
  assert.equal(h.save().props.state, 'error');
  h.fireTimers(); await h.settle(); assert.equal(calls.length, 1);
  await h.save().props.onSave(); h.render();
  assert.deepEqual(calls.map((c) => c.patch.payday), [11, 11]);
  assert.ok(h.nodes().some((n) => n.type === 'input' && n.props.value === '12'));
  assert.equal(h.save().props.state, 'dirty');
  h.fireTimers(); await h.settle();
  assert.deepEqual(calls.map((c) => c.patch.payday), [11, 11, 12]);
});

test('unknown ordinary writes block statutory writes even through a previously captured action', async () => {
  const pending = deferred(), rateCalls = [];
  const h = await settingsHarness({ updateSettings: () => pending.promise, saveRateSet: (input) => { rateCalls.push(input); } });
  await h.button('Use sourced salary-tax draft').props.onClick(); h.render();
  const saveRate = h.button('Save statutory draft').props.onClick;
  h.change('Monthly payday', '11'); h.fireTimers(); await h.settle();
  pending.reject(Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' })); await h.settle();
  await saveRate(); assert.equal(rateCalls.length, 0);
});

test('unknown settings writes remain frozen across A to B to A', async () => {
  const pending = deferred(), calls = [];
  const h = await settingsHarness({ updateSettings: ({ companyId, patch }) => { calls.push({ companyId, patch }); return calls.length === 1 ? pending.promise : Promise.resolve({ payday: patch.payday }); } });
  h.change('Monthly payday', '11'); h.fireTimers(); await h.settle();
  h.change('Monthly payday', '12'); h.context.company = 'b'; h.render(); await h.settle();
  pending.reject(Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' })); await h.settle();
  h.context.company = 'a'; h.render(); await h.settle();
  assert.equal(h.save().props.state, 'error');
  assert.ok(h.nodes().some((n) => n.type === 'input' && n.props.value === '12'));
  h.fireTimers(); await h.settle(); assert.equal(calls.length, 1);
});

test('revoking admin before debounce prevents the captured callback from writing', async () => {
  const calls = [];
  const h = await settingsHarness({ updateSettings: (input) => { calls.push(input); return Promise.resolve({}); } });
  h.change('Monthly payday', '11'); h.context.admin = false; h.render(); h.fireTimers(); await h.settle();
  assert.deepEqual(calls, []);
});

test('revoking admin before a queued unknown retry starts cancels it but keeps the original payload retryable', async () => {
  const calls = [];
  const h = await settingsHarness({ updateSettings: async (input) => { calls.push(input); if (calls.length === 1) throw Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' }); return { payday: input.patch.payday }; } });
  h.change('Monthly payday', '11'); h.fireTimers(); await h.settle();
  const cancelled = h.save().props.onSave();
  h.context.admin = false; h.render(); await cancelled;
  assert.equal(calls.length, 1);
  h.context.admin = true; h.render(); await h.save().props.onSave(); h.render();
  assert.deepEqual(calls.map((c) => c.patch.payday), [11, 11]);
});

test('initial read error is visible and retry reloads the current request', async () => {
  let attempts = 0;
  const h = await settingsHarness({ getSettings: async () => { if (++attempts === 1) throw new Error('Read denied'); return { payday: 10 }; } });
  assert.ok(h.nodes().some((n) => n.props.role === 'alert' && h.text(n).includes('Read denied')));
  h.button('Retry').props.onClick(); await h.settle();
  assert.equal(attempts, 2); assert.ok(h.save());
});

test('a late initial read failure cannot hide another company or a newer A visit', async () => {
  const old = deferred(); let calls = 0;
  const h = await settingsHarness({ getSettings: () => ++calls === 1 ? old.promise : Promise.resolve({ payday: 10 }) });
  h.context.company = 'b'; h.render(); await h.settle();
  h.context.company = 'a'; h.render(); await h.settle();
  old.reject(new Error('Old read denied')); await h.settle();
  assert.ok(h.save());
  assert.ok(!h.nodes().some((n) => n.props.role === 'alert' && h.text(n).includes('Old read denied')));
});

test('policy confirmation timeout allows the same payload retry without an ordinary settings write', async () => {
  const calls = [];
  const h = await settingsHarness({ updateSettings: async (input) => { calls.push(input); if (calls.length === 1) throw Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' }); return { payday: 10, policyConfirmed: true }; } });
  h.change('Review evidence', 'Accountant reviewed 2026-10-09');
  for (const node of h.nodes().filter((n) => n.type === 'input' && n.props.type === 'checkbox' && !Object.hasOwn(n.props, 'disabled'))) node.props.onChange({ target: { checked: true } });
  h.render(); await h.button('Confirm reviewed policy').props.onClick(); h.render();
  assert.equal(h.button('Retry same policy confirmation').props.disabled, false);
  await h.button('Retry same policy confirmation').props.onClick(); h.render();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(calls[1].patch.policyConfirmed, true);
});

test('policy retry releases a consumed ordinary debounce only after confirming the original payload', async () => {
  const pending = deferred(), calls = [];
  const h = await settingsHarness({ updateSettings: (input) => {
    calls.push(input);
    return calls.length === 1 ? pending.promise : Promise.resolve({ payday: input.patch.payday ?? 10, policyConfirmed: true });
  } });
  h.change('Review evidence', 'Accountant reviewed 2026-10-09');
  for (const node of h.nodes().filter((n) => n.type === 'input' && n.props.type === 'checkbox' && !Object.hasOwn(n.props, 'disabled'))) node.props.onChange({ target: { checked: true } });
  h.render();
  const task = h.button('Confirm reviewed policy').props.onClick();
  // A change handler captured before confirmation disabled the controls.
  h.change('Monthly payday', '12'); h.fireTimers(); await h.settle();
  assert.equal(calls.length, 1);
  pending.reject(Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' }));
  await task; h.render(); h.fireTimers(); await h.settle(); assert.equal(calls.length, 1);
  await h.button('Retry same policy confirmation').props.onClick(); h.render();
  assert.deepEqual(calls[0], calls[1]);
  h.fireTimers(); await h.settle();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].patch.payday, 12);
  assert.equal(calls[2].patch.policyConfirmed, undefined);
  assert.equal(h.save().props.state, 'saved');
});

test('a policy timeout freezes a queued ordinary write and another company may still save', async () => {
  const pending = deferred(), calls = [];
  const h = await settingsHarness({ updateSettings: (input) => { calls.push(input); return calls.length === 1 ? pending.promise : Promise.resolve({ payday: input.patch.payday }); } });
  h.change('Review evidence', 'Accountant reviewed 2026-10-09');
  for (const node of h.nodes().filter((n) => n.type === 'input' && n.props.type === 'checkbox' && !Object.hasOwn(n.props, 'disabled'))) node.props.onChange({ target: { checked: true } });
  h.render();
  const task = h.button('Confirm reviewed policy').props.onClick(); await h.settle();
  // Invoke the real change handler captured before its controls became disabled.
  h.change('Monthly payday', '12');
  pending.reject(Object.assign(new Error('unknown'), { code: 'RPC_OUTCOME_UNKNOWN' })); await task; h.render();
  h.fireTimers(); await h.settle(); assert.equal(calls.length, 1);
  h.context.company = 'b'; h.render(); await h.settle();
  h.change('Monthly payday', '13'); h.fireTimers(); await h.settle();
  assert.deepEqual(calls.map((c) => c.companyId), ['a', 'b']);
});

test('all editable settings controls have an associated label or accessible name', async () => {
  const h = await settingsHarness();
  const labels = new Set(h.nodes().filter((n) => n.type === 'label').map((n) => n.props.htmlFor));
  for (const node of h.nodes().filter((n) => ['input', 'select', 'textarea'].includes(n.type) && n.props.type !== 'checkbox')) {
    assert.ok(node.props['aria-label'] || (node.props.id && labels.has(node.props.id)), `Unnamed ${node.type} with value ${node.props.value}`);
  }
});

test('ordinary settings saves omit the professional confirmation flag and server fields', () => {
  const patch = buildSettingsPatch({
    payCycle: 'monthly',
    payday: 10,
    maxDeductionPercent: 25,
    taxRateKhrPerUsd: 4053,
    rateSource: '{"source":"gdt-nbc"}',
    nssfRateKhrPerUsd: 4060,
    nssfRateSource: 'NSSF monthly notice',
    loanRateKhrPerUsd: 4069,
    loanRateSource: 'Loan evidence',
    policyConfirmed: true,
    policyConfirmedByUserId: 'admin',
    complianceWarning: 'server supplied',
  });

  assert.deepEqual(patch, {
    payCycle: 'monthly',
    payday: 10,
    maxDeductionPercent: 25,
    taxRateKhrPerUsd: 4053,
    rateSource: '{"source":"gdt-nbc"}',
    nssfRateKhrPerUsd: 4060,
    nssfRateSource: 'NSSF monthly notice',
    loanRateKhrPerUsd: 4069,
    loanRateSource: 'Loan evidence',
  });
});

test('loan preset amounts convert to loan minor units by the selected currency', () => {
  assert.equal(amountToMinor('12.34', 'USD'), 1234);
  assert.equal(amountToMinor('12000', 'KHR'), 12000);
  assert.equal(amountToMinor('12.345', 'USD'), NaN);
  assert.equal(minorToAmount(1234, 'USD'), '12.34');
  assert.equal(minorToAmount(12000, 'KHR'), '12000');
});

test('policy confirmation requires explicit non-empty review evidence', () => {
  assert.equal(policyConfirmationPatch('   '), null);
  assert.deepEqual(policyConfirmationPatch('Reviewed by accountant, 2026-10-09'), {
    policySource: 'Reviewed by accountant, 2026-10-09',
    policyConfirmed: true,
  });
});

test('company saves serialize per company without blocking another company', async () => {
  const events = [];
  let release;
  const queue = createCompanySaveQueue(async (companyId, patch) => {
    events.push(`start:${companyId}:${patch.value}`);
    if (patch.value === 1) await new Promise((resolve) => { release = resolve; });
    events.push(`end:${companyId}:${patch.value}`);
  });

  const first = queue('company-a', { value: 1 });
  const second = queue('company-a', { value: 2 });
  const other = queue('company-b', { value: 3 });
  await other;
  assert.deepEqual(events, ['start:company-a:1', 'start:company-b:3', 'end:company-b:3']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events.slice(3), ['end:company-a:1', 'start:company-a:2', 'end:company-a:2']);
});

test('unknown mutation outcomes are recognized even when Electron drops the error code', () => {
  assert.equal(isUnknownMutationOutcome(Object.assign(new Error('validation failed'), { code: 'BAD_REQUEST' })), false);
  assert.equal(isUnknownMutationOutcome(new Error('The server Mac stopped answering before it confirmed this change. The operation may still have completed; refresh the current data before retrying.')), true);
  assert.equal(isUnknownMutationOutcome(new Error('The connection to the server Mac dropped. It may be asleep, restarting, or off Tailscale. This Mac keeps retrying on its own.')), true);
  assert.equal(isUnknownMutationOutcome(new Error('The server Mac is reachable but is not accepting connections yet.')), false);
  assert.equal(isUnknownMutationOutcome(Object.assign(new Error('timed out'), { code: 'RPC_OUTCOME_UNKNOWN' })), true);
});

test('salary-tax draft uses sourced GDT values without inventing NSSF settings', () => {
  const draft = salaryTaxDraft();
  assert.equal(draft.name, 'Cambodia salary tax (draft)');
  assert.equal(draft.effectiveFrom, '2024-09-19');
  assert.deepEqual(draft.nssfComponents, []);
  assert.deepEqual(draft.taxBrackets, [
    { upperKhr: '1500000', ratePercent: '0' },
    { upperKhr: '2000000', ratePercent: '5' },
    { upperKhr: '8500000', ratePercent: '10' },
    { upperKhr: '12500000', ratePercent: '15' },
    { upperKhr: '', ratePercent: '20' },
  ]);
  assert.match(draft.sourceNote, /Prakas No\. 575/);
  assert.match(draft.sourceNote, /Sub-Decree No\. 48/);
  assert.equal(draft.tax.maxDependents, '');
});

test('rate-set serialization preserves per-scheme bands and null open limits', () => {
  const payload = serializeRateSetDraft({
    name: 'Working draft',
    effectiveFrom: '2026-01-01',
    effectiveTo: '',
    sourceNote: 'Source pending',
    nssfComponents: [{
      key: 'occupational_risk',
      employeePercent: '0',
      employerPercent: '0.8',
      bands: [{ upperKhr: '500000', baseKhr: '475000' }, { upperKhr: '', baseKhr: '1200000' }],
    }],
    taxBrackets: [],
    tax: {
      spouseAllowanceKhr: '', dependentAllowanceKhr: '', maxDependents: '',
      nonResidentPercent: '', fringeBenefitPercent: '', pensionDeductible: false,
    },
  });

  assert.equal(payload.effectiveTo, null);
  assert.deepEqual(payload.nssf.components[0].bands, [
    { upperKhr: 500000, baseKhr: 475000 },
    { upperKhr: null, baseKhr: 1200000 },
  ]);
  assert.equal(payload.tax, null);
});

test('saved statutory versions can be reconciled against the exact draft payload', () => {
  const payload = { name: 'Draft', effectiveFrom: '2026-01-01', effectiveTo: null, sourceNote: null, nssf: { components: [] }, tax: null };
  assert.equal(rateSetMatchesPayload({ id: 'set-1', status: 'draft', ...payload }, payload), true);
  assert.equal(rateSetMatchesPayload({ id: 'set-2', status: 'draft', ...payload, name: 'Other' }, payload), false);
});

test('the People UI scopes requests by company and applies fetched FX only from an explicit action', async () => {
  const source = await readFile(new URL('../renderer/modules/People/PayrollSettings.jsx', testUrl), 'utf8');
  assert.match(source, /useAppStore\(\(s\) => s\.activeCompanyId\)/);
  assert.match(source, /hasCap\(caps, 'payroll\.manage'\)/);
  assert.match(source, /hasCap\(caps, '\*'\)/);
  assert.match(source, /window\.api\.payroll\.fetchSalaryTaxRate\(\{ companyId, month:/);
  assert.match(source, /JSON\.stringify\(proposal\)/);
  assert.match(source, /Use this proposal/);
  assert.doesNotMatch(source, /asOfDate/);
  assert.match(source, /window\.api\.payroll\.listRateSets\(\{ companyId \}\)/);
  assert.match(source, /window\.api\.payroll\.saveRateSet\(\{ companyId,/);
  assert.match(source, /window\.api\.payroll\.confirmRateSet\(\{ companyId,/);
  assert.match(source, /Reviewed topics: \$\{POLICY_REVIEW_TOPICS\.join\(', '\)\}/);
  assert.match(source, /previousCompanyId\.current === activeCompanyId/);
  assert.match(source, /useHrTick\(\['payroll'\]\)/);
});
