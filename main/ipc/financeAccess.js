const { callerCaps, activeCompanyId, getCallerUserId } = require('./fuelAccess');
const { getDb } = require('../db');

function denied(message = 'You do not have permission to use Finance') {
  const error = new Error(message);
  error.code = 'FORBIDDEN';
  error.userFacing = true;
  return error;
}

function isOwner() {
  const caps = callerCaps();
  return caps === null || caps.has('*');
}

function requireOwner() {
  if (!isOwner()) throw denied('Only the owner can approve expenses or change Finance setup');
}

function permissions() {
  const caps = callerCaps();
  const owner = caps === null || caps.has('*');
  return {
    canRecord: owner || caps.has('finance.record'),
    canViewAll: owner || caps.has('finance.view'),
    canManage: owner,
    canApprove: owner,
  };
}

function supervisedBranches(companyId) {
  const userId = getCallerUserId();
  if (!userId) return [];
  return getDb().prepare(`
    SELECT b.id FROM branches b JOIN employees e ON e.id = b.manager_employee_id
    WHERE b.company_id = ? AND e.company_id = ? AND e.user_id = ? AND e.status = 'active'
  `).all(companyId, companyId, userId).map((b) => b.id);
}

function branchScope(companyId, { write = false } = {}) {
  activeCompanyId(companyId);
  const allowed = permissions();
  if (write && !allowed.canRecord) throw denied('You do not have permission to record expenses');
  if (allowed.canManage || (!write && allowed.canViewAll)) return null;
  if (!allowed.canRecord) throw denied();
  const ids = supervisedBranches(companyId);
  if (!ids.length) throw denied('This account does not supervise a branch in this company — ask the owner to assign one');
  return ids;
}

function requireBranch(companyId, branchId, options) {
  const scope = branchScope(companyId, options);
  if (!branchId || (scope !== null && !scope.includes(branchId))) {
    throw denied('That expense is outside the branches you supervise');
  }
  const branch = require('../db/branches').get(branchId);
  if (!branch || branch.companyId !== companyId) throw denied('That branch is not in this company');
  return branch;
}

function emitFinanceChange(kind, op, id, companyId) {
  require('../events').broadcast('finance:changed', {
    kind, op, id: id ?? null, companyId, originUserId: getCallerUserId(),
  });
}

module.exports = { denied, isOwner, requireOwner, permissions, supervisedBranches, branchScope, requireBranch, emitFinanceChange };
