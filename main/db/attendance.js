/**
 * HR1: attendance — clock events, corrections, the review list, overtime
 * approvals, lateness confirmations and the computed day / month figures
 * (docs/PEOPLE_AND_FUEL_PLAN.md §3.2, §5.1, §5.2, §7b).
 *
 * Rules that hold for every function here:
 *   - **Never DELETE, never edit an event.** A wrong event is voided with a
 *     reason; a correction adds a NEW event whose supersedes_event_id names
 *     the one it replaces. "Active" = not voided and not superseded by an
 *     active event.
 *   - **The server clock decides the time** of every kiosk, phone and
 *     supervisor event. A phone that waited offline sends `queuedForMs`; the
 *     wait is capped (phoneQueueMaxHours) and the event never lands at or
 *     before the person's previous event. Only a manager's manual entry
 *     (`addManual`, with a reason) chooses a time.
 *   - **In or out is decided by the server** from the person's last event
 *     (main/util/attendanceCalc.js decideKind); a second tap within
 *     doubleTapMinutes returns the first event instead of adding one.
 *   - **Phone and supervisor events are accepted but listed for review**
 *     (review_status 'pending'); rejecting one voids it with the reason.
 *   - `client_ref` (+ a hash of what was sent) makes a phone upload
 *     idempotent, exactly as for fuel records.
 *   - Every write is audited with sensitivity 'hr'.
 */

const { getDb } = require('./index');
const { uuid, str, badRequest, getCallerUserId } = require('./_fuelUtil');
const calc = require('../util/attendanceCalc');
const hr = require('./hr');
const employees = require('./employees');

const SOURCES = ['kiosk', 'phone', 'supervisor', 'manual', 'correction'];
const REVIEW_SOURCES = new Set(['phone', 'supervisor']);
const FUTURE_SLACK_MS = 5 * 60 * 1000;

function hrAudit(entityType, entityId, action, payload) { hr.hrAudit(entityType, entityId, action, payload); }

/* ─── rows ────────────────────────────────────────────────────── */

const ACTIVE_SQL = `e.voided_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM attendance_events s WHERE s.supersedes_event_id = e.id AND s.voided_at IS NULL)`;

function rowToEvent(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, employeeId: r.employee_id, kind: r.kind, at: r.at, workDate: r.work_date, source: r.source,
    recordedByUserId: r.recorded_by_user_id ?? null, deviceLabel: r.device_label ?? null,
    hasPhoto: !!r.photo_path && !r.photo_retired_at, photoRetired: !!r.photo_retired_at,
    supersedesEventId: r.supersedes_event_id ?? null, correctionId: r.correction_id ?? null, note: r.note ?? null,
    queuedForMs: r.queued_for_ms ?? null, reviewStatus: r.review_status, reviewedByUserId: r.reviewed_by_user_id ?? null,
    reviewedAt: r.reviewed_at ?? null, reviewNote: r.review_note ?? null,
    voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null, createdAt: r.created_at,
  };
}

function getEvent(id) { return rowToEvent(getDb().prepare('SELECT * FROM attendance_events WHERE id = ?').get(id)); }
function getEventRow(id) { return getDb().prepare('SELECT * FROM attendance_events WHERE id = ?').get(id); }

function lastActiveEvent(employeeId, { before = null } = {}) {
  return rowToEvent(getDb().prepare(`SELECT * FROM attendance_events e WHERE e.employee_id = ? AND ${ACTIVE_SQL}
     ${before != null ? 'AND e.at < ?' : ''} ORDER BY e.at DESC LIMIT 1`).get(...(before != null ? [employeeId, before] : [employeeId])));
}

/** Active events by employee for work dates in [from, to]. */
/**
 * A phone / supervisor entry that waited offline longer than
 * queuedReviewMinutes is HELD: it stays in the review list and counts for
 * nothing until a manager accepts it (review fix L5).
 */
function heldSql(companyId) {
  const ms = hr.getSettings(companyId).queuedReviewMinutes * 60 * 1000;
  return `NOT (e.review_status = 'pending' AND COALESCE(e.queued_for_ms, 0) > ${Math.floor(ms)})`;
}
function isHeld(ev, settings) {
  return ev.reviewStatus === 'pending' && (ev.queuedForMs || 0) > settings.queuedReviewMinutes * 60 * 1000;
}

/** Active, counted events by employee for work dates in [from, to]. */
function activeEventsByEmployee(companyId, from, to, employeeIds = null) {
  const params = [companyId, from, to];
  let extra = '';
  if (employeeIds && employeeIds.length) { extra = `AND e.employee_id IN (${employeeIds.map(() => '?').join(',')})`; params.push(...employeeIds); }
  const rows = getDb().prepare(`SELECT * FROM attendance_events e WHERE e.company_id = ? AND e.work_date >= ? AND e.work_date <= ? ${extra} AND ${ACTIVE_SQL} AND ${heldSql(companyId)} ORDER BY e.at`).all(...params);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.employee_id)) out.set(r.employee_id, new Map());
    const m = out.get(r.employee_id);
    if (!m.has(r.work_date)) m.set(r.work_date, []);
    m.get(r.work_date).push(rowToEvent(r));
  }
  return out;
}

/* ─── client_ref (phone retries) ──────────────────────────────── */

