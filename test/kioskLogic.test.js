/**
 * HR1: the attendance kiosk screen's pure logic (renderer/modules/Kiosk/
 * kioskLogic.js) — words in Khmer and English, the PIN keypad, the idle timer,
 * the screen state machine, plain-language errors, dates and the two request
 * forms. Plain `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

function load(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const L = load('renderer/modules/Kiosk/kioskLogic.js');
const { getValidator } = require('../main/server/validators');
const { analyzeFetchError } = require('../main/util/fetchErrors');

/* ── words ── */

test('every word exists in Khmer and English, non-empty, with the same {placeholders}', () => {
  const km = Object.keys(L.STRINGS.km).sort();
  const en = Object.keys(L.STRINGS.en).sort();
  assert.deepEqual(km, en);
  assert.ok(km.length > 100, `expected the full set, saw ${km.length}`);
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of km) {
    assert.ok(L.STRINGS.km[k].trim(), `km.${k} empty`);
    assert.ok(L.STRINGS.en[k].trim(), `en.${k} empty`);
    assert.deepEqual(holes(L.STRINGS.km[k]), holes(L.STRINGS.en[k]), `placeholders differ for ${k}`);
  }
});

test('Khmer really is Khmer (except the button that switches to English)', () => {
  for (const [k, s] of Object.entries(L.STRINGS.km)) {
    if (k === 'lang_other') { assert.equal(s, 'English'); continue; }
    if (!/\p{L}/u.test(s.replace(/\{\w+\}/g, ''))) continue; // only placeholders and punctuation
    assert.match(s, /[ក-៿]/, `km.${k} has no Khmer: ${s}`);
  }
  assert.match(L.STRINGS.en.lang_other, /[ក-៿]/);
});

test('plain words: no technical terms, no emoji', () => {
  for (const lang of L.LANGS) {
    for (const [k, s] of Object.entries(L.STRINGS[lang])) {
      assert.doesNotMatch(s, /\b(token|session|RPC|IPC|server|error|exception|null|undefined|HTTP|API)\b/i, `${lang}.${k}: ${s}`);
      assert.doesNotMatch(s, /\p{Extended_Pictographic}/u, `${lang}.${k} has an emoji`);
    }
  }
});

test('t() fills placeholders and falls back to Khmer', () => {
  assert.equal(L.t('en', 'err_wrong_pin', { n: 3 }), 'Wrong PIN. 3 tries left.');
  assert.equal(L.t('km', 'err_wrong_pin', { n: 3 }), 'លេខសម្ងាត់មិនត្រឹមត្រូវ។ នៅសល់ 3 ដងទៀត។');
  assert.equal(L.t('xx', 'title'), L.STRINGS.km.title);
  assert.equal(L.otherLang('km'), 'en');
  assert.equal(L.otherLang('en'), 'km');
});

/* ── keypad ── */

test('keypad: digits only, at most 8, back and clear; OK from 4 digits', () => {
  let pin = '';
  for (const d of '123456789') pin = L.keypadReduce(pin, { type: 'digit', digit: d });
  assert.equal(pin, '12345678');
  assert.equal(L.keypadReduce(pin, { type: 'digit', digit: 'a' }), pin);
  assert.equal(L.keypadReduce('12', { type: 'digit', digit: '12' }), '12');
  assert.equal(L.keypadReduce('123', { type: 'back' }), '12');
  assert.equal(L.keypadReduce('', { type: 'back' }), '');
  assert.equal(L.keypadReduce('123', { type: 'clear' }), '');
  assert.equal(L.keypadReduce(undefined, { type: 'digit', digit: '5' }), '5');
  assert.equal(L.canSubmitPin('123'), false);
  assert.equal(L.canSubmitPin('1234'), true);
  assert.equal(L.canSubmitPin('12345678'), true);
  assert.equal(L.canSubmitPin('123456789'), false);
  assert.equal(L.canSubmitPin('12a4'), false);
  // What OK sends passes the server's own PIN check.
  assert.equal(getValidator('kiosk:signIn')({ employeeId: 'e1', pin: '12345678' }), true);
});

