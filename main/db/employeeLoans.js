const {
  getDb
} = require('./index');
const c = require('./payrollConfig');
const {
  uuid,
  getCallerUserId
} = require('./_fuelUtil');
const calc = () => require('../util/loanCalc');
const today = () => require('../util/attendanceCalc').ppDate(Date.now());
const MAX_CALCULATION_MONTHS = 600; // Technical resource bound, not lending policy.
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function entry(r) {
  return {
    id: r.id,
    companyId: r.company_id,
    loanId: r.loan_id,
    entryDate: r.entry_date,
    kind: r.kind,
    amountMinor: r.amount_minor,
    principalPart: r.principal_part,
    interestPart: r.interest_part,
    source: r.source,
    payrollLineId: r.payroll_line_id,
    paymentId: r.payment_id,
    reversesEntryId: r.reverses_entry_id,
    period: r.period,
    note: r.note,
    snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
    reversedAt: r.reversed_at
  };
}
function entries(companyId, id) {
  return getDb().prepare('SELECT * FROM loan_entries WHERE company_id=? AND loan_id=? ORDER BY entry_date,created_at,rowid').all(companyId, id).map(entry);
}
function effectiveEntries(all) {
  const reversed = new Set(all.filter(e => e.kind === 'reversal').map(e => e.reversesEntryId));
  return all.filter(e => e.kind !== 'reversal' && !reversed.has(e.id));
}
function balance(es, part) {
  // Signed history can temporarily exceed Number's safe range even when the
  // final balance is safe. Cancel reversals exactly before validating the total.
  return c.money(Number(es.reduce((sum, e) => sum + BigInt(e[part]), 0n)), part === 'principalPart' ? 'Principal balance' : 'Interest balance');
}
function loan(r, details = true) {
  const es = entries(r.company_id, r.id);
  const principalMinor = balance(es, 'principalPart');
  const interestMinor = balance(es, 'interestPart');
  c.money(principalMinor + interestMinor, 'Total debt');
  return {
    id: r.id,
    companyId: r.company_id,
    employeeId: r.employee_id,
    loanNo: r.loan_no,
    originalPrincipalMinor: r.original_principal_minor,
    principalMinor,
    interestMinor,
    currency: r.currency,
    disbursedOn: r.disbursed_on,
    interestMethod: r.interest_method,
    interestPolicy: r.interest_policy,
    interestFreeMonths: r.interest_free_months,
    installmentMinor: r.installment_minor,
    maxDeductionPercent: r.max_deduction_percent,
    deductViaPayroll: !!r.deduct_via_payroll,
    status: r.status,
    purpose: r.purpose,
    approvedAt: r.approved_at,
    ...(details ? {
      entries: es,
      rates: getDb().prepare('SELECT * FROM loan_rate_changes WHERE company_id=? AND loan_id=? ORDER BY effective_from').all(r.company_id, r.id).map(x => ({
        id: x.id,
        effectiveFrom: x.effective_from,
        ratePercent: x.rate_pct,
        reason: x.reason
      })),
      postponements: getDb().prepare('SELECT month,reason FROM loan_postponements WHERE company_id=? AND loan_id=? ORDER BY month').all(r.company_id, r.id)
    } : {})
  };
}
function get(companyId, id) {
  return loan(c.scoped('employee_loans', companyId, id, 'Loan'));
}
function list(companyId, {
  employeeId = null,
  status = null
} = {}) {
  c.company(companyId);
  if (employeeId) c.employee(companyId, employeeId);
  if (status) c.choice(status, ['draft', 'active', 'paid', 'written_off', 'void'], 'Loan status');
  return getDb().prepare('SELECT * FROM employee_loans WHERE company_id=? AND (? IS NULL OR employee_id=?) AND (? IS NULL OR status=?) ORDER BY disbursed_on,id').all(companyId, employeeId, employeeId, status, status).map(r => loan(r, false));
}
function create(companyId, p) {
  return c.operation(companyId, p.operationId, 'loan:create', p, () => {
    c.employee(companyId, p.employeeId);
    c.money(p.principalMinor, 'Principal', 1);
    c.date(p.disbursedOn);
    if (p.disbursedOn > today()) c.fail('Future disbursement is not supported');
    c.choice(p.currency, ['USD', 'KHR'], 'Currency');
    c.choice(p.interestMethod, ['declining', 'none'], 'Interest method');
    c.choice(p.interestPolicy, ['separate', 'capitalize'], 'Interest policy');
    c.percent(p.ratePercent, 'Monthly rate');
    if (p.interestMethod === 'none' && p.ratePercent !== 0) c.fail('Interest-free loan must have zero rate');
    c.money(p.interestFreeMonths, 'Free months');
    if (p.interestFreeMonths > 120) c.fail('Free months must be at most 120');
    c.money(p.installmentMinor, 'Installment', 1);
    const settings = c.getSettings(companyId);
    const cap = p.maxDeductionPercent ?? settings.maxDeductionPercent;
    c.percent(cap);
    if (p.deductViaPayroll != null) c.bool(p.deductViaPayroll, 'Payroll deduction');
    const id = uuid();
    const loanNo = p.loanNo ? c.text(p.loanNo, 'Loan number') : id;
    const now = Date.now();
    getDb().prepare('INSERT INTO employee_loans VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, companyId, p.employeeId, loanNo, p.principalMinor, p.currency, p.disbursedOn, p.interestMethod, p.interestPolicy, p.interestFreeMonths, p.installmentMinor, cap, +(p.deductViaPayroll ?? true), 'draft', p.purpose || null, null, null, now);
    getDb().prepare('INSERT INTO loan_rate_changes VALUES (?,?,?,?,?,?,?,?)').run(uuid(), companyId, id, p.disbursedOn, p.ratePercent, 'Starting agreed rate', getCallerUserId(), now);
    c.audit('employee_loan', id, 'create', p);
    return get(companyId, id);
  });
}
function post(companyId, id, {
  entryDate,
  kind,
  principalPart = 0,
  interestPart = 0,
  source = 'cash',
  payrollLineId = null,
  paymentId = null,
  reversesEntryId = null,
  period = null,
  note = null,
  snapshot = null
}) {
  const key = uuid();
  const amount = principalPart + interestPart;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(principalPart) || !Number.isSafeInteger(interestPart)) c.fail('Unsafe loan posting');
  getDb().prepare('INSERT INTO loan_entries (id,company_id,loan_id,entry_date,kind,amount_minor,principal_part,interest_part,source,payroll_line_id,payment_id,reverses_entry_id,period,note,snapshot,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key, companyId, id, entryDate, kind, amount, principalPart, interestPart, source, payrollLineId, paymentId, reversesEntryId, period, note, snapshot ? JSON.stringify(snapshot) : null, getCallerUserId(), Date.now());
  c.audit('loan_entry', key, kind, {
    loanId: id,
    entryDate,
    amountMinor: amount,
    principalPart,
    interestPart,
    source,
    reversesEntryId
  });
  return entry(c.scoped('loan_entries', companyId, key, 'Loan entry'));
}
function sync(companyId, id) {
  const l = get(companyId, id);
  if (l.status === 'void' || l.status === 'written_off') return;
  getDb().prepare('UPDATE employee_loans SET status=? WHERE id=?').run(l.principalMinor + l.interestMinor === 0 ? 'paid' : 'active', id);
}
function lendingPolicy(companyId, l) {
  if (l.interestPolicy === 'capitalize' && !c.getSettings(companyId).policyConfirmed) c.fail('Confirmed professional lending/capitalization policy evidence is required');
}
function approve(companyId, id) {
  return getDb().transaction(() => {
    const l = get(companyId, id);
    if (l.status !== 'draft') return l;
    lendingPolicy(companyId, l);
    post(companyId, id, {
      entryDate: l.disbursedOn,
      kind: 'disbursement',
      principalPart: l.originalPrincipalMinor
    });
    getDb().prepare("UPDATE employee_loans SET status='active',approved_at=?,approved_by_user_id=? WHERE id=?").run(Date.now(), getCallerUserId(), id);
    return get(companyId, id);
  })();
}
function boundary(l, date, {
  rate = false
} = {}) {
  c.date(date);
  if (date < l.disbursedOn) c.fail('Date is before disbursement');
  if (!rate && date > today()) c.fail('Future financial postings are not supported');
  const active = effectiveEntries(l.entries);
  const through = active.filter(e => e.kind === 'interest').at(-1)?.entryDate;
  if (through && date <= through) c.fail('Backdated change crosses a posted interest boundary; reverse later history first');
  if (!rate && active.some(e => e.entryDate > date)) c.fail('Backdated posting crosses later financial history');
}
function changeRate(companyId, p) {
  return c.operation(companyId, p.operationId, 'loan:rate', p, () => {
    const l = get(companyId, p.id);
    if (!['draft', 'active'].includes(l.status)) c.fail('Loan is frozen');
    c.percent(p.ratePercent);
    c.text(p.reason, 'Rate-change reason');
    boundary(l, p.effectiveFrom, {
      rate: true
    });
    if (l.interestMethod === 'none' && p.ratePercent !== 0) c.fail('Interest-free loan cannot gain interest');
    getDb().prepare('INSERT INTO loan_rate_changes VALUES (?,?,?,?,?,?,?,?)').run(uuid(), companyId, l.id, p.effectiveFrom, p.ratePercent, p.reason, getCallerUserId(), Date.now());
    c.audit('employee_loan', l.id, 'rate_change', p);
    return get(companyId, l.id);
  });
}
// Split only when the interest base or monthly rate actually changes. Zero-money
// ledger rows and identical rates must not add rounding boundaries.
function calculationHorizon(l, through) {
  c.date(through);
  if (through < l.disbursedOn) c.fail('Interest end precedes disbursement');
  const monthNumber = d => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  if (monthNumber(through) - monthNumber(l.disbursedOn) + 1 > MAX_CALCULATION_MONTHS) {
    c.fail(`Calculation horizon may cover at most ${MAX_CALCULATION_MONTHS} months from disbursement`);
  }
}
function projectedInterest(l, through) {
  calculationHorizon(l, through);
  c.date(through);
  if (through < l.disbursedOn) c.fail('Interest end precedes disbursement');
  if (through !== require('../util/attendanceCalc').lastDayOfMonth(through.slice(0, 7))) c.fail('Accrue only complete calendar months');
  const math = calc();
  const free = math.addMonths(l.disbursedOn, l.interestFreeMonths);
  const active = effectiveEntries(l.entries);
  const simulated = [...active];
  const out = [];
  for (const period of math.monthlyPeriods(l.disbursedOn, through)) {
    const key = period.startDate.slice(0, 7);
    if (active.some(e => e.kind === 'interest' && e.period === key)) continue;
    const last = require('../util/attendanceCalc').lastDayOfMonth(key);
    if (period.endDate !== last) c.fail('Accrue only complete calendar months');
    let start = period.startDate;
    let principal = balance(simulated.filter(e => e.entryDate <= start), 'principalPart');
    let rate = l.rates.filter(r => r.effectiveFrom <= start).at(-1)?.ratePercent ?? 0;
    let interest = 0;
    const slices = [];
    const points = [...new Set([...simulated.filter(e => e.principalPart !== 0 && e.entryDate > start && e.entryDate <= period.endDate).map(e => e.entryDate), ...l.rates.filter(r => r.effectiveFrom > start && r.effectiveFrom <= period.endDate).map(r => r.effectiveFrom), shift(period.endDate, 1)])].sort();
    for (const point of points) {
      const nextPrincipal = balance(simulated.filter(e => e.entryDate <= point), 'principalPart');
      const nextRate = l.rates.filter(r => r.effectiveFrom <= point).at(-1)?.ratePercent ?? 0;
      if (point <= period.endDate && nextPrincipal === principal && nextRate === rate) continue;
      const endDate = shift(point, -1);
      const piece = math.interestForPeriod({
        principalMinor: c.money(principal),
        annualized: false,
        ratePercent: l.interestMethod === 'none' ? 0 : rate,
        startDate: start,
        endDate,
        interestFreeUntil: free
      });
      interest = c.money(interest + piece.interestMinor, 'Accrued interest');
      slices.push({
        startDate: start,
        endDate,
        principalMinor: principal,
        ratePercent: rate,
        ...piece
      });
      start = point;
      principal = nextPrincipal;
      rate = nextRate;
    }
    const e = {
      entryDate: period.endDate,
      kind: 'interest',
      principalPart: 0,
      interestPart: interest,
      period: key,
      snapshot: {
        interestFreeUntil: free,
        slices
      }
    };
    out.push(e);
    simulated.push(e);
    if (l.interestPolicy === 'capitalize') {
      const asOf = simulated.filter(e => e.entryDate <= period.endDate);
      const pp = balance(asOf, 'principalPart');
      const ip = balance(asOf, 'interestPart');
      if (ip > 0) {
        const cap = math.capitalizeInterest({
          principalMinor: pp,
          interestMinor: ip
        });
        const transfer = {
          entryDate: period.endDate,
          kind: 'capitalization',
          principalPart: cap.principalMinor - pp,
          interestPart: -ip,
          period: key
        };
        out.push(transfer);
        simulated.push(transfer);
      }
    }
  }
  return out;
}
function accrue(companyId, p) {
  return c.operation(companyId, p.operationId, 'loan:accrue', p, () => {
    const l = get(companyId, p.id);
    if (!['active', 'paid'].includes(l.status)) c.fail('Loan must be approved before accrual');
    lendingPolicy(companyId, l);
    calculationHorizon(l, p.through);
    if (p.through > today()) c.fail('Future interest posting is not supported');
    for (const x of projectedInterest(l, p.through)) post(companyId, l.id, {
      ...x,
      source: 'system'
    });
    sync(companyId, l.id);
    return get(companyId, l.id);
  });
}
function repay(companyId, p) {
  return c.operation(companyId, p.operationId, 'loan:repay', p, () => {
    if (p.source === 'payroll') c.fail('Payroll repayments must be posted atomically by the payroll payment service');
    return postRepayment(companyId, p);
  });
}
function postRepayment(companyId, p, {
  paymentId = null,
  payrollLineId = null
} = {}) {
  const l = get(companyId, p.id);
  if (l.status !== 'active') c.fail('Loan is not active');
  c.money(p.amountMinor, 'Repayment', 1);
  c.choice(p.source, ['cash', 'bank', 'payroll'], 'Repayment source');
  boundary(l, p.entryDate);
  const a = calc().allocateRepayment({
    principalMinor: l.principalMinor,
    interestMinor: l.interestMinor,
    amountMinor: p.amountMinor
  });
  const e = post(companyId, l.id, {
    entryDate: p.entryDate,
    kind: 'repayment',
    principalPart: -a.principalPaidMinor,
    interestPart: -a.interestPaidMinor,
    source: p.source,
    paymentId,
    payrollLineId,
    note: p.note || null
  });
  sync(companyId, l.id);
  return e;
}
function postpone(companyId, p) {
  return c.operation(companyId, p.operationId, 'loan:postpone', p, () => {
    const l = get(companyId, p.id);
    if (l.status !== 'active') c.fail('Loan is not active');
    c.date(`${p.month}-01`, 'Month');
    c.text(p.reason, 'Postponement reason');
    const old = l.postponements.find(x => x.month === p.month);
    if (old) {
      if (old.reason !== p.reason) c.fail('Postponement already approved with another reason');
      return l;
    }
    getDb().prepare('INSERT INTO loan_postponements VALUES (?,?,?,?,?,?,?)').run(uuid(), companyId, l.id, p.month, p.reason, getCallerUserId(), Date.now());
    c.audit('employee_loan', l.id, 'postpone', p);
    return get(companyId, l.id);
  });
}
function reverse(companyId, p, {
  payroll = false
} = {}) {
  const r = c.scoped('loan_entries', companyId, p.id, 'Loan entry');
  const e = entry(r);
  c.text(p.reason, 'Reversal reason');
  if (e.kind === 'reversal') c.fail('Cannot reverse a reversal');
  if (e.paymentId && !payroll) c.fail('Reverse the linked payroll payment instead');
  const old = getDb().prepare('SELECT * FROM loan_entries WHERE reverses_entry_id=?').get(e.id);
  if (old) return entry(old);
  const l = get(companyId, e.loanId);
  const later = getDb().prepare('SELECT x.id FROM loan_entries x WHERE x.loan_id=? AND x.rowid>(SELECT rowid FROM loan_entries WHERE id=?) AND x.kind<>? AND NOT EXISTS (SELECT 1 FROM loan_entries rev WHERE rev.reverses_entry_id=x.id) LIMIT 1').get(l.id, e.id, 'reversal');
  if (later) c.fail('Reverse later loan entries first; prior interest cannot be rewritten');
  const principal = l.principalMinor - e.principalPart;
  const interest = l.interestMinor - e.interestPart;
  c.money(principal, 'Reversal principal');
  c.money(interest, 'Reversal interest');
  const result = post(companyId, l.id, {
    entryDate: today(),
    kind: 'reversal',
    principalPart: -e.principalPart,
    interestPart: -e.interestPart,
    source: e.source,
    reversesEntryId: e.id,
    paymentId: e.paymentId,
    payrollLineId: e.payrollLineId,
    note: p.reason
  });
  getDb().prepare('UPDATE loan_entries SET reversed_at=? WHERE id=?').run(Date.now(), e.id);
  if (e.kind === 'disbursement') getDb().prepare("UPDATE employee_loans SET status='void' WHERE id=?").run(l.id);else {
    getDb().prepare("UPDATE employee_loans SET status='active' WHERE id=?").run(l.id);
    sync(companyId, l.id);
  }
  return result;
}
function reverseEntry(companyId, p) {
  return c.operation(companyId, p.operationId, 'loan:reverse', p, () => reverse(companyId, p));
}
function writeOff(companyId, p) {
  return c.operation(companyId, p.operationId, 'loan:write_off', p, () => {
    const l = get(companyId, p.id);
    if (l.status !== 'active') c.fail('Loan is not active');
    c.text(p.reason, 'Write-off reason');
    boundary(l, p.entryDate);
    post(companyId, l.id, {
      entryDate: p.entryDate,
      kind: 'write_off',
      principalPart: -l.principalMinor,
      interestPart: -l.interestMinor,
      note: p.reason
    });
    getDb().prepare("UPDATE employee_loans SET status='written_off' WHERE id=?").run(l.id);
    return get(companyId, l.id);
  });
}
function project(companyId, id, {
  through
} = {}) {
  const l = get(companyId, id);
  if (l.status === 'draft') c.fail('Approve the loan before projection');
  calculationHorizon(l, through);
  const forecast = [];
  const simulated = {
    ...l,
    entries: effectiveEntries(l.entries)
  };
  for (const period of calc().monthlyPeriods(l.disbursedOn, through)) {
    if (period.endDate !== require('../util/attendanceCalc').lastDayOfMonth(period.startDate.slice(0, 7))) c.fail('Projection must end at a calendar month end');
    const interest = projectedInterest(simulated, period.endDate);
    forecast.push(...interest);
    simulated.entries.push(...interest);
    if (period.endDate < today() || l.postponements.some(p => p.month === period.startDate.slice(0, 7))) continue;
    const asOf = simulated.entries.filter(e => e.entryDate <= period.endDate);
    const principalMinor = balance(asOf, 'principalPart');
    const interestMinor = balance(asOf, 'interestPart');
    const amountMinor = Math.min(l.installmentMinor, c.money(principalMinor + interestMinor));
    if (amountMinor) {
      const paid = calc().allocateRepayment({
        principalMinor,
        interestMinor,
        amountMinor
      });
      const e = {
        entryDate: period.endDate,
        kind: 'repayment',
        amountMinor: -amountMinor,
        principalPart: -paid.principalPaidMinor,
        interestPart: -paid.interestPaidMinor,
        forecast: true
      };
      forecast.push(e);
      simulated.entries.push(e);
    }
  }
  return {
    loanId: id,
    currency: l.currency,
    entries: forecast,
    principalMinor: balance(simulated.entries, 'principalPart'),
    interestMinor: balance(simulated.entries, 'interestPart'),
    estimate: true,
    note: 'Forecast accrues unpaid historic months and assumes future month-end instalments are paid in full; no ledger entries are posted.'
  };
}
function voidDraft(companyId, input) {
  return c.operation(companyId, input.operationId, 'loan:void_draft', input, () => {
    const l = get(companyId, input.id);
    c.text(input.reason, 'Draft cancellation reason');
    if (l.status !== 'draft' || l.entries.length) c.fail('Only a draft loan with no entries can be voided');
    getDb().prepare("UPDATE employee_loans SET status='void' WHERE id=?").run(l.id);
    c.audit('employee_loan', l.id, 'void_draft', {
      reason: input.reason
    });
    return get(companyId, l.id);
  });
}
module.exports = {
  list,
  get,
  create,
  approve,
  changeRate,
  accrue,
  repay,
  postpone,
  reverseEntry,
  writeOff,
  project,
  voidDraft,
  postRepayment,
  reverse
};
