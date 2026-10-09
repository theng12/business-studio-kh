const access = require('./payrollAccess');
const { getCallerUserId } = require('../db/_util');
const { userError } = require('../util/userError');
const service = () => require('../db/payroll');
const config = () => require('../db/payrollConfig');
const CAP = 'payroll.manage';
function read(args, fn) { return fn(access.company(args, CAP), access.input(args)); }
function write(args, op, fn, { admin = false, policy = null } = {}) {
  return read(args, (companyId, input) => {
    if (admin) access.assertAdmin();
    if (policy) access.approval(companyId, CAP, policy);
    return access.changed('payroll', op, fn(companyId, input), companyId);
  });
}

// Document fields come from frozen inputs, never a current employee lookup.
function plannedLoanBalance(line) {
  const plans = line.snapshot?.loanPlans;
  if (!Array.isArray(plans) || !plans.length) return undefined;
  let total = 0;
  for (const plan of plans) {
    if (plan.currency !== line.currency || !['principalMinor', 'interestMinor', 'amountMinor'].every(k => Number.isSafeInteger(plan[k]) && plan[k] >= 0)) return undefined;
    const opening = plan.principalMinor + plan.interestMinor;
    const after = opening - plan.amountMinor;
    if (!Number.isSafeInteger(opening) || after < 0 || !Number.isSafeInteger(total + after)) return undefined;
    total += after;
  }
  return total;
}
function documentLine(line) {
  const employee = line.snapshot?.employee || {};
  const policy = line.snapshot?.policy || {};
  return { ...line, ...Object.fromEntries(['staffCode', 'nameEn', 'nameKm', 'bankName', 'bankAccountName', 'bankAccountNo', 'nssfNo'].map(key => [key, employee[key]])),
    applyTax: policy.applyTax, applyNssf: policy.applyNssf, estimate: line.snapshot?.estimate ?? line.estimate,
    loanBalanceAfterMinor: plannedLoanBalance(line),
    leaveBalances: line.snapshot?.leaveBalances, leaveBalanceAsOf: line.snapshot?.leaveBalanceAsOf };
}
function selfSession(args, expectedCompanyId) {
  access.assertCap('attendance.kiosk', 'hr.manage');
  const companyId = require('./fuelAccess').activeCompanyId(expectedCompanyId);
  const session = require('../db/hrPeople').useSession(args.sessionToken, { kioskUserId: getCallerUserId(), companyId });
  return { companyId, employeeId: session.employeeId };
}
function selfLine(args, expectedCompanyId) {
  const { companyId, employeeId } = selfSession(args, expectedCompanyId);
  const context = access.lineContext(companyId, args.id);
  if (context.line.employeeId !== employeeId || !['approved', 'paid'].includes(context.run.status)) throw userError('Approved payslip not found for this session', 'NOT_FOUND');
  return { companyId, ...context };
}
async function payslip(args, self = false) {
  const companyId = self ? selfSession(args).companyId : access.company(args, CAP);
  const { run, line } = self ? selfLine(args, companyId) : access.lineContext(companyId, args.id);
  const companyName = run.input?.companyName ?? require('../db/companies').get(companyId)?.name;
  const html = require('../util/payrollDocuments').buildPayslipHtml({ companyName, run, line: documentLine(line) });
  const bytes = await require('../renderWindow').toPdfBuffer(html, { pageSize: 'A5', landscape: false, printBackground: true });
  let fresh;
  if (self) fresh = selfLine(args, companyId);
  else { access.recheck(companyId, CAP); fresh = access.lineContext(companyId, args.id); }
  if (fresh.run.status !== run.status || fresh.run.revision !== run.revision) throw userError('Payroll changed while rendering the payslip; export it again');
  return { companyId, filename: `payslip-${run.month}-${line.id}.pdf`, bytes };
}
async function runPdf(args) {
  const companyId = access.company(args, CAP);
  const run = service().get(companyId, args.id);
  const companyName = run.input?.companyName ?? require('../db/companies').get(companyId)?.name;
  const html = require('../util/payrollDocuments').buildPayrollRunHtml({ companyName, run, lines: run.lines.map(documentLine) });
  const bytes = await require('../renderWindow').toPdfBuffer(html, { pageSize: 'A5', landscape: false, printBackground: true });
  access.recheck(companyId, CAP);
  const fresh = service().get(companyId, args.id);
  if (fresh.status !== run.status || fresh.revision !== run.revision) throw userError('Payroll changed while rendering the run; export it again');
  return { companyId, filename: `payroll-${run.month}-${run.id}.pdf`, bytes };
}
function workbook(args) {
  return read(args, (companyId, input) => {
    const run = service().get(companyId, input.id);
    const companyName = run.input?.companyName ?? require('../db/companies').get(companyId)?.name;
    return { companyId, ...require('../util/payrollDocuments').buildPayrollWorkbook({ companyName, run, lines: run.lines.map(documentLine) }) };
  });
}
async function saveDocument(args, build, extension, self = false) {
  const first = await build(args);
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow?.() || BrowserWindow.getAllWindows?.()[0] || null;
  const options = { title: extension === 'pdf' ? (build === runPdf ? 'Save payroll run' : 'Save payslip') : 'Save payroll workbook', defaultPath: first.filename,
    filters: [{ name: extension === 'pdf' ? 'PDF' : 'Workbook', extensions: [extension] }] };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  if (self) selfLine(args, first.companyId); else access.recheck(first.companyId, CAP);
  // The dialog may outlive a void/recalculation. Build from the newly checked state.
  const fresh = await build(args);
  if (fresh.companyId !== first.companyId) throw userError('Company changed while saving payroll', 'CROSS_COMPANY');
  require('node:fs').writeFileSync(result.filePath, fresh.bytes);
  return result.filePath;
}

