const test = require('node:test');
const assert = require('node:assert/strict');
const { getValidator } = require('../main/server/validators');
const { validateArgs } = require('../main/util/validateArgs');
const { allowedByCaps } = require('../main/util/permissions');
const { OPT_IN_CAPABILITIES } = require('../main/util/capabilities');

const fixtures = {
  'payroll:list': {}, 'payroll:get': { id: 'run' }, 'payroll:listEmployees': {},
  'payroll:getSettings': {}, 'payroll:updateSettings': { patch: { payday: 10 } },
  'payroll:getEmployeePolicy': { employeeId: 'e' },
  'payroll:setEmployeePolicy': { employeeId: 'e', applyNssf: true, applyTax: true, taxResident: true, spouseCount: 0, dependentCount: 0 },
  'payroll:listPayRates': { employeeId: 'e' },
  'payroll:setPayRate': { employeeId: 'e', effectiveFrom: '2026-09-01', basis: 'month', amountMinor: 50000, currency: 'USD', reason: 'Agreed pay' },
  'payroll:listComponents': {},
  'payroll:saveComponent': { code: 'BONUS', nameEn: 'Bonus', kind: 'earning', calc: 'fixed', taxable: true, nssfContributory: true, isFringeBenefit: false },
  'payroll:listEmployeeComponents': { employeeId: 'e' },
  'payroll:setEmployeeComponent': { employeeId: 'e', componentId: 'c', amountMinor: 100, currency: 'KHR', effectiveFrom: '2026-09-01' },
  'payroll:listRateSets': {},
  'payroll:saveRateSet': { name: 'Unconfirmed draft', effectiveFrom: '2026-09-01', nssf: { bands: [], components: [] }, tax: null },
  'payroll:confirmRateSet': { id: 's', sourceNote: 'Accountant signed statutory review, reference 2026-09' },
  'payroll:create': { periodStart: '2026-09-01', periodEnd: '2026-09-30', employeeIds: ['e'], kind: 'regular', operationId: 'new-run' },
  'payroll:calculate': { id: 'r' },
  'payroll:updateLine': { id: 'l', expectedRevision: 1, patch: { dayDecisions: [{ date: '2026-09-01', payable: true, reason: 'Reviewed partial day' }] } },
  'payroll:review': { id: 'r', expectedRevision: 1 }, 'payroll:approve': { id: 'r', expectedRevision: 1 },
  'payroll:pay': { id: 'l', amountMinor: 100, method: 'cash', paidAt: '2026-10-09', operationId: 'pay-1' },
  'payroll:reversePayment': { id: 'p', reason: 'Incorrect payment', operationId: 'reverse-1' },
  'payroll:voidRun': { id: 'r', reason: 'Correction' },
  'payroll:fetchSalaryTaxRate': { month: '2026-09' },
  'payroll:getPayslipPdf': { id: 'l' }, 'payroll:savePayslipPdf': { id: 'l' },
  'payroll:getWorkbook': { id: 'r' }, 'payroll:saveWorkbook': { id: 'r' },
  'loans:list': {}, 'loans:get': { id: 'loan' }, 'loans:listEmployees': {}, 'loans:getPolicy': {},
  'loans:create': { employeeId: 'e', principalMinor: 50000, currency: 'USD', disbursedOn: '2026-09-01', interestMethod: 'declining', interestPolicy: 'separate', ratePercent: 1, interestFreeMonths: 3, installmentMinor: 10000, operationId: 'loan-new' },
  'loans:approve': { id: 'loan' },
  'loans:voidDraft': { id: 'loan', reason: 'Mistaken draft', operationId: 'cancel-draft' },
  'loans:changeRate': { id: 'loan', effectiveFrom: '2026-10-01', ratePercent: 2, reason: 'Agreed change', operationId: 'rate-1' },
  'loans:accrue': { id: 'loan', through: '2026-09-30', operationId: 'interest-1' },
  'loans:repay': { id: 'loan', amountMinor: 10000, entryDate: '2026-10-09', source: 'bank', operationId: 'repay-1' },
  'loans:postpone': { id: 'loan', month: '2026-10', reason: 'Agreed postponement', operationId: 'postpone-1' },
  'loans:reverseEntry': { id: 'entry', reason: 'Correction', operationId: 'reverse-loan' },
  'loans:writeOff': { id: 'loan', entryDate: '2026-10-09', reason: 'Agreed writeoff', operationId: 'write-off' },
  'loans:project': { id: 'loan', through: '2026-12-31' },
  'kiosk:payroll': { sessionToken: 'token' }, 'kiosk:loans': { sessionToken: 'token' },
  'kiosk:getPayslipPdf': { sessionToken: 'token', id: 'l' }, 'kiosk:savePayslipPdf': { sessionToken: 'token', id: 'l' },
};

