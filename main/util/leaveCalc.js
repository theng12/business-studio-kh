/**
 * HR1: leave arithmetic — pure (docs/PEOPLE_AND_FUEL_PLAN.md §3.2, §7b).
 *
 *   days of a request   every date from..to that is a work day for that
 *                       person (their schedule that day) and not a public
 *                       holiday; a half day (from = to) counts 0.5.
 *   monthly accrual     a type with accrual 'monthly' earns accrualDays for a
 *                       calendar month in which the person was employed for at
 *                       least half the month's days (hire_date / end_date),
 *                       dated the month's last day, ONCE per employee + type +
 *                       month (the ledger's unique `period`).
 *   yearly grant        a type with accrual 'yearly' (e.g. special leave, 7
 *                       days) is granted accrualDays for each calendar year
 *                       the person is employed in, dated 1 January (or the
 *                       hire date), once per year.
 *   balance             Σ ledger days (accruals and grants +, taken −,
 *                       adjustments ±, expiry −).
 *   year end            a type with a carry-over limit keeps at most
 *                       carryOverMax days into the new year: the excess is
 *                       written off as one `expiry` row dated 31 December
 *                       (once per employee + type + year). A yearly grant
 *                       with carryOverMax 0 simply lapses.
 */

const { addDays, isDate, monthDates, lastDayOfMonth, nextMonth } = require('./attendanceCalc');

/**
 * @param {object} p
 * @param {string} p.fromDate / p.toDate
 * @param {null|'am'|'pm'} p.halfDay   only when fromDate === toDate
 * @param {(date: string) => boolean} p.isWorkDay
 * @param {(date: string) => boolean} p.isHoliday
 */
function countLeaveDays({ fromDate, toDate, halfDay = null, isWorkDay, isHoliday = () => false }) {
  if (!isDate(fromDate) || !isDate(toDate)) throw new Error('Dates must look like 2026-10-08');
  if (toDate < fromDate) throw new Error('The leave cannot end before it starts');
  if (halfDay && fromDate !== toDate) throw new Error('A half day must start and end on the same date');
  let days = 0;
  let n = 0;
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    n += 1;
    if (n > 400) throw new Error('A leave request can cover at most 400 days');
    if (isWorkDay(d) && !isHoliday(d)) days += 1;
  }
  if (halfDay) return days > 0 ? 0.5 : 0;
  return days;
}

/** The dates of a request that are counted (work days, not holidays). */
function leaveDates({ fromDate, toDate, isWorkDay, isHoliday = () => false }) {
  const out = [];
  for (let d = fromDate; d <= toDate && out.length <= 400; d = addDays(d, 1)) if (isWorkDay(d) && !isHoliday(d)) out.push(d);
  return out;
}

/** Days in `month` on which the person was employed. */
function employedDaysInMonth({ hireDate = null, endDate = null, month }) {
  return monthDates(month).filter((d) => (!hireDate || d >= hireDate) && (!endDate || d <= endDate)).length;
}

function monthEligible({ hireDate, endDate, month }) {
  const total = monthDates(month).length;
  return employedDaysInMonth({ hireDate, endDate, month }) * 2 >= total;
}

/**
 * Accrual rows a monthly type still owes, for every COMPLETE month from
 * `startMonth` up to `uptoMonth` (inclusive) that is eligible and not already
 * in `existingPeriods`. Returns [{ period: 'YYYY-MM', date, days }].
 */
function monthlyAccrualsDue({ accrualDays, hireDate = null, endDate = null, startMonth, uptoMonth, existingPeriods = new Set() }) {
  const out = [];
  if (!(accrualDays > 0) || !startMonth || !uptoMonth || startMonth > uptoMonth) return out;
  let m = startMonth;
  if (hireDate && hireDate.slice(0, 7) > m) m = hireDate.slice(0, 7);
  for (let guard = 0; m <= uptoMonth && guard < 1200; m = nextMonth(m), guard += 1) {
    if (endDate && `${m}-01` > endDate) break;
    if (existingPeriods.has(m)) continue;
    if (!monthEligible({ hireDate, endDate, month: m })) continue;
    out.push({ period: m, date: lastDayOfMonth(m), days: accrualDays });
  }
  return out;
}

/** Yearly grants still owed for years startYear..uptoYear (strings 'YYYY'). */
function yearlyGrantsDue({ accrualDays, hireDate = null, endDate = null, startYear, uptoYear, existingPeriods = new Set() }) {
  const out = [];
  if (!(accrualDays > 0) || !startYear || !uptoYear) return out;
  for (let y = Number(startYear); y <= Number(uptoYear); y += 1) {
    const period = String(y);
    if (existingPeriods.has(period)) continue;
    if (hireDate && hireDate > `${y}-12-31`) continue;
    if (endDate && endDate < `${y}-01-01`) continue;
    const date = hireDate && hireDate > `${y}-01-01` ? hireDate : `${y}-01-01`;
    out.push({ period, date, days: accrualDays });
  }
  return out;
}

/** Days to write off at the end of a year: max(0, balance − carryOverMax); null max = no limit. */
function expiryAtYearEnd({ balance, carryOverMax }) {
  if (carryOverMax == null || !(balance > carryOverMax)) return 0;
  return Math.round((balance - carryOverMax) * 100) / 100;
}

function sumLedger(rows) {
  return Math.round((rows || []).reduce((t, r) => t + (Number(r.days) || 0), 0) * 100) / 100;
}

module.exports = { countLeaveDays, leaveDates, employedDaysInMonth, monthEligible, monthlyAccrualsDue, yearlyGrantsDue, expiryAtYearEnd, sumLedger };
