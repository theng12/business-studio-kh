const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { buildPayslipHtml, buildPayrollRunHtml, buildPayrollWorkbook } = require('../main/util/payrollDocuments');

function fixture(overrides = {}) {
  const run = {
    id: 'run-2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30',
    payDate: '2026-10-10', status: 'approved', taxRateKhrPerUsd: 4100,
    rateSource: 'manual', estimate: false,
  };
  const line = {
    id: 'line-1', employeeId: 'emp-1', staffCode: 'KH-001',
    nameEn: 'Sokha Chan', nameKm: 'សុខា ចាន់', currency: 'USD',
    baseMinor: 20000, overtimeMinor: 2500, grossMinor: 22500,
    nssfEmployeeMinor: 500, nssfEmployerMinor: 1000, taxBaseKhr: 902500,
    salaryTaxKhr: 12000, fringeTaxKhr: 0, salaryTaxMinor: 293,
    otherDeductionsMinor: 0, loanDeductionMinor: 5000, advanceMinor: 0,
    netMinor: 16707,
    items: [{ label: 'Base pay', code: 'BASE', kind: 'earning', amountMinor: 20000 },
      { label: 'Overtime', code: 'OT', kind: 'earning', amountMinor: 2500 }],
    estimate: false, applyNssf: true, applyTax: true,
    loanBalanceAfterMinor: 15000, leaveBalanceDays: 4.5,
    bankName: 'Example Bank', bankAccountName: 'Sokha Chan',
    bankAccountNo: '000123456789', nssfNo: 'NSSF-001',
  };
  return {
    companyName: overrides.companyName ?? 'Example Co',
    run: { ...run, ...(overrides.run || {}) },
    line: { ...line, ...(overrides.line || {}) },
  };
}

