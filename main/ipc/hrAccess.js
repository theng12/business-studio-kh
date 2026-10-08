/**
 * HR1: who is calling and what they may see (docs/PEOPLE_AND_FUEL_PLAN.md §6).
 *
 * The RPC gate (main/util/capabilities.js) decides whether a caller may use a
 * channel at all. These helpers narrow WHAT a permitted caller gets back:
 *
 *   level 'full'       hr.manage, admin, or this Mac's own window (no caller —
 *                      not gated, as everywhere): every field.
 *   level 'directory'  hr.view: the staff directory WITHOUT ID / NSSF numbers,
 *                      bank details, date of birth and address; attendance
 *                      without clock-in photos; no documents.
 *   level 'fuel'       fuel.manage without an HR capability: the F1 staff
 *                      record only — no notes, no status reason, no HR field
 *                      (review fix L2). staff:update ignores the notes from
 *                      such a caller (it cannot see them, so it must not
 *                      overwrite them).
 *   level 'tile'       anyone else allowed on the channel (fuel.record, the
 *                      kiosk): code, names, photo flag, position, status.
 */

const { userError } = require('../util/userError');
const { callerCaps } = require('./fuelAccess');
const { getCallerUserId } = require('../db/_util');
const { SENSITIVE_FIELDS } = require('../db/employees');

function has(caps, ...keys) { return caps === null || caps.has('*') || keys.some((k) => caps.has(k)); }

function canManageHr() { return has(callerCaps(), 'hr.manage'); }
function canViewHr() { return has(callerCaps(), 'hr.view', 'hr.manage'); }

function staffLevel() {
  const caps = callerCaps();
  if (has(caps, 'hr.manage')) return 'full';
  if (has(caps, 'hr.view')) return 'directory';
  if (has(caps, 'fuel.manage')) return 'fuel';
  return 'tile';
}

/** The F1 fields (fuel.manage's view), without notes. */
const FUEL_FIELDS = ['id', 'companyId', 'staffCode', 'nameEn', 'nameKm', 'phone', 'hasPhoto', 'photoSha256', 'position', 'isDriver',
  'isFuelAttendant', 'status', 'leftOn', 'leftReason', 'userId', 'createdAt', 'updatedAt', 'updatedByUserId'];
function fuelView(e) {
  const out = {};
  for (const k of FUEL_FIELDS) if (k in e) out[k] = e[k];
  return out;
}

/** What a recorder / kiosk needs for a tile — no phone number, notes, account link or HR fields. */
function tile(e) {
  return {
    id: e.id, companyId: e.companyId, staffCode: e.staffCode, nameEn: e.nameEn, nameKm: e.nameKm,
    hasPhoto: e.hasPhoto, photoSha256: e.photoSha256, position: e.position, isDriver: e.isDriver,
    isFuelAttendant: e.isFuelAttendant, status: e.status,
  };
}

function directory(e) {
  const out = { ...e };
  for (const k of SENSITIVE_FIELDS) delete out[k];
  return out;
}

function forLevel(e, level = staffLevel()) {
  if (!e) return e;
  if (level === 'full') return e;
  if (level === 'directory') return directory(e);
  if (level === 'fuel') return fuelView(e);
  return tile(e);
}

/** The staff record linked to the calling account in this company (attendance.self / supervise). */
function callerEmployee(companyId, { required = true } = {}) {
  const uid = getCallerUserId();
  const e = uid ? require('../db/employees').getByUserId(companyId, uid) : null;
  if (!e && required) {
    const err = userError('This account is not linked to a staff record in this company — ask the office to link it');
    err.code = 'NOT_LINKED';
    throw err;
  }
  return e;
}

/** Live-update event: ids only, so any listener may receive it. */
function emitHrChange(kind, op, id, companyId) {
  try {
    const { broadcast } = require('../events');
    broadcast('hr:changed', { kind, op, id: id ?? null, companyId: companyId ?? null, originUserId: getCallerUserId() });
  } catch (_) { /* best effort */ }
}

module.exports = { canManageHr, canViewHr, staffLevel, tile, directory, fuelView, forLevel, callerEmployee, emitHrChange, FUEL_FIELDS };