test('keyboard: the number row and keypad digits, Backspace/Delete, Enter, Escape', () => {
  assert.deepEqual(L.keyToKeypadAction('7'), { type: 'digit', digit: '7' });
  assert.deepEqual(L.keyToKeypadAction('Backspace'), { type: 'back' });
  assert.deepEqual(L.keyToKeypadAction('Delete'), { type: 'back' });
  assert.deepEqual(L.keyToKeypadAction('Enter'), { type: 'submit' });
  assert.deepEqual(L.keyToKeypadAction('Escape'), { type: 'cancel' });
  assert.equal(L.keyToKeypadAction('a'), null);
  assert.equal(L.keyToKeypadAction('F1'), null);
  assert.equal(L.keyToKeypadAction(undefined), null);
});

/* ── idle ── */

test('idle timer: expires after the timeout, activity resets it', () => {
  const timer = L.createIdleTimer(L.SESSION_IDLE_MS, 1000);
  assert.equal(timer.expired(1000 + L.SESSION_IDLE_MS - 1), false);
  assert.equal(timer.remainingMs(1000 + 60_000), 60_000);
  timer.touch(50_000);
  assert.equal(timer.expired(1000 + L.SESSION_IDLE_MS), false);
  assert.equal(timer.expired(50_000 + L.SESSION_IDLE_MS), true);
  assert.equal(timer.remainingMs(10 ** 9), 0);
  assert.equal(L.SESSION_IDLE_MS, 120_000, 'two minutes, like the server session');
  assert.equal(L.DONE_SECONDS, 5);
});

test('keep-alive: only while the person is busy and the server has not heard from us for a minute', () => {
  const now = 1_000_000;
  assert.equal(L.needsKeepAlive({ lastServerUseAt: now - 61_000, lastActivityAt: now - 5_000, now }), true);
  assert.equal(L.needsKeepAlive({ lastServerUseAt: now - 30_000, lastActivityAt: now - 5_000, now }), false);
  assert.equal(L.needsKeepAlive({ lastServerUseAt: now - 61_000, lastActivityAt: now - 45_000, now }), false, 'nobody there — let it end');
});

/* ── screens ── */

const person = { id: 'e1', nameEn: 'Sok Dara', nameKm: 'សុខ ដារ៉ា', hasPin: true };
const manager = { id: 'm1', nameEn: 'Chan Mony', nameKm: 'ចាន់ មុន្នី', hasPin: true };
const run = (events, from = L.INITIAL_STATE) => events.reduce((s, e) => L.kioskReduce(s, e), from);

test('clocking: tiles → PIN → camera → saving → done', () => {
  let s = run([{ type: 'PICK_TILE', person }]);
  assert.equal(s.screen, 'pin');
  assert.equal(L.inSession(s), false);
  s = L.kioskReduce(s, { type: 'SIGNED_IN', sessionToken: 'tok', nextKind: 'out', nextNeedsCheck: true, employee: person, lastEvent: { kind: 'in', at: 1 } });
  assert.equal(s.screen, 'camera');
  assert.deepEqual(s.session, { token: 'tok', nextKind: 'out', needsCheck: true, lastEvent: { kind: 'in', at: 1 }, employee: person });
  assert.equal(L.inSession(s), true);
  s = L.kioskReduce(s, { type: 'SAVING' });
  assert.equal(s.screen, 'saving');
  s = L.kioskReduce(s, { type: 'CLOCKED', event: { kind: 'out', at: 42 }, duplicate: false });
  assert.equal(s.screen, 'done');
  assert.deepEqual(s.result, { kind: 'out', at: 42, duplicate: false, noPhotoBy: null, preview: false });
  assert.equal(L.kioskReduce(s, { type: 'RESET' }).screen, 'tiles');
  assert.equal(L.kioskReduce(s, { type: 'RESET' }).session, null);
});

test('a failed clock goes back to the camera with the session kept; an ended session goes back to the tiles', () => {
  const cam = run([{ type: 'PICK_TILE', person }, { type: 'SIGNED_IN', sessionToken: 't', nextKind: 'in' }, { type: 'SAVING' }]);
  const failed = L.kioskReduce(cam, { type: 'CLOCK_FAILED' });
  assert.equal(failed.screen, 'camera');
  assert.equal(failed.session.token, 't');
  const ended = L.kioskReduce(failed, { type: 'SESSION_ENDED' });
  assert.equal(ended.screen, 'tiles');
  assert.equal(ended.session, null);
  assert.equal(ended.notice, 'err_session');
});

