const test = require('node:test');
const assert = require('node:assert/strict');

function calculator() {
  let value;
  assert.doesNotThrow(() => { value = require('../main/util/payrollCalc'); }, 'payroll arithmetic must exist');
  return value;
}

// Synthetic arithmetic fixtures; these are deliberately not legal rates.
function rates() {
  return {
    status: 'confirmed',
    nssf: {
      bands: [{ upperKhr: 1000, baseKhr: 800 }, { upperKhr: null, baseKhr: 1600 }],
      components: [
        { key: 'pension', employeePercent: 2, employerPercent: 3 },
        { key: 'health', employeePercent: 1, employerPercent: 4 },
      ],
    },
    tax: {
      brackets: [{ upperKhr: 1000, ratePercent: 0 }, { upperKhr: 2000, ratePercent: 10 }, { upperKhr: null, ratePercent: 20 }],
      spouseAllowanceKhr: 100, dependentAllowanceKhr: 50, maxDependents: 2,
      nonResidentPercent: 25, fringeBenefitPercent: 30, pensionDeductible: true,
    },
  };
}

const line = (patch = {}) => ({ currency: 'KHR', baseMinor: 3000, applyTax: true, taxResident: true, rateSet: rates(), ...patch });
const component = (patch = {}) => ({ code: 'bonus', label: 'Bonus', kind: 'earning', amountMinor: 100, taxable: true, nssfContributory: true, isFringeBenefit: false, ...patch });

test('draft previews allow an absent disabled statutory domain without inventing tables', () => {
  const { calculatePayrollLine } = calculator();
  for (const nssf of [undefined, null, { components: [] }]) {
    const rateSet = { status: 'draft', tax: rates().tax, nssf };
    const result = calculatePayrollLine(line({ rateSet }));
    assert.equal(result.salaryTaxKhr, 300);
    assert.equal(result.nssfEmployeeMinor, 0);
    assert.equal(result.estimate, true);
    assert.throws(() => calculatePayrollLine(line({ rateSet, applyNssf: true })), /NSSF/);
    assert.throws(() => calculatePayrollLine(line({ rateSet: { ...rateSet, status: 'confirmed' } })), /NSSF/);
  }
  const rateSet = { status: 'draft', nssf: rates().nssf, tax: null };
  const result = calculatePayrollLine(line({ rateSet, applyTax: false, applyNssf: true }));
  assert.equal(result.nssfEmployeeMinor, 48);
  assert.equal(result.salaryTaxKhr, 0);
  assert.equal(result.estimate, true);
  assert.throws(() => calculatePayrollLine(line({ rateSet })), /Tax/);
  assert.throws(() => calculatePayrollLine(line({ rateSet: { ...rateSet, status: 'confirmed' }, applyTax: false })), /Tax/);
  assert.throws(() => calculatePayrollLine(line({ rateSet: { status: 'draft', tax: rates().tax, nssf: { components: [{ key: 'pension', employeePercent: 2, employerPercent: 2 }] } } })), /bands/);
});

test('minor-unit conversions use cents, whole riel and exact decimal half-up rounding', () => {
  const { convertMinor } = calculator();
  for (const [amount, from, to, rate, want] of [
    [20000, 'USD', 'KHR', 4000, 800000], [800000, 'KHR', 'USD', 4000, 20000],
    [1, 'USD', 'KHR', 4050, 41], [20, 'KHR', 'USD', 4000, 1], [19, 'KHR', 'USD', 4000, 0],
    [250, 'USD', 'KHR', 40.6, 102], [12345, 'USD', 'KHR', 4100.25, 506176],
    [11, 'KHR', 'USD', 2200, 1], [5, 'USD', 'USD', undefined, 5], [5, 'KHR', 'KHR', undefined, 5],
  ]) assert.equal(convertMinor(amount, from, to, rate), want);
});

