/**
 * The size of the picture an overlay is composed onto — the editor's copy of
 * `outputCanvasSize` in main/templateRenderer.js. test/overlayPreview.test.js
 * runs both over the same inputs and fails if they ever disagree.
 *
 * Owner decision (2026-10-02): the output takes the TEMPLATE's shape. A photo
 * whose aspect differs from the template's design size is letterboxed into it
 * on white (`contain` — never cropped, never squashed), at the photo's own pixel
 * density: the canvas is the smallest template-shaped rectangle that holds the
 * photo at 1:1. With the bulk inset on, the canvas is the design size itself.
 * No design size (a legacy inline template) → the photo's own size.
 *
 * The editor needs this because font sizes, paddings and radii are in pixels
 * OF THAT CANVAS: a 96 px font on a 1600 px wide output is 6% of the width.
 * Drawing it against the design width instead is what made the editor's text a
 * different size from the export's.
 *
 * Pure and DOM-free.
 */

const LETTERBOX_TOLERANCE = 0.005;

export function outputCanvasSize(template, photoW, photoH) {
  const tW = Number(template?.canvasWidth);
  const tH = Number(template?.canvasHeight);
  if (template?.inset?.enabled) {
    return {
      width: Math.max(16, Math.round(tW || 2000)),
      height: Math.max(16, Math.round(tH || 2000)),
      mode: 'inset',
    };
  }
  const pW = Math.max(1, Math.round(Number(photoW) || 0));
  const pH = Math.max(1, Math.round(Number(photoH) || 0));
  if (!(tW > 0 && tH > 0)) return { width: pW, height: pH, mode: 'photo' };
  const want = tW / tH;
  const have = pW / pH;
  if (Math.abs(have / want - 1) <= LETTERBOX_TOLERANCE) return { width: pW, height: pH, mode: 'photo' };
  if (have > want) return { width: pW, height: Math.max(pH, Math.round(pW / want)), mode: 'letterbox' };
  return { width: Math.max(pW, Math.round(pH * want)), height: pH, mode: 'letterbox' };
}

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
