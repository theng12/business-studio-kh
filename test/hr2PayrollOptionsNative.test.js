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
    skip = 'Run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/hr2PayrollOptionsNative.test.js';
  } else throw error;
}

// Real HR1/HR2 services and isolated synthetic data; no copied module or mocks.
function fixture(fn, {
  cycle = 'monthly',
  confirmed = true
} = {}) {
  const dbModule = require('../main/db');
  dbModule.initDb(fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-hr2-options-')));
  try {
    const companies = require('../main/db/companies');
    const employees = require('../main/db/employees');
    const c = require('../main/db/payrollConfig');
    const p = require('../main/db/payroll');
    const hr = require('../main/db/hr');
    const at = require('../main/db/attendance');
    const ac = require('../main/util/attendanceCalc');
    const leave = require('../main/db/leave');
    const a = companies.create({
      name: 'Synthetic payroll options A'
    }).id;
    const b = companies.create({
      name: 'Synthetic payroll options B'
    }).id;
    const e = employees.create({
      companyId: a,
      staffCode: 'A',
      nameEn: 'Synthetic employee A'
    }).id;
    const foreign = employees.create({
      companyId: b,
      staffCode: 'B',
      nameEn: 'Synthetic employee B'
    }).id;
    hr.ensurePrefilled(a);
    const schedule = hr.createSchedule({
      companyId: a,
      name: 'Synthetic daily schedule',
      startTime: '09:00',
      endTime: '17:00',
      breakMin: 0,
      workDays: '1111111',
      graceMin: 0
    });
    hr.updateSettings(a, {
      defaultScheduleId: schedule.id,
      attendanceStartDate: '2026-01-01'
    });
    c.updateSettings(a, {
      payCycle: cycle,
      policyConfirmed: true,
      policySource: 'Synthetic professional evidence: pay frequency, deductions, lending, capitalization, statutory aggregation and FX',
      taxRateKhrPerUsd: 4000,
      rateSource: 'Synthetic tax FX',
      nssfRateKhrPerUsd: 4000,
      nssfRateSource: 'Synthetic NSSF FX'
    });
    c.setEmployeePolicy(a, {
      employeeId: e,
      applyTax: true,
      applyNssf: false,
      taxResident: true,
      spouseCount: 0,
      dependentCount: 0,
      reason: 'Synthetic employee exemption'
    });
    c.setPayRate(a, {
      employeeId: e,
      effectiveFrom: '2026-01-01',
      basis: 'month',
      amountMinor: 30000,
      currency: 'USD',
      reason: 'Synthetic pay rate'
    });
    const set = c.saveRateSet(a, {
      name: 'Synthetic rates, not legal defaults',
      effectiveFrom: '2026-01-01',
      nssf: {
        bands: [{
          upperKhr: null,
          baseKhr: 400000
        }],
        components: [{
          key: 'pension',
          employeePercent: 1,
          employerPercent: 2
        }]
      },
      tax: {
        brackets: [{
          upperKhr: null,
          ratePercent: 10
        }],
        spouseAllowanceKhr: 0,
        dependentAllowanceKhr: 0,
        maxDependents: null,
        nonResidentPercent: 10,
        fringeBenefitPercent: 10,
        pensionDeductible: false
      }
    });
    if (confirmed) c.confirmRateSet(a, {
      id: set.id,
      sourceNote: 'Synthetic confirmation for tests only'
    });
    for (let day = 1; day <= 30; day++) {
      const date = `2026-09-${String(day).padStart(2, '0')}`;
      for (const [kind, time] of [['in', '09:00'], ['out', '17:00']]) {
        at.addManual({
          companyId: a,
          employeeId: e,
          workDate: date,
          kind,
          at: ac.timeOnDate(date, time),
          reason: 'Synthetic attendance'
        });
      }
    }
    let sequence = 0;
    const create = (patch = {}) => p.create(a, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      employeeIds: [e],
      statutoryRateSetId: set.id,
      operationId: `options-${++sequence}`,
      ...patch
    });
    return fn({
      a,
      b,
      e,
      foreign,
      c,
      p,
      leave,
      create,
      db: dbModule.getDb()
    });
  } finally {
    dbModule.closeDb();
  }
}
function review(p, companyId, run) {
  return p.review(companyId, {
    id: run.id,
    expectedRevision: run.revision
  });
}
function override(p, companyId, run, statutoryOverride) {
  return p.updateLine(companyId, {
    id: run.lines[0].id,
    expectedRevision: run.revision,
    patch: {
      statutoryOverride
    }
  });
}
test('statutory flags inherit employee then run then line, and null clears the line override', {
  skip
}, () => fixture(({
  a,
  e,
  c,
  p,
  create
}) => {
  const inherited = p.calculate(a, create().id);
  assert.equal(inherited.lines[0].salaryTaxMinor, 3000);
  assert.equal(inherited.lines[0].nssfEmployeeMinor, 0);
  const runOverride = {
    applyTax: false,
    applyNssf: true,
    reason: 'Synthetic run exception'
  };
  let run = p.calculate(a, create({
    statutoryOverride: runOverride
  }).id);
  assert.deepEqual(run.input.statutoryOverride, runOverride);
  assert.equal(run.lines[0].salaryTaxMinor, 0);
  assert.equal(run.lines[0].nssfEmployeeMinor, 100);
  const employeePolicy = c.getEmployeePolicy(a, e);
  const lineOverride = {
    applyTax: true,
    reason: 'Synthetic line inclusion'
  };
  run = override(p, a, run, lineOverride);
  const line = run.lines[0];
  assert.equal(line.applyTax, true);
  assert.equal(line.applyNssf, true);
  assert.equal(line.netMinor, 26900);
  assert.deepEqual(line.snapshot.employeePolicy, employeePolicy);
  assert.deepEqual(line.snapshot.runStatutoryOverride, runOverride);
  assert.deepEqual(line.snapshot.lineStatutoryOverride, lineOverride);
  assert.deepEqual(line.snapshot.effectivePolicy, {
    ...employeePolicy,
    applyTax: true,
    applyNssf: true
  });
  assert.deepEqual(line.snapshot.policy, line.snapshot.effectivePolicy);
  assert.deepEqual(line.decisions.statutoryOverride, lineOverride);
  // Replacing a line object does not retain its previous explicit tax=true.
  run = override(p, a, run, {
    applyNssf: false,
    reason: 'Synthetic NSSF exclusion'
  });
  assert.equal(run.lines[0].netMinor, 30000);
  run = override(p, a, run, null);
  assert.equal(run.lines[0].netMinor, 29900);
  assert.equal(run.lines[0].decisions.statutoryOverride, null);
  assert.equal(run.lines[0].snapshot.lineStatutoryOverride, null);
  assert.deepEqual(run.input.statutoryOverride, runOverride);
  assert.deepEqual(c.getEmployeePolicy(a, e), employeePolicy);
}));
test('statutory overrides require explicit boolean flags and reasons for both inclusion and exclusion', {
  skip
}, () => fixture(({
  a,
  p,
  create,
  db
}) => {
  const bad = [{
    applyTax: true
  }, {
    applyNssf: false
  }, {
    applyTax: true,
    reason: '  '
  }, {
    applyTax: 'false',
    reason: 'Invalid type'
  }, {
    applyNssf: 1,
    reason: 'Invalid type'
  }, {
    applyTax: null,
    reason: 'Invalid type'
  }, {
    applyTax: false,
    reason: 7
  }, {
    reason: 'No flags'
  }, {
    applyTax: false,
    taxResident: false,
    reason: 'Unknown key'
  }, [], false, 'off'];
  for (const statutoryOverride of bad) {
    assert.throws(() => create({
      statutoryOverride
    }), /override|boolean|reason/i);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_runs').get().n, 0);
  const run = p.calculate(a, create().id);
  for (const statutoryOverride of [...bad, undefined]) {
    assert.throws(() => override(p, a, run, statutoryOverride), /override|boolean|reason/i);
    assert.equal(p.get(a, run.id).revision, run.revision);
  }
  const input = {
    operationId: 'same-key',
    statutoryOverride: {
      applyTax: false,
      reason: 'First reason'
    }
  };
  const created = create(input);
  assert.equal(create(input).id, created.id);
  assert.throws(() => create({
    ...input,
    statutoryOverride: {
      applyTax: false,
      reason: 'Changed reason'
    }
  }), /operation|payload/i);
}));
test('turning both statutory flags off cannot bypass statutory or professional policy confirmation', {
  skip
}, () => fixture(({
  a,
  c,
  p,
  create
}) => {
  let run = p.calculate(a, create({
    statutoryOverride: {
      applyTax: false,
      applyNssf: false,
      reason: 'Synthetic preview exemption'
    }
  }).id);
  assert.equal(run.lines[0].salaryTaxMinor, 0);
  assert.equal(run.lines[0].nssfEmployeeMinor, 0);
  run = review(p, a, run);
  assert.throws(() => p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  }), /confirmed.*statutory/i);
  c.updateSettings(a, {
    policyConfirmed: false
  });
  run = p.calculate(a, run.id);
  assert.ok(run.lines[0].blockers.some(x => x.code === 'policy_confirmation'));
  assert.throws(() => review(p, a, run), /professional|policy/i);
}, {
  confirmed: false
}));
test('override changes enforce tenant, stale revision, source and approved snapshot boundaries', {
  skip
}, () => fixture(({
  a,
  b,
  e,
  foreign,
  c,
  p,
  create
}) => {
  assert.throws(() => create({
    employeeIds: [foreign],
    statutoryOverride: {
      applyTax: false,
      reason: 'Foreign employee'
    }
  }), /company|staff|employee/i);
  let run = p.calculate(a, create({
    statutoryOverride: {
      applyTax: false,
      reason: 'Synthetic exception'
    }
  }).id);
  assert.throws(() => override(p, b, run, null), /company|line/i);
  const old = run;
  run = override(p, a, run, {
    applyTax: true,
    reason: 'Restore inclusion'
  });
  assert.throws(() => override(p, a, old, null), /revision|superseded/i);
  run = review(p, a, run);
  c.setEmployeePolicy(a, {
    employeeId: e,
    applyTax: true,
    applyNssf: false,
    taxResident: true,
    spouseCount: 0,
    dependentCount: 1,
    reason: 'Synthetic changed dependent'
  });
  assert.throws(() => p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  }), /stale|changed/i);
  run = review(p, a, p.calculate(a, run.id));
  run = p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  assert.throws(() => override(p, a, run, null), /frozen/i);
  const frozen = run.lines[0].snapshot;
  c.setEmployeePolicy(a, {
    employeeId: e,
    applyTax: false,
    applyNssf: true,
    taxResident: false,
    spouseCount: 0,
    dependentCount: 0,
    reason: 'Later policy change'
  });
  assert.deepEqual(p.get(a, run.id).lines[0].snapshot, frozen);
  assert.equal(p.get(a, run.id).lines[0].applyTax, true);
}));
test('separate periods reject mixed effective statutory flags and accept matching overrides', {
  skip
}, () => fixture(({
  a,
  p,
  create
}) => {
  let first = p.calculate(a, create({
    periodEnd: '2026-09-15',
    statutoryOverride: {
      applyTax: false,
      reason: 'Synthetic month exception'
    }
  }).id);
  first = review(p, a, first);
  p.approve(a, {
    id: first.id,
    expectedRevision: first.revision
  });
  let second = p.calculate(a, create({
    periodStart: '2026-09-16'
  }).id);
  assert.ok(second.lines[0].blockers.some(x => /Monthly statutory policy/.test(x.message)));
  assert.throws(() => review(p, a, second), /Monthly statutory policy/i);
  second = override(p, a, second, {
    applyTax: false,
    reason: 'Match approved first period'
  });
  assert.deepEqual(second.lines[0].blockers, []);
  assert.equal(second.lines[0].salaryTaxMinor, 0);
  second = review(p, a, second);
  assert.equal(p.approve(a, {
    id: second.id,
    expectedRevision: second.revision
  }).status, 'approved');
}, {
  cycle: 'twice_monthly_separate'
}));
test('leave snapshots keep tracked types separate as of period end and freeze without accrual writes', {
  skip
}, () => fixture(({
  a,
  b,
  e,
  foreign,
  p,
  leave,
  create,
  db
}) => {
  const types = leave.listTypes(a);
  const annual = types.find(t => t.code === 'annual');
  const special = types.find(t => t.code === 'special');
  const foreignType = leave.listTypes(b).find(t => t.code === 'annual');
  const adjust = (t, days, date) => leave.adjust({
    companyId: a,
    employeeId: e,
    leaveTypeId: t.id,
    days,
    date,
    note: 'Synthetic leave ledger'
  });
  adjust(annual, 12, '2026-08-31');
  adjust(annual, -1.5, '2026-09-30');
  adjust(special, 7, '2026-08-31');
  adjust(special, -0.5, '2026-09-30');
  adjust(annual, 20, '2026-10-01');
  adjust(special, -2, '2026-10-01');
  leave.adjust({
    companyId: b,
    employeeId: foreign,
    leaveTypeId: foreignType.id,
    days: 99,
    date: '2026-09-30',
    note: 'Other tenant'
  });
  const count = db.prepare('SELECT COUNT(*) n FROM leave_ledger').get().n;
  let run = p.calculate(a, create().id);
  const expected = [annual, special].map((t, index) => ({
    leaveTypeId: t.id,
    code: t.code,
    nameEn: t.nameEn,
    nameKm: t.nameKm,
    days: index === 0 ? 10.5 : 6.5
  }));
  assert.equal(run.lines[0].snapshot.leaveBalanceAsOf, '2026-09-30');
  assert.deepEqual(run.lines[0].snapshot.leaveBalances, expected);
  run = review(p, a, run);
  // A later-dated adjustment does not change the as-of values or block approval.
  adjust(annual, 1, '2026-10-02');
  run = p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leave_ledger').get().n, count + 1);
  // A backdated correction after approval changes live history, never the payslip.
  adjust(annual, 2, '2026-09-30');
  leave.updateType(special.id, {
    nameEn: 'Later renamed special leave'
  });
  assert.equal(leave.balanceOf(e, annual.id, {
    asOf: '2026-09-30'
  }), 12.5);
  assert.deepEqual(p.get(a, run.id).lines[0].snapshot.leaveBalances, expected);
  assert.throws(() => p.get(b, run.id), /company|run/i);
}));
test('a backdated leave balance adjustment invalidates reviewed payroll before approval', {
  skip
}, () => fixture(({
  a,
  e,
  p,
  leave,
  create
}) => {
  const annual = leave.listTypes(a).find(t => t.code === 'annual');
  leave.adjust({
    companyId: a,
    employeeId: e,
    leaveTypeId: annual.id,
    days: 10,
    date: '2026-09-01',
    note: 'Synthetic opening'
  });
  let run = review(p, a, p.calculate(a, create().id));
  leave.adjust({
    companyId: a,
    employeeId: e,
    leaveTypeId: annual.id,
    days: -2,
    date: '2026-09-30',
    note: 'Synthetic correction'
  });
  assert.throws(() => p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  }), /stale|changed/i);
  run = p.calculate(a, run.id);
  assert.equal(run.lines[0].snapshot.leaveBalances.find(t => t.code === 'annual').days, 8);
  run = review(p, a, run);
  assert.equal(p.approve(a, {
    id: run.id,
    expectedRevision: run.revision
  }).status, 'approved');
}));
