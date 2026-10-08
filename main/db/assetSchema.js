/**
 * Fixed Assets & Branches A0 + A1 — schema (docs/ASSETS_AND_BRANCHES_PLAN.md §3).
 *
 * Additive only (AGENTS.md §14): CREATE TABLE IF NOT EXISTS / addColumnIfMissing,
 * run on every boot from initDb. SCHEMA_VERSION is NOT bumped — a bump runs
 * wipeStructuralTables() and erases the catalogue.
 *
 * Conventions (same as the fuel schema): UUID text ids, epoch-ms timestamps,
 * dates 'YYYY-MM-DD' (Asia/Phnom_Penh), periods 'YYYY-MM', money as whole
 * minor units (`*_minor`, US cents or riel) plus a currency code.
 *
 * Deletion rules — "no DELETE anywhere" (§3):
 *   - HISTORY rows (branches, fixed_assets, asset_events, and the journals in
 *     ledgerSchema.js) reference the company with ON DELETE RESTRICT, and
 *     `companies:remove` refuses in words first (main/db/fuelHistory.js).
 *   - CONFIGURATION rows (categories, settings, fx rates, tag batches, tag
 *     aliases, the file index) cascade with the company.
 *   - Mistakes are fixed by void (reason required, only where nothing was
 *     posted) or by a reversing entry. A draft is cancelled, never deleted.
 *
 * Asset photos and documents are evidence: files under
 * `<dataDir>/fixed-assets/` (NOT assets/, which is the catalogue's and is
 * served by /assets/ and app-image://), read only through `assets:getFile`.
 */

const { addColumnIfMissing } = require('./index');
const { ensureLedgerSchema } = require('./ledgerSchema');

