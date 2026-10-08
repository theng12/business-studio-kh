/**
 * HR1: the parts of a staff record that are not plain fields — the kiosk PIN,
 * documents, and the short-lived kiosk sessions
 * (docs/PEOPLE_AND_FUEL_PLAN.md §3.1, §5.2, §6).
 *
 * PIN: async scrypt with a per-employee salt (main/util/kioskPin.js). 5 wrong
 * tries lock that person's PIN for 10 minutes, doubling with each lock the
 * same day; the 3rd lock in a day is manager-only (hr:unlockPin). One kiosk
 * account gets 10 wrong PINs across all staff per 10 minutes, then pauses PIN
 * entry for 5 minutes. Every lock and pause is an alert in the manager's
 * review list. Neither the PIN nor its hash ever leaves this module or enters
 * History.
 *
 * Kiosk sessions (in memory on the server Mac): a correct PIN gives the kiosk
 * a random token bound to (kiosk account, employee, company), valid
 * kioskSessionSeconds (120) after its last use and kioskSessionMaxMinutes (10)
 * at most. Every self-service kiosk call names the token, never an employee
 * id — the server decides who is acting. A restart drops every session, which
 * is the safe direction.
 */

const crypto = require('node:crypto');
const { getDb } = require('./index');
const { uuid, str, badRequest, getCallerUserId } = require('./_fuelUtil');
const pinUtil = require('../util/kioskPin');
const hr = require('./hr');
const employees = require('./employees');

function hrAudit(entityType, entityId, action, payload) { hr.hrAudit(entityType, entityId, action, payload); }

/* ─── PIN ─────────────────────────────────────────────────────── */

async function setPin(employeeId, pin) {
  const e = employees.get(employeeId);
  if (!e) throw badRequest('Staff member not found');
  const problem = pinUtil.pinProblem(pin);
  if (problem) throw badRequest(problem);
  const { hash, salt } = await pinUtil.hashPin(pin);
  getDb().prepare(`UPDATE employees SET kiosk_pin_hash = ?, pin_salt = ?, pin_failed_count = 0, pin_locked_until = NULL, pin_manager_only = 0,
      pin_lock_count = 0, pin_lock_day = NULL, pin_set_at = ? WHERE id = ?`)
    .run(hash, salt, Date.now(), employeeId);
  hrAudit('employee', employeeId, 'pin:set', { after: { pin: '(set)' } });
  return employees.get(employeeId);
}

function clearPin(employeeId) {
  const e = employees.get(employeeId);
  if (!e) throw badRequest('Staff member not found');
  getDb().prepare('UPDATE employees SET kiosk_pin_hash = NULL, pin_salt = NULL, pin_failed_count = 0, pin_locked_until = NULL, pin_manager_only = 0, pin_set_at = NULL WHERE id = ?').run(employeeId);
  hrAudit('employee', employeeId, 'pin:clear', { after: { pin: null } });
  return employees.get(employeeId);
}

/** A manager lifts a lock (the only way out of a manager-only lock). The day's lock count stays. */
function unlockPin(employeeId) {
  getDb().prepare('UPDATE employees SET pin_failed_count = 0, pin_locked_until = NULL, pin_manager_only = 0 WHERE id = ?').run(employeeId);
  hrAudit('employee', employeeId, 'pin:unlock', {});
  return employees.get(employeeId);
}

/* Wrong PINs per kiosk account across all staff (in memory; a restart forgets — the per-person locks are in the DB). */
const kioskState = new Map(); // kioskUserId|'local' → { failures: [ms], cooldownUntil }
function _clearKioskState() { kioskState.clear(); }

function pinError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Check a PIN and update the counters. Throws a plain sentence when the PIN
 * is wrong or locked or the kiosk is paused (the kiosk shows it), returns the
 * employee when right. Async: scrypt runs off the main thread, and the
 * counters are updated in one synchronous step after it, re-read so two
 * attempts at once cannot lose a count.
 */
