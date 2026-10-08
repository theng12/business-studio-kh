/**
 * HR1 — the People screens' view model. Pure functions only (no React, no
 * window.api), so test/hrUiModel.test.js can check the wording, the grids,
 * the overtime / lateness states and the form rules without a browser.
 *
 * Conventions from the backend (docs/PEOPLE_AND_FUEL_PLAN.md §10):
 *   - times are epoch ms; a work day is 'YYYY-MM-DD' in Phnom Penh time
 *     (UTC+7 all year), whichever Mac shows it;
 *   - minutes are whole numbers; overtime has four categories
 *     (normal 150 %, night / rest day / holiday 200 % by default);
 *   - nothing is deleted: void, reject, cancel, archive.
 * The date helpers are the Fuel ones (one Phnom Penh rule in the renderer).
 */

import { ppDateKey, ppMonthKey, monthLabel } from '../Fuel/fuelModel.js';

export { ppDateKey, ppMonthKey, monthLabel };

const PP_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ─── capabilities ────────────────────────────────────────────────────── */

const has = (caps, key) => Array.isArray(caps) && (caps.includes('*') || caps.includes(key));

/** What this account may do on the People screens. */
export function hrCapsOf(caps) {
  const canManage = has(caps, 'hr.manage');
  const canView = canManage || has(caps, 'hr.view');
  const fuelManage = has(caps, 'fuel.manage');
  return { canView, canManage, fuelManage, canSeeStaff: canView || fuelManage };
}

/* ─── names ───────────────────────────────────────────────────────────── */

export function personName(e) {
  if (!e) return '—';
  return e.nameEn || e.nameKm || e.staffCode || '—';
}

/** "Sok Dara · សុខ ដារា" when both names exist. */
export function bothNames(e) {
  if (!e) return '';
  if (e.nameEn && e.nameKm) return `${e.nameEn} · ${e.nameKm}`;
  return personName(e);
}

/* ─── time ────────────────────────────────────────────────────────────── */