test('HR2 shapes accept the declared UI inputs and reject actor/unknown fields on both boundaries', () => {
  for (const [ch, input] of Object.entries(fixtures)) {
    const v = getValidator(ch);
    assert.equal(typeof v, 'function', `${ch} needs validation`);
    assert.equal(v(input), true, ch);
    for (const field of ['actor', 'confirmedByUserId', 'unexpected']) {
      const bad = { ...input, [field]: 'attacker' };
      assert.notEqual(v(bad), true, ch);
      assert.throws(() => validateArgs(ch, bad), /^Error: Bad request:/, ch);
    }
  }
});

test('HR2 rejects unsafe money, fabricated dates, missing idempotency and stale revision shapes', () => {
  const cases = [
    ['payroll:pay', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ['payroll:pay', { amountMinor: -1 }], ['payroll:pay', { amountMinor: 1.5 }],
    ['payroll:pay', { paidAt: '2026-02-30' }], ['payroll:pay', { operationId: undefined }],
    ['payroll:approve', { expectedRevision: undefined }], ['payroll:approve', { expectedRevision: -1 }],
    ['payroll:fetchSalaryTaxRate', { asOfDate: '2026-09-15' }],
    ['payroll:create', { employeeIds: ['e', 'e'] }],
    ['payroll:updateLine', { patch: { netMinor: 99999 } }],
    ['payroll:updateLine', { patch: { loanDecisions: [{ loanId: 'loan', amountMinor: 1, reason: '' }] } }],
    ['payroll:updateSettings', { patch: { approvalPolicy: 'everyone' } }],
    ['payroll:updateSettings', { patch: { policyConfirmed: true } }],
    ['payroll:updateSettings', { patch: { nssfRateKhrPerUsd: -1 } }],
    ['payroll:saveRateSet', { nssf: { bands: [{ upperKhr: null, baseKhr: 200000, actor: 'x' }], components: [] } }],
    ['loans:repay', { source: 'payroll' }], ['loans:create', { interestFreeMonths: -1 }],
    ['loans:postpone', { month: '2026-13' }], ['kiosk:payroll', { employeeId: 'other' }],
  ];
  for (const [ch, patch] of cases) {
    const v = getValidator(ch);
    assert.equal(typeof v, 'function', ch);
    assert.notEqual(v({ ...fixtures[ch], ...patch }), true, `${ch} ${JSON.stringify(patch)}`);
  }
});

test('statutory drafts may start empty and explicitly supplied zero bases remain configuration', () => {
  const validate = getValidator('payroll:saveRateSet');
  assert.equal(validate({ name: 'Empty draft', effectiveFrom: '2026-09-01' }), true);
  assert.equal(validate({ name: 'Synthetic zero base', effectiveFrom: '2026-09-01', nssf: {
    bands: [{ upperKhr: null, baseKhr: 0 }], components: [{ key: 'test', employeePercent: 0, employerPercent: 0 }],
  } }), true);
  assert.equal(validate({ name: 'Scheme-specific draft', effectiveFrom: '2026-09-01', nssf: {
    components: [{ key: 'pension', employeePercent: 2, employerPercent: 2, bands: [{ upperKhr: null, baseKhr: 400000 }] }],
  } }), true);
});

test('the zero-wage NSSF exemption band passes while tax bracket upper zero remains invalid', () => {
  const validate = getValidator('payroll:saveRateSet');
  const draft = { name: 'Zero-wage exemption', effectiveFrom: '2026-09-01', nssf: {
    bands: [{ upperKhr: 0, baseKhr: 0 }, { upperKhr: null, baseKhr: 400000 }],
    components: [{ key: 'pension', employeePercent: 2, employerPercent: 2,
      bands: [{ upperKhr: 0, baseKhr: 0 }, { upperKhr: null, baseKhr: 400000 }] }],
  } };
  assert.equal(validate(draft), true);
  assert.notEqual(validate({ ...draft, tax: { brackets: [{ upperKhr: 0, ratePercent: 0 }, { upperKhr: null, ratePercent: 20 }],
    spouseAllowanceKhr: 0, dependentAllowanceKhr: 0, maxDependents: null, nonResidentPercent: 20,
    fringeBenefitPercent: 20, pensionDeductible: false } }), true);
});

test('HR2 financial privileges are opt-in and admin control channels cannot be granted to managers', () => {
  for (const cap of ['payroll.manage', 'loans.manage']) assert.equal(OPT_IN_CAPABILITIES.has(cap), true);
  for (const ch of ['payroll:list', 'payroll:listEmployees', 'loans:list', 'loans:listEmployees']) {
    assert.equal(allowedByCaps(new Set(['hr.manage', 'hr.view', 'history.view']), ch), false, ch);
    assert.equal(allowedByCaps(new Set(['payroll.manage', 'loans.manage']), ch), true, ch);
  }
  for (const ch of ['payroll:updateSettings', 'payroll:confirmRateSet', 'payroll:reversePayment', 'loans:writeOff', 'loans:reverseEntry']) {
    assert.equal(allowedByCaps(new Set(['payroll.manage', 'loans.manage']), ch), false, ch);
    assert.equal(allowedByCaps(new Set(['*']), ch), true, ch);
  }
  assert.equal(allowedByCaps(new Set(['attendance.kiosk']), 'kiosk:payroll'), true);
  assert.equal(allowedByCaps(new Set(['attendance.kiosk']), 'payroll:getPayslipPdf'), false);
});

module.exports = { fixtures };

test('actual preload forwards HR2 object payloads without actor injection or tenant loss', async () => {
  const Module = require('node:module');
  const original = Module._load;
  const preloadPath = require.resolve('../main/preload');
  const previous = require.cache[preloadPath];
  let api;
  let received;
  delete require.cache[preloadPath];
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return {
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'api'); api = value; } },
      ipcRenderer: { invoke: async (channel, args) => { received = { channel, args }; return 'ok'; }, on() {}, removeListener() {}, send() {} },
    };
    return original.call(this, request, parent, isMain);
  };
  try { require('../main/preload'); }
  finally { Module._load = original; if (previous) require.cache[preloadPath] = previous; else delete require.cache[preloadPath]; }
  for (const [channel, fixture] of Object.entries(fixtures)) {
    const [domain, method] = channel.split(':');
    const args = domain === 'kiosk' ? { ...fixture } : { ...fixture, companyId: 'bound-company' };
    await api[domain][method](args);
    assert.deepEqual(received, { channel, args });
    assert.equal(getValidator(channel)(received.args), true);
  }
});

