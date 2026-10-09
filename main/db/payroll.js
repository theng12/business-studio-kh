const {
  getDb
} = require('./index');
const c = require('./payrollConfig');
const loans = require('./employeeLoans');
const {
  uuid,
  getCallerUserId
} = require('./_fuelUtil');
const attendance = require('./attendance');
const leave = require('./leave');
const ac = require('../util/attendanceCalc');
const hr = require('./hr');
const math = () => require('../util/payrollCalc');
const loanMath = () => require('../util/loanCalc');
const FIELDS = ['baseMinor', 'overtimeMinor', 'grossMinor', 'nssfEmployeeMinor', 'nssfEmployerMinor', 'taxBaseKhr', 'salaryTaxKhr', 'fringeTaxKhr', 'salaryTaxMinor', 'otherDeductionsMinor', 'loanDeductionMinor', 'advanceMinor', 'netMinor'];
const snake = s => s.replace(/[A-Z]/g, x => `_${x.toLowerCase()}`);
const round = (n, d) => {
  const amount = Number((n + d / 2n) / d);
  return c.money(amount);
};
// A withholding limit is a ceiling, not a nearest-rounding FX quote. Charge
// enough salary units to cover the exact loan-currency repayment, then choose
// the largest loan amount within that ceiling. Ordinary FX stays in payrollCalc.
function salaryCostCeiling(amountMinor, loanCurrency, salaryCurrency, rate) {
  if (loanCurrency === salaryCurrency) return amountMinor;
  const [mantissa, exponent = '0'] = String(rate).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale));
  const denominator = 10n ** BigInt(Math.max(0, scale));
  const n = BigInt(amountMinor) * (loanCurrency === 'USD' ? numerator : denominator * 100n);
  const d = loanCurrency === 'USD' ? denominator * 100n : numerator;
  return c.money(Number((n + d - 1n) / d), 'Salary loan withholding');
}
function paid(lineId) {
  return c.money(getDb().prepare('SELECT COALESCE(SUM(amount_minor),0) n FROM payroll_payments WHERE line_id=?').get(lineId).n, 'Paid balance');
}
function payment(r) {
  return {
    id: r.id,
    companyId: r.company_id,
    lineId: r.line_id,
    amountMinor: r.amount_minor,
    paidAt: r.paid_at,
    method: r.method,
    reference: r.reference,
    reversesPaymentId: r.reverses_payment_id,
    reason: r.reason,
    paidByUserId: r.paid_by_user_id
  };
}
function line(r) {
  const snapshot = JSON.parse(r.snapshot);
  const paidMinor = paid(r.id);
  const employee = snapshot.employee || {};
  const postedLoans = getDb().prepare(`SELECT e.loan_id loanId, SUM(-e.amount_minor) amountMinor
    FROM loan_entries e WHERE e.payroll_line_id=? AND e.kind='repayment'
      AND NOT EXISTS (SELECT 1 FROM loan_entries rev WHERE rev.reverses_entry_id=e.id)
    GROUP BY e.loan_id`).all(r.id);
  const remainingLoanDeductionMinor = c.money((snapshot.loanPlans || []).reduce((sum, plan) => {
    if (!plan.amountMinor) return sum;
    const posted = postedLoans.find(x => x.loanId === plan.loanId)?.amountMinor || 0;
    if (posted !== 0 && posted !== plan.amountMinor) c.fail('Payroll loan posting does not reconcile to its frozen plan');
    return sum + (posted === plan.amountMinor ? 0 : plan.salaryAmountMinor);
  }, 0), 'Remaining payroll loan deduction');
  return {
    id: r.id,
    companyId: r.company_id,
    runId: r.run_id,
    employeeId: r.employee_id,
    active: !!r.active,
    currency: r.currency,
    ...Object.fromEntries(FIELDS.map(k => [k, r[snake(k)]])),
    snapshot,
    blockers: JSON.parse(r.blockers_json),
    decisions: JSON.parse(r.decisions_json),
    staffCode: employee.staffCode,
    nameEn: employee.nameEn,
    nameKm: employee.nameKm,
    bankName: employee.bankName,
    bankAccountName: employee.bankAccountName,
    bankAccountNo: employee.bankAccountNo,
    nssfNo: employee.nssfNo,
    applyTax: snapshot.policy?.applyTax,
    applyNssf: snapshot.policy?.applyNssf,
    estimate: snapshot.estimate ?? true,
    items: getDb().prepare('SELECT code,label,kind,amount_minor amountMinor,amount_khr amountKhr,base_khr baseKhr FROM payroll_line_items WHERE line_id=? ORDER BY rowid').all(r.id),
    paidMinor,
    remainingLoanDeductionMinor,
    remainingMinor: r.net_minor - paidMinor
  };
}
function run(r, details = true) {
  return {
    id: r.id,
    companyId: r.company_id,
    month: r.month,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    payDate: r.pay_date,
    kind: r.kind,
    status: r.status,
    revision: r.revision,
    taxRateKhrPerUsd: r.tax_rate_khr_per_usd,
    rateSource: r.rate_source,
    statutoryRateSetId: r.statutory_rate_set_id,
    sourceHash: r.source_hash,
    input: JSON.parse(r.input_snapshot),
    approvedAt: r.approved_at,
    approvedByUserId: r.approved_by_user_id,
    voidReason: r.void_reason,
    ...(details ? {
      lines: getDb().prepare('SELECT * FROM payroll_lines WHERE run_id=? AND active=1 ORDER BY employee_id').all(r.id).map(line),
      payments: getDb().prepare('SELECT p.* FROM payroll_payments p JOIN payroll_lines l ON l.id=p.line_id WHERE l.run_id=? ORDER BY p.rowid').all(r.id).map(payment),
      reviews: getDb().prepare('SELECT revision,source_hash sourceHash,blockers_json blockersJson,reviewed_by_user_id reviewedByUserId,created_at createdAt FROM payroll_reviews WHERE run_id=? ORDER BY rowid').all(r.id).map(x => ({
        ...x,
        blockers: JSON.parse(x.blockersJson)
      }))
    } : {})
  };
}
function get(companyId, id) {
  const result = run(c.scoped('payroll_runs', companyId, id, 'Payroll run'));
  result.estimate = result.lines.some(x => x.estimate);
  return result;
}
function list(companyId, {
  month = null,
  status = null
} = {}) {
  c.company(companyId);
  if (month) c.date(`${month}-01`, 'Month');
  if (status) c.choice(status, ['draft', 'reviewed', 'approved', 'paid', 'void'], 'Run status');
  return getDb().prepare('SELECT * FROM payroll_runs WHERE company_id=? AND (? IS NULL OR month=?) AND (? IS NULL OR status=?) ORDER BY period_start DESC,created_at DESC').all(companyId, month, month, status, status).map(r => run(r, false));
}
function mutable(r) {
  if (!['draft', 'reviewed'].includes(r.status)) c.fail('Approved payroll is frozen; void and replace it');
}
function revision(r, v) {
  if (!Number.isSafeInteger(v) || r.revision !== v) c.fail('Payroll revision changed; reload the run');
}
function statutoryOverride(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) c.fail('Statutory override must be an object or null');
  for (const key of Object.keys(value)) {
    if (!['applyTax', 'applyNssf', 'reason'].includes(key)) c.fail(`Unsupported statutory override ${key}`);
  }
  const flags = ['applyTax', 'applyNssf'].filter(key => Object.hasOwn(value, key));
  if (!flags.length) c.fail('Statutory override requires at least one boolean flag');
  return {
    ...Object.fromEntries(flags.map(key => [key, c.bool(value[key], key)])),
    reason: c.text(value.reason, 'Statutory override reason')
  };
}
function create(companyId, p) {
  return c.operation(companyId, p.operationId, 'payroll:create', p, () => {
    c.date(p.periodStart);
    c.date(p.periodEnd);
    if (p.periodStart > p.periodEnd || p.periodStart.slice(0, 7) !== p.periodEnd.slice(0, 7)) c.fail('Payroll must be within one calendar month');
    if (p.periodEnd >= ac.ppDate(Date.now())) c.fail('Payroll period must have ended');
    if (!Array.isArray(p.employeeIds) || !p.employeeIds.length || p.employeeIds.length > 500 || new Set(p.employeeIds).size !== p.employeeIds.length) c.fail('Choose 1 to 500 distinct staff members');
    for (const id of p.employeeIds) c.employee(companyId, id);
    hr.ensurePrefilled(companyId);
    const settings = c.getSettings(companyId);
    const month = p.periodStart.slice(0, 7);
    const last = ac.lastDayOfMonth(month);
    const first = `${month}-01`;
    const middle = `${month}-15`;
    const second = `${month}-16`;
    const kind = p.kind || 'regular';
    c.choice(kind, ['regular', 'advance', 'settlement'], 'Run kind');
    if (settings.payCycle === 'monthly' && (kind !== 'regular' || p.periodStart !== first || p.periodEnd !== last)) c.fail('Monthly policy requires one complete calendar month');
    if (settings.payCycle === 'twice_monthly_separate' && (kind !== 'regular' || !(p.periodStart === first && p.periodEnd === middle || p.periodStart === second && p.periodEnd === last))) c.fail('Separate periods must be days 1–15 or 16–month end');
    if (settings.payCycle === 'twice_monthly_advance' && !(kind === 'advance' && p.periodStart === first && p.periodEnd === middle || kind === 'settlement' && p.periodStart === first && p.periodEnd === last)) c.fail('Advance policy requires first-half advance or full-month settlement');
    if (kind === 'advance') {
      c.money(p.advanceMinor, 'Advance', 1);
      c.choice(p.currency, ['USD', 'KHR'], 'Advance currency');
    }
    const set = p.statutoryRateSetId ? c.scoped('statutory_rate_sets', companyId, p.statutoryRateSetId, 'Rate set') : null;
    const nextMonth = loanMath().addMonths(first, 1);
    const payDate = p.payDate || `${nextMonth.slice(0, 7)}-${String(settings.payday).padStart(2, '0')}`;
    c.date(payDate);
    const input = {
      ...p,
      statutoryOverride: statutoryOverride(p.statutoryOverride ?? null),
      payCycle: settings.payCycle
    };
    delete input.operationId;
    for (const k of ['taxRateKhrPerUsd', 'nssfRateKhrPerUsd', 'loanRateKhrPerUsd', 'rateSource', 'nssfRateSource', 'loanRateSource']) input[k] = p[k] ?? settings[k];
    for (const k of ['taxRateKhrPerUsd', 'nssfRateKhrPerUsd', 'loanRateKhrPerUsd']) if (input[k] != null && (typeof input[k] !== 'number' || !Number.isFinite(input[k]) || input[k] <= 0 || input[k] > 100000)) c.fail(`Explicit positive ${k} is required`);
    const id = uuid();
    getDb().prepare(`INSERT INTO payroll_runs (id,company_id,month,period_start,period_end,pay_date,kind,tax_rate_khr_per_usd,rate_source,statutory_rate_set_id,input_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, companyId, month, p.periodStart, p.periodEnd, payDate, kind, input.taxRateKhrPerUsd, input.rateSource, set?.id || null, JSON.stringify(input), Date.now());
    c.audit('payroll_run', id, 'create', {
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      employeeIds: p.employeeIds,
      kind
    });
    return get(companyId, id);
  });
}
function earlier(r, eid) {
  return getDb().prepare(`SELECT l.* FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE r.company_id=? AND r.month=? AND r.id<>? AND r.status IN ('approved','paid') AND l.active=1 AND l.employee_id=? ORDER BY r.period_start`).all(r.companyId, r.month, r.id, eid).map(x => ({
    line: line(x),
    run: get(r.companyId, x.run_id)
  }));
}
function context(r) {
  const summary = attendance.monthSummary(r.companyId, r.month, {
    withDays: true
  });
  const approvals = attendance.listOvertime(r.companyId, {
    month: r.month
  });
  const settings = c.getSettings(r.companyId);
  const leaveTypes = leave.listTypes(r.companyId).filter(t => t.tracksBalance);
  const staff = r.input.employeeIds.map(id => ({
    employee: c.employee(r.companyId, id),
    policy: c.getEmployeePolicy(r.companyId, id),
    leaveBalances: leaveTypes.map(t => ({
      leaveTypeId: t.id,
      code: t.code,
      nameEn: t.nameEn,
      nameKm: t.nameKm,
      days: leave.balanceOf(id, t.id, {
        asOf: r.periodEnd
      })
    })),
    rates: c.listPayRates(r.companyId, id),
    components: c.listEmployeeComponents(r.companyId, id),
    summary: summary.rows.find(x => x.employeeId === id),
    approvals: approvals.filter(x => x.employeeId === id),
    loans: loans.list(r.companyId, {
      employeeId: id,
      status: 'active'
    }).map(x => loans.get(r.companyId, x.id)),
    earlier: earlier(r, id)
  }));
  const rateSet = c.listRateSets(r.companyId).find(x => x.id === r.statutoryRateSetId) || null;
  const source = {
    configuration: c.signature(r.companyId),
    staff,
    settings,
    rateSet,
    components: c.listComponents(r.companyId),
    hrSettings: hr.getSettings(r.companyId)
  };
  return {
    ...source,
    fingerprint: c.hash(source)
  };
}
function aggregate(inputs) {
  const p = {
    ...inputs.at(-1),
    baseMinor: 0,
    lateDeductionMinor: 0,
    overtime: [],
    components: [],
    loanDeductionMinor: 0,
    advanceMinor: 0
  };
  const components = new Map();
  for (const i of inputs) {
    p.baseMinor = c.money(p.baseMinor + i.baseMinor);
    p.lateDeductionMinor = c.money(p.lateDeductionMinor + i.lateDeductionMinor);
    p.overtime.push(...i.overtime);
    for (const x of i.components) {
      const old = components.get(x.code);
      if (old && ['kind', 'taxable', 'nssfContributory', 'isFringeBenefit'].some(k => old[k] !== x[k])) c.fail('Monthly component tax treatment changed; review previous period');
      components.set(x.code, {
        ...x,
        amountMinor: c.money((old?.amountMinor || 0) + x.amountMinor)
      });
    }
  }
  p.components = [...components.values()];
  return p;
}
function computeLine(r, s, ctx, decisions = {}) {
  const employee = s.employee;
  const runOverride = r.input.statutoryOverride || null;
  const lineOverride = decisions.statutoryOverride || null;
  const policy = s.policy ? {
    ...s.policy
  } : null;
  // Override only these two flags; residency/dependents remain employee policy.
  for (const override of [runOverride, lineOverride]) {
    for (const key of ['applyTax', 'applyNssf']) {
      if (policy && override && Object.hasOwn(override, key)) policy[key] = override[key];
    }
  }
  const blockers = [];
  const block = (code, message, date = null) => blockers.push({
    code,
    message,
    ...(date ? {
      date
    } : {})
  });
  const snapshot = {
    employee: {
      id: employee.id,
      staffCode: employee.staffCode,
      nameEn: employee.nameEn,
      nameKm: employee.nameKm,
      bankName: employee.bankName,
      bankAccountName: employee.bankAccountName,
      bankAccountNo: employee.bankAccountNo,
      nssfNo: employee.nssfNo
    },
    employeePolicy: s.policy,
    runStatutoryOverride: runOverride,
    lineStatutoryOverride: lineOverride,
    effectivePolicy: policy,
    policy,
    leaveBalances: s.leaveBalances,
    leaveBalanceAsOf: r.periodEnd,
    settings: ctx.settings,
    rateSet: ctx.rateSet,
    loanPlans: [],
    estimate: true
  };
  let currency = s.rates.filter(x => x.effectiveFrom <= r.periodEnd).at(-1)?.currency || r.input.currency || 'USD';
  let result = Object.fromEntries(FIELDS.map(k => [k, 0]));
  result.items = [];
  result.currency = currency;
  const previous = s.earlier.filter(x => x.run.kind !== 'advance');
  const advances = s.earlier.filter(x => x.run.kind === 'advance');
  if (!s.policy) block('missing_policy', 'Set this employee’s tax, NSSF and residency policy.');
  if (!ctx.settings.policyConfirmed) block('policy_confirmation', 'Record professional policy evidence for pay frequency, deduction limits, lending, aggregation and FX.');
  if (!ctx.rateSet || ctx.rateSet.effectiveFrom > r.periodStart || ctx.rateSet.effectiveTo && ctx.rateSet.effectiveTo < r.periodEnd) block('statutory_coverage', 'Choose a statutory set covering the entire period.');
  if (previous.some(x => x.run.periodStart <= r.periodEnd && x.run.periodEnd >= r.periodStart)) block('overlap', 'An approved payroll already includes this employee and these earning dates.');
  if (r.kind === 'advance') {
    if (advances.length || previous.length) block('advance_overlap', 'An advance or settlement is already approved for this employee/month.');
    result.netMinor = r.input.advanceMinor;
    currency = r.input.currency;
    result.currency = currency;
    snapshot.advance = true;
    snapshot.estimate = ctx.rateSet?.status !== 'confirmed';
    return {
      result,
      snapshot,
      blockers,
      decisions
    };
  }
  if (r.input.payCycle === 'twice_monthly_separate' && r.periodStart.endsWith('-16') && !previous.some(x => x.run.periodStart === `${r.month}-01` && x.run.periodEnd === `${r.month}-15`)) block('first_period', 'Approve the first period before calculating the second period.');
  const all = s.summary?.days || [];
  const days = all.filter(x => x.date >= r.periodStart && x.date <= r.periodEnd);
  snapshot.days = days;
  snapshot.lateness = s.summary?.lateness || null;
  if (!days.length) block('missing_attendance', 'No attendance/schedule summary is available for this employee.');
  const resolve = hr.scheduleResolver(r.companyId);
  const fullMonthDates = [];
  for (let d = `${r.month}-01`; d <= ac.lastDayOfMonth(r.month); d = ac.addDays(d, 1)) fullMonthDates.push(d);
  const scheduled = fullMonthDates.filter(d => ac.isWorkDay(resolve(employee.id, d), d)).length;
  const divisor = ctx.settings.monthlyDivisor === 'fixed' ? ctx.settings.fixedDivisor : scheduled;
  if (!divisor) block('missing_divisor', 'Configure a work schedule or fixed monthly divisor.');
  const approvedByDate = new Map(s.approvals.map(a => [a.workDate, {
    ...a.minutes,
    rates: a.rates,
    needsReapproval: a.needsReapproval,
    id: a.id
  }]));
  const totals = ac.summarizeDays(days, {
    approvedByDate,
    settings: ctx.hrSettings
  });
  snapshot.totals = totals;
  for (const d of [...totals.approvalsExceedingAttendance, ...totals.approvalsNeedingReapproval]) block('stale_overtime', 'Review the stale overtime approval.', d);
  if (s.summary?.lateness?.needsReapproval) block('stale_lateness', 'Review the stale monthly lateness confirmation.');
  if (s.summary?.lateness?.exceedsAttendance) block('stale_lateness', 'Confirmed lateness exceeds current attendance; reconfirm it.');
  const rateFor = d => s.rates.filter(x => x.effectiveFrom <= d).at(-1);
  const groups = new Map();
  const payable = [];
  for (const d of days) {
    const rate = rateFor(d.date);
    const schedule = resolve(employee.id, d.date);
    if (!rate) {
      block('missing_pay_rate', 'Set a dated pay rate covering this date.', d.date);
      continue;
    }
    if (!schedule) {
      block('missing_schedule', 'Assign a work schedule.', d.date);
      continue;
    }
    if (rate.currency !== currency) {
      block('currency_change', 'Mixed salary currencies within one payroll period require separate reviewed treatment.', d.date);
      continue;
    }
    const employed = (!employee.hireDate || d.date >= employee.hireDate) && (!employee.endDate || d.date <= employee.endDate) && (!employee.leftOn || d.date <= employee.leftOn) && d.status !== 'not_employed';
    let approved = employed && d.status !== 'suspended' && (d.workedMin > 0 || d.workDay && (!!d.holiday?.paid || !!d.leave?.paid));
    const shiftMinutes = d.scheduled ? Math.round((d.scheduled.end - d.scheduled.start) / 60000) - (schedule.breakMin || 0) : 0;
    const partialDay = d.workedMin > 0 && d.workDay && d.workedMin < shiftMinutes;
    const anomaly = !!d.leave?.half || d.missingOut || d.oddEntries || d.status === 'suspended_with_events' || partialDay && (rate.basis === 'day' || d.lateMin === 0 && d.earlyLeaveMin === 0);
    const decision = decisions.dayDecisions?.find(x => x.date === d.date);
    if (anomaly) {
      if (!decision) block('whole_day_decision', 'Choose payable or unpaid as a whole day and give a reason.', d.date);else approved = decision.payable && employed;
    }
    if (d.status === 'future') block('future_attendance', 'This attendance day has not ended.', d.date);
    if (d.workDay && d.status === 'absent' && rate.basis === 'month') approved = false;
    if (approved) {
      payable.push(d);
      const g = groups.get(rate.id) || {
        rate,
        days: 0,
        minutes: 0
      };
      g.days += d.workDay || rate.basis !== 'month' ? 1 : 0;
      g.minutes += d.regularMin;
      groups.set(rate.id, g);
    }
  }
  let base = 0;
  snapshot.baseAllocations = [];
  for (const g of groups.values()) {
    const prior = previous.flatMap(x => x.line.snapshot.baseAllocations || []).filter(x => x.rateId === g.rate.id);
    const priorDays = prior.reduce((n, x) => n + x.days, 0);
    const priorMinutes = prior.reduce((n, x) => n + x.minutes, 0);
    const priorMinor = prior.reduce((n, x) => n + x.amountMinor, 0);
    const n = g.rate.basis === 'month' ? c.money(round(BigInt(g.rate.amountMinor) * BigInt(priorDays + g.days), BigInt(divisor || 1)) - priorMinor) : g.rate.basis === 'day' ? c.money(g.rate.amountMinor * g.days) : c.money(round(BigInt(g.rate.amountMinor) * BigInt(priorMinutes + g.minutes), 60n) - priorMinor);
    snapshot.baseAllocations.push({
      rateId: g.rate.id,
      days: g.days,
      minutes: g.minutes,
      amountMinor: n
    });
    base = c.money(base + n);
  }
  const hourly = d => {
    const rate = rateFor(d.date);
    const schedule = resolve(employee.id, d.date);
    if (!rate || !schedule) return 0;
    const mins = d.scheduled ? Math.round((d.scheduled.end - d.scheduled.start) / 60000) - (schedule.breakMin || 0) : 0;
    return rate.basis === 'hour' ? rate.amountMinor : round(BigInt(rate.amountMinor) * 60n, BigInt(Math.max(1, mins)) * (rate.basis === 'month' ? BigInt(divisor || 1) : 1n));
  };
  const overtime = [];
  for (const d of days) {
    const t = ac.summarizeDays([d], {
      approvedByDate,
      settings: ctx.hrSettings
    });
    for (const bucket of Object.values(t.overtimeApprovedByRate)) for (const [rate, minutes] of Object.entries(bucket)) overtime.push({
      minutes,
      ratePercent: Number(rate),
      hourlyMinor: hourly(d)
    });
  }
  // Monthly confirmed minutes are allocated chronologically, once. A second
  // separate period settles the monthly difference missed by an unconfirmed first.
  // Hourly wages already exclude missed minutes; unpaid whole days contain no
  // wages to deduct. Freeze included day/month wages for later-period settlement.
  snapshot.latenessWageDays = payable.filter(d => rateFor(d.date).basis !== 'hour').map(d => ({
    date: d.date,
    hourlyMinor: hourly(d)
  }));
  const latenessWages = new Map([...previous.flatMap(x => x.line.snapshot.latenessWageDays || []), ...snapshot.latenessWageDays].map(d => [d.date, d.hourlyMinor]));
  let late = 0;
  let lateRemaining = s.summary?.lateness?.deductibleLateMin || 0;
  let earlyRemaining = s.summary?.lateness?.deductibleEarlyLeaveMin || 0;
  const allocations = [];
  for (const d of all) {
    const minutes = Math.min(d.lateMin, lateRemaining) + Math.min(d.earlyLeaveMin, earlyRemaining);
    lateRemaining -= Math.min(d.lateMin, lateRemaining);
    earlyRemaining -= Math.min(d.earlyLeaveMin, earlyRemaining);
    if (minutes) {
      const amountMinor = round(BigInt(latenessWages.get(d.date) || 0) * BigInt(minutes), 60n);
      allocations.push({
        date: d.date,
        minutes,
        amountMinor
      });
      if (d.date >= r.periodStart && d.date <= r.periodEnd || r.input.payCycle === 'twice_monthly_separate' && r.periodEnd === ac.lastDayOfMonth(r.month)) late = c.money(late + amountMinor);
    }
  }
  if (r.input.payCycle === 'twice_monthly_separate' && r.periodEnd === ac.lastDayOfMonth(r.month)) late -= previous.reduce((n, x) => n + (x.line.snapshot.calculationInput?.lateDeductionMinor || 0), 0);
  if (late < 0) {
    block('lateness_reduction', 'Monthly confirmed deduction was reduced below frozen prior-period deductions.');
    late = 0;
  }
  snapshot.latenessAllocations = allocations;
  snapshot.payRates = s.rates;
  snapshot.monthlyDivisor = divisor;
  const components = [];
  snapshot.componentAllocations = [];
  for (const assignment of s.components) {
    const def = ctx.components.find(x => x.id === assignment.componentId);
    if (!def?.active) continue;
    const subset = payable.filter(d => d.date >= assignment.effectiveFrom && (!assignment.effectiveTo || d.date <= assignment.effectiveTo));
    if (!subset.length) continue;
    if (assignment.currency !== currency) {
      block('component_currency', 'Pay components must use the salary currency.');
      continue;
    }
    let amountMinor = assignment.amountMinor;
    if (def.calc === 'percent') {
      block('component_percent', 'Percentage component requires a defined basis; use an explicit fixed amount.');
      continue;
    }
    if (def.calc === 'per_day') amountMinor = c.money(amountMinor * subset.length);
    if (def.calc === 'per_hour') {
      const minutes = subset.reduce((n, d) => n + d.regularMin, 0);
      const prior = previous.flatMap(x => x.line.snapshot.componentAllocations || []).filter(x => x.assignmentId === assignment.id);
      const priorMinutes = prior.reduce((n, x) => n + x.minutes, 0);
      const priorMinor = prior.reduce((n, x) => n + x.amountMinor, 0);
      amountMinor = c.money(round(BigInt(amountMinor) * BigInt(priorMinutes + minutes), 60n) - priorMinor);
      snapshot.componentAllocations.push({
        assignmentId: assignment.id,
        minutes,
        amountMinor
      });
    }
    if (def.calc === 'fixed') {
      const eligible = fullMonthDates.filter(d => d >= assignment.effectiveFrom && (!assignment.effectiveTo || d <= assignment.effectiveTo));
      const period = eligible.filter(d => d >= r.periodStart && d <= r.periodEnd);
      // Difference of cumulative rounded allocations makes two periods sum exactly.
      const before = eligible.filter(d => d < r.periodStart).length;
      amountMinor = round(BigInt(amountMinor) * BigInt(before + period.length), BigInt(eligible.length)) - round(BigInt(amountMinor) * BigInt(before), BigInt(eligible.length));
    }
    const old = components.find(x => x.code === def.code);
    if (old) old.amountMinor = c.money(old.amountMinor + amountMinor);else components.push({
      code: def.code,
      label: def.nameEn,
      kind: def.kind,
      amountMinor,
      taxable: def.taxable,
      nssfContributory: def.nssfContributory,
      isFringeBenefit: def.isFringeBenefit
    });
  }
  let advanceMinor = 0;
  for (const a of advances) {
    if (a.line.currency !== currency) block('advance_currency', 'Advance and settlement currencies must match.');else advanceMinor = c.money(advanceMinor + a.line.paidMinor);
  }
  const input = {
    currency,
    baseMinor: base,
    overtime,
    lateDeductionMinor: late,
    components,
    applyNssf: policy?.applyNssf ?? false,
    applyTax: policy?.applyTax ?? false,
    taxResident: s.policy?.taxResident ?? true,
    spouseCount: s.policy?.spouseCount || 0,
    dependentCount: s.policy?.dependentCount || 0,
    loanDeductionMinor: 0,
    advanceMinor,
    ...(r.input.taxRateKhrPerUsd != null ? {
      taxRateKhrPerUsd: r.input.taxRateKhrPerUsd
    } : {}),
    ...(r.input.nssfRateKhrPerUsd != null ? {
      nssfRateKhrPerUsd: r.input.nssfRateKhrPerUsd
    } : {}),
    ...(ctx.rateSet ? {
      rateSet: ctx.rateSet
    } : {})
  };
  if (input.applyTax && currency === 'USD' && (!r.input.taxRateKhrPerUsd || !r.input.rateSource)) block('tax_fx', 'Save explicit salary-tax FX and source.');
  if (input.applyNssf && currency === 'USD' && (!r.input.nssfRateKhrPerUsd || !r.input.nssfRateSource)) block('nssf_fx', 'Save separately confirmed NSSF FX and source.');
  try {
    result = math().calculatePayrollLine(input);
    if (previous.length) {
      for (const x of previous) {
        const old = x.line.snapshot.calculationInput;
        if (!old || x.line.currency !== currency || c.hash(old.rateSet) !== c.hash(input.rateSet) || ['applyTax', 'applyNssf', 'taxResident', 'spouseCount', 'dependentCount', 'taxRateKhrPerUsd', 'nssfRateKhrPerUsd'].some(k => old[k] !== input[k])) c.fail('Monthly statutory policy/FX differs from the frozen first period');
      }
      const cumulative = math().calculatePayrollLine(aggregate([...previous.map(x => x.line.snapshot.calculationInput), input]));
      for (const k of ['nssfEmployeeMinor', 'nssfEmployerMinor', 'salaryTaxKhr', 'fringeTaxKhr', 'salaryTaxMinor']) result[k] = c.money(cumulative[k] - previous.reduce((n, x) => n + x.line[k], 0), `Incremental ${k}`);
      snapshot.cumulativeTaxBaseKhr = cumulative.taxBaseKhr;
      result.taxBaseKhr = c.money(cumulative.taxBaseKhr - previous.reduce((n, x) => n + x.line.taxBaseKhr, 0), 'Incremental tax base');
      result.items = result.items.filter(x => !x.code.startsWith('nssf_') && !['salary_tax', 'fringe_tax'].includes(x.code));
      for (const item of cumulative.items.filter(x => x.code.startsWith('nssf_') || ['salary_tax', 'fringe_tax'].includes(x.code))) {
        const prior = previous.reduce((n, x) => n + x.line.items.filter(i => i.code === item.code).reduce((v, i) => v + i.amountMinor, 0), 0);
        result.items.push({
          ...item,
          amountMinor: c.money(item.amountMinor - prior),
          amountKhr: item.amountKhr == null ? null : c.money(item.amountKhr - previous.reduce((n, x) => n + x.line.items.filter(i => i.code === item.code).reduce((v, i) => v + (i.amountKhr || 0), 0), 0))
        });
      }
      result.netMinor = c.money(result.grossMinor - result.otherDeductionsMinor - result.nssfEmployeeMinor - result.salaryTaxMinor - advanceMinor, 'Incremental take-home pay');
    }
    let available = result.netMinor;
    let deduction = 0;
    const recoveryBase = available;
    const companyCeiling = loanMath().deductionPlan({
      principalMinor: recoveryBase,
      interestMinor: 0,
      installmentMinor: recoveryBase,
      availableMinor: recoveryBase,
      maxDeductionPercent: ctx.settings.maxDeductionPercent
    }).amountMinor;
    const endMonth = r.periodEnd === ac.lastDayOfMonth(r.month);
    if (endMonth) for (const l of s.loans.filter(x => x.deductViaPayroll)) {
      const postponed = l.postponements.find(x => x.month === r.month);
      if (postponed) {
        snapshot.loanPlans.push({
          loanId: l.id,
          postponed: true,
          reason: postponed.reason,
          amountMinor: 0,
          salaryAmountMinor: 0,
          currency: l.currency
        });
        continue;
      }
      // Repayment eligibility follows actual payment, including salary earned
      // before disbursement. There is no interest to accrue before the loan exists.
      if (l.interestMethod !== 'none' && l.disbursedOn <= r.periodEnd && !l.entries.some(x => x.kind === 'interest' && x.period === r.month && !x.reversedAt)) block('loan_interest', 'Accrue this loan through the payroll month before approval.');
      const perLoanCeiling = loanMath().deductionPlan({
        principalMinor: recoveryBase,
        interestMinor: 0,
        installmentMinor: recoveryBase,
        availableMinor: recoveryBase,
        maxDeductionPercent: l.maxDeductionPercent
      }).amountMinor;
      const maximum = Math.min(available, perLoanCeiling, companyCeiling - deduction);
      const scheduledDebt = Math.min(l.installmentMinor, c.money(l.principalMinor + l.interestMinor));
      const cross = l.currency !== currency;
      const fx = r.input.loanRateKhrPerUsd;
      if (cross && (!fx || !r.input.loanRateSource)) {
        block('loan_fx', 'Save an explicit loan conversion rate and source.');
        continue;
      }
      let amountMinor = scheduledDebt;
      if (cross) {
        let lo = 0,
          hi = scheduledDebt;
        while (lo < hi) {
          const mid = lo + Math.ceil((hi - lo) / 2);
          if (salaryCostCeiling(mid, l.currency, currency, fx) <= maximum) lo = mid;else hi = mid - 1;
        }
        amountMinor = lo;
      } else amountMinor = Math.min(scheduledDebt, maximum);
      const decision = decisions.loanDecisions?.find(x => x.loanId === l.id);
      if (decision) {
        if (decision.amountMinor > amountMinor) block('loan_limit', 'Loan decision exceeds debt, available pay or confirmed deduction cap.');else amountMinor = decision.amountMinor;
      }
      let salaryAmountMinor = cross ? salaryCostCeiling(amountMinor, l.currency, currency, fx) : amountMinor;
      if (amountMinor > 0 && salaryAmountMinor === 0) {
        block('loan_fx_rounding', 'Loan repayment is smaller than one salary currency unit; choose a reviewed amount.');
        amountMinor = 0;
        salaryAmountMinor = 0;
      }
      if (amountMinor < scheduledDebt && !decision) block('loan_shortfall', 'Approve a loan repayment shortfall with a reason or postpone the instalment.');
      const allocation = loanMath().allocateRepayment({
        principalMinor: l.principalMinor,
        interestMinor: l.interestMinor,
        amountMinor
      });
      snapshot.loanPlans.push({
        loanId: l.id,
        currency: l.currency,
        amountMinor,
        salaryAmountMinor,
        principalMinor: l.principalMinor,
        interestMinor: l.interestMinor,
        principalPaidMinor: allocation.principalPaidMinor,
        interestPaidMinor: allocation.interestPaidMinor,
        loanRateKhrPerUsd: cross ? fx : null,
        loanRateSource: cross ? r.input.loanRateSource : null,
        reason: decision?.reason || null,
        shortfallMinor: scheduledDebt - amountMinor
      });
      available = c.money(available - salaryAmountMinor);
      deduction = c.money(deduction + salaryAmountMinor);
    }
    result.loanDeductionMinor = deduction;
    result.netMinor = available;
    result.items = result.items.filter(x => x.code !== 'loan');
    result.items.push({
      code: 'loan',
      label: 'Loan repayment',
      kind: 'deduction',
      amountMinor: deduction
    });
    input.loanDeductionMinor = deduction;
  } catch (error) {
    block('calculation', error.message);
  }
  snapshot.calculationInput = input;
  snapshot.estimate = result.estimate ?? true;
  snapshot.rateSource = r.input.rateSource;
  snapshot.nssfRateSource = r.input.nssfRateSource;
  snapshot.loanRateSource = r.input.loanRateSource;
  return {
    result,
    snapshot,
    blockers,
    decisions
  };
}
function calculate(companyId, id) {
  return getDb().transaction(() => {
    const r = get(companyId, id);
    mutable(r);
    const ctx = context(r);
    const prev = new Map(r.lines.map(x => [x.employeeId, x.decisions]));
    getDb().prepare('UPDATE payroll_lines SET active=0 WHERE run_id=? AND active=1').run(id);
    for (const s of ctx.staff) {
      const computed = computeLine(r, s, ctx, prev.get(s.employee.id) || {});
      const key = uuid();
      const columns = FIELDS.map(snake);
      getDb().prepare(`INSERT INTO payroll_lines (id,company_id,run_id,employee_id,currency,${columns.join(',')},snapshot,blockers_json,decisions_json,created_at) VALUES (${Array(5 + FIELDS.length + 4).fill('?').join(',')})`).run(key, companyId, id, s.employee.id, computed.result.currency, ...FIELDS.map(k => c.money(computed.result[k] || 0, k)), JSON.stringify(computed.snapshot), JSON.stringify(computed.blockers), JSON.stringify(computed.decisions), Date.now());
      for (const item of computed.result.items || []) getDb().prepare('INSERT INTO payroll_line_items VALUES (?,?,?,?,?,?,?,?,?)').run(uuid(), key, item.code, item.label, item.kind, c.money(item.amountMinor), item.amountKhr == null ? null : c.money(item.amountKhr), item.baseKhr == null ? null : c.money(item.baseKhr), Date.now());
    }
    getDb().prepare("UPDATE payroll_runs SET status='draft',revision=revision+1,source_hash=? WHERE id=?").run(ctx.fingerprint, id);
    c.audit('payroll_run', id, 'calculate', {
      revision: r.revision + 1
    });
    return get(companyId, id);
  })();
}
function updateLine(companyId, p) {
  return getDb().transaction(() => {
    const row = c.scoped('payroll_lines', companyId, p.id, 'Payroll line');
    const r = get(companyId, row.run_id);
    mutable(r);
    revision(r, p.expectedRevision);
    if (!row.active) c.fail('Payroll line was superseded');
    const patch = {
      ...p.patch
    };
    for (const k of Object.keys(patch)) if (!['dayDecisions', 'loanDecisions', 'note', 'statutoryOverride'].includes(k)) c.fail(`Unsupported payroll override ${k}`);
    if (Object.hasOwn(patch, 'statutoryOverride')) patch.statutoryOverride = statutoryOverride(patch.statutoryOverride);
    for (const d of patch.dayDecisions || []) {
      c.date(d.date);
      c.bool(d.payable, 'Payable day');
      c.text(d.reason, 'Whole-day decision reason');
      if (d.date < r.periodStart || d.date > r.periodEnd) c.fail('Day decision is outside the period');
    }
    if (patch.dayDecisions && new Set(patch.dayDecisions.map(x => x.date)).size !== patch.dayDecisions.length) c.fail('Duplicate day decisions');
    for (const d of patch.loanDecisions || []) {
      const l = loans.get(companyId, d.loanId);
      if (l.employeeId !== row.employee_id) c.fail('Loan belongs to another staff member');
      c.money(d.amountMinor, 'Loan-currency decision amount');
      c.text(d.reason, 'Loan shortfall reason');
    }
    if (patch.loanDecisions && new Set(patch.loanDecisions.map(x => x.loanId)).size !== patch.loanDecisions.length) c.fail('Duplicate loan decisions');
    const decisions = {
      ...JSON.parse(row.decisions_json),
      ...patch
    };
    getDb().prepare('UPDATE payroll_lines SET decisions_json=? WHERE id=?').run(JSON.stringify(decisions), p.id);
    return calculate(companyId, r.id);
  })();
}
function validateReview(r, ctx) {
  if (!r.lines.length) c.fail('Calculate payroll before review');
  if (ctx.fingerprint !== r.sourceHash) c.fail('Payroll sources changed; calculation is stale. Recalculate and review.');
  const blocks = ctx.staff.flatMap(s => computeLine(r, s, ctx, r.lines.find(x => x.employeeId === s.employee.id)?.decisions || {}).blockers);
  if (blocks.length) c.fail(`Payroll requires review: ${blocks.map(x => x.message).join(' ')}`);
}
function review(companyId, p) {
  return getDb().transaction(() => {
    const r = get(companyId, p.id);
    mutable(r);
    revision(r, p.expectedRevision);
    const ctx = context(r);
    validateReview(r, ctx);
    const next = r.revision + 1;
    getDb().prepare('INSERT INTO payroll_reviews VALUES (?,?,?,?,?,?,?,?)').run(uuid(), companyId, r.id, next, ctx.fingerprint, '[]', getCallerUserId(), Date.now());
    getDb().prepare("UPDATE payroll_runs SET status='reviewed',revision=? WHERE id=?").run(next, r.id);
    c.audit('payroll_run', r.id, 'review', {
      revision: next
    });
    return get(companyId, r.id);
  })();
}
function approve(companyId, p) {
  return getDb().transaction(() => {
    const r = get(companyId, p.id);
    revision(r, p.expectedRevision);
    if (r.status === 'approved' || r.status === 'paid') return r;
    if (r.status !== 'reviewed') c.fail('Review payroll before approval');
    const ctx = context(r);
    validateReview(r, ctx);
    if (!ctx.settings.policyConfirmed) c.fail('Professional policy confirmation is required');
    if (ctx.rateSet?.status !== 'confirmed' || !ctx.rateSet.sourceNote || !ctx.rateSet.confirmedAt) c.fail('Confirmed effective statutory tables are required, even for tax/NSSF exemptions');
    getDb().prepare("UPDATE payroll_runs SET status='approved',approved_at=?,approved_by_user_id=? WHERE id=?").run(Date.now(), getCallerUserId(), r.id);
    c.audit('payroll_run', r.id, 'approve', {
      revision: r.revision
    });
    return get(companyId, r.id);
  })();
}
function reconcileStatus(companyId, runId) {
  const r = get(companyId, runId);
  if (!['approved', 'paid'].includes(r.status)) return;
  getDb().prepare('UPDATE payroll_runs SET status=? WHERE id=?').run(r.lines.every(x => x.remainingMinor === 0 && x.remainingLoanDeductionMinor === 0) ? 'paid' : 'approved', runId);
}
function pay(companyId, p) {
  return c.operation(companyId, p.operationId, 'payroll:pay', p, () => {
    const row = c.scoped('payroll_lines', companyId, p.id, 'Payroll line');
    const l = line(row);
    const r = get(companyId, l.runId);
    if (!row.active || !['approved', 'paid'].includes(r.status)) c.fail('Only approved payroll can be paid');
    c.money(p.amountMinor, 'Payment');
    c.choice(p.method, ['cash', 'bank', 'other'], 'Payment method');
    c.date(p.paidAt);
    if (p.paidAt > ac.ppDate(Date.now()) || p.paidAt < r.periodStart) c.fail('Payment date must be within or after its period and not in the future');
    if (p.amountMinor > l.remainingMinor) c.fail('Payment exceeds remaining take-home pay');
    const siblings = earlier(r, l.employeeId);
    if (r.kind === 'advance' && siblings.some(x => x.run.kind === 'settlement')) c.fail('Advance is frozen after settlement approval');
    const key = uuid();
    getDb().prepare('INSERT INTO payroll_payments VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(key, companyId, l.id, p.amountMinor, p.paidAt, p.method, p.reference || null, null, null, getCallerUserId(), Date.now());
    const posted = getDb().prepare(`SELECT e.id FROM loan_entries e WHERE e.payroll_line_id=? AND e.kind='repayment' AND NOT EXISTS (SELECT 1 FROM loan_entries rev WHERE rev.reverses_entry_id=e.id)`).all(l.id);
    if (!posted.length) for (const plan of l.snapshot.loanPlans || []) {
      if (!plan.amountMinor) continue;
      const current = loans.get(companyId, plan.loanId);
      if (current.principalMinor !== plan.principalMinor || current.interestMinor !== plan.interestMinor) c.fail('Loan balance changed after approval; review the frozen repayment before payment');
      loans.postRepayment(companyId, {
        id: plan.loanId,
        amountMinor: plan.amountMinor,
        entryDate: p.paidAt,
        source: 'payroll',
        note: plan.reason
      }, {
        paymentId: key,
        payrollLineId: l.id
      });
    }
    if (p.amountMinor === 0 && (!l.loanDeductionMinor || posted.length)) c.fail('A zero cash payment must post an outstanding loan deduction');
    c.audit('payroll_payment', key, 'pay', p);
    reconcileStatus(companyId, l.runId);
    return payment(c.scoped('payroll_payments', companyId, key, 'Payment'));
  });
}
function reversePayment(companyId, p) {
  return c.operation(companyId, p.operationId, 'payroll:reverse_payment', p, () => {
    const old = c.scoped('payroll_payments', companyId, p.id, 'Payment');
    c.text(p.reason, 'Payment reversal reason');
    if (old.reverses_payment_id) c.fail('Cannot reverse a reversal');
    const l = line(c.scoped('payroll_lines', companyId, old.line_id, 'Payroll line'));
    const r = get(companyId, l.runId);
    if (r.status === 'void') c.fail('Voided payroll is frozen');
    if (r.kind === 'advance' && earlier(r, l.employeeId).some(x => x.run.kind === 'settlement')) c.fail('Void the dependent settlement before reversing its advance');
    const prior = getDb().prepare('SELECT * FROM payroll_payments WHERE reverses_payment_id=?').get(old.id);
    if (prior) return payment(prior);
    const linked = getDb().prepare("SELECT id FROM loan_entries WHERE payment_id=? AND kind='repayment' ORDER BY rowid DESC").all(old.id);
    if (linked.length) {
      const later = getDb().prepare(`SELECT p.id FROM payroll_payments p
        WHERE p.line_id=? AND p.rowid>(SELECT rowid FROM payroll_payments WHERE id=?)
          AND p.reverses_payment_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM payroll_payments rev WHERE rev.reverses_payment_id=p.id)
        LIMIT 1`).get(l.id, old.id);
      if (later) c.fail('Reverse subsequent cash payments for this line before reversing its loan-linked payment');
    }
    for (const e of linked) loans.reverse(companyId, {
      id: e.id,
      reason: p.reason
    }, {
      payroll: true
    });
    const id = uuid();
    getDb().prepare('INSERT INTO payroll_payments VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, companyId, l.id, -old.amount_minor, ac.ppDate(Date.now()), old.method, old.reference, old.id, p.reason, getCallerUserId(), Date.now());
    c.audit('payroll_payment', id, 'reverse', p);
    reconcileStatus(companyId, l.runId);
    return payment(c.scoped('payroll_payments', companyId, id, 'Payment'));
  });
}
function voidRun(companyId, p) {
  return getDb().transaction(() => {
    const r = get(companyId, p.id);
    c.text(p.reason, 'Void reason');
    if (r.status === 'void') return r;
    if (r.payments.some(x => !x.reversesPaymentId && !r.payments.some(y => y.reversesPaymentId === x.id))) c.fail('Reverse every payment before voiding payroll');
    if (r.lines.some(l => earlier(r, l.employeeId).some(x => x.run.kind !== 'advance' && x.run.periodStart > r.periodEnd))) c.fail('Void the dependent later statutory period first');
    getDb().prepare("UPDATE payroll_runs SET status='void',void_reason=?,voided_at=? WHERE id=?").run(p.reason, Date.now(), r.id);
    c.audit('payroll_run', r.id, 'void', p);
    return get(companyId, r.id);
  })();
}
module.exports = {
  list,
  get,
  create,
  calculate,
  updateLine,
  review,
  approve,
  pay,
  reversePayment,
  voidRun
};