test('already-prorated base pay and disabled defaults remain a draft estimate', () => {
  const { calculatePayrollLine } = calculator();
  const got = calculatePayrollLine({ currency: 'USD', baseMinor: 20000, applyNssf: false, applyTax: false, loanDeductionMinor: 10000, advanceMinor: 2500 });
  assert.deepEqual(Object.fromEntries(Object.entries(got).filter(([key]) => key !== 'items')), {
    currency: 'USD', baseMinor: 20000, overtimeMinor: 0, grossMinor: 20000,
    nssfEmployeeMinor: 0, nssfEmployerMinor: 0, taxBaseKhr: 0, salaryTaxKhr: 0, fringeTaxKhr: 0,
    salaryTaxMinor: 0, otherDeductionsMinor: 0, loanDeductionMinor: 10000, advanceMinor: 2500, netMinor: 7500, estimate: true,
  });
  assert.equal(calculatePayrollLine({ currency: 'KHR', baseMinor: 777 }).netMinor, 777);
  assert.equal(calculatePayrollLine({ currency: 'KHR', baseMinor: 777, rateSet: rates() }).estimate, false);
});

test('overtime uses the approved total multiplier and rounds each payable entry', () => {
  const { calculatePayrollLine } = calculator();
  const got = calculatePayrollLine({ currency: 'USD', baseMinor: 10000, overtime: [
    { minutes: 60, hourlyMinor: 1000, ratePercent: 150 },
    { minutes: 30, hourlyMinor: 1000, ratePercent: 200 },
    { minutes: 60, hourlyMinor: 250, ratePercent: 40.6 },
    { minutes: 1, hourlyMinor: 1, ratePercent: 0 },
  ], lateDeductionMinor: 101, loanDeductionMinor: 100, advanceMinor: 500 });
  assert.equal(got.overtimeMinor, 2602);
  assert.equal(got.grossMinor, 12602);
  assert.equal(got.otherDeductionsMinor, 101);
  assert.equal(got.netMinor, 11901);
});

test('progressive tax taxes only marginal slices at literal boundaries', () => {
  const { calculatePayrollLine } = calculator();
  for (const [baseMinor, salaryTaxKhr] of [[0, 0], [999, 0], [1000, 0], [1001, 0], [1005, 1], [1999, 100], [2000, 100], [2001, 100], [3000, 300]]) {
    const got = calculatePayrollLine(line({ baseMinor }));
    assert.equal(got.taxBaseKhr, baseMinor);
    assert.equal(got.salaryTaxKhr, salaryTaxKhr);
    assert.equal(got.netMinor, baseMinor - salaryTaxKhr);
  }
});

test('progressive tax rounds once after summing fractional bracket charges', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  rateSet.tax.brackets = [{ upperKhr: 1, ratePercent: 40.6 }, { upperKhr: null, ratePercent: 40.6 }];
  assert.equal(calculatePayrollLine(line({ baseMinor: 2, rateSet })).salaryTaxKhr, 1);
});

test('resident relief is bounded while nonresidents get a flat supplied rate without relief', () => {
  const { calculatePayrollLine } = calculator();
  const input = line({ spouseCount: 1, dependentCount: 5 });
  const resident = calculatePayrollLine(input);
  assert.equal(resident.taxBaseKhr, 2800);
  assert.equal(resident.salaryTaxKhr, 260);
  const nonresident = calculatePayrollLine({ ...input, taxResident: false });
  assert.equal(nonresident.taxBaseKhr, 3000);
  assert.equal(nonresident.salaryTaxKhr, 750);
  assert.equal(calculatePayrollLine(line({ baseMinor: 50, spouseCount: 1 })).taxBaseKhr, 0);
});

test('NSSF selects inclusive wage bands and an explicitly supplied unbounded cap band', () => {
  const { calculatePayrollLine } = calculator();
  for (const [baseMinor, employee, employer] of [[999, 24, 56], [1000, 24, 56], [1001, 48, 112], [2000, 48, 112], [3000, 48, 112]]) {
    const got = calculatePayrollLine(line({ baseMinor, applyNssf: true, applyTax: false }));
    assert.equal(got.nssfEmployeeMinor, employee);
    assert.equal(got.nssfEmployerMinor, employer);
    assert.equal(got.netMinor, baseMinor - employee);
  }
});

