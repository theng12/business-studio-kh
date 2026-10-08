/**
 * HR1: kiosk PINs (docs/PEOPLE_AND_FUEL_PLAN.md §5.2).
 *
 *   - Stored as scrypt(pin, per-employee random salt) — never the PIN itself.
 *   - 4–8 digits; a PIN of one repeated digit or a straight run (1234, 9876)
 *     is refused because it is the first thing anyone tries.
 *   - pinMaxTries (5) wrong tries lock that person's PIN for pinLockMinutes
 *     (10); a correct PIN resets the count. The lock is per employee, so one
 *     person mistyping does not lock the kiosk for everyone.
 *
 * `afterAttempt` and `lockState` are pure (unit-tested); hashing uses Node's
 * crypto.
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

function hashPin(pin, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

function verifyPin(pin, hashHex, saltHex) {
  if (!hashHex || !saltHex || !/^\d{1,12}$/.test(String(pin ?? ''))) return false;
  const { hash } = hashPin(pin, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Is the PIN locked right now? */
function lockState({ lockedUntil = null, now }) {
  const locked = Number.isFinite(lockedUntil) && lockedUntil > now;
  return { locked, retryAt: locked ? lockedUntil : null, retryInSeconds: locked ? Math.ceil((lockedUntil - now) / 1000) : 0 };
}

/**
 * The counters after one attempt.
 * Returns { failedCount, lockedUntil, locked, triesLeft }.
 */
function afterAttempt({ correct, failedCount = 0, now, maxTries = 5, lockMinutes = 10 }) {
  if (correct) return { failedCount: 0, lockedUntil: null, locked: false, triesLeft: maxTries };
  const n = (Number(failedCount) || 0) + 1;
  if (n >= maxTries) return { failedCount: 0, lockedUntil: now + lockMinutes * 60 * 1000, locked: true, triesLeft: 0 };
  return { failedCount: n, lockedUntil: null, locked: false, triesLeft: maxTries - n };
}

module.exports = { pinProblem, hashPin, verifyPin, lockState, afterAttempt, SCRYPT };
