/**
 * Fuel F1 against a real database and a real data folder.
 *
 * Pins the properties that only show up with SQLite and files:
 *   1. The schema is additive and idempotent (initDb twice), SCHEMA_VERSION untouched.
 *   2. Staff: unique code per company, mark-left (no delete), audit rows.
 *   3. The §4.1 worked example through the tables: the T1 flag is stored, and
 *      re-running the rules never duplicates it nor loses its review — a flag
 *      that stops firing is resolved, and if it fires again it comes back with
 *      its review intact.
 *   4. client_ref makes uploads idempotent.
 *   5. The §4.3 cash case: C1, C2 and A7 fire; adding the photos clears A7.
 *   6. Pump flow meter: litres come from the meter; M1 and M2 fire.
 *   7. A correction is a new revision; a void keeps the row.
 *   8. History blocks company deletion (in words, and at the SQLite level);
 *      a company with only configuration can still be deleted.
 *   9. Photos are resized, hashed, stored under fuel/<yyyy-mm>/ (not assets/),
 *      and retention moves old ones to Recently deleted, from where they restore.
 *  10. The monthly report and workbook build from the tables.
 *
 * RUNNING THIS. Real SQLite + real files: `npm run test:native`.
 * Under plain `npm test` these cases SKIP with that command as the reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
} catch (err) {
  if (err && (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err.message)))) {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

const DAY = 24 * 60 * 60 * 1000;
let counter = 0;

function fixture() {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-fuel-${counter}-`));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: `Farm ${counter}`, isActive: true });
  return { dataDir, company };
}

function mods() {
  return {
    companies: require('../main/db/companies'),
    employees: require('../main/db/employees'),
    fuel: require('../main/db/fuel'),
    records: require('../main/db/fuelRecords'),
    flags: require('../main/db/fuelFlags'),
    reports: require('../main/db/fuelReports'),
    history: require('../main/db/fuelHistory'),
    photos: require('../main/fuelPhotos'),
    deleted: require('../main/deletedItems'),
    rules: require('../main/util/fuelAnomalies'),
  };
}

const ULLAGE = [
  { dipCm: 0, litres: 3500 }, { dipCm: 95, litres: 2156 }, { dipCm: 100, litres: 2046 },
  { dipCm: 120, litres: 1850 }, { dipCm: 200, litres: 0 },
];

async function jpeg(width = 3000, height = 2000) {
  const sharp = require('sharp');
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
}

test('schema is additive and idempotent; SCHEMA_VERSION stays 2', { skip: skipReason }, () => {
  const { dataDir } = fixture();
  db.closeDb();
  db.initDb(dataDir); // second boot over the same file
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['employees', 'fuel_asset_types', 'fuel_assets', 'fuel_meter_resets', 'fuel_stock_locations', 'fuel_tank_calibration',
    'fuel_dips', 'fuel_deliveries', 'fuel_transfers', 'fuel_stations', 'fuel_prices', 'fuel_fills', 'fuel_photos', 'fuel_flags', 'fuel_settings']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.equal(db.SCHEMA_VERSION, 2);
  assert.equal(db.getAppState('schema_version'), '2');
});

test('staff list: unique code per company, mark left instead of delete, audited', { skip: skipReason }, () => {
  const { company } = fixture();
  const { employees } = mods();
  const a = employees.create({ companyId: company.id, staffCode: 'D01', nameEn: 'Sok', nameKm: 'សុខ', isDriver: true });
  assert.throws(() => employees.create({ companyId: company.id, staffCode: 'd01', nameEn: 'Dara' }), /already used/);
  assert.throws(() => employees.create({ companyId: company.id, staffCode: 'D02' }), /name/);
  employees.create({ companyId: company.id, staffCode: 'A01', nameEn: 'Pisey', isFuelAttendant: true });
  assert.deepEqual(employees.list(company.id, { role: 'driver' }).map((e) => e.staffCode), ['D01']);
  const updated = employees.update(a.id, { phone: '012 345 678' });
  assert.equal(updated.phone, '012 345 678');
  const left = employees.markLeft(a.id, { reason: 'Moved to Phnom Penh' });
  assert.equal(left.status, 'left');
  assert.ok(employees.get(a.id), 'never deleted');
  const actions = db.getDb().prepare("SELECT action FROM audit_log WHERE entity_type = 'employee' AND entity_id = ? ORDER BY id").all(a.id).map((r) => r.action);
  assert.deepEqual(actions, ['create', 'update', 'mark-left']);
});

function setupTank(companyId, fuel, extra = {}) {
  const loc = fuel.createLocation({ companyId, name: extra.name || 'Warehouse tank', kind: 'tank', capacityL: 5000, hasFlowMeter: !!extra.hasFlowMeter });
  fuel.setChart(loc.id, ULLAGE);
  return loc;
}

function setupTruck(companyId, fuel, over = {}) {
  const types = fuel.listAssetTypes(companyId);
  assert.equal(types.length, 8, 'eight built-in types');
  const truck = types.find((t) => t.builtinKey === over.type || t.builtinKey === 'truck');
  return fuel.createAsset({ companyId, typeId: truck.id, name: over.name || 'Truck 1', tankCapacityL: over.capacity ?? 200, baselineRate: over.baseline ?? 25, ...over.extra });
}

test('§4.1 worked example through the tables; re-running never duplicates or loses a review', { skip: skipReason }, () => {
  const { company } = fixture();
  const { fuel, records, flags } = mods();
  const tank = setupTank(company.id, fuel);
  const farm = fuel.createLocation({ companyId: company.id, name: 'Farm store', kind: 'farm_store' });
  const truck = setupTruck(company.id, fuel);
  const t0 = Date.now() - 6 * DAY;
  const d0 = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 120, at: t0 }).dip;
  assert.equal(d0.litres, 1850);
  records.createDelivery({ companyId: company.id, locationId: tank.id, litresInvoiced: 2000, at: t0 + DAY, priceMinorPerL: 4000 });
  records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 700, at: t0 + DAY + 60000 });
  const f2 = records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 720, at: t0 + 2 * DAY }).fill;
  records.createTransfer({ companyId: company.id, fromLocationId: tank.id, toLocationId: farm.id, litresSent: 200, at: t0 + 3 * DAY });
  const d1 = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 98, at: t0 + 4 * DAY }).dip;
  assert.equal(d1.litres, 2090);

  flags.recomputeLocation(tank.id);
  const t1 = () => db.getDb().prepare("SELECT * FROM fuel_flags WHERE rule_key = 'T1'").all();
  assert.equal(t1().length, 1);
  assert.equal(t1()[0].severity, 'red');
  assert.equal(t1()[0].subject, `dips:${d0.id}:${d1.id}`);
  assert.equal(t1()[0].measured, 2090);
  assert.equal(t1()[0].expected, 2230);

  const flag = flags.listFlags(company.id, { ruleKey: 'T1' }).items[0];
  flags.reviewFlag(flag.id, { status: 'explained', note: 'Generator fill not written down' });
  flags.recomputeLocation(tank.id);
  flags.recomputeAll({ companyId: company.id });
  assert.equal(t1().length, 1, 're-running never duplicates');
  assert.equal(t1()[0].status, 'explained', 're-running never loses the review');

  // Correct the 720 L fill to 860 L (the missing 140 L was dispensed, just not
  // written down): the books now balance → the flag resolves, review kept.
  records.correctFill(f2.id, { litres: 860 }, 'Slip misread');
  flags.recomputeLocation(tank.id);
  assert.ok(t1()[0].resolved_at, 'resolved when it stops firing');
  assert.equal(t1()[0].status, 'explained');
  // And back: it fires again on the same row, review still there.
  records.correctFill(f2.id, { litres: 720 }, 'Slip was right after all');
  flags.recomputeLocation(tank.id);
  assert.equal(t1().length, 1);
  assert.equal(t1()[0].resolved_at, null);
  assert.equal(t1()[0].status, 'explained');
  assert.equal(t1()[0].review_note, 'Generator fill not written down');
});

test('client_ref: a retried upload never makes a second row', { skip: skipReason }, () => {
  const { company } = fixture();
  const { fuel, records } = mods();
  const tank = setupTank(company.id, fuel);
  const truck = setupTruck(company.id, fuel);
  const input = { companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 40, clientRef: 'phone-7:abc123', source: 'phone' };
  const a = records.createFill(input);
  const b = records.createFill(input);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.fill.id, a.fill.id);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM fuel_fills').get().n, 1);
  const d1 = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 100, clientRef: 'phone-7:dip001' });
  const d2 = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 100, clientRef: 'phone-7:dip001' });
  assert.equal(d2.duplicate, true);
  assert.equal(d2.dip.id, d1.dip.id);
  // Phone records use the server clock, whatever time the phone sent.
  const phone = records.createFill({ ...input, clientRef: 'phone-7:abc124', at: 1000 });
  assert.ok(Math.abs(phone.fill.at - Date.now()) < 60000);
});

test('§4.3 cash case through the tables: C1 + C2 red, A7 until the photos arrive', { skip: skipReason }, async () => {
  const { company } = fixture();
  const { fuel, records, flags, photos } = mods();
  const types = fuel.listAssetTypes(company.id);
  const bike = fuel.createAsset({ companyId: company.id, typeId: types.find((t) => t.builtinKey === 'motorbike').id, name: 'Honda 1', tankCapacityL: 3.5, baselineRate: 2.5 });
  assert.equal(bike.meterUnit, 'km');
  assert.equal(bike.fuelType, 'gasoline');
  fuel.setPrice({ companyId: company.id, fuelType: 'gasoline', priceMinorPerL: 4000, effectiveFrom: '2026-01-01', sourceNote: 'arithmetic only' });
  assert.equal(fuel.priceOn(company.id, 'gasoline', Date.now()).priceMinorPerL, 4000);
  const { fill } = records.createFill({
    companyId: company.id, kind: 'cash_station', assetId: bike.id, stationName: 'Tela Sen Sok', amountPaidMinor: 15000,
    litresShownOnPump: 2.5, meterReading: 1100, fullTank: true,
  });
  assert.equal(fill.litres, 2.5);
  assert.equal(fill.litresSource, 'pump_display');
  assert.equal(fill.currency, 'KHR');
  flags.recomputeAsset(bike.id);
  const open = () => flags.listFlags(company.id, { assetId: bike.id }).items.map((f) => `${f.ruleKey}:${f.severity}`).sort();
  assert.deepEqual(open(), ['A7:amber', 'C1:red', 'C2:red']);

  // The photos arrive: A7 resolves.
  const shot = await jpeg();
  const prepared = await photos.prepareUploads('fill', [{ kind: 'meter', bytes: shot }, { kind: 'pump_display', bytes: shot }]);
  const staged = photos.stagePhotos({ recordId: fill.rootId, at: fill.at, photos: prepared });
  for (const row of staged.rows) records.insertPhotoRow({ ...row, companyId: company.id, ownerKind: 'fill', ownerId: fill.rootId });
  staged.commit();
  flags.recomputeAsset(bike.id);
  assert.deepEqual(open(), ['C1:red', 'C2:red']);

  // Without the litres shown, litres are worked out from the price (15,000 ÷ 4,000 = 3.75 L).
  const derived = records.createFill({ companyId: company.id, kind: 'cash_station', assetId: bike.id, stationName: 'tela sen sok', amountPaidMinor: 15000, meterReading: 1200 }).fill;
  assert.equal(derived.litres, 3.75);
  assert.equal(derived.litresSource, 'derived_from_price');
  assert.equal(derived.stationId, fill.stationId, 'station names match case-insensitively');
  // The reviewer reads the pump photo: 10,000 KHR → C5.
  records.reviewFill(fill.id, { status: 'needs_review', reviewedAmountMinor: 10000, reviewedLitres: 2.5 });
  flags.recomputeAsset(bike.id);
  assert.ok(open().includes('C5:red'));
});

test('pump flow meter: litres from the meter; M1 disagreement and M2 gap', { skip: skipReason }, () => {
  const { company } = fixture();
  const { fuel, records, flags } = mods();
  const tank = setupTank(company.id, fuel, { hasFlowMeter: true });
  const truck = setupTruck(company.id, fuel);
  const t = Date.now() - DAY;
  const a = records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, pumpMeterBefore: 100, pumpMeterAfter: 140, litres: 40, at: t }).fill;
  assert.equal(a.litres, 40);
  assert.equal(a.litresSource, 'pump_meter');
  const b = records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, pumpMeterBefore: 150, pumpMeterAfter: 180, litres: 35, at: t + 1000 }).fill;
  assert.equal(b.litres, 30, 'the meter wins over the typed 35');
  assert.equal(b.typedLitres, 35);
  flags.recomputeLocation(tank.id);
  const keys = flags.listFlags(company.id, { locationId: tank.id }).items.map((f) => f.ruleKey).sort();
  assert.ok(keys.includes('M1'));
  assert.ok(keys.includes('M2'));
  assert.throws(() => records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, pumpMeterBefore: 200 }), /both pump meter readings/);
});

test('a correction is a new revision; a void keeps the row; reasons are required', { skip: skipReason }, () => {
  const { company } = fixture();
  const { fuel, records } = mods();
  const tank = setupTank(company.id, fuel);
  const truck = setupTruck(company.id, fuel);
  const { fill } = records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 50 });
  assert.throws(() => records.correctFill(fill.id, { litres: 45 }, ''), /reason/);
  const next = records.correctFill(fill.id, { litres: 45 }, 'Typo');
  assert.equal(next.rootId, fill.id);
  assert.equal(next.supersedesId, fill.id);
  assert.equal(next.reviewStatus, 'checked');
  assert.equal(records.getFill(fill.id).superseded, true);
  assert.equal(records.listFills(company.id).total, 1);
  assert.equal(records.listRevisions(fill.id).length, 2);
  assert.throws(() => records.voidRecord('fill', fill.id, ''), /reason/);
  // The Mac's own window has no caller, so "void my own" cannot apply to it.
  assert.throws(() => records.voidRecord('fill', fill.id, 'oops', { ownOnly: true }), /entered yourself/);
  const v = records.voidRecord('fill', fill.id, 'Duplicate slip');
  assert.equal(v.voided, true);
  assert.equal(records.listFills(company.id).total, 0);
  assert.equal(records.listFills(company.id, { includeVoided: true, includeSuperseded: true }).total, 2, 'nothing deleted');
});

test('history blocks company deletion; configuration alone does not', { skip: skipReason }, () => {
  const { company } = fixture();
  const { fuel, records, history, companies, employees } = mods();
  const tank = setupTank(company.id, fuel);
  const truck = setupTruck(company.id, fuel);
  const emp = employees.create({ companyId: company.id, staffCode: 'D9', nameEn: 'Vanna' });
  records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 50, driverEmployeeId: emp.id });
  assert.throws(() => history.assertCompanyRemovable(company.id), (err) => err.code === 'HAS_HISTORY' && /1 staff record, 1 fuel fill/.test(err.message));
  assert.throws(() => db.getDb().prepare('DELETE FROM companies WHERE id = ?').run(company.id), /FOREIGN KEY/);
  assert.throws(() => db.getDb().prepare('DELETE FROM employees WHERE id = ?').run(emp.id), /FOREIGN KEY/);
  assert.throws(() => db.getDb().prepare('DELETE FROM fuel_assets WHERE id = ?').run(truck.id), /FOREIGN KEY/);

  const empty = companies.create({ name: `Config only ${counter}` });
  setupTank(empty.id, fuel);
  setupTruck(empty.id, fuel);
  fuel.updateSettings(empty.id, { missedDipDays: 3 });
  history.assertCompanyRemovable(empty.id);
  assert.equal(companies.remove(empty.id), true);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM fuel_assets WHERE company_id = ?').get(empty.id).n, 0);
});

test('photos: resized to 1600 px, hashed, under fuel/<yyyy-mm>/ — never assets/; retention → Recently deleted → restore', { skip: skipReason }, async () => {
  const { company, dataDir } = fixture();
  const { fuel, records, photos, deleted, rules } = mods();
  const tank = setupTank(company.id, fuel);
  const { dip } = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 100 });
  const prepared = await photos.prepareUploads('dip', [{ kind: 'stick', bytes: await jpeg(3000, 2000) }]);
  assert.equal(prepared[0].prepared.width, 1600);
  assert.equal(prepared[0].prepared.height, 1067);
  await assert.rejects(photos.prepareUploads('dip', [{ kind: 'meter', bytes: Buffer.from('x') }]), /Photo kind/);
  await assert.rejects(photos.prepareUploads('dip', [{ kind: 'stick', bytes: Buffer.from('not a photo') }]), /not a photo/);
  const staged = photos.stagePhotos({ recordId: dip.id, at: dip.takenAt, photos: prepared });
  const row = records.insertPhotoRow({ ...staged.rows[0], companyId: company.id, ownerKind: 'dip', ownerId: dip.id });
  staged.commit();
  assert.equal(row.relPath, `fuel/${rules.phnomPenhMonth(dip.takenAt)}/${dip.id}-stick.jpg`);
  const abs = path.join(dataDir, row.relPath);
  assert.ok(fs.existsSync(abs));
  assert.ok(!abs.includes(`${path.sep}assets${path.sep}`));
  const read = await photos.readPhotoFile(row.relPath, { expectedSha256: row.sha256 });
  assert.equal(read.intact, true);
  const thumb = await photos.readPhotoFile(row.relPath, { thumb: true });
  const meta = await require('sharp')(thumb.bytes).metadata();
  assert.ok(meta.width <= 320);

  // 25 months old → retired into Recently deleted (default keep: 24 months).
  db.getDb().prepare('UPDATE fuel_photos SET uploaded_at = ? WHERE id = ?').run(Date.now() - 25 * 31 * DAY, row.id);
  const swept = photos.sweepRetention({ companyId: company.id });
  assert.equal(swept.retired, 1);
  assert.ok(!fs.existsSync(abs), 'moved out of fuel/');
  const held = records.getPhoto(row.id);
  assert.equal(held.retired, true);
  const items = deleted.list({ companyId: company.id });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'fuel-photo');
  assert.equal(photos.sweepRetention({ companyId: company.id }).retired, 0, 'idempotent');
  deleted.restore(items[0].id);
  assert.ok(fs.existsSync(abs), 'restored to its place');
  assert.equal(records.getPhoto(row.id).retired, false);
});

test('monthly report and workbook build from the tables', { skip: skipReason }, () => {
  const { company } = fixture();
  const { fuel, records, reports, employees, rules } = mods();
  const tank = setupTank(company.id, fuel);
  const truck = setupTruck(company.id, fuel, { baseline: 25, capacity: 300 });
  const driver = employees.create({ companyId: company.id, staffCode: 'D1', nameEn: 'Rith', isDriver: true });
  const prevMonth = rules.phnomPenhMonth(rules.monthRange(rules.phnomPenhMonth(Date.now())).start - DAY);
  const { start } = rules.monthRange(prevMonth);
  records.createDelivery({ companyId: company.id, locationId: tank.id, litresInvoiced: 1000, priceMinorPerL: 4500, at: start + 1000 });
  records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 100, fullTank: true, meterReading: 10000, at: start + DAY, driverEmployeeId: driver.id });
  records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 130, fullTank: true, meterReading: 10400, at: start + 3 * DAY, driverEmployeeId: driver.id });
  const report = reports.monthlyReport(company.id, prevMonth);
  const row = report.assets.find((a) => a.assetId === truck.id);
  assert.equal(row.distance, 400);
  assert.equal(row.litres, 230);
  assert.equal(row.expectedLitres, 100);
  assert.equal(row.excessLitres, 130);
  assert.equal(row.valueRiel, 230 * 4500);
  assert.equal(row.excessRiel, 130 * 4500);
  assert.equal(report.drivers[0].employeeId, driver.id);
  const wb = reports.monthlyWorkbook(company.id, prevMonth);
  assert.ok(wb.filename.endsWith(`${prevMonth}.xlsx`));
  assert.ok(wb.bytes.length > 1000);
});

/* ─── the phone path: real /api/rpc with tokens and roles ─────────── */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

