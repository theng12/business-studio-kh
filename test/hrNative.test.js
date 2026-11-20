/**
 * HR1 against the REAL database, server, validators and permission gate:
 * the kiosk with a kiosk-only token, a phone with attendance.self, a
 * supervisor, hr.view vs hr.manage narrowing, the review list, corrections,
 * overtime and lateness, leave and the accrual job, History hiding,
 * clearHistory keeping HR rows, photo retention and the workbook.
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

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function jpeg(r = 90) {
  const sharp = require('sharp');
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r, g: 140, b: 40 } } }).jpeg({ quality: 80 }).toBuffer();
}
const enc = (buf) => ({ __bin: true, b64: Buffer.from(buf).toString('base64') });

test('HR1 end to end over the real server', { skip: skipReason }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-hr-'));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: 'HR farm', isActive: true });
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const employees = require('../main/db/employees');
  const calc = require('../main/util/attendanceCalc');

  const ipcHandlers = new Map();
  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getVersion: () => '0.0.0-hr', getPath: () => dataDir }, ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on() {} }, BrowserWindow: { getAllWindows: () => [] } },
  };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const helpers = require('../main/ipc/helpers');
  for (const m of ['staff', 'fuel', 'hr', 'attendance', 'kiosk', 'audit']) require(`../main/ipc/${m}`).register(helpers);
  const server = require('../main/server');
  const local = async (channel, args) => {
    const fn = ipcHandlers.get(channel);
    if (!fn) throw new Error(`no local handler ${channel}`);
    return fn({}, args);
  };

  // Accounts — each role holds only what it says.
  const role = (name, permissions) => roles.create({ name, permissions });
  const kioskUser = users.create({ name: 'Shop kiosk', role: role('Kiosk', ['attendance.kiosk']).key });
  const kiosk2 = users.create({ name: 'Other kiosk', role: role('Kiosk 2', ['attendance.kiosk']).key });
  const selfRole = role('Phone', ['attendance.self']);
  const phoneUser = users.create({ name: 'Dara phone', role: selfRole.key });
  const unlinked = users.create({ name: 'Nobody phone', role: selfRole.key });
  const supUser = users.create({ name: 'Supervisor phone', role: role('Supervisor', ['attendance.supervise', 'attendance.self']).key });
  const viewer = users.create({ name: 'HR viewer', role: role('HR viewer', ['hr.view', 'history.view']).key });
  const manager = users.create({ name: 'HR manager', role: role('HR manager', ['hr.manage', 'history.view']).key });
  const auditor = users.create({ name: 'Editor elsewhere', role: role('History only', ['history.view']).key });
  const recorder = users.create({ name: 'Pump phone', role: role('Fuel phone', ['fuel.record']).key });

  const emp = (code, nameEn, extra = {}) => employees.create({ companyId: company.id, staffCode: code, nameEn, ...extra });
  const A = emp('A1', 'Sok Dara');
  const P = emp('P1', 'Keo Sophal', { userId: phoneUser.id });
  const S = emp('S1', 'Lim Chanthou', { userId: supUser.id });
  const B = emp('B1', 'Sun Piseth');
  const C = emp('C1', 'Heng Sovann');
  const M = emp('M1', 'Tep Sokunthea', { userId: manager.id });
  employees.updateHrProfile(B.id, { supervisorEmployeeId: S.id });
  employees.updateHrProfile(C.id, { supervisorEmployeeId: S.id });

  const port = await freePort();
  await server.bootServer({ port, dataDir: db.getDataDir(), wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());
  for (const u of [kioskUser, kiosk2, phoneUser, unlinked, supUser, viewer, manager, auditor, recorder]) users.setActiveCompany(u.id, company.id);
  const call = async (token, channel, args) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args }),
    });
    const body = await res.json();
    return { status: res.status, result: body.result, error: body.error };
  };
  const ok = async (token, channel, args) => {
    const r = await call(token, channel, args);
    assert.equal(r.status, 200, `${channel}: ${r.status} ${r.error}`);
    return r.result;
  };
  const fails = async (token, channel, args, status, re) => {
    const r = await call(token, channel, args);
    assert.equal(r.status, status, `${channel} should fail ${status}, got ${r.status} ${r.error}`);
    if (re) assert.match(r.error, re);
    return r;
  };
  const photo = enc(await jpeg());

  /* ─── first use prefills holidays, a schedule and leave types ─── */
  const settings = await ok(manager.token, 'hr:getSettings');
  assert.deepEqual(settings.otRates, { normal: 150, night: 200, restDay: 200, holiday: 200 });
  const holidays = await ok(manager.token, 'hr:listHolidays', { year: '2026' });
  assert.equal(holidays.length, 21);
  assert.ok(holidays.find((h) => h.date === '2026-10-15'));
  assert.equal((await ok(viewer.token, 'hr:listHolidays', { year: '2027' })).length, 11);
  const types = await ok(viewer.token, 'leave:listTypes');
  assert.deepEqual(types.map((x) => x.code), ['annual', 'special', 'sick', 'maternity', 'unpaid']);
  const annual = types.find((x) => x.code === 'annual');
  assert.equal(annual.accrualDays, 1.5);
  const schedules = await ok(viewer.token, 'hr:listSchedules');
  assert.equal(schedules[0].startTime, '07:00');

  /* ─── kiosk: tiles, PINs, lockout, sessions ─── */
  await fails(kioskUser.token, 'staff:list', {}, 403);
  await fails(kioskUser.token, 'attendance:day', {}, 403);
  await fails(kioskUser.token, 'hr:setPin', { id: A.id, pin: '4071' }, 403);
  await ok(manager.token, 'hr:setPin', { id: A.id, pin: '4071' });
  await ok(manager.token, 'hr:setPin', { id: C.id, pin: '3958' });
  await ok(manager.token, 'hr:setPin', { id: M.id, pin: '5820' });
  await fails(manager.token, 'hr:setPin', { id: B.id, pin: '1234' }, 422, /straight run/);
  const tiles = await ok(kioskUser.token, 'kiosk:tiles');
  const tileA = tiles.find((x) => x.id === A.id);
  assert.deepEqual(Object.keys(tileA).sort(), ['hasPhoto', 'hasPin', 'id', 'nameEn', 'nameKm', 'photoSha256'], 'tiles never say who is a manager');
  assert.equal(await ok(kioskUser.token, 'kiosk:tilePhoto', { id: A.id }), null);

  // HR1 review: locks, pauses and unlocks reach Review / the badge / the Staff list live.
  const eventsMod = require('../main/events');
  const realBroadcast = eventsMod.broadcast;
  const hrEvents = [];
  eventsMod.broadcast = (channel, payload) => { if (channel === 'hr:changed') hrEvents.push(payload); return realBroadcast(channel, payload); };
  t.after(() => { eventsMod.broadcast = realBroadcast; });
  // Buddy-punch attempt: someone tries C's tile with guessed PINs → locked after 5.
  for (let i = 0; i < 4; i += 1) await fails(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '0000' }, 422, /Wrong PIN/);
  await fails(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '0000' }, 422, /Locked for 10 min/);
  await fails(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '3958' }, 422, /Too many wrong PINs/);
  await ok(manager.token, 'hr:unlockPin', C.id);
  await ok(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '3958' });
  // Locks escalate the same day: the 2nd lock is 20 min, the 3rd needs a manager.
  for (let i = 0; i < 4; i += 1) await fails(kiosk2.token, 'kiosk:signIn', { employeeId: C.id, pin: '0001' }, 422, /Wrong PIN/);
  await fails(kiosk2.token, 'kiosk:signIn', { employeeId: C.id, pin: '0001' }, 422, /Locked for 20 min/);
  await ok(manager.token, 'hr:unlockPin', C.id);
  for (let i = 0; i < 4; i += 1) await fails(kiosk2.token, 'kiosk:signIn', { employeeId: C.id, pin: '0002' }, 422, /Wrong PIN/);
  await fails(kiosk2.token, 'kiosk:signIn', { employeeId: C.id, pin: '0002' }, 422, /only a manager can unlock/);
  // …and that was kiosk2's 10th wrong PIN in 10 minutes across staff: the kiosk pauses PIN entry.
  await fails(kiosk2.token, 'kiosk:signIn', { employeeId: A.id, pin: '4071' }, 422, /paused/);
  await fails(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '3958' }, 422, /Only a manager can unlock/);
  const alertList = (await ok(manager.token, 'attendance:listReview', {})).alerts;
  assert.equal(hrEvents.filter((e) => e.kind === 'alert' && e.op === 'create').length, 4, 'three PIN locks + one kiosk pause, each announced');
  assert.ok(hrEvents.some((e) => e.kind === 'staff' && e.id === C.id && e.companyId === company.id), 'the locked person\'s record changed');
  const beforeUnlock = hrEvents.length;
  assert.equal(alertList.filter((a) => a.kind === 'pin_locked' && a.employeeId === C.id).length, 3);
  assert.equal(alertList.filter((a) => a.kind === 'kiosk_paused').length, 1);
  assert.equal((await ok(manager.token, 'attendance:ackAlert', { id: alertList[0].id })).status, 'seen');
  await ok(manager.token, 'hr:unlockPin', C.id);
  assert.ok(hrEvents.slice(beforeUnlock).some((e) => e.kind === 'staff' && e.op === 'update' && e.id === C.id), 'an unlock is announced');
  await ok(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '3958' });

  const signIn = await ok(kioskUser.token, 'kiosk:signIn', { employeeId: A.id, pin: '4071' });
  assert.equal(signIn.nextKind, 'in');
  const tokenA = signIn.sessionToken;
  await fails(kioskUser.token, 'kiosk:clock', { sessionToken: tokenA }, 400, /photo is required/);
  const clocked = await ok(kioskUser.token, 'kiosk:clock', { sessionToken: tokenA, photo, employeeId: B.id });
  assert.equal(clocked.event.employeeId, A.id, 'the session decides who clocks, never an id from the screen');
  assert.equal(clocked.event.kind, 'in');
  assert.equal(clocked.event.source, 'kiosk');
  assert.equal(clocked.event.hasPhoto, true);
  const tapAgain = await ok(kioskUser.token, 'kiosk:clock', { sessionToken: tokenA, photo });
  assert.equal(tapAgain.duplicate, true);
  assert.equal(tapAgain.doubleTap, true);
  assert.equal(tapAgain.event.id, clocked.event.id);
  await fails(kiosk2.token, 'kiosk:me', { sessionToken: tokenA }, 422, /session has ended/);
  await fails(kioskUser.token, 'kiosk:me', { sessionToken: 'made-up-token-123456' }, 422, /session has ended/);
  const me = await ok(kioskUser.token, 'kiosk:me', { sessionToken: tokenA });
  assert.equal(me.employee.id, A.id);
  assert.equal(me.employee.nationalIdNo, undefined);
  assert.equal(me.lastEvent.kind, 'in');
  assert.ok(Array.isArray(me.leave) && me.leave.length === 5);
  const eventsBefore = db.getDb().prepare('SELECT COUNT(*) n FROM attendance_events').get().n;
  const yesterday = calc.addDays(calc.ppDate(Date.now()), -1);
  const corr = await ok(kioskUser.token, 'kiosk:requestCorrection', { sessionToken: tokenA, workDate: yesterday, outTime: '17:05', reason: 'I forgot to clock out' });
  assert.equal(corr.status, 'pending');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM attendance_events').get().n, eventsBefore, 'a correction request is never an event');
  // The request must land on work days: "today + 7" used to fall on a weekend or
  // a public holiday and the server rightly refused it (422, no work days).
  let leaveFrom = calc.addDays(calc.ppDate(Date.now()), 7);
  const leaveHolidays = new Set((await ok(manager.token, 'hr:listHolidays', { year: leaveFrom.slice(0, 4) })).map((h) => h.date));
  while (calc.weekdayMon0(leaveFrom) >= 5 || leaveHolidays.has(leaveFrom)) leaveFrom = calc.addDays(leaveFrom, 1);
  const leaveReq = await ok(kioskUser.token, 'kiosk:requestLeave', { sessionToken: tokenA, leaveTypeId: types.find((x) => x.code === 'sick').id, fromDate: leaveFrom, toDate: calc.addDays(leaveFrom, 1) });
  assert.equal(leaveReq.requestedVia, 'kiosk');
  await fails(kioskUser.token, 'kiosk:verifyManagerPin', { employeeId: A.id, pin: '4071' }, 422, /Only a manager/);
  assert.deepEqual(await ok(kioskUser.token, 'kiosk:verifyManagerPin', { employeeId: M.id, pin: '5820' }), { ok: true, managerId: M.id });
  assert.deepEqual(await ok(kioskUser.token, 'kiosk:signOut', { sessionToken: tokenA }), { ended: true });
  await fails(kioskUser.token, 'kiosk:me', { sessionToken: tokenA }, 422, /session has ended/);

  /* ─── phone: attendance.self ─── */
  // The 12 h cap on a queued clock-in can land yesterday when the suite runs before noon;
  // keep attendance tracking open far enough back that the held day is inside the window.
  const freshStart = (await ok(manager.token, 'hr:getSettings')).attendanceStartDate;
  await ok(manager.token, 'hr:updateSettings', { attendanceStartDate: calc.addDays(freshStart, -2) });
  await fails(phoneUser.token, 'attendance:clockSelf', {}, 400, /photo is required/);
  await fails(unlinked.token, 'attendance:clockSelf', { photo }, 422, /not linked/);
  await fails(phoneUser.token, 'attendance:day', {}, 403);
  await fails(phoneUser.token, 'kiosk:tiles', {}, 403);
  // A record that waited offline is dated "arrival − wait", the wait capped at 12 h.
  const t0 = Date.now();
  const selfIn = await ok(phoneUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0001', queuedForMs: 48 * 3600e3 });
  assert.equal(selfIn.event.employeeId, P.id);
  assert.equal(selfIn.event.source, 'phone');
  assert.equal(selfIn.event.reviewStatus, 'pending');
  assert.equal(selfIn.event.queuedForMs, 12 * 3600e3);
  assert.ok(Math.abs(selfIn.event.at - (t0 - 12 * 3600e3)) < 5000);
  const retry = await ok(phoneUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0001', queuedForMs: 49 * 3600e3 });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.event.id, selfIn.event.id);
  await fails(phoneUser.token, 'attendance:clockSelf', { photo: enc(await jpeg(10)), clientRef: 'phone-dara:0001' }, 422, /different entry/);
  await fails(supUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0001' }, 422, /someone else|different entry/);
  // …and never before the person's previous event: a second long wait lands just after it.
  const queued = await ok(phoneUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0002', queuedForMs: 30 * 3600e3 });
  assert.ok(queued.duplicate || queued.event.at > selfIn.event.at, 'never at or before the last event');
  const outNow = await ok(phoneUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0003' });
  assert.equal(outNow.duplicate, false);
  // A record that waited > 15 min is HELD: listed, explained, not counted until accepted.
  const dayP = async () => (await ok(manager.token, 'attendance:day', { date: selfIn.event.workDate })).rows.find((r) => r.employeeId === P.id);
  assert.notEqual((await dayP()).firstIn, selfIn.event.at, 'held — not counted');
  const heldItem = (await ok(manager.token, 'attendance:listReview', { employeeId: P.id })).items.find((x) => x.id === selfIn.event.id);
  assert.equal(heldItem.held, true);
  assert.match(heldItem.explanation, /not counted until you accept it/);
  // Verification fix: 'attention' lists held entries first, then the rest newest first.
  const attention = (await ok(manager.token, 'attendance:listReview', { order: 'attention' })).items;
  const firstNotHeld = attention.findIndex((x) => !x.held);
  assert.ok(attention[0].held, 'a held entry leads');
  assert.ok(firstNotHeld === -1 || attention.slice(firstNotHeld).every((x) => !x.held), 'every held entry comes before the rest');
  const rest = attention.slice(firstNotHeld === -1 ? attention.length : firstNotHeld).filter((x) => ['phone', 'supervisor'].includes(x.source));
  assert.deepEqual(rest.map((x) => x.at), [...rest.map((x) => x.at)].sort((p, q) => q - p), 'then newest first');
  await fails(manager.token, 'attendance:listReview', { order: 'sideways' }, 400, /order must be/);
  await ok(manager.token, 'attendance:review', { id: selfIn.event.id, decision: 'accept' });
  assert.equal((await dayP()).firstIn, selfIn.event.at, 'counted once accepted');
  assert.equal(db.getDb().prepare('SELECT employee_id FROM users WHERE id = ?').get(phoneUser.id).employee_id, null, 'users.employee_id is not written (the link is employees.user_id, per company)');
  await assert.rejects(async () => employees.create({ companyId: company.id, staffCode: 'X9', nameEn: 'Twin', userId: phoneUser.id }), /already linked/);
  const mine = await ok(phoneUser.token, 'attendance:mine');
  assert.equal(mine.employee.id, P.id);
  /* A work day about two weeks out. "Today + 14" alone failed whenever it
   * landed on a Sunday or a public holiday (e.g. run on Sunday 2026-10-11). */
  let sickDay = calc.addDays(calc.ppDate(Date.now()), 14);
  const sickYearHolidays = new Set((await ok(manager.token, 'hr:listHolidays', { year: sickDay.slice(0, 4) })).map((h) => h.date));
  while (calc.weekdayMon0(sickDay) >= 6 || holidays.some((h) => h.date === sickDay) || sickYearHolidays.has(sickDay)) sickDay = calc.addDays(sickDay, 1);
  const sickReq = await ok(phoneUser.token, 'leave:requestSelf', { leaveTypeId: types.find((x) => x.code === 'sick').id, fromDate: sickDay });
  assert.equal((await ok(phoneUser.token, 'leave:cancelSelf', { id: sickReq.id })).status, 'cancelled');
  await fails(phoneUser.token, 'leave:cancelSelf', { id: leaveReq.id }, 422, /your own/);

  /* ─── supervisor ─── */
  const crew = await ok(supUser.token, 'attendance:crew');
  assert.deepEqual(crew.map((x) => x.id).sort(), [B.id, C.id].sort());
  await fails(supUser.token, 'attendance:markCrew', { employeeId: A.id }, 422, /not in your crew/);
  await fails(supUser.token, 'attendance:markCrew', { employeeId: S.id }, 422, /Clock yourself in/);
  const marked = await ok(supUser.token, 'attendance:markCrew', { employeeId: B.id, photo, note: 'at the farm' });
  assert.equal(marked.event.source, 'supervisor');
  assert.equal(marked.event.reviewStatus, 'pending');
  const markedC = await ok(supUser.token, 'attendance:markCrew', { employeeId: C.id });
  assert.equal(markedC.event.hasPhoto, false);

  /* ─── review list ─── */
  const queue = await ok(viewer.token, 'attendance:listReview', {});
  assert.equal(queue.items.find((x) => x.id === marked.event.id).queuedLong, false);
  assert.equal(queue.items.find((x) => x.id === marked.event.id).held, false);
  assert.equal(queue.total, 3 + (queued.duplicate ? 0 : 1)); // phone out + 2 supervisor (the held one was accepted)
  await fails(viewer.token, 'attendance:review', { id: marked.event.id, decision: 'accept' }, 403);
  await fails(manager.token, 'attendance:review', { id: markedC.event.id, decision: 'reject' }, 422, /Say why/);
  assert.equal((await ok(manager.token, 'attendance:review', { id: marked.event.id, decision: 'accept' })).reviewStatus, 'accepted');
  const rejected = await ok(manager.token, 'attendance:review', { id: markedC.event.id, decision: 'reject', reason: 'C was at the shop all day' });
  assert.equal(rejected.voided, true);
  assert.match(rejected.voidReason, /C was at the shop/);
  assert.equal((await ok(manager.token, 'attendance:listReview', {})).total, queue.total - 2);

  /* ─── hr.view vs hr.manage narrowing ─── */
  await ok(manager.token, 'hr:updateProfile', { id: A.id, patch: { nationalIdNo: '010203040', bankName: 'ABA', bankAccountNo: '000 111 222', dob: '1990-05-01', hireDate: '2025-01-15', employmentType: 'monthly', gender: 'male' } });
  const asManager = await ok(manager.token, 'staff:get', A.id);
  assert.equal(asManager.nationalIdNo, '010203040');
  const asViewer = await ok(viewer.token, 'staff:get', A.id);
  assert.equal(asViewer.nationalIdNo, undefined);
  assert.equal(asViewer.bankAccountNo, undefined);
  assert.equal(asViewer.dob, undefined);
  assert.equal(asViewer.hireDate, '2025-01-15');
  const profileViewer = await ok(viewer.token, 'hr:getProfile', A.id);
  assert.equal(profileViewer.nationalIdNo, undefined);
  assert.equal(profileViewer.documents, undefined);
  // fuel.manage alone: the F1 record — no notes, status reason or HR field — and it cannot relink accounts.
  const fuelMgr = users.create({ name: 'Fuel office', role: role('Fuel manager', ['fuel.manage']).key });
  users.setActiveCompany(fuelMgr.id, company.id);
  await ok(manager.token, 'staff:update', { id: A.id, patch: { notes: 'Private HR note' } });
  const asFuel = await ok(fuelMgr.token, 'staff:get', A.id);
  for (const k of ['notes', 'hireDate', 'statusReason', 'nationalIdNo', 'supervisorEmployeeId', 'hasPin']) assert.equal(asFuel[k], undefined, k);
  assert.equal(asFuel.staffCode, 'A1');
  await fails(fuelMgr.token, 'staff:update', { id: A.id, patch: { userId: phoneUser.id } }, 422, /hr.manage/);
  await fails(fuelMgr.token, 'staff:create', { staffCode: 'Z9', nameEn: 'Linked', userId: unlinked.id }, 422, /hr.manage/);
  await ok(fuelMgr.token, 'staff:update', { id: A.id, patch: { notes: null, phone: '012 345 678' } });
  assert.equal(employees.get(A.id).notes, 'Private HR note', 'a caller who cannot see the notes cannot wipe them');
  const asRecorder = await ok(recorder.token, 'staff:get', A.id);
  assert.equal(asRecorder.hireDate, undefined);
  assert.equal(asRecorder.phone, undefined);
  await fails(viewer.token, 'hr:updateProfile', { id: A.id, patch: { nssfNo: 'x' } }, 403);
  await fails(viewer.token, 'attendance:getPhoto', { eventId: clocked.event.id }, 403);
  const shot = await ok(manager.token, 'attendance:getPhoto', { eventId: clocked.event.id });
  // 3. The review list's photos in one call, as small thumbnails (hr.manage only).
  const thumbs = await ok(manager.token, 'attendance:getPhotos', { eventIds: [clocked.event.id, marked.event.id, markedC.event.id, 'no-such-event'], size: 'small' });
  assert.deepEqual(thumbs.map((x) => x.eventId), [clocked.event.id, marked.event.id, markedC.event.id, 'no-such-event']);
  assert.ok(thumbs[0].bytes && thumbs[0].intact === true && thumbs[1].bytes);
  const thumbBuf = Buffer.from(thumbs[0].bytes.b64 || thumbs[0].bytes, thumbs[0].bytes.b64 ? 'base64' : undefined);
  const meta = await require('sharp')(thumbBuf).metadata();
  assert.ok(meta.width <= 160 && meta.height <= 160, 'small thumbnail');
  assert.equal(thumbs[2].none, true);
  assert.equal(thumbs[3].missing, true);
  await fails(viewer.token, 'attendance:getPhotos', { eventIds: [clocked.event.id] }, 403);
  await fails(manager.token, 'attendance:getPhotos', { eventIds: Array.from({ length: 61 }, (_, i) => `e${i}`) }, 400, /1 to 60/);
  assert.equal(shot.intact, true);
  assert.equal(shot.mime, 'image/jpeg');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  const doc = await ok(manager.token, 'hr:addDocument', { employeeId: A.id, kind: 'contract', title: 'Contract 2025', bytes: enc(pdf) });
  assert.equal(doc.mime, 'application/pdf');
  await fails(viewer.token, 'hr:listDocuments', { employeeId: A.id }, 403);
  await fails(viewer.token, 'hr:readDocument', { id: doc.id }, 403);
  const read = await ok(manager.token, 'hr:readDocument', { id: doc.id });
  assert.equal(read.intact, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'hr', 'employees', A.id, 'docs', `${doc.id}.pdf`)));
  assert.ok(!fs.existsSync(path.join(dataDir, 'assets', 'hr')), 'never under assets/');

  /* ─── manual entries, a missing clock-out, corrections, overtime, lateness ─── */
  const lastMonth = calc.prevMonth(calc.ppMonth(Date.now()));
  // A work day (Mon–Sat) of last month that is not a holiday.
  const holidaySet = new Set(holidays.map((h) => h.date));
  const workDays = calc.monthDates(lastMonth).filter((d) => calc.weekdayMon0(d) < 6 && !holidaySet.has(d));
  const [d1, d2, d3] = workDays;

  /* ─── no absence before attendance was kept in the app; dated suspensions ─── */
  // F is an F1-era record: no hire date. By default attendance starts the day HR was first used.
  const F = emp('F1', 'Prak Sophea');
  const sumF = async () => (await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: F.id })).rows[0];
  assert.equal((await sumF()).totals.absentDays, 0, 'nobody is absent before the app kept attendance');
  assert.equal(freshStart, calc.ppDate(Date.now()), 'a fresh install starts attendance on the day HR was first used');
  await ok(manager.token, 'hr:updateSettings', { attendanceStartDate: `${lastMonth}-01` });
  const allAbsent = (await sumF()).totals.absentDays;
  assert.equal(allAbsent, workDays.length);
  const [s0, s1] = [workDays[3], workDays[6]];
  await ok(manager.token, 'hr:setStatus', { id: F.id, status: 'suspended', reason: 'Investigation', fromDate: s0 });
  await ok(manager.token, 'hr:setStatus', { id: F.id, status: 'active', toDate: s1 });
  const fRow = await sumF();
  const suspendedDays = fRow.days.filter((d) => d.date >= s0 && d.date <= s1);
  assert.ok(suspendedDays.every((d) => d.status === 'suspended' || d.status === 'off'));
  assert.equal(fRow.totals.absentDays, allAbsent - workDays.filter((d) => d >= s0 && d <= s1).length);
  assert.equal((await ok(manager.token, 'hr:getProfile', F.id)).suspensions.length, 1);
  await fails(viewer.token, 'attendance:addManual', { employeeId: B.id, kind: 'in', at: calc.timeOnDate(d1, '07:20'), reason: 'paper sheet' }, 403);
  await ok(manager.token, 'attendance:addManual', { employeeId: B.id, kind: 'in', at: calc.timeOnDate(d1, '07:20'), reason: 'paper sheet' });
  await ok(manager.token, 'attendance:addManual', { employeeId: B.id, kind: 'out', at: calc.timeOnDate(d1, '19:10'), reason: 'paper sheet' });
  await ok(manager.token, 'attendance:addManual', { employeeId: B.id, kind: 'in', at: calc.timeOnDate(d2, '06:58'), reason: 'paper sheet' });
  let sum = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  const dayB1 = sum.rows[0].days.find((d) => d.date === d1);
  assert.equal(dayB1.lateMin, 15);
  assert.equal(dayB1.overtime.normal, 105, '130 after the end, but late in: capped at worked − scheduled (110) → 105');
  const dayB2 = sum.rows[0].days.find((d) => d.date === d2);
  assert.equal(dayB2.status, 'incomplete');
  assert.equal(dayB2.missingOut, true);
  // The forgotten clock-out: a correction, approved by the manager.
  const fix = await ok(manager.token, 'attendance:requestCorrection', { employeeId: B.id, workDate: d2, outTime: '17:02', reason: 'Forgot to clock out' });
  const decided = await ok(manager.token, 'attendance:decideCorrection', { id: fix.id, decision: 'approve' });
  assert.equal(decided.events.length, 1);
  assert.equal(decided.events[0].source, 'correction');
  sum = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  assert.equal(sum.rows[0].days.find((d) => d.date === d2).status, 'present');
  // Overtime: approve part, never more than the attendance shows.
  await fails(manager.token, 'attendance:approveOvertime', { employeeId: B.id, workDate: d1, minutes: { normal: 180 } }, 422, /Only 105 min/);
  await ok(manager.token, 'attendance:approveOvertime', { employeeId: B.id, workDate: d1, minutes: { normal: 60 }, note: 'Unloading the container' });
  const again2 = await ok(manager.token, 'attendance:approveOvertime', { employeeId: B.id, workDate: d1, minutes: { normal: 90 } });
  assert.equal(again2.minutes.normal, 90);
  assert.equal((await ok(viewer.token, 'attendance:listOvertime', { month: lastMonth })).length, 1, 'a re-approval replaces the earlier one');
  sum = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  assert.equal(sum.rows[0].totals.overtimeApproved.normal, 90);
  assert.equal(sum.rows[0].totals.overtimePending.normal, 15);
  // Lateness: confirm the month (a waiver needs a note).
  await fails(manager.token, 'attendance:confirmLateness', { employeeId: B.id, month: lastMonth, lateMinutes: 5 }, 422, /Say why/);
  const conf = await ok(manager.token, 'attendance:confirmLateness', { employeeId: B.id, month: lastMonth });
  assert.equal(conf.confirmedLateMin, sum.rows[0].totals.lateMin);
  await fails(manager.token, 'attendance:confirmLateness', { employeeId: B.id, month: calc.ppMonth(Date.now()) }, 422, /after it has ended/);

  /* ─── approvals do not outlive the attendance under them ─── */
  const outEvent = (await ok(manager.token, 'attendance:listEvents', { employeeId: B.id, from: d1, to: d1 })).items.find((e) => e.kind === 'out');
  await ok(manager.token, 'attendance:void', { id: outEvent.id, reason: 'Wrong time on the sheet' });
  await ok(manager.token, 'attendance:addManual', { employeeId: B.id, kind: 'out', at: calc.timeOnDate(d1, '17:40'), reason: 'Corrected sheet' });
  const ot = (await ok(viewer.token, 'attendance:listOvertime', { month: lastMonth }))[0];
  assert.equal(ot.needsReapproval, true);
  assert.match(ot.needsReapprovalReason, /Corrected sheet|voided/);
  sum = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  assert.equal(sum.rows[0].days.find((d) => d.date === d1).overtime.normal, 15);
  assert.equal(sum.rows[0].totals.overtimeApproved.normal, 15, 'only min(approved 90, computed 15) is counted');
  assert.deepEqual(sum.rows[0].totals.approvalsExceedingAttendance, [d1]);
  // The in time was wrong too: a correction makes him on time — the confirmed lateness can no longer be deducted.
  const fixIn = await ok(manager.token, 'attendance:requestCorrection', { employeeId: B.id, workDate: d1, inTime: '07:00', reason: 'Was on time' });
  await ok(manager.token, 'attendance:decideCorrection', { id: fixIn.id, decision: 'approve' });
  sum = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  assert.equal(sum.rows[0].lateness.needsReapproval, true);
  assert.equal(sum.rows[0].lateness.deductibleLateMin, 0);
  assert.equal(sum.rows[0].lateness.exceedsAttendance, true);
  const reconf = await ok(manager.token, 'attendance:approveOvertime', { employeeId: B.id, workDate: d1, minutes: { normal: 30 } });
  assert.equal(reconf.needsReapproval, false, 're-approving clears the mark');

  /* ─── a night shift's forgotten clock-out: the out lands the next morning ─── */
  const nightSch = await ok(manager.token, 'hr:createSchedule', { name: 'Night', startTime: '22:00', endTime: '06:00', breakMin: 0, workDays: '1111111', graceMin: 5 });
  await ok(manager.token, 'hr:assignSchedule', { employeeId: C.id, scheduleId: nightSch.id, effectiveFrom: d3 });
  await ok(manager.token, 'attendance:addManual', { employeeId: C.id, kind: 'in', at: calc.timeOnDate(d3, '21:55'), reason: 'paper sheet' });
  const nightFix = await ok(manager.token, 'attendance:requestCorrection', { employeeId: C.id, workDate: d3, outTime: '06:05', reason: 'Forgot to clock out' });
  assert.equal(nightFix.proposedOutAt, calc.timeOnDate(calc.addDays(d3, 1), '06:05'), 'after the in, i.e. the next morning');
  const nightDone = await ok(manager.token, 'attendance:decideCorrection', { id: nightFix.id, decision: 'approve', outTime: '06:15' });
  assert.equal(nightDone.events[0].at, calc.timeOnDate(calc.addDays(d3, 1), '06:15'));
  const cDay = (await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: C.id })).rows[0].days.find((d) => d.date === d3);
  assert.equal(cDay.status, 'present');
  assert.equal(cDay.workedMin, 500);
  // Review fix L2: approving with a time emptied (null) leaves that time out; undefined keeps the proposal.
  const E = emp('E1', 'Correction tester');
  const both = await ok(manager.token, 'attendance:requestCorrection', { employeeId: E.id, workDate: d1, inTime: '07:00', outTime: '17:00', reason: 'Forgot both' });
  const outOnly = await ok(manager.token, 'attendance:decideCorrection', { id: both.id, decision: 'approve', inTime: null });
  assert.deepEqual(outOnly.events.map((e) => [e.kind, e.at]), [['out', calc.timeOnDate(d1, '17:00')]]);
  assert.equal(outOnly.correction.proposedInAt, null, 'the stored decision says no clock-in was added');
  const both2 = await ok(manager.token, 'attendance:requestCorrection', { employeeId: E.id, workDate: d3, inTime: '07:00', outTime: '17:00', reason: 'Forgot both again' });
  await fails(manager.token, 'attendance:decideCorrection', { id: both2.id, decision: 'approve', inTime: null, outTime: null }, 422, /Keep a clock-in or a clock-out/);
  const kept = await ok(manager.token, 'attendance:decideCorrection', { id: both2.id, decision: 'approve', outTime: '17:30' });
  assert.deepEqual(kept.events.map((e) => e.kind).sort(), ['in', 'out'], 'an omitted time keeps the proposal');

  /* ─── verification fixes ─── */
  // 1. A closed pair and a later open in (the S002 case): the approved out is ADDED after the open in;
  //    the earlier pair's out is never superseded.
  const G = emp('G1', 'Split shift');
  const d4 = workDays[8];
  await ok(manager.token, 'attendance:addManual', { employeeId: G.id, kind: 'in', at: calc.timeOnDate(d4, '07:00'), reason: 'sheet' });
  const noonOut = await ok(manager.token, 'attendance:addManual', { employeeId: G.id, kind: 'out', at: calc.timeOnDate(d4, '12:00'), reason: 'sheet' });
  await ok(manager.token, 'attendance:addManual', { employeeId: G.id, kind: 'in', at: calc.timeOnDate(d4, '13:00'), reason: 'sheet' });
  const splitFix = await ok(manager.token, 'attendance:requestCorrection', { employeeId: G.id, workDate: d4, outTime: '17:05', reason: 'Forgot to clock out' });
  assert.equal(splitFix.proposedOutAt, calc.timeOnDate(d4, '17:05'), 'anchored on the open (latest) in');
  const splitDone = await ok(manager.token, 'attendance:decideCorrection', { id: splitFix.id, decision: 'approve' });
  assert.equal(splitDone.events[0].supersedesEventId, null, 'nothing replaced');
  const gEvents = (await ok(manager.token, 'attendance:listEvents', { employeeId: G.id, from: d4, to: d4 })).items;
  assert.equal(gEvents.find((e) => e.id === noonOut.id).supersededById, null, 'the 12:00 out stays');
  const gDay = (await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: G.id })).rows[0].days.find((d) => d.date === d4);
  assert.equal(gDay.workedMin, 545); // 07:00–12:00 + 13:00–17:05, the clocked lunch replaces the break
  assert.deepEqual(gDay.overtime, { normal: 0, night: 0, restDay: 0, holiday: 0 });
  // …and a wrong clock-out time (last entry is an out) is still replaced.
  const wrongOut = await ok(manager.token, 'attendance:requestCorrection', { employeeId: G.id, workDate: d4, outTime: '17:00', reason: 'Left at 17:00' });
  assert.equal((await ok(manager.token, 'attendance:decideCorrection', { id: wrongOut.id, decision: 'approve' })).events[0].supersedesEventId, splitDone.events[0].id);
  // 2. A day with only an out (no in) is incomplete, flagged as odd entries — not "present, 0 min".
  const d5 = workDays[9];
  await ok(manager.token, 'attendance:addManual', { employeeId: G.id, kind: 'out', at: calc.timeOnDate(d5, '17:00'), reason: 'sheet' });
  const gOdd = (await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: G.id })).rows[0].days.find((d) => d.date === d5);
  assert.equal(gOdd.status, 'incomplete');
  assert.equal(gOdd.oddEntries, true);
  // 8. Clock entries on a suspended day are kept and counted, and the day says so.
  await ok(manager.token, 'attendance:addManual', { employeeId: F.id, kind: 'in', at: calc.timeOnDate(s0, '07:00'), reason: 'sheet' });
  await ok(manager.token, 'attendance:addManual', { employeeId: F.id, kind: 'out', at: calc.timeOnDate(s0, '17:00'), reason: 'sheet' });
  const fSusp = (await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: F.id })).rows[0];
  const fDay = fSusp.days.find((d) => d.date === s0);
  assert.equal(fDay.status, 'suspended_with_events');
  assert.equal(fDay.workedMin, 540);
  assert.equal(fSusp.totals.suspendedWithEventsDays, 1);
  // 7. Overtime is paid at the rate in force when it was approved.
  await ok(manager.token, 'hr:updateSettings', { otRates: { normal: 175 } });
  const sumRates = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  assert.equal(sumRates.settings.otRates.normal, 175, 'computed / pending: today\'s rate');
  assert.deepEqual(sumRates.rows[0].totals.overtimeApprovedByRate.normal, { 150: 30 }, 'approved: the rate stored on the approval');
  assert.equal(sumRates.rows[0].totals.overtimeApprovedWeightedMin, 45);
  assert.deepEqual((await ok(viewer.token, 'attendance:listOvertime', { month: lastMonth }))[0].rates, { normal: 150, night: 200, restDay: 200, holiday: 200 });
  const wbRates = await ok(viewer.token, 'hr:getMonthWorkbook', { month: lastMonth });
  const XLSXr = require('xlsx');
  const rateRows = XLSXr.utils.sheet_to_json(XLSXr.read(Buffer.from(wbRates.bytes.b64 || wbRates.bytes, wbRates.bytes.b64 ? 'base64' : undefined), { type: 'buffer' }).Sheets.Summary, { header: 1 });
  assert.ok(rateRows[0].some((h) => /current rate 175%/.test(h)));
  assert.match(String(rateRows.find((r) => r[0] === 'B1')[rateRows[0].indexOf('Approved OT at approval rates')]), /30 min @ 150%/);
  await ok(manager.token, 'hr:updateSettings', { otRates: { normal: 150 } });
  // 6. The person's own view shows late minutes as computed AND after review.
  const own = require('../main/ipc/attendance').ownView(company.id, B.id);
  assert.deepEqual(Object.keys(own.lastMonth.lateness).sort(), ['earlyLeaveAfterReviewMin', 'earlyLeaveMin', 'lateAfterReviewMin', 'lateMin', 'reviewed']);
  assert.equal(own.lastMonth.lateness.reviewed, true);
  assert.equal(own.lastMonth.lateness.lateAfterReviewMin, Math.min(conf.confirmedLateMin, own.lastMonth.lateness.lateMin));
  assert.equal(own.thisMonth.lateness.reviewed, false);
  assert.equal(own.thisMonth.lateness.lateAfterReviewMin, null);
  // 5. History says "(empty)", not "(set)", for a sensitive field that had nothing in it.
  const profileRow = db.getDb().prepare("SELECT before_json, after_json FROM audit_log WHERE entity_type = 'employee' AND entity_id = ? AND action = 'profile' ORDER BY id LIMIT 1").get(A.id);
  assert.equal(JSON.parse(profileRow.before_json).nationalIdNo, '(empty)');
  assert.equal(JSON.parse(profileRow.after_json).nationalIdNo, '(set)');

  /* ─── leave: balances, requests, the accrual job ─── */
  await ok(manager.token, 'hr:updateProfile', { id: B.id, patch: { hireDate: '2024-03-01' } });
  await ok(manager.token, 'hr:updateSettings', { accrualFromMonth: '2025-10' });
  const jobs = await ok(manager.token, 'hr:runJobs');
  assert.ok(jobs.accruals.accrued > 0);
  assert.equal((await ok(manager.token, 'hr:runJobs')).accruals.accrued, 0, 'idempotent');
  const balB = await ok(viewer.token, 'leave:balances', { employeeId: B.id });
  const monthsAccrued = (() => { let n = 0; for (let m = '2025-10'; m < calc.ppMonth(Date.now()); m = calc.nextMonth(m)) n += 1; return n; })();
  assert.equal(balB.find((x) => x.code === 'annual').balance, Math.min(monthsAccrued * 1.5, 1000));
  assert.equal(balB.find((x) => x.code === 'special').balance, 7, '2025 special leave lapsed at the year end; 2026 granted');
  // Review fix L1: batch reads for the Balances grid and the Staff list — one bad id fails only its own row.
  const other = companies.create({ name: 'Other farm' });
  const stranger = employees.create({ companyId: other.id, staffCode: 'X1', nameEn: 'Not ours' });
  const batchBal = await ok(viewer.token, 'leave:balances', { employeeIds: [B.id, A.id, 'nope', stranger.id, B.id] });
  assert.deepEqual(batchBal.byEmployee[B.id], balB);
  assert.ok(Array.isArray(batchBal.byEmployee[A.id]));
  assert.match(batchBal.errors.nope, /not found/);
  assert.match(batchBal.errors[stranger.id], /not found/, 'another company\'s person is never read');
  assert.equal(batchBal.byEmployee[stranger.id], undefined);
  const batchSch = await ok(viewer.token, 'hr:listEmployeeSchedules', { employeeIds: [B.id, 'nope'] });
  assert.deepEqual(batchSch.byEmployee[B.id], await ok(viewer.token, 'hr:listEmployeeSchedules', B.id));
  assert.match(batchSch.errors.nope, /not found/);
  assert.deepEqual(await ok(viewer.token, 'leave:balances', { employeeIds: [] }), { byEmployee: {}, errors: {} });
  await fails(viewer.token, 'leave:balances', { employeeIds: Array.from({ length: 501 }, (_, i) => `id${i}`) }, 400, /at most 500/);
  await fails(viewer.token, 'hr:listEmployeeSchedules', { employeeIds: 'x' }, 400, /list of staff ids/);
  await fails(recorder.token, 'leave:balances', { employeeIds: [B.id] }, 403);
  const ledgerSpecial = await ok(viewer.token, 'leave:ledger', { employeeId: B.id, leaveTypeId: types.find((x) => x.code === 'special').id });
  assert.ok(ledgerSpecial.some((r) => r.kind === 'expiry' && r.days === -7 && r.date === '2025-12-31'));
  const nextMon = (() => { let d = calc.addDays(calc.ppDate(Date.now()), 21); while (calc.weekdayMon0(d) !== 0 || holidaySet.has(d)) d = calc.addDays(d, 1); return d; })();
  const req = await ok(manager.token, 'leave:request', { employeeId: B.id, leaveTypeId: annual.id, fromDate: nextMon, toDate: calc.addDays(nextMon, 6) });
  const hols = holidays.filter((h) => h.date >= nextMon && h.date <= calc.addDays(nextMon, 5)).length;
  assert.equal(req.days, 6 - hols, 'Mon–Sun: Sunday off and public holidays are not counted');
  const before = balB.find((x) => x.code === 'annual').balance;
  await ok(manager.token, 'leave:decide', { id: req.id, decision: 'approve' });
  assert.equal((await ok(viewer.token, 'leave:balances', { employeeId: B.id })).find((x) => x.code === 'annual').balance, before - req.days);
  await ok(manager.token, 'leave:cancel', { id: req.id, reason: 'Trip cancelled' });
  assert.equal((await ok(viewer.token, 'leave:balances', { employeeId: B.id })).find((x) => x.code === 'annual').balance, before);
  const D = await ok(manager.token, 'staff:create', { staffCode: 'D1', nameEn: 'New starter' });
  const big = await ok(manager.token, 'leave:request', { employeeId: D.id, leaveTypeId: annual.id, fromDate: nextMon, toDate: calc.addDays(nextMon, 2) });
  await fails(manager.token, 'leave:decide', { id: big.id, decision: 'approve' }, 422, /Not enough/);

  /* ─── year-end expiry stays true when December leave is decided in January ─── */
  const bal2025 = () => db.getDb().prepare("SELECT ROUND(SUM(days), 2) b FROM leave_ledger WHERE employee_id = ? AND leave_type_id = ? AND date <= '2025-12-31'").get(B.id, annual.id).b;
  await ok(manager.token, 'leave:adjust', { employeeId: B.id, leaveTypeId: annual.id, days: 20, date: '2025-11-01', note: 'Opening balance from the paper file' });
  assert.equal(bal2025(), 18, 'over the 18-day carry-over: the excess lapses at the end of 2025');
  const dec = await ok(manager.token, 'leave:request', { employeeId: B.id, leaveTypeId: annual.id, fromDate: '2025-12-22', toDate: '2025-12-23', reason: 'Approved late, on paper' });
  await ok(manager.token, 'leave:decide', { id: dec.id, decision: 'approve' });
  assert.equal(bal2025(), 18, 'December leave approved later: 2 fewer days lapse, 18 are still carried');
  const ledger2025 = await ok(viewer.token, 'leave:ledger', { employeeId: B.id, leaveTypeId: annual.id });
  assert.ok(ledger2025.some((r) => r.kind === 'adjustment' && r.period === '2025-expiry-fix' && r.days === 2));
  await ok(manager.token, 'leave:cancel', { id: dec.id, reason: 'Did not take it after all' });
  assert.equal(bal2025(), 18);
  await ok(manager.token, 'hr:runJobs');
  assert.equal(bal2025(), 18, 'the job agrees (idempotent)');

  /* ─── History: HR rows hidden without hr.view; clearHistory keeps them ─── */
  const feedAuditor = await ok(auditor.token, 'audit:listRecent', { limit: 500 });
  assert.ok(feedAuditor.every((r) => r.sensitivity !== 'hr' && r.entityType !== 'employee'), 'history.view alone sees no HR or staff rows');
  assert.equal(await ok(auditor.token, 'audit:countForEntity', { entityType: 'employee', entityId: A.id }), 0);
  const feedViewer = await ok(viewer.token, 'audit:listRecent', { limit: 500 });
  assert.ok(feedViewer.some((r) => r.sensitivity === 'hr' && r.entityType === 'attendance'));
  assert.ok(!JSON.stringify(feedViewer).includes('010203040'), 'an ID number never enters History');
  assert.ok(!feedViewer.some((r) => r.entityType === 'hr_document'), 'document rows are hr.manage only');
  assert.ok((await ok(manager.token, 'audit:listRecent', { limit: 500 })).some((r) => r.entityType === 'hr_document'));
  const hrRows = db.getDb().prepare("SELECT COUNT(*) n FROM audit_log WHERE sensitivity = 'hr'").get().n;
  assert.ok(hrRows > 10);
  const cleared = await local('audit:clearHistory', { days: 0 });
  assert.ok(cleared.kept >= hrRows);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) n FROM audit_log WHERE sensitivity = 'hr'").get().n, hrRows);

  /* ─── the company cannot be deleted while it has attendance ─── */
  assert.throws(() => require('../main/db/fuelHistory').assertCompanyRemovable(company.id), /attendance entr/);

  /* ─── clock-in photo retention → Recently deleted → restore ─── */
  await ok(manager.token, 'hr:updateSettings', { photoRetentionMonths: 1 });
  db.getDb().prepare('UPDATE attendance_events SET at = ? WHERE id = ?').run(Date.now() - 70 * 86400e3, clocked.event.id);
  const swept = require('../main/hrPhotos').sweepRetention({ companyId: company.id });
  assert.ok(swept.retired >= 1);
  const row = db.getDb().prepare('SELECT * FROM attendance_events WHERE id = ?').get(clocked.event.id);
  assert.ok(row.photo_retired_at);
  assert.ok(!fs.existsSync(path.join(dataDir, row.photo_path)));
  await fails(manager.token, 'attendance:getPhoto', { eventId: clocked.event.id }, 422, /Recently deleted/);
  const deletedItems = require('../main/deletedItems');
  const held = deletedItems.list({ companyId: company.id }).find((i) => i.kind === 'hr-photo');
  assert.ok(held && !/Sok Dara/.test(held.label), 'the bin entry never names the person');
  assert.equal(held.label, `Clock-in photo ${calc.ppDate(Date.now() - 70 * 86400e3)}`, 'dated in Phnom Penh time');
  deletedItems.restore(held.id);
  assert.ok(fs.existsSync(path.join(dataDir, row.photo_path)));
  assert.equal((await ok(manager.token, 'attendance:getPhoto', { eventId: clocked.event.id })).intact, true);

  /* ─── the month workbook (hr.view) ─── */
  const wb = await ok(viewer.token, 'hr:getMonthWorkbook', { month: lastMonth });
  const XLSX = require('xlsx');
  const book = XLSX.read(Buffer.from(wb.bytes.b64 || wb.bytes, wb.bytes.b64 ? 'base64' : undefined), { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['Summary', 'Days', 'Notes']);
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Summary, { header: 1 });
  const bRow = rows.find((r) => r[0] === 'B1');
  assert.ok(bRow, 'B1 is in the summary');
  assert.ok(!JSON.stringify(rows).includes('010203040'));

  /* ─── suspended staff cannot clock in ─── */
  await ok(manager.token, 'hr:setStatus', { id: A.id, status: 'suspended', reason: 'Investigation' });
  await fails(kioskUser.token, 'kiosk:signIn', { employeeId: A.id, pin: '4071' }, 422, /cannot clock in/);
});