test('payslip is self-contained, A5, bilingual, and embeds the Khmer fonts', () => {
  const { run, line } = fixture();
  const html = buildPayslipHtml({ companyName: 'Example Co', run, line });
  assert.match(html, /@page\s*\{[^}]*size:\s*A5\s+portrait/s);
  assert.match(html, /ប្រាក់បៀវត្ស/);
  assert.match(html, /Payslip/);
  assert.match(html, /font-family:"MS Noto Khmer"/);
  assert.match(html, /data:font\/ttf;base64,/);
  assert.match(html, /៛|KHR/);
  assert.doesNotMatch(html, /<script|https?:\/\//i);
});

test('payroll run payslip keeps each employee isolated and in input order', () => {
  const first = fixture({ line: { nameEn: 'First Employee', staffCode: 'FIRST', netMinor: 1111 } });
  const second = fixture({ line: { nameEn: 'Second Employee', staffCode: 'SECOND', netMinor: 2222 } });
  const html = buildPayrollRunHtml({
    companyName: 'Example Co', run: first.run, lines: [first.line, second.line],
  });
  const pages = html.split('<section class="payslip-page">').slice(1);

  assert.equal(pages.length, 2);
  assert.ok(pages[0].includes('First Employee'));
  assert.ok(pages[0].includes('FIRST'));
  assert.ok(pages[0].includes('$11.11'));
  assert.ok(!pages[0].includes('Second Employee'));
  assert.ok(pages[1].includes('Second Employee'));
  assert.ok(pages[1].includes('SECOND'));
  assert.ok(pages[1].includes('$22.22'));
  assert.ok(!pages[1].includes('First Employee'));
  assert.equal((html.match(/section\.payslip-page\+section\.payslip-page\{/g) || []).length, 1);
  assert.ok(html.endsWith('</body></html>'));
});

test('single-line payroll run HTML is identical to the existing payslip', () => {
  const { run, line } = fixture();
  assert.equal(
    buildPayrollRunHtml({ companyName: 'Example Co', run, lines: [line] }),
    buildPayslipHtml({ companyName: 'Example Co', run, line }),
  );
});

test('run watermarks are positioned within their own employee section while single payslips retain fixed stamps', () => {
  const { companyName, run, line } = fixture({ line: { estimate: true } });
  const second = { ...line, id: 'line-2', employeeId: 'emp-2', nameEn: 'Second Employee', estimate: false };
  for (const status of ['approved', 'draft', 'void']) {
    const currentRun = { ...run, status };
    const html = buildPayrollRunHtml({ companyName, run: currentRun, lines: [line, second] });
    const pages = html.split('<section class="payslip-page">').slice(1);
    assert.equal((pages[0].match(/class="watermark"/g) || []).length, 1);
    assert.equal((pages[1].match(/class="watermark"/g) || []).length, status === 'approved' ? 0 : 1);
    if (status === 'approved') {
      assert.match(pages[0], /DRAFT · ESTIMATE/);
      assert.match(pages[1], /class="status">APPROVED<\/span>/);
      assert.doesNotMatch(pages[1], /DRAFT|ESTIMATE/);
    }
    // Fixed elements repeat on every printed page even when their markup is in one section.
    const css = html.slice(html.indexOf('@page'), html.indexOf('</style>'));
    assert.match(css, /section\.payslip-page\{[^}]*position:relative/);
    assert.match(css, /section\.payslip-page>\.watermark\{[^}]*position:absolute/);

    const single = buildPayslipHtml({ companyName, run: currentRun, line });
    const singleCss = single.slice(single.indexOf('@page'), single.indexOf('</style>'));
    assert.match(singleCss, /\.watermark\{position:fixed;/);
    assert.doesNotMatch(singleCss, /payslip-page/);
    assert.equal(buildPayrollRunHtml({ companyName, run: currentRun, lines: [line] }), single);
  }
});

test('payroll run payslip rejects empty lines and escapes untrusted text', () => {
  const { run, line } = fixture({
    companyName: '<img src=x onerror="company()">',
    line: { nameEn: '<script>employee()</script>' },
  });
  assert.throws(
    () => buildPayrollRunHtml({ companyName: 'Example Co', run, lines: [] }),
    /at least one payroll line/i,
  );

  const html = buildPayrollRunHtml({ companyName: '<img src=x onerror="company()">', run, lines: [line, line] });
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;employee\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;company\(\)&quot;&gt;/);
});

test('payslip summarizes built-in payroll amounts once and keeps custom detail with net and balances', () => {
  const builtins = [
    ['base', 'Base pay', 20000], ['overtime_0', 'Overtime', 2500], ['late', 'Lateness deduction', 350],
    ['nssf_employee_pension', 'NSSF employee pension', 500], ['nssf_employer_pension', 'NSSF employer pension', 1000],
    ['salary_tax', 'Salary tax', 293], ['fringe_tax', 'Fringe benefit tax', 0],
    ['loan', 'Loan repayment', 5000], ['advance', 'Advance already paid', 0],
  ].map(([code, label, amountMinor]) => ({ code, label, kind: code === 'late' ? 'deduction' : 'earning', amountMinor }));
  const custom = [
    ['base_pay', 'Base pay custom', 'earning', 611], ['nssf_custom', 'Custom NSSF allowance', 'earning', 722],
    [' base ', 'Whitespace-padded base code', 'earning', 833], ['meal_allowance', 'Meal allowance', 'earning', 944],
    ['transport_deduction', 'Transport deduction', 'deduction', 1055],
  ].map(([code, label, kind, amountMinor]) => ({ code, label, kind, amountMinor }));
  const { run, line } = fixture({ line: { items: [...builtins, ...custom] } });
  const html = buildPayslipHtml({ companyName: 'Example Co', run, line });
  const detailTable = html.split('<table class="items"><thead>')[1].split('</table>')[0];
  const detailRows = detailTable.split('</thead>')[1].split('</tbody>')[0];
  const css = html.split('<style>')[1].split('</style>')[0];
  const layoutCss = css.slice(css.indexOf('@page'));

  assert.equal((detailRows.match(/<tr>/g) || []).length, 6);
  assert.equal((html.match(/<th[^>]*>Net pay/g) || []).length, 1);
  for (const item of builtins.filter(({ code }) => code !== 'late')) {
    assert.ok(!detailRows.includes('<small>' + item.code + '</small>'));
  }
  assert.match(detailRows, /Lateness deduction<small>late<\/small><\/td><td>deduction<\/td><td class="num">\$3\.50/);
  const zeroLateHtml = buildPayslipHtml({
    companyName: 'Example Co', run,
    line: { ...line, items: [...builtins.map((item) => item.code === 'late' ? { ...item, amountMinor: 0 } : item), ...custom] },
  });
  assert.doesNotMatch(zeroLateHtml.split('</thead>')[1].split('</tbody>')[0], /<small>late<\/small>/);
  for (const item of custom) {
    assert.ok(detailTable.includes(item.code));
    assert.ok(detailTable.includes(item.label));
    assert.ok(detailTable.includes('$' + (item.amountMinor / 100).toFixed(2)));
  }
  assert.match(detailRows, /deduction/);
  const taxNote = html.split('<p class="tax-note">')[1].split('</p>')[0];
  assert.match(taxNote, /Salary tax \(KHR\): 12,000 ៛/);
  assert.match(taxNote, /Fringe tax \(KHR\): 0 ៛/);
  for (const amount of [
    '$200.00', '$25.00', '$225.00', '$5.00', '$10.00', '$3.50', '902,500 ៛', '12,000 ៛',
    '0 ៛', '$2.93', '$0.00', '$50.00', '$167.07', '$150.00', '4.5 days',
  ]) assert.ok(html.includes(amount), `payslip keeps ${amount}`);
  assert.match(layoutCss, /\.summary\{[^}]*break-inside:\s*avoid[^}]*page-break-inside:\s*avoid/s);
  assert.match(layoutCss, /thead\{display:\s*table-header-group/);
  assert.doesNotMatch(layoutCss, /(?:^|[;{])\s*(?:height\s*:\s*[^;]+|overflow\s*:\s*hidden)/i);
});

test('payslip keeps fringe tax in pay currency alongside its KHR summary', () => {
  // Calculator output: USD 100 noncash benefit, synthetic 30% fringe rate, FX 4000 KHR/USD.
  const data = fixture({
    run: { taxRateKhrPerUsd: 4000 },
    line: {
      baseMinor: 20000, overtimeMinor: 0, grossMinor: 20000,
      applyNssf: false, applyTax: true, nssfEmployeeMinor: 0, nssfEmployerMinor: 0,
      taxBaseKhr: 800000, salaryTaxKhr: 0, fringeTaxKhr: 120000, salaryTaxMinor: 0,
      otherDeductionsMinor: 0, loanDeductionMinor: 0, advanceMinor: 0, netMinor: 20000,
      items: [
        { code: 'base', label: 'Base pay', kind: 'earning', amountMinor: 20000 },
        { code: 'noncash_benefit', label: 'Noncash benefit', kind: 'employer_cost', amountMinor: 10000,
          taxable: true, nssfContributory: false, isFringeBenefit: true },
        { code: 'late', label: 'Lateness deduction', kind: 'deduction', amountMinor: 0 },
        { code: 'salary_tax', label: 'Salary tax', kind: 'deduction', amountMinor: 0, amountKhr: 0 },
        { code: 'fringe_tax', label: 'Fringe benefit tax', kind: 'employer_cost', amountMinor: 3000, amountKhr: 120000 },
        { code: 'loan', label: 'Loan repayment', kind: 'deduction', amountMinor: 0 },
        { code: 'advance', label: 'Advance already paid', kind: 'deduction', amountMinor: 0 },
      ],
    },
  });
  const html = buildPayslipHtml(data);
  const detailRows = html.split('</thead>')[1].split('</tbody>')[0];
  assert.match(detailRows, /Fringe benefit tax<small>fringe_tax<\/small><\/td><td>employer_cost<\/td><td class="num">\$30\.00<\/td>/);
  assert.match(detailRows, /Noncash benefit<small>noncash_benefit<\/small><\/td><td>employer_cost<\/td><td class="num">\$100\.00<\/td>/);
  assert.match(html, /Fringe tax \(KHR\): 120,000 ៛/);
  assert.match(html, /<tr class="net">[^]*?<td class="num">\$200\.00<\/td>/);
});

test('draft and estimate labels survive approval and line estimate status', () => {
  const { run, line } = fixture({ line: { estimate: true } });
  const html = buildPayslipHtml({ companyName: 'Example Co', run, line });
  assert.ok(/DRAFT|សេចក្តីព្រាង/i.test(html), 'estimate watermark is visible');
  assert.ok(/ESTIMATE|ប៉ាន់ស្មាន/i.test(html), 'estimate reason is visible');

  const draft = fixture({ run: { status: 'reviewed' } });
  assert.ok(/DRAFT|សេចក្តីព្រាង/i.test(buildPayslipHtml({ companyName: 'Example Co', ...draft })));
});

test('HTML escapes company, employee, item, and bank details as text', () => {
  const { companyName, run, line } = fixture({
    companyName: '<img src=x onerror="company()">',
    line: {
      nameEn: '<script>employee()</script>', nameKm: '"><svg onload=employee()>',
      bankName: '<iframe src=x>', bankAccountName: '"><b>account',
      bankAccountNo: '<img src=x>',
      items: [{ label: '<script>item()</script>', code: '=<cmd>', kind: 'earning', amountMinor: 1 }],
    },
  });
  const html = buildPayslipHtml({ companyName, run, line });
  assert.doesNotMatch(html, /<script>|<iframe|<svg onload|<img src=x/);
  assert.match(html, /&lt;script&gt;employee\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;item\(\)&lt;\/script&gt;/);
});

test('missing and unapplied values are labelled without inventing zeroes', () => {
  const { run, line } = fixture({ line: {
    nssfNo: undefined, loanBalanceAfterMinor: undefined, leaveBalanceDays: undefined,
    bankName: undefined, bankAccountName: undefined, bankAccountNo: undefined,
    applyNssf: false, applyTax: false,
  } });
  const html = buildPayslipHtml({ companyName: 'Example Co', run, line });
  assert.match(html, /not provided/i);
  assert.match(html, /not applied/i);
});

test('payroll workbook contains the five specified sheets and keeps each currency explicit', () => {
  const { run, line } = fixture();
  const second = {
    ...line, id: 'line-2', employeeId: 'emp-2', staffCode: 'KH-002',
    nameEn: 'Dara', currency: 'KHR', baseMinor: 300000, overtimeMinor: 0,
    grossMinor: 300000, nssfEmployeeMinor: 5000, nssfEmployerMinor: 9000,
    salaryTaxMinor: 0, otherDeductionsMinor: 0, loanDeductionMinor: 0,
    advanceMinor: 0, netMinor: 295000, items: [], bankAccountNo: undefined,
  };
  const { filename, bytes } = buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [line, second] });
  assert.match(filename, /^payroll-example-co-2026-09\.xlsx$/);
  const wb = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Register', 'Bank transfer', 'NSSF', 'Salary tax', 'Notes']);

  const register = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1, raw: true });
  assert.ok(register[0].includes('Currency'));
  assert.ok(register[0].includes('Net (minor units)'));
  const currencyIndex = register[0].indexOf('Currency');
  const netIndex = register[0].indexOf('Net (minor units)');
  const lineRows = register.slice(1).filter((row) => row[0] === 'Payroll line');
  assert.deepEqual(lineRows.map((r) => [r[currencyIndex], r[netIndex]]), [['USD', 16707], ['KHR', 295000]]);
  assert.equal(lineRows[0][netIndex], 16707, 'USD cents stay cents');
  assert.equal(lineRows[1][netIndex], 295000, 'KHR stays whole riel');
});

