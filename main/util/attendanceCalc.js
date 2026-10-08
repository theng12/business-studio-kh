/**
 * HR1: attendance arithmetic — pure, no database (docs/PEOPLE_AND_FUEL_PLAN.md
 * §3.2, §7b). Everything about a person's day is computed here from the
 * clock events, the schedule in force that day, the holiday list and any
 * approved leave; nothing derived is stored (§3.2: "computed at read time").
 *
 * Times are epoch ms; dates are 'YYYY-MM-DD' in Asia/Phnom_Penh (UTC+7, no
 * daylight saving, so a fixed offset is exact).
 *
 * The rules, per person per day (see `calcDay`):
 *
 *   pairs        events sorted by time; an `in` opens, the next `out` closes.
 *                A second `in` while one is open is ignored (flag
 *                `duplicate_in`); an `out` with nothing open is ignored
 *                (flag `orphan_out`); an `in` never closed is `missing_out`
 *                and counts NO worked time — the app never guesses a time.
 *   gross        Σ (out − in) over the pairs, in minutes.
 *   break        the schedule's break is unpaid. If gross > breakDeductAfterMin
 *                (default 300 = 5 h), deduct max(0, breakMin − gaps), where
 *                gaps = minutes clocked out between pairs (someone who clocked
 *                out for lunch has already taken it off).
 *   worked       gross − break.
 *   late         work day, not a holiday, not on full-day leave, first `in`
 *                after expectedStart + grace:
 *                  lateCountsFrom 'grace' (default): first in − (start + grace)
 *                  lateCountsFrom 'start':           first in − start
 *                (a morning half-day of leave moves expectedStart to the
 *                middle of the scheduled day).
 *   early leave  last `out` before expectedEnd: expectedEnd − last out
 *                (an afternoon half-day of leave moves expectedEnd to the middle).
 *   absent       a scheduled work day, not a holiday, not on leave, no event at
 *                all, and the day is over (absentDays 1, or 0.5 beside a half
 *                day of leave).
 *   overtime     (Labour Law defaults, owner-editable rates — §7b)
 *                public holiday  → every worked minute is `holiday`   (200 %)
 *                weekly day off  → every worked minute is `restDay`   (200 %)
 *                work day        → minutes worked after the scheduled end
 *                                  (and before the start when
 *                                  countEarlyArrival is on); of those, the
 *                                  ones inside the night window are `night`
 *                                  (200 %), the rest `normal` (150 %).
 *                On a work day the overtime is never more than
 *                max(0, worked − scheduled minutes) (scheduled = shift length −
 *                break): arriving late and staying late is not overtime.
 *                A day's overtime under otMinMinutes (15) counts as none; each
 *                category is rounded DOWN to otRoundMinutes (15).
 *   suspended    a day inside a suspension is `suspended`: never absent, never late.
 *   regular      worked − overtime.
 *
 * Overtime and lateness are only COMPUTED here. Payroll (HR2) pays approved
 * overtime minutes only and deducts lateness only after a month's
 * confirmation — both live in the database (overtime_approvals,
 * lateness_confirmations).
 */

const PP_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86400 * 1000;
const MIN_MS = 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
  otRates: Object.freeze({ normal: 150, night: 200, restDay: 200, holiday: 200 }),
  otMinMinutes: 15,
  otRoundMinutes: 15,
  countEarlyArrival: false,
  lateCountsFrom: 'grace',
  breakDeductAfterMin: 300,
  maxShiftHours: 20,
  newShiftWindowMinutes: 120,
  doubleTapMinutes: 2,
  phoneQueueMaxHours: 12,
  queuedReviewMinutes: 15,
  photoRetentionMonths: 24,
  pinMaxTries: 5,
  pinLockMinutes: 10,
  pinLocksBeforeManager: 3,
  kioskWrongPinLimit: 10,
  kioskWrongPinWindowMinutes: 10,
  kioskCooldownMinutes: 5,
  kioskSessionSeconds: 120,
  kioskSessionMaxMinutes: 10,
});

