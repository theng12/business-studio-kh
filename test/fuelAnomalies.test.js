/**
 * Fuel F1: the anomaly rules (main/util/fuelAnomalies.js) — pure, plain `npm test`.
 *
 * Includes the plan's two worked examples (docs/PEOPLE_AND_FUEL_PLAN.md):
 *   §4.1 the 140 L tank variance, and
 *   §4.3 the owner's 15,000 / 10,000 KHR cash case.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../main/util/fuelAnomalies');
const { normalizeChart } = require('../main/util/tankCalibration');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 5, 1, 0, 0); // Mon 5 Oct 2026, 08:00 Phnom Penh
const ULLAGE = normalizeChart([
  { dipCm: 0, litres: 3500 }, { dipCm: 95, litres: 2156 }, { dipCm: 100, litres: 2046 },
  { dipCm: 120, litres: 1850 }, { dipCm: 200, litres: 0 },
]);
const TANK = { id: 'tank-1', name: 'Warehouse tank', kind: 'tank', status: 'active', createdAt: T0 - 30 * DAY };

function fill(over) {
  return { id: over.id, rootId: over.id, kind: 'warehouse_tank', locationId: TANK.id, assetId: 'bike', at: T0, litres: 10, fullTank: false, photoKinds: ['meter'], ...over };
}

/* ─── §4.1 worked example ─── */

test('T1 worked example: 1,850 + 2,000 − 1,420 − 200 = 2,230 expected; 2,090 measured → −140 L, tolerance ≈ 30 L → red', () => {
  const dips = [
    { id: 'd0', locationId: TANK.id, takenAt: T0, dipCm: 120, litres: 1850 },
    { id: 'd1', locationId: TANK.id, takenAt: T0 + 4 * DAY, dipCm: 98, litres: 2090 },
  ];
  const deliveries = [{ id: 'del', locationId: TANK.id, deliveredAt: T0 + DAY, litresInvoiced: 2000 }];
  const fills = [
    fill({ id: 'f1', at: T0 + DAY + 1000, litres: 700, attendantEmployeeId: 'att-a' }),
    fill({ id: 'f2', at: T0 + 2 * DAY, litres: 720, attendantEmployeeId: 'att-b' }),
  ];
  const transfers = [{ id: 'tr', fromLocationId: TANK.id, toLocationId: 'farm', litresSent: 200, sentAt: T0 + 3 * DAY }];
  const out = rules.tankReconciliation({ location: TANK, chart: ULLAGE, dips, deliveries, fills, transfers });
  assert.equal(out.intervals.length, 1);
  const iv = out.intervals[0];
  assert.equal(iv.expected, 2230);
  assert.equal(iv.variance, -140);
  assert.equal(iv.dipError, 22);
  assert.equal(iv.tolerance, 30.1);
  assert.deepEqual(iv.fillsByAttendant, { 'att-a': { litres: 700, count: 1 }, 'att-b': { litres: 720, count: 1 } });
  assert.equal(out.flags.length, 1);
  const f = out.flags[0];
  assert.equal(f.ruleKey, 'T1');
  assert.equal(f.severity, 'red');
  assert.equal(f.subject, 'dips:d0:d1');
  assert.match(f.explanation, /140 L unaccounted for/);
  assert.equal(f.period, '2026-10');
});

test('T1: inside tolerance → no flag; more fuel than recorded → amber', () => {
  const dips = [
    { id: 'a', locationId: TANK.id, takenAt: T0, dipCm: 120, litres: 1850 },
    { id: 'b', locationId: TANK.id, takenAt: T0 + DAY, dipCm: 120, litres: 1850 - 1000 + 10 },
  ];
  const fills = [fill({ id: 'x', at: T0 + 1000, litres: 1000 })];
  assert.equal(rules.tankReconciliation({ location: TANK, chart: ULLAGE, dips, fills }).flags.length, 0);
  dips[1].litres = 1850 - 1000 + 200;
  const out = rules.tankReconciliation({ location: TANK, chart: ULLAGE, dips, fills });
  assert.equal(out.flags[0].severity, 'amber');
});

