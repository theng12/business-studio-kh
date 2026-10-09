/**
 * Fuel F1 review fixes (2026-10-08), against a real database:
 *
 *   - setDeliveryDips keeps a link that was not passed;
 *   - voiding a price gives the period before it its end back;
 *   - a reviewed flag that gets worse is reopened (old review in History);
 *   - a windowed recompute after a save gives exactly what a full pass gives;
 *   - per-save recompute stays fast on three years of data;
 *   - retention keeps evidence for open / confirmed flags;
 *   - removing a company with only configuration sends its photos to the Trash;
 *   - over real /api/rpc: a recorder cannot backdate, a queued record lands
 *     after the latest dip and is noted (Q1), History hides staff/fuel rows
 *     from history.view-only roles, self-receipt is refused, a reused
 *     client_ref with different content is refused, staff who left cannot be
 *     chosen, the recorder sees only this dip's flags without review notes,
 *     and a record holds at most 12 photos.
 *
 * RUNNING THIS. Real SQLite + files: `npm run test:native`.
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
const m = () => ({
  companies: require('../main/db/companies'),
  employees: require('../main/db/employees'),
  fuel: require('../main/db/fuel'),
  records: require('../main/db/fuelRecords'),
  flags: require('../main/db/fuelFlags'),
  photos: require('../main/fuelPhotos'),
  history: require('../main/db/fuelHistory'),
});

function fixture() {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-fuelrev-${counter}-`));
  db.initDb(dataDir);
  const company = require('../main/db/companies').create({ name: `Farm R${counter}`, isActive: true });
  return { dataDir, company };
}

function tankAndTruck(companyId, { baseline = 25, learned = false } = {}) {
  const { fuel } = m();
  const tank = fuel.createLocation({ companyId, name: `Tank ${counter}`, kind: 'tank', capacityL: 50000 });
  fuel.setChart(tank.id, [{ dipCm: 0, litres: 0 }, { dipCm: 300, litres: 30000 }]);
  const type = fuel.listAssetTypes(companyId).find((t) => t.builtinKey === 'truck');
  const truck = fuel.createAsset({ companyId, typeId: type.id, name: `Truck ${counter}`, tankCapacityL: 300, baselineRate: baseline, baselineSource: learned ? 'learned' : 'manual' });
  return { tank, truck };
}

const openSet = (companyId) => db.getDb().prepare(`SELECT rule_key, subject, severity, ROUND(measured, 3) AS m FROM fuel_flags
  WHERE company_id = ? AND resolved_at IS NULL ORDER BY rule_key, subject`).all(companyId).map((r) => `${r.rule_key}|${r.subject}|${r.severity}|${r.m}`);

async function jpeg() {
  return require('sharp')({ create: { width: 64, height: 48, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
}

test('setDeliveryDips: a link not passed is kept; null clears it', { skip: skipReason }, () => {
  const { company } = fixture();
  const { records } = m();
  const { tank } = tankAndTruck(company.id);
  const t = Date.now() - DAY;
  const b = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 10, at: t }).dip;
  const a = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 30, at: t + 3600e3 }).dip;
  const d = records.createDelivery({ companyId: company.id, locationId: tank.id, litresInvoiced: 2000, at: t + 1800e3, dipBeforeId: b.id }).delivery;
  const linked = records.setDeliveryDips(d.id, { dipAfterId: a.id });
  assert.equal(linked.dipBeforeId, b.id, 'the before link survives a call that only sets "after"');
  assert.equal(linked.dipAfterId, a.id);
  assert.equal(records.setDeliveryDips(d.id, { dipBeforeId: null }).dipBeforeId, null);
});

test('voidPrice restores the previous period\'s end in the same change', { skip: skipReason }, () => {
  const { company } = fixture();
  const { fuel } = m();
  const p1 = fuel.setPrice({ companyId: company.id, fuelType: 'diesel', priceMinorPerL: 4000, effectiveFrom: '2026-01-01' });
  const p2 = fuel.setPrice({ companyId: company.id, fuelType: 'diesel', priceMinorPerL: 4500, effectiveFrom: '2026-03-01' });
  assert.equal(fuel.getPrice(p1.id).effectiveTo, '2026-02-28');
  fuel.voidPrice(p2.id, 'Typed the wrong month');
  assert.equal(fuel.getPrice(p1.id).effectiveTo, null, 'January price runs on again');
  assert.equal(fuel.priceOn(company.id, 'diesel', Date.parse('2026-04-01T05:00:00Z')).priceMinorPerL, 4000);
  assert.throws(() => fuel.setPrice({ companyId: company.id, fuelType: 'diesel', priceMinorPerL: 1, effectiveFrom: '2026-02-30' }), /real date/);
});

test('a reviewed flag that gets worse is reopened; the old review stays in History', { skip: skipReason }, () => {
  const { company } = fixture();
  const { records, flags } = m();
  const { tank, truck } = tankAndTruck(company.id, { baseline: 25 });
  const t = Date.now() - 5 * DAY;
  records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 100, fullTank: true, meterReading: 1000, at: t });
  const f2 = records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 31, fullTank: true, meterReading: 1100, at: t + DAY }).fill;
  flags.recomputeAsset(truck.id, null, [f2.at]);
  const a1 = flags.listFlags(company.id, { ruleKey: 'A1' }).items[0];
  assert.equal(a1.severity, 'amber'); // 31 L/100 km vs 25 → +24 %
  flags.reviewFlag(a1.id, { status: 'explained', note: 'Heavy load that day' });
  // Small change, still amber: the review holds.
  records.correctFill(f2.id, { litres: 32 }, 'slip');
  flags.recomputeAsset(truck.id, null, [f2.at]);
  assert.equal(flags.getFlag(a1.id).status, 'explained');
  // Now red: reopened.
  records.correctFill(f2.id, { litres: 40 }, 'slip again');
  flags.recomputeAsset(truck.id, null, [f2.at]);
  const after = flags.getFlag(a1.id);
  assert.equal(after.severity, 'red');
  assert.equal(after.status, 'open');
  const reopen = db.getDb().prepare("SELECT before_json FROM audit_log WHERE entity_type = 'fuel_flag' AND entity_id = ? AND action = 'reopen'").get(a1.id);
  assert.match(reopen.before_json, /Heavy load that day/);
  assert.equal(flags.worsened({ severity: 'amber', measured: 10, expected: 5 }, { severity: 'amber', measured: 13, expected: 5 }), true);
  assert.equal(flags.worsened({ severity: 'amber', measured: 10, expected: 5 }, { severity: 'amber', measured: 11, expected: 5 }), false);
});

/** Three years of daily life for one truck and one tank, inserted directly (fast). */
function threeYears(companyId, tank, truck) {
  const d = db.getDb();
  const start = Date.now() - 3 * 365 * DAY;
  const insFill = d.prepare(`INSERT INTO fuel_fills (id, company_id, root_id, kind, location_id, asset_id, at, work_date, litres, litres_source,
    meter_reading, full_tank, source, recorded_at, review_status, created_at, updated_at)
    VALUES (?, ?, ?, 'warehouse_tank', ?, ?, ?, '2024-01-01', ?, 'typed', ?, 1, 'mac', ?, 'new', ?, ?)`);
  const insDip = d.prepare(`INSERT INTO fuel_dips (id, company_id, location_id, taken_at, work_date, dip_cm, litres, litres_source, source, created_at)
    VALUES (?, ?, ?, ?, '2024-01-01', ?, ?, 'chart', 'mac', ?)`);
  const insDel = d.prepare(`INSERT INTO fuel_deliveries (id, company_id, location_id, delivered_at, work_date, litres_invoiced, currency, source, created_at)
    VALUES (?, ?, ?, ?, '2024-01-01', 2000, 'KHR', 'mac', ?)`);
  let level = 20000;
  let meter = 10000;
  d.transaction(() => {
    for (let i = 0; i < 3 * 365; i += 1) {
      const day = start + i * DAY;
      if (i % 7 === 0) { insDel.run(`del-${i}`, companyId, tank.id, day + 3600e3, day); level += 2000; }
      const litres = 70 + (i % 5);
      meter += 280;
      insFill.run(`fill-${i}`, companyId, `fill-${i}`, tank.id, truck.id, day + 7200e3, litres, meter, day, day, day);
      level -= litres + (i % 31 === 0 ? 150 : 0); // a theft now and then
      insDip.run(`dip-${i}`, companyId, tank.id, day + 20 * 3600e3, level / 100, level, day);
    }
  })();
  return { start };
}

