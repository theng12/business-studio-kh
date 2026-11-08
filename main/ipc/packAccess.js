/**
 * Pick & Pack: who is calling and which company.
 *
 * The RPC gate (main/util/permissions.js) decides whether a channel may be
 * called at all. These helpers narrow the data to the caller's company and
 * tell the pack handlers whether the caller may manage orders (the packer may
 * not change settings or edit orders).
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

function callerCanManageOrders() {
  const caps = callerCaps();
  return caps === null || caps.has('*') || caps.has('orders.manage');
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

function emitPackChange(kind, op, id, companyId) {
  try {
    const { broadcast } = require('../events');
    broadcast('pack:changed', { kind, op, id: id ?? null, companyId: companyId ?? null, originUserId: getCallerUserId() });
  } catch (_) { /* best effort */ }
}

module.exports = { callerCaps, callerCanManageOrders, activeCompanyId, emitPackChange, getCallerUserId };
