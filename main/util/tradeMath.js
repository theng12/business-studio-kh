/**
 * Trade Finance — the money and date math, in one place
 * (docs/TRADE_FINANCE_PLAN.md §4).
 *
 * Two rules from the source product carry over because breaking either one
 * produces a wrong figure that looks plausible:
 *
 *   1. MONEY IS AN INTEGER IN MINOR UNITS. Nothing here returns a float
 *      amount; a fractional result is rounded once, at the end of a whole
 *      calculation, never per day or per segment.
 *   2. DAYS ARE CALENDAR DATES. Both sides of a difference are parsed as
 *      UTC midnight from 'YYYY-MM-DD', so a time component can never turn a
 *      3-day gap into 2 (the day-late reminder bug in the source product).
 *
 * Pure CommonJS with no DB import, so `test/tradeMath.test.js` runs under
 * plain `node --test`.
 */

const MS_PER_DAY = 86_400_000;
const PERIODS_PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1 };

/** UTC midnight for a calendar date, or null for anything that is not one. */
function dayStart(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').slice(0, 10));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  // Reject 2026-02-30 and friends: the parts must survive a round trip.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return t;
}

/** Whole calendar days from `aISO` to `bISO` (negative when b is earlier). */
function calendarDaysBetween(aISO, bISO) {
  const a = dayStart(aISO);
  const b = dayStart(bISO);
  if (a == null || b == null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/** Days from `todayISO` until `dateISO`; negative = overdue. */
function daysUntil(dateISO, todayISO) {
  const n = calendarDaysBetween(todayISO, dateISO);
  return n == null ? null : n;
}

/**
 * interest = principal × (rate/100) × days ÷ day_count, rounded once.
 * Returns 0 for anything missing or nonsensical — callers show the real
 * reason, never a guessed figure.
 */
function interestMinor({ principalMinor, ratePct, days, dayCount }) {
  const principal = Number(principalMinor);
  const rate = Number(ratePct);
  const n = Number(days);
  const dc = Number(dayCount);
  if (!Number.isFinite(principal) || !Number.isFinite(rate) || !Number.isFinite(n)) return 0;
  if (principal <= 0 || rate <= 0 || n <= 0 || (dc !== 360 && dc !== 365)) return 0;
  return Math.round((principal * (rate / 100) * n) / dc);
}

/** One day's interest. */
function dailyInterestMinor({ principalMinor, ratePct, dayCount }) {
  return interestMinor({ principalMinor, ratePct, days: 1, dayCount });
}

/** Principal still owed: principal minus principal repayments, never below 0. */
function outstandingMinor({ principalMinor, repayments = [] }) {
  const principal = Math.max(0, Math.round(Number(principalMinor) || 0));
  const paid = repayments.reduce((s, r) => s + Math.max(0, Math.round(Number(r.principalMinor) || 0)), 0);
  return Math.max(0, principal - paid);
}

/**
 * Interest accrued on a drawdown between two calendar dates, integrating the
 * outstanding principal day by day across part-repayments. A repayment's own
 * day accrues on the lower balance (the bank's convention in the source
 * product). The raw figure is accumulated unrounded and rounded ONCE, so a
 * month of daily accruals and one monthly calculation agree.
 */
function accruedMinor({ principalMinor, ratePct, dayCount, fromISO, toISO, repayments = [] }) {
  const start = dayStart(fromISO);
  const end = dayStart(toISO);
  const rate = Number(ratePct);
  const dc = Number(dayCount);
  if (start == null || end == null || end <= start) return 0;
  if (!Number.isFinite(rate) || rate <= 0 || (dc !== 360 && dc !== 365)) return 0;

  const all = repayments
    .map((r) => ({
      at: dayStart(r.paidOn ?? r.date),
      principal: Math.max(0, Math.round(Number(r.principalMinor) || 0)),
    }))
    .filter((r) => r.at != null)
    .sort((a, b) => a.at - b.at);

  // Repayments dated on or before the window started already: they lower the
  // balance the window opens on, and must never be counted twice.
  let balance = Math.max(0, Math.round(Number(principalMinor) || 0));
  let cursor = start;
  let raw = 0;
  const add = (days) => {
    if (days > 0 && balance > 0) raw += (balance * (rate / 100) * days) / dc;
  };
  for (const cut of all) {
    if (cut.at > start) break;
    balance = Math.max(0, balance - cut.principal);
  }
  const cuts = all.filter((r) => r.at > start && r.at <= end);
  for (const cut of cuts) {
    add(Math.round((cut.at - cursor) / MS_PER_DAY));
    balance = Math.max(0, balance - cut.principal);
    cursor = cut.at;
  }
  add(Math.round((end - cursor) / MS_PER_DAY));
  return Math.round(raw);
}

/** Commitment fee on the undrawn portion for one billing period, rounded once. */
function commitmentPerPeriodMinor({ undrawnMinor, ratePct, frequency = 'monthly' }) {
  const undrawn = Math.max(0, Math.round(Number(undrawnMinor) || 0));
  const rate = Number(ratePct);
  const periods = PERIODS_PER_YEAR[frequency] || 12;
  if (!Number.isFinite(rate) || rate <= 0 || undrawn <= 0) return 0;
  return Math.round((undrawn * (rate / 100)) / periods);
}

/** Last calendar day of a 1-based month. */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

/** Advance a calendar date by one billing period, clamping the day to the month. */
function addPeriod(dateISO, frequency = 'monthly') {
  const start = dayStart(dateISO);
  if (start == null) return null;
  const d = new Date(start);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1; // 1-based
  const day = d.getUTCDate();
  m += frequency === 'quarterly' ? 3 : frequency === 'yearly' ? 12 : 1;
  while (m > 12) { m -= 12; y += 1; }
  const dim = lastDayOfMonth(y, m);
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(Math.min(day, dim))}`;
}

/** The first and last calendar day of the month an ISO date falls in. */
function monthBounds(dateISO) {
  const start = dayStart(dateISO);
  if (start == null) return null;
  const d = new Date(start);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const pad = (n) => String(n).padStart(2, '0');
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` };
}

