/**
 * Fixed Assets A0: tax depreciation, Cambodian classes, in riel
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §4.3 — every rate "confirm with accountant").
 * Pure — plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../main/util/taxDepreciation');

test('classes and rates as the plan lists them', () => {
  assert.equal(X.taxClass(1).rateBp, 500);
  assert.equal(X.taxClass('1b').rateBp, 1000);
  assert.equal(X.taxClass(2).rateBp, 5000);
  assert.equal(X.taxClass(3).rateBp, 2500);
  assert.equal(X.taxClass(4).rateBp, 2000);
  assert.deepEqual(X.POOLED_CLASSES, ['2', '3', '4']);
  assert.equal(X.taxClass('land').method, 'none');
  assert.throws(() => X.taxClass('9'), /Unknown tax class/);
});

test('§4.3 worked example: the 2027 truck in the Class 3 pool', () => {
  const added = X.usdCentsToKhr(2_400_000, 4050);
  assert.equal(added, 97_200_000);
  const y = X.poolYear({ classKey: 3, openingWdvKhr: 40_000_000, additionsKhr: added });
  assert.equal(y.baseKhr, 137_200_000);
  assert.equal(y.depreciationKhr, 34_300_000);
  assert.equal(y.closingWdvKhr, 102_900_000);
  // Book depreciation on the same truck in 2027, $2,250 at 4,050.
  assert.equal(X.usdCentsToKhr(225_000, 4050), 9_112_500);
});

test('pool sign cases: negative base is a gain, an emptied class is a loss', () => {
  const sale = X.usdCentsToKhr(900_000, 4050); // §5.4 truck sale
  assert.equal(sale, 36_450_000);
  const gain = X.poolYear({ classKey: 3, openingWdvKhr: 20_000_000, proceedsKhr: sale });
  assert.equal(gain.baseKhr, -16_450_000);
  assert.equal(gain.gainKhr, 16_450_000);
  assert.equal(gain.depreciationKhr, 0);
  assert.equal(gain.closingWdvKhr, 0);
  const loss = X.poolYear({ classKey: 2, openingWdvKhr: 5_000_000, proceedsKhr: 1_000_000, assetsRemaining: false });
  assert.equal(loss.lossKhr, 4_000_000);
  assert.equal(loss.closingWdvKhr, 0);
  const zero = X.poolYear({ classKey: 4, openingWdvKhr: 1000, proceedsKhr: 1000 });
  assert.equal(zero.baseKhr, 0);
  assert.equal(zero.depreciationKhr, 0);
  assert.throws(() => X.poolYear({ classKey: 1, openingWdvKhr: 1 }), /not a pooled class/);
});

test('rounding is half-up to the riel', () => {
  assert.equal(X.applyBp(3, 5000), 2);   // 1.5 → 2
  assert.equal(X.applyBp(5, 2500), 1);   // 1.25 → 1
  assert.equal(X.applyBp(7, 2500), 2);   // 1.75 → 2
  assert.equal(X.poolYear({ classKey: 2, openingWdvKhr: 3 }).depreciationKhr, 2);
});

test('Class 1: full year in, none in the year of disposal, until the cost is used', () => {
  const rows = X.straightLineYears({ classKey: 1, costKhr: 400_000_000, acquiredYear: 2026, toYear: 2048 });
  assert.equal(rows[0].depreciationKhr, 20_000_000, '5 % of cost in the year acquired');
  assert.equal(rows.filter((r) => r.depreciationKhr > 0).length, 20);
  assert.equal(rows[rows.length - 1].wdvKhr, 0);
  const sold = X.straightLineYears({ classKey: 1, costKhr: 400_000_000, acquiredYear: 2026, disposedYear: 2029, toYear: 2030 });
  assert.deepEqual(sold.map((r) => r.depreciationKhr), [20_000_000, 20_000_000, 20_000_000, 0, 0]);
  assert.equal(X.straightLineDisposal({ costKhr: 400_000_000, accumKhr: 60_000_000, proceedsKhr: 350_000_000 }), 10_000_000);
  const light = X.straightLineYears({ classKey: '1b', costKhr: 1_000_000, acquiredYear: 2026, toYear: 2026 });
  assert.equal(light[0].depreciationKhr, 100_000);
});

test('intangibles: over their life when known, else 10 %', () => {
  assert.equal(X.annualCharge({ classKey: 'intangible', costKhr: 12_000_000, lifeMonths: 36 }), 4_000_000);
  assert.equal(X.annualCharge({ classKey: 'intangible', costKhr: 12_000_000 }), 1_200_000);
  assert.equal(X.annualCharge({ classKey: 3, costKhr: 12_000_000 }), 0, 'pooled classes have no per-asset charge');
});

test('estimated pool openings from purchase history (no accountant yet, §13a)', () => {
  const est = X.estimatePoolOpenings({
    firstYear: 2026,
    assets: [
      { taxClass: 3, costKhr: 100_000_000, purchaseYear: 2023 },
      { taxClass: 3, costKhr: 40_000_000, purchaseYear: 2025 },
      { taxClass: 2, costKhr: 8_000_000, purchaseYear: 2024 },
      { taxClass: 2, costKhr: 4_000_000, purchaseYear: 2024, disposalYear: 2025, proceedsKhr: 1_000_000 },
      { taxClass: 1, costKhr: 500_000_000, purchaseYear: 2020 },  // not pooled
      { taxClass: 3, costKhr: 9_999_999, purchaseYear: 2026 },    // after the first year
    ],
  });
  // Class 3: 2023 100M → dep 25M → 75M; 2024 → 56.25M; 2025 +40M = 96.25M → 72.1875M (rounded).
  assert.equal(est['3'].years.length, 3);
  assert.equal(est['3'].openingWdvKhr, 72_187_500);
  // Class 2: 2024 12M → 6M; 2025 6M − 1M = 5M → 2.5M.
  assert.equal(est['2'].openingWdvKhr, 2_500_000);
  assert.equal(est['4'].openingWdvKhr, 0);
  assert.ok(est['3'].estimate);
  assert.equal(est['1'], undefined);
});
