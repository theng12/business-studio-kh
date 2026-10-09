const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let skip = false;
try {
  new (require('better-sqlite3'))(':memory:').close();
} catch (e) {
  if (e.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(e.message)) skip = 'Run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/hr2Native.test.js';else throw e;
}
test('HR2 additive schema and tenant-scoped source-backed configuration', {
  skip
}, () => {
  const db = require('../main/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-hr2-'));
  db.initDb(dir);
  try {
    const companies = require('../main/db/companies');
    const employees = require('../main/db/employees');
    const a = companies.create({
      name: 'Synthetic HR2 A'
    });
    const b = companies.create({
      name: 'Synthetic HR2 B'
    });
    const e = employees.create({
      companyId: a.id,
      staffCode: 'A',
      nameEn: 'Synthetic A'
    });
    assert.ok(db.getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'payroll_runs'").get(), 'payroll schema is installed at boot');
    const c = require('../main/db/payrollConfig');
    assert.equal(c.getSettings(a.id).payday, 10);
    assert.equal(c.getSettings(a.id).policyConfirmed, false);
    assert.equal(c.listRateSets(a.id).length, 0);
    assert.throws(() => c.updateSettings(a.id, {
      policyConfirmed: true
    }), /source/i);
    assert.throws(() => c.updateSettings(a.id, {
      surprise: true
    }), /unknown/i);
    assert.equal(c.getEmployeePolicy(a.id, e.id), null);
    assert.throws(() => c.setEmployeePolicy(b.id, {
      employeeId: e.id,
      applyTax: true
    }), /staff/i);
    c.setEmployeePolicy(a.id, {
      employeeId: e.id,
      applyTax: false,
      applyNssf: false,
      taxResident: true,
      spouseCount: 0,
      dependentCount: 0,
      reason: 'Synthetic exemption'
    });
    assert.equal(c.getEmployeePolicy(a.id, e.id).applyTax, false);
    assert.throws(() => c.setPayRate(a.id, {
      employeeId: e.id,
      effectiveFrom: '2026-02-30',
      basis: 'month',
      amountMinor: 20000,
      currency: 'USD',
      reason: 'test'
    }), /date/i);
    const rate = c.setPayRate(a.id, {
      employeeId: e.id,
      effectiveFrom: '2026-01-01',
      basis: 'month',
      amountMinor: 20000,
      currency: 'USD',
      reason: 'test'
    });
    assert.equal(c.listPayRates(a.id, e.id)[0].amountMinor, 20000);
    assert.throws(() => c.setPayRate(a.id, {
      ...rate,
      amountMinor: 30000
    }), /already|unique/i);
    const draft = c.saveRateSet(a.id, {
      name: 'Empty synthetic draft',
      effectiveFrom: '2026-01-01'
    });
    assert.equal(draft.status, 'draft');
    assert.throws(() => c.confirmRateSet(a.id, {
      id: draft.id
    }), /source/i);
    const set = c.saveRateSet(a.id, {
      id: draft.id,
      name: 'Synthetic zero tables',
      effectiveFrom: '2026-01-01',
      nssf: {
        bands: [{
          upperKhr: null,
          baseKhr: 0
        }],
        components: [{
          key: 'pension',
          employeePercent: 0,
          employerPercent: 0,
          bands: [{
            upperKhr: null,
            baseKhr: 400000
          }]
        }]
      },
      tax: {
        brackets: [{
          upperKhr: null,
          ratePercent: 0
        }],
        spouseAllowanceKhr: 0,
        dependentAllowanceKhr: 0,
        maxDependents: null,
        nonResidentPercent: 0,
        fringeBenefitPercent: 0,
        pensionDeductible: false
      }
    });
    const confirmed = c.confirmRateSet(a.id, {
      id: set.id,
      sourceNote: 'Synthetic test configuration only',
      confirmedByUserId: 'synthetic-admin'
    });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.confirmedByUserId, 'local-admin');
    assert.equal(confirmed.nssf.components[0].bands[0].baseKhr, 400000);
    assert.equal(confirmed.tax.maxDependents, null);
    const replacement = c.saveRateSet(a.id, {
      ...confirmed,
      name: 'New draft'
    });
    assert.notEqual(replacement.id, confirmed.id);
    assert.equal(c.listRateSets(a.id).find(x => x.id === confirmed.id).name, 'Synthetic zero tables');
    assert.throws(() => c.confirmRateSet(b.id, {
      id: confirmed.id,
      sourceNote: 'test'
    }), /rate set/i);
    const before = c.signature(a.id);
    c.updateSettings(a.id, {
      payday: 12
    });
    assert.notEqual(c.signature(a.id), before);
    db.closeDb();
    db.initDb(dir);
    assert.equal(db.getAppState('schema_version'), '2');
    assert.equal(c.listPayRates(a.id, e.id).length, 1);
    assert.throws(() => require('../main/db/fuelHistory').assertCompanyRemovable(a.id), /history/i);
    assert.throws(() => companies.remove(a.id), /FOREIGN KEY/i);
  } finally {
    db.closeDb();
  }
});
function fixture(fn) {
  const db = require('../main/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-hr2-'));
  db.initDb(dir);
  try {
    const companies = require('../main/db/companies');
    const a = companies.create({
      name: 'A'
    });
    const b = companies.create({
      name: 'B'
    });
    const e = require('../main/db/employees').create({
      companyId: a.id,
      staffCode: 'A',
      nameEn: 'Synthetic A'
    });
    return fn({
      db: db.getDb(),
      a: a.id,
      b: b.id,
      e: e.id
    });
  } finally {
    db.closeDb();
  }
}
test('loans preserve principal, grace interest, idempotency and atomic reversals', {
  skip
}, () => fixture(({
  db,
  a,
  b,
  e
}) => {
  const l = require('../main/db/employeeLoans');
  const input = {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'declining',
    interestPolicy: 'separate',
    ratePercent: 2,
    interestFreeMonths: 3,
    installmentMinor: 10000,
    maxDeductionPercent: 100,
    deductViaPayroll: true,
    operationId: 'new'
  };
  const loan = l.create(a, input);
  assert.equal(l.create(a, input).id, loan.id);
  assert.throws(() => l.create(a, {
    ...input,
    principalMinor: 60000
  }), /different request/i);
  assert.throws(() => l.get(b, loan.id), /loan/i);
  l.approve(a, loan.id);
  l.approve(a, loan.id);
  assert.equal(l.get(a, loan.id).entries.length, 1);
  for (const [i, day] of ['2026-01-20', '2026-02-20', '2026-03-20'].entries()) l.repay(a, {
    id: loan.id,
    amountMinor: 10000,
    entryDate: day,
    source: 'cash',
    operationId: `repay${i}`
  });
  assert.equal(l.get(a, loan.id).principalMinor, 20000);
  const accrued = l.accrue(a, {
    id: loan.id,
    through: '2026-04-30',
    operationId: 'accrue'
  });
  assert.equal(accrued.interestMinor, 400);
  assert.equal(l.accrue(a, {
    id: loan.id,
    through: '2026-04-30',
    operationId: 'accrue'
  }).interestMinor, 400);
  assert.equal(l.accrue(a, {
    id: loan.id,
    through: '2026-04-30',
    operationId: 'another-accrue'
  }).interestMinor, 400);
  assert.throws(() => l.repay(a, {
    id: loan.id,
    amountMinor: 100,
    entryDate: '2026-04-29',
    source: 'cash',
    operationId: 'backdate'
  }), /back|interest|boundary/i);
  assert.throws(() => l.changeRate(a, {
    id: loan.id,
    effectiveFrom: '2026-04-01',
    ratePercent: 3,
    reason: 'test',
    operationId: 'back-rate'
  }), /back|interest|boundary/i);
  const p = {
    id: loan.id,
    amountMinor: 10400,
    entryDate: '2026-05-01',
    source: 'cash',
    operationId: 'last-repay'
  };
  const entry = l.repay(a, p);
  l.repay(a, p);
  assert.equal(l.get(a, loan.id).principalMinor, 10000);
  assert.equal(l.get(a, loan.id).interestMinor, 0);
  assert.throws(() => l.repay(a, {
    ...p,
    amountMinor: 10401
  }), /different request/i);
  l.reverseEntry(a, {
    id: entry.id,
    reason: 'Synthetic correction',
    operationId: 'reverse'
  });
  assert.equal(l.get(a, loan.id).principalMinor, 20000);
  assert.equal(l.get(a, loan.id).interestMinor, 400);
  assert.throws(() => l.repay(a, {
    id: loan.id,
    amountMinor: 999999,
    entryDate: require('../main/util/attendanceCalc').ppDate(Date.now()),
    source: 'bank',
    operationId: 'overpay'
  }), /over|debt/i);
  const n = db.prepare('SELECT COUNT(*) n FROM loan_entries').get().n;
  l.project(a, loan.id, {
    through: '2026-08-31'
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM loan_entries').get().n, n);
  assert.throws(() => l.writeOff(b, {
    id: loan.id,
    entryDate: '2026-05-02',
    reason: 'test',
    operationId: 'write'
  }), /loan/i);
}));
function payFixture(fn, cycle = 'monthly', currency = 'USD', progressive = false) {
  return fixture(x => {
    const c = require('../main/db/payrollConfig');
    const hr = require('../main/db/hr');
    const at = require('../main/db/attendance');
    const ac = require('../main/util/attendanceCalc');
    hr.ensurePrefilled(x.a);
    const schedule = hr.createSchedule({
      companyId: x.a,
      name: 'Synthetic every day',
      startTime: '09:00',
      endTime: '17:00',
      breakMin: 0,
      workDays: '1111111',
      graceMin: 0
    });
    hr.updateSettings(x.a, {
      defaultScheduleId: schedule.id,
      attendanceStartDate: '2026-01-01'
    });
    c.updateSettings(x.a, {
      payCycle: cycle,
      policySource: 'Synthetic professional evidence: pay frequency, deductions, lending, capitalization, statutory aggregation, FX and rounding',
      policyConfirmed: true,
      taxRateKhrPerUsd: 4000,
      nssfRateKhrPerUsd: 4000,
      rateSource: 'Synthetic salary FX',
      nssfRateSource: 'Synthetic NSSF FX'
    });
    const statutory = typeof progressive === 'object' ? progressive : {};
    c.setEmployeePolicy(x.a, {
      employeeId: x.e,
      applyTax: statutory.applyTax ?? progressive === true,
      applyNssf: statutory.applyNssf ?? false,
      taxResident: true,
      spouseCount: 0,
      dependentCount: 0,
      reason: 'Synthetic exemptions'
    });
    c.setPayRate(x.a, {
      employeeId: x.e,
      effectiveFrom: '2026-01-01',
      basis: 'month',
      amountMinor: 30000,
      currency,
      reason: 'Synthetic'
    });
    const draft = c.saveRateSet(x.a, {
      name: 'Synthetic statutory',
      effectiveFrom: '2026-01-01',
      nssf: statutory.nssf || {
        bands: [{
          upperKhr: null,
          baseKhr: 0
        }],
        components: [{
          key: 'pension',
          employeePercent: 0,
          employerPercent: 0
        }]
      },
      tax: statutory.tax || {
        brackets: progressive === true ? [{
          upperKhr: 600000,
          ratePercent: 0
        }, {
          upperKhr: null,
          ratePercent: 10
        }] : [{
          upperKhr: null,
          ratePercent: 0
        }],
        spouseAllowanceKhr: 0,
        dependentAllowanceKhr: 0,
        maxDependents: 10,
        nonResidentPercent: 0,
        fringeBenefitPercent: 0,
        pensionDeductible: false
      }
    });
    c.confirmRateSet(x.a, {
      id: draft.id,
      sourceNote: 'Synthetic fixture, no legal confirmation'
    });
    for (let i = 1; i <= 30; i++) {
      const d = `2026-09-${String(i).padStart(2, '0')}`;
      for (const [kind, time] of [['in', '09:00'], ['out', '17:00']]) at.addManual({
        companyId: x.a,
        employeeId: x.e,
        kind,
        at: ac.timeOnDate(d, time),
        workDate: d,
        reason: 'Synthetic attendance'
      });
    }
    return fn({
      ...x,
      c,
      hr,
      at,
      ac,
      rateSetId: draft.id
    });
  });
}
test('payroll snapshots, stale approvals, tenant boundaries and payment loan reconciliation', {
  skip
}, () => payFixture(({
  a,
  b,
  e,
  c,
  at,
  db,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  const loans = require('../main/db/employeeLoans');
  const l = loans.create(a, {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'none',
    interestPolicy: 'separate',
    ratePercent: 0,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'loan'
  });
  loans.approve(a, l.id);
  const run = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'run'
  });
  let calculated = p.calculate(a, run.id);
  assert.equal(calculated.lines[0].baseMinor, 30000);
  assert.equal(calculated.lines[0].loanDeductionMinor, 10000);
  assert.equal(calculated.lines[0].netMinor, 20000);
  assert.equal(loans.get(a, l.id).principalMinor, 50000);
  assert.throws(() => p.get(b, run.id), /run/i);
  const reviewed = p.review(a, {
    id: run.id,
    expectedRevision: calculated.revision
  });
  c.setPayRate(a, {
    employeeId: e,
    effectiveFrom: '2026-09-16',
    basis: 'month',
    amountMinor: 36000,
    currency: 'USD',
    reason: 'Synthetic raise'
  });
  assert.throws(() => p.approve(a, {
    id: run.id,
    expectedRevision: reviewed.revision
  }), /stale|changed/i);
  calculated = p.calculate(a, run.id);
  assert.equal(calculated.lines[0].baseMinor, 33000);
  const ready = p.review(a, {
    id: run.id,
    expectedRevision: calculated.revision
  });
  const approved = p.approve(a, {
    id: run.id,
    expectedRevision: ready.revision
  });
  const line = approved.lines[0];
  assert.equal(line.snapshot.employee.nameEn, 'Synthetic A');
  assert.equal(line.snapshot.policy.taxResident, true);
  assert.throws(() => p.calculate(a, run.id), /frozen|approved/i);
  c.setPayRate(a, {
    employeeId: e,
    effectiveFrom: '2026-10-01',
    basis: 'month',
    amountMinor: 60000,
    currency: 'USD',
    reason: 'Later raise'
  });
  assert.equal(p.get(a, run.id).lines[0].baseMinor, 33000);
  const input = {
    id: line.id,
    amountMinor: 10000,
    method: 'cash',
    paidAt: '2026-10-01',
    operationId: 'pay'
  };
  const payment = p.pay(a, input);
  assert.equal(p.pay(a, input).id, payment.id);
  assert.equal(loans.get(a, l.id).principalMinor, 40000);
  assert.throws(() => p.pay(a, {
    ...input,
    amountMinor: 10001
  }), /different request/i);
  assert.throws(() => p.voidRun(a, {
    id: run.id,
    reason: 'test'
  }), /payment|reverse/i);
  p.reversePayment(a, {
    id: payment.id,
    reason: 'Synthetic reversal',
    operationId: 'undo'
  });
  assert.equal(loans.get(a, l.id).principalMinor, 50000);
  const replacement = p.pay(a, {
    ...input,
    paidAt: require('../main/util/attendanceCalc').ppDate(Date.now()),
    amountMinor: 23000,
    operationId: 'pay2'
  });
  assert.equal(loans.get(a, l.id).principalMinor, 40000);
  assert.equal(p.get(a, run.id).status, 'paid');
  p.reversePayment(a, {
    id: replacement.id,
    reason: 'Synthetic correction',
    operationId: 'undo2'
  });
  p.voidRun(a, {
    id: run.id,
    reason: 'Synthetic void'
  });
  assert.equal(p.get(a, run.id).status, 'void');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM payroll_lines').get().n >= 2);
}));
test('twice-monthly separate periods apply monthly progressive tax once', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  const first = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-15',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'first'
  });
  const f = p.calculate(a, first.id);
  assert.equal(f.lines[0].baseMinor, 15000);
  assert.equal(f.lines[0].salaryTaxKhr, 0);
  const reviewed = p.review(a, {
    id: f.id,
    expectedRevision: f.revision
  });
  p.approve(a, {
    id: f.id,
    expectedRevision: reviewed.revision
  });
  const second = p.create(a, {
    periodStart: '2026-09-16',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'second'
  });
  let s = p.calculate(a, second.id);
  assert.equal(s.lines[0].salaryTaxKhr, 60000);
  assert.equal(s.lines[0].taxBaseKhr, 600000);
  assert.equal(s.lines[0].salaryTaxMinor, 1500);
  assert.equal(s.lines[0].netMinor, 13500);
  s = p.review(a, {
    id: s.id,
    expectedRevision: s.revision
  });
  p.approve(a, {
    id: s.id,
    expectedRevision: s.revision
  });
  assert.equal(p.get(a, first.id).lines[0].salaryTaxKhr, 0);
  assert.throws(() => p.voidRun(a, {
    id: first.id,
    reason: 'test'
  }), /dependent|later/i);
}, 'twice_monthly_separate', 'USD', true));
test('advance is settled from actual payments without duplicate earnings', {
  skip
}, () => payFixture(({
  a,
  e,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  const adv = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-15',
    employeeIds: [e],
    kind: 'advance',
    advanceMinor: 12000,
    currency: 'USD',
    statutoryRateSetId: rateSetId,
    operationId: 'adv'
  });
  let r = p.calculate(a, adv.id);
  assert.equal(r.lines[0].grossMinor, 0);
  r = p.review(a, {
    id: r.id,
    expectedRevision: r.revision
  });
  r = p.approve(a, {
    id: r.id,
    expectedRevision: r.revision
  });
  p.pay(a, {
    id: r.lines[0].id,
    amountMinor: 10000,
    method: 'cash',
    paidAt: '2026-09-15',
    operationId: 'advpay'
  });
  const settle = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    kind: 'settlement',
    statutoryRateSetId: rateSetId,
    operationId: 'settle'
  });
  let s = p.calculate(a, settle.id);
  assert.equal(s.lines[0].grossMinor, 30000);
  assert.equal(s.lines[0].advanceMinor, 10000);
  assert.equal(s.lines[0].netMinor, 20000);
  s = p.review(a, {
    id: s.id,
    expectedRevision: s.revision
  });
  p.approve(a, {
    id: s.id,
    expectedRevision: s.revision
  });
  assert.throws(() => p.pay(a, {
    id: r.lines[0].id,
    amountMinor: 2000,
    method: 'cash',
    paidAt: '2026-09-20',
    operationId: 'lateadv'
  }), /settlement|frozen/i);
}, 'twice_monthly_advance'));
test('capitalization transfers interest once and postponement never adds principal', {
  skip
}, () => fixture(({
  a,
  e
}) => {
  const l = require('../main/db/employeeLoans');
  const loan = l.create(a, {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'declining',
    interestPolicy: 'capitalize',
    ratePercent: 2,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'new'
  });
  assert.throws(() => l.approve(a, loan.id), /lending|policy/i);
  require('../main/db/payrollConfig').updateSettings(a, {
    policyConfirmed: true,
    policySource: 'Synthetic professional evidence for pay frequency, deduction limits, lending and capitalization'
  });
  l.approve(a, loan.id);
  l.accrue(a, {
    id: loan.id,
    through: '2026-01-31',
    operationId: 'jan'
  });
  assert.equal(l.get(a, loan.id).principalMinor, 51000);
  assert.equal(l.get(a, loan.id).interestMinor, 0);
  l.accrue(a, {
    id: loan.id,
    through: '2026-01-31',
    operationId: 'jan-again'
  });
  assert.equal(l.get(a, loan.id).principalMinor, 51000);
  l.postpone(a, {
    id: loan.id,
    month: '2026-02',
    reason: 'Synthetic review',
    operationId: 'postpone'
  });
  assert.equal(l.get(a, loan.id).principalMinor, 51000);
  l.accrue(a, {
    id: loan.id,
    through: '2026-02-28',
    operationId: 'feb'
  });
  assert.equal(l.get(a, loan.id).principalMinor, 52020);
}));
test('loan reversals can unwind active history in reverse order and audit failure rolls back money', {
  skip
}, () => fixture(({
  a,
  e,
  db
}) => {
  const l = require('../main/db/employeeLoans');
  const loan = l.create(a, {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'none',
    interestPolicy: 'separate',
    ratePercent: 0,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'new'
  });
  l.approve(a, loan.id);
  const a1 = l.repay(a, {
    id: loan.id,
    amountMinor: 10000,
    entryDate: '2026-02-01',
    source: 'cash',
    operationId: 'a1'
  });
  const a2 = l.repay(a, {
    id: loan.id,
    amountMinor: 10000,
    entryDate: '2026-03-01',
    source: 'cash',
    operationId: 'a2'
  });
  l.reverseEntry(a, {
    id: a2.id,
    reason: 'Synthetic',
    operationId: 'undo2'
  });
  l.reverseEntry(a, {
    id: a1.id,
    reason: 'Synthetic',
    operationId: 'undo1'
  });
  assert.equal(l.get(a, loan.id).principalMinor, 50000);
  const n = db.prepare('SELECT COUNT(*) n FROM loan_entries').get().n;
  db.exec("CREATE TRIGGER synthetic_audit_fail BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.throws(() => l.repay(a, {
    id: loan.id,
    amountMinor: 100,
    entryDate: require('../main/util/attendanceCalc').ppDate(Date.now()),
    source: 'cash',
    operationId: 'fail'
  }), /audit/i);
  assert.equal(l.get(a, loan.id).principalMinor, 50000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM loan_entries').get().n, n);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payroll_operations WHERE operation_id='fail'").get().n, 0);
}));
test('loan conversion uses explicit FX and caps salary deduction conservatively', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  const loans = require('../main/db/employeeLoans');
  const loan = loans.create(a, {
    employeeId: e,
    principalMinor: 410000,
    currency: 'KHR',
    disbursedOn: '2026-01-01',
    interestMethod: 'none',
    interestPolicy: 'separate',
    ratePercent: 0,
    interestFreeMonths: 0,
    installmentMinor: 410000,
    maxDeductionPercent: 25,
    operationId: 'loan'
  });
  loans.approve(a, loan.id);
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    loanRateKhrPerUsd: 4100,
    loanRateSource: 'Synthetic explicit conversion',
    operationId: 'run'
  });
  let run = p.calculate(a, r.id);
  assert.equal(run.lines[0].loanDeductionMinor, 7500);
  assert.ok(run.lines[0].blockers.some(x => x.code === 'loan_shortfall'));
  run = p.updateLine(a, {
    id: run.lines[0].id,
    expectedRevision: run.revision,
    patch: {
      loanDecisions: [{
        loanId: loan.id,
        amountMinor: 307500,
        reason: 'Synthetic capped repayment in loan currency'
      }]
    }
  });
  assert.equal(run.lines[0].loanDeductionMinor, 7500);
  assert.equal(run.lines[0].snapshot.loanPlans[0].amountMinor, 307500);
  run = p.review(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  run = p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  p.pay(a, {
    id: run.lines[0].id,
    amountMinor: 22500,
    method: 'cash',
    paidAt: '2026-10-01',
    operationId: 'pay'
  });
  assert.equal(loans.get(a, loan.id).principalMinor, 102500);
}));
test('historical capitalization uses balances as of the month and projection includes future instalments', {
  skip
}, () => fixture(({
  a,
  e
}) => {
  const l = require('../main/db/employeeLoans');
  require('../main/db/payrollConfig').updateSettings(a, {
    policyConfirmed: true,
    policySource: 'Synthetic professional capitalization and lending evidence'
  });
  const loan = l.create(a, {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'declining',
    interestPolicy: 'capitalize',
    ratePercent: 2,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'new'
  });
  l.approve(a, loan.id);
  l.repay(a, {
    id: loan.id,
    amountMinor: 10000,
    entryDate: '2026-03-01',
    source: 'cash',
    operationId: 'march'
  });
  l.accrue(a, {
    id: loan.id,
    through: '2026-02-28',
    operationId: 'catchup'
  });
  assert.equal(l.get(a, loan.id).principalMinor, 42020);
  const projection = l.project(a, loan.id, {
    through: '2027-01-31'
  });
  assert.ok(projection.entries.some(e => e.kind === 'repayment'));
  assert.equal(l.get(a, loan.id).principalMinor, 42020);
}));
test('statutory confirmation supports component-only NSSF bases and rejects malformed ordered tables', {
  skip
}, () => fixture(({
  a
}) => {
  const c = require('../main/db/payrollConfig');
  const tax = {
    brackets: [{
      upperKhr: null,
      ratePercent: 0
    }],
    spouseAllowanceKhr: 0,
    dependentAllowanceKhr: 0,
    maxDependents: null,
    nonResidentPercent: 0,
    fringeBenefitPercent: 0,
    pensionDeductible: false
  };
  const r = c.saveRateSet(a, {
    name: 'Synthetic separate scheme bases',
    effectiveFrom: '2026-01-01',
    nssf: {
      components: [{
        key: 'pension',
        employeePercent: 2,
        employerPercent: 2,
        bands: [{
          upperKhr: null,
          baseKhr: 400000
        }]
      }]
    },
    tax
  });
  assert.equal(c.confirmRateSet(a, {
    id: r.id,
    sourceNote: 'Synthetic component base coverage'
  }).status, 'confirmed');
  assert.throws(() => c.saveRateSet(a, {
    name: 'Bad descending base',
    effectiveFrom: '2027-01-01',
    nssf: {
      bands: [{
        upperKhr: 500000,
        baseKhr: 500000
      }, {
        upperKhr: null,
        baseKhr: 400000
      }],
      components: [{
        key: 'pension',
        employeePercent: 2,
        employerPercent: 2
      }]
    },
    tax
  }), /ordered/i);
}));
test('monthly FX evidence and authority edits preserve professional policy confirmation', {
  skip
}, () => fixture(({
  a
}) => {
  const c = require('../main/db/payrollConfig');
  c.updateSettings(a, {
    policyConfirmed: true,
    policySource: 'Synthetic professional policy evidence'
  });
  c.updateSettings(a, {
    taxRateKhrPerUsd: 4100,
    rateSource: 'Synthetic next-month FX',
    approvalPolicy: 'designated_managers'
  });
  assert.equal(c.getSettings(a).policyConfirmed, true);
  c.updateSettings(a, {
    maxDeductionPercent: 50
  });
  assert.equal(c.getSettings(a).policyConfirmed, false);
}));
test('daily whole-day decisions and capped stored-rate overtime recheck stale HR1 approvals', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  hr,
  at,
  ac,
  db,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  c.setPayRate(a, {
    employeeId: e,
    effectiveFrom: '2026-09-01',
    basis: 'day',
    amountMinor: 1000,
    currency: 'USD',
    reason: 'Daily test'
  });
  hr.updateSettings(a, {
    otRates: {
      normal: 125,
      night: 200,
      restDay: 200,
      holiday: 200
    }
  });
  function replace(date, kind, time) {
    const old = db.prepare('SELECT id FROM attendance_events WHERE employee_id=? AND work_date=? AND kind=? AND voided_at IS NULL').get(e, date, kind);
    at.voidEvent(old.id, 'Synthetic replacement');
    return at.addManual({
      companyId: a,
      employeeId: e,
      workDate: date,
      kind,
      at: ac.timeOnDate(date, time),
      reason: 'Synthetic replacement'
    });
  }
  replace('2026-09-02', 'out', '18:00');
  at.approveOvertime({
    companyId: a,
    employeeId: e,
    workDate: '2026-09-02',
    minutes: {
      normal: 60
    }
  });
  hr.updateSettings(a, {
    otRates: {
      normal: 200,
      night: 200,
      restDay: 200,
      holiday: 200
    }
  });
  replace('2026-09-03', 'in', '09:30');
  at.confirmLateness({
    companyId: a,
    employeeId: e,
    month: '2026-09',
    lateMinutes: 30,
    earlyLeaveMinutes: 0
  });
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'run'
  });
  let run = p.calculate(a, r.id);
  assert.ok(run.lines[0].blockers.some(x => x.code === 'whole_day_decision'));
  run = p.updateLine(a, {
    id: run.lines[0].id,
    expectedRevision: run.revision,
    patch: {
      dayDecisions: [{
        date: '2026-09-03',
        payable: true,
        reason: 'Synthetic approval of a whole payable day despite late arrival'
      }]
    }
  });
  assert.equal(run.lines[0].baseMinor, 30000);
  assert.equal(run.lines[0].overtimeMinor, 156);
  assert.equal(run.lines[0].otherDeductionsMinor, 63);
  const reviewed = p.review(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  replace('2026-09-02', 'out', '17:30');
  assert.throws(() => p.approve(a, {
    id: r.id,
    expectedRevision: reviewed.revision
  }), /stale|changed/i);
  run = p.calculate(a, r.id);
  assert.equal(run.lines[0].overtimeMinor, 78);
  assert.ok(run.lines[0].blockers.some(x => x.code === 'stale_overtime'));
  assert.throws(() => p.review(a, {
    id: r.id,
    expectedRevision: run.revision
  }), /stale|review/i);
  at.approveOvertime({
    companyId: a,
    employeeId: e,
    workDate: '2026-09-02',
    minutes: {
      normal: 30
    }
  });
  at.confirmLateness({
    companyId: a,
    employeeId: e,
    month: '2026-09',
    lateMinutes: 30,
    earlyLeaveMinutes: 0
  });
  run = p.calculate(a, r.id);
  assert.equal(run.lines[0].overtimeMinor, 125);
  assert.equal(run.lines[0].baseMinor, 30000);
}));
test('a half-day leave requires an explicit whole-day reason; no half wage is inferred', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  db,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  const leave = require('../main/db/leave');
  c.setPayRate(a, {
    employeeId: e,
    effectiveFrom: '2026-09-01',
    basis: 'day',
    amountMinor: 1000,
    currency: 'USD',
    reason: 'Daily test'
  });
  const type = leave.listTypes(a).find(t => t.code === 'unpaid');
  const request = leave.createRequest({
    companyId: a,
    employeeId: e,
    leaveTypeId: type.id,
    fromDate: '2026-09-04',
    toDate: '2026-09-04',
    halfDay: 'am',
    reason: 'Synthetic'
  });
  leave.decide(request.id, {
    decision: 'approve'
  });
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'run'
  });
  let run = p.calculate(a, r.id);
  assert.ok(run.lines[0].blockers.some(x => x.code === 'whole_day_decision'));
  assert.throws(() => p.updateLine(a, {
    id: run.lines[0].id,
    expectedRevision: run.revision,
    patch: {
      dayDecisions: [{
        date: '2026-09-04',
        payable: false,
        reason: ''
      }]
    }
  }), /reason/i);
  run = p.updateLine(a, {
    id: run.lines[0].id,
    expectedRevision: run.revision,
    patch: {
      dayDecisions: [{
        date: '2026-09-04',
        payable: false,
        reason: 'Synthetic whole unpaid day decision'
      }]
    }
  });
  assert.equal(run.lines[0].baseMinor, 29000);
  assert.ok(!run.lines[0].blockers.some(x => x.code === 'whole_day_decision'));
}));
test('KHR payroll with USD loan floors repayment at the exact salary cap', {
  skip
}, () => payFixture(({
  a,
  e,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  const loans = require('../main/db/employeeLoans');
  const loan = loans.create(a, {
    employeeId: e,
    principalMinor: 10000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'none',
    interestPolicy: 'separate',
    ratePercent: 0,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    maxDeductionPercent: 25,
    operationId: 'loan'
  });
  loans.approve(a, loan.id);
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    loanRateKhrPerUsd: 4100,
    loanRateSource: 'Synthetic',
    operationId: 'run'
  });
  let run = p.calculate(a, r.id);
  assert.equal(run.lines[0].loanDeductionMinor, 7462);
  assert.equal(run.lines[0].snapshot.loanPlans[0].amountMinor, 182);
  run = p.updateLine(a, {
    id: run.lines[0].id,
    expectedRevision: run.revision,
    patch: {
      loanDecisions: [{
        loanId: loan.id,
        amountMinor: 182,
        reason: 'Synthetic conservative floor'
      }]
    }
  });
  run = p.review(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  run = p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  p.pay(a, {
    id: run.lines[0].id,
    amountMinor: 22538,
    method: 'cash',
    paidAt: '2026-10-01',
    operationId: 'pay'
  });
  assert.equal(loans.get(a, loan.id).principalMinor, 9818);
}, 'monthly', 'KHR'));
test('draft statutory sets block final approval with exemptions and NSSF uses its own saved FX', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  const confirmed = c.listRateSets(a).find(x => x.id === rateSetId);
  const draft = c.saveRateSet(a, {
    ...confirmed,
    name: 'Synthetic draft copy'
  });
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: draft.id,
    operationId: 'draft-run'
  });
  let run = p.calculate(a, r.id);
  run = p.review(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  assert.throws(() => p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  }), /confirm/i);
  const regular = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    nssfRateKhrPerUsd: 5000,
    nssfRateSource: 'Separate synthetic NSSF FX',
    operationId: 'run'
  });
  const result = p.calculate(a, regular.id);
  assert.equal(result.lines[0].nssfEmployeeMinor, 160);
  assert.equal(result.lines[0].snapshot.calculationInput.nssfRateKhrPerUsd, 5000);
}, 'monthly', 'USD', {
  applyNssf: true,
  nssf: {
    components: [{
      key: 'pension',
      employeePercent: 2,
      employerPercent: 2,
      bands: [{
        upperKhr: null,
        baseKhr: 400000
      }]
    }]
  }
}));
test('the company recovery ceiling applies across all loans, not separately to each', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  const p = require('../main/db/payroll'),
    l = require('../main/db/employeeLoans');
  c.updateSettings(a, {
    maxDeductionPercent: 25,
    policyConfirmed: true,
    policySource: 'Synthetic aggregate recovery limit evidence'
  });
  for (const key of ['one', 'two']) {
    const loan = l.create(a, {
      employeeId: e,
      principalMinor: 50000,
      currency: 'USD',
      disbursedOn: '2026-01-01',
      interestMethod: 'none',
      interestPolicy: 'separate',
      ratePercent: 0,
      interestFreeMonths: 0,
      installmentMinor: 10000,
      maxDeductionPercent: 100,
      loanNo: key,
      operationId: key
    });
    l.approve(a, loan.id);
  }
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'run'
  });
  const run = p.calculate(a, r.id);
  assert.equal(run.lines[0].loanDeductionMinor, 7500);
}));
test('policy confirmations record the trusted actor and advancing snapshots preserve source evidence', {
  skip
}, () => fixture(({
  a
}) => {
  const c = require('../main/db/payrollConfig');
  const result = c.updateSettings(a, {
    policyConfirmed: true,
    policySource: 'Synthetic professional evidence'
  });
  assert.equal(result.policyConfirmedByUserId, 'local-admin');
  assert.ok(result.policyConfirmedAt > 0);
  assert.throws(() => c.updateSettings(a, {
    policyConfirmedByUserId: 'forged'
  }), /unknown/i);
}));
test('separate-period rounding never creates an extra cent of monthly base pay', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  c.setPayRate(a, {
    employeeId: e,
    effectiveFrom: '2026-09-01',
    basis: 'month',
    amountMinor: 30001,
    currency: 'USD',
    reason: 'Odd-cent monthly rate'
  });
  const create = (start, end, id) => p.create(a, {
    periodStart: start,
    periodEnd: end,
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: id
  });
  let first = p.calculate(a, create('2026-09-01', '2026-09-15', 'first').id);
  first = p.review(a, {
    id: first.id,
    expectedRevision: first.revision
  });
  first = p.approve(a, {
    id: first.id,
    expectedRevision: first.revision
  });
  const second = p.calculate(a, create('2026-09-16', '2026-09-30', 'second').id);
  assert.equal(first.lines[0].baseMinor, 15001);
  assert.equal(second.lines[0].baseMinor, 15000);
}, 'twice_monthly_separate'));
test('voidDraft preserves the loan header and enforces tenant, state and operation payload', {
  skip
}, () => fixture(({
  a,
  b,
  e,
  db
}) => {
  const l = require('../main/db/employeeLoans');
  const input = {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'none',
    interestPolicy: 'separate',
    ratePercent: 0,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'create'
  };
  const draft = l.create(a, input);
  assert.throws(() => l.voidDraft(b, {
    id: draft.id,
    reason: 'Wrong staff',
    operationId: 'void'
  }), /loan/i);
  const request = {
    id: draft.id,
    reason: 'Wrong synthetic employee',
    operationId: 'void'
  };
  assert.equal(l.voidDraft(a, request).status, 'void');
  assert.equal(l.voidDraft(a, request).id, draft.id);
  assert.throws(() => l.voidDraft(a, {
    ...request,
    reason: 'Changed payload'
  }), /different request/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM employee_loans').get().n, 1);
  assert.equal(l.get(a, draft.id).entries.length, 0);
  const active = l.create(a, {
    ...input,
    operationId: 'active'
  });
  l.approve(a, active.id);
  assert.throws(() => l.voidDraft(a, {
    id: active.id,
    reason: 'Wrong state',
    operationId: 'active-void'
  }), /draft/i);
}));
test('configuration rejects inherited unknown keys and sparse employee selections', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  assert.throws(() => c.updateSettings(a, {
    toString: 'unexpected'
  }), /unknown/i);
  const p = require('../main/db/payroll');
  assert.throws(() => p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: Array(1),
    statutoryRateSetId: rateSetId,
    operationId: 'sparse'
  }), /staff|employee/i);
}));
test('reversed interest no longer blocks corrected rate slices or corrected monthly accrual', {
  skip
}, () => fixture(({
  a,
  e
}) => {
  const l = require('../main/db/employeeLoans');
  const loan = l.create(a, {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'declining',
    interestPolicy: 'separate',
    ratePercent: 2,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'new'
  });
  l.approve(a, loan.id);
  const jan = l.accrue(a, {
    id: loan.id,
    through: '2026-01-31',
    operationId: 'jan'
  });
  assert.equal(jan.interestMinor, 1000);
  const interest = jan.entries.find(x => x.kind === 'interest');
  l.reverseEntry(a, {
    id: interest.id,
    reason: 'Synthetic correction',
    operationId: 'undo'
  });
  l.changeRate(a, {
    id: loan.id,
    effectiveFrom: '2026-01-16',
    ratePercent: 1,
    reason: 'Corrected synthetic terms',
    operationId: 'rate'
  });
  const corrected = l.accrue(a, {
    id: loan.id,
    through: '2026-01-31',
    operationId: 'corrected-jan'
  });
  assert.equal(corrected.interestMinor, 742);
  assert.equal(corrected.entries.filter(x => x.kind === 'interest').length, 2);
  assert.equal(corrected.entries.filter(x => x.kind === 'reversal').length, 1);
}));
test('salary-tax-only drafts preview without fabricated NSSF configuration', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  const p = require('../main/db/payroll');
  c.setEmployeePolicy(a, {
    employeeId: e,
    applyTax: true,
    applyNssf: false,
    taxResident: true,
    spouseCount: 0,
    dependentCount: 0,
    reason: 'Synthetic NSSF exemption'
  });
  const draft = c.saveRateSet(a, {
    name: 'Salary-tax-only synthetic draft',
    effectiveFrom: '2026-09-01',
    effectiveTo: '2026-09-30',
    tax: {
      brackets: [{
        upperKhr: 600000,
        ratePercent: 0
      }, {
        upperKhr: null,
        ratePercent: 10
      }],
      spouseAllowanceKhr: 0,
      dependentAllowanceKhr: 0,
      maxDependents: null,
      nonResidentPercent: 10,
      fringeBenefitPercent: 0,
      pensionDeductible: false
    }
  });
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: draft.id,
    operationId: 'run'
  });
  const run = p.calculate(a, r.id);
  assert.equal(run.lines[0].salaryTaxKhr, 60000);
  assert.equal(run.lines[0].estimate, true);
  assert.equal(run.lines[0].snapshot.rateSet.nssf.components.length, 0);
  assert.equal(run.lines[0].blockers.filter(x => x.code === 'calculation').length, 0);
}));
test('loan-linked payroll payment cannot reverse before later cash payments', {
  skip
}, () => {
  for (const firstAmount of [0, 5000]) payFixture(({
    a,
    e,
    rateSetId
  }) => {
    const p = require('../main/db/payroll'),
      l = require('../main/db/employeeLoans');
    const loan = l.create(a, {
      employeeId: e,
      principalMinor: 50000,
      currency: 'USD',
      disbursedOn: '2026-01-01',
      interestMethod: 'none',
      interestPolicy: 'separate',
      ratePercent: 0,
      interestFreeMonths: 0,
      installmentMinor: 10000,
      operationId: 'loan'
    });
    l.approve(a, loan.id);
    const run = p.create(a, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      employeeIds: [e],
      statutoryRateSetId: rateSetId,
      operationId: 'run'
    });
    let r = p.calculate(a, run.id);
    r = p.review(a, {
      id: r.id,
      expectedRevision: r.revision
    });
    r = p.approve(a, {
      id: r.id,
      expectedRevision: r.revision
    });
    const id = r.lines[0].id;
    const first = p.pay(a, {
      id,
      amountMinor: firstAmount,
      method: 'cash',
      paidAt: '2026-10-01',
      operationId: 'first'
    });
    const cash = p.pay(a, {
      id,
      amountMinor: 20000 - firstAmount,
      method: 'cash',
      paidAt: '2026-10-02',
      operationId: 'cash'
    });
    assert.equal(p.get(a, r.id).status, 'paid');
    assert.throws(() => p.reversePayment(a, {
      id: first.id,
      reason: 'Synthetic reversal',
      operationId: 'first-reverse'
    }), /later|subsequent/i);
    assert.equal(l.get(a, loan.id).principalMinor, 40000);
    assert.equal(p.get(a, r.id).status, 'paid');
    p.reversePayment(a, {
      id: cash.id,
      reason: 'Synthetic later cash reversal',
      operationId: 'cash-reverse'
    });
    p.reversePayment(a, {
      id: first.id,
      reason: 'Synthetic reversal',
      operationId: 'first-reverse'
    });
    assert.equal(l.get(a, loan.id).principalMinor, 50000);
    assert.equal(p.get(a, r.id).status, 'approved');
    assert.equal(p.get(a, r.id).lines[0].remainingMinor, 20000);
  });
});
test('reversing a zero-net payroll deduction restores approved rather than paid state', {
  skip
}, () => payFixture(({
  a,
  e,
  c,
  rateSetId
}) => {
  const p = require('../main/db/payroll'),
    l = require('../main/db/employeeLoans');
  c.setPayRate(a, {
    employeeId: e,
    effectiveFrom: '2026-09-01',
    basis: 'month',
    amountMinor: 10000,
    currency: 'USD',
    reason: 'Synthetic zero-net case'
  });
  const loan = l.create(a, {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'none',
    interestPolicy: 'separate',
    ratePercent: 0,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'loan'
  });
  l.approve(a, loan.id);
  const run = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'run'
  });
  let r = p.calculate(a, run.id);
  r = p.review(a, {
    id: r.id,
    expectedRevision: r.revision
  });
  r = p.approve(a, {
    id: r.id,
    expectedRevision: r.revision
  });
  const id = r.lines[0].id;
  assert.equal(r.lines[0].netMinor, 0);
  const first = p.pay(a, {
    id,
    amountMinor: 0,
    method: 'cash',
    paidAt: '2026-10-01',
    operationId: 'zero'
  });
  assert.equal(p.get(a, r.id).status, 'paid');
  p.reversePayment(a, {
    id: first.id,
    reason: 'Synthetic',
    operationId: 'undo'
  });
  const reversed = p.get(a, r.id);
  assert.equal(reversed.status, 'approved');
  assert.equal(reversed.lines[0].remainingLoanDeductionMinor, 10000);
  assert.equal(l.get(a, loan.id).principalMinor, 50000);
}));
test('payroll requires an effective monthly loan accrual after interest reversal', {
  skip
}, () => payFixture(({
  a,
  e,
  rateSetId
}) => {
  const p = require('../main/db/payroll'),
    l = require('../main/db/employeeLoans');
  const loan = l.create(a, {
    employeeId: e,
    principalMinor: 50000,
    currency: 'USD',
    disbursedOn: '2026-01-01',
    interestMethod: 'declining',
    interestPolicy: 'separate',
    ratePercent: 2,
    interestFreeMonths: 0,
    installmentMinor: 10000,
    operationId: 'loan'
  });
  l.approve(a, loan.id);
  const accrued = l.accrue(a, {
    id: loan.id,
    through: '2026-09-30',
    operationId: 'interest'
  });
  const september = accrued.entries.find(x => x.kind === 'interest' && x.period === '2026-09');
  l.reverseEntry(a, {
    id: september.id,
    reason: 'Synthetic correction',
    operationId: 'reverse-september'
  });
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: 'run'
  });
  const run = p.calculate(a, r.id);
  assert.ok(run.lines[0].blockers.some(x => x.code === 'loan_interest'));
  assert.throws(() => p.review(a, {
    id: r.id,
    expectedRevision: run.revision
  }), /accrue|review/i);
}));
test('NSSF-only draft passes the selected set to the calculator without a tax table', {
  skip
}, () => payFixture(({
  a,
  e,
  c
}) => {
  const p = require('../main/db/payroll');
  c.setEmployeePolicy(a, {
    employeeId: e,
    applyTax: false,
    applyNssf: true,
    taxResident: true,
    spouseCount: 0,
    dependentCount: 0,
    reason: 'Synthetic salary tax exemption'
  });
  const draft = c.saveRateSet(a, {
    name: 'NSSF-only synthetic draft',
    effectiveFrom: '2026-09-01',
    nssf: {
      components: [{
        key: 'pension',
        employeePercent: 2,
        employerPercent: 2,
        bands: [{
          upperKhr: null,
          baseKhr: 400000
        }]
      }]
    }
  });
  const r = p.create(a, {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    employeeIds: [e],
    statutoryRateSetId: draft.id,
    nssfRateKhrPerUsd: 5000,
    nssfRateSource: 'Synthetic NSSF-only source',
    operationId: 'run'
  });
  const run = p.calculate(a, r.id);
  assert.equal(run.lines[0].nssfEmployeeMinor, 160);
  assert.equal(run.lines[0].salaryTaxMinor, 0);
  assert.equal(run.lines[0].snapshot.calculationInput.rateSet.id, draft.id);
  assert.equal(run.lines[0].estimate, true);
}));
test('loan projection and accrual reject oversized horizons before monthly scans', {
  skip
}, () => fixture(({
  a,
  e
}) => {
  const l = require('../main/db/employeeLoans');
  const create = (date, key) => {
    const loan = l.create(a, {
      employeeId: e,
      principalMinor: 100,
      currency: 'KHR',
      disbursedOn: date,
      interestMethod: 'none',
      interestPolicy: 'separate',
      ratePercent: 0,
      interestFreeMonths: 0,
      installmentMinor: 100,
      operationId: key
    });
    l.approve(a, loan.id);
    return loan;
  };
  const normal = create('2026-01-01', 'normal');
  assert.throws(() => l.project(a, normal.id, {
    through: '9999-12-31'
  }), /horizon|600/i);
  assert.throws(() => l.accrue(a, {
    id: normal.id,
    through: '9999-12-31',
    operationId: 'absurd-future'
  }), /horizon|600/i);
  const historical = create('1400-01-01', 'historical');
  assert.throws(() => l.accrue(a, {
    id: historical.id,
    through: '2026-09-30',
    operationId: 'absurd-history'
  }), /horizon|600/i);
  const projection = l.project(a, normal.id, {
    through: '2036-12-31'
  });
  assert.equal(projection.principalMinor, 0);
  assert.equal(projection.interestMinor, 0);
  assert.ok(projection.entries.some(x => x.kind === 'repayment'));
}));
function replaceClockIn({
  a,
  e,
  db,
  at,
  ac
}, date, time) {
  const old = db.prepare("SELECT id FROM attendance_events WHERE employee_id=? AND work_date=? AND kind='in' AND voided_at IS NULL").get(e, date);
  at.voidEvent(old.id, 'Synthetic correction');
  at.addManual({
    companyId: a,
    employeeId: e,
    workDate: date,
    kind: 'in',
    at: ac.timeOnDate(date, time),
    reason: 'Synthetic correction'
  });
}
function approvePayroll(p, a, run) {
  const reviewed = p.review(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  return p.approve(a, {
    id: run.id,
    expectedRevision: reviewed.revision
  });
}
for (const basis of ['hour', 'day']) {
  test(`confirmed lateness does not charge wages already excluded from ${basis} base pay`, {
    skip
  }, () => payFixture(x => {
    const {
      a,
      e,
      c,
      at,
      rateSetId
    } = x;
    const p = require('../main/db/payroll');
    for (const h of x.hr.listHolidays(a, {
      from: '2026-09-01',
      to: '2026-09-30'
    })) x.hr.updateHoliday(h.id, {
      archived: true
    });
    c.setPayRate(a, {
      employeeId: e,
      effectiveFrom: '2026-09-01',
      basis,
      amountMinor: 1000,
      currency: 'USD',
      reason: 'Synthetic wage basis'
    });
    replaceClockIn(x, '2026-09-01', basis === 'hour' ? '10:00' : '09:30');
    at.confirmLateness({
      companyId: a,
      employeeId: e,
      month: '2026-09',
      lateMinutes: basis === 'hour' ? 60 : 30,
      earlyLeaveMinutes: 0
    });
    let run = p.calculate(a, p.create(a, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      employeeIds: [e],
      statutoryRateSetId: rateSetId,
      operationId: 'excluded-wages'
    }).id);
    if (basis === 'day') run = p.updateLine(a, {
      id: run.lines[0].id,
      expectedRevision: run.revision,
      patch: {
        dayDecisions: [{
          date: '2026-09-01',
          payable: false,
          reason: 'Whole day unpaid'
        }]
      }
    });
    assert.equal(run.lines[0].baseMinor, basis === 'hour' ? 239000 : 29000);
    assert.equal(run.lines[0].otherDeductionsMinor, 0);
    assert.equal(run.lines[0].netMinor, basis === 'hour' ? 239000 : 29000);
    assert.equal(approvePayroll(p, a, run).status, 'approved');
  }));
}
for (const basis of ['hour', 'day', 'month']) {
  test(`separate-period late settlement preserves frozen ${basis} wage inclusion and chronological cap`, {
    skip
  }, () => payFixture(x => {
    const {
      a,
      e,
      c,
      at,
      rateSetId
    } = x;
    const p = require('../main/db/payroll');
    for (const h of x.hr.listHolidays(a, {
      from: '2026-09-01',
      to: '2026-09-30'
    })) x.hr.updateHoliday(h.id, {
      archived: true
    });
    c.setPayRate(a, {
      employeeId: e,
      effectiveFrom: '2026-09-01',
      basis,
      amountMinor: basis === 'month' ? 30000 : 1000,
      currency: 'USD',
      reason: 'Synthetic wage basis'
    });
    replaceClockIn(x, '2026-09-01', '09:30');
    replaceClockIn(x, '2026-09-16', '09:30');
    const create = (start, end) => p.calculate(a, p.create(a, {
      periodStart: start,
      periodEnd: end,
      employeeIds: [e],
      statutoryRateSetId: rateSetId,
      operationId: start
    }).id);
    let first = create('2026-09-01', '2026-09-15');
    if (basis === 'day') first = p.updateLine(a, {
      id: first.lines[0].id,
      expectedRevision: first.revision,
      patch: {
        dayDecisions: [{
          date: '2026-09-01',
          payable: false,
          reason: 'Whole day unpaid'
        }]
      }
    });
    assert.equal(first.lines[0].otherDeductionsMinor, 0, 'Unconfirmed first half cannot deduct lateness');
    first = approvePayroll(p, a, first);
    at.confirmLateness({
      companyId: a,
      employeeId: e,
      month: '2026-09',
      lateMinutes: 30,
      earlyLeaveMinutes: 0,
      note: 'Waive 30 minutes of the monthly total'
    });
    let second = create('2026-09-16', '2026-09-30');
    if (basis === 'day') second = p.updateLine(a, {
      id: second.lines[0].id,
      expectedRevision: second.revision,
      patch: {
        dayDecisions: [{
          date: '2026-09-16',
          payable: true,
          reason: 'Whole day payable'
        }]
      }
    });
    // The 30 confirmed minutes belong to Sep 1 even if that day was unpaid;
    // they must not migrate to Sep 16. Monthly wages still include Sep 1.
    assert.equal(second.lines[0].otherDeductionsMinor, basis === 'month' ? 63 : 0);
    assert.equal(first.lines[0].netMinor + second.lines[0].netMinor, basis === 'hour' ? 239000 : basis === 'day' ? 29000 : 29937);
    assert.equal(approvePayroll(p, a, second).status, 'approved');
  }, 'twice_monthly_separate'));
}
test('hourly components allocate cumulative cents per dated assignment across separate periods', {
  skip
}, () => payFixture(x => {
  const {
    a,
    e,
    c,
    rateSetId
  } = x;
  const p = require('../main/db/payroll');
  for (const h of x.hr.listHolidays(a, {
    from: '2026-09-01',
    to: '2026-09-30'
  })) x.hr.updateHoliday(h.id, {
    archived: true
  });
  replaceClockIn(x, '2026-09-01', '09:30');
  replaceClockIn(x, '2026-09-16', '09:30');
  const assign = (code, windows) => {
    const component = c.saveComponent(a, {
      code,
      nameEn: code,
      kind: 'earning',
      calc: 'per_hour',
      taxable: false,
      nssfContributory: false,
      isFringeBenefit: false
    });
    return windows.map(([from, to, amountMinor]) => c.setEmployeeComponent(a, {
      employeeId: e,
      componentId: component.id,
      effectiveFrom: from,
      effectiveTo: to,
      amountMinor,
      currency: 'USD'
    }));
  };
  assign('full', [['2026-09-01', '2026-09-30', 1]]);
  // Assignment 1: 159 hours -> 159 cents, split 119.5h + 39.5h.
  // Assignment 2: 80 hours at 3 cents -> 240 cents, no prior allocation.
  assign('changing', [['2026-09-01', '2026-09-20', 1], ['2026-09-21', '2026-09-30', 3]]);
  // Starts inside the first half and ends inside the second: 79.5h -> 80 cents.
  assign('window', [['2026-09-11', '2026-09-20', 1]]);
  const create = (start, end) => p.calculate(a, p.create(a, {
    periodStart: start,
    periodEnd: end,
    employeeIds: [e],
    statutoryRateSetId: rateSetId,
    operationId: start
  }).id);
  const first = approvePayroll(p, a, create('2026-09-01', '2026-09-15'));
  const second = create('2026-09-16', '2026-09-30');
  const amounts = run => Object.fromEntries(run.lines[0].snapshot.calculationInput.components.map(i => [i.code, i.amountMinor]));
  assert.deepEqual(amounts(first), {
    full: 120,
    changing: 120,
    window: 40
  });
  assert.deepEqual(amounts(second), {
    full: 119,
    changing: 279,
    window: 40
  });
  assert.equal(approvePayroll(p, a, second).status, 'approved');
}, 'twice_monthly_separate'));
test('signed loan history retains exact balances after large interest reversals and reaccrual', {
  skip
}, () => fixture(({
  a,
  e,
  db
}) => {
  const l = require('../main/db/employeeLoans');
  const loan = l.create(a, {
    employeeId: e,
    principalMinor: 1000000000000001,
    currency: 'KHR',
    disbursedOn: '2026-01-01',
    interestMethod: 'declining',
    interestPolicy: 'separate',
    ratePercent: 100,
    interestFreeMonths: 0,
    installmentMinor: 1000000000000001,
    operationId: 'large-loan'
  });
  l.approve(a, loan.id);
  const first = l.accrue(a, {
    id: loan.id,
    through: '2026-08-31',
    operationId: 'first-accrual'
  });
  assert.equal(first.interestMinor, 8000000000000008);
  for (const entry of first.entries.filter(x => x.kind === 'interest').reverse()) {
    l.reverseEntry(a, {
      id: entry.id,
      reason: 'Synthetic correction',
      operationId: entry.id
    });
  }
  assert.equal(l.get(a, loan.id).interestMinor, 0);
  assert.equal(l.project(a, loan.id, {
    through: '2026-08-31'
  }).interestMinor, 8000000000000008);
  const corrected = l.accrue(a, {
    id: loan.id,
    through: '2026-08-31',
    operationId: 'corrected-accrual'
  });
  assert.equal(corrected.interestMinor, 8000000000000008);
  assert.equal(l.list(a)[0].interestMinor, 8000000000000008);
  assert.equal(l.project(a, loan.id, {
    through: '2026-08-31'
  }).interestMinor, 8000000000000008);
  l.repay(a, {
    id: loan.id,
    amountMinor: 9000000000000009,
    entryDate: '2026-09-01',
    source: 'cash',
    operationId: 'exact-payoff'
  });
  assert.equal(l.get(a, loan.id).status, 'paid');
  assert.equal(l.get(a, loan.id).interestMinor, 0);
  assert.equal(l.project(a, loan.id, {
    through: '2026-09-30'
  }).interestMinor, 0);
  assert.deepEqual(db.prepare('SELECT SUM(principal_part) principal, SUM(interest_part) interest FROM loan_entries WHERE loan_id=?').get(loan.id), {
    principal: 0,
    interest: 0
  });
}));
for (const interestMethod of ['none', 'declining']) {
  test(`prior-month salary can repay an October ${interestMethod} loan only on or after disbursement`, {
    skip
  }, () => payFixture(({
    a,
    e,
    db,
    rateSetId
  }) => {
    const l = require('../main/db/employeeLoans');
    const p = require('../main/db/payroll');
    const loan = l.create(a, {
      employeeId: e,
      principalMinor: 50000,
      currency: 'USD',
      disbursedOn: '2026-10-01',
      interestMethod,
      interestPolicy: 'separate',
      ratePercent: interestMethod === 'none' ? 0 : 2,
      interestFreeMonths: 0,
      installmentMinor: 10000,
      operationId: 'october-loan'
    });
    l.approve(a, loan.id);
    const run = p.calculate(a, p.create(a, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      employeeIds: [e],
      statutoryRateSetId: rateSetId,
      operationId: 'september-salary'
    }).id);
    assert.deepEqual(run.lines[0].blockers, []);
    assert.equal(run.lines[0].loanDeductionMinor, 10000);
    const approved = approvePayroll(p, a, run);
    assert.throws(() => p.pay(a, {
      id: approved.lines[0].id,
      amountMinor: 20000,
      paidAt: '2026-09-30',
      method: 'cash',
      operationId: 'too-early'
    }), /before disbursement/i);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_payments').get().n, 0);
    p.pay(a, {
      id: approved.lines[0].id,
      amountMinor: 20000,
      paidAt: '2026-10-01',
      method: 'cash',
      operationId: 'on-disbursement'
    });
    assert.equal(l.get(a, loan.id).principalMinor, 40000);
    assert.equal(p.get(a, run.id).status, 'paid');
  }));
}
