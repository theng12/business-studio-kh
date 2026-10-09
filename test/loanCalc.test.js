const test = require('node:test');
const assert = require('node:assert/strict');
const loan = require('../main/util/loanCalc');

const interest = (patch = {}) => loan.interestForPeriod({
  principalMinor: 100000, annualized: false, ratePercent: 3,
  startDate: '2024-02-01', endDate: '2024-02-29', ...patch,
});
const deduction = (patch = {}) => loan.deductionPlan({
  principalMinor: 50000, interestMinor: 1000, installmentMinor: 10000,
  availableMinor: 30000, maxDeductionPercent: 100, ...patch,
});

test('monthly interest uses full calendar-month days, including leap February', () => {
  assert.deepEqual(interest(), { interestMinor: 3000, eligibleDays: 29, periodDays: 29 });
  assert.deepEqual(interest({ startDate: '2024-02-20' }), { interestMinor: 1034, eligibleDays: 10, periodDays: 29 });
  assert.deepEqual(interest({ startDate: '2023-02-15', endDate: '2023-02-28' }),
    { interestMinor: 1500, eligibleDays: 14, periodDays: 28 });
  assert.deepEqual(interest({ startDate: '2026-04-30', endDate: '2026-04-30' }),
    { interestMinor: 100, eligibleDays: 1, periodDays: 30 });
});

test('grace excludes its anniversary, which is the first eligible day', () => {
  assert.deepEqual(interest({ interestFreeUntil: '2024-02-20' }),
    { interestMinor: 1034, eligibleDays: 10, periodDays: 29 });
  assert.deepEqual(interest({ interestFreeUntil: '2024-02-29' }),
    { interestMinor: 103, eligibleDays: 1, periodDays: 29 });
  assert.deepEqual(interest({ interestFreeUntil: '2024-03-01' }),
    { interestMinor: 0, eligibleDays: 0, periodDays: 29 });
  assert.deepEqual(interest({ interestFreeUntil: '2024-01-31' }),
    { interestMinor: 3000, eligibleDays: 29, periodDays: 29 });
  assert.deepEqual(interest({ interestFreeUntil: null }), interest());
});

test('zero rate or principal still reports eligible days', () => {
  assert.deepEqual(interest({ ratePercent: 0 }), { interestMinor: 0, eligibleDays: 29, periodDays: 29 });
  assert.deepEqual(interest({ principalMinor: 0 }), { interestMinor: 0, eligibleDays: 29, periodDays: 29 });
});

test('interest rounds half up exactly in cents or riel without floating-point ties', () => {
  // 150 * 0.29 / 100 = 0.435; 5000 * 0.29 / 100 = 14.5 exactly.
  assert.equal(interest({ principalMinor: 150, ratePercent: 0.29 }).interestMinor, 0);
  assert.equal(interest({ principalMinor: 5000, ratePercent: 0.29 }).interestMinor, 15);
  assert.equal(interest({ principalMinor: 50, ratePercent: 1 }).interestMinor, 1);
  assert.equal(interest({ principalMinor: 49, ratePercent: 1 }).interestMinor, 0);
  assert.equal(interest({ principalMinor: 1000000, ratePercent: 1e-4 }).interestMinor, 1);
  assert.equal(interest({ principalMinor: 1000000, ratePercent: 1e-7 }).interestMinor, 0);
  assert.equal(interest({ principalMinor: Number.MAX_SAFE_INTEGER, ratePercent: 100 }).interestMinor,
    Number.MAX_SAFE_INTEGER);
  assert.equal(interest({ principalMinor: Number.MAX_SAFE_INTEGER, ratePercent: 50 }).interestMinor,
    4503599627370496);
});

test('interest rejects cross-month intervals, reversed dates and annualized rates', () => {
  assert.throws(() => interest({ startDate: '2024-01-31' }), /month/i);
  assert.throws(() => interest({ startDate: '2024-02-29', endDate: '2024-02-28' }), /date|start|end/i);
  for (const annualized of [true, 'false', 0, null]) {
    assert.throws(() => interest({ annualized }), /annualized/i);
  }
});

