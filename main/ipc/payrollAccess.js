const { callerCaps, activeCompanyId } = require('./fuelAccess');
const { emitHrChange } = require('./hrAccess');
const { userError } = require('../util/userError');

function has(...keys) {
  const uid = require('../db/_util').getCallerUserId();
  if (uid) {
    const user = require('../db/users').get(uid);
    if (!user || user.deactivatedAt != null) return false;
  }
  const caps = callerCaps();
  return caps === null || caps.has('*') || keys.some(key => caps.has(key));
}
function admin() { return has(); }
function assertCap(...keys) {
  if (!has(...keys)) throw userError('You do not have permission to access payroll or loans');
}
function assertAdmin() {
  if (!admin()) throw userError('Only an admin may perform this financial action');
}
function company(args, cap) {
  assertCap(cap);
  return activeCompanyId(args?.companyId);
}
function recheck(companyId, cap) {
  assertCap(cap);
  activeCompanyId(companyId);
}
function approval(companyId, cap, policyKey) {
  recheck(companyId, cap);
  const policy = require('../db/payrollConfig').getSettings(companyId)[policyKey];
  if (!admin() && policy !== 'designated_managers') throw userError('Company policy requires admin approval');
}
function input(args = {}) {
  const { companyId: _companyId, ...payload } = args;
  return payload;
}
function listEmployees(companyId) {
  return require('../db/employees').list(companyId).map(e => ({
    id: e.id, companyId: e.companyId, staffCode: e.staffCode, nameEn: e.nameEn,
    nameKm: e.nameKm, status: e.status, position: e.position,
  }));
}
function scopedRow(table, companyId, id) {
  // Table names are internal literals, never renderer input.
  if (!['payroll_lines', 'payroll_payments', 'loan_entries'].includes(table)) throw new Error('Unknown financial record');
  const row = require('../db').getDb().prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(id, companyId);
  if (!row) throw userError('Financial record not found in this company', 'NOT_FOUND');
  return row;
}
function lineContext(companyId, id) {
  const row = scopedRow('payroll_lines', companyId, id);
  const run = require('../db/payroll').get(companyId, row.run_id);
  const line = run.lines.find(x => x.id === id);
  if (!line) throw userError('This payslip has been superseded', 'NOT_FOUND');
  return { run, line };
}
function changed(kind, op, result, companyId) {
  emitHrChange(kind, op, result?.id ?? null, companyId);
  return result;
}
module.exports = { admin, assertCap, assertAdmin, company, recheck, approval, input, listEmployees, scopedRow, lineContext, changed };
