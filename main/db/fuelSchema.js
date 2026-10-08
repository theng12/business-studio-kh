/**
 * Fuel F1 + the thin staff list — schema (docs/PEOPLE_AND_FUEL_PLAN.md §3.1, §3.6).
 *
 * Additive only (AGENTS.md §14): CREATE TABLE IF NOT EXISTS / addColumnIfMissing,
 * run on every boot from initDb. SCHEMA_VERSION is NOT bumped — a bump runs
 * wipeStructuralTables() and erases the catalogue.
 *
 * Conventions: UUID text ids, epoch-ms timestamps, `work_date` 'YYYY-MM-DD' in
 * Asia/Phnom_Penh, every row carries company_id, money as whole numbers in the
 * smallest unit (`*_minor`, riel or US cents) plus a currency code.
 *
 * Deletion rules — "history is never deleted" (§3):
 *   - HISTORY rows (staff, fills, dips, deliveries, transfers, meter resets)
 *     reference the company, the staff and the assets with ON DELETE RESTRICT,
 *     so SQLite itself refuses to delete a company / asset / employee that has
 *     history. `companies:remove` checks first and says so in words
 *     (main/db/fuelHistory.js).
 *   - CONFIGURATION rows (asset types, assets, tanks, dip charts, stations,
 *     prices, settings) and derived rows (flags, photo index) cascade with the
 *     company, so a company that never recorded anything can still be removed.
 *     Config-to-config references use the default NO ACTION (checked at the end
 *     of the statement), so the order SQLite cascades them in cannot matter.
 *   - Mistakes are fixed by void (with a reason) or a correcting revision,
 *     never DELETE. Nothing in this feature deletes a row.
 */

const { addColumnIfMissing } = require('./index');