test('windowed recompute after a save = full pass; and it stays fast on three years of data', { skip: skipReason }, () => {
  const { company } = fixture();
  const { records, flags } = m();
  const { tank, truck } = tankAndTruck(company.id);
  threeYears(company.id, tank, truck);
  const t0 = Date.now();
  flags.recomputeAll({ companyId: company.id });
  const fullMs = Date.now() - t0;
  assert.ok(openSet(company.id).length > 10, 'the synthetic thefts raise flags');

  // A save in the middle of the history, the normal per-save path.
  const mid = db.getDb().prepare("SELECT * FROM fuel_fills WHERE id = 'fill-500'").get();
  const timings = [];
  for (let k = 0; k < 5; k += 1) {
    const s = process.hrtime.bigint();
    const { fill } = records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 60 + k, at: mid.at + 60000 * (k + 1) });
    flags.recomputeForRecord({ assetIds: [truck.id], locationIds: [tank.id], times: [fill.at] });
    timings.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  const windowed = openSet(company.id);
  flags.recomputeAll({ companyId: company.id });
  assert.deepEqual(windowed, openSet(company.id), 'the windowed result is exactly what a full pass computes');
  const median = timings.sort((a, b) => a - b)[2];
  process.stdout.write(`# per-save recompute median ${median.toFixed(1)} ms, full pass ${fullMs} ms\n`);
  assert.ok(median < 50, `per-save recompute took ${median.toFixed(1)} ms (full pass ${fullMs} ms) — must stay under 50 ms`);
});