function payloadHash(parts) {
  return require('node:crypto').createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A saved event for this ref: same content → it (duplicate); different → conflict. */
function existingForRef(clientRef, hash) {
  if (!clientRef) return null;
  const row = getDb().prepare('SELECT * FROM attendance_events WHERE client_ref = ?').get(clientRef);
  if (!row) return null;
  if (row.client_ref_hash && hash && row.client_ref_hash !== hash) {
    const err = new Error('That record reference was already used for a different entry. Start a new entry instead of resending this one.');
    err.code = 'CLIENT_REF_CONFLICT';
    throw err;
  }
  return row;
}

/**
 * A phone request (correction, leave) already saved under this client_ref:
 * same content from the same account → that row (a resend); different
 * content, or another account → a plain conflict. Null when the ref is new.
 */
function requestForRef(table, clientRef, hash) {
  if (!clientRef) return null;
  const row = getDb().prepare(`SELECT * FROM ${table} WHERE client_ref = ?`).get(clientRef);
  if (!row) return null;
  if ((row.requested_by_user_id ?? null) !== (getCallerUserId() ?? null)) {
    const err = new Error('That record reference was already used by someone else. Start a new request.');
    err.code = 'CLIENT_REF_CONFLICT';
    throw err;
  }
  if (row.client_ref_hash && row.client_ref_hash !== hash) {
    const err = new Error('That record reference was already used for a different request. Start a new request instead of resending this one.');
    err.code = 'CLIENT_REF_CONFLICT';
    throw err;
  }
  return row;
}

/* ─── approvals that the attendance moved under (review fix M2) ── */

/**
 * The attendance of (employee, work date) changed. An overtime approval for
 * that day and a lateness confirmation for that month are NOT voided — they
 * are marked `needsReapproval` with the reason, and summaries already only use
 * min(approved, computed) / min(confirmed, computed). Re-approving clears it.
 */
function touchDate(employeeId, workDate, reason) {
  if (!employeeId || !calc.isDate(workDate)) return;
  const db = getDb();
  const now = Date.now();
  const r = str(reason, 300);
  const a = db.prepare(`UPDATE overtime_approvals SET needs_reapproval = 1, needs_reapproval_reason = ?, needs_reapproval_at = ?
     WHERE employee_id = ? AND work_date = ? AND voided_at IS NULL`).run(r, now, employeeId, workDate);
  const b = db.prepare(`UPDATE lateness_confirmations SET needs_reapproval = 1, needs_reapproval_reason = ?, needs_reapproval_at = ?
     WHERE employee_id = ? AND month = ? AND voided_at IS NULL`).run(r, now, employeeId, workDate.slice(0, 7));
  if (a.changes || b.changes) hrAudit('attendance', employeeId, 'needs-reapproval', { after: { workDate, reason: r, overtime: a.changes, lateness: b.changes } });
}

/* ─── alerts (locked PINs, a paused kiosk) ───────────────────── */

function rowToAlert(r) {
  return {
    id: r.id, companyId: r.company_id, employeeId: r.employee_id, kind: r.kind, at: r.at, kioskUserId: r.kiosk_user_id, message: r.message,
    details: r.details_json ? JSON.parse(r.details_json) : null, status: r.status, seenByUserId: r.seen_by_user_id, seenAt: r.seen_at,
  };
}
function addAlert({ companyId, employeeId = null, kind, kioskUserId = null, message, details = null }) {
  const id = uuid();
  getDb().prepare('INSERT INTO attendance_alerts (id, company_id, employee_id, kind, at, kiosk_user_id, message, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, companyId, employeeId, kind, Date.now(), kioskUserId, str(message, 500), details ? JSON.stringify(details) : null);
  hrAudit('attendance_alert', id, kind, { after: { employeeId, message: str(message, 500) } });
  // HR1 review: a locked PIN or a paused kiosk reaches Review, the People badge
  // and the Staff list live (ids only). Lazy require: ipc/hrAccess loads db modules.
  try {
    const { emitHrChange } = require('../ipc/hrAccess');
    emitHrChange('alert', 'create', id, companyId);
    if (employeeId) emitHrChange('staff', 'update', employeeId, companyId);
  } catch (_) { /* best effort */ }
  return id;
}
function listAlerts(companyId, { status = 'open', limit = 200 } = {}) {
  const where = ['company_id = ?'];
  const params = [companyId];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  return getDb().prepare(`SELECT * FROM attendance_alerts WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ${Math.min(Math.max(1, Number(limit) || 200), 1000)}`)
    .all(...params).map(rowToAlert);
}
function getAlert(id) { const r = getDb().prepare('SELECT * FROM attendance_alerts WHERE id = ?').get(id); return r ? rowToAlert(r) : null; }
function ackAlert(id) {
  const a = getAlert(id);
  if (!a) throw badRequest('Alert not found');
  if (a.status === 'seen') return a;
  getDb().prepare("UPDATE attendance_alerts SET status = 'seen', seen_by_user_id = ?, seen_at = ? WHERE id = ?").run(getCallerUserId(), Date.now(), id);
  hrAudit('attendance_alert', id, 'seen', {});
  return getAlert(id);
}

/* ─── clocking (kiosk, phone, supervisor) ─────────────────────── */

/** A client_ref retry is answered only to the account that saved it. */
function refRepeat(event, uid) {
  if ((event.recordedByUserId ?? null) !== (uid ?? null)) {
    const err = new Error('That record reference was already used by someone else. Start a new entry.');
    err.code = 'CLIENT_REF_CONFLICT';
    throw err;
  }
  return { event, duplicate: true, doubleTap: false, refRepeat: true };
}

function activeEmployeeIn(companyId, employeeId) {
  const e = employees.get(employeeId);
  if (!e || e.companyId !== companyId) throw badRequest('That person is not on this company\'s staff list');
  if (e.status !== 'active') throw badRequest(`${e.nameEn || e.nameKm || e.staffCode} is ${e.status === 'left' ? 'no longer on the staff list' : 'suspended'} and cannot clock in or out`);
  return e;
}

/**
 * Clock someone in or out "now".
 * @returns {Promise<{ event, duplicate, doubleTap }>}
 */
async function clock({
  companyId, employeeId, source, photoBytes = null, requirePhoto = false, deviceLabel = null,
  clientRef = null, queuedForMs = null, note = null, kind: explicitKind = null,
  // HR1 kiosk: a clock-in a manager allowed without the camera waits in the review list.
  reviewRequired = false,
}) {
  if (!SOURCES.includes(source) || source === 'manual' || source === 'correction') throw badRequest('source must be kiosk, phone or supervisor');
  if (explicitKind != null && !['in', 'out'].includes(explicitKind)) throw badRequest('kind must be in or out');
  const uid = getCallerUserId();
  // A retry resends the same bytes, so the photo's own hash is part of "the same entry";
  // queuedForMs is left out (it grows while a record waits to be resent).
  const photoSha = photoBytes ? require('node:crypto').createHash('sha256').update(require('../fuelPhotos').toBuffer(photoBytes)).digest('hex') : null;
  const hash = clientRef ? payloadHash({ employeeId, source, kind: explicitKind, note: note ?? null, photo: photoSha }) : null;
  const dupRow = existingForRef(clientRef, hash);
  if (dupRow) return refRepeat(rowToEvent(dupRow), uid);

  const emp = activeEmployeeIn(companyId, employeeId);
  if (requirePhoto && !photoBytes) throw badRequest('A photo is needed to clock in or out');
  const settings = hr.getSettings(companyId);
  const id = uuid();
  const staged = photoBytes ? await require('../hrPhotos').stageClockPhoto({ eventId: id, at: Date.now(), bytes: photoBytes }) : null;

  const db = getDb();
  let result;
  try {
    result = db.transaction(() => {
      // Everything from here is synchronous: two taps cannot interleave.
      const again = existingForRef(clientRef, hash);
      if (again) return { event: rowToEvent(again), duplicate: true, doubleTap: false, refRepeat: true };
      const now = Date.now();
      const last = lastActiveEvent(emp.id);
      const queued = REVIEW_SOURCES.has(source) ? calc.queuedTime({ now, queuedForMs, floor: last?.at ?? null, settings }) : { at: now, queuedForMs: null };
      const at = queued.at;
      if (calc.isDoubleTap(last, at, settings) && (!explicitKind || explicitKind === last.kind)) {
        return { event: last, duplicate: true, doubleTap: true };
      }
      const schedule = hr.scheduleResolver(companyId)(emp.id, calc.ppDate(at));
      const auto = calc.decideKind({ lastEvent: last, now: at, schedule, settings });
      const kind = explicitKind || auto.kind;
      const workDate = kind === auto.kind ? auto.workDate : calc.ppDate(at);
      // A day shift closed after midnight (07:00 → 00:30) is kept but listed for review.
      const lateClose = kind === auto.kind && auto.flag === 'late_close';
      const flagNote = lateClose ? `Closes the shift of ${workDate} after midnight — check it` : null;
      db.prepare(`INSERT INTO attendance_events (id, company_id, employee_id, kind, at, work_date, source, recorded_by_user_id, device_label,
          photo_path, photo_sha256, note, queued_for_ms, client_ref, client_ref_hash, review_status, created_at)
        VALUES (@id, @companyId, @employeeId, @kind, @at, @workDate, @source, @uid, @deviceLabel, @photoPath, @photoSha, @note, @queued, @clientRef, @hash, @review, @now)`)
        .run({
          id, companyId, employeeId: emp.id, kind, at, workDate, source, uid, deviceLabel: str(deviceLabel, 120),
          photoPath: staged?.relPath ?? null, photoSha: staged?.sha256 ?? null, note: str([note, flagNote].filter(Boolean).join(' · '), 500), queued: queued.queuedForMs,
          clientRef, hash, review: REVIEW_SOURCES.has(source) || lateClose || reviewRequired ? 'pending' : 'none', now,
        });
      return { event: getEvent(id), duplicate: false, doubleTap: false };
    })();
  } catch (err) {
    staged?.abort();
    throw err;
  }
  if (result.duplicate) {
    staged?.abort();
    return result.refRepeat ? refRepeat(result.event, uid) : result;
  }
  staged?.commit();
  if (result.event.workDate !== calc.ppDate(Date.now())) touchDate(emp.id, result.event.workDate, `A ${source} entry was added for ${result.event.workDate}`);
  hrAudit('attendance', result.event.id, 'clock', {
    after: { employeeId: emp.id, kind: result.event.kind, at: result.event.at, workDate: result.event.workDate, source, photo: !!staged, queuedForMs: result.event.queuedForMs },
  });
  return result;
}

/* ─── manager entries ─────────────────────────────────────────── */

/** A manager adds an event with its own time (paper sheet, broken kiosk). Reason required. */
function addManual({ companyId, employeeId, kind, at, workDate = null, reason }) {
  const emp = employees.get(employeeId);
  if (!emp || emp.companyId !== companyId) throw badRequest('Staff member not found');
  if (!['in', 'out'].includes(kind)) throw badRequest('kind must be in or out');
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) throw badRequest('at must be a time in milliseconds');
  if (t > Date.now() + FUTURE_SLACK_MS) throw badRequest('That time is in the future');
  if (!str(reason, 500)) throw badRequest('Say why the entry is added by hand');
  let wd = workDate;
  if (wd != null && !calc.isDate(wd)) throw badRequest('workDate must be a real date');
  if (!wd) {
    const settings = hr.getSettings(companyId);
    const before = lastActiveEvent(emp.id, { before: t });
    const schedule = hr.scheduleResolver(companyId)(emp.id, calc.ppDate(t));
    const auto = calc.decideKind({ lastEvent: before, now: t, schedule, settings });
    wd = kind === auto.kind ? auto.workDate : calc.ppDate(t);
  }
  const id = uuid();
  getDb().prepare(`INSERT INTO attendance_events (id, company_id, employee_id, kind, at, work_date, source, recorded_by_user_id, note, review_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, 'none', ?)`).run(id, companyId, emp.id, kind, t, wd, getCallerUserId(), str(reason, 500), Date.now());
  hrAudit('attendance', id, 'manual', { after: { employeeId: emp.id, kind, at: t, workDate: wd, reason: str(reason, 500) } });
  touchDate(emp.id, wd, `Entry added by hand: ${str(reason, 200)}`);
  return getEvent(id);
}

function voidEvent(id, reason) {
  const e = getEvent(id);
  if (!e) throw badRequest('Attendance entry not found');
  if (e.voided) return { event: e, already: true };
  if (!str(reason, 500)) throw badRequest('Say why the entry is voided');
  getDb().prepare('UPDATE attendance_events SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(Date.now(), str(reason, 500), getCallerUserId(), id);
  hrAudit('attendance', id, 'void', { before: { voided: false }, after: { voided: true, reason: str(reason, 500) } });
  touchDate(e.employeeId, e.workDate, `An entry was voided: ${str(reason, 200)}`);
  return { event: getEvent(id), already: false };
}

/* ─── review list (phone + supervisor) ────────────────────────── */

/**
 * `order` (verification, 2026-10-08): 'oldest' / 'newest', or 'attention' —
 * held entries first, then entries flagged for a check (not a phone or
 * supervisor mark, e.g. a day shift closed after midnight), then newest
 * first, so a fresh held entry is never on page 2. Default as before: pending
 * oldest first, anything else newest first.
 */
function listReview(companyId, { status = 'pending', source = null, employeeId = null, from = null, to = null, limit = 100, offset = 0, order = null } = {}) {
  // Phone and supervisor entries, and any other entry flagged for review (a day shift closed after midnight).
  const where = ['e.company_id = @companyId', "e.review_status <> 'none'"];
  const params = { companyId };
  if (status && status !== 'all') {
    if (!['pending', 'accepted', 'rejected'].includes(status)) throw badRequest('status must be pending, accepted, rejected or all');
    where.push('e.review_status = @status'); params.status = status;
  }
  if (source) { if (!SOURCES.includes(source)) throw badRequest('source must be kiosk, phone, supervisor, manual or correction'); where.push('e.source = @source'); params.source = source; }
  if (employeeId) { where.push('e.employee_id = @employeeId'); params.employeeId = employeeId; }
  if (from != null) { where.push('e.at >= @from'); params.from = Number(from); }
  if (to != null) { where.push('e.at < @to'); params.to = Number(to); }
  const lim = Math.min(Math.max(1, Number(limit) || 100), 500);
  const off = Math.max(0, Number(offset) || 0);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM attendance_events e WHERE ${where.join(' AND ')}`).get(params).n;
  // Like fuel's Q1: an entry that waited on the phone longer than queuedReviewMinutes
  // is pointed out — and, while pending, HELD out of every figure (review fix L5).
  const settings = hr.getSettings(companyId);
  const longMs = settings.queuedReviewMinutes * 60 * 1000;
  if (order != null && !['attention', 'oldest', 'newest'].includes(order)) throw badRequest('order must be attention, oldest or newest');
  const orderSql = order === 'attention'
    ? `(e.review_status = 'pending' AND COALESCE(e.queued_for_ms, 0) > ${Math.floor(longMs)}) DESC, (e.source NOT IN ('phone', 'supervisor')) DESC, e.at DESC`
    : `e.at ${(order || (status === 'pending' ? 'oldest' : 'newest')) === 'oldest' ? 'ASC' : 'DESC'}`;
  const items = db.prepare(`SELECT * FROM attendance_events e WHERE ${where.join(' AND ')} ORDER BY ${orderSql} LIMIT ${lim} OFFSET ${off}`)
    .all(params).map(rowToEvent).map((ev) => {
      const queuedLong = ev.queuedForMs != null && ev.queuedForMs > longMs;
      const held = isHeld(ev, settings);
      const mins = Math.round((ev.queuedForMs || 0) / 60000);
      const waited = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
      const explanation = held
        ? `Sent ${waited} after it was taken (the phone had no signal). The time is the arrival time minus that wait. It is not counted until you accept it.`
        : ev.source === 'phone' ? 'Clocked on the person\'s own phone with a selfie. Counted; check the photo.'
          : ev.source === 'supervisor' ? 'Marked by the supervisor away from the shop. Counted; check it.'
            : ev.note || 'Flagged for a check. Counted.';
      return { ...ev, queuedLong, held, explanation };
    });
  // Alerts that are not clock entries (a PIN that locked, a kiosk that paused) come with the list.
  return { items, total, alerts: status === 'pending' || status == null ? listAlerts(companyId, { status: 'open', limit: 100 }) : [] };
}

function review(id, { decision, reason = null } = {}) {
  const e = getEvent(id);
  if (!e) throw badRequest('Attendance entry not found');
  if (!['accept', 'reject'].includes(decision)) throw badRequest('decision must be accept or reject');
  if (e.reviewStatus === 'none') throw badRequest('This entry is not waiting for review');
  if (e.reviewStatus !== 'pending') throw badRequest(`This entry was already ${e.reviewStatus}`);
  const now = Date.now();
  const uid = getCallerUserId();
  if (decision === 'reject') {
    if (!str(reason, 500)) throw badRequest('Say why the entry is rejected');
    getDb().prepare(`UPDATE attendance_events SET review_status = 'rejected', reviewed_by_user_id = ?, reviewed_at = ?, review_note = ?,
        voided_at = COALESCE(voided_at, ?), void_reason = COALESCE(void_reason, ?), voided_by_user_id = COALESCE(voided_by_user_id, ?) WHERE id = ?`)
      .run(uid, now, str(reason, 500), now, `Rejected on review: ${str(reason, 450)}`, uid, id);
  } else {
    getDb().prepare(`UPDATE attendance_events SET review_status = 'accepted', reviewed_by_user_id = ?, reviewed_at = ?, review_note = ? WHERE id = ?`)
      .run(uid, now, str(reason, 500), id);
  }
  // Rejecting removes it from the figures; accepting a HELD entry adds it.
  if (decision === 'reject' || isHeld(e, hr.getSettings(e.companyId))) touchDate(e.employeeId, e.workDate, `A ${e.source} entry was ${decision}ed on review`);
  hrAudit('attendance', id, `review:${decision}`, { before: { reviewStatus: 'pending' }, after: { reviewStatus: decision === 'accept' ? 'accepted' : 'rejected', reason: str(reason, 500) } });
  return getEvent(id);
}

function listEvents(companyId, { employeeId = null, from = null, to = null, includeVoided = false, limit = 500, offset = 0 } = {}) {
  const where = ['e.company_id = @companyId'];
  const params = { companyId };
  if (employeeId) { where.push('e.employee_id = @employeeId'); params.employeeId = employeeId; }
  if (from) { where.push('e.work_date >= @from'); params.from = from; }
  if (to) { where.push('e.work_date <= @to'); params.to = to; }
  if (!includeVoided) where.push('e.voided_at IS NULL');
  const lim = Math.min(Math.max(1, Number(limit) || 500), 2000);
  const off = Math.max(0, Number(offset) || 0);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM attendance_events e WHERE ${where.join(' AND ')}`).get(params).n;
  const items = db.prepare(`SELECT e.*, (SELECT s.id FROM attendance_events s WHERE s.supersedes_event_id = e.id AND s.voided_at IS NULL LIMIT 1) AS superseded_by
      FROM attendance_events e WHERE ${where.join(' AND ')} ORDER BY e.at DESC LIMIT ${lim} OFFSET ${off}`)
    .all(params).map((r) => ({ ...rowToEvent(r), supersededById: r.superseded_by ?? null }));
  return { items, total };
}

/* ─── corrections ─────────────────────────────────────────────── */

function rowToCorrection(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, employeeId: r.employee_id, workDate: r.work_date, proposedInAt: r.proposed_in_at, proposedOutAt: r.proposed_out_at,
    reason: r.reason, requestedByUserId: r.requested_by_user_id, requestedVia: r.requested_via, status: r.status,
    decidedByUserId: r.decided_by_user_id, decidedAt: r.decided_at, decisionNote: r.decision_note,
    resultingInEventId: r.resulting_in_event_id, resultingOutEventId: r.resulting_out_event_id, createdAt: r.created_at,
  };
}
function getCorrection(id) { return rowToCorrection(getDb().prepare('SELECT * FROM attendance_corrections WHERE id = ?').get(id)); }

