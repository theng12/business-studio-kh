/** Opening balances only. Transport must enforce loans.manage and trusted company
 * context; approval continues through employeeLoans.approve and its IPC policy.
 * Preview values are descriptive, never an authorization token: apply replans.
 * All money cells are safe integer USD cents / whole KHR, never rounded here.
 */
const { getDb } = require('./index');
const c = require('./payrollConfig');
const loans = require('./employeeLoans');
const { uuid, getCallerUserId } = require('./_fuelUtil');
const ac = require('../util/attendanceCalc');
const XLSX = require('xlsx');
const MAX_ROWS = 500;
const IMPORT_COLUMNS = [
  ['loanNo', 'Loan number', ['loan_no', 'loan number'], 'Required natural key in this company.'],
  ['staffCode', 'Staff code', ['staff_code', 'employee code'], 'Required for new rows; must match staff in this company.'],
  ['originalPrincipalMinor', 'Original principal (USD cents / KHR riel)', ['original_principal', 'original principal'], 'Required positive integer original principal, even for an interest-only balance. USD cents / whole KHR.'],
  ['currentPrincipalMinor', 'Current principal (USD cents / KHR riel)', ['current_principal', 'current principal'], 'Required nonnegative integer outstanding principal at balanceAsOf. USD cents / whole KHR. Zero is allowed.'],
  ['unpaidInterestMinor', 'Unpaid interest (USD cents / KHR riel)', ['unpaid_interest', 'unpaid interest'], 'Required nonnegative integer interest already owed at balanceAsOf. USD cents / whole KHR. Zero is allowed.'],
  ['balanceAsOf', 'Balance as of', ['balance_as_of', 'opening date'], 'Required real YYYY-MM-DD calendar month end, no future dates. Includes all history through that day.'],
  ['currency', 'Currency', ['ccy'], 'Required USD or KHR. USD 100 = $1; KHR 100 = 100 riel. No conversion.'],
  ['disbursedOn', 'Original disbursement date', ['disbursed_on', 'original disbursement date'], 'Required real YYYY-MM-DD, on or before balanceAsOf. Free months use this original anniversary.'],
  ['interestMethod', 'Interest method', ['interest_method'], 'Required declining or none. none requires zero rate.'],
  ['interestPolicy', 'Unpaid interest policy', ['interest_policy'], 'Required separate or capitalize. Capitalization approval requires existing professional policy confirmation.'],
  ['ratePercent', 'Monthly rate (%)', ['rate_percent', 'monthly rate'], 'Required number 0–100. Applied prospectively after the opening; no historical interest is invented.'],
  ['interestFreeMonths', 'Original free months', ['interest_free_months', 'free months'], 'Required integer 0–120, measured from original disbursedOn.'],
  ['installmentMinor', 'Instalment (USD cents / KHR riel)', ['installment_minor', 'instalment'], 'Required positive integer USD cents / whole KHR.'],
  ['maxDeductionPercent', 'Maximum deduction (%)', ['max_deduction_percent'], 'Optional 0–100; defaults to the company policy for new rows.'],
  ['deductViaPayroll', 'Deduct via payroll', ['deduct_via_payroll'], 'Optional boolean true/false; defaults to true for new rows.'],
  ['purpose', 'Purpose', ['note'], 'Optional text, at most 2000 characters.'],
].map(([key, label, aliases, accepts]) => ({ key, label, aliases, accepts }));
const keys = new Set(IMPORT_COLUMNS.map(x => x.key));
const blank = v => v == null || (typeof v === 'string' && !v.trim());
function importColumns() { return IMPORT_COLUMNS.map(x => ({ ...x, aliases: [...x.aliases] })); }
function batch(companyId, input, apply = false) {
  c.company(companyId);
  if (!input || typeof input !== 'object' || Array.isArray(input)) c.fail('Import request must be an object');
  for (const key of Object.keys(input)) if (!['rows', ...(apply ? ['operationId'] : [])].includes(key)) c.fail(`Unknown import request field ${key}`);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > MAX_ROWS) c.fail(`Import requires 1–${MAX_ROWS} rows`);
}
function previousValues(l) {
  return {
    loanNo: l.loanNo, employeeId: l.employeeId, originalPrincipalMinor: l.originalPrincipalMinor,
    currentPrincipalMinor: l.openingPrincipalMinor, unpaidInterestMinor: l.openingInterestMinor,
    balanceAsOf: l.balanceAsOf, currency: l.currency, disbursedOn: l.disbursedOn,
    interestMethod: l.interestMethod, interestPolicy: l.interestPolicy,
    interestFreeMonths: l.interestFreeMonths, installmentMinor: l.installmentMinor,
    maxDeductionPercent: l.maxDeductionPercent, deductViaPayroll: l.deductViaPayroll,
    purpose: l.purpose, ratePercent: l.rates[0]?.ratePercent
  };
}
function planRow(companyId, raw, index, seen) {
  const out = { rowNo: index + 2, action: 'error', loanId: null, loanNo: null, values: {}, warnings: [], errors: [] };
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) c.fail('Mapped row must be an object');
    if (raw.rowNo != null) out.rowNo = c.money(raw.rowNo, 'Row number', 1);
    for (const key of Object.keys(raw)) if (!keys.has(key) && key !== 'rowNo') c.fail(`Unknown mapped field ${key}; employee IDs, status and approval authority are not importable`);
    const supplied = Object.fromEntries(Object.entries(raw).filter(([k, v]) => keys.has(k) && !blank(v)));
    out.loanNo = c.text(supplied.loanNo, 'Loan number');
    if (seen.has(out.loanNo)) c.fail(`Loan number ${out.loanNo} appears twice in this batch`);
    seen.add(out.loanNo);
    const found = getDb().prepare('SELECT id FROM employee_loans WHERE company_id=? AND loan_no=?').get(companyId, out.loanNo);
    const old = found ? loans.get(companyId, found.id) : null;
    out.loanId = old?.id ?? null;
    if (old && !old.balanceAsOf) c.fail('This is an ordinary loan; import cannot replace it with an opening balance');
    const prev = old ? previousValues(old) : {};
    const p = { ...prev, ...supplied, loanNo: out.loanNo };
    if (supplied.staffCode != null || !old) {
      const staffCode = c.text(supplied.staffCode, 'Staff code');
      const staff = getDb().prepare('SELECT id FROM employees WHERE company_id=? AND staff_code=?').get(companyId, staffCode);
      if (!staff) c.fail(`Staff code ${staffCode} not found in this company`);
      p.employeeId = staff.id;
    }
    delete p.staffCode;
    c.money(p.originalPrincipalMinor, 'Original principal', 1);
    c.money(p.currentPrincipalMinor, 'Current principal');
    c.money(p.unpaidInterestMinor, 'Unpaid interest');
    c.money(p.currentPrincipalMinor + p.unpaidInterestMinor, 'Opening debt');
    c.date(p.balanceAsOf, 'Balance as of');
    if (p.balanceAsOf.startsWith('0000-') || p.balanceAsOf !== ac.lastDayOfMonth(p.balanceAsOf.slice(0, 7))) c.fail('Balance as of must be a real YYYY-MM-DD calendar month end');
    if (p.balanceAsOf > ac.ppDate(Date.now())) c.fail('Future opening balances are not supported');
    if (typeof p.disbursedOn !== 'string' || p.disbursedOn.startsWith('0000-')) c.fail('Original disbursement must be a real YYYY-MM-DD date');
    if (p.disbursedOn > p.balanceAsOf) c.fail('Original disbursement must be on or before the opening balance');
    p.maxDeductionPercent = loans.validateTerms(companyId, { ...p, principalMinor: p.originalPrincipalMinor });
    p.deductViaPayroll ??= true;
    p.purpose = p.purpose == null ? null : c.text(p.purpose, 'Purpose');
    // Validate anniversary bounds now, not after approval has posted money.
    require('../util/loanCalc').addMonths(p.disbursedOn, p.interestFreeMonths);
    out.values = p;
    const identical = old && c.hash(prev) === c.hash(p);
    if (old && (old.status !== 'draft' || old.approvedAt || old.entries.length)) {
      if (identical && ['active', 'paid'].includes(old.status)) {
        out.action = 'skip'; out.warnings.push('Identical approved opening; current ledger and terms preserved');
        return out;
      }
      c.fail(`Loan ${out.loanNo} is approved or frozen; import cannot rewrite financial terms or history. Use the authorized loan actions for corrections.`);
    }
    if (old && (old.rates.length !== 1 || old.postponements.length)) c.fail('Draft has dated changes; review those loan actions before reimporting');
    out.action = old ? (identical ? 'skip' : 'update') : 'create';
  } catch (e) { out.errors.push(e.message); out.action = 'error'; }
  return out;
}
function preview(companyId, input) {
  batch(companyId, input);
  const seen = new Set();
  const rows = Array.from(input.rows, (r, i) => planRow(companyId, r, i, seen));
  const count = a => rows.filter(r => r.action === a).length;
  return { rows, summary: { total: rows.length, create: count('create'), update: count('update'), skip: count('skip'), error: count('error') }, valid: !count('error') };
}
function apply(companyId, input) {
  batch(companyId, input, true);
  const invalid = {}; // Private sentinel: validation rejects before any receipt/write.
  let rejected;
  try {
    return c.operation(companyId, input.operationId, 'loan:import', input, () => {
      const plan = preview(companyId, { rows: input.rows });
      if (!plan.valid) {
        rejected = { applied: false, created: 0, updated: 0, skipped: 0, failed: plan.rows.length,
          rows: plan.rows.map(r => r.action === 'error' ? r : { ...r, action: 'blocked', errors: ['Batch rejected; correct all row errors and preview again'] }) };
        throw invalid;
      }
      const db = getDb();
      const rows = plan.rows.map(r => {
        if (r.action === 'skip') return r;
        const p = r.values;
        const id = r.loanId || uuid();
        const now = Date.now();
        if (r.action === 'create') {
          db.prepare(`INSERT INTO employee_loans (id,company_id,employee_id,loan_no,original_principal_minor,currency,disbursed_on,interest_method,interest_policy,interest_free_months,installment_minor,max_deduction_percent,deduct_via_payroll,status,purpose,created_at,balance_as_of,opening_principal_minor,opening_interest_minor)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)`).run(id, companyId, p.employeeId, p.loanNo, p.originalPrincipalMinor, p.currency, p.disbursedOn, p.interestMethod, p.interestPolicy, p.interestFreeMonths, p.installmentMinor, p.maxDeductionPercent, +p.deductViaPayroll, p.purpose, now, p.balanceAsOf, p.currentPrincipalMinor, p.unpaidInterestMinor);
          db.prepare('INSERT INTO loan_rate_changes VALUES (?,?,?,?,?,?,?,?)').run(uuid(), companyId, id, p.disbursedOn, p.ratePercent, 'Imported opening agreed rate', getCallerUserId(), now);
        } else {
          db.prepare(`UPDATE employee_loans SET employee_id=?,original_principal_minor=?,currency=?,disbursed_on=?,interest_method=?,interest_policy=?,interest_free_months=?,installment_minor=?,max_deduction_percent=?,deduct_via_payroll=?,purpose=?,balance_as_of=?,opening_principal_minor=?,opening_interest_minor=? WHERE company_id=? AND id=?`).run(p.employeeId, p.originalPrincipalMinor, p.currency, p.disbursedOn, p.interestMethod, p.interestPolicy, p.interestFreeMonths, p.installmentMinor, p.maxDeductionPercent, +p.deductViaPayroll, p.purpose, p.balanceAsOf, p.currentPrincipalMinor, p.unpaidInterestMinor, companyId, id);
          db.prepare('UPDATE loan_rate_changes SET effective_from=?,rate_pct=? WHERE company_id=? AND loan_id=?').run(p.disbursedOn, p.ratePercent, companyId, id);
        }
        c.audit('employee_loan', id, `import_${r.action}`, p);
        return { ...r, loanId: id };
      });
      return { applied: true, rows, created: plan.summary.create, updated: plan.summary.update, skipped: plan.summary.skip, failed: 0 };
    });
  } catch (e) { if (e === invalid) return rejected; throw e; }
}
function sampleWorkbook(companyId) {
  c.company(companyId);
  const wb = XLSX.utils.book_new();
  const example = { loanNo: 'EXAMPLE-USD', staffCode: 'REPLACE-WITH-STAFF-CODE', originalPrincipalMinor: 50000, currentPrincipalMinor: 20000,
    unpaidInterestMinor: 500, balanceAsOf: '2026-03-31', currency: 'USD', disbursedOn: '2026-01-01', interestMethod: 'declining',
    interestPolicy: 'separate', ratePercent: 2, interestFreeMonths: 0, installmentMinor: 10000, maxDeductionPercent: 100, deductViaPayroll: true, purpose: 'Synthetic example; replace before import' };
  const khr = { ...example, loanNo: 'EXAMPLE-KHR', currency: 'KHR', originalPrincipalMinor: 2000000, currentPrincipalMinor: 800000, unpaidInterestMinor: 20000, installmentMinor: 400000 };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([IMPORT_COLUMNS.map(x => x.key), ...[example, khr].map(r => IMPORT_COLUMNS.map(x => r[x.key]))]), 'Loans');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Column', 'What it is', 'Accepts'], ...IMPORT_COLUMNS.map(x => [x.key, x.label, x.accepts]),
    ['Reimports', '', 'Only nonempty supplied cells update imported drafts; empty cells never clear values.'],
    ['Approval', '', 'Imports remain drafts. Approval records one opening balance, no new cash or invented past repayments.'],
    ['Batch', '', 'At most 500 rows. All errors must be corrected; apply is atomic. Keep the same operationId for an uncertain retry.'],
    ['Future interest', '', 'Accrual begins after balanceAsOf. Original free-month anniversary remains in force.'],
    ['Examples', '', 'Synthetic USD and KHR examples only; replace both staff codes and all values before import.']
  ]), 'Instructions');
  return { filename: 'opening-loans-import-sample.xlsx', bytes: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}
module.exports = { MAX_ROWS, importColumns, preview, apply, sampleWorkbook };
