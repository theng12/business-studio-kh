// HR2 is additive: never change SCHEMA_VERSION or rewrite historical money.
function ensurePayrollSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
      settings_json TEXT NOT NULL, installment_minor INTEGER, updated_at INTEGER NOT NULL, updated_by_user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS employee_payroll_policies (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE RESTRICT,
      apply_nssf INTEGER NOT NULL, apply_tax INTEGER NOT NULL, tax_resident INTEGER NOT NULL,
      spouse_count INTEGER NOT NULL, dependent_count INTEGER NOT NULL, reason TEXT,
      updated_at INTEGER NOT NULL, updated_by_user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS employee_pay_rates (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      effective_from TEXT NOT NULL, basis TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
      currency TEXT NOT NULL, reason TEXT NOT NULL, set_by_user_id TEXT, created_at INTEGER NOT NULL,
      UNIQUE(employee_id,effective_from)
    );
    CREATE TABLE IF NOT EXISTS pay_components (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      code TEXT NOT NULL, name_en TEXT NOT NULL, name_km TEXT, kind TEXT NOT NULL, calc TEXT NOT NULL,
      default_amount_minor INTEGER NOT NULL DEFAULT 0, taxable INTEGER NOT NULL, nssf_contributory INTEGER NOT NULL,
      is_fringe_benefit INTEGER NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(company_id,code)
    );
    CREATE TABLE IF NOT EXISTS employee_components (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      component_id TEXT NOT NULL REFERENCES pay_components(id) ON DELETE RESTRICT,
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
      created_at INTEGER NOT NULL, set_by_user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS statutory_rate_sets (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      name TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, status TEXT NOT NULL DEFAULT 'draft',
      source_note TEXT, confirmed_by_user_id TEXT, confirmed_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nssf_wage_bands (
      rate_set_id TEXT NOT NULL REFERENCES statutory_rate_sets(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL, upper_khr INTEGER, base_khr INTEGER NOT NULL, PRIMARY KEY(rate_set_id,position)
    );
    CREATE TABLE IF NOT EXISTS nssf_rates (
      rate_set_id TEXT NOT NULL REFERENCES statutory_rate_sets(id) ON DELETE RESTRICT,
      component TEXT NOT NULL, employee_rate REAL NOT NULL, employer_rate REAL NOT NULL, PRIMARY KEY(rate_set_id,component)
    );
    CREATE TABLE IF NOT EXISTS nssf_component_bands (
      rate_set_id TEXT NOT NULL, component TEXT NOT NULL, position INTEGER NOT NULL,
      upper_khr INTEGER, base_khr INTEGER NOT NULL,
      PRIMARY KEY(rate_set_id,component,position),
      FOREIGN KEY(rate_set_id,component) REFERENCES nssf_rates(rate_set_id,component) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS salary_tax_brackets (
      rate_set_id TEXT NOT NULL REFERENCES statutory_rate_sets(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL, upper_khr INTEGER, rate REAL NOT NULL, PRIMARY KEY(rate_set_id,position)
    );
    CREATE TABLE IF NOT EXISTS salary_tax_params (
      rate_set_id TEXT PRIMARY KEY REFERENCES statutory_rate_sets(id) ON DELETE RESTRICT,
      spouse_allowance_khr INTEGER NOT NULL, dependent_allowance_khr INTEGER NOT NULL, max_dependents INTEGER,
      non_resident_rate REAL NOT NULL, fringe_benefit_rate REAL NOT NULL, pension_deductible INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      month TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, pay_date TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 0,
      tax_rate_khr_per_usd REAL, rate_source TEXT, statutory_rate_set_id TEXT REFERENCES statutory_rate_sets(id) ON DELETE RESTRICT,
      source_hash TEXT, input_snapshot TEXT NOT NULL, approved_at INTEGER, approved_by_user_id TEXT,
      void_reason TEXT, voided_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payroll_lines (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT, active INTEGER NOT NULL DEFAULT 1,
      currency TEXT NOT NULL, base_minor INTEGER NOT NULL DEFAULT 0, overtime_minor INTEGER NOT NULL DEFAULT 0,
      gross_minor INTEGER NOT NULL DEFAULT 0, nssf_employee_minor INTEGER NOT NULL DEFAULT 0,
      nssf_employer_minor INTEGER NOT NULL DEFAULT 0, tax_base_khr INTEGER NOT NULL DEFAULT 0,
      salary_tax_khr INTEGER NOT NULL DEFAULT 0, fringe_tax_khr INTEGER NOT NULL DEFAULT 0,
      salary_tax_minor INTEGER NOT NULL DEFAULT 0, other_deductions_minor INTEGER NOT NULL DEFAULT 0,
      loan_deduction_minor INTEGER NOT NULL DEFAULT 0, advance_minor INTEGER NOT NULL DEFAULT 0,
      net_minor INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL, blockers_json TEXT NOT NULL,
      decisions_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_lines_active ON payroll_lines(run_id,employee_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS payroll_line_items (
      id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES payroll_lines(id) ON DELETE RESTRICT,
      code TEXT, label TEXT NOT NULL, kind TEXT NOT NULL, amount_minor INTEGER NOT NULL,
      amount_khr INTEGER, base_khr INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payroll_payments (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      line_id TEXT NOT NULL REFERENCES payroll_lines(id) ON DELETE RESTRICT,
      amount_minor INTEGER NOT NULL, paid_at TEXT NOT NULL, method TEXT NOT NULL, reference TEXT,
      reverses_payment_id TEXT UNIQUE REFERENCES payroll_payments(id) ON DELETE RESTRICT,
      reason TEXT, paid_by_user_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payroll_reviews (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE RESTRICT, revision INTEGER NOT NULL,
      source_hash TEXT NOT NULL, blockers_json TEXT NOT NULL, reviewed_by_user_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS employee_loans (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      loan_no TEXT NOT NULL, original_principal_minor INTEGER NOT NULL CHECK(original_principal_minor > 0), currency TEXT NOT NULL,
      disbursed_on TEXT NOT NULL, interest_method TEXT NOT NULL, interest_policy TEXT NOT NULL,
      interest_free_months INTEGER NOT NULL, installment_minor INTEGER NOT NULL, max_deduction_percent REAL NOT NULL,
      deduct_via_payroll INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', purpose TEXT,
      approved_at INTEGER, approved_by_user_id TEXT, created_at INTEGER NOT NULL, UNIQUE(company_id,loan_no)
    );
    CREATE TABLE IF NOT EXISTS loan_rate_changes (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      loan_id TEXT NOT NULL REFERENCES employee_loans(id) ON DELETE RESTRICT, effective_from TEXT NOT NULL,
      rate_pct REAL NOT NULL, reason TEXT NOT NULL, set_by_user_id TEXT, created_at INTEGER NOT NULL,
      UNIQUE(loan_id,effective_from)
    );
    CREATE TABLE IF NOT EXISTS loan_entries (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      loan_id TEXT NOT NULL REFERENCES employee_loans(id) ON DELETE RESTRICT, entry_date TEXT NOT NULL,
      kind TEXT NOT NULL, amount_minor INTEGER NOT NULL, principal_part INTEGER NOT NULL, interest_part INTEGER NOT NULL,
      source TEXT NOT NULL, payroll_line_id TEXT REFERENCES payroll_lines(id) ON DELETE RESTRICT,
      payment_id TEXT REFERENCES payroll_payments(id) ON DELETE RESTRICT,
      reverses_entry_id TEXT UNIQUE REFERENCES loan_entries(id) ON DELETE RESTRICT,
      period TEXT, note TEXT, snapshot TEXT, created_by_user_id TEXT, created_at INTEGER NOT NULL,
      reversed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_disbursement ON loan_entries(loan_id) WHERE kind='disbursement';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_interest_period ON loan_entries(loan_id,period) WHERE kind='interest' AND reversed_at IS NULL;
    CREATE TABLE IF NOT EXISTS loan_postponements (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      loan_id TEXT NOT NULL REFERENCES employee_loans(id) ON DELETE RESTRICT, month TEXT NOT NULL,
      reason TEXT NOT NULL, approved_by_user_id TEXT, created_at INTEGER NOT NULL, UNIQUE(loan_id,month)
    );
    CREATE TABLE IF NOT EXISTS payroll_operations (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT, operation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(company_id,operation_id)
    );
  `);
  const { addColumnIfMissing } = require('./index');
  addColumnIfMissing(db, 'employee_loans', 'balance_as_of', 'TEXT');
  addColumnIfMissing(db, 'employee_loans', 'opening_principal_minor', 'INTEGER CHECK(opening_principal_minor >= 0)');
  addColumnIfMissing(db, 'employee_loans', 'opening_interest_minor', 'INTEGER CHECK(opening_interest_minor >= 0)');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_opening ON loan_entries(loan_id) WHERE kind='opening_balance'");
  for (const table of ['employee_payroll_policies','employee_pay_rates','pay_components','employee_components','statutory_rate_sets','payroll_runs','payroll_lines','payroll_payments','payroll_reviews','employee_loans','loan_rate_changes','loan_entries','loan_postponements']) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_company ON ${table}(company_id)`);
  }
  for (const [table, col] of [['employee_pay_rates','employee_id'],['employee_components','employee_id'],['employee_components','component_id'],['payroll_runs','statutory_rate_set_id'],['payroll_lines','employee_id'],['payroll_line_items','line_id'],['payroll_payments','line_id'],['payroll_reviews','run_id'],['employee_loans','employee_id'],['loan_rate_changes','loan_id'],['loan_entries','loan_id'],['loan_entries','payroll_line_id'],['loan_entries','payment_id'],['loan_postponements','loan_id']]) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${col} ON ${table}(${col})`);
  }
}
module.exports = { ensurePayrollSchema };