const SETTING_RANGES = {
  otMinMinutes: [0, 240],
  otRoundMinutes: [1, 60],
  breakDeductAfterMin: [0, 1440],
  maxShiftHours: [4, 24],
  newShiftWindowMinutes: [0, 600],
  doubleTapMinutes: [0, 30],
  phoneQueueMaxHours: [0, 48],
  queuedReviewMinutes: [0, 1440],
  photoRetentionMonths: [1, 120],
  pinMaxTries: [3, 20],
  pinLockMinutes: [1, 1440],
  pinLocksBeforeManager: [1, 10],
  kioskWrongPinLimit: [3, 100],
  kioskWrongPinWindowMinutes: [1, 120],
  kioskCooldownMinutes: [1, 120],
  kioskSessionSeconds: [30, 600],
  kioskSessionMaxMinutes: [1, 60],
};
const OT_KEYS = ['normal', 'night', 'restDay', 'holiday'];

/** Merge stored settings over the defaults, refusing anything out of range. */
function mergeSettings(stored = {}, patch = null) {
  const out = { ...DEFAULT_SETTINGS, otRates: { ...DEFAULT_SETTINGS.otRates } };
  const apply = (src, strict) => {
    if (!src || typeof src !== 'object') return;
    for (const [k, v] of Object.entries(src)) {
      if (k === 'otRates') {
        if (!v || typeof v !== 'object') { if (strict) throw new Error('otRates must be { normal, night, restDay, holiday }'); continue; }
        for (const [rk, rv] of Object.entries(v)) {
          if (!OT_KEYS.includes(rk)) { if (strict) throw new Error(`Unknown overtime rate: ${rk}`); continue; }
          const n = Number(rv);
          if (!Number.isFinite(n) || n < 100 || n > 500) { if (strict) throw new Error(`Overtime rate ${rk} must be between 100 and 500 (%)`); continue; }
          out.otRates[rk] = n;
        }
      } else if (k === 'countEarlyArrival') {
        out.countEarlyArrival = !!v;
      } else if (k === 'lateCountsFrom') {
        if (v !== 'grace' && v !== 'start') { if (strict) throw new Error("lateCountsFrom must be 'grace' or 'start'"); continue; }
        out.lateCountsFrom = v;
      } else if (k in SETTING_RANGES) {
        const n = Number(v);
        const [lo, hi] = SETTING_RANGES[k];
        if (!Number.isFinite(n) || n < lo || n > hi) { if (strict) throw new Error(`${k} must be a number from ${lo} to ${hi}`); continue; }
        out[k] = n;
      } else if (k === 'defaultScheduleId') {
        out.defaultScheduleId = v == null ? null : String(v);
      } else if (k === 'attendanceStartDate') {
        if (v != null && !isDate(v)) { if (strict) throw new Error('attendanceStartDate must be a real date like 2026-10-01'); continue; }
        out.attendanceStartDate = v == null ? null : v;
      } else if (strict) {
        throw new Error(`Unknown HR setting: ${k}`);
      }
    }
  };
  apply(stored, false);
  apply(patch, true);
  return out;
}

/* ─── dates ───────────────────────────────────────────────────── */

function ppDate(ms) { return new Date(Number(ms) + PP_OFFSET_MS).toISOString().slice(0, 10); }
function ppMonth(ms) { return ppDate(ms).slice(0, 7); }

function isDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
function isMonth(v) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v ?? '')); }

/** 00:00 of a Phnom Penh date, as epoch ms. */
function dateStartMs(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return Date.UTC(y, m - 1, d) - PP_OFFSET_MS;
}
function addDays(date, n) { return ppDate(dateStartMs(date) + n * DAY_MS + 12 * 3600 * 1000); }
/** 0 = Monday … 6 = Sunday (the order of a schedule's work_days mask). */
function weekdayMon0(date) { return (new Date(dateStartMs(date) + PP_OFFSET_MS).getUTCDay() + 6) % 7; }
function monthDates(month) {
  const out = [];
  let d = `${month}-01`;
  while (d.startsWith(month)) { out.push(d); d = addDays(d, 1); }
  return out;
}
function prevMonth(month) { return ppMonth(dateStartMs(`${month}-01`) - DAY_MS + 12 * 3600 * 1000); }
function nextMonth(month) { return ppMonth(dateStartMs(`${month}-01`) + 32 * DAY_MS); }
function lastDayOfMonth(month) { const d = monthDates(month); return d[d.length - 1]; }

/* ─── schedules ───────────────────────────────────────────────── */

