/**
 * HR1 over IPC/RPC: attendance and leave (docs/PEOPLE_AND_FUEL_PLAN.md §3.2,
 * §5.1, §7b; channel list in §10 "HR1 API").
 *
 * Three kinds of caller (main/util/capabilities.js):
 *   - managers (hr.manage) and viewers (hr.view): day sheets, month
 *     summaries, the review list, corrections, overtime, lateness, leave.
 *     hr.view never gets clock-in photos (attendance:getPhoto is hr.manage).
 *   - a phone with attendance.self: clock ITSELF in/out with a selfie, its own
 *     records and requests. The person is the staff record linked to the
 *     calling account — never an id sent by the phone.
 *   - a supervisor with attendance.supervise: mark the people whose
 *     supervisor they are, with an optional photo.
 * Phone and supervisor events are accepted at once but listed for a manager
 * to review (attendance:listReview / attendance:review).
 */

const attendance = require('../db/attendance');
const leave = require('../db/leave');
const hr = require('../db/hr');
const employees = require('../db/employees');
const calc = require('../util/attendanceCalc');
const { activeCompanyId, inCompany } = require('./fuelAccess');
const { callerEmployee, tile, emitHrChange } = require('./hrAccess');

function company(requested) {
  const id = activeCompanyId(requested);
  hr.ensurePrefilled(id);
  return id;
}
function staffMember(id) { return inCompany(employees.get(id), 'Staff member'); }

function deviceLabel() {
  const { getCallerUserId } = require('../db/_util');
  const uid = getCallerUserId();
  if (!uid) return 'This Mac';
  try { return require('../db/users').get(uid)?.name || null; } catch (_) { return null; }
}

/**
 * A person's own view — the kiosk after the PIN, and the phone's "my
 * attendance": today, this month and last month (day results and totals),
 * leave balances, and their own requests still waiting. No photos, no one
 * else's data.
 */
function ownView(companyId, employeeId, { now = Date.now() } = {}) {
  const e = employees.get(employeeId);
  const thisMonth = calc.ppMonth(now);
  const lastMonth = calc.prevMonth(thisMonth);
  const cur = attendance.monthSummary(companyId, thisMonth, { employeeId, now }).rows[0] || null;
  const prev = attendance.monthSummary(companyId, lastMonth, { employeeId, now }).rows[0] || null;
  const today = cur?.days?.find((d) => d.date === calc.ppDate(now)) || null;
  const last = attendance.lastActiveEvent(employeeId);
  const pick = (r, month) => (r ? { month, totals: r.totals, days: r.days, latenessConfirmed: !!r.lateness } : { month, totals: null, days: [] });
  return {
    employee: tile(e),
    today,
    lastEvent: last ? { kind: last.kind, at: last.at, workDate: last.workDate, source: last.source } : null,
    thisMonth: pick(cur, thisMonth),
    lastMonth: pick(prev, lastMonth),
    leave: leave.balances(companyId, employeeId, { now }),
    requests: {
      leave: leave.listRequests(companyId, { employeeId, status: 'pending' }).items,
      corrections: attendance.listCorrections(companyId, { employeeId, status: 'pending' }).items,
    },
  };
}

/** The crew of the calling supervisor: active staff whose supervisor is the caller's staff record. */
function crewOf(companyId, supervisor) {
  return employees.list(companyId, { status: 'active' }).filter((e) => e.supervisorEmployeeId === supervisor.id);
}

