/**
 * HR1 — staff profiles, attendance, leave, kiosk — schema
 * (docs/PEOPLE_AND_FUEL_PLAN.md §3.1, §3.2, §7b).
 *
 * Additive only (AGENTS.md §14): CREATE TABLE IF NOT EXISTS /
 * addColumnIfMissing, run on every boot from initDb right after the fuel
 * schema. SCHEMA_VERSION is NOT bumped — a bump runs wipeStructuralTables()
 * and erases the catalogue.
 *
 * Same conventions and deletion rules as F1 (main/db/fuelSchema.js):
 *   - HISTORY rows (attendance events, corrections, overtime approvals,
 *     lateness confirmations, leave ledger and requests, documents) reference
 *     the company and the employee with ON DELETE RESTRICT; nothing deletes
 *     them — mistakes are voided with a reason, superseded or reversed.
 *     `companies:remove` refuses while they exist (main/db/fuelHistory.js).
 *   - CONFIGURATION rows (positions, schedules, holidays, leave types, HR
 *     settings) cascade with the company; references between configuration
 *     and history use the default NO ACTION, checked at the end of the
 *     statement.
 *   - Files (clock-in photos, documents) live under <dataDir>/hr/, never
 *     under assets/, and are read only through permission-checked channels.
 */

const { addColumnIfMissing } = require('./index');