test('events out of place are ignored (no sign-in from the tiles, no records without a session)', () => {
  const tiles = L.INITIAL_STATE;
  assert.equal(L.kioskReduce(tiles, { type: 'SIGNED_IN', sessionToken: 't' }), tiles);
  assert.equal(L.kioskReduce(tiles, { type: 'VIEW_ME' }), tiles);
  assert.equal(L.kioskReduce(tiles, { type: 'CLOCKED', event: {} }), tiles);
  assert.equal(L.kioskReduce(tiles, { type: 'NO_PHOTO' }), tiles);
  assert.equal(L.kioskReduce(tiles, { type: 'nonsense' }), tiles);
  const pin = run([{ type: 'PICK_TILE', person }]);
  assert.equal(L.kioskReduce(pin, { type: 'PICK_TILE', person: manager }), pin, 'one person at a time');
});

test('own records and the two requests need the session', () => {
  let s = run([{ type: 'PICK_TILE', person }, { type: 'SIGNED_IN', sessionToken: 't', nextKind: 'in' }, { type: 'VIEW_ME' }]);
  assert.equal(s.screen, 'me');
  s = L.kioskReduce(s, { type: 'OPEN_LEAVE' });
  assert.equal(s.screen, 'leave');
  s = L.kioskReduce(s, { type: 'VIEW_ME' });
  s = L.kioskReduce(s, { type: 'OPEN_CORRECTION' });
  assert.equal(s.screen, 'correction');
  assert.equal(L.inSession(s), true);
});

test('manager: leave kiosk mode / close the app go through tile + PIN', () => {
  let s = run([{ type: 'MANAGER_MENU' }]);
  assert.equal(s.screen, 'managerMenu');
  assert.equal(L.kioskReduce(s, { type: 'MANAGER_ACTION', action: 'delete-everything' }), s);
  s = L.kioskReduce(s, { type: 'MANAGER_ACTION', action: 'leave' });
  assert.deepEqual([s.screen, s.managerAction], ['managerPick', 'leave']);
  s = L.kioskReduce(s, { type: 'PICK_MANAGER', person: manager });
  assert.deepEqual([s.screen, s.manager.id], ['managerPin', 'm1']);
  assert.equal(L.kioskReduce(s, { type: 'MANAGER_BACK' }).screen, 'managerPick');
  assert.equal(L.kioskReduce(s, { type: 'MANAGER_OK' }).screen, 'exiting');
  assert.equal(run([{ type: 'MANAGER_BACK' }], run([{ type: 'MANAGER_MENU' }, { type: 'MANAGER_ACTION', action: 'quit' }])).screen, 'tiles');
});

test('a refused quit asks for a manager from any screen and drops the open session', () => {
  const cam = run([{ type: 'PICK_TILE', person }, { type: 'SIGNED_IN', sessionToken: 't', nextKind: 'in' }]);
  const s = L.kioskReduce(cam, { type: 'QUIT_REQUESTED' });
  assert.deepEqual([s.screen, s.managerAction, s.session, s.notice], ['managerPick', 'quit', null, 'quit_requested']);
});

test('no camera: a manager PIN lets the person clock without a photo, and the session is kept', () => {
  let s = run([{ type: 'PICK_TILE', person }, { type: 'SIGNED_IN', sessionToken: 't', nextKind: 'in' }, { type: 'NO_PHOTO' }]);
  assert.deepEqual([s.screen, s.managerAction], ['managerPick', 'no-photo']);
  assert.equal(L.inSession(s), true, 'the two-minute clock keeps running');
  assert.equal(L.kioskReduce(s, { type: 'MANAGER_BACK' }).screen, 'camera', 'back to the camera, still signed in');
  s = L.kioskReduce(s, { type: 'PICK_MANAGER', person: manager });
  s = L.kioskReduce(s, { type: 'MANAGER_OK' });
  assert.equal(s.screen, 'saving');
  assert.equal(s.session.token, 't');
  s = L.kioskReduce(s, { type: 'CLOCKED', event: { kind: 'in', at: 5 }, noPhotoBy: 'Chan Mony' });
  assert.equal(s.result.noPhotoBy, 'Chan Mony');
});

/* ── errors ── */

