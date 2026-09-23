/**
 * v0.1.72: directional hover intent for the Bulk actions menu.
 *
 * The two-level menu opens a section's submenu while the pointer rests on its
 * trigger. The previous rule used a fixed delay for every hover, so a pointer
 * travelling from an open trigger diagonally toward its submenu would cross a
 * neighbouring trigger and have the submenu swapped underneath it mid-flight.
 *
 * `pointsTowardRect` is the pure geometric test that fixes that: given the
 * previous and next pointer samples and the open submenu's rect, it answers
 * "was the pointer heading at that rectangle?". The caller keeps the open
 * submenu when the answer is yes and falls back to a short delay otherwise.
 *
 * Deliberately plain ESM with no React, no JSX and no DOM so it is
 * unit-testable under plain `npm test` via a dynamic import (the same shape
 * as imageScopeValue.mjs). Inputs are plain numbers:
 *
 *   prevPoint / nextPoint: { x, y } in viewport (client) coordinates
 *   rect: { left, top, right, bottom } — a DOMRect, or any same-shape object
 *
 * The test is a segment-vs-axis-aligned-rectangle intersection (the slab
 * method). It answers "does the ray that starts at prevPoint and runs in the
 * movement direction hit the rect at or ahead of prevPoint?". Zero-length
 * movement means "no clear direction" and returns false, which is exactly
 * what routes the caller to the fallback delay. Starting inside the rect also
 * returns false: at that point the pointer is leaving the submenu, not
 * heading at it, so a different trigger may safely take over.
 */

/** Is a point inside (or on the edge of) the rect? */
function insideRect(point, rect) {
  return (
    point.x >= rect.left && point.x <= rect.right
    && point.y >= rect.top && point.y <= rect.bottom
  );
}

/**
 * Does a ray from `origin` in direction `dir` hit the rect at t >= 0?
 * Standard slab method; `dir` need not be normalised.
 */
function rayHitsRect(origin, dir, rect) {
  let tMin = -Infinity;
  let tMax = Infinity;
  const slabs = [
    [origin.x, dir.x, rect.left, rect.right],
    [origin.y, dir.y, rect.top, rect.bottom],
  ];
  for (const [o, d, lo, hi] of slabs) {
    if (d === 0) {
      // Parallel to this pair of edges: it can only hit if it is between them.
      if (o < lo || o > hi) return false;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  return tMax >= 0;
}

/**
 * Was the pointer movement `prevPoint → nextPoint` heading at `rect`?
 *
 * True when the movement segment hits the rect (or finishes inside it); false
 * for a stationary pointer, an invalid sample, or movement that points away.
 */
export function pointsTowardRect(prevPoint, nextPoint, rect) {
  if (!prevPoint || !nextPoint || !rect) return false;
  const numbers = [prevPoint.x, prevPoint.y, nextPoint.x, nextPoint.y, rect.left, rect.top, rect.right, rect.bottom];
  if (!numbers.every((n) => Number.isFinite(n))) return false;
  if (rect.left > rect.right || rect.top > rect.bottom) return false;
  if (insideRect(prevPoint, rect)) return false;
  if (insideRect(nextPoint, rect)) return true;
  const dir = { x: nextPoint.x - prevPoint.x, y: nextPoint.y - prevPoint.y };
  if (dir.x === 0 && dir.y === 0) return false;
  return rayHitsRect(prevPoint, dir, rect);
}