test('workbook marks estimates and leaves unknown values visible as unknown', () => {
  const { run, line } = fixture({ line: {
    estimate: true, nssfNo: undefined, bankAccountNo: undefined,
    loanBalanceAfterMinor: undefined, leaveBalanceDays: undefined,
  } });
  const { bytes } = buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [line] });
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const notes = XLSX.utils.sheet_to_json(wb.Sheets.Notes, { header: 1, raw: true }).flat().join(' ');
  assert.match(notes, /DRAFT|ESTIMATE/i);
  const register = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1, raw: true });
  assert.ok(register[0].includes('NSSF number'));
  assert.ok(register[1].includes('not provided'));
  assert.match(register[1][6], /DRAFT.*ESTIMATE/);
});

test('pay item workbook rows keep code, label, kind, and amount under their exact headers', () => {
  const { run, line } = fixture();
  const { bytes } = buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [line] });
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1, raw: true });
  const headers = rows[0];
  const item = rows.find((row) => row[0] === 'Pay item');

  assert.equal(item.length, headers.length);
  assert.deepEqual(
    ['Item code', 'Item label', 'Item kind', 'Item amount (minor units)'].map((header) => item[headers.indexOf(header)]),
    ['BASE', 'Base pay', 'earning', 20000],
  );
});