test('T2 short delivery: dips either side show less than the invoice', () => {
  const chart = normalizeChart([{ dipCm: 0, litres: 0 }, { dipCm: 200, litres: 4000 }]); // 20 L/cm
  const dips = [
    { id: 'b', locationId: TANK.id, takenAt: T0, dipCm: 50, litres: 1000 },
    { id: 'a', locationId: TANK.id, takenAt: T0 + 3600e3, dipCm: 145, litres: 2900 },
  ];
  const deliveries = [{ id: 'del', locationId: TANK.id, deliveredAt: T0 + 1800e3, litresInvoiced: 2000, dipBeforeId: 'b', dipAfterId: 'a' }];
  const out = rules.shortDeliveries({ location: TANK, chart, deliveries, dips });
  // received 1,900; tolerance 20 + 0.5% × 2,000 = 30; short 100 > 2 × 30 → red
  assert.equal(out.checks[0].received, 1900);
  assert.equal(out.checks[0].tolerance, 30);
  assert.equal(out.flags[0].ruleKey, 'T2');
  assert.equal(out.flags[0].severity, 'red');
  // A fill taken from the tank between the dips counts as received.
  const withFill = rules.shortDeliveries({ location: TANK, chart, deliveries, dips, fills: [fill({ id: 'z', at: T0 + 2000e3, litres: 90 })] });
  assert.equal(withFill.flags.length, 0);
});

test('T3 missed dip: none for more than 2 days → amber, keyed to the last dip', () => {
  const now = T0 + 5 * DAY;
  const none = rules.missedDips({ location: { ...TANK, createdAt: T0 }, dips: [], now });
  assert.equal(none.flags[0].subject, 'nodip:tank-1:none');
  const old = rules.missedDips({ location: TANK, dips: [{ id: 'd', takenAt: T0 }], now });
  assert.equal(old.flags[0].subject, 'nodip:tank-1:d');
  assert.equal(old.flags[0].severity, 'amber');
  assert.equal(rules.missedDips({ location: TANK, dips: [{ id: 'd', takenAt: now - DAY }], now }).flags.length, 0);
  assert.equal(rules.missedDips({ location: { ...TANK, kind: 'farm_store' }, dips: [], now }).flags.length, 0);
});

/* ─── §4.3 worked example: the owner's 15,000 / 10,000 KHR case ─── */

const BIKE = { id: 'bike', name: 'Honda 1', meterUnit: 'km', tankCapacityL: 3.5, baselineRate: 2.5, baselineSource: 'manual', fuelType: 'gasoline', maxPerDay: 250 };
const PRICE_4000 = () => ({ priceMinorPerL: 4000, currency: 'KHR' }); // 4,000 KHR/L — arithmetic only, not a real price

test('cash case, with the pump-display photo: implied 6,000 KHR/L is 50% above the posted 4,000 → C1 red; 3.75 L > 3.5 L tank → C2 red', () => {
  const fills = [fill({
    id: 'cash', kind: 'cash_station', locationId: null, stationId: 'st-1', driverEmployeeId: 'x',
    litres: 2.5, amountPaidMinor: 15000, currency: 'KHR', litresShownOnPump: 2.5, meterReading: 1100,
    photoKinds: ['meter', 'pump_display'],
  })];
  const out = rules.assetRules({ asset: BIKE, fills, priceFor: PRICE_4000 });
  const c1 = out.flags.find((f) => f.ruleKey === 'C1');
  assert.equal(c1.severity, 'red');
  assert.equal(c1.measured, 6000);
  assert.equal(c1.expected, 4000);
  assert.match(c1.explanation, /50% above/);
  assert.equal(c1.refs.employeeId, 'x');
  assert.equal(c1.refs.stationId, 'st-1');
  const cash = rules.cashFigures(fills[0], PRICE_4000());
  assert.equal(cash.expectedLitres, 3.75);
  assert.equal(out.flags.find((f) => f.ruleKey === 'C2').severity, 'red');
  assert.equal(out.flags.find((f) => f.ruleKey === 'A7'), undefined);
});

