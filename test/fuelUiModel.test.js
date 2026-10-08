/**
 * Fuel F1 desktop screens — the pure view model (renderer/modules/Fuel/fuelModel.js):
 * flag wording, the review queue, the paper-slip and correction forms, the dip
 * chart rules (kept identical to the server's), Phnom Penh dates, money in the
 * smallest unit, and the Settings → Fuel fields (kept in step with the
 * server's DEFAULT_SETTINGS / SETTING_RANGES). Plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');

function load(rel) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const req = createRequire(path.join(ROOT, 'package.json'));
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
}

const M = load('renderer/modules/Fuel/fuelModel.js');
const anomalies = require('../main/util/fuelAnomalies');
const { normalizeChart } = require('../main/util/tankCalibration');

const maps = (o = {}) => ({
  assets: new Map((o.assets || []).map((x) => [x.id, x])),
  locations: new Map((o.locations || []).map((x) => [x.id, x])),
  stations: new Map((o.stations || []).map((x) => [x.id, x])),
  staff: new Map((o.staff || []).map((x) => [x.id, x])),
});

/* ─── dates ───────────────────────────────────────────────────────────── */

test('Phnom Penh month and day keys do not follow the Mac\'s own zone', () => {
  // 2026-09-30 18:30 UTC is already 1 October in Phnom Penh (UTC+7).
  const ms = Date.UTC(2026, 8, 30, 18, 30);
  assert.equal(M.ppDateKey(ms), '2026-10-01');
  assert.equal(M.ppMonthKey(ms), '2026-10');
  assert.equal(anomalies.phnomPenhMonth(ms), M.ppMonthKey(ms));
});

test('monthRange matches the server\'s month range', () => {
  for (const key of ['2026-01', '2026-10', '2026-12', '2027-02']) {
    const mine = M.monthRange(key);
    const theirs = anomalies.monthRange(key);
    assert.equal(mine.from, theirs.start, `${key} start`);
    assert.equal(mine.to, theirs.end, `${key} end`);
  }
  assert.equal(M.monthRange('2026-13'), null);
  assert.equal(M.monthRange('nope'), null);
});

test('a datetime-local value is read and written as Phnom Penh time', () => {
  const ms = Date.UTC(2026, 9, 8, 3, 45); // 10:45 in Phnom Penh
  assert.equal(M.ppInputValue(ms), '2026-10-08T10:45');
  assert.equal(M.parsePpInput('2026-10-08T10:45'), ms);
  assert.equal(M.parsePpInput(''), null);
  assert.equal(M.parsePpInput('8 Oct'), null);
});

test('recentMonths lists newest first, across a year end', () => {
  const list = M.recentMonths(3, Date.UTC(2026, 0, 15));
  assert.deepEqual(list.map((m) => m.value), ['2026-01', '2025-12', '2025-11']);
});

/* ─── money and numbers ───────────────────────────────────────────────── */

test('riel is whole, US dollars are cents', () => {
  assert.equal(M.toMinor(15000, 'KHR'), 15000);
  assert.equal(M.toMinor(12.5, 'USD'), 1250);
  assert.equal(M.fromMinor(1250, 'USD'), 12.5);
  assert.equal(M.fmtMoney(15000, 'KHR'), '៛15,000');
  assert.equal(M.fmtMoney(1250, 'USD'), '$12.50');
  assert.equal(M.fmtRiel(-2500.4), '−៛2,500');
  assert.equal(M.fmtMoney(null, 'KHR'), '—');
});

test('parseNumber accepts thousands separators and rejects words', () => {
  assert.equal(M.parseNumber('1,234.5'), 1234.5);
  assert.equal(M.parseNumber(' 20 '), 20);
  assert.equal(M.parseNumber(''), null);
  assert.ok(Number.isNaN(M.parseNumber('twenty')));
  assert.ok(Number.isNaN(M.parseNumber('1.2.3')));
});

/* ─── flags ───────────────────────────────────────────────────────────── */