test('missing NSSF and tax switches remain not provided in both documents', () => {
  const { run, line } = fixture({ line: { applyNssf: undefined, applyTax: undefined } });
  const html = buildPayslipHtml({ companyName: 'Example Co', run, line });
  const { bytes } = buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [line] });
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const register = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1, raw: true });
  const registerHeaders = register[0];
  const lineRow = register[1];
  const nssf = XLSX.utils.sheet_to_json(wb.Sheets.NSSF, { header: 1, raw: true });
  const tax = XLSX.utils.sheet_to_json(wb.Sheets['Salary tax'], { header: 1, raw: true });
  const totals = html.split('<table class="totals"><tbody>')[1].split('</tbody>')[0];

  assert.match(totals, /<th>Employee NSSF[\s\S]*?<td class="num">not provided<\/td>/);
  assert.match(html, /Salary tax \(KHR\): not provided/);
  assert.match(html, /Fringe tax \(KHR\): not provided/);
  assert.equal(lineRow[registerHeaders.indexOf('Employee NSSF (minor units)')], 'not provided');
  assert.equal(lineRow[registerHeaders.indexOf('Employer NSSF (minor units)')], 'not provided');
  assert.equal(lineRow[registerHeaders.indexOf('NSSF status')], 'not provided');
  assert.equal(lineRow[registerHeaders.indexOf('Salary tax (KHR)')], 'not provided');
  assert.equal(lineRow[registerHeaders.indexOf('Fringe tax (KHR)')], 'not provided');
  assert.equal(lineRow[registerHeaders.indexOf('Salary tax (minor units)')], 'not provided');
  assert.equal(lineRow[registerHeaders.indexOf('Tax status')], 'not provided');
  assert.equal(nssf[1][nssf[0].indexOf('Employee NSSF (minor units)')], 'not provided');
  assert.equal(nssf[1][nssf[0].indexOf('Employer NSSF (minor units)')], 'not provided');
  assert.equal(nssf[1][nssf[0].indexOf('NSSF status')], 'not provided');
  assert.equal(tax[1][tax[0].indexOf('Salary tax (KHR)')], 'not provided');
  assert.equal(tax[1][tax[0].indexOf('Fringe tax (KHR)')], 'not provided');
  assert.equal(tax[1][tax[0].indexOf('Salary tax (minor units)')], 'not provided');
  assert.equal(tax[1][tax[0].indexOf('Tax status')], 'not provided');

  const unapplied = fixture({ line: { applyNssf: false, applyTax: false } });
  const unappliedHtml = buildPayslipHtml({ companyName: 'Example Co', ...unapplied });
  const unappliedTotals = unappliedHtml.split('<table class="totals"><tbody>')[1].split('</tbody>')[0];
  const unappliedWorkbook = buildPayrollWorkbook({ companyName: 'Example Co', run: unapplied.run, lines: [unapplied.line] });
  const unappliedSheets = XLSX.read(unappliedWorkbook.bytes, { type: 'buffer' });
  const unappliedRegister = XLSX.utils.sheet_to_json(unappliedSheets.Sheets.Register, { header: 1, raw: true });
  const unappliedNssf = XLSX.utils.sheet_to_json(unappliedSheets.Sheets.NSSF, { header: 1, raw: true });
  const unappliedTax = XLSX.utils.sheet_to_json(unappliedSheets.Sheets['Salary tax'], { header: 1, raw: true });

  assert.match(unappliedTotals, /<th>Employee NSSF[\s\S]*?<td class="num">not applied<\/td>/);
  assert.match(unappliedHtml, /Salary tax \(KHR\): not applied/);
  assert.match(unappliedHtml, /Fringe tax \(KHR\): not applied/);
  assert.equal(unappliedRegister[1][unappliedRegister[0].indexOf('Employee NSSF (minor units)')], 'not applied');
  assert.equal(unappliedRegister[1][unappliedRegister[0].indexOf('Salary tax (KHR)')], 'not applied');
  assert.equal(unappliedRegister[1][unappliedRegister[0].indexOf('NSSF status')], 'not applied');
  assert.equal(unappliedRegister[1][unappliedRegister[0].indexOf('Tax status')], 'not applied');
  assert.equal(unappliedNssf[1][unappliedNssf[0].indexOf('Employee NSSF (minor units)')], 'not applied');
  assert.equal(unappliedNssf[1][unappliedNssf[0].indexOf('NSSF status')], 'not applied');
  assert.equal(unappliedTax[1][unappliedTax[0].indexOf('Salary tax (KHR)')], 'not applied');
  assert.equal(unappliedTax[1][unappliedTax[0].indexOf('Tax status')], 'not applied');
});

