const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let skip = false;
try { new (require('better-sqlite3'))(':memory:').close(); }
catch (e) {
  if (e.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(e.message)) skip = 'Run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/hr2LoanImportNative.test.js';
  else throw e;
}
const row = (patch = {}) => ({
  loanNo: 'OPEN-1', staffCode: 'A', originalPrincipalMinor: 50000,
  currentPrincipalMinor: 20000, unpaidInterestMinor: 500, balanceAsOf: '2026-03-31',
  currency: 'USD', disbursedOn: '2026-01-01', interestMethod: 'declining',
  interestPolicy: 'separate', ratePercent: 2, interestFreeMonths: 0,
  installmentMinor: 10000, maxDeductionPercent: 100, deductViaPayroll: true,
  purpose: 'Opening paper balance', ...patch
});
function fixture(fn) {
  const dbModule = require('../main/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-loan-import-'));
  dbModule.initDb(dir);
  try {
    const companies = require('../main/db/companies');
    const employees = require('../main/db/employees');
    const a = companies.create({ name: 'Synthetic opening A' }).id;
    const b = companies.create({ name: 'Synthetic opening B' }).id;
    const e = employees.create({ companyId: a, staffCode: 'A', nameEn: 'Synthetic A' }).id;
    const other = employees.create({ companyId: b, staffCode: 'B', nameEn: 'Synthetic B' }).id;
    return fn({ db: dbModule.getDb(), dbModule, dir, a, b, e, other,
      imports: require('../main/db/loanImports'), loans: require('../main/db/employeeLoans') });
  } finally { dbModule.closeDb(); }
}
function imported(x, patch = {}, operationId = 'import') {
  const res = x.imports.apply(x.a, { rows: [row(patch)], operationId });
  assert.equal(res.applied, true);
  return x.loans.get(x.a, res.rows[0].loanId);
}
for (const loanNo of ['OPEN-1', ' OPEN-1 ']) {
  test(`opening loan key stays canonical when reimported as ${JSON.stringify(loanNo)} with new operation IDs`, { skip }, () => fixture(x => {
    const first = x.imports.apply(x.a, { rows: [row({ loanNo: ' OPEN-1 ' })], operationId: 'spaced-create' });
    const id = first.rows[0].loanId;
    const repeated = x.imports.apply(x.a, { rows: [row({ loanNo })], operationId: 'draft-repeat-new-operation' });
    assert.equal(repeated.rows[0].loanId, id);
    assert.equal(repeated.skipped, 1);
    assert.equal(first.rows[0].values.loanNo, 'OPEN-1');
    assert.equal(x.db.prepare('SELECT loan_no FROM employee_loans WHERE id=?').get(id).loan_no, 'OPEN-1');
    const preview = x.imports.preview(x.a, { rows: [row({ loanNo })] });
    assert.equal(preview.rows[0].loanNo, 'OPEN-1');
    assert.equal(preview.rows[0].values.loanNo, 'OPEN-1');
    const updatedRow = row({ loanNo, purpose: 'Reviewed paper balance' });
    const updated = x.imports.apply(x.a, { rows: [updatedRow], operationId: 'draft-update-new-operation' });
    assert.equal(updated.updated, 1);
    assert.equal(updated.rows[0].loanId, id);
    assert.equal(x.loans.get(x.a, id).purpose, 'Reviewed paper balance');
    x.loans.approve(x.a, id);
    const approvedRepeat = x.imports.apply(x.a, { rows: [updatedRow], operationId: 'approved-repeat-new-operation' });
    assert.equal(approvedRepeat.skipped, 1);
    assert.equal(approvedRepeat.rows[0].loanId, id);
    x.loans.approve(x.a, approvedRepeat.rows[0].loanId);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM employee_loans WHERE company_id=?').get(x.a).n, 1);
    const ledger = x.db.prepare('SELECT kind,amount_minor,principal_part,interest_part FROM loan_entries WHERE company_id=?').all(x.a);
    assert.deepEqual(ledger, [{ kind: 'opening_balance', amount_minor: 20500, principal_part: 20000, interest_part: 500 }]);
  }));
}
test('opening preview writes nothing; approval posts literal balances once without cash or invented repayments', { skip }, () => fixture(x => {
  const p = x.imports.preview(x.a, { rows: [row(), row({ loanNo: 'KHR', currency: 'KHR', originalPrincipalMinor: 2000000, currentPrincipalMinor: 800000, unpaidInterestMinor: 20000 })] });
  assert.equal(p.valid, true);
  assert.deepEqual(p.summary, { total: 2, create: 2, update: 0, skip: 0, error: 0 });
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM employee_loans').get().n, 0);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payroll_operations').get().n, 0);
  const l = imported(x);
  assert.equal(l.status, 'draft');
  assert.equal(l.entries.length, 0);
  assert.equal(l.openingPrincipalMinor, 20000);
  assert.equal(l.openingInterestMinor, 500);
  assert.equal(l.balanceAsOf, '2026-03-31');
  const approved = x.loans.approve(x.a, l.id);
  assert.equal(approved.originalPrincipalMinor, 50000);
  assert.equal(approved.principalMinor, 20000);
  assert.equal(approved.interestMinor, 500);
  assert.deepEqual(approved.entries.map(e => [e.kind, e.entryDate, e.source, e.amountMinor, e.principalPart, e.interestPart]), [['opening_balance', '2026-03-31', 'import', 20500, 20000, 500]]);
  assert.equal(x.loans.approve(x.a, l.id).entries.length, 1);
  const k = imported(x, { loanNo: 'KHR', currency: 'KHR', originalPrincipalMinor: 2000000, currentPrincipalMinor: 800000, unpaidInterestMinor: 20000 }, 'khr');
  assert.equal(x.loans.approve(x.a, k.id).principalMinor, 800000);
  assert.equal(x.loans.get(x.a, k.id).interestMinor, 20000);
}));
test('draft reimport preserves blank fields and audits the merged terms; receipts survive reopening and later approval', { skip }, () => fixture(x => {
  const l = imported(x);
  const p = { rows: [{ loanNo: 'OPEN-1', staffCode: ' ', purpose: null, originalPrincipalMinor: '', currentPrincipalMinor: 18000, ratePercent: 3, deductViaPayroll: false }], operationId: 'patch' };
  const result = x.imports.apply(x.a, p);
  assert.equal(result.updated, 1);
  const next = x.loans.get(x.a, l.id);
  assert.equal(next.originalPrincipalMinor, 50000);
  assert.equal(next.openingPrincipalMinor, 18000);
  assert.equal(next.openingInterestMinor, 500);
  assert.equal(next.purpose, 'Opening paper balance');
  assert.equal(next.deductViaPayroll, false);
  assert.equal(next.rates[0].ratePercent, 3);
  const audit = x.db.prepare("SELECT * FROM audit_log WHERE entity_id=? AND action='import_update'").get(l.id);
  assert.equal(audit.sensitivity, 'payroll');
  assert.equal(JSON.parse(audit.after_json).currentPrincipalMinor, 18000);
  x.loans.approve(x.a, l.id);
  x.dbModule.closeDb(); x.dbModule.initDb(x.dir);
  assert.deepEqual(x.imports.apply(x.a, p), result);
  assert.throws(() => x.imports.apply(x.a, { ...p, rows: [{ loanNo: 'OPEN-1', currentPrincipalMinor: 17000 }] }), /different request/i);
  assert.equal(x.loans.get(x.a, l.id).entries.length, 1);
  assert.equal(x.dbModule.getAppState('schema_version'), '2');
}));
test('company staff resolution and loan keys never accept caller IDs or financial authority', { skip }, () => fixture(x => {
  assert.equal(x.imports.preview(x.a, { rows: [row({ staffCode: 'B' })] }).valid, false);
  for (const patch of [{ employeeId: x.other }, { approvedByUserId: 'admin' }, { status: 'active' }, { companyId: x.b }]) {
    assert.equal(x.imports.preview(x.a, { rows: [row(patch)] }).valid, false);
  }
  const aLoan = imported(x);
  const bRes = x.imports.apply(x.b, { rows: [row({ staffCode: 'B' })], operationId: 'import' });
  assert.equal(bRes.created, 1);
  assert.notEqual(bRes.rows[0].loanId, aLoan.id);
  assert.throws(() => x.loans.get(x.a, bRes.rows[0].loanId), /company/i);
}));
test('all rows get known outcomes and malformed batches write no loans, audit or receipts', { skip }, () => fixture(x => {
  const before = x.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  const res = x.imports.apply(x.a, { rows: [row(), null, row({ loanNo: 'BAD', currentPrincipalMinor: 1.5 })], operationId: 'bad-batch' });
  assert.equal(res.applied, false);
  assert.deepEqual(res.rows.map(r => r.action), ['blocked', 'error', 'error']);
  assert.equal(res.rows.length, 3);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM employee_loans').get().n, 0);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, before);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payroll_operations').get().n, 0);
  assert.equal(x.imports.preview(x.a, { rows: [row(), row()] }).valid, false);
  const sparse = []; sparse.length = 2; sparse[0] = row();
  assert.equal(x.imports.preview(x.a, { rows: sparse }).rows[1].action, 'error');
  assert.throws(() => x.imports.preview(x.a, { rows: Array.from({ length: 501 }, () => row()) }), /500/i);
}));
test('strict mapped values reject unsafe money, impossible dates, missing original principal and invalid terms', { skip }, () => fixture(x => {
  for (const patch of [
    { originalPrincipalMinor: null }, { originalPrincipalMinor: 0 }, { currentPrincipalMinor: -1 },
    { unpaidInterestMinor: -1 }, { currentPrincipalMinor: '20000' }, { currency: 'EUR' },
    { currentPrincipalMinor: Number.MAX_SAFE_INTEGER, unpaidInterestMinor: 1 },
    { balanceAsOf: '2026-02-30' }, { balanceAsOf: '2026-03-30' }, { balanceAsOf: '2099-01-31' },
    { disbursedOn: '2026-04-01' }, { disbursedOn: '0000-01-01' },
    { interestMethod: 'none', ratePercent: 2 }, { interestFreeMonths: 121 },
    { interestFreeMonths: 0.5 }, { installmentMinor: 0 }, { maxDeductionPercent: 101 },
    { deductViaPayroll: 'yes' }, { ratePercent: NaN }, { purpose: {} }
  ]) assert.equal(x.imports.preview(x.a, { rows: [row(patch)] }).valid, false, JSON.stringify(patch));
}));
test('identical approved import skips even after repayments; changed active input is an actionable refusal', { skip }, () => fixture(x => {
  const l = imported(x);
  x.loans.approve(x.a, l.id);
  x.loans.repay(x.a, { id: l.id, amountMinor: 1500, entryDate: '2026-04-01', source: 'cash', operationId: 'pay' });
  const res = x.imports.apply(x.a, { rows: [row()], operationId: 'reimport' });
  assert.equal(res.skipped, 1);
  for (const patch of [{ currentPrincipalMinor: 19000 }, { purpose: 'Changed' }, { ratePercent: 3 }]) {
    const bad = x.imports.apply(x.a, { rows: [row(patch)], operationId: `changed-${Object.keys(patch)[0]}` });
    assert.equal(bad.applied, false);
    assert.match(bad.rows[0].errors.join(' '), /approved|active|history/i);
  }
  assert.equal(x.loans.get(x.a, l.id).principalMinor, 19000);
  assert.equal(x.loans.get(x.a, l.id).entries.length, 2);
}));
test('opening accrual never invents earlier interest and refuses repayment/rate changes before opening', { skip }, () => fixture(x => {
  const l = imported(x);
  x.loans.approve(x.a, l.id);
  for (const through of ['2026-02-28', '2026-03-31']) assert.equal(x.loans.accrue(x.a, { id: l.id, through, operationId: through }).entries.length, 1);
  assert.throws(() => x.loans.repay(x.a, { id: l.id, amountMinor: 100, entryDate: '2026-03-30', source: 'cash', operationId: 'back' }), /opening|before/i);
  assert.throws(() => x.loans.changeRate(x.a, { id: l.id, ratePercent: 3, effectiveFrom: '2026-03-30', reason: 'Test', operationId: 'back-rate' }), /opening|before/i);
  const res = x.loans.accrue(x.a, { id: l.id, through: '2026-04-30', operationId: 'april' });
  assert.equal(res.principalMinor, 20000);
  assert.equal(res.interestMinor, 900);
  assert.deepEqual(res.entries.map(e => e.kind), ['opening_balance', 'interest']);
  assert.equal(x.loans.accrue(x.a, { id: l.id, through: '2026-04-30', operationId: 'again' }).interestMinor, 900);
  const count = res.entries.length;
  const forecast = x.loans.project(x.a, l.id, { through: '2026-05-31' });
  assert.equal(forecast.interestMinor, 1300);
  assert.equal(forecast.entries.some(e => e.entryDate <= '2026-03-31'), false);
  assert.equal(x.loans.get(x.a, l.id).entries.length, count);
}));
test('opening grace uses the original anniversary and capitalization transfers supplied interest exactly once', { skip }, () => fixture(x => {
  const grace = imported(x, { disbursedOn: '2026-01-15', interestFreeMonths: 3, unpaidInterestMinor: 0 });
  x.loans.approve(x.a, grace.id);
  const april = x.loans.accrue(x.a, { id: grace.id, through: '2026-04-30', operationId: 'grace' });
  assert.equal(april.interestMinor, 213); // 20000 * 2% * 16 / 30, half up.
  assert.equal(april.entries[1].snapshot.interestFreeUntil, '2026-04-15');
  const cap = imported(x, { loanNo: 'CAP', interestPolicy: 'capitalize' }, 'cap');
  assert.throws(() => x.loans.approve(x.a, cap.id), /policy/i);
  require('../main/db/payrollConfig').updateSettings(x.a, { policySource: 'Synthetic lending evidence', policyConfirmed: true });
  x.loans.approve(x.a, cap.id);
  const next = x.loans.accrue(x.a, { id: cap.id, through: '2026-05-31', operationId: 'cap-months' });
  assert.equal(next.principalMinor, 21318); // April: 20000 + 500 + 400; May: +418.
  assert.equal(next.interestMinor, 0);
  assert.equal(x.loans.accrue(x.a, { id: cap.id, through: '2026-05-31', operationId: 'cap-again' }).principalMinor, 21318);
}));
test('interest-only openings need real original principal and no fake disbursement', { skip }, () => fixture(x => {
  const l = imported(x, { currentPrincipalMinor: 0, unpaidInterestMinor: 500 });
  x.loans.approve(x.a, l.id);
  const april = x.loans.accrue(x.a, { id: l.id, through: '2026-04-30', operationId: 'interest-only' });
  assert.equal(april.originalPrincipalMinor, 50000);
  assert.equal(april.principalMinor, 0);
  assert.equal(april.interestMinor, 500);
  const pay = x.loans.repay(x.a, { id: l.id, amountMinor: 500, entryDate: '2026-05-01', source: 'bank', operationId: 'pay-only' });
  assert.equal(pay.principalPart, 0);
  assert.equal(pay.interestPart, -500);
  assert.equal(x.loans.get(x.a, l.id).status, 'paid');
}));
test('audit and receipt failures roll back the whole batch; an unknown result can be retried safely', { skip }, () => fixture(x => {
  const rows = [row(), row({ loanNo: 'SECOND' })];
  x.db.exec("CREATE TRIGGER fail_second_import BEFORE INSERT ON audit_log WHEN NEW.action='import_create' AND json_extract(NEW.after_json,'$.loanNo')='SECOND' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.throws(() => x.imports.apply(x.a, { rows, operationId: 'batch' }), /audit/i);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM employee_loans').get().n, 0);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM loan_rate_changes').get().n, 0);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payroll_operations').get().n, 0);
  x.db.exec('DROP TRIGGER fail_second_import');
  x.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON payroll_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  assert.throws(() => x.imports.apply(x.a, { rows, operationId: 'batch' }), /receipt/i);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM employee_loans').get().n, 0);
  x.db.exec('DROP TRIGGER fail_receipt');
  const res = x.imports.apply(x.a, { rows, operationId: 'batch' });
  assert.equal(res.created, 2);
  assert.deepEqual(x.imports.apply(x.a, { rows, operationId: 'batch' }), res);
  x.db.exec("CREATE TRIGGER fail_opening_audit BEFORE INSERT ON audit_log WHEN NEW.action='opening_balance' BEGIN SELECT RAISE(ABORT,'synthetic approval audit failure'); END");
  assert.throws(() => x.loans.approve(x.a, res.rows[0].loanId), /audit/i);
  assert.equal(x.loans.get(x.a, res.rows[0].loanId).entries.length, 0);
  assert.equal(x.loans.get(x.a, res.rows[0].loanId).status, 'draft');
  x.db.exec('DROP TRIGGER fail_opening_audit');
  assert.equal(x.loans.approve(x.a, res.rows[0].loanId).entries.length, 1);
}));
test('ordinary drafts cannot be overwritten as openings and their new-cash approval is unchanged', { skip }, () => fixture(x => {
  const ordinary = x.loans.create(x.a, { ...row(), employeeId: x.e, principalMinor: 50000, operationId: 'ordinary' });
  const res = x.imports.apply(x.a, { rows: [row()], operationId: 'ordinary-import' });
  assert.equal(res.applied, false);
  assert.match(res.rows[0].errors.join(' '), /ordinary|opening|import/i);
  const approved = x.loans.approve(x.a, ordinary.id);
  assert.deepEqual(approved.entries.map(e => [e.kind, e.principalPart, e.interestPart]), [['disbursement', 50000, 0]]);
}));
test('sample workbook has every mapped field, explicit currency units and no formulas or staff data', { skip }, () => fixture(x => {
  const XLSX = require('xlsx');
  const columns = x.imports.importColumns();
  assert.equal(columns.length, 16);
  assert.equal(new Set(columns.map(c => c.key)).size, 16);
  for (const key of ['originalPrincipalMinor', 'currentPrincipalMinor', 'unpaidInterestMinor', 'installmentMinor']) {
    assert.match(columns.find(c => c.key === key).label, /USD cents \/ KHR riel/);
  }
  columns[0].aliases.push('not persistent');
  assert.equal(x.imports.importColumns()[0].aliases.includes('not persistent'), false);
  const sample = x.imports.sampleWorkbook(x.a);
  assert.equal(sample.filename, 'opening-loans-import-sample.xlsx');
  const wb = XLSX.read(sample.bytes, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Loans', 'Instructions']);
  const samples = XLSX.utils.sheet_to_json(wb.Sheets.Loans);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map(r => [r.currency, r.originalPrincipalMinor, r.currentPrincipalMinor, r.unpaidInterestMinor]), [['USD', 50000, 20000, 500], ['KHR', 2000000, 800000, 20000]]);
  assert.deepEqual(Object.keys(samples[0]), x.imports.importColumns().map(c => c.key));
  for (const sheet of Object.values(wb.Sheets)) for (const cell of Object.values(sheet)) assert.equal(cell?.f, undefined);
  const instructions = XLSX.utils.sheet_to_json(wb.Sheets.Instructions, { header: 1 }).flat().join(' ');
  assert.match(instructions, /USD cents \/ whole KHR/);
  assert.match(instructions, /original principal/i);
  assert.match(instructions, /outstanding principal/i);
  assert.equal(instructions.includes('Synthetic A'), false);
  assert.equal(x.imports.preview(x.a, { rows: samples.map(r => ({ ...r, staffCode: 'A' })) }).valid, true);
  assert.throws(() => x.imports.sampleWorkbook('other-company'), /company/i);
}));
test('opening reversals void the loan and a preview cannot authorize a changed or subsequently approved row', { skip }, () => fixture(x => {
  const l = imported(x);
  assert.equal(x.imports.preview(x.a, { rows: [{ loanNo: l.loanNo, currentPrincipalMinor: 15000 }] }).rows[0].action, 'update');
  const approved = x.loans.approve(x.a, l.id);
  assert.equal(x.imports.apply(x.a, { rows: [{ loanNo: l.loanNo, currentPrincipalMinor: 15000 }], operationId: 'stale' }).applied, false);
  x.loans.reverseEntry(x.a, { id: approved.entries[0].id, reason: 'Wrong opening', operationId: 'reverse-opening' });
  const reversed = x.loans.get(x.a, l.id);
  assert.equal(reversed.status, 'void');
  assert.equal(reversed.principalMinor, 0);
  assert.equal(reversed.interestMinor, 0);
  assert.equal(reversed.entries.length, 2);
  assert.equal(x.imports.apply(x.a, { rows: [row()], operationId: 'void-import' }).applied, false);
}));
test('remaining introductory free months accrue no deferred interest and repayments affect only subsequent daily bases', { skip }, () => fixture(x => {
  const l = imported(x, { interestFreeMonths: 5, unpaidInterestMinor: 0 });
  x.loans.approve(x.a, l.id);
  const may = x.loans.accrue(x.a, { id: l.id, through: '2026-05-31', operationId: 'may-free' });
  assert.equal(may.interestMinor, 0);
  assert.deepEqual(may.entries.filter(e => e.kind === 'interest').map(e => e.amountMinor), [0, 0]);
  x.loans.repay(x.a, { id: l.id, amountMinor: 10000, entryDate: '2026-06-16', source: 'cash', operationId: 'middle' });
  const june = x.loans.accrue(x.a, { id: l.id, through: '2026-06-30', operationId: 'june' });
  assert.equal(june.principalMinor, 10000);
  assert.equal(june.interestMinor, 300); // 20000 * 2% * 15/30 + 10000 * 2% * 15/30.
}));
test('opening approval rechecks policy and zero-debt imports close without fabricated debt', { skip }, () => fixture(x => {
  const l = imported(x, { currentPrincipalMinor: 0, unpaidInterestMinor: 0 });
  const approved = x.loans.approve(x.a, l.id);
  assert.equal(approved.status, 'paid');
  assert.equal(approved.entries[0].amountMinor, 0);
  assert.equal(x.imports.apply(x.a, { rows: [row({ currentPrincipalMinor: 0, unpaidInterestMinor: 0 })], operationId: 'empty-reimport' }).skipped, 1);
}));
test('a failed draft update restores its balances, initial rate, audit and receipt before retry', { skip }, () => fixture(x => {
  const l = imported(x);
  const before = x.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  const p = { rows: [{ loanNo: l.loanNo, currentPrincipalMinor: 15000, ratePercent: 4 }], operationId: 'update-retry' };
  x.db.exec("CREATE TRIGGER fail_update_import BEFORE INSERT ON audit_log WHEN NEW.action='import_update' BEGIN SELECT RAISE(ABORT,'synthetic update audit failure'); END");
  assert.throws(() => x.imports.apply(x.a, p), /audit/i);
  const rolledBack = x.loans.get(x.a, l.id);
  assert.equal(rolledBack.openingPrincipalMinor, 20000);
  assert.equal(rolledBack.rates[0].ratePercent, 2);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, before);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM payroll_operations WHERE operation_id='update-retry'").get().n, 0);
  x.db.exec('DROP TRIGGER fail_update_import');
  assert.equal(x.imports.apply(x.a, p).updated, 1);
  assert.equal(x.loans.get(x.a, l.id).openingPrincipalMinor, 15000);
  assert.equal(x.loans.get(x.a, l.id).rates[0].ratePercent, 4);
}));
test('additive opening schema preserves a legacy ordinary loan without rewriting money or approval history', { skip }, () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE companies(id TEXT PRIMARY KEY);
      CREATE TABLE employees(id TEXT PRIMARY KEY);
      CREATE TABLE employee_loans (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, employee_id TEXT NOT NULL, loan_no TEXT NOT NULL,
        original_principal_minor INTEGER NOT NULL CHECK(original_principal_minor > 0), currency TEXT NOT NULL,
        disbursed_on TEXT NOT NULL, interest_method TEXT NOT NULL, interest_policy TEXT NOT NULL,
        interest_free_months INTEGER NOT NULL, installment_minor INTEGER NOT NULL, max_deduction_percent REAL NOT NULL,
        deduct_via_payroll INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', purpose TEXT,
        approved_at INTEGER, approved_by_user_id TEXT, created_at INTEGER NOT NULL, UNIQUE(company_id,loan_no));
      INSERT INTO companies VALUES ('company'); INSERT INTO employees VALUES ('employee');
      INSERT INTO employee_loans VALUES ('legacy','company','employee','LEGACY',50000,'USD','2026-01-01','declining','separate',0,10000,100,1,'active','Original',100,'actor',50);`);
    const before = db.prepare('SELECT * FROM employee_loans').get();
    const schema = require('../main/db/payrollSchema');
    schema.ensurePayrollSchema(db);
    schema.ensurePayrollSchema(db);
    const after = db.prepare('SELECT * FROM employee_loans').get();
    for (const [key, value] of Object.entries(before)) assert.equal(after[key], value);
    assert.equal(after.balance_as_of, null);
    assert.equal(after.opening_principal_minor, null);
    assert.equal(after.opening_interest_minor, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM loan_entries').get().n, 0);
  } finally { db.close(); }
});