test('flag headlines say what happened in plain English', () => {
  const lk = maps({
    assets: [{ id: 'a1', name: 'Truck 3A' }],
    locations: [{ id: 't1', name: 'Warehouse tank' }],
    stations: [{ id: 's1', name: 'Tela NR4' }],
  });
  assert.equal(M.flagHeadline({ ruleKey: 'A1', assetId: 'a1', measured: 27, expected: 20 }, lk), 'Truck 3A used 35% more than normal');
  assert.equal(M.flagHeadline({ ruleKey: 'C1', assetId: 'a1', stationId: 's1', measured: 6000, expected: 4000 }, lk), 'Truck 3A: paid 50% above the posted price at Tela NR4');
  assert.equal(M.flagHeadline({ ruleKey: 'T1', locationId: 't1', measured: 2090, expected: 2230 }, lk), 'Warehouse tank: 140 L unaccounted for');
  assert.equal(M.flagHeadline({ ruleKey: 'T1', locationId: 't1', measured: 2300, expected: 2230 }, lk), 'Warehouse tank: 70 L more than recorded');
  assert.equal(M.flagHeadline({ ruleKey: 'T2', locationId: 't1', measured: 1950, expected: 2000 }, lk), 'Warehouse tank: delivery 50 L short');
  assert.equal(M.flagHeadline({ ruleKey: 'T3', locationId: 't1', measured: 3.6 }, lk), 'Warehouse tank has not been dipped for 3 days');
  assert.equal(M.flagHeadline({ ruleKey: 'A7', assetId: 'gone' }, lk), 'A vehicle or machine: a photo or reading is missing');
  assert.equal(M.flagHeadline({ ruleKey: 'Z9', explanation: 'Something new' }, lk), 'Something new');
});

test('every rule the server raises has a headline and a title', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'main/util/fuelAnomalies.js'), 'utf8');
  const raised = [...new Set([...src.matchAll(/flag\('([A-Z]\d+)'/g)].map((m) => m[1]))];
  assert.ok(raised.length >= 15, `found the server's rules (${raised})`);
  for (const key of raised) {
    assert.notEqual(M.ruleTitle(key), key, `${key} has a title`);
    const h = M.flagHeadline({ ruleKey: key, explanation: 'RAW' }, maps());
    assert.ok(h && h !== 'RAW', `${key} has its own headline`);
  }
});

test('flags sort red, then amber, then info; newest first within a colour', () => {
  const sorted = M.sortFlags([
    { id: 'a', severity: 'amber', at: 5 },
    { id: 'b', severity: 'red', at: 1 },
    { id: 'c', severity: 'info', at: 9 },
    { id: 'd', severity: 'red', at: 3 },
  ]);
  assert.deepEqual(sorted.map((f) => f.id), ['d', 'b', 'a', 'c']);
});

test('a flag answer needs a note, except "Theft confirmed"', () => {
  assert.match(M.flagReviewError('dismissed', ''), /note/);
  assert.equal(M.flagReviewError('dismissed', 'Receipt checked'), null);
  assert.equal(M.flagReviewError('confirmed', ''), null);
  assert.match(M.flagReviewError('explained', '  '), /note/);
  assert.deepEqual(M.FLAG_ACTIONS.map((a) => a.label), ['Checked — OK', 'Theft confirmed', 'Error corrected']);
});

/* ─── review queue ────────────────────────────────────────────────────── */

test('the review queue puts red flags first, then "needs review", then oldest', () => {
  const q = M.buildReviewQueue([
    { id: 'old', reviewStatus: 'new', at: 1 },
    { id: 'newer', reviewStatus: 'new', at: 5 },
    { id: 'nr', reviewStatus: 'needs_review', at: 9 },
    { id: 'red', reviewStatus: 'new', at: 10, hasRedFlag: true, openFlags: 1 },
    { id: 'amberFlag', reviewStatus: 'new', at: 7, openFlags: 2 },
    { id: 'done', reviewStatus: 'checked', at: 0 },
    { id: 'void', reviewStatus: 'new', voided: true, at: 0 },
    { id: 'old', reviewStatus: 'new', at: 1 },
  ]);
  assert.deepEqual(q.map((f) => f.id), ['red', 'nr', 'amberFlag', 'old', 'newer']);
});

/* ─── the paper-slip form ─────────────────────────────────────────────── */

const NOW = Date.UTC(2026, 9, 8, 5, 0);
const slip = (o) => ({ ...M.emptyFillForm(NOW - 3600_000), assetId: 'a1', locationId: 't1', ...o });