test('void payroll outputs are explicitly void and unknown run statuses are rejected', () => {
  const { run, line } = fixture({ run: { status: 'void' } });
  const html = buildPayslipHtml({ companyName: 'Example Co', run, line });
  const { bytes } = buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [line] });
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const notes = XLSX.utils.sheet_to_json(wb.Sheets.Notes, { header: 1, raw: true });
  const outputStatus = notes.find(([key]) => key === 'Output status')[1];
  const register = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1, raw: true });

  assert.ok(html.includes('<div class="watermark" aria-hidden="true">VOID</div>'));
  assert.equal(outputStatus, 'VOID');
  assert.equal(register[1][register[0].indexOf('Estimate status')], 'VOID');
  assert.doesNotMatch(html, /FINAL/);
  assert.doesNotMatch(outputStatus, /FINAL/);

  const invalid = fixture({ run: { status: 'mystery' } });
  assert.throws(() => buildPayslipHtml({ companyName: 'Example Co', ...invalid }), /run status/i);
  assert.throws(() => buildPayrollWorkbook({ companyName: 'Example Co', ...invalid, lines: [invalid.line] }), /run status/i);

  const paid = fixture({ run: { status: 'paid' } });
  assert.doesNotThrow(() => buildPayslipHtml({ companyName: 'Example Co', ...paid }));
  assert.doesNotThrow(() => buildPayrollWorkbook({ companyName: 'Example Co', ...paid, lines: [paid.line] }));
});

