// HR2 trust boundary: unknown fields are refused, including nested actor fields.
const object = v => v != null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = v => typeof v === 'string' && !!v.trim() && v.length <= 2000;
const id = v => text(v) && v.length <= 200;
const boolean = v => typeof v === 'boolean';
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER) => v => Number.isSafeInteger(v) && v >= min && v <= max;
const money = integer();
const percent = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const fx = v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100000;
const oneOf = (...values) => v => values.includes(v);
const optional = (check, nullable = false) => v => v === undefined || (nullable && v === null) || check(v);
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= '1900-01-01' && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const month = v => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) && date(`${v}-01`);
const array = (check, min = 0, max = 500) => v => Array.isArray(v) && v.length >= min && v.length <= max && v.every(x => check(x) === true);

function shape(fields, { empty = false, company = false } = {}) {
  const checks = company ? { ...fields, companyId: optional(id) } : fields;
  return input => {
    const a = empty && input == null ? {} : input;
    if (!object(a)) return 'expected an object argument';
    for (const key of Object.keys(a)) if (!Object.hasOwn(checks, key)) return `unknown field: ${key}`;
    for (const [key, check] of Object.entries(checks)) {
      const result = check(a[key]);
      if (result !== true) return typeof result === 'string' ? `${key}: ${result}` : `invalid or missing ${key}`;
    }
    return true;
  };
}
const data = (fields, empty = false) => shape(fields, { company: true, empty });
const currency = oneOf('USD', 'KHR');
const policy = oneOf('admin', 'designated_managers');
const reason = text;
const action = { id, reason, operationId: id };
const settings = shape({
  payCycle: optional(oneOf('monthly', 'twice_monthly_advance', 'twice_monthly_separate')),
  payday: optional(integer(1, 28)), monthlyDivisor: optional(oneOf('scheduled_working_days', 'fixed')),
  fixedDivisor: optional(integer(1, 366), true), approvalPolicy: optional(policy), loanApprovalPolicy: optional(policy),
  rateChangePolicy: optional(policy), postponementPolicy: optional(policy), maxDeductionPercent: optional(percent),
  installmentMinor: optional(integer(1), true), installmentCurrency: optional(currency),
  taxRateKhrPerUsd: optional(fx, true), rateSource: optional(text, true),
  nssfRateKhrPerUsd: optional(fx, true), nssfRateSource: optional(text, true),
  loanRateKhrPerUsd: optional(fx, true), loanRateSource: optional(text, true),
  policyConfirmed: optional(boolean), policySource: optional(text, true),
});
const band = shape({ upperKhr: v => v === null || integer()(v), baseKhr: money });
const nssf = shape({ bands: optional(array(band, 0, 100)), components: array(shape({
  key: id, employeePercent: percent, employerPercent: percent, bands: optional(array(band, 1, 100)),
}), 0, 20) });
const tax = shape({
  brackets: array(shape({ upperKhr: v => v === null || integer(1)(v), ratePercent: percent }), 1, 100),
  spouseAllowanceKhr: money, dependentAllowanceKhr: money, maxDependents: v => v === null || integer(0, 100)(v),
  nonResidentPercent: percent, fringeBenefitPercent: percent, pensionDeductible: boolean,
});
const overrideShape = shape({ applyTax: optional(boolean), applyNssf: optional(boolean), reason });
const statutoryOverride = value => {
  const result = overrideShape(value);
  if (result !== true) return result;
  return typeof value.applyTax === 'boolean' || typeof value.applyNssf === 'boolean' || 'at least one statutory flag is required';
};
const linePatch = shape({
  dayDecisions: optional(array(shape({ date, payable: boolean, reason }), 0, 31)),
  loanDecisions: optional(array(shape({ loanId: id, amountMinor: money, reason }))), note: optional(text, true),
  statutoryOverride: optional(statutoryOverride, true),
});
const payrollCreate = data({
  periodStart: date, periodEnd: date, payDate: optional(date, true),
  employeeIds: v => array(id, 1, 500)(v) && new Set(v).size === v.length,
  kind: oneOf('regular', 'advance', 'settlement'), currency: optional(currency), advanceMinor: optional(money),
  taxRateKhrPerUsd: optional(fx, true), rateSource: optional(text, true),
  nssfRateKhrPerUsd: optional(fx, true), nssfRateSource: optional(text, true),
  loanRateKhrPerUsd: optional(fx, true), loanRateSource: optional(text, true),
  statutoryRateSetId: optional(id, true), statutoryOverride: optional(statutoryOverride, true), operationId: id,
});
const idArg = data({ id });
const read = data({}, true);
const employeeArg = data({ employeeId: id });
const revision = data({ id, expectedRevision: integer() });
const self = shape({ sessionToken: id });
const selfPdf = shape({ sessionToken: id, id });
// Spreadsheet values are untrusted cells. Preserve blanks/invalid scalar values
// for per-row service feedback; never accept caller authority or nested objects.
const importCell = optional(v => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.length <= 2000), true);
const importRow = shape({ ...Object.fromEntries(['loanNo', 'staffCode', 'originalPrincipalMinor', 'currentPrincipalMinor',
  'unpaidInterestMinor', 'balanceAsOf', 'currency', 'disbursedOn', 'interestMethod', 'interestPolicy', 'ratePercent',
  'interestFreeMonths', 'installmentMinor', 'maxDeductionPercent', 'deductViaPayroll', 'purpose'].map(k => [k, importCell])),
  rowNo: optional(integer(1), true) });