test('document normalization uses frozen same-currency loan plans and leaves incomplete/foreign balances unknown', () => {
  const { documentLine } = require('../main/ipc/payroll');
  const plan = { currency: 'USD', principalMinor: 50000, interestMinor: 1000, amountMinor: 11000 };
  const input = plans => ({ currency: 'USD', nameEn: 'Current name must not win', loanBalanceAfterMinor: 99999,
    snapshot: { employee: { nameEn: 'Historical name' }, policy: { applyTax: false, applyNssf: false }, loanPlans: plans } });
  const original = input([plan, { ...plan, principalMinor: 8000, interestMinor: 0, amountMinor: 8000 }]);
  const frozen = JSON.stringify(original);
  const line = documentLine(original);
  assert.equal(line.loanBalanceAfterMinor, 40000);
  assert.equal(line.nameEn, 'Historical name');
  assert.equal(line.leaveBalanceDays, undefined);
  assert.equal(JSON.stringify(original), frozen);
  for (const plans of [undefined, [], [{ loanId: 'l', postponed: true, amountMinor: 0 }],
    [{ ...plan, currency: 'KHR' }], [{ ...plan, principalMinor: undefined }],
    [{ ...plan, interestMinor: null }], [{ ...plan, amountMinor: -1 }],
    [{ ...plan, amountMinor: 60000 }], [{ ...plan, principalMinor: Number.MAX_SAFE_INTEGER }],
    [{ ...plan, principalMinor: Number.MAX_SAFE_INTEGER, interestMinor: 0, amountMinor: 0 }, plan]]) {
    assert.equal(documentLine(input(plans)).loanBalanceAfterMinor, undefined, JSON.stringify(plans));
  }
});
