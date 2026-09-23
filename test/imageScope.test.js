/**
 * v0.1.69: the shared "which images does an operation act on" contract.
 *
 * The customer asked to overlay only the 2nd and 4th photo of each product,
 * with products that lack those photos skipped and reported. main/util/imageScope.js
 * is the ONE place that rule lives, deliberately pure — no DB, no sharp — so
 * the whole contract is testable under plain `npm test`. The follow-up release
 * wires the same helper into the other image operations, so these cases are
 * the shared safety net. End-to-end wiring is covered by
 * test/imageScopeWiring.test.js and the UI crawl.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_IMAGE_POSITION,
  ordinal,
  normalizePositions,
  selectImages,
} = require('../main/util/imageScope');
const { getValidator } = require('../main/server/validators');

/** A stand-in for productImages.listByProduct: an ordered array of rows
 *  (index 0 = main). selectImages only ever indexes into it. */
const images = (n) => Array.from({ length: n }, (_, i) => ({ filepath: `img-${i + 1}.jpg`, orderIndex: i }));

test('normalizePositions dedupes, sorts, and drops nonsense', () => {
  assert.deepEqual(normalizePositions([4, 2, 2, 1]), [1, 2, 4]);
  assert.deepEqual(normalizePositions([2, 4]), [2, 4]);
  // 0, negatives, fractions, strings, NaN and null are not positions.
  assert.deepEqual(normalizePositions([0, -1, 1.5, '2', NaN, null, undefined, {}, 3]), [3]);
  // Non-arrays degrade to "no positions", never throw.
  assert.deepEqual(normalizePositions(undefined), []);
  assert.deepEqual(normalizePositions('2, 4'), []);
  // Above the image cap is dropped rather than carried into a query.
  assert.deepEqual(normalizePositions([1, MAX_IMAGE_POSITION + 1]), [1]);
});

test('ordinal() reads the way the skip message does', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(22), '22nd');
});

test('scope defaults and the legacy main/all contract are unchanged', () => {
  const main = selectImages(images(3), { scope: 'main' });
  assert.deepEqual(main.chosen.map((i) => i.filepath), ['img-1.jpg']);
  assert.equal(main.skippedReason, null);

  const all = selectImages(images(3), { scope: 'all' });
  assert.deepEqual(all.chosen.map((i) => i.filepath), ['img-1.jpg', 'img-2.jpg', 'img-3.jpg']);
  assert.equal(all.skippedReason, null);

  // Processed variant preferred, exactly as the old main-image path did.
  const processed = [{ isProcessed: false }, { isProcessed: true, processedFilepath: 'p.jpg' }];
  assert.equal(selectImages(processed, { scope: 'main' }).chosen[0].processedFilepath, 'p.jpg');

  // Empty galleries are a plain no-op, not a position skip.
  assert.deepEqual(selectImages([], { scope: 'main' }), { chosen: [], skippedReason: 'no images', positions: [], missing: [] });
  assert.equal(selectImages([], { scope: 'all' }).skippedReason, 'no images');
});

test('positions [2,4] apply to both a 2-image and a 4-image product', () => {
  const two = selectImages(images(2), { scope: 'positions', positions: [2, 4] });
  const four = selectImages(images(4), { scope: 'positions', positions: [2, 4] });

  // The 2-image product has its 2nd photo; the 4th is simply not there.
  assert.deepEqual(two.chosen.map((i) => i.filepath), ['img-2.jpg']);
  assert.deepEqual(two.missing, [4]);
  assert.equal(two.skippedReason, null);
  // The 4-image product gets both requested positions.
  assert.deepEqual(four.chosen.map((i) => i.filepath), ['img-2.jpg', 'img-4.jpg']);
  assert.deepEqual(four.missing, []);
  assert.equal(four.skippedReason, null);
});

test('positions [3] skip the 2-image product as "no 3rd image"', () => {
  const two = selectImages(images(2), { scope: 'positions', positions: [3] });
  assert.deepEqual(two.chosen, []);
  assert.deepEqual(two.missing, [3]);
  assert.equal(two.skippedReason, 'no 3rd image');

  const four = selectImages(images(4), { scope: 'positions', positions: [3] });
  assert.deepEqual(four.chosen.map((i) => i.filepath), ['img-3.jpg']);
  assert.equal(four.skippedReason, null);
});

test('a product with none of the requested positions is skipped, not failed', () => {
  assert.equal(selectImages(images(1), { scope: 'positions', positions: [2, 4] }).skippedReason, 'no 2nd image');
  assert.equal(selectImages(images(2), { scope: 'positions', positions: [4] }).skippedReason, 'no 4th image');
  assert.equal(selectImages(images(2), { scope: 'positions', positions: [2] }).skippedReason, null);
  // Positions win over scope when both are supplied.
  assert.equal(selectImages(images(2), { scope: 'all', positions: [1] }).chosen.length, 1);
});

test('the IPC validator rejects nonsense positions before the handler runs', () => {
  const base = { templateId: 't', destination: { kind: 'append' } };
  const bulk = (positions) => getValidator('templates:applyBulk')({ ...base, productIds: ['p'], positions });
  const filtered = (positions) => getValidator('templates:applyByFilter')({ ...base, filters: {}, positions });

  // Old callers that send no positions at all keep working.
  assert.equal(bulk(undefined), true);
  assert.equal(filtered(undefined), true);
  assert.equal(bulk([2, 4]), true);
  assert.equal(filtered([2, 4]), true);
  assert.equal(getValidator('templates:applyToProduct')({ ...base, productId: 'p', positions: [1] }), true);

  // A returned string means the dispatcher answers 400 and the handler
  // (and therefore any data) is never touched.
  for (const bad of [[0], [-1], [1.5], ['2'], [NaN], [2, 0], '2,4', {}]) {
    assert.match(bulk(bad), /positions must be positive integers|positions must be an array/);
    assert.match(filtered(bad), /positions must be positive integers|positions must be an array/);
  }
});

test('v0.1.70: every image-op channel validates the additive positions list', () => {
  for (const channel of ['images:autoCropProducts', 'images:autoEnhanceProducts', 'images:reencodeProducts']) {
    const validate = getValidator(channel);
    // The pre-v0.1.70 contract (productIds only) must still pass.
    assert.equal(validate({ productIds: ['p'] }), true, `${channel} rejects an old-style call`);
    assert.equal(validate({ productIds: ['p'], scope: 'all' }), true, `${channel} rejects a scope-only call`);
    assert.equal(validate({ productIds: ['p'], positions: [2, 4] }), true, `${channel} rejects valid positions`);
    for (const bad of [[0], [-1], [1.5], ['2'], [NaN], '2,4', {}]) {
      assert.match(validate({ productIds: ['p'], positions: bad }),
        /positions must be positive integers|positions must be an array/,
        `${channel} let a nonsense positions value through: ${JSON.stringify(bad)}`);
    }
    // productIds is still required.
    assert.match(validate({ positions: [2] }), /productIds/);
  }
});

test('v0.1.70: images:listByProduct accepts the scoped shape and still the bare id', () => {
  const validate = getValidator('images:listByProduct');
  assert.equal(validate('product-id'), true, 'the legacy bare-id read was broken');
  assert.equal(validate({ productId: 'product-id' }), true);
  assert.equal(validate({ productId: 'product-id', scope: 'positions', positions: [2] }), true);
  assert.match(validate({ positions: [2] }), /productId/);
  assert.match(validate(42), /product id or/);
  assert.match(validate({ productId: 'p', positions: [0] }), /positions must be positive integers/);
});
