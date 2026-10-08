/**
 * One place for the process-wide sharp (libvips) cache limits.
 *
 * Perf audit 2026-10: main-process RSS drifted 227 → 652 MB over ten minutes
 * of real use. sharp's own operation cache defaults to 50 MB / 20 files /
 * 100 operations and nothing in the app set it. This module caps it lower —
 * the app's hot paths now keep their own small, purpose-built caches (the
 * thumbnail cache on disk, the overlay preview base cache in
 * main/templateRenderer.js), so libvips re-using whole operations buys little.
 * Measured on this Mac with 30 × 1600 px previews + repeated edits: the cap
 * left speed unchanged and the end RSS 30–60 MB lower (noisy; see the
 * 2026-10 studios audit report). Concurrency is left at sharp's default (one
 * thread per core): limiting it did not change preview time and would slow
 * large exports.
 *
 * Idempotent and side-effect only: require it from any module that uses sharp.
 */
let applied = false;
function applySharpLimits(sharp = require('sharp')) {
  if (applied) return;
  applied = true;
  try { sharp.cache({ memory: 32, files: 10, items: 50 }); } catch (_) { /* sharp missing in a stub — harmless */ }
}
applySharpLimits();
module.exports = { applySharpLimits };