test('Khmer labels cause the Khmer font to be embedded for ASCII-only payroll data', () => {
  const { run, line } = fixture({
    companyName: 'Example Company',
    line: { nameEn: 'Sokha Chan', nameKm: 'Sokha Chan', items: [{ label: 'Base pay', code: 'BASE', kind: 'earning', amountMinor: 20000 }] },
  });
  const html = buildPayslipHtml({ companyName: 'Example Company', run, line });

  assert.ok(html.includes('@font-face{font-family:"MS Noto Khmer"'));
});

test('document builders reject unsupported currencies and unsafe monetary values', () => {
  const { run, line } = fixture();
  const invalidInputs = [
    { line: { currency: 'EUR' } },
    { line: { currency: undefined } },
    { line: { grossMinor: 1.5 } },
    { line: { grossMinor: '22500' } },
    { line: { grossMinor: Number.MAX_SAFE_INTEGER + 1 } },
    { line: { taxBaseKhr: 902500.25 } },
    { line: { items: [{ label: 'Bad amount', amountMinor: 1.25 }] } },
    { line: { items: [{ label: 'String amount', amountMinor: '20000' }] } },
  ];

  for (const invalid of invalidInputs) {
    const badLine = { ...line, ...invalid.line };
    assert.throws(() => buildPayslipHtml({ companyName: 'Example Co', run, line: badLine }));
    assert.throws(() => buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [badLine] }));
  }
});

