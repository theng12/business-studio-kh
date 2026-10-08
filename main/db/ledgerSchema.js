/**
 * Fixed Assets A0: the accounting core's tables (docs/ASSETS_AND_BRANCHES_PLAN.md §5).
 *
 * Additive only (AGENTS.md §14): CREATE TABLE IF NOT EXISTS, run on every
 * boot from initDb. SCHEMA_VERSION is NOT bumped.
 *
 *   gl_accounts         per company; seeded on first use (main/db/ledger.js).
 *                       `system_key` is the stable identity the app posts to —
 *                       code and name are the accountant's to change.
 *   accounting_periods  'YYYY-MM' rows, created lazily; a missing row is open.
 *   journal_entries     one per posting; money in US cents + the riel rate used.
 *   journal_lines       debit OR credit, ≥ 0, with the riel figure on every line.
 *   ledger_settings     per company JSON.
 *
 * "Posted means permanent" (§5.2 rule 2) is enforced by SQLite itself, so a
 * future bug — or a future agent — cannot quietly rewrite the books:
 *   - journal_lines: no UPDATE, no DELETE, and no line added to an entry after
 *     it was posted (each entry records how many lines it has);
 *   - journal_entries: no DELETE, and the only UPDATE allowed is setting
 *     `reversed_by_entry_id` once.
 * Mistakes are fixed by a reversing entry (ledger.reverse), never by editing.
 *
 * Journals and lines reference the company with ON DELETE RESTRICT (history);
 * accounts, periods and settings cascade (configuration). A company with any
 * journal entry cannot be deleted (main/db/fuelHistory.js HISTORY_TABLES).
 */

function ensureLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gl_accounts (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code                TEXT NOT NULL COLLATE NOCASE,
      name_en             TEXT NOT NULL,
      name_km             TEXT,
      type                TEXT NOT NULL,
      normal_balance      TEXT NOT NULL,
      parent_id           TEXT REFERENCES gl_accounts(id),
      system_key          TEXT,
      is_postable         INTEGER NOT NULL DEFAULT 1,
      archived_at         INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT,
      UNIQUE (company_id, code),
      UNIQUE (company_id, system_key)
    );
    CREATE INDEX IF NOT EXISTS idx_gl_accounts_company ON gl_accounts(company_id);
    CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent ON gl_accounts(parent_id);

    CREATE TABLE IF NOT EXISTS accounting_periods (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      period              TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'open',
      locked_by_user_id   TEXT,
      locked_at           INTEGER,
      lock_note           TEXT,
      updated_at          INTEGER NOT NULL,
      UNIQUE (company_id, period)
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      entry_no              TEXT NOT NULL,
      entry_date            TEXT NOT NULL,
      period                TEXT NOT NULL,
      intended_date         TEXT,
      source_kind           TEXT NOT NULL,
      source_id             TEXT,
      idempotency_key       TEXT NOT NULL,
      memo                  TEXT,
      base_currency         TEXT NOT NULL DEFAULT 'USD',
      fx_khr_per_usd        REAL NOT NULL,
      fx_source             TEXT,
      status                TEXT NOT NULL DEFAULT 'posted',
      line_count            INTEGER NOT NULL,
      total_minor           INTEGER NOT NULL,
      khr_total             INTEGER NOT NULL,
      reverses_entry_id     TEXT REFERENCES journal_entries(id) ON DELETE RESTRICT,
      reversed_by_entry_id  TEXT REFERENCES journal_entries(id) ON DELETE RESTRICT,
      created_by_user_id    TEXT,
      created_at            INTEGER NOT NULL,
      UNIQUE (company_id, entry_no),
      UNIQUE (company_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_journal_entries_period ON journal_entries(company_id, period);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_reverses ON journal_entries(reverses_entry_id);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_reversed_by ON journal_entries(reversed_by_entry_id);

    CREATE TABLE IF NOT EXISTS journal_lines (
      id                TEXT PRIMARY KEY,
      entry_id          TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
      company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      line_no           INTEGER NOT NULL,
      account_id        TEXT NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
      debit_minor       INTEGER NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
      credit_minor      INTEGER NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
      txn_currency      TEXT,
      txn_amount_minor  INTEGER,
      khr_minor         INTEGER NOT NULL CHECK (khr_minor >= 0),
      branch_id         TEXT REFERENCES branches(id) ON DELETE RESTRICT,
      asset_id          TEXT REFERENCES fixed_assets(id) ON DELETE RESTRICT,
      employee_id       TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      line_role         TEXT,
      memo              TEXT,
      CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)),
      UNIQUE (entry_id, line_no)
    );
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_asset ON journal_lines(asset_id, line_role);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_branch ON journal_lines(branch_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_employee ON journal_lines(employee_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_company ON journal_lines(company_id);

    CREATE TABLE IF NOT EXISTS ledger_settings (
      company_id          TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings_json       TEXT NOT NULL DEFAULT '{}',
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );

    /* §5.2 rule 2 — posted means permanent. */
    CREATE TRIGGER IF NOT EXISTS trg_journal_lines_no_update
      BEFORE UPDATE ON journal_lines
      BEGIN SELECT RAISE(ABORT, 'Posted journal lines are permanent: post a reversing entry instead'); END;
    CREATE TRIGGER IF NOT EXISTS trg_journal_lines_no_delete
      BEFORE DELETE ON journal_lines
      BEGIN SELECT RAISE(ABORT, 'Posted journal lines are permanent: post a reversing entry instead'); END;
    CREATE TRIGGER IF NOT EXISTS trg_journal_lines_closed_entry
      BEFORE INSERT ON journal_lines
      WHEN (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.entry_id)
           >= (SELECT line_count FROM journal_entries WHERE id = NEW.entry_id)
      BEGIN SELECT RAISE(ABORT, 'A posted journal entry cannot gain lines'); END;
    CREATE TRIGGER IF NOT EXISTS trg_journal_entries_no_delete
      BEFORE DELETE ON journal_entries
      BEGIN SELECT RAISE(ABORT, 'Posted journal entries are permanent: post a reversing entry instead'); END;
    CREATE TRIGGER IF NOT EXISTS trg_journal_entries_only_reversal_link
      BEFORE UPDATE ON journal_entries
      WHEN OLD.reversed_by_entry_id IS NOT NULL
        OR NEW.reversed_by_entry_id IS NULL
        OR NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
        OR NEW.entry_no IS NOT OLD.entry_no OR NEW.entry_date IS NOT OLD.entry_date
        OR NEW.period IS NOT OLD.period OR NEW.intended_date IS NOT OLD.intended_date
        OR NEW.source_kind IS NOT OLD.source_kind OR NEW.source_id IS NOT OLD.source_id
        OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.memo IS NOT OLD.memo
        OR NEW.base_currency IS NOT OLD.base_currency OR NEW.fx_khr_per_usd IS NOT OLD.fx_khr_per_usd
        OR NEW.fx_source IS NOT OLD.fx_source OR NEW.status IS NOT OLD.status
        OR NEW.line_count IS NOT OLD.line_count OR NEW.total_minor IS NOT OLD.total_minor
        OR NEW.khr_total IS NOT OLD.khr_total OR NEW.reverses_entry_id IS NOT OLD.reverses_entry_id
        OR NEW.created_by_user_id IS NOT OLD.created_by_user_id OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Posted journal entries are permanent: only the reversal link can be set, once'); END;
  `);
}

module.exports = { ensureLedgerSchema };
