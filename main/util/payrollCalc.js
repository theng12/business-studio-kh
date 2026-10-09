/**
 * HR2 pure payroll arithmetic. Inputs are already prorated/capped by the caller.
 * USD money is cents; KHR money is whole riel. No statutory rates are built in.
 * Round half-up per overtime entry and per NSSF component, once for progressive
 * tax, and at every FX boundary. BigInt intermediates prevent float drift.
 *
 * Component kind defines cash treatment: earning adds to gross, deduction
 * reduces net, employer_cost does neither. Flags independently select statutory
 * bases; a flagged deduction reduces those bases. Fringe benefits are excluded
 * from salary tax and taxed separately to the employer. A noncash benefit must
 * be an employer_cost. Lateness reduces regular taxable/contributory pay; loan
 * deductions and prior advances settle net only. Only NSSF key 'pension' gives
 * pension relief, using its rounded KHR employee contribution before FX.
 * NSSF schemes may supply their own bands; shared bands are used only when
 * explicitly supplied. USD NSSF and salary tax require separate supplied FX.
 * A zero wage still follows the supplied band; an explicit first band with
 * upperKhr/baseKhr 0 can exempt it. Estimate reflects supplied rate-set status;
 * approval authority and employee exemptions remain the caller's responsibility.
 */

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function boolean(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text`);
  return value;
}

function array(value, label, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length)) throw new Error(`${label} must be ${nonempty ? 'a nonempty' : 'an'} array`);
  if (value.includes(undefined)) throw new Error(`${label} cannot contain missing entries`);
  return value;
}

function safe(value, label) {
  if (value > MAX || value < -MAX) throw new Error(`${label} exceeds the safe integer range`);
  return Number(value);
}

function sum(values, label) {
  return safe(values.reduce((total, value) => total + BigInt(value), 0n), label);
}

// Interpret the supplied Number's decimal spelling exactly, including exponents.
function ratio(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${label} must be a finite number from 0 to ${max}`);
  }
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction);
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n];
}

function round(numerator, denominator, label) {
  return safe((numerator + denominator / 2n) / denominator, label);
}

function percent(amount, rate, label) {
  const [n, d] = ratio(rate, label, 100);
  return round(BigInt(amount) * n, d * 100n, label);
}

function currency(value) {
  if (value !== 'USD' && value !== 'KHR') throw new Error('Currency must be USD or KHR');
  return value;
}

function convertMinor(amountMinor, from, to, khrPerUsd) {
  integer(amountMinor, 'amountMinor');
  currency(from);
  currency(to);
  if (from === to) {
    if (khrPerUsd !== undefined) exchangeRatio(khrPerUsd);
    return amountMinor;
  }
  const [n, d] = exchangeRatio(khrPerUsd);
  return from === 'USD'
    ? round(BigInt(amountMinor) * n, d * 100n, 'Converted amount')
    : round(BigInt(amountMinor) * d * 100n, n, 'Converted amount');
}

function exchangeRatio(value, label = 'KHR per USD') {
  const result = ratio(value, label);
  if (result[0] === 0n) throw new Error(`${label} must be above zero`);
  return result;
}

function validateNssfBands(value) {
  const bands = array(value, 'NSSF bands', true);
  let previousUpper = -1;
  let previousBase = 0;
  bands.forEach((band, i) => {
    object(band, 'NSSF band');
    const base = integer(band.baseKhr, 'NSSF baseKhr');
    if (base < previousBase) throw new Error('NSSF bases must be ordered');
    previousBase = base;
    if (band.upperKhr === null && i === bands.length - 1) return;
    const upper = integer(band.upperKhr, 'NSSF upperKhr');
    if (upper <= previousUpper) throw new Error('NSSF bands must have increasing upper bounds');
    previousUpper = upper;
  });
}

