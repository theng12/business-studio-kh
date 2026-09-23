/**
 * v0.1.70: the free-text positions parser finally has a real unit test.
 *
 * v0.1.69 shipped `parsePositionsInput` inside a .jsx component, so the range
 * syntax ("2-4") and the junk handling were never exercised — the UI crawl
 * typed a single "2" and nothing more. The pure value logic now lives in
 * renderer/modules/ProductLibrary/imageScopeValue.mjs, which plain
 * `npm test` (CommonJS) can load with a dynamic import: no React, no JSX,
 * no Electron.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// Resolved relative to this file; node caches the module across tests.
const load = () => import('../renderer/modules/ProductLibrary/imageScopeValue.mjs');

test('parsePositionsInput reads comma, space, semicolon and range syntax', async () => {
  const { parsePositionsInput } = await load();
  assert.deepEqual(parsePositionsInput('2, 4'), [2, 4]);
  assert.deepEqual(parsePositionsInput('2 4'), [2, 4]);
  assert.deepEqual(parsePositionsInput('2;4'), [2, 4]);
  assert.deepEqual(parsePositionsInput('2-4'), [2, 3, 4]);
  // A backwards range is still a range, and the en dash is accepted.
  assert.deepEqual(parsePositionsInput('4-2'), [2, 3, 4]);
  assert.deepEqual(parsePositionsInput('1–3'), [1, 2, 3]);
  // Mixed forms, deduped and sorted regardless of input order.
  assert.deepEqual(parsePositionsInput('  3 , 1 , 3-4 '), [1, 3, 4]);
});

test('parsePositionsInput drops junk, out-of-range values and the cap overflow', async () => {
  const { parsePositionsInput, MAX_IMAGE_POSITION } = await load();
  assert.deepEqual(parsePositionsInput('abc 0 -3 2.5 2'), [2]);
  assert.deepEqual(parsePositionsInput(''), []);
  assert.deepEqual(parsePositionsInput(null), []);
  assert.deepEqual(parsePositionsInput(undefined), []);
  assert.deepEqual(parsePositionsInput('1, 51'), [1]);
  assert.deepEqual(parsePositionsInput(`48-${MAX_IMAGE_POSITION + 2}`), [48, 49, 50]);
});

test('buildImageScope keeps the value shape honest per mode', async () => {
  const { buildImageScope, IMAGE_SCOPE_DEFAULT, normalizePositionList } = await load();
  assert.deepEqual(buildImageScope('main', [2, 4]), { scope: 'main', positions: [] });
  assert.deepEqual(buildImageScope('all', [2, 4]), { scope: 'all', positions: [] });
  assert.deepEqual(buildImageScope('positions', [4, 2, 2, 0, 'x', 51]), { scope: 'positions', positions: [2, 4] });
  // An unknown scope degrades to the default, never to 'positions'.
  assert.deepEqual(buildImageScope('nonsense', [2]), { scope: 'main', positions: [] });
  assert.deepEqual(IMAGE_SCOPE_DEFAULT, { scope: 'main', positions: [] });
  assert.deepEqual(normalizePositionList([3, 1, 3, 1.5, -2, 50]), [1, 3, 50]);
});

test('imageScopeNeedsPositions holds the run back only for an empty positions mode', async () => {
  const { imageScopeNeedsPositions } = await load();
  assert.equal(imageScopeNeedsPositions({ scope: 'positions', positions: [] }), true);
  assert.equal(imageScopeNeedsPositions({ scope: 'positions', positions: [2] }), false);
  assert.equal(imageScopeNeedsPositions({ scope: 'main', positions: [] }), false);
  assert.equal(imageScopeNeedsPositions({ scope: 'all', positions: [] }), false);
  assert.equal(imageScopeNeedsPositions(undefined), false);
});

test('summarizeSkippedReasons renders the toast skip line', async () => {
  const { summarizeSkippedReasons } = await load();
  assert.equal(summarizeSkippedReasons({}), '');
  assert.equal(summarizeSkippedReasons(undefined), '');
  assert.equal(summarizeSkippedReasons({ 'no 4th image': 2 }), '2 products skipped: no 4th image');
  assert.equal(summarizeSkippedReasons({ 'no 2nd image': 1 }), '1 product skipped: no 2nd image');
  assert.equal(
    summarizeSkippedReasons({ 'no 2nd image': 1, 'no 4th image': 2 }),
    '1 product skipped: no 2nd image; 2 products skipped: no 4th image',
  );
});

test('formatBulkImageResult says how many products were skipped and why', async () => {
  const { formatBulkImageResult } = await load();
  const withSkip = formatBulkImageResult(
    { products: 3, images: 6, failed: 0, imagesByProduct: { a: 2, b: 2, c: 2 }, skippedReasons: { 'no 4th image': 2 } },
    { verb: 'Compressed', savedLabel: '1.2 MB saved' },
  );
  assert.match(withSkip.text, /Compressed 3 products \(2 images each\)/);
  assert.match(withSkip.text, /6 images/);
  assert.match(withSkip.text, /1\.2 MB saved/);
  assert.match(withSkip.text, /2 products skipped: no 4th image/);
  assert.equal(withSkip.tone, 'info');

  const clean = formatBulkImageResult(
    { products: 1, images: 1, failed: 0, imagesByProduct: { a: 1 } },
    { verb: 'Enhanced' },
  );
  assert.equal(clean.text, 'Enhanced 1 product · 1 image');
  assert.equal(clean.tone, 'success');

  const allFailed = formatBulkImageResult({ products: 0, images: 0, failed: 2 }, { verb: 'Resized' });
  assert.equal(allFailed.tone, 'error');
});
