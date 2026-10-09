const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { buildPayslipHtml, buildPayrollWorkbook } = require('../main/util/payrollDocuments');

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
  assert.match(totals, /<th>Salary tax \(KHR\)[\s\S]*?<td class="num">not provided<\/td>/);
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
  assert.match(unappliedTotals, /<th>Salary tax \(KHR\)[\s\S]*?<td class="num">not applied<\/td>/);
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