function validateRateSet(value) {
  const r = object(value, 'rateSet');
  if (!['draft', 'confirmed'].includes(r.status)) throw new Error('Rate set status must be draft or confirmed');
  const nssf = object(r.nssf, 'NSSF');
  if (nssf.bands !== undefined) validateNssfBands(nssf.bands);
  const keys = new Set();
  array(nssf.components, 'NSSF components', true).forEach((c) => {
    object(c, 'NSSF component');
    text(c.key, 'NSSF key');
    if (keys.has(c.key)) throw new Error('Duplicate NSSF component key');
    keys.add(c.key);
    ratio(c.employeePercent, 'NSSF employeePercent', 100);
    ratio(c.employerPercent, 'NSSF employerPercent', 100);
    if (c.bands !== undefined) validateNssfBands(c.bands);
    else if (nssf.bands === undefined) throw new Error(`NSSF ${c.key} requires supplied bands`);
  });
  const tax = object(r.tax, 'Tax');
  const brackets = array(tax.brackets, 'Tax brackets', true);
  let previousUpper = 0;
  let previousRate = 0;
  brackets.forEach((b, i) => {
    object(b, 'Tax bracket');
    ratio(b.ratePercent, 'Tax ratePercent', 100);
    if (b.ratePercent < previousRate) throw new Error('Progressive tax rates must be ordered');
    previousRate = b.ratePercent;
    if (b.upperKhr === null && i === brackets.length - 1) return;
    const upper = integer(b.upperKhr, 'Tax upperKhr');
    if (upper <= previousUpper) throw new Error('Tax brackets must have increasing upper bounds');
    previousUpper = upper;
  });
  integer(tax.spouseAllowanceKhr, 'spouseAllowanceKhr');
  integer(tax.dependentAllowanceKhr, 'dependentAllowanceKhr');
  if (tax.maxDependents !== null) integer(tax.maxDependents, 'maxDependents');
  ratio(tax.nonResidentPercent, 'nonResidentPercent', 100);
  ratio(tax.fringeBenefitPercent, 'fringeBenefitPercent', 100);
  boolean(tax.pensionDeductible, 'pensionDeductible');
  return r;
}

function progressiveTax(baseKhr, brackets) {
  let lower = 0;
  let numerator = 0n;
  let denominator = 1n;
  for (const bracket of brackets) {
    const upper = bracket.upperKhr === null ? baseKhr : Math.min(baseKhr, bracket.upperKhr);
    const [n, d] = ratio(bracket.ratePercent, 'Tax ratePercent', 100);
    numerator = numerator * d + BigInt(upper - lower) * n * denominator;
    denominator *= d;
    lower = upper;
    if (lower === baseKhr) return round(numerator, denominator * 100n, 'Salary tax KHR');
  }
  throw new Error('Tax brackets do not cover the salary tax base');
}

