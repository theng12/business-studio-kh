/**
 * HR1: the shop-Mac clock-in kiosk (docs/PEOPLE_AND_FUEL_PLAN.md §5.2, §7b).
 *
 * The shop Mac runs as a CLIENT of the office Mac with a "Shop kiosk" account
 * holding only `attendance.kiosk`, so the server refuses everything but these
 * channels even if the kiosk screen is escaped. All `expose()`d.
 *
 *   kiosk:tiles             who can clock in: photo flag + names only
 *   kiosk:tilePhoto         a tile's photo (small)
 *   kiosk:signIn            tile + PIN → a session token (2 min after last use)
 *   kiosk:clock             session + webcam photo → in or out, server time
 *   kiosk:me                the signed-in person's own attendance, leave, requests
 *   kiosk:requestLeave      …a leave request
 *   kiosk:requestCorrection …"I forgot to clock out": a REQUEST, never an event
 *   kiosk:signOut           end the session
 *   kiosk:verifyManagerPin  a manager's PIN, to leave kiosk mode
 *
 * After sign-in the screen only ever sends the token: the employee is the one
 * the server bound to it, never an id from the screen. The token is also bound
 * to the kiosk ACCOUNT that signed in, so another device cannot use it.
 */

const attendance = require('../db/attendance');
const leave = require('../db/leave');
const hr = require('../db/hr');
const people = require('../db/hrPeople');
const employees = require('../db/employees');
const { activeCompanyId, inCompany } = require('./fuelAccess');
const { getCallerUserId } = require('../db/_util');
const { emitHrChange } = require('./hrAccess');
const { ownView, ownEvent } = require('./attendance');

function company() {
  const id = activeCompanyId();
  hr.ensurePrefilled(id);
  return id;
}

function session(token, companyId) {
  return people.useSession(token, { kioskUserId: getCallerUserId(), companyId });
}

function kioskLabel() {
  const uid = getCallerUserId();
  if (!uid) return 'Kiosk (this Mac)';
  try { return `Kiosk: ${require('../db/users').get(uid)?.name || 'account'}`; } catch (_) { return 'Kiosk'; }
}

function register({ expose }) {
  expose('kiosk:tiles', () => {
    const companyId = company();
    return employees.list(companyId, { status: 'active' }).map((e) => ({
      id: e.id, nameEn: e.nameEn, nameKm: e.nameKm, hasPhoto: e.hasPhoto, photoSha256: e.photoSha256,
      hasPin: e.hasPin, isManager: people.isManagerEmployee(e),
    }));
  });

  expose('kiosk:tilePhoto', async ({ id } = {}) => {
    company();
    const e = inCompany(employees.get(id), 'Staff member');
    if (e.status !== 'active') throw new Error('Staff member not found');
    const row = employees.getRow(id);
    if (!row.photo_path) return null;
    const out = await require('../fuelPhotos').readPhotoFile(row.photo_path, { thumb: true, expectedSha256: row.photo_sha256 });
    return { bytes: out.bytes, mime: out.mime, sha256: row.photo_sha256 };
  });

  expose('kiosk:signIn', ({ employeeId, pin } = {}) => {
    const companyId = company();
    const e = inCompany(employees.get(employeeId), 'Staff member');
    if (e.status !== 'active') throw new Error('This person cannot clock in — ask a manager');
    people.checkPin(employeeId, pin, { companyId });
    const token = people.createSession({ kioskUserId: getCallerUserId(), employeeId, companyId });
    const last = attendance.lastActiveEvent(employeeId);
    const settings = hr.getSettings(companyId);
    const schedule = hr.scheduleResolver(companyId)(employeeId, require('../util/attendanceCalc').ppDate(Date.now()));
    const next = require('../util/attendanceCalc').decideKind({ lastEvent: last, now: Date.now(), schedule, settings });
    return {
      sessionToken: token, expiresInSeconds: settings.kioskSessionSeconds,
      employee: { id: e.id, nameEn: e.nameEn, nameKm: e.nameKm, hasPhoto: e.hasPhoto },
      nextKind: next.kind, lastEvent: last ? { kind: last.kind, at: last.at } : null,
    };
  });

  expose('kiosk:signOut', ({ sessionToken } = {}) => ({ ended: people.endSession(sessionToken) }));

  expose('kiosk:clock', async ({ sessionToken, photo } = {}) => {
    const companyId = company();
    const s = session(sessionToken, companyId);
    const res = await attendance.clock({ companyId, employeeId: s.employeeId, source: 'kiosk', photoBytes: photo, requirePhoto: true, deviceLabel: kioskLabel() });
    if (!res.duplicate) emitHrChange('attendance', 'create', res.event.id, companyId);
    return { event: ownEvent(res.event), duplicate: res.duplicate, doubleTap: res.doubleTap };
  });

  expose('kiosk:me', ({ sessionToken } = {}) => {
    const companyId = company();
    const s = session(sessionToken, companyId);
    return ownView(companyId, s.employeeId);
  });

  expose('kiosk:requestLeave', ({ sessionToken, leaveTypeId, fromDate, toDate = null, halfDay = null, reason = null } = {}) => {
    const companyId = company();
    const s = session(sessionToken, companyId);
    const r = leave.createRequest({ companyId, employeeId: s.employeeId, leaveTypeId, fromDate, toDate, halfDay, reason, via: 'kiosk' });
    emitHrChange('leave', 'create', r.id, companyId);
    return r;
  });

  expose('kiosk:requestCorrection', ({ sessionToken, workDate, inTime = null, outTime = null, reason } = {}) => {
    const companyId = company();
    const s = session(sessionToken, companyId);
    const c = attendance.requestCorrection({ companyId, employeeId: s.employeeId, workDate, inTime, outTime, reason, via: 'kiosk' });
    emitHrChange('correction', 'create', c.id, companyId);
    return c;
  });

  /**
   * Leaving kiosk mode needs a manager: a staff member linked to an account
   * with hr.manage (or admin) and their own PIN. Wrong tries count against
   * that manager's PIN lock like any other.
   */
  expose('kiosk:verifyManagerPin', ({ employeeId, pin } = {}) => {
    const companyId = company();
    const e = inCompany(employees.get(employeeId), 'Staff member');
    if (!people.isManagerEmployee(e)) throw new Error('Only a manager can leave kiosk mode');
    people.checkPin(employeeId, pin, { companyId });
    require('../db/hr').hrAudit('employee', employeeId, 'kiosk:manager-exit', { after: { kiosk: kioskLabel() } });
    return { ok: true, managerId: e.id };
  });
}

module.exports = { register };