async function checkPin(employeeId, pin, { companyId, kioskUserId = null, now = Date.now() } = {}) {
  const settings = hr.getSettings(companyId);
  const kioskKey = kioskUserId || 'local';
  const cool = pinUtil.kioskCooldown(kioskState.get(kioskKey), now);
  if (cool.cooling) throw pinError(`Too many wrong PINs on this kiosk. PIN entry is paused for ${Math.ceil(cool.retryInSeconds / 60)} min — ask a manager.`, 'KIOSK_PAUSED');
  const row = employees.getRow(employeeId);
  if (!row || row.company_id !== companyId) throw badRequest('That person is not on this company\'s staff list');
  if (!row.kiosk_pin_hash) throw badRequest('No PIN is set for this person yet — ask a manager');
  const lock = pinUtil.lockState({ lockedUntil: row.pin_locked_until, managerOnly: !!row.pin_manager_only, now });
  if (lock.locked) {
    throw pinError(lock.managerOnly ? 'This PIN is locked. Only a manager can unlock it.' : `Too many wrong PINs. Try again in ${Math.ceil(lock.retryInSeconds / 60)} min.`, 'PIN_LOCKED', { retryAt: lock.retryAt });
  }
  const correct = await pinUtil.verifyPin(pin, row.kiosk_pin_hash, row.pin_salt);
  const db = getDb();
  const today = require('../util/attendanceCalc').ppDate(now);
  let next;
  db.transaction(() => {
    const cur = employees.getRow(employeeId);
    next = pinUtil.afterAttempt({
      correct, failedCount: cur.pin_failed_count, now, maxTries: settings.pinMaxTries, lockMinutes: settings.pinLockMinutes,
      today, lockDay: cur.pin_lock_day, locksToday: cur.pin_lock_count, locksBeforeManager: settings.pinLocksBeforeManager,
    });
    db.prepare('UPDATE employees SET pin_failed_count = ?, pin_locked_until = ?, pin_manager_only = ?, pin_lock_count = ?, pin_lock_day = ? WHERE id = ?')
      .run(next.failedCount, next.lockedUntil, next.managerOnly ? 1 : 0, next.locksToday, next.lockDay, employeeId);
  })();
  if (correct) return employees.get(employeeId);

  const att = require('./attendance');
  const name = row.name_en || row.name_km || row.staff_code;
  if (next.locked) {
    hrAudit('employee', employeeId, 'pin:locked', { after: { lockedUntil: next.lockedUntil, managerOnly: next.managerOnly, locksToday: next.locksToday } });
    att.addAlert({
      companyId, employeeId, kind: 'pin_locked', kioskUserId,
      message: next.managerOnly
        ? `${name}'s PIN locked ${next.locksToday} times today — only a manager can unlock it now. Someone may be trying to clock in for them.`
        : `${name}'s PIN locked for ${next.lockMinutes} min after ${settings.pinMaxTries} wrong tries.`,
      details: { locksToday: next.locksToday, managerOnly: next.managerOnly },
    });
  }
  const k = pinUtil.kioskFailure(kioskState.get(kioskKey), {
    now, limit: settings.kioskWrongPinLimit, windowMinutes: settings.kioskWrongPinWindowMinutes, cooldownMinutes: settings.kioskCooldownMinutes,
  });
  kioskState.set(kioskKey, k.state);
  if (k.cooldownStarted) {
    att.addAlert({ companyId, kind: 'kiosk_paused', kioskUserId, message: `${settings.kioskWrongPinLimit} wrong PINs in ${settings.kioskWrongPinWindowMinutes} min on one kiosk — PIN entry paused for ${settings.kioskCooldownMinutes} min.` });
    hrAudit('attendance_alert', kioskKey, 'kiosk:paused', { after: { limit: settings.kioskWrongPinLimit } });
  }
  if (next.locked) {
    throw pinError(next.managerOnly ? 'Wrong PIN. This PIN is now locked — only a manager can unlock it.' : `Wrong PIN. Locked for ${next.lockMinutes} min — ask a manager.`, 'PIN_LOCKED');
  }
  throw pinError(`Wrong PIN. ${next.triesLeft} ${next.triesLeft === 1 ? 'try' : 'tries'} left.`, 'PIN_WRONG');
}

/** A manager for the kiosk: linked to an app account whose role has hr.manage (or admin). */
function isManagerEmployee(e) {
  if (!e?.userId) return false;
  try {
    const user = require('./users').get(e.userId);
    if (!user || user.deactivatedAt) return false;
    const caps = require('./roles').getCapabilityKeys(user.role);
    return !!caps && (caps.has('*') || caps.has('hr.manage'));
  } catch (_) {
    return false;
  }
}

/* ─── kiosk sessions ──────────────────────────────────────────── */

const sessions = new Map(); // token → { kioskUserId, employeeId, companyId, createdAt, lastUsedAt }

function sweepSessions(now, settings = null) {
  for (const [token, s] of sessions) {
    const idle = (settings?.kioskSessionSeconds ?? 120) * 1000;
    const max = (settings?.kioskSessionMaxMinutes ?? 10) * 60 * 1000;
    if (now - s.lastUsedAt > idle || now - s.createdAt > max) sessions.delete(token);
  }
}

