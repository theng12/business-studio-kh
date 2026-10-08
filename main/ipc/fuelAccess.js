/**
 * Fuel F1: who is calling, which company, and what they may see.
 *
 * The RPC gate (main/server/index.js → main/util/permissions.js) already
 * decides whether a phone or client Mac may call a channel at all. A few
 * channels are open to `fuel.record` but must still narrow WHAT they return —
 * an attendant may read the photos of records they entered, not everyone's.
 * Those handlers ask `callerCanManage()`.
 *
 * Local calls (this Mac's own window) carry no caller and are not gated, the
 * same as every other channel (docs/PEOPLE_AND_FUEL_PLAN.md §2 gap 1).
 */

const { getCallerUserId } = require('../db/_util');

function callerCaps() {
  const uid = getCallerUserId();
  if (!uid) return null; // local window — not gated
  try {
    const user = require('../db/users').get(uid);
    if (!user) return new Set();
    return require('../db/roles').getCapabilityKeys(user.role) || new Set();
  } catch (_) {
    return new Set();
  }
}

function callerCanManage() {
  const caps = callerCaps();
  return caps === null || caps.has('*') || caps.has('fuel.manage');
}

/** The active company for this caller; a different companyId in the args is refused. */
function activeCompanyId(requested) {
  const companies = require('../db/companies');
  const active = companies.getActiveId();
  if (!active) throw new Error('Pick a company first');
  if (requested && requested !== active) {
    const err = new Error('That belongs to a different company');
    err.code = 'CROSS_COMPANY';
    throw err;
  }
  return active;
}

function inCompany(entity, kind) {
  if (!entity) {
    const err = new Error(`${kind} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  activeCompanyId(entity.companyId);
  return entity;
}

let _writeVersion = 0;
/** Bumped on every fuel write; caches keyed on it (the overview's monthly figure) go stale with it. */
function fuelWriteVersion() { return _writeVersion; }

/** Live-update event. Ids only — never the record itself — so every listener may receive it. */
function emitFuelChange(kind, op, id, companyId) {
  _writeVersion += 1;
  try {
    const { broadcast } = require('../events');
    broadcast('fuel:changed', { kind, op, id: id ?? null, companyId: companyId ?? null, originUserId: getCallerUserId() });
  } catch (_) { /* best effort */ }
}

module.exports = { callerCaps, callerCanManage, activeCompanyId, inCompany, emitFuelChange, fuelWriteVersion, getCallerUserId };
