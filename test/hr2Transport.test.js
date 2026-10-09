// Actual handlers, HTTP server and SQLite services. Never substitute a fake DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
let db;
let skip = false;
try {
  new (require('better-sqlite3'))(':memory:').close();
  db = require('../main/db');
} catch (err) {
  if (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(err.message)) {
    skip = 'Wrong SQLite ABI; run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/hr2Transport.test.js';
  } else throw err;
}
async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('HR2 real transport denies financial leakage and enforces company/policy authority', { skip }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-hr2-transport-'));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const employees = require('../main/db/employees');
  const a = companies.create({ name: 'Synthetic payroll A', isActive: true });
  const b = companies.create({ name: 'Synthetic payroll B' });
  const e = employees.create({ companyId: a.id, staffCode: 'A1', nameEn: 'Historical name', phone: 'private phone', notes: 'Private HR note' });
  const other = employees.create({ companyId: b.id, staffCode: 'B1', nameEn: 'Other company' });
  employees.updateHrProfile(e.id, { bankAccountNo: 'PRIVATE-BANK', nssfNo: 'PRIVATE-NSSF', nationalIdNo: 'PRIVATE-ID' });
  const role = (name, permissions) => roles.create({ name, permissions });
  const payrollRole = role('Payroll only', ['payroll.manage', 'history.view']);
  const loanRole = role('Loans only', ['loans.manage', 'history.view']);
  const hrRole = role('HR only', ['hr.manage', 'history.view']);
  const payrollUser = users.create({ name: 'Pay manager', role: payrollRole.key });
  const loanUser = users.create({ name: 'Loan manager', role: loanRole.key });
  const hrUser = users.create({ name: 'HR manager', role: hrRole.key });
  const admin = users.create({ name: 'Synthetic admin', role: 'admin' });
  const kiosk = users.create({ name: 'Synthetic kiosk', role: role('Kiosk only', ['attendance.kiosk']).key });
  const kiosk2 = users.create({ name: 'Other kiosk', role: kiosk.role });
  for (const u of [payrollUser, loanUser, hrUser, admin, kiosk, kiosk2]) users.setActiveCompany(u.id, a.id);
  const handlers = new Map();
  const electronPath = require.resolve('electron');
  const previous = require.cache[electronPath];
  let saveDialog = async () => ({ canceled: true });
  let pickDialog = async () => ({ canceled: true, filePaths: [] });
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
    app: { getVersion: () => '0.0.0-hr2-test', getPath: () => dataDir },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    dialog: { showSaveDialog: (...args) => saveDialog(...args), showOpenDialog: (...args) => pickDialog(...args) },
  } };
  t.after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });
  const helpers = require('../main/ipc/helpers');
  for (const domain of ['payroll', 'loans', 'hr', 'audit', 'files', 'catalog']) require(`../main/ipc/${domain}`).register(helpers);
  const server = require('../main/server');
  const port = await freePort();
  await server.bootServer({ port, dataDir });
  t.after(() => server.stopServer());
  const call = async (user, channel, args = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, { method: 'POST',
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }) });
    return { status: res.status, ...await res.json() };
  };
  const ok = async (user, ch, args) => { const r = await call(user, ch, args); assert.equal(r.status, 200, `${ch}: ${r.error}`); return r.result; };
  const local = (ch, args) => handlers.get(ch)({}, args);

  await t.test('financial caps are opt-in; minimal lookup does not grant broad HR access', async () => {
    for (const key of ['editor', 'viewer', 'photographer']) {
      const caps = roles.getCapabilityKeys(key);
      assert.equal(caps.has('payroll.manage'), false); assert.equal(caps.has('loans.manage'), false);
    }
    const names = await ok(payrollUser, 'payroll:listEmployees');
    assert.deepEqual(Object.keys(names[0]).sort(), ['companyId', 'id', 'nameEn', 'nameKm', 'position', 'staffCode', 'status']);
    assert.equal(names.length, 1); assert.equal(names[0].id, e.id);
    assert.equal(JSON.stringify(names).includes('PRIVATE'), false);
    assert.equal((await call(payrollUser, 'hr:getProfile', e.id)).status, 403);
    assert.equal((await call(hrUser, 'payroll:listEmployees')).status, 403);
    assert.equal((await call(payrollUser, 'loans:listEmployees')).status, 403);
    assert.equal((await ok(loanUser, 'loans:listEmployees'))[0].id, e.id);
    assert.notEqual((await call(payrollUser, 'payroll:listEmployees', { companyId: b.id })).status, 200);
  });
  await t.test('local and HTTP refuse the same actor and nested override payloads', async () => {
    const bad = { id: 'unknown', amountMinor: 100, method: 'cash', paidAt: '2026-10-09', operationId: 'x', actor: admin.id };
    assert.throws(() => local('payroll:pay', bad), /Bad request: unknown field: actor/);
    const r = await call(payrollUser, 'payroll:pay', bad);
    assert.equal(r.status, 400); assert.match(r.error, /Bad request: unknown field: actor/);
    assert.equal((await call(payrollUser, 'payroll:updateSettings', { patch: { approvalPolicy: 'designated_managers' } })).status, 403);
  });

  await t.test('financial History is scoped even for admin and cannot be cleared when a tag is missing', async () => {
    const audit = require('../main/db/auditLog');
    const first = audit.log({ entityType: 'employee_payroll_policy', entityId: e.id, action: 'private', after: { salary: 'secret' }, sensitivity: 'payroll' });
    const second = audit.log({ entityType: 'employee_payroll_policy', entityId: other.id, action: 'private', after: { salary: 'other secret' } });
    assert.ok(first); assert.ok(second);
    assert.equal((await ok(hrUser, 'audit:listRecent')).some(x => x.entityType === 'employee_payroll_policy'), false);
    assert.equal((await ok(loanUser, 'audit:listRecent')).some(x => x.entityType === 'employee_payroll_policy'), false);
    for (const user of [admin, payrollUser]) {
      const rows = (await ok(user, 'audit:listRecent')).filter(x => x.entityType === 'employee_payroll_policy');
      assert.deepEqual(rows.map(x => x.entityId), [e.id]);
      assert.equal(await ok(user, 'audit:countForEntity', { entityType: 'employee_payroll_policy', entityId: other.id }), 0);
    }
    await ok(admin, 'audit:clearHistory', { days: 0 });
    assert.equal(audit.countForEntity('employee_payroll_policy', e.id), 1);
    assert.equal(audit.countForEntity('employee_payroll_policy', other.id), 1);
  });
  await t.test('real FX helper over IPC proposes evidence without writes or an API fake clock', async () => {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Synthetic official endpoint fixture'], ['Release Date', 'Currency', 'Rate', 'Published By'],
      ['September 15, 2026', 'USD/KHR', 4053, 'National Bank of Cambodia'],
    ]), 'Exchange Rate');
    const workbook = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const originalFetch = global.fetch;
    const requests = [];
    let duringFetch = () => {};
    global.fetch = async (url, options) => {
      if (String(url).startsWith('https://www.tax.gov.kh/')) {
        requests.push({ url, options }); duringFetch();
        return new Response(workbook, { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
      }
      return originalFetch(url, options);
    };
    try {
      const before = db.getDb().prepare('SELECT COUNT(*) n FROM audit_log').get().n;
      const proposed = await ok(payrollUser, 'payroll:fetchSalaryTaxRate', { month: '2026-09', companyId: a.id });
      assert.equal(proposed.khrPerUsd, 4053); assert.equal(proposed.referenceDate, '2026-09-15');
      assert.equal(proposed.requiresConfirmation, true); assert.equal(proposed.source, 'gdt-nbc');
      assert.equal(requests[0].url, 'https://www.tax.gov.kh/en/exchange-rate/export?for_year=2026&for_month=9');
      assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM audit_log').get().n, before);
      assert.equal((await call(payrollUser, 'payroll:fetchSalaryTaxRate', { month: '2026-09', asOfDate: '2099-09-15' })).status, 400);
      duringFetch = () => users.setActiveCompany(payrollUser.id, b.id);
      assert.notEqual((await call(payrollUser, 'payroll:fetchSalaryTaxRate', { month: '2026-09' })).status, 200);
      users.setActiveCompany(payrollUser.id, a.id);
      duringFetch = () => roles.update(payrollRole.key, { permissions: ['history.view'] });
      const revoked = await call(payrollUser, 'payroll:fetchSalaryTaxRate', { month: '2026-09' });
      assert.equal(revoked.status, 422); assert.match(revoked.error, /permission/);
      roles.update(payrollRole.key, { permissions: ['payroll.manage', 'history.view'] });
    } finally { global.fetch = originalFetch; }
  });
  await t.test('actual backend row actions, revisions, policy separation, retry conflicts and History', async () => {
    const config = require('../main/db/payrollConfig');
    const payroll = require('../main/db/payroll');
    const loans = require('../main/db/employeeLoans');
    const settings = await ok(admin, 'payroll:getSettings');
    assert.equal(settings.policyConfirmed, false);
    const loanPolicy = await ok(loanUser, 'loans:getPolicy', { companyId: a.id });
    assert.deepEqual(Object.keys(loanPolicy).sort(), ['complianceWarning', 'installmentCurrency', 'installmentMinor', 'loanApprovalPolicy', 'maxDeductionPercent', 'policyConfirmed', 'postponementPolicy', 'rateChangePolicy']);
    assert.equal((await call(loanUser, 'payroll:getSettings')).status, 403);
    await ok(admin, 'payroll:updateSettings', { patch: { loanApprovalPolicy: 'designated_managers', rateChangePolicy: 'admin', postponementPolicy: 'admin' } });
    const input = { employeeId: e.id, principalMinor: 50000, currency: 'USD', disbursedOn: '2026-09-01', interestMethod: 'none', interestPolicy: 'separate', ratePercent: 0, interestFreeMonths: 3, installmentMinor: 10000, operationId: 'create-loan' };
    const loan = await ok(loanUser, 'loans:create', input);
    const duplicate = await ok(loanUser, 'loans:create', input);
    assert.equal(duplicate.id, loan.id);
    assert.notEqual((await call(loanUser, 'loans:create', { ...input, principalMinor: 60000 })).status, 200);
    await ok(loanUser, 'loans:approve', { id: loan.id });
    assert.equal(loans.get(a.id, loan.id).principalMinor, 50000);
    const excessiveProjection = await call(loanUser, 'loans:project', { id: loan.id, through: '9999-12-31' });
    assert.equal(excessiveProjection.status, 422);
    assert.match(excessiveProjection.error, /projection|horizon|months|years|limit/i);
    await assert.rejects(() => local('loans:project', { id: loan.id, through: '9999-12-31' }), /projection|horizon|months|years|limit/i);
    assert.notEqual((await call(loanUser, 'loans:voidDraft', { id: loan.id, reason: 'Active cannot be canceled', operationId: 'cancel-active' })).status, 200);
    const mistaken = await ok(loanUser, 'loans:create', { ...input, operationId: 'mistaken' });
    const cancel = { id: mistaken.id, reason: 'Mistaken draft', operationId: 'cancel-mistaken' };
    assert.equal((await ok(loanUser, 'loans:voidDraft', cancel)).status, 'void');
    assert.equal((await ok(loanUser, 'loans:voidDraft', cancel)).id, mistaken.id);
    assert.notEqual((await call(loanUser, 'loans:changeRate', { id: loan.id, effectiveFrom: '2026-10-01', ratePercent: 0, reason: 'Review', operationId: 'rate' })).status, 200);
    assert.notEqual((await call(loanUser, 'loans:postpone', { id: loan.id, month: '2026-10', reason: 'Review', operationId: 'postpone' })).status, 200);
    await ok(admin, 'payroll:updateSettings', { patch: { postponementPolicy: 'designated_managers' } });
    await ok(loanUser, 'loans:postpone', { id: loan.id, month: '2026-10', reason: 'Review', operationId: 'postpone' });
    const repayment = { id: loan.id, amountMinor: 10000, entryDate: '2026-10-09', source: 'cash', operationId: 'repayment' };
    await ok(loanUser, 'loans:repay', repayment); await ok(loanUser, 'loans:repay', repayment);
    assert.equal(loans.get(a.id, loan.id).principalMinor, 40000);
    assert.notEqual((await call(loanUser, 'loans:repay', { ...repayment, amountMinor: 20000 })).status, 200);
    assert.equal(loans.get(a.id, loan.id).principalMinor, 40000);
    const run = await ok(payrollUser, 'payroll:create', { periodStart: '2026-09-01', periodEnd: '2026-09-30', employeeIds: [e.id], kind: 'regular', operationId: 'run' });
    const calculated = await ok(payrollUser, 'payroll:calculate', { id: run.id });
    assert.notEqual((await call(payrollUser, 'payroll:review', { id: run.id, expectedRevision: calculated.revision - 1 })).status, 200);
    assert.notEqual((await call(payrollUser, 'payroll:approve', { id: run.id, expectedRevision: calculated.revision })).status, 200);
    assert.equal(payroll.get(a.id, run.id).status, 'draft');
    assert.notEqual((await call(payrollUser, 'payroll:getEmployeePolicy', { employeeId: other.id })).status, 200);
    for (const u of [payrollUser, loanUser, admin]) users.setActiveCompany(u.id, b.id);
    for (const [ch, id] of [['payroll:get', run.id], ['payroll:getWorkbook', run.id], ['payroll:getPayslipPdf', calculated.lines[0].id], ['loans:get', loan.id]]) {
      assert.notEqual((await call(admin, ch, { id })).status, 200, ch);
    }
    assert.equal(config.getSettings(a.id).postponementPolicy, 'designated_managers');
    for (const u of [payrollUser, loanUser, admin]) users.setActiveCompany(u.id, a.id);
    const audit = require('../main/db/auditLog');
    const ownHistory = await ok(payrollUser, 'audit:listRecent');
    assert.equal(ownHistory.some(x => x.sensitivity === 'payroll'), true);
    const privateHistory = await ok(hrUser, 'audit:listRecent');
    assert.equal(privateHistory.some(x => x.sensitivity === 'payroll' || audit.isPayrollEntityType(x.entityType)), false);
    users.setActiveCompany(payrollUser.id, b.id);
    assert.equal((await ok(payrollUser, 'audit:listRecent')).some(x => x.sensitivity === 'payroll'), false);
    assert.equal(await ok(payrollUser, 'audit:countForEntity', { entityType: 'employee_loan', entityId: loan.id }), 0);
    users.setActiveCompany(payrollUser.id, a.id);
    const before = audit.listForEntity('employee_loan', loan.id).length;
    await ok(admin, 'audit:clearHistory', { days: 0 });
    assert.equal(audit.listForEntity('employee_loan', loan.id).length, before);
    roles.update(payrollRole.key, { permissions: ['history.view'] });
    assert.equal((await call(payrollUser, 'payroll:get', { id: run.id })).status, 403);
  });

  await t.test('opening import is loan-cap scoped, atomic, retryable and drafts still require policy approval', async sub => {
    const loanService = require('../main/db/employeeLoans');
    const row = { loanNo: 'HTTP-OPEN', staffCode: 'A1', originalPrincipalMinor: 50000, currentPrincipalMinor: 20000,
      unpaidInterestMinor: 500, balanceAsOf: '2026-03-31', currency: 'USD', disbursedOn: '2026-01-01',
      interestMethod: 'declining', interestPolicy: 'separate', ratePercent: 2, interestFreeMonths: 0,
      installmentMinor: 10000, purpose: 'Synthetic opening' };
    const input = { companyId: a.id, rows: [row], operationId: 'http-opening' };
    const columns = await ok(loanUser, 'loans:importColumns', { companyId: a.id });
    assert.ok(columns.some(x => x.key === 'currentPrincipalMinor'));
    assert.equal((await call(hrUser, 'loans:importColumns')).status, 403);
    assert.equal((await call(payrollUser, 'loans:importColumns')).status, 403);
    assert.notEqual((await call(loanUser, 'loans:importColumns', { companyId: b.id })).status, 200);
    const before = loanService.list(a.id).length;
    const plan = await ok(loanUser, 'loans:importPlan', { rows: [row], companyId: a.id });
    assert.equal(plan.valid, true); assert.equal(plan.summary.create, 1);
    assert.equal(loanService.list(a.id).length, before);
    const malformed = { ...input, rows: [{ ...row, employeeId: other.id }] };
    assert.throws(() => local('loans:importApply', malformed), /Bad request:/);
    assert.equal((await call(loanUser, 'loans:importApply', malformed)).status, 400);
    assert.equal((await call(loanUser, 'loans:importApply', { rows: [row] })).status, 400);
    const rejected = await ok(loanUser, 'loans:importApply', { ...input, operationId: 'bad-opening', rows: [row, { ...row, loanNo: 'BAD-STAFF', staffCode: 'B1' }] });
    assert.equal(rejected.applied, false);
    assert.equal(loanService.list(a.id).length, before);
    const [first, retry] = await Promise.all([ok(loanUser, 'loans:importApply', input), ok(loanUser, 'loans:importApply', input)]);
    assert.deepEqual(first, retry); assert.equal(first.created, 1);
    assert.notEqual((await call(loanUser, 'loans:importApply', { ...input, rows: [{ ...row, currentPrincipalMinor: 10000 }] })).status, 200);
    const id = first.rows[0].loanId;
    assert.equal(loanService.get(a.id, id).status, 'draft');
    assert.equal(loanService.get(a.id, id).entries.length, 0);
    await ok(admin, 'payroll:updateSettings', { patch: { loanApprovalPolicy: 'admin' } });
    assert.notEqual((await call(loanUser, 'loans:approve', { id })).status, 200);
    await ok(admin, 'payroll:updateSettings', { patch: { loanApprovalPolicy: 'designated_managers' } });
    const approved = await ok(loanUser, 'loans:approve', { id });
    assert.equal(approved.principalMinor, 20000); assert.equal(approved.interestMinor, 500);
    assert.equal(approved.entries.length, 1); assert.equal(approved.entries[0].kind, 'opening_balance');
    assert.deepEqual(await ok(loanUser, 'loans:importApply', input), first);
    const sample = await ok(loanUser, 'loans:getImportSample', { companyId: a.id });
    assert.equal(sample.companyId, a.id);
    const bytes = Buffer.from(sample.bytes.__bin ? sample.bytes.b64 : sample.bytes, sample.bytes.__bin ? 'base64' : undefined);
    const XLSX = require('xlsx');
    assert.deepEqual(XLSX.read(bytes, { type: 'buffer' }).SheetNames, ['Loans', 'Instructions']);
    assert.notEqual((await call(loanUser, 'loans:saveImportSample', {})).status, 200);
    const file = path.join(dataDir, 'opening-sample-local.xlsx');
    saveDialog = async () => ({ filePath: file });
    assert.equal(await local('loans:saveImportSample', { companyId: a.id }), file);
    assert.deepEqual(XLSX.read(fs.readFileSync(file), { type: 'buffer' }).SheetNames, ['Loans', 'Instructions']);
    pickDialog = async () => ({ canceled: false, filePaths: [file] });
    assert.equal(await local('files:pickWorkbook'), file);
    assert.equal((await local('files:parseWorkbook', file)).sheets[0].name, 'Loans');
    await sub.test('standalone workbook rejects a relative path with the shared Bad request wording', () => {
      assert.throws(() => local('files:parseWorkbook', path.relative(process.cwd(), file)), /Bad request: an absolute path to a workbook/);
    });
    assert.throws(() => local('files:parseWorkbook', '/tmp/private.txt'), /Bad request:/);
    const denied = path.join(dataDir, 'opening-sample-denied.xlsx');
    saveDialog = async () => { companies.setActive(b.id); return { filePath: denied }; };
    await assert.rejects(() => local('loans:saveImportSample', { companyId: a.id }), /different company/);
    assert.equal(fs.existsSync(denied), false);
    companies.setActive(a.id);
    saveDialog = async () => ({ canceled: true });
    assert.equal(await local('loans:saveImportSample', {}), null);
  });

  await t.test('a manager approves their own real payroll only by policy; payments retry once and reverse atomically', async () => {
    roles.update(payrollRole.key, { permissions: ['payroll.manage', 'history.view'] });
    const own = employees.create({ companyId: a.id, staffCode: 'PAY-MANAGER', nameEn: 'Synthetic manager own salary', userId: payrollUser.id });
    const hr = require('../main/db/hr');
    const attendance = require('../main/db/attendance');
    const calc = require('../main/util/attendanceCalc');
    hr.ensurePrefilled(a.id);
    const schedule = hr.createSchedule({ companyId: a.id, name: 'Synthetic every day', startTime: '09:00', endTime: '17:00', breakMin: 0, workDays: '1111111', graceMin: 0 });
    hr.updateSettings(a.id, { defaultScheduleId: schedule.id, attendanceStartDate: '2026-01-01' });
    // Synthetic supplied configuration tests authority; these values are not legal seed defaults.
    await ok(admin, 'payroll:updateSettings', { patch: { approvalPolicy: 'admin', policyConfirmed: true,
      policySource: 'Synthetic professional evidence: pay frequency, deduction/recovery limits, lending/capitalization, statutory aggregation and FX/rounding',
      taxRateKhrPerUsd: 4000, rateSource: 'Synthetic salary FX', nssfRateKhrPerUsd: 4000, nssfRateSource: 'Separate synthetic NSSF FX' } });
    await ok(payrollUser, 'payroll:setEmployeePolicy', { employeeId: own.id, applyTax: false, applyNssf: false, taxResident: true, spouseCount: 0, dependentCount: 0, reason: 'Synthetic exemption fixture' });
    await ok(payrollUser, 'payroll:setPayRate', { employeeId: own.id, effectiveFrom: '2026-01-01', basis: 'month', amountMinor: 30000, currency: 'USD', reason: 'Synthetic rate' });
    const draft = await ok(payrollUser, 'payroll:saveRateSet', { name: 'Synthetic zero tables', effectiveFrom: '2026-01-01',
      nssf: { bands: [{ upperKhr: null, baseKhr: 0 }], components: [{ key: 'pension', employeePercent: 0, employerPercent: 0 }] },
      tax: { brackets: [{ upperKhr: null, ratePercent: 0 }], spouseAllowanceKhr: 0, dependentAllowanceKhr: 0, maxDependents: null,
        nonResidentPercent: 0, fringeBenefitPercent: 0, pensionDeductible: false } });
    const confirm = { id: draft.id, sourceNote: 'Synthetic fixture professional statutory source, not a legal default' };
    assert.equal((await call(payrollUser, 'payroll:confirmRateSet', confirm)).status, 403);
    assert.equal((await ok(admin, 'payroll:confirmRateSet', confirm)).confirmedByUserId, admin.id);
    for (let day = 1; day <= 30; day++) {
      const workDate = `2026-09-${String(day).padStart(2, '0')}`;
      for (const [kind, time] of [['in', '09:00'], ['out', '17:00']]) attendance.addManual({ companyId: a.id, employeeId: own.id,
        kind, at: calc.timeOnDate(workDate, time), workDate, reason: 'Synthetic attendance' });
    }
    const run = await ok(payrollUser, 'payroll:create', { employeeIds: [own.id], periodStart: '2026-09-01', periodEnd: '2026-09-30', kind: 'regular', statutoryRateSetId: draft.id, operationId: 'own-real-run' });
    let calculated = await ok(payrollUser, 'payroll:calculate', { id: run.id });
    let reviewed = await ok(payrollUser, 'payroll:review', { id: run.id, expectedRevision: calculated.revision });
    assert.notEqual((await call(payrollUser, 'payroll:approve', { id: run.id, expectedRevision: reviewed.revision })).status, 200);
    await ok(admin, 'payroll:updateSettings', { patch: { approvalPolicy: 'designated_managers' } });
    calculated = await ok(payrollUser, 'payroll:calculate', { id: run.id });
    reviewed = await ok(payrollUser, 'payroll:review', { id: run.id, expectedRevision: calculated.revision });
    const approved = await ok(payrollUser, 'payroll:approve', { id: run.id, expectedRevision: reviewed.revision });
    assert.equal(approved.status, 'approved'); assert.equal(approved.approvedByUserId, payrollUser.id);
    const line = approved.lines[0]; assert.equal(line.netMinor, 30000);
    const payment = { id: line.id, amountMinor: 10000, method: 'cash', paidAt: '2026-10-09', operationId: 'own-payment' };
    const [one, two] = await Promise.all([ok(payrollUser, 'payroll:pay', payment), ok(payrollUser, 'payroll:pay', payment)]);
    assert.equal(one.id, two.id);
    assert.notEqual((await call(payrollUser, 'payroll:pay', { ...payment, amountMinor: 20000 })).status, 200);
    const paid = await ok(payrollUser, 'payroll:get', { id: run.id });
    assert.equal(paid.lines[0].paidMinor, 10000); assert.equal(paid.lines[0].remainingMinor, 20000);
    assert.equal(paid.payments.length, 1);
    assert.notEqual((await call(payrollUser, 'payroll:voidRun', { id: run.id, reason: 'Manager cannot void approved' })).status, 200);
    const reversal = { id: one.id, reason: 'Synthetic correction', operationId: 'reverse-own-payment' };
    assert.equal((await call(payrollUser, 'payroll:reversePayment', reversal)).status, 403);
    await ok(admin, 'payroll:reversePayment', reversal);
    assert.equal((await ok(payrollUser, 'payroll:get', { id: run.id })).lines[0].paidMinor, 0);
    assert.equal((await ok(admin, 'payroll:voidRun', { id: run.id, reason: 'Synthetic void after reversal' })).status, 'void');
  });

  await t.test('own kiosk documents, frozen names and permissions/company/state after async export', async () => {
    roles.update(payrollRole.key, { permissions: ['payroll.manage', 'history.view'] });
    const payroll = require('../main/db/payroll');
    const people = require('../main/db/hrPeople');
    const input = { periodStart: '2026-08-01', periodEnd: '2026-08-31', employeeIds: [e.id], kind: 'regular', operationId: 'export-run' };
    const run = await ok(payrollUser, 'payroll:create', input);
    const calculated = await ok(payrollUser, 'payroll:calculate', { id: run.id });
    const line = calculated.lines[0];
    // Transport-only approved fixture; this deliberately does not assert statutory approval.
    db.getDb().prepare("UPDATE payroll_runs SET status='approved' WHERE id=?").run(run.id);
    const sessionToken = people.createSession({ kioskUserId: kiosk.id, employeeId: e.id, companyId: a.id });
    const otherToken = people.createSession({ kioskUserId: kiosk.id, employeeId: other.id, companyId: a.id });
    assert.equal((await ok(kiosk, 'kiosk:payroll', { sessionToken }))[0].id, line.id);
    assert.equal((await call(kiosk, 'kiosk:payroll', { sessionToken, employeeId: other.id })).status, 400);
    assert.notEqual((await call(kiosk2, 'kiosk:payroll', { sessionToken })).status, 200);
    assert.notEqual((await call(kiosk, 'kiosk:getPayslipPdf', { sessionToken: otherToken, id: line.id })).status, 200);
    assert.equal((await call(kiosk, 'payroll:get', { id: run.id })).status, 403);
    const ownLoans = await ok(kiosk, 'kiosk:loans', { sessionToken });
    for (const loan of ownLoans) assert.deepEqual(Object.keys(loan).sort(), ['currency', 'id', 'interestMinor', 'loanNo', 'principalMinor', 'status']);
    employees.update(e.id, { nameEn: 'Changed current name' });
    const output = await ok(payrollUser, 'payroll:getWorkbook', { id: run.id, companyId: a.id });
    const XLSX = require('xlsx');
    const bytes = Buffer.from(output.bytes.__bin ? output.bytes.b64 : output.bytes, output.bytes.__bin ? 'base64' : undefined);
    const wb = XLSX.read(bytes, { type: 'buffer' });
    const cells = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1 });
    assert.equal(cells[1][9], 'Historical name');
    assert.equal(JSON.stringify(cells).includes('Changed current name'), false);

    const renderer = require('../main/renderWindow');
    const original = renderer.toPdfBuffer;
    t.after(() => { renderer.toPdfBuffer = original; });
    let afterRender = () => {};
    renderer.toPdfBuffer = async (html, options) => {
      assert.equal(options.pageSize, 'A5');
      assert.match(html, /Historical name/);
      assert.doesNotMatch(html, /Changed current name/);
      await afterRender();
      return Buffer.from('%PDF-test-boundary');
    };
    await ok(kiosk, 'kiosk:getPayslipPdf', { sessionToken, id: line.id });
    afterRender = () => users.setActiveCompany(payrollUser.id, b.id);
    assert.notEqual((await call(payrollUser, 'payroll:getPayslipPdf', { id: line.id })).status, 200);
    users.setActiveCompany(payrollUser.id, a.id);
    afterRender = () => roles.update(payrollRole.key, { permissions: ['history.view'] });
    assert.notEqual((await call(payrollUser, 'payroll:getPayslipPdf', { id: line.id })).status, 200);
    roles.update(payrollRole.key, { permissions: ['payroll.manage', 'history.view'] });
    afterRender = () => users.setDeactivated(payrollUser.id, true);
    assert.notEqual((await call(payrollUser, 'payroll:getPayslipPdf', { id: line.id })).status, 200);
    users.setDeactivated(payrollUser.id, false);
    afterRender = () => db.getDb().prepare("UPDATE payroll_runs SET status='void' WHERE id=?").run(run.id);
    assert.notEqual((await call(payrollUser, 'payroll:getPayslipPdf', { id: line.id })).status, 200, 'cannot return FINAL PDF after run void');
    db.getDb().prepare("UPDATE payroll_runs SET status='approved' WHERE id=?").run(run.id);
    afterRender = () => people.endSession(sessionToken);
    assert.notEqual((await call(kiosk, 'kiosk:getPayslipPdf', { sessionToken, id: line.id })).status, 200);
    afterRender = () => {};
    saveDialog = async () => { companies.setActive(b.id); return { filePath: path.join(dataDir, 'must-not-write.xlsx') }; };
    await assert.rejects(() => local('payroll:saveWorkbook', { id: run.id, companyId: a.id }), /different company/);
    assert.equal(fs.existsSync(path.join(dataDir, 'must-not-write.xlsx')), false);
    companies.setActive(a.id);
    saveDialog = async () => ({ canceled: true });
    assert.equal(await local('payroll:saveWorkbook', { id: run.id, companyId: a.id }), null);
    assert.equal(payroll.get(a.id, run.id).id, run.id);
  });

  await t.test('run and line statutory overrides reach real services and exports preserve frozen leave types', async () => {
    const leave = require('../main/db/leave');
    const firstType = leave.createType({ companyId: a.id, code: 'TRANSPORT_AL', nameEn: 'Frozen annual transport', tracksBalance: true });
    const secondType = leave.createType({ companyId: a.id, code: 'TRANSPORT_SL', nameEn: 'Frozen sick transport', tracksBalance: true });
    for (const [type, days] of [[firstType, 10.5], [secondType, 6.5]]) {
      leave.adjust({ companyId: a.id, employeeId: e.id, leaveTypeId: type.id, days, date: '2026-06-30', note: 'Synthetic opening' });
    }
    await ok(payrollUser, 'payroll:setEmployeePolicy', { employeeId: e.id, applyTax: true, applyNssf: false, taxResident: true, spouseCount: 0, dependentCount: 0, reason: 'Synthetic employee exemption' });
    const input = { companyId: a.id, employeeIds: [e.id], periodStart: '2026-06-01', periodEnd: '2026-06-30', kind: 'regular',
      operationId: 'override-transport', statutoryOverride: { applyTax: false, reason: 'Synthetic run exemption' } };
    const malformed = { ...input, statutoryOverride: { ...input.statutoryOverride, actor: 'forged' } };
    assert.throws(() => local('payroll:create', malformed), /Bad request:/);
    assert.equal((await call(payrollUser, 'payroll:create', malformed)).status, 400);
    const run = await ok(payrollUser, 'payroll:create', input);
    assert.deepEqual(run.input.statutoryOverride, input.statutoryOverride);
    assert.notEqual((await call(payrollUser, 'payroll:create', { ...input, statutoryOverride: { applyTax: false, reason: 'Changed reason' } })).status, 200);
    let calculated = await ok(payrollUser, 'payroll:calculate', { id: run.id });
    assert.equal(calculated.lines[0].snapshot.policy.applyTax, false);
    const change = { id: calculated.lines[0].id, expectedRevision: calculated.revision, companyId: a.id,
      patch: { statutoryOverride: { applyNssf: true, reason: 'Synthetic line enrollment' } } };
    calculated = await ok(payrollUser, 'payroll:updateLine', change);
    assert.equal(calculated.lines[0].snapshot.policy.applyTax, false);
    assert.equal(calculated.lines[0].snapshot.policy.applyNssf, true);
    assert.equal((await call(payrollUser, 'payroll:updateLine', { ...change, patch: { statutoryOverride: { applyTax: false } } })).status, 400);
    await assert.rejects(() => local('payroll:updateLine', change), /revision|superseded|stale/i);
    calculated = await local('payroll:updateLine', { id: calculated.lines[0].id, expectedRevision: calculated.revision,
      patch: { statutoryOverride: null }, companyId: a.id });
    const line = calculated.lines[0];
    assert.equal(line.snapshot.policy.applyNssf, false);
    assert.equal(line.snapshot.leaveBalanceAsOf, '2026-06-30');
    assert.deepEqual(line.snapshot.leaveBalances.filter(x => [firstType.id, secondType.id].includes(x.leaveTypeId)).map(x => x.days), [10.5, 6.5]);
    // Freeze the output for this transport fixture, then alter live labels/balances.
    db.getDb().prepare("UPDATE payroll_runs SET status='approved' WHERE id=?").run(run.id);
    leave.updateType(firstType.id, { nameEn: 'Current annual label' });
    leave.adjust({ companyId: a.id, employeeId: e.id, leaveTypeId: firstType.id, days: 99, date: '2026-06-30', note: 'Later live correction' });
    const renderer = require('../main/renderWindow');
    const previousRender = renderer.toPdfBuffer;
    renderer.toPdfBuffer = async html => {
      assert.match(html, /Frozen annual transport.*10\.5 days/);
      assert.match(html, /Frozen sick transport.*6\.5 days/);
      assert.doesNotMatch(html, /Current annual label|109\.5 days/);
      return Buffer.from('%PDF-frozen-leave');
    };
    try {
      await ok(payrollUser, 'payroll:getRunPdf', { id: run.id });
      await ok(payrollUser, 'payroll:getPayslipPdf', { id: line.id });
      const output = await ok(payrollUser, 'payroll:getWorkbook', { id: run.id });
      const XLSX = require('xlsx');
      const bytes = Buffer.from(output.bytes.__bin ? output.bytes.b64 : output.bytes, output.bytes.__bin ? 'base64' : undefined);
      const workbook = XLSX.read(bytes, { type: 'buffer' });
      const cells = JSON.stringify(XLSX.utils.sheet_to_json(workbook.Sheets.Register, { header: 1 }));
      assert.match(cells, /Frozen annual transport.*10\.5 days/);
      assert.match(cells, /Frozen sick transport.*6\.5 days/);
      assert.doesNotMatch(cells, /Current annual label|109\.5 days/);
    } finally { renderer.toPdfBuffer = previousRender; }
  });

  await t.test('whole-run PDFs recheck run revision/status and authority after rendering and local save dialogs', async () => {
    const second = employees.create({ companyId: a.id, staffCode: 'A2', nameEn: 'Second frozen employee' });
    const created = await ok(payrollUser, 'payroll:create', { periodStart: '2026-07-01', periodEnd: '2026-07-31',
      employeeIds: [e.id, second.id], kind: 'regular', operationId: 'whole-run-pdf' });
    const run = await ok(payrollUser, 'payroll:calculate', { id: created.id });
    employees.update(second.id, { nameEn: 'Current second name' });
    const args = { id: run.id, companyId: a.id };
    const renderer = require('../main/renderWindow');
    const previousRender = renderer.toPdfBuffer;
    let afterRender = () => {};
    renderer.toPdfBuffer = async (html, options) => {
      assert.equal(options.pageSize, 'A5');
      assert.match(html, /Second frozen employee/);
      assert.match(html, /Changed current name/);
      assert.doesNotMatch(html, /Current second name/);
      await afterRender();
      return Buffer.from('%PDF-whole-run');
    };
    try {
      assert.equal((await ok(payrollUser, 'payroll:getRunPdf', args)).companyId, a.id);
      assert.equal((await call(hrUser, 'payroll:getRunPdf', args)).status, 403);
      assert.equal((await call(kiosk, 'payroll:getRunPdf', args)).status, 403);
      assert.notEqual((await call(payrollUser, 'payroll:getRunPdf', { ...args, companyId: b.id })).status, 200);
      assert.throws(() => local('payroll:saveRunPdf', { ...args, actor: 'forged' }), /Bad request/);
      assert.equal((await call(payrollUser, 'payroll:getRunPdf', { ...args, actor: 'forged' })).status, 400);
      afterRender = () => db.getDb().prepare('UPDATE payroll_runs SET revision=revision+1 WHERE id=?').run(run.id);
      assert.match((await call(payrollUser, 'payroll:getRunPdf', args)).error, /changed while rendering/i);
      afterRender = () => db.getDb().prepare("UPDATE payroll_runs SET status='void' WHERE id=?").run(run.id);
      assert.match((await call(payrollUser, 'payroll:getRunPdf', args)).error, /changed while rendering/i);
      afterRender = () => users.setActiveCompany(payrollUser.id, b.id);
      assert.notEqual((await call(payrollUser, 'payroll:getRunPdf', args)).status, 200);
      users.setActiveCompany(payrollUser.id, a.id);
      afterRender = () => roles.update(payrollRole.key, { permissions: ['history.view'] });
      assert.notEqual((await call(payrollUser, 'payroll:getRunPdf', args)).status, 200);
      roles.update(payrollRole.key, { permissions: ['payroll.manage', 'history.view'] });
      afterRender = () => {};
      saveDialog = async () => ({ canceled: true });
      assert.equal(await local('payroll:saveRunPdf', args), null);
      const output = path.join(dataDir, 'whole-run-local.pdf');
      saveDialog = async options => {
        assert.deepEqual(options.filters, [{ name: 'PDF', extensions: ['pdf'] }]);
        return { filePath: output };
      };
      assert.equal(await local('payroll:saveRunPdf', args), output);
      assert.equal(fs.readFileSync(output, 'utf8'), '%PDF-whole-run');
      const denied = path.join(dataDir, 'whole-run-denied.pdf');
      saveDialog = async () => { companies.setActive(b.id); return { filePath: denied }; };
      await assert.rejects(() => local('payroll:saveRunPdf', args), /different company/);
      assert.equal(fs.existsSync(denied), false);
    } finally {
      companies.setActive(a.id);
      saveDialog = async () => ({ canceled: true });
      renderer.toPdfBuffer = previousRender;
    }
  });

  await t.test('actual client save bridge gets bytes from this server and reauthorizes after the local dialog', async sub => {
    const Module = require('node:module');
    const originalLoad = Module._load;
    const nativeSetTimeout = global.setTimeout;
    let client;
    const clientConfig = { clientServerUrl: `http://127.0.0.1:${port}`, clientToken: payrollUser.token };
    Module._load = function(request, parent, isMain) {
      if (request === 'ws') return class { on() {} };
      return originalLoad.call(this, request, parent, isMain);
    };
    // Suppress only background reconnect/polling at registration; actual HTTP RPC stays real.
    global.setTimeout = (fn, delay, ...args) => delay >= 500 ? { unref() {} } : nativeSetTimeout(fn, delay, ...args);
    try {
      client = require('../main/client');
      client.registerClientProxies(() => clientConfig);
    } finally { Module._load = originalLoad; global.setTimeout = nativeSetTimeout; }
    const run = require('../main/db/payroll').list(a.id).find(r => r.status === 'void');
    assert.ok(run);
    const args = { id: run.id, companyId: a.id };
    assert.equal((await client.rpc('payroll:get', args)).id, run.id);
    const renderer = require('../main/renderWindow');
    const previousRender = renderer.toPdfBuffer;
    renderer.toPdfBuffer = async (_html, options) => { assert.equal(options.pageSize, 'A5'); return Buffer.from('%PDF-client-run'); };
    try {
      const pdfPath = path.join(dataDir, 'whole-run-client.pdf');
      saveDialog = async options => { assert.equal(options.filters[0].extensions[0], 'pdf'); return { filePath: pdfPath }; };
      assert.equal(await local('payroll:saveRunPdf', args), pdfPath);
      assert.equal(fs.readFileSync(pdfPath, 'utf8'), '%PDF-client-run');
      saveDialog = async () => ({ canceled: true });
      assert.equal(await local('payroll:saveRunPdf', args), null);
      const denied = path.join(dataDir, 'whole-run-client-denied.pdf');
      saveDialog = async () => { roles.update(payrollRole.key, { permissions: ['history.view'] }); return { filePath: denied }; };
      await assert.rejects(() => local('payroll:saveRunPdf', args), /permission|allowed|access|forbidden/i);
      assert.equal(fs.existsSync(denied), false);
    } finally {
      roles.update(payrollRole.key, { permissions: ['payroll.manage', 'history.view'] });
      renderer.toPdfBuffer = previousRender;
    }
    assert.throws(() => local('payroll:saveWorkbook', { ...args, actor: 'forged' }), /Bad request: unknown field: actor/);
    saveDialog = async () => ({ canceled: true });
    assert.equal(await local('payroll:saveWorkbook', args), null);
    const outputPath = path.join(dataDir, 'client-payroll.xlsx');
    saveDialog = async options => {
      assert.deepEqual(options.filters, [{ name: 'Workbook', extensions: ['xlsx'] }]);
      return { filePath: outputPath };
    };
    assert.equal(await local('payroll:saveWorkbook', args), outputPath);
    const XLSX = require('xlsx');
    const wb = XLSX.read(fs.readFileSync(outputPath), { type: 'buffer' });
    assert.deepEqual(wb.SheetNames, ['Register', 'Bank transfer', 'NSSF', 'Salary tax', 'Notes']);
    const deniedPath = path.join(dataDir, 'client-must-not-write.xlsx');
    saveDialog = async () => {
      users.setActiveCompany(payrollUser.id, b.id);
      return { filePath: deniedPath };
    };
    await assert.rejects(() => local('payroll:saveWorkbook', args), /different company/);
    assert.equal(fs.existsSync(deniedPath), false);
    users.setActiveCompany(payrollUser.id, a.id);
    saveDialog = async () => {
      roles.update(payrollRole.key, { permissions: ['history.view'] });
      return { filePath: deniedPath };
    };
    await assert.rejects(() => local('payroll:saveWorkbook', args), /permission|allowed|access|forbidden/i);
    assert.equal(fs.existsSync(deniedPath), false);
    roles.update(payrollRole.key, { permissions: ['payroll.manage', 'history.view'] });
    saveDialog = async () => ({ canceled: true });
    clientConfig.clientToken = loanUser.token;
    assert.ok((await local('loans:importColumns', { companyId: a.id })).some(x => x.key === 'loanNo'));
    assert.equal(await local('loans:saveImportSample', { companyId: a.id }), null);
    const samplePath = path.join(dataDir, 'opening-sample-client.xlsx');
    saveDialog = async () => ({ filePath: samplePath });
    assert.equal(await local('loans:saveImportSample', { companyId: a.id }), samplePath);
    assert.deepEqual(XLSX.read(fs.readFileSync(samplePath), { type: 'buffer' }).SheetNames, ['Loans', 'Instructions']);
    pickDialog = async () => ({ canceled: false, filePaths: [samplePath] });
    assert.equal(await local('files:pickWorkbook'), samplePath);
    assert.equal((await local('files:parseWorkbook', samplePath)).sheets[0].name, 'Loans');
    await sub.test('client workbook rejects a relative path before local parsing', () => {
      assert.throws(() => local('files:parseWorkbook', path.relative(process.cwd(), samplePath)), /Bad request: an absolute path to a workbook/);
    });
    await sub.test('client workbook calls enforce fresh shared capabilities, including existing product and asset grants', async () => {
      try {
        for (const cap of ['products.edit', 'assets.manage', 'loans.manage']) {
          roles.update(loanRole.key, { permissions: [cap, 'history.view'] });
          assert.equal(await local('files:pickWorkbook'), samplePath, cap);
          assert.equal((await local('files:parseWorkbook', samplePath)).sheets[0].name, 'Loans', cap);
        }
        roles.update(loanRole.key, { permissions: ['history.view'] });
        let dialogs = 0;
        pickDialog = async () => { dialogs++; return { canceled: false, filePaths: [samplePath] }; };
        await assert.rejects(async () => local('files:parseWorkbook', samplePath), /permission|allowed|access|forbidden/i);
        await assert.rejects(async () => local('files:pickWorkbook'), /permission|allowed|access|forbidden/i);
        assert.equal(dialogs, 0);
      } finally { roles.update(loanRole.key, { permissions: ['loans.manage', 'history.view'] }); }
    });
    for (const change of ['permission', 'company', 'connection']) await sub.test(`client workbook picker refuses ${change} changes during the dialog`, async () => {
      pickDialog = async () => {
        if (change === 'permission') roles.update(loanRole.key, { permissions: ['history.view'] });
        if (change === 'company') users.setActiveCompany(loanUser.id, b.id);
        if (change === 'connection') clientConfig.clientToken = admin.token;
        return { canceled: false, filePaths: [samplePath] };
      };
      try {
        await assert.rejects(async () => local('files:pickWorkbook'), /permission|allowed|access|forbidden|company|connection/i);
      } finally {
        roles.update(loanRole.key, { permissions: ['loans.manage', 'history.view'] });
        users.setActiveCompany(loanUser.id, a.id);
        clientConfig.clientToken = loanUser.token;
      }
    });
    pickDialog = async () => ({ canceled: true, filePaths: [] });
    assert.equal(await local('files:pickWorkbook'), null);
    assert.throws(() => local('files:parseWorkbook', '/tmp/private.txt'), /Bad request:/);
    assert.throws(() => local('loans:saveImportSample', { companyId: a.id, actor: 'forged' }), /Bad request:/);
    const sampleDenied = path.join(dataDir, 'opening-sample-client-denied.xlsx');
    saveDialog = async () => { users.setActiveCompany(loanUser.id, b.id); return { filePath: sampleDenied }; };
    await assert.rejects(() => local('loans:saveImportSample', { companyId: a.id }), /different company/);
    assert.equal(fs.existsSync(sampleDenied), false);
    users.setActiveCompany(loanUser.id, a.id);
    saveDialog = async () => { roles.update(loanRole.key, { permissions: ['history.view'] }); return { filePath: sampleDenied }; };
    await assert.rejects(() => local('loans:saveImportSample', { companyId: a.id }), /permission|allowed|access|forbidden/i);
    assert.equal(fs.existsSync(sampleDenied), false);
    roles.update(loanRole.key, { permissions: ['loans.manage', 'history.view'] });
    saveDialog = async () => { clientConfig.clientToken = admin.token; return { filePath: sampleDenied }; };
    await assert.rejects(() => local('loans:saveImportSample', { companyId: a.id }), /Connection changed/);
    assert.equal(fs.existsSync(sampleDenied), false);
  });
});
