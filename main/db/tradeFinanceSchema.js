/**
 * Trade Finance — the native tables (docs/TRADE_FINANCE_PLAN.md §3).
 *
 * Additive only (AGENTS.md §14): CREATE TABLE IF NOT EXISTS, run from initDb.
 * SCHEMA_VERSION is NOT bumped. Every row carries company_id, so the same
 * rules hold in standalone, server and client mode.
 *
 * Money is an INTEGER in the currency's minor unit (US cents / whole riel);
 * dates are TEXT 'YYYY-MM-DD'; timestamps are INTEGER ms. Nothing here stores
 * a running total — drawn, outstanding and accrued figures are derived.
 *
 * A facility is a set of RULES (interest_basis, has_maturity, commitment_rate,
 * …), not a hardcoded type; `kind` is only the preset label. Phase A writes
 * drawn-amount facilities; the running-balance (overdraft) columns are ready
 * for the Phase B movement screen.
 */

function ensureTradeFinanceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tf_banks (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name                TEXT NOT NULL,
      note                TEXT,
      archived_at         INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tf_banks_company ON tf_banks(company_id, archived_at);

    CREATE TABLE IF NOT EXISTS tf_facilities (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      bank_id             TEXT NOT NULL REFERENCES tf_banks(id),
      kind                TEXT NOT NULL DEFAULT 'RC',
      name                TEXT NOT NULL,
      currency            TEXT NOT NULL CHECK (currency IN ('USD', 'KHR')),
      limit_minor         INTEGER NOT NULL DEFAULT 0 CHECK (limit_minor >= 0),
      rate                REAL NOT NULL DEFAULT 0 CHECK (rate >= 0),
      day_count           INTEGER NOT NULL DEFAULT 360 CHECK (day_count IN (360, 365)),
      revolving           INTEGER NOT NULL DEFAULT 1,
      has_maturity        INTEGER NOT NULL DEFAULT 1,
      interest_basis      TEXT NOT NULL DEFAULT 'drawn' CHECK (interest_basis IN ('drawn', 'balance')),
      interest_billing    TEXT NOT NULL DEFAULT 'at_repayment' CHECK (interest_billing IN ('at_repayment', 'month_end_capitalised')),
      commitment_rate     REAL NOT NULL DEFAULT 0 CHECK (commitment_rate >= 0),
      commitment_freq     TEXT NOT NULL DEFAULT 'monthly' CHECK (commitment_freq IN ('monthly', 'quarterly', 'yearly')),
      term_days           INTEGER CHECK (term_days IS NULL OR term_days > 0),
      active              INTEGER NOT NULL DEFAULT 1,
      note                TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tf_facilities_company ON tf_facilities(company_id, active);
    CREATE INDEX IF NOT EXISTS idx_tf_facilities_bank ON tf_facilities(bank_id);

    /* Rate history is appended whenever a facility's rate is edited. Postings
       store their own rate, so a later change never reprices history. */
    CREATE TABLE IF NOT EXISTS tf_rate_history (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      facility_id         TEXT NOT NULL REFERENCES tf_facilities(id) ON DELETE CASCADE,
      rate                REAL NOT NULL,
      effective_date      TEXT NOT NULL,
      note                TEXT,
      created_at          INTEGER NOT NULL,
      created_by_user_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tf_rate_history_facility ON tf_rate_history(facility_id, effective_date);

    CREATE TABLE IF NOT EXISTS tf_drawdowns (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      client_uuid         TEXT,
      facility_id         TEXT NOT NULL REFERENCES tf_facilities(id),
      principal_minor     INTEGER NOT NULL CHECK (principal_minor > 0),
      value_date          TEXT NOT NULL,
      maturity_date       TEXT,
      rate                REAL NOT NULL CHECK (rate >= 0),
      reference           TEXT,
      settle_currency     TEXT,
      fx_rate             REAL CHECK (fx_rate IS NULL OR fx_rate > 0),
      purchase_order_id   TEXT REFERENCES purchase_orders(id),
      note                TEXT,
      status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'cancelled')),
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      created_by_user_id  TEXT,
      updated_by_user_id  TEXT
    );
    /* A bank reference is optional, but no two drawdowns share one when given. */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_drawdown_reference
      ON tf_drawdowns(company_id, reference) WHERE reference IS NOT NULL;
    /* A lost reply must not create a second drawdown (Finance's client_uuid rule). */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_drawdown_client
      ON tf_drawdowns(company_id, client_uuid) WHERE client_uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tf_drawdowns_facility ON tf_drawdowns(facility_id, status);
    CREATE INDEX IF NOT EXISTS idx_tf_drawdowns_maturity ON tf_drawdowns(company_id, maturity_date);
    CREATE INDEX IF NOT EXISTS idx_tf_drawdowns_po ON tf_drawdowns(purchase_order_id);

    CREATE TABLE IF NOT EXISTS tf_repayments (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      client_uuid         TEXT,
      drawdown_id         TEXT NOT NULL REFERENCES tf_drawdowns(id),
      principal_minor     INTEGER NOT NULL DEFAULT 0 CHECK (principal_minor >= 0),
      interest_minor      INTEGER NOT NULL DEFAULT 0 CHECK (interest_minor >= 0),
      paid_on             TEXT NOT NULL,
      note                TEXT,
      created_at          INTEGER NOT NULL,
      created_by_user_id  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_repayment_client
      ON tf_repayments(company_id, client_uuid) WHERE client_uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tf_repayments_drawdown ON tf_repayments(drawdown_id, paid_on);

    /* The persisted interest record. The source column distinguishes our
       charge from the bank's actual figure (Phase B reconciliation). The
       unique indexes make a re-run of the same period impossible to
       double-post, including facility-level rows where drawdown_id is NULL. */
    CREATE TABLE IF NOT EXISTS tf_interest_postings (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      facility_id         TEXT NOT NULL REFERENCES tf_facilities(id),
      drawdown_id         TEXT REFERENCES tf_drawdowns(id),
      period_start        TEXT NOT NULL,
      period_end          TEXT NOT NULL,
      basis_minor         INTEGER NOT NULL DEFAULT 0,
      rate                REAL NOT NULL,
      day_count           INTEGER NOT NULL,
      days                INTEGER NOT NULL DEFAULT 0,
      amount_minor        INTEGER NOT NULL,
      source              TEXT NOT NULL DEFAULT 'charged' CHECK (source IN ('charged', 'bank_actual')),
      note                TEXT,
      created_at          INTEGER NOT NULL,
      created_by_user_id  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_interest_drawdown_period
      ON tf_interest_postings(facility_id, drawdown_id, period_start, period_end, source)
      WHERE drawdown_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_interest_facility_period
      ON tf_interest_postings(facility_id, period_start, period_end, source)
      WHERE drawdown_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tf_interest_facility ON tf_interest_postings(facility_id, period_end);
    CREATE INDEX IF NOT EXISTS idx_tf_interest_drawdown ON tf_interest_postings(drawdown_id);

    /* Phase B: the running balance of an overdraft. Balance-based facilities
       take no drawdowns; their balance is the sum of these signed entries
       (+ increases what is owed, - reduces it). Month-end interest is
       capitalised as a real entry, so the next month compounds. */
    CREATE TABLE IF NOT EXISTS tf_ledger_entries (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      client_uuid         TEXT,
      facility_id         TEXT NOT NULL REFERENCES tf_facilities(id),
      entry_date          TEXT NOT NULL,
      kind                TEXT NOT NULL CHECK (kind IN ('opening', 'draw', 'repay', 'interest_capitalised', 'adjustment')),
      amount_minor        INTEGER NOT NULL,
      note                TEXT,
      created_at          INTEGER NOT NULL,
      created_by_user_id  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_ledger_client
      ON tf_ledger_entries(company_id, client_uuid) WHERE client_uuid IS NOT NULL;
    /* One capitalisation per facility per month, whatever two runs decide at
       the same moment — the posting's own unique index is not enough, because
       the matching ledger entry is what moves the balance. */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_ledger_capitalised
      ON tf_ledger_entries(facility_id, entry_date) WHERE kind = 'interest_capitalised';
    CREATE INDEX IF NOT EXISTS idx_tf_ledger_facility ON tf_ledger_entries(facility_id, entry_date, created_at);

    /* Phase B: fees charged by the bank (TT, commitment, commission, handling),
       optionally tied to a facility or drawdown. */
    CREATE TABLE IF NOT EXISTS tf_fees (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      client_uuid         TEXT,
      facility_id         TEXT REFERENCES tf_facilities(id),
      drawdown_id         TEXT REFERENCES tf_drawdowns(id),
      kind                TEXT NOT NULL,
      amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),
      currency            TEXT NOT NULL,
      fee_date            TEXT NOT NULL,
      note                TEXT,
      created_at          INTEGER NOT NULL,
      created_by_user_id  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_fee_client
      ON tf_fees(company_id, client_uuid) WHERE client_uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tf_fees_company ON tf_fees(company_id, fee_date);

    /* Phase B: scheduled fees that post themselves when due (catch-up safe). */
    CREATE TABLE IF NOT EXISTS tf_recurring_fees (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      facility_id         TEXT REFERENCES tf_facilities(id),
      kind                TEXT NOT NULL,
      amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),
      currency            TEXT NOT NULL,
      frequency           TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
      next_date           TEXT NOT NULL,
      enabled             INTEGER NOT NULL DEFAULT 1,
      note                TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tf_recurring_company ON tf_recurring_fees(company_id, next_date);

    /* Phase C: reminders. A rule is a lead time in days before a maturity;
       lead_days = 0 is the overdue rule that fires daily. facility_id NULL is
       a global rule; any rule on a facility replaces the global set for it.
       Rules are disabled, never deleted — like everything else here. */
    CREATE TABLE IF NOT EXISTS tf_reminder_rules (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      facility_id         TEXT REFERENCES tf_facilities(id),
      lead_days           INTEGER NOT NULL CHECK (lead_days >= 0),
      label               TEXT NOT NULL,
      enabled             INTEGER NOT NULL DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tf_reminder_rules_company ON tf_reminder_rules(company_id, facility_id);

    /* What the app has already surfaced. A pre-due rule logs once; the overdue
       rule logs once a day. The unique index is the dedupe guard. */
    CREATE TABLE IF NOT EXISTS tf_reminder_log (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      subject_kind        TEXT NOT NULL CHECK (subject_kind IN ('drawdown', 'facility', 'recurring_fee')),
      subject_id          TEXT NOT NULL,
      rule_key            TEXT NOT NULL,
      send_date           TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'shown',
      detail              TEXT,
      sent_at             INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tf_reminder_log
      ON tf_reminder_log(company_id, subject_kind, subject_id, rule_key, send_date);
    CREATE INDEX IF NOT EXISTS idx_tf_reminder_log_company ON tf_reminder_log(company_id, sent_at);

    /* Phase C: per-company switch for the background money postings (month-end
       capitalisation, recurring fees). Off by default — an auto-action is a
       deliberate switch (owner, 2026-11-13). The reminder pass always runs. */
    CREATE TABLE IF NOT EXISTS tf_settings (
      company_id          TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      auto_post           INTEGER NOT NULL DEFAULT 0,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
  `);

  // Phase C: a drawdown's reminders can be snoozed until a date.
  const { addColumnIfMissing } = require('./index');
  addColumnIfMissing(db, 'tf_drawdowns', 'snooze_until', 'TEXT');
}

module.exports = { ensureTradeFinanceSchema };
