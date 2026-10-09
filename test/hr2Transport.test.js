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
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
    app: { getVersion: () => '0.0.0-hr2-test', getPath: () => dataDir },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    dialog: { showSaveDialog: (...args) => saveDialog(...args) },
  } };
  t.after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });
  const helpers = require('../main/ipc/helpers');
  for (const domain of ['payroll', 'loans', 'hr', 'audit']) require(`../main/ipc/${domain}`).register(helpers);
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

  await t.test('actual client save bridge gets bytes from this server and reauthorizes after the local dialog', async () => {
    const Module = require('node:module');
    const originalLoad = Module._load;
    const nativeSetTimeout = global.setTimeout;
    let client;
    Module._load = function(request, parent, isMain) {
      if (request === 'ws') return class { on() {} };
      return originalLoad.call(this, request, parent, isMain);
    };
    // Suppress only background reconnect/polling at registration; actual HTTP RPC stays real.
    global.setTimeout = (fn, delay, ...args) => delay >= 500 ? { unref() {} } : nativeSetTimeout(fn, delay, ...args);
    try {
      client = require('../main/client');
      client.registerClientProxies(() => ({ clientServerUrl: `http://127.0.0.1:${port}`, clientToken: payrollUser.token }));
    } finally { Module._load = originalLoad; global.setTimeout = nativeSetTimeout; }
    const run = require('../main/db/payroll').list(a.id).find(r => r.status === 'void');
    assert.ok(run);
    const args = { id: run.id, companyId: a.id };
    assert.equal((await client.rpc('payroll:get', args)).id, run.id);
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
  });
});
