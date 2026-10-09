const XLSX = require('xlsx');
const { embeddedFontCss, esc } = require('../studioRenderer');

const NOT_PROVIDED = 'not provided';
const NOT_APPLIED = 'not applied';
const RUN_STATUSES = new Set(['draft', 'reviewed', 'approved', 'paid', 'void']);
const KHR_MONEY_FIELDS = new Set(['taxBaseKhr', 'salaryTaxKhr', 'fringeTaxKhr']);
// Mirrors payrollCalc's generated and reserved item codes; other codes are user components.
const BUILTIN_PAY_ITEM_CODE = /^(?:base|late|loan|advance|salary_tax|fringe_tax|overtime_\d+|nssf_(?:employee|employer)_.+)$/;

function has(value) {
  return value !== undefined && value !== null && value !== '';
}

function validateRun(run) {
  if (!RUN_STATUSES.has(run?.status)) throw new Error('Invalid payroll run status');
}

function validateMoneyFields(record, label) {
  for (const [key, value] of Object.entries(record || {})) {
    if ((key.endsWith('Minor') || KHR_MONEY_FIELDS.has(key)) && has(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${label}.${key} must be a safe integer`);
    }
  }
}

function validateLine(line) {
  if (line?.currency !== 'USD' && line?.currency !== 'KHR') throw new Error('Payroll document currency must be USD or KHR');
  validateMoneyFields(line, 'line');
  for (const item of Array.isArray(line.items) ? line.items : []) validateMoneyFields(item, 'item');
}

function appliedValue(applies, value, format = cellValue) {
  if (applies === false) return NOT_APPLIED;
  return applies === true ? format(value) : NOT_PROVIDED;
}

function appliedStatus(applies) {
  return applies === true ? 'applied' : applies === false ? NOT_APPLIED : NOT_PROVIDED;
}

function outputStatus(run, estimate = false) {
  const voided = run.status === 'void';
  const draft = run.status === 'draft' || run.status === 'reviewed' || Boolean(run.estimate) || (estimate && !voided);
  const state = voided ? 'VOID' : draft ? 'DRAFT' : 'FINAL';
  return [state, run.estimate || estimate ? 'ESTIMATE' : ''].filter(Boolean).join(' · ');
}

function money(value, currency) {
  if (!has(value)) return NOT_PROVIDED;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NOT_PROVIDED;
  if (currency === 'USD') {
    const sign = amount < 0 ? '-' : '';
    return sign + '$' + (Math.abs(amount) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (currency === 'KHR') return Math.trunc(amount).toLocaleString('en-US') + ' ៛';
  return amount.toLocaleString('en-US') + ' ' + (currency || NOT_PROVIDED);
}

function riel(value) {
  return has(value) ? money(value, 'KHR') : NOT_PROVIDED;
}

function lineMoney(line, key) {
  return money(line[key], line.currency);
}

function appliedLineMoney(line, key, applies) {
  return appliedValue(applies, line[key], (value) => money(value, line.currency));
}

function date(value) {
  return has(value) ? String(value) : NOT_PROVIDED;
}

function cellValue(value) {
  return has(value) ? value : NOT_PROVIDED;
}

function buildPayslipHtml({ companyName, run, line }) {
  validateRun(run);
  validateLine(line);
  const fonts = embeddedFontCss(JSON.stringify({ companyName, run, line }) + ' ប្រាក់បៀវត្ស');
  const draft = run.status === 'draft' || run.status === 'reviewed';
  const estimate = Boolean(run.estimate || line.estimate);
  const voided = run.status === 'void';
  const watermark = draft || estimate || voided;
  const stamp = [voided ? 'VOID' : draft || estimate ? 'DRAFT' : '', estimate ? 'ESTIMATE' : ''].filter(Boolean).join(' · ');
  const stampKm = [draft || estimate ? 'សេចក្តីព្រាង' : '', estimate ? 'ប៉ាន់ស្មាន' : ''].filter(Boolean).join(' · ');
  const items = (Array.isArray(line.items) ? line.items : []).filter((item) => (
    !BUILTIN_PAY_ITEM_CODE.test(String(item.code || '')) ||
    ((item.code === 'late' || item.code === 'fringe_tax') && item.amountMinor !== 0)
  )).map((item) => (
    '<tr><td>' + esc(item.label || NOT_PROVIDED) + '<small>' + esc(item.code || NOT_PROVIDED) + '</small></td>' +
    '<td>' + esc(item.kind || NOT_PROVIDED) + '</td><td class="num">' +
    esc(money(item.amountMinor, line.currency)) + '</td></tr>'
  )).join('');
  const amountRows = [
    ['Base pay', 'ប្រាក់ខែគោល', lineMoney(line, 'baseMinor')],
    ['Overtime', 'ប្រាក់បន្ថែមម៉ោង', lineMoney(line, 'overtimeMinor')],
    ['Gross pay', 'ប្រាក់សរុប', lineMoney(line, 'grossMinor')],
    ['Employee NSSF', 'ប.ស.ស. និយោជិត', appliedLineMoney(line, 'nssfEmployeeMinor', line.applyNssf)],
    ['Employer NSSF', 'ប.ស.ស. និយោជក', appliedLineMoney(line, 'nssfEmployerMinor', line.applyNssf)],
    ['Salary tax in pay currency', 'ពន្ធតាមរូបិយប័ណ្ណប្រាក់ខែ', appliedLineMoney(line, 'salaryTaxMinor', line.applyTax)],
    ['Other deductions', 'ការកាត់កងផ្សេងៗ', lineMoney(line, 'otherDeductionsMinor')],
    ['Loan deduction', 'ការកាត់សងប្រាក់កម្ចី', lineMoney(line, 'loanDeductionMinor')],
    ['Advance', 'ប្រាក់បើកមុន', lineMoney(line, 'advanceMinor')],
    ['Net pay', 'ប្រាក់សុទ្ធ', lineMoney(line, 'netMinor')],
  ];
  const summaryPairs = [];
  for (let index = 0; index < amountRows.length - 1; index += 2) {
    summaryPairs.push(amountRows.slice(index, Math.min(index + 2, amountRows.length - 1)));
  }
  const totals = summaryPairs.map((pair) => (
    '<tr>' + pair.map(([en, km, value]) => (
      '<th>' + esc(en) + '<small>' + esc(km) + '</small></th><td class="num">' + esc(value) + '</td>'
    )).join('') + (pair.length === 1 ? '<td colspan="2"></td>' : '') + '</tr>'
  )).join('') +
    '<tr class="net"><th colspan="3">Net pay<small>ប្រាក់សុទ្ធ</small></th><td class="num">' +
    esc(amountRows[amountRows.length - 1][2]) + '</td></tr>';
  const nssfRef = appliedValue(line.applyNssf, line.nssfNo);
  const taxRate = run.taxRateKhrPerUsd == null ? NOT_PROVIDED :
    String(run.taxRateKhrPerUsd) + ' KHR/USD · ' + (run.rateSource || NOT_PROVIDED);

  return '<!doctype html><html lang="km"><head><meta charset="utf-8"><title>' +
    esc(companyName || NOT_PROVIDED) + ' · Payslip</title><style>' + fonts +
    '@page{size:A5 portrait;margin:8mm}*{box-sizing:border-box}' +
    'html,body{margin:0;color:#171717;font-family:"MS Noto Khmer","MS Noto",sans-serif;font-size:8.5pt;line-height:1.35}' +
    'body{position:relative}h1,h2,p{margin:0}.head{border-bottom:1px solid #555;padding-bottom:4mm;margin-bottom:3mm}' +
    '.company{font-size:13pt;font-weight:700}.title{display:flex;justify-content:space-between;align-items:start;margin-top:1.5mm}' +
    '.title h1{font-size:11pt}.dates,.meta{display:flex;justify-content:space-between;gap:4mm;margin-top:2mm}' +
    '.meta{border-bottom:1px solid #aaa;padding-bottom:2mm}.label{color:#555}small{display:block;color:#555;font-size:7pt}' +
    'table{border-collapse:collapse;width:100%;margin-top:3mm}th,td{border-bottom:1px solid #ddd;padding:1.2mm 1mm;text-align:left;vertical-align:top}' +
    'thead th{font-size:7pt;color:#555}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}' +
    '.items th,.items td{padding:.7mm .8mm}.items small{display:inline;margin-left:1mm}.items thead{display:table-header-group}.items tbody tr{break-inside:avoid;page-break-inside:avoid}' +
    '.summary{break-inside:avoid;page-break-inside:avoid}.totals{table-layout:fixed;margin-top:2mm}.totals th,.totals td{width:25%;padding:1mm .8mm}' +
    '.net th,.net td{border-top:1.5px solid #222;border-bottom:0;font-size:10pt;font-weight:700;padding-top:2mm}' +
    '.balance{display:flex;gap:8mm;margin-top:3mm;padding:2mm;border:1px solid #ddd}.muted{color:#666}' +
    '.watermark{position:fixed;inset:43% 0 auto;text-align:center;color:rgba(170,0,0,.13);font-size:25pt;font-weight:700;transform:rotate(-24deg);pointer-events:none}' +
    '.status{font-size:8pt;font-weight:700;color:#8b1d1d}.tax-note{margin-top:2mm;color:#555;font-size:7pt}' +
    '</style></head><body>' +
    (watermark ? '<div class="watermark" aria-hidden="true">' + esc(stamp || stampKm) + '</div>' : '') +
    '<header class="head"><p class="company">' + esc(companyName || NOT_PROVIDED) + '</p>' +
    '<div class="title"><h1>ប្រាក់បៀវត្ស · Payslip</h1><span class="status">' +
    esc(stamp || stampKm || String(run.status || NOT_PROVIDED).toUpperCase()) + '</span></div>' +
    '<div class="dates"><span><b>រយៈពេល · Period</b><br>' + esc(date(run.periodStart)) + ' – ' +
    esc(date(run.periodEnd)) + '</span><span><b>ថ្ងៃបើកប្រាក់ · Pay date</b><br>' +
    esc(date(run.payDate)) + '</span></div></header>' +
    '<section class="meta"><div><b>' + esc(line.nameKm || NOT_PROVIDED) + '</b><br>' +
    esc(line.nameEn || NOT_PROVIDED) + '</div><div><span class="label">Staff code</span><br>' +
    esc(cellValue(line.staffCode)) + '</div><div><span class="label">NSSF</span><br>' +
    esc(nssfRef) + '</div></section>' +
    (items ? '<table class="items"><thead><tr><th>Pay item · បញ្ជីប្រាក់</th><th>Kind</th><th class="num">Amount</th></tr></thead><tbody>' +
      items + '</tbody></table>' : '') +
    '<section class="summary"><table class="totals"><tbody>' + totals + '</tbody></table>' +
    '<p class="tax-note">Tax base: ' + esc(riel(line.taxBaseKhr)) + ' · Salary tax (KHR): ' +
    esc(appliedValue(line.applyTax, line.salaryTaxKhr, riel)) + ' · Fringe tax (KHR): ' +
    esc(appliedValue(line.applyTax, line.fringeTaxKhr, riel)) + ' · FX: ' + esc(taxRate) + '</p>' +
    '<section class="balance"><div><span class="label">Loan balance after · សមតុល្យកម្ចី</span><br><b>' +
    esc(money(line.loanBalanceAfterMinor, line.currency)) + '</b></div><div><span class="label">Leave balance · សមតុល្យច្បាប់</span><br><b>' +
    esc(has(line.leaveBalanceDays) ? String(line.leaveBalanceDays) + ' days' : NOT_PROVIDED) +
    '</b></div></section></section></body></html>';
}

function safeSlug(value) {
  return String(value || 'company').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'company';
}

function safePeriod(run) {
  const start = String(run.periodStart || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(start) ? start : 'period';
}

function buildPayrollWorkbook({ companyName, run, lines = [] }) {
  validateRun(run);
  for (const line of lines) validateLine(line);
  const wb = XLSX.utils.book_new();
  const estimate = Boolean(run.estimate || lines.some((line) => line.estimate));
  const stateLabel = outputStatus(run, estimate);
  const register = [[
    'Row type', 'Run ID', 'Period start', 'Period end', 'Pay date', 'Run status', 'Estimate status',
    'Employee ID', 'Staff code', 'Name (English)', 'Name (Khmer)', 'Currency',
    'Base (minor units)', 'Overtime (minor units)', 'Gross (minor units)',
    'Employee NSSF (minor units)', 'Employer NSSF (minor units)', 'Tax base (KHR)',
    'Salary tax (KHR)', 'Fringe tax (KHR)', 'Salary tax (minor units)',
    'Other deductions (minor units)', 'Loan deduction (minor units)', 'Advance (minor units)',
    'Net (minor units)', 'NSSF status', 'Tax status', 'Loan balance after (minor units)',
    'Leave balance (days)', 'NSSF number', 'Item code', 'Item label', 'Item kind', 'Item amount (minor units)',
  ]];
  const bank = [['Run ID', 'Period', 'Pay date', 'Employee ID', 'Staff code', 'Name (English)', 'Name (Khmer)',
    'Bank', 'Account name', 'Account number', 'Currency', 'Net amount (minor units)', 'Estimate status']];
  const nssf = [['Run ID', 'Period', 'Employee ID', 'Staff code', 'Name (English)', 'Name (Khmer)',
    'NSSF number', 'Currency', 'Employee NSSF (minor units)', 'Employer NSSF (minor units)',
    'Gross (minor units)', 'NSSF status', 'Estimate status']];
  const tax = [['Run ID', 'Period', 'Employee ID', 'Staff code', 'Name (English)', 'Name (Khmer)',
    'Currency', 'Tax base (KHR)', 'Salary tax (KHR)', 'Fringe tax (KHR)', 'Salary tax (minor units)',
    'Tax status', 'Tax FX (KHR/USD)', 'FX source', 'Estimate status']];

  for (const line of lines) {
    const lineState = outputStatus(run, Boolean(line.estimate));
    const summary = [
      'Payroll line', cellValue(run.id), date(run.periodStart), date(run.periodEnd), date(run.payDate),
      cellValue(run.status), lineState, cellValue(line.employeeId), cellValue(line.staffCode),
      cellValue(line.nameEn), cellValue(line.nameKm), cellValue(line.currency),
      cellValue(line.baseMinor), cellValue(line.overtimeMinor), cellValue(line.grossMinor),
      appliedValue(line.applyNssf, line.nssfEmployeeMinor),
      appliedValue(line.applyNssf, line.nssfEmployerMinor),
      cellValue(line.taxBaseKhr), appliedValue(line.applyTax, line.salaryTaxKhr),
      appliedValue(line.applyTax, line.fringeTaxKhr), appliedValue(line.applyTax, line.salaryTaxMinor),
      cellValue(line.otherDeductionsMinor), cellValue(line.loanDeductionMinor), cellValue(line.advanceMinor),
      cellValue(line.netMinor), appliedStatus(line.applyNssf),
      appliedStatus(line.applyTax), cellValue(line.loanBalanceAfterMinor),
      cellValue(line.leaveBalanceDays), appliedValue(line.applyNssf, line.nssfNo),
      '', '', '', '',
    ];
    register.push(summary);
    for (const item of Array.isArray(line.items) ? line.items : []) {
      const prefix = [
        'Pay item', cellValue(run.id), date(run.periodStart), date(run.periodEnd), date(run.payDate),
        cellValue(run.status), lineState, cellValue(line.employeeId), cellValue(line.staffCode),
        cellValue(line.nameEn), cellValue(line.nameKm), cellValue(line.currency),
      ];
      register.push([...prefix, ...Array(register[0].length - prefix.length - 4).fill(''),
        cellValue(item.code), cellValue(item.label), cellValue(item.kind), cellValue(item.amountMinor)]);
    }

    bank.push([
      cellValue(run.id), date(run.periodStart), date(run.payDate), cellValue(line.employeeId),
      cellValue(line.staffCode), cellValue(line.nameEn), cellValue(line.nameKm),
      cellValue(line.bankName), cellValue(line.bankAccountName), cellValue(line.bankAccountNo),
      cellValue(line.currency), cellValue(line.netMinor), lineState,
    ]);
    nssf.push([
      cellValue(run.id), date(run.periodStart), cellValue(line.employeeId), cellValue(line.staffCode),
      cellValue(line.nameEn), cellValue(line.nameKm), appliedValue(line.applyNssf, line.nssfNo),
      cellValue(line.currency), appliedValue(line.applyNssf, line.nssfEmployeeMinor),
      appliedValue(line.applyNssf, line.nssfEmployerMinor), cellValue(line.grossMinor),
      appliedStatus(line.applyNssf), lineState,
    ]);
    tax.push([
      cellValue(run.id), date(run.periodStart), cellValue(line.employeeId), cellValue(line.staffCode),
      cellValue(line.nameEn), cellValue(line.nameKm), cellValue(line.currency), cellValue(line.taxBaseKhr),
      appliedValue(line.applyTax, line.salaryTaxKhr),
      appliedValue(line.applyTax, line.fringeTaxKhr),
      appliedValue(line.applyTax, line.salaryTaxMinor),
      appliedStatus(line.applyTax), cellValue(run.taxRateKhrPerUsd), cellValue(run.rateSource), lineState,
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(register), 'Register');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bank), 'Bank transfer');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(nssf), 'NSSF');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tax), 'Salary tax');
  const notes = [
    ['Payroll workbook', cellValue(companyName)],
    ['Period', date(run.periodStart) + ' – ' + date(run.periodEnd)],
    ['Pay date', date(run.payDate)],
    ['Run status', cellValue(run.status)],
    ['Output status', stateLabel],
    ['Currency units', 'USD monetary values are integer cents. KHR monetary values are whole riel. Amounts in different currencies are not added.'],
    ['Status meanings', 'DRAFT covers draft and reviewed runs. ESTIMATE applies to the run or any estimated employee line and remains visible after approval. VOID identifies a voided run.'],
    ['Register rows', 'Payroll line rows contain line totals; Pay item rows contain individual item amounts. Their summary amount columns are blank on item rows.'],
    ['NSSF and tax', 'not applied means the line switch is off. not provided means the snapshot did not include that value.'],
    ['Bank transfer', 'This worksheet is an export for review. It does not initiate or confirm a bank transfer.'],
    ['Tax exchange rate', cellValue(run.taxRateKhrPerUsd) + ' KHR/USD; source: ' + cellValue(run.rateSource)],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'Notes');
  const period = safePeriod(run);
  return {
    filename: 'payroll-' + safeSlug(companyName) + '-' + period + '.xlsx',
    bytes: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
  };
}

module.exports = { buildPayslipHtml, buildPayrollWorkbook };