test('tax relief deducts only employee pension, never health or employer contributions', () => {
  const { calculatePayrollLine } = calculator();
  const got = calculatePayrollLine(line({ applyNssf: true }));
  assert.equal(got.taxBaseKhr, 2968);
  assert.equal(got.salaryTaxKhr, 294);
  assert.equal(got.nssfEmployeeMinor, 48);
  assert.equal(got.nssfEmployerMinor, 112);
  assert.equal(got.netMinor, 2658);
  assert.equal(got.estimate, false);
  const rateSet = rates();
  rateSet.tax.pensionDeductible = false;
  assert.equal(calculatePayrollLine(line({ rateSet, applyNssf: true })).taxBaseKhr, 3000);
  rateSet.tax.pensionDeductible = true;
  rateSet.nssf.components = [{ key: 'health', employeePercent: 1, employerPercent: 4 }];
  assert.equal(calculatePayrollLine(line({ rateSet, applyNssf: true })).taxBaseKhr, 3000);
});

test('earnings flags independently control taxable and NSSF bases; employer costs stay outside pay', () => {
  const { calculatePayrollLine } = calculator();
  const got = calculatePayrollLine(line({ baseMinor: 900, applyNssf: true, components: [
    component({ code: 'taxOnly', amountMinor: 600, nssfContributory: false }),
    component({ code: 'nssfOnly', amountMinor: 200, taxable: false }),
    component({ code: 'neither', amountMinor: 100, taxable: false, nssfContributory: false }),
    component({ code: 'cost', kind: 'employer_cost', amountMinor: 500, taxable: false, nssfContributory: false }),
    component({ code: 'fee', kind: 'deduction', amountMinor: 50, taxable: false, nssfContributory: false }),
  ] }));
  assert.equal(got.grossMinor, 1800);
  assert.equal(got.taxBaseKhr, 1468);
  assert.equal(got.salaryTaxKhr, 47);
  assert.equal(got.nssfEmployeeMinor, 48);
  assert.equal(got.otherDeductionsMinor, 50);
  assert.equal(got.netMinor, 1655);
});

test('fringe benefits are taxed separately as employer costs, without salary tax or NSSF double count', () => {
  const { calculatePayrollLine } = calculator();
  const got = calculatePayrollLine(line({ components: [
    component({ code: 'cashFringe', amountMinor: 100, isFringeBenefit: true, nssfContributory: false }),
    component({ code: 'nonCashFringe', kind: 'employer_cost', amountMinor: 200, isFringeBenefit: true, nssfContributory: false }),
  ] }));
  assert.equal(got.grossMinor, 3100);
  assert.equal(got.taxBaseKhr, 3000);
  assert.equal(got.salaryTaxKhr, 300);
  assert.equal(got.fringeTaxKhr, 90);
  assert.equal(got.netMinor, 2800);
  assert.equal(got.items.find((item) => item.code === 'fringe_tax').kind, 'employer_cost');
});

test('late and flagged deductions reduce statutory wage bases; loans and advances never do', () => {
  const { calculatePayrollLine } = calculator();
  const got = calculatePayrollLine(line({ lateDeductionMinor: 100, loanDeductionMinor: 100, advanceMinor: 100,
    components: [component({ kind: 'deduction', amountMinor: 100 })], applyNssf: true }));
  assert.equal(got.taxBaseKhr, 2768);
  assert.equal(got.salaryTaxKhr, 254);
  assert.equal(got.otherDeductionsMinor, 200);
  assert.equal(got.netMinor, 2298);
});

test('USD statutory amounts convert using the supplied rate, rounding contributions per component', () => {
  const { calculatePayrollLine } = calculator();
  const got = calculatePayrollLine(line({ currency: 'USD', baseMinor: 10000, taxRateKhrPerUsd: 4000, nssfRateKhrPerUsd: 4000, applyNssf: true }));
  assert.equal(got.nssfEmployeeMinor, 1);
  assert.equal(got.nssfEmployerMinor, 3);
  assert.equal(got.taxBaseKhr, 399968);
  assert.equal(got.salaryTaxKhr, 79694);
  assert.equal(got.salaryTaxMinor, 1992);
  assert.equal(got.netMinor, 8007);
  const pension = got.items.find((item) => item.code === 'nssf_employee_pension');
  assert.equal(pension.amountKhr, 32);
  assert.equal(pension.amountMinor, 1);
});

