/**
 * Finance expenses: the pure money arithmetic (main/util/financeMath.js).
 * Runs under plain Node — no database. `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { isWholeMinor, isRate, usdCentsFromMinor, khrMinorFromMinor, exceedsThreshold } = require('../main/util/financeMath');

test('whole minor units only: non-negative safe integers', () => {
  for (const v of [0, 1, 10000, Number.MAX_SAFE_INTEGER]) assert.equal(isWholeMinor(v), true, String(v));
  for (const v of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, '10', null]) {
    assert.equal(isWholeMinor(v), false, String(v));
  }
});

test('a usable rate is a finite number above zero', () => {
  assert.equal(isRate(4100), true);
  assert.equal(isRate('4100'), true);
  for (const v of [0, -1, NaN, Infinity, null, undefined, '']) assert.equal(isRate(v), false, String(v));
});

test('USD passes through as cents', () => {
  assert.equal(usdCentsFromMinor('USD', 1000, 4100), 1000);
  assert.equal(usdCentsFromMinor('USD', 1, 5000), 1);
});

test('KHR converts to whole US cents at the house rate', () => {
  assert.equal(usdCentsFromMinor('KHR', 4100, 4100), 100);     // 4,100 riel = $1.00
  assert.equal(usdCentsFromMinor('KHR', 41000, 4100), 1000);   // 41,000 riel = $10.00
  assert.equal(usdCentsFromMinor('KHR', 100, 4100), 2);        // rounds to 2 cents
  assert.equal(usdCentsFromMinor('KHR', 1, 4100), 0);          // below 1 cent
  assert.throws(() => usdCentsFromMinor('EUR', 100, 4100), /Unknown currency/);
});

test('the riel figure both lines carry: exact for KHR, converted for USD', () => {
  assert.equal(khrMinorFromMinor('KHR', 41000, 1000, 4100), 41000);
  assert.equal(khrMinorFromMinor('USD', 1000, 1000, 4100), 41000);
  assert.throws(() => khrMinorFromMinor('EUR', 100, 100, 4100), /Unknown currency/);
});

test('the threshold is strictly above: exactly $100 does not need approval', () => {
  assert.equal(exceedsThreshold(10000, 10000), false);
  assert.equal(exceedsThreshold(10001, 10000), true);
  assert.equal(exceedsThreshold(9999, 10000), false);
  assert.equal(exceedsThreshold(0, 0), false);
  assert.equal(exceedsThreshold(1, 0), true);
});