test('cash case, without the display photo: A7 amber first, then the odometer gives it away — 3.75 L/100 km, 50% above baseline → A1 red', () => {
  const fills = [
    fill({ id: 'w', at: T0, kind: 'warehouse_tank', litres: 2.5, fullTank: true, meterReading: 1000 }),
    fill({ id: 'cash', at: T0 + DAY, kind: 'cash_station', locationId: null, stationId: 'st-1', driverEmployeeId: 'x',
      litres: 3.75, amountPaidMinor: 15000, currency: 'KHR', fullTank: true, meterReading: 1100, photoKinds: ['meter'] }),
  ];
  const out = rules.assetRules({ asset: { ...BIKE, tankCapacityL: 5 }, fills, priceFor: PRICE_4000 });
  const a7 = out.flags.find((f) => f.ruleKey === 'A7');
  assert.equal(a7.severity, 'amber');
  assert.deepEqual(a7.details.missing, ['pump display photo']);
  assert.equal(out.intervals.length, 1);
  assert.equal(out.intervals[0].rate, 3.75);
  const a1 = out.flags.find((f) => f.ruleKey === 'A1');
  assert.equal(a1.severity, 'red');
  assert.equal(a1.measured, 3.75);
  assert.equal(a1.expected, 2.5);
  assert.equal(a1.subject, 'interval:w:cash');
  assert.match(a1.explanation, /50% above/);
});

test('C5: the reviewer reads the pump photo and it disagrees with the typed figures → red', () => {
  const f = fill({ id: 'c', kind: 'cash_station', amountPaidMinor: 15000, currency: 'KHR', litresShownOnPump: 3.75, reviewedAmountMinor: 10000, reviewedLitres: 2.5, meterReading: 5, photoKinds: ['meter', 'pump_display'] });
  const out = rules.assetRules({ asset: BIKE, fills: [f], priceFor: PRICE_4000 });
  const c5 = out.flags.find((x) => x.ruleKey === 'C5');
  assert.equal(c5.severity, 'red');
  assert.match(c5.explanation, /10,000 KHR/);
  assert.equal(rules.reviewerMismatch({ ...f, reviewedAmountMinor: 15000, reviewedLitres: 3.75 }), null);
});

/* ─── A-rules ─── */

test('A2 meter not moving, A3 backwards, a recorded meter reset is not "backwards"', () => {
  const base = [fill({ id: 'a', at: T0, meterReading: 5000 })];
  const same = rules.assetRules({ asset: BIKE, fills: [...base, fill({ id: 'b', at: T0 + DAY, meterReading: 5000 })] });
  assert.ok(same.flags.some((f) => f.ruleKey === 'A2' && f.severity === 'amber'));
  const back = rules.assetRules({ asset: BIKE, fills: [...base, fill({ id: 'b', at: T0 + DAY, meterReading: 4900 })] });
  assert.ok(back.flags.some((f) => f.ruleKey === 'A3' && f.severity === 'red'));
  const reset = rules.assetRules({
    asset: BIKE,
    fills: [...base, fill({ id: 'b', at: T0 + DAY, meterReading: 40 })],
    resets: [{ id: 'r', assetId: 'bike', at: T0 + DAY / 2, oldReading: 5020, newReading: 0 }],
  });
  assert.equal(reset.flags.filter((f) => f.ruleKey === 'A3' || f.ruleKey === 'A2').length, 0);
  assert.equal(reset.segments[0].distance, 60); // 20 before the swap + 40 after
});

test('A4 impossible jump: a motorbike cannot do 600 km in a day (max 250/day)', () => {
  const out = rules.assetRules({ asset: BIKE, fills: [fill({ id: 'a', at: T0, meterReading: 100 }), fill({ id: 'b', at: T0 + DAY, meterReading: 700 })] });
  const a4 = out.flags.find((f) => f.ruleKey === 'A4');
  assert.equal(a4.severity, 'red');
  assert.equal(a4.threshold, 250);
  const hours = rules.assetRules({ asset: { ...BIKE, meterUnit: 'hours' }, fills: [fill({ id: 'a', at: T0, meterReading: 10 }), fill({ id: 'b', at: T0 + DAY, meterReading: 40 })] });
  assert.ok(hours.flags.some((f) => f.ruleKey === 'A4'));
});