test('a tank fill needs a vehicle, a tank and the litres', () => {
  const { errors, payload } = M.validateFillForm({ ...M.emptyFillForm(NOW), assetId: '', locationId: '' }, { now: NOW });
  assert.equal(payload, null);
  assert.ok(errors.assetId && errors.locationId && errors.litres);
});

test('a tank fill builds the recordFill input', () => {
  const { errors, payload } = M.validateFillForm(slip({ litres: '45.5', meterReading: '120,450', driverEmployeeId: 'd1', note: ' slip 12 ' }), { now: NOW });
  assert.deepEqual(errors, {});
  assert.equal(payload.kind, 'warehouse_tank');
  assert.equal(payload.litres, 45.5);
  assert.equal(payload.meterReading, 120450);
  assert.equal(payload.driverEmployeeId, 'd1');
  assert.equal(payload.note, 'slip 12');
  assert.equal(payload.source, 'mac');
  assert.equal(payload.at, NOW - 3600_000);
  assert.equal(payload.fullTank, true);
  assert.equal('stationId' in payload, false);
});

test('with a flow meter the two pump readings can stand in for the litres', () => {
  const ctx = { now: NOW, location: { hasFlowMeter: true } };
  const ok = M.validateFillForm(slip({ pumpMeterBefore: '1000', pumpMeterAfter: '1040' }), ctx);
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.payload.pumpMeterBefore, 1000);
  assert.equal(ok.payload.pumpMeterAfter, 1040);
  const half = M.validateFillForm(slip({ pumpMeterBefore: '1000' }), ctx);
  assert.match(half.errors.pumpMeterAfter, /both/);
  const backwards = M.validateFillForm(slip({ pumpMeterBefore: '1040', pumpMeterAfter: '1000' }), ctx);
  assert.match(backwards.errors.pumpMeterAfter, /higher/);
  // Without a flow meter the readings are not sent at all.
  const noMeter = M.validateFillForm(slip({ litres: '20', pumpMeterBefore: '1', pumpMeterAfter: '2' }), { now: NOW });
  assert.equal('pumpMeterBefore' in noMeter.payload, false);
});

test('a cash fill needs the station and the amount; litres are optional', () => {
  const bad = M.validateFillForm(slip({ kind: 'cash_station', locationId: '' }), { now: NOW });
  assert.ok(bad.errors.stationId && bad.errors.amountPaid);
  assert.equal(bad.errors.litres, undefined);
  const ok = M.validateFillForm(slip({ kind: 'cash_station', stationName: '  Tela NR4 ', amountPaid: '15,000', litresShownOnPump: '2.5' }), { now: NOW });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.payload.stationName, 'Tela NR4');
  assert.equal(ok.payload.amountPaidMinor, 15000);
  assert.equal(ok.payload.currency, 'KHR');
  assert.equal(ok.payload.litresShownOnPump, 2.5);
  assert.equal('locationId' in ok.payload, false);
  const usd = M.validateFillForm(slip({ kind: 'cash_station', stationId: 's1', amountPaid: '3.75', currency: 'USD' }), { now: NOW });
  assert.equal(usd.payload.amountPaidMinor, 375);
});

test('the slip time cannot be in the future, and numbers must be numbers', () => {
  const r = M.validateFillForm(slip({ litres: 'ten', at: M.ppInputValue(NOW + 2 * 3600_000) }), { now: NOW });
  assert.match(r.errors.at, /future/);
  assert.match(r.errors.litres, /number/);
  const cans = M.validateFillForm(slip({ cansCount: '2.5' }), { now: NOW });
  assert.match(cans.errors.cansCount, /whole/);
});

test('far more litres than the tank holds is caught before sending', () => {
  const r = M.validateFillForm(slip({ litres: '400' }), { now: NOW, asset: { tankCapacityL: 60 } });
  assert.match(r.errors.litres, /60 L/);
});

/* ─── corrections ─────────────────────────────────────────────────────── */

