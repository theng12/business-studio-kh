/**
 * Fixed Assets & Branches A0/A1: the wiring around the new channels —
 * capabilities and the Editor preset, client-mode proxying, preload,
 * validators, backups, history guards and the native test list.
 * Pure source/module checks, plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CAPABILITIES, OPT_IN_CAPABILITIES, channelCapability, BASELINE_READS } = require('../main/util/capabilities');
const { allowedByCaps } = require('../main/util/permissions');
const { getValidator } = require('../main/server/validators');
const { BACKUP_DATA_ENTRIES, ARCHIVE_TOP_LEVEL_DIRS } = require('../main/util/backupSafety');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function declared(file) {
  const src = read(file);
  return {
    exposed: [...src.matchAll(/\bexpose\(\s*'([^']+)'/g)].map((m) => m[1]),
    local: [...src.matchAll(/\bexposeLocal\(\s*'([^']+)'/g)].map((m) => m[1]),
  };
}
const FILES = ['main/ipc/assets.js', 'main/ipc/branches.js', 'main/ipc/ledger.js'].map(declared);
const EXPOSED = FILES.flatMap((f) => f.exposed);
const LOCAL = FILES.flatMap((f) => f.local);
const caps = (...k) => new Set(k);

test('three opt-in Assets capabilities, none in the Editor preset', () => {
  assert.deepEqual(CAPABILITIES.filter((c) => c.group === 'Assets').map((c) => c.key), ['assets.view', 'assets.manage', 'assets.count']);
  for (const k of ['assets.view', 'assets.manage', 'assets.count']) assert.ok(OPT_IN_CAPABILITIES.has(k), k);
  const { BUILTIN_ROLES } = require('../main/db/roles');
  const editor = BUILTIN_ROLES.find((r) => r.key === 'editor');
  assert.ok(editor.permissions.includes('products.edit'));
  for (const k of ['assets.view', 'assets.manage', 'assets.count']) assert.ok(!editor.permissions.includes(k), k);
});

test('every asset / branch / fx / ledger channel is mapped (none fall through to legacy)', () => {
  assert.ok(EXPOSED.length >= 50, `expected the full set, saw ${EXPOSED.length}`);
  for (const ch of [...EXPOSED, ...LOCAL]) assert.notEqual(channelCapability(ch), null, ch);
  for (const ch of ['branches:list', 'branches:get', 'fx:list', 'fx:rateOn']) assert.ok(BASELINE_READS.has(ch), ch);
});

test('the §9 matrix: view reads, manage writes, count gets photos, admin locks months', () => {
  const view = caps('assets.view');
  const manage = caps('assets.manage');
  const count = caps('assets.count');
  const editor = caps('products.edit', 'images.manage', 'costing.manage', 'history.view');
  const system = caps('system.manage');
  const READS = ['assets:list', 'assets:get', 'assets:getSchedule', 'assets:listCategories', 'assets:getSettings', 'assets:listEvents', 'ledger:listAccounts', 'ledger:entriesForAsset', 'ledger:getEntry'];
  const WRITES = ['assets:create', 'assets:update', 'assets:activate', 'assets:transfer', 'assets:recordCapex', 'assets:importApply', 'assets:addFile', 'assets:updateSettings', 'ledger:updateAccount'];
  for (const ch of READS) {
    assert.equal(allowedByCaps(view, ch), true, `view → ${ch}`);
    assert.equal(allowedByCaps(manage, ch), true, `manage → ${ch}`);
    assert.equal(allowedByCaps(count, ch), false, `count ✗ ${ch}`);
    assert.equal(allowedByCaps(editor, ch), false, `editor ✗ ${ch}`);
  }
  for (const ch of WRITES) {
    assert.equal(allowedByCaps(manage, ch), true, `manage → ${ch}`);
    assert.equal(allowedByCaps(view, ch), false, `view ✗ ${ch}`);
    assert.equal(allowedByCaps(editor, ch), false, `editor ✗ ${ch}`);
  }
  for (const c of [view, manage, count]) assert.equal(allowedByCaps(c, 'assets:getFile'), true);
  assert.equal(allowedByCaps(editor, 'assets:getFile'), false);
  for (const c of [view, manage, count, editor]) {
    assert.equal(allowedByCaps(c, 'branches:list'), true, 'baseline');
    assert.equal(allowedByCaps(c, 'fx:rateOn'), true, 'baseline');
    assert.equal(allowedByCaps(c, 'ledger:lockPeriod'), false, 'admin only');
  }
  assert.equal(allowedByCaps(caps('*'), 'ledger:lockPeriod'), true);
  // A2: reads for view, posting for manage, filing a tax year for the admin only.
  for (const ch of ['assets:previewDepreciation', 'assets:listRuns', 'assets:getTaxYear', 'assets:getReport', 'assets:getWorkbook', 'assets:saveWorkbook', 'assets:checkIntegrity']) {
    assert.equal(allowedByCaps(view, ch), true, `view → ${ch}`);
    assert.equal(allowedByCaps(editor, ch), false, `editor ✗ ${ch}`);
  }
  for (const ch of ['assets:runDepreciation', 'assets:reverseRun', 'assets:dispose', 'assets:partialDispose', 'assets:markLost', 'assets:markFound', 'assets:impair', 'assets:revalue', 'assets:setPoolOpening']) {
    assert.equal(allowedByCaps(manage, ch), true, `manage → ${ch}`);
    assert.equal(allowedByCaps(view, ch), false, `view ✗ ${ch}`);
  }
  for (const ch of ['assets:markTaxYearFiled', 'assets:unfileTaxYear']) {
    assert.equal(allowedByCaps(manage, ch), false, `admin only: ${ch}`);
    assert.equal(allowedByCaps(caps('*'), ch), true);
  }
  assert.equal(allowedByCaps(system, 'branches:create'), true);
  assert.equal(allowedByCaps(manage, 'branches:create'), false);
  assert.equal(allowedByCaps(system, 'fx:setRate'), true);
  assert.equal(allowedByCaps(manage, 'fx:setRate'), true);
  assert.equal(allowedByCaps(view, 'fx:setRate'), false);
  // §2 gap 5: an asset manager can read a workbook to import.
  assert.equal(allowedByCaps(manage, 'files:parseWorkbook'), true);
  assert.equal(allowedByCaps(caps('products.edit'), 'files:parseWorkbook'), true);
  assert.equal(allowedByCaps(view, 'files:parseWorkbook'), false);
  // A3's stock-take channels are already routed (count or manage).
  assert.equal(allowedByCaps(count, 'stocktake:scan'), true);
  assert.equal(allowedByCaps(count, 'stocktake:close'), false);
});

test('client mode proxies every exposed channel; the Save dialog is local on both sides', () => {
  const src = read('main/client/index.js');
  const block = src.match(/PROXIED_CHANNELS\s*=\s*\[([\s\S]*?)\n\];/)[1];
  for (const ch of EXPOSED) assert.ok(block.includes(`'${ch}'`), `${ch} is not proxied in client mode`);
  assert.deepEqual(LOCAL.sort(), ['assets:saveImportSample', 'assets:saveWorkbook']);
  for (const ch of LOCAL) assert.ok(src.includes(`handleLocal('${ch}'`), `${ch} has no client-side Save dialog`);
});

test('preload exposes every channel and the live-update event', () => {
  const src = read('main/preload.js');
  for (const ch of [...EXPOSED, ...LOCAL]) assert.ok(src.includes(`invoke('${ch}'`), `preload has no method for ${ch}`);
  assert.ok(src.includes("ipcRenderer.on('assets:changed'"));
});

test('validators: every channel has one; shapes are refused in words', () => {
  for (const ch of [...EXPOSED, ...LOCAL]) assert.equal(typeof getValidator(ch), 'function', ch);
  assert.equal(getValidator('assets:transfer')({ assetIds: ['a'], toBranchId: 'b', date: '2026-06-01' }), true);
  assert.match(getValidator('assets:transfer')({ assetIds: [] }), /1–1000/);
  assert.match(getValidator('assets:addFile')({ assetId: 'a', kind: 'photo', bytes: { __bin: true, b64: 'A'.repeat(21 * 1024 * 1024) } }), /too large/);
  assert.match(getValidator('assets:addFile')({ assetId: 'a', kind: 'selfie', bytes: new Uint8Array(3) }), /kind must be/);
  assert.match(getValidator('assets:cancelDraft')({ id: 'a' }), /reason/);
  assert.match(getValidator('assets:update')({ id: 'a', patch: { costMinor: 'lots' } }), /costMinor must be a number/);
  assert.match(getValidator('assets:update')({ id: 'a', patch: { purchaseDate: '12/03/2026' } }), /2026-03-12/);
  assert.match(getValidator('ledger:lockPeriod')({ period: '2026-13' }), /period/);
  assert.match(getValidator('fx:setRate')({ rateDate: '2026-01-01' }), /khrPerUsd/);
  assert.match(getValidator('assets:importPlan')({ rows: new Array(5001).fill({}) }), /5000/);
});

test('backups and the server bundle carry fixed-assets/ — in BOTH lists', () => {
  assert.ok(BACKUP_DATA_ENTRIES.includes('fixed-assets'));
  assert.ok(ARCHIVE_TOP_LEVEL_DIRS.has('fixed-assets'));
  // Every data folder a backup writes must be restorable.
  for (const e of BACKUP_DATA_ENTRIES) if (e !== 'database.sqlite') assert.ok(ARCHIVE_TOP_LEVEL_DIRS.has(e), `${e} is backed up but would be refused on restore`);
  // The bundle carries every backed-up data tree (fixed-assets, finance, …) by
  // deriving from the one allow-list instead of a second hardcoded copy.
  assert.ok(/trees = BACKUP_DATA_ENTRIES\.filter\(\(e\) => e !== 'database\.sqlite'\)/.test(read('main/serverBundle.js')));
});

test('asset files are never served by /assets/ or app-image:// (they live outside assets/)', () => {
  assert.ok(read('main/assetFiles.js').includes("const ROOT_DIR = 'fixed-assets'"));
  for (const file of ['main/server/index.js', 'main/protocol.js']) assert.ok(!read(file).includes('fixed-assets'), `${file} must not serve fixed-assets/`);
});

test('history guards: the register, journals and branches block company deletion; suppliers keep their assets', () => {
  const tables = require('../main/db/fuelHistory').HISTORY_TABLES.map(([t]) => t);
  for (const t of ['fixed_assets', 'asset_events', 'journal_entries', 'branches']) assert.ok(tables.includes(t), t);
  assert.ok(/FROM fixed_assets WHERE supplier_id/.test(read('main/db/suppliers.js')));
});

test('additive only: SCHEMA_VERSION untouched, and the native tests are in the test:native list', () => {
  assert.ok(/const SCHEMA_VERSION = 2;/.test(read('main/db/index.js')));
  for (const f of ['main/db/assetSchema.js', 'main/db/ledgerSchema.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/DROP TABLE|ALTER TABLE \w+ (DROP|RENAME)|SCHEMA_VERSION/.test(src), `${f} must stay additive`);
  }
  const native = JSON.parse(read('package.json')).scripts['test:native'];
  for (const f of ['test/assetsNative.test.js', 'test/ledgerNative.test.js', 'test/assetsBackupNative.test.js', 'test/assetsReviewNative.test.js', 'test/assetsDepreciationNative.test.js', 'test/assetsLagNative.test.js']) assert.ok(native.includes(f), `${f} is not in test:native`);
});