function register({ expose }) {
  /* ─── manager / viewer: figures ─── */
  expose('attendance:day', ({ date } = {}) => attendance.daySheet(company(), date || calc.ppDate(Date.now())));
  expose('attendance:monthSummary', ({ month, employeeId = null, withDays = false } = {}) => {
    const companyId = company();
    if (employeeId) staffMember(employeeId);
    return attendance.monthSummary(companyId, month || calc.ppMonth(Date.now()), { employeeId, withDays: withDays === true });
  });
  expose('attendance:listEvents', (filters = {}) => {
    const companyId = company();
    if (filters?.employeeId) staffMember(filters.employeeId);
    return attendance.listEvents(companyId, filters || {});
  });
  /** A clock-in photo (hr.manage only — the capability rule keeps hr.view out). */
  expose('attendance:getPhoto', async ({ eventId, thumb = false } = {}) => {
    company();
    const row = attendance.getEventRow(eventId);
    if (!row) throw new Error('Attendance entry not found');
    activeCompanyId(row.company_id);
    if (!row.photo_path) return null;
    if (row.photo_retired_at) {
      const err = new Error('This photo is past its keep-for period and is in Recently deleted');
      err.code = 'PHOTO_RETIRED';
      throw err;
    }
    const out = await require('../hrPhotos').readHrFile(row.photo_path, { thumb: thumb === true, expectedSha256: row.photo_sha256 });
    return { bytes: out.bytes, mime: out.mime, sha256: row.photo_sha256, intact: out.intact, at: row.at, kind: row.kind, source: row.source };
  });

  /* ─── manager: entries, review ─── */
  expose('attendance:addManual', (input = {}) => {
    const companyId = company(input.companyId);
    staffMember(input.employeeId);
    const ev = attendance.addManual({ ...input, companyId });
    emitHrChange('attendance', 'create', ev.id, companyId);
    return ev;
  });
  expose('attendance:void', ({ id, reason } = {}) => {
    company();
    const ev = inCompany(attendance.getEvent(id), 'Attendance entry');
    const res = attendance.voidEvent(id, reason);
    emitHrChange('attendance', 'void', id, ev.companyId);
    return res;
  });
  expose('attendance:listReview', (filters = {}) => attendance.listReview(company(), filters || {}));
  /** Locked PINs and paused kiosks (also returned with attendance:listReview). */
  expose('attendance:listAlerts', ({ status = 'open', limit } = {}) => attendance.listAlerts(company(), { status, limit }));
  expose('attendance:ackAlert', ({ id } = {}) => {
    company();
    const a = inCompany(attendance.getAlert(id), 'Alert');
    const next = attendance.ackAlert(id);
    emitHrChange('alert', 'update', id, a.companyId);
    return next;
  });
  expose('attendance:review', ({ id, decision, reason = null } = {}) => {
    company();
    const ev = inCompany(attendance.getEvent(id), 'Attendance entry');
    const next = attendance.review(id, { decision, reason });
    emitHrChange('attendance', 'update', id, ev.companyId);
    return next;
  });

  /* ─── corrections ─── */
  expose('attendance:listCorrections', (filters = {}) => attendance.listCorrections(company(), filters || {}));
  expose('attendance:requestCorrection', ({ employeeId, workDate, inTime = null, outTime = null, reason } = {}) => {
    const companyId = company();
    staffMember(employeeId);
    const c = attendance.requestCorrection({ companyId, employeeId, workDate, inTime, outTime, reason, via: 'manager' });
    emitHrChange('correction', 'create', c.id, companyId);
    return c;
  });
  expose('attendance:decideCorrection', ({ id, decision, note = null, inTime, outTime } = {}) => {
    company();
    const c = inCompany(attendance.getCorrection(id), 'Correction');
    const res = attendance.decideCorrection(id, { decision, note, inTime, outTime });
    emitHrChange('correction', 'update', id, c.companyId);
    return res;
  });

  /* ─── overtime + lateness (what payroll will use) ─── */
  expose('attendance:listOvertime', (filters = {}) => attendance.listOvertime(company(), filters || {}));
  expose('attendance:approveOvertime', ({ employeeId, workDate, minutes = {}, note = null } = {}) => {
    const companyId = company();
    staffMember(employeeId);
    const r = attendance.approveOvertime({ companyId, employeeId, workDate, minutes, note });
    emitHrChange('overtime', 'create', r.id, companyId);
    return r;
  });
  expose('attendance:revokeOvertime', ({ id, reason } = {}) => {
    company();
    const r = inCompany(attendance.getOvertime(id), 'Overtime approval');
    const next = attendance.revokeOvertime(id, reason);
    emitHrChange('overtime', 'void', id, r.companyId);
    return next;
  });
  expose('attendance:listLateness', (filters = {}) => attendance.listLateness(company(), filters || {}));
  expose('attendance:confirmLateness', ({ employeeId, month, lateMinutes = null, earlyLeaveMinutes = null, note = null } = {}) => {
    const companyId = company();
    staffMember(employeeId);
    const r = attendance.confirmLateness({ companyId, employeeId, month, lateMinutes, earlyLeaveMinutes, note });
    emitHrChange('lateness', 'create', r.id, companyId);
    return r;
  });

  /* ─── my own (phone, attendance.self) ─── */
  expose('attendance:clockSelf', async ({ photo, clientRef = null, queuedForMs = null } = {}) => {
    const companyId = company();
    const me = callerEmployee(companyId);
    const res = await attendance.clock({
      companyId, employeeId: me.id, source: 'phone', photoBytes: photo, requirePhoto: true,
      deviceLabel: deviceLabel(), clientRef, queuedForMs,
    });
    if (!res.duplicate) emitHrChange('attendance', 'create', res.event.id, companyId);
    return { event: ownEvent(res.event), duplicate: res.duplicate, doubleTap: res.doubleTap };
  });
  expose('attendance:mine', () => {
    const companyId = company();
    return ownView(companyId, callerEmployee(companyId).id);
  });
  expose('attendance:requestCorrectionSelf', ({ workDate, inTime = null, outTime = null, reason } = {}) => {
    const companyId = company();
    const me = callerEmployee(companyId);
    const c = attendance.requestCorrection({ companyId, employeeId: me.id, workDate, inTime, outTime, reason, via: 'phone' });
    emitHrChange('correction', 'create', c.id, companyId);
    return c;
  });

  /* ─── supervisor (attendance.supervise) ─── */
  expose('attendance:crew', () => {
    const companyId = company();
    const me = callerEmployee(companyId);
    const today = calc.ppDate(Date.now());
    const sheet = new Map(attendance.daySheet(companyId, today).rows.map((r) => [r.employeeId, r]));
    return crewOf(companyId, me).map((e) => {
      const d = sheet.get(e.id);
      const last = attendance.lastActiveEvent(e.id);
      return { ...tile(e), today: d ? { status: d.status, firstIn: d.firstIn, lastOut: d.lastOut } : null, lastEvent: last ? { kind: last.kind, at: last.at } : null };
    });
  });
  expose('attendance:markCrew', async ({ employeeId, kind = null, photo = null, note = null, clientRef = null, queuedForMs = null } = {}) => {
    const companyId = company();
    const me = callerEmployee(companyId);
    if (employeeId === me.id) throw new Error('Clock yourself in with "Clock me in", not as your own crew');
    if (!crewOf(companyId, me).some((e) => e.id === employeeId)) throw new Error('That person is not in your crew');
    const res = await attendance.clock({
      companyId, employeeId, source: 'supervisor', photoBytes: photo, requirePhoto: false, deviceLabel: deviceLabel(),
      clientRef, queuedForMs, note, kind,
    });
    if (!res.duplicate) emitHrChange('attendance', 'create', res.event.id, companyId);
    return { event: ownEvent(res.event), duplicate: res.duplicate, doubleTap: res.doubleTap };
  });

  /* ─── leave: manager / viewer ─── */
  expose('leave:listTypes', (opts = {}) => leave.listTypes(company(), opts || {}));
  expose('leave:createType', (input = {}) => {
    const companyId = company(input.companyId);
    const t = leave.createType({ ...input, companyId });
    emitHrChange('leaveType', 'create', t.id, companyId);
    return t;
  });
  expose('leave:updateType', ({ id, patch } = {}) => {
    company();
    inCompany(leave.getType(id), 'Leave type');
    const t = leave.updateType(id, patch || {});
    emitHrChange('leaveType', 'update', id, t.companyId);
    return t;
  });
  expose('leave:balances', ({ employeeId } = {}) => {
    const companyId = company();
    staffMember(employeeId);
    return leave.balances(companyId, employeeId);
  });
  expose('leave:ledger', ({ employeeId, leaveTypeId = null, limit } = {}) => {
    company();
    staffMember(employeeId);
    return leave.listLedger(employeeId, { leaveTypeId, limit });
  });
  expose('leave:listRequests', (filters = {}) => {
    const companyId = company();
    if (filters?.employeeId) staffMember(filters.employeeId);
    return leave.listRequests(companyId, filters || {});
  });
  expose('leave:request', ({ employeeId, leaveTypeId, fromDate, toDate = null, halfDay = null, reason = null } = {}) => {
    const companyId = company();
    staffMember(employeeId);
    const r = leave.createRequest({ companyId, employeeId, leaveTypeId, fromDate, toDate, halfDay, reason, via: 'manager' });
    emitHrChange('leave', 'create', r.id, companyId);
    return r;
  });
  expose('leave:decide', ({ id, decision, note = null, allowNegative = false } = {}) => {
    company();
    const r = inCompany(leave.getRequest(id), 'Leave request');
    const next = leave.decide(id, { decision, note, allowNegative: allowNegative === true });
    emitHrChange('leave', 'update', id, r.companyId);
    return next;
  });
  expose('leave:cancel', ({ id, reason = null } = {}) => {
    company();
    const r = inCompany(leave.getRequest(id), 'Leave request');
    const next = leave.cancel(id, { reason });
    emitHrChange('leave', 'update', id, r.companyId);
    return next;
  });
  expose('leave:adjust', ({ employeeId, leaveTypeId, days, date = null, note } = {}) => {
    const companyId = company();
    staffMember(employeeId);
    const res = leave.adjust({ companyId, employeeId, leaveTypeId, days, date, note });
    emitHrChange('leave', 'update', employeeId, companyId);
    return res;
  });

  /* ─── leave: my own (phone) ─── */
  expose('leave:requestSelf', ({ leaveTypeId, fromDate, toDate = null, halfDay = null, reason = null } = {}) => {
    const companyId = company();
    const me = callerEmployee(companyId);
    const r = leave.createRequest({ companyId, employeeId: me.id, leaveTypeId, fromDate, toDate, halfDay, reason, via: 'phone' });
    emitHrChange('leave', 'create', r.id, companyId);
    return r;
  });
  expose('leave:cancelSelf', ({ id, reason = null } = {}) => {
    const companyId = company();
    const me = callerEmployee(companyId);
    const r = inCompany(leave.getRequest(id), 'Leave request');
    if (r.employeeId !== me.id) throw new Error('You can only withdraw your own requests');
    const next = leave.cancel(id, { reason, onlyPending: true });
    emitHrChange('leave', 'update', id, companyId);
    return next;
  });
}

/** What the phone / supervisor gets back about an event: no review notes, no photo path. */
function ownEvent(e) {
  return { id: e.id, employeeId: e.employeeId, kind: e.kind, at: e.at, workDate: e.workDate, source: e.source, queuedForMs: e.queuedForMs, hasPhoto: e.hasPhoto, reviewStatus: e.reviewStatus };
}

module.exports = { register, ownView, ownEvent, crewOf };