test('estimate follows supplied confirmation status without treating legitimate disabled deductions as draft', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  rateSet.status = 'draft';
  assert.equal(calculatePayrollLine(line({ rateSet, applyNssf: true })).estimate, true);
  assert.equal(calculatePayrollLine(line()).estimate, false, 'a confirmed set with disabled NSSF remains confirmed');
  assert.equal(calculatePayrollLine(line({ applyNssf: true, applyTax: false })).estimate, false);
  assert.equal(calculatePayrollLine(line({ rateSet, applyNssf: false, applyTax: false })).estimate, true);
  assert.equal(calculatePayrollLine({ currency: 'KHR', baseMinor: 100 }).estimate, true);
});

test('items reconcile payable earnings and deductions and inputs are not mutated', () => {
  const { calculatePayrollLine } = calculator();
  const input = line({ applyNssf: true, advanceMinor: 100, loanDeductionMinor: 50, lateDeductionMinor: 25,
    overtime: [{ minutes: 60, ratePercent: 150, hourlyMinor: 100 }], components: [component()] });
  const before = JSON.stringify(input);
  const got = calculatePayrollLine(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(got.items.filter((i) => i.kind === 'earning').reduce((n, i) => n + i.amountMinor, 0), got.grossMinor);
  assert.equal(got.items.filter((i) => i.kind === 'deduction').reduce((n, i) => n + i.amountMinor, 0), got.grossMinor - got.netMinor);
  assert.doesNotThrow(() => JSON.stringify(got));
});

test('invalid money, switches, rates and input shapes are refused instead of coerced', () => {
  const { calculatePayrollLine, convertMinor } = calculator();
  for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null]) {
    assert.throws(() => convertMinor(amount, 'USD', 'KHR', 4000));
    assert.throws(() => calculatePayrollLine({ currency: 'USD', baseMinor: amount }));
  }
  for (const rate of [undefined, null, 0, -1, NaN, Infinity, '4000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => convertMinor(1, 'USD', 'KHR', rate));
  }
  for (const patch of [
    { currency: 'EUR' }, { currency: undefined }, { baseMinor: undefined }, { applyTax: 'false' },
    { applyNssf: null }, { applyTax: true }, { applyNssf: true }, { rateSet: rates(), applyTax: true },
    { overtime: null }, { components: {} }, { lateDeductionMinor: 0.5 }, { loanDeductionMinor: -1 },
    { advanceMinor: '1' }, { spouseCount: 2 }, { dependentCount: -1 }, { taxResident: 'true' },
    { overtime: [{ minutes: 0.5, hourlyMinor: 1, ratePercent: 150 }] },
    { overtime: [{ minutes: 60, hourlyMinor: 1 }] },
    { overtime: [{ minutes: 60, hourlyMinor: -1, ratePercent: 150 }] },
    { overtime: [{ minutes: 60, hourlyMinor: 1, ratePercent: Infinity }] },
    { components: [component({ amountMinor: 0.5 })] }, { components: [component({ kind: 'unknown' })] },
    { components: [component({ taxable: 1 })] }, { components: [component({ code: '' })] },
    { components: [component(), component()] },
    { components: [component({ kind: 'deduction', isFringeBenefit: true })] },
  ]) assert.throws(() => calculatePayrollLine({ currency: 'USD', baseMinor: 10000, ...patch }), JSON.stringify(patch));
  assert.throws(() => calculatePayrollLine(null));
  assert.throws(() => convertMinor(1, 'EUR', 'KHR', 4000));
});