/** "07:52" in Phnom Penh, or '—'. */
export function fmtHm(ms) {
  if (!isNum(ms)) return '—';
  const d = new Date(ms + PP_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "07:52" or "06:10 +1" when the moment falls on a later day than `workDate`. */
export function fmtHmOn(ms, workDate) {
  if (!isNum(ms)) return '—';
  const day = ppDateKey(ms);
  if (!workDate || day === workDate) return fmtHm(ms);
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${workDate}T00:00:00Z`)) / DAY_MS);
  return `${fmtHm(ms)} ${diff > 0 ? '+' : ''}${diff}`;
}

/** Minutes → "7 h 05 min", "45 min", "0 min"; '—' for nothing. */
export function fmtMinutes(min, { zero = '0 min' } = {}) {
  if (!isNum(min)) return '—';
  const n = Math.round(min);
  if (n === 0) return zero;
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a < 60) return `${sign}${a} min`;
  return `${sign}${Math.floor(a / 60)} h ${pad(a % 60)} min`;
}

/** Minutes → "7:05" for dense grids. */
export function fmtHours(min) {
  if (!isNum(min)) return '—';
  const a = Math.max(0, Math.round(min));
  return `${Math.floor(a / 60)}:${pad(a % 60)}`;
}

/** A 'HH:MM' typed for a work date → epoch ms (Phnom Penh), or null. `nextDay` adds a day. */
export function hmToMs(date, hm, { nextDay = false } = {}) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hm || ''));
  if (!d || !t) return null;
  const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + (nextDay ? 1 : 0), Number(t[1]), Number(t[2])) - PP_OFFSET_MS;
  return Number.isFinite(ms) ? ms : null;
}

export function isHm(v) { return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(v || '')); }
export function isDateKey(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)); }

/** Add n days to 'YYYY-MM-DD'. */
export function addDays(date, n) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  const d = new Date(ms + n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Every 'YYYY-MM-DD' of a 'YYYY-MM' month. */
export function monthDates(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${m[1]}-${m[2]}-${pad(i + 1)}`);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayMon0(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : (new Date(ms).getUTCDay() + 6) % 7;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Thu 8 Oct" for a work date. */
export function fmtWorkDate(date, { year = false } = {}) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return String(date || '—');
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
}

/** "8 – 10 Oct 2026" / "8 Oct 2026" for a leave range. */
export function fmtDateRange(from, to) {
  if (!from) return '—';
  const one = (d, opts) => new Date(Date.parse(`${d}T00:00:00Z`)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  if (!to || to === from) return one(from, { day: 'numeric', month: 'short', year: 'numeric' });
  if (from.slice(0, 7) === to.slice(0, 7)) return `${one(from, { day: 'numeric' })} – ${one(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `${one(from, { day: 'numeric', month: 'short' })} – ${one(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** The month before 'YYYY-MM'. */
export function prevMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** A month has ended (lateness can be confirmed) when it is before this month. */
export function monthEnded(month, now = Date.now()) {
  return /^\d{4}-\d{2}$/.test(String(month || '')) && month < ppMonthKey(now);
}

/* ─── day status ──────────────────────────────────────────────────────── */

/** Each status of a day: label, badge tone, and the one-letter cell of the month grid. */
export const DAY_STATUS = {
  present: { label: 'Present', tone: 'emerald', letter: 'P' },
  late: { label: 'Late', tone: 'amber', letter: 'L' },
  incomplete: { label: 'No clock-out', tone: 'amber', letter: '!' },
  absent: { label: 'Absent', tone: 'rose', letter: 'A' },
  leave: { label: 'On leave', tone: 'blue', letter: 'Lv' },
  holiday: { label: 'Holiday', tone: 'slate', letter: 'H' },
  off: { label: 'Day off', tone: 'slate', letter: '·' },
  suspended: { label: 'Suspended', tone: 'rose', letter: 'S' },
  future: { label: 'Not yet', tone: 'slate', letter: '' },
  not_employed: { label: 'Not employed', tone: 'slate', letter: '' },
};

export function dayStatusOf(status) {
  return DAY_STATUS[status] || { label: status || '—', tone: 'slate', letter: '?' };
}

/** The legend under the month grid, in reading order. */
export const GRID_LEGEND = ['present', 'late', 'incomplete', 'absent', 'leave', 'holiday', 'suspended', 'off', 'not_employed'];

/** Total overtime minutes of a day result or a totals object. */
export function otTotal(ot) {
  if (!ot) return 0;
  return (ot.normal || 0) + (ot.night || 0) + (ot.restDay || 0) + (ot.holiday || 0);
}

/** The month grid cell for one day: letter, tone and a tooltip. */
export function gridCell(day) {
  const s = dayStatusOf(day?.status);
  const bits = [fmtWorkDate(day?.date), s.label];
  if (day?.holiday) bits.push(day.holiday.nameEn || day.holiday.nameKm || 'Public holiday');
  if (day?.leave) bits.push(`Leave${day.leave.half ? ` (${day.leave.half === 'am' ? 'morning' : 'afternoon'})` : ''}`);
  if (isNum(day?.firstIn)) bits.push(`in ${fmtHmOn(day.firstIn, day.date)}`);
  if (isNum(day?.lastOut)) bits.push(`out ${fmtHmOn(day.lastOut, day.date)}`);
  if (day?.lateMin > 0) bits.push(`${day.lateMin} min late`);
  if (otTotal(day?.overtime) > 0) bits.push(`${fmtMinutes(otTotal(day.overtime))} overtime`);
  // A half day of leave beside work shows the work status, with a leave mark.
  const letter = s.letter + (day?.leave?.half && day.status !== 'leave' ? '½' : '');
  return { letter, tone: s.tone, status: day?.status || 'off', title: bits.filter(Boolean).join(' · ') };
}

/* ─── events ──────────────────────────────────────────────────────────── */

export const SOURCES = {
  kiosk: 'Shop kiosk',
  phone: 'Own phone',
  supervisor: 'Supervisor',
  manual: 'Entered by a manager',
  correction: 'Correction',
};
export const sourceLabel = (s) => SOURCES[s] || s || '—';

export const REVIEW_LABELS = {
  pending: { label: 'Waiting for review', tone: 'amber' },
  accepted: { label: 'Accepted', tone: 'emerald' },
  rejected: { label: 'Rejected', tone: 'rose' },
};

/** The badges of one event: void, superseded, review state, held. */
export function eventBadges(ev) {
  const out = [];
  if (!ev) return out;
  if (ev.voided) out.push({ label: ev.reviewStatus === 'rejected' ? 'Rejected' : 'Voided', tone: 'rose' });
  else if (ev.supersededById) out.push({ label: 'Replaced by a correction', tone: 'slate' });
  if (!ev.voided && ev.reviewStatus && REVIEW_LABELS[ev.reviewStatus]) out.push(REVIEW_LABELS[ev.reviewStatus]);
  if (ev.held) out.push({ label: 'Held — not counted', tone: 'rose' });
  else if (ev.queuedLong) out.push({ label: 'Sent late', tone: 'amber' });
  return out;
}

/** Events of a day, oldest first; voided and superseded ones last. */
export function sortDayEvents(events) {
  const live = (e) => !e.voided && !e.supersededById;
  return [...(events || [])].sort((a, b) => (live(b) - live(a)) || (a.at - b.at));
}

export const ALERT_KINDS = {
  pin_locked: 'PIN locked',
  kiosk_paused: 'Kiosk paused',
};
export const alertKindLabel = (k) => ALERT_KINDS[k] || k || 'Alert';

/**
 * Review fix M1: a dialog that loads data for "this person on this day" keeps
 * the answer together with the key it was asked for, and shows it only while
 * that key is still the dialog's — never the previous person's rows.
 */
export const EMPTY_DAY_LOAD = Object.freeze({ key: null, events: [], day: null, error: null });
export function loadedFor(state, key, empty) {
  return state && key && state.key === key ? state : empty;
}

/**
 * Review fix L1: fold one batch answer (`{ byEmployee, errors }` from
 * leave:balances / hr:listEmployeeSchedules with `employeeIds`) into what is
 * on screen. Values already shown stay until their new value arrives (no
 * flicker on a refresh); a row that failed shows its own error and keeps
 * nothing stale; a row that recovered loses its error.
 */
export const EMPTY_BATCH = Object.freeze({ values: {}, errors: {} });
export function mergeBatch(prev, res) {
  const values = { ...(prev?.values || {}) };
  const errors = { ...(prev?.errors || {}) };
  for (const [id, v] of Object.entries(res?.byEmployee || {})) { values[id] = v; delete errors[id]; }
  for (const [id, msg] of Object.entries(res?.errors || {})) { errors[id] = msg; delete values[id]; }
  return { values, errors };
}

/* ─── corrections ─────────────────────────────────────────────────────── */

export const CORRECTION_STATUS = {
  pending: { label: 'Waiting', tone: 'amber' },
  approved: { label: 'Approved', tone: 'emerald' },
  rejected: { label: 'Rejected', tone: 'rose' },
};

export const VIA_LABELS = { kiosk: 'Kiosk', phone: 'Phone', manager: 'Manager' };

/** Approve form defaults: the proposed times as 'HH:MM' (Phnom Penh). */
export function correctionForm(c) {
  return {
    inTime: isNum(c?.proposedInAt) ? fmtHm(c.proposedInAt) : '',
    outTime: isNum(c?.proposedOutAt) ? fmtHm(c.proposedOutAt) : '',
    note: '',
  };
}

/**
 * The approve call's times (review fix L2): a typed time replaces the
 * proposal, an EMPTIED field that had a proposal sends null (the server then
 * removes that time — e.g. approve only the forgotten clock-out), and a field
 * that was empty and stays empty is left out.
 */
export function correctionDecision(correction, form) {
  const pick = (typed, proposed) => (typed ? typed : (isNum(proposed) ? null : undefined));
  const out = { inTime: pick(form.inTime, correction?.proposedInAt), outTime: pick(form.outTime, correction?.proposedOutAt) };
  const note = String(form.note || '').trim();
  if (note) out.note = note;
  return out;
}

export function validateCorrectionForm(form) {
  const errors = {};
  if (form.inTime && !isHm(form.inTime)) errors.inTime = 'Type a time like 07:30';
  if (form.outTime && !isHm(form.outTime)) errors.outTime = 'Type a time like 17:00';
  if (!form.inTime && !form.outTime) errors.inTime = 'Give a clock-in or a clock-out time';
  return errors;
}

/* ─── overtime ────────────────────────────────────────────────────────── */

export const OT_CATEGORIES = [
  { key: 'normal', label: 'Normal', hint: 'After hours on a work day' },
  { key: 'night', label: 'Night', hint: 'After hours inside the night window' },
  { key: 'restDay', label: 'Day off', hint: 'Worked on the weekly day off' },
  { key: 'holiday', label: 'Holiday', hint: 'Worked on a public holiday' },
];

/** "Normal 150 % · Night 200 % · …" */
export function ratesLine(rates) {
  if (!rates) return '';
  return OT_CATEGORIES.map((c) => `${c.label} ${rates[c.key] ?? '—'} %`).join(' · ');
}

/**
 * One row per person per day that has overtime computed or an approval:
 * `{ key, employeeId, name, staffCode, date, computed, approved, approval,
 *    state ('pending'|'approved'|'partial'|'reapprove'|'exceeds'|'none') }`.
 * `summary` = attendance:monthSummary with days; `approvals` = listOvertime.
 */
export function overtimeRows(summary, approvals = []) {
  const byDay = new Map();
  for (const a of approvals || []) if (!a.voided) byDay.set(`${a.employeeId}|${a.workDate}`, a);
  const rows = [];
  for (const r of summary?.rows || []) {
    for (const d of r.days || []) {
      const key = `${r.employeeId}|${d.date}`;
      const approval = byDay.get(key) || null;
      const computed = { normal: 0, night: 0, restDay: 0, holiday: 0, ...(d.overtime || {}) };
      if (!otTotal(computed) && !approval) continue;
      const approved = approval ? { ...approval.minutes } : null;
      rows.push({
        key, employeeId: r.employeeId, name: personName(r), staffCode: r.staffCode, date: d.date,
        computed, approved, approval, state: overtimeState(computed, approval),
      });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
  return rows;
}

/** What a day's overtime needs. */
export function overtimeState(computed, approval) {
  if (!approval) return otTotal(computed) > 0 ? 'pending' : 'none';
  if (approval.needsReapproval) return 'reapprove';
  const m = approval.minutes || {};
  if (OT_CATEGORIES.some((c) => (m[c.key] || 0) > (computed?.[c.key] || 0))) return 'exceeds';
  if (OT_CATEGORIES.some((c) => (m[c.key] || 0) < (computed?.[c.key] || 0))) return 'partial';
  return 'approved';
}

export const OT_STATE = {
  pending: { label: 'Waiting', tone: 'amber' },
  approved: { label: 'Approved', tone: 'emerald' },
  partial: { label: 'Approved in part', tone: 'blue' },
  reapprove: { label: 'Needs re-approval', tone: 'rose' },
  exceeds: { label: 'More than the attendance shows', tone: 'rose' },
  none: { label: 'No overtime', tone: 'slate' },
};

/** Rows still needing a decision (the "Waiting" view and the approve-all action). */
export function overtimeNeedsLook(rows) {
  return (rows || []).filter((r) => r.state === 'pending' || r.state === 'reapprove' || r.state === 'exceeds');
}

/**
 * The Adjust dialog's starting values (review fix L3): per category the
 * approved minutes, but never more than the attendance shows now (an approval
 * that outgrew a corrected day starts at what can still be approved); no
 * approval yet → the computed minutes.
 */
export function overtimeAdjustForm(row) {
  const form = { note: row?.approval?.note || '' };
  for (const c of OT_CATEGORIES) {
    const computed = row?.computed?.[c.key] || 0;
    form[c.key] = String(row?.approved ? Math.min(row.approved[c.key] || 0, computed) : computed);
  }
  return form;
}

/** A category field is locked only when there is nothing to approve AND it holds nothing. */
export function overtimeFieldLocked(form, computed, key) {
  return !(computed?.[key] > 0) && !(Number(form?.[key]) > 0);
}

/** Adjust form → minutes, checked never above the computed figure. */
export function validateOvertimeAdjust(form, computed) {
  const errors = {};
  const minutes = {};
  for (const c of OT_CATEGORIES) {
    const raw = String(form?.[c.key] ?? '').trim();
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0) { errors[c.key] = 'Whole minutes, 0 or more'; continue; }
    const max = computed?.[c.key] || 0;
    if (n > max) { errors[c.key] = `At most ${max} min — that is what the attendance shows`; continue; }
    minutes[c.key] = n;
  }
  return { errors, minutes };
}

/* ─── lateness ────────────────────────────────────────────────────────── */

/** State of one person's month: 'none' (nothing late) / 'open' / 'confirmed' / 'reapprove' / 'exceeds'. */
export function latenessState(row) {
  const t = row?.totals || {};
  const l = row?.lateness;
  if (!l) return (t.lateMin || 0) + (t.earlyLeaveMin || 0) > 0 ? 'open' : 'none';
  if (l.needsReapproval) return 'reapprove';
  if (l.exceedsAttendance) return 'exceeds';
  return 'confirmed';
}

export const LATENESS_STATE = {
  none: { label: 'Nothing late', tone: 'slate' },
  open: { label: 'Not confirmed', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'emerald' },
  reapprove: { label: 'Needs re-confirming', tone: 'rose' },
  exceeds: { label: 'More than the attendance shows', tone: 'rose' },
};

/**
 * Re-confirming a month (review fix L8) keeps an earlier WAIVER as the number
 * of minutes waived, not as the old confirmed figure: waived = computed then −
 * confirmed then; confirmed now = max(0, computed now − waived), with the old
 * note. A month that had no waiver re-confirms at today's computed minutes.
 * Returns the confirmLateness args beyond employeeId / month, plus `waived`
 * ({ late, early }) for the question to ask first; null when there is no
 * earlier confirmation.
 */
export function reconfirmLateness(row) {
  const l = row?.lateness;
  if (!l) return null;
  const t = row.totals || {};
  const waived = {
    late: Math.max(0, (l.computedLateMin || 0) - (l.confirmedLateMin || 0)),
    early: Math.max(0, (l.computedEarlyLeaveMin || 0) - (l.confirmedEarlyLeaveMin || 0)),
  };
  if (!waived.late && !waived.early) return { args: {}, waived };
  return {
    args: {
      lateMinutes: Math.max(0, (t.lateMin || 0) - waived.late),
      earlyLeaveMinutes: Math.max(0, (t.earlyLeaveMin || 0) - waived.early),
      note: l.note || 'Earlier waiver kept',
    },
    waived,
  };
}

/** The waiver form: lower figures need a note. */
export function validateLatenessForm(form, computed) {
  const errors = {};
  const parse = (v) => (String(v ?? '').trim() === '' ? NaN : Number(v));
  const late = parse(form.lateMinutes);
  const early = parse(form.earlyLeaveMinutes);
  if (!Number.isInteger(late) || late < 0) errors.lateMinutes = 'Whole minutes, 0 or more';
  else if (late > (computed.lateMin || 0)) errors.lateMinutes = `At most ${computed.lateMin || 0} min`;
  if (!Number.isInteger(early) || early < 0) errors.earlyLeaveMinutes = 'Whole minutes, 0 or more';
  else if (early > (computed.earlyLeaveMin || 0)) errors.earlyLeaveMinutes = `At most ${computed.earlyLeaveMin || 0} min`;
  const waived = (Number.isInteger(late) && late < (computed.lateMin || 0)) || (Number.isInteger(early) && early < (computed.earlyLeaveMin || 0));
  if (waived && !String(form.note || '').trim()) errors.note = 'Say why some minutes are waived';
  return errors;
}

/* ─── leave ───────────────────────────────────────────────────────────── */

export const LEAVE_STATUS = {
  pending: { label: 'Waiting', tone: 'amber' },
  approved: { label: 'Approved', tone: 'emerald' },
  rejected: { label: 'Rejected', tone: 'rose' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

export const LEDGER_KINDS = {
  accrual: 'Earned',
  taken: 'Taken',
  adjustment: 'Adjustment',
  carry_over: 'Carried over',
  expiry: 'Expired',
};

export const ACCRUALS = [
  { value: 'monthly', label: 'Each month worked' },
  { value: 'yearly', label: 'Each calendar year' },
  { value: 'none', label: 'Not earned (taken as needed)' },
];

/** "1.5" / "-2" / "0.5" — days never show more than two decimals. */
export function fmtDays(n) {
  if (!isNum(n)) return '—';
  const r = Math.round(n * 100) / 100;
  return String(r);
}

export function leaveTypeName(t) {
  if (!t) return '—';
  return t.nameEn || t.nameKm || t.code || '—';
}

export function validateLeaveRequestForm(form) {
  const errors = {};
  if (!form.employeeId) errors.employeeId = 'Choose who the leave is for';
  if (!form.leaveTypeId) errors.leaveTypeId = 'Choose the kind of leave';
  if (!isDateKey(form.fromDate)) errors.fromDate = 'Choose the first day';
  if (form.toDate && !isDateKey(form.toDate)) errors.toDate = 'Choose the last day';
  else if (form.toDate && isDateKey(form.fromDate) && form.toDate < form.fromDate) errors.toDate = 'The last day is before the first';
  if (form.halfDay && form.toDate && form.toDate !== form.fromDate) errors.halfDay = 'A half day is one day only';
  return errors;
}

export function validateAdjustForm(form) {
  const errors = {};
  const n = Number(String(form.days ?? '').trim());
  if (!String(form.days ?? '').trim() || !Number.isFinite(n) || n === 0) errors.days = 'Days to add (or take away with a minus), not 0';
  else if (Math.abs(n) > 1000) errors.days = 'That is more than 1,000 days';
  if (!form.leaveTypeId) errors.leaveTypeId = 'Choose the kind of leave';
  if (form.date && !isDateKey(form.date)) errors.date = 'Choose a date';
  if (!String(form.note || '').trim()) errors.note = 'Say why the balance changes (e.g. opening balance)';
  return errors;
}

/** A leave approval refused for balance → the plain question to ask instead. */
export function negativeBalanceQuestion(message) {
  const m = /^(Not enough [^:]+: balance [^,]+, request \d+(?:\.\d+)?)/.exec(String(message || '').replace(/^Bad request:\s*/, ''));
  return m ? `${m[1]} day(s). Approve anyway and let the balance go below zero?` : null;
}

/* ─── schedules ───────────────────────────────────────────────────────── */

/** '1111110' → "Mon–Sat"; '1010100' → "Mon, Wed, Fri". */
export function workDaysLabel(mask) {
  const s = String(mask || '');
  if (!/^[01]{7}$/.test(s)) return '—';
  const on = [...s].map((c, i) => (c === '1' ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return 'No work days';
  if (on.length === 7) return 'Every day';
  const run = on.every((d, i) => i === 0 || d === on[i - 1] + 1);
  if (run && on.length > 2) return `${WEEKDAYS[on[0]]}–${WEEKDAYS[on[on.length - 1]]}`;
  return on.map((i) => WEEKDAYS[i]).join(', ');
}

/** "07:00–17:00 · 60 min break · Mon–Sat". */
export function scheduleLine(s) {
  if (!s) return '—';
  return `${s.startTime}–${s.endTime}${s.crossesMidnight ? ' (next day)' : ''} · ${s.breakMin || 0} min break · ${workDaysLabel(s.workDays)}`;
}

export function emptyScheduleForm(s = null) {
  return {
    name: s?.name || '', startTime: s?.startTime || '07:00', endTime: s?.endTime || '17:00',
    breakMin: String(s?.breakMin ?? 60), workDays: s?.workDays || '1111110', graceMin: String(s?.graceMin ?? 5),
    nightStart: s?.nightStart || '22:00', nightEnd: s?.nightEnd || '05:00',
  };
}

export function validateScheduleForm(form) {
  const errors = {};
  if (!String(form.name || '').trim()) errors.name = 'Give the schedule a name';
  for (const k of ['startTime', 'endTime', 'nightStart', 'nightEnd']) if (!isHm(form[k])) errors[k] = 'Type a time like 07:30';
  if (!errors.startTime && !errors.endTime && form.startTime === form.endTime) errors.endTime = 'The end must differ from the start';
  for (const k of ['breakMin', 'graceMin']) {
    const n = Number(form[k]);
    if (String(form[k]).trim() === '' || !Number.isInteger(n) || n < 0 || n > 600) errors[k] = 'Whole minutes from 0 to 600';
  }
  if (!/^[01]{7}$/.test(String(form.workDays || '')) || !String(form.workDays).includes('1')) errors.workDays = 'Pick at least one work day';
  return errors;
}

export function scheduleInput(form) {
  return {
    name: form.name.trim(), startTime: form.startTime, endTime: form.endTime, breakMin: Number(form.breakMin),
    workDays: form.workDays, graceMin: Number(form.graceMin), nightStart: form.nightStart, nightEnd: form.nightEnd,
  };
}

/** The schedule in force on `date` from a person's history (none → null: the company default). */
export function scheduleOn(history, date) {
  let hit = null;
  for (const h of history || []) if (h.effectiveFrom <= date && (!hit || h.effectiveFrom >= hit.effectiveFrom)) hit = h;
  return hit;
}

/* ─── holidays ────────────────────────────────────────────────────────── */

/** A prefilled 2027 date to check against the sub-decree once it is published. */
export function holidayNeedsCheck(h) {
  return /check/i.test(String(h?.sourceNote || ''));
}

export function validateHolidayForm(form) {
  const errors = {};
  if (!isDateKey(form.date)) errors.date = 'Choose the date';
  if (!String(form.nameEn || '').trim() && !String(form.nameKm || '').trim()) errors.nameEn = 'Give the holiday a name in English or Khmer';
  return errors;
}

/* ─── PINs ────────────────────────────────────────────────────────────── */

/** The same rules the server applies (main/util/kioskPin.js pinProblem). */
export function pinProblem(pin) {
  const s = String(pin ?? '');
  if (!/^\d{4,8}$/.test(s)) return 'The PIN must be 4 to 8 digits';
  if (/^(\d)\1+$/.test(s)) return 'Pick a PIN that is not one digit repeated';
  if ('0123456789'.includes(s) || '9876543210'.includes(s)) return 'Pick a PIN that is not a straight run like 1234';
  return null;
}

/** "No PIN" / "PIN set" / "Locked until 14:05" / "Locked — a manager must unlock it". */
export function pinStatus(e, now = Date.now()) {
  if (!e?.hasPin) return { label: 'No PIN yet', tone: 'slate', locked: false };
  if (e.pinManagerOnly) return { label: 'Locked — only a manager can unlock it', tone: 'rose', locked: true };
  if (isNum(e.pinLockedUntil) && e.pinLockedUntil > now) return { label: `Locked until ${fmtHm(e.pinLockedUntil)}`, tone: 'amber', locked: true };
  return { label: 'PIN set', tone: 'emerald', locked: false };
}

/* ─── staff status ────────────────────────────────────────────────────── */

export function staffStatus(e) {
  if (e?.status === 'left') return { label: `Left${e.leftOn ? ` ${e.leftOn}` : ''}`, tone: 'slate' };
  if (e?.status === 'suspended') return { label: 'Suspended', tone: 'rose' };
  return { label: 'Working', tone: 'emerald' };
}

export const EMPLOYMENT_TYPES = [
  { value: 'monthly', label: 'Monthly salary' },
  { value: 'daily', label: 'Daily wage' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'contract', label: 'Contract' },
];

export const GENDERS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
];

export const DOC_KINDS = [
  { value: 'id_card', label: 'ID card' },
  { value: 'contract', label: 'Contract' },
  { value: 'certificate', label: 'Certificate' },
  { value: 'photo', label: 'Photo' },
  { value: 'other', label: 'Other' },
];
export const docKindLabel = (k) => DOC_KINDS.find((d) => d.value === k)?.label || k || 'Document';

/** The private fields a caller sees only with hr.manage — the backend leaves them out for everyone else. */
export const PRIVATE_FIELDS = ['dob', 'address', 'nationalIdNo', 'nssfNo', 'bankName', 'bankAccountName', 'bankAccountNo'];

/**
 * Which profile fields this record carries. The backend narrows the record
 * per caller (main/ipc/hrAccess.js); a key that is ABSENT means "you may not
 * see it", which must never show as an empty field (that reads as data loss).
 */
export function visibleFields(e) {
  const keys = new Set(Object.keys(e || {}));
  return {
    notes: keys.has('notes'),
    private: PRIVATE_FIELDS.every((k) => keys.has(k)),
    hr: keys.has('employmentType') || keys.has('hireDate'),
    statusReason: keys.has('statusReason'),
  };
}

/** The HR details form from a profile (only the keys the caller can see). */
export function profileForm(e) {
  const v = visibleFields(e);
  const out = {
    gender: e?.gender || '', positionId: e?.positionId || '', hireDate: e?.hireDate || '', endDate: e?.endDate || '',
    employmentType: e?.employmentType || '', supervisorEmployeeId: e?.supervisorEmployeeId || '',
  };
  if (v.private) for (const k of PRIVATE_FIELDS) out[k] = e?.[k] || '';
  return out;
}

/** The changed fields of the details form, as an hr:updateProfile patch ('' → null). */
export function profilePatch(before, after) {
  const patch = {};
  for (const k of Object.keys(after)) {
    const a = after[k] === '' ? null : after[k];
    const b = (before?.[k] ?? '') === '' ? null : before[k];
    if (a !== b) patch[k] = a;
  }
  return patch;
}

export function validateProfileForm(form) {
  const errors = {};
  for (const k of ['dob', 'hireDate', 'endDate']) if (form[k] && !isDateKey(form[k])) errors[k] = 'Choose a date';
  if (form.hireDate && form.endDate && form.endDate < form.hireDate) errors.endDate = 'The end date is before the start date';
  return errors;
}

export function validateSuspendForm(form) {
  const errors = {};
  if (!isDateKey(form.fromDate)) errors.fromDate = 'Choose the first day';
  if (form.toDate && !isDateKey(form.toDate)) errors.toDate = 'Choose the last day';
  else if (form.toDate && form.toDate < form.fromDate) errors.toDate = 'The last day is before the first';
  if (!String(form.reason || '').trim()) errors.reason = 'Say why';
  return errors;
}

/* ─── settings ────────────────────────────────────────────────────────── */

/**
 * Settings → People: the numeric settings, grouped, with plain labels and
 * the server's ranges (main/util/attendanceCalc.js SETTING_RANGES).
 * `rate: true` fields live under `otRates`.
 */
export const HR_SETTING_GROUPS = [
  {
    title: 'Overtime',
    hint: 'Labour Law defaults — confirm the rates with your accountant.',
    fields: [
      { key: 'normal', rate: true, label: 'Normal overtime rate', unit: '%', def: 150, min: 100, max: 500 },
      { key: 'night', rate: true, label: 'Night overtime rate', unit: '%', def: 200, min: 100, max: 500 },
      { key: 'restDay', rate: true, label: 'Weekly day off rate', unit: '%', def: 200, min: 100, max: 500 },
      { key: 'holiday', rate: true, label: 'Public holiday rate', unit: '%', def: 200, min: 100, max: 500 },
      { key: 'otMinMinutes', label: 'Smallest overtime counted', unit: 'min', def: 15, min: 0, max: 240 },
      { key: 'otRoundMinutes', label: 'Round overtime down to', unit: 'min', def: 15, min: 1, max: 60 },
    ],
  },
  {
    title: 'Lateness and breaks',
    fields: [
      { key: 'breakDeductAfterMin', label: 'Take off the break after', unit: 'min worked', def: 300, min: 0, max: 1440 },
    ],
  },
  {
    title: 'Clocking in',
    fields: [
      { key: 'maxShiftHours', label: 'Longest shift', unit: 'hours', def: 20, min: 4, max: 24 },
      { key: 'newShiftWindowMinutes', label: 'New shift starts this early', unit: 'min before the start', def: 120, min: 0, max: 600 },
      { key: 'doubleTapMinutes', label: 'A second tap within this is ignored', unit: 'min', def: 2, min: 0, max: 30 },
      { key: 'phoneQueueMaxHours', label: 'Longest a phone may hold an entry', unit: 'hours', def: 12, min: 0, max: 48 },
      { key: 'queuedReviewMinutes', label: 'Hold entries sent later than', unit: 'min', def: 15, min: 0, max: 1440 },
      { key: 'photoRetentionMonths', label: 'Keep clock-in photos for', unit: 'months', def: 24, min: 1, max: 120 },
    ],
  },
  {
    title: 'Kiosk PIN',
    fields: [
      { key: 'pinMaxTries', label: 'Wrong PINs before a lock', unit: 'tries', def: 5, min: 3, max: 20 },
      { key: 'pinLockMinutes', label: 'First lock lasts', unit: 'min', def: 10, min: 1, max: 1440 },
      { key: 'pinLocksBeforeManager', label: 'Locks in a day before only a manager can unlock', unit: 'locks', def: 3, min: 1, max: 10 },
      { key: 'kioskWrongPinLimit', label: 'Wrong PINs on one kiosk before it pauses', unit: 'tries', def: 10, min: 3, max: 100 },
      { key: 'kioskWrongPinWindowMinutes', label: '… counted over', unit: 'min', def: 10, min: 1, max: 120 },
      { key: 'kioskCooldownMinutes', label: 'Kiosk pause lasts', unit: 'min', def: 5, min: 1, max: 120 },
      { key: 'kioskSessionSeconds', label: 'Kiosk sign-in ends after idle', unit: 'seconds', def: 120, min: 30, max: 600 },
      { key: 'kioskSessionMaxMinutes', label: 'Kiosk sign-in ends after at most', unit: 'min', def: 10, min: 1, max: 60 },
    ],
  },
];
export const HR_SETTING_FIELDS = HR_SETTING_GROUPS.flatMap((g) => g.fields);

/** The stored value of a field (rates live under otRates). */
export function hrSettingValue(settings, field) {
  return field.rate ? settings?.otRates?.[field.key] : settings?.[field.key];
}

/** Typed text → `{ value }` or `{ error }`. */
export function parseHrSetting(field, text) {
  const s = String(text ?? '').trim();
  if (!s) return { error: 'Enter a number' };
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: 'Whole numbers only' };
  if (n < field.min || n > field.max) return { error: `From ${field.min} to ${field.max}` };
  return { value: n };
}

/** Pending field changes → one hr:updateSettings patch (rates merged into otRates). */
export function settingsPatch(pending, current) {
  const out = {};
  for (const [k, v] of Object.entries(pending || {})) {
    if (k.startsWith('otRates.')) {
      out.otRates = { ...(current?.otRates || {}), ...(out.otRates || {}), [k.slice(8)]: v };
    } else out[k] = v;
  }
  return out;
}

export function settingKey(field) { return field.rate ? `otRates.${field.key}` : field.key; }

/** Every default, as a pending map, for "Reset to defaults". */
export function defaultSettingsPending() {
  const out = {};
  for (const f of HR_SETTING_FIELDS) out[settingKey(f)] = f.def;
  out.lateCountsFrom = 'grace';
  out.countEarlyArrival = false;
  return out;
}

/* ─── errors ──────────────────────────────────────────────────────────── */

/** The message to show for a failed call: the server's own sentence, without the "Bad request:" prefix. */
export function errText(err) {
  const msg = String(err?.message ?? err ?? 'Something failed').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (msg.startsWith('CONFLICT|')) return 'Someone else changed this while it was open. Close it and open it again to see their change.';
  return msg.replace(/^Bad request:\s*/, '');
}