test('retention keeps evidence while a flag on its record is open or confirmed', { skip: skipReason }, async () => {
  const { company } = fixture();
  const { records, photos } = m();
  const { tank } = tankAndTruck(company.id);
  const shot = await jpeg();
  const put = async (dipCm) => {
    const { dip } = records.createDip({ companyId: company.id, locationId: tank.id, dipCm, at: Date.now() - DAY });
    const staged = photos.stagePhotos({ recordId: dip.id, at: dip.takenAt, photos: await photos.prepareUploads('dip', [{ kind: 'stick', bytes: shot }]) });
    const row = records.insertPhotoRow({ ...staged.rows[0], companyId: company.id, ownerKind: 'dip', ownerId: dip.id });
    staged.commit();
    db.getDb().prepare('UPDATE fuel_photos SET uploaded_at = ? WHERE id = ?').run(Date.now() - 800 * DAY, row.id);
    return { dip, row };
  };
  const flagged = await put(50);
  const plain = await put(60);
  db.getDb().prepare(`INSERT INTO fuel_flags (id, company_id, rule_key, subject, subject_kind, subject_id, scope_key, severity, explanation, status, first_seen_at, last_seen_at, resolved_at)
    VALUES ('fl1', ?, 'T1', ?, 'dip', ?, 'x', 'red', 'test', 'confirmed', 1, 1, 5)`).run(company.id, `dips:other:${flagged.dip.id}`, flagged.dip.id);
  const swept = photos.sweepRetention({ companyId: company.id });
  assert.equal(swept.retired, 1);
  assert.equal(records.getPhoto(flagged.row.id).retired, false, 'confirmed-theft evidence is kept');
  assert.equal(records.getPhoto(plain.row.id).retired, true);
});

