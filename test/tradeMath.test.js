/**
 * Trade Finance money + date math (docs/TRADE_FINANCE_PLAN.md §4).
 *
 * The two rules that matter: days are calendar dates (never a datetime that
 * can shift one day), and money is an integer rounded once at the end of a
 * whole calculation. Every figure below is worked by hand.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../main/util/tradeMath');

test('calendar days ignore time and month lengths', () => {
  assert.equal(m.calendarDaysBetween('2026-03-01', '2026-03-04'), 3);
  assert.equal(m.calendarDaysBetween('2026-03-04', '2026-03-01'), -3);
  assert.equal(m.calendarDaysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(m.calendarDaysBetween('2026-03-07', '2026-03-09'), 2, 'US DST weekend still counts two days');
  assert.equal(m.calendarDaysBetween('2024-02-28', '2024-03-01'), 2, 'leap day included');
  assert.equal(m.calendarDaysBetween('2026-02-30', '2026-03-01'), null, 'a non-date is refused');
});

test('daysUntil is negative once overdue', () => {
  assert.equal(m.daysUntil('2026-03-10', '2026-03-07'), 3);
  assert.equal(m.daysUntil('2026-03-07', '2026-03-07'), 0);
  assert.equal(m.daysUntil('2026-03-05', '2026-03-07'), -2);
});

test('interest is principal × rate × days ÷ day count, rounded once', () => {
  // USD 100,000 at 7.5% for 90 days on a 360-day basis.
  assert.equal(m.interestMinor({ principalMinor: 10_000_000, ratePct: 7.5, days: 90, dayCount: 360 }), 187_500);
  // The same on a 365-day basis.
  assert.equal(m.interestMinor({ principalMinor: 10_000_000, ratePct: 7.5, days: 90, dayCount: 365 }), 184_932);
  assert.equal(m.interestMinor({ principalMinor: 0, ratePct: 7.5, days: 90, dayCount: 360 }), 0);
  assert.equal(m.interestMinor({ principalMinor: 10_000_000, ratePct: 0, days: 90, dayCount: 360 }), 0);
  assert.equal(m.interestMinor({ principalMinor: 10_000_000, ratePct: 7.5, days: 0, dayCount: 360 }), 0);
  assert.equal(m.interestMinor({ principalMinor: 10_000_000, ratePct: 7.5, days: 90, dayCount: 0 }), 0);
});

test('accrual integrates a part-repayment and rounds once', () => {
  // Jan 1 → Feb 1 (31 days), 12%, 360 basis, USD 10,000:
  //   15 days on 10,000 = 5,000 cents; then 16 days on 6,000 = 3,200 cents.
  const accrued = m.accruedMinor({
    principalMinor: 1_000_000, ratePct: 12, dayCount: 360,
    fromISO: '2026-01-01', toISO: '2026-02-01',
    repayments: [{ paidOn: '2026-01-16', principalMinor: 400_000 }],
  });
  assert.equal(accrued, 8_200);
});

test('a repayment before the window lowers the opening balance exactly once', () => {
  // Jan 5 repayment lowers 10,000 to 6,000; Jan 10 → Feb 1 is 22 days.
  //   6,000 × 12% × 22/360 = 4,400 cents.
  const accrued = m.accruedMinor({
    principalMinor: 1_000_000, ratePct: 12, dayCount: 360,
    fromISO: '2026-01-10', toISO: '2026-02-01',
    repayments: [{ paidOn: '2026-01-05', principalMinor: 400_000 }],
  });
  assert.equal(accrued, 4_400);
});

test('a repaid drawdown stops accruing on the day it is repaid', () => {
  // Jan 1 → Jan 10 is 9 days at 12% / 360 on USD 10,000 = 3,000 cents;
  // the repayment day itself accrues on the lower (zero) balance.
  assert.equal(m.accruedMinor({
    principalMinor: 1_000_000, ratePct: 12, dayCount: 360,
    fromISO: '2026-01-01', toISO: '2026-03-01',
    repayments: [{ paidOn: '2026-01-10', principalMinor: 1_000_000 }],
  }), 3_000);
});

test('outstanding never goes below zero', () => {
  assert.equal(m.outstandingMinor({ principalMinor: 500, repayments: [{ principalMinor: 200 }] }), 300);
  assert.equal(m.outstandingMinor({ principalMinor: 500, repayments: [{ principalMinor: 900 }] }), 0);
});

test('commitment fee uses the undrawn part and its own frequency', () => {
  // USD 100,000 undrawn at 0.5% a year: 50,000 cents / 12 = 4,166.67 → 4,167.
  assert.equal(m.commitmentPerPeriodMinor({ undrawnMinor: 10_000_000, ratePct: 0.5, frequency: 'monthly' }), 4_167);
  assert.equal(m.commitmentPerPeriodMinor({ undrawnMinor: 10_000_000, ratePct: 0.5, frequency: 'quarterly' }), 12_500);
  assert.equal(m.commitmentPerPeriodMinor({ undrawnMinor: 10_000_000, ratePct: 0, frequency: 'monthly' }), 0, 'a waived rate is zero');
});

test('periods clamp to the month and month bounds are real', () => {
  assert.equal(m.addPeriod('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(m.addPeriod('2024-01-31', 'monthly'), '2024-02-29');
  assert.equal(m.addPeriod('2026-11-15', 'quarterly'), '2027-02-15');
  assert.deepEqual(m.monthBounds('2026-02-14'), { start: '2026-02-01', end: '2026-02-28' });
});

test('reminder rules: most urgent crossed lead wins, overdue fires daily', () => {
  const rules = [{ leadDays: 7, enabled: 1 }, { leadDays: 3, enabled: 1 }, { leadDays: 1, enabled: 1 }, { leadDays: 0, enabled: 1 }];
  assert.deepEqual(m.chooseReminderRule(3, rules), { leadDays: 3, daily: false }, 'a 3-day gap picks 3, not 7');
  assert.deepEqual(m.chooseReminderRule(2, rules), { leadDays: 3, daily: false }, 'past the 3-day mark the 3-day rule still owns it');
  assert.deepEqual(m.chooseReminderRule(0, rules), { leadDays: 1, daily: false }, 'due today is the nearest pre-due rule');
  assert.deepEqual(m.chooseReminderRule(-1, rules), { leadDays: 0, daily: true }, 'overdue fires every day');
  assert.equal(m.chooseReminderRule(8, rules), null, 'outside every window, nothing fires');
  assert.equal(m.chooseReminderRule(-1, rules.filter((r) => r.leadDays !== 0)), null, 'no overdue rule, no overdue reminder');
  assert.deepEqual(
    m.chooseReminderRule(1, rules.map((r) => ({ ...r, enabled: r.leadDays === 1 ? 0 : 1 }))),
    { leadDays: 3, daily: false }, 'a disabled rule does not fire',
  );
});

test('utilisation and ladder buckets', () => {
  assert.equal(m.utilisation(5_000, 10_000), 0.5);
  assert.equal(m.utilisation(5_000, 0), 0, 'no limit is not Infinity');
  assert.deepEqual(
    [-1, 0, 30, 31, 60, 61, 90, 91].map(m.ladderBucket),
    ['overdue', '0–30', '0–30', '31–60', '31–60', '61–90', '61–90', '90+'],
  );
});
