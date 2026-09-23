/**
 * v0.1.71: the bulk table's column picker + saved sets must stay REACHABLE.
 *
 * The feature spans four layers, and a wiring failure at any of them is
 * invisible to the unit suite: the DB module and the pure selection rules can
 * be perfect while nothing in the UI calls them, or the preload surface forgets
 * a method the screen uses. So this file scans the real sources for the chain:
 *
 *     bulk table toolbar → preload → IPC channel → validator → client proxy
 *
 * plus the built-in sets and the "other bulk modals untouched" guard. It is
 * deliberately static — the UI crawl covers the runtime path.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const IPC = read('main/ipc/bulkColumns.js');
const BARREL = read('main/ipc.js');
const PRELOAD = read('main/preload.js');
const VALIDATORS = read('main/server/validators.js');
const CLIENT = read('main/client/index.js');
const DB = read('main/db/bulkColumnSets.js');
const SCHEMA = read('main/db/index.js');
const MODAL = read('renderer/modules/ProductLibrary/BulkTableModal.jsx');
const COLS = read('renderer/modules/ProductLibrary/bulkColumns.js');
const UICOMP = read('renderer/modules/ProductLibrary/LibraryColumns.jsx');
const CRAWL = read('scripts/probe-ui-crawl.js');

/** Every channel the feature owns, with the preload method name. */
const CHANNELS = [
  ['bulkColumns:list', 'list'],
  ['bulkColumns:create', 'create'],
  ['bulkColumns:update', 'update'],
  ['bulkColumns:remove', 'remove'],
];

test('the schema creates bulk_column_sets without a version bump', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS bulk_column_sets/,
    'bulk_column_sets is not created — an existing install would have no home for saved sets');
  assert.match(SCHEMA, /idx_bulk_column_sets_company_updated/,
    'the table needs the (company_id, updated_at) index its list() query uses');
  const version = SCHEMA.match(/const SCHEMA_VERSION = (\d+);/);
  assert.equal(version?.[1], '2',
    'SCHEMA_VERSION moved — a bump wipes real content tables, and a new table needs only CREATE TABLE IF NOT EXISTS');
});

test('the DB module implements the CRUD shape socialGridTemplates established', () => {
  for (const fn of ['list', 'get', 'create', 'update', 'remove', 'duplicate']) {
    assert.match(DB, new RegExp(`function ${fn}\\(`), `main/db/bulkColumnSets.js has no ${fn}()`);
  }
  assert.match(DB, /prepareOptimisticPatch/, 'updates must honour the optimistic-concurrency token');
  assert.match(DB, /nextUpdatedAt/, 'a wall-clock timestamp is not a revision');
});

test('main registers and wires every column-set channel', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(IPC.includes(`expose('${channel}'`), `${channel} is not registered in main/ipc/bulkColumns.js`);
  }
  assert.match(BARREL, /bulkColumnsDomain\.register\(helpers\)/,
    'main/ipc.js never registers the bulkColumns domain');
});

test('preload exposes a method for every column-set channel', () => {
  assert.match(PRELOAD, /bulkColumns:\s*\{/, 'main/preload.js has no bulkColumns domain');
  for (const [channel, method] of CHANNELS) {
    assert.match(PRELOAD, new RegExp(`${method}:\\s*\\(`), `window.api.bulkColumns.${method} is missing`);
    assert.ok(PRELOAD.includes(`'${channel}'`), `preload does not invoke ${channel}`);
  }
});

test('every column-set channel has a validator', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(VALIDATORS.includes(`'${channel}'`),
      `${channel} has no validator — test/validatorCoverage would fail, and a bad argument would reach the handler`);
  }
});

test('client mode proxies every column-set channel to the server', () => {
  // The sets live with the data, so a client Mac asks the server for them.
  for (const [channel] of CHANNELS) {
    assert.ok(CLIENT.includes(`'${channel}'`),
      `${channel} is not in PROXIED_CHANNELS — on a client Mac the saved sets would come back empty`);
  }
});

test('the bulk table toolbar has a Columns picker over the shared control', () => {
  assert.match(MODAL, /<ColumnsControl/, 'the bulk table never renders the shared ColumnsControl');
  assert.match(MODAL, /import \{ ColumnsControl \} from '\.\/LibraryColumns\.jsx'/,
    'the picker must be the Product Library one, so the app has a single way to pick columns');
  assert.match(MODAL, /Columns ▾/, 'the toolbar control is not labelled "Columns ▾"');
  assert.match(MODAL, /BUILTIN_SETS/, 'the bulk table does not offer the built-in sets');
  assert.match(MODAL, /window\.api\.bulkColumns\.(list|create|update|remove)\(/,
    'the bulk table never calls the saved-set channels');
  // Up/down reorder, never drag.
  assert.match(UICOMP, /onMove/, 'ColumnsControl has no reorder hook, so reordering cannot exist');
  assert.match(MODAL, /moveColumn\(/, 'the bulk table never reorders columns');
});

test('the built-in sets exist and Everything is the default', () => {
  for (const label of ['Everything', 'Basics', 'Prices', 'Logistics']) {
    assert.ok(COLS.includes(`label: '${label}'`), `built-in set "${label}" is missing`);
  }
  assert.match(COLS, /key: 'everything', label: 'Everything', all: true/,
    'Everything must be the all-columns sentinel');
  // The last-used selection is localStorage; the named sets are the DB rows.
  assert.match(COLS, /BulkTable\.columns/, 'the last-used selection key is missing');
  assert.match(MODAL, /loadColumnSelection|saveColumnSelection/,
    'the bulk table never persists its last-used selection');
});

test('Bulk AI and the other untouched bulk modals stay untouched', () => {
  // AGENTS.md section 25: the three remaining bulk modals are closed decisions.
  for (const file of ['BulkBgRemovalModal.jsx', 'BulkOverlayRunModal.jsx', 'BulkProductsAIRunModal.jsx']) {
    const src = read(`renderer/modules/ProductLibrary/${file}`);
    assert.ok(!/bulkColumns|ColumnsControl/.test(src),
      `${file} gained column-set wiring — the column picker belongs to the bulk table only`);
  }
});

test('the UI crawl drives the picker, the saved set and a resize after switching', () => {
  assert.match(CRAWL, /Columns ▾/, 'the crawl never opens the Columns picker');
  assert.match(CRAWL, /data-col-key="variant"/, 'the crawl never hides a column');
  assert.match(CRAWL, /a hidden column stays hidden after close and reopen/,
    'the crawl does not prove the hidden choice survives a reopen');
  assert.match(CRAWL, /Save as set/, 'the crawl never saves a named set');
  assert.match(CRAWL, /switching built-in sets swaps the visible columns/,
    'the crawl does not switch between sets');
  assert.match(CRAWL, /resizing still works after switching sets/,
    'the crawl does not re-prove resize after a set switch');
});

test('the UI crawl proves the overlay artwork fit on the mismatched case', () => {
  assert.match(CRAWL, /async function deepOverlayFitFlow\(/, 'the crawl has no overlay-fit leg');
  assert.match(CRAWL, /await deepOverlayFitFlow\(crawl, photoPath\)/, 'the overlay-fit leg is never called');
  assert.match(CRAWL, /crawl\.step\('deep overlay fit flow', false/, 'the leg has no non-fatal catch');
  assert.match(CRAWL, /dataset\?\.fit|data-fit/, 'the crawl does not assert the rendered fit mapping');
  assert.match(CRAWL, /objectFit/, 'the crawl does not read the computed object-fit');
});
