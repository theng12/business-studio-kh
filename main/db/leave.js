/**
 * HR1: leave — types, the ledger, requests, the monthly accrual and the
 * year-end carry-over (docs/PEOPLE_AND_FUEL_PLAN.md §3.2, §7b).
 *
 *   - A balance is the SUM of the person's ledger rows for that type; nothing
 *     else holds a balance. Rows are never edited or deleted: an approved
 *     request writes a `taken` row (−days); cancelling it writes an
 *     `adjustment` (+days); a manager's opening balance is an `adjustment`.
 *   - Accrual and expiry rows carry a `period` and a unique index, so the jobs
 *     (main/hrScheduler.js) can run any number of times without doubling.
 *   - Accrual starts at the company's `accrualFromMonth` (the month HR was
 *     first used) — earlier service is entered once as an opening adjustment,
 *     never invented.
 *   - Arithmetic is in main/util/leaveCalc.js (pure, unit-tested).
 *
 * Every write is audited with sensitivity 'hr'.
 */

const { getDb } = require('./index');
const { uuid, str, badRequest, getCallerUserId } = require('./_fuelUtil');
const calc = require('../util/attendanceCalc');
const leaveCalc = require('../util/leaveCalc');
const hr = require('./hr');

const ACCRUALS = ['monthly', 'yearly', 'none'];
const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const LEDGER_KINDS = ['accrual', 'taken', 'adjustment', 'carry_over', 'expiry'];

/**
 * The Cambodian Labour Law defaults the owner starts from (§7b). Every one is
 * marked "confirm with the accountant" — the app calculates from these, it
 * does not vouch for them.
 */
const DEFAULT_TYPES = [
  { code: 'annual', nameEn: 'Annual leave', nameKm: 'ច្បាប់ឈប់សម្រាកប្រចាំឆ្នាំ', paid: true, accrual: 'monthly', accrualDays: 1.5, tracksBalance: true, carryOverMax: 18,
    note: 'Labour Law art. 166: 1.5 working days per month of continuous service (seniority adds 1 day per 3 years — not added automatically). Carry-over limit is a starting value. Confirm with the accountant.' },
  { code: 'special', nameEn: 'Special leave', nameKm: 'ច្បាប់ឈប់សម្រាកពិសេស', paid: true, accrual: 'yearly', accrualDays: 7, tracksBalance: true, carryOverMax: 0,
    note: 'Labour Law art. 171: up to 7 days a year for events in the immediate family. Confirm with the accountant whether it is set against annual leave.' },
  { code: 'sick', nameEn: 'Sick leave', nameKm: 'ច្បាប់ឈប់សម្រាកព្យាបាលជំងឺ', paid: true, accrual: 'none', accrualDays: 0, tracksBalance: false, needsDocument: true,
    note: 'Paid sick days and when a medical certificate is needed — confirm with the accountant.' },
  { code: 'maternity', nameEn: 'Maternity leave', nameKm: 'ច្បាប់ឈប់សម្រាកលំហែមាតុភាព', paid: true, accrual: 'none', accrualDays: 0, tracksBalance: false, maxDaysPerRequest: 90, countCalendarDays: true, needsDocument: true,
    note: 'Labour Law art. 182: 90 days. Which part the employer and NSSF pay — confirm with the accountant.' },
  { code: 'unpaid', nameEn: 'Unpaid leave', nameKm: 'ច្បាប់ឈប់សម្រាកគ្មានប្រាក់ឈ្នួល', paid: false, accrual: 'none', accrualDays: 0, tracksBalance: false,
    note: 'Not paid; agreed case by case.' },
];

function hrAudit(entityType, entityId, action, payload) { hr.hrAudit(entityType, entityId, action, payload); }

/* ─── types ───────────────────────────────────────────────────── */

