/**
 * v0.1.70: the "which images?" control must be wired into EVERY
 * image-affecting bulk operation, not just the overlay apply.
 *
 * v0.1.69 built the shared pieces (main/util/imageScope.js, ImageScopeField)
 * and proved them on Apply overlay. This file pins the follow-up: Remove
 * background, Auto crop, Enhance, Convert format, Compress and Resize all
 * offer the same choice, send `positions` on the channel they already call,
 * and have that channel run the shared selectImages rule. It also pins the
 * deliberate exclusion of Bulk AI (it generates FROM an image, it does not
 * edit one in place) and each modal's default scope.
 *
 * Static on purpose: runs under plain `npm test`, no Electron, no DB. The
 * runtime end-to-end for one destructive op is the UI crawl.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MODALS = {
  compress: read('renderer/modules/ProductLibrary/BulkCompressModal.jsx'),
  convert: read('renderer/modules/ProductLibrary/BulkConvertModal.jsx'),
  resize: read('renderer/modules/ProductLibrary/BulkResizeModal.jsx'),
  autocrop: read('renderer/modules/ProductLibrary/AutoCropRunModal.jsx'),
  enhance: read('renderer/modules/ProductLibrary/AutoEnhanceRunModal.jsx'),
  bgremoval: read('renderer/modules/ProductLibrary/BulkBgRemovalModal.jsx'),
  bulkAi: read('renderer/modules/ProductLibrary/BulkProductsAIRunModal.jsx'),
};
const IPC = read('main/ipc/images.js');
const VALIDATORS = read('main/server/validators.js');
const PRELOAD = read('main/preload.js');
const CLIENT = read('main/client/index.js');

const SHARED_IMPORT = /import\s*\{[^}]*\bImageScopeField\b[^}]*\}\s*from\s*'\.\/ImageScopeField\.jsx'/;

test('all six image operations render the shared ImageScopeField', () => {
  for (const [name, src] of Object.entries(MODALS)) {
    if (name === 'bulkAi') continue;
    assert.match(src, SHARED_IMPORT, `${name} does not import ImageScopeField`);
    assert.match(src, /<ImageScopeField/, `${name} imports the control but never renders it`);
  }
});

test('each modal sends positions on the IPC call it already made', () => {
  for (const name of ['compress', 'convert', 'resize']) {
    assert.match(MODALS[name], /reencodeProducts\(\{[\s\S]{0,400}?positions:\s*state\.positions/,
      `${name} does not pass positions to images:reencodeProducts`);
  }
  assert.match(MODALS.autocrop, /autoCropProducts\(\{[\s\S]{0,400}?positions:\s*imageChoice\.value\.positions/,
    'Auto crop does not pass positions to images:autoCropProducts');
  assert.match(MODALS.enhance, /autoEnhanceProducts\(\{[\s\S]{0,400}?positions:\s*imageChoice\.value\.positions/,
    'Enhance does not pass positions to images:autoEnhanceProducts');
  assert.match(MODALS.bgremoval, /listByProduct\(\{\s*productId,\s*scope,\s*positions\s*\}\)/,
    'Remove background does not ask the scoped images:listByProduct for its selection');
});

test('every changed handler runs the ONE shared selectImages rule', () => {
  const uses = IPC.match(/selectImages\(/g) || [];
  // autoCropProducts, autoEnhanceProducts, reencodeProducts + the scoped
  // images:listByProduct form the Remove background flow uses.
  assert.ok(uses.length >= 4, `main/ipc/images.js calls selectImages only ${uses.length} time(s)`);
  assert.match(IPC, /selectImages\(all, \{ scope, positions \}\)/, 'the bulk ops do not use the shared rule');
  assert.match(IPC, /selectImages\(images, \{ scope, positions \}\)/, 'the scoped listByProduct does not use the shared rule');
  // The rule itself must stay single-sourced.
  assert.match(read('main/util/imageScope.js'), /function selectImages\(images, \{ scope = 'main', positions \} = \{\}\)/);
});

test('every changed channel has a validator that checks positions', () => {
  for (const channel of ['images:autoCropProducts', 'images:autoEnhanceProducts', 'images:reencodeProducts', 'images:listByProduct']) {
    assert.ok(VALIDATORS.includes(`'${channel}'`), `${channel} has no validator`);
  }
  const checks = VALIDATORS.match(/validateOptionalPositions\(a\.positions\)/g) || [];
  // 3 templates:* + 3 images bulk ops + the images:listByProduct scoped form.
  assert.ok(checks.length >= 7, `validateOptionalPositions is used ${checks.length} time(s)`);
});

test('the delete-the-middle-man path is reachable: preload + client proxy', () => {
  assert.match(PRELOAD, /listByProduct:\s*\(arg\)/, 'preload still collapses listByProduct to a string id');
  for (const method of ['autoCropProducts', 'autoEnhanceProducts', 'reencodeProducts']) {
    assert.ok(PRELOAD.includes(`${method}:`), `window.api.images.${method} is missing from preload`);
  }
  for (const channel of ['images:autoCropProducts', 'images:autoEnhanceProducts', 'images:reencodeProducts', 'images:listByProduct']) {
    assert.ok(CLIENT.includes(`'${channel}'`), `${channel} is not proxied in client mode`);
  }
});

test('every modal keeps its previous behaviour as the default scope', () => {
  // main-only today → main default.
  for (const name of ['compress', 'convert', 'resize']) {
    assert.match(MODALS[name], /scope:\s*'main'/, `${name} no longer defaults to the main image`);
  }
  // Enhance was main-only; its hook default is main (no explicit all default).
  assert.match(MODALS.enhance, /useImageScope\(\)/, 'Enhance lost its shared scope hook');
  assert.doesNotMatch(MODALS.enhance, /useImageScope\(\{\s*scope:\s*'all'/, 'Enhance changed its default scope');
  // Remove background was main-only.
  assert.match(MODALS.bgremoval, /useImageScope\(\)/, 'Remove background lost its shared scope hook');
  // Auto crop processed every image → all default, on mount AND on each open.
  assert.match(MODALS.autocrop, /useImageScope\(\{\s*scope:\s*'all'/, 'Auto crop no longer defaults to all images');
  assert.match(MODALS.autocrop, /reset\(\{\s*scope:\s*'all'/, 'Auto crop does not restore its all-images default on open');
});

test('the skip is reported in every modal toast', () => {
  for (const name of ['compress', 'convert', 'resize']) {
    assert.match(MODALS[name], /formatBulkImageResult\(res[\s\S]{0,120}?verb:/, `${name} toast ignores the result summary`);
  }
  for (const name of ['autocrop', 'enhance']) {
    assert.match(MODALS[name], /formatBulkImageResult\(res/, `${name} toast ignores the skip summary`);
  }
  assert.match(MODALS.bgremoval, /summarizeSkippedReasons\(skippedReasons\)/, 'Remove background does not report its skips');
});

test('Bulk AI is deliberately untouched', () => {
  assert.doesNotMatch(MODALS.bulkAi, /ImageScopeField/, 'Bulk AI gained the image-scope picker it must not have');
  assert.doesNotMatch(MODALS.bulkAi, /Specific positions/, 'Bulk AI grew the positions UI');
  assert.doesNotMatch(MODALS.bulkAi, /positions:/, 'Bulk AI now sends an image positions list');
});