test('invalid or uncovered statutory tables fail explicitly', () => {
  const { calculatePayrollLine } = calculator();
  const mutations = [
    (r) => { r.status = 'invented'; }, (r) => { r.nssf.bands = []; }, (r) => { r.nssf.components = []; },
    (r) => { r.nssf.bands[1].upperKhr = 1000; }, (r) => { r.nssf.bands[0].baseKhr = -1; },
    (r) => { r.nssf.bands[1].baseKhr = 700; }, (r) => { r.nssf.components[0].employeePercent = 101; },
    (r) => { r.nssf.components[0].employerPercent = -1; }, (r) => { r.nssf.components[1].key = 'pension'; },
    (r) => { r.tax.brackets = []; }, (r) => { r.tax.brackets[1].upperKhr = 900; },
    (r) => { r.tax.brackets[0].upperKhr = null; }, (r) => { r.tax.brackets[1].ratePercent = NaN; },
    (r) => { r.tax.brackets[2].ratePercent = 101; }, (r) => { r.tax.brackets[2].ratePercent = 5; },
    (r) => { r.tax.brackets[2].upperKhr = 2500; }, (r) => { r.tax.spouseAllowanceKhr = 0.5; },
    (r) => { r.tax.dependentAllowanceKhr = undefined; }, (r) => { r.tax.maxDependents = -1; },
    (r) => { r.tax.nonResidentPercent = null; }, (r) => { r.tax.fringeBenefitPercent = '30'; },
    (r) => { r.tax.pensionDeductible = 1; },
  ];
  for (const mutate of mutations) {
    const rateSet = rates();
    mutate(rateSet);
    assert.throws(() => calculatePayrollLine(line({ rateSet, applyNssf: true })), mutate.toString());
  }
});

test('negative net pay and unsafe conversions or totals are refused, but safe large arithmetic works', () => {
  const { calculatePayrollLine, convertMinor } = calculator();
  assert.throws(() => calculatePayrollLine({ currency: 'USD', baseMinor: 100, advanceMinor: 101 }), /net|pay/i);
  assert.throws(() => convertMinor(Number.MAX_SAFE_INTEGER, 'USD', 'KHR', 4000), /safe|large|range/i);
  assert.throws(() => calculatePayrollLine({ currency: 'KHR', baseMinor: Number.MAX_SAFE_INTEGER, components: [component({ amountMinor: 1 })] }), /safe|large|range/i);
  assert.throws(() => calculatePayrollLine({ currency: 'KHR', baseMinor: 0, overtime: [{ minutes: Number.MAX_SAFE_INTEGER, hourlyMinor: Number.MAX_SAFE_INTEGER, ratePercent: 150 }] }), /safe|large|range/i);
  const huge = calculatePayrollLine({ currency: 'KHR', baseMinor: 0, overtime: [{ minutes: 60, hourlyMinor: Number.MAX_SAFE_INTEGER, ratePercent: 100 }] });
  assert.equal(huge.netMinor, Number.MAX_SAFE_INTEGER);
});

test('component codes cannot impersonate generated deduction or contribution items', () => {
  const { calculatePayrollLine } = calculator();
  for (const code of ['base', 'late', 'loan', 'advance', 'salary_tax', 'fringe_tax', 'overtime_0', 'nssf_employee_health', 'nssf_employer_health']) {
    assert.throws(() => calculatePayrollLine(line({ applyNssf: true, components: [component({ code })] })), /code|reserved|duplicate/i, code);
  }
});

test('NSSF totals in riel cannot overflow even when the output currency is smaller', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  rateSet.nssf.bands = [{ upperKhr: null, baseKhr: Number.MAX_SAFE_INTEGER }];
  rateSet.nssf.components = [
    { key: 'pension', employeePercent: 0, employerPercent: 100 },
    { key: 'health', employeePercent: 0, employerPercent: 100 },
  ];
  assert.throws(() => calculatePayrollLine(line({ currency: 'USD', nssfRateKhrPerUsd: 4000, rateSet, applyNssf: true, applyTax: false })), /safe|large|range/i);
});

test('missing USD FX is rejected for each active statutory path, but KHR needs no FX', () => {
  const { calculatePayrollLine } = calculator();
  assert.throws(() => calculatePayrollLine(line({ currency: 'USD' })), /KHR per USD/i);
  assert.throws(() => calculatePayrollLine(line({ currency: 'USD', applyTax: false, applyNssf: true })), /KHR per USD/i);
  assert.equal(calculatePayrollLine(line({ applyNssf: true })).netMinor, 2658);
});

