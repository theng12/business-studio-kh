/**
 * HR1: the kiosk Mac's local recovery code (main/util/kioskRecovery.js) — the
 * way out of kiosk mode when the office Mac is gone. Pure, plain `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../main/util/kioskRecovery');

test('codes: 12 characters in 3 groups, from an alphabet with no lookalikes', () => {
  for (const bad of ['0', 'O', '1', 'I', 'L', 'U', 'V', '5', 'S']) assert.ok(!R.ALPHABET.includes(bad), `${bad} is ambiguous`);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = R.generateCode();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok([...code.replace(/-/g, '')].every((c) => R.ALPHABET.includes(c)));
    assert.ok(R.isWellFormed(code));
    seen.add(code);
  }
  assert.equal(seen.size, 200, 'no repeats');
});

test('generation skips biased bytes (uniform over the alphabet)', () => {
  // A source that first hands out only bytes above the cut-off, then 0,1,2…
  let calls = 0;
  const bytes = () => { calls += 1; return calls === 1 ? Buffer.alloc(32, 255) : Buffer.from([...Array(32).keys()]); };
  const code = R.generateCode(bytes);
  assert.equal(code.replace(/-/g, ''), R.ALPHABET.slice(0, 12));
});

test('typing is forgiving: case, spaces and dashes do not matter', () => {
  assert.equal(R.normalizeCode(' k7qm-2xrt h9pd '), 'K7QM2XRTH9PD');
  assert.equal(R.formatCode('k7qm2xrth9pd'), 'K7QM-2XRT-H9PD');
  assert.equal(R.isWellFormed('K7QM2XRTH9P'), false);
  assert.equal(R.isWellFormed('K7QM-2XRT-H9P0'), false, '0 is not in the alphabet');
});

test('only a scrypt hash + salt are kept, and only the right code matches', async () => {
  const code = R.generateCode();
  const stored = await R.hashCode(code);
  assert.match(stored.hash, /^[0-9a-f]{64}$/);
  assert.match(stored.salt, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(stored).includes(code.replace(/-/g, '')));
  assert.equal(await R.verifyCode(code, stored), true);
  assert.equal(await R.verifyCode(code.toLowerCase().replace(/-/g, ' '), stored), true);
  assert.equal(await R.verifyCode(R.generateCode(), stored), false);
  assert.equal(await R.verifyCode('', stored), false);
  assert.equal(await R.verifyCode(code, {}), false);
  const again = await R.hashCode(code);
  assert.notEqual(again.salt, stored.salt, 'a fresh salt every time');
});

test('5 wrong codes lock for 15 min, then 30, 60 … at most 24 h; a right code clears everything', () => {
  let state = {};
  const now = 1_000_000;
  for (let i = 1; i <= 4; i++) {
    state = R.afterAttempt(state, { correct: false, now });
    assert.equal(state.locked, false);
    assert.equal(state.triesLeft, 5 - i);
  }
  state = R.afterAttempt(state, { correct: false, now });
  assert.equal(state.locked, true);
  assert.equal(state.lockMinutes, 15);
  assert.equal(state.lockedUntil, now + 15 * 60 * 1000);
  assert.equal(state.failures, 0, 'a fresh five tries after the lock');
  assert.equal(R.lockState(state, now + 60_000).locked, true);
  assert.equal(R.lockState(state, now + 15 * 60 * 1000).locked, false);
  for (let i = 0; i < 5; i++) state = R.afterAttempt(state, { correct: false, now: now + 20 * 60 * 1000 });
  assert.equal(state.lockMinutes, 30, 'the second lock doubles');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(R.lockMinutes), [15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
  const cleared = R.afterAttempt(state, { correct: true, now });
  assert.deepEqual([cleared.failures, cleared.lockedUntil, cleared.lockCount, cleared.locked], [0, 0, 0, false]);
});
