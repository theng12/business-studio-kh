/**
 * Fuel F1: monthly reports (main/util/fuelReports.js) and the workbook
 * (main/util/fuelWorkbook.js) — pure, plain `npm test`.
 *
 * The month of the §4.3 worked example: about 20 padded cash fills — each
 * claims 3.75 L (15,000 KHR at 4,000 KHR/L) while the bike burns 2.5 L per
 * 100 km — come to ≈ 25 L and ≈ 100,000 KHR excess for that driver, while a
 * driver on an honest bike shows none.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const rules = require('../main/util/fuelAnomalies');
const { buildMonthlyReport } = require('../main/util/fuelReports');
const { buildFuelWorkbook } = require('../main/util/fuelWorkbook');

const DAY = 24 * 60 * 60 * 1000;
const OCT1 = rules.monthRange('2026-10').start;
const BIKE = { id: 'bike', name: 'Honda 1', meterUnit: 'km', tankCapacityL: 5, baselineRate: 2.5, baselineSource: 'manual', fuelType: 'gasoline', typeName: 'Motorbike' };
const BIKE2 = { ...BIKE, id: 'bike2', name: 'Honda 2' };
const PRICE = () => ({ priceMinorPerL: 4000, currency: 'KHR' });

function monthOfFills(assetId, driver, litres) {
  const fills = [{ id: `${assetId}-0`, rootId: `${assetId}-0`, kind: 'warehouse_tank', locationId: 'tank', assetId, driverEmployeeId: driver,
    at: OCT1 - DAY, litres: 2.5, fullTank: true, meterReading: 1000, valueRiel: 10000, photoKinds: ['meter'] }];
  for (let i = 1; i <= 20; i += 1) {
    fills.push({
      id: `${assetId}-${i}`, rootId: `${assetId}-${i}`, kind: 'cash_station', stationId: 'st', assetId, driverEmployeeId: driver,
      at: OCT1 + i * DAY, litres, fullTank: true, meterReading: 1000 + 100 * i, amountPaidMinor: litres * 4000, currency: 'KHR',
      valueRiel: litres * 4000, photoKinds: ['meter'],
    });
  }
  return fills;
}

function report() {
  const padded = monthOfFills('bike', 'x', 3.75);
  const honest = monthOfFills('bike2', 'y', 2.5);
  const assetResults = new Map([
    ['bike', rules.assetRules({ asset: BIKE, fills: padded, priceFor: PRICE })],
    ['bike2', rules.assetRules({ asset: BIKE2, fills: honest, priceFor: PRICE })],
  ]);
  const tankResults = new Map([['tank', {
    intervals: [{ fromDipId: 'd0', toDipId: 'd1', fromAt: OCT1, toAt: OCT1 + 4 * DAY, startLitres: 1850, delivered: 2000, received: 0, filled: 1420, sent: 200, expected: 2230, measured: 2090, variance: -140, tolerance: 30.1, fillsByAttendant: {} }],
    checks: [],
  }]]);
  return {
    out: buildMonthlyReport({
      month: '2026-10',
      assets: [BIKE, BIKE2],
      employees: [{ id: 'x', staffCode: 'D01', nameEn: 'Driver X' }, { id: 'y', staffCode: 'D02', nameEn: 'Driver Y', nameKm: 'អ្នកបើកបរ' }],
      locations: [{ id: 'tank', name: 'Warehouse tank', kind: 'tank' }],
      fills: [...padded, ...honest],
      assetResults, tankResults,
      flags: [{ ruleKey: 'A1', severity: 'red', status: 'open', period: '2026-10', assetId: 'bike', employeeId: 'x', at: OCT1 + DAY }],
    }),
    padded, honest,
  };
}

test('per asset: excess_L = litres − distance × baseline ÷ 100, in litres and riel', () => {
  const { out } = report();
  const bike = out.assets.find((a) => a.assetId === 'bike');
  assert.equal(bike.distance, 2000);
  assert.equal(bike.litres, 75);
  assert.equal(bike.expectedLitres, 50);
  assert.equal(bike.excessLitres, 25);
  assert.equal(bike.excessRiel, 100000);
  assert.equal(bike.actualRate, 3.75);
  assert.equal(bike.baseline, 2.5);
  assert.equal(bike.litresByKind.cash_station, 75);
  assert.deepEqual(bike.cashPaid, { KHR: 300000 });
  assert.equal(bike.openFlags, 1);
  assert.equal(bike.redFlags, 1);
  assert.equal(bike.costPerUnitRiel, 150);
  const honest = out.assets.find((a) => a.assetId === 'bike2');
  assert.equal(honest.excessLitres, 0);
  assert.equal(honest.excessRiel, 0);
  // Ranked by excess riel.
  assert.equal(out.assets[0].assetId, 'bike');
  assert.equal(out.totals.excessRiel, 100000);
});

test('per driver: the same summed over the assets they used, ranked by excess riel', () => {
  const { out } = report();
  assert.equal(out.drivers[0].employeeId, 'x');
  assert.equal(out.drivers[0].name, 'Driver X');
  assert.equal(out.drivers[0].excessLitres, 25);
  assert.equal(out.drivers[0].excessRiel, 100000);
  assert.equal(out.drivers[0].distanceKm, 2000);
  assert.equal(out.drivers[0].openFlags, 1);
  const y = out.drivers.find((d) => d.employeeId === 'y');
  assert.equal(y.name, 'Driver Y (អ្នកបើកបរ)');
  assert.equal(y.excessRiel, 0);
});

test('per tank: dip-to-dip variance carried into the month', () => {
  const { out } = report();
  // Only intervals ending in the month are counted; this tank had no fills in our fixture rows.
  const t = out.tanks.find((x) => x.locationId === 'tank');
  assert.equal(t.varianceTotal, -140);
  assert.equal(t.intervals.length, 1);
});

test('the workbook has one sheet per view and the numbers match the report', () => {
  const { out, padded, honest } = report();
  const { filename, bytes } = buildFuelWorkbook(out, {
    fills: [...padded, ...honest], flags: [], assets: [BIKE, BIKE2], employees: [], locations: [], stations: [], companyName: 'Siem Reap Farm',
  });
  assert.equal(filename, 'fuel-siem-reap-farm-2026-10.xlsx');
  const wb = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Per asset', 'Per driver', 'Tanks', 'Fills', 'Flags', 'Notes']);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Per asset'], { header: 1 });
  assert.equal(rows[1][0], 'Honda 1');
  assert.equal(rows[1][18], 100000);
  const fills = XLSX.utils.sheet_to_json(wb.Sheets.Fills, { header: 1 });
  assert.equal(fills.length, 1 + 42);
});

/* ─── realistic-data review (2026-10-08) ─── */

