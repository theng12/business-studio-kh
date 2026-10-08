/**
 * HR1 on the phone page (`/f`) against the REAL server, database, validators
 * and permission gate — every call shaped exactly as webclient/fuel sends it
 * (logic.js makeItem + sendArgs for the outbox, bootReads for the opening reads):
 *   - an attendance-only account opens the page without a single 403, and
 *     every fuel channel is closed to it;
 *   - a clock-in with a selfie is dated by the server, a resend with the same
 *     client_ref is the same entry, a wait over 15 min is HELD (L.isHeld agrees
 *     with the review list) and counts only once a manager accepts it;
 *   - a supervisor marks their crew only — never themselves, never someone else's;
 *   - leave and "I forgot" requests through the outbox: a resend returns the
 *     saved request (duplicate), a changed one with the same ref is refused;
 *   - a supervisor sees the photos of their own crew, nobody else's; my attendance;
 *   - a driver (fuel.record + attendance.self) does both.
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

async function selfie(r = 120) {
  const sharp = require('sharp');
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: { r, g: 110, b: 90 } } }).jpeg({ quality: 80 }).toBuffer();
}

test('the phone page\'s attendance calls work against the real server', { skip: skipReason }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-hr-phone-'));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: 'Phone HR farm', isActive: true });
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const employees = require('../main/db/employees');
  const fuel = require('../main/db/fuel');
  const calc = require('../main/util/attendanceCalc');

  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getVersion: () => '0.0.0-hr-phone', getPath: () => dataDir }, ipcMain: { handle() {}, on() {} }, BrowserWindow: { getAllWindows: () => [] } },
  };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const helpers = require('../main/ipc/helpers');
  for (const m of ['staff', 'fuel', 'hr', 'attendance']) require(`../main/ipc/${m}`).register(helpers);
  const server = require('../main/server');

  const role = (name, permissions) => roles.create({ name, permissions });
  const selfOnly = users.create({ name: 'Dara phone', role: role('Clock-in phone', ['attendance.self']).key });
  const driverUser = users.create({ name: 'Driver phone', role: role('Driver', ['fuel.record', 'attendance.self']).key });
  const supUser = users.create({ name: 'Supervisor phone', role: role('Supervisor', ['attendance.supervise', 'attendance.self']).key });
  const unlinked = users.create({ name: 'Nobody phone', role: role('Clock-in 2', ['attendance.self']).key });
  const manager = users.create({ name: 'HR manager', role: role('HR manager', ['hr.manage']).key });

  const emp = (code, nameEn, extra = {}) => employees.create({ companyId: company.id, staffCode: code, nameEn, ...extra });
  const P = emp('P1', 'Keo Sophal', { nameKm: 'កែវ សុផល', userId: selfOnly.id });
  const D = emp('D1', 'Sok Driver', { isDriver: true, userId: driverUser.id });
  const S = emp('S1', 'Lim Chanthou', { userId: supUser.id });
  const B = emp('B1', 'Sun Piseth');
  const C = emp('C1', 'Heng Sovann');
  const X = emp('X1', 'Not in the crew');
  employees.updateHrProfile(B.id, { supervisorEmployeeId: S.id });
  employees.updateHrProfile(C.id, { supervisorEmployeeId: S.id });
  emp('M1', 'Tep Manager', { userId: manager.id });
  const tank = fuel.createLocation({ companyId: company.id, name: 'Warehouse tank', kind: 'tank', capacityL: 5000 });
  const truckType = fuel.listAssetTypes(company.id).find((x) => x.builtinKey === 'truck');
  const truck = fuel.createAsset({ companyId: company.id, typeId: truckType.id, name: 'Truck 1', tankCapacityL: 200, assignedEmployeeId: D.id });

  const port = await freePort();
  await server.bootServer({ port, dataDir: db.getDataDir(), wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());
  for (const u of [selfOnly, driverUser, supUser, unlinked, manager]) users.setActiveCompany(u.id, company.id);

  const call = async (token, channel, args) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args: args === undefined ? null : args }),
    });
    const body = await res.json();
    return { status: res.status, result: body.result, error: body.error };
  };
  const ok = async (token, channel, args) => {
    const r = await call(token, channel, args);
    assert.equal(r.status, 200, `${channel}: ${r.status} ${r.error}`);
    return r.result;
  };
  const whoami = async (token) => (await (await fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } })).json()).user;
  const encode = (buf) => ({ __bin: true, b64: Buffer.from(buf).toString('base64') });
  const shot = (await selfie()).buffer;
  let n = 0;
  /** An outbox item exactly as app.js builds it, sent as the outbox sends it. */
  const item = (channel, args, { user, photo = shot, takenAt = Date.now() } = {}) => L.makeItem({
    channel, args, clientRef: L.makeClientRef('hrtest01', `ref-${++n}-${Date.now()}`), companyId: company.id, userId: user.id,
    photos: photo ? [{ kind: 'selfie', data: photo }] : [], takenAt, now: Date.now(),
  });
  const send = (it, token) => call(token, it.channel, L.sendArgs(it, Date.now(), encode));

  /* ─── an attendance-only phone opens without a 403 and never sees fuel ─── */
  const selfAccess = L.pageAccess((await whoami(selfOnly.token)).caps);
  assert.deepEqual([selfAccess.fuel, selfAccess.self, selfAccess.supervise], [false, true, false]);
  for (const [channel, args] of L.bootReads(selfAccess)) await ok(selfOnly.token, channel, args);
  assert.equal((await ok(selfOnly.token, 'staff:me')).id, P.id);
  for (const [channel, args] of [['fuel:getSettings', null], ['fuel:listAssets', { status: 'active' }], ['fuel:listLocations', {}], ['staff:list', { status: 'active' }], ['fuel:listStations', {}], ['fuel:listMyRecent', { days: 3 }], ['staff:getPhoto', { id: P.id }], ['attendance:crew', null]]) {
    assert.equal((await call(selfOnly.token, channel, args)).status, 403, `${channel} is closed to an attendance-only phone`);
  }
  // The page's own fuel reads (bootReads with fuel) are exactly the ones it would 403 on.
  for (const [channel] of L.bootReads(L.pageAccess(['fuel.record']))) {
    if (channel !== 'staff:me') assert.equal((await call(selfOnly.token, channel, {})).status, 403, channel);
  }

  /* ─── clock in with a selfie; the server dates it ─── */
  const t0 = Date.now();
  const clockIn = item('attendance:clockSelf', {}, { user: selfOnly });
  const sentArgs = L.sendArgs(clockIn, Date.now(), encode);
  assert.equal(sentArgs.at, undefined);
  assert.equal(sentArgs.source, undefined);
  const r1 = await send(clockIn, selfOnly.token);
  assert.equal(r1.status, 200, r1.error);
  assert.equal(r1.result.event.employeeId, P.id);
  assert.equal(r1.result.event.kind, 'in');
  assert.equal(r1.result.event.source, 'phone');
  assert.equal(r1.result.event.hasPhoto, true);
  assert.equal(r1.result.event.reviewStatus, 'pending', 'accepted, and listed for review');
  assert.ok(r1.result.event.at >= t0 - 2000 && r1.result.event.at <= Date.now(), 'server time');
  assert.equal(L.isHeld(r1.result.event), false);
  // A resend of the same record (lost answer) is the same entry.
  const again = await send(clockIn, selfOnly.token);
  assert.equal(again.result.duplicate, true);
  assert.equal(again.result.event.id, r1.result.event.id);
  // Same client_ref with a different selfie is refused, never a silent duplicate.
  const tampered = { ...clockIn, photos: [{ kind: 'selfie', data: (await selfie(10)).buffer }] };
  assert.match((await send(tampered, selfOnly.token)).error, /different entry/);
  // A second tap within two minutes is answered with the first entry.
  const tap2 = await send(item('attendance:clockSelf', {}, { user: selfOnly }), selfOnly.token);
  assert.equal(tap2.result.doubleTap, true);
  assert.equal(tap2.result.event.id, r1.result.event.id);
  const mine = await ok(selfOnly.token, 'attendance:mine');
  assert.equal(mine.employee.id, P.id);
  assert.equal(mine.lastEvent.kind, 'in');
  assert.equal(L.nextClockKind(mine.lastEvent, [], Date.now()), 'out', 'the Clock tile now says Clock out');
  assert.ok(mine.thisMonth.totals, 'this month\'s figures');
  assert.ok(Array.isArray(mine.leave) && mine.leave.length >= 3, 'leave balances (the phone picks its leave types here)');

  /* ─── HELD: the driver's clock-in waited 20 minutes offline ─── */
  const late = item('attendance:clockSelf', {}, { user: driverUser, takenAt: Date.now() - 20 * 60 * 1000 });
  const held = await send(late, driverUser.token);
  assert.equal(held.status, 200, held.error);
  assert.ok(held.result.event.queuedForMs >= 20 * 60 * 1000 - 5000);
  assert.equal(L.isHeld(held.result.event), true, 'the page says the office will check it');
  const review = await ok(manager.token, 'attendance:listReview', { employeeId: D.id });
  const listed = review.items.find((x) => x.id === held.result.event.id);
  assert.equal(listed.held, true, 'the server agrees: held');
  const dayD = async () => (await ok(manager.token, 'attendance:day', { date: held.result.event.workDate })).rows.find((r) => r.employeeId === D.id);
  assert.equal((await dayD()).firstIn, null, 'not counted yet');
  await ok(manager.token, 'attendance:review', { id: held.result.event.id, decision: 'accept' });
  assert.equal((await dayD()).firstIn, held.result.event.at, 'counted once accepted');
  // The driver also records fuel with the same account.
  const driverAccess = L.pageAccess((await whoami(driverUser.token)).caps);
  assert.deepEqual([driverAccess.fuel, driverAccess.self], [true, true]);
  for (const [channel, args] of L.bootReads(driverAccess)) await ok(driverUser.token, channel, args);
  const fill = L.makeItem({
    channel: 'fuel:recordFill', clientRef: L.makeClientRef('hrtest01'), companyId: company.id, userId: driverUser.id, now: Date.now(),
    args: { kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, fullTank: false, litres: 40 },
  });
  assert.equal((await send(fill, driverUser.token)).status, 200);

  /* ─── supervisor: crew only, never themselves ─── */
  const crew = await ok(supUser.token, 'attendance:crew');
  assert.deepEqual(crew.map((x) => x.id).sort(), [B.id, C.id].sort());
  assert.ok(crew.every((x) => x.id !== S.id));
  const markB = item('attendance:markCrew', { employeeId: B.id, kind: 'in' }, { user: supUser });
  const mB = await send(markB, supUser.token);
  assert.equal(mB.status, 200, mB.error);
  assert.deepEqual([mB.result.event.employeeId, mB.result.event.kind, mB.result.event.source, mB.result.event.hasPhoto], [B.id, 'in', 'supervisor', true]);
  assert.equal((await send(markB, supUser.token)).result.duplicate, true, 'a resend is the same mark');
  const mC = await send(item('attendance:markCrew', { employeeId: C.id, kind: 'in' }, { user: supUser, photo: null }), supUser.token);
  assert.equal(mC.result.event.hasPhoto, false, 'the photo is optional');
  assert.match((await send(item('attendance:markCrew', { employeeId: S.id, kind: 'in' }, { user: supUser }), supUser.token)).error, /Clock yourself in/);
  assert.match((await send(item('attendance:markCrew', { employeeId: X.id, kind: 'in' }, { user: supUser }), supUser.token)).error, /not in your crew/);
  assert.equal((await send(item('attendance:markCrew', { employeeId: B.id, kind: 'out' }, { user: selfOnly }), selfOnly.token)).status, 403, 'attendance.self alone cannot mark anyone');
  // Crew faces: the supervisor may read the photo of their own crew, not anyone else's.
  const face = { __bin: true, b64: (await selfie(200)).toString('base64') };
  for (const e of [B, X, P]) await ok(manager.token, 'staff:setPhoto', { id: e.id, bytes: face });
  const bPhoto = await ok(supUser.token, 'staff:getPhoto', { id: B.id, thumb: true });
  assert.ok(bPhoto && bPhoto.bytes, 'their crew member\'s face');
  for (const other of [X, P, S]) {
    const r = await call(supUser.token, 'staff:getPhoto', { id: other.id, thumb: true });
    assert.equal(r.status, 500, `${other.nameEn}: ${r.status}`);
    assert.match(r.error, /only see the photos of your own crew/);
  }
  assert.equal((await call(selfOnly.token, 'staff:getPhoto', { id: P.id })).status, 403, 'attendance.self alone: no staff photos');
  assert.ok((await ok(driverUser.token, 'staff:getPhoto', { id: X.id, thumb: true })).bytes, 'fuel.record as before');
  const crewNow = await ok(supUser.token, 'attendance:crew');
  const bNow = crewNow.find((x) => x.id === B.id);
  assert.equal(L.dayState(bNow.today, bNow.lastEvent, Date.now()).key, 'st_in');

  /* ─── leave and "I forgot" — through the outbox, as the page sends them ─── */
  const annual = mine.leave.find((b) => b.code === 'annual') || mine.leave[0];
  // A work day three weeks out (not the weekly day off, not a public holiday).
  let leaveReq = null;
  let leaveItem = null;
  for (let i = 21; i < 40 && !leaveReq; i += 1) {
    leaveItem = item('leave:requestSelf', { leaveTypeId: annual.leaveTypeId, fromDate: calc.addDays(calc.ppDate(Date.now()), i), halfDay: 'am' }, { user: selfOnly, photo: null });
    const r = await send(leaveItem, selfOnly.token);
    if (r.status === 200) leaveReq = r.result;
    else assert.match(r.error, /not work days/);
  }
  assert.ok(leaveReq, 'a half day of leave was requested');
  assert.equal(leaveReq.duplicate, false);
  // The answer was lost; the outbox sends the same item again → the same request, no overlap refusal.
  const leaveAgain = await send(leaveItem, selfOnly.token);
  assert.equal(leaveAgain.status, 200, leaveAgain.error);
  assert.equal(leaveAgain.result.duplicate, true);
  assert.equal(leaveAgain.result.id, leaveReq.id);
  // Same ref, other content → refused; same ref from another account → refused.
  const changedLeave = { ...leaveItem, args: { ...leaveItem.args, halfDay: 'pm' } };
  assert.match((await send(changedLeave, selfOnly.token)).error, /already used for a different request/);
  assert.match((await send({ ...leaveItem, userId: supUser.id }, supUser.token)).error, /already used by someone else/);
  // Without a client_ref (the kiosk, the Mac) the overlap rule still refuses a second one.
  assert.match((await call(selfOnly.token, 'leave:requestSelf', leaveItem.args)).error, /overlaps/);
  assert.equal((await call(selfOnly.token, 'leave:requestSelf', { ...leaveItem.args, clientRef: 'bad ref!' })).status, 400, 'the ref is validated');
  assert.equal(leaveReq.days, 0.5);
  assert.equal(leaveReq.status, 'pending');
  assert.equal(leaveReq.employeeId, P.id);
  assert.equal((await ok(selfOnly.token, 'attendance:mine')).requests.leave.length, 1, 'listed under "waiting for the office"');
  assert.equal((await ok(selfOnly.token, 'leave:cancelSelf', { id: leaveReq.id })).status, 'cancelled');
  const yesterday = calc.addDays(calc.ppDate(Date.now()), -1);
  const fixItem = item('attendance:requestCorrectionSelf', { workDate: yesterday, outTime: L.parseHm('1705'), reason: L.t('en', 'reason_forgot') }, { user: selfOnly, photo: null });
  const fixRes = await send(fixItem, selfOnly.token);
  assert.equal(fixRes.status, 200, fixRes.error);
  const fix = fixRes.result;
  assert.equal(fix.duplicate, false);
  assert.equal(fix.status, 'pending');
  const fixAgain = await send(fixItem, selfOnly.token);
  assert.equal(fixAgain.status, 200, `a resend is not "already a correction waiting": ${fixAgain.error}`);
  assert.deepEqual([fixAgain.result.duplicate, fixAgain.result.id], [true, fix.id]);
  assert.match((await send({ ...fixItem, args: { ...fixItem.args, outTime: '18:00' } }, selfOnly.token)).error, /already used for a different request/);
  assert.match((await call(selfOnly.token, 'attendance:requestCorrectionSelf', fixItem.args)).error, /already a correction waiting/, 'no ref: the day rule as before');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM attendance_corrections WHERE employee_id = ?').get(P.id).n, 1, 'one request, however often it was sent');
  assert.equal(fix.requestedVia, 'phone');
  assert.equal(L.ppTime(fix.proposedOutAt), '17:05');

  /* ─── an account not linked to a staff record ─── */
  assert.equal(await ok(unlinked.token, 'staff:me'), null, 'the page shows "ask the office to link it"');
  const notLinked = await send(item('attendance:clockSelf', {}, { user: unlinked }), unlinked.token);
  assert.match(notLinked.error, /not linked/);
  assert.equal(L.classifyError({ status: notLinked.status, message: notLinked.error }), 'fail', 'waits for a person, never retried by itself');
});
