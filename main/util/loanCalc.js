/**
 * HR2 pure loan arithmetic. Money is safe integer cents/riel in ONE currency.
 * Rates are monthly percentages, 0..100 (an arithmetic bound, not a legal limit).
 * Callers split intervals at month boundaries, rate changes and repayments.
 */
function money(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative safe integer`);
  }
  return value;
}

function totalDebt(principalMinor, interestMinor) {
  return money(money(principalMinor, 'principalMinor') + money(interestMinor, 'interestMinor'), 'total debt');
}

/** Convert the supplied decimal number to an exact percentage fraction. */
function percentage(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${field} must be a finite percentage between 0 and 100`);
  }
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  return [BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale)),
    100n * 10n ** BigInt(Math.max(0, scale))];
}

function dateMs(value, field = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    throw new Error(`${field} must be a real YYYY-MM-DD date (year 0001..9999)`);
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a real YYYY-MM-DD date`);
  }
  return ms;
}

function monthDays(date) {
  const first = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + 1, 0);
  return first.getUTCDate();
}

/** Inclusive single-month interval; interestFreeUntil is the FIRST eligible day. */
function interestForPeriod({ principalMinor, annualized = false, ratePercent, startDate, endDate, interestFreeUntil }) {
  money(principalMinor, 'principalMinor');
  if (annualized !== false) throw new Error('annualized must be false; supply a monthly rate');
  const [rate, divisor] = percentage(ratePercent, 'ratePercent');
  const start = dateMs(startDate, 'startDate');
  const end = dateMs(endDate, 'endDate');
  if (end < start) throw new Error('endDate must not precede startDate');
  if (startDate.slice(0, 7) !== endDate.slice(0, 7)) throw new Error('Interest interval must be within one calendar month');
  const eligibleStart = interestFreeUntil == null ? start : Math.max(start, dateMs(interestFreeUntil, 'interestFreeUntil'));
  const eligibleDays = Math.max(0, (end - eligibleStart) / 86400000 + 1);
  const periodDays = monthDays(startDate);
  const numerator = BigInt(principalMinor) * rate * BigInt(eligibleDays);
  const denominator = divisor * BigInt(periodDays);
  // Half up once per supplied interval, with no floating-point multiplication.
  const interestMinor = Number((2n * numerator + denominator) / (2n * denominator));
  return { interestMinor: money(interestMinor, 'interestMinor'), eligibleDays, periodDays };
}

function allocateRepayment({ principalMinor, interestMinor, amountMinor }) {
  const debt = totalDebt(principalMinor, interestMinor);
  money(amountMinor, 'amountMinor');
  if (amountMinor > debt) throw new Error('Repayment exceeds outstanding debt (overpayment)');
  const interestPaidMinor = Math.min(interestMinor, amountMinor);
  const principalPaidMinor = amountMinor - interestPaidMinor;
  return { principalPaidMinor, interestPaidMinor,
    principalMinor: principalMinor - principalPaidMinor, interestMinor: interestMinor - interestPaidMinor };
}

/** The caller explicitly chooses capitalization and persists its one-time transfer. */
function capitalizeInterest({ principalMinor, interestMinor }) {
  return { principalMinor: totalDebt(principalMinor, interestMinor), interestMinor: 0 };
}

/** Shortfall is the unpaid scheduled amount, capped by debt, not the whole debt. */
function deductionPlan({ principalMinor, interestMinor, installmentMinor, availableMinor, maxDeductionPercent }) {
  const debt = totalDebt(principalMinor, interestMinor);
  money(installmentMinor, 'installmentMinor');
  money(availableMinor, 'availableMinor');
  const [rate, divisor] = percentage(maxDeductionPercent, 'maxDeductionPercent');
  const scheduled = Math.min(debt, installmentMinor);
  // Floor a ceiling: rounding up could deduct more salary than the policy allows.
  const ceiling = Number(BigInt(availableMinor) * rate / divisor);
  const amountMinor = Math.min(scheduled, ceiling);
  const shortfallMinor = scheduled - amountMinor;
  return { amountMinor, shortfallMinor, needsReview: shortfallMinor > 0 };
}

/** Add directly from the original date; clamp its day to the target month. */
function addMonths(date, count) {
  dateMs(date);
  if (!Number.isSafeInteger(count)) throw new Error('Month count must be a safe integer');
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + count;
  if (index < 12 || index >= 120000) throw new Error('Target year must be in range 0001..9999');
  const month = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
  const day = Math.min(Number(date.slice(8, 10)), monthDays(`${month}-01`));
  return `${month}-${String(day).padStart(2, '0')}`;
}

function monthlyPeriods(from, through) {
  if (dateMs(through, 'through date') < dateMs(from, 'from date')) throw new Error('through date must not precede from date');
  const periods = [];
  for (let startDate = from; ;) {
    const last = `${startDate.slice(0, 7)}-${monthDays(startDate)}`;
    const endDate = last < through ? last : through;
    periods.push({ startDate, endDate });
    if (endDate === through) return periods;
    startDate = addMonths(`${startDate.slice(0, 7)}-01`, 1);
  }
}

module.exports = { interestForPeriod, allocateRepayment, capitalizeInterest, deductionPlan, addMonths, monthlyPeriods };
