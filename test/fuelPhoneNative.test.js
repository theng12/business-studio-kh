/**
 * Fuel phone page (`/f`) against the REAL server, database and validators:
 * every record the page builds (the exact argument shapes in webclient/fuel/app.js,
 * sent through the outbox's sendArgs) is accepted over `/api/rpc` with a
 * `fuel.record` token, a resend with the same client_ref makes no second row,
 * `staff:me` names the phone's own staff record, and GET /f serves the built page.
 *
 * RUNNING THIS. Real SQLite: `npm run test:native`. Under plain `npm test` it SKIPS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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

const L = require('../webclient/fuel/logic.js');

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function jpeg() {
  const sharp = require('sharp');
  return sharp({ create: { width: 1600, height: 1067, channels: 3, background: { r: 90, g: 140, b: 40 } } }).jpeg({ quality: 80 }).toBuffer();
}

test('the phone page\'s records are accepted by the real server, once each', { skip: skipReason }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-fuel-phone-'));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: 'Phone farm', isActive: true });
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const employees = require('../main/db/employees');
  const fuel = require('../main/db/fuel');

  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getVersion: () => '0.0.0-phone' }, ipcMain: { handle() {}, on() {} } },
  };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const helpers = require('../main/ipc/helpers');
  require('../main/ipc/staff').register(helpers);
  require('../main/ipc/fuel').register(helpers);
  const server = require('../main/server');

  const role = roles.create({ name: 'Pump phone', permissions: ['fuel.record'] });
  const pump = users.create({ name: 'Pump phone', role: role.key });
  const me = employees.create({ companyId: company.id, staffCode: 'A1', nameEn: 'Sophea', nameKm: 'សុភា', isFuelAttendant: true, isDriver: true, userId: pump.id });
  const driver = employees.create({ companyId: company.id, staffCode: 'D1', nameEn: 'Sok', isDriver: true });
  const tank = fuel.createLocation({ companyId: company.id, name: 'Warehouse tank', kind: 'tank', capacityL: 5000 });
  fuel.setChart(tank.id, [{ dipCm: 0, litres: 3500 }, { dipCm: 100, litres: 2046 }, { dipCm: 200, litres: 0 }]);
  const farm = fuel.createLocation({ companyId: company.id, name: 'Farm store', kind: 'farm_store' });
  const truckType = fuel.listAssetTypes(company.id).find((x) => x.builtinKey === 'truck');
  const truck = fuel.createAsset({ companyId: company.id, typeId: truckType.id, name: 'Truck 1', tankCapacityL: 200, assignedEmployeeId: me.id });

  const port = await freePort();
  await server.bootServer({ port, dataDir: db.getDataDir(), wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());
  const farmPhone = users.create({ name: 'Farm phone', role: role.key });
  employees.create({ companyId: company.id, staffCode: 'F1', nameEn: 'Vanna', isFuelAttendant: true, userId: farmPhone.id });
  const rpc = async (channel, args, token = pump.token) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args }),
    });
    const body = await res.json();
    if (res.status !== 200) throw Object.assign(new Error(body.error), { status: res.status });
    return body.result;
  };
  const shot = (await jpeg()).buffer;
  const encode = (buf) => ({ __bin: true, b64: Buffer.from(buf).toString('base64') });
  const send = (item, token) => rpc(item.channel, L.sendArgs(item, Date.now(), encode), token);
  const item = (channel, args, photos = [], extra = {}) => L.makeItem({
    channel, args, photos: photos.map((kind) => ({ kind, data: shot })), clientRef: L.makeClientRef('test0001'),
    companyId: company.id, userId: pump.id, now: Date.now(), ...extra,
  });

  // The page served by this server is the built one.
  const page = await fetch(`http://127.0.0.1:${port}/f`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), require('../main/fuelWebclientHtml.js'));

  // staff:me — "my" staff record, as a tile.
  const mine = await rpc('staff:me', null);
  assert.equal(mine.id, me.id);
  assert.equal(mine.userId, undefined, 'a tile, not the full record');
  assert.equal((await rpc('fuel:listAssets', { status: 'active' }))[0].assignedEmployeeId, me.id);

  // Give fuel: 3 × 20 L cans, two photos; a resend is the same row.
  const give = item('fuel:recordFill', { kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, fullTank: true, driverEmployeeId: driver.id, meterReading: 12345, cansCount: 3, canSizeL: 20 }, ['meter', 'fill']);
  const first = await send(give);
  assert.equal(first.duplicate, false);
  assert.equal(first.fill.litres, 60);
  assert.equal(first.fill.litresSource, 'cans');
  assert.equal(first.fill.source, 'phone');
  assert.equal(first.fill.attendantEmployeeId, me.id, 'the phone\'s own staff record is the attendant');
  const again = await send(give);
  assert.equal(again.duplicate, true);
  assert.equal(again.fill.id, first.fill.id);

  // Dip tank (with a chart: cm only).
  const dip = await send(item('fuel:recordDip', { locationId: tank.id, dipCm: 100 }, ['stick']));
  assert.equal(dip.dip.litres, 2046);

  // A tank with no chart yet: the stick is read in cm AND litres — both are kept,
  // so the office can build the chart from them.
  const bare = fuel.createLocation({ companyId: company.id, name: 'New tank', kind: 'tank', capacityL: 3000 });
  const bareDip = await send(item('fuel:recordDip', { locationId: bare.id, dipCm: 80, litres: 1200 }, ['stick']));
  assert.deepEqual([bareDip.dip.dipCm, bareDip.dip.litres, bareDip.dip.litresSource], [80, 1200, 'typed']);

  // Delivery arrived with a dip before and after, sent as the outbox sends them.
  const before = item('fuel:recordDip', { locationId: tank.id, dipCm: 150 }, ['stick']);
  const after = item('fuel:recordDip', { locationId: tank.id, dipCm: 110 }, ['stick']);
  const dBefore = await send(before);
  const dAfter = await send(after);
  const delivery = item('fuel:recordDelivery', { locationId: tank.id, litresInvoiced: 800 }, ['invoice']);
  delivery.preDone = { dipBeforeId: dBefore.dip.id, dipAfterId: dAfter.dip.id };
  const del = await send(delivery);
  assert.equal(del.delivery.dipBeforeId, dBefore.dip.id);
  assert.equal(del.delivery.dipAfterId, dAfter.dip.id);

  // Send to farm, then the FARM phone receives it (the sender may not confirm their own
  // send); twice — the second is answered unchanged.
  const sent = await send(item('fuel:recordTransfer', { fromLocationId: tank.id, toLocationId: farm.id, litresSent: 200, containers: 10 }, ['containers']));
  assert.equal(sent.transfer.litresSent, 200);
  const pending = await rpc('fuel:listPendingTransfers', {}, farmPhone.token);
  assert.deepEqual(pending.map((p) => p.id), [sent.transfer.id]);
  assert.equal(pending[0].recordedByUserId, pump.id, 'the page hides transfers this phone sent itself');
  const receipt = item('fuel:receiveTransfer', { id: sent.transfer.id, litresReceived: 195 }, ['received'], { userId: farmPhone.id });
  const r1 = await send(receipt, farmPhone.token);
  assert.equal(r1.transfer.litresReceived, 195);
  const r2 = await send(receipt, farmPhone.token);
  assert.equal(r2.duplicate, true);
  // Another phone's queued receipt for the same delivery is NOT "already saved".
  const farm2 = users.create({ name: 'Farm phone 2', role: role.key });
  const other = item('fuel:receiveTransfer', { id: sent.transfer.id, litresReceived: 190 }, [], { userId: farm2.id });
  await assert.rejects(send(other, farm2.token), /Someone else already recorded this delivery as received/);
  // The same phone with different litres is refused too.
  const changed = item('fuel:receiveTransfer', { id: sent.transfer.id, litresReceived: 199 }, [], { userId: farmPhone.id });
  await assert.rejects(send(changed, farmPhone.token), /Someone else already recorded/);

  // I bought fuel: riel, a station typed by name.
  const cash = await send(item('fuel:recordFill', { kind: 'cash_station', assetId: truck.id, fullTank: false, amountPaidMinor: 120000, currency: 'KHR', stationName: 'Tela Kampong Speu', litresShownOnPump: 29.5, meterReading: 12600 }, ['pump_display', 'meter']));
  assert.equal(cash.fill.litres, 29.5);
  assert.equal(cash.fill.driverEmployeeId, me.id, 'the phone\'s own staff record is the driver');
  assert.equal((await rpc('fuel:listStations', {}))[0].name, 'Tela Kampong Speu');

  // A record that waited on the phone is dated before it arrived, never after.
  const late = item('fuel:recordDip', { locationId: tank.id, dipCm: 105 }, [], { now: Date.now() - 10 * 60 * 1000 });
  const lateRes = await send(late);
  assert.ok(lateRes.dip.takenAt <= Date.now(), 'never in the future');

  const recent = await rpc('fuel:listMyRecent', { days: 1 });
  assert.equal(recent.fills.length, 2);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM fuel_fills').get().n, 2);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM fuel_photos WHERE owner_kind = 'fill'").get().n, 4, 'a resend stores no extra photos');
});
