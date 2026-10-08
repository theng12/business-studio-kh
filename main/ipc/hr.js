/**
 * HR1 over IPC/RPC: settings, positions, schedules, holidays, staff
 * profiles, kiosk PINs, documents and the monthly workbook
 * (docs/PEOPLE_AND_FUEL_PLAN.md §3.1, §5.1, §6; channel list in §10 "HR1 API").
 *
 * Every data channel is `expose()`d (works on this Mac, from a client Mac and
 * over /api/rpc); `hr:saveMonthWorkbook` is local (Save dialog on the Mac
 * you sit at; client mode has its own copy in main/client/index.js).
 * Reads are hr.view or hr.manage; writes hr.manage (main/util/capabilities.js).
 * Everything acts on the caller's ACTIVE company; an id from another company
 * is refused.
 */

const hr = require('../db/hr');
const people = require('../db/hrPeople');
const employees = require('../db/employees');
const { activeCompanyId, inCompany } = require('./fuelAccess');
const { forLevel, staffLevel, emitHrChange } = require('./hrAccess');

function company(requested) {
  const id = activeCompanyId(requested);
  hr.ensurePrefilled(id);
  return id;
}

function staffMember(id) { return inCompany(employees.get(id), 'Staff member'); }

/** The month workbook (bytes) — shared by the RPC channel and the local Save dialog. */
function monthWorkbook(companyId, month) {
  const attendance = require('../db/attendance');
  const leave = require('../db/leave');
  const { getDb } = require('../db/index');
  const calc = require('../util/attendanceCalc');
  const m = month || calc.ppMonth(Date.now());
  const summary = attendance.monthSummary(companyId, m, { withDays: true });
  const from = `${m}-01`;
  const to = calc.lastDayOfMonth(m);
  const byDate = leave.approvedLeaveByDate(companyId, from, to);
  const leaveTaken = new Map();
  for (const [empId, dates] of byDate) {
    const per = {};
    for (const v of dates.values()) per[v.typeCode] = (per[v.typeCode] || 0) + (v.half ? 0.5 : 1);
    leaveTaken.set(empId, per);
  }
  const companyName = getDb().prepare('SELECT name FROM companies WHERE id = ?').get(companyId)?.name;
  return require('../util/hrWorkbook').buildAttendanceWorkbook(summary, {
    companyName, leaveTaken, leaveCodes: leave.listTypes(companyId).map((t) => t.code),
  });
}

