/**
 * Fuel F1: the thin staff list — the seed of HR (docs/PEOPLE_AND_FUEL_PLAN.md §3.1).
 *
 * Only what fuel needs now: code, names (English + Khmer), phone, photo,
 * position, driver / pump-attendant flags, status, optional app account.
 * HR1 extends the same table additively (main/db/hrSchema.js): the profile
 * fields below (`updateHrProfile`), status `suspended`, the supervisor link,
 * and the kiosk PIN (main/db/hrPeople.js).
 *
 * No delete. Someone who leaves is marked `left` (with the date and reason)
 * and keeps every fill, dip and delivery that names them — fuel history
 * references employees with ON DELETE RESTRICT.
 */

const { getDb } = require('./index');
const { prepareOptimisticPatch, nextUpdatedAt } = require('./_util');
const { uuid, audit, str, badRequest, getCallerUserId, isCalendarDate } = require('./_fuelUtil');

const STATUSES = ['active', 'suspended', 'left'];
const GENDERS = ['female', 'male', 'other'];
const EMPLOYMENT_TYPES = ['monthly', 'daily', 'hourly', 'contract'];

/**
 * HR1: fields only `hr.manage` sees (docs/PEOPLE_AND_FUEL_PLAN.md §6) — ID
 * and NSSF numbers, bank details, date of birth and home address. `hr.view`
 * and `fuel.manage` get the directory without them (main/ipc/hrAccess.js).
 */
const SENSITIVE_FIELDS = ['dob', 'address', 'nationalIdNo', 'nssfNo', 'bankName', 'bankAccountName', 'bankAccountNo'];

/**
 * What goes into History for a staff change: never the phone number, the
 * notes or a sensitive HR field themselves (personal data; History is
 * readable more widely than the staff list) — only that they were set or
 * changed.
 */
const PRIVATE_FIELDS = ['phone', 'notes', ...SENSITIVE_FIELDS];
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of PRIVATE_FIELDS) if (k in out) out[k] = out[k] == null ? null : '(set)';
  return out;
}

function rowToEmployee(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    staffCode: row.staff_code,
    nameEn: row.name_en ?? null,
    nameKm: row.name_km ?? null,
    phone: row.phone ?? null,
    hasPhoto: !!row.photo_path,
    photoSha256: row.photo_sha256 ?? null,
    position: row.position ?? null,
    isDriver: !!row.is_driver,
    isFuelAttendant: !!row.is_fuel_attendant,
    status: row.status,
    leftOn: row.left_on ?? null,
    leftReason: row.left_reason ?? null,
    userId: row.user_id ?? null,
    notes: row.notes ?? null,
    // HR1 profile
    gender: row.gender ?? null,
    dob: row.dob ?? null,
    address: row.address ?? null,
    nationalIdNo: row.national_id_no ?? null,
    nssfNo: row.nssf_no ?? null,
    bankName: row.bank_name ?? null,
    bankAccountName: row.bank_account_name ?? null,
    bankAccountNo: row.bank_account_no ?? null,
    positionId: row.position_id ?? null,
    hireDate: row.hire_date ?? null,
    endDate: row.end_date ?? null,
    employmentType: row.employment_type ?? null,
    supervisorEmployeeId: row.supervisor_employee_id ?? null,
    statusReason: row.status_reason ?? null,
    hasPin: !!row.kiosk_pin_hash,
    pinLockedUntil: row.pin_locked_until && row.pin_locked_until > Date.now() ? row.pin_locked_until : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

function list(companyId, { status = null, role = null, q = null, searchPhone = true } = {}) {
  if (!companyId) return [];
  const where = ['company_id = @companyId'];
  const params = { companyId };
  if (status && STATUSES.includes(status)) { where.push('status = @status'); params.status = status; }
  if (role === 'driver') where.push('is_driver = 1');
  if (role === 'attendant') where.push('is_fuel_attendant = 1');
  if (role === 'supervisor') where.push('id IN (SELECT supervisor_employee_id FROM employees WHERE supervisor_employee_id IS NOT NULL)');
  if (q && String(q).trim()) {
    // A recorder's tile search must not reveal phone numbers by matching them.
    where.push(`(staff_code LIKE @q OR name_en LIKE @q OR name_km LIKE @q${searchPhone ? ' OR phone LIKE @q' : ''})`);
    params.q = `%${String(q).trim()}%`;
  }
  return getDb()
    .prepare(`SELECT * FROM employees WHERE ${where.join(' AND ')} ORDER BY status = 'left', status = 'suspended', COALESCE(name_en, name_km, staff_code) COLLATE NOCASE`)
    .all(params)
    .map(rowToEmployee);
}

function get(id) {
  if (!id) return null;
  return rowToEmployee(getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id));
}

function getRow(id) {
  return getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id);
}