test('a correction sends only what changed', () => {
  const fill = {
    id: 'f1', assetId: 'a1', driverEmployeeId: 'd1', attendantEmployeeId: null, at: Date.UTC(2026, 9, 8, 1, 0),
    typedLitres: 40, meterReading: 45120, fullTank: true, pumpMeterBefore: null, pumpMeterAfter: null,
    amountPaidMinor: null, currency: null, litresShownOnPump: null, note: null,
  };
  const form = M.fillToCorrectionForm(fill);
  assert.deepEqual(M.diffFillCorrection(fill, form).patch, {});
  const changed = M.diffFillCorrection(fill, { ...form, meterReading: '45,210', fullTank: false });
  assert.deepEqual(changed.patch, { meterReading: 45210, fullTank: false });
  const cleared = M.diffFillCorrection(fill, { ...form, driverEmployeeId: '' });
  assert.deepEqual(cleared.patch, { driverEmployeeId: null });
  assert.ok(M.diffFillCorrection(fill, { ...form, assetId: '' }).errors.assetId);
  assert.ok(M.diffFillCorrection(fill, { ...form, litres: 'x' }).errors.litres);
});

test('a cash correction converts the amount to the fill\'s currency', () => {
  const fill = { id: 'f2', assetId: 'a1', at: 1, amountPaidMinor: 1500, currency: 'USD', fullTank: false };
  const form = M.fillToCorrectionForm(fill);
  assert.equal(form.amountPaid, '15');
  assert.deepEqual(M.diffFillCorrection(fill, { ...form, amountPaid: '12.25' }).patch, { amountPaidMinor: 1225 });
});

/* ─── dip chart ───────────────────────────────────────────────────────── */

