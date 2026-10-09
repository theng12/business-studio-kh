const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
// Store initialization reads preferences; this isolated process has no saved UI state.
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });

const ROOT = path.join(__dirname, '..');
function load(file, extraExports = '') {
  const input = extraExports ? { stdin: { contents: `${fs.readFileSync(path.join(ROOT, file), 'utf8')}\nexport { ${extraExports} };`, resolveDir: path.dirname(path.join(ROOT, file)), loader: 'jsx' } } : { entryPoints: [path.join(ROOT, file)] };
  const out = esbuild.buildSync({ ...input, bundle: true, write: false,
    format: 'cjs', platform: 'node', external: ['react', 'react-dom/server'], jsx: 'automatic', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}
const modelPath = 'renderer/modules/People/payrollUiModel.js';
const M = fs.existsSync(path.join(ROOT, modelPath)) ? load(modelPath) : {};

test('typed wages preserve cents and whole riel, rejecting rounding, overflow and unknown currencies', () => {
  assert.equal(typeof M.amountMinor, 'function');
  assert.equal(M.amountMinor('12.34', 'USD'), 1234);
  assert.equal(M.amountMinor('1,250', 'KHR'), 1250);
  assert.equal(M.amountMinor('0', 'USD'), 0);
  for (const [value, currency] of [['12.345', 'USD'], ['1.2', 'KHR'], ['-2', 'USD'], ['', 'USD'], ['9e3', 'USD'], ['1,2', 'USD'], ['9007199254740992', 'KHR'], ['2', 'EUR']]) {
    assert.throws(() => M.amountMinor(value, currency));
  }
});

test('run choices follow monthly, advance/settlement and separate-period policy including leap February', () => {
  assert.equal(typeof M.periodChoices, 'function');
  assert.deepEqual(M.periodChoices('2028-02', 'monthly'), [{ value: 'monthly', label: 'Monthly', kind: 'regular', periodStart: '2028-02-01', periodEnd: '2028-02-29' }]);
  assert.deepEqual(M.periodChoices('2026-09', 'twice_monthly_advance').map(x => [x.value, x.kind, x.periodStart, x.periodEnd]), [
    ['advance', 'advance', '2026-09-01', '2026-09-15'], ['settlement', 'settlement', '2026-09-01', '2026-09-30'],
  ]);
  assert.deepEqual(M.periodChoices('2026-09', 'twice_monthly_separate').map(x => [x.kind, x.periodStart, x.periodEnd]), [
    ['regular', '2026-09-01', '2026-09-15'], ['regular', '2026-09-16', '2026-09-30'],
  ]);
  assert.throws(() => M.periodChoices('2026-13', 'monthly'));
  assert.throws(() => M.periodChoices('2026-09', 'unknown'));
});

test('new run carries company, selected staff/statutory set and three separately sourced FX rates', () => {
  assert.equal(typeof M.createRunPayload, 'function');
  const form = { month: '2026-09', period: 'monthly', employeeIds: ['e2', 'e1'], statutoryRateSetId: 's1',
    payDate: '2026-10-10', taxRateKhrPerUsd: '4100', rateSource: 'GDT September',
    nssfRateKhrPerUsd: '4050', nssfRateSource: 'NSSF confirmed', loanRateKhrPerUsd: '4070', loanRateSource: 'Agreed debt FX' };
  assert.deepEqual(M.createRunPayload('c1', form, { payCycle: 'monthly' }, '2026-10-09'), {
    companyId: 'c1', kind: 'regular', periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-10-10', employeeIds: ['e2', 'e1'], statutoryRateSetId: 's1',
    taxRateKhrPerUsd: 4100, rateSource: 'GDT September', nssfRateKhrPerUsd: 4050, nssfRateSource: 'NSSF confirmed', loanRateKhrPerUsd: 4070, loanRateSource: 'Agreed debt FX',
  });
  assert.throws(() => M.createRunPayload('c1', { ...form, employeeIds: ['e1', 'e1'] }, { payCycle: 'monthly' }, '2026-10-09'));
  assert.throws(() => M.createRunPayload('c1', { ...form, rateSource: '' }, { payCycle: 'monthly' }, '2026-10-09'));
  assert.throws(() => M.createRunPayload('c1', { ...form, month: '2026-10' }, { payCycle: 'monthly' }, '2026-10-09'));
});

test('requests drop superseded generations and a company A-B-A round trip cannot revive old A', () => {
  assert.equal(typeof M.requestScope, 'function');
  const scope = M.requestScope('A');
  const first = scope.begin('load');
  const second = scope.begin('load');
  assert.equal(scope.current(first), false);
  assert.equal(scope.current(second), true);
  scope.bind('B'); scope.bind('A');
  assert.equal(scope.current(second), false);
  const last = scope.begin('save'); scope.close();
  assert.equal(scope.current(last), false);
});

test('response guards reject wrong-company nested salary data and malformed monetary responses', () => {
  assert.equal(typeof M.guardRun, 'function');
  const run = { id: 'r1', companyId: 'A', revision: 2, status: 'draft', lines: [{ id: 'l1', companyId: 'A', runId: 'r1', employeeId: 'e1', currency: 'KHR', baseMinor: 1500, grossMinor: 1500, netMinor: 1250, paidMinor: 0, remainingMinor: 1250, blockers: [], snapshot: {} }], payments: [], reviews: [] };
  assert.equal(M.guardRun(run, 'A', 'r1'), run);
  assert.throws(() => M.guardRun(run, 'B'));
  assert.throws(() => M.guardRun({ ...run, lines: [{ ...run.lines[0], companyId: 'B' }] }, 'A'));
  assert.throws(() => M.guardRun({ ...run, lines: [{ ...run.lines[0], netMinor: 1.5 }] }, 'A'));
  assert.throws(() => M.guardRun({ ...run, revision: undefined }, 'A'));
  assert.throws(() => M.guardRun({ ...run, lines: [{ ...run.lines[0], snapshot: { employee: { id: 'e2' } } }] }, 'A'));
  assert.throws(() => M.guardRun({ ...run, payments: [{ id: 'p1', companyId: 'A', lineId: 'other-run-line', amountMinor: 500 }] }, 'A'));
});

test('unknown-outcome retries retain exact operation and payload, reject changes and prevent concurrent duplicates', async () => {
  assert.equal(typeof M.commandBook, 'function');
  const book = M.commandBook(() => 'op-fixed');
  const input = { companyId: 'A', id: 'l1', amountMinor: 1234, method: 'bank', paidAt: '2026-10-09' };
  let calls = 0;
  await assert.rejects(book.send('pay', input, async payload => {
    calls++; assert.deepEqual(payload, { ...input, operationId: 'op-fixed' }); throw new Error('Connection lost after posting');
  }), /Connection lost/);
  input.amountMinor = 999;
  assert.deepEqual(book.pending('A')[0].payload, { companyId: 'A', id: 'l1', amountMinor: 1234, method: 'bank', paidAt: '2026-10-09', operationId: 'op-fixed' });
  await assert.rejects(book.send('pay', input, async () => calls++), /Retry the pending/);
  const retry = book.pending('A')[0];
  let finish;
  const waiting = book.send('pay', retry.payload, payload => new Promise(resolve => { calls++; finish = () => resolve({ id: 'p1', payload }); }));
  await assert.rejects(book.send('pay', retry.payload, async () => calls++), /already running/);
  finish(); const result = await waiting;
  assert.equal(result.payload.operationId, 'op-fixed'); assert.equal(calls, 2);
  assert.deepEqual(book.pending('A'), []);
});

test('reload restores original unknown operation; journal failure prevents a money command being sent', async () => {
  assert.equal(typeof M.commandBook, 'function');
  let saved = null;
  const storage = { getItem: () => saved, setItem(key, value) { saved = value; } };
  const first = M.commandBook(() => 'durable-op', storage);
  await assert.rejects(first.send('pay', { companyId: 'c1', id: 'l1', amountMinor: 1234 }, async () => { throw new Error('Network disconnected'); }));
  const reloaded = M.commandBook(() => 'must-not-be-used', storage);
  const original = reloaded.pending('c1')[0];
  assert.equal(original.payload.operationId, 'durable-op');
  assert.equal(original.payload.amountMinor, 1234);
  await reloaded.send('pay', original.payload, async payload => { assert.equal(payload.operationId, 'durable-op'); return { id: 'p1' }; });
  assert.deepEqual(JSON.parse(saved), []);
  let calls = 0;
  const blocked = M.commandBook(() => 'op', { getItem: () => null, setItem() { throw new Error('Storage denied'); } });
  await assert.rejects(blocked.send('pay', { companyId: 'c1', id: 'l1' }, async () => calls++), /retain the payroll retry/);
  assert.equal(calls, 0);
});

test('server Bad request rejection clears retry lock while transport failures retain it', async () => {
  assert.equal(typeof M.commandBook, 'function');
  const book = M.commandBook(() => 'op-1');
  await assert.rejects(book.send('create', { companyId: 'A' }, async () => { throw new Error("Error invoking remote method 'payroll:create': Error: Bad request: Payroll period must have ended"); }));
  assert.deepEqual(book.pending('A'), []);
  await assert.rejects(book.send('pay', { companyId: 'A', id: 'l1', amountMinor: 1300 }, async () => { throw new Error("Error invoking remote method 'payroll:pay': Error: Payment exceeds remaining take-home pay"); }));
  assert.deepEqual(book.pending('A'), [], 'serialized backend validation permits corrected amount');
  await assert.rejects(book.send('pay', { companyId: 'A', id: 'l1', amountMinor: 1200 }, async () => { throw new Error('The server Mac stopped answering before it confirmed this change. The operation may still have completed; refresh the current data before retrying.'); }));
  assert.equal(book.pending('A')[0].payload.amountMinor, 1200);
});

test('approval needs payroll capability and company authority; draft/reviewed always carry estimate notice', () => {
  assert.equal(typeof M.runActions, 'function');
  const reviewed = { status: 'reviewed', revision: 3, lines: [{ blockers: [] }], payments: [] };
  assert.equal(M.runActions(reviewed, { approvalPolicy: 'admin' }, ['payroll.manage']).approve, false);
  assert.equal(M.runActions(reviewed, { approvalPolicy: 'designated_managers' }, ['payroll.manage']).approve, true);
  assert.equal(M.runActions(reviewed, { approvalPolicy: 'admin' }, ['*']).approve, true);
  assert.equal(M.runActions(reviewed, { approvalPolicy: 'admin' }, ['payroll.manage', 'users.manage', 'system.manage']).approve, false);
  assert.equal(M.runActions(reviewed, { approvalPolicy: 'designated_managers' }, ['hr.manage']).approve, false);
  assert.equal(M.runActions({ ...reviewed, lines: [{ blockers: [{ message: 'Needs reason' }] }] }, {}, ['*']).approve, false);
  assert.match(M.runNotice(reviewed), /Draft estimate/);
  assert.match(M.runNotice({ status: 'approved' }), /Frozen/);
});

test('policy edits require explicit choices and exemption reasons; no missing policy becomes implicit exemption', () => {
  assert.equal(typeof M.employeePolicyPayload, 'function');
  const policy = { applyTax: 'yes', applyNssf: 'no', taxResident: 'yes', spouseCount: '1', dependentCount: '2', reason: 'Documented exemption' };
  assert.deepEqual(M.employeePolicyPayload('c1', 'e1', policy), { companyId: 'c1', employeeId: 'e1', applyTax: true, applyNssf: false, taxResident: true, spouseCount: 1, dependentCount: 2, reason: 'Documented exemption' });
  assert.throws(() => M.employeePolicyPayload('c1', 'e1', { ...policy, applyTax: '' }));
  assert.throws(() => M.employeePolicyPayload('c1', 'e1', { ...policy, reason: '' }));
  assert.throws(() => M.employeePolicyPayload('c1', 'e1', { ...policy, dependentCount: '2.5' }));
});

test('whole-day and loan decisions retain untouched decisions and carry run revision; loan amounts use debt currency', () => {
  assert.equal(typeof M.decisionPayload, 'function');
  const run = { companyId: 'c1', revision: 7, periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const line = { id: 'l1', decisions: { dayDecisions: [{ date: '2026-09-02', payable: false, reason: 'No work' }], loanDecisions: [] } };
  assert.deepEqual(M.decisionPayload(run, line, { kind: 'day', date: '2026-09-03', payable: 'yes', reason: 'Half leave reviewed' }), {
    companyId: 'c1', id: 'l1', expectedRevision: 7, patch: { dayDecisions: [{ date: '2026-09-02', payable: false, reason: 'No work' }, { date: '2026-09-03', payable: true, reason: 'Half leave reviewed' }] },
  });
  assert.deepEqual(M.decisionPayload(run, line, { kind: 'loan', loanId: 'loan1', currency: 'KHR', amount: '50000', reason: 'Reduced installment' }).patch, { loanDecisions: [{ loanId: 'loan1', amountMinor: 50000, reason: 'Reduced installment' }] });
  assert.throws(() => M.decisionPayload(run, line, { kind: 'day', date: '2026-10-01', payable: 'yes', reason: 'Outside' }));
});

test('payment payload rejects overpayment, wrong date and zero without an outstanding loan deduction', () => {
  assert.equal(typeof M.paymentPayload, 'function');
  const line = { id: 'l1', currency: 'USD', remainingMinor: 1234, loanDeductionMinor: 0 };
  assert.deepEqual(M.paymentPayload('c1', line, { amount: '12.34', method: 'bank', paidAt: '2026-10-09', reference: ' TRX-1 ' }, '2026-09-01', '2026-10-09'), { companyId: 'c1', id: 'l1', amountMinor: 1234, method: 'bank', paidAt: '2026-10-09', reference: 'TRX-1' });
  assert.throws(() => M.paymentPayload('c1', line, { amount: '12.35', method: 'bank', paidAt: '2026-10-09' }, '2026-09-01', '2026-10-09'));
  assert.throws(() => M.paymentPayload('c1', line, { amount: '0', method: 'bank', paidAt: '2026-10-09' }, '2026-09-01', '2026-10-09'));
});

test('zero cash reposts outstanding frozen loan withholding, but never posts it again when settled', () => {
  assert.equal(typeof M.canPayLine, 'function');
  const line = { id: 'l1', currency: 'KHR', remainingMinor: 0, loanDeductionMinor: 50000, remainingLoanDeductionMinor: 50000 };
  assert.equal(M.canPayLine(line), true);
  assert.deepEqual(M.paymentPayload('c1', line, { amount: '0', method: 'cash', paidAt: '2026-10-09', reference: '' }, '2026-09-01', '2026-10-09'), { companyId: 'c1', id: 'l1', amountMinor: 0, method: 'cash', paidAt: '2026-10-09', reference: null });
  assert.equal(M.canPayLine({ ...line, remainingLoanDeductionMinor: 0 }), false);
  assert.throws(() => M.paymentPayload('c1', { ...line, remainingLoanDeductionMinor: 0 }, { amount: '0', method: 'cash', paidAt: '2026-10-09' }, '2026-09-01', '2026-10-09'));
});

test('run view renders draft notice, blockers and each currency separately, escaping employee text', () => {
  const file = 'renderer/modules/People/Payroll.jsx';
  assert.ok(fs.existsSync(path.join(ROOT, file)), 'Payroll view must exist');
  const { PayrollRunView } = load(file);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const run = { id: 'r1', companyId: 'c1', month: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', status: 'draft', kind: 'regular', revision: 1, input: {}, payments: [], reviews: [], lines: [
    { id: 'l1', employeeId: 'e1', currency: 'USD', netMinor: 1234, grossMinor: 2000, paidMinor: 0, remainingMinor: 1234, snapshot: { employee: { nameEn: '<script>Dara</script>' } }, blockers: [{ code: 'whole_day_decision', date: '2026-09-03', message: 'Choose a whole day' }] },
    { id: 'l2', employeeId: 'e2', currency: 'KHR', netMinor: 50000, grossMinor: 60000, paidMinor: 0, remainingMinor: 50000, snapshot: { employee: { nameEn: 'Sok' } }, blockers: [] },
  ] };
  const html = renderToStaticMarkup(React.createElement(PayrollRunView, { run, companyId: 'c1', runId: 'r1', caps: ['payroll.manage'], settings: {}, onAction() {}, onLine() {} }));
  assert.match(html, /Draft estimate/); assert.match(html, /Choose a whole day/);
  assert.match(html, /\$12\.34/); assert.match(html, /50,000/);
  assert.match(html, /&lt;script&gt;Dara/); assert.doesNotMatch(html, /<script>/);
  const stale = renderToStaticMarkup(React.createElement(PayrollRunView, { run, companyId: 'c2', runId: 'r1', caps: ['*'] }));
  assert.doesNotMatch(stale, /Dara|50,000|12\.34/);
  const revoked = renderToStaticMarkup(React.createElement(PayrollRunView, { run, companyId: 'c1', runId: 'r1', caps: ['hr.manage'] }));
  assert.doesNotMatch(revoked, /Dara|50,000|12\.34/);
});

test('frozen approved run offers explicit payments, no calculate/review and displays immutable inputs', () => {
  const file = 'renderer/modules/People/Payroll.jsx';
  assert.ok(fs.existsSync(path.join(ROOT, file)), 'Payroll view must exist');
  const { PayrollRunView } = load(file);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const run = { id: 'r1', companyId: 'c1', status: 'approved', periodStart: '2026-09-01', periodEnd: '2026-09-30', input: { rateSource: 'Frozen GDT source' }, revision: 4, payments: [], reviews: [], lines: [{ id: 'l1', employeeId: 'e1', currency: 'USD', netMinor: 1200, grossMinor: 2000, paidMinor: 0, remainingMinor: 1200, snapshot: { employee: { nameEn: 'Dara' } }, blockers: [] }] };
  const html = renderToStaticMarkup(React.createElement(PayrollRunView, { run, companyId: 'c1', runId: 'r1', caps: ['*'], settings: {}, onAction() {}, onLine() {} }));
  assert.match(html, /Frozen approved inputs/); assert.match(html, /Record payment/);
  assert.doesNotMatch(html, /<button[^>]*>(?:Calculate|Recalculate|Review|Approve)<\/button>/);
  assert.match(html, /Frozen GDT source/);
});

test('dated rates and assignments are explicit validated payloads; new extra components start inactive', () => {
  assert.equal(typeof M.payRatePayload, 'function');
  assert.deepEqual(M.payRatePayload('c1', 'e1', { effectiveFrom: '2026-09-01', basis: 'day', amount: '12500', currency: 'KHR', reason: 'Contract rate' }), { companyId: 'c1', employeeId: 'e1', effectiveFrom: '2026-09-01', basis: 'day', amountMinor: 12500, currency: 'KHR', reason: 'Contract rate' });
  assert.throws(() => M.payRatePayload('c1', 'e1', { effectiveFrom: '2026-02-30', basis: 'month', amount: '12', currency: 'USD', reason: 'Invalid date' }));
  assert.throws(() => M.payRatePayload('c1', 'e1', { effectiveFrom: '2026-09-01', basis: 'month', amount: '12', currency: 'USD', reason: '' }));
  assert.deepEqual(M.componentPayload('c1', { code: 'bonus', nameEn: 'Bonus', nameKm: '', kind: 'earning', calc: 'fixed', taxable: true, nssfContributory: false, isFringeBenefit: false }), { companyId: 'c1', code: 'bonus', nameEn: 'Bonus', nameKm: null, kind: 'earning', calc: 'fixed', defaultAmountMinor: 0, taxable: true, nssfContributory: false, isFringeBenefit: false, active: false });
  assert.throws(() => M.assignmentPayload('c1', 'e1', { componentId: 'x', amount: '12', currency: 'USD', effectiveFrom: '2026-09-02', effectiveTo: '2026-09-01' }, { id: 'x', active: true, calc: 'fixed' }));
  assert.throws(() => M.assignmentPayload('c1', 'e1', { componentId: 'x', amount: '12', currency: 'USD', effectiveFrom: '2026-09-02', effectiveTo: '' }, { id: 'x', active: true, calc: 'percent' }));
});

// Same lightweight hook harness used by this project's editor workflow tests.
// React scheduling and IPC are the test boundaries; the request hook is real.
function hookHarness() {
  let cursor = 0, updates = 0;
  const values = [], effects = [];
  const changed = (old, next) => !old || !next || next.some((v, i) => !Object.is(v, old[i]));
  const React = {
    useState(initial) { const i = cursor++; values[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [values[i].value, next => { const value = typeof next === 'function' ? next(values[i].value) : next; if (!Object.is(value, values[i].value)) updates++; values[i].value = value; }]; },
    useRef(initial) { const i = cursor++; return values[i] ||= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) values[i] = { value: fn(), deps }; return values[i].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) effects.push(() => { values[i]?.cleanup?.(); values[i] = { deps, cleanup: fn() }; }); },
  };
  const runtime = { Fragment: 'Fragment', jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
  return { React, runtime, get updates() { return updates; }, render(fn) { cursor = 0; const output = fn(); for (const effect of effects.splice(0)) effect(); return output; }, cleanup() { values.forEach(v => { if (v?.cleanup) { const off = v.cleanup; v.cleanup = null; off(); } }); } };
}
function requestHookFixture(api = {}, hook = hookHarness()) {
  const subscribers = new Set(), toasts = [], flushers = new Set();
  const state = { activeCompanyId: 'A', appMode: 'client', clientConnection: { user: { caps: ['payroll.manage'] } }, addToast: (...args) => toasts.push(args) };
  const useAppStore = select => select(state);
  useAppStore.getState = () => state;
  useAppStore.subscribe = listener => { subscribers.add(listener); return () => subscribers.delete(listener); };
  const code = esbuild.transformSync(fs.readFileSync(path.join(ROOT, 'renderer/modules/People/PayrollModals.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const mod = { exports: {} };
  const stubs = { react: hook.React, 'react/jsx-runtime': hook.runtime, '../../store/index.js': { useAppStore }, '../../components/Sidebar.jsx': { useUserCaps: () => state.clientConnection.user?.caps || ['*'] }, '../../lib/capabilities.js': load('renderer/lib/capabilities.js'), '../../lib/companySwitch.js': { registerCompanySwitchFlusher: fn => { flushers.add(fn); return () => flushers.delete(fn); } }, '../../components/ui.jsx': load('renderer/components/ui.jsx'), '../../components/SaveStatus.jsx': {}, './hrHooks.js': { useHrTick: () => 0 }, './payrollUiModel.js': M };
  global.window = { api: { payroll: api } };
  new Function('require', 'module', 'exports', code)(id => { assert.ok(id in stubs, id); return stubs[id]; }, mod, mod.exports);
  return { hook, stubs, toasts, modals: mod.exports, render: () => hook.render(() => mod.exports.usePayrollRequests('A', 'run1')),
    flush: async () => { for (const fn of flushers) await fn(); },
    switchCompany(id) { state.activeCompanyId = id; subscribers.forEach(fn => fn(state)); },
    revoke() { state.clientConnection.user.caps = ['hr.manage']; subscribers.forEach(fn => fn(state)); },
    forgetUser() { state.clientConnection.user = null; subscribers.forEach(fn => fn(state)); },
    cleanup() { hook.cleanup(); delete global.window; } };
}

test('request hook invalidates live store changes before a render and never dispatches after revocation', async () => {
  let reads = 0;
  const fixture = requestHookFixture({ get: async () => { reads++; return { id: 'r1' }; } });
  try {
    const requests = fixture.render();
    const ticket = requests.begin('load');
    fixture.switchCompany('B'); fixture.switchCompany('A');
    assert.equal(requests.current(ticket), false, 'A-B-A before a render must invalidate the original ticket');
    fixture.revoke();
    await assert.rejects(requests.invoke('get', { companyId: 'A', id: 'r1' }), /permission changed/);
    assert.equal(reads, 0, 'revoked users must not make another salary request');
    assert.deepEqual(fixture.toasts, []);
  } finally { fixture.cleanup(); }
});

test('actual payment completion after a company switch cannot close a dialog or change the new company', async () => {
  let resolve, payload, changed = 0;
  const fixture = requestHookFixture({ pay: input => { payload = input; return new Promise(ok => { resolve = ok; }); } });
  const run = { id: 'run1', companyId: 'A', revision: 4, status: 'approved', periodStart: '2026-09-01', lines: [{ blockers: [] }], payments: [] };
  const action = { method: 'pay', revision: 4, line: { id: 'line1', currency: 'USD', remainingMinor: 1234, loanDeductionMinor: 0 } };
  try {
    const modal = fixture.hook.render(() => fixture.modals.PayrollActionModal({ companyId: 'A', run, action, settings: {}, onClose() {}, onChanged() { changed++; } }));
    const button = modal.props.footer.props.children.find(node => node.props.children === 'Record payment');
    const pending = button.props.onClick();
    assert.equal(payload.companyId, 'A'); assert.equal(payload.id, 'line1'); assert.equal(payload.amountMinor, 1234);
    assert.match(payload.operationId, /^[\w-]+$/);
    fixture.switchCompany('B');
    resolve({ id: 'payment1', companyId: 'A', lineId: 'line1', amountMinor: 1234 }); await pending;
    assert.equal(changed, 0); assert.deepEqual(fixture.toasts, []);
  } finally { fixture.cleanup(); }
});

test('a queued save after a company switch rejects inside its async call, never throws before its error handler', async () => {
  const fixture = requestHookFixture({ updateLine: async () => assert.fail('Old-company save dispatched') });
  try {
    const requests = fixture.render(); fixture.switchCompany('B');
    assert.doesNotThrow(() => requests.begin('save'), 'Timer callbacks must reach their catch/finally');
    await assert.rejects(requests.invoke('updateLine', { companyId: 'A', id: 'l1', expectedRevision: 1, patch: { note: 'Old company' } }), /Company.*changed/);
  } finally { fixture.cleanup(); }
});

test('client identity loading cannot turn missing capabilities into salary access', async () => {
  let reads = 0;
  const fixture = requestHookFixture({ get: async () => { reads++; } });
  try {
    const requests = fixture.render(); fixture.forgetUser();
    await assert.rejects(requests.invoke('get', { companyId: 'A', id: 'run1' }), /permission changed/);
    assert.equal(reads, 0);
  } finally { fixture.cleanup(); }
});

test('closing a persisted note before its debounce preserves the company-bound edit without a late callback', async () => {
  const writes = []; let changed = 0;
  const line = { id: 'line1', companyId: 'A', runId: 'run1', employeeId: 'e1', currency: 'USD', baseMinor: 2000, grossMinor: 2000, netMinor: 2000, paidMinor: 0, remainingMinor: 2000, blockers: [], snapshot: {}, decisions: { note: 'Original' } };
  const run = { id: 'run1', companyId: 'A', revision: 1, status: 'draft', lines: [line], payments: [], reviews: [] };
  const fixture = requestHookFixture({ updateLine: async payload => { writes.push(payload); return { ...run, revision: 2 }; } });
  const props = { companyId: 'A', run, line, onChanged() { changed++; } };
  const render = () => fixture.hook.render(() => fixture.modals.PayrollLineNote(props));
  try {
    const tree = render();
    const field = tree.props.children.find(node => node?.type?.name === 'Field');
    field.props.children({ id: 'note' }).props.onChange({ target: { value: 'Reviewed anomaly' } });
    render(); fixture.cleanup();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(writes, [{ companyId: 'A', id: 'line1', expectedRevision: 1, patch: { note: 'Reviewed anomaly' } }]);
    assert.equal(changed, 0, 'closed editors must not change another view');
  } finally { fixture.cleanup(); }
});

test('company switch waits for a pending note save and refuses the switch on the actual save error', async () => {
  const failure = new Error('Backend rejected stale payroll revision'); let writes = 0;
  const logged = [], originalError = console.error;
  console.error = (...args) => logged.push(args);
  const fixture = requestHookFixture({ updateLine: async () => { writes++; throw failure; } });
  const line = { id: 'line1', employeeId: 'e1', decisions: { note: 'Original' } };
  const run = { id: 'run1', revision: 1 };
  const render = () => fixture.hook.render(() => fixture.modals.PayrollLineNote({ companyId: 'A', line, run, onChanged() {} }));
  try {
    const tree = render();
    tree.props.children.find(node => node?.type?.name === 'Field').props.children({ id: 'note' }).props.onChange({ target: { value: 'Needs review' } });
    render();
    await assert.rejects(fixture.flush(), error => error === failure);
    assert.equal(writes, 1);
    assert.equal(fixture.toasts[0][0], 'Backend rejected stale payroll revision');
  } finally {
    fixture.cleanup();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    console.error = originalError;
    assert.equal(logged[0]?.[1], failure, 'a failed closing save is logged with its actual error rather than a stale toast');
  }
});

// Run actual People components with separate hook lifetimes for each keyed
// child. Only scheduling, store and IPC are boundaries; forms/handlers are real.
function staffFixture(api = {}, workspace = false) {
  const instances = new Map(); let active, tick = 0;
  const hook = {
    React: new Proxy({}, { get: (_, key) => (...args) => active.React[key](...args) }),
    runtime: hookHarness().runtime,
    cleanup() { instances.forEach(x => x.hook.cleanup()); instances.clear(); },
  };
  const fixture = requestHookFixture(api, hook);
  const source = fs.readFileSync(path.join(ROOT, workspace ? 'renderer/modules/People/Payroll.jsx' : 'renderer/modules/People/PayrollStaffPay.jsx'), 'utf8');
  const extraExports = workspace ? 'PayrollRunWorkspace' : 'StaffPayCompany, StaffPayEditor, EmployeePolicyEditor, PayRateModal, ComponentModal, AssignmentModal';
  const code = esbuild.transformSync(`${source}\nexport { ${extraExports} };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const mod = { exports: {} };
  const stubs = { ...fixture.stubs, './PayrollModals.jsx': fixture.modals, './PayrollStaffPay.jsx': {}, '../Companies/NoCompanyState.jsx': {}, '../../components/PageHeader.jsx': {}, './hrHooks.js': { useHrTick: () => tick }, '../../components/SaveStatus.jsx': { SaveStatus: function SaveStatus() {} } };
  new Function('require', 'module', 'exports', code)(id => { assert.ok(id in stubs, id); return stubs[id]; }, mod, mod.exports);
  const components = new Set(workspace ? [mod.exports.PayrollRunWorkspace, fixture.modals.PayrollDecisionModal] : Object.values(mod.exports));
  function render(name, props) {
    const visited = new Set();
    function walk(node, at) {
      if (Array.isArray(node)) return node.map((child, i) => walk(child, `${at}/${i}`));
      if (!node?.props) return node;
      const key = `${at}:${node.key || ''}`;
      if (components.has(node.type)) {
        visited.add(key);
        let instance = instances.get(key);
        if (instance?.type !== node.type) { instance?.hook.cleanup(); instance = { type: node.type, hook: hookHarness() }; instances.set(key, instance); }
        active = instance.hook;
        return walk(active.render(() => node.type(node.props)), `${key}/view`);
      }
      return { ...node, props: { ...node.props, children: walk(node.props.children, `${key}/children`), footer: walk(node.props.footer, `${key}/footer`) } };
    }
    const tree = walk({ type: mod.exports[name], props }, 'root');
    for (const [key, instance] of instances) if (!visited.has(key)) { instance.hook.cleanup(); instances.delete(key); }
    return tree;
  }
  return { ...fixture, render, get updates() { return [...instances.values()].reduce((total, x) => total + x.hook.updates, 0); }, event() { tick++; } };
}
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(x => nodes(x, predicate));
  if (!tree?.props) return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props.children, predicate), ...nodes(tree.props.footer, predicate), ...nodes(tree.props.actions, predicate)];
}
const fieldControl = (tree, label) => nodes(tree, n => n.props.label === label)[0]?.props.children({ id: label });
const saveControl = tree => nodes(tree, n => n.type?.name === 'SaveStatus')[0];
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const taxablePolicy = { companyId: 'A', employeeId: 'e1', applyTax: true, applyNssf: true, taxResident: true, spouseCount: 0, dependentCount: 0, reason: null };

test('Staff Pay clean policy refresh hydrates exemptions before a dependent-only save', async () => {
  const writes = [];
  const fixture = staffFixture({ setEmployeePolicy: async payload => { writes.push(payload); return payload; } });
  let policy = taxablePolicy;
  const render = () => fixture.render('EmployeePolicyEditor', { companyId: 'A', employeeId: 'e1', policy });
  try {
    render();
    policy = await Promise.resolve({ ...taxablePolicy, applyTax: false, reason: 'Documented exemption' });
    render(); let tree = render();
    assert.equal(fieldControl(tree, 'Apply salary tax').props.value, 'no');
    fieldControl(tree, 'Dependent count').props.onChange({ target: { value: '2' } });
    tree = render(); await saveControl(tree).props.onSave();
    assert.deepEqual(writes, [{ companyId: 'A', employeeId: 'e1', applyTax: false, applyNssf: true, taxResident: true, spouseCount: 0, dependentCount: 2, reason: 'Documented exemption' }]);
  } finally { fixture.cleanup(); await settle(); }
});

test('Staff Pay dirty policy refresh preserves draft and blocks autosave, Save and switch-flush until resolved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const fixture = staffFixture({ setEmployeePolicy: async payload => { writes.push(payload); return payload; } });
  let policy = taxablePolicy;
  const render = () => fixture.render('EmployeePolicyEditor', { companyId: 'A', employeeId: 'e1', policy });
  try {
    let tree = render();
    fieldControl(tree, 'Dependent count').props.onChange({ target: { value: '3' } });
    render();
    policy = await Promise.resolve({ ...taxablePolicy, applyTax: false, reason: 'Exemption approved' });
    render(); tree = render();
    assert.equal(fieldControl(tree, 'Dependent count').props.value, '3');
    t.mock.timers.tick(600); await settle();
    await saveControl(tree).props.onSave();
    await assert.rejects(fixture.flush(), /policy.*changed|conflict/i);
    assert.deepEqual(writes, [], 'no whole stale policy may be saved by any path');
    const conflict = nodes(tree, n => n.type === fixture.modals.PayrollError).map(n => n.props.message).filter(Boolean).join(' ');
    assert.match(conflict, /policy.*changed|conflict/i);
    const resolve = nodes(tree, n => n.props.children === 'Discard draft and use refreshed policy')[0];
    assert.ok(resolve, 'conflict needs an explicit recovery action');
    resolve.props.onClick(); tree = render();
    assert.equal(fieldControl(tree, 'Apply salary tax').props.value, 'no');
    assert.equal(fieldControl(tree, 'Dependent count').props.value, '0');
    fieldControl(tree, 'Dependent count').props.onChange({ target: { value: '3' } });
    tree = render(); await saveControl(tree).props.onSave();
    assert.equal(writes[0].applyTax, false); assert.equal(writes[0].dependentCount, 3);
  } finally { fixture.cleanup(); await settle(); }
});

test('Staff Pay refresh failure and retry retain the actual open pay-rate draft', async () => {
  let rejectComponents, fail = false, failEmployees = false;
  const fixture = staffFixture({
    listEmployees: async ({ companyId }) => { if (failEmployees) throw new Error('Staff lookup unavailable'); return [{ id: 'e1', companyId, nameEn: 'Dara' }, { id: 'e2', companyId, nameEn: 'Sok' }]; },
    listPayRates: async () => [], getEmployeePolicy: async ({ companyId, employeeId }) => ({ ...taxablePolicy, companyId, employeeId }),
    listComponents: () => fail ? new Promise((_, reject) => { rejectComponents = reject; }) : Promise.resolve([]),
    listEmployeeComponents: async () => [],
  });
  const props = { employeeId: 'e1' };
  const render = () => fixture.render('PayrollStaffPay', props);
  try {
    render(); await settle(); render(); await settle(); let tree = render();
    nodes(tree, n => n.props.children === '+ Add pay rate…')[0].props.onClick(); tree = render();
    fieldControl(tree, 'Amount').props.onChange({ target: { value: '1250.75' } });
    fieldControl(tree, 'Reason').props.onChange({ target: { value: 'New contract' } });
    render(); fail = true; fixture.event(); render();
    rejectComponents(new Error('Components service unavailable')); await settle(); tree = render();
    assert.equal(fieldControl(tree, 'Amount')?.props.value, '1250.75', 'refresh failure must not unmount the form');
    assert.equal(fieldControl(tree, 'Reason')?.props.value, 'New contract');
    const error = nodes(tree, n => n.type === fixture.modals.PayrollError && n.props.message)[0];
    assert.equal(error.props.message, 'Components service unavailable');
    fail = false; error.props.onRetry(); render(); await settle(); tree = render();
    assert.equal(fieldControl(tree, 'Amount')?.props.value, '1250.75');
    assert.equal(fieldControl(tree, 'Reason')?.props.value, 'New contract');
    failEmployees = true; fixture.event(); render(); await settle(); tree = render();
    assert.equal(fieldControl(tree, 'Amount')?.props.value, '1250.75', 'lookup refresh also preserves mounted editors');
    assert.equal(nodes(tree, n => n.type === fixture.modals.PayrollError && n.props.message)[0].props.message, 'Staff lookup unavailable');
    failEmployees = false;
    props.employeeId = 'e2'; tree = render();
    assert.equal(fieldControl(tree, 'Amount'), undefined, 'employee switch hides old salary drafts immediately');
    await settle(); render(); await settle(); tree = render();
    nodes(tree, n => n.props.children === '+ Add pay rate…')[0].props.onClick(); tree = render();
    fieldControl(tree, 'Amount').props.onChange({ target: { value: '99' } }); render();
    fixture.switchCompany('B'); tree = render();
    assert.equal(fieldControl(tree, 'Amount'), undefined, 'company switch hides old salary drafts immediately');
    await settle(); render(); await settle(); tree = render();
    nodes(tree, n => n.props.children === '+ Add pay rate…')[0].props.onClick(); tree = render();
    fieldControl(tree, 'Amount').props.onChange({ target: { value: '88' } }); render();
    fixture.revoke(); tree = render();
    assert.equal(fieldControl(tree, 'Amount'), undefined);
  } finally { fixture.cleanup(); await settle(); }
});

test('Staff Pay late save completion cannot clear a refreshed policy conflict or strand recovery', async () => {
  let finish;
  const fixture = staffFixture({ setEmployeePolicy: payload => new Promise(resolve => { finish = () => resolve(payload); }) });
  let policy = taxablePolicy;
  const render = () => fixture.render('EmployeePolicyEditor', { companyId: 'A', employeeId: 'e1', policy });
  try {
    let tree = render(); fieldControl(tree, 'Dependent count').props.onChange({ target: { value: '2' } });
    tree = render(); const pending = saveControl(tree).props.onSave(); render();
    policy = await Promise.resolve({ ...taxablePolicy, applyTax: false, reason: 'New exemption' });
    tree = render();
    assert.equal(nodes(tree, n => n.props.children === 'Discard draft and use refreshed policy')[0].props.disabled, true);
    const updates = fixture.updates;
    finish(); await pending;
    assert.ok(fixture.updates > updates, 'save completion must schedule rendering the enabled recovery action');
    tree = render();
    assert.match(saveControl(tree).props.error, /policy.*changed/i);
    assert.equal(fieldControl(tree, 'Dependent count').props.value, '2');
    assert.equal(nodes(tree, n => n.props.children === 'Discard draft and use refreshed policy')[0].props.disabled, false);
  } finally { fixture.cleanup(); await settle(); }
});

test('Staff Pay clean refresh after a local save can restore an earlier server policy', async () => {
  const fixture = staffFixture({ setEmployeePolicy: async payload => payload });
  let policy = taxablePolicy;
  const render = () => fixture.render('EmployeePolicyEditor', { companyId: 'A', employeeId: 'e1', policy });
  try {
    let tree = render(); fieldControl(tree, 'Dependent count').props.onChange({ target: { value: '2' } });
    tree = render(); await saveControl(tree).props.onSave(); render();
    policy = await Promise.resolve({ ...taxablePolicy, updatedAt: '2026-10-09T08:00:00Z' });
    render(); tree = render();
    assert.equal(fieldControl(tree, 'Dependent count').props.value, '0', 'a fresh response can undo a prior local value');
  } finally { fixture.cleanup(); await settle(); }
});

test('Staff Pay unchanged background policy preserves a dirty draft without a false conflict', async () => {
  const writes = [];
  const fixture = staffFixture({ setEmployeePolicy: async payload => { writes.push(payload); return payload; } });
  let policy = taxablePolicy;
  const render = () => fixture.render('EmployeePolicyEditor', { companyId: 'A', employeeId: 'e1', policy });
  try {
    let tree = render(); fieldControl(tree, 'Dependent count').props.onChange({ target: { value: '2' } }); render();
    policy = await Promise.resolve({ ...taxablePolicy }); tree = render();
    assert.equal(fieldControl(tree, 'Dependent count').props.value, '2');
    assert.equal(saveControl(tree).props.error, null);
    await saveControl(tree).props.onSave(); assert.equal(writes[0].dependentCount, 2);
  } finally { fixture.cleanup(); await settle(); }
});

const optionRun = () => ({ id: 'run1', companyId: 'A', revision: 4, status: 'reviewed', periodStart: '2026-09-01', periodEnd: '2026-09-30', input: {}, payments: [], reviews: [], lines: [
  { id: 'line1', companyId: 'A', runId: 'run1', employeeId: 'e1', currency: 'USD', baseMinor: 20000, grossMinor: 20000, netMinor: 19000, paidMinor: 0, remainingMinor: 19000, blockers: [], decisions: {}, snapshot: { employee: { id: 'e1', nameEn: 'Dara' } } },
] });

test('statutory choices inherit by default and emit only explicit flags with a reason for either direction', () => {
  assert.equal(typeof M.statutoryOverridePayload, 'function');
  assert.equal(M.statutoryOverridePayload({ applyTax: 'inherit', applyNssf: 'inherit', reason: '' }), null);
  assert.deepEqual(M.statutoryOverridePayload({ applyTax: 'no', applyNssf: 'inherit', reason: ' Reviewed exemption ' }), { applyTax: false, reason: 'Reviewed exemption' });
  assert.deepEqual(M.statutoryOverridePayload({ applyTax: 'yes', applyNssf: 'no', reason: 'Reviewed treatment' }), { applyTax: true, applyNssf: false, reason: 'Reviewed treatment' });
  for (const value of ['yes', 'no']) assert.throws(() => M.statutoryOverridePayload({ applyTax: value, applyNssf: 'inherit', reason: ' ' }), /reason/i);
  assert.throws(() => M.statutoryOverridePayload({ applyTax: 'false', reason: 'Invalid flag' }));
  const form = { month: '2026-09', period: 'monthly', employeeIds: ['e1'], payDate: '2026-10-10', statutoryOverride: { applyTax: 'no', applyNssf: 'yes', reason: 'Run treatment' } };
  assert.deepEqual(M.createRunPayload('A', form, { payCycle: 'monthly' }, '2026-10-09').statutoryOverride, { applyTax: false, applyNssf: true, reason: 'Run treatment' });
  assert.equal(M.createRunPayload('A', { ...form, statutoryOverride: { applyTax: 'inherit', applyNssf: 'inherit' } }, { payCycle: 'monthly' }, '2026-10-09').statutoryOverride, null);
});

test('line statutory replacement and clearing carry the exact revision without copying prior flags or other decisions', () => {
  const run = optionRun(), line = run.lines[0];
  line.decisions = { statutoryOverride: { applyTax: false, reason: 'Old exemption' }, note: 'Keep note' };
  assert.deepEqual(M.decisionPayload(run, line, { kind: 'statutory', applyTax: 'inherit', applyNssf: 'yes', reason: 'Apply NSSF' }), {
    companyId: 'A', id: 'line1', expectedRevision: 4, patch: { statutoryOverride: { applyNssf: true, reason: 'Apply NSSF' } },
  });
  assert.deepEqual(M.decisionPayload(run, line, { kind: 'statutory', applyTax: 'inherit', applyNssf: 'inherit', reason: '' }), {
    companyId: 'A', id: 'line1', expectedRevision: 4, patch: { statutoryOverride: null },
  });
});

function overrideControls(fixture, tree) {
  const fields = nodes(tree, n => n.type === fixture.modals.PayrollStatutoryFields)[0];
  assert.ok(fields, 'the actual modal must include statutory controls');
  return fixture.modals.PayrollStatutoryFields(fields.props);
}

test('actual run creation defaults to inherit and retains the override and operation ID after an unknown outcome', async () => {
  const sent = []; let created = 0;
  const fixture = requestHookFixture({ create: async payload => { sent.push(payload); throw new Error('RPC_OUTCOME_UNKNOWN: operation may still have completed'); } });
  const props = { companyId: 'A', settings: { payCycle: 'monthly' }, employees: [{ id: 'e1', nameEn: 'Dara' }], rateSets: [], onClose() {}, onCreated() { created++; } };
  const render = () => fixture.hook.render(() => fixture.modals.NewPayrollRunModal(props));
  try {
    let tree = render(), fields = overrideControls(fixture, tree);
    for (const label of ['Salary tax', 'NSSF']) assert.equal(fieldControl(fields, label).props.value, 'inherit');
    assert.equal(nodes(tree, n => n.type === 'details' && nodes(n, x => x.type === fixture.modals.PayrollStatutoryFields).length).length, 1);
    fieldControl(fields, 'Salary tax').props.onChange({ target: { value: 'no' } });
    tree = render(); fields = overrideControls(fixture, tree);
    fieldControl(fields, 'Override reason').props.onChange({ target: { value: 'Run exemption evidence' } });
    nodes(tree, n => n.props.children === 'Select matching (up to 500)')[0].props.onClick();
    tree = render(); await nodes(tree, n => n.props.children === 'Create draft')[0].props.onClick();
    assert.deepEqual(sent[0].statutoryOverride, { applyTax: false, reason: 'Run exemption evidence' });
    const pending = fixture.modals.pendingPayrollCommands.pending('A')[0];
    assert.deepEqual(pending.payload, sent[0]);
    await assert.rejects(fixture.modals.pendingPayrollCommands.send('create', { ...pending.payload, statutoryOverride: { applyTax: true, reason: 'Changed' } }, async () => assert.fail('must not dispatch')), /original payload/);
    await fixture.modals.pendingPayrollCommands.send('create', pending.payload, async payload => { assert.deepEqual(payload, sent[0]); return optionRun(); });
    assert.equal(created, 0);
  } finally { fixture.cleanup(); }
});

test('actual line override sends replacement, retries identical unknown outcome and ignores superseded completion', async () => {
  const sent = []; let finish, changed = 0;
  const fixture = requestHookFixture({ updateLine: payload => { sent.push(payload); if (sent.length === 1) return Promise.reject(new Error('RPC_OUTCOME_UNKNOWN')); return new Promise(resolve => { finish = resolve; }); } });
  const run = optionRun(); run.lines[0].decisions.statutoryOverride = { applyTax: false, reason: 'Prior exemption' };
  const props = { companyId: 'A', run, line: run.lines[0], kind: 'statutory', onClose() {}, onChanged() { changed++; } };
  const render = () => fixture.hook.render(() => fixture.modals.PayrollDecisionModal(props));
  try {
    let tree = render(), fields = overrideControls(fixture, tree);
    assert.equal(fieldControl(fields, 'Salary tax').props.value, 'no');
    assert.equal(fieldControl(fields, 'NSSF').props.value, 'inherit');
    fieldControl(fields, 'Salary tax').props.onChange({ target: { value: 'inherit' } });
    tree = render(); fields = overrideControls(fixture, tree);
    fieldControl(fields, 'NSSF').props.onChange({ target: { value: 'yes' } });
    tree = render(); fields = overrideControls(fixture, tree);
    fieldControl(fields, 'Override reason').props.onChange({ target: { value: 'Line treatment' } });
    tree = render(); await nodes(tree, n => n.props.children === 'Save decision and recalculate')[0].props.onClick();
    assert.deepEqual(sent[0], { companyId: 'A', id: 'line1', expectedRevision: 4, patch: { statutoryOverride: { applyNssf: true, reason: 'Line treatment' } } });
    tree = render(); const retry = nodes(tree, n => n.props.children === 'Retry original decision')[0];
    assert.ok(retry); const pending = retry.props.onClick();
    assert.deepEqual(sent[1], sent[0]);
    props.run = { ...run, revision: 5, lines: [{ ...run.lines[0], id: 'line2' }] }; props.line = props.run.lines[0]; render();
    finish(optionRun()); await pending;
    assert.equal(changed, 0, 'old-line completion must not close or overwrite the new line');
    assert.deepEqual(fixture.toasts.map(x => x[0]), ['RPC_OUTCOME_UNKNOWN']);
  } finally { fixture.cleanup(); }
});

test('actual line decision refuses changed revisions and frozen runs before dispatch', async () => {
  let calls = 0;
  const fixture = requestHookFixture({ updateLine: async () => { calls++; } });
  const run = optionRun(); const props = { companyId: 'A', run, line: run.lines[0], kind: 'day', date: '2026-09-02', onClose() {}, onChanged() {} };
  const render = () => fixture.hook.render(() => fixture.modals.PayrollDecisionModal(props));
  try {
    render(); props.run = { ...run, revision: 5 };
    let tree = render(), save = nodes(tree, n => n.props.children === 'Save decision and recalculate')[0];
    assert.equal(save.props.disabled, true); await save.props.onClick();
    props.run = { ...run, status: 'approved' }; tree = render(); save = nodes(tree, n => n.props.children === 'Save decision and recalculate')[0];
    assert.equal(save.props.disabled, true); await save.props.onClick(); assert.equal(calls, 0);
  } finally { fixture.cleanup(); }
});

test('line details render frozen policy layers and separate as-of leave balances, with no approved edit action', () => {
  const { PayrollLineDetails } = load('renderer/modules/People/Payroll.jsx', 'PayrollLineDetails');
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const run = optionRun(); run.status = 'approved';
  const line = run.lines[0];
  line.snapshot = { employeePolicy: { applyTax: true, applyNssf: false, reason: 'Employee exemption' }, runStatutoryOverride: { applyTax: false, applyNssf: true, reason: 'Run evidence' }, lineStatutoryOverride: { applyTax: true, reason: 'Line evidence' }, effectivePolicy: { applyTax: true, applyNssf: true }, leaveBalanceAsOf: '2026-09-30', leaveBalances: [
    { leaveTypeId: 'annual', code: 'AL', nameEn: 'Annual leave frozen label', nameKm: '', days: 10.5 }, { leaveTypeId: 'sick', code: 'SL', nameEn: 'Sick leave frozen label', nameKm: '', days: 6.5 },
  ] };
  const props = { companyId: 'A', run, line, caps: ['payroll.manage'], settings: {} };
  const html = renderToStaticMarkup(React.createElement(PayrollLineDetails, props));
  for (const text of ['Employee policy', 'Run override', 'Line override', 'Effective policy', 'Run evidence', 'Line evidence', 'Employee exemption', 'Annual leave frozen label', 'Sick leave frozen label', '10.5', '6.5']) assert.ok(html.includes(text), text);
  assert.match(html, /Leave balances/); assert.match(html, /30 Sep 2026|Sep 30, 2026/);
  assert.doesNotMatch(html, /Edit statutory treatment|17 days|Total leave/);
  assert.equal(renderToStaticMarkup(React.createElement(PayrollLineDetails, { ...props, companyId: 'B' })), '');
  line.snapshot = {};
  assert.match(renderToStaticMarkup(React.createElement(PayrollLineDetails, props)), /not captured/i);
});

test('workspace run PDF uses the run ID and drops late export feedback on a company switch', async () => {
  const sent = []; let finish;
  const run = optionRun();
  const fixture = requestHookFixture({ get: async () => run, getSettings: async () => ({}), saveRunPdf: payload => { sent.push(payload); return new Promise(resolve => { finish = resolve; }); } });
  const source = fs.readFileSync(path.join(ROOT, 'renderer/modules/People/Payroll.jsx'), 'utf8');
  const code = esbuild.transformSync(`${source}\nexport { PayrollRunWorkspace };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const stubs = { ...fixture.stubs, './PayrollModals.jsx': fixture.modals, './PayrollStaffPay.jsx': {}, '../Companies/NoCompanyState.jsx': {}, '../../components/PageHeader.jsx': {} };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => { assert.ok(id in stubs, id); return stubs[id]; }, mod, mod.exports);
  const render = () => fixture.hook.render(() => mod.exports.PayrollRunWorkspace({ companyId: 'A', runId: 'run1', caps: ['payroll.manage'], onBack() {} }));
  try {
    render(); await settle(); const tree = render();
    const view = nodes(tree, n => n.type === mod.exports.PayrollRunView)[0];
    assert.equal(typeof view.props.onRunPdf, 'function');
    const pending = view.props.onRunPdf(); assert.deepEqual(sent, [{ companyId: 'A', id: 'run1' }]);
    fixture.switchCompany('B'); finish('/chosen/payroll.pdf'); await pending;
    assert.deepEqual(fixture.toasts, []);
    const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
    const { PayrollRunView } = load('renderer/modules/People/Payroll.jsx');
    assert.match(renderToStaticMarkup(React.createElement(PayrollRunView, { run, companyId: 'A', runId: 'run1', caps: ['payroll.manage'], settings: {} })), /Save run PDF/);
  } finally { fixture.cleanup(); }
});

test('new snapshot guards reject cross-employee policy and malformed leave while accepting historical absence', () => {
  const run = optionRun();
  assert.equal(M.guardRun(run, 'A', 'run1'), run);
  run.lines[0].snapshot.employeePolicy = { companyId: 'A', employeeId: 'e2', applyTax: true, applyNssf: true };
  assert.throws(() => M.guardRun(run, 'A', 'run1'), /snapshot/);
  run.lines[0].snapshot = { leaveBalanceAsOf: '2026-09-30', leaveBalances: [{ leaveTypeId: 'annual', code: 'AL', nameEn: 'Annual', nameKm: '', days: '10.5' }] };
  assert.throws(() => M.guardRun(run, 'A', 'run1'), /leave/i);
  run.lines[0].snapshot.leaveBalances[0].days = -0.5;
  assert.equal(M.guardRun(run, 'A', 'run1'), run, 'fractional and negative balances are snapshots, not UI calculations');
});

test('actual line override allows correction after definite rejection and clears to inherit with a recalculated line', async () => {
  const sent = []; let changed;
  const result = optionRun(); result.revision = 5; result.lines[0].id = 'line2';
  const fixture = requestHookFixture({ updateLine: async payload => { sent.push(payload); if (sent.length === 1) throw new Error('Bad request: Statutory override needs corrected evidence'); return result; } });
  const run = optionRun(); run.lines[0].decisions.statutoryOverride = { applyTax: false, reason: 'Old exemption' };
  const props = { companyId: 'A', run, line: run.lines[0], kind: 'statutory', onClose() {}, onChanged(value) { changed = value; } };
  const render = () => fixture.hook.render(() => fixture.modals.PayrollDecisionModal(props));
  try {
    let tree = render(); await nodes(tree, n => n.props.children === 'Save decision and recalculate')[0].props.onClick();
    tree = render(); const fields = overrideControls(fixture, tree);
    assert.equal(fields.props.disabled, false);
    assert.equal(nodes(tree, n => n.type === fixture.modals.PayrollError)[0].props.message, 'Bad request: Statutory override needs corrected evidence');
    fieldControl(fields, 'Salary tax').props.onChange({ target: { value: 'inherit' } });
    tree = render(); await nodes(tree, n => n.props.children === 'Save decision and recalculate')[0].props.onClick();
    assert.deepEqual(sent[1], { companyId: 'A', id: 'line1', expectedRevision: 4, patch: { statutoryOverride: null } });
    assert.equal(changed.lines[0].id, 'line2'); assert.equal(changed.revision, 5);
  } finally { fixture.cleanup(); }
});

test('actual statutory completion after permission revocation cannot update the workspace', async () => {
  let finish, changed = 0;
  const fixture = requestHookFixture({ updateLine: () => new Promise(resolve => { finish = resolve; }) });
  const run = optionRun();
  try {
    const tree = fixture.hook.render(() => fixture.modals.PayrollDecisionModal({ companyId: 'A', run, line: run.lines[0], kind: 'statutory', onClose() {}, onChanged() { changed++; } }));
    const pending = nodes(tree, n => n.props.children === 'Save decision and recalculate')[0].props.onClick();
    fixture.revoke(); finish(optionRun()); await pending;
    assert.equal(changed, 0); assert.deepEqual(fixture.toasts, []);
  } finally { fixture.cleanup(); }
});

test('parent workspace preserves decision draft across replacement line keys and requires explicit conflict recovery', async () => {
  let current = optionRun(); const writes = [];
  const fixture = staffFixture({ get: async ({ companyId, id }) => ({ ...current, companyId, id, lines: current.lines.map(line => ({ ...line, companyId, runId: id })) }), getSettings: async () => ({}), updateLine: async payload => {
    writes.push(payload);
    current = { ...current, revision: 6, lines: [{ ...current.lines[0], id: 'line3', decisions: { statutoryOverride: payload.patch.statutoryOverride } }] };
    return current;
  } }, true);
  const props = { companyId: 'A', runId: 'run1', caps: ['payroll.manage'], onBack() {} };
  const render = () => fixture.render('PayrollRunWorkspace', props);
  const open = () => {
    let tree = render(); nodes(tree, n => n.type?.name === 'PayrollRunView')[0].props.onLine(current.lines[0]);
    tree = render(); nodes(tree, n => n.type?.name === 'PayrollLineDetails')[0].props.onDecision({ kind: 'statutory' });
    return render();
  };
  try {
    render(); await settle(); let tree = open();
    fieldControl(overrideControls(fixture, tree), 'Salary tax').props.onChange({ target: { value: 'no' } });
    tree = render(); fieldControl(overrideControls(fixture, tree), 'Override reason').props.onChange({ target: { value: 'Unsaved evidence' } }); render();
    current = { ...current, revision: 5, lines: [{ ...current.lines[0], id: 'line2' }] };
    fixture.event(); render(); await settle(); tree = render();
    let fields = overrideControls(fixture, tree);
    assert.equal(fieldControl(fields, 'Salary tax').props.value, 'no', 'parent must not remount the draft when line ID changes');
    assert.equal(fieldControl(fields, 'Override reason').props.value, 'Unsaved evidence');
    const save = nodes(tree, n => n.props.children === 'Save decision and recalculate')[0];
    assert.equal(save.props.disabled, true); await save.props.onClick(); assert.deepEqual(writes, []);
    assert.ok(nodes(tree, n => n.props.role === 'alert').length, 'replacement needs a visible conflict');
    nodes(tree, n => n.props.children === 'Discard draft and load current decision')[0].props.onClick();
    tree = render(); fields = overrideControls(fixture, tree);
    assert.equal(fieldControl(fields, 'Salary tax').props.value, 'inherit');
    assert.equal(fieldControl(fields, 'Override reason').props.value, '');
    fieldControl(fields, 'NSSF').props.onChange({ target: { value: 'yes' } }); tree = render();
    fieldControl(overrideControls(fixture, tree), 'Override reason').props.onChange({ target: { value: 'Reviewed current line' } }); tree = render();
    await nodes(tree, n => n.props.children === 'Save decision and recalculate')[0].props.onClick();
    assert.deepEqual(writes, [{ companyId: 'A', id: 'line2', expectedRevision: 5, patch: { statutoryOverride: { applyNssf: true, reason: 'Reviewed current line' } } }]);
    tree = render(); assert.equal(nodes(tree, n => n.type === fixture.modals.PayrollStatutoryFields).length, 0, 'own successful save closes decision');
    await settle(); tree = open(); fields = overrideControls(fixture, tree);
    assert.equal(fieldControl(fields, 'NSSF').props.value, 'yes');
    assert.equal(fieldControl(fields, 'Override reason').props.value, 'Reviewed current line');
    assert.equal(nodes(tree, n => n.props.children === 'Save decision and recalculate')[0].props.disabled, false, 'reopened decision binds the new line and revision');
    props.runId = 'other-run'; tree = render();
    assert.equal(nodes(tree, n => n.type === fixture.modals.PayrollStatutoryFields).length, 0, 'run switch hides old draft on first render');
  } finally { fixture.cleanup(); await settle(); }
});

test('preserved decision draft is hidden immediately when company, run, employee or permission changes', () => {
  for (const change of ['company', 'run', 'employee', 'permission']) {
    const fixture = requestHookFixture(); const run = optionRun();
    const props = { companyId: 'A', run, line: run.lines[0], kind: 'statutory', onClose() {}, onChanged() {} };
    const render = () => fixture.hook.render(() => fixture.modals.PayrollDecisionModal(props));
    try {
      let tree = render(); fieldControl(overrideControls(fixture, tree), 'Salary tax').props.onChange({ target: { value: 'no' } });
      tree = render(); fieldControl(overrideControls(fixture, tree), 'Override reason').props.onChange({ target: { value: 'Private draft evidence' } }); render();
      if (change === 'company') { fixture.switchCompany('B'); props.companyId = 'B'; }
      if (change === 'run') { props.run = { ...run, id: 'run2' }; props.line = { ...props.line, runId: 'run2' }; }
      if (change === 'employee') props.line = { ...props.line, employeeId: 'e2' };
      if (change === 'permission') fixture.revoke();
      tree = render();
      assert.equal(nodes(tree, n => n.type === fixture.modals.PayrollStatutoryFields).length, 0, change);
      assert.equal(nodes(tree, n => n.props.children === 'Save decision and recalculate')[0].props.disabled, true, change);
    } finally { fixture.cleanup(); }
  }
});