test('finite tax tables are valid within coverage and fractional percentages stay exact', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  rateSet.tax.brackets = [{ upperKhr: 1000, ratePercent: 0 }, { upperKhr: 2000, ratePercent: 40.6 }];
  assert.equal(calculatePayrollLine(line({ baseMinor: 1250, rateSet })).salaryTaxKhr, 102);
  rateSet.nssf.components = [{ key: 'pension', employeePercent: 6.25, employerPercent: 6.25 }];
  const got = calculatePayrollLine(line({ baseMinor: 1250, rateSet, applyNssf: true }));
  assert.equal(got.nssfEmployeeMinor, 100);
  assert.equal(got.nssfEmployerMinor, 100);
  assert.equal(got.taxBaseKhr, 1150);
  assert.equal(got.salaryTaxKhr, 61);
  assert.equal(got.netMinor, 1089);
});

test('each NSSF scheme chooses its own supplied bands with explicit shared fallback', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  rateSet.nssf.components[0].bands = [{ upperKhr: 2000, baseKhr: 1200 }];
  const got = calculatePayrollLine(line({ baseMinor: 600, rateSet, applyNssf: true }));
  assert.equal(got.nssfEmployeeMinor, 32);
  assert.equal(got.nssfEmployerMinor, 68);
  assert.equal(got.taxBaseKhr, 576);
  assert.equal(got.netMinor, 568);
  assert.equal(got.items.find((i) => i.code === 'nssf_employee_pension').baseKhr, 1200);
  assert.equal(got.items.find((i) => i.code === 'nssf_employee_health').baseKhr, 800);
});

test('per-scheme bands work without global bands, but absent or invalid scheme bases never fall back implicitly', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  delete rateSet.nssf.bands;
  rateSet.nssf.components[0].bands = [{ upperKhr: null, baseKhr: 1200 }];
  rateSet.nssf.components[1].bands = [{ upperKhr: null, baseKhr: 600 }];
  const got = calculatePayrollLine(line({ baseMinor: 600, rateSet, applyNssf: true }));
  assert.equal(got.nssfEmployeeMinor, 30);
  assert.equal(got.nssfEmployerMinor, 60);
  assert.equal(got.netMinor, 570);
  delete rateSet.nssf.components[1].bands;
  assert.throws(() => calculatePayrollLine(line({ rateSet, applyNssf: true })), /band|base/i);
  for (const bands of [[], null, [{ upperKhr: 1000, baseKhr: 800 }, { upperKhr: 900, baseKhr: 900 }], [{ upperKhr: null, baseKhr: -1 }]]) {
    const invalid = rates();
    invalid.nssf.components[0].bands = bands;
    assert.throws(() => calculatePayrollLine(line({ rateSet: invalid, applyNssf: true })), /band|base/i);
  }
});

test('USD NSSF requires its own explicit FX and uses it independently of salary-tax FX', () => {
  const { calculatePayrollLine } = calculator();
  assert.throws(() => calculatePayrollLine(line({ currency: 'USD', applyNssf: true, taxRateKhrPerUsd: 1000 })), /NSSF.*KHR per USD/i);
  const got = calculatePayrollLine(line({ currency: 'USD', baseMinor: 10000, applyNssf: true, taxRateKhrPerUsd: 1000, nssfRateKhrPerUsd: 4000 }));
  assert.equal(got.nssfEmployeeMinor, 1);
  assert.equal(got.nssfEmployerMinor, 3);
  assert.equal(got.taxBaseKhr, 99968);
  assert.equal(got.salaryTaxKhr, 19694);
  assert.equal(got.salaryTaxMinor, 1969);
  assert.equal(got.netMinor, 8030);
  const nssfOnly = calculatePayrollLine(line({ currency: 'USD', baseMinor: 10000, applyTax: false, applyNssf: true, nssfRateKhrPerUsd: 4000 }));
  assert.equal(nssfOnly.netMinor, 9999);
  for (const rate of [null, 0, -1, NaN, Infinity, '4000']) {
    assert.throws(() => calculatePayrollLine(line({ currency: 'USD', applyTax: false, applyNssf: true, nssfRateKhrPerUsd: rate })), /NSSF.*KHR per USD/i);
  }
});

