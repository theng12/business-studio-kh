/**
 * Small pure helpers for the Overlay Studio editor's server preview
 * (EditorCanvas). DOM-free so test/overlayPreview.test.js can run them.
 */

/**
 * Longest side to ask the server preview for: the canvas as it is actually
 * shown, in device pixels, so a Retina screen gets a sharp picture — capped at
 * 1600 (beyond that compose time grows for nothing visible) and floored at 256.
 * Rounded UP to a 64 px step so a window resize of a few pixels does not
 * trigger a new render.
 */
export function previewMaxPx(canvasW, canvasH, dpr = 1) {
  const longest = Math.max(Number(canvasW) || 0, Number(canvasH) || 0) * (Number(dpr) > 0 ? Number(dpr) : 1);
  const stepped = Math.ceil(longest / 64) * 64;
  return Math.max(256, Math.min(1600, stepped));
}

/**
 * Sequence guard for overlapping preview requests. `next()` stamps a request;
 * `isLatest(stamp)` says whether its reply may still be shown. Bumping with
 * `invalidate()` (product or template switched) drops every reply in flight.
 * Without it an older, slower render could land after a newer one and put the
 * stale picture back — or clear "Updating…" while the latest is still out.
 */
export function createLatestGuard() {
  let seq = 0;
  return {
    next() { seq += 1; return seq; },
    isLatest(stamp) { return stamp === seq; },
    invalidate() { seq += 1; },
  };
}