function parseHm(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function isHm(v) { return parseHm(v) != null; }
function isWorkDaysMask(v) { return /^[01]{7}$/.test(String(v ?? '')); }

function isWorkDay(schedule, date) {
  if (!schedule || !isWorkDaysMask(schedule.workDays)) return false;
  return schedule.workDays[weekdayMon0(date)] === '1';
}

/** True when the shift ends on the next calendar day (a night shift). */
function crossesMidnight(schedule) {
  const s = parseHm(schedule?.startTime);
  const e = parseHm(schedule?.endTime);
  return s != null && e != null && e <= s;
}

/** The scheduled shift of a date: { start, end } epoch ms (end next day for a night shift). */
function scheduledWindow(schedule, date) {
  const s = parseHm(schedule?.startTime);
  const e = parseHm(schedule?.endTime);
  if (s == null || e == null) return null;
  const base = dateStartMs(date);
  const start = base + s * MIN_MS;
  let end = base + e * MIN_MS;
  if (end <= start) end += DAY_MS;
  return { start, end };
}

function overlapMs(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/** Milliseconds of [from, to) that fall inside the daily night window (e.g. 22:00–05:00). */
function nightMs(from, to, nightStart = '22:00', nightEnd = '05:00') {
  if (!(to > from)) return 0;
  const ns = parseHm(nightStart);
  const ne = parseHm(nightEnd);
  if (ns == null || ne == null || ns === ne) return 0;
  let total = 0;
  for (let day = ppDate(from - DAY_MS); dateStartMs(day) <= to; day = addDays(day, 1)) {
    const base = dateStartMs(day);
    const w0 = base + ns * MIN_MS;
    const w1 = ne > ns ? base + ne * MIN_MS : base + DAY_MS + ne * MIN_MS;
    total += overlapMs(from, to, w0, w1);
  }
  return total;
}

/* ─── events → pairs ──────────────────────────────────────────── */

/**
 * Pair a day's events. `events`: [{ id, kind: 'in'|'out', at }] — already
 * filtered to active (not voided, not superseded) events.
 */
function pairEvents(events) {
  const sorted = [...(events || [])].sort((a, b) => a.at - b.at || (a.kind === 'in' ? -1 : 1));
  const pairs = [];
  const flags = [];
  let open = null;
  for (const ev of sorted) {
    if (ev.kind === 'in') {
      if (open) { flags.push({ code: 'duplicate_in', eventId: ev.id ?? null, at: ev.at }); continue; }
      open = ev;
    } else if (ev.kind === 'out') {
      if (!open) { flags.push({ code: 'orphan_out', eventId: ev.id ?? null, at: ev.at }); continue; }
      pairs.push({ in: open.at, out: ev.at, inId: open.id ?? null, outId: ev.id ?? null });
      open = null;
    }
  }
  if (open) flags.push({ code: 'missing_out', eventId: open.id ?? null, at: open.at });
  return { pairs, openIn: open, flags, firstIn: sorted.find((e) => e.kind === 'in')?.at ?? null };
}

/* ─── one day ─────────────────────────────────────────────────── */

const minutes = (ms) => Math.max(0, Math.floor(ms / MIN_MS));
function roundDown(min, step) { return step > 1 ? Math.floor(min / step) * step : min; }

/**
 * @param {object} p
 * @param {string} p.date                 'YYYY-MM-DD'
 * @param {object|null} p.schedule       { startTime, endTime, breakMin, workDays, graceMin, nightStart, nightEnd }
 * @param {Array}  p.events              active events whose work_date is this date
 * @param {object|null} p.holiday        { nameEn, nameKm, paid } when a public holiday
 * @param {object|null} p.leave          { half: null|'am'|'pm', typeCode, paid } approved leave covering the date
 * @param {object} [p.employment]        { from: 'YYYY-MM-DD'|null, to: 'YYYY-MM-DD'|null } — from = the later
 *                                       of the hire date and the date attendance started being kept
 * @param {boolean} [p.suspended]        the person is suspended that day
 * @param {object} [p.settings]          mergeSettings() result
 * @param {number} [p.now]               for "is the day over yet"
 */
function calcDay({ date, schedule = null, events = [], holiday = null, leave = null, employment = {}, suspended = false, settings = DEFAULT_SETTINGS, now = Date.now() }) {
  const s = settings || DEFAULT_SETTINGS;
  const empty = { normal: 0, night: 0, restDay: 0, holiday: 0 };
  const res = {
    date, workDay: false, holiday: holiday || null, leave: leave || null, status: 'off',
    firstIn: null, lastOut: null, grossMin: 0, breakMin: 0, workedMin: 0, regularMin: 0,
    lateMin: 0, earlyLeaveMin: 0, absentDays: 0, missingOut: false,
    overtime: { ...empty }, flags: [], scheduled: null,
  };
  const employed = (!employment?.from || date >= employment.from) && (!employment?.to || date <= employment.to);
  if (!employed && !events.length) { res.status = 'not_employed'; return res; }

  const workDay = isWorkDay(schedule, date);
  res.workDay = workDay;
  const win = schedule ? scheduledWindow(schedule, date) : null;
  res.scheduled = win;

  const { pairs, openIn, flags } = pairEvents(events);
  res.flags = flags;
  res.missingOut = !!openIn;
  if (pairs.length) {
    res.firstIn = pairs[0].in;
    res.lastOut = pairs[pairs.length - 1].out;
  }
  if (openIn && (res.firstIn == null || openIn.at < res.firstIn)) res.firstIn = openIn.at;

  const grossMs = pairs.reduce((t, p) => t + (p.out - p.in), 0);
  res.grossMin = minutes(grossMs);
  let gapsMs = 0;
  for (let i = 1; i < pairs.length; i += 1) gapsMs += Math.max(0, pairs[i].in - pairs[i - 1].out);
  const breakMin = Number(schedule?.breakMin) || 0;
  if (breakMin > 0 && res.grossMin > s.breakDeductAfterMin) {
    res.breakMin = Math.min(res.grossMin, Math.max(0, breakMin - minutes(gapsMs)));
  }
  res.workedMin = Math.max(0, res.grossMin - res.breakMin);

  const fullLeave = !!leave && !leave.half;
  const dayOver = win ? now >= win.end : now >= dateStartMs(date) + DAY_MS;

  // Overtime.
  const ot = { ...empty };
  if (res.workedMin > 0) {
    if (holiday) ot.holiday = res.workedMin;
    else if (!workDay) ot.restDay = res.workedMin;
    else if (win) {
      let extraMs = 0;
      let extraNightMs = 0;
      for (const p of pairs) {
        const after = [Math.max(p.in, win.end), p.out];
        if (after[1] > after[0]) {
          extraMs += after[1] - after[0];
          extraNightMs += nightMs(after[0], after[1], schedule.nightStart, schedule.nightEnd);
        }
        if (s.countEarlyArrival) {
          const before = [p.in, Math.min(p.out, win.start)];
          if (before[1] > before[0]) {
            extraMs += before[1] - before[0];
            extraNightMs += nightMs(before[0], before[1], schedule.nightStart, schedule.nightEnd);
          }
        }
      }
      ot.night = minutes(extraNightMs);
      ot.normal = Math.max(0, minutes(extraMs) - ot.night);
      // Late in + late out is not overtime: never more than worked − scheduled.
      const scheduledMin = Math.max(0, minutes(win.end - win.start) - (Number(schedule.breakMin) || 0));
      let over = (ot.normal + ot.night) - Math.max(0, res.workedMin - scheduledMin);
      if (over > 0) { const cut = Math.min(ot.normal, over); ot.normal -= cut; over -= cut; ot.night = Math.max(0, ot.night - over); }
    }
    const total = ot.normal + ot.night + ot.restDay + ot.holiday;
    if (total < s.otMinMinutes) { ot.normal = 0; ot.night = 0; ot.restDay = 0; ot.holiday = 0; }
    for (const k of Object.keys(ot)) ot[k] = roundDown(ot[k], s.otRoundMinutes);
    // Never more overtime than time worked (the break comes off regular time first).
    const sum = ot.normal + ot.night + ot.restDay + ot.holiday;
    if (sum > res.workedMin) {
      let over = sum - res.workedMin;
      for (const k of ['normal', 'night', 'restDay', 'holiday']) { const cut = Math.min(ot[k], over); ot[k] -= cut; over -= cut; }
    }
  }
  res.overtime = ot;
  res.regularMin = Math.max(0, res.workedMin - (ot.normal + ot.night + ot.restDay + ot.holiday));

  // Lateness and early leave: scheduled work days only.
  if (workDay && !holiday && !fullLeave && !suspended && win) {
    const mid = win.start + Math.floor((win.end - win.start) / 2);
    const expectedStart = leave?.half === 'am' ? mid : win.start;
    const expectedEnd = leave?.half === 'pm' ? mid : win.end;
    const graceMs = (Number(schedule.graceMin) || 0) * MIN_MS;
    if (res.firstIn != null && res.firstIn > expectedStart + graceMs) {
      res.lateMin = minutes(res.firstIn - (s.lateCountsFrom === 'start' ? expectedStart : expectedStart + graceMs));
    }
    if (!openIn && res.lastOut != null && res.lastOut < expectedEnd) {
      res.earlyLeaveMin = minutes(expectedEnd - res.lastOut);
    }
  }

  // Status.
  const anyEvent = events.length > 0;
  // Outside the employment window only a day WITH events is reported (as usual); never absent.
  if (!employed && !anyEvent) res.status = 'not_employed';
  else if (suspended && !anyEvent) res.status = 'suspended';
  else if (holiday && !anyEvent) res.status = 'holiday';
  else if (fullLeave && !anyEvent) res.status = 'leave';
  else if (!workDay && !anyEvent) res.status = 'off';
  else if (!anyEvent) {
    if (!dayOver) res.status = 'future';
    else { res.status = 'absent'; res.absentDays = leave?.half ? 0.5 : 1; }
  } else if (openIn) res.status = 'incomplete';
  else if (res.lateMin > 0) res.status = 'late';
  else res.status = 'present';
  return res;
}

/* ─── a month ─────────────────────────────────────────────────── */

const zeroOt = () => ({ normal: 0, night: 0, restDay: 0, holiday: 0 });

/**
 * Totals for one person over a list of calcDay results, plus the overtime
 * already approved (per work date) so the pending part is known.
 *   approvedByDate: Map<date, { normal, night, restDay, holiday }>
 * approved (per category) = Σ over days of min(approved, computed) — never more
 * than the attendance now shows; days where the approval is larger are listed
 * in approvalsExceedingAttendance.
 * pending (per category) = Σ over days of max(0, computed − approved).
 */
function summarizeDays(days, { approvedByDate = new Map(), settings = DEFAULT_SETTINGS } = {}) {
  const t = {
    days: days.length, daysWorked: 0, workedMin: 0, regularMin: 0, lateDays: 0, lateMin: 0,
    earlyLeaveDays: 0, earlyLeaveMin: 0, absentDays: 0, leaveDays: 0, holidays: 0, offDays: 0,
    missingOutDays: 0, suspendedDays: 0, overtimeComputed: zeroOt(), overtimeApproved: zeroOt(), overtimePending: zeroOt(),
    approvalsExceedingAttendance: [], approvalsNeedingReapproval: [],
    otRates: { ...(settings?.otRates || DEFAULT_SETTINGS.otRates) },
  };
  for (const d of days) {
    if (d.workedMin > 0) t.daysWorked += 1;
    t.workedMin += d.workedMin;
    t.regularMin += d.regularMin;
    if (d.lateMin > 0) { t.lateDays += 1; t.lateMin += d.lateMin; }
    if (d.earlyLeaveMin > 0) { t.earlyLeaveDays += 1; t.earlyLeaveMin += d.earlyLeaveMin; }
    t.absentDays += d.absentDays;
    if (d.leave) t.leaveDays += d.leave.half ? 0.5 : 1;
    if (d.holiday) t.holidays += 1;
    if (d.status === 'off') t.offDays += 1;
    if (d.status === 'suspended') t.suspendedDays += 1;
    if (d.missingOut) t.missingOutDays += 1;
    const ap = approvedByDate.get(d.date) || zeroOt();
    let exceeds = false;
    for (const k of Object.keys(t.overtimeComputed)) {
      const computed = d.overtime[k] || 0;
      const approved = ap[k] || 0;
      // Payroll may only ever use min(approved, computed): an approval given
      // before the attendance changed cannot pay minutes that are no longer there.
      if (approved > computed) exceeds = true;
      t.overtimeComputed[k] += computed;
      t.overtimeApproved[k] += Math.min(approved, computed);
      t.overtimePending[k] += Math.max(0, computed - approved);
    }
    if (exceeds) t.approvalsExceedingAttendance.push(d.date);
    if (ap.needsReapproval) t.approvalsNeedingReapproval.push(d.date);
  }
  return t;
}

/* ─── clocking ────────────────────────────────────────────────── */

/**
 * Is this tap an `in` or an `out`, and which work day does it belong to?
 *   - the person's last active event is an `in` of TODAY → `out` of today;
 *   - it is an `in` of an earlier day, less than maxShiftHours (20) ago:
 *       night shift (the schedule crosses midnight) → `out` of THAT day;
 *       day shift → `out` of that day too, flagged `late_close` for review
 *       (07:00 in, 00:30 out after a long night) — unless the tap is already
 *       inside today's new-shift window (newShiftWindowMinutes, 120, before
 *       today's scheduled start): then it is today's `in` and yesterday's `in`
 *       stays open as a missing clock-out;
 *   - otherwise `in` of today. An open `in` is never closed by a guess.
 * Returns { kind, workDate, flag: null | 'late_close' }.
 */
function decideKind({ lastEvent = null, now, schedule = null, settings = DEFAULT_SETTINGS }) {
  const today = ppDate(now);
  const s = settings || DEFAULT_SETTINGS;
  if (lastEvent && lastEvent.kind === 'in') {
    if (lastEvent.workDate === today) return { kind: 'out', workDate: today, flag: null };
    const maxMs = (s.maxShiftHours ?? DEFAULT_SETTINGS.maxShiftHours) * 3600 * 1000;
    if (now - lastEvent.at <= maxMs) {
      if (crossesMidnight(schedule)) return { kind: 'out', workDate: lastEvent.workDate, flag: null };
      const win = schedule ? scheduledWindow(schedule, today) : null;
      const windowMs = (s.newShiftWindowMinutes ?? DEFAULT_SETTINGS.newShiftWindowMinutes) * MIN_MS;
      const newShift = win ? now >= win.start - windowMs : false;
      if (!newShift) return { kind: 'out', workDate: lastEvent.workDate, flag: 'late_close' };
    }
  }
  return { kind: 'in', workDate: today, flag: null };
}

/** A second tap by the same person within doubleTapMinutes returns the first one. */
function isDoubleTap(lastEvent, now, settings = DEFAULT_SETTINGS) {
  if (!lastEvent) return false;
  const ms = (settings?.doubleTapMinutes ?? DEFAULT_SETTINGS.doubleTapMinutes) * MIN_MS;
  return ms > 0 && now - lastEvent.at >= 0 && now - lastEvent.at < ms;
}

/**
 * When a phone record that waited offline happened: now − wait, the wait
 * capped at phoneQueueMaxHours, and never at or before `floor` (the person's
 * last event) — a long or tampered wait cannot slip a clock-in behind one
 * already saved. Returns { at, queuedForMs }.
 */
function queuedTime({ now, queuedForMs, floor = null, settings = DEFAULT_SETTINGS }) {
  const capMs = (settings?.phoneQueueMaxHours ?? DEFAULT_SETTINGS.phoneQueueMaxHours) * 3600 * 1000;
  const n = Number(queuedForMs);
  const wait = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), capMs) : 0;
  let at = now - wait;
  if (floor != null && at <= floor) at = Math.min(now, floor + 1);
  return { at, queuedForMs: wait > 0 ? wait : null };
}

/** Proposed 'HH:MM' on a work date → epoch ms (an out earlier than the in is the next morning). */
function timeOnDate(date, hm, { after = null } = {}) {
  const m = parseHm(hm);
  if (m == null) return null;
  let t = dateStartMs(date) + m * MIN_MS;
  if (after != null && t <= after) t += DAY_MS;
  return t;
}

module.exports = {
  PP_OFFSET_MS, DAY_MS, MIN_MS, DEFAULT_SETTINGS, SETTING_RANGES, OT_KEYS,
  mergeSettings, ppDate, ppMonth, isDate, isMonth, dateStartMs, addDays, weekdayMon0, monthDates,
  prevMonth, nextMonth, lastDayOfMonth, parseHm, isHm, isWorkDaysMask, isWorkDay, crossesMidnight,
  scheduledWindow, nightMs, pairEvents, calcDay, summarizeDays, decideKind, isDoubleTap, queuedTime, timeOnDate,
};
