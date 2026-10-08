/**
 * Fixed Assets A0: tag codes (docs/ASSETS_AND_BRANCHES_PLAN.md §6.1). Pure.
 *
 *   <PREFIX>-<seq, at least 4 digits><Damm check digit>     e.g. CK-04270
 *
 * The Damm algorithm catches every single mistyped digit and every swap of
 * two adjacent digits, which is what goes wrong when a code is typed off a
 * scratched sticker. Upper-case letters, digits and '-' are all in the QR
 * alphanumeric set, so the code fits a version-1 QR at error level Q.
 *
 * Accepted spellings when reading a code back: `CK-04270`, `ck04270`,
 * ` ck-0427-0 `, and — with a default prefix (inside a branch count) — the
 * bare digits `04270` / `4270`.
 *
 * (The plan's illustrative `CK-04273` does not carry a valid check digit; the
 * real code for sequence 427 is `CK-04270`.)
 */

/** The standard Damm quasigroup table (order 10, weakly totally anti-symmetric). */
const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

const MIN_SEQ_DIGITS = 4;
const PREFIX_RE = /^[A-Z]{2,4}$/;

/** The Damm check digit (0–9) of a string of decimal digits. */
function dammDigit(digits) {
  const s = String(digits);
  if (!/^\d+$/.test(s)) throw new Error('Damm check digit needs decimal digits');
  let interim = 0;
  for (const ch of s) interim = DAMM[interim][ch.charCodeAt(0) - 48];
  return interim;
}

/** True when the last digit of `digitsWithCheck` is the Damm digit of the rest. */
function dammValid(digitsWithCheck) {
  const s = String(digitsWithCheck);
  if (!/^\d{2,}$/.test(s)) return false;
  let interim = 0;
  for (const ch of s) interim = DAMM[interim][ch.charCodeAt(0) - 48];
  return interim === 0;
}

function normalizePrefix(prefix) {
  const p = String(prefix ?? '').trim().toUpperCase();
  if (!PREFIX_RE.test(p)) throw new Error('A tag prefix is 2 to 4 letters, like CK');
  return p;
}

/** `formatTagCode('CK', 427)` → `'CK-04270'`. */
function formatTagCode(prefix, seq) {
  const p = normalizePrefix(prefix);
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1 || n > 99_999_999) throw new Error('A tag number is a whole number from 1');
  const body = String(n).padStart(MIN_SEQ_DIGITS, '0');
  return `${p}-${body}${dammDigit(body)}`;
}

/**
 * Read a code as typed or scanned. Returns
 *   { ok: true,  code, prefix, seq }                       — a valid code
 *   { ok: false, reason: 'format' | 'check' | 'prefix' }   — anything else
 * `defaultPrefix` lets a bare number stand for a code with that prefix.
 * Never throws.
 */
function parseTagCode(input, { defaultPrefix = null } = {}) {
  const raw = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
  const m = /^([A-Z]{2,4})?(\d{2,9})$/.exec(raw);
  if (!m) return { ok: false, reason: 'format' };
  let prefix = m[1] || null;
  if (!prefix) {
    if (!defaultPrefix) return { ok: false, reason: 'prefix' };
    try { prefix = normalizePrefix(defaultPrefix); } catch (_) { return { ok: false, reason: 'prefix' }; }
  }
  const digits = m[2];
  if (!dammValid(digits)) return { ok: false, reason: 'check' };
  const seq = Number(digits.slice(0, -1));
  if (seq < 1) return { ok: false, reason: 'format' };
  const code = formatTagCode(prefix, seq);
  return { ok: true, code, prefix, seq };
}

/**
 * A 2–4 letter prefix from a company name: the initials of up to four words
 * (`Chea Kim Trading` → `CKT`), or the first letters of a single word
 * (`Terranash` → `TE`). Non-Latin names fall back to `AS`.
 */
function defaultTagPrefix(companyName) {
  const words = String(companyName ?? '')
    .normalize('NFKD').replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  if (!words.length) return 'AS';
  if (words.length === 1) {
    const w = words[0].toUpperCase();
    return w.length >= 2 ? w.slice(0, 2) : `${w}X`;
  }
  return words.slice(0, 4).map((w) => w[0].toUpperCase()).join('');
}

module.exports = { DAMM, MIN_SEQ_DIGITS, dammDigit, dammValid, normalizePrefix, formatTagCode, parseTagCode, defaultTagPrefix };