const SERVER_MESSAGES = [
  ['Wrong PIN. 3 tries left.', 'wrongPin', 'Wrong PIN. 3 tries left.'],
  ['Wrong PIN. 1 try left.', 'wrongPin', 'Wrong PIN. 1 try left.'], // singular in English (verification 2026-10-08)
  ['Wrong PIN. Locked for 10 min — ask a manager.', 'locked', 'This PIN is locked. Try again in 10 min, or ask a manager.'],
  ['Wrong PIN. This PIN is now locked — only a manager can unlock it.', 'lockedManager', 'This PIN is locked. Only a manager can unlock it.'],
  ['Too many wrong PINs. Try again in 7 min.', 'locked', 'This PIN is locked. Try again in 7 min, or ask a manager.'],
  ['This PIN is locked. Only a manager can unlock it.', 'lockedManager', 'This PIN is locked. Only a manager can unlock it.'],
  ['Too many wrong PINs on this kiosk. PIN entry is paused for 5 min — ask a manager.', 'paused', 'Too many wrong PINs. PIN entry is paused for 5 min — call a manager.'],
  ['No PIN is set for this person yet — ask a manager', 'noPin', null],
  ['This person cannot clock in — ask a manager', 'cannotClock', null],
  ['Your kiosk session has ended. Tap your photo and enter your PIN again.', 'sessionEnded', null],
  ['Only a manager can leave kiosk mode', 'notManager', null],
  ['Only a manager can allow this', 'notManager', null],
  ['Server URL not set (Settings → Multi-Mac → Client mode)', 'offline', null],
  ['Token rejected by server. Ask the admin to regenerate.', 'offline', null],
];

test('every message the server sends maps to a plain sentence in both languages', () => {
  for (const [msg, kind, en] of SERVER_MESSAGES) {
    assert.equal(L.classifyError(new Error(msg)).kind, kind, msg);
    if (en) assert.equal(L.errorText(new Error(msg), 'en'), en);
    assert.match(L.errorText(new Error(msg), 'km'), /[ក-៿]/, `no Khmer for: ${msg}`);
  }
});

test('every "can\'t reach the office Mac" the client produces reads as offline (never queued, never technical)', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'SOMETHING_ELSE']) {
    const err = new Error('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
    const msg = analyzeFetchError(err, 'http://100.64.0.5:13180').message;
    assert.equal(L.classifyError(new Error(msg)).kind, 'offline', `${code}: ${msg}`);
    assert.equal(L.errorText(new Error(msg), 'en'), 'Can\'t reach the office Mac. Nothing was saved. Try again in a moment.');
  }
});

test('a wrong PIN never hints how close it was', () => {
  for (const lang of L.LANGS) {
    for (const k of ['err_wrong_pin', 'err_wrong_pin_plain']) {
      assert.doesNotMatch(L.STRINGS[lang][k], /close|almost|digit|correct|nearly/i);
    }
  }
});

test('messages are kept as data and re-render in the other language', () => {
  const m = { err: new Error('Wrong PIN. 2 tries left.') };
  assert.equal(L.messageText(m, 'en'), 'Wrong PIN. 2 tries left.');
  assert.equal(L.messageText(m, 'km'), 'លេខសម្ងាត់មិនត្រឹមត្រូវ។ នៅសល់ 2 ដងទៀត។');
  assert.equal(L.messageText({ key: 'sent_leave' }, 'en'), L.STRINGS.en.sent_leave);
  assert.equal(L.messageText(null, 'en'), '');
  assert.equal(L.messageText('plain', 'km'), 'plain');
});

test('anything else keeps its real message (AGENTS.md §18)', () => {
  assert.equal(L.classifyError(new Error('Leave type not found')).kind, 'other');
  assert.equal(L.errorText(new Error('Leave type not found'), 'en'), 'Not done: Leave type not found');
});

/* ── dates, confirmation ── */

test('times are Phnom Penh time; the confirmation reads "ចូលធ្វើការ 07:52 / Clocked in 07:52"', () => {
  const at = Date.UTC(2026, 9, 8, 0, 52); // 07:52 in Phnom Penh
  assert.equal(L.ppTime(at), '07:52');
  assert.equal(L.ppDate(Date.UTC(2026, 9, 8, 18, 0)), '2026-10-09', 'after 17:00 UTC it is already tomorrow in Phnom Penh');
  assert.equal(L.confirmationLine('km', 'in', at), 'ចូលធ្វើការ 07:52');
  assert.equal(L.confirmationLine('en', 'in', at), 'Clocked in 07:52');
  assert.equal(L.confirmationLine('en', 'out', at), 'Clocked out 07:52');
  assert.equal(L.addDaysToDate('2026-03-01', -1), '2026-02-28');
});

