const access = require('./payrollAccess');
const service = () => require('../db/employeeLoans');
const imports = () => require('../db/loanImports');
const CAP = 'loans.manage';
function read(args, fn) { return fn(access.company(args, CAP), access.input(args)); }
function write(args, op, fn, { admin = false, policy = null } = {}) {
  return read(args, (companyId, input) => {
    if (admin) access.assertAdmin();
    if (policy) access.approval(companyId, CAP, policy);
    return access.changed('loan', op, fn(companyId, input), companyId);
  });
}
function sample(args) {
  return read(args, companyId => ({ companyId, ...imports().sampleWorkbook(companyId) }));
}
function register({ expose, exposeLocal }) {
  expose('loans:listEmployees', args => read(args, companyId => access.listEmployees(companyId)));
  expose('loans:getPolicy', args => read(args, companyId => {
    const settings = require('../db/payrollConfig').getSettings(companyId);
    return Object.fromEntries(['installmentMinor', 'installmentCurrency', 'maxDeductionPercent', 'loanApprovalPolicy',
      'rateChangePolicy', 'postponementPolicy', 'policyConfirmed', 'complianceWarning'].map(key => [key, settings[key]]));
  }));
  expose('loans:list', args => read(args, (c, p) => service().list(c, p)));
  expose('loans:get', args => read(args, (c, p) => service().get(c, p.id)));
  expose('loans:create', args => write(args, 'create', (c, p) => service().create(c, p)));
  expose('loans:approve', args => write(args, 'approve', (c, p) => service().approve(c, p.id), { policy: 'loanApprovalPolicy' }));
  expose('loans:voidDraft', args => write(args, 'void', (c, p) => service().voidDraft(c, p)));
  expose('loans:changeRate', args => write(args, 'rate', (c, p) => service().changeRate(c, p), { policy: 'rateChangePolicy' }));
  expose('loans:accrue', args => write(args, 'accrue', (c, p) => service().accrue(c, p)));
  expose('loans:repay', args => write(args, 'repay', (c, p) => service().repay(c, p)));
  expose('loans:postpone', args => write(args, 'postpone', (c, p) => service().postpone(c, p), { policy: 'postponementPolicy' }));
  expose('loans:reverseEntry', args => write(args, 'reverse', (c, p) => service().reverseEntry(c, p), { admin: true }));
  expose('loans:writeOff', args => write(args, 'writeoff', (c, p) => service().writeOff(c, p), { admin: true }));
  expose('loans:project', args => read(args, (c, p) => service().project(c, p.id, { through: p.through })));
  expose('loans:importColumns', args => read(args, () => imports().importColumns()));
  expose('loans:importPlan', args => read(args, (c, p) => imports().preview(c, p)));
  expose('loans:importApply', args => read(args, (c, p) => {
    const result = imports().apply(c, p);
    return result.applied ? access.changed('loan', 'import', result, c) : result;
  }));
  expose('loans:getImportSample', sample);
  exposeLocal('loans:saveImportSample', async args => {
    const first = sample(args);
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog({ title: 'Save opening loans sample', defaultPath: first.filename,
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }] });
    if (result.canceled || !result.filePath) return null;
    access.recheck(first.companyId, CAP);
    const fresh = sample(args);
    require('node:fs').writeFileSync(result.filePath, fresh.bytes);
    return result.filePath;
  });
}
module.exports = { register };