test('a chart pasted from Excel (tabs), CSV or spaces is read; a header is skipped', () => {
  const { points, errors } = M.parseChartText('cm\tlitres\n0\t0\n10\t180\n20, 420\n30 700\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(points, [{ dipCm: 0, litres: 0 }, { dipCm: 10, litres: 180 }, { dipCm: 20, litres: 420 }, { dipCm: 30, litres: 700 }]);
  assert.match(M.parseChartText('0 0\n10\n').errors[0], /Line 2/);
});

test('chart rules match the server\'s normalizeChart', () => {
  const cases = [
    [{ dipCm: 0, litres: 0 }, { dipCm: 10, litres: 180 }],
    [{ dipCm: 0, litres: 0 }],
    [{ dipCm: 0, litres: 0 }, { dipCm: 0, litres: 10 }],
    [{ dipCm: 0, litres: 0 }, { dipCm: 10, litres: 100 }, { dipCm: 20, litres: 50 }],
    [{ dipCm: 0, litres: 1000 }, { dipCm: 10, litres: 800 }],
    [{ dipCm: 0, litres: 5 }, { dipCm: 10, litres: 5 }],
    [{ dipCm: -1, litres: 0 }, { dipCm: 10, litres: 5 }],
  ];
  for (const pts of cases) {
    let serverOk = true;
    try { normalizeChart(pts); } catch { serverOk = false; }
    const mine = M.chartError(pts.map((p) => ({ dipCm: String(p.dipCm), litres: String(p.litres) })));
    assert.equal(mine === null, serverOk, `${JSON.stringify(pts)}: ui says ${mine}`);
  }
  assert.deepEqual(M.chartPoints([{ dipCm: '20', litres: '420' }, { dipCm: '0', litres: '0' }, { dipCm: '', litres: '' }]),
    [{ dipCm: 0, litres: 0 }, { dipCm: 20, litres: 420 }]);
});

/* ─── tanks ───────────────────────────────────────────────────────────── */

test('between two dips: missing beyond the tolerance is red, extra is amber', () => {
  assert.equal(M.intervalVerdict({ variance: -140, tolerance: 30 }), 'red');
  assert.equal(M.intervalVerdict({ variance: 45, tolerance: 30 }), 'amber');
  assert.equal(M.intervalVerdict({ variance: -20, tolerance: 30 }), 'ok');
  assert.equal(M.intervalVerdict({}), 'unknown');
});

test('a dip older than the rule is stale; no dip at all is too', () => {
  const now = Date.UTC(2026, 9, 8);
  assert.deepEqual(M.dipAge({ takenAt: now - 3.5 * 86_400_000 }, 2, now), { days: 3, stale: true, never: false });
  assert.deepEqual(M.dipAge({ takenAt: now - 86_400_000 }, 2, now), { days: 1, stale: false, never: false });
  assert.equal(M.dipAge(null, 2, now).never, true);
});

/* ─── reports ─────────────────────────────────────────────────────────── */

test('drivers rank by excess riel; unknown excess last', () => {
  const r = M.rankDrivers([
    { name: 'B', excessRiel: null },
    { name: 'C', excessRiel: 100000 },
    { name: 'A', excessRiel: -5000 },
    { name: 'D', excessRiel: 250000 },
  ]);
  assert.deepEqual(r.map((d) => d.name), ['D', 'C', 'A', 'B']);
});

/* ─── Settings → Fuel ─────────────────────────────────────────────────── */

test('every server threshold is on the Settings → Fuel page with the same default and range', () => {
  const keys = M.FUEL_SETTING_FIELDS.map((f) => f.key).sort();
  const serverKeys = Object.keys(anomalies.SETTING_RANGES).sort();
  assert.deepEqual(keys, serverKeys);
  for (const f of M.FUEL_SETTING_FIELDS) {
    assert.equal(f.def, anomalies.DEFAULT_SETTINGS[f.key], `${f.key} default`);
    assert.deepEqual(f.range, anomalies.SETTING_RANGES[f.key], `${f.key} range`);
    assert.ok(f.label && f.unit, `${f.key} has a plain label and a unit`);
  }
});

test('ratios are shown as "% over" and written back as ratios', () => {
  const a1 = M.FUEL_SETTING_FIELDS.find((f) => f.key === 'a1AmberRatio');
  assert.equal(M.settingToDisplay(a1, 1.2), '20');
  assert.deepEqual(M.displayToSetting(a1, '35'), { value: 1.35 });
  assert.match(M.displayToSetting(a1, '600').error, /0 to 400/);
  const days = M.FUEL_SETTING_FIELDS.find((f) => f.key === 'missedDipDays');
  assert.deepEqual(M.displayToSetting(days, '3'), { value: 3 });
  assert.match(M.displayToSetting(days, '0').error, /1 to 60/);
  assert.match(M.displayToSetting(days, 'x').error, /number/);
  // What the field writes is accepted by the server's own check.
  assert.doesNotThrow(() => anomalies.sanitizeSettingsPatch({ a1AmberRatio: M.displayToSetting(a1, '35').value }));
});

/* ─── photos and errors ───────────────────────────────────────────────── */

test('photo bytes in any IPC shape become a Uint8Array', () => {
  const u = new Uint8Array([1, 2, 3]);
  assert.equal(M.toUint8(u), u);
  assert.deepEqual([...M.toUint8(u.buffer)], [1, 2, 3]);
  assert.deepEqual([...M.toUint8(Buffer.from([4, 5]))], [4, 5]);
  assert.deepEqual([...M.toUint8({ type: 'Buffer', data: [6] })], [6]);
  assert.equal(M.toUint8(null), null);
});

test('picked photos: pictures only, at most six, 15 MB each', () => {
  assert.equal(M.photoFileError({ type: 'image/jpeg', size: 1000 }, 0), null);
  assert.match(M.photoFileError({ type: 'application/pdf', size: 10 }, 0), /picture/);
  assert.match(M.photoFileError({ type: 'image/png', size: 16 * 1024 * 1024 }, 0), /15 MB/);
  assert.match(M.photoFileError({ type: 'image/png', size: 10 }, 6), /6 photos/);
});

test('an edit conflict reads as a sentence, not CONFLICT|{json}', () => {
  assert.match(M.errText(new Error('CONFLICT|{"kind":"fuel_asset"}')), /Someone else changed this/);
  assert.equal(M.errText(new Error('Pick the tank')), 'Pick the tank');
});

test('simple record forms point at the missing field', () => {
  assert.deepEqual(Object.keys(M.validateAssetForm({ name: ' ', typeId: '', tankCapacityL: '-1' })).sort(), ['name', 'tankCapacityL', 'typeId']);
  assert.deepEqual(M.validateAssetForm({ name: 'Truck 3A', typeId: 't', tankCapacityL: '120', baselineRate: '' }), {});
  assert.ok(M.validateStaffForm({ staffCode: '', nameEn: '', nameKm: '' }).staffCode);
  assert.deepEqual(M.validateStaffForm({ staffCode: 'D01', nameEn: '', nameKm: 'សុខា' }), {});
  assert.equal(M.staffName({ nameEn: 'Sokha', nameKm: 'សុខា' }), 'Sokha (សុខា)');
});
