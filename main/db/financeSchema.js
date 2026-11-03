/**
 * Finance expenses: the native tables (docs/FINANCE_PLAN.md).
 *
 * Additive only (AGENTS.md §14): CREATE TABLE IF NOT EXISTS, run from initDb.
 * SCHEMA_VERSION is NOT bumped.
 *
 *   finance_settings    one row per company; approvalThresholdMinor (USD cents,
 *                       default 10000 = $100, strictly-above starts approval).
 *   finance_categories  editable, ordered, archivable, restorable. Seeded once
 *                       from CATEGORY_SEEDS; each row owns a GL expense account.
 *   finance_accounts    cash boxes (one active per branch) and bank accounts,
 *                       each currency USD or KHR and each its own GL asset
 *                       account. The opening balance is a dated journal entry.
 *   finance_expenses    draft -> pending/posted -> rejected/cancelled/reversed.
 *                       Frozen once submitted; never deleted.
 *
 * Balance and report figures are always derived from the ledger, never from a
 * stored running total here.
 */

function ensureFinanceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_settings (
      company_id                TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      approval_threshold_minor  INTEGER NOT NULL DEFAULT 10000 CHECK (approval_threshold_minor >= 0),
      updated_at                INTEGER NOT NULL,
      updated_by_user_id        TEXT
    );

    CREATE TABLE IF NOT EXISTS finance_categories (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      key                 TEXT NOT NULL,
      name                TEXT NOT NULL,
      name_km             TEXT,
      gl_account_id       TEXT NOT NULL REFERENCES gl_accounts(id),
      sort                INTEGER NOT NULL DEFAULT 0,
      archived_at         INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT,
      UNIQUE (company_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_finance_categories_company ON finance_categories(company_id);

    CREATE TABLE IF NOT EXISTS finance_accounts (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind                TEXT NOT NULL CHECK (kind IN ('cash', 'bank')),
      name                TEXT NOT NULL,
      name_km             TEXT,
      branch_id           TEXT REFERENCES branches(id),
      currency            TEXT NOT NULL CHECK (currency IN ('USD', 'KHR')),
      gl_account_id       TEXT NOT NULL REFERENCES gl_accounts(id),
      opening_minor       INTEGER NOT NULL DEFAULT 0 CHECK (opening_minor >= 0),
      opening_date        TEXT,
      opening_journal_id  TEXT REFERENCES journal_entries(id),
      archived_at         INTEGER,
      sort                INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_finance_accounts_company ON finance_accounts(company_id);
    CREATE INDEX IF NOT EXISTS idx_finance_accounts_branch ON finance_accounts(branch_id);
    -- One active cash box per branch (retired ones keep their history).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_accounts_one_cash_per_branch
      ON finance_accounts(company_id, branch_id)
      WHERE kind = 'cash' AND archived_at IS NULL;

    CREATE TABLE IF NOT EXISTS finance_expenses (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      client_uuid         TEXT NOT NULL,
      revision            INTEGER NOT NULL DEFAULT 1,
      status              TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending', 'posted', 'rejected', 'cancelled', 'reversed')),
      expense_date        TEXT,
      branch_id           TEXT REFERENCES branches(id),
      category_id         TEXT REFERENCES finance_categories(id),
      account_id          TEXT REFERENCES finance_accounts(id),
      currency            TEXT CHECK (currency IN ('USD', 'KHR')),
      amount_minor        INTEGER CHECK (amount_minor >= 0),
      usd_minor           INTEGER CHECK (usd_minor >= 0),
      khr_minor           INTEGER CHECK (khr_minor >= 0),
      fx_khr_per_usd      REAL,
      fx_rate_date        TEXT,
      fx_source           TEXT,
      threshold_minor     INTEGER,
      memo                TEXT,
      receipt_json        TEXT,
      journal_entry_id    TEXT REFERENCES journal_entries(id),
      reversal_journal_id TEXT REFERENCES journal_entries(id),
      submitted_at        INTEGER,
      submitted_by_user_id TEXT,
      approved_at         INTEGER,
      approved_by_user_id TEXT,
      rejected_at         INTEGER,
      rejected_by_user_id TEXT,
      reject_reason       TEXT,
      cancelled_at        INTEGER,
      cancelled_by_user_id TEXT,
      cancel_reason       TEXT,
      reversed_at         INTEGER,
      reversed_by_user_id TEXT,
      reverse_reason      TEXT,
      created_at          INTEGER NOT NULL,
      created_by_user_id  TEXT,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT,
      UNIQUE (company_id, client_uuid)
    );
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_company ON finance_expenses(company_id, expense_date);
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_branch ON finance_expenses(branch_id);
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_status ON finance_expenses(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_category ON finance_expenses(category_id);
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_account ON finance_expenses(account_id);
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_journal ON finance_expenses(journal_entry_id);

    /* No expense is ever deleted: a draft is cancelled, a posted one reversed. */
    CREATE TRIGGER IF NOT EXISTS trg_finance_expenses_no_delete
      BEFORE DELETE ON finance_expenses
      BEGIN SELECT RAISE(ABORT, 'Expenses are never deleted: cancel a draft or reverse a posted expense'); END;

    /* A submitted expense's money and identity are frozen. Status/audit/receipt
       columns stay writable so approve/reject/reverse can record what happened. */
    CREATE TRIGGER IF NOT EXISTS trg_finance_expenses_frozen
      BEFORE UPDATE ON finance_expenses
      WHEN OLD.submitted_at IS NOT NULL AND (
        NEW.company_id IS NOT OLD.company_id OR NEW.expense_date IS NOT OLD.expense_date
        OR NEW.branch_id IS NOT OLD.branch_id OR NEW.category_id IS NOT OLD.category_id
        OR NEW.account_id IS NOT OLD.account_id OR NEW.currency IS NOT OLD.currency
        OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.usd_minor IS NOT OLD.usd_minor
        OR NEW.khr_minor IS NOT OLD.khr_minor OR NEW.fx_khr_per_usd IS NOT OLD.fx_khr_per_usd
        OR NEW.fx_rate_date IS NOT OLD.fx_rate_date OR NEW.threshold_minor IS NOT OLD.threshold_minor
      )
      BEGIN SELECT RAISE(ABORT, 'A submitted expense is frozen: reverse it instead'); END;
  `);
}

module.exports = { ensureFinanceSchema };
