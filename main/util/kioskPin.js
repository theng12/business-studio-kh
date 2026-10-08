/**
 * HR1: kiosk PINs (docs/PEOPLE_AND_FUEL_PLAN.md §5.2).
 *
 *   - Stored as scrypt(pin, per-employee random salt) — never the PIN itself.
 *   - 4–8 digits; a PIN of one repeated digit or a straight run (1234, 9876)
 *     is refused because it is the first thing anyone tries.
 *   - pinMaxTries (5) wrong tries lock that person's PIN for pinLockMinutes
 *     (10), doubling with each lock the same day (10, 20, …); after
 *     pinLocksBeforeManager (3) locks in a day only a manager can unlock it.
 *     A correct PIN resets the try count (not the day's lock count).
 *   - Across ALL staff, one kiosk account gets kioskWrongPinLimit (10) wrong
 *     PINs per kioskWrongPinWindowMinutes (10); then that kiosk pauses PIN
 *     entry for kioskCooldownMinutes (5) — someone walking the tiles guessing
 *     is stopped even though no single PIN locks.
 *   - Hashing is async (crypto.scrypt runs on the libuv pool), so a PIN check
 *     never blocks the server's main thread.
 *
 * `afterAttempt`, `lockState` and `kioskFailure` are pure (unit-tested).
 */

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function pinProblem(pin) {
  const s = String(pin ?? '');
  if (!/^\d{4,8}$/.test(s)) return 'The PIN must be 4 to 8 digits';
  if (/^(\d)\1+$/.test(s)) return 'Pick a PIN that is not one digit repeated';
  const up = '0123456789';
  const down = '9876543210';
  if (up.includes(s) || down.includes(s)) return 'Pick a PIN that is not a straight run like 1234';
  return null;
}

function scryptAsync(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPin(pin, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = await scryptAsync(pin, salt);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

async function verifyPin(pin, hashHex, saltHex) {
  if (!hashHex || !saltHex || !/^\d{1,12}$/.test(String(pin ?? ''))) return false;
  const { hash } = await hashPin(pin, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Is the PIN locked right now? A manager-only lock never runs out. */
function lockState({ lockedUntil = null, managerOnly = false, now }) {
  if (managerOnly) return { locked: true, managerOnly: true, retryAt: null, retryInSeconds: null };
  const locked = Number.isFinite(lockedUntil) && lockedUntil > now;
  return { locked, managerOnly: false, retryAt: locked ? lockedUntil : null, retryInSeconds: locked ? Math.ceil((lockedUntil - now) / 1000) : 0 };
}

/**
 * The counters after one attempt.
 *   today / lockDay / locksToday: the day's lock count (escalation).
 * Returns { failedCount, lockedUntil, locked, managerOnly, locksToday, lockDay, triesLeft, lockMinutes }.
 */
function afterAttempt({ correct, failedCount = 0, now, maxTries = 5, lockMinutes = 10, today = null, lockDay = null, locksToday = 0, locksBeforeManager = 3 }) {
  const dayLocks = lockDay && lockDay === today ? Number(locksToday) || 0 : 0;
  if (correct) return { failedCount: 0, lockedUntil: null, locked: false, managerOnly: false, locksToday: dayLocks, lockDay: today, triesLeft: maxTries };
  const n = (Number(failedCount) || 0) + 1;
  if (n < maxTries) return { failedCount: n, lockedUntil: null, locked: false, managerOnly: false, locksToday: dayLocks, lockDay: today, triesLeft: maxTries - n };
  const locks = dayLocks + 1;
  if (locks >= locksBeforeManager) {
    return { failedCount: 0, lockedUntil: null, locked: true, managerOnly: true, locksToday: locks, lockDay: today, triesLeft: 0, lockMinutes: null };
  }
  const minutes = lockMinutes * 2 ** (locks - 1);
  return { failedCount: 0, lockedUntil: now + minutes * 60 * 1000, locked: true, managerOnly: false, locksToday: locks, lockDay: today, triesLeft: 0, lockMinutes: minutes };
}

/**
 * One kiosk account's wrong PINs across all staff. `state` = { failures: [ms], cooldownUntil }.
 * Returns the new state and whether this failure started a cooldown.
 */
function kioskFailure(state, { now, limit = 10, windowMinutes = 10, cooldownMinutes = 5 }) {
  const windowMs = windowMinutes * 60 * 1000;
  const failures = [...((state && state.failures) || []).filter((t) => now - t < windowMs), now];
  if (failures.length >= limit) {
    return { state: { failures: [], cooldownUntil: now + cooldownMinutes * 60 * 1000 }, cooldownStarted: true };
  }
  return { state: { failures, cooldownUntil: state?.cooldownUntil ?? null }, cooldownStarted: false };
}

function kioskCooldown(state, now) {
  const until = state?.cooldownUntil;
  return Number.isFinite(until) && until > now ? { cooling: true, retryInSeconds: Math.ceil((until - now) / 1000) } : { cooling: false, retryInSeconds: 0 };
}

module.exports = { pinProblem, hashPin, verifyPin, lockState, afterAttempt, kioskFailure, kioskCooldown, SCRYPT };