function rowToType(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, code: r.code, nameEn: r.name_en, nameKm: r.name_km, paid: !!r.paid,
    accrual: r.accrual, accrualDays: r.accrual_days, tracksBalance: !!r.tracks_balance, maxBalance: r.max_balance,
    carryOverMax: r.carry_over_max, maxDaysPerRequest: r.max_days_per_request, countCalendarDays: !!r.count_calendar_days,
    needsDocument: !!r.needs_document, note: r.note, sort: r.sort, archived: !!r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function ensureDefaultTypes(companyId, now = Date.now()) {
  const ins = getDb().prepare(`INSERT OR IGNORE INTO leave_types (id, company_id, code, name_en, name_km, paid, accrual, accrual_days, tracks_balance, max_balance,
      carry_over_max, max_days_per_request, count_calendar_days, needs_document, note, sort, created_at, updated_at)
    VALUES (@id, @companyId, @code, @nameEn, @nameKm, @paid, @accrual, @accrualDays, @tracks, NULL, @carry, @maxReq, @calendar, @doc, @note, @sort, @now, @now)`);
  DEFAULT_TYPES.forEach((t, i) => ins.run({
    id: uuid(), companyId, code: t.code, nameEn: t.nameEn, nameKm: t.nameKm, paid: t.paid ? 1 : 0, accrual: t.accrual, accrualDays: t.accrualDays,
    tracks: t.tracksBalance ? 1 : 0, carry: t.carryOverMax ?? null, maxReq: t.maxDaysPerRequest ?? null, calendar: t.countCalendarDays ? 1 : 0,
    doc: t.needsDocument ? 1 : 0, note: t.note, sort: i, now,
  }));
}

function listTypes(companyId, { includeArchived = false } = {}) {
  hr.ensurePrefilled(companyId);
  return getDb().prepare(`SELECT * FROM leave_types WHERE company_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY sort, code`).all(companyId).map(rowToType);
}
function getType(id) { return rowToType(getDb().prepare('SELECT * FROM leave_types WHERE id = ?').get(id)); }

function typeValues(input, base) {
  const v = { ...base };
  if ('code' in input) { v.code = str(input.code, 30); if (!v.code || !/^[A-Za-z0-9_-]+$/.test(v.code)) throw badRequest('code must be letters, digits, - or _'); }
  if ('nameEn' in input) v.nameEn = str(input.nameEn, 120);
  if ('nameKm' in input) v.nameKm = str(input.nameKm, 120);
  if ('paid' in input) v.paid = input.paid !== false;
  if ('accrual' in input) { if (!ACCRUALS.includes(input.accrual)) throw badRequest('accrual must be monthly, yearly or none'); v.accrual = input.accrual; }
  const days = (k, max) => {
    if (!(k in input)) return;
    if (input[k] == null) { v[k] = null; return; }
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) throw badRequest(`${k} must be a number from 0 to ${max}`);
    v[k] = Math.round(n * 100) / 100;
  };
  days('accrualDays', 366); days('maxBalance', 1000); days('carryOverMax', 1000); days('maxDaysPerRequest', 400);
  for (const k of ['tracksBalance', 'needsDocument', 'countCalendarDays', 'archived']) if (k in input) v[k] = !!input[k];
  if ('note' in input) v.note = str(input.note, 1000);
  if ('sort' in input) v.sort = Math.round(Number(input.sort) || 0);
  if (!v.nameEn && !v.nameKm) throw badRequest('A leave type needs a name in English or Khmer');
  if (v.accrual !== 'none' && !(v.accrualDays > 0)) throw badRequest('An accruing leave type needs accrualDays more than 0');
  return v;
}