/** The staff record linked to an app account in a company (phone default driver/attendant). */
function getByUserId(companyId, userId) {
  if (!companyId || !userId) return null;
  return rowToEmployee(getDb().prepare(
    `SELECT * FROM employees WHERE company_id = ? AND user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1`,
  ).get(companyId, userId));
}

/**
 * An app account may be linked to one staff record per company (HR1: the
 * phone's "clock me in" and the kiosk manager check both resolve the person
 * from the account, so two records for one account would be ambiguous).
 */
function checkUser(userId, companyId = null, employeeId = null) {
  if (userId == null) return null;
  const u = getDb().prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!u) throw badRequest('That app account does not exist');
  if (companyId) {
    const other = getDb().prepare(`SELECT staff_code, name_en, name_km FROM employees WHERE company_id = ? AND user_id = ? AND id <> ? AND status <> 'left'`)
      .get(companyId, userId, employeeId || '');
    if (other) throw badRequest(`That app account is already linked to ${other.name_en || other.name_km || other.staff_code}`);
  }
  return userId;
}

/*
 * users.employee_id (added by main/db/hrSchema.js) is deliberately NOT kept in step: the link is
 * employees.user_id, per company, and one account may be staff in two companies (review fix L4).
 */

function create(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const staffCode = str(input.staffCode, 40);
  if (!staffCode) throw badRequest('Staff code is required');
  const nameEn = str(input.nameEn, 120);
  const nameKm = str(input.nameKm, 120);
  if (!nameEn && !nameKm) throw badRequest('A name in English or Khmer is required');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM employees WHERE company_id = ? AND staff_code = ?').get(companyId, staffCode)) {
    throw badRequest(`Staff code ${staffCode} is already used in this company`);
  }
  const id = uuid();
  const now = Date.now();
  db.prepare(`
    INSERT INTO employees (id, company_id, staff_code, name_en, name_km, phone, position, is_driver, is_fuel_attendant,
      status, user_id, notes, created_at, updated_at, updated_by_user_id)
    VALUES (@id, @companyId, @staffCode, @nameEn, @nameKm, @phone, @position, @isDriver, @isFuelAttendant,
      'active', @userId, @notes, @now, @now, @by)
  `).run({
    id, companyId, staffCode, nameEn, nameKm,
    phone: str(input.phone, 40),
    position: str(input.position, 80),
    isDriver: input.isDriver ? 1 : 0,
    isFuelAttendant: input.isFuelAttendant ? 1 : 0,
    userId: checkUser(input.userId ?? null, companyId, id),
    notes: str(input.notes, 2000),
    now,
    by: getCallerUserId(),
  });
  const created = get(id);
  audit('employee', id, 'create', { after: redact(created) });
  return created;
}

const EDITABLE = {
  staffCode: ['staff_code', (v) => { const s = str(v, 40); if (!s) throw badRequest('Staff code cannot be empty'); return s; }],
  nameEn: ['name_en', (v) => str(v, 120)],
  nameKm: ['name_km', (v) => str(v, 120)],
  phone: ['phone', (v) => str(v, 40)],
  position: ['position', (v) => str(v, 80)],
  isDriver: ['is_driver', (v) => (v ? 1 : 0)],
  isFuelAttendant: ['is_fuel_attendant', (v) => (v ? 1 : 0)],
  userId: ['user_id', (v, e) => checkUser(v ?? null, e.companyId, e.id)],
  notes: ['notes', (v) => str(v, 2000)],
};

function update(id, rawPatch = {}) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  const patch = prepareOptimisticPatch({ ...existing, name: existing.nameEn || existing.nameKm }, rawPatch, 'employee');
  const sets = [];
  const params = { id };
  const changed = {};
  for (const [key, [col, conv]] of Object.entries(EDITABLE)) {
    if (!(key in patch)) continue;
    const value = conv(patch[key], existing);
    sets.push(`${col} = @${key}`);
    params[key] = value;
    changed[key] = typeof value === 'number' && (key === 'isDriver' || key === 'isFuelAttendant') ? !!value : value;
  }
  if (!sets.length) return existing;
  const nameEn = 'nameEn' in changed ? changed.nameEn : existing.nameEn;
  const nameKm = 'nameKm' in changed ? changed.nameKm : existing.nameKm;
  if (!nameEn && !nameKm) throw badRequest('A name in English or Khmer is required');
  if ('staffCode' in changed && changed.staffCode.toLowerCase() !== existing.staffCode.toLowerCase()) {
    const clash = getDb().prepare('SELECT 1 FROM employees WHERE company_id = ? AND staff_code = ? AND id <> ?')
      .get(existing.companyId, changed.staffCode, id);
    if (clash) throw badRequest(`Staff code ${changed.staffCode} is already used in this company`);
  }
  sets.push('updated_at = @updatedAt', 'updated_by_user_id = @by');
  params.updatedAt = nextUpdatedAt(existing.updatedAt);
  params.by = getCallerUserId();
  getDb().prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('employee', id, 'update', { before: redact(diff.before), after: redact(diff.after) });
  return get(id);
}