const PAYROLL_VALIDATORS = {
  'payroll:list': data({ month: optional(month), status: optional(oneOf('draft', 'reviewed', 'approved', 'paid', 'void')) }, true),
  'payroll:get': idArg, 'payroll:listEmployees': read, 'payroll:getSettings': read,
  'payroll:updateSettings': a => {
    const result = data({ patch: settings })(a);
    if (result !== true) return result;
    if (!Object.keys(a.patch).length) return 'patch must not be empty';
    return a.patch.policyConfirmed === true && !text(a.patch.policySource)
      ? 'policySource must record professional evidence covering pay frequency, deduction/recovery limits, lending/capitalization, statutory aggregation and FX/rounding'
      : true;
  },
  'payroll:getEmployeePolicy': employeeArg,
  'payroll:setEmployeePolicy': data({ employeeId: id, applyNssf: boolean, applyTax: boolean, taxResident: boolean,
    spouseCount: integer(0, 1), dependentCount: integer(0, 100), reason: optional(reason, true) }),
  'payroll:listPayRates': employeeArg,
  'payroll:setPayRate': data({ employeeId: id, effectiveFrom: date, basis: oneOf('month', 'day', 'hour'), amountMinor: money, currency, reason }),
  'payroll:listComponents': read,
  'payroll:saveComponent': data({ id: optional(id), code: id, nameEn: text, nameKm: optional(text, true),
    kind: oneOf('earning', 'deduction', 'employer_cost'), calc: oneOf('fixed', 'per_day', 'per_hour', 'percent'),
    defaultAmountMinor: optional(money), taxable: boolean, nssfContributory: boolean, isFringeBenefit: boolean, active: optional(boolean) }),
  'payroll:listEmployeeComponents': employeeArg,
  'payroll:setEmployeeComponent': data({ employeeId: id, componentId: id, amountMinor: money, currency, effectiveFrom: date, effectiveTo: optional(date, true) }),
  'payroll:listRateSets': read,
  'payroll:saveRateSet': data({ id: optional(id), name: text, effectiveFrom: date, effectiveTo: optional(date, true), sourceNote: optional(text, true), nssf: optional(nssf), tax: optional(tax, true) }),
  'payroll:confirmRateSet': data({ id, sourceNote: text }),
  'payroll:create': payrollCreate, 'payroll:calculate': idArg,
  'payroll:updateLine': data({ id, patch: linePatch, expectedRevision: integer() }),
  'payroll:review': revision, 'payroll:approve': revision,
  'payroll:pay': data({ id, amountMinor: money, method: oneOf('cash', 'bank', 'other'), paidAt: date, reference: optional(text, true), operationId: id }),
  'payroll:reversePayment': data(action), 'payroll:voidRun': data({ id, reason }),
  'payroll:fetchSalaryTaxRate': data({ month }),
  'payroll:getPayslipPdf': idArg, 'payroll:savePayslipPdf': idArg, 'payroll:getWorkbook': idArg, 'payroll:saveWorkbook': idArg,
  'payroll:getRunPdf': idArg, 'payroll:saveRunPdf': idArg,
  'loans:list': data({ employeeId: optional(id), status: optional(oneOf('draft', 'active', 'paid', 'written_off', 'void')) }, true),
  'loans:get': idArg, 'loans:listEmployees': read, 'loans:getPolicy': read,
  'loans:importColumns': read, 'loans:importPlan': data({ rows: array(importRow, 1, 500) }),
  'loans:importApply': data({ rows: array(importRow, 1, 500), operationId: id }),
  'loans:getImportSample': read, 'loans:saveImportSample': read,
  'loans:create': data({ employeeId: id, loanNo: optional(id), principalMinor: integer(1), currency, disbursedOn: date,
    interestMethod: oneOf('declining', 'none'), interestPolicy: oneOf('separate', 'capitalize'), ratePercent: percent,
    interestFreeMonths: integer(0, 120), installmentMinor: integer(1), maxDeductionPercent: optional(percent),
    deductViaPayroll: optional(boolean), purpose: optional(text, true), operationId: id }),
  'loans:approve': idArg,
  'loans:voidDraft': data(action),
  'loans:changeRate': data({ id, effectiveFrom: date, ratePercent: percent, reason, operationId: id }),
  'loans:accrue': data({ id, through: date, operationId: id }),
  'loans:repay': data({ id, amountMinor: integer(1), entryDate: date, source: oneOf('cash', 'bank'), note: optional(text, true), operationId: id }),
  'loans:postpone': data({ id, month, reason, operationId: id }),
  'loans:reverseEntry': data(action), 'loans:writeOff': data({ ...action, entryDate: date }),
  'loans:project': data({ id, through: date }),
  'kiosk:payroll': self, 'kiosk:loans': self, 'kiosk:getPayslipPdf': selfPdf, 'kiosk:savePayslipPdf': selfPdf,
};
module.exports = { PAYROLL_VALIDATORS };