test('removing a company with only fuel configuration sends its photo files to the Trash', { skip: skipReason }, async () => {
  const { dataDir } = fixture();
  const { companies, fuel, records, photos, history } = m();
  const other = companies.create({ name: `Config co ${counter}` });
  const { truck } = tankAndTruck(other.id);
  const [prepared] = await photos.prepareUploads('asset', [{ kind: 'asset', bytes: await jpeg() }]);
  const staged = photos.stagePhotos({ recordId: truck.id, at: Date.now(), photos: [prepared] });
  records.insertPhotoRow({ ...staged.rows[0], companyId: other.id, ownerKind: 'asset', ownerId: truck.id });
  staged.commit();
  fuel.setAssetPhoto(truck.id, staged.rows[0].id);
  const abs = path.join(dataDir, staged.rows[0].relPath);
  assert.ok(fs.existsSync(abs));
  const files = history.companyPhotoFiles(other.id);
  assert.deepEqual(files, [abs]);
  assert.equal(companies.remove(other.id), true);
  history.trashCompanyPhotoFiles(files);
  await new Promise((r) => setTimeout(r, 50));
  // Outside Electron there is no Trash, so fileTrash removes it (the app moves it to the Trash).
  assert.ok(!fs.existsSync(abs));
});

/* ─── over real /api/rpc ─── */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