test('missing optional monetary fields stay not provided', () => {
  const { run, line } = fixture({ line: {
    grossMinor: undefined, salaryTaxKhr: undefined, items: [{ label: 'Base pay', code: 'BASE', kind: 'earning' }],
  } });
  const html = buildPayslipHtml({ companyName: 'Example Co', run, line });
  const { bytes } = buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [line] });
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const register = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1, raw: true });

  const totals = html.split('<table class="totals"><tbody>')[1].split('</tbody>')[0];
  assert.match(totals, /Gross pay[\s\S]*?<td class="num">not provided<\/td>/);
  assert.equal(register[1][register[0].indexOf('Gross (minor units)')], 'not provided');
});

test('untrusted workbook text is stored as string cells, never formulas or cross-line data', () => {
  const { companyName, run, line } = fixture({
    companyName: 'A&B',
    line: {
      nameEn: '=HYPERLINK("https://secret.invalid","leak")',
      bankAccountName: '+cmd|secret',
      bankAccountNo: '@other-line-secret',
      items: [{ label: '=1+1', code: 'CSV', kind: 'earning', amountMinor: 7 }],
    },
  });
  const other = { ...line, id: 'line-2', employeeId: 'emp-2', nameEn: 'Other employee', bankAccountNo: 'SECOND-SECRET' };
  const { bytes } = buildPayrollWorkbook({ companyName, run, lines: [line, other] });
  const wb = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
  for (const sheetName of wb.SheetNames) {
    for (const cell of Object.values(wb.Sheets[sheetName])) {
      if (cell && typeof cell === 'object' && 'v' in cell) {
        assert.equal(cell.f, undefined);
      }
    }
  }
  const register = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1, raw: true });
  const heading = register[0];
  const nameCol = heading.indexOf('Name (English)');
  assert.equal(wb.Sheets.Register[XLSX.utils.encode_cell({ r: 1, c: nameCol })].t, 's');
  assert.ok(register[1].includes('=HYPERLINK("https://secret.invalid","leak")'));
  const bankRows = XLSX.utils.sheet_to_json(wb.Sheets['Bank transfer'], { header: 1, raw: true });
  const accountNoCol = bankRows[0].indexOf('Account number');
  assert.equal(wb.Sheets['Bank transfer'][XLSX.utils.encode_cell({ r: 1, c: accountNoCol })].t, 's');
  assert.equal(bankRows[1].includes('SECOND-SECRET'), false);
  assert.ok(bankRows[2].includes('SECOND-SECRET'));
});

test('builders do not mutate their immutable input snapshots', () => {
  const { run, line } = fixture();
  const inputs = structuredClone({ run, line });
  buildPayslipHtml({ companyName: 'Example Co', run, line });
  buildPayrollWorkbook({ companyName: 'Example Co', run, lines: [line] });
  assert.deepEqual({ run, line }, inputs);
});

test('company names cannot escape into unsafe output filenames', () => {
  const { run, line } = fixture();
  const { filename } = buildPayrollWorkbook({ companyName: '../../Payroll / Evil ☃', run, lines: [line] });
  assert.match(filename, /^payroll-[a-z0-9-]+-2026-09\.xlsx$/);
  assert.doesNotMatch(filename, /\.\.|[/\\]|☃/);
});
