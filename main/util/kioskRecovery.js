/**
 * HR1: the kiosk Mac's local RECOVERY CODE — the way out of kiosk mode when the
 * office Mac (which checks manager PINs) is gone or unreachable.
 *
 * When kiosk mode is turned on, a random 12-character code is shown ONCE
 * (Settings → Multi-Mac → Attendance kiosk). Only a scrypt hash + salt are
 * kept, in this Mac's config.json (machine-local, not portable, refused by the
 * generic settings setters — main/config.js KIOSK_CONFIG_KEYS). The kiosk
 * screen offers it only while the office Mac cannot be reached, and main
 * re-checks that before accepting a code (main/kioskWindow.js).
 *
 * 5 wrong codes → a local cooldown of 15 min, doubling on each further lock
 * (30, 60 … at most 24 h); the counters live in config.json so a relaunch does
 * not reset them.
 *
 * Pure apart from crypto: no Electron, no DB — both boot paths (standalone and
 * client) use it. test/kioskRecovery.test.js.
 */

const crypto = require('node:crypto');

/** No 0/O, 1/I/L, U/V or 5/S lookalikes: read off paper and typed on a keyboard. */
const ALPHABET = 'ABCDEFGHJKMNPQRTWXYZ2346789';
const CODE_LENGTH = 12;
const GROUP = 4;
const MAX_TRIES = 5;
const FIRST_LOCK_MINUTES = 15;
const MAX_LOCK_MINUTES = 24 * 60;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;

/** A fresh code, e.g. "K7QM-2XRT-H9PD". Unbiased: bytes ≥ the largest multiple of the alphabet size are skipped. */
function generateCode(randomBytes = crypto.randomBytes) {
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    for (const b of randomBytes(32)) {
      if (b >= limit) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return formatCode(out.join(''));
}

/** What the person typed → the 12 characters that are compared (case, spaces and dashes ignored). */
function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[\s\-_.]/g, '');
}

function formatCode(raw) {
  const s = normalizeCode(raw);
  const parts = [];
  for (let i = 0; i < s.length; i += GROUP) parts.push(s.slice(i, i + GROUP));
  return parts.join('-');
}

function isWellFormed(input) {
  const s = normalizeCode(input);
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c));
}

function scrypt(code, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(normalizeCode(code), Buffer.from(salt, 'hex'), KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** { hash, salt } (hex) for config.json — never the code itself. */
async function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(code, salt);
  return { hash: key.toString('hex'), salt };
}

async function verifyCode(code, { hash, salt } = {}) {
  if (!hash || !salt || !isWellFormed(code)) return false;
  const key = await scrypt(code, salt);
  const want = Buffer.from(hash, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

/** Minutes of the n-th lock (1-based): 15, 30, 60 … capped at 24 h. */
function lockMinutes(lockCount) {
  const n = Math.max(1, Number(lockCount) || 1);
  return Math.min(MAX_LOCK_MINUTES, FIRST_LOCK_MINUTES * 2 ** (n - 1));
}

/** Is the code locked right now? */
function lockState({ lockedUntil = 0 } = {}, now = Date.now()) {
  const until = Number(lockedUntil) || 0;
  return until > now ? { locked: true, retryAt: until, retryInSeconds: Math.ceil((until - now) / 1000) } : { locked: false };
}

/**
 * The counters after one attempt. `state` = { failures, lockedUntil, lockCount }.
 * A right code clears everything; the 5th wrong one starts a lock and resets
 * the try counter.
 */
function afterAttempt(state = {}, { correct, now = Date.now() }) {
  const lockCount = Number(state.lockCount) || 0;
  if (correct) return { failures: 0, lockedUntil: 0, lockCount: 0, locked: false, triesLeft: MAX_TRIES };
  const failures = (Number(state.failures) || 0) + 1;
  if (failures >= MAX_TRIES) {
    const count = lockCount + 1;
    const minutes = lockMinutes(count);
    return { failures: 0, lockedUntil: now + minutes * 60 * 1000, lockCount: count, locked: true, lockMinutes: minutes, triesLeft: 0 };
  }
  return { failures, lockedUntil: Number(state.lockedUntil) || 0, lockCount, locked: false, triesLeft: MAX_TRIES - failures };
}

module.exports = {
  ALPHABET, CODE_LENGTH, MAX_TRIES, FIRST_LOCK_MINUTES, MAX_LOCK_MINUTES,
  generateCode, normalizeCode, formatCode, isWellFormed, hashCode, verifyCode, lockMinutes, lockState, afterAttempt,
};
