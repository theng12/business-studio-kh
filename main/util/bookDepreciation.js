/**
 * Fixed Assets A0: book depreciation — straight-line over the owner's life,
 * down to a salvage value (docs/ASSETS_AND_BRANCHES_PLAN.md §4.1, §4.2).
 *
 * Pure: no database, no clock. Money is integer minor units (US cents).
 * Periods are 'YYYY-MM', dates 'YYYY-MM-DD'.
 *
 * Nothing is stored as "the schedule": the register keeps the inputs (basis,
 * salvage, opening accumulated depreciation, remaining life, start period and
 * the dated changes) and this module works the schedule out the same way
 * every time. The monthly run (A2) posts "computed to date − posted to date".
 *
 * Allocation. A total T spread over n months gives month i
 *     floor(T × i / n) − floor(T × (i − 1) / n)        (i = 1..n)
 * which sums to T exactly, spreads any remainder across the months (never a
 * stray cent at the end), and is the same on every run.
 *
 * Conventions:
 *   mid_month  (default) in service on or before the 15th → that month counts,
 *              after the 15th → the next month. Disposed on or before the
 *              15th → that month does not count; after the 15th → it counts.
 *   full_month the in-service month counts; the disposal month does not.
 */

const CONVENTIONS = ['mid_month', 'full_month'];

function assertPeriod(p, label = 'period') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(p))) throw new Error(`${label} must look like 2027-03`);
  return String(p);
}

function assertDate(d, label = 'date') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d ?? ''));
  if (!m) throw new Error(`${label} must look like 2027-03-12`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (dt.getUTCMonth() !== Number(m[2]) - 1 || dt.getUTCDate() !== Number(m[3])) throw new Error(`${label} is not a real date`);
  return String(d);
}

function periodOf(date) { return assertDate(date).slice(0, 7); }

function periodIndex(p) {
  assertPeriod(p);
  return Number(p.slice(0, 4)) * 12 + (Number(p.slice(5, 7)) - 1);
}

