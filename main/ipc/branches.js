/**
 * Fixed Assets A0: branches over IPC/RPC (docs/ASSETS_AND_BRANCHES_PLAN.md §3.1, §9).
 *
 * `branches:list` / `branches:get` are baseline reads — the Staff, Fuel and
 * phone screens need branch names, and they reveal nothing sensitive. Creating,
 * editing and closing a branch is `system.manage` (Settings → Company →
 * Branches), because staff and tanks use branches too, not only assets.
 */

const branches = require('../db/branches');
const { activeCompanyId, inCompany, emitAssetChange } = require('./assetAccess');

function register({ expose }) {
  expose('branches:list', (opts = {}) => branches.list(activeCompanyId(), opts || {}));
  expose('branches:get', (id) => inCompany(branches.get(id), 'Branch'));
  expose('branches:create', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const b = branches.create({ ...input, companyId });
    emitAssetChange('branch', 'create', b.id, companyId);
    return b;
  });
  expose('branches:update', ({ id, patch } = {}) => {
    inCompany(branches.get(id), 'Branch');
    const b = branches.update(id, patch || {});
    emitAssetChange('branch', 'update', id, b.companyId);
    return b;
  });
  expose('branches:close', ({ id, reason } = {}) => {
    inCompany(branches.get(id), 'Branch');
    const b = branches.close(id, reason);
    emitAssetChange('branch', 'close', id, b.companyId);
    return b;
  });
  /** The one-screen "Set up branches" (§3.1): Fuel's free-text home locations, as suggestions only. */
  expose('branches:suggestFromFuel', () => branches.suggestionsFromFuel(activeCompanyId()));
}

module.exports = { register };
