/**
 * v0.21.0: search:* IPC handler, extracted from ipc.js.
 *
 * One channel: `search:global` runs a case-insensitive LIKE query
 * across products / brands / categories — and, for an account that may
 * see costing, suppliers and PO numbers — for the active company.
 * Backs the Cmd+K palette shipped in v0.18.2.
 */

const companies = require('../db/companies');

/**
 * v0.1.89: may the caller see suppliers and purchase orders? The same
 * decision the server makes for `suppliers:list`, so search can never show
 * what the Suppliers screen would refuse. The host Mac's own renderer has no
 * caller id and is the implicit owner.
 */
function callerMayViewCosting() {
  let uid;
  try { uid = require('../server').getCurrentUserId?.() ?? null; } catch (_) { return true; }
  if (!uid) return true;
  try {
    const user = require('../db/users').get(uid);
    if (!user) return false;
    return require('../util/permissions').isAllowed(user.role, 'suppliers:list');
  } catch (_) {
    return false;
  }
}

function register({ expose }) {
  expose('search:global', ({ query, limit } = {}) => {
    const companyId = companies.getActiveId();
    if (!companyId) return [];
    const { globalSearch } = require('../db/search');
    return globalSearch(companyId, query, Math.min(limit ?? 30, 100), {
      includeCosting: callerMayViewCosting(),
    });
  });
}

module.exports = { register, callerMayViewCosting };
