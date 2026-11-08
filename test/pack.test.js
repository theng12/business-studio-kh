/**
 * Pick & Pack Phase 0 — pure wiring checks.
 *
 * Capabilities, backup allowlists, the compiled /pack page and the order
 * import mapper. The database behaviour lives in test/packNative.test.js
 * (`npm run test:native`).
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

const { channelCapability } = require('../main/util/capabilities');
const { allowedByCaps } = require('../main/util/permissions');
const backup = require('../main/util/backupSafety');
const { buildPackHtml } = require('../scripts/build-webclient');

test('packer capabilities: pack.work reaches the pack screen, not order management', () => {
  assert.deepEqual(channelCapability('pack:getPhoto'), ['pack.work', 'orders.manage']);
  assert.deepEqual(channelCapability('pack:seal'), ['pack.work', 'orders.manage']);
  assert.equal(channelCapability('pack:updateSettings'), 'orders.manage');
  assert.equal(channelCapability('orders:list'), 'orders.manage');

  const packer = new Set(['pack.work']);
  assert.equal(allowedByCaps(packer, 'pack:list'), true);
  assert.equal(allowedByCaps(packer, 'pack:get'), true);
  assert.equal(allowedByCaps(packer, 'pack:scan'), true);
  assert.equal(allowedByCaps(packer, 'pack:addPhoto'), true);
  assert.equal(allowedByCaps(packer, 'pack:getPhoto'), true);
  assert.equal(allowedByCaps(packer, 'pack:seal'), true);
  assert.equal(allowedByCaps(packer, 'orders:list'), false);
  assert.equal(allowedByCaps(packer, 'orders:import'), false);
  assert.equal(allowedByCaps(packer, 'pack:updateSettings'), false);

  const manager = new Set(['orders.manage']);
  assert.equal(allowedByCaps(manager, 'pack:list'), true);
  assert.equal(allowedByCaps(manager, 'orders:import'), true);
  assert.equal(allowedByCaps(manager, 'pack:updateSettings'), true);
});

test('parcel evidence travels in backups and archives', () => {
  assert.ok(backup.BACKUP_DATA_ENTRIES.includes('pack'), 'pack must be in BACKUP_DATA_ENTRIES');
  assert.ok(backup.ARCHIVE_TOP_LEVEL_DIRS.has('pack'), 'pack must be in ARCHIVE_TOP_LEVEL_DIRS');
});

test('the /pack page is compiled from webclient/pack and served', () => {
  assert.equal(require('../main/packWebclientHtml'), buildPackHtml(ROOT), 'main/packWebclientHtml.js is stale; run node scripts/build-webclient.js');
  const server = read('main/server/index.js');
  assert.match(server, /urlPath === '\/pack'/);
  assert.match(server, /packWebclientHtml/);
  const preload = read('main/preload.js');
  assert.match(preload, /pack:\s*\{/);
  assert.match(preload, /orders:\s*\{/);
});

test('order import guesses headers and reuses a saved mapping', () => {
  const M = load('renderer/modules/Pack/orderImport.js');
  assert.equal(M.orderAutoGuess('Order No'), 'externalRef');
  assert.equal(M.orderAutoGuess('Order value'), 'value');
  assert.equal(M.orderAutoGuess('Customer Name'), 'customerName');
  assert.equal(M.orderAutoGuess('Mobile'), 'customerPhone');
  assert.equal(M.orderAutoGuess('Item SKU'), 'sku');
  assert.equal(M.orderAutoGuess('Qty'), 'quantity');
  assert.equal(M.orderAutoGuess('Random column'), '__skip__');

  const headers = ['Order No', 'Customer', 'SKU', 'Qty'];
  const saved = { 'Order No': 'externalRef', Customer: 'customerName', SKU: 'sku', Qty: 'quantity' };
  assert.deepEqual(M.applySavedMapping(headers, saved), saved);
  assert.equal(M.mappingReady(headers, saved), true);

  const sheet = {
    headers,
    rows: [
      { 'Order No': 'A-1', Customer: 'Sokha', SKU: 'P-1', Qty: '2' },
      { 'Order No': 'A-1', Customer: 'Sokha', SKU: 'P-2', Qty: '1' },
    ],
  };
  const rows = M.buildOrderRows(sheet, saved);
  assert.deepEqual(rows, [
    { externalRef: 'A-1', customerName: 'Sokha', sku: 'P-1', quantity: 2 },
    { externalRef: 'A-1', customerName: 'Sokha', sku: 'P-2', quantity: 1 },
  ]);
});
