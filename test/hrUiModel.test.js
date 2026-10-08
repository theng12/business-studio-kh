/**
 * HR1 desktop screens — the pure view model (renderer/modules/People/hrModel.js):
 * Phnom Penh times, the month grid cells, event badges, the overtime and
 * lateness states, the form rules, PINs, which profile fields a caller sees,
 * and the Settings → People fields. Where the backend owns a rule (PIN rules,
 * setting ranges, the narrowed record, the 2027 holiday note) the test reads
 * the backend's own module or source so a drift fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function load(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const M = load('renderer/modules/People/hrModel.js');
const calc = require('../main/util/attendanceCalc');
const kioskPin = require('../main/util/kioskPin');
const holidays = require('../main/util/cambodiaHolidays');

const PP = 7 * 3600 * 1000;
const at = (date, hm) => Date.parse(`${date}T${hm}:00Z`) - PP; // a Phnom Penh wall time

test('times are Phnom Penh wall times; a night-shift clock-out says +1', () => {
  assert.equal(M.fmtHm(at('2026-10-08', '07:52')), '07:52');
  assert.equal(M.fmtHm(null), '—');
  assert.equal(M.fmtHmOn(at('2026-10-09', '06:10'), '2026-10-08'), '06:10 +1');
  assert.equal(M.fmtHmOn(at('2026-10-08', '17:00'), '2026-10-08'), '17:00');
  assert.equal(M.hmToMs('2026-10-08', '07:30'), at('2026-10-08', '07:30'));
  assert.equal(M.hmToMs('2026-10-08', '06:10', { nextDay: true }), at('2026-10-09', '06:10'));
  assert.equal(M.hmToMs('2026-10-08', '7:30'), null);
  assert.equal(M.hmToMs('2026-10-31', '23:59', { nextDay: true }), at('2026-11-01', '23:59'), 'month roll-over');
  assert.equal(M.ppDateKey(at('2026-10-08', '23:30')), '2026-10-08', 'late evening is still that day in Phnom Penh');
});

test('minutes read as hours and minutes', () => {
  assert.equal(M.fmtMinutes(0), '0 min');
  assert.equal(M.fmtMinutes(45), '45 min');
  assert.equal(M.fmtMinutes(425), '7 h 05 min');
  assert.equal(M.fmtMinutes(-30), '−30 min');
  assert.equal(M.fmtMinutes(undefined), '—');
  assert.equal(M.fmtHours(545), '9:05');
});

test('month dates and weekdays agree with the backend', () => {
  assert.deepEqual(M.monthDates('2026-02'), calc.monthDates('2026-02'));
  assert.equal(M.monthDates('2028-02').length, 29);
  for (const d of ['2026-10-05', '2026-10-08', '2026-10-11', '2027-01-01']) assert.equal(M.weekdayMon0(d), calc.weekdayMon0(d), d);
  assert.equal(M.prevMonth('2026-01'), '2025-12');
  assert.equal(M.monthEnded('2026-09', at('2026-10-08', '09:00')), true);
  assert.equal(M.monthEnded('2026-10', at('2026-10-08', '09:00')), false);
  assert.equal(M.addDays('2026-12-31', 1), '2027-01-01');
});

test('every status the calculation can return has a label, tone and grid letter', () => {
  // The statuses calcDay sets (main/util/attendanceCalc.js).
  const src = read('main/util/attendanceCalc.js');
  const statuses = new Set([...src.matchAll(/res\.status = '([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(statuses.size >= 9, [...statuses].join(','));
  for (const s of statuses) {
    assert.ok(M.DAY_STATUS[s], `label for ${s}`);
    assert.ok(['emerald', 'amber', 'rose', 'blue', 'slate'].includes(M.DAY_STATUS[s].tone));
  }
  assert.equal(M.dayStatusOf('nonsense').letter, '?');
  for (const k of M.GRID_LEGEND) assert.ok(M.DAY_STATUS[k], k);
});

test('a month-grid cell: letter, tone and a tooltip that says the figures', () => {
  const day = {
    date: '2026-10-08', status: 'late', firstIn: at('2026-10-08', '07:20'), lastOut: at('2026-10-08', '18:00'),
    lateMin: 15, overtime: { normal: 45, night: 0, restDay: 0, holiday: 0 },
  };
  const c = M.gridCell(day);
  assert.equal(c.letter, 'L');
  assert.equal(c.tone, 'amber');
  assert.match(c.title, /in 07:20/);
  assert.match(c.title, /15 min late/);
  assert.match(c.title, /45 min overtime/);
  const half = M.gridCell({ date: '2026-10-09', status: 'present', leave: { half: 'pm' } });
  assert.equal(half.letter, 'P½', 'a half day of leave beside work is marked');
  assert.match(half.title, /Leave \(afternoon\)/);
  assert.equal(M.gridCell({ date: '2026-10-10', status: 'holiday', holiday: { nameEn: 'Pchum Ben' } }).letter, 'H');
  assert.match(M.gridCell({ date: '2026-10-10', status: 'holiday', holiday: { nameEn: 'Pchum Ben' } }).title, /Pchum Ben/);
  assert.equal(M.gridCell({ date: '2026-10-10', status: 'not_employed' }).letter, '');
  assert.equal(M.gridCell({ date: '2026-10-10', status: 'suspended' }).tone, 'rose');
});

test('event badges: voided, rejected, replaced, held, sent late, waiting', () => {
  const labels = (ev) => M.eventBadges(ev).map((b) => b.label);
  assert.deepEqual(labels({ voided: true, reviewStatus: 'none' }), ['Voided']);
  assert.deepEqual(labels({ voided: true, reviewStatus: 'rejected' }), ['Rejected']);
  assert.deepEqual(labels({ supersededById: 'x', reviewStatus: 'none' }), ['Replaced by a correction']);
  assert.deepEqual(labels({ reviewStatus: 'pending', held: true, queuedLong: true }), ['Waiting for review', 'Held — not counted']);
  assert.deepEqual(labels({ reviewStatus: 'accepted', queuedLong: true }), ['Accepted', 'Sent late']);
  const sorted = M.sortDayEvents([
    { id: 'v', at: 1, voided: true }, { id: 'b', at: 3 }, { id: 'a', at: 2 }, { id: 's', at: 0, supersededById: 'x' },
  ]).map((e) => e.id);
  assert.deepEqual(sorted, ['a', 'b', 's', 'v'], 'live entries first, by time; voided / replaced last');
  for (const s of ['kiosk', 'phone', 'supervisor', 'manual', 'correction']) assert.notEqual(M.sourceLabel(s), s, `source ${s} has words`);
});

test('overtime rows: one per person per day with overtime or an approval, with its state', () => {
  const summary = {
    rows: [{
      employeeId: 'e1', nameEn: 'Dara', staffCode: 'D01',
      days: [
        { date: '2026-10-01', overtime: { normal: 60, night: 0, restDay: 0, holiday: 0 } },
        { date: '2026-10-02', overtime: { normal: 0, night: 0, restDay: 0, holiday: 0 } },
        { date: '2026-10-03', overtime: { normal: 30, night: 30, restDay: 0, holiday: 0 } },
        { date: '2026-10-04', overtime: { normal: 0, night: 0, restDay: 240, holiday: 0 } },
        { date: '2026-10-05', overtime: { normal: 15, night: 0, restDay: 0, holiday: 0 } },
        { date: '2026-10-06', overtime: { normal: 0, night: 0, restDay: 0, holiday: 0 } },
      ],
    }],
  };
  const approvals = [
    { id: 'a3', employeeId: 'e1', workDate: '2026-10-03', minutes: { normal: 30, night: 30, restDay: 0, holiday: 0 } },
    { id: 'a4', employeeId: 'e1', workDate: '2026-10-04', minutes: { normal: 0, night: 0, restDay: 120, holiday: 0 } },
    { id: 'a5', employeeId: 'e1', workDate: '2026-10-05', minutes: { normal: 15, night: 0, restDay: 0, holiday: 0 }, needsReapproval: true },
    { id: 'a6', employeeId: 'e1', workDate: '2026-10-06', minutes: { normal: 60, night: 0, restDay: 0, holiday: 0 } },
    { id: 'old', employeeId: 'e1', workDate: '2026-10-01', minutes: { normal: 60 }, voided: true },
  ];
  const rows = M.overtimeRows(summary, approvals);
  assert.deepEqual(rows.map((r) => [r.date, r.state]), [
    ['2026-10-01', 'pending'], // the voided approval does not count
    ['2026-10-03', 'approved'],
    ['2026-10-04', 'partial'],
    ['2026-10-05', 'reapprove'],
    ['2026-10-06', 'exceeds'], // approved 60, the attendance now shows none
  ]);
  assert.deepEqual(M.overtimeNeedsLook(rows).map((r) => r.date), ['2026-10-01', '2026-10-05', '2026-10-06']);
  for (const s of Object.keys(M.OT_STATE)) assert.ok(M.OT_STATE[s].label);
  assert.equal(M.otTotal(rows[1].computed), 60);
  assert.equal(M.ratesLine({ normal: 150, night: 200, restDay: 200, holiday: 200 }), 'Normal 150 % · Night 200 % · Day off 200 % · Holiday 200 %');
  // The categories are the backend's.
  assert.deepEqual(M.OT_CATEGORIES.map((c) => c.key), calc.OT_KEYS);
});

test('adjusting overtime never goes above what the attendance shows', () => {
  const computed = { normal: 60, night: 30, restDay: 0, holiday: 0 };
  const ok = M.validateOvertimeAdjust({ normal: '45', night: '30', restDay: '', holiday: '0' }, computed);
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.minutes, { normal: 45, night: 30, restDay: 0, holiday: 0 });
  const bad = M.validateOvertimeAdjust({ normal: '90', night: '-1', restDay: '1.5', holiday: '0' }, computed);
  assert.match(bad.errors.normal, /At most 60 min/);
  assert.ok(bad.errors.night && bad.errors.restDay);
});

test('lateness: state of a month, and a waiver needs a note', () => {
  assert.equal(M.latenessState({ totals: { lateMin: 0, earlyLeaveMin: 0 } }), 'none');
  assert.equal(M.latenessState({ totals: { lateMin: 20, earlyLeaveMin: 0 } }), 'open');
  assert.equal(M.latenessState({ totals: { lateMin: 20 }, lateness: { confirmedLateMin: 20 } }), 'confirmed');
  assert.equal(M.latenessState({ totals: { lateMin: 20 }, lateness: { needsReapproval: true } }), 'reapprove');
  assert.equal(M.latenessState({ totals: { lateMin: 5 }, lateness: { exceedsAttendance: true } }), 'exceeds');
  const computed = { lateMin: 40, earlyLeaveMin: 10 };
  assert.deepEqual(M.validateLatenessForm({ lateMinutes: '40', earlyLeaveMinutes: '10', note: '' }, computed), {});
  assert.match(M.validateLatenessForm({ lateMinutes: '30', earlyLeaveMinutes: '10', note: ' ' }, computed).note, /waived/);
  assert.deepEqual(M.validateLatenessForm({ lateMinutes: '30', earlyLeaveMinutes: '10', note: 'Flat tyre' }, computed), {});
  assert.match(M.validateLatenessForm({ lateMinutes: '41', earlyLeaveMinutes: '10', note: '' }, computed).lateMinutes, /At most 40/);
});

test('leave forms and the not-enough-balance question', () => {
  assert.deepEqual(Object.keys(M.validateLeaveRequestForm({ employeeId: '', leaveTypeId: '', fromDate: '' })).sort(), ['employeeId', 'fromDate', 'leaveTypeId']);
  assert.match(M.validateLeaveRequestForm({ employeeId: 'e', leaveTypeId: 't', fromDate: '2026-10-08', toDate: '2026-10-01' }).toDate, /before/);
  assert.match(M.validateLeaveRequestForm({ employeeId: 'e', leaveTypeId: 't', fromDate: '2026-10-08', toDate: '2026-10-09', halfDay: 'am' }).halfDay, /one day/);
  assert.deepEqual(M.validateLeaveRequestForm({ employeeId: 'e', leaveTypeId: 't', fromDate: '2026-10-08', toDate: '', halfDay: 'pm' }), {});
  assert.ok(M.validateAdjustForm({ leaveTypeId: 't', days: '0', note: 'x' }).days);
  assert.ok(M.validateAdjustForm({ leaveTypeId: 't', days: '2', note: '' }).note);
  assert.deepEqual(M.validateAdjustForm({ leaveTypeId: 't', days: '-1.5', note: 'Opening balance', date: '2026-10-01' }), {});
  // The backend's sentence (main/db/leave.js decide) becomes a plain question.
  const src = read('main/db/leave.js');
  assert.match(src, /Not enough \$\{t\.nameEn \|\| t\.code\}: balance \$\{bal\} day\(s\), request \$\{days\}\. Approve anyway with allowNegative if agreed\./);
  const q = M.negativeBalanceQuestion('Bad request: Not enough Annual leave: balance 1.5 day(s), request 3. Approve anyway with allowNegative if agreed.');
  assert.equal(q, 'Not enough Annual leave: balance 1.5 day(s), request 3 day(s). Approve anyway and let the balance go below zero?');
  assert.doesNotMatch(q, /allowNegative/);
  assert.equal(M.negativeBalanceQuestion('This request is already approved'), null);
  assert.equal(M.fmtDays(1.333333), '1.33');
  assert.equal(M.fmtDateRange('2026-10-08', '2026-10-08'), M.fmtDateRange('2026-10-08'));
});

test('schedules: work days, the line, the form and the one in force on a date', () => {
  assert.equal(M.workDaysLabel('1111110'), 'Mon–Sat');
  assert.equal(M.workDaysLabel('1111111'), 'Every day');
  assert.equal(M.workDaysLabel('1010100'), 'Mon, Wed, Fri');
  assert.equal(M.workDaysLabel('0000000'), 'No work days');
  assert.equal(M.scheduleLine({ startTime: '22:00', endTime: '06:00', crossesMidnight: true, breakMin: 30, workDays: '1111100' }),
    '22:00–06:00 (next day) · 30 min break · Mon–Fri');
  assert.deepEqual(M.validateScheduleForm(M.emptyScheduleForm({ name: 'Standard day' })), {});
  const bad = M.validateScheduleForm({ ...M.emptyScheduleForm(), name: ' ', startTime: '07:00', endTime: '07:00', breakMin: 'x', workDays: '0000000' });
  assert.deepEqual(Object.keys(bad).sort(), ['breakMin', 'endTime', 'name', 'workDays']);
  assert.deepEqual(M.scheduleInput(M.emptyScheduleForm({ name: 'A', breakMin: 45 })).breakMin, 45);
  const hist = [{ scheduleName: 'Day', effectiveFrom: '2026-01-01' }, { scheduleName: 'Night', effectiveFrom: '2026-10-01' }];
  assert.equal(M.scheduleOn(hist, '2026-09-30').scheduleName, 'Day');
  assert.equal(M.scheduleOn(hist, '2026-10-01').scheduleName, 'Night');
  assert.equal(M.scheduleOn(hist, '2025-12-31'), null, 'before any: the company default');
});

test('holidays: the prefilled 2027 dates are flagged for checking, 2026 ones are not', () => {
  assert.equal(M.holidayNeedsCheck({ sourceNote: holidays.SOURCE_2027_FIXED }), true);
  assert.equal(M.holidayNeedsCheck({ sourceNote: holidays.SOURCE_2026 }), false);
  assert.equal(M.holidayNeedsCheck({}), false);
  assert.ok(M.validateHolidayForm({ date: '', nameEn: '' }).date);
  assert.deepEqual(M.validateHolidayForm({ date: '2027-01-07', nameKm: 'ទិវា' }), {});
});

test('PIN rules match the server (main/util/kioskPin.js pinProblem)', () => {
  for (const pin of ['', '12', '123', '1234', '4321', '0000', '1111', '1357', '2580', '12345678', '123456789', '987654', '90210', '0123', 'abcd', '12a4']) {
    assert.equal(M.pinProblem(pin), kioskPin.pinProblem(pin), `PIN "${pin}"`);
  }
  assert.equal(M.pinStatus({ hasPin: false }).label, 'No PIN yet');
  assert.equal(M.pinStatus({ hasPin: true }).locked, false);
  const now = at('2026-10-08', '14:00');
  assert.equal(M.pinStatus({ hasPin: true, pinLockedUntil: at('2026-10-08', '14:05') }, now).label, 'Locked until 14:05');
  assert.equal(M.pinStatus({ hasPin: true, pinLockedUntil: at('2026-10-08', '13:55') }, now).locked, false, 'a lock that ran out');
  assert.match(M.pinStatus({ hasPin: true, pinManagerOnly: true }, now).label, /only a manager/);
  // The record carries the manager-only flag (main/db/employees.js).
  assert.match(read('main/db/employees.js'), /pinManagerOnly: !!row\.pin_manager_only,/);
});

test('a field the backend leaves out is not shown (never as an empty field)', () => {
  const emp = read('main/db/employees.js');
  const sensitive = JSON.parse(emp.match(/const SENSITIVE_FIELDS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  assert.deepEqual([...M.PRIVATE_FIELDS].sort(), [...sensitive].sort(), 'the UI hides exactly what hr.view loses');
  const access = read('main/ipc/hrAccess.js');
  const fuelFields = JSON.parse(access.match(/const FUEL_FIELDS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/\s+/g, ' '));
  const keys = [...emp.matchAll(/^\s{4}([a-zA-Z0-9]+): /gm)].map((m) => m[1]);
  const full = Object.fromEntries(keys.map((k) => [k, null]));
  assert.ok('notes' in full && 'nationalIdNo' in full && 'employmentType' in full, 'read the record shape');
  const directory = { ...full };
  for (const k of sensitive) delete directory[k];
  const fuel = Object.fromEntries(fuelFields.map((k) => [k, null]));
  assert.deepEqual(M.visibleFields(full), { notes: true, private: true, hr: true, statusReason: true });
  assert.deepEqual(M.visibleFields(directory), { notes: true, private: false, hr: true, statusReason: true });
  assert.deepEqual(M.visibleFields(fuel), { notes: false, private: false, hr: false, statusReason: false }, 'fuel.manage: no notes (review fix L2)');
  assert.ok(!Object.keys(M.profileForm(directory)).some((k) => sensitive.includes(k)), 'the details form has no private keys for hr.view');
  assert.ok(sensitive.every((k) => k in M.profileForm({ ...full, dob: '1990-01-02' })));
  assert.deepEqual(M.profilePatch({ gender: '', hireDate: '2026-01-01' }, { gender: 'female', hireDate: '2026-01-01' }), { gender: 'female' });
  assert.deepEqual(M.profilePatch({ bankName: 'ABA' }, { bankName: '' }), { bankName: null }, 'clearing writes null');
  assert.match(M.validateProfileForm({ hireDate: '2026-05-01', endDate: '2026-04-01' }).endDate, /before/);
  assert.ok(M.validateSuspendForm({ fromDate: '2026-10-08', reason: '' }).reason);
  assert.deepEqual(M.validateSuspendForm({ fromDate: '2026-10-08', toDate: '', reason: 'Inquiry' }), {});
});

test('Settings → People: every field is a backend setting, with its default and range', () => {
  const keys = M.HR_SETTING_FIELDS.filter((f) => !f.rate).map((f) => f.key);
  for (const f of M.HR_SETTING_FIELDS) {
    if (f.rate) {
      assert.equal(f.def, calc.DEFAULT_SETTINGS.otRates[f.key], `${f.key} rate default`);
      assert.deepEqual([f.min, f.max], [100, 500]);
    } else {
      assert.equal(f.def, calc.DEFAULT_SETTINGS[f.key], `${f.key} default`);
      assert.deepEqual([f.min, f.max], calc.SETTING_RANGES[f.key], `${f.key} range`);
    }
  }
  assert.deepEqual([...keys].sort(), Object.keys(calc.SETTING_RANGES).sort(), 'every ranged setting is on the screen');
  assert.deepEqual(M.parseHrSetting(M.HR_SETTING_FIELDS[0], '175'), { value: 175 });
  assert.ok(M.parseHrSetting(M.HR_SETTING_FIELDS[0], '90').error);
  assert.ok(M.parseHrSetting(M.HR_SETTING_FIELDS[0], '1.5').error);
  assert.deepEqual(M.settingsPatch({ 'otRates.night': 250, otMinMinutes: 30 }, { otRates: { normal: 150, night: 200, restDay: 200, holiday: 200 } }),
    { otRates: { normal: 150, night: 250, restDay: 200, holiday: 200 }, otMinMinutes: 30 });
  // The reset writes only what the server accepts.
  const reset = M.settingsPatch(M.defaultSettingsPending(), calc.DEFAULT_SETTINGS);
  assert.doesNotThrow(() => calc.mergeSettings({}, reset));
  assert.deepEqual(calc.mergeSettings({}, reset), calc.mergeSettings({}, {}), 'reset = the defaults');
});

test('capabilities and error text', () => {
  assert.deepEqual(M.hrCapsOf(['*']), { canView: true, canManage: true, fuelManage: true, canSeeStaff: true });
  assert.deepEqual(M.hrCapsOf(['hr.view']), { canView: true, canManage: false, fuelManage: false, canSeeStaff: true });
  assert.deepEqual(M.hrCapsOf(['hr.manage']).canView, true);
  assert.deepEqual(M.hrCapsOf(['fuel.manage']), { canView: false, canManage: false, fuelManage: true, canSeeStaff: true });
  assert.deepEqual(M.hrCapsOf([]), { canView: false, canManage: false, fuelManage: false, canSeeStaff: false });
  assert.equal(M.errText(new Error('Bad request: Say why the entry is rejected')), 'Say why the entry is rejected');
  assert.match(M.errText(new Error('CONFLICT|{}')), /Someone else changed this/);
});