/**
 * 'HH:MM' on a work date → ms. An out time is placed AFTER the day's in: the
 * proposed in, else `anchorIn` (the work date's active in, or the scheduled
 * start of a shift that crosses midnight) — so "out 06:10" for a night shift
 * that began at 22:00 lands the next morning (review fix M3).
 */
function proposedTimes(workDate, inTime, outTime, { anchorIn = null } = {}) {
  const inAt = inTime ? calc.timeOnDate(workDate, inTime) : null;
  if (inTime && inAt == null) throw badRequest('inTime must be a time like 07:30');
  const outAt = outTime ? calc.timeOnDate(workDate, outTime, { after: inAt ?? anchorIn }) : null;
  if (outTime && outAt == null) throw badRequest('outTime must be a time like 17:05');
  if (inAt == null && outAt == null) throw badRequest('Give the time you came in, the time you left, or both');
  if (Math.max(inAt ?? 0, outAt ?? 0) > Date.now() + FUTURE_SLACK_MS) throw badRequest('That time is in the future');
  return { inAt, outAt };
}

/** The in an out-only correction follows: the work date's latest active in, else a night shift's scheduled start. */
function anchorInFor(companyId, employeeId, workDate) {
  // The open (latest) in: with a closed pair and a later open in, the missing out follows that one.
  const row = getDb().prepare(`SELECT at FROM attendance_events e WHERE e.employee_id = ? AND e.work_date = ? AND e.kind = 'in' AND ${ACTIVE_SQL} ORDER BY e.at DESC LIMIT 1`).get(employeeId, workDate);
  if (row) return row.at;
  const schedule = hr.scheduleResolver(companyId)(employeeId, workDate);
  return calc.crossesMidnight(schedule) ? calc.scheduledWindow(schedule, workDate).start : null;
}

