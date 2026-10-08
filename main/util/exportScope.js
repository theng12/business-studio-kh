/**
 * Export profile image scope — which of each product's images a profile
 * exports. Stored on the profile (export_profiles.image_scope, JSON) so it
 * syncs between Macs. Shapes: { mode: 'all' } | { mode: 'main' } |
 * { mode: 'first', count: 1–50 }. Anything else reads as { mode: 'all' }.
 *
 * Pure (no DB) so the renderer-facing rules can be unit-tested with plain Node.
 */
const MAX_FIRST_COUNT = 50;

function normalizeProfileImageScope(scope) {
  let value = scope;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { mode: 'all' }; }
  }
  const mode = value && typeof value === 'object' ? value.mode : null;
  if (mode === 'main') return { mode: 'main' };
  if (mode === 'first') {
    const n = Math.round(Number(value.count));
    if (Number.isFinite(n) && n >= 1) return { mode: 'first', count: Math.min(MAX_FIRST_COUNT, n) };
  }
  return { mode: 'all' };
}

/** JSON text for the image_scope column. */
function serializeProfileImageScope(scope) {
  return JSON.stringify(normalizeProfileImageScope(scope));
}

module.exports = { MAX_FIRST_COUNT, normalizeProfileImageScope, serializeProfileImageScope };