/* ─── HR1: the full profile ───────────────────────────────────── */

function dateField(label) {
  return (v) => {
    const s = v == null ? null : String(v).trim();
    if (!s) return null;
    if (!isCalendarDate(s)) throw badRequest(`${label} must be a real date like 2026-10-08`);
    return s;
  };
}

const HR_EDITABLE = {
  gender: ['gender', (v) => { if (v == null || v === '') return null; if (!GENDERS.includes(v)) throw badRequest('Gender must be female, male or other'); return v; }],
  dob: ['dob', dateField('Date of birth')],
  address: ['address', (v) => str(v, 500)],
  nationalIdNo: ['national_id_no', (v) => str(v, 40)],
  nssfNo: ['nssf_no', (v) => str(v, 40)],
  bankName: ['bank_name', (v) => str(v, 80)],
  bankAccountName: ['bank_account_name', (v) => str(v, 120)],
  bankAccountNo: ['bank_account_no', (v) => str(v, 40)],
  positionId: ['position_id', (v, e) => {
    if (v == null || v === '') return null;
    const p = getDb().prepare('SELECT company_id FROM positions WHERE id = ?').get(v);
    if (!p || p.company_id !== e.companyId) throw badRequest('That position is not in this company');
    return v;
  }],
  hireDate: ['hire_date', dateField('Hire date')],
  endDate: ['end_date', dateField('End date')],
  employmentType: ['employment_type', (v) => { if (v == null || v === '') return null; if (!EMPLOYMENT_TYPES.includes(v)) throw badRequest('Employment type must be monthly, daily, hourly or contract'); return v; }],
  supervisorEmployeeId: ['supervisor_employee_id', (v, e) => {
    if (v == null || v === '') return null;
    if (v === e.id) throw badRequest('Someone cannot be their own supervisor');
    const db = getDb();
    const sup = db.prepare('SELECT company_id FROM employees WHERE id = ?').get(v);
    if (!sup || sup.company_id !== e.companyId) throw badRequest('The supervisor is not on this company\'s staff list');
    // No loops: walking up from the new supervisor must never reach this person.
    let cur = v;
    for (let i = 0; i < 100 && cur; i += 1) {
      if (cur === e.id) throw badRequest('That would make a loop of supervisors');
      cur = db.prepare('SELECT supervisor_employee_id AS s FROM employees WHERE id = ?').get(cur)?.s ?? null;
    }
    return v;
  }],
};

/** Edit the HR profile fields (hr.manage). Audited as sensitive ('hr'); sensitive values never enter History. */
function updateHrProfile(id, rawPatch = {}) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  const patch = prepareOptimisticPatch({ ...existing, name: existing.nameEn || existing.nameKm }, rawPatch, 'employee');
  const sets = [];
  const params = { id };
  const changed = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'expectedUpdatedAt') continue;
    if (!(key in HR_EDITABLE)) throw badRequest(`${key} is not a profile field`);
    const [col, conv] = HR_EDITABLE[key];
    const v = conv(value, existing);
    sets.push(`${col} = @${key}`);
    params[key] = v;
    changed[key] = v;
  }
  if (!sets.length) return existing;
  const hire = 'hireDate' in changed ? changed.hireDate : existing.hireDate;
  const end = 'endDate' in changed ? changed.endDate : existing.endDate;
  if (hire && end && end < hire) throw badRequest('The end date cannot be before the hire date');
  sets.push('updated_at = @updatedAt', 'updated_by_user_id = @by');
  params.updatedAt = nextUpdatedAt(existing.updatedAt);
  params.by = getCallerUserId();
  getDb().prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('employee', id, 'profile', { before: redact(diff.before), after: redact(diff.after), sensitivity: 'hr' });
  return get(id);
}

/**
 * Suspend (from a date, today by default, optionally to a date) or bring back
 * from suspension. Each suspension is a dated row in employee_suspensions, so a
 * suspended day reads "suspended" in attendance, never "absent" (left is
 * markLeft / reactivate).
 */