/**
 * "I forgot to clock out" — a REQUEST, never an event. A manager approves it
 * (decideCorrection), which is when events are added.
 */
function requestCorrection({ companyId, employeeId, workDate, inTime = null, outTime = null, reason, via, clientRef = null }) {
  // A resend from the phone's outbox returns the request it already made
  // (checked first: the "already waiting for that day" rule would refuse it).
  const hash = clientRef ? payloadHash({ employeeId, workDate, inTime: inTime || null, outTime: outTime || null, reason: str(reason, 500) }) : null;
  const again = requestForRef('attendance_corrections', clientRef, hash);
  if (again) return { ...rowToCorrection(again), duplicate: true };
  const emp = employees.get(employeeId);
  if (!emp || emp.companyId !== companyId) throw badRequest('Staff member not found');
  if (!calc.isDate(workDate)) throw badRequest('workDate must be a real date like 2026-10-08');
  if (workDate > calc.ppDate(Date.now())) throw badRequest('That day has not happened yet');
  if (!str(reason, 500)) throw badRequest('Say what needs correcting');
  const { inAt, outAt } = proposedTimes(workDate, inTime, outTime, { anchorIn: anchorInFor(companyId, employeeId, workDate) });
  const db = getDb();
  if (db.prepare("SELECT 1 FROM attendance_corrections WHERE employee_id = ? AND work_date = ? AND status = 'pending'").get(employeeId, workDate)) {
    throw badRequest('There is already a correction waiting for that day');
  }
  const id = uuid();
  db.prepare(`INSERT INTO attendance_corrections (id, company_id, employee_id, work_date, proposed_in_at, proposed_out_at, reason, requested_by_user_id, requested_via, status, created_at, client_ref, client_ref_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, companyId, employeeId, workDate, inAt, outAt, str(reason, 500), getCallerUserId(), via, Date.now(), clientRef, hash);
  hrAudit('attendance_correction', id, 'request', { after: { employeeId, workDate, proposedInAt: inAt, proposedOutAt: outAt, via } });
  return getCorrection(id);
}

/** Approve (events are added, superseding any of the same kind that day) or reject. */
function decideCorrection(id, { decision, note = null, inTime, outTime } = {}) {
  const c = getCorrection(id);
  if (!c) throw badRequest('Correction not found');
  if (c.status !== 'pending') throw badRequest(`This correction is already ${c.status}`);
  if (!['approve', 'reject'].includes(decision)) throw badRequest('decision must be approve or reject');
  const db = getDb();
  const now = Date.now();
  const uid = getCallerUserId();
  if (decision === 'reject') {
    if (!str(note, 500)) throw badRequest('Say why the correction is rejected');
    db.prepare("UPDATE attendance_corrections SET status = 'rejected', decided_by_user_id = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(uid, now, str(note, 500), id);
    hrAudit('attendance_correction', id, 'reject', { before: { status: 'pending' }, after: { status: 'rejected', note: str(note, 500) } });
    return { correction: getCorrection(id), events: [] };
  }
  // A manager may adjust the proposed times while approving: a time left out
  // (undefined) keeps the proposal, 'HH:MM' replaces it, and null REMOVES it
  // (HR1 review fix L2 — e.g. approve only the forgotten clock-out). At least
  // one time must remain; to change nothing, reject instead.
  let { proposedInAt: inAt, proposedOutAt: outAt } = c;
  if (inTime !== undefined || outTime !== undefined) {
    const newIn = inTime === undefined ? inAt : (inTime ? calc.timeOnDate(c.workDate, inTime) : null);
    if (inTime && newIn == null) throw badRequest('inTime must be a time like 07:30');
    let newOut = outAt;
    if (outTime !== undefined) {
      newOut = outTime ? calc.timeOnDate(c.workDate, outTime, { after: newIn ?? anchorInFor(c.companyId, c.employeeId, c.workDate) }) : null;
      if (outTime && newOut == null) throw badRequest('outTime must be a time like 17:05');
    }
    if (newIn == null && newOut == null) throw badRequest('Keep a clock-in or a clock-out time — to change nothing, reject the request');
    if (Math.max(newIn ?? 0, newOut ?? 0) > Date.now() + FUTURE_SLACK_MS) throw badRequest('That time is in the future');
    inAt = newIn;
    outAt = newOut;
    if (inAt != null && outAt != null && outAt <= inAt) throw badRequest('The out time must be after the in time');
  }
  const events = [];
  db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM attendance_events e WHERE e.employee_id = ? AND e.work_date = ? AND ${ACTIVE_SQL} ORDER BY e.at`).all(c.employeeId, c.workDate);
    // Supersede only an entry the correction really replaces: an `out` replaces
    // the day's last entry when that is an out (a wrong clock-out time); when
    // the last entry is an `in` (forgotten clock-out) the out is ADDED — never
    // replacing an earlier pair's out. Mirror for `in`: replace the first entry
    // only when it is an in; before a leading orphan out it is added.
    const first = existing[0] || null;
    const last = existing[existing.length - 1] || null;
    const replaces = { in: first && first.kind === 'in' ? first : null, out: last && last.kind === 'out' ? last : null };
    const add = (kind, at) => {
      const replaced = replaces[kind];
      const evId = uuid();
      db.prepare(`INSERT INTO attendance_events (id, company_id, employee_id, kind, at, work_date, source, recorded_by_user_id, supersedes_event_id, correction_id, note, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'correction', ?, ?, ?, ?, 'none', ?)`).run(evId, c.companyId, c.employeeId, kind, at, c.workDate, uid, replaced?.id ?? null, id, c.reason, now);
      events.push(getEvent(evId));
      return evId;
    };
    const inId = inAt != null ? add('in', inAt) : null;
    const outId = outAt != null ? add('out', outAt) : null;
    db.prepare(`UPDATE attendance_corrections SET status = 'approved', decided_by_user_id = ?, decided_at = ?, decision_note = ?, resulting_in_event_id = ?, resulting_out_event_id = ?,
        proposed_in_at = ?, proposed_out_at = ? WHERE id = ?`).run(uid, now, str(note, 500), inId, outId, inAt, outAt, id);
  })();
  touchDate(c.employeeId, c.workDate, 'A correction was approved');
  hrAudit('attendance_correction', id, 'approve', {
    before: { status: 'pending', proposedInAt: c.proposedInAt, proposedOutAt: c.proposedOutAt },
    after: { status: 'approved', inAt, outAt, events: events.map((e) => ({ id: e.id, kind: e.kind, supersedes: e.supersedesEventId })) },
  });
  return { correction: getCorrection(id), events };
}