function calculatePayrollLine(input) {
  object(input, 'Payroll input');
  const curr = currency(input.currency);
  const baseMinor = integer(input.baseMinor, 'baseMinor');
  const applyNssf = boolean(input.applyNssf, 'applyNssf', false);
  const applyTax = boolean(input.applyTax, 'applyTax', false);
  const resident = boolean(input.taxResident, 'taxResident', applyTax ? undefined : true);
  const spouseCount = integer(input.spouseCount === undefined ? 0 : input.spouseCount, 'spouseCount');
  if (spouseCount > 1) throw new Error('spouseCount must be 0 or 1');
  const dependentCount = integer(input.dependentCount === undefined ? 0 : input.dependentCount, 'dependentCount');
  const late = integer(input.lateDeductionMinor === undefined ? 0 : input.lateDeductionMinor, 'lateDeductionMinor');
  const loan = integer(input.loanDeductionMinor === undefined ? 0 : input.loanDeductionMinor, 'loanDeductionMinor');
  const advance = integer(input.advanceMinor === undefined ? 0 : input.advanceMinor, 'advanceMinor');
  const rateSet = input.rateSet === undefined ? null : validateRateSet(input.rateSet);
  if ((applyNssf || applyTax) && !rateSet) throw new Error('A supplied statutory rate set is required');
  if (input.taxRateKhrPerUsd !== undefined || (curr === 'USD' && applyTax)) exchangeRatio(input.taxRateKhrPerUsd, 'Tax KHR per USD');
  if (input.nssfRateKhrPerUsd !== undefined || (curr === 'USD' && applyNssf)) exchangeRatio(input.nssfRateKhrPerUsd, 'NSSF KHR per USD');
  const toKhr = (amount) => convertMinor(amount, curr, 'KHR', input.taxRateKhrPerUsd);
  const fromKhr = (amount) => convertMinor(amount, 'KHR', curr, input.taxRateKhrPerUsd);
  const items = [{ code: 'base', label: 'Base pay', kind: 'earning', amountMinor: baseMinor, taxable: true, nssfContributory: true, isFringeBenefit: false }];
  const overtimeAmounts = array(input.overtime === undefined ? [] : input.overtime, 'overtime').map((o, i) => {
    object(o, 'Overtime entry');
    integer(o.minutes, 'Overtime minutes');
    integer(o.hourlyMinor, 'Overtime hourlyMinor');
    const [n, d] = ratio(o.ratePercent, 'Overtime ratePercent');
    const amountMinor = round(BigInt(o.minutes) * BigInt(o.hourlyMinor) * n, d * 6000n, 'Overtime amount');
    items.push({ code: `overtime_${i}`, label: 'Overtime', kind: 'earning', amountMinor, minutes: o.minutes, ratePercent: o.ratePercent, hourlyMinor: o.hourlyMinor, taxable: true, nssfContributory: true, isFringeBenefit: false });
    return amountMinor;
  });
  const overtimeMinor = sum(overtimeAmounts, 'Overtime total');
  const codes = new Set([...items.map((i) => i.code), 'late', 'loan', 'advance', 'salary_tax', 'fringe_tax']);
  array(input.components === undefined ? [] : input.components, 'components').forEach((c) => {
    object(c, 'Pay component');
    text(c.code, 'Component code');
    text(c.label, 'Component label');
    if (codes.has(c.code) || /^(overtime_|nssf_employee_|nssf_employer_)/.test(c.code)) throw new Error('Duplicate or reserved pay component code');
    codes.add(c.code);
    if (!['earning', 'deduction', 'employer_cost'].includes(c.kind)) throw new Error('Unknown pay component kind');
    integer(c.amountMinor, 'Component amountMinor');
    for (const flag of ['taxable', 'nssfContributory', 'isFringeBenefit']) boolean(c[flag], `Component ${flag}`);
    if (c.kind === 'deduction' && c.isFringeBenefit) throw new Error('A deduction cannot be a fringe benefit');
    items.push({ code: c.code, label: c.label, kind: c.kind, amountMinor: c.amountMinor, taxable: c.taxable, nssfContributory: c.nssfContributory, isFringeBenefit: c.isFringeBenefit });
  });
  items.push({ code: 'late', label: 'Lateness deduction', kind: 'deduction', amountMinor: late, taxable: true, nssfContributory: true, isFringeBenefit: false });
  const grossMinor = sum(items.filter((i) => i.kind === 'earning').map((i) => i.amountMinor), 'Gross pay');
  const otherDeductionsMinor = sum(items.filter((i) => i.kind === 'deduction').map((i) => i.amountMinor), 'Other deductions');
  const wageBase = (predicate) => Math.max(0, sum(items.filter(predicate).map((i) => i.kind === 'deduction' ? -i.amountMinor : i.amountMinor), 'Statutory wage base'));
  let pensionKhr = 0;
  let nssfEmployeeMinor = 0;
  let nssfEmployerMinor = 0;
  if (applyNssf) {
    const wagesKhr = convertMinor(wageBase((i) => i.nssfContributory), curr, 'KHR', input.nssfRateKhrPerUsd);
    const nssfItems = [];
    for (const c of rateSet.nssf.components) {
      const bands = c.bands === undefined ? rateSet.nssf.bands : c.bands;
      const band = bands.find((b) => b.upperKhr === null || wagesKhr <= b.upperKhr);
      if (!band) throw new Error(`NSSF ${c.key} bands do not cover contributory wages`);
      const baseKhr = band.baseKhr;
      const employeeKhr = percent(baseKhr, c.employeePercent, 'NSSF employee KHR');
      const employerKhr = percent(baseKhr, c.employerPercent, 'NSSF employer KHR');
      if (c.key === 'pension') pensionKhr = employeeKhr;
      nssfItems.push({ code: `nssf_employee_${c.key}`, label: `NSSF employee ${c.key}`, kind: 'deduction', amountMinor: convertMinor(employeeKhr, 'KHR', curr, input.nssfRateKhrPerUsd), amountKhr: employeeKhr, baseKhr });
      nssfItems.push({ code: `nssf_employer_${c.key}`, label: `NSSF employer ${c.key}`, kind: 'employer_cost', amountMinor: convertMinor(employerKhr, 'KHR', curr, input.nssfRateKhrPerUsd), amountKhr: employerKhr, baseKhr });
    }
    for (const kind of ['deduction', 'employer_cost']) {
      sum(nssfItems.filter((i) => i.kind === kind).map((i) => i.amountKhr), 'NSSF total KHR');
    }
    nssfEmployeeMinor = sum(nssfItems.filter((i) => i.kind === 'deduction').map((i) => i.amountMinor), 'NSSF employee total');
    nssfEmployerMinor = sum(nssfItems.filter((i) => i.kind === 'employer_cost').map((i) => i.amountMinor), 'NSSF employer total');
    items.push(...nssfItems);
  }
  let taxBaseKhr = 0;
  let salaryTaxKhr = 0;
  let fringeTaxKhr = 0;
  let salaryTaxMinor = 0;
  if (applyTax) {
    const t = rateSet.tax;
    taxBaseKhr = toKhr(wageBase((i) => i.taxable && !i.isFringeBenefit));
    const relief = sum([
      t.pensionDeductible ? pensionKhr : 0,
      resident ? safe(BigInt(spouseCount) * BigInt(t.spouseAllowanceKhr), 'Spouse relief') : 0,
      resident ? safe(BigInt(t.maxDependents === null ? dependentCount : Math.min(dependentCount, t.maxDependents)) * BigInt(t.dependentAllowanceKhr), 'Dependent relief') : 0,
    ], 'Tax relief');
    taxBaseKhr = Math.max(0, taxBaseKhr - relief);
    salaryTaxKhr = resident ? progressiveTax(taxBaseKhr, t.brackets) : percent(taxBaseKhr, t.nonResidentPercent, 'Nonresident tax');
    salaryTaxMinor = fromKhr(salaryTaxKhr);
    fringeTaxKhr = percent(toKhr(wageBase((i) => i.taxable && i.isFringeBenefit)), t.fringeBenefitPercent, 'Fringe tax');
    items.push({ code: 'salary_tax', label: 'Salary tax', kind: 'deduction', amountMinor: salaryTaxMinor, amountKhr: salaryTaxKhr });
    items.push({ code: 'fringe_tax', label: 'Fringe benefit tax', kind: 'employer_cost', amountMinor: fromKhr(fringeTaxKhr), amountKhr: fringeTaxKhr });
  }
  items.push({ code: 'loan', label: 'Loan repayment', kind: 'deduction', amountMinor: loan });
  items.push({ code: 'advance', label: 'Advance already paid', kind: 'deduction', amountMinor: advance });
  const deductions = sum([otherDeductionsMinor, nssfEmployeeMinor, salaryTaxMinor, loan, advance], 'Total deductions');
  const netMinor = grossMinor - deductions;
  if (netMinor < 0) throw new Error('Deductions exceed gross pay: negative net pay requires review');
  return {
    currency: curr, baseMinor, overtimeMinor, grossMinor, nssfEmployeeMinor, nssfEmployerMinor,
    taxBaseKhr, salaryTaxKhr, fringeTaxKhr, salaryTaxMinor, otherDeductionsMinor,
    loanDeductionMinor: loan, advanceMinor: advance, netMinor, items,
    estimate: !rateSet || rateSet.status !== 'confirmed',
  };
}

module.exports = { calculatePayrollLine, convertMinor };
