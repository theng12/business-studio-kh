/**
 * HR1 kiosk review fixes against the REAL database, server and permission gate:
 *   M4 — clocking without a photo is a server decision: a manager's PIN marks
 *        the signed-in person's session (never their own), the entry has no
 *        photo, a note naming the manager, waits for review, raises an alert
 *        and is in History with the person's name; the mark is used once.
 *   M5 — the in-app preview is a dry run: hr.manage only, wrong PINs are not
 *        counted, nothing is written (events, requests, History).
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

test('kiosk: no-photo clock is server-checked; preview writes nothing', { skip: skipReason }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-kiosk-'));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: 'Kiosk farm', isActive: true });
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const employees = require('../main/db/employees');
  const people = require('../main/db/hrPeople');

  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getVersion: () => '0.0.0-kiosk', getPath: () => dataDir }, ipcMain: { handle() {}, on() {} }, BrowserWindow: { getAllWindows: () => [] } },
  };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const helpers = require('../main/ipc/helpers');
  for (const m of ['staff', 'hr', 'attendance', 'kiosk', 'audit']) require(`../main/ipc/${m}`).register(helpers);
  const server = require('../main/server');

  const role = (name, permissions) => roles.create({ name, permissions });
  const kioskUser = users.create({ name: 'Shop kiosk', role: role('Kiosk', ['attendance.kiosk']).key });
  const mgrRole = role('HR manager', ['hr.manage', 'history.view']);
  const manager = users.create({ name: 'HR manager', role: mgrRole.key });
  const manager2 = users.create({ name: 'Second manager', role: mgrRole.key });
  const A = employees.create({ companyId: company.id, staffCode: 'A1', nameEn: 'Sok Dara' });
  const B = employees.create({ companyId: company.id, staffCode: 'B1', nameEn: 'Sun Piseth' });
  const M = employees.create({ companyId: company.id, staffCode: 'M1', nameEn: 'Tep Sokunthea', userId: manager.id });
  const M2 = employees.create({ companyId: company.id, staffCode: 'M2', nameEn: 'Chan Mony', userId: manager2.id });
  await people.setPin(A.id, '4071');
  await people.setPin(B.id, '6284');
  await people.setPin(M.id, '5820');
  await people.setPin(M2.id, '7391');

  const port = await freePort();
  await server.bootServer({ port, dataDir: db.getDataDir(), wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());
  for (const u of [kioskUser, manager, manager2]) users.setActiveCompany(u.id, company.id);
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
  const sql = (q, ...p) => db.getDb().prepare(q).all(...p);
  const count = (table) => db.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const K = kioskUser.token;

  /* ─── M4: no photo ─── */
  const tokenA = (await ok(K, 'kiosk:signIn', { employeeId: A.id, pin: '4071' })).sessionToken;
  await fails(K, 'kiosk:clock', { sessionToken: tokenA, noPhoto: true }, 500, /photo is needed/);
  await fails(K, 'kiosk:verifyManagerPin', { employeeId: M.id, pin: '5820', purpose: 'no-photo' }, 400, /sessionToken is required/);
  // A manager cannot allow their own clock-in without a photo.
  const tokenM = (await ok(K, 'kiosk:signIn', { employeeId: M.id, pin: '5820' })).sessionToken;
  await fails(K, 'kiosk:verifyManagerPin', { employeeId: M.id, pin: '5820', purpose: 'no-photo', sessionToken: tokenM }, 500, /cannot allow their own/);
  await fails(K, 'kiosk:clock', { sessionToken: tokenM, noPhoto: true }, 500, /photo is needed/);
  // Not a manager.
  await fails(K, 'kiosk:verifyManagerPin', { employeeId: B.id, pin: '6284', purpose: 'no-photo', sessionToken: tokenA }, 500, /Only a manager can allow this/);
  await fails(K, 'kiosk:clock', { sessionToken: tokenA, noPhoto: true }, 500, /photo is needed/);
  // A manager allows it for A.
  assert.deepEqual(await ok(K, 'kiosk:verifyManagerPin', { employeeId: M.id, pin: '5820', purpose: 'no-photo', sessionToken: tokenA }), { ok: true, managerId: M.id });
  const clocked = await ok(K, 'kiosk:clock', { sessionToken: tokenA, noPhoto: true });
  assert.equal(clocked.duplicate, false);
  assert.equal(clocked.event.hasPhoto, false);
  assert.equal(clocked.event.reviewStatus, 'pending');
  const [row] = sql('SELECT * FROM attendance_events WHERE id = ?', clocked.event.id);
  assert.equal(row.photo_path, null);
  assert.equal(row.source, 'kiosk');
  assert.match(row.note, /No photo — allowed by Tep Sokunthea/);
  // In the review list, with the note as the explanation, and an alert.
  const review = await ok(manager.token, 'attendance:listReview', {});
  const item = review.items.find((x) => x.id === clocked.event.id);
  assert.ok(item, 'the no-photo entry waits in the review list');
  assert.match(item.explanation, /allowed by Tep Sokunthea/);
  const alert = review.alerts.find((a) => a.kind === 'kiosk_no_photo');
  assert.ok(alert, 'an alert comes with the review list');
  assert.equal(alert.employeeId, A.id);
  assert.match(alert.message, /Sok Dara clocked in .* without a photo — allowed by Tep Sokunthea/);
  // History names the person and the event; the manager's PIN use names the person too.
  const [hist] = sql("SELECT * FROM audit_log WHERE action = 'kiosk:no-photo' AND entity_id = ?", clocked.event.id);
  assert.ok(hist, 'History row for the no-photo clock');
  const after = JSON.parse(hist.after_json);
  assert.equal(after.employee, 'Sok Dara');
  assert.equal(after.allowedBy, 'Tep Sokunthea');
  assert.equal(after.kind, 'in');
  const [pinUse] = sql("SELECT * FROM audit_log WHERE action = 'kiosk:manager-no-photo' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(pinUse.after_json).forEmployee, 'Sok Dara');
  // The mark is used once.
  await fails(K, 'kiosk:clock', { sessionToken: tokenA, noPhoto: true }, 500, /photo is needed/);
  // The mark is bound to the session: another person's session is not marked.
  const tokenB = (await ok(K, 'kiosk:signIn', { employeeId: B.id, pin: '6284' })).sessionToken;
  await fails(K, 'kiosk:clock', { sessionToken: tokenB, noPhoto: true }, 500, /photo is needed/);
  // A second manager can allow a manager's own clock-in.
  await ok(K, 'kiosk:verifyManagerPin', { employeeId: M2.id, pin: '7391', purpose: 'no-photo', sessionToken: tokenM });
  assert.equal((await ok(K, 'kiosk:clock', { sessionToken: tokenM, noPhoto: true })).event.hasPhoto, false);

  /* ─── M5: preview is a dry run, for HR managers only ─── */
  await fails(K, 'kiosk:signIn', { employeeId: B.id, pin: '6284', preview: true }, 500, /only for HR managers/);
  const events0 = count('attendance_events');
  const leave0 = count('leave_requests');
  const corr0 = count('attendance_corrections');
  const audit0 = count('audit_log');
  // A wrong PIN in preview is not counted.
  for (let i = 0; i < 6; i++) await fails(manager.token, 'kiosk:signIn', { employeeId: B.id, pin: '0000', preview: true }, 500, /^Wrong PIN\.$/);
  const rowB = employees.getRow(B.id);
  assert.equal(rowB.pin_failed_count || 0, 0);
  assert.ok(!rowB.pin_locked_until);
  const pv = await ok(manager.token, 'kiosk:signIn', { employeeId: B.id, pin: '6284', preview: true });
  assert.equal(pv.preview, true);
  const jpeg = await require('sharp')({ create: { width: 64, height: 48, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  const pclock = await ok(manager.token, 'kiosk:clock', { sessionToken: pv.sessionToken, photo: { __bin: true, b64: jpeg.toString('base64') } });
  assert.equal(pclock.preview, true);
  assert.equal(pclock.event.id, null);
  const types = await ok(manager.token, 'leave:listTypes');
  const pleave = await ok(manager.token, 'kiosk:requestLeave', { sessionToken: pv.sessionToken, leaveTypeId: types[0].id, fromDate: '2026-12-01' });
  assert.equal(pleave.preview, true);
  const pcorr = await ok(manager.token, 'kiosk:requestCorrection', { sessionToken: pv.sessionToken, workDate: '2026-10-01', outTime: '17:00', reason: 'preview' });
  assert.equal(pcorr.preview, true);
  // No-photo in preview: marked and "clocked" — still nothing written.
  await ok(manager.token, 'kiosk:verifyManagerPin', { employeeId: M2.id, pin: '7391', purpose: 'no-photo', sessionToken: pv.sessionToken, preview: true });
  assert.equal((await ok(manager.token, 'kiosk:clock', { sessionToken: pv.sessionToken, noPhoto: true })).preview, true);
  assert.deepEqual(await ok(manager.token, 'kiosk:verifyManagerPin', { employeeId: M.id, pin: '5820', purpose: 'leave', preview: true }), { ok: true, managerId: M.id });
  assert.equal(count('attendance_events'), events0, 'no events');
  assert.equal(count('leave_requests'), leave0, 'no leave requests');
  assert.equal(count('attendance_corrections'), corr0, 'no corrections');
  assert.equal(count('audit_log'), audit0, 'no History');
});