function listCorrections(companyId, { status = null, employeeId = null, limit = 200, offset = 0 } = {}) {
  const where = ['company_id = @companyId'];
  const params = { companyId };
  if (status) { if (!['pending', 'approved', 'rejected'].includes(status)) throw badRequest('status must be pending, approved or rejected'); where.push('status = @status'); params.status = status; }
  if (employeeId) { where.push('employee_id = @employeeId'); params.employeeId = employeeId; }
  const lim = Math.min(Math.max(1, Number(limit) || 200), 1000);
  const off = Math.max(0, Number(offset) || 0);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM attendance_corrections WHERE ${where.join(' AND ')}`).get(params).n;
  const items = db.prepare(`SELECT * FROM attendance_corrections WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`).all(params).map(rowToCorrection);
  return { items, total };
}

/* ─── computed days and months ────────────────────────────────── */

/**
 * The days a person can be counted (absent, late…): from the later of the hire
 * date and the date the company started keeping attendance in the app
 * (attendanceStartDate — before that the attendance is on paper, so no day
 * there is "absent"), to the end date / leaving day.
 */
function employedWindow(e, attendanceStartDate = null) {
  const hire = e.hireDate || null;
  const from = hire && attendanceStartDate ? (hire > attendanceStartDate ? hire : attendanceStartDate) : (hire || attendanceStartDate || null);
  return { from, to: e.endDate || e.leftOn || null };
}
function suspendedOn(ranges, date) { return !!ranges && ranges.some((r) => r.from <= date && (!r.to || date <= r.to)); }

/** Staff to include for a date range: not left before it starts, not hired after it ends. */
function staffForRange(companyId, from, to, employeeId = null) {
  return employees.list(companyId, {}).filter((e) => {
    if (employeeId && e.id !== employeeId) return false;
    const w = employedWindow(e);
    if (w.to && w.to < from) return false;
    if (w.from && w.from > to) return false;
    return true;
  });
}

/**
 * calcDay for every person (or one) and every date in [from, to].
 * Returns Map employeeId → { employee, days: DayResult[] }.
 */
function computeDays(companyId, { from, to, employeeId = null, now = Date.now() }) {
  const settings = hr.getSettings(companyId);
  const resolve = hr.scheduleResolver(companyId);
  const holidays = hr.holidayMap(companyId, from, to);
  const staff = staffForRange(companyId, from, to, employeeId);
  const events = activeEventsByEmployee(companyId, from, to, employeeId ? [employeeId] : null);
  const leave = require('./leave').approvedLeaveByDate(companyId, from, to);
  const suspensions = employees.suspensionsByEmployee(companyId);
  const out = new Map();
  const dates = [];
  for (let d = from; d <= to && dates.length < 400; d = calc.addDays(d, 1)) dates.push(d);
  for (const e of staff) {
    const evs = events.get(e.id) || new Map();
    const lv = leave.get(e.id) || new Map();
    const days = dates.map((date) => {
      const h = holidays.get(date);
      return calc.calcDay({
        date, schedule: resolve(e.id, date), events: evs.get(date) || [],
        holiday: h ? { nameEn: h.nameEn, nameKm: h.nameKm, paid: h.paid } : null,
        leave: lv.get(date) || null, employment: employedWindow(e, settings.attendanceStartDate),
        suspended: suspendedOn(suspensions.get(e.id), date), settings, now,
      });
    });
    out.set(e.id, { employee: e, days });
  }
  return out;
}

function zeroOt() { return { normal: 0, night: 0, restDay: 0, holiday: 0 }; }

function approvalsByEmployee(companyId, from, to) {
  const out = new Map();
  for (const r of getDb().prepare('SELECT * FROM overtime_approvals WHERE company_id = ? AND work_date >= ? AND work_date <= ? AND voided_at IS NULL').all(companyId, from, to)) {
    if (!out.has(r.employee_id)) out.set(r.employee_id, new Map());
    out.get(r.employee_id).set(r.work_date, { normal: r.normal_min, night: r.night_min, restDay: r.rest_day_min, holiday: r.holiday_min, id: r.id, needsReapproval: !!r.needs_reapproval,
      rates: r.rate_normal == null ? null : { normal: r.rate_normal, night: r.rate_night, restDay: r.rate_rest_day, holiday: r.rate_holiday } });
  }
  return out;
}

function latenessFor(companyId, month) {
  return new Map(getDb().prepare('SELECT * FROM lateness_confirmations WHERE company_id = ? AND month = ? AND voided_at IS NULL').all(companyId, month)
    .map((r) => [r.employee_id, rowToLateness(r)]));
}

/**
 * The month for everyone (or one person): per person the totals (days
 * worked, late minutes, overtime by category computed / approved / pending,
 * leave days…) and the lateness confirmation, plus the day list when one
 * person is asked for.
 */
function monthSummary(companyId, month, { employeeId = null, withDays = false, now = Date.now() } = {}) {
  if (!calc.isMonth(month)) throw badRequest('month must look like 2026-10');
  const from = `${month}-01`;
  const to = calc.lastDayOfMonth(month);
  const settings = hr.getSettings(companyId);
  const computed = computeDays(companyId, { from, to, employeeId, now });
  const approvals = approvalsByEmployee(companyId, from, to);
  const lateness = latenessFor(companyId, month);
  const rows = [];
  for (const [id, { employee, days }] of computed) {
    const totals = calc.summarizeDays(days, { approvedByDate: approvals.get(id) || new Map(), settings });
    const conf = lateness.get(id) || null;
    // Payroll may deduct only min(confirmed, computed now): a confirmation never outgrows the attendance.
    const late = conf ? {
      ...conf,
      deductibleLateMin: Math.min(conf.confirmedLateMin, totals.lateMin),
      deductibleEarlyLeaveMin: Math.min(conf.confirmedEarlyLeaveMin, totals.earlyLeaveMin),
      exceedsAttendance: conf.confirmedLateMin > totals.lateMin || conf.confirmedEarlyLeaveMin > totals.earlyLeaveMin,
    } : null;
    rows.push({
      employeeId: id, staffCode: employee.staffCode, nameEn: employee.nameEn, nameKm: employee.nameKm, status: employee.status,
      totals, lateness: late, ...(withDays || employeeId ? { days } : {}),
    });
  }
  rows.sort((a, b) => String(a.nameEn || a.nameKm || a.staffCode).localeCompare(String(b.nameEn || b.nameKm || b.staffCode)));
  return { month, settings: { otRates: settings.otRates, lateCountsFrom: settings.lateCountsFrom }, rows };
}

/** One date for everyone: status, first in, last out, late, overtime. */
function daySheet(companyId, date, { now = Date.now() } = {}) {
  if (!calc.isDate(date)) throw badRequest('date must be a real date like 2026-10-08');
  const computed = computeDays(companyId, { from: date, to: date, now });
  const rows = [];
  for (const [id, { employee, days }] of computed) {
    const d = days[0];
    if (d.status === 'not_employed') continue;
    rows.push({ employeeId: id, staffCode: employee.staffCode, nameEn: employee.nameEn, nameKm: employee.nameKm, ...d });
  }
  return { date, rows };
}

/* ─── overtime approvals ──────────────────────────────────────── */

function rowToOvertime(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, employeeId: r.employee_id, workDate: r.work_date,
    minutes: { normal: r.normal_min, night: r.night_min, restDay: r.rest_day_min, holiday: r.holiday_min },
    note: r.note, approvedByUserId: r.approved_by_user_id, approvedAt: r.approved_at, voided: !!r.voided_at, voidReason: r.void_reason,
    needsReapproval: !!r.needs_reapproval, needsReapprovalReason: r.needs_reapproval_reason ?? null, needsReapprovalAt: r.needs_reapproval_at ?? null,
    rates: r.rate_normal == null ? null : { normal: r.rate_normal, night: r.rate_night, restDay: r.rate_rest_day, holiday: r.rate_holiday },
  };
}

/**
 * Approve overtime for one person and day. Never more than the attendance
 * shows for a category. Re-approving the same day replaces (voids) the earlier
 * approval; `minutes` all 0 approves none (an explicit "no").
 */
function approveOvertime({ companyId, employeeId, workDate, minutes = {}, note = null }) {
  const emp = employees.get(employeeId);
  if (!emp || emp.companyId !== companyId) throw badRequest('Staff member not found');
  if (!calc.isDate(workDate)) throw badRequest('workDate must be a real date');
  const m = zeroOt();
  for (const k of Object.keys(m)) {
    if (minutes[k] == null) continue;
    const n = Number(minutes[k]);
    if (!Number.isInteger(n) || n < 0 || n > 1440) throw badRequest(`${k} must be whole minutes from 0 to 1440`);
    m[k] = n;
  }
  const day = computeDays(companyId, { from: workDate, to: workDate, employeeId }).get(employeeId)?.days?.[0];
  const ot = day?.overtime || zeroOt();
  for (const k of Object.keys(m)) {
    if (m[k] > ot[k]) throw badRequest(`Only ${ot[k]} min of ${k} overtime shows in the attendance for ${workDate} — fix the attendance first`);
  }
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const uid = getCallerUserId();
  let previous = null;
  db.transaction(() => {
    previous = db.prepare('SELECT * FROM overtime_approvals WHERE employee_id = ? AND work_date = ? AND voided_at IS NULL').get(employeeId, workDate);
    if (previous) db.prepare('UPDATE overtime_approvals SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(now, 'Replaced by a new approval', uid, previous.id);
    // The rates in force now are stored with the approval (payroll pays it at these).
    const rates = hr.getSettings(companyId).otRates;
    db.prepare(`INSERT INTO overtime_approvals (id, company_id, employee_id, work_date, normal_min, night_min, rest_day_min, holiday_min, note, approved_by_user_id, approved_at,
        rate_normal, rate_night, rate_rest_day, rate_holiday)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, companyId, employeeId, workDate, m.normal, m.night, m.restDay, m.holiday, str(note, 500), uid, now,
      rates.normal, rates.night, rates.restDay, rates.holiday);
  })();
  hrAudit('overtime', id, 'approve', { before: previous ? rowToOvertime(previous).minutes : null, after: { employeeId, workDate, minutes: m, computed: ot } });
  return rowToOvertime(db.prepare('SELECT * FROM overtime_approvals WHERE id = ?').get(id));
}