function ensureAssetSchema(db) {
  db.exec(`
    /* §3.1 */
    CREATE TABLE IF NOT EXISTS branches (
      id                   TEXT PRIMARY KEY,
      company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      code                 TEXT NOT NULL COLLATE NOCASE,
      name_en              TEXT NOT NULL,
      name_km              TEXT,
      address              TEXT,
      phone                TEXT,
      manager_employee_id  TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      is_head_office       INTEGER NOT NULL DEFAULT 0,
      status               TEXT NOT NULL DEFAULT 'active',
      closed_at            INTEGER,
      closed_reason        TEXT,
      sort                 INTEGER NOT NULL DEFAULT 0,
      notes                TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      updated_by_user_id   TEXT,
      UNIQUE (company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_branches_company ON branches(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_branches_manager ON branches(manager_employee_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_head_office ON branches(company_id) WHERE is_head_office = 1;

    /* §3.2 — the rate a journal used is stored on the journal; this is the source list. */
    CREATE TABLE IF NOT EXISTS fx_rates (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      rate_date           TEXT NOT NULL,
      khr_per_usd         REAL NOT NULL,
      source              TEXT NOT NULL DEFAULT 'house',
      source_note         TEXT,
      file_id             TEXT,
      created_by_user_id  TEXT,
      created_at          INTEGER NOT NULL,
      voided_at           INTEGER,
      void_reason         TEXT,
      voided_by_user_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fx_rates_lookup ON fx_rates(company_id, source, rate_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fx_rates_one_per_day ON fx_rates(company_id, rate_date, source) WHERE voided_at IS NULL;

    /* §3.3 */
    CREATE TABLE IF NOT EXISTS asset_categories (
      id                     TEXT PRIMARY KEY,
      company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      builtin_key            TEXT,
      name_en                TEXT NOT NULL,
      name_km                TEXT,
      tag_prefix             TEXT,
      default_life_months    INTEGER,
      default_salvage_pct    REAL NOT NULL DEFAULT 0,
      book_method            TEXT NOT NULL DEFAULT 'straight_line',
      tax_class              TEXT NOT NULL DEFAULT '4',
      gl_cost_account_id     TEXT REFERENCES gl_accounts(id),
      gl_accum_account_id    TEXT REFERENCES gl_accounts(id),
      gl_expense_account_id  TEXT REFERENCES gl_accounts(id),
      is_vehicle             INTEGER NOT NULL DEFAULT 0,
      sort                   INTEGER NOT NULL DEFAULT 0,
      archived_at            INTEGER,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      updated_by_user_id     TEXT,
      UNIQUE (company_id, builtin_key)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_categories_company ON asset_categories(company_id);
    CREATE INDEX IF NOT EXISTS idx_asset_categories_cost ON asset_categories(gl_cost_account_id);
    CREATE INDEX IF NOT EXISTS idx_asset_categories_accum ON asset_categories(gl_accum_account_id);
    CREATE INDEX IF NOT EXISTS idx_asset_categories_expense ON asset_categories(gl_expense_account_id);

    CREATE TABLE IF NOT EXISTS asset_settings (
      company_id          TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings_json       TEXT NOT NULL DEFAULT '{}',
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );

    /* §3.4 — the register. Snapshot columns (accum_minor, nbv_minor,
       last_posted_period) are rebuilt from the events and journals; they only
       make lists fast. */
    CREATE TABLE IF NOT EXISTS fixed_assets (
      id                         TEXT PRIMARY KEY,
      company_id                 TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      tag_code                   TEXT NOT NULL COLLATE NOCASE,
      tag_seq                    INTEGER,
      name                       TEXT NOT NULL,
      name_km                    TEXT,
      category_id                TEXT NOT NULL REFERENCES asset_categories(id),
      quantity                   INTEGER NOT NULL DEFAULT 1,
      serial_no                  TEXT,
      make_model                 TEXT,
      plate_no                   TEXT,
      registration_no            TEXT,
      insurance_until            TEXT,
      road_tax_until             TEXT,
      branch_id                  TEXT REFERENCES branches(id) ON DELETE RESTRICT,
      location_note              TEXT,
      custodian_employee_id      TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      status                     TEXT NOT NULL DEFAULT 'in_use',
      record_state               TEXT NOT NULL DEFAULT 'draft',
      accounting_treatment       TEXT,
      depreciate_override        INTEGER,
      needs_cost                 INTEGER NOT NULL DEFAULT 0,
      origin                     TEXT NOT NULL DEFAULT 'manual',
      acquisition_kind           TEXT NOT NULL DEFAULT 'purchase',
      purchase_date              TEXT,
      in_service_date            TEXT,
      supplier_id                TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
      purchase_order_id          TEXT,
      invoice_no                 TEXT,
      cost_minor                 INTEGER,
      cost_currency              TEXT NOT NULL DEFAULT 'USD',
      cost_fx_khr_per_usd        REAL,
      cost_usd_minor             INTEGER,
      vat_minor                  INTEGER,
      warranty_until             TEXT,
      warranty_note              TEXT,
      cost_basis                 TEXT,
      opening_as_of              TEXT,
      opening_accum_minor        INTEGER NOT NULL DEFAULT 0,
      useful_life_months         INTEGER,
      schedule_life_months       INTEGER,
      salvage_minor              INTEGER,
      depreciation_start_period  TEXT,
      accum_minor                INTEGER NOT NULL DEFAULT 0,
      nbv_minor                  INTEGER,
      last_posted_period         TEXT,
      tax_class                  TEXT,
      tax_class_reason           TEXT,
      tax_cost_khr_minor         INTEGER,
      tax_fx_khr_per_usd         REAL,
      tax_fx_source              TEXT,
      tax_opening_wdv_khr_minor  INTEGER,
      fuel_asset_id              TEXT REFERENCES fuel_assets(id),
      tag_printed_at             INTEGER,
      activated_at               INTEGER,
      activated_by_user_id       TEXT,
      acquisition_entry_id       TEXT REFERENCES journal_entries(id),
      cancelled_at               INTEGER,
      cancel_reason              TEXT,
      notes                      TEXT,
      created_at                 INTEGER NOT NULL,
      updated_at                 INTEGER NOT NULL,
      updated_by_user_id         TEXT,
      UNIQUE (company_id, tag_code)
    );
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_company ON fixed_assets(company_id, record_state, status);
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_category ON fixed_assets(category_id);
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_branch ON fixed_assets(branch_id);
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_custodian ON fixed_assets(custodian_employee_id);
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_supplier ON fixed_assets(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_po ON fixed_assets(purchase_order_id);
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_serial ON fixed_assets(company_id, serial_no);
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_entry ON fixed_assets(acquisition_entry_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fixed_assets_fuel ON fixed_assets(fuel_asset_id) WHERE fuel_asset_id IS NOT NULL;

    /* Photos and documents (evidence, under <dataDir>/fixed-assets/). Never
       deleted: a file is retired with a reason, its bytes stay. */
    CREATE TABLE IF NOT EXISTS asset_files (
      id                   TEXT PRIMARY KEY,
      company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      asset_id             TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
      kind                 TEXT NOT NULL,
      position             INTEGER NOT NULL DEFAULT 0,
      rel_path             TEXT NOT NULL UNIQUE,
      sha256               TEXT NOT NULL,
      original_sha256      TEXT,
      mime                 TEXT NOT NULL,
      bytes                INTEGER,
      width                INTEGER,
      height               INTEGER,
      original_name        TEXT,
      uploaded_by_user_id  TEXT,
      uploaded_at          INTEGER NOT NULL,
      retired_at           INTEGER,
      retired_reason       TEXT,
      retired_by_user_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asset_files_asset ON asset_files(asset_id, kind, position);
    CREATE INDEX IF NOT EXISTS idx_asset_files_company ON asset_files(company_id);

    /* §3.5 — the event log is the truth. */
    CREATE TABLE IF NOT EXISTS asset_events (
      id                     TEXT PRIMARY KEY,
      company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      asset_id               TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
      batch_id               TEXT,
      event_date             TEXT NOT NULL,
      effective_period       TEXT,
      kind                   TEXT NOT NULL,
      from_branch_id         TEXT REFERENCES branches(id) ON DELETE RESTRICT,
      to_branch_id           TEXT REFERENCES branches(id) ON DELETE RESTRICT,
      from_employee_id       TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      to_employee_id         TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      from_status            TEXT,
      to_status              TEXT,
      amount_minor           INTEGER,
      currency               TEXT,
      fx_khr_per_usd         REAL,
      amount_usd_minor       INTEGER,
      proceeds_minor         INTEGER,
      buyer                  TEXT,
      qty                    INTEGER,
      new_life_months        INTEGER,
      new_salvage_minor      INTEGER,
      extends_life_months    INTEGER,
      vendor                 TEXT,
      supplier_id            TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
      reason                 TEXT,
      detail_json            TEXT,
      document_file_ids      TEXT,
      stocktake_result_id    TEXT,
      journal_entry_id       TEXT REFERENCES journal_entries(id) ON DELETE RESTRICT,
      reverses_event_id      TEXT REFERENCES asset_events(id) ON DELETE RESTRICT,
      reversed_by_event_id   TEXT REFERENCES asset_events(id) ON DELETE RESTRICT,
      recorded_by_user_id    TEXT,
      created_at             INTEGER NOT NULL,
      voided_at              INTEGER,
      void_reason            TEXT,
      voided_by_user_id      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asset_events_asset ON asset_events(asset_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_asset_events_company ON asset_events(company_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_asset_events_batch ON asset_events(batch_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_entry ON asset_events(journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_from_branch ON asset_events(from_branch_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_to_branch ON asset_events(to_branch_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_from_emp ON asset_events(from_employee_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_to_emp ON asset_events(to_employee_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_supplier ON asset_events(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_reverses ON asset_events(reverses_event_id);
    CREATE INDEX IF NOT EXISTS idx_asset_events_reversed_by ON asset_events(reversed_by_event_id);

    /* §6.2 — pre-printed blank tags (A3 fills these; the table reserves sequences). */
    CREATE TABLE IF NOT EXISTS asset_tag_batches (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      prefix              TEXT NOT NULL,
      first_seq           INTEGER NOT NULL,
      last_seq            INTEGER NOT NULL,
      printed_at          INTEGER,
      label_run_id        TEXT,
      note                TEXT,
      created_by_user_id  TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asset_tag_batches_company ON asset_tag_batches(company_id);

    /* §11 "Tag damaged or replaced": the old code stays here and is never reused. */
    CREATE TABLE IF NOT EXISTS asset_tag_aliases (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      tag_code            TEXT NOT NULL COLLATE NOCASE,
      tag_seq             INTEGER,
      asset_id            TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
      reason              TEXT,
      retired_by_user_id  TEXT,
      retired_at          INTEGER NOT NULL,
      UNIQUE (company_id, tag_code)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_tag_aliases_asset ON asset_tag_aliases(asset_id);
  `);

  ensureLedgerSchema(db);

  // §3.1 additive branch columns. HR1 may add employees.branch_id too — the
  // same name and type, so whichever runs second is a no-op.
  addColumnIfMissing(db, 'employees', 'branch_id', 'TEXT REFERENCES branches(id)');
  addColumnIfMissing(db, 'fuel_stock_locations', 'branch_id', 'TEXT REFERENCES branches(id)');
  addColumnIfMissing(db, 'fuel_assets', 'branch_id', 'TEXT REFERENCES branches(id)');
  addColumnIfMissing(db, 'users', 'default_branch_id', 'TEXT REFERENCES branches(id)');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees(branch_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_locations_branch ON fuel_stock_locations(branch_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_assets_branch ON fuel_assets(branch_id);
    CREATE INDEX IF NOT EXISTS idx_users_default_branch ON users(default_branch_id);
  `);
}

module.exports = { ensureAssetSchema };