function createType({ companyId, ...input }) {
  hr.ensurePrefilled(companyId);
  const v = typeValues(input, { paid: true, accrual: 'none', accrualDays: 0, tracksBalance: false, needsDocument: false, countCalendarDays: false, sort: 100 });
  if (!v.code) throw badRequest('code is required');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM leave_types WHERE company_id = ? AND code = ?').get(companyId, v.code)) throw badRequest(`There is already a leave type ${v.code}`);
  const id = uuid();
  const now = Date.now();
  db.prepare(`INSERT INTO leave_types (id, company_id, code, name_en, name_km, paid, accrual, accrual_days, tracks_balance, max_balance, carry_over_max,
      max_days_per_request, count_calendar_days, needs_document, note, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, v.code, v.nameEn ?? null, v.nameKm ?? null, v.paid ? 1 : 0, v.accrual, v.accrualDays, v.tracksBalance ? 1 : 0, v.maxBalance ?? null,
      v.carryOverMax ?? null, v.maxDaysPerRequest ?? null, v.countCalendarDays ? 1 : 0, v.needsDocument ? 1 : 0, v.note ?? null, v.sort, now, now);
  const t = getType(id);
  hrAudit('leave_type', id, 'create', { after: t });
  return t;
}

function updateType(id, patch = {}) {
  const t = getType(id);
  if (!t) throw badRequest('Leave type not found');
  if ('code' in patch && patch.code !== t.code) throw badRequest('A leave type\'s code cannot change');
  const v = typeValues(patch, { ...t });
  getDb().prepare(`UPDATE leave_types SET name_en = ?, name_km = ?, paid = ?, accrual = ?, accrual_days = ?, tracks_balance = ?, max_balance = ?, carry_over_max = ?,
      max_days_per_request = ?, count_calendar_days = ?, needs_document = ?, note = ?, sort = ?, archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?`)
    .run(v.nameEn, v.nameKm, v.paid ? 1 : 0, v.accrual, v.accrualDays, v.tracksBalance ? 1 : 0, v.maxBalance ?? null, v.carryOverMax ?? null,
      v.maxDaysPerRequest ?? null, v.countCalendarDays ? 1 : 0, v.needsDocument ? 1 : 0, v.note, v.sort, v.archived ? 1 : 0, Date.now(), Date.now(), id);
  const diff = require('./auditLog').diffPatch(t, v);
  if (diff) hrAudit('leave_type', id, 'update', diff);
  return getType(id);
}

/* ─── ledger + balances ───────────────────────────────────────── */

function rowToLedger(r) {
  return { id: r.id, employeeId: r.employee_id, leaveTypeId: r.leave_type_id, date: r.date, kind: r.kind, days: r.days, period: r.period, requestId: r.request_id, note: r.note, createdByUserId: r.created_by_user_id, createdAt: r.created_at };
}

function insertLedger(db, row) {
  const info = db.prepare(`INSERT OR IGNORE INTO leave_ledger (id, company_id, employee_id, leave_type_id, date, kind, days, period, request_id, note, created_by_user_id, created_at)
    VALUES (@id, @companyId, @employeeId, @leaveTypeId, @date, @kind, @days, @period, @requestId, @note, @by, @now)`).run({
    id: uuid(), period: null, requestId: null, note: null, by: getCallerUserId(), now: Date.now(), ...row,
  });
  return info.changes > 0;
}

function listLedger(employeeId, { leaveTypeId = null, limit = 500 } = {}) {
  const rows = getDb().prepare(`SELECT * FROM leave_ledger WHERE employee_id = @e ${leaveTypeId ? 'AND leave_type_id = @t' : ''} ORDER BY date DESC, created_at DESC LIMIT ${Math.min(Math.max(1, Number(limit) || 500), 2000)}`)
    .all(leaveTypeId ? { e: employeeId, t: leaveTypeId } : { e: employeeId });
  return rows.map(rowToLedger);
}

function balanceOf(employeeId, leaveTypeId, { asOf = null } = {}) {
  const r = getDb().prepare(`SELECT COALESCE(SUM(days), 0) AS b FROM leave_ledger WHERE employee_id = ? AND leave_type_id = ? ${asOf ? 'AND date <= ?' : ''}`)
    .get(...[employeeId, leaveTypeId, ...(asOf ? [asOf] : [])]);
  return Math.round((r?.b || 0) * 100) / 100;
}

/** Every type for one person: balance (tracked types), taken this year, waiting for a decision. */
function balances(companyId, employeeId, { now = Date.now() } = {}) {
  const year = calc.ppDate(now).slice(0, 4);
  const db = getDb();
  return listTypes(companyId).map((t) => {
    const taken = db.prepare(`SELECT COALESCE(SUM(days), 0) AS d FROM leave_requests WHERE employee_id = ? AND leave_type_id = ? AND status = 'approved' AND from_date LIKE ?`)
      .get(employeeId, t.id, `${year}-%`).d;
    const pending = db.prepare(`SELECT COALESCE(SUM(days), 0) AS d FROM leave_requests WHERE employee_id = ? AND leave_type_id = ? AND status = 'pending'`).get(employeeId, t.id).d;
    return {
      leaveTypeId: t.id, code: t.code, nameEn: t.nameEn, nameKm: t.nameKm, paid: t.paid, tracksBalance: t.tracksBalance,
      balance: t.tracksBalance ? balanceOf(employeeId, t.id) : null, takenThisYear: taken, pendingDays: pending,
    };
  });
}

/** A manager's opening balance or correction (±days). */
function adjust({ companyId, employeeId, leaveTypeId, days, date = null, note }) {
  const emp = require('./employees').get(employeeId);
  if (!emp || emp.companyId !== companyId) throw badRequest('Staff member not found');
  const t = getType(leaveTypeId);
  if (!t || t.companyId !== companyId) throw badRequest('Leave type not found');
  const n = Number(days);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1000) throw badRequest('days must be a number other than 0');
  if (!str(note, 500)) throw badRequest('Say why the balance is adjusted');
  const d = date || calc.ppDate(Date.now());
  if (!calc.isDate(d)) throw badRequest('date must be a real date');
  insertLedger(getDb(), { companyId, employeeId, leaveTypeId, date: d, kind: 'adjustment', days: Math.round(n * 100) / 100, note: str(note, 500) });
  hrAudit('leave_ledger', employeeId, 'adjust', { after: { leaveType: t.code, days: n, date: d, note: str(note, 500) } });
  return { balance: balanceOf(employeeId, leaveTypeId) };
}

/* ─── requests ────────────────────────────────────────────────── */

function rowToRequest(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, employeeId: r.employee_id, leaveTypeId: r.leave_type_id, fromDate: r.from_date, toDate: r.to_date,
    halfDay: r.half_day, days: r.days, reason: r.reason, status: r.status, requestedByUserId: r.requested_by_user_id, requestedVia: r.requested_via,
    decidedByUserId: r.decided_by_user_id, decidedAt: r.decided_at, decisionNote: r.decision_note, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function getRequest(id) { return rowToRequest(getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(id)); }

function countDays(companyId, employeeId, type, { fromDate, toDate, halfDay }) {
  if (type.countCalendarDays) {
    return leaveCalc.countLeaveDays({ fromDate, toDate, halfDay, isWorkDay: () => true, isHoliday: () => false });
  }
  const resolve = hr.scheduleResolver(companyId);
  const holidays = hr.holidayMap(companyId, fromDate, toDate);
  return leaveCalc.countLeaveDays({
    fromDate, toDate, halfDay,
    isWorkDay: (d) => calc.isWorkDay(resolve(employeeId, d), d),
    isHoliday: (d) => holidays.has(d),
  });
}

function createRequest({ companyId, employeeId, leaveTypeId, fromDate, toDate = null, halfDay = null, reason = null, via = 'manager' }) {
  hr.ensurePrefilled(companyId);
  const emp = require('./employees').get(employeeId);
  if (!emp || emp.companyId !== companyId) throw badRequest('Staff member not found');
  if (emp.status === 'left') throw badRequest('This person has left');
  const t = getType(leaveTypeId);
  if (!t || t.companyId !== companyId || t.archived) throw badRequest('Leave type not found');
  const to = toDate || fromDate;
  if (halfDay != null && !['am', 'pm'].includes(halfDay)) throw badRequest("halfDay must be 'am' or 'pm'");
  const days = countDays(companyId, employeeId, t, { fromDate, toDate: to, halfDay });
  if (!(days > 0)) throw badRequest('Those dates are not work days (weekly day off or public holiday) — nothing to request');
  if (t.maxDaysPerRequest != null && days > t.maxDaysPerRequest) throw badRequest(`${t.nameEn || t.code} is at most ${t.maxDaysPerRequest} days per request`);
  const db = getDb();
  const clash = db.prepare(`SELECT from_date, to_date FROM leave_requests WHERE employee_id = ? AND status IN ('pending', 'approved') AND from_date <= ? AND to_date >= ?
      AND NOT (half_day IS NOT NULL AND ? IS NOT NULL AND half_day <> ? AND from_date = to_date AND from_date = ?)`)
    .get(employeeId, to, fromDate, halfDay, halfDay, fromDate);
  if (clash) throw badRequest(`There is already leave from ${clash.from_date} to ${clash.to_date} that overlaps`);
  const id = uuid();
  const now = Date.now();
  db.prepare(`INSERT INTO leave_requests (id, company_id, employee_id, leave_type_id, from_date, to_date, half_day, days, reason, status, requested_by_user_id, requested_via, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, companyId, employeeId, leaveTypeId, fromDate, to, halfDay, days, str(reason, 1000), getCallerUserId(), via, now, now);
  const r = getRequest(id);
  hrAudit('leave_request', id, 'request', { after: { employeeId, leaveType: t.code, fromDate, toDate: to, halfDay, days, via } });
  return r;
}

function decide(id, { decision, note = null, allowNegative = false } = {}) {
  const r = getRequest(id);
  if (!r) throw badRequest('Leave request not found');
  if (r.status !== 'pending') throw badRequest(`This request is already ${r.status}`);
  if (!['approve', 'reject'].includes(decision)) throw badRequest('decision must be approve or reject');
  if (decision === 'reject' && !str(note, 1000)) throw badRequest('Say why the request is rejected');
  const t = getType(r.leaveTypeId);
  const db = getDb();
  const now = Date.now();
  let days = r.days;
  db.transaction(() => {
    if (decision === 'approve') {
      // Re-count: a holiday or schedule may have changed since the request.
      days = countDays(r.companyId, r.employeeId, t, { fromDate: r.fromDate, toDate: r.toDate, halfDay: r.halfDay });
      if (t.tracksBalance && !allowNegative) {
        const bal = balanceOf(r.employeeId, t.id);
        if (bal - days < -1e-9) throw badRequest(`Not enough ${t.nameEn || t.code}: balance ${bal} day(s), request ${days}. Approve anyway with allowNegative if agreed.`);
      }
      insertLedger(db, { companyId: r.companyId, employeeId: r.employeeId, leaveTypeId: t.id, date: r.fromDate, kind: 'taken', days: -days, requestId: id, note: `${r.fromDate}${r.toDate !== r.fromDate ? ` – ${r.toDate}` : ''}` });
    }
    db.prepare('UPDATE leave_requests SET status = ?, days = ?, decided_by_user_id = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?')
      .run(decision === 'approve' ? 'approved' : 'rejected', days, getCallerUserId(), now, str(note, 1000), now, id);
  })();
  hrAudit('leave_request', id, decision, { before: { status: 'pending' }, after: { status: decision === 'approve' ? 'approved' : 'rejected', days, note: str(note, 1000) } });
  return getRequest(id);
}

/** Cancel a pending request, or an approved one (its days go back on the balance). */
function cancel(id, { reason = null, onlyPending = false } = {}) {
  const r = getRequest(id);
  if (!r) throw badRequest('Leave request not found');
  if (!['pending', 'approved'].includes(r.status)) throw badRequest(`This request is already ${r.status}`);
  if (onlyPending && r.status !== 'pending') throw badRequest('Only a request still waiting for a decision can be withdrawn here — ask the office');
  if (r.status === 'approved' && !str(reason, 500)) throw badRequest('Say why approved leave is cancelled');
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    if (r.status === 'approved') {
      insertLedger(db, { companyId: r.companyId, employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, date: calc.ppDate(now), kind: 'adjustment', days: r.days, requestId: id, note: `Cancelled: ${str(reason, 400)}` });
    }
    db.prepare("UPDATE leave_requests SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?").run(now, str(reason, 500), now, id);
  })();
  hrAudit('leave_request', id, 'cancel', { before: { status: r.status }, after: { status: 'cancelled', reason: str(reason, 500) } });
  return getRequest(id);
}

