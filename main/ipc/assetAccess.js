/**
 * Fixed Assets A0/A1: who is calling, which company, and what they may see
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §9).
 *
 * The RPC gate (main/server/index.js → main/util/permissions.js) already
 * decides whether a caller may reach a channel at all. A few channels are
 * open to more than one capability and narrow WHAT they return here — e.g.
 * `assets:getFile` is open to `assets.count` (the phone count page) but a
 * counter gets photos only, never invoices or other documents.
 *
 * Local calls (this Mac's own window) carry no caller and are not gated, the
 * same as every other channel.
 */

const { callerCaps, activeCompanyId, inCompany, getCallerUserId } = require('./fuelAccess');

function has(cap) {
  const caps = callerCaps();
  return caps === null || caps.has('*') || caps.has(cap);
}

function callerCanView() { return has('assets.view') || has('assets.manage'); }
function callerCanManage() { return has('assets.manage'); }
/** The admin role ('*') or this Mac's own window. */
function callerIsAdmin() {
  const caps = callerCaps();
  return caps === null || caps.has('*');
}

/**
 * The active company, made ready for the register: the built-in categories
 * and chart exist, and (once per company) every fuel vehicle has its draft
 * register entry (main/db/assetIdentity.js). Runs on the first assets:* call
 * for a company — never at boot.
 */
function assetCompany(requested) {
  const companyId = activeCompanyId(requested);
  require('../db/assetConfig').ensureCategories(companyId);
  require('../db/assetIdentity').ensureFuelLinked(companyId);
  return companyId;
}

/** Live-update event. Ids only — never the record — so every listener may receive it. */
function emitAssetChange(kind, op, id, companyId) {
  try {
    const { broadcast } = require('../events');
    broadcast('assets:changed', { kind, op, id: id ?? null, companyId: companyId ?? null, originUserId: getCallerUserId() });
  } catch (_) { /* best effort */ }
}

module.exports = { has, callerCanView, callerCanManage, callerIsAdmin, assetCompany, activeCompanyId, inCompany, emitAssetChange, getCallerUserId };
