/**
 * Fuel F1: the wiring around the fuel and staff channels — permissions, the
 * Editor preset, client-mode proxying, preload, validators, backups and the
 * company-delete guard. Pure source/module checks, plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CAPABILITIES, channelCapability } = require('../main/util/capabilities');
const { allowedByCaps } = require('../main/util/permissions');
const { getValidator } = require('../main/server/validators');
const { BACKUP_DATA_ENTRIES } = require('../main/util/backupSafety');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function declared(file) {
  const src = read(file);
  return {
    exposed: [...src.matchAll(/\bexpose\(\s*'([^']+)'/g)].map((m) => m[1]),
    local: [...src.matchAll(/\bexposeLocal\(\s*'([^']+)'/g)].map((m) => m[1]),
  };
}
const FUEL = declared('main/ipc/fuel.js');
const STAFF = declared('main/ipc/staff.js');
const ALL_EXPOSED = [...FUEL.exposed, ...STAFF.exposed];

// The phone page (§5.3) needs these; they must be reachable with fuel.record alone.
const PHONE = [
  'staff:list', 'staff:getPhoto', 'fuel:getSettings', 'fuel:listAssets', 'fuel:listLocations', 'fuel:getDipLitres',
  'fuel:listStations', 'fuel:recordFill', 'fuel:recordDip', 'fuel:recordDelivery', 'fuel:recordTransfer',
  'fuel:receiveTransfer', 'fuel:addPhoto', 'fuel:getPhoto', 'fuel:listMyRecent', 'fuel:listPendingTransfers', 'fuel:voidMyRecord',
];

const caps = (...k) => new Set(k);

test('two Fuel capabilities exist, grouped "Fuel"', () => {
  const fuel = CAPABILITIES.filter((c) => c.group === 'Fuel').map((c) => c.key);
  assert.deepEqual(fuel, ['fuel.record', 'fuel.manage']);
});

test('the Editor preset does NOT get the fuel capabilities (§2 gap 3)', () => {
  const { BUILTIN_ROLES } = require('../main/db/roles');
  const editor = BUILTIN_ROLES.find((r) => r.key === 'editor');
  assert.ok(editor.permissions.includes('products.edit'));
  assert.ok(!editor.permissions.includes('fuel.record'));
  assert.ok(!editor.permissions.includes('fuel.manage'));
});

test('every fuel/staff channel maps to a fuel capability (none fall through to legacy)', () => {
  assert.ok(ALL_EXPOSED.length > 50, `expected the full channel set, saw ${ALL_EXPOSED.length}`);
  for (const ch of [...ALL_EXPOSED, ...FUEL.local]) {
    const cap = channelCapability(ch);
    const list = Array.isArray(cap) ? cap : [cap];
    // Fixed Assets: an asset's custodian picker reads the staff list and one record (as tiles),
    // so staff:list / staff:get are also open to the asset roles — and to nothing else.
    const allowed = ['fuel.record', 'fuel.manage', ...(/^staff:(list|get)$/.test(ch) ? ['assets.view', 'assets.manage'] : [])];
    assert.ok(list.some((c) => c === 'fuel.record' || c === 'fuel.manage') && list.every((c) => allowed.includes(c)), `${ch} → ${JSON.stringify(cap)}`);
  }
});

test('a recorder (fuel.record only) reaches the phone channels and nothing else', () => {
  const recorder = caps('fuel.record');
  for (const ch of PHONE) assert.equal(allowedByCaps(recorder, ch), true, ch);
  for (const ch of ['fuel:listFills', 'fuel:voidRecord', 'fuel:correctFill', 'fuel:reviewFlag', 'fuel:getMonthlyReport', 'fuel:setPrice', 'staff:create', 'staff:markLeft', 'fuel:createAsset', 'fuel:setDeliveryDips']) {
    assert.equal(allowedByCaps(recorder, ch), false, ch);
  }
});

test('a manager (fuel.manage only) can also record; an editor without fuel caps cannot touch fuel', () => {
  const manager = caps('fuel.manage');
  for (const ch of [...PHONE, 'fuel:listFills', 'fuel:voidRecord', 'staff:create']) assert.equal(allowedByCaps(manager, ch), true, ch);
  const editor = caps('products.edit', 'images.manage', 'costing.manage', 'history.view');
  for (const ch of ['fuel:recordFill', 'fuel:listAssets', 'staff:list']) assert.equal(allowedByCaps(editor, ch), false, ch);
});

test('the phone channels are expose()d (RPC-reachable), not local-only', () => {
  for (const ch of PHONE) assert.ok(ALL_EXPOSED.includes(ch), `${ch} must be expose()d`);
  assert.deepEqual(FUEL.local, ['fuel:saveMonthlyWorkbook']);
});

test('client mode proxies every exposed channel and handles the Save dialog locally', () => {
  const src = read('main/client/index.js');
  const block = src.match(/PROXIED_CHANNELS\s*=\s*\[([\s\S]*?)\n\];/)[1];
  for (const ch of ALL_EXPOSED) assert.ok(block.includes(`'${ch}'`), `${ch} is not proxied in client mode`);
  assert.ok(/handleLocal\('fuel:saveMonthlyWorkbook'/.test(src));
});

test('preload exposes every channel', () => {
  const src = read('main/preload.js');
  for (const ch of [...ALL_EXPOSED, ...FUEL.local]) assert.ok(src.includes(`invoke('${ch}'`), `preload has no method for ${ch}`);
});

test('validators: photo size limits and envelopes are checked before decoding', () => {
  const v = getValidator('fuel:recordFill');
  const ok = { kind: 'cash_station', assetId: 'a', amountPaidMinor: 15000, photos: [{ kind: 'pump_display', bytes: { __bin: true, b64: 'AAAA' } }] };
  assert.equal(v(ok), true);
  assert.match(v({ ...ok, photos: [{ kind: 'x', bytes: { __bin: true, b64: 'A'.repeat(21 * 1024 * 1024) } }] }), /too large/);
  assert.match(v({ ...ok, photos: new Array(7).fill(ok.photos[0]) }), /at most 6/);
  assert.match(v({ ...ok, kind: 'gift' }), /kind must be/);
  assert.match(v({ ...ok, clientRef: 'x' }), /clientRef/);
  assert.equal(v({ ...ok, clientRef: 'phone-1:2026-10-08:0001' }), true);
  assert.equal(getValidator('fuel:addPhoto')({ ownerKind: 'fill', ownerId: 'f', kind: 'meter', bytes: new Uint8Array(10) }), true);
  assert.match(getValidator('fuel:addPhoto')({ ownerKind: 'asset', ownerId: 'f', kind: 'meter', bytes: new Uint8Array(10) }), /ownerKind/);
  assert.equal(getValidator('fuel:getMonthlyReport')({ month: '2026-10' }), true);
  assert.match(getValidator('fuel:getMonthlyReport')({ month: '2026-13' }), /month/);
});

test('backups and the server bundle carry fuel/ and hr/', () => {
  assert.ok(BACKUP_DATA_ENTRIES.includes('fuel'));
  assert.ok(BACKUP_DATA_ENTRIES.includes('hr'));
  assert.ok(/trees = \[[^\]]*'fuel'[^\]]*'hr'/.test(read('main/serverBundle.js')));
});

test('companies:remove refuses while staff or fuel history exists', () => {
  const src = read('main/ipc/catalog.js');
  const body = src.slice(src.indexOf("expose('companies:remove'"), src.indexOf("expose('companies:remove'") + 300);
  assert.ok(body.includes('assertCompanyRemovable(id)'));
});

test('fuel photos are never served by /assets/ or app-image:// (they live outside assets/)', () => {
  const photos = read('main/fuelPhotos.js');
  assert.ok(/`fuel\/\$\{phnomPenhMonth\(at\)\}`/.test(photos));
  for (const file of ['main/server/index.js', 'main/protocol.js']) {
    const src = read(file);
    assert.ok(!/['"`]fuel\//.test(src) && !/['"`]hr\//.test(src), `${file} must not serve fuel/ or hr/`);
  }
});
