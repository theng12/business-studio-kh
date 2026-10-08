/**
 * The parts of the data-safety fixes a database test cannot see: who may use
 * the recycle bin, and the renderer/IPC call sites that have to use the safe
 * helpers. The behaviour itself is pinned by test/dataSafety.test.js
 * (`npm run test:native`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { channelCapability } = require('../main/util/capabilities');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('the recycle bin is gated: restore with delete rights, purge is admin only', () => {
  const { ADMIN_ONLY } = require('../main/util/capabilities');
  const { allowedByCaps } = require('../main/util/permissions');
  assert.equal(channelCapability('deleted:list'), 'products.delete');
  assert.equal(channelCapability('deleted:restore'), 'products.delete');
  // Purging is the irreversible step (the files leave the data folder), and
  // the owner wants it for the admin alone (2026-10-02) — no grantable key.
  assert.equal(channelCapability('deleted:purge'), ADMIN_ONLY);
  assert.equal(channelCapability('deleted:empty'), ADMIN_ONLY);
  const admin = new Set(['*']);
  const powerful = new Set(['products.delete', 'system.manage', 'users.manage']);
  assert.equal(allowedByCaps(admin, 'deleted:purge'), true);
  assert.equal(allowedByCaps(admin, 'deleted:empty'), true);
  assert.equal(allowedByCaps(powerful, 'deleted:purge'), false, 'even system.manage cannot purge');
  assert.equal(allowedByCaps(powerful, 'deleted:empty'), false);
  assert.equal(allowedByCaps(powerful, 'deleted:restore'), true, 'restoring stays open to delete rights');
  const panel = read('renderer/modules/Settings/DeletedItemsPanel.jsx');
  assert.match(panel, /canPurge = useUserCaps\(\)\.includes\('\*'\)/, 'the screen hides the purge buttons from non-admins');
});

test('every in-place image writer lands through replaceImageFile, by row id', () => {
  const images = read('main/ipc/images.js');
  const templates = read('main/ipc/templates.js');
  // The old pattern — rename over the path read before the encode, then stamp
  // the hash by that path — is what overwrote a renumbered neighbour.
  assert.doesNotMatch(images, /setContentHash\(productId, (filepath|oldRel|newRel)/);
  assert.doesNotMatch(templates, /setContentHash\(/);
  assert.equal((images.match(/productImages\.replaceImageFile\(/g) || []).length, 3,
    'flip, the shared reframe/crop/enhance writer, and compress/convert');
  assert.match(templates, /productImages\.replaceImageFile\(productId, image\.id/);
});

test('renumbering image IPC waits for adds in the same product', () => {
  const images = read('main/ipc/images.js');
  for (const channel of ['images:setMainImage', 'images:reorderImages', 'images:removeFromProduct']) {
    assert.match(images, new RegExp(`expose\\('${channel}', \\([^)]*\\) => productImages\\.withProductImageLock\\(`),
      `${channel} must run in the product's image queue`);
  }
});

test('bulk Remove background promotes the cutout only after the product is done', () => {
  const modal = read('renderer/modules/ProductLibrary/BulkBgRemovalModal.jsx');
  const loopAt = modal.indexOf('for (const img of targets)');
  const promoteAt = modal.indexOf('await promote();');
  assert.ok(loopAt > 0 && promoteAt > loopAt, 'set-main runs after the targets loop');
  assert.doesNotMatch(modal, /setMainImage\(productId, added\.filepath\)/,
    'promoting inside the loop renumbered the remaining targets');
});

test('brand icons are cache-stamped, since a replaced icon keeps its path', () => {
  assert.match(read('renderer/modules/Brands/index.jsx'), /appImageSrc\(b\.icon, b\.updatedAt\)/);
  assert.match(read('renderer/modules/Brands/BrandForm.jsx'), /appImageSrc\(form\.icon, iconStamp\)/);
});

test('export save-back refreshes the product stamp the thumbnails cache-bust on', () => {
  const runner = read('main/exportRunner.js');
  // The add and the set-main run in one turn of the product image lock
  // (addFromSource makeMain → setMainById by row id inside the lock).
  assert.match(runner, /productImages\.addFromSource\(pid, f, \{ originalFilepath: marker, makeMain: true \}\)/);
  assert.match(runner, /products\.touchUpdated\(pid\)/);
});

test('merge revert/purge never erase quarantined photos in place', () => {
  const dedup = read('main/imageDedup.js');
  assert.doesNotMatch(dedup, /fs\.rmSync\(/);
  assert.match(dedup, /trashPathInBackground\(dir\)/);
});