function revokeOvertime(id, reason) {
  const r = getDb().prepare('SELECT * FROM overtime_approvals WHERE id = ?').get(id);
  if (!r) throw badRequest('Overtime approval not found');
  if (r.voided_at) return rowToOvertime(r);
  if (!str(reason, 500)) throw badRequest('Say why the approval is withdrawn');
  getDb().prepare('UPDATE overtime_approvals SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(Date.now(), str(reason, 500), getCallerUserId(), id);
  hrAudit('overtime', id, 'revoke', { after: { reason: str(reason, 500) } });
  return rowToOvertime(getDb().prepare('SELECT * FROM overtime_approvals WHERE id = ?').get(id));
}

function getOvertime(id) { return rowToOvertime(getDb().prepare('SELECT * FROM overtime_approvals WHERE id = ?').get(id)); }

function listOvertime(companyId, { month = null, employeeId = null, includeVoided = false } = {}) {
  const where = ['company_id = @companyId'];
  const params = { companyId };
  if (month) { where.push('work_date LIKE @m'); params.m = `${month}-%`; }
  if (employeeId) { where.push('employee_id = @employeeId'); params.employeeId = employeeId; }
  if (!includeVoided) where.push('voided_at IS NULL');
  return getDb().prepare(`SELECT * FROM overtime_approvals WHERE ${where.join(' AND ')} ORDER BY work_date, approved_at`).all(params).map(rowToOvertime);
}

/* ─── lateness confirmations ──────────────────────────────────── */

function rowToLateness(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, employeeId: r.employee_id, month: r.month,
    computedLateMin: r.computed_late_min, confirmedLateMin: r.confirmed_late_min,
    computedEarlyLeaveMin: r.computed_early_min, confirmedEarlyLeaveMin: r.confirmed_early_min,
    note: r.note, confirmedByUserId: r.confirmed_by_user_id, confirmedAt: r.confirmed_at, voided: !!r.voided_at, voidReason: r.void_reason,
    needsReapproval: !!r.needs_reapproval, needsReapprovalReason: r.needs_reapproval_reason ?? null, needsReapprovalAt: r.needs_reapproval_at ?? null,
  };
}