test('R1: a vehicle\'s first fill of the month (no full fill before it) adds no excess', () => {
  const truck = { id: 'tk', name: 'Truck', meterUnit: 'km', baselineRate: 20 };
  const fills = [
    { id: 'a', rootId: 'a', kind: 'warehouse_tank', assetId: 'tk', at: OCT1 + DAY, litres: 120, fullTank: true, meterReading: 5000, valueRiel: 480000, driverEmployeeId: 'y' },
    { id: 'b', rootId: 'b', kind: 'warehouse_tank', assetId: 'tk', at: OCT1 + 5 * DAY, litres: 100, fullTank: true, meterReading: 5500, valueRiel: 400000, driverEmployeeId: 'y' },
  ];
  const assetResults = new Map([['tk', rules.assetRules({ asset: truck, fills })]]);
  const out = buildMonthlyReport({ month: '2026-10', assets: [truck], fills, assetResults });
  const row = out.assets[0];
  assert.equal(row.litres, 220, 'all litres are shown');
  assert.equal(row.expectedLitres, 100, '500 km × 20 L/100 km over the one complete interval');
  assert.equal(row.excessLitres, 0, 'the opening 120 L is not "excess"');
});

test('R2: drivers are ranked by suspected loss — cash above the posted price + fuel beyond normal variation', () => {
  const { out } = report();
  const x = out.drivers.find((d) => d.employeeId === 'x');
  // 20 intervals of 3.75 L where 2.5 L is normal: above 2.5 × 1.2 = 3.0 L → 0.75 L each = 15 L at 4,000 KHR/L.
  assert.equal(x.suspectedExcessLitres, 15);
  assert.equal(x.suspectedLossRiel, 60000);
  // A honest driver whose vehicle runs a few % over its owner-set figure adds nothing.
  const truck = { id: 'tk', name: 'Truck', meterUnit: 'km', baselineRate: 20 };
  const fills = [];
  for (let i = 0; i <= 10; i += 1) {
    fills.push({ id: `t${i}`, rootId: `t${i}`, kind: 'warehouse_tank', assetId: 'tk', at: OCT1 + i * DAY + 1000, litres: 107, fullTank: true, meterReading: 500 * i, valueRiel: 428000, driverEmployeeId: 'heng' });
  }
  fills.push({ id: 'c1', rootId: 'c1', kind: 'cash_station', assetId: 'bike', at: OCT1 + 2 * DAY, litres: 2.5, fullTank: false, amountPaidMinor: 15000, currency: 'KHR', litresShownOnPump: 2.5, valueRiel: 15000, overpaidRiel: 5000, driverEmployeeId: 'ratha' });
  const assetResults = new Map([['tk', rules.assetRules({ asset: truck, fills: fills.filter((f) => f.assetId === 'tk') })]]);
  const r = buildMonthlyReport({ month: '2026-10', assets: [truck, BIKE], fills, assetResults, employees: [{ id: 'heng', nameEn: 'Heng Sovann' }, { id: 'ratha', nameEn: 'Nhem Ratha' }] });
  const heng = r.drivers.find((d) => d.employeeId === 'heng');
  assert.ok(heng.excessLitres > 60, 'the 7 % over the owner\'s figure still shows as excess litres');
  assert.equal(heng.suspectedLossRiel, 0);
  assert.equal(r.drivers[0].name, 'Nhem Ratha');
  assert.equal(r.drivers[0].cashOverpaidRiel, 5000);
});

test('D2: the month\'s flags are listed whatever their status (a gap closed by a later dip, a reviewed flag)', () => {
  const r = buildMonthlyReport({
    month: '2026-10',
    flags: [
      { ruleKey: 'T3', severity: 'amber', status: 'open', resolved: false, period: '2026-10', at: OCT1 },
      { ruleKey: 'T3', severity: 'amber', status: 'explained', resolved: true, period: '2026-10', at: OCT1 + DAY },
    ],
  });
  const t3 = r.flags.find((f) => f.ruleKey === 'T3');
  assert.equal(t3.total, 2);
  assert.equal(t3.open, 1);
  assert.equal(t3.explained, 1);
  assert.equal(t3.resolved, 1);
  assert.deepEqual(r.flagList.map((f) => f.status), ['open', 'explained']);
});
