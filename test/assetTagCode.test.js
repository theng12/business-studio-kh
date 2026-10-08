/**
 * Fixed Assets A0: tag codes with a Damm check digit (docs/ASSETS_AND_BRANCHES_PLAN.md §6.1).
 * Pure — plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../main/util/assetTagCode');

test('Damm: the published example and the table identity', () => {
  assert.equal(T.dammDigit('572'), 4); // the standard worked example
  assert.equal(T.dammValid('5724'), true);
  assert.equal(T.dammValid('5727'), false);
  for (let i = 0; i < 10; i += 1) assert.equal(T.DAMM[i][i], 0, 'zero diagonal');
});

test('Damm: EVERY single-digit error and EVERY adjacent swap is caught (all 4-digit bodies)', () => {
  let singles = 0;
  let swaps = 0;
  for (let n = 0; n < 10000; n += 1) {
    const body = String(n).padStart(4, '0');
    const code = body + T.dammDigit(body);
    assert.equal(T.dammValid(code), true);
    for (let pos = 0; pos < code.length; pos += 1) {
      for (let d = 0; d < 10; d += 1) {
        if (String(d) === code[pos]) continue;
        const bad = code.slice(0, pos) + d + code.slice(pos + 1);
        assert.equal(T.dammValid(bad), false, `${code} → ${bad}`);
        singles += 1;
      }
    }
    for (let pos = 0; pos < code.length - 1; pos += 1) {
      if (code[pos] === code[pos + 1]) continue;
      const bad = code.slice(0, pos) + code[pos + 1] + code[pos] + code.slice(pos + 2);
      assert.equal(T.dammValid(bad), false, `${code} → ${bad}`);
      swaps += 1;
    }
  }
  assert.equal(singles, 10000 * 5 * 9);
  assert.ok(swaps > 30000);
});

test('format: prefix, at least 4 digits, check digit', () => {
  assert.equal(T.formatTagCode('CK', 427), 'CK-04270');
  assert.equal(T.formatTagCode('ck', 1), 'CK-00013');
  assert.equal(T.formatTagCode('MSK', 12345), `MSK-12345${T.dammDigit('12345')}`);
  assert.throws(() => T.formatTagCode('C', 1), /2 to 4 letters/);
  assert.throws(() => T.formatTagCode('CK1', 1), /2 to 4 letters/);
  assert.throws(() => T.formatTagCode('CK', 0), /whole number/);
  assert.throws(() => T.formatTagCode('CK', 1.5), /whole number/);
});

test('parse: the spellings people type, scanners send and counts assume', () => {
  const want = { ok: true, code: 'CK-04270', prefix: 'CK', seq: 427 };
  for (const s of ['CK-04270', 'ck-04270', 'CK04270', ' ck 0427-0 ', 'Ck-04270\n']) assert.deepEqual(T.parseTagCode(s), want, s);
  assert.deepEqual(T.parseTagCode('04270', { defaultPrefix: 'ck' }), want);
  assert.deepEqual(T.parseTagCode('4270', { defaultPrefix: 'CK' }), want, 'leading zeros may be dropped');
  assert.deepEqual(T.parseTagCode('4270'), { ok: false, reason: 'prefix' });
  assert.deepEqual(T.parseTagCode('CK-04273'), { ok: false, reason: 'check' }, 'the plan\'s illustrative code is not valid');
  assert.deepEqual(T.parseTagCode('CK-04720'), { ok: false, reason: 'check' }, 'swapped digits');
  assert.deepEqual(T.parseTagCode('hello'), { ok: false, reason: 'format' });
  assert.deepEqual(T.parseTagCode(null), { ok: false, reason: 'format' });
  assert.deepEqual(T.parseTagCode('CK-00000'), { ok: false, reason: 'format' }, 'sequence 0 does not exist');
  // Round trip for a range of sequences.
  for (const seq of [1, 9, 10, 999, 1000, 9999, 10000, 123456]) {
    const code = T.formatTagCode('AB', seq);
    assert.deepEqual(T.parseTagCode(code), { ok: true, code, prefix: 'AB', seq });
  }
});

test('default prefix from the company name', () => {
  assert.equal(T.defaultTagPrefix('Chea Kim'), 'CK');
  assert.equal(T.defaultTagPrefix('Chea Kim Trading Co Ltd'), 'CKTC');
  assert.equal(T.defaultTagPrefix('Terranash'), 'TE');
  assert.equal(T.defaultTagPrefix('ក្រុមហ៊ុន'), 'AS');
  assert.equal(T.defaultTagPrefix(''), 'AS');
  assert.equal(T.defaultTagPrefix('X'), 'XX');
});
