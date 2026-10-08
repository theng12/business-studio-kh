/**
 * HR1: the attendance arithmetic (main/util/attendanceCalc.js) — pure.
 * Standard schedule: 07:00–17:00, 60 min unpaid break, Monday–Saturday,
 * 5 min grace, night window 22:00–05:00. 2026-10-08 is a Thursday,
 * 2026-10-11 a Sunday, 2026-10-15 a public holiday (King Father day).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../main/util/attendanceCalc');

const DAY = { startTime: '07:00', endTime: '17:00', breakMin: 60, workDays: '1111110', graceMin: 5, nightStart: '22:00', nightEnd: '05:00' };
const NIGHT = { startTime: '22:00', endTime: '06:00', breakMin: 60, workDays: '1111111', graceMin: 5, nightStart: '22:00', nightEnd: '05:00' };
const S = c.mergeSettings({});
const at = (date, hm) => c.timeOnDate(date, hm);
const ev = (date, ...pairs) => pairs.flatMap(([i, o], n) => [
  ...(i ? [{ id: `i${n}`, kind: 'in', at: at(date, i) }] : []),
  ...(o ? [{ id: `o${n}`, kind: 'out', at: at(date, o) }] : []),
]);
const LATER = Date.parse('2026-12-01T00:00:00Z');
const day = (date, events, extra = {}) => c.calcDay({ date, schedule: DAY, events, settings: S, now: LATER, ...extra });

test('a normal day: break deducted, no lateness, no overtime', () => {
  const d = day('2026-10-08', ev('2026-10-08', ['06:55', '17:00']));
  assert.equal(d.status, 'present');
  assert.equal(d.grossMin, 605);
  assert.equal(d.breakMin, 60);
  assert.equal(d.workedMin, 545);
  assert.equal(d.lateMin, 0);
  assert.equal(d.earlyLeaveMin, 0);
  assert.deepEqual(d.overtime, { normal: 0, night: 0, restDay: 0, holiday: 0 });
  assert.equal(d.regularMin, 545);
});

test('lateness: inside grace is not late; after grace counts from grace (default) or from the start', () => {
  assert.equal(day('2026-10-08', ev('2026-10-08', ['07:04', '17:00'])).lateMin, 0);
  const late = day('2026-10-08', ev('2026-10-08', ['07:20', '17:00']));
  assert.equal(late.lateMin, 15);
  assert.equal(late.status, 'late');
  const fromStart = day('2026-10-08', ev('2026-10-08', ['07:20', '17:00']), { settings: c.mergeSettings({}, { lateCountsFrom: 'start' }) });
  assert.equal(fromStart.lateMin, 20);
});

test('early leave is the minutes before the scheduled end', () => {
  assert.equal(day('2026-10-08', ev('2026-10-08', ['07:00', '16:30'])).earlyLeaveMin, 30);
});

test('overtime on a work day: after the end, rounded down to 15 min, night part at the night rate', () => {
  const ot = day('2026-10-08', ev('2026-10-08', ['07:00', '19:10']));
  assert.equal(ot.overtime.normal, 120); // 130 → 120
  assert.equal(ot.workedMin, 670);
  assert.equal(ot.regularMin, 550);
  const night = day('2026-10-08', ev('2026-10-08', ['07:00', '23:00']));
  assert.deepEqual(night.overtime, { normal: 300, night: 60, restDay: 0, holiday: 0 });
  assert.deepEqual(day('2026-10-08', ev('2026-10-08', ['07:00', '17:10'])).overtime.normal, 0, 'under 15 min is none');
});

test('early arrival is overtime only when the setting says so', () => {
  const evs = ev('2026-10-08', ['06:00', '17:00']);
  assert.equal(day('2026-10-08', evs).overtime.normal, 0);
  assert.equal(day('2026-10-08', evs, { settings: c.mergeSettings({}, { countEarlyArrival: true }) }).overtime.normal, 60);
});

test('weekly day off and public holiday: every worked minute is overtime in its own category', () => {
  const sun = day('2026-10-11', ev('2026-10-11', ['08:00', '12:00']));
  assert.equal(sun.workDay, false);
  assert.equal(sun.breakMin, 0, '4 h is under the 5 h break rule');
  assert.deepEqual(sun.overtime, { normal: 0, night: 0, restDay: 240, holiday: 0 });
  assert.equal(sun.regularMin, 0);
  const hol = day('2026-10-15', ev('2026-10-15', ['08:00', '16:00']), { holiday: { nameEn: 'King Father', paid: true } });
  assert.deepEqual(hol.overtime, { normal: 0, night: 0, restDay: 0, holiday: 420 });
  assert.equal(hol.lateMin, 0, 'no lateness on a holiday');
});

test('a missing clock-out counts no time and is flagged', () => {
  const d = day('2026-10-08', [{ id: 'a', kind: 'in', at: at('2026-10-08', '07:00') }]);
  assert.equal(d.status, 'incomplete');
  assert.equal(d.missingOut, true);
  assert.equal(d.workedMin, 0);
  assert.ok(d.flags.some((f) => f.code === 'missing_out'));
});

test('absent only on a scheduled work day that is over, with no leave', () => {
  assert.equal(day('2026-10-08', []).status, 'absent');
  assert.equal(day('2026-10-08', []).absentDays, 1);
  assert.equal(day('2026-10-11', []).status, 'off');
  assert.equal(day('2026-10-15', [], { holiday: { nameEn: 'x' } }).status, 'holiday');
  assert.equal(day('2026-10-08', [], { now: at('2026-10-08', '12:00') }).status, 'future');
  assert.equal(day('2026-10-08', [], { leave: { half: null, typeCode: 'annual' } }).status, 'leave');
  assert.equal(day('2026-10-08', [], { leave: { half: 'am', typeCode: 'annual' } }).absentDays, 0.5);
});

test('half-day leave moves the expected start or end to midday', () => {
  const am = day('2026-10-08', ev('2026-10-08', ['12:00', '17:00']), { leave: { half: 'am', typeCode: 'annual' } });
  assert.equal(am.lateMin, 0);
  const pm = day('2026-10-08', ev('2026-10-08', ['07:00', '12:00']), { leave: { half: 'pm', typeCode: 'annual' } });
  assert.equal(pm.earlyLeaveMin, 0);
});

test('a clocked lunch break is not deducted twice', () => {
  const full = day('2026-10-08', ev('2026-10-08', ['07:00', '12:00'], ['13:00', '17:00']));
  assert.equal(full.grossMin, 540);
  assert.equal(full.breakMin, 0);
  assert.equal(full.workedMin, 540);
  const short = day('2026-10-08', ev('2026-10-08', ['07:00', '12:00'], ['12:30', '17:00']));
  assert.equal(short.breakMin, 30);
  assert.equal(short.workedMin, 540);
});

test('a night shift past midnight belongs to the day it started; its normal hours are not overtime', () => {
  const evs = [{ id: 'i', kind: 'in', at: at('2026-10-07', '21:55') }, { id: 'o', kind: 'out', at: at('2026-10-08', '06:10') }];
  const d = c.calcDay({ date: '2026-10-07', schedule: NIGHT, events: evs, settings: S, now: LATER });
  assert.equal(d.grossMin, 495);
  assert.equal(d.workedMin, 435);
  assert.equal(d.lateMin, 0);
  assert.deepEqual(d.overtime, { normal: 0, night: 0, restDay: 0, holiday: 0 });
});

test('pairing ignores a second in and an out with nothing open', () => {
  const p = c.pairEvents([
    { id: 'o0', kind: 'out', at: 1 }, { id: 'i1', kind: 'in', at: 2 }, { id: 'i2', kind: 'in', at: 3 }, { id: 'o3', kind: 'out', at: 10 },
  ]);
  assert.equal(p.pairs.length, 1);
  assert.equal(p.pairs[0].in, 2);
  assert.deepEqual(p.flags.map((f) => f.code), ['orphan_out', 'duplicate_in']);
});

test('the night window crosses midnight', () => {
  const ms = c.nightMs(at('2026-10-08', '21:00'), at('2026-10-08', '21:00') + 10 * 3600e3);
  assert.equal(ms / 60000, 7 * 60); // 22:00–05:00
});

test('decideKind: in/out from the last event; a night shift closes the day it started', () => {
  const today = at('2026-10-08', '17:05');
  const inToday = { kind: 'in', at: at('2026-10-08', '07:00'), workDate: '2026-10-08' };
  assert.deepEqual(c.decideKind({ lastEvent: inToday, now: today, schedule: DAY }), { kind: 'out', workDate: '2026-10-08', flag: null });
  const nightIn = { kind: 'in', at: at('2026-10-07', '21:55'), workDate: '2026-10-07' };
  assert.deepEqual(c.decideKind({ lastEvent: nightIn, now: at('2026-10-08', '06:05'), schedule: NIGHT }), { kind: 'out', workDate: '2026-10-07', flag: null });
  assert.deepEqual(c.decideKind({ lastEvent: nightIn, now: at('2026-10-08', '19:00'), schedule: NIGHT }), { kind: 'in', workDate: '2026-10-08', flag: null }, 'over 20 h');
  assert.deepEqual(c.decideKind({ lastEvent: null, now: today, schedule: DAY }), { kind: 'in', workDate: '2026-10-08', flag: null });
});

test('decideKind: a day shift past midnight (07:00 → 00:30 → 07:00) does not flip the next day', () => {
  const in7 = { kind: 'in', at: at('2026-10-07', '07:00'), workDate: '2026-10-07' };
  const late = c.decideKind({ lastEvent: in7, now: at('2026-10-08', '00:30'), schedule: DAY });
  assert.deepEqual(late, { kind: 'out', workDate: '2026-10-07', flag: 'late_close' }, '00:30 closes yesterday, flagged for review');
  const out = { kind: 'out', at: at('2026-10-08', '00:30'), workDate: '2026-10-07' };
  assert.deepEqual(c.decideKind({ lastEvent: out, now: at('2026-10-08', '07:00'), schedule: DAY }), { kind: 'in', workDate: '2026-10-08', flag: null });
  // A forgotten clock-out (in 11:00 yesterday) and this morning's tap at 06:55 is today's in.
  const in11 = { kind: 'in', at: at('2026-10-07', '11:00'), workDate: '2026-10-07' };
  assert.deepEqual(c.decideKind({ lastEvent: in11, now: at('2026-10-08', '06:55'), schedule: DAY }), { kind: 'in', workDate: '2026-10-08', flag: null });
  // The day's pairs: 07:00–00:30 → 17.5 h, overtime 17:00–00:30 split at 22:00.
  const d = c.calcDay({ date: '2026-10-07', schedule: DAY, events: [{ id: 'a', kind: 'in', at: in7.at }, { id: 'b', kind: 'out', at: out.at }], settings: S, now: LATER });
  assert.deepEqual(d.overtime, { normal: 300, night: 150, restDay: 0, holiday: 0 });
});

test('overtime on a work day is capped at worked − scheduled minutes (late in + late out is not overtime)', () => {
  const d = day('2026-10-08', ev('2026-10-08', ['09:00', '19:00'])); // 2 h late, 2 h after the end
  assert.equal(d.workedMin, 540);
  assert.deepEqual(d.overtime, { normal: 0, night: 0, restDay: 0, holiday: 0 });
  assert.equal(day('2026-10-08', ev('2026-10-08', ['07:30', '19:00'])).overtime.normal, 90, '120 after the end, but only 90 over the scheduled 540');
});

test('a suspended day is never absent or late', () => {
  const d = day('2026-10-08', [], { suspended: true });
  assert.equal(d.status, 'suspended');
  assert.equal(d.absentDays, 0);
  assert.equal(day('2026-10-08', ev('2026-10-08', ['09:00', '17:00']), { suspended: true }).lateMin, 0);
});

test('double tap within 2 minutes; queued phone time is capped and never before the last event', () => {
  const last = { kind: 'in', at: 1_000_000 };
  assert.equal(c.isDoubleTap(last, 1_000_000 + 119_000), true);
  assert.equal(c.isDoubleTap(last, 1_000_000 + 121_000), false);
  const now = Date.parse('2026-10-08T10:00:00Z');
  assert.equal(c.queuedTime({ now, queuedForMs: 48 * 3600e3 }).at, now - 12 * 3600e3, 'capped at 12 h');
  assert.equal(c.queuedTime({ now, queuedForMs: 3600e3, floor: now - 600e3 }).at, now - 600e3 + 1, 'not before the last event');
  assert.deepEqual(c.queuedTime({ now, queuedForMs: null }), { at: now, queuedForMs: null });
});

test('month totals: approved overtime counts only up to what the attendance shows', () => {
  const days = [
    day('2026-10-07', ev('2026-10-07', ['07:00', '19:00'])),   // OT 120
    day('2026-10-08', []),                                      // absent
    day('2026-10-11', ev('2026-10-11', ['08:00', '12:00'])),   // rest-day OT 240
    day('2026-10-09', ev('2026-10-09', ['07:20', '17:00'])),   // late 15, no OT
  ];
  const approved = new Map([
    ['2026-10-07', { normal: 60, night: 0, restDay: 0, holiday: 0 }],
    ['2026-10-09', { normal: 45, night: 0, restDay: 0, holiday: 0, needsReapproval: true }], // attendance changed since
  ]);
  const t = c.summarizeDays(days, { approvedByDate: approved });
  assert.equal(t.daysWorked, 3);
  assert.equal(t.lateDays, 1);
  assert.equal(t.lateMin, 15);
  assert.equal(t.absentDays, 1);
  assert.deepEqual(t.overtimeComputed, { normal: 120, night: 0, restDay: 240, holiday: 0 });
  assert.deepEqual(t.overtimeApproved, { normal: 60, night: 0, restDay: 0, holiday: 0 }, 'the 45 approved on the 9th are not there any more');
  assert.deepEqual(t.overtimePending, { normal: 60, night: 0, restDay: 240, holiday: 0 });
  assert.deepEqual(t.approvalsExceedingAttendance, ['2026-10-09']);
  assert.deepEqual(t.approvalsNeedingReapproval, ['2026-10-09']);
  assert.deepEqual(t.otRates, { normal: 150, night: 200, restDay: 200, holiday: 200 });
});

test('outside the employment window: not employed, never absent', () => {
  assert.equal(day('2026-10-08', [], { employment: { from: '2026-10-09' } }).status, 'not_employed');
  assert.equal(day('2026-10-08', [], { employment: { to: '2026-10-01' } }).absentDays, 0);
});

test('settings: Labour Law defaults, strict validation of a patch', () => {
  assert.deepEqual(S.otRates, { normal: 150, night: 200, restDay: 200, holiday: 200 });
  assert.equal(S.pinMaxTries, 5);
  assert.equal(S.pinLockMinutes, 10);
  assert.equal(S.photoRetentionMonths, 24);
  assert.throws(() => c.mergeSettings({}, { otRates: { normal: 50 } }), /between 100 and 500/);
  assert.throws(() => c.mergeSettings({}, { bogus: 1 }), /Unknown HR setting/);
  assert.equal(c.mergeSettings({ otMinMinutes: 9999 }).otMinMinutes, 15, 'a bad stored value falls back to the default');
});

test('only odd entries (an out with no in) is incomplete, not present', () => {
  const d = day('2026-10-08', [{ id: 'o', kind: 'out', at: at('2026-10-08', '17:00') }]);
  assert.equal(d.status, 'incomplete');
  assert.equal(d.oddEntries, true);
  assert.equal(d.workedMin, 0);
  assert.equal(day('2026-10-08', ev('2026-10-08', ['07:00', '17:00'])).oddEntries, false);
});

test('clock entries on a suspended day are counted and the day is marked', () => {
  const d = day('2026-10-08', ev('2026-10-08', ['07:00', '17:00']), { suspended: true });
  assert.equal(d.status, 'suspended_with_events');
  assert.equal(d.workedMin, 540);
  assert.ok(d.flags.some((f) => f.code === 'suspended_with_events'));
});

test('approved overtime is counted at the rate stored on the approval', () => {
  const days = [day('2026-10-07', ev('2026-10-07', ['07:00', '19:00']))]; // 120 normal
  const t = c.summarizeDays(days, {
    approvedByDate: new Map([['2026-10-07', { normal: 90, night: 0, restDay: 0, holiday: 0, rates: { normal: 150, night: 200, restDay: 200, holiday: 200 } }]]),
    settings: c.mergeSettings({}, { otRates: { normal: 175 } }),
  });
  assert.deepEqual(t.overtimeApprovedByRate.normal, { 150: 90 });
  assert.equal(t.overtimeApprovedWeightedMin, 135);
  assert.equal(t.otRates.normal, 175, 'computed / pending are labelled with the current rate');
  const legacy = c.summarizeDays(days, { approvedByDate: new Map([['2026-10-07', { normal: 60, night: 0, restDay: 0, holiday: 0 }]]) });
  assert.deepEqual(legacy.overtimeApprovedByRate.normal, { 150: 60 }, 'an approval without stored rates falls back to the current rate');
});