/* ── tiles ── */

const STAFF = [
  { id: '1', nameEn: 'Sok Dara', nameKm: 'សុខ ដារ៉ា' },
  { id: '2', nameEn: 'Chan Mony', nameKm: 'ចាន់ មុន្នី' },
  { id: '3', nameEn: '', nameKm: 'ស្រី ពៅ' },
  { id: '4', nameEn: 'sophea', nameKm: '' },
];

test('tiles: sorted, first-letter bar (A–Z then Khmer), search on either name', () => {
  assert.deepEqual(L.sortTiles(STAFF).map((p) => p.id), ['2', '1', '4', '3']);
  assert.deepEqual(L.tileLetters(STAFF, 'en'), ['C', 'S']);
  const km = L.tileLetters(STAFF, 'km');
  assert.ok(km.includes('ស') && km.includes('ច') && !km.includes('C'), 'Khmer screen: Khmer initials');
  assert.deepEqual(L.tileLetters([{ nameEn: 'Dara' }], 'km'), ['D'], 'falls back to A–Z when nobody has a Khmer name');
  assert.deepEqual(L.filterTiles(STAFF, { letter: 'S' }).map((p) => p.id), ['1', '4']);
  assert.deepEqual(L.filterTiles(STAFF, { letter: 'ស' }).map((p) => p.id), ['1', '3']);
  assert.deepEqual(L.filterTiles(STAFF, { query: 'mon' }).map((p) => p.id), ['2']);
  assert.deepEqual(L.filterTiles(STAFF, { query: 'ពៅ' }).map((p) => p.id), ['3']);
  assert.equal(L.filterTiles(STAFF, {}).length, 4);
  assert.equal(L.displayName(STAFF[0], 'km'), 'សុខ ដារ៉ា');
  assert.equal(L.displayName(STAFF[0], 'en'), 'Sok Dara');
  assert.equal(L.displayName(STAFF[2], 'en'), 'ស្រី ពៅ', 'falls back to the other name');
  assert.equal(L.initials(STAFF[0]), 'SD');
  assert.equal(L.initials(STAFF[2]), 'ស');
});

/* ── own records ── */