function createSession({ kioskUserId, employeeId, companyId, now = Date.now() }) {
  sweepSessions(now, hr.getSettings(companyId));
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, { kioskUserId: kioskUserId ?? null, employeeId, companyId, createdAt: now, lastUsedAt: now });
  return token;
}

/**
 * The session for a token, refreshed — only for the kiosk account that
 * created it, in the company it was created in. Throws a plain sentence when
 * it has ended (the kiosk goes back to the tiles).
 */
function useSession(token, { kioskUserId, companyId, now = Date.now() }) {
  const s = typeof token === 'string' ? sessions.get(token) : null;
  const settings = s ? hr.getSettings(s.companyId) : null;
  const idle = (settings?.kioskSessionSeconds ?? 120) * 1000;
  const max = (settings?.kioskSessionMaxMinutes ?? 10) * 60 * 1000;
  const expired = !s || now - s.lastUsedAt > idle || now - s.createdAt > max;
  if (expired || s.kioskUserId !== (kioskUserId ?? null) || s.companyId !== companyId) {
    if (s && expired) sessions.delete(token);
    const err = new Error('Your kiosk session has ended. Tap your photo and enter your PIN again.');
    err.code = 'KIOSK_SESSION_ENDED';
    throw err;
  }
  s.lastUsedAt = now;
  return s;
}

function endSession(token) { return sessions.delete(token); }
function _clearSessions() { sessions.clear(); }

/* ─── documents ───────────────────────────────────────────────── */

function rowToDocument(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, employeeId: r.employee_id, kind: r.kind, title: r.title, mime: r.mime, sha256: r.sha256, bytes: r.bytes,
    uploadedByUserId: r.uploaded_by_user_id, uploadedAt: r.uploaded_at, voided: !!r.voided_at, voidedAt: r.voided_at, voidReason: r.void_reason,
  };
}

function listDocuments(employeeId, { includeVoided = false } = {}) {
  return getDb().prepare(`SELECT * FROM employee_documents WHERE employee_id = ? ${includeVoided ? '' : 'AND voided_at IS NULL'} ORDER BY uploaded_at DESC`)
    .all(employeeId).map(rowToDocument);
}
function getDocumentRow(id) { return getDb().prepare('SELECT * FROM employee_documents WHERE id = ?').get(id); }

async function addDocument({ companyId, employeeId, kind, title = null, bytes }) {
  const { DOC_KINDS, stageDocument } = require('../hrPhotos');
  const e = employees.get(employeeId);
  if (!e || e.companyId !== companyId) throw badRequest('Staff member not found');
  if (!DOC_KINDS.includes(kind)) throw badRequest(`kind must be one of: ${DOC_KINDS.join(', ')}`);
  const id = uuid();
  const staged = await stageDocument({ employeeId, docId: id, bytes });
  try {
    getDb().prepare(`INSERT INTO employee_documents (id, company_id, employee_id, kind, title, file_path, mime, sha256, original_sha256, bytes, uploaded_by_user_id, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, companyId, employeeId, kind, str(title, 200), staged.relPath, staged.mime, staged.sha256, staged.originalSha256, staged.bytes, getCallerUserId(), Date.now());
  } catch (err) {
    staged.abort();
    throw err;
  }
  staged.commit();
  // 'hr_private': only hr.manage sees document rows in History (a title can say what the document is).
  require('./_fuelUtil').audit('hr_document', id, 'add', { after: { employeeId, kind, title: str(title, 200), mime: staged.mime, sha256: staged.sha256 }, sensitivity: 'hr_private' });
  return rowToDocument(getDocumentRow(id));
}

function voidDocument(id, reason) {
  const r = getDocumentRow(id);
  if (!r) throw badRequest('Document not found');
  if (r.voided_at) return rowToDocument(r);
  if (!str(reason, 500)) throw badRequest('Say why the document is voided');
  getDb().prepare('UPDATE employee_documents SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(Date.now(), str(reason, 500), getCallerUserId(), id);
  require('./_fuelUtil').audit('hr_document', id, 'void', { after: { reason: str(reason, 500) }, sensitivity: 'hr_private' });
  return rowToDocument(getDocumentRow(id));
}

module.exports = {
  setPin, clearPin, unlockPin, checkPin, isManagerEmployee,
  createSession, useSession, endSession, _clearSessions, _clearKioskState,
  listDocuments, getDocumentRow, addDocument, voidDocument, rowToDocument,
};
