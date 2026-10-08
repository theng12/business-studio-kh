/**
 * Fixed Assets A0: book depreciation (docs/ASSETS_AND_BRANCHES_PLAN.md §4.1, §4.2, §5.4).
 * Pure — plain `npm test`. The plan's worked examples are checked to the cent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../main/util/bookDepreciation');

const sum = (a) => a.reduce((t, x) => t + x, 0);

test('allocation is exact to the cent for every total and length tried', () => {
  for (const n of [1, 2, 3, 7, 12, 24, 36, 41, 96, 120, 240]) {
    for (const total of [0, 1, 2, 99, 100, 101, 55000, 2160000, 922500, 999999, 123456789]) {
      const a = B.allocate(total, n);
      assert.equal(a.length, n);
      assert.equal(sum(a), total, `${total}/${n}`);
      const min = Math.min(...a);
      const max = Math.max(...a);
      assert.ok(max - min <= 1, `${total}/${n}: months differ by at most a cent`);
      assert.ok(a.every((x) => x >= 0));
    }
  }
  // Remainders are spread, never a stray cent at the end only.
  assert.deepEqual(B.allocate(10, 4), [2, 3, 2, 3]);
  assert.deepEqual(B.allocate(100, 3), [33, 33, 34]);
});

test('large amounts stay exact (BigInt)', () => {
  const total = 9_000_000_000_000; // ninety billion dollars in cents
  assert.equal(sum(B.allocate(total, 1200)), total);
});

test('periods and conventions', () => {
  assert.equal(B.addMonths('2026-12', 1), '2027-01');
  assert.equal(B.addMonths('2027-01', -1), '2026-12');
  assert.equal(B.monthsBetween('2020-06', '2027-01'), 79);
  assert.equal(B.dayBefore('2026-01-01'), '2025-12-31');
  assert.equal(B.dayBefore('2024-03-01'), '2024-02-29');
  // mid_month: on or before the 15th counts; after → next month.
  assert.equal(B.firstPeriod('2027-03-12'), '2027-03');
  assert.equal(B.firstPeriod('2027-03-15'), '2027-03');
  assert.equal(B.firstPeriod('2027-03-16'), '2027-04');
  assert.equal(B.firstPeriod('2027-12-31'), '2028-01');
  assert.equal(B.firstPeriod('2027-03-16', 'full_month'), '2027-03');
  // Disposal: on or before the 15th → that month does not count; after → it does.
  assert.equal(B.lastPeriod('2028-08-20'), '2028-08');
  assert.equal(B.lastPeriod('2028-08-15'), '2028-07');
  assert.equal(B.lastPeriod('2028-01-10'), '2027-12');
  assert.equal(B.lastPeriod('2028-08-20', 'full_month'), '2028-07');
  assert.throws(() => B.firstPeriod('2027-02-30'), /real date/);
  assert.throws(() => B.firstPeriod('2027-03-01', 'weekly'), /convention/);
});

test('§4.1 worked example: new truck, $24,000, 96 months, $2,400 salvage', () => {
  const start = B.firstPeriod('2027-03-12');
  assert.equal(start, '2027-03');
  const spec = { basisMinor: 2_400_000, salvageMinor: 240_000, lifeMonths: 96, startPeriod: start };
  const s = B.bookSchedule(spec);
  assert.equal(s.rows.length, 96);
  assert.ok(s.rows.every((r) => r.amountMinor === 22_500), '$225.00 a month');
  assert.equal(B.amountBetween(spec, '2027-01', '2027-12'), 225_000, '$2,250 for 2027 (10 months)');
  assert.equal(s.nbvMinor, 240_000, 'ends at salvage');
  assert.equal(s.fullyDepreciatedAt, '2035-02');
  assert.equal(B.accumThrough(spec, '2027-02'), 0);
  assert.equal(B.amountFor(spec, '2027-03'), 22_500);
});

test('§4.2 worked example, known cost: 2020 truck opening on 1 Jan 2027', () => {
  const o = B.openingPosition({ costMinor: 3_000_000, salvageMinor: 300_000, lifeMonths: 120, inServiceDate: '2020-06-01', registerStartDate: '2027-01-01' });
  assert.equal(o.monthsUsed, 79);
  assert.equal(o.accumMinor, 1_777_500, 'accumulated $17,775');
  assert.equal(o.nbvMinor, 1_222_500, 'NBV $12,225');
  assert.equal(o.remainingMonths, 41);
  assert.equal(o.depreciationStartPeriod, '2027-01');
  const spec = { basisMinor: 3_000_000, salvageMinor: 300_000, openingAccumMinor: o.accumMinor, lifeMonths: o.remainingMonths, startPeriod: '2027-01' };
  const s = B.bookSchedule(spec);
  assert.equal(s.rows.length, 41);
  assert.ok(s.rows.every((r) => r.amountMinor === 22_500), 'still $225 a month');
  assert.equal(s.nbvMinor, 300_000);
});

test('§5.4 worked example: selling that truck on 20 Aug 2028 — accumulated $22,275', () => {
  const spec = { basisMinor: 3_000_000, salvageMinor: 300_000, openingAccumMinor: 1_777_500, lifeMonths: 41, startPeriod: '2027-01', endPeriod: B.lastPeriod('2028-08-20') };
  assert.equal(B.accumThrough(spec, '2028-08'), 2_227_500);
  const s = B.bookSchedule(spec);
  assert.equal(s.rows.length, 20, 'Jan 2027 … Aug 2028');
  assert.equal(s.nbvMinor, 772_500, 'NBV $7,725');
  // Gain: proceeds $9,000 − NBV $7,725 = $1,275; the entry balances at $31,275.
  assert.equal(900_000 - s.nbvMinor, 127_500);
  assert.equal(2_227_500 + 900_000, 3_000_000 + 127_500);
});

test('§4.2 worked example, unknown cost: iMac at $600 deemed, 24 months left, $50 salvage', () => {
  const spec = { basisMinor: 60_000, salvageMinor: 5_000, lifeMonths: 24, startPeriod: '2027-01' };
  const s = B.bookSchedule(spec);
  assert.equal(s.rows.length, 24);
  assert.ok(s.rows.every((r) => r.amountMinor === 2291 || r.amountMinor === 2292), '$22.91 or $22.92');
  assert.equal(sum(s.rows.map((r) => r.amountMinor)), 55_000);
  assert.equal(s.nbvMinor, 5_000);
});

test('opening: a fully used-up asset and one put in use after the start', () => {
  const old = B.openingPosition({ costMinor: 100_000, salvageMinor: 0, lifeMonths: 36, inServiceDate: '2015-01-01', registerStartDate: '2026-01-01' });
  assert.equal(old.accumMinor, 100_000);
  assert.equal(old.remainingMonths, 0);
  assert.equal(B.bookSchedule({ basisMinor: 100_000, openingAccumMinor: 100_000, lifeMonths: 0, startPeriod: '2026-01' }).rows.length, 0);
  const late = B.openingPosition({ costMinor: 100_000, lifeMonths: 36, inServiceDate: '2026-02-20', registerStartDate: '2026-01-01' });
  assert.equal(late.monthsUsed, 0);
  assert.equal(late.accumMinor, 0);
  assert.throws(() => B.openingPosition({ costMinor: 1, lifeMonths: 1, inServiceDate: '2020-01-01', registerStartDate: '2026-01-15' }), /first of a month/);
});

test('prospective changes: life, salvage, capex and impairment re-run from the change month', () => {
  // $1,200 over 12 months = $100/month. After 4 months, life changes to 4 more months.
  const base = { basisMinor: 120_000, salvageMinor: 0, lifeMonths: 12, startPeriod: '2027-01' };
  const life = B.bookSchedule({ ...base, changes: [{ period: '2027-05', lifeMonths: 4 }] });
  assert.deepEqual(life.rows.slice(0, 4).map((r) => r.amountMinor), [10_000, 10_000, 10_000, 10_000], 'past months untouched');
  assert.deepEqual(life.rows.slice(4).map((r) => r.amountMinor), [20_000, 20_000, 20_000, 20_000], 'NBV $800 over 4 months');
  assert.equal(life.rows.length, 8);
  assert.equal(life.nbvMinor, 0);

  // Salvage raised to $400 at month 7: NBV $600 − $400 = $200 over the 6 months left.
  const salv = B.bookSchedule({ ...base, changes: [{ period: '2027-07', salvageMinor: 40_000 }] });
  assert.equal(sum(salv.rows.slice(6).map((r) => r.amountMinor)), 20_000);
  assert.equal(salv.nbvMinor, 40_000);

  // Salvage above the NBV: nothing more to depreciate, never negative.
  const high = B.bookSchedule({ ...base, changes: [{ period: '2027-07', salvageMinor: 90_000 }] });
  assert.equal(high.rows.length, 6);
  assert.equal(high.nbvMinor, 60_000);

  // Capex of $600 with 6 extra months at month 7: NBV 600+600 = $1,200 over 12 months = $100.
  const capex = B.bookSchedule({ ...base, changes: [{ period: '2027-07', addBasisMinor: 60_000, extendMonths: 6 }] });
  assert.equal(capex.rows.length, 18);
  assert.ok(capex.rows.slice(6).every((r) => r.amountMinor === 10_000));
  assert.equal(capex.basisMinor, 180_000);

  // Capex AFTER the asset was fully depreciated starts a new segment.
  const later = B.bookSchedule({ ...base, changes: [{ period: '2028-06', addBasisMinor: 24_000, extendMonths: 12 }] });
  assert.equal(later.rows.length, 24);
  assert.equal(later.rows[12].period, '2028-06');
  assert.equal(later.rows[12].amountMinor, 2_000);

  // Impairment of $300 at month 7: NBV $600 − 300 = $300 over 6 months.
  const imp = B.bookSchedule({ ...base, changes: [{ period: '2027-07', impairMinor: 30_000 }] });
  assert.ok(imp.rows.slice(6).every((r) => r.amountMinor === 5_000));
  assert.equal(imp.nbvMinor, 0);
  assert.equal(imp.impairedMinor, 30_000);
});

test('disposal stops the schedule at the last counted period', () => {
  const s = B.bookSchedule({ basisMinor: 120_000, lifeMonths: 12, startPeriod: '2027-01', endPeriod: '2027-03' });
  assert.equal(s.rows.length, 3);
  assert.equal(s.accumMinor, 30_000);
});

test('A2: charged-to-date, the position at a month, and the A2 change kinds', () => {
  const base = { basisMinor: 120_000, salvageMinor: 0, lifeMonths: 12, startPeriod: '2026-01' };
  assert.equal(B.chargedThrough(base, '2025-12'), 0);
  assert.equal(B.chargedThrough(base, '2026-03'), 30_000);
  assert.equal(B.chargedThrough(base, '2030-01'), 120_000);
  assert.equal(B.chargedThrough({ ...base, endPeriod: '2026-02' }, '2026-06'), 20_000, 'a disposal ends the charge');
  assert.deepEqual(B.positionAt(base, '2026-04'), { basisMinor: 120_000, accumMinor: 30_000, impairedMinor: 0, nbvMinor: 90_000, salvageMinor: 0, remainingMonths: 9, chargedMinor: 30_000 });
  assert.equal(B.positionAt(base, '2026-01').remainingMonths, 12);
  assert.equal(B.positionAt(base, '2027-06').remainingMonths, 0, 'fully depreciated: no life left');
  // Partial disposal from May: 40 % of cost and accumulated leave; the rest runs on.
  const part = B.bookSchedule({ ...base, changes: [{ period: '2026-05', removeBasisMinor: 48_000, removeAccumMinor: 16_000 }] });
  assert.equal(part.basisMinor, 72_000);
  assert.equal(part.nbvMinor, 0);
  assert.equal(part.chargedMinor, 40_000 + 72_000 - 24_000, 'charged = 4 months + the rest of the 60 % share');
  assert.deepEqual(part.rows.slice(4, 6).map((r) => r.amountMinor), [6_000, 6_000]);
  // Revaluation (elimination): accumulated goes to 0 and the new value runs over the months left.
  const rev = B.bookSchedule({ ...base, changes: [{ period: '2026-07', revalueToMinor: 60_000 }] });
  assert.deepEqual(rev.rows.slice(6).map((r) => r.amountMinor), [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(rev.accumMinor, 60_000, 'the balance after elimination');
  assert.equal(rev.chargedMinor, 120_000);
});
