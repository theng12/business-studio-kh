import { hasCap } from '../../lib/capabilities.js';
import { formatDate } from '../../lib/format.js';
import { fmtMoneyIn, minorToInput, lastEndedPeriod, todayKey, addMonths } from '../Assets/assetsModel.js';
export { minorToInput, lastEndedPeriod, todayKey };

export const errorText = error => error?.message || String(error);
export const dateLabel = date => formatDate(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date, { timeZone: 'Asia/Phnom_Penh' });
const required = (v, label) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required`); return v.trim(); };
const whole = (v, label, max = Number.MAX_SAFE_INTEGER) => {
  if (!/^\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v)) || Number(v) > max) throw new Error(`${label} must be a whole number from 0 to ${max}`);
  return Number(v);
};
export function calendarDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '1900-01-01' &&
    !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}
export function amountMinor(raw, currency) {
  if (!['USD', 'KHR'].includes(currency)) throw new Error('Choose USD or KHR');
  const value = String(raw ?? '').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter an amount in dollars or whole riel');
  const clean = value.replaceAll(',', '');
  if (currency === 'KHR' && clean.includes('.')) throw new Error('KHR amounts must be whole riel');
  const [units, decimal = ''] = clean.split('.');
  const minor = BigInt(units) * (currency === 'USD' ? 100n : 1n) + (currency === 'USD' ? BigInt(decimal.padEnd(2, '0')) : 0n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large');
  return Number(minor);
}
export function moneyLabel(minor, currency) {
  return Number.isSafeInteger(minor) && ['USD', 'KHR'].includes(currency) ? fmtMoneyIn(minor, currency) : '—';
}
export function periodChoices(month, cycle) {
  if (!calendarDate(`${month}-01`)) throw new Error('Choose a valid month');
  const [year, m] = month.split('-').map(Number);
  const last = `${month}-${new Date(Date.UTC(year, m, 0)).getUTCDate()}`;
  const choice = (value, label, kind, start, end) => ({ value, label, kind, periodStart: `${month}-${start}`, periodEnd: end });
  if (cycle === 'monthly') return [choice('monthly', 'Monthly', 'regular', '01', last)];
  if (cycle === 'twice_monthly_advance') return [choice('advance', 'First-half advance', 'advance', '01', `${month}-15`), choice('settlement', 'Month-end settlement', 'settlement', '01', last)];
  if (cycle === 'twice_monthly_separate') return [choice('first', 'Days 1–15', 'regular', '01', `${month}-15`), choice('second', 'Days 16–month end', 'regular', '16', last)];
  throw new Error('Company pay-cycle policy is unavailable');
}
export function defaultPayDate(month, settings) {
  return `${addMonths(month, 1)}-${String(settings.payday || 10).padStart(2, '0')}`;
}
export function statutoryOverrideForm(value) {
  return { applyTax: value?.applyTax === undefined ? 'inherit' : value.applyTax ? 'yes' : 'no',
    applyNssf: value?.applyNssf === undefined ? 'inherit' : value.applyNssf ? 'yes' : 'no', reason: value?.reason || '' };
}
export function statutoryOverridePayload(form) {
  const flags = {};
  for (const key of ['applyTax', 'applyNssf']) {
    const value = form?.[key] ?? 'inherit';
    if (!['inherit', 'yes', 'no'].includes(value)) throw new Error('Choose Inherit, Apply or Do not apply');
    if (value !== 'inherit') flags[key] = value === 'yes';
  }
  return Object.keys(flags).length ? { ...flags, reason: required(form?.reason, 'Statutory override reason') } : null;
}
export function createRunPayload(companyId, form, settings, today = todayKey()) {
  required(companyId, 'Company');
  const period = periodChoices(form.month, settings.payCycle).find(x => x.value === form.period);
  if (!period) throw new Error('Choose a period allowed by company policy');
  if (period.periodEnd >= today) throw new Error('Payroll period must have ended');
  if (!Array.isArray(form.employeeIds) || !form.employeeIds.length || form.employeeIds.length > 500 || new Set(form.employeeIds).size !== form.employeeIds.length) throw new Error('Choose 1 to 500 distinct staff members');
  form.employeeIds.forEach(id => required(id, 'Staff member'));
  if (!calendarDate(form.payDate)) throw new Error('Choose a valid pay date');
  const payload = { companyId, kind: period.kind, periodStart: period.periodStart, periodEnd: period.periodEnd, payDate: form.payDate, employeeIds: [...form.employeeIds], statutoryRateSetId: form.statutoryRateSetId || null };
  if (form.statutoryOverride !== undefined) payload.statutoryOverride = statutoryOverridePayload(form.statutoryOverride);
  if (period.kind === 'advance') {
    payload.currency = form.currency;
    payload.advanceMinor = amountMinor(form.advance, form.currency);
    if (!payload.advanceMinor) throw new Error('Advance must be more than zero');
  }
  for (const [rate, source] of [['taxRateKhrPerUsd', 'rateSource'], ['nssfRateKhrPerUsd', 'nssfRateSource'], ['loanRateKhrPerUsd', 'loanRateSource']]) {
    if (!String(form[rate] ?? '').trim()) { payload[rate] = null; payload[source] = null; continue; }
    const n = Number(form[rate]);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new Error('FX must be a positive KHR-per-USD rate, at most 100,000');
    payload[rate] = n; payload[source] = required(form[source], 'FX source');
  }
  return payload;
}

/** Generations invalidate even an A → B → A switch, independently per request lane. */
export function requestScope(key) {
  let bound = key, epoch = 0, alive = true;
  const lanes = new Map();
  return {
    bind(next) { if (next !== bound) { bound = next; epoch++; lanes.clear(); } },
    begin(lane = 'load') { const generation = (lanes.get(lane) || 0) + 1; lanes.set(lane, generation); return { key: bound, epoch, lane, generation }; },
    current(ticket) { return alive && ticket.key === bound && ticket.epoch === epoch && lanes.get(ticket.lane) === ticket.generation; },
    close() { alive = false; epoch++; },
  };
}
export function guardRows(rows, companyId, employeeId) {
  if (!Array.isArray(rows) || rows.some(x => !x || x.companyId !== companyId || !x.id || (employeeId && x.employeeId !== employeeId))) throw new Error('Payroll response does not match this company or employee');
  return rows;
}
export function guardRun(run, companyId, id) {
  if (!run || run.companyId !== companyId || !run.id || (id && run.id !== id) || !Number.isSafeInteger(run.revision) || run.revision < 0 || !['draft', 'reviewed', 'approved', 'paid', 'void'].includes(run.status)) throw new Error('Payroll response does not match this run');
  guardRows(run.lines, companyId);
  for (const line of run.lines) {
    if (line.runId !== run.id || !line.employeeId || !['USD', 'KHR'].includes(line.currency) || !Array.isArray(line.blockers) || !line.snapshot) throw new Error('Invalid payroll line response');
    for (const key of ['baseMinor', 'grossMinor', 'netMinor', 'paidMinor', 'remainingMinor']) if (!Number.isSafeInteger(line[key])) throw new Error('Invalid payroll amount response');
    if (line.remainingLoanDeductionMinor !== undefined && (!Number.isSafeInteger(line.remainingLoanDeductionMinor) || line.remainingLoanDeductionMinor < 0)) throw new Error('Invalid loan withholding balance');
    if (line.snapshot.employee?.id && line.snapshot.employee.id !== line.employeeId || [line.snapshot.policy, line.snapshot.employeePolicy, line.snapshot.effectivePolicy].some(p => p?.companyId && p.companyId !== companyId || p?.employeeId && p.employeeId !== line.employeeId)) throw new Error('Payroll input snapshot does not match this employee');
    if (line.snapshot.leaveBalances !== undefined && (!Array.isArray(line.snapshot.leaveBalances) || !calendarDate(line.snapshot.leaveBalanceAsOf) || line.snapshot.leaveBalances.some(b => !b || typeof b.leaveTypeId !== 'string' || !b.leaveTypeId || !Number.isFinite(b.days)))) throw new Error('Invalid payroll leave balance snapshot');
  }
  guardRows(run.payments, companyId);
  if (run.payments.some(payment => !Number.isSafeInteger(payment.amountMinor) || !run.lines.some(line => line.id === payment.lineId))) throw new Error('Payment response does not match this run');
  if (!Array.isArray(run.reviews)) throw new Error('Invalid payroll review response');
  return run;
}

// IPC drops error.code in some Electron/client paths. These are source-checked,
// transaction-rejection messages; unknown transport text takes precedence.
export function isDefiniteRejection(error, method) {
  const message = errorText(error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  if (error?.code === 'RPC_OUTCOME_UNKNOWN' || /RPC_OUTCOME_UNKNOWN|may still have completed|stopped answering before it confirmed/i.test(message)) return false;
  if (error?.code === 'BAD_REQUEST' || /^Bad request:/.test(message)) return true;
  const prefixes = {
    create: ['Payroll period must have ended', 'Payroll must be within one calendar month', 'Monthly policy requires', 'Separate periods must', 'Advance policy requires', 'Choose 1 to 500 distinct staff members', 'Explicit positive', 'Advance must', 'Statutory override', 'Unsupported statutory override'],
    updateLine: ['Payroll revision changed', 'Payroll line was superseded', 'Approved payroll is frozen', 'Statutory override', 'Unsupported statutory override'],
    pay: ['Only approved payroll can be paid', 'Payment date must', 'Payment exceeds remaining take-home pay', 'Advance is frozen after settlement approval', 'Loan balance changed after approval', 'A zero cash payment must'],
    reversePayment: ['Cannot reverse a reversal', 'Voided payroll is frozen', 'Void the dependent settlement before reversing its advance', 'Payment reversal reason is required'],
    setPayRate: ['A pay rate already exists for this date', 'Pay-rate reason is required'],
    setEmployeeComponent: ['Overlapping employee component assignment', 'Component end precedes start'],
    saveComponent: ['Code is required', 'Name is required'],
  };
  return ['You do not have permission to access payroll or loans', 'Only an admin may perform this financial action', 'That belongs to a different company', 'Pick a company first', 'Company not found', 'Payroll line not found in this company', 'Payment not found in this company', 'Rate set not found in this company', 'Staff member not found in this company', ...(prefixes[method] || [])].some(prefix => message.startsWith(prefix));
}

/** Pending payloads survive dialogs/company changes and same-tab reloads. */
export function commandBook(newId = () => globalThis.crypto.randomUUID(), storage = null) {
  const records = new Map();
  const keyOf = (method, payload) => `${payload.companyId}|${method}|${payload.id || 'new'}`;
  const journalKey = 'Payroll.pendingOperations.v1';
  let journalError = null;
  if (storage) {
    try {
      const saved = JSON.parse(storage.getItem(journalKey) || '[]');
      if (!Array.isArray(saved) || saved.some(r => !['create', 'pay', 'reversePayment'].includes(r.method) || !r.payload?.companyId || !r.payload?.operationId)) throw new Error('Invalid payroll retry journal');
      for (const record of saved) records.set(keyOf(record.method, record.payload), { ...record, running: false });
    } catch (error) { journalError = error; }
  }
  const persist = () => {
    if (!storage) return;
    try { storage.setItem(journalKey, JSON.stringify([...records.values()].map(({ running: _running, ...r }) => r))); }
    catch (error) { throw new Error(`Cannot retain the payroll retry request: ${errorText(error)}`, { cause: error }); }
  };
  return {
    pending(companyId) { return [...records.values()].filter(x => x.payload.companyId === companyId); },
    async send(method, input, invoke) {
      if (journalError) throw new Error(`Cannot read the payroll retry requests: ${errorText(journalError)}`);
      const key = keyOf(method, input);
      let record = records.get(key);
      if (record?.running) throw new Error('This financial request is already running');
      if (record) {
        const { operationId: _id, ...old } = record.payload;
        const { operationId: _nextId, ...next } = input;
        if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error('Retry the pending request with its original payload before starting another');
      } else {
        record = { method, payload: structuredClone({ ...input, operationId: newId() }), running: false, error: null };
        records.set(key, record);
      }
      record.running = true;
      try {
        persist(); // Persist before dispatch: a reload cannot create a new payment key.
        const result = await invoke(structuredClone(record.payload));
        records.delete(key);
        try { persist(); } catch (error) { records.set(key, record); throw error; }
        return result;
      } catch (error) {
        record.error = errorText(error);
        // The transactional backend explicitly rejects before any committed event.
        // Transport failures, timeouts and malformed responses remain unresolved.
        if (isDefiniteRejection(error, method)) { records.delete(key); persist(); }
        throw error;
      } finally { record.running = false; }
    },
  };
}

export function runNotice(run) {
  if (['approved', 'paid'].includes(run?.status)) return 'Frozen approved inputs. Payments are recorded only by an explicit payment action.';
  if (run?.status === 'void') return 'Voided run. Historical inputs and payments are retained.';
  return 'Draft estimate — calculate, resolve blockers and review before approval. Nothing has been paid.';
}
export function runActions(run, settings, caps) {
  const manage = hasCap(caps, 'payroll.manage');
  const admin = hasCap(caps, '*');
  const editable = manage && ['draft', 'reviewed'].includes(run?.status);
  const blocked = !run?.lines?.length || run.lines.some(x => x.blockers?.length);
  return { editable, calculate: editable, review: editable && !blocked,
    approve: manage && run?.status === 'reviewed' && !blocked && (admin || settings?.approvalPolicy === 'designated_managers'),
    pay: manage && ['approved', 'paid'].includes(run?.status),
    reverse: manage && admin && run?.status !== 'void',
    void: manage && run?.status !== 'void' && (editable || admin) };
}
export function employeePolicyPayload(companyId, employeeId, form) {
  const result = { companyId, employeeId };
  for (const key of ['applyTax', 'applyNssf', 'taxResident']) {
    if (!['yes', 'no'].includes(form[key])) throw new Error('Choose tax, NSSF and residency policy explicitly');
    result[key] = form[key] === 'yes';
  }
  result.spouseCount = whole(form.spouseCount, 'Spouse count', 1);
  result.dependentCount = whole(form.dependentCount, 'Dependent count', 100);
  result.reason = (!result.applyTax || !result.applyNssf) ? required(form.reason, 'Exemption reason') : form.reason?.trim() || null;
  return result;
}
export function decisionPayload(run, line, form) {
  if (form.kind === 'statutory') return { companyId: run.companyId, id: line.id, expectedRevision: run.revision, patch: { statutoryOverride: statutoryOverridePayload(form) } };
  const reason = required(form.reason, 'Decision reason');
  let patch;
  if (form.kind === 'day') {
    if (!calendarDate(form.date) || form.date < run.periodStart || form.date > run.periodEnd) throw new Error('Decision date is outside the payroll period');
    if (!['yes', 'no'].includes(form.payable)) throw new Error('Choose payable or unpaid for the whole day');
    patch = { dayDecisions: [...(line.decisions?.dayDecisions || []).filter(x => x.date !== form.date), { date: form.date, payable: form.payable === 'yes', reason }] };
  } else if (form.kind === 'loan') {
    patch = { loanDecisions: [...(line.decisions?.loanDecisions || []).filter(x => x.loanId !== form.loanId), { loanId: required(form.loanId, 'Loan'), amountMinor: amountMinor(form.amount, form.currency), reason }] };
  } else throw new Error('Unknown payroll decision');
  return { companyId: run.companyId, id: line.id, patch, expectedRevision: run.revision };
}
export function paymentPayload(companyId, line, form, periodStart, today = todayKey()) {
  const amount = amountMinor(form.amount, line.currency);
  if (amount > line.remainingMinor) throw new Error('Payment exceeds remaining take-home pay');
  if (amount === 0 && !(line.remainingLoanDeductionMinor ?? line.loanDeductionMinor)) throw new Error('Zero cash requires an outstanding loan deduction');
  if (!['cash', 'bank', 'other'].includes(form.method)) throw new Error('Choose a payment method');
  if (!calendarDate(form.paidAt) || form.paidAt > today || form.paidAt < periodStart) throw new Error('Payment date must be within or after the period and not in the future');
  return { companyId, id: line.id, amountMinor: amount, method: form.method, paidAt: form.paidAt, reference: form.reference?.trim() || null };
}

export function canPayLine(line, payments = []) {
  if (line.remainingMinor > 0) return true;
  if (line.remainingLoanDeductionMinor !== undefined) return line.remainingLoanDeductionMinor > 0;
  // Compatibility while the backend adds its reconciled withholding balance.
  return line.loanDeductionMinor > 0 && !payments.some(p => p.lineId === line.id && !p.reversesPaymentId && !payments.some(r => r.reversesPaymentId === p.id));
}

export function payRatePayload(companyId, employeeId, form) {
  if (!calendarDate(form.effectiveFrom)) throw new Error('Choose a real effective date');
  if (!['month', 'day', 'hour'].includes(form.basis)) throw new Error('Choose monthly, daily or hourly pay');
  return { companyId, employeeId, effectiveFrom: form.effectiveFrom, basis: form.basis, currency: form.currency,
    amountMinor: amountMinor(form.amount, form.currency), reason: required(form.reason, 'Pay-rate reason') };
}
export function componentPayload(companyId, form) {
  if (!['earning', 'deduction', 'employer_cost'].includes(form.kind) || !['fixed', 'per_day', 'per_hour', 'percent'].includes(form.calc)) throw new Error('Choose component kind and calculation');
  const booleans = {};
  for (const key of ['taxable', 'nssfContributory', 'isFringeBenefit']) {
    if (typeof form[key] !== 'boolean') throw new Error('Choose component tax and NSSF treatment explicitly');
    booleans[key] = form[key];
  }
  return { companyId, ...(form.id ? { id: form.id } : {}), code: required(form.code, 'Code'), nameEn: required(form.nameEn, 'English name'), nameKm: form.nameKm?.trim() || null,
    kind: form.kind, calc: form.calc, defaultAmountMinor: form.defaultAmountMinor ?? 0, ...booleans, active: form.id ? !!form.active : false };
}
export function assignmentPayload(companyId, employeeId, form, component) {
  if (!component || component.id !== form.componentId || !component.active) throw new Error('Choose an active component');
  if (component.calc === 'percent') throw new Error('Percentage components need a defined base; automatic percentage assignments are unavailable');
  if (!calendarDate(form.effectiveFrom) || (form.effectiveTo && (!calendarDate(form.effectiveTo) || form.effectiveTo < form.effectiveFrom))) throw new Error('Choose a valid component date range');
  return { companyId, employeeId, componentId: form.componentId, amountMinor: amountMinor(form.amount, form.currency), currency: form.currency,
    effectiveFrom: form.effectiveFrom, effectiveTo: form.effectiveTo || null };
}
