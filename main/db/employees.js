/**
 * Fuel F1: the thin staff list — the seed of HR (docs/PEOPLE_AND_FUEL_PLAN.md §3.1).
 *
 * Only what fuel needs now: code, names (English + Khmer), phone, photo,
 * position, driver / pump-attendant flags, status, optional app account.
 * HR1 extends the same table additively.
 *
 * No delete. Someone who leaves is marked `left` (with the date and reason)
 * and keeps every fill, dip and delivery that names them — fuel history
 * references employees with ON DELETE RESTRICT.
 */

const { getDb } = require('./index');
const { prepareOptimisticPatch, nextUpdatedAt } = require('./_util');
const { uuid, audit, str, badRequest, getCallerUserId, isCalendarDate } = require('./_fuelUtil');

const STATUSES = ['active', 'left'];

/**
 * What goes into History for a staff change: never the phone number or the
 * notes themselves (personal data; History is readable more widely than the
 * staff list) — only that they were set or changed.
 */
const PRIVATE_FIELDS = ['phone', 'notes'];
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
  if (q && String(q).trim()) {
    // A recorder's tile search must not reveal phone numbers by matching them.
    where.push(`(staff_code LIKE @q OR name_en LIKE @q OR name_km LIKE @q${searchPhone ? ' OR phone LIKE @q' : ''})`);
    params.q = `%${String(q).trim()}%`;
  }
  return getDb()
    .prepare(`SELECT * FROM employees WHERE ${where.join(' AND ')} ORDER BY status = 'left', COALESCE(name_en, name_km, staff_code) COLLATE NOCASE`)
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

function checkUser(userId) {
  if (userId == null) return null;
  const u = getDb().prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!u) throw badRequest('That app account does not exist');
  return userId;
}

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
    userId: checkUser(input.userId ?? null),
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
  userId: ['user_id', (v) => checkUser(v ?? null)],
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
    const value = conv(patch[key]);
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

/** Mark someone as having left. Never deletes; their records keep their name. */
function markLeft(id, { leftOn = null, reason = null } = {}) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  if (existing.status === 'left') return existing;
  if (leftOn != null && leftOn !== '' && !isCalendarDate(leftOn)) throw badRequest('Left on must be a real date like 2026-10-08');
  const date = leftOn || new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  getDb().prepare(`UPDATE employees SET status = 'left', left_on = ?, left_reason = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?`)
    .run(date, str(reason, 500), nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
  audit('employee', id, 'mark-left', { before: { status: existing.status }, after: { status: 'left', leftOn: date, reason: str(reason, 500) } });
  return get(id);
}

function reactivate(id) {
  const existing = get(id);
  if (!existing) throw badRequest('Staff member not found');
  if (existing.status === 'active') return existing;
  getDb().prepare(`UPDATE employees SET status = 'active', left_on = NULL, left_reason = NULL, updated_at = ?, updated_by_user_id = ? WHERE id = ?`)
    .run(nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
  audit('employee', id, 'reactivate', { before: { status: 'left', leftOn: existing.leftOn }, after: { status: 'active' } });
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

module.exports = { list, get, getRow, getByUserId, create, update, markLeft, reactivate, setPhoto, rowToEmployee };
