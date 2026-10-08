/**
 * HR1: the wiring around the hr / attendance / leave / kiosk channels —
 * capabilities and who reaches what, the Editor preset, client-mode proxying,
 * preload, validators, backups and History hiding. Pure source/module checks,
 * plain `npm test` (the behaviour itself is test/hrNative.test.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CAPABILITIES, channelCapability, OPT_IN_CAPABILITIES } = require('../main/util/capabilities');
const { allowedByCaps } = require('../main/util/permissions');
const { getValidator } = require('../main/server/validators');
const backupSafety = require('../main/util/backupSafety');
const { BACKUP_DATA_ENTRIES } = backupSafety;
const { hideClauses } = require('../main/db/auditLog');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function declared(file) {
  const src = read(file);
  return {
    exposed: [...src.matchAll(/\bexpose\(\s*'([^']+)'/g)].map((m) => m[1]),
    local: [...src.matchAll(/\bexposeLocal\(\s*'([^']+)'/g)].map((m) => m[1]),
  };
}
const FILES = ['main/ipc/hr.js', 'main/ipc/attendance.js', 'main/ipc/kiosk.js'].map(declared);
const EXPOSED = FILES.flatMap((f) => f.exposed);
const LOCAL = FILES.flatMap((f) => f.local);
const caps = (...k) => new Set(k);

test('five People capabilities exist, all opt-in, none in the Editor preset', () => {
  const people = CAPABILITIES.filter((c) => c.group === 'People').map((c) => c.key);
  assert.deepEqual(people, ['attendance.kiosk', 'attendance.self', 'attendance.supervise', 'hr.view', 'hr.manage']);
  for (const k of people) assert.ok(OPT_IN_CAPABILITIES.has(k), k);
  const { BUILTIN_ROLES } = require('../main/db/roles');
  const editor = BUILTIN_ROLES.find((r) => r.key === 'editor');
  for (const k of people) assert.ok(!editor.permissions.includes(k), `Editor must not get ${k}`);
});

test('every HR channel maps to a People capability — none falls through to the legacy rules', () => {
  assert.ok(EXPOSED.length > 60, `expected the full channel set, saw ${EXPOSED.length}`);
  const people = new Set(['attendance.kiosk', 'attendance.self', 'attendance.supervise', 'hr.view', 'hr.manage']);
  for (const ch of [...EXPOSED, ...LOCAL]) {
    const cap = channelCapability(ch);
    const list = Array.isArray(cap) ? cap : [cap];
    assert.ok(list.length && list.every((c) => people.has(c)), `${ch} → ${JSON.stringify(cap)}`);
  }
});

test('a kiosk-only account reaches the kiosk channels and nothing else', () => {
  const kiosk = caps('attendance.kiosk');
  for (const ch of EXPOSED.filter((c) => c.startsWith('kiosk:'))) assert.equal(allowedByCaps(kiosk, ch), true, ch);
  for (const ch of ['attendance:day', 'attendance:clockSelf', 'attendance:getPhoto', 'hr:getProfile', 'staff:list', 'staff:get', 'leave:balances', 'fuel:recordFill', 'products:update', 'audit:listRecent']) {
    assert.equal(allowedByCaps(kiosk, ch), false, ch);
  }
});

test('attendance.self reaches only its own channels; attendance.supervise only the crew', () => {
  const self = caps('attendance.self');
  for (const ch of ['attendance:clockSelf', 'attendance:mine', 'attendance:requestCorrectionSelf', 'leave:requestSelf', 'leave:cancelSelf', 'staff:me']) assert.equal(allowedByCaps(self, ch), true, ch);
  for (const ch of ['attendance:markCrew', 'attendance:addManual', 'attendance:day', 'kiosk:clock', 'leave:request', 'staff:list']) assert.equal(allowedByCaps(self, ch), false, ch);
  const sup = caps('attendance.supervise');
  for (const ch of ['attendance:crew', 'attendance:markCrew', 'staff:me']) assert.equal(allowedByCaps(sup, ch), true, ch);
  for (const ch of ['attendance:clockSelf', 'attendance:review', 'attendance:day']) assert.equal(allowedByCaps(sup, ch), false, ch);
});

test('hr.view reads but never photos, documents, PINs or writes; hr.manage does everything', () => {
  const view = caps('hr.view');
  for (const ch of ['attendance:day', 'attendance:monthSummary', 'attendance:listReview', 'leave:balances', 'leave:listRequests', 'hr:getProfile', 'hr:listHolidays', 'hr:getMonthWorkbook', 'hr:saveMonthWorkbook', 'staff:list']) {
    assert.equal(allowedByCaps(view, ch), true, ch);
  }
  for (const ch of ['attendance:getPhoto', 'hr:readDocument', 'hr:listDocuments', 'hr:setPin', 'hr:updateProfile', 'attendance:review', 'leave:decide', 'staff:create', 'kiosk:clock']) {
    assert.equal(allowedByCaps(view, ch), false, ch);
  }
  const manage = caps('hr.manage');
  for (const ch of [...EXPOSED.filter((c) => !/clockSelf|mine|requestCorrectionSelf|requestSelf|cancelSelf|crew|markCrew/.test(c)), 'staff:create', 'staff:markLeft']) {
    assert.equal(allowedByCaps(manage, ch), true, ch);
  }
  for (const ch of ['fuel:recordFill', 'fuel:listFills']) assert.equal(allowedByCaps(manage, ch), false, ch);
});

test('fuel.record keeps tile-only staff access; fuel.manage still edits staff', () => {
  assert.equal(allowedByCaps(caps('fuel.record'), 'staff:list'), true);
  assert.equal(allowedByCaps(caps('fuel.record'), 'staff:create'), false);
  assert.equal(allowedByCaps(caps('fuel.manage'), 'staff:update'), true);
  assert.equal(allowedByCaps(caps('fuel.manage'), 'hr:updateProfile'), false, 'ID / bank fields are hr.manage only');
});

test('every HR channel has a validator, a client proxy and a preload method', () => {
  const client = read('main/client/index.js');
  const block = client.match(/PROXIED_CHANNELS\s*=\s*\[([\s\S]*?)\n\];/)[1];
  const preload = read('main/preload.js');
  for (const ch of EXPOSED) {
    assert.ok(getValidator(ch), `${ch} has no validator`);
    assert.ok(block.includes(`'${ch}'`), `${ch} is not proxied in client mode`);
    assert.ok(preload.includes(`invoke('${ch}'`), `preload has no method for ${ch}`);
  }
  assert.deepEqual(LOCAL, ['hr:saveMonthWorkbook']);
  assert.ok(/handleLocal\('hr:saveMonthWorkbook'/.test(client));
  assert.ok(getValidator('hr:saveMonthWorkbook'));
});

test('validators refuse bad shapes before a handler runs', () => {
  const big = { __bin: true, b64: 'A'.repeat(21 * 1024 * 1024) };
  assert.match(getValidator('kiosk:clock')({ sessionToken: 'abcdef' }), /photo is required/);
  assert.match(getValidator('kiosk:clock')({ sessionToken: 'abcdef', photo: big }), /too large/);
  assert.equal(getValidator('kiosk:clock')({ sessionToken: 'abcdef', photo: { __bin: true, b64: 'AAAA' } }), true);
  assert.match(getValidator('kiosk:signIn')({ employeeId: 'e', pin: '12ab' }), /digits/);
  assert.match(getValidator('hr:setPin')({ id: 'e', pin: '12' }), /4 to 8/);
  assert.match(getValidator('attendance:clockSelf')({}), /photo is required/);
  assert.match(getValidator('attendance:clockSelf')({ photo: new Uint8Array(4), clientRef: 'x' }), /clientRef/);
  assert.match(getValidator('attendance:approveOvertime')({ employeeId: 'e', workDate: '2026-10-08', minutes: { weekend: 5 } }), /not an overtime category/);
  assert.match(getValidator('leave:request')({ employeeId: 'e', leaveTypeId: 't', fromDate: '2026-10-08', halfDay: 'noon' }), /halfDay/);
  assert.match(getValidator('attendance:requestCorrection')({ employeeId: 'e', workDate: '2026-10-08', outTime: '25:00', reason: 'x' }), /07:30/);
  assert.match(getValidator('hr:createSchedule')({ name: 'X', startTime: '07:00', endTime: '17:00', workDays: '11111' }), /workDays/);
});

test('hr/ travels in backups and restores (clock-in photos, documents)', () => {
  assert.ok(BACKUP_DATA_ENTRIES.includes('hr'));
  assert.ok(/ARCHIVE_TOP_LEVEL_DIRS = new Set\(\[[^\]]*'hr'/.test(read('main/util/backupSafety.js')), 'a backup with hr/ must be restorable');
});

test('HR files are never under assets/ and never served by /assets/ or app-image://', () => {
  const src = read('main/hrPhotos.js');
  assert.match(src, /`hr\/attendance\/\$\{ppMonth\(at\)\}\//);
  assert.match(src, /`hr\/employees\/\$\{safeName\(employeeId\)\}\/docs\//);
  for (const file of ['main/server/index.js', 'main/protocol.js']) {
    assert.ok(!/['"`]hr\//.test(read(file)), `${file} must not serve hr/`);
  }
});

test('History hiding: sensitivity and entity clauses', () => {
  assert.deepEqual(hideClauses(null), []);
  const all = hideClauses({ fuel: true, employee: true, hr: true, payroll: true });
  assert.equal(all.length, 5);
  assert.ok(all.some((c) => c.includes("sensitivity <> 'hr_private'")), 'documents: hr.manage only');
  assert.deepEqual(hideClauses({ hrPrivate: true }), ["sensitivity <> 'hr_private'"]);
  assert.ok(all.some((c) => c.includes("sensitivity <> 'hr'")));
  assert.ok(all.some((c) => c.includes("entity_type <> 'employee'")));
  const src = read('main/db/auditLog.js');
  assert.ok(/CLEARABLE_SQL = `sensitivity = 'normal' AND \$\{FUEL_ENTITY_SQL\} AND \$\{ASSET_ENTITY_SQL\}`/.test(src), 'clearHistory keeps staff / fuel / HR / payroll / asset rows');
  // Fixed Assets: asset / ledger rows (and 'finance' rows) hidden without assets.view.
  assert.deepEqual(hideClauses({ assets: true }).length, 2);
  assert.ok(hideClauses({ assets: true }).some((c) => c.includes("sensitivity <> 'finance'")));
});

test('the HR scheduler starts on the data-owning boot path, next to the fuel one', () => {
  const src = read('main/index.js');
  const fuelAt = src.indexOf("require('./fuelScheduler').startFuelScheduler");
  const hrAt = src.indexOf("require('./hrScheduler').startHrScheduler");
  assert.ok(fuelAt > 0 && hrAt > fuelAt);
});

test('the schema is additive: no SCHEMA_VERSION change, only IF NOT EXISTS / addColumnIfMissing', () => {
  const schema = read('main/db/hrSchema.js');
  assert.ok(!/DROP TABLE|ALTER TABLE \w+ DROP|SCHEMA_VERSION\s*=/.test(schema));
  for (const m of schema.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) (?!IF NOT EXISTS)/g)) assert.fail(`not idempotent: ${m[0]}`);
  assert.match(read('main/db/index.js'), /const SCHEMA_VERSION = 2;/);
});

test('a refusal thrown on purpose is HTTP 422 over /api/rpc; anything else stays 500', () => {
  const { isUserFacing, userError, USER_ERROR_STATUS } = require('../main/util/userError');
  assert.equal(USER_ERROR_STATUS, 422);
  assert.equal(isUserFacing(userError('Only a manager can leave kiosk mode')), true);
  assert.equal(isUserFacing(Object.assign(new Error('That time is in the future'), { code: 'BAD_REQUEST' })), true);
  assert.equal(isUserFacing(new Error('SQLITE_BUSY: database is locked')), false);
  assert.equal(isUserFacing(new TypeError('x is not a function')), false);
  assert.match(read('main/server/index.js'), /isUserFacing\(err\) \? USER_ERROR_STATUS : 500/);
});
