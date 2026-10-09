/**
 * HR1: the shop-Mac clock-in kiosk (docs/PEOPLE_AND_FUEL_PLAN.md §5.2, §7b).
 *
 * The shop Mac runs as a CLIENT of the office Mac with a "Shop kiosk" account
 * holding only `attendance.kiosk`, so the server refuses everything but these
 * channels even if the kiosk screen is escaped. All `expose()`d.
 *
 *   kiosk:tiles             who can clock in: photo flag + names only (not who is a manager)
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

const { userError } = require('../util/userError');
const attendance = require('../db/attendance');
const leave = require('../db/leave');
const hr = require('../db/hr');
const people = require('../db/hrPeople');
const employees = require('../db/employees');
const { activeCompanyId, inCompany, callerCaps } = require('./fuelAccess');
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

const calc = require('../util/attendanceCalc');
const pinUtil = require('../util/kioskPin');

/** How long a manager's "clock without a photo" stays valid on a session. */
const NO_PHOTO_MS = 2 * 60 * 1000;

function nameOf(e) { return e?.nameEn || e?.nameKm || e?.staffCode || 'staff member'; }

/**
 * Preview (dry run) is for the owner's own window or an hr.manage account: the
 * in-app "Preview the kiosk screen" — PINs are checked but wrong ones are not
 * counted, and nothing is written (no events, requests, locks or History).
 */
function assertPreviewAllowed() {
  const caps = callerCaps(); // null = this Mac's own window
  if (caps && !(caps.has('*') || caps.has('hr.manage'))) throw userError('The kiosk preview is only for HR managers');
}

/** A PIN check that writes nothing (preview): a lock is still reported, a wrong PIN is not counted. */
async function checkPinDry(employeeId, pin, companyId) {
  const row = employees.getRow(employeeId);
  if (!row || row.company_id !== companyId) throw userError('That person is not on this company\'s staff list');
  if (!row.kiosk_pin_hash) throw userError('No PIN is set for this person yet — ask a manager');
  const lock = pinUtil.lockState({ lockedUntil: row.pin_locked_until, managerOnly: !!row.pin_manager_only, now: Date.now() });
  if (lock.locked) throw userError(lock.managerOnly ? 'This PIN is locked. Only a manager can unlock it.' : `Too many wrong PINs. Try again in ${Math.ceil(lock.retryInSeconds / 60)} min.`);
  if (!(await pinUtil.verifyPin(pin, row.kiosk_pin_hash, row.pin_salt))) throw userError('Wrong PIN.');
}

function nextFor(companyId, employeeId, now = Date.now()) {
  const last = attendance.lastActiveEvent(employeeId);
  const settings = hr.getSettings(companyId);
  const schedule = hr.scheduleResolver(companyId)(employeeId, calc.ppDate(now));
  return { last, settings, next: calc.decideKind({ lastEvent: last, now, schedule, settings }) };
}

function kioskLabel() {
  const uid = getCallerUserId();
  if (!uid) return 'Kiosk (this Mac)';
  try { return `Kiosk: ${require('../db/users').get(uid)?.name || 'account'}`; } catch (_) { return 'Kiosk'; }
}