test('A5 more than the tank holds (> capacity × 1.05)', () => {
  const out = rules.assetRules({ asset: BIKE, fills: [fill({ id: 'a', litres: 3.7 })] });
  assert.ok(out.flags.some((f) => f.ruleKey === 'A5'));
  assert.ok(!rules.assetRules({ asset: BIKE, fills: [fill({ id: 'a', litres: 3.6 })] }).flags.some((f) => f.ruleKey === 'A5'));
});

test('A6 refilled too soon: under 25% of a tank\'s range since the last fill', () => {
  // range = 3.5 L ÷ 2.5 L/100 km × 100 = 140 km → too soon under 35 km
  const out = rules.assetRules({ asset: BIKE, fills: [fill({ id: 'a', at: T0, meterReading: 100 }), fill({ id: 'b', at: T0 + DAY, meterReading: 120, litres: 1 })] });
  const a6 = out.flags.find((f) => f.ruleKey === 'A6');
  assert.equal(a6.severity, 'amber');
  assert.equal(a6.threshold, 35);
  assert.ok(!rules.assetRules({ asset: BIKE, fills: [fill({ id: 'a', at: T0, meterReading: 100 }), fill({ id: 'b', at: T0 + DAY, meterReading: 200 })] }).flags.some((f) => f.ruleKey === 'A6'));
});

test('A7 missing evidence: no meter photo; machines without a meter need none', () => {
  const out = rules.assetRules({ asset: BIKE, fills: [fill({ id: 'a', meterReading: 1, photoKinds: [] })] });
  assert.deepEqual(out.flags.find((f) => f.ruleKey === 'A7').details.missing, ['meter photo']);
  const pump = rules.assetRules({ asset: { ...BIKE, meterUnit: 'none' }, fills: [fill({ id: 'a', photoKinds: [] })] });
  assert.ok(!pump.flags.some((f) => f.ruleKey === 'A7'));
});

test('A1 thresholds: +20% amber, +35% red, learned baseline = median of recent intervals', () => {
  const mk = (litres) => [
    fill({ id: 'a', at: T0, fullTank: true, meterReading: 0 }),
    fill({ id: 'b', at: T0 + DAY, fullTank: true, meterReading: 100, litres }),
  ];
  const amber = rules.assetRules({ asset: { ...BIKE, tankCapacityL: 10 }, fills: mk(3.1) });
  assert.equal(amber.flags.find((f) => f.ruleKey === 'A1').severity, 'amber');
  const fine = rules.assetRules({ asset: { ...BIKE, tankCapacityL: 10 }, fills: mk(2.9) });
  assert.equal(fine.flags.find((f) => f.ruleKey === 'A1'), undefined);
  const learned = rules.resolveBaseline({ baselineRate: 9, baselineSource: 'learned' }, [
    { toAt: T0 - 3 * DAY, rate: 2 }, { toAt: T0 - 2 * DAY, rate: 3 }, { toAt: T0 - DAY, rate: 10 },
  ], T0);
  assert.deepEqual(learned, { value: 3, source: 'learned', samples: 3 });
  const tooFew = rules.resolveBaseline({ baselineRate: 9, baselineSource: 'learned' }, [{ toAt: T0 - DAY, rate: 2 }], T0);
  assert.equal(tooFew.value, 9);
  assert.equal(tooFew.source, 'manual');
});

/* ─── pump flow meter ─── */

test('M1 pump meter vs typed litres; M2 continuity gap = fuel that left the pump with no record', () => {
  const loc = { ...TANK, hasFlowMeter: true };
  const fills = [
    fill({ id: 'f1', at: T0, pumpMeterBefore: 100, pumpMeterAfter: 140, typedLitres: 40 }),
    fill({ id: 'f2', at: T0 + 1000, pumpMeterBefore: 150, pumpMeterAfter: 180, typedLitres: 30 }),
    fill({ id: 'f3', at: T0 + 2000, pumpMeterBefore: 180, pumpMeterAfter: 200, typedLitres: 25 }),
  ];
  const out = rules.meterRules({ location: loc, fills });
  const m2 = out.flags.filter((f) => f.ruleKey === 'M2');
  assert.equal(m2.length, 1);
  assert.equal(m2[0].severity, 'red');
  assert.equal(m2[0].details.gapLitres, 10);
  assert.match(m2[0].explanation, /10 L left the pump with no record/);
  const m1 = out.flags.filter((f) => f.ruleKey === 'M1');
  assert.equal(m1.length, 1);
  assert.equal(m1[0].subject, 'fill:f3');
  // A pump meter reset between the two records restarts the chain.
  const reset = rules.meterRules({ location: loc, fills: fills.slice(0, 2), resets: [{ id: 'r', locationId: TANK.id, at: T0 + 500, oldReading: 140, newReading: 150 }] });
  assert.equal(reset.flags.length, 0);
});

