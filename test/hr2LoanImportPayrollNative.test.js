const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let skip = false;
try {
  new (require('better-sqlite3'))(':memory:').close();
} catch (error) {
  if (error.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(error.message)) {
    skip = 'Run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/hr2LoanImportPayrollNative.test.js';
  } else throw error;
}

function fixture(t, fn) {
  // Explicit test clock permits the requested Oct10/Nov10 actual payment dates.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-15T12:00:00Z') });
  const dbModule = require('../main/db');
  dbModule.initDb(fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-opening-payroll-')));
  try {
    const a = require('../main/db/companies').create({ name: 'Synthetic opening payroll' }).id;
    const e = require('../main/db/employees').create({ companyId: a, staffCode: 'A', nameEn: 'Synthetic employee' }).id;
    const c = require('../main/db/payrollConfig');
    const p = require('../main/db/payroll');
    const loans = require('../main/db/employeeLoans');
    const imports = require('../main/db/loanImports');
    const hr = require('../main/db/hr');
    const at = require('../main/db/attendance');
    const ac = require('../main/util/attendanceCalc');
    hr.ensurePrefilled(a);
    const schedule = hr.createSchedule({
      companyId: a, name: 'Synthetic daily shift', startTime: '09:00', endTime: '17:00',
      breakMin: 0, workDays: '1111111', graceMin: 0
    });
    hr.updateSettings(a, { defaultScheduleId: schedule.id, attendanceStartDate: '2026-01-01' });
    c.updateSettings(a, {
      policyConfirmed: true,
      policySource: 'Synthetic professional evidence for pay frequency, deductions, lending, capitalization and statutory aggregation'
    });
    c.setEmployeePolicy(a, {
      employeeId: e, applyTax: false, applyNssf: false, taxResident: true,
      spouseCount: 0, dependentCount: 0, reason: 'Synthetic exemptions'
    });
    c.setPayRate(a, {
      employeeId: e, effectiveFrom: '2026-01-01', basis: 'month',
      amountMinor: 30000, currency: 'USD', reason: 'Synthetic monthly wage'
    });
    const set = c.saveRateSet(a, {
      name: 'Synthetic test tables, not legal defaults', effectiveFrom: '2026-01-01',
      nssf: { bands: [{ upperKhr: null, baseKhr: 0 }], components: [{ key: 'pension', employeePercent: 0, employerPercent: 0 }] },
      tax: {
        brackets: [{ upperKhr: null, ratePercent: 0 }], spouseAllowanceKhr: 0,
        dependentAllowanceKhr: 0, maxDependents: null, nonResidentPercent: 0,
        fringeBenefitPercent: 0, pensionDeductible: false
      }
    });
    c.confirmRateSet(a, { id: set.id, sourceNote: 'Synthetic evidence only' });
    const createRun = month => {
      const periodEnd = ac.lastDayOfMonth(month);
      for (let date = `${month}-01`; date <= periodEnd; date = ac.addDays(date, 1)) {
        for (const [kind, time] of [['in', '09:00'], ['out', '17:00']]) {
          at.addManual({ companyId: a, employeeId: e, workDate: date, kind, at: ac.timeOnDate(date, time), reason: 'Synthetic attendance' });
        }
      }
      return p.calculate(a, p.create(a, {
        periodStart: `${month}-01`, periodEnd, employeeIds: [e],
        statutoryRateSetId: set.id, operationId: `salary-${month}`
      }).id);
    };
    const opening = () => {
      const rows = [{
        loanNo: 'OPEN-1', staffCode: 'A', originalPrincipalMinor: 50000,
        currentPrincipalMinor: 20000, unpaidInterestMinor: 500, balanceAsOf: '2026-09-30',
        currency: 'USD', disbursedOn: '2026-01-01', interestMethod: 'declining',
        interestPolicy: 'separate', ratePercent: 2, interestFreeMonths: 3,
        installmentMinor: 10000, deductViaPayroll: true
      }];
      assert.equal(imports.preview(a, { rows }).valid, true);
      assert.equal(dbModule.getDb().prepare('SELECT COUNT(*) n FROM loan_entries').get().n, 0);
      const result = imports.apply(a, { rows, operationId: 'opening-import' });
      assert.equal(result.applied, true);
      const draft = loans.get(a, result.rows[0].loanId);
      assert.equal(draft.status, 'draft');
      assert.deepEqual(draft.entries, []);
      return loans.approve(a, draft.id);
    };
    return fn({ a, e, p, loans, opening, createRun, db: dbModule.getDb() });
  } finally {
    dbModule.closeDb();
  }
}

function approve(p, a, run) {
  const reviewed = p.review(a, { id: run.id, expectedRevision: run.revision });
  return p.approve(a, { id: run.id, expectedRevision: reviewed.revision });
}

test('September opening covers September payroll interest and Oct10 pay repays supplied interest first', { skip }, t => fixture(t, ({ a, p, loans, opening, createRun }) => {
  const loan = opening();
  let run = createRun('2026-09');
  assert.deepEqual(run.lines[0].blockers, []);
  assert.equal(run.lines[0].loanDeductionMinor, 10000);
  assert.equal(run.lines[0].netMinor, 20000);
  assert.deepEqual(loans.get(a, loan.id).entries, loan.entries, 'Payroll preview must not accrue or duplicate opening debt');
  run = approve(p, a, run);
  assert.equal(loans.get(a, loan.id).entries.length, 1);
  p.pay(a, { id: run.lines[0].id, amountMinor: 20000, method: 'cash', paidAt: '2026-10-10', operationId: 'oct10-pay' });
  const paid = loans.get(a, loan.id);
  assert.equal(paid.principalMinor, 10500);
  assert.equal(paid.interestMinor, 0);
  assert.deepEqual(paid.entries.map(x => [x.kind, x.principalPart, x.interestPart]), [
    ['opening_balance', 20000, 500], ['repayment', -9500, -500]
  ]);
  assert.equal(p.get(a, run.id).status, 'paid');
}));

test('October after a September opening still requires posted October interest using original grace anniversary', { skip }, t => fixture(t, ({ a, p, loans, opening, createRun }) => {
  const loan = opening();
  let run = createRun('2026-10');
  assert.ok(run.lines[0].blockers.some(x => x.code === 'loan_interest'));
  assert.throws(() => approve(p, a, run), /accrue/i);
  assert.equal(loans.get(a, loan.id).interestMinor, 500);
  assert.equal(loans.get(a, loan.id).entries.length, 1);
  const accrued = loans.accrue(a, { id: loan.id, through: '2026-10-31', operationId: 'october-interest' });
  assert.equal(accrued.interestMinor, 900, 'Opening500 plus October400, with no restarted grace or historical interest');
  assert.equal(accrued.entries[1].snapshot.interestFreeUntil, '2026-04-01');
  assert.deepEqual(accrued.entries.map(x => [x.kind, x.period, x.interestPart]), [
    ['opening_balance', null, 500], ['interest', '2026-10', 400]
  ]);
  run = approve(p, a, p.calculate(a, run.id));
  p.pay(a, { id: run.lines[0].id, amountMinor: 20000, method: 'cash', paidAt: '2026-11-10', operationId: 'nov10-pay' });
  assert.equal(loans.get(a, loan.id).principalMinor, 10900);
  assert.equal(loans.get(a, loan.id).interestMinor, 0);
}));

test('payroll payment before the imported opening boundary rejects payment, repayment and receipt atomically', { skip }, t => fixture(t, ({ a, p, loans, opening, createRun, db }) => {
  const loan = opening();
  const run = approve(p, a, createRun('2026-09'));
  const before = loans.get(a, loan.id);
  const receiptCount = db.prepare('SELECT COUNT(*) n FROM payroll_operations').get().n;
  assert.throws(() => p.pay(a, {
    id: run.lines[0].id, amountMinor: 20000, method: 'cash', paidAt: '2026-09-29', operationId: 'before-opening'
  }), /before the opening balance/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_payments').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_operations').get().n, receiptCount);
  assert.deepEqual(loans.get(a, loan.id), before);
  assert.equal(p.get(a, run.id).status, 'approved');
  assert.equal(p.get(a, run.id).lines[0].remainingLoanDeductionMinor, 10000);
}));

test('August salary paid after a September opening can repay current imported debt without historical accrual', { skip }, t => fixture(t, ({ a, p, loans, opening, createRun }) => {
  const loan = opening();
  const run = approve(p, a, createRun('2026-08'));
  assert.equal(run.lines[0].loanDeductionMinor, 10000);
  assert.equal(loans.get(a, loan.id).entries.length, 1);
  p.pay(a, { id: run.lines[0].id, amountMinor: 20000, method: 'cash', paidAt: '2026-10-10', operationId: 'older-salary' });
  assert.equal(loans.get(a, loan.id).principalMinor, 10500);
  assert.equal(loans.get(a, loan.id).interestMinor, 0);
}));