function register({ expose, exposeLocal }) {
  /* ─── settings ─── */
  expose('hr:getSettings', () => hr.getSettings(company()));
  expose('hr:updateSettings', (patch = {}) => {
    const companyId = company();
    const next = hr.updateSettings(companyId, patch || {});
    emitHrChange('settings', 'update', companyId, companyId);
    return next;
  });

  /* ─── positions ─── */
  expose('hr:listPositions', (opts = {}) => hr.listPositions(company(), opts || {}));
  expose('hr:createPosition', (input = {}) => {
    const companyId = company(input.companyId);
    const p = hr.createPosition({ ...input, companyId });
    emitHrChange('position', 'create', p.id, companyId);
    return p;
  });
  expose('hr:updatePosition', ({ id, patch } = {}) => {
    inCompany(hr.getPosition(id), 'Position');
    const p = hr.updatePosition(id, patch || {});
    emitHrChange('position', 'update', id, p.companyId);
    return p;
  });

  /* ─── schedules ─── */
  expose('hr:listSchedules', (opts = {}) => hr.listSchedules(company(), opts || {}));
  expose('hr:createSchedule', (input = {}) => {
    const companyId = company(input.companyId);
    const s = hr.createSchedule({ ...input, companyId });
    emitHrChange('schedule', 'create', s.id, companyId);
    return s;
  });
  expose('hr:updateSchedule', ({ id, patch } = {}) => {
    inCompany(hr.getSchedule(id), 'Schedule');
    const s = hr.updateSchedule(id, patch || {});
    emitHrChange('schedule', 'update', id, s.companyId);
    return s;
  });
  expose('hr:assignSchedule', ({ employeeId, scheduleId, effectiveFrom } = {}) => {
    company();
    const e = staffMember(employeeId);
    const out = hr.assignSchedule({ employeeId, scheduleId, effectiveFrom });
    emitHrChange('staff', 'update', employeeId, e.companyId);
    return out;
  });
  expose('hr:listEmployeeSchedules', (employeeId) => {
    company();
    staffMember(employeeId);
    return hr.listEmployeeSchedules(employeeId);
  });

  /* ─── holidays ─── */
  expose('hr:listHolidays', (opts = {}) => hr.listHolidays(company(), opts || {}));
  expose('hr:createHoliday', (input = {}) => {
    const companyId = company(input.companyId);
    const h = hr.createHoliday({ ...input, companyId });
    emitHrChange('holiday', 'create', h.id, companyId);
    return h;
  });
  expose('hr:updateHoliday', ({ id, patch } = {}) => {
    inCompany(hr.getHoliday(id), 'Holiday');
    const h = hr.updateHoliday(id, patch || {});
    emitHrChange('holiday', 'update', id, h.companyId);
    return h;
  });

  /* ─── profiles ─── */
  /** A staff record with its schedule history, narrowed to the caller (hr.view: no ID / bank / dob / address). */
  expose('hr:getProfile', (id) => {
    company();
    const e = staffMember(id);
    const level = staffLevel();
    return {
      ...forLevel(e, level),
      position: e.positionId ? hr.getPosition(e.positionId) : null,
      positionText: e.position,
      schedules: hr.listEmployeeSchedules(id),
      documents: level === 'full' ? people.listDocuments(id).length : undefined,
    };
  });
  expose('hr:updateProfile', ({ id, patch } = {}) => {
    company();
    const e = staffMember(id);
    const next = employees.updateHrProfile(id, patch || {});
    emitHrChange('staff', 'update', id, e.companyId);
    return next;
  });
  expose('hr:setStatus', ({ id, status, reason = null } = {}) => {
    company();
    const e = staffMember(id);
    const next = employees.setStatus(id, status, reason);
    emitHrChange('staff', 'update', id, e.companyId);
    return next;
  });

  /* ─── kiosk PINs (managers) ─── */
  expose('hr:setPin', ({ id, pin } = {}) => {
    company();
    const e = staffMember(id);
    const next = people.setPin(id, pin);
    emitHrChange('staff', 'update', id, e.companyId);
    return { id, hasPin: next.hasPin };
  });
  expose('hr:clearPin', (id) => {
    company();
    const e = staffMember(id);
    people.clearPin(id);
    emitHrChange('staff', 'update', id, e.companyId);
    return { id, hasPin: false };
  });
  expose('hr:unlockPin', (id) => {
    company();
    staffMember(id);
    people.unlockPin(id);
    return { id, locked: false };
  });

  /* ─── documents (hr.manage only — never hr.view) ─── */
  expose('hr:listDocuments', ({ employeeId, includeVoided = false } = {}) => {
    company();
    staffMember(employeeId);
    return people.listDocuments(employeeId, { includeVoided: includeVoided === true });
  });
  expose('hr:addDocument', async ({ employeeId, kind, title = null, bytes } = {}) => {
    const companyId = company();
    staffMember(employeeId);
    const doc = await people.addDocument({ companyId, employeeId, kind, title, bytes });
    emitHrChange('document', 'create', doc.id, companyId);
    return doc;
  });
  expose('hr:readDocument', async ({ id, thumb = false } = {}) => {
    company();
    const row = people.getDocumentRow(id);
    if (!row) throw new Error('Document not found');
    activeCompanyId(row.company_id);
    const out = await require('../hrPhotos').readHrFile(row.file_path, { thumb: thumb === true && row.mime !== 'application/pdf', expectedSha256: row.sha256, mime: row.mime });
    require('../db/hr').hrAudit('hr_document', id, 'read', {});
    return { bytes: out.bytes, mime: out.mime, sha256: row.sha256, intact: out.intact, kind: row.kind, title: row.title, voided: !!row.voided_at };
  });
  expose('hr:voidDocument', ({ id, reason } = {}) => {
    company();
    const row = people.getDocumentRow(id);
    if (!row) throw new Error('Document not found');
    activeCompanyId(row.company_id);
    const doc = people.voidDocument(id, reason);
    emitHrChange('document', 'void', id, row.company_id);
    return doc;
  });

  /* ─── jobs + export ─── */
  /** Run the leave accrual / year-end job and the clock-in photo retention now (the scheduler does it twice a day). */
  expose('hr:runJobs', () => {
    const companyId = company();
    const accruals = require('../db/leave').runAccruals(companyId);
    const photos = require('../hrPhotos').sweepRetention({ companyId });
    emitHrChange('leave', 'update', null, companyId);
    return { accruals, photos };
  });
  expose('hr:getMonthWorkbook', ({ month } = {}) => monthWorkbook(company(), month));
  exposeLocal('hr:saveMonthWorkbook', async ({ month } = {}) => {
    const { dialog } = require('electron');
    const { filename, bytes } = monthWorkbook(company(), month);
    const res = await dialog.showSaveDialog({ title: 'Save attendance workbook', defaultPath: filename, filters: [{ name: 'Workbook', extensions: ['xlsx'] }] });
    if (res.canceled || !res.filePath) return null;
    require('node:fs').writeFileSync(res.filePath, bytes);
    return res.filePath;
  });
}

module.exports = { register, monthWorkbook };