function ensureHrSchema(db) {
  // §3.1 — the rest of the staff record. F1 created the thin table.
  const employeeCols = [
    ['gender', 'TEXT'],
    ['dob', 'TEXT'],
    ['address', 'TEXT'],
    ['national_id_no', 'TEXT'],
    ['nssf_no', 'TEXT'],
    ['bank_name', 'TEXT'],
    ['bank_account_name', 'TEXT'],
    ['bank_account_no', 'TEXT'],
    ['position_id', 'TEXT'],
    ['hire_date', 'TEXT'],
    ['end_date', 'TEXT'],
    ['employment_type', 'TEXT'],
    ['supervisor_employee_id', 'TEXT'],
    ['status_reason', 'TEXT'],
    ['kiosk_pin_hash', 'TEXT'],
    ['pin_salt', 'TEXT'],
    ['pin_failed_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['pin_locked_until', 'INTEGER'],
    ['pin_set_at', 'INTEGER'],
  ];
  for (const [col, type] of employeeCols) addColumnIfMissing(db, 'employees', col, type);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_employees_supervisor ON employees(supervisor_employee_id);
    CREATE INDEX IF NOT EXISTS idx_employees_position ON employees(position_id);
  `);

  // Planned as an account → staff mirror. NOT written or read (review fix L4):
  // the link is employees.user_id, which is per company, while one account can
  // be staff in two companies. The column stays (additive; harmless).
  addColumnIfMissing(db, 'users', 'employee_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_employee ON users(employee_id)');

  // §6: History hides HR / payroll entries from callers without the matching
  // capability, and audit:clearHistory never removes them.
  addColumnIfMissing(db, 'audit_log', 'sensitivity', "TEXT NOT NULL DEFAULT 'normal'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_sensitivity ON audit_log(sensitivity, created_at DESC)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id           TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name_en      TEXT,
      name_km      TEXT,
      department   TEXT,
      sort         INTEGER NOT NULL DEFAULT 0,
      archived_at  INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_positions_company ON positions(company_id);

    CREATE TABLE IF NOT EXISTS employee_documents (
      id                   TEXT PRIMARY KEY,
      company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id          TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      kind                 TEXT NOT NULL,
      title                TEXT,
      file_path            TEXT NOT NULL,
      mime                 TEXT NOT NULL,
      sha256               TEXT NOT NULL,
      original_sha256      TEXT,
      bytes                INTEGER,
      uploaded_by_user_id  TEXT,
      uploaded_at          INTEGER NOT NULL,
      voided_at            INTEGER,
      void_reason          TEXT,
      voided_by_user_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id, uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_employee_documents_company ON employee_documents(company_id);

    CREATE TABLE IF NOT EXISTS work_schedules (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name                TEXT NOT NULL COLLATE NOCASE,
      start_time          TEXT NOT NULL,
      end_time            TEXT NOT NULL,
      break_min           INTEGER NOT NULL DEFAULT 0,
      work_days           TEXT NOT NULL DEFAULT '1111110',
      grace_min           INTEGER NOT NULL DEFAULT 0,
      night_start         TEXT NOT NULL DEFAULT '22:00',
      night_end           TEXT NOT NULL DEFAULT '05:00',
      archived_at         INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT,
      UNIQUE (company_id, name)
    );

    CREATE TABLE IF NOT EXISTS employee_schedules (
      id               TEXT PRIMARY KEY,
      company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      schedule_id      TEXT NOT NULL REFERENCES work_schedules(id),
      effective_from   TEXT NOT NULL,
      set_by_user_id   TEXT,
      created_at       INTEGER NOT NULL,
      UNIQUE (employee_id, effective_from)
    );
    CREATE INDEX IF NOT EXISTS idx_employee_schedules_schedule ON employee_schedules(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_employee_schedules_company ON employee_schedules(company_id);

    CREATE TABLE IF NOT EXISTS holidays (
      id           TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      date         TEXT NOT NULL,
      name_en      TEXT,
      name_km      TEXT,
      paid         INTEGER NOT NULL DEFAULT 1,
      source_note  TEXT,
      archived_at  INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_company_date ON holidays(company_id, date) WHERE archived_at IS NULL;

    /* One row per tap. Never edited: a correction adds a row whose
       supersedes_event_id names the one it replaces; a rejected phone or
       supervisor event is voided with the reason. */
    CREATE TABLE IF NOT EXISTS attendance_events (
      id                     TEXT PRIMARY KEY,
      company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id            TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      kind                   TEXT NOT NULL,
      at                     INTEGER NOT NULL,
      work_date              TEXT NOT NULL,
      source                 TEXT NOT NULL,
      recorded_by_user_id    TEXT,
      device_label           TEXT,
      photo_path             TEXT,
      photo_sha256           TEXT,
      photo_retired_at       INTEGER,
      photo_recycle_item_id  TEXT,
      supersedes_event_id    TEXT REFERENCES attendance_events(id) ON DELETE RESTRICT,
      correction_id          TEXT,
      note                   TEXT,
      queued_for_ms          INTEGER,
      client_ref             TEXT UNIQUE,
      client_ref_hash        TEXT,
      review_status          TEXT NOT NULL DEFAULT 'none',
      reviewed_by_user_id    TEXT,
      reviewed_at            INTEGER,
      review_note            TEXT,
      voided_at              INTEGER,
      void_reason            TEXT,
      voided_by_user_id      TEXT,
      created_at             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_events(employee_id, at);
    CREATE INDEX IF NOT EXISTS idx_attendance_company_date ON attendance_events(company_id, work_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_review ON attendance_events(company_id, review_status);
    CREATE INDEX IF NOT EXISTS idx_attendance_supersedes ON attendance_events(supersedes_event_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_photo ON attendance_events(company_id, at) WHERE photo_path IS NOT NULL AND photo_retired_at IS NULL;

    CREATE TABLE IF NOT EXISTS attendance_corrections (
      id                      TEXT PRIMARY KEY,
      company_id              TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id             TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      work_date               TEXT NOT NULL,
      proposed_in_at          INTEGER,
      proposed_out_at         INTEGER,
      reason                  TEXT NOT NULL,
      requested_by_user_id    TEXT,
      requested_via           TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'pending',
      decided_by_user_id      TEXT,
      decided_at              INTEGER,
      decision_note           TEXT,
      resulting_in_event_id   TEXT REFERENCES attendance_events(id),
      resulting_out_event_id  TEXT REFERENCES attendance_events(id),
      created_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_corrections_company ON attendance_corrections(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_attendance_corrections_employee ON attendance_corrections(employee_id, work_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_corrections_in ON attendance_corrections(resulting_in_event_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_corrections_out ON attendance_corrections(resulting_out_event_id);

    /* Payroll (HR2) pays ONLY approved overtime minutes. One active row per
       person per work date; re-approving voids the previous row. */
    CREATE TABLE IF NOT EXISTS overtime_approvals (
      id                   TEXT PRIMARY KEY,
      company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id          TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      work_date            TEXT NOT NULL,
      normal_min           INTEGER NOT NULL DEFAULT 0,
      night_min            INTEGER NOT NULL DEFAULT 0,
      rest_day_min         INTEGER NOT NULL DEFAULT 0,
      holiday_min          INTEGER NOT NULL DEFAULT 0,
      note                 TEXT,
      approved_by_user_id  TEXT,
      approved_at          INTEGER NOT NULL,
      voided_at            INTEGER,
      void_reason          TEXT,
      voided_by_user_id    TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_active ON overtime_approvals(employee_id, work_date) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_overtime_company ON overtime_approvals(company_id, work_date);

    /* Payroll (HR2) deducts lateness only for a confirmed month. */
    CREATE TABLE IF NOT EXISTS lateness_confirmations (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id           TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      month                 TEXT NOT NULL,
      computed_late_min     INTEGER NOT NULL,
      confirmed_late_min    INTEGER NOT NULL,
      computed_early_min    INTEGER NOT NULL,
      confirmed_early_min   INTEGER NOT NULL,
      note                  TEXT,
      confirmed_by_user_id  TEXT,
      confirmed_at          INTEGER NOT NULL,
      voided_at             INTEGER,
      void_reason           TEXT,
      voided_by_user_id     TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lateness_active ON lateness_confirmations(employee_id, month) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_lateness_company ON lateness_confirmations(company_id, month);

    CREATE TABLE IF NOT EXISTS leave_types (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code                  TEXT NOT NULL COLLATE NOCASE,
      name_en               TEXT,
      name_km               TEXT,
      paid                  INTEGER NOT NULL DEFAULT 1,
      accrual               TEXT NOT NULL DEFAULT 'none',
      accrual_days          REAL NOT NULL DEFAULT 0,
      tracks_balance        INTEGER NOT NULL DEFAULT 0,
      max_balance           REAL,
      carry_over_max        REAL,
      max_days_per_request  REAL,
      count_calendar_days   INTEGER NOT NULL DEFAULT 0,
      needs_document        INTEGER NOT NULL DEFAULT 0,
      note                  TEXT,
      sort                  INTEGER NOT NULL DEFAULT 0,
      archived_at           INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      UNIQUE (company_id, code)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id           TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      leave_type_id         TEXT NOT NULL REFERENCES leave_types(id),
      from_date             TEXT NOT NULL,
      to_date               TEXT NOT NULL,
      half_day              TEXT,
      days                  REAL NOT NULL,
      reason                TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      requested_by_user_id  TEXT,
      requested_via         TEXT NOT NULL,
      decided_by_user_id    TEXT,
      decided_at            INTEGER,
      decision_note         TEXT,
      cancelled_at          INTEGER,
      cancel_reason         TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leave_requests_company ON leave_requests(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id, from_date);
    CREATE INDEX IF NOT EXISTS idx_leave_requests_type ON leave_requests(leave_type_id);

    /* balance = Σ days. accrual / expiry rows carry a period ('YYYY-MM' or
       'YYYY') and are unique per employee + type + period, so the monthly and
       year-end jobs can run any number of times. */
    CREATE TABLE IF NOT EXISTS leave_ledger (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      leave_type_id       TEXT NOT NULL REFERENCES leave_types(id),
      date                TEXT NOT NULL,
      kind                TEXT NOT NULL,
      days                REAL NOT NULL,
      period              TEXT,
      request_id          TEXT REFERENCES leave_requests(id),
      note                TEXT,
      created_by_user_id  TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_ledger_period ON leave_ledger(employee_id, leave_type_id, kind, period)
      WHERE period IS NOT NULL AND kind IN ('accrual', 'expiry');
    CREATE INDEX IF NOT EXISTS idx_leave_ledger_employee ON leave_ledger(employee_id, leave_type_id, date);
    CREATE INDEX IF NOT EXISTS idx_leave_ledger_company ON leave_ledger(company_id);
    CREATE INDEX IF NOT EXISTS idx_leave_ledger_type ON leave_ledger(leave_type_id);
    CREATE INDEX IF NOT EXISTS idx_leave_ledger_request ON leave_ledger(request_id);

    CREATE TABLE IF NOT EXISTS hr_settings (
      company_id          TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings_json       TEXT NOT NULL DEFAULT '{}',
      prefilled_at        INTEGER,
      accrual_from_month  TEXT,
      updated_at          INTEGER NOT NULL,
      updated_by_user_id  TEXT
    );
  `);

  /* Review fixes (2026-10-08), additive on top of the first HR1 tables. */
  // Escalating PIN locks: the day's lock count; the third lock is manager-only.
  addColumnIfMissing(db, 'employees', 'pin_lock_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'employees', 'pin_lock_day', 'TEXT');
  addColumnIfMissing(db, 'employees', 'pin_manager_only', 'INTEGER NOT NULL DEFAULT 0');
  // An approval / confirmation given before the attendance under it changed.
  for (const t of ['overtime_approvals', 'lateness_confirmations']) {
    addColumnIfMissing(db, t, 'needs_reapproval', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, t, 'needs_reapproval_reason', 'TEXT');
    addColumnIfMissing(db, t, 'needs_reapproval_at', 'INTEGER');
  }
  // No absence before the company started keeping attendance in the app.
  addColumnIfMissing(db, 'hr_settings', 'attendance_start_date', 'TEXT');
  // Phone requests ("I forgot", leave) go through the phone's offline outbox:
  // a client_ref + a hash of the content make a resend return the saved request.
  for (const t of ['attendance_corrections', 'leave_requests']) {
    addColumnIfMissing(db, t, 'client_ref', 'TEXT');
    addColumnIfMissing(db, t, 'client_ref_hash', 'TEXT');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_client_ref ON ${t}(client_ref) WHERE client_ref IS NOT NULL`);
  }
  db.exec(`
    /* Dated suspensions: a suspended day is "suspended", never "absent". */
    CREATE TABLE IF NOT EXISTS employee_suspensions (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      from_date           TEXT NOT NULL,
      to_date             TEXT,
      reason              TEXT NOT NULL,
      created_by_user_id  TEXT,
      created_at          INTEGER NOT NULL,
      ended_by_user_id    TEXT,
      ended_at            INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_employee_suspensions_employee ON employee_suspensions(employee_id, from_date);
    CREATE INDEX IF NOT EXISTS idx_employee_suspensions_company ON employee_suspensions(company_id);

    /* Things a manager should look at that are not clock events: a PIN that
       locked, a kiosk that paused after many wrong PINs, an approval whose
       attendance changed. Shown with the review list. */
    CREATE TABLE IF NOT EXISTS attendance_alerts (
      id                TEXT PRIMARY KEY,
      company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      employee_id       TEXT REFERENCES employees(id) ON DELETE RESTRICT,
      kind              TEXT NOT NULL,
      at                INTEGER NOT NULL,
      kiosk_user_id     TEXT,
      message           TEXT NOT NULL,
      details_json      TEXT,
      status            TEXT NOT NULL DEFAULT 'open',
      seen_by_user_id   TEXT,
      seen_at           INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_alerts_company ON attendance_alerts(company_id, status, at);
    CREATE INDEX IF NOT EXISTS idx_attendance_alerts_employee ON attendance_alerts(employee_id);
  `);
}

module.exports = { ensureHrSchema };
