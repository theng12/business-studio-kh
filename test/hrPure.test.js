/**
 * HR1: leave day counting, accrual, yearly grants and year-end expiry
 * (main/util/leaveCalc.js) and the kiosk PIN rules (main/util/kioskPin.js) —
 * pure, plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../main/util/leaveCalc');
const P = require('../main/util/kioskPin');
const { isWorkDay } = require('../main/util/attendanceCalc');
const { prefilledHolidays, HOLIDAYS_2026 } = require('../main/util/cambodiaHolidays');

const MON_SAT = { workDays: '1111110' };
const workDay = (d) => isWorkDay(MON_SAT, d);

test('leave days skip the weekly day off and public holidays; half days count 0.5', () => {
  // Mon 2026-10-05 … Mon 2026-10-12: Sunday 11 off, 10–12 Pchum Ben.
  const hol = new Set(['2026-10-10', '2026-10-11', '2026-10-12']);
  assert.equal(L.countLeaveDays({ fromDate: '2026-10-05', toDate: '2026-10-12', isWorkDay: workDay, isHoliday: (d) => hol.has(d) }), 5);
  assert.equal(L.countLeaveDays({ fromDate: '2026-10-08', toDate: '2026-10-08', halfDay: 'am', isWorkDay: workDay }), 0.5);
  assert.equal(L.countLeaveDays({ fromDate: '2026-10-11', toDate: '2026-10-11', halfDay: 'pm', isWorkDay: workDay }), 0, 'a half Sunday is nothing');
  assert.throws(() => L.countLeaveDays({ fromDate: '2026-10-09', toDate: '2026-10-08', isWorkDay: workDay }), /cannot end before/);
  assert.throws(() => L.countLeaveDays({ fromDate: '2026-10-08', toDate: '2026-10-09', halfDay: 'am', isWorkDay: workDay }), /same date/);
});

test('monthly accrual: complete months only, half a month employed counts, never twice', () => {
  const due = L.monthlyAccrualsDue({ accrualDays: 1.5, hireDate: '2026-07-20', startMonth: '2026-06', uptoMonth: '2026-09' });
  // July: 12 of 31 days → no; Aug, Sep → yes; June before hire → no.
  assert.deepEqual(due.map((r) => r.period), ['2026-08', '2026-09']);
  assert.equal(due[0].date, '2026-08-31');
  assert.equal(due[0].days, 1.5);
  const again = L.monthlyAccrualsDue({ accrualDays: 1.5, hireDate: '2026-07-10', startMonth: '2026-06', uptoMonth: '2026-09', existingPeriods: new Set(['2026-08']) });
  assert.deepEqual(again.map((r) => r.period), ['2026-07', '2026-09']);
  const left = L.monthlyAccrualsDue({ accrualDays: 1.5, endDate: '2026-08-10', startMonth: '2026-07', uptoMonth: '2026-09' });
  assert.deepEqual(left.map((r) => r.period), ['2026-07'], 'left on 10 Aug: August (10 of 31) does not count');
});

test('yearly grant: once per year employed, dated 1 January or the hire date', () => {
  const g = L.yearlyGrantsDue({ accrualDays: 7, hireDate: '2026-03-02', startYear: '2026', uptoYear: '2027' });
  assert.deepEqual(g, [{ period: '2026', date: '2026-03-02', days: 7 }, { period: '2027', date: '2027-01-01', days: 7 }]);
  assert.deepEqual(L.yearlyGrantsDue({ accrualDays: 7, startYear: '2026', uptoYear: '2026', existingPeriods: new Set(['2026']) }), []);
});

test('year end: only the excess over the carry-over limit lapses', () => {
  assert.equal(L.expiryAtYearEnd({ balance: 20, carryOverMax: 18 }), 2);
  assert.equal(L.expiryAtYearEnd({ balance: 5, carryOverMax: 18 }), 0);
  assert.equal(L.expiryAtYearEnd({ balance: 4, carryOverMax: 0 }), 4);
  assert.equal(L.expiryAtYearEnd({ balance: 40, carryOverMax: null }), 0, 'no limit');
  assert.equal(L.sumLedger([{ days: 1.5 }, { days: 1.5 }, { days: -2 }, { days: 0.5 }]), 1.5);
});

test('kiosk PIN: weak PINs refused, async scrypt round trip', async () => {
  assert.match(P.pinProblem('12'), /4 to 8 digits/);
  assert.match(P.pinProblem('1111'), /repeated/);
  assert.match(P.pinProblem('1234'), /straight run/);
  assert.match(P.pinProblem('9876'), /straight run/);
  assert.equal(P.pinProblem('4071'), null);
  const pending = P.hashPin('4071');
  assert.ok(pending instanceof Promise, 'hashing does not block the main thread');
  const { hash, salt } = await pending;
  assert.notEqual(hash, '4071');
  assert.equal(await P.verifyPin('4071', hash, salt), true);
  assert.equal(await P.verifyPin('4072', hash, salt), false);
  assert.notEqual((await P.hashPin('4071')).salt, salt, 'a new salt each time');
});

test('kiosk PIN: 5 wrong tries lock; locks double the same day; the third lock needs a manager', () => {
  const now = 1_000_000;
  const base = { now, today: '2026-10-08', maxTries: 5, lockMinutes: 10, locksBeforeManager: 3 };
  let s = { failedCount: 0, lockDay: null, locksToday: 0 };
  const fail5 = () => {
    for (let i = 1; i <= 5; i += 1) {
      s = P.afterAttempt({ ...base, correct: false, failedCount: s.failedCount, lockDay: s.lockDay, locksToday: s.locksToday });
      if (i < 5) assert.equal(s.triesLeft, 5 - i);
    }
    return s;
  };
  assert.equal(fail5().lockedUntil, now + 10 * 60 * 1000);
  assert.equal(P.lockState({ lockedUntil: s.lockedUntil, now: now + 60_000 }).locked, true);
  assert.equal(P.lockState({ lockedUntil: s.lockedUntil, now: now + 10 * 60 * 1000 + 1 }).locked, false);
  assert.equal(fail5().lockedUntil, now + 20 * 60 * 1000, 'second lock of the day: 20 min');
  const third = fail5();
  assert.equal(third.managerOnly, true);
  assert.equal(P.lockState({ managerOnly: true, now: now + 365 * 86400e3 }).locked, true, 'only a manager unlocks it');
  // A new day starts the escalation again; a correct PIN keeps the day's count.
  assert.equal(P.afterAttempt({ ...base, today: '2026-10-09', correct: false, failedCount: 4, lockDay: '2026-10-08', locksToday: 2 }).lockedUntil, now + 10 * 60 * 1000);
  assert.deepEqual(P.afterAttempt({ ...base, correct: true, failedCount: 3, lockDay: '2026-10-08', locksToday: 1 }).locksToday, 1);
});

test('kiosk-wide limit: 10 wrong PINs across staff in 10 min pause the kiosk', () => {
  let st = { failures: [] };
  let now = 0;
  for (let i = 0; i < 9; i += 1) { const r = P.kioskFailure(st, { now: now += 30_000 }); st = r.state; assert.equal(r.cooldownStarted, false); }
  const r = P.kioskFailure(st, { now: now += 30_000 });
  assert.equal(r.cooldownStarted, true);
  assert.equal(P.kioskCooldown(r.state, now + 60_000).cooling, true);
  assert.equal(P.kioskCooldown(r.state, now + 5 * 60_000 + 1).cooling, false);
  // Failures older than the window do not count.
  let slow = { failures: [] };
  for (let i = 0; i < 20; i += 1) { const x = P.kioskFailure(slow, { now: i * 120_000 }); slow = x.state; assert.equal(x.cooldownStarted, false); }
});

test('holiday prefill: 21 dates for 2026 from Sub-Decree 167; 2027 only fixed dates, no lunar ones', () => {
  assert.equal(HOLIDAYS_2026.length, 21);
  const all = prefilledHolidays();
  const y27 = all.filter((h) => h.date.startsWith('2027'));
  assert.ok(y27.every((h) => /check against the 2027 sub-decree/.test(h.sourceNote)));
  for (const lunar of ['Pchum Ben', 'Water Festival', 'Khmer New Year', 'Ploughing', 'Visak']) {
    assert.ok(!y27.some((h) => h.nameEn.includes(lunar)), `${lunar} must not be guessed for 2027`);
  }
  assert.equal(new Set(all.map((h) => h.date)).size, all.length, 'one row per date');
});
