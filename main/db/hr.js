/**
 * HR1: per-company HR configuration — settings, the first-use prefill,
 * positions, work schedules (+ who works which schedule from when) and the
 * public-holiday list (docs/PEOPLE_AND_FUEL_PLAN.md §3.1, §3.2, §7b).
 *
 * Configuration, not history: these rows cascade with their company and may
 * be edited (every edit audited, sensitivity 'hr'). Schedules and holidays are
 * ARCHIVED rather than deleted so a past month still computes the same way;
 * changing a schedule's hours changes every date that uses it, so the screens
 * should offer "new schedule from <date>" (assignSchedule) for real changes.
 */

const { getDb } = require('./index');
const { uuid, audit, str, badRequest, getCallerUserId } = require('./_fuelUtil');
const calc = require('../util/attendanceCalc');

const HR = 'hr';

function hrAudit(entityType, entityId, action, payload = {}) {
  audit(entityType, entityId, action, { ...payload, sensitivity: HR });
}

/* ─── settings + first-use prefill ────────────────────────────── */

function settingsRow(companyId) {
  return getDb().prepare('SELECT * FROM hr_settings WHERE company_id = ?').get(companyId);
}

/**
 * Prefill a company's HR set-up the first time any HR channel touches it:
 * Cambodia's public holidays (main/util/cambodiaHolidays.js), one standard
 * schedule, the Labour Law leave types (main/db/leave.js). Idempotent: once
 * `prefilled_at` is set nothing is added again, so whatever the owner edits
 * or archives stays that way.
 */
function ensurePrefilled(companyId) {
  if (!companyId) throw badRequest('Pick a company first');
  const db = getDb();
  const row = settingsRow(companyId);
  if (row?.prefilled_at) return false;
  const now = Date.now();
  db.transaction(() => {
    if (!row) {
      db.prepare('INSERT INTO hr_settings (company_id, settings_json, updated_at) VALUES (?, ?, ?)').run(companyId, '{}', now);
    }
    // Holidays: skip a date the owner already entered.
    const ins = db.prepare(`INSERT INTO holidays (id, company_id, date, name_en, name_km, paid, source_note, created_at, updated_at)
      SELECT @id, @companyId, @date, @nameEn, @nameKm, @paid, @sourceNote, @now, @now
       WHERE NOT EXISTS (SELECT 1 FROM holidays WHERE company_id = @companyId AND date = @date AND archived_at IS NULL)`);
    for (const h of require('../util/cambodiaHolidays').prefilledHolidays()) {
      ins.run({ id: uuid(), companyId, date: h.date, nameEn: h.nameEn, nameKm: h.nameKm, paid: h.paid ? 1 : 0, sourceNote: h.sourceNote, now });
    }
    // One schedule to start from.
    let scheduleId = db.prepare('SELECT id FROM work_schedules WHERE company_id = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1').get(companyId)?.id;
    if (!scheduleId) {
      scheduleId = uuid();
      db.prepare(`INSERT INTO work_schedules (id, company_id, name, start_time, end_time, break_min, work_days, grace_min, night_start, night_end, created_at, updated_at)
        VALUES (?, ?, 'Standard day', '07:00', '17:00', 60, '1111110', 5, '22:00', '05:00', ?, ?)`).run(scheduleId, companyId, now, now);
    }
    require('./leave').ensureDefaultTypes(companyId, now);
    const stored = JSON.parse(settingsRow(companyId)?.settings_json || '{}');
    if (!stored.defaultScheduleId) stored.defaultScheduleId = scheduleId;
    db.prepare(`UPDATE hr_settings SET settings_json = ?, prefilled_at = ?, accrual_from_month = COALESCE(accrual_from_month, ?),
        attendance_start_date = COALESCE(attendance_start_date, ?), updated_at = ? WHERE company_id = ?`)
      .run(JSON.stringify(stored), now, calc.ppMonth(now), calc.ppDate(now), now, companyId);
  })();
  hrAudit('hr_settings', companyId, 'prefill', { after: { holidays: 'Cambodia 2026 (+ fixed 2027 dates)', schedule: 'Standard day 07:00–17:00', leaveTypes: 'Labour Law defaults' } });
  return true;
}