function ensureFuelSchema(db) {
  db.exec(`
    /* §3.1, thin: only what F1 needs. HR1 adds the rest with addColumnIfMissing. */
    CREATE TABLE IF NOT EXISTS employees (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      staff_code          TEXT NOT NULL COLLATE NOCASE,
      name_en             TEXT,
      name_km             TEXT,
      phone               TEXT,
      photo_path          TEXT,
      photo_sha256        TEXT,
      position            TEXT,
      is_driver           INTEGER NOT NULL DEFAULT 0,
      is_fuel_attendant   INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'active',
      left_on             TEXT,
      left_reason         TEXT,
      user_id             TEXT,
      notes               TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT,
      UNIQUE (company_id, staff_code)
    );
    CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_employees_user ON employees(user_id);

    CREATE TABLE IF NOT EXISTS fuel_asset_types (
      id            TEXT PRIMARY KEY,
      company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      builtin_key   TEXT,
      name          TEXT NOT NULL,
      name_km       TEXT,
      meter_unit    TEXT NOT NULL DEFAULT 'km',
      default_fuel  TEXT NOT NULL DEFAULT 'diesel',
      max_per_day   REAL,
      sort          INTEGER NOT NULL DEFAULT 0,
      archived_at   INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE (company_id, builtin_key)
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_asset_types_company ON fuel_asset_types(company_id);

    CREATE TABLE IF NOT EXISTS fuel_assets (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      type_id               TEXT NOT NULL REFERENCES fuel_asset_types(id),
      name                  TEXT NOT NULL,
      plate_or_serial       TEXT,
      photo_id              TEXT,
      fuel_type             TEXT NOT NULL DEFAULT 'diesel',
      meter_unit            TEXT NOT NULL DEFAULT 'km',
      tank_capacity_l       REAL,
      baseline_rate         REAL,
      baseline_source       TEXT NOT NULL DEFAULT 'manual',
      assigned_employee_id  TEXT REFERENCES employees(id),
      home_location         TEXT,
      status                TEXT NOT NULL DEFAULT 'active',
      notes                 TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      updated_by_user_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_assets_company ON fuel_assets(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_fuel_assets_type ON fuel_assets(type_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_assets_employee ON fuel_assets(assigned_employee_id);

    CREATE TABLE IF NOT EXISTS fuel_stock_locations (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name                TEXT NOT NULL COLLATE NOCASE,
      kind                TEXT NOT NULL DEFAULT 'tank',
      fuel_type           TEXT NOT NULL DEFAULT 'diesel',
      capacity_l          REAL,
      has_flow_meter      INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'active',
      notes               TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT,
      UNIQUE (company_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_locations_company ON fuel_stock_locations(company_id, status);

    CREATE TABLE IF NOT EXISTS fuel_tank_calibration (
      id           TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      location_id  TEXT NOT NULL REFERENCES fuel_stock_locations(id) ON DELETE CASCADE,
      dip_cm       REAL NOT NULL,
      litres       REAL NOT NULL,
      UNIQUE (location_id, dip_cm)
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_calibration_company ON fuel_tank_calibration(company_id);

    CREATE TABLE IF NOT EXISTS fuel_stations (
      id           TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name         TEXT NOT NULL COLLATE NOCASE,
      area         TEXT,
      archived_at  INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE (company_id, name)
    );

    CREATE TABLE IF NOT EXISTS fuel_prices (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      fuel_type           TEXT NOT NULL,
      price_minor_per_l   INTEGER NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'KHR',
      effective_from      TEXT NOT NULL,
      effective_to        TEXT,
      source_note         TEXT,
      photo_id            TEXT,
      created_by_user_id  TEXT,
      created_at          INTEGER NOT NULL,
      voided_at           INTEGER,
      void_reason         TEXT,
      voided_by_user_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_prices_lookup ON fuel_prices(company_id, fuel_type, effective_from);

    CREATE TABLE IF NOT EXISTS fuel_meter_resets (
      id                   TEXT PRIMARY KEY,
      company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      asset_id             TEXT REFERENCES fuel_assets(id) ON DELETE RESTRICT,
      location_id          TEXT REFERENCES fuel_stock_locations(id) ON DELETE RESTRICT,
      at                   INTEGER NOT NULL,
      old_reading          REAL NOT NULL,
      new_reading          REAL NOT NULL,
      reason               TEXT NOT NULL,
      recorded_by_user_id  TEXT,
      created_at           INTEGER NOT NULL,
      voided_at            INTEGER,
      void_reason          TEXT,
      voided_by_user_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_resets_asset ON fuel_meter_resets(asset_id, at);
    CREATE INDEX IF NOT EXISTS idx_fuel_resets_location ON fuel_meter_resets(location_id, at);
    CREATE INDEX IF NOT EXISTS idx_fuel_resets_company ON fuel_meter_resets(company_id);

    CREATE TABLE IF NOT EXISTS fuel_dips (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      location_id           TEXT NOT NULL REFERENCES fuel_stock_locations(id) ON DELETE RESTRICT,
      taken_at              INTEGER NOT NULL,
      work_date             TEXT NOT NULL,
      dip_cm                REAL,
      litres                REAL NOT NULL,
      litres_source         TEXT NOT NULL DEFAULT 'chart',
      out_of_chart          INTEGER NOT NULL DEFAULT 0,
      taken_by_employee_id  TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      witness_employee_id   TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      recorded_by_user_id   TEXT,
      source                TEXT NOT NULL DEFAULT 'mac',
      client_ref            TEXT UNIQUE,
      note                  TEXT,
      created_at            INTEGER NOT NULL,
      voided_at             INTEGER,
      void_reason           TEXT,
      voided_by_user_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_dips_location ON fuel_dips(location_id, taken_at);
    CREATE INDEX IF NOT EXISTS idx_fuel_dips_company ON fuel_dips(company_id, taken_at);
    CREATE INDEX IF NOT EXISTS idx_fuel_dips_taken_by ON fuel_dips(taken_by_employee_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_dips_witness ON fuel_dips(witness_employee_id);

    CREATE TABLE IF NOT EXISTS fuel_deliveries (
      id                       TEXT PRIMARY KEY,
      company_id               TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      location_id              TEXT NOT NULL REFERENCES fuel_stock_locations(id) ON DELETE RESTRICT,
      supplier                 TEXT,
      invoice_no               TEXT,
      delivered_at             INTEGER NOT NULL,
      work_date                TEXT NOT NULL,
      litres_invoiced          REAL NOT NULL,
      price_minor_per_l        INTEGER,
      amount_minor             INTEGER,
      currency                 TEXT NOT NULL DEFAULT 'KHR',
      dip_before_id            TEXT REFERENCES fuel_dips(id) ON DELETE RESTRICT,
      dip_after_id             TEXT REFERENCES fuel_dips(id) ON DELETE RESTRICT,
      received_by_employee_id  TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      recorded_by_user_id      TEXT,
      source                   TEXT NOT NULL DEFAULT 'mac',
      client_ref               TEXT UNIQUE,
      note                     TEXT,
      created_at               INTEGER NOT NULL,
      voided_at                INTEGER,
      void_reason              TEXT,
      voided_by_user_id        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_location ON fuel_deliveries(location_id, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_company ON fuel_deliveries(company_id, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_dips ON fuel_deliveries(dip_before_id, dip_after_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_dip_after ON fuel_deliveries(dip_after_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_employee ON fuel_deliveries(received_by_employee_id);

    CREATE TABLE IF NOT EXISTS fuel_transfers (
      id                            TEXT PRIMARY KEY,
      company_id                    TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      from_location_id              TEXT NOT NULL REFERENCES fuel_stock_locations(id) ON DELETE RESTRICT,
      to_location_id                TEXT REFERENCES fuel_stock_locations(id) ON DELETE RESTRICT,
      litres_sent                   REAL NOT NULL,
      containers                    INTEGER,
      container_note                TEXT,
      pump_meter_before             REAL,
      pump_meter_after              REAL,
      typed_litres                  REAL,
      sent_at                       INTEGER NOT NULL,
      work_date                     TEXT NOT NULL,
      sent_by_employee_id           TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      litres_received               REAL,
      received_at                   INTEGER,
      received_by_employee_id       TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      received_note                 TEXT,
      recorded_by_user_id           TEXT,
      received_recorded_by_user_id  TEXT,
      source                        TEXT NOT NULL DEFAULT 'mac',
      client_ref                    TEXT UNIQUE,
      note                          TEXT,
      created_at                    INTEGER NOT NULL,
      voided_at                     INTEGER,
      void_reason                   TEXT,
      voided_by_user_id             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_transfers_from ON fuel_transfers(from_location_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_fuel_transfers_to ON fuel_transfers(to_location_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_fuel_transfers_company ON fuel_transfers(company_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_fuel_transfers_sent_by ON fuel_transfers(sent_by_employee_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_transfers_received_by ON fuel_transfers(received_by_employee_id);

    /* One table for every fill (§3.6). A correction is a NEW row with
       supersedes_id → the row it replaces (which gets superseded_at); all
       revisions share root_id, and photos hang off root_id so they follow the
       record through corrections. */
    CREATE TABLE IF NOT EXISTS fuel_fills (
      id                     TEXT PRIMARY KEY,
      company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      root_id                TEXT NOT NULL,
      supersedes_id          TEXT REFERENCES fuel_fills(id) ON DELETE RESTRICT,
      superseded_at          INTEGER,
      superseded_by_id       TEXT,
      correction_reason      TEXT,
      kind                   TEXT NOT NULL,
      location_id            TEXT REFERENCES fuel_stock_locations(id) ON DELETE RESTRICT,
      station_id             TEXT REFERENCES fuel_stations(id),
      asset_id               TEXT NOT NULL REFERENCES fuel_assets(id) ON DELETE RESTRICT,
      driver_employee_id     TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      attendant_employee_id  TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      at                     INTEGER NOT NULL,
      work_date              TEXT NOT NULL,
      litres                 REAL NOT NULL,
      litres_source          TEXT NOT NULL DEFAULT 'typed',
      typed_litres           REAL,
      cans_count             INTEGER,
      can_size_l             REAL,
      pump_meter_before      REAL,
      pump_meter_after       REAL,
      meter_reading          REAL,
      full_tank              INTEGER NOT NULL DEFAULT 0,
      fuel_type              TEXT,
      amount_paid_minor      INTEGER,
      currency               TEXT,
      litres_shown_on_pump   REAL,
      source                 TEXT NOT NULL DEFAULT 'mac',
      client_ref             TEXT UNIQUE,
      recorded_by_user_id    TEXT,
      recorded_at            INTEGER NOT NULL,
      review_status          TEXT NOT NULL DEFAULT 'new',
      reviewed_by_user_id    TEXT,
      reviewed_at            INTEGER,
      review_note            TEXT,
      reviewed_amount_minor  INTEGER,
      reviewed_litres        REAL,
      note                   TEXT,
      voided_at              INTEGER,
      void_reason            TEXT,
      voided_by_user_id      TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_company ON fuel_fills(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_asset ON fuel_fills(asset_id, at);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_location ON fuel_fills(location_id, at);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_station ON fuel_fills(station_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_driver ON fuel_fills(driver_employee_id, at);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_attendant ON fuel_fills(attendant_employee_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_root ON fuel_fills(root_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_supersedes ON fuel_fills(supersedes_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_review ON fuel_fills(company_id, review_status);
    CREATE INDEX IF NOT EXISTS idx_fuel_fills_recorder ON fuel_fills(recorded_by_user_id, recorded_at);

    /* Photo index. Files live under <dataDir>/fuel/<yyyy-mm>/ — NOT under
       assets/, so neither /assets/ nor app-image:// can serve them; they are
       read only through fuel:getPhoto. owner_id is the fill's root_id, or the
       dip / delivery / transfer / asset / price id. */
    CREATE TABLE IF NOT EXISTS fuel_photos (
      id                   TEXT PRIMARY KEY,
      company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      owner_kind           TEXT NOT NULL,
      owner_id             TEXT NOT NULL,
      kind                 TEXT NOT NULL,
      rel_path             TEXT NOT NULL,
      sha256               TEXT NOT NULL,
      original_sha256      TEXT,
      bytes                INTEGER,
      width                INTEGER,
      height               INTEGER,
      uploaded_at          INTEGER NOT NULL,
      uploaded_by_user_id  TEXT,
      retired_at           INTEGER,
      retired_reason       TEXT,
      recycle_item_id      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_photos_owner ON fuel_photos(owner_kind, owner_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_photos_company ON fuel_photos(company_id, uploaded_at);

    CREATE TABLE IF NOT EXISTS fuel_flags (
      id                   TEXT PRIMARY KEY,
      company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      rule_key             TEXT NOT NULL,
      subject              TEXT NOT NULL,
      subject_kind         TEXT,
      subject_id           TEXT,
      scope_key            TEXT NOT NULL,
      asset_id             TEXT,
      location_id          TEXT,
      employee_id          TEXT,
      station_id           TEXT,
      severity             TEXT NOT NULL,
      period               TEXT,
      at                   INTEGER,
      measured             REAL,
      expected             REAL,
      threshold            REAL,
      unit                 TEXT,
      explanation          TEXT NOT NULL,
      details_json         TEXT,
      status               TEXT NOT NULL DEFAULT 'open',
      reviewed_by_user_id  TEXT,
      reviewed_at          INTEGER,
      review_note          TEXT,
      first_seen_at        INTEGER NOT NULL,
      last_seen_at         INTEGER NOT NULL,
      resolved_at          INTEGER,
      UNIQUE (rule_key, subject)
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_flags_company ON fuel_flags(company_id, status, severity);
    CREATE INDEX IF NOT EXISTS idx_fuel_flags_scope ON fuel_flags(scope_key);
    CREATE INDEX IF NOT EXISTS idx_fuel_flags_period ON fuel_flags(company_id, period);
    CREATE INDEX IF NOT EXISTS idx_fuel_flags_asset ON fuel_flags(asset_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_flags_location ON fuel_flags(location_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_flags_employee ON fuel_flags(employee_id);

    CREATE TABLE IF NOT EXISTS fuel_settings (
      company_id          TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings_json       TEXT NOT NULL DEFAULT '{}',
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
  `);

  // Room for later additive columns lives here (addColumnIfMissing), e.g. HR1's
  // employee fields. Kept as a call so the pattern is obvious to the next stage.
  addColumnIfMissing(db, 'employees', 'notes', 'TEXT');
}

module.exports = { ensureFuelSchema };
