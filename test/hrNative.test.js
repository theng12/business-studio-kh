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
  await fails(manager.token, 'hr:setPin', { id: B.id, pin: '1234' }, 500, /straight run/);
  const tiles = await ok(kioskUser.token, 'kiosk:tiles');
  const tileA = tiles.find((x) => x.id === A.id);
  assert.deepEqual(Object.keys(tileA).sort(), ['hasPhoto', 'hasPin', 'id', 'isManager', 'nameEn', 'nameKm', 'photoSha256']);
  assert.equal(tiles.find((x) => x.id === M.id).isManager, true);
  assert.equal(tileA.isManager, false);
  assert.equal(await ok(kioskUser.token, 'kiosk:tilePhoto', { id: A.id }), null);

  // Buddy-punch attempt: someone tries C's tile with guessed PINs → locked after 5.
  for (let i = 0; i < 4; i += 1) await fails(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '0000' }, 500, /Wrong PIN/);
  await fails(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '0000' }, 500, /Locked for 10 min/);
  await fails(kioskUser.token, 'kiosk:signIn', { employeeId: C.id, pin: '3958' }, 500, /Too many wrong PINs/);
  await ok(manager.token, 'hr:unlockPin', C.id);
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
  await fails(kiosk2.token, 'kiosk:me', { sessionToken: tokenA }, 500, /session has ended/);
  await fails(kioskUser.token, 'kiosk:me', { sessionToken: 'made-up-token-123456' }, 500, /session has ended/);
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
  const leaveReq = await ok(kioskUser.token, 'kiosk:requestLeave', { sessionToken: tokenA, leaveTypeId: types.find((x) => x.code === 'sick').id, fromDate: calc.addDays(calc.ppDate(Date.now()), 7), toDate: calc.addDays(calc.ppDate(Date.now()), 8) });
  assert.equal(leaveReq.requestedVia, 'kiosk');
  await fails(kioskUser.token, 'kiosk:verifyManagerPin', { employeeId: A.id, pin: '4071' }, 500, /Only a manager/);
  assert.deepEqual(await ok(kioskUser.token, 'kiosk:verifyManagerPin', { employeeId: M.id, pin: '5820' }), { ok: true, managerId: M.id });
  assert.deepEqual(await ok(kioskUser.token, 'kiosk:signOut', { sessionToken: tokenA }), { ended: true });
  await fails(kioskUser.token, 'kiosk:me', { sessionToken: tokenA }, 500, /session has ended/);

  /* ─── phone: attendance.self ─── */
  await fails(phoneUser.token, 'attendance:clockSelf', {}, 400, /photo is required/);
  await fails(unlinked.token, 'attendance:clockSelf', { photo }, 500, /not linked/);
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
  await fails(phoneUser.token, 'attendance:clockSelf', { photo: enc(await jpeg(10)), clientRef: 'phone-dara:0001' }, 500, /different entry/);
  await fails(supUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0001' }, 500, /someone else|different entry/);
  // …and never before the person's previous event: a second long wait lands just after it.
  const queued = await ok(phoneUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0002', queuedForMs: 30 * 3600e3 });
  assert.ok(queued.duplicate || queued.event.at > selfIn.event.at, 'never at or before the last event');
  const outNow = await ok(phoneUser.token, 'attendance:clockSelf', { photo, clientRef: 'phone-dara:0003' });
  assert.equal(outNow.duplicate, false);
  assert.equal(db.getDb().prepare('SELECT employee_id FROM users WHERE id = ?').get(phoneUser.id).employee_id, P.id, 'users.employee_id mirrors the link');
  await assert.rejects(async () => employees.create({ companyId: company.id, staffCode: 'X9', nameEn: 'Twin', userId: phoneUser.id }), /already linked/);
  const mine = await ok(phoneUser.token, 'attendance:mine');
  assert.equal(mine.employee.id, P.id);
  const sickReq = await ok(phoneUser.token, 'leave:requestSelf', { leaveTypeId: types.find((x) => x.code === 'sick').id, fromDate: calc.addDays(calc.ppDate(Date.now()), 14) });
  assert.equal((await ok(phoneUser.token, 'leave:cancelSelf', { id: sickReq.id })).status, 'cancelled');
  await fails(phoneUser.token, 'leave:cancelSelf', { id: leaveReq.id }, 500, /your own/);

  /* ─── supervisor ─── */
  const crew = await ok(supUser.token, 'attendance:crew');
  assert.deepEqual(crew.map((x) => x.id).sort(), [B.id, C.id].sort());
  await fails(supUser.token, 'attendance:markCrew', { employeeId: A.id }, 500, /not in your crew/);
  await fails(supUser.token, 'attendance:markCrew', { employeeId: S.id }, 500, /Clock yourself in/);
  const marked = await ok(supUser.token, 'attendance:markCrew', { employeeId: B.id, photo, note: 'at the farm' });
  assert.equal(marked.event.source, 'supervisor');
  assert.equal(marked.event.reviewStatus, 'pending');
  const markedC = await ok(supUser.token, 'attendance:markCrew', { employeeId: C.id });
  assert.equal(markedC.event.hasPhoto, false);

  /* ─── review list ─── */
  const queue = await ok(viewer.token, 'attendance:listReview', {});
  assert.equal(queue.items.find((x) => x.id === selfIn.event.id).queuedLong, true, 'a 12 h offline wait is pointed out to the reviewer');
  assert.equal(queue.items.find((x) => x.id === marked.event.id).queuedLong, false);
  assert.equal(queue.total, 4 + (queued.duplicate ? 0 : 1)); // phone + 2 supervisor
  await fails(viewer.token, 'attendance:review', { id: marked.event.id, decision: 'accept' }, 403);
  await fails(manager.token, 'attendance:review', { id: markedC.event.id, decision: 'reject' }, 500, /Say why/);
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
  const asRecorder = await ok(recorder.token, 'staff:get', A.id);
  assert.equal(asRecorder.hireDate, undefined);
  assert.equal(asRecorder.phone, undefined);
  await fails(viewer.token, 'hr:updateProfile', { id: A.id, patch: { nssfNo: 'x' } }, 403);
  await fails(viewer.token, 'attendance:getPhoto', { eventId: clocked.event.id }, 403);
  const shot = await ok(manager.token, 'attendance:getPhoto', { eventId: clocked.event.id });
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
  const [d1, d2] = workDays;
  await fails(viewer.token, 'attendance:addManual', { employeeId: B.id, kind: 'in', at: calc.timeOnDate(d1, '07:20'), reason: 'paper sheet' }, 403);
  await ok(manager.token, 'attendance:addManual', { employeeId: B.id, kind: 'in', at: calc.timeOnDate(d1, '07:20'), reason: 'paper sheet' });
  await ok(manager.token, 'attendance:addManual', { employeeId: B.id, kind: 'out', at: calc.timeOnDate(d1, '19:10'), reason: 'paper sheet' });
  await ok(manager.token, 'attendance:addManual', { employeeId: B.id, kind: 'in', at: calc.timeOnDate(d2, '06:58'), reason: 'paper sheet' });
  let sum = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  const dayB1 = sum.rows[0].days.find((d) => d.date === d1);
  assert.equal(dayB1.lateMin, 15);
  assert.equal(dayB1.overtime.normal, 120);
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
  await fails(manager.token, 'attendance:approveOvertime', { employeeId: B.id, workDate: d1, minutes: { normal: 180 } }, 500, /Only 120 min/);
  await ok(manager.token, 'attendance:approveOvertime', { employeeId: B.id, workDate: d1, minutes: { normal: 60 }, note: 'Unloading the container' });
  const again2 = await ok(manager.token, 'attendance:approveOvertime', { employeeId: B.id, workDate: d1, minutes: { normal: 90 } });
  assert.equal(again2.minutes.normal, 90);
  assert.equal((await ok(viewer.token, 'attendance:listOvertime', { month: lastMonth })).length, 1, 'a re-approval replaces the earlier one');
  sum = await ok(viewer.token, 'attendance:monthSummary', { month: lastMonth, employeeId: B.id });
  assert.equal(sum.rows[0].totals.overtimeApproved.normal, 90);
  assert.equal(sum.rows[0].totals.overtimePending.normal, 30);
  // Lateness: confirm the month (a waiver needs a note).
  await fails(manager.token, 'attendance:confirmLateness', { employeeId: B.id, month: lastMonth, lateMinutes: 5 }, 500, /Say why/);
  const conf = await ok(manager.token, 'attendance:confirmLateness', { employeeId: B.id, month: lastMonth });
  assert.equal(conf.confirmedLateMin, sum.rows[0].totals.lateMin);
  await fails(manager.token, 'attendance:confirmLateness', { employeeId: B.id, month: calc.ppMonth(Date.now()) }, 500, /after it has ended/);

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
  await fails(manager.token, 'leave:decide', { id: big.id, decision: 'approve' }, 500, /Not enough/);

  /* ─── History: HR rows hidden without hr.view; clearHistory keeps them ─── */
  const feedAuditor = await ok(auditor.token, 'audit:listRecent', { limit: 500 });
  assert.ok(feedAuditor.every((r) => r.sensitivity !== 'hr' && r.entityType !== 'employee'), 'history.view alone sees no HR or staff rows');
  assert.equal(await ok(auditor.token, 'audit:countForEntity', { entityType: 'employee', entityId: A.id }), 0);
  const feedViewer = await ok(viewer.token, 'audit:listRecent', { limit: 500 });
  assert.ok(feedViewer.some((r) => r.sensitivity === 'hr' && r.entityType === 'attendance'));
  assert.ok(!JSON.stringify(feedViewer).includes('010203040'), 'an ID number never enters History');
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
  await fails(manager.token, 'attendance:getPhoto', { eventId: clocked.event.id }, 500, /Recently deleted/);
  const deletedItems = require('../main/deletedItems');
  const held = deletedItems.list({ companyId: company.id }).find((i) => i.kind === 'hr-photo');
  assert.ok(held && !/Sok Dara/.test(held.label), 'the bin entry never names the person');
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
  await fails(kioskUser.token, 'kiosk:signIn', { employeeId: A.id, pin: '4071' }, 500, /cannot clock in/);
});