test('month figures in a fixed order; missing totals show nothing', () => {
  const rows = L.monthRows({ daysWorked: 20, lateDays: 2, lateMin: 17, absentDays: 1, missingOutDays: 0, leaveDays: 1.5 });
  assert.deepEqual(rows.map((r) => r.key), ['days_worked', 'late_days', 'late_minutes', 'absent_days', 'missing_out_days', 'leave_days']);
  assert.equal(rows[2].value, 17);
  assert.deepEqual(L.monthRows(null), []);
  // Once the month is confirmed, the figure after review sits beside the computed one.
  assert.equal(rows[2].afterReview, null, 'not reviewed yet');
  assert.equal(L.lateMinutesText('en', rows[2]), '17');
  const reviewed = L.monthRows({ lateMin: 45 }, { reviewed: true, lateAfterReviewMin: 30 })[2];
  assert.equal(L.lateMinutesText('en', reviewed), '45 (30 after review)');
  assert.match(L.lateMinutesText('km', reviewed), /^45 \(30 /);
  assert.equal(L.lateMinutesText('en', L.monthRows({ lateMin: 45 }, { reviewed: true, lateAfterReviewMin: 45 })[2]), '45', 'no waiver: one number');
  assert.equal(L.monthRows({ lateMin: 45 }, { reviewed: false, lateAfterReviewMin: null })[2].afterReview, null);
  assert.equal(L.formatDays(1.5), '1.5');
  assert.equal(L.formatDays(2), '2');
  assert.equal(L.daysText('en', 1), '1 day');
  assert.equal(L.daysText('en', 2.5), '2.5 days');
  assert.equal(L.daysText('km', 3), '3 ថ្ងៃ');
});

/* ── forms → the server's own validators ── */

test('leave request: checks, and what is sent passes kiosk:requestLeave', () => {
  assert.deepEqual(L.leaveFormErrors({}), ['need_type', 'need_from']);
  assert.deepEqual(L.leaveFormErrors({ leaveTypeId: 't', fromDate: '2026-10-10', toDate: '2026-10-09' }), ['need_order']);
  assert.deepEqual(L.leaveFormErrors({ leaveTypeId: 't', fromDate: '2026-10-10', toDate: '2026-10-12', halfDay: 'am' }), ['need_half_one_day']);
  assert.deepEqual(L.leaveFormErrors({ leaveTypeId: 't', fromDate: '2026-10-10', halfDay: 'pm', reason: 'x' }), []);
  const v = getValidator('kiosk:requestLeave');
  const one = L.buildLeaveArgs({ leaveTypeId: 't', fromDate: '2026-10-10', toDate: '2026-10-10', halfDay: 'am', reason: '  doctor ' }, 'tok');
  assert.deepEqual(one, { sessionToken: 'tok', leaveTypeId: 't', fromDate: '2026-10-10', halfDay: 'am', reason: 'doctor' });
  assert.equal(v(one), true);
  const range = L.buildLeaveArgs({ leaveTypeId: 't', fromDate: '2026-10-10', toDate: '2026-10-14', halfDay: '', reason: '' }, 'tok');
  assert.deepEqual(range, { sessionToken: 'tok', leaveTypeId: 't', fromDate: '2026-10-10', toDate: '2026-10-14' });
  assert.equal(v(range), true);
  assert.ok(!('employeeId' in range), 'never an employee id — the session says who');
});

test('"I forgot to clock out": checks, the default day, and what is sent passes kiosk:requestCorrection', () => {
  assert.deepEqual(L.correctionFormErrors({}), ['need_date', 'need_time', 'need_reason']);
  assert.deepEqual(L.correctionFormErrors({ workDate: '2026-10-07', outTime: '17:05', reason: 'x'.repeat(201) }), ['too_long']);
  const args = L.buildCorrectionArgs({ workDate: '2026-10-07', outTime: '17:05', inTime: '', reason: ' went home, forgot ' }, 'tok');
  assert.deepEqual(args, { sessionToken: 'tok', workDate: '2026-10-07', reason: 'went home, forgot', outTime: '17:05' });
  assert.equal(getValidator('kiosk:requestCorrection')(args), true);
  assert.equal(getValidator('kiosk:requestCorrection')(L.buildCorrectionArgs({ workDate: '2026-10-07', outTime: '17:05', reason: 'x'.repeat(200) }, 'tok')), true, 'the longest reason the form allows is accepted');
  const now = Date.UTC(2026, 9, 8, 3); // 2026-10-08 in Phnom Penh
  const days = (list) => list.map(([date, missingOut]) => ({ date, missingOut }));
  assert.equal(L.defaultCorrectionDate({ thisMonth: { days: days([['2026-10-02', true], ['2026-10-05', true], ['2026-10-06', false], ['2026-10-08', true]]) } }, now), '2026-10-05',
    'the latest day before today with a missing clock-out (today is still open)');
  assert.equal(L.defaultCorrectionDate({ thisMonth: { days: [] }, lastMonth: { days: days([['2026-09-30', true]]) } }, now), '2026-09-30');
  assert.equal(L.defaultCorrectionDate({ lastEvent: { kind: 'in', workDate: '2026-10-06' } }, now), '2026-10-06');
  assert.equal(L.defaultCorrectionDate({ lastEvent: { kind: 'in', workDate: '2026-10-08' } }, now), '2026-10-07', 'clocked in today: not today');
  assert.equal(L.defaultCorrectionDate(null, now), '2026-10-07');
});

/* ── recovery code (office Mac unreachable) ── */

test('recovery: offered only on the real kiosk, with a code set, while the office Mac cannot be reached', () => {
  const status = { enabled: true, hasRecoveryCode: true };
  assert.equal(L.offerRecovery({ preview: false, status, unreachable: true }), true);
  assert.equal(L.offerRecovery({ preview: false, status, unreachable: false }), false);
  assert.equal(L.offerRecovery({ preview: true, status, unreachable: true }), false);
  assert.equal(L.offerRecovery({ preview: false, status: { enabled: true, hasRecoveryCode: false }, unreachable: true }), false);
  assert.equal(L.offerRecovery({ preview: false, status: null, unreachable: true }), false);
  // Standalone / server kiosk: no office Mac to lose — offered whenever a manager is asked for.
  assert.equal(L.offerRecovery({ preview: false, status: { ...status, recoveryNeedsOffline: false }, unreachable: false }), true);
  assert.equal(L.offerRecovery({ preview: false, status: { ...status, recoveryNeedsOffline: true }, unreachable: false }), false);
});

test('crash screen: reloads after 5 s, then 10 s; the 3rd crash within 2 minutes stops reloading', () => {
  const now = 10_000_000;
  const a = L.crashPlan([], now);
  assert.deepEqual([a.reload, a.delayMs], [true, 5000]);
  const b = L.crashPlan(a.recent, now + 20_000);
  assert.deepEqual([b.reload, b.delayMs], [true, 10000]);
  const c = L.crashPlan(b.recent, now + 40_000);
  assert.deepEqual([c.reload, c.delayMs], [false, null], 'no reload loop');
  const later = L.crashPlan(c.recent, now + 10 * 60_000);
  assert.deepEqual([later.reload, later.delayMs], [true, 5000], 'old crashes no longer count');
  assert.equal(L.crashPlan(['junk', NaN], now).reload, true);
});

test('preview says nothing is saved', () => {
  assert.equal(L.STRINGS.en.preview_badge, 'Preview — nothing is saved');
  const done = run([{ type: 'PICK_TILE', person }, { type: 'SIGNED_IN', sessionToken: 't', nextKind: 'in' }, { type: 'SAVING' }, { type: 'CLOCKED', event: { kind: 'in', at: 1 }, preview: true }]);
  assert.equal(done.result.preview, true);
});

test('recovery: screen transitions', () => {
  for (const from of [L.INITIAL_STATE, run([{ type: 'MANAGER_MENU' }]), run([{ type: 'MANAGER_MENU' }, { type: 'MANAGER_ACTION', action: 'quit' }])]) {
    assert.equal(L.kioskReduce(from, { type: 'OPEN_RECOVERY' }).screen, 'recovery');
  }
  const cam = run([{ type: 'PICK_TILE', person }, { type: 'SIGNED_IN', sessionToken: 't', nextKind: 'in' }]);
  assert.equal(L.kioskReduce(cam, { type: 'OPEN_RECOVERY' }), cam, 'never from a signed-in screen');
  const rec = L.kioskReduce(L.INITIAL_STATE, { type: 'OPEN_RECOVERY' });
  assert.equal(L.kioskReduce(rec, { type: 'MANAGER_BACK' }).screen, 'tiles');
  assert.deepEqual([L.kioskReduce(rec, { type: 'RECOVERY_OK' }).screen, L.kioskReduce(rec, { type: 'RECOVERY_OK' }).managerAction], ['exiting', 'leave']);
  assert.equal(L.inSession(rec), false);
});

test('recovery: typed code is grouped as XXXX-XXXX-XXXX', () => {
  assert.equal(L.formatRecoveryInput('k7qm2x'), 'K7QM-2X');
  assert.equal(L.formatRecoveryInput('K7QM-2XRT-H9PD-EXTRA'), 'K7QM-2XRT-H9PD');
  assert.equal(L.formatRecoveryInput(' k7 qm '), 'K7QM');
});

test('recovery: every message main sends reads plainly in both languages', () => {
  const cases = [
    ['Wrong recovery code. 3 tries left.', 'recoveryWrong', 'Wrong code. 3 tries left.'],
    ['Wrong recovery code. 1 try left.', 'recoveryWrong', 'Wrong code. 1 try left.'],
    ['Wrong recovery code. Too many wrong recovery codes: try again in 15 min.', 'recoveryLocked', 'Too many wrong codes. Try again in 15 min.'],
    ['Too many wrong recovery codes. Try again in 30 min.', 'recoveryLocked', 'Too many wrong codes. Try again in 30 min.'],
    ['The office Mac can be reached, so the recovery code is not needed: a manager uses their PIN instead.', 'recoveryReachable', null],
    ['No recovery code was set when this kiosk was turned on. A manager uses their PIN when the office Mac is back.', 'recoveryNone', null],
  ];
  for (const [msg, kind, en] of cases) {
    assert.equal(L.classifyError(new Error(msg)).kind, kind, msg);
    if (en) assert.equal(L.errorText(new Error(msg), 'en'), en);
    assert.match(L.errorText(new Error(msg), 'km'), /[ក-៿]/);
  }
});