/**
 * Confirm a finished month's late / early-leave minutes for payroll. The
 * confirmed figure defaults to the computed one and may only be LOWER (a
 * waiver, which needs a note). Re-confirming replaces the earlier row.
 */
function confirmLateness({ companyId, employeeId, month, lateMinutes = null, earlyLeaveMinutes = null, note = null }) {
  if (!calc.isMonth(month)) throw badRequest('month must look like 2026-10');
  if (month >= calc.ppMonth(Date.now())) throw badRequest('Confirm a month after it has ended');
  const summary = monthSummary(companyId, month, { employeeId });
  const row = summary.rows[0];
  if (!row) throw badRequest('Staff member not found for that month');
  const computedLate = row.totals.lateMin;
  const computedEarly = row.totals.earlyLeaveMin;
  const pick = (v, max, label) => {
    if (v == null) return max;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw badRequest(`${label} must be whole minutes`);
    if (n > max) throw badRequest(`${label} cannot be more than the ${max} min the attendance shows`);
    return n;
  };
  const late = pick(lateMinutes, computedLate, 'lateMinutes');
  const early = pick(earlyLeaveMinutes, computedEarly, 'earlyLeaveMinutes');
  if ((late < computedLate || early < computedEarly) && !str(note, 500)) throw badRequest('Say why some minutes are waived');
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const uid = getCallerUserId();
  db.transaction(() => {
    const prev = db.prepare('SELECT id FROM lateness_confirmations WHERE employee_id = ? AND month = ? AND voided_at IS NULL').get(employeeId, month);
    if (prev) db.prepare('UPDATE lateness_confirmations SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(now, 'Replaced by a new confirmation', uid, prev.id);
    db.prepare(`INSERT INTO lateness_confirmations (id, company_id, employee_id, month, computed_late_min, confirmed_late_min, computed_early_min, confirmed_early_min, note, confirmed_by_user_id, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, companyId, employeeId, month, computedLate, late, computedEarly, early, str(note, 500), uid, now);
  })();
  hrAudit('lateness', id, 'confirm', { after: { employeeId, month, computedLate, late, computedEarly, early, note: str(note, 500) } });
  return rowToLateness(db.prepare('SELECT * FROM lateness_confirmations WHERE id = ?').get(id));
}

function listLateness(companyId, { month = null, employeeId = null } = {}) {
  const where = ['company_id = @companyId', 'voided_at IS NULL'];
  const params = { companyId };
  if (month) { where.push('month = @month'); params.month = month; }
  if (employeeId) { where.push('employee_id = @employeeId'); params.employeeId = employeeId; }
  return getDb().prepare(`SELECT * FROM lateness_confirmations WHERE ${where.join(' AND ')} ORDER BY month DESC`).all(params).map(rowToLateness);
}

module.exports = {
  SOURCES, rowToEvent, getEvent, getEventRow, lastActiveEvent, activeEventsByEmployee, touchDate,
  addAlert, listAlerts, getAlert, ackAlert,
  clock, addManual, voidEvent, listReview, review, listEvents,
  getCorrection, requestCorrection, decideCorrection, listCorrections, requestForRef, payloadHash,
  computeDays, monthSummary, daySheet,
  approveOvertime, revokeOvertime, getOvertime, listOvertime,
  confirmLateness, listLateness,
};
