/**
 * Fixed Assets A0: the balance and riel-rounding rules of one journal entry
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §5.2 rule 1). Pure — plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../main/util/ledgerMath');

const line = (accountId, debitMinor, creditMinor, extra = {}) => ({ accountId, debitMinor, creditMinor, ...extra });

test('a balanced entry gets riel on every line, and the riel side balances too', () => {
  // The §4.2 opening: Dr Vehicles 30,000 / Cr Acc dep 17,775 / Cr Opening equity 12,225.
  const { lines, totalMinor, khrTotal } = L.prepareLines([
    line('veh', 3_000_000, 0), line('acc', 0, 1_777_500), line('eq', 0, 1_222_500),
  ], 4050);
  assert.equal(totalMinor, 3_000_000);
  assert.deepEqual(lines.map((l) => l.khrMinor), [121_500_000, 71_988_750, 49_511_250]);
  assert.equal(khrTotal, 121_500_000);
  assert.deepEqual(L.linesBalance(lines), { usd: true, khr: true, debitMinor: 3_000_000, creditMinor: 3_000_000, khrDebit: 121_500_000, khrCredit: 121_500_000 });
});

test('riel rounding differences land on the largest line', () => {
  // Three credits of 1 cent at 4,100.5 riel/$ round to 41 each (123) against a
  // debit of 3 cents → 123.015 → 123: balanced. Use a rate that leaves a remainder.
  const { lines } = L.prepareLines([line('a', 3, 0), line('b', 0, 1), line('c', 0, 1), line('d', 0, 1)], 4150);
  // 3 × 4150 / 100 = 124.5 → 125 (Math.round); credits 41.5 → 42 each = 126; diff −1 on the debit line.
  assert.equal(L.linesBalance(lines).khr, true);
  assert.equal(lines[0].khrMinor, 126);
  assert.deepEqual(lines.slice(1).map((l) => l.khrMinor), [42, 42, 42]);
});

test('a line can bring its own riel figure (paid in riel)', () => {
  const { lines } = L.prepareLines([line('cost', 100_000, 0, { khrMinor: 4_100_000 }), line('clr', 0, 100_000)], 4000);
  assert.equal(lines[0].khrMinor, 4_100_000);
  assert.equal(lines[1].khrMinor, 4_000_000 + 100_000, 'the given riel figure is kept; the other line takes the difference');
  assert.equal(L.linesBalance(lines).khr, true);
  assert.throws(() => L.prepareLines([line('a', 100, 0, { khrMinor: 1 }), line('b', 0, 100, { khrMinor: 2 })], 4000), /do not balance/);
});

test('refusals, in words', () => {
  assert.throws(() => L.prepareLines([line('a', 100, 0), line('b', 0, 99)], 4100), /does not balance/);
  assert.throws(() => L.prepareLines([line('a', 100, 0)], 4100), /at least two lines/);
  assert.throws(() => L.prepareLines([line('a', 100, 100), line('b', 0, 0)], 4100), /either a debit or a credit/);
  assert.throws(() => L.prepareLines([line('a', -100, 0), line('b', 0, -100)], 4100), /not negative/);
  assert.throws(() => L.prepareLines([line('a', 1.5, 0), line('b', 0, 1.5)], 4100), /whole cents/);
  assert.throws(() => L.prepareLines([line(null, 100, 0), line('b', 0, 100)], 4100), /no account/);
  assert.throws(() => L.prepareLines([line('a', 100, 0), line('b', 0, 100)], 0), /rate above 0/);
});

test('mirror lines swap debits and credits (a reversal)', () => {
  const m = L.mirrorLines([line('a', 5, 0, { khrMinor: 205 }), line('b', 0, 5, { khrMinor: 205 })]);
  assert.deepEqual(m.map((l) => [l.debitMinor, l.creditMinor, l.khrMinor]), [[0, 5, 205], [5, 0, 205]]);
});