test('phone RPC: a recorder saves a fill with photos once, sees only their own photos, and is refused manager channels', { skip: skipReason }, async (t) => {
  const { company } = fixture();
  const { fuel, employees } = mods();
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getVersion: () => '0.0.0-test' }, ipcMain: { handle() {}, on() {} } },
  };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const helpers = require('../main/ipc/helpers');
  require('../main/ipc/staff').register(helpers);
  require('../main/ipc/fuel').register(helpers);
  const server = require('../main/server');

  const pumpRole = roles.create({ name: 'Pump phone', permissions: ['fuel.record'] });
  const pump = users.create({ name: 'Pump phone', role: pumpRole.key });
  const other = users.create({ name: 'Driver phone', role: pumpRole.key });
  const viewer = users.create({ name: 'Viewer', role: 'viewer' });
  const attendant = employees.create({ companyId: company.id, staffCode: 'A1', nameEn: 'Sophea', isFuelAttendant: true, userId: pump.id });
  const tank = setupTank(company.id, fuel);
  const truck = setupTruck(company.id, fuel);

  const port = await freePort();
  await server.bootServer({ port, dataDir: db.getDataDir(), wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());
  const rpc = async (token, channel, args) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args }),
    });
    return { status: res.status, body: await res.json() };
  };

  const shot = (await jpeg(2000, 1500)).toString('base64');
  const fillArgs = {
    kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 60, meterReading: 12000, fullTank: true,
    clientRef: 'pump-phone:0001', source: 'phone',
    photos: [{ kind: 'meter', bytes: { __bin: true, b64: shot } }, { kind: 'fill', bytes: { __bin: true, b64: shot } }],
  };
  const first = await rpc(pump.token, 'fuel:recordFill', fillArgs);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.result.duplicate, false);
  const fill = first.body.result.fill;
  assert.equal(fill.attendantEmployeeId, attendant.id, 'the phone account\'s staff record is the attendant');
  assert.equal(fill.recordedByUserId, pump.id);
  const again = await rpc(pump.token, 'fuel:recordFill', fillArgs);
  assert.equal(again.body.result.duplicate, true);
  assert.equal(again.body.result.fill.id, fill.id);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM fuel_photos').get().n, 2, 'a retry stores no extra photos');

  const mine = await rpc(pump.token, 'fuel:listMyRecent', {});
  assert.equal(mine.body.result.fills.length, 1);
  const photoId = db.getDb().prepare("SELECT id FROM fuel_photos WHERE kind = 'meter'").get().id;
  const own = await rpc(pump.token, 'fuel:getPhoto', { photoId, thumb: true });
  assert.equal(own.status, 200);
  assert.equal(own.body.result.bytes.__bin, true);
  const notMine = await rpc(other.token, 'fuel:getPhoto', { photoId });
  assert.equal(notMine.status, 500);
  assert.match(notMine.body.error, /records you entered/);

  assert.equal((await rpc(pump.token, 'fuel:listFills', {})).status, 403);
  assert.equal((await rpc(pump.token, 'staff:create', { staffCode: 'X', nameEn: 'X' })).status, 403);
  assert.equal((await rpc(viewer.token, 'fuel:listAssets', {})).status, 403);
  assert.equal((await rpc(pump.token, 'fuel:listAssets', {})).body.result.length, 1);
  const tiles = (await rpc(pump.token, 'staff:list', {})).body.result;
  assert.equal(tiles[0].nameEn, 'Sophea');
  assert.equal(tiles[0].phone, undefined, 'a recorder gets tiles, not phone numbers');
  assert.equal(tiles[0].userId, undefined);
  const big = await rpc(pump.token, 'fuel:recordFill', { ...fillArgs, clientRef: 'pump-phone:0002', photos: [{ kind: 'meter', bytes: { __bin: true, b64: 'A'.repeat(21 * 1024 * 1024) } }] });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /too large/);

  // The recorder may void their own fresh entry, not someone else's.
  assert.match((await rpc(other.token, 'fuel:voidMyRecord', { kind: 'fill', id: fill.id, reason: 'not mine' })).body.error, /entered yourself/);
  const voided = await rpc(pump.token, 'fuel:voidMyRecord', { kind: 'fill', id: fill.id, reason: 'Wrong truck' });
  assert.equal(voided.body.result.voided, true);
});