function setStatus(id, status, reason = null, { fromDate = null, toDate = null } = {}) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  if (!['active', 'suspended'].includes(status)) throw badRequest('Status must be active or suspended (use Mark as left for someone leaving)');
  if (existing.status === 'left') throw badRequest('This person has left — reactivate them first');
  if (existing.status === status) return existing;
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  for (const [label, v] of [['fromDate', fromDate], ['toDate', toDate]]) {
    if (v != null && !isCalendarDate(v)) throw badRequest(`${label} must be a real date like 2026-10-08`);
  }
  const db = getDb();
  const by = getCallerUserId();
  const now = Date.now();
  db.transaction(() => {
    if (status === 'suspended') {
      if (!str(reason, 500)) throw badRequest('Say why the person is suspended');
      const from = fromDate || today;
      if (toDate && toDate < from) throw badRequest('The suspension cannot end before it starts');
      db.prepare('INSERT INTO employee_suspensions (id, company_id, employee_id, from_date, to_date, reason, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uuid(), existing.companyId, id, from, toDate, str(reason, 500), by, now);
    } else {
      // Back from today (or the day after `toDate`): the open suspension ends the day before.
      const end = toDate || new Date(Date.now() + 7 * 3600e3 - 86400e3).toISOString().slice(0, 10);
      db.prepare('UPDATE employee_suspensions SET to_date = ?, ended_by_user_id = ?, ended_at = ? WHERE employee_id = ? AND to_date IS NULL')
        .run(end, by, now, id);
    }
    db.prepare('UPDATE employees SET status = ?, status_reason = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?')
      .run(status, status === 'suspended' ? str(reason, 500) : null, nextUpdatedAt(existing.updatedAt), by, id);
  })();
  audit('employee', id, status === 'suspended' ? 'suspend' : 'unsuspend', {
    before: { status: existing.status }, after: { status, reason: str(reason, 500), fromDate, toDate }, sensitivity: 'hr',
  });
  return get(id);
}

/** Suspension ranges per employee: Map<employeeId, [{ from, to|null }]>. */
function suspensionsByEmployee(companyId) {
  const out = new Map();
  for (const r of getDb().prepare('SELECT employee_id, from_date, to_date FROM employee_suspensions WHERE company_id = ? ORDER BY from_date').all(companyId)) {
    if (!out.has(r.employee_id)) out.set(r.employee_id, []);
    out.get(r.employee_id).push({ from: r.from_date, to: r.to_date });
  }
  return out;
}

function listSuspensions(employeeId) {
  return getDb().prepare('SELECT * FROM employee_suspensions WHERE employee_id = ? ORDER BY from_date DESC').all(employeeId)
    .map((r) => ({ id: r.id, fromDate: r.from_date, toDate: r.to_date, reason: r.reason, createdByUserId: r.created_by_user_id, createdAt: r.created_at, endedAt: r.ended_at }));
}

/** Mark someone as having left. Never deletes; their records keep their name. */
function markLeft(id, { leftOn = null, reason = null } = {}) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  if (existing.status === 'left') return existing;
  if (leftOn != null && leftOn !== '' && !isCalendarDate(leftOn)) throw badRequest('Left on must be a real date like 2026-10-08');
  const date = leftOn || new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  getDb().prepare(`UPDATE employees SET status = 'left', left_on = ?, left_reason = ?, end_date = COALESCE(end_date, ?), updated_at = ?, updated_by_user_id = ? WHERE id = ?`)
    .run(date, str(reason, 500), date, nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
  audit('employee', id, 'mark-left', { before: { status: existing.status }, after: { status: 'left', leftOn: date, reason: str(reason, 500) } });
  return get(id);
}

function reactivate(id) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  if (existing.status === 'active') return existing;
  // The end date markLeft wrote goes with it; one an HR manager typed separately stays.
  getDb().prepare(`UPDATE employees SET status = 'active', left_on = NULL, left_reason = NULL,
      end_date = CASE WHEN end_date = ? THEN NULL ELSE end_date END, status_reason = NULL, updated_at = ?, updated_by_user_id = ? WHERE id = ?`)
    .run(existing.leftOn, nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
  getDb().prepare('UPDATE employee_suspensions SET to_date = ?, ended_by_user_id = ?, ended_at = ? WHERE employee_id = ? AND to_date IS NULL')
    .run(new Date(Date.now() + 7 * 3600e3 - 86400e3).toISOString().slice(0, 10), getCallerUserId(), Date.now(), id);
  audit('employee', id, 'reactivate', { before: { status: existing.status, leftOn: existing.leftOn }, after: { status: 'active' } });
  return get(id);
}

function setPhoto(id, { relPath, sha256 }) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  getDb().prepare('UPDATE employees SET photo_path = ?, photo_sha256 = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?')
    .run(relPath, sha256, nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
  audit('employee', id, 'photo', { before: { photoSha256: existing.photoSha256 }, after: { photoSha256: sha256 } });
  return get(id);
}

module.exports = {
  list, get, getRow, getByUserId, create, update, updateHrProfile, setStatus, suspensionsByEmployee, listSuspensions, markLeft, reactivate, setPhoto, rowToEmployee,
  STATUSES, GENDERS, EMPLOYMENT_TYPES, SENSITIVE_FIELDS, HR_EDITABLE,
};
