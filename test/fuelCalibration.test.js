/**
 * Fuel F1: the dip chart (main/util/tankCalibration.js) — pure, plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../main/util/tankCalibration');

// An "ullage" stick (cm measured from the top: more cm = less fuel) shaped so
// the plan's worked example holds exactly: 120 cm → 1,850 L, 98 cm → 2,090 L,
// and one cm is worth 22 L at the 98 cm level (§4.1).
const ULLAGE = [
  { dipCm: 0, litres: 3500 },
  { dipCm: 95, litres: 2156 },
  { dipCm: 100, litres: 2046 },
  { dipCm: 120, litres: 1850 },
  { dipCm: 200, litres: 0 },
];

test('lookup interpolates on a straight line between chart points', () => {
  const chart = cal.normalizeChart(ULLAGE);
  assert.equal(cal.litresAt(chart, 120), 1850);
  assert.equal(cal.litresAt(chart, 98), 2090);
  assert.equal(cal.litresAt(chart, 110), 1948);
  assert.equal(cal.lookup(chart, 98).outOfRange, false);
});

test('a depth stick (litres rise with cm) works the same way', () => {
  const chart = cal.normalizeChart([{ dipCm: 0, litres: 0 }, { dipCm: 100, litres: 2000 }, { dipCm: 150, litres: 2600 }]);
  assert.equal(cal.litresAt(chart, 50), 1000);
  assert.equal(cal.litresAt(chart, 125), 2300);
});

test('outside the chart the end segment is extended and flagged, never below 0 L', () => {
  const chart = cal.normalizeChart([{ dipCm: 10, litres: 100 }, { dipCm: 20, litres: 300 }]);
  assert.deepEqual(cal.lookup(chart, 25), { litres: 400, outOfRange: true });
  assert.deepEqual(cal.lookup(chart, 0), { litres: 0, outOfRange: true });
});

test('dip error = litres per cm at that level × allowed cm (the 22 L of the worked example)', () => {
  const chart = cal.normalizeChart(ULLAGE);
  assert.equal(cal.litresPerCmAt(chart, 98), 22);
  assert.equal(cal.dipErrorLitres(chart, 98, 1), 22);
  assert.equal(cal.dipErrorLitres(chart, 98, 2), 44);
  assert.ok(Math.abs(cal.dipErrorLitres(chart, 110, 1) - 9.8) < 1e-9);
});

test('normalizeChart sorts, and refuses charts that cannot be right', () => {
  const sorted = cal.normalizeChart([{ dipCm: 50, litres: 1000 }, { dipCm: 0, litres: 0 }]);
  assert.deepEqual(sorted.map((p) => p.dipCm), [0, 50]);
  assert.throws(() => cal.normalizeChart([{ dipCm: 0, litres: 0 }]), /at least two/);
  assert.throws(() => cal.normalizeChart([{ dipCm: 0, litres: 0 }, { dipCm: 0, litres: 5 }]), /twice/);
  assert.throws(() => cal.normalizeChart([{ dipCm: 0, litres: 0 }, { dipCm: 10, litres: 50 }, { dipCm: 20, litres: 40 }]), /only go up, or only go down/);
  assert.throws(() => cal.normalizeChart([{ dipCm: -1, litres: 0 }, { dipCm: 10, litres: 50 }]), /negative/);
  assert.throws(() => cal.normalizeChart('x'), /list/);
});

test('a chart can be built from deliveries dipped before and after', () => {
  const out = cal.buildChartFromDeliveries([
    { dipBeforeCm: 0, dipAfterCm: 50, litresAdded: 1000 },
    { dipBeforeCm: 50, dipAfterCm: 100, litresAdded: 800 },
  ], { stepCm: 10 });
  const at = (cm) => out.points.find((p) => p.dipCm === cm)?.litres;
  assert.equal(at(0), 0);
  assert.equal(at(50), 1000);
  assert.equal(at(100), 1800);
  assert.equal(out.observations, 2);
  // Overlapping deliveries average their slopes per cm.
  const avg = cal.buildChartFromDeliveries([
    { dipBeforeCm: 0, dipAfterCm: 10, litresAdded: 100 },
    { dipBeforeCm: 0, dipAfterCm: 10, litresAdded: 300 },
  ], { stepCm: 10 });
  assert.equal(avg.points.find((p) => p.dipCm === 10).litres, 200);
  assert.throws(() => cal.buildChartFromDeliveries([]), /At least one delivery/);
});