function getSettings(companyId) {
  ensurePrefilled(companyId);
  const row = settingsRow(companyId);
  let stored;
  try { stored = JSON.parse(row?.settings_json || '{}'); } catch (_) { stored = {}; }
  const { attendanceStartDate: _ignored, ...rest } = stored;
  return {
    ...calc.mergeSettings(rest), defaultScheduleId: stored.defaultScheduleId ?? null, accrualFromMonth: row?.accrual_from_month ?? null,
    // No day before this is ever "absent" (the paper era). Default: the day HR was first used.
    attendanceStartDate: row?.attendance_start_date || (row?.prefilled_at ? calc.ppDate(row.prefilled_at) : null),
  };
}

function updateSettings(companyId, patch = {}) {
  const before = getSettings(companyId);
  const { accrualFromMonth, attendanceStartDate, ...rest } = patch || {};
  if ('defaultScheduleId' in rest && rest.defaultScheduleId != null) {
    const s = getSchedule(rest.defaultScheduleId);
    if (!s || s.companyId !== companyId) throw badRequest('That schedule is not in this company');
  }
  const { attendanceStartDate: _a, accrualFromMonth: _m, ...beforeStored } = before;
  const merged = calc.mergeSettings(beforeStored, rest); // throws on a bad value
  const { attendanceStartDate: _x, ...mergedStored } = merged;
  const stored = { ...mergedStored, defaultScheduleId: 'defaultScheduleId' in rest ? rest.defaultScheduleId : before.defaultScheduleId };
  const db = getDb();
  if (accrualFromMonth !== undefined) {
    if (accrualFromMonth != null && !calc.isMonth(accrualFromMonth)) throw badRequest('accrualFromMonth must look like 2026-10');
    db.prepare('UPDATE hr_settings SET accrual_from_month = ? WHERE company_id = ?').run(accrualFromMonth, companyId);
  }
  if (attendanceStartDate !== undefined) {
    if (attendanceStartDate != null && !calc.isDate(attendanceStartDate)) throw badRequest('attendanceStartDate must be a real date like 2026-10-01');
    db.prepare('UPDATE hr_settings SET attendance_start_date = ? WHERE company_id = ?').run(attendanceStartDate, companyId);
  }
  db.prepare('UPDATE hr_settings SET settings_json = ?, updated_at = ?, updated_by_user_id = ? WHERE company_id = ?')
    .run(JSON.stringify(stored), Date.now(), getCallerUserId(), companyId);
  const after = getSettings(companyId);
  const diff = require('./auditLog').diffPatch(before, after);
  if (diff) hrAudit('hr_settings', companyId, 'update', diff);
  return after;
}

/* ─── positions ───────────────────────────────────────────────── */