test('resolvePumpMeterLitres: the meter wins, a disagreement is reported, backwards is caught', () => {
  assert.deepEqual(
    pick(rules.resolvePumpMeterLitres({ before: 10, after: 50, typed: 40.2 })),
    { litres: 40, source: 'pump_meter', disagreement: false },
  );
  assert.equal(rules.resolvePumpMeterLitres({ before: 10, after: 50, typed: 45 }).disagreement, true);
  assert.equal(rules.resolvePumpMeterLitres({ before: 50, after: 10, typed: 40 }).backwards, true);
  function pick(r) { return { litres: r.litres, source: r.source, disagreement: r.disagreement }; }
});

/* ─── settings + dates ─── */

test('settings: defaults per the plan, sanitize refuses unknown or out-of-range values', () => {
  const s = rules.mergeSettings({ missedDipDays: 3, nonsense: 1, a1RedRatio: 99 });
  assert.equal(s.missedDipDays, 3);
  assert.equal(s.a1RedRatio, 1.35);
  assert.equal(s.tankTolerancePct, 0.5);
  assert.equal(s.photoRetentionMonths, 24);
  assert.equal(s.c1PriceRatio, 1.02);
  assert.throws(() => rules.sanitizeSettingsPatch({ nonsense: 1 }), /Unknown fuel setting/);
  assert.throws(() => rules.sanitizeSettingsPatch({ missedDipDays: 0 }), /from 1 to 60/);
  assert.deepEqual(rules.sanitizeSettingsPatch({ missedDipDays: 4 }), { missedDipDays: 4 });
});

test('dates are Phnom Penh dates (UTC+7) and months are [start, end) in that zone', () => {
  assert.equal(rules.phnomPenhDate(Date.UTC(2026, 9, 31, 18, 0)), '2026-11-01');
  const { start, end } = rules.monthRange('2026-10');
  assert.equal(rules.phnomPenhDate(start), '2026-10-01');
  assert.equal(rules.phnomPenhDate(end - 1), '2026-10-31');
  assert.throws(() => rules.monthRange('2026-13'), /month/);
});

/* ─── review fixes (2026-10-08) ─── */

test('a delivery typed in after its "after" dip (the natural phone order) counts inside its dips — no false red', () => {
  const dips = [
    { id: 'b', locationId: TANK.id, takenAt: T0, dipCm: 120, litres: 1850 },
    { id: 'a', locationId: TANK.id, takenAt: T0 + 3600e3, dipCm: 100, litres: 0 },
    { id: 'c', locationId: TANK.id, takenAt: T0 + DAY, dipCm: 100, litres: 0 },
  ];
  dips[1].litres = 1850 + 2000; // the delivery shows in the "after" dip…
  dips[2].litres = 1850 + 2000; // …and nothing moved until the next one
  const late = { id: 'del', locationId: TANK.id, deliveredAt: T0 + 2 * 3600e3, litresInvoiced: 2000, dipBeforeId: 'b', dipAfterId: 'a' };
  const out = rules.tankReconciliation({ location: TANK, chart: ULLAGE, dips, deliveries: [late] });
  assert.deepEqual(out.flags, [], 'placed inside its dips, the books balance');
  assert.equal(out.intervals[0].delivered, 2000);
  assert.equal(rules.deliveryEffectiveAt(late, new Map(dips.map((d) => [d.id, d]))), T0 + 3600e3 - 1);
  // Without the link it lands after the "after" dip: one red, one amber — the bug this fixes.
  const unlinked = rules.tankReconciliation({ location: TANK, chart: ULLAGE, dips, deliveries: [{ ...late, dipBeforeId: null, dipAfterId: null }] });
  assert.deepEqual(unlinked.flags.map((f) => f.severity).sort(), ['amber', 'red']);
});

