/**
 * v0.1.86: the recycle bin's wiring — because the feature is only real if the
 * screen can reach it.
 *
 * The behavioural half lives in test/deletedItems.test.js (real database, real
 * files, `npm run test:native`). What this file checks is the part a unit test
 * cannot see:
 *
 *   - every channel registered on one side is validated, exposed on the preload
 *     bridge and proxied for client mode (the failure this project keeps
 *     hitting);
 *   - the two delete paths actually CALL the bin instead of erasing files — a
 *     restore button is decoration if the delete still unlinks the file;
 *   - the panel exists in Settings, is offered to the right capability, and the
 *     copy tells the user the three things that matter: how long it is kept,
 *     that "delete forever" still goes to the Mac's Trash, and that a backup
 *     restore replaces the list.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MODULE = read('main/deletedItems.js');
const IPC = read('main/ipc/deletedItems.js');
const BARREL = read('main/ipc.js');
const VALIDATORS = read('main/server/validators.js');
const PRELOAD = read('main/preload.js');
const CLIENT = read('main/client/index.js');
const PRODUCTS_DB = read('main/db/products.js');
const IMAGES_DB = read('main/db/productImages.js');
const SETTINGS = read('renderer/modules/Settings/index.jsx');
const PANEL = read('renderer/modules/Settings/DeletedItemsPanel.jsx');
const FORM = read('renderer/modules/ProductLibrary/ProductForm.jsx');
const LIBRARY = read('renderer/modules/ProductLibrary/index.jsx');
const BOOT = read('main/index.js');
const CONFIG = read('main/config.js');
const SCHEMA = read('main/db/index.js');

test('the four channels are registered, validated, bridged and proxied', () => {
  assert.match(BARREL, /deletedDomain\.register\(helpers\)/);
  for (const channel of ['deleted:list', 'deleted:restore', 'deleted:purge', 'deleted:empty']) {
    assert.match(IPC, new RegExp(`expose\\('${channel}'`), `${channel} must be registered`);
    assert.match(VALIDATORS, new RegExp(`'${channel}':`), `${channel} needs a validator`);
    assert.ok(CLIENT.includes(`'${channel}'`), `${channel} must be proxied — a client Mac can restore too`);
  }
  assert.match(PRELOAD, /deleted: \{[\s\S]{0,400}restore:/);
  assert.match(PRELOAD, /invoke\('deleted:restore', id\)/);
});

test('the table is additive, so no schema bump and no wiped catalogue', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS deleted_items \(/);
  assert.match(SCHEMA, /idx_deleted_items_at/);
  // A bump would run wipeStructuralTables() and destroy the catalogue — the
  // recycle bin must never be the reason for one.
  assert.match(SCHEMA, /const SCHEMA_VERSION = 2;/);
});

test('both delete paths move files into the bin instead of erasing them', () => {
  // Product: the hold call replaced the v0.1.85 trash-the-folder step.
  assert.match(PRODUCTS_DB, /require\('\.\.\/deletedItems'\)\.holdProduct\(/);
  assert.doesNotMatch(PRODUCTS_DB, /fs\.rmSync\(abs, \{ recursive: true, force: true \}\)/);
  assert.match(PRODUCTS_DB, /imageRows: rawImageRows/, 'the image rows must be snapshotted before the DELETE');
  assert.match(PRODUCTS_DB, /moveAssets: sharedWithCount === 0/,
    'a folder shared with another product must not be moved — v0.1.27');

  // Image: held BEFORE the renumber pass, which is what makes it safe.
  assert.match(IMAGES_DB, /require\('\.\.\/deletedItems'\)\.holdImage\(/);
  const holdAt = IMAGES_DB.indexOf("holdImage(");
  const renumberAt = IMAGES_DB.indexOf('renumberFiles(productId);', holdAt);
  assert.ok(holdAt > 0 && renumberAt > holdAt, 'the photo must be held before the survivors are renumbered');
});

test('restore re-inserts the rows that were snapshotted, files and all', () => {
  assert.match(MODULE, /function insertRow\(table, row\)/);
  assert.match(MODULE, /insertRow\('products', productRow\)/);
  assert.match(MODULE, /insertRow\('product_images', imageRow\)/);
  assert.match(MODULE, /function putBack\(fromAbs, toAbs\)/);
  // A slot taken while the item was away must not be overwritten.
  assert.match(MODULE, /restored-\$\{crypto\.randomUUID\(\)\}/);
  // And a refusal has to be actionable, not silent.
  assert.match(MODULE, /exists again\. Rename or delete it first, then restore this one\./);
});

test('the retention window is a setting, swept at boot, and 0 means never', () => {
  assert.match(CONFIG, /deletedRetentionDays: 30,/);
  assert.match(BOOT, /require\('\.\/deletedItems'\)\.purgeExpired\(\{ retentionDays \}\)/);
  assert.match(MODULE, /if \(!\(retentionDays > 0\)\) return \{ removed: 0, kept: count\(\) \}/);
  // Purge goes through the Trash helper rather than deleting on the spot.
  assert.match(MODULE, /trash\(dir\)\.catch/);
});

test('Settings offers the panel, and it says the three things that matter', () => {
  assert.match(SETTINGS, /import \{ DeletedItemsPanel \} from '\.\/DeletedItemsPanel\.jsx'/);
  assert.match(SETTINGS, /\{ key: 'deleted',\s+label: 'Recently deleted' \}/);
  assert.match(SETTINGS, /tab === 'deleted' && \(\s*<DeletedItemsPanel/);
  assert.match(SETTINGS, /t\.key === 'backups' \|\| t\.key === 'deleted'/,
    'the recycle bin is a data-folder operation like backups — same capability gate');

  // How long: the setting itself, with the window offered in the UI.
  assert.match(PANEL, /window\.api\.settings\.setOne\('deletedRetentionDays'/);
  assert.match(PANEL, /<option value="7">7 days<\/option>/);
  assert.match(PANEL, /<option value="30">30 days<\/option>/);
  assert.match(PANEL, /<option value="0">Until I clear it<\/option>/);
  assert.match(PANEL, /restorable for \$\{item\.daysLeft\}/);
  // Forever-purge still leaves a way back through Finder.
  assert.match(PANEL, /files are moved to the Mac\\?'s Trash first/);
  // And the honest caveat about backups.
  assert.match(PANEL, /not part of a backup file/);
  // Emptying everything is destructive enough to need the word typed.
  assert.match(PANEL, /requireText: 'DELETE'/);
});

test('the delete screens point at the bin, so the restore is discoverable', () => {
  // The copy wraps across lines in the JSX, so allow whitespace inside it.
  assert.match(FORM, /waits in Settings →\s*Recently deleted/);
  assert.match(FORM, /restore it from Settings → Recently deleted/);
  assert.match(LIBRARY, /restore from Settings → Recently deleted/);
  assert.match(LIBRARY, /wait in Settings →\s*Recently deleted/);
});

test('the phone viewer\'s image delete points at the bin too (v0.1.89)', () => {
  // The viewer deletes through images:removeFromProduct, which holds the photo
  // in the recycle bin like the desktop does — so its confirm must not say
  // the delete is final, and must say where the photo went.
  const VIEWER = read('webclient/index.html');
  assert.doesNotMatch(VIEWER, /This can\\'t be undone\./, 'the viewer still calls an image delete final');
  assert.match(VIEWER, /It goes to Recently deleted on the Mac \(Settings → Recently deleted\)/);
  assert.match(VIEWER, /window\.confirm\(deleteImageConfirmText\(index\)\)/);
  assert.match(VIEWER, /rpc\('images:removeFromProduct'/);
});
