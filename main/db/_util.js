/**
 * Shared helpers for DB row-mappers. Hoisted out of per-table modules so
 * we don't keep redefining the same one-liner — and so a future fix lands
 * in one place.
 */

/**
 * Parse a value that was stored as a JSON string. Returns `fallback`
 * (and never throws) when the column is null/empty/malformed.
 */
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * v0.15.3: return the id of the user currently making this call, or
 * null when there isn't one (standalone Mac, or server admin using
 * the local renderer with no token in flight).
 *
 * Lazy-loaded via require() so this module stays usable during db
 * init, before main/server/index.js has run.
 */
function getCallerUserId() {
  try {
    const { getCurrentUserId } = require('../server');
    return getCurrentUserId?.() ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Apply the optional optimistic-concurrency token used by whole-draft editors.
 * Omission is an intentional overwrite/backward-compatible call. A present
 * token must be a finite number and match the row revision exactly.
 */
function prepareOptimisticPatch(current, patch, kind) {
  const next = { ...(patch || {}) };
  if (!Object.prototype.hasOwnProperty.call(next, 'expectedUpdatedAt')) return next;

  const expected = next.expectedUpdatedAt;
  delete next.expectedUpdatedAt;
  if (!Number.isFinite(expected)) throw new Error('expectedUpdatedAt must be a finite number');
  if (expected !== Number(current.updatedAt)) {
    throw new Error(`CONFLICT|${JSON.stringify({
      kind,
      id: current.id,
      name: current.name,
      updatedAt: current.updatedAt,
    })}`);
  }
  return next;
}

/** A wall-clock timestamp is not a revision unless equal milliseconds differ. */
function nextUpdatedAt(currentUpdatedAt) {
  const current = Number(currentUpdatedAt);
  return Math.max(Date.now(), Number.isFinite(current) ? current + 1 : 0);
}

module.exports = { parseJson, getCallerUserId, prepareOptimisticPatch, nextUpdatedAt };