test('a null maxDependents applies all validated dependent claims without an invented cap', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  rateSet.tax.maxDependents = null;
  const got = calculatePayrollLine(line({ rateSet, dependentCount: 5 }));
  assert.equal(got.taxBaseKhr, 2750);
  assert.equal(got.salaryTaxKhr, 250);
  for (const dependentCount of [null, -1, 0.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculatePayrollLine(line({ rateSet, dependentCount })), /dependentCount/i);
  }
  assert.throws(() => calculatePayrollLine(line({ rateSet, dependentCount: Number.MAX_SAFE_INTEGER })), /safe|range/i);
});

test('sparse input arrays cannot silently skip missing pay entries or statutory bands', () => {
  const { calculatePayrollLine } = calculator();
  assert.throws(() => calculatePayrollLine({ currency: 'KHR', baseMinor: 100, components: Array(1) }), /missing|array|object/i);
  assert.throws(() => calculatePayrollLine({ currency: 'KHR', baseMinor: 100, overtime: Array(1) }), /missing|array|object/i);
  const rateSet = rates();
  rateSet.nssf.components = Array(1);
  assert.throws(() => calculatePayrollLine(line({ rateSet, applyNssf: true })), /missing|array|object/i);
  rateSet.nssf.components = rates().nssf.components;
  rateSet.nssf.bands = Array(1);
  assert.throws(() => calculatePayrollLine(line({ rateSet, applyNssf: true })), /missing|array|object/i);
});

test('zero-wage NSSF follows supplied floors unless an explicit zero-exemption band is supplied', () => {
  const { calculatePayrollLine } = calculator();
  const input = line({ baseMinor: 0, applyNssf: true, applyTax: false,
    components: [component({ amountMinor: 100, taxable: false, nssfContributory: false })] });
  const floor = calculatePayrollLine(input);
  assert.equal(floor.nssfEmployeeMinor, 24);
  assert.equal(floor.nssfEmployerMinor, 56);
  assert.equal(floor.netMinor, 76);
  assert.throws(() => calculatePayrollLine({ ...input, components: [] }), /negative net pay/i);
  const rateSet = rates();
  rateSet.nssf.bands.unshift({ upperKhr: 0, baseKhr: 0 });
  const exempt = calculatePayrollLine({ ...input, components: [], rateSet });
  assert.equal(exempt.nssfEmployeeMinor, 0);
  assert.equal(exempt.nssfEmployerMinor, 0);
  assert.equal(exempt.netMinor, 0);
  assert.equal(calculatePayrollLine(line({ baseMinor: 1000, applyNssf: true, applyTax: false, rateSet })).nssfEmployeeMinor, 24);
  const schemes = rates();
  schemes.nssf.components[0].bands = [{ upperKhr: 0, baseKhr: 0 }, { upperKhr: null, baseKhr: 1200 }];
  const pensionExempt = calculatePayrollLine({ ...input, rateSet: schemes });
  assert.equal(pensionExempt.nssfEmployeeMinor, 8);
  assert.equal(pensionExempt.nssfEmployerMinor, 32);
});

test('finite NSSF tables refuse uncovered wages instead of inventing a cap above the supplied mapping', () => {
  const { calculatePayrollLine } = calculator();
  const rateSet = rates();
  rateSet.nssf.bands[1].upperKhr = 2000;
  assert.equal(calculatePayrollLine(line({ baseMinor: 2000, applyNssf: true, applyTax: false, rateSet })).nssfEmployeeMinor, 48);
  assert.throws(() => calculatePayrollLine(line({ baseMinor: 2001, applyNssf: true, applyTax: false, rateSet })), /cover|band/i);
  const scheme = rates();
  scheme.nssf.components[0].bands = [{ upperKhr: 1000, baseKhr: 800 }];
  assert.throws(() => calculatePayrollLine(line({ baseMinor: 1001, applyNssf: true, applyTax: false, rateSet: scheme })), /cover|band/i);
});