function register({ expose, exposeLocal }) {
  expose('payroll:listEmployees', args => read(args, c => access.listEmployees(c)));
  expose('payroll:getSettings', args => read(args, c => config().getSettings(c)));
  expose('payroll:updateSettings', args => write(args, 'settings', (c, p) => config().updateSettings(c, p.patch), { admin: true }));
  expose('payroll:getEmployeePolicy', args => read(args, (c, p) => config().getEmployeePolicy(c, p.employeeId)));
  expose('payroll:setEmployeePolicy', args => write(args, 'employee-policy', (c, p) => config().setEmployeePolicy(c, p)));
  expose('payroll:listPayRates', args => read(args, (c, p) => config().listPayRates(c, p.employeeId)));
  expose('payroll:setPayRate', args => write(args, 'pay-rate', (c, p) => config().setPayRate(c, p)));
  expose('payroll:listComponents', args => read(args, c => config().listComponents(c)));
  expose('payroll:saveComponent', args => write(args, 'component', (c, p) => config().saveComponent(c, p)));
  expose('payroll:listEmployeeComponents', args => read(args, (c, p) => config().listEmployeeComponents(c, p.employeeId)));
  expose('payroll:setEmployeeComponent', args => write(args, 'employee-component', (c, p) => config().setEmployeeComponent(c, p)));
  expose('payroll:listRateSets', args => read(args, c => config().listRateSets(c)));
  expose('payroll:saveRateSet', args => write(args, 'statutory-draft', (c, p) => {
    if (p.id && config().listRateSets(c).some(s => s.id === p.id && s.status === 'confirmed')) access.assertAdmin();
    return config().saveRateSet(c, p);
  }));
  expose('payroll:confirmRateSet', args => write(args, 'statutory-confirm', (c, p) => config().confirmRateSet(c, p), { admin: true }));
  expose('payroll:list', args => read(args, (c, p) => service().list(c, p)));
  expose('payroll:get', args => read(args, (c, p) => service().get(c, p.id)));
  expose('payroll:create', args => write(args, 'create', (c, p) => service().create(c, p)));
  expose('payroll:calculate', args => write(args, 'calculate', (c, p) => service().calculate(c, p.id)));
  expose('payroll:updateLine', args => write(args, 'line', (c, p) => service().updateLine(c, p)));
  expose('payroll:review', args => write(args, 'review', (c, p) => service().review(c, p)));
  expose('payroll:approve', args => write(args, 'approve', (c, p) => service().approve(c, p), { policy: 'approvalPolicy' }));
  expose('payroll:pay', args => write(args, 'pay', (c, p) => service().pay(c, p)));
  expose('payroll:reversePayment', args => write(args, 'reverse', (c, p) => service().reversePayment(c, p), { admin: true }));
  expose('payroll:voidRun', args => write(args, 'void', (c, p) => {
    if (['approved', 'paid'].includes(service().get(c, p.id).status)) access.assertAdmin();
    return service().voidRun(c, p);
  }));
  expose('payroll:fetchSalaryTaxRate', async args => {
    const companyId = access.company(args, CAP);
    const proposed = await require('../util/payrollExchangeRate').fetchSalaryTaxRate({ month: args.month });
    access.recheck(companyId, CAP);
    return proposed;
  });
  expose('payroll:getPayslipPdf', args => payslip(args));
  expose('payroll:getRunPdf', runPdf);
  expose('payroll:getWorkbook', workbook);
  exposeLocal('payroll:savePayslipPdf', args => saveDocument(args, payslip, 'pdf'));
  exposeLocal('payroll:saveRunPdf', args => saveDocument(args, runPdf, 'pdf'));
  exposeLocal('payroll:saveWorkbook', args => saveDocument(args, workbook, 'xlsx'));

  expose('kiosk:payroll', args => {
    const { companyId, employeeId } = selfSession(args);
    return service().list(companyId).filter(r => ['approved', 'paid'].includes(r.status)).flatMap(r => {
      const run = service().get(companyId, r.id);
      return run.lines.filter(l => l.employeeId === employeeId).map(l => ({ id: l.id, runId: run.id, month: run.month,
        periodStart: run.periodStart, periodEnd: run.periodEnd, payDate: run.payDate, status: run.status,
        currency: l.currency, netMinor: l.netMinor, paidMinor: l.paidMinor, remainingMinor: l.remainingMinor }));
    });
  });
  expose('kiosk:loans', args => {
    const { companyId, employeeId } = selfSession(args);
    return require('../db/employeeLoans').list(companyId, { employeeId }).filter(l => l.status !== 'draft').map(l => ({
      id: l.id, loanNo: l.loanNo, currency: l.currency, status: l.status, principalMinor: l.principalMinor, interestMinor: l.interestMinor,
    }));
  });
  expose('kiosk:getPayslipPdf', args => payslip(args, true));
  exposeLocal('kiosk:savePayslipPdf', args => saveDocument(args, a => payslip(a, true), 'pdf', true));
}
module.exports = { register, documentLine, payslip, workbook };
