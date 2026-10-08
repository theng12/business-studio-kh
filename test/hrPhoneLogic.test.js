/**
 * HR1 on the phone page (`/f`): the attendance part of webclient/fuel/logic.js
 * and the rules app.js must keep (docs/PEOPLE_AND_FUEL_PLAN.md §5.3, §7b, §10).
 *   - every attendance word exists in Khmer and English (also the ones the
 *     screens build from a variable, which the fuel test's scan cannot see);
 *   - which tiles an account gets, and that an attendance-only phone never
 *     calls a fuel channel;
 *   - a clock-in goes through the outbox: ONE selfie as `photo`, a client_ref
 *     reused for every retry, the wait as `queuedForMs`, never a clock time;
 *   - offline → kept; refused → waits for a person; token refused → stops;
 *   - HELD (waited > 15 min), the Clock tile's word, a person's day state,
 *     the time keypad, Phnom Penh dates and times.
 * Plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../webclient/fuel/logic.js');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'webclient/fuel/app.js'), 'utf8');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MIN = 60 * 1000;

test('every attendance word is in both languages (including the ones picked by a variable)', () => {
  const dynamic = ['st_in', 'st_out', 'st_none', 'st_leave', 'st_holiday', 'st_off', 'st_absent',
    'reason_forgot', 'reason_battery', 'reason_network', 'half_am', 'half_pm', 'same_day',
    'home_clock_in', 'home_clock_out', 'clocked_in', 'clocked_out', 'marked_in', 'marked_out',
    'kind_in', 'kind_out', 'this_month', 'last_month', 'm_days', 'm_late', 'm_missing', 'm_absent', 'm_leave', 'leave_title', 'app_title_hr'];
  for (const k of dynamic) {
    assert.ok(L.STRINGS.km[k] && L.STRINGS.en[k], `missing word: ${k}`);
    assert.match(L.STRINGS.km[k], /[ក-៿]/, `km.${k} is not Khmer`);
  }
  // Every quoted key the attendance screens name, wherever it sits in the code.
  const used = new Set();
  for (const m of app.matchAll(/'((?:st|m|reason|half|forgot|time|mark|marked|clocked|leave|days|home|field|kind|crew|pending|withdraw|sent|need|pick|selfie|held|queued|double|not|no|same|today|yesterday|this|last|app)_[a-z_]+)'/g)) used.add(m[1]);
  const skip = new Set(['warehouse_tank', 'cash_station', 'farm_store', 'pump_meter_before', 'pump_meter_after', 'pump_display', 'no_driver', 'last_month', 'this_month']);
  for (const k of used) {
    if (skip.has(k) && !(k in L.STRINGS.en)) continue;
    assert.ok(k in L.STRINGS.km && k in L.STRINGS.en, `missing word: ${k}`);
  }
  assert.ok(!('no_fuel_access' in L.STRINGS.en), 'the refusal names both kinds of account now');
  assert.match(L.STRINGS.en.no_access, /Record fuel/);
  assert.match(L.STRINGS.en.no_access, /Clock in on my phone/);
});

test('which parts of the page an account gets', () => {
  assert.deepEqual(L.pageAccess(['fuel.record']), { admin: false, fuel: true, self: false, supervise: false, staffPhotos: true, any: true });
  assert.deepEqual(L.pageAccess(['attendance.self']), { admin: false, fuel: false, self: true, supervise: false, staffPhotos: false, any: true });
  assert.equal(L.pageAccess(['attendance.supervise']).staffPhotos, true, 'a supervisor sees their crew\'s faces (the server checks it is their crew)');
  const driver = L.pageAccess(['fuel.record', 'attendance.self']);
  assert.equal(driver.fuel && driver.self, true, 'a driver has both');
  const sup = L.pageAccess(['attendance.supervise', 'attendance.self']);
  assert.equal(sup.supervise && sup.self && !sup.fuel, true);
  assert.equal(L.pageAccess(['*']).fuel && L.pageAccess(['*']).self && L.pageAccess(['*']).admin, true);
  assert.equal(L.pageAccess(['products.view']).any, false);
  assert.equal(L.pageAccess(['attendance.kiosk']).any, false, 'the shop kiosk account is not a phone');
  assert.equal(L.pageAccess(null).any, false);
});

test('an attendance-only phone reads no fuel channel when it opens', () => {
  const self = L.bootReads(L.pageAccess(['attendance.self'])).map((r) => r[0]);
  assert.deepEqual(self, ['staff:me']);
  const fuel = L.bootReads(L.pageAccess(['fuel.record'])).map((r) => r[0]);
  assert.ok(fuel.includes('fuel:listAssets') && fuel.includes('staff:list') && fuel.includes('staff:me'));
  // app.js loads through bootReads, and every other fuel read sits behind a fuel flow.
  assert.match(app, /var reads = L\.bootReads\(S\.access\);/);
  assert.doesNotMatch(code, /rpc\('fuel:(getSettings|listAssets|listLocations|listStations)'/);
  assert.match(app, /var tiles = !A\.fuel \? \[\]/);
  assert.match(app, /if \(A\.fuel\) more\.push\(homeTile\('recent'/);
  // Crew photos only for accounts that may read them (staff:getPhoto is fuel / HR).
  assert.match(app, /S\.access\.staffPhotos && p\.hasPhoto/);
});

test('a clock-in in the outbox: one selfie as `photo`, the client_ref, the wait — no time, no source', () => {
  const now = 10_000_000;
  const item = L.makeItem({
    channel: 'attendance:clockSelf', clientRef: 'f:dev:clock1', companyId: 'c1', userId: 'u1',
    args: {}, photos: [{ kind: 'selfie', data: new Uint8Array([1, 2, 3]).buffer }], takenAt: now - 5 * MIN, now,
  });
  const args = L.sendArgs(item, now, (buf) => ({ __bin: true, b64: Buffer.from(buf).toString('base64') }));
  assert.deepEqual(Object.keys(args).sort(), ['clientRef', 'photo', 'queuedForMs']);
  assert.equal(args.clientRef, 'f:dev:clock1');
  assert.equal(args.queuedForMs, 5 * MIN);
  assert.deepEqual(args.photo, { __bin: true, b64: 'AQID' });
  const mark = L.makeItem({ channel: 'attendance:markCrew', clientRef: 'f:dev:mark01', args: { employeeId: 'e2', kind: 'in' }, now });
  const margs = L.sendArgs(mark, now, null);
  assert.deepEqual(margs, { employeeId: 'e2', kind: 'in', clientRef: 'f:dev:mark01', queuedForMs: 0 });
  // Leave and "I forgot" go through the outbox too: their own fields and the client_ref, nothing else.
  const leave = L.makeItem({ channel: 'leave:requestSelf', clientRef: 'f:dev:leave1', companyId: 'c1', args: { leaveTypeId: 'lt1', fromDate: '2026-10-20', halfDay: 'am' }, takenAt: now - 9 * MIN, now });
  assert.deepEqual(L.sendArgs(leave, now, null), { leaveTypeId: 'lt1', fromDate: '2026-10-20', halfDay: 'am', clientRef: 'f:dev:leave1' });
  const fix = L.makeItem({ channel: 'attendance:requestCorrectionSelf', clientRef: 'f:dev:fix001', args: { workDate: '2026-10-07', outTime: '17:05', reason: 'I forgot' }, now });
  assert.deepEqual(L.sendArgs(fix, now, null), { workDate: '2026-10-07', outTime: '17:05', reason: 'I forgot', clientRef: 'f:dev:fix001' });
  assert.throws(() => L.makeItem({ channel: 'leave:cancelSelf', clientRef: 'f:dev:cancel', args: {}, now }), /record-saving/, 'withdrawing stays a direct call');
});

function netErr() { const e = new Error('offline'); e.network = true; return e; }
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function setup() {
  let now = 50_000_000;
  const calls = [];
  const saved = new Map();
  let mode = 'ok';
  const box = L.createOutbox({
    store: L.memoryStore(),
    ctx: () => ({ userId: 'u1', companyId: 'c1', now }),
    encode: (buf) => ({ __bin: true, b64: Buffer.from(buf).toString('base64') }),
    send: (channel, args) => {
      calls.push({ channel, args });
      if (mode === 'offline') return Promise.reject(netErr());
      if (mode === 'auth') return Promise.reject(httpErr(401, 'Invalid or missing token'));
      if (mode === 'refuse') return Promise.reject(httpErr(500, 'This account is not linked to a staff record in this company — ask the office to link it'));
      const dup = saved.has(args.clientRef);
      if (!dup) saved.set(args.clientRef, { id: `ev${saved.size + 1}`, kind: 'in', at: now - (args.queuedForMs || 0), queuedForMs: args.queuedForMs || null, reviewStatus: 'pending' });
      return Promise.resolve({ event: saved.get(args.clientRef), duplicate: dup, doubleTap: false });
    },
  });
  return { box, calls, saved, set(m) { mode = m; }, tick(ms) { now += ms; }, now: () => now };
}
const clock = (ref, takenAt) => ({
  channel: 'attendance:clockSelf', clientRef: ref, companyId: 'c1', userId: 'u1', args: {},
  photos: [{ kind: 'selfie', data: new Uint8Array([9, 9]).buffer }], takenAt, summary: { kindLabel: 'kind_clock', expect: 'in', noTime: true },
});

test('offline clock-in: kept, then sent with the SAME client_ref and the wait it had → HELD past 15 min', async () => {
  const s = setup();
  s.set('offline');
  const out = await s.box.add(clock('f:dev:off001', s.now()));
  assert.equal(out.status, 'queued');
  assert.equal((await s.box.list()).length, 1, 'kept on the phone');
  s.tick(20 * MIN);
  s.set('ok');
  await s.box.flush(); // the pass that kept it may still be finishing
  await s.box.flush();
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].args.clientRef, s.calls[0].args.clientRef);
  assert.equal(s.calls[1].args.queuedForMs, 20 * MIN);
  assert.equal(s.calls[1].args.at, undefined);
  assert.equal((await s.box.list()).length, 0);
  const ev = s.saved.get('f:dev:off001');
  assert.equal(L.isHeld(ev), true, 'waited 20 min: the office accepts it first');
});

test('a refused clock-in waits for a person; a refused token stops and keeps it', async () => {
  const s = setup();
  s.set('refuse');
  const out = await s.box.add(clock('f:dev:ref001', s.now()));
  assert.equal(out.status, 'failed');
  assert.match(out.error.message, /not linked/);
  s.tick(10 * MIN);
  await s.box.flush();
  assert.equal(s.calls.length, 1, 'never retried by itself');
  const s2 = setup();
  s2.set('auth');
  assert.equal((await s2.box.add(clock('f:dev:auth01', s2.now()))).status, 'auth');
  assert.equal((await s2.box.add(clock('f:dev:auth02', s2.now()))).status, 'auth');
  assert.equal(s2.calls.length, 1, 'nothing more is sent with a refused token');
  assert.equal((await s2.box.list()).length, 2, 'both kept');
});

test('HELD mirrors the server: pending and waited more than 15 minutes', () => {
  assert.equal(L.QUEUED_REVIEW_MS, 15 * MIN);
  assert.equal(L.isHeld({ reviewStatus: 'pending', queuedForMs: 16 * MIN }), true);
  assert.equal(L.isHeld({ reviewStatus: 'pending', queuedForMs: 15 * MIN }), false);
  assert.equal(L.isHeld({ reviewStatus: 'pending', queuedForMs: null }), false);
  assert.equal(L.isHeld({ reviewStatus: 'accepted', queuedForMs: 60 * MIN }), false, 'accepted counts');
  assert.equal(L.isHeld(null), false);
  // Same numbers as the server's defaults.
  const src = fs.readFileSync(path.join(ROOT, 'main/db/attendance.js'), 'utf8');
  assert.match(src, /queuedReviewMinutes \* 60 \* 1000/);
});

test('the Clock tile: "Clock out" after an in of this shift, else "Clock in"; queued clock-ins count', () => {
  const now = Date.UTC(2026, 9, 8, 3, 0);
  assert.equal(L.nextClockKind(null, [], now), 'in');
  assert.equal(L.nextClockKind({ kind: 'in', at: now - 3 * 3600e3 }, [], now), 'out');
  assert.equal(L.nextClockKind({ kind: 'out', at: now - 3600e3 }, [], now), 'in');
  assert.equal(L.nextClockKind({ kind: 'in', at: now - 21 * 3600e3 }, [], now), 'in', 'a forgotten clock-out does not make today an out');
  assert.equal(L.nextClockKind({ kind: 'out', at: now - 3600e3 }, [{ kind: 'in', at: now - 60e3 }], now), 'out', 'an in waiting on the phone');
  assert.equal(L.nextClockKind(null, [{ kind: 'out', at: now - 10e3 }, { kind: 'in', at: now - 60e3 }], now), 'in', 'the latest queued one wins');
});

test('a person\'s day: in since, out at, leave / holiday / off / absent, not in yet', () => {
  const now = Date.UTC(2026, 9, 8, 5, 0);
  assert.deepEqual(L.dayState(null, { kind: 'in', at: Date.UTC(2026, 9, 8, 0, 52) }, now), { key: 'st_in', time: '07:52' });
  assert.deepEqual(L.dayState({ status: 'present', lastOut: Date.UTC(2026, 9, 8, 4, 30) }, { kind: 'out', at: 1 }, now), { key: 'st_out', time: '11:30' });
  assert.deepEqual(L.dayState({ status: 'leave' }, null, now), { key: 'st_leave', time: '' });
  assert.deepEqual(L.dayState({ status: 'holiday' }, null, now), { key: 'st_holiday', time: '' });
  assert.deepEqual(L.dayState({ status: 'future' }, null, now), { key: 'st_none', time: '' });
  assert.deepEqual(L.dayState(null, null, now), { key: 'st_none', time: '' });
});

test('time keypad and Phnom Penh dates (UTC+7, no daylight saving)', () => {
  let t = '';
  for (const k of ['1', '7', '0', '5', '9']) t = L.timePress(t, k);
  assert.equal(t, '1705', 'four digits at most');
  assert.equal(L.parseHm(t), '17:05');
  assert.equal(L.parseHm('752'), '07:52');
  assert.equal(L.parseHm('7'), '07:00');
  assert.equal(L.parseHm('2400'), null);
  assert.equal(L.parseHm('1260'), null);
  assert.equal(L.parseHm(''), null);
  assert.equal(L.timePress('17', 'back'), '1');
  assert.equal(L.timePress('17', 'x'), '17');
  assert.equal(L.ppTime(Date.UTC(2026, 9, 8, 0, 52)), '07:52');
  assert.equal(L.ppTime(null), '');
  assert.equal(L.ppDate(Date.UTC(2026, 9, 7, 17, 30)), '2026-10-08', 'past midnight in Phnom Penh');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
});

test('screens: the selfie uses the front camera and cannot be skipped; times shown are the server\'s', () => {
  assert.match(app, /type: 'photo', kind: 'selfie', title: 'selfie_title', selfie: true, required: true/);
  assert.match(app, /capture: st\.selfie \? 'user' : 'environment'/);
  assert.match(app, /if \(!st\.required\) out\.push\(h\('button', \{\s*type: 'button', class: 'link', text: tr\('no_photo'\)/);
  // Clock-ins and crew marks only through the outbox (client_ref, retries, the wait).
  assert.doesNotMatch(code, /rpc\('attendance:(clockSelf|markCrew)'/);
  assert.match(app, /channel: 'attendance:clockSelf', args: \{\}/);
  assert.match(app, /channel: 'attendance:markCrew', args: \{ employeeId: d\.person\.id, kind: d\.kind \}/);
  // The result's time is the event's `at`; a queued entry shows no time at all.
  assert.match(app, /var time = L\.ppTime\(ev\.at\);/);
  assert.doesNotMatch(code, /ppTime\(Date\.now\(\)\)/);
  assert.match(app, /sm\.noTime \? '' : ' · ' \+ fmtTime\(it\.savedAt\)/);
  assert.match(app, /if \(L\.isHeld\(ev\)\) nodes\.push/);
  assert.match(app, /if \(saved\.summary\.noTime\) nodes\.push\(h\('div', \{ class: 'notice notice--warn', 'data-queued-clock'/);
  // A supervisor never marks themselves; leave and "I forgot" go through the outbox (no direct rpc).
  assert.match(app, /return !S\.me \|\| p\.id !== S\.me\.id;/);
  assert.doesNotMatch(code, /rpc\('(leave:requestSelf|attendance:requestCorrectionSelf)'/);
  assert.equal((app.match(/request: true/g) || []).length, 2);
  // A second tap on Save while saving does nothing.
  assert.match(app, /if \(screen\.name !== 'flow'\) return; \/\/ a second tap/);
});