test('real ISO dates are required even when rate and principal are zero', () => {
  for (const value of ['2023-02-29', '2024-02-30', '2024-13-01', '2024-00-01',
    '2024-04-31', '2024-2-01', '2024-02-01T00:00:00Z', '', null, 20240201, undefined]) {
    for (const field of ['startDate', 'endDate', 'interestFreeUntil']) {
      if (field === 'interestFreeUntil' && value == null) continue;
      assert.throws(() => interest({ principalMinor: 0, ratePercent: 0, [field]: value }), /date/i);
    }
    assert.throws(() => loan.addMonths(value, 1), /date/i);
    assert.throws(() => loan.monthlyPeriods(value, '2024-03-01'), /date/i);
    assert.throws(() => loan.monthlyPeriods('2024-01-01', value), /date/i);
  }
});

test('money inputs reject negative, fractional, coerced, nonfinite and unsafe values', () => {
  for (const value of [-1, 0.5, '100', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => interest({ principalMinor: value }), /principalMinor/i);
    for (const field of ['principalMinor', 'interestMinor', 'amountMinor']) {
      assert.throws(() => loan.allocateRepayment({ principalMinor: 100, interestMinor: 1, amountMinor: 1,
        [field]: value }), new RegExp(field));
    }
    for (const field of ['principalMinor', 'interestMinor']) {
      assert.throws(() => loan.capitalizeInterest({ principalMinor: 100, interestMinor: 1,
        [field]: value }), new RegExp(field));
    }
    for (const field of ['principalMinor', 'interestMinor', 'installmentMinor', 'availableMinor']) {
      assert.throws(() => deduction({ [field]: value }), new RegExp(field));
    }
  }
});

test('rates and deduction caps require finite numeric percentages between zero and 100', () => {
  for (const value of [-1, 100.01, '3', null, undefined, NaN, Infinity]) {
    assert.throws(() => interest({ ratePercent: value }), /ratePercent/i);
    assert.throws(() => deduction({ maxDeductionPercent: value }), /maxDeductionPercent/i);
  }
});

test('repayments pay interest first and leave exact separate balances', () => {
  const balance = Object.freeze({ principalMinor: 50000, interestMinor: 1000, amountMinor: 11000 });
  assert.deepEqual(loan.allocateRepayment(balance), {
    principalPaidMinor: 10000, interestPaidMinor: 1000, principalMinor: 40000, interestMinor: 0,
  });
  assert.deepEqual(loan.allocateRepayment({ ...balance, amountMinor: 400 }), {
    principalPaidMinor: 0, interestPaidMinor: 400, principalMinor: 50000, interestMinor: 600,
  });
  assert.deepEqual(loan.allocateRepayment({ ...balance, amountMinor: 0 }), {
    principalPaidMinor: 0, interestPaidMinor: 0, principalMinor: 50000, interestMinor: 1000,
  });
  assert.deepEqual(loan.allocateRepayment({ ...balance, amountMinor: 51000 }), {
    principalPaidMinor: 50000, interestPaidMinor: 1000, principalMinor: 0, interestMinor: 0,
  });
  assert.throws(() => loan.allocateRepayment({ ...balance, amountMinor: 51001 }), /overpayment|exceed/i);
});

test('capitalization transfers interest once without increasing total debt', () => {
  const before = Object.freeze({ principalMinor: 50000, interestMinor: 1000 });
  const after = loan.capitalizeInterest(before);
  assert.deepEqual(after, { principalMinor: 51000, interestMinor: 0 });
  assert.deepEqual(loan.capitalizeInterest(after), after);
});

test('unsafe aggregate debt is rejected rather than rounded', () => {
  const balance = { principalMinor: Number.MAX_SAFE_INTEGER, interestMinor: 1 };
  assert.throws(() => loan.capitalizeInterest(balance), /safe|overflow/i);
  assert.throws(() => loan.allocateRepayment({ ...balance, amountMinor: 1 }), /safe|overflow/i);
  assert.throws(() => deduction(balance), /safe|overflow/i);
});