function periodFromIndex(i) {
  const y = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

function addMonths(period, n) { return periodFromIndex(periodIndex(period) + n); }

/** Months from period a to period b (b − a); negative when b is earlier. */
function monthsBetween(a, b) { return periodIndex(b) - periodIndex(a); }

/** The day before a date, 'YYYY-MM-DD'. */
function dayBefore(date) {
  assertDate(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

function convention(c) {
  const v = c ?? 'mid_month';
  if (!CONVENTIONS.includes(v)) throw new Error('convention must be mid_month or full_month');
  return v;
}

/** The first period that depreciates for an asset put in use on `inServiceDate`. */
function firstPeriod(inServiceDate, conv = 'mid_month') {
  const p = periodOf(inServiceDate);
  if (convention(conv) === 'full_month') return p;
  return Number(inServiceDate.slice(8, 10)) <= 15 ? p : addMonths(p, 1);
}

/** The last period that depreciates for an asset disposed of (or lost) on `endDate`. */
function lastPeriod(endDate, conv = 'mid_month') {
  const p = periodOf(endDate);
  if (convention(conv) === 'full_month') return addMonths(p, -1);
  return Number(endDate.slice(8, 10)) <= 15 ? addMonths(p, -1) : p;
}

function int(v, label) {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a whole number of minor units`);
  return n;
}

/** floor(total × i / n), exact for any safe-integer inputs (BigInt). */
function cumulativeAt(total, n, i) {
  if (n <= 0 || total <= 0) return 0;
  const k = Math.max(0, Math.min(i, n));
  return Number((BigInt(total) * BigInt(k)) / BigInt(n));
}

/** Spread `total` over `n` months exactly (§4.1). */
function allocate(total, n) {
  const T = int(total, 'total');
  if (!Number.isInteger(n) || n < 0) throw new Error('months must be a whole number');
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push(cumulativeAt(T, n, i) - cumulativeAt(T, n, i - 1));
  return out;
}

/**
 * An old asset's position on the register start date when its cost and
 * in-service date are known (§4.2, first row): the accumulated depreciation
 * from in-service to the start, the NBV, and the months of life left.
 * `registerStartDate` must be the first of a month.
 */
function openingPosition({ costMinor, salvageMinor = 0, lifeMonths, inServiceDate, registerStartDate, convention: conv = 'mid_month' }) {
  const cost = int(costMinor, 'cost');
  const salvage = int(salvageMinor, 'salvage');
  const life = int(lifeMonths, 'life');
  if (life <= 0) throw new Error('Useful life must be at least 1 month');
  if (!String(registerStartDate).endsWith('-01')) throw new Error('The register start date must be the first of a month');
  const start = firstPeriod(inServiceDate, conv);
  const regStart = periodOf(registerStartDate);
  const used = Math.max(0, Math.min(life, monthsBetween(start, regStart)));
  const T = Math.max(0, cost - salvage);
  const accum = cumulativeAt(T, life, used);
  return {
    firstPeriod: start,
    monthsUsed: used,
    remainingMonths: life - used,
    accumMinor: accum,
    nbvMinor: cost - accum,
    depreciationStartPeriod: regStart,
  };
}

/**
 * The book schedule.
 *
 *   basisMinor         cost (or deemed cost) in US cents
 *   salvageMinor       residual value
 *   openingAccumMinor  depreciation already used up before startPeriod (known-cost openings)
 *   lifeMonths         months of life LEFT from startPeriod
 *   startPeriod        first period that depreciates
 *   endPeriod          last period that depreciates (disposal / loss), or null
 *   changes            prospective changes, each dated by the period they take effect:
 *       { period, lifeMonths? (new remaining life from that period),
 *         extendMonths? (added to the remaining life — capex),
 *         salvageMinor? (new salvage), addBasisMinor? (capex cost),
 *         impairMinor? (impairment: lowers the NBV) }
 *     T becomes the NBV at the start of that month minus the (new) salvage, n
 *     the remaining life; past months are untouched (§4.1).
 *
 * Returns { rows: [{ period, amountMinor, accumMinor, nbvMinor, segment }],
 *           openingAccumMinor, accumMinor (at the end), nbvMinor, basisMinor,
 *           impairedMinor, fullyDepreciatedAt }
 * Only months that depreciate (inside a segment's life) are listed.
 */
function bookSchedule(spec) {
  let basis = int(spec.basisMinor, 'basis');
  let salvage = int(spec.salvageMinor, 'salvage');
  const openingAccum = int(spec.openingAccumMinor, 'opening accumulated depreciation');
  const life = int(spec.lifeMonths, 'life');
  if (life < 0) throw new Error('Remaining life cannot be negative');
  const start = assertPeriod(spec.startPeriod, 'startPeriod');
  const end = spec.endPeriod ? assertPeriod(spec.endPeriod, 'endPeriod') : null;
  const startIdx = periodIndex(start);
  const endIdx = end ? periodIndex(end) : Infinity;

  const changes = (spec.changes || []).map((c) => ({ ...c, idx: Math.max(startIdx, periodIndex(assertPeriod(c.period, 'change period'))) }))
    .sort((a, b) => a.idx - b.idx);

  let accum = openingAccum;
  let impaired = 0;
  let segN = life;
  let segTotal = Math.max(0, basis - salvage - accum);
  let segDone = 0;
  let segment = 0;
  const rows = [];
  let fullyAt = null;

  const lastChangeIdx = changes.length ? changes[changes.length - 1].idx : -Infinity;
  let ci = 0;
  for (let p = startIdx; p <= endIdx; p += 1) {
    // Apply every change dated this period, then restart the segment from here.
    let changed = false;
    while (ci < changes.length && changes[ci].idx === p) {
      const c = changes[ci];
      const remaining = segN - segDone;
      if (c.addBasisMinor != null) basis += int(c.addBasisMinor, 'capex');
      if (c.impairMinor != null) impaired += int(c.impairMinor, 'impairment');
      if (c.salvageMinor != null) salvage = int(c.salvageMinor, 'salvage');
      let newRemaining = remaining;
      if (c.lifeMonths != null) newRemaining = int(c.lifeMonths, 'life');
      if (c.extendMonths != null) newRemaining += int(c.extendMonths, 'extra months');
      segN = Math.max(0, newRemaining);
      changed = true;
      ci += 1;
    }
    if (changed) {
      segment += 1;
      segDone = 0;
      segTotal = Math.max(0, basis - impaired - accum - salvage);
      fullyAt = null;
    }
    if (segDone < segN && segTotal > 0) {
      const amount = cumulativeAt(segTotal, segN, segDone + 1) - cumulativeAt(segTotal, segN, segDone);
      segDone += 1;
      accum += amount;
      rows.push({ period: periodFromIndex(p), amountMinor: amount, accumMinor: accum, nbvMinor: basis - impaired - accum, segment });
      if (segDone === segN) fullyAt = periodFromIndex(p);
    } else if (p >= lastChangeIdx) {
      if (fullyAt == null && segDone >= segN && rows.length) fullyAt = rows[rows.length - 1].period;
      break; // nothing left to depreciate and no change still to come
    }
  }
  return {
    rows,
    openingAccumMinor: openingAccum,
    accumMinor: accum,
    basisMinor: basis,
    impairedMinor: impaired,
    nbvMinor: basis - impaired - accum,
    fullyDepreciatedAt: fullyAt,
  };
}

/** Accumulated depreciation through `period` (inclusive), opening included. */
function accumThrough(spec, period) {
  const idx = periodIndex(assertPeriod(period));
  const { rows, openingAccumMinor } = bookSchedule(spec);
  let accum = openingAccumMinor;
  for (const r of rows) {
    if (periodIndex(r.period) > idx) break;
    accum = r.accumMinor;
  }
  return accum;
}

/** Depreciation for one period (0 outside the schedule). */
function amountFor(spec, period) {
  const row = bookSchedule(spec).rows.find((r) => r.period === period);
  return row ? row.amountMinor : 0;
}

/** Sum of depreciation over [fromPeriod, toPeriod], inclusive. */
function amountBetween(spec, fromPeriod, toPeriod) {
  const a = periodIndex(assertPeriod(fromPeriod));
  const b = periodIndex(assertPeriod(toPeriod));
  return bookSchedule(spec).rows
    .filter((r) => { const i = periodIndex(r.period); return i >= a && i <= b; })
    .reduce((t, r) => t + r.amountMinor, 0);
}

module.exports = {
  CONVENTIONS,
  periodOf, periodIndex, periodFromIndex, addMonths, monthsBetween, dayBefore,
  firstPeriod, lastPeriod, cumulativeAt, allocate,
  openingPosition, bookSchedule, accumThrough, amountFor, amountBetween,
  assertDate, assertPeriod,
};