function rowToPosition(r) {
  if (!r) return null;
  return { id: r.id, companyId: r.company_id, nameEn: r.name_en, nameKm: r.name_km, department: r.department, sort: r.sort, archived: !!r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at };
}
function listPositions(companyId, { includeArchived = false } = {}) {
  return getDb().prepare(`SELECT * FROM positions WHERE company_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY sort, COALESCE(name_en, name_km) COLLATE NOCASE`)
    .all(companyId).map(rowToPosition);
}
function getPosition(id) { return rowToPosition(getDb().prepare('SELECT * FROM positions WHERE id = ?').get(id)); }
function createPosition({ companyId, nameEn = null, nameKm = null, department = null, sort = 0 }) {
  const en = str(nameEn, 120);
  const km = str(nameKm, 120);
  if (!en && !km) throw badRequest('A position needs a name in English or Khmer');
  const id = uuid();
  const now = Date.now();
  getDb().prepare('INSERT INTO positions (id, company_id, name_en, name_km, department, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, companyId, en, km, str(department, 120), Number.isFinite(Number(sort)) ? Math.round(Number(sort)) : 0, now, now);
  const p = getPosition(id);
  hrAudit('position', id, 'create', { after: p });
  return p;
}
function updatePosition(id, patch = {}) {
  const p = getPosition(id);
  if (!p) throw badRequest('Position not found');
  const next = {
    nameEn: 'nameEn' in patch ? str(patch.nameEn, 120) : p.nameEn,
    nameKm: 'nameKm' in patch ? str(patch.nameKm, 120) : p.nameKm,
    department: 'department' in patch ? str(patch.department, 120) : p.department,
    sort: 'sort' in patch ? Math.round(Number(patch.sort) || 0) : p.sort,
    archived: 'archived' in patch ? !!patch.archived : p.archived,
  };
  if (!next.nameEn && !next.nameKm) throw badRequest('A position needs a name in English or Khmer');
  getDb().prepare('UPDATE positions SET name_en = ?, name_km = ?, department = ?, sort = ?, archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?')
    .run(next.nameEn, next.nameKm, next.department, next.sort, next.archived ? 1 : 0, Date.now(), Date.now(), id);
  const after = getPosition(id);
  const diff = require('./auditLog').diffPatch(p, next);
  if (diff) hrAudit('position', id, 'update', diff);
  return after;
}

/* ─── schedules ───────────────────────────────────────────────── */

function rowToSchedule(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, name: r.name, startTime: r.start_time, endTime: r.end_time, breakMin: r.break_min,
    workDays: r.work_days, graceMin: r.grace_min, nightStart: r.night_start, nightEnd: r.night_end,
    crossesMidnight: calc.crossesMidnight({ startTime: r.start_time, endTime: r.end_time }),
    archived: !!r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function listSchedules(companyId, { includeArchived = false } = {}) {
  return getDb().prepare(`SELECT * FROM work_schedules WHERE company_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name COLLATE NOCASE`)
    .all(companyId).map(rowToSchedule);
}
function getSchedule(id) { return rowToSchedule(getDb().prepare('SELECT * FROM work_schedules WHERE id = ?').get(id)); }

function scheduleValues(input, base = {}) {
  const v = { ...base };
  if ('name' in input) { v.name = str(input.name, 80); if (!v.name) throw badRequest('A schedule needs a name'); }
  for (const k of ['startTime', 'endTime', 'nightStart', 'nightEnd']) {
    if (k in input) { if (!calc.isHm(input[k])) throw badRequest(`${k} must be a time like 07:30`); v[k] = input[k]; }
  }
  if ('breakMin' in input) { const n = Number(input.breakMin); if (!Number.isInteger(n) || n < 0 || n > 600) throw badRequest('breakMin must be whole minutes from 0 to 600'); v.breakMin = n; }
  if ('graceMin' in input) { const n = Number(input.graceMin); if (!Number.isInteger(n) || n < 0 || n > 120) throw badRequest('graceMin must be whole minutes from 0 to 120'); v.graceMin = n; }
  if ('workDays' in input) { if (!calc.isWorkDaysMask(input.workDays)) throw badRequest('workDays must be 7 digits 0/1, Monday first (e.g. 1111110)'); v.workDays = input.workDays; }
  if (v.startTime && v.endTime && v.startTime === v.endTime) throw badRequest('A schedule must start and end at different times');
  return v;
}

function createSchedule({ companyId, ...input }) {
  const v = scheduleValues(input, { breakMin: 60, graceMin: 5, workDays: '1111110', nightStart: '22:00', nightEnd: '05:00' });
  if (!v.name || !v.startTime || !v.endTime) throw badRequest('A schedule needs a name, a start time and an end time');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM work_schedules WHERE company_id = ? AND name = ?').get(companyId, v.name)) throw badRequest(`There is already a schedule called ${v.name}`);
  const id = uuid();
  const now = Date.now();
  db.prepare(`INSERT INTO work_schedules (id, company_id, name, start_time, end_time, break_min, work_days, grace_min, night_start, night_end, created_at, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, companyId, v.name, v.startTime, v.endTime, v.breakMin, v.workDays, v.graceMin, v.nightStart, v.nightEnd, now, now, getCallerUserId());
  const s = getSchedule(id);
  hrAudit('hr_schedule', id, 'create', { after: s });
  return s;
}

function updateSchedule(id, patch = {}) {
  const s = getSchedule(id);
  if (!s) throw badRequest('Schedule not found');
  const v = scheduleValues(patch, { ...s });
  if ('archived' in patch) {
    if (patch.archived && getSettings(s.companyId).defaultScheduleId === id) throw badRequest('This is the default schedule — pick another default first');
    v.archived = !!patch.archived;
  }
  if (v.name !== s.name && getDb().prepare('SELECT 1 FROM work_schedules WHERE company_id = ? AND name = ? AND id <> ?').get(s.companyId, v.name, id)) {
    throw badRequest(`There is already a schedule called ${v.name}`);
  }
  getDb().prepare(`UPDATE work_schedules SET name = ?, start_time = ?, end_time = ?, break_min = ?, work_days = ?, grace_min = ?, night_start = ?, night_end = ?,
      archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END, updated_at = ?, updated_by_user_id = ? WHERE id = ?`)
    .run(v.name, v.startTime, v.endTime, v.breakMin, v.workDays, v.graceMin, v.nightStart, v.nightEnd, v.archived ? 1 : 0, Date.now(), Date.now(), getCallerUserId(), id);
  const after = getSchedule(id);
  const { id: _i, companyId: _c, createdAt: _a, updatedAt: _u, crossesMidnight: _x, ...cmp } = v;
  const diff = require('./auditLog').diffPatch(s, cmp);
  if (diff) hrAudit('hr_schedule', id, 'update', diff);
  return after;
}

/** Who works which schedule from when. Same employee + date replaces that row. */
function assignSchedule({ employeeId, scheduleId, effectiveFrom }) {
  const emp = require('./employees').get(employeeId);
  if (!emp) throw badRequest('Staff member not found');
  const s = getSchedule(scheduleId);
  if (!s || s.companyId !== emp.companyId) throw badRequest('That schedule is not in this company');
  if (s.archived) throw badRequest('That schedule is archived');
  if (!calc.isDate(effectiveFrom)) throw badRequest('effectiveFrom must be a real date like 2026-10-01');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM employee_schedules WHERE employee_id = ? AND effective_from = ?').get(employeeId, effectiveFrom);
  if (existing) {
    db.prepare('UPDATE employee_schedules SET schedule_id = ?, set_by_user_id = ?, created_at = ? WHERE id = ?').run(scheduleId, getCallerUserId(), Date.now(), existing.id);
  } else {
    db.prepare('INSERT INTO employee_schedules (id, company_id, employee_id, schedule_id, effective_from, set_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuid(), emp.companyId, employeeId, scheduleId, effectiveFrom, getCallerUserId(), Date.now());
  }
  hrAudit('employee', employeeId, 'schedule', { before: existing ? { scheduleId: existing.schedule_id, effectiveFrom } : null, after: { scheduleId, scheduleName: s.name, effectiveFrom } });
  return listEmployeeSchedules(employeeId);
}

function listEmployeeSchedules(employeeId) {
  return getDb().prepare(`SELECT es.*, ws.name AS schedule_name FROM employee_schedules es JOIN work_schedules ws ON ws.id = es.schedule_id
     WHERE es.employee_id = ? ORDER BY es.effective_from`).all(employeeId)
    .map((r) => ({ id: r.id, employeeId: r.employee_id, scheduleId: r.schedule_id, scheduleName: r.schedule_name, effectiveFrom: r.effective_from, setByUserId: r.set_by_user_id, createdAt: r.created_at }));
}

/**
 * (employeeId, date) → the schedule in force, from one load of the company's
 * schedules and assignments (month summaries ask thousands of times).
 * Falls back to the company's default schedule.
 */
function scheduleResolver(companyId) {
  const db = getDb();
  const schedules = new Map(db.prepare('SELECT * FROM work_schedules WHERE company_id = ?').all(companyId).map((r) => [r.id, rowToSchedule(r)]));
  const byEmp = new Map();
  for (const r of db.prepare('SELECT employee_id, schedule_id, effective_from FROM employee_schedules WHERE company_id = ? ORDER BY effective_from').all(companyId)) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id).push(r);
  }
  const fallback = schedules.get(getSettings(companyId).defaultScheduleId) || null;
  return (employeeId, date) => {
    const list = byEmp.get(employeeId);
    let id = null;
    if (list) for (const r of list) { if (r.effective_from <= date) id = r.schedule_id; else break; }
    return (id && schedules.get(id)) || fallback;
  };
}

/* ─── holidays ────────────────────────────────────────────────── */

function rowToHoliday(r) {
  if (!r) return null;
  return { id: r.id, companyId: r.company_id, date: r.date, nameEn: r.name_en, nameKm: r.name_km, paid: !!r.paid, sourceNote: r.source_note, archived: !!r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at };
}
function listHolidays(companyId, { year = null, from = null, to = null, includeArchived = false } = {}) {
  const where = ['company_id = @companyId'];
  const params = { companyId };
  if (!includeArchived) where.push('archived_at IS NULL');
  if (year) { where.push('date LIKE @y'); params.y = `${year}-%`; }
  if (from) { where.push('date >= @from'); params.from = from; }
  if (to) { where.push('date <= @to'); params.to = to; }
  return getDb().prepare(`SELECT * FROM holidays WHERE ${where.join(' AND ')} ORDER BY date`).all(params).map(rowToHoliday);
}
function getHoliday(id) { return rowToHoliday(getDb().prepare('SELECT * FROM holidays WHERE id = ?').get(id)); }
function holidayMap(companyId, from, to) {
  return new Map(listHolidays(companyId, { from, to }).map((h) => [h.date, h]));
}
function createHoliday({ companyId, date, nameEn = null, nameKm = null, paid = true, sourceNote = null }) {
  if (!calc.isDate(date)) throw badRequest('date must be a real date like 2026-04-14');
  const en = str(nameEn, 160);
  const km = str(nameKm, 160);
  if (!en && !km) throw badRequest('A holiday needs a name in English or Khmer');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM holidays WHERE company_id = ? AND date = ? AND archived_at IS NULL').get(companyId, date)) throw badRequest(`${date} is already a holiday`);
  const id = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO holidays (id, company_id, date, name_en, name_km, paid, source_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, companyId, date, en, km, paid === false ? 0 : 1, str(sourceNote, 300), now, now);
  const h = getHoliday(id);
  hrAudit('holiday', id, 'create', { after: h });
  return h;
}
function updateHoliday(id, patch = {}) {
  const h = getHoliday(id);
  if (!h) throw badRequest('Holiday not found');
  const next = {
    date: 'date' in patch ? patch.date : h.date,
    nameEn: 'nameEn' in patch ? str(patch.nameEn, 160) : h.nameEn,
    nameKm: 'nameKm' in patch ? str(patch.nameKm, 160) : h.nameKm,
    paid: 'paid' in patch ? patch.paid !== false : h.paid,
    sourceNote: 'sourceNote' in patch ? str(patch.sourceNote, 300) : h.sourceNote,
    archived: 'archived' in patch ? !!patch.archived : h.archived,
  };
  if (!calc.isDate(next.date)) throw badRequest('date must be a real date like 2026-04-14');
  if (!next.nameEn && !next.nameKm) throw badRequest('A holiday needs a name in English or Khmer');
  if (!next.archived && getDb().prepare('SELECT 1 FROM holidays WHERE company_id = ? AND date = ? AND archived_at IS NULL AND id <> ?').get(h.companyId, next.date, id)) {
    throw badRequest(`${next.date} is already a holiday`);
  }
  getDb().prepare('UPDATE holidays SET date = ?, name_en = ?, name_km = ?, paid = ?, source_note = ?, archived_at = ?, updated_at = ? WHERE id = ?')
    .run(next.date, next.nameEn, next.nameKm, next.paid ? 1 : 0, next.sourceNote, next.archived ? Date.now() : null, Date.now(), id);
  const diff = require('./auditLog').diffPatch(h, next);
  if (diff) hrAudit('holiday', id, 'update', diff);
  return getHoliday(id);
}

module.exports = {
  hrAudit, ensurePrefilled, getSettings, updateSettings,
  listPositions, getPosition, createPosition, updatePosition,
  listSchedules, getSchedule, createSchedule, updateSchedule, assignSchedule, listEmployeeSchedules, scheduleResolver,
  listHolidays, getHoliday, holidayMap, createHoliday, updateHoliday,
};