test('deductions cap the scheduled amount by debt and available pay', () => {
  assert.deepEqual(deduction(), { amountMinor: 10000, shortfallMinor: 0, needsReview: false });
  assert.deepEqual(deduction({ availableMinor: 6000 }),
    { amountMinor: 6000, shortfallMinor: 4000, needsReview: true });
  assert.deepEqual(deduction({ principalMinor: 800, interestMinor: 200 }),
    { amountMinor: 1000, shortfallMinor: 0, needsReview: false });
  assert.deepEqual(deduction({ principalMinor: 0, interestMinor: 0, availableMinor: 0 }),
    { amountMinor: 0, shortfallMinor: 0, needsReview: false });
  assert.deepEqual(deduction({ availableMinor: 0 }),
    { amountMinor: 0, shortfallMinor: 10000, needsReview: true });
  assert.deepEqual(deduction({ installmentMinor: 0 }),
    { amountMinor: 0, shortfallMinor: 0, needsReview: false });
});

test('percentage deduction ceilings round down to avoid exceeding the cap', () => {
  assert.deepEqual(deduction({ availableMinor: 199, maxDeductionPercent: 50 }),
    { amountMinor: 99, shortfallMinor: 9901, needsReview: true });
  assert.deepEqual(deduction({ availableMinor: 10000, maxDeductionPercent: 33.33 }),
    { amountMinor: 3333, shortfallMinor: 6667, needsReview: true });
  assert.deepEqual(deduction({ availableMinor: 10000, maxDeductionPercent: 0 }),
    { amountMinor: 0, shortfallMinor: 10000, needsReview: true });
  assert.deepEqual(deduction({ principalMinor: Number.MAX_SAFE_INTEGER, interestMinor: 0,
    installmentMinor: Number.MAX_SAFE_INTEGER, availableMinor: Number.MAX_SAFE_INTEGER,
    maxDeductionPercent: 50 }), {
    amountMinor: 4503599627370495, shortfallMinor: 4503599627370496, needsReview: true,
  });
});

test('month anniversaries clamp month ends and handle leap years and year changes', () => {
  for (const [date, count, expected] of [
    ['2024-01-31', 1, '2024-02-29'], ['2023-01-31', 1, '2023-02-28'],
    ['2024-01-31', 2, '2024-03-31'], ['2024-01-31', 3, '2024-04-30'],
    ['2024-02-29', 12, '2025-02-28'], ['2024-12-31', 1, '2025-01-31'],
    ['2024-03-31', -1, '2024-02-29'], ['2024-02-29', 0, '2024-02-29'],
  ]) assert.equal(loan.addMonths(date, count), expected);
  assert.deepEqual(interest({ interestFreeUntil: loan.addMonths('2024-01-20', 1) }),
    { interestMinor: 1034, eligibleDays: 10, periodDays: 29 });
});

test('month offsets reject nonintegers and dates outside the four-digit year range', () => {
  for (const count of [0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    assert.throws(() => loan.addMonths('2024-01-31', count), /count|month/i);
  }
  assert.throws(() => loan.addMonths('9999-12-31', 1), /year|range/i);
  assert.throws(() => loan.addMonths('0001-01-01', -1), /year|range/i);
  assert.throws(() => loan.addMonths('2024-01-31', Number.MAX_SAFE_INTEGER), /year|range/i);
});

test('monthly periods clip inclusive endpoints and retain complete interior months', () => {
  assert.deepEqual(loan.monthlyPeriods('2023-12-29', '2024-03-02'), [
    { startDate: '2023-12-29', endDate: '2023-12-31' },
    { startDate: '2024-01-01', endDate: '2024-01-31' },
    { startDate: '2024-02-01', endDate: '2024-02-29' },
    { startDate: '2024-03-01', endDate: '2024-03-02' },
  ]);
  assert.deepEqual(loan.monthlyPeriods('2024-02-12', '2024-02-12'), [
    { startDate: '2024-02-12', endDate: '2024-02-12' },
  ]);
  assert.deepEqual(loan.monthlyPeriods('9999-12-01', '9999-12-31'), [
    { startDate: '9999-12-01', endDate: '9999-12-31' },
  ]);
  assert.throws(() => loan.monthlyPeriods('2024-03-01', '2024-02-29'), /date|from|through|start|end/i);
});