function listRequests(companyId, { status = null, employeeId = null, from = null, to = null, limit = 200, offset = 0 } = {}) {
  const where = ['company_id = @companyId'];
  const params = { companyId };
  if (status) { if (!REQUEST_STATUSES.includes(status)) throw badRequest('status must be pending, approved, rejected or cancelled'); where.push('status = @status'); params.status = status; }
  if (employeeId) { where.push('employee_id = @employeeId'); params.employeeId = employeeId; }
  if (from) { where.push('to_date >= @from'); params.from = from; }
  if (to) { where.push('from_date <= @to'); params.to = to; }
  const lim = Math.min(Math.max(1, Number(limit) || 200), 1000);
  const off = Math.max(0, Number(offset) || 0);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM leave_requests WHERE ${where.join(' AND ')}`).get(params).n;
  const items = db.prepare(`SELECT * FROM leave_requests WHERE ${where.join(' AND ')} ORDER BY from_date DESC, created_at DESC LIMIT ${lim} OFFSET ${off}`).all(params).map(rowToRequest);
  return { items, total };
}

/** Approved leave as a map employeeId → Map(date → { half, typeCode, paid }) for the dates in [from, to]. */
function approvedLeaveByDate(companyId, from, to) {
  const rows = getDb().prepare(`SELECT r.*, t.code AS type_code, t.paid AS type_paid, t.count_calendar_days AS cal FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
     WHERE r.company_id = ? AND r.status = 'approved' AND r.from_date <= ? AND r.to_date >= ?`).all(companyId, to, from);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.employee_id)) out.set(r.employee_id, new Map());
    const m = out.get(r.employee_id);
    for (let d = r.from_date > from ? r.from_date : from; d <= r.to_date && d <= to; d = calc.addDays(d, 1)) {
      m.set(d, { half: r.half_day || null, typeCode: r.type_code, paid: !!r.type_paid, requestId: r.id });
    }
  }
  return out;
}

/* ─── the jobs ────────────────────────────────────────────────── */

/**
 * Monthly accrual + yearly grants + year-end expiry for one company, up to
 * `now`. Idempotent (unique period per employee + type + kind). Returns
 * { accrued, granted, expired }.
 */
function runAccruals(companyId, { now = Date.now() } = {}) {
  const settings = hr.getSettings(companyId);
  const fromMonth = settings.accrualFromMonth || calc.ppMonth(now);
  const thisMonth = calc.ppMonth(now);
  const lastComplete = calc.prevMonth(thisMonth);
  const thisYear = thisMonth.slice(0, 4);
  const db = getDb();
  const types = listTypes(companyId, { includeArchived: false }).filter((t) => t.tracksBalance || t.accrual !== 'none');
  const staff = db.prepare('SELECT id, hire_date, end_date, left_on, status FROM employees WHERE company_id = ?').all(companyId);
  const res = { accrued: 0, granted: 0, expired: 0 };
  db.transaction(() => {
    for (const e of staff) {
      const endDate = e.end_date || e.left_on || null;
      if (endDate && endDate < `${fromMonth}-01`) continue;
      for (const t of types) {
        const have = new Set(db.prepare("SELECT period FROM leave_ledger WHERE employee_id = ? AND leave_type_id = ? AND kind = 'accrual' AND period IS NOT NULL").all(e.id, t.id).map((r) => r.period));
        if (t.accrual === 'monthly') {
          for (const row of leaveCalc.monthlyAccrualsDue({ accrualDays: t.accrualDays, hireDate: e.hire_date, endDate, startMonth: fromMonth, uptoMonth: lastComplete, existingPeriods: have })) {
            if (insertLedger(db, { companyId, employeeId: e.id, leaveTypeId: t.id, date: row.date, kind: 'accrual', days: row.days, period: row.period, note: `Accrual ${row.period}`, by: null })) res.accrued += 1;
          }
        } else if (t.accrual === 'yearly') {
          for (const row of leaveCalc.yearlyGrantsDue({ accrualDays: t.accrualDays, hireDate: e.hire_date, endDate, startYear: fromMonth.slice(0, 4), uptoYear: thisYear, existingPeriods: have })) {
            if (insertLedger(db, { companyId, employeeId: e.id, leaveTypeId: t.id, date: row.date, kind: 'accrual', days: row.days, period: row.period, note: `Yearly allowance ${row.period}`, by: null })) res.granted += 1;
          }
        }
        if (t.tracksBalance && t.carryOverMax != null) {
          for (let y = Number(fromMonth.slice(0, 4)); y < Number(thisYear); y += 1) {
            const period = String(y);
            if (db.prepare("SELECT 1 FROM leave_ledger WHERE employee_id = ? AND leave_type_id = ? AND kind = 'expiry' AND period = ?").get(e.id, t.id, period)) continue;
            const bal = balanceOf(e.id, t.id, { asOf: `${y}-12-31` });
            const lapse = leaveCalc.expiryAtYearEnd({ balance: bal, carryOverMax: t.carryOverMax });
            if (lapse > 0 && insertLedger(db, { companyId, employeeId: e.id, leaveTypeId: t.id, date: `${y}-12-31`, kind: 'expiry', days: -lapse, period, note: `Over the carry-over limit of ${t.carryOverMax} day(s)`, by: null })) res.expired += 1;
          }
        }
      }
    }
  })();
  if (res.accrued || res.granted || res.expired) hrAudit('leave_ledger', companyId, 'accrual-run', { after: { ...res, upto: lastComplete } });
  return res;
}

module.exports = {
  DEFAULT_TYPES, REQUEST_STATUSES, LEDGER_KINDS,
  ensureDefaultTypes, listTypes, getType, createType, updateType,
  listLedger, balanceOf, balances, adjust,
  getRequest, createRequest, decide, cancel, listRequests, approvedLeaveByDate, countDays,
  runAccruals,
};