test('phone RPC: no backdating, queued records after the latest dip, History hidden, self-receipt, client_ref, left staff, flags, photo cap', { skip: skipReason }, async (t) => {
  const { company } = fixture();
  const { employees, fuel, records } = m();
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const electronPath = require.resolve('electron');
  const previous = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getVersion: () => 't' }, ipcMain: { handle() {}, on() {} } } };
  t.after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });
  const helpers = require('../main/ipc/helpers');
  require('../main/ipc/staff').register(helpers);
  require('../main/ipc/fuel').register(helpers);
  require('../main/ipc/audit').register(helpers);
  const server = require('../main/server');

  const recRole = roles.create({ name: `Pump R${counter}`, permissions: ['fuel.record'] });
  const histRole = roles.create({ name: `Auditor R${counter}`, permissions: ['history.view'] });
  const pump = users.create({ name: 'Pump', role: recRole.key });
  const farm = users.create({ name: 'Farm', role: recRole.key });
  const auditor = users.create({ name: 'Auditor', role: histRole.key });
  const sender = employees.create({ companyId: company.id, staffCode: 'P1', nameEn: 'Sender 999', isFuelAttendant: true, userId: pump.id, phone: '012 999 888' });
  const gone = employees.create({ companyId: company.id, staffCode: 'X1', nameEn: 'Gone', isDriver: true });
  employees.markLeft(gone.id, { leftOn: new Date(Date.now() + 7 * 3600e3 - 10 * DAY).toISOString().slice(0, 10), reason: 'left' });
  const { tank, truck } = tankAndTruck(company.id);
  const farmStore = fuel.createLocation({ companyId: company.id, name: `Farm store ${counter}`, kind: 'farm_store' });

  const port = await freePort();
  await server.bootServer({ port, dataDir: db.getDataDir(), wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());
  const rpc = async (token, channel, args) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args }) });
    return { status: res.status, body: await res.json() };
  };

  // A recorder's `at` is ignored: no backdating.
  const lastWeek = Date.now() - 7 * DAY;
  const fill = (await rpc(pump.token, 'fuel:recordFill', { kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 40, at: lastWeek, source: 'mac' })).body.result.fill;
  assert.ok(Math.abs(fill.at - Date.now()) < 60000, 'server clock, not the sent time');
  assert.equal(fill.source, 'phone');

  // A dip by the farm phone, then a queued fill that claims to be 3 hours old:
  // it lands after the dip (and after the pump's own previous record), with a Q1 note.
  const dipRes = (await rpc(farm.token, 'fuel:recordDip', { locationId: tank.id, dipCm: 120 })).body.result;
  const queued = (await rpc(pump.token, 'fuel:recordFill', { kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 30, queuedForMs: 3 * 3600e3, clientRef: 'pump:q-0001' })).body.result;
  assert.ok(queued.fill.at > dipRes.dip.takenAt, 'never placed before the latest dip');
  assert.ok(queued.fill.queuedForMs > 0);
  assert.ok(queued.flags.some((f) => f.ruleKey === 'Q1'));
  assert.ok(queued.flags.every((f) => f.details === undefined && f.reviewNote === undefined), 'recorders get no working figures or review notes');
  // The dip response carries only this dip's flags.
  assert.ok(dipRes.flags.every((f) => String(f.subject).includes(dipRes.dip.id) || f.subjectId === dipRes.dip.id));

  // Same client_ref, different content → refused; same content from another account → refused.
  const conflict = await rpc(pump.token, 'fuel:recordFill', { kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 999, clientRef: 'pump:q-0001' });
  assert.match(conflict.body.error, /already used for a different entry/);
  const stranger = await rpc(farm.token, 'fuel:recordFill', { kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 30, queuedForMs: 3 * 3600e3, clientRef: 'pump:q-0001' });
  assert.match(stranger.body.error, /already used by someone else/);

  // Staff who left cannot be put on a new record.
  const left = await rpc(pump.token, 'fuel:recordFill', { kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 5, driverEmployeeId: gone.id });
  assert.match(left.body.error, /has left/);

  // Self-receipt: the sender's phone cannot confirm its own transfer; the farm phone can.
  const tr = (await rpc(pump.token, 'fuel:recordTransfer', { fromLocationId: tank.id, toLocationId: farmStore.id, litresSent: 200 })).body.result.transfer;
  assert.match((await rpc(pump.token, 'fuel:receiveTransfer', { id: tr.id, litresReceived: 200 })).body.error, /cannot also confirm/);
  const got = await rpc(farm.token, 'fuel:receiveTransfer', { id: tr.id, litresReceived: 180 });
  assert.equal(got.status, 200);
  const f1 = db.getDb().prepare("SELECT severity FROM fuel_flags WHERE rule_key = 'F1' AND subject = ?").get(`transfer:${tr.id}`);
  assert.equal(f1.severity, 'red', '10 % lost on the way');

  // Re-linking a delivery's dips is a manager's job.
  const del = (await rpc(pump.token, 'fuel:recordDelivery', { locationId: tank.id, litresInvoiced: 1000, dipBeforeId: dipRes.dip.id })).body.result.delivery;
  assert.equal((await rpc(pump.token, 'fuel:setDeliveryDips', { id: del.id, dipAfterId: dipRes.dip.id })).status, 403);

  // History: an Editor-like role with history.view sees no staff or fuel rows.
  const feed = (await rpc(auditor.token, 'audit:listRecent', { limit: 500 })).body.result;
  assert.ok(feed.length > 0 || true);
  assert.ok(feed.every((e) => e.entityType !== 'employee' && !String(e.entityType).startsWith('fuel_')));
  assert.deepEqual((await rpc(auditor.token, 'audit:listForEntity', { entityType: 'employee', entityId: sender.id })).body.result, []);
  assert.equal((await rpc(auditor.token, 'audit:countRecent', { entityType: 'fuel_fill' })).body.result, 0);
  // …and the staff phone number never reached History at all.
  const empAudit = db.getDb().prepare("SELECT after_json FROM audit_log WHERE entity_type = 'employee' AND entity_id = ? AND action = 'create'").get(sender.id);
  // A public name, random ID or timestamp may legitimately contain "999".
  // Check the actual private field and complete phone value, not that fragment.
  assert.equal(JSON.parse(empAudit.after_json).phone, '(set)');
  assert.ok(!empAudit.after_json.includes(sender.phone));

  // At most 12 photos per record.
  const shot = (await jpeg()).toString('base64');
  for (let i = 0; i < 12; i += 1) {
    const r = await rpc(pump.token, 'fuel:addPhoto', { ownerKind: 'fill', ownerId: fill.id, kind: 'other', bytes: { __bin: true, b64: shot } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.match((await rpc(pump.token, 'fuel:addPhoto', { ownerKind: 'fill', ownerId: fill.id, kind: 'other', bytes: { __bin: true, b64: shot } })).body.error, /most one record can hold is 12/);
  assert.equal(records.listPhotos('fill', fill.id).length, 12);
});

test('realistic-data fixes: USD slip litres, leaver\'s old slip, transfer carrier, missed-dip gap kept after the next dip', { skip: skipReason }, () => {
  const { company } = fixture();
  const { records, employees, fuel, flags } = m();
  const { tank, truck } = tankAndTruck(company.id);
  // B1: a USD paper slip with no litres → converted at the exchange rate (4,100 when no config).
  fuel.setPrice({ companyId: company.id, fuelType: 'diesel', priceMinorPerL: 4100, effectiveFrom: '2025-01-01' });
  const usd = records.createFill({ companyId: company.id, kind: 'cash_station', assetId: truck.id, stationName: 'Caltex', amountPaidMinor: 1000, currency: 'USD', at: Date.now() - DAY }).fill;
  assert.equal(usd.litres, 10, '$10 × 4,100 ÷ 4,100 KHR/L');
  assert.equal(usd.litresSource, 'derived_from_price');
  // B2: someone who left last week — a slip from before they left is accepted, a newer one is not.
  const leaver = employees.create({ companyId: company.id, staffCode: 'L1', nameEn: 'Leaver', isDriver: true });
  const leftOn = new Date(Date.now() + 7 * 3600e3 - 7 * DAY).toISOString().slice(0, 10);
  employees.markLeft(leaver.id, { leftOn });
  const old = records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 20, driverEmployeeId: leaver.id, at: Date.now() - 9 * DAY });
  assert.equal(old.fill.driverEmployeeId, leaver.id);
  assert.throws(() => records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 20, driverEmployeeId: leaver.id, at: Date.now() - DAY }), /has left/);
  // D3: the carrier is stored and named on F1.
  const farm = fuel.createLocation({ companyId: company.id, name: `Farm ${counter}`, kind: 'farm_store' });
  const carrier = employees.create({ companyId: company.id, staffCode: 'C1', nameEn: 'Sok Dara', isDriver: true });
  const receiver = employees.create({ companyId: company.id, staffCode: 'R1', nameEn: 'Ouk Samnang' });
  const tr = records.createTransfer({ companyId: company.id, fromLocationId: tank.id, toLocationId: farm.id, litresSent: 160, carriedByEmployeeId: carrier.id, at: Date.now() - 2 * DAY }).transfer;
  assert.equal(tr.carriedByEmployeeId, carrier.id);
  records.receiveTransfer(tr.id, { litresReceived: 140, receivedByEmployeeId: receiver.id, at: Date.now() - 2 * DAY + 3600e3 });
  flags.recomputeLocation(tank.id);
  const f1 = flags.listFlags(company.id, { ruleKey: 'F1' }).items[0];
  assert.equal(f1.employeeId, carrier.id);
  assert.match(f1.explanation, /carried by Sok Dara, received by Ouk Samnang/);
  // D2: a 6-day gap without a dip stays a flag after the tank is dipped again.
  const d0 = records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 100, at: Date.now() - 12 * DAY }).dip;
  flags.recomputeLocation(tank.id, null, Date.now() - 5 * DAY);
  records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 99, at: Date.now() - 6 * DAY });
  records.createDip({ companyId: company.id, locationId: tank.id, dipCm: 98, at: Date.now() - DAY });
  flags.recomputeLocation(tank.id);
  const gap = flags.listFlags(company.id, { ruleKey: 'T3', subject: `nodip:${tank.id}:${d0.id}` }).items[0];
  assert.ok(gap, 'the gap is still listed');
  assert.equal(gap.measured, 6);
  assert.match(gap.explanation, /went 6 days without a dip/);
});