test('M1 on a transfer compares the pump meter with what was TYPED, not with itself', () => {
  const transfers = [{ id: 't1', fromLocationId: TANK.id, sentAt: T0, pumpMeterBefore: 0, pumpMeterAfter: 200, litresSent: 200, typedLitres: 220 }];
  const out = rules.meterRules({ location: TANK, transfers });
  assert.equal(out.flags.length, 1);
  assert.equal(out.flags[0].ruleKey, 'M1');
  assert.equal(out.flags[0].expected, 220);
  assert.equal(rules.meterRules({ location: TANK, transfers: [{ ...transfers[0], typedLitres: 200 }] }).flags.length, 0);
});

test('F1 transfer loss: sent − received over 2% amber, over 5% red', () => {
  const t = (received) => [{ id: 'x', fromLocationId: TANK.id, toLocationId: 'farm', sentAt: T0, litresSent: 200, litresReceived: received }];
  assert.equal(rules.transferLoss({ location: TANK, transfers: t(197) }).flags.length, 0);
  assert.equal(rules.transferLoss({ location: TANK, transfers: t(194) }).flags[0].severity, 'amber');
  const red = rules.transferLoss({ location: TANK, transfers: t(180) }).flags[0];
  assert.equal(red.ruleKey, 'F1');
  assert.equal(red.severity, 'red');
  assert.match(red.explanation, /20 L \(10%\)/);
});

test('Q1: a phone record that waited in the offline queue is noted (info) for the reviewer', () => {
  const late = fill({ id: 'q', queuedForMs: 3 * 3600e3, meterReading: 5 });
  const out = rules.assetRules({ asset: BIKE, fills: [late] });
  const q1 = out.flags.find((f) => f.ruleKey === 'Q1');
  assert.equal(q1.severity, 'info');
  assert.match(q1.explanation, /3 h/);
  assert.ok(!rules.assetRules({ asset: BIKE, fills: [fill({ id: 'q', queuedForMs: 60000 })] }).flags.some((f) => f.ruleKey === 'Q1'));
  const loc = rules.locationQueuedNotes({ location: TANK, dips: [{ id: 'd', locationId: TANK.id, takenAt: T0, queuedForMs: 7200e3 }] });
  assert.equal(loc.flags[0].subject, 'dip:d');
});

test('USD cash is compared with a KHR price at the exchange rate; no price → an info flag, not silence', () => {
  // $3.66 at 4,100 KHR/USD = 15,006 KHR for 2.5 L shown → 6,002 KHR/L vs 4,000 posted.
  const usd = fill({ id: 'u', kind: 'cash_station', amountPaidMinor: 366, currency: 'USD', litresShownOnPump: 2.5, meterReading: 5, photoKinds: ['meter', 'pump_display'] });
  const out = rules.assetRules({ asset: BIKE, fills: [usd], priceFor: PRICE_4000, fxKhrPerUsd: 4100 });
  const c1 = out.flags.find((f) => f.ruleKey === 'C1');
  assert.equal(c1.severity, 'red');
  assert.equal(c1.unit, 'KHR/L');
  assert.match(c1.explanation, /\$3\.66 \(15,006 KHR at 4,100 KHR\/USD\)/);
  assert.ok(out.flags.some((f) => f.ruleKey === 'C2'));
  const noRate = rules.assetRules({ asset: BIKE, fills: [usd], priceFor: PRICE_4000, fxKhrPerUsd: null });
  assert.equal(noRate.flags.find((f) => f.ruleKey === 'C0').severity, 'info');
  assert.ok(!noRate.flags.some((f) => f.ruleKey === 'C1'));
  const noPrice = rules.assetRules({ asset: BIKE, fills: [usd], priceFor: () => null, fxKhrPerUsd: 4100 });
  assert.match(noPrice.flags.find((f) => f.ruleKey === 'C0').explanation, /No published/);
});
