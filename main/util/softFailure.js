/**
 * v0.1.12: the single place a non-fatal failure gets recorded.
 *
 * Background. An audit found ~99 empty `catch` blocks in this codebase. Most are
 * legitimate — failing to delete a temp file, or to read an optional file size,
 * genuinely should not stop anything. But a few were on user-visible paths, and
 * those made real problems invisible: the export completed but the product's
 * status was never updated, a prompt's use-counter stopped incrementing, and in
 * each case nothing anywhere said so.
 *
 * The distinction that matters is not "did we swallow the error" but "would
 * anybody ever find out". `logSoftFailure` is for the second case: a failure we
 * deliberately continue past, but which someone should be able to discover.
 *
 * It writes to stderr, which matters because:
 *   - `main/index.js` mirrors stdout/stderr into `<userData>/crash.log`, so the
 *     line survives in the log users can send you — that is the whole point.
 *   - In `npm run dev` it appears in the terminal immediately.
 *   - It never throws. A logger that can throw is a liability inside a catch
 *     block, which is exactly where this is called from.
 *
 * Do NOT use this for genuinely expected, ignorable conditions — probing for an
 * optional file, releasing a pointer capture, writing to localStorage that the
 * user has disabled. Those should stay empty, with a short comment saying why,
 * so the next reader can tell "deliberate" from "forgotten".
 *
 * @param {string} scope  short tag identifying the site, e.g. 'images:merge'
 * @param {string} what   what was being attempted, e.g. 'recompute process status'
 * @param {unknown} err   the caught error
 */
function logSoftFailure(scope, what, err) {
  const detail = err && (err.message || String(err));
  try {
    process.stderr.write(`[soft-failure] ${scope}: ${what} failed — ${detail}\n`);
  } catch (_) {
    // Nothing useful left to do, and this must never rethrow: it is called from
    // inside catch blocks whose whole purpose is to keep going.
  }
}

module.exports = { logSoftFailure };
