/**
 * HR1: the parts of a staff record that are not plain fields — the kiosk PIN,
 * documents, and the short-lived kiosk sessions
 * (docs/PEOPLE_AND_FUEL_PLAN.md §3.1, §5.2, §6).
 *
 * PIN: scrypt with a per-employee salt (main/util/kioskPin.js); 5 wrong tries
 * lock that person's PIN for 10 minutes (settings pinMaxTries /
 * pinLockMinutes). Neither the PIN nor its hash ever leaves this module or
 * enters History.
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

function setPin(employeeId, pin) {
  const e = employees.get(employeeId);
  if (!e) throw badRequest('Staff member not found');
  const problem = pinUtil.pinProblem(pin);
  if (problem) throw badRequest(problem);
  const { hash, salt } = pinUtil.hashPin(pin);
  getDb().prepare('UPDATE employees SET kiosk_pin_hash = ?, pin_salt = ?, pin_failed_count = 0, pin_locked_until = NULL, pin_set_at = ? WHERE id = ?')
    .run(hash, salt, Date.now(), employeeId);
  hrAudit('employee', employeeId, 'pin:set', { after: { pin: '(set)' } });
  return employees.get(employeeId);
}

function clearPin(employeeId) {
  const e = employees.get(employeeId);
  if (!e) throw badRequest('Staff member not found');
  getDb().prepare('UPDATE employees SET kiosk_pin_hash = NULL, pin_salt = NULL, pin_failed_count = 0, pin_locked_until = NULL, pin_set_at = NULL WHERE id = ?').run(employeeId);
  hrAudit('employee', employeeId, 'pin:clear', { after: { pin: null } });
  return employees.get(employeeId);
}

function unlockPin(employeeId) {
  getDb().prepare('UPDATE employees SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = ?').run(employeeId);
  hrAudit('employee', employeeId, 'pin:unlock', {});
  return employees.get(employeeId);
}

/**
 * Check a PIN and update the counters. Throws a plain sentence when the PIN
 * is wrong or locked (the kiosk shows it), returns the employee when right.
 */
function checkPin(employeeId, pin, { companyId, now = Date.now() } = {}) {
  const row = employees.getRow(employeeId);
  if (!row || row.company_id !== companyId) throw badRequest('That person is not on this company\'s staff list');
  if (!row.kiosk_pin_hash) throw badRequest('No PIN is set for this person yet — ask a manager');
  const settings = hr.getSettings(companyId);
  const lock = pinUtil.lockState({ lockedUntil: row.pin_locked_until, now });
  if (lock.locked) {
    const err = new Error(`Too many wrong PINs. Try again in ${Math.ceil(lock.retryInSeconds / 60)} min.`);
    err.code = 'PIN_LOCKED';
    err.retryAt = lock.retryAt;
    throw err;
  }
  const correct = pinUtil.verifyPin(pin, row.kiosk_pin_hash, row.pin_salt);
  const next = pinUtil.afterAttempt({ correct, failedCount: row.pin_failed_count, now, maxTries: settings.pinMaxTries, lockMinutes: settings.pinLockMinutes });
  getDb().prepare('UPDATE employees SET pin_failed_count = ?, pin_locked_until = ? WHERE id = ?').run(next.failedCount, next.lockedUntil, employeeId);
  if (!correct) {
    if (next.locked) hrAudit('employee', employeeId, 'pin:locked', { after: { lockedUntil: next.lockedUntil } });
    const err = new Error(next.locked
      ? `Wrong PIN. Locked for ${settings.pinLockMinutes} min — ask a manager.`
      : `Wrong PIN. ${next.triesLeft} ${next.triesLeft === 1 ? 'try' : 'tries'} left.`);
    err.code = next.locked ? 'PIN_LOCKED' : 'PIN_WRONG';
    throw err;
  }
  return employees.get(employeeId);
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
  hrAudit('hr_document', id, 'add', { after: { employeeId, kind, title: str(title, 200), mime: staged.mime, sha256: staged.sha256 } });
  return rowToDocument(getDocumentRow(id));
}

function voidDocument(id, reason) {
  const r = getDocumentRow(id);
  if (!r) throw badRequest('Document not found');
  if (r.voided_at) return rowToDocument(r);
  if (!str(reason, 500)) throw badRequest('Say why the document is voided');
  getDb().prepare('UPDATE employee_documents SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(Date.now(), str(reason, 500), getCallerUserId(), id);
  hrAudit('hr_document', id, 'void', { after: { reason: str(reason, 500) } });
  return rowToDocument(getDocumentRow(id));
}

module.exports = {
  setPin, clearPin, unlockPin, checkPin, isManagerEmployee,
  createSession, useSession, endSession, _clearSessions,
  listDocuments, getDocumentRow, addDocument, voidDocument, rowToDocument,
};