function register({ expose }) {
  expose('kiosk:tiles', () => {
    const companyId = company();
    // Who is a manager is not shown: the screen offers every tile for "leave
    // kiosk mode" and the server decides (kiosk:verifyManagerPin).
    return employees.list(companyId, { status: 'active' }).map((e) => ({
      id: e.id, nameEn: e.nameEn, nameKm: e.nameKm, hasPhoto: e.hasPhoto, photoSha256: e.photoSha256, hasPin: e.hasPin,
    }));
  });

  expose('kiosk:tilePhoto', async ({ id } = {}) => {
    company();
    const e = inCompany(employees.get(id), 'Staff member');
    if (e.status !== 'active') throw userError('Staff member not found');
    const row = employees.getRow(id);
    if (!row.photo_path) return null;
    const out = await require('../fuelPhotos').readPhotoFile(row.photo_path, { thumb: true, expectedSha256: row.photo_sha256 });
    return { bytes: out.bytes, mime: out.mime, sha256: row.photo_sha256 };
  });

  /** `preview: true` (owner's window / hr.manage only): a dry-run session — see assertPreviewAllowed. */
  expose('kiosk:signIn', async ({ employeeId, pin, preview = false } = {}) => {
    const companyId = company();
    if (preview) assertPreviewAllowed();
    const e = inCompany(employees.get(employeeId), 'Staff member');
    if (e.status !== 'active') throw userError('This person cannot clock in — ask a manager');
    if (preview) await checkPinDry(employeeId, pin, companyId);
    else await people.checkPin(employeeId, pin, { companyId, kioskUserId: getCallerUserId() });
    const token = people.createSession({ kioskUserId: getCallerUserId(), employeeId, companyId });
    if (preview) session(token, companyId).preview = true;
    const { last, settings, next } = nextFor(companyId, employeeId);
    return {
      sessionToken: token, expiresInSeconds: settings.kioskSessionSeconds,
      employee: { id: e.id, companyId: e.companyId, nameEn: e.nameEn, nameKm: e.nameKm, hasPhoto: e.hasPhoto },
      nextKind: next.kind, nextNeedsCheck: next.flag === 'late_close', lastEvent: last ? { kind: last.kind, at: last.at } : null,
      preview: !!preview,
    };
  });

  expose('kiosk:signOut', ({ sessionToken } = {}) => ({ ended: people.endSession(sessionToken) }));

  /**
   * A photo is required (§7b). The ONLY way without one: `noPhoto: true` on a
   * session a manager marked moments ago (kiosk:verifyManagerPin, purpose
   * 'no-photo'). That entry carries a note naming the manager, waits in the
   * review list, raises an alert, and is written to History with the person.
   */
  expose('kiosk:clock', async ({ sessionToken, photo = null, noPhoto = false } = {}) => {
    const companyId = company();
    const s = session(sessionToken, companyId);
    const allowed = noPhoto === true && s.noPhotoBy && Date.now() - s.noPhotoBy.at <= NO_PHOTO_MS ? s.noPhotoBy : null;
    if (!photo && !allowed) throw userError('A photo is needed to clock in or out');
    if (s.preview) {
      // Dry run: what would happen, nothing written.
      const { next } = nextFor(companyId, s.employeeId);
      s.noPhotoBy = null;
      return { event: { id: null, employeeId: s.employeeId, kind: next.kind, at: Date.now(), workDate: next.workDate, source: 'kiosk', hasPhoto: !!photo }, duplicate: false, doubleTap: false, preview: true };
    }
    const res = await attendance.clock({
      companyId, employeeId: s.employeeId, source: 'kiosk', photoBytes: photo || null, requirePhoto: !allowed, deviceLabel: kioskLabel(),
      note: allowed && !photo ? `No photo — allowed by ${allowed.managerName} with their manager PIN at the kiosk` : null,
      reviewRequired: !!(allowed && !photo),
    });
    s.noPhotoBy = null;
    if (!res.duplicate) {
      if (allowed && !photo) {
        const person = nameOf(employees.get(s.employeeId));
        const time = new Date(res.event.at + 7 * 3600 * 1000).toISOString().slice(11, 16);
        attendance.addAlert({
          companyId, employeeId: s.employeeId, kind: 'kiosk_no_photo', kioskUserId: getCallerUserId(),
          message: `${person} clocked ${res.event.kind} at ${time} on ${res.event.workDate} without a photo — allowed by ${allowed.managerName}. Check it in the review list.`,
          details: { eventId: res.event.id, managerId: allowed.managerId },
        });
        hr.hrAudit('attendance', res.event.id, 'kiosk:no-photo', {
          after: { employeeId: s.employeeId, employee: person, kind: res.event.kind, at: res.event.at, workDate: res.event.workDate, allowedBy: allowed.managerName, managerId: allowed.managerId },
        });
      }
      emitHrChange('attendance', 'create', res.event.id, companyId);
    }
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
    if (s.preview) {
      const t = leave.getType(leaveTypeId);
      if (!t || t.companyId !== companyId) throw userError('Leave type not found');
      return { id: null, preview: true, status: 'pending', leaveTypeId, fromDate, toDate: toDate || fromDate, halfDay, days: null };
    }
    const r = leave.createRequest({ companyId, employeeId: s.employeeId, leaveTypeId, fromDate, toDate, halfDay, reason, via: 'kiosk' });
    emitHrChange('leave', 'create', r.id, companyId);
    return r;
  });

  expose('kiosk:requestCorrection', ({ sessionToken, workDate, inTime = null, outTime = null, reason } = {}) => {
    const companyId = company();
    const s = session(sessionToken, companyId);
    if (s.preview) return { id: null, preview: true, status: 'pending', workDate, inTime, outTime };
    const c = attendance.requestCorrection({ companyId, employeeId: s.employeeId, workDate, inTime, outTime, reason, via: 'kiosk' });
    emitHrChange('correction', 'create', c.id, companyId);
    return c;
  });

  expose('kiosk:verifyManagerPin', verifyManagerPin);
}

/**
 * Leaving kiosk mode needs a manager: a staff member linked to an account
 * with hr.manage (or admin) and their own PIN. Wrong tries count against
 * that manager's PIN lock like any other.
 *
 * `purpose` (kiosk screen): 'leave' kiosk mode (the default), 'quit' the app,
 * or 'no-photo' — a manager lets someone clock while the camera is not
 * working. Only the History wording differs. Also called in-process by
 * kioskMode:leave / kioskMode:quit (main/ipc/kioskMode.js) on a standalone or
 * server Mac; a client Mac reaches it over RPC.
 */
async function verifyManagerPin({ employeeId, pin, purpose = 'leave', sessionToken = null, preview = false } = {}) {
  const companyId = company();
  if (preview) assertPreviewAllowed();
  const e = inCompany(employees.get(employeeId), 'Staff member');
  const noPhoto = purpose === 'no-photo';
  // 'no-photo' is for the person signed in on this kiosk session — never the manager themself.
  let s = null;
  if (noPhoto) {
    if (!sessionToken) throw userError('Clocking without a photo needs the person signed in first');
    s = session(sessionToken, companyId);
    if (s.employeeId === e.id) throw userError('A manager cannot allow their own clock-in without a photo — another manager must');
  }
  // The PIN is checked first (same per-person and per-kiosk limits), so the
  // answer does not reveal who is a manager to someone without the PIN.
  if (preview || s?.preview) await checkPinDry(employeeId, pin, companyId);
  else await people.checkPin(employeeId, pin, { companyId, kioskUserId: getCallerUserId() });
  if (!people.isManagerEmployee(e)) throw userError(noPhoto ? 'Only a manager can allow this' : 'Only a manager can leave kiosk mode');
  if (noPhoto) s.noPhotoBy = { managerId: e.id, managerName: nameOf(e), at: Date.now() };
  if (!preview && !s?.preview) {
    const person = s ? employees.get(s.employeeId) : null;
    hr.hrAudit('employee', employeeId, noPhoto ? 'kiosk:manager-no-photo' : 'kiosk:manager-exit', {
      after: { kiosk: kioskLabel(), purpose: purpose || 'leave', ...(person ? { forEmployeeId: person.id, forEmployee: nameOf(person) } : {}) },
    });
  }
  return { ok: true, managerId: e.id };
}

module.exports = { register, verifyManagerPin };
