/**
 * Finance desktop helpers — the money rules that must never drift.
 *
 * The ledger keeps whole US cents; the screen parses typed amounts from exact
 * strings so no float decides a cent. These checks mirror main/util/financeMath
 * and the server's strict "above the threshold" rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let m;
test.before(async () => {
  m = await import('../renderer/modules/Finance/financeModel.js');
});

test('USD amounts parse from exact strings into whole cents', () => {
  assert.deepEqual(m.parseAmount('12.50', 'USD'), { ok: true, minor: 1250 });
  assert.deepEqual(m.parseAmount('12.5', 'USD'), { ok: true, minor: 1250 });
  assert.deepEqual(m.parseAmount('0.1', 'USD'), { ok: true, minor: 10 });
  assert.deepEqual(m.parseAmount('1,250.00', 'USD'), { ok: true, minor: 125000 });
  assert.deepEqual(m.parseAmount(' 7 ', 'USD'), { ok: true, minor: 700 });
});

test('more than two USD decimals is refused, never rounded', () => {
  const r = m.parseAmount('12.345', 'USD');
  assert.equal(r.ok, false);
  assert.match(r.error, /two decimals/);
});

test('KHR is whole riel only', () => {
  assert.deepEqual(m.parseAmount('1250', 'KHR'), { ok: true, minor: 1250 });
  const r = m.parseAmount('1250.5', 'KHR');
  assert.equal(r.ok, false);
  assert.match(r.error, /whole numbers/);
});

test('blank and non-numeric input are refused with a field message', () => {
  assert.equal(m.parseAmount('', 'USD').ok, false);
  assert.equal(m.parseAmount('   ', 'USD').ok, false);
  assert.equal(m.parseAmount('12a', 'USD').ok, false);
});

test('an amount too large for a safe integer is refused', () => {
  assert.equal(m.parseAmount('99999999999999999', 'USD').ok, false);
});

test('minor units round-trip back into the amount field', () => {
  assert.equal(m.minorToInput(1250, 'USD'), '12.50');
  assert.equal(m.minorToInput(5, 'USD'), '0.05');
  assert.equal(m.minorToInput(1250, 'KHR'), '1250');
  assert.equal(m.minorToInput(null, 'USD'), '');
});

test('USD value uses the server rate; no rate means no guess', () => {
  assert.equal(m.usdMinorFor(1250, 'USD', null), 1250);
  assert.equal(m.usdMinorFor(4100, 'KHR', 4100), 100);
  assert.equal(m.usdMinorFor(1250, 'KHR', null), null);
  assert.equal(m.usdMinorFor(1250, 'KHR', 0), null);
});

test('the smallest KHR amount worth a US cent is the rate divided by 200, rounded up', () => {
  assert.equal(m.minKhrMinorForCent(4100), 21);
  assert.equal(m.minKhrMinorForCent(4000), 20);
  assert.equal(m.minKhrMinorForCent(null), null);
});

test('the threshold is strictly greater — exactly the threshold needs no approval', () => {
  assert.equal(m.exceedsThreshold(10001, 10000), true);
  assert.equal(m.exceedsThreshold(10000, 10000), false);
  assert.equal(m.exceedsThreshold(9999, 10000), false);
  assert.equal(m.exceedsThreshold(null, 10000), false);
});

test('an account may pay only for its own branch, or is a company-wide bank', () => {
  const cashA = { id: 'a', kind: 'cash', branchId: 'b1' };
  const cashB = { id: 'b', kind: 'cash', branchId: 'b2' };
  const bankGlobal = { id: 'g', kind: 'bank', branchId: null };
  const bankBranch = { id: 'h', kind: 'bank', branchId: 'b1' };
  assert.equal(m.accountAllowedForBranch(cashA, 'b1'), true);
  assert.equal(m.accountAllowedForBranch(cashB, 'b1'), false);
  assert.equal(m.accountAllowedForBranch(bankGlobal, 'b1'), true);
  assert.equal(m.accountAllowedForBranch(bankBranch, 'b1'), true);
  assert.deepEqual(
    m.accountsForBranch([cashA, cashB, bankGlobal, bankBranch], 'b1').map((a) => a.id),
    ['a', 'g', 'h'],
  );
});

test('status labels and tones cover every lifecycle state', () => {
  for (const s of m.EXPENSE_STATUSES) {
    assert.ok(m.statusLabel(s) && m.statusLabel(s) !== 'Unknown');
    assert.ok(m.statusTone(s));
  }
  assert.equal(m.isEditable('draft'), true);
  assert.equal(m.isEditable('pending'), false);
  assert.equal(m.isEditable('posted'), false);
});

test('a server conflict reads as a plain sentence, other errors pass through', () => {
  assert.match(m.errText(new Error('CONFLICT|stale')), /changed this while it was open/);
  assert.equal(m.errText(new Error('Bad request: nope')), 'Bad request: nope');
});

test('a stable client id is generated for a new draft', () => {
  const id = m.newClientId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length >= 8);
  assert.notEqual(id, m.newClientId());
});