/** Utilisation as a fraction of the limit; no limit reads as 0, never Infinity. */
function utilisation(drawnMinor, limitMinor) {
  const limit = Number(limitMinor) || 0;
  if (limit <= 0) return 0;
  return Math.max(0, Number(drawnMinor) || 0) / limit;
}

/** The maturity bucket a report uses. */
function ladderBucket(daysTo) {
  if (daysTo == null) return '90+';
  if (daysTo < 0) return 'overdue';
  if (daysTo <= 30) return '0–30';
  if (daysTo <= 60) return '31–60';
  if (daysTo <= 90) return '61–90';
  return '90+';
}

const LADDER_BUCKETS = ['overdue', '0–30', '31–60', '61–90', '90+'];

/**
 * Which reminder rule fires for a drawdown `daysTo` days from maturity.
 * `rules` are `{ leadDays, enabled }`. Before maturity the MOST URGENT crossed
 * lead time wins (3 days out with 7/3/1 rules picks 3, never 7 and 3 both);
 * once overdue only the lead-0 rule applies, and it fires every day.
 * Returns `{ leadDays, daily }` or null.
 */
function chooseReminderRule(daysTo, rules = []) {
  if (daysTo == null || !Number.isFinite(Number(daysTo))) return null;
  const active = rules.filter((r) => r.enabled !== 0 && Number.isFinite(Number(r.leadDays)));
  if (daysTo < 0) {
    const overdue = active.find((r) => Number(r.leadDays) === 0);
    return overdue ? { leadDays: 0, daily: true } : null;
  }
  const reached = active.filter((r) => Number(r.leadDays) > 0 && Number(r.leadDays) >= daysTo);
  if (!reached.length) return null;
  const best = reached.reduce((a, b) => (Number(b.leadDays) < Number(a.leadDays) ? b : a));
  return { leadDays: Number(best.leadDays), daily: false };
}

module.exports = {
  MS_PER_DAY,
  PERIODS_PER_YEAR,
  dayStart,
  calendarDaysBetween,
  daysUntil,
  interestMinor,
  dailyInterestMinor,
  outstandingMinor,
  accruedMinor,
  commitmentPerPeriodMinor,
  lastDayOfMonth,
  addPeriod,
  monthBounds,
  utilisation,
  ladderBucket,
  LADDER_BUCKETS,
  chooseReminderRule,
};
