/**
 * v0.1.70: the pure value shape behind the shared "which images?" control.
 *
 * `ImageScopeField.jsx` renders the control; this module owns the value
 * builders and the free-text parser. It is deliberately plain ESM with no
 * React and no JSX so it can be unit-tested under plain `npm test` via a
 * dynamic import — v0.1.69 shipped the range parser with no test at all.
 *
 * The value shape is the contract shared with main/util/imageScope.js:
 *
 *     { scope: 'main' | 'all' | 'positions', positions: number[] }
 *
 * `positions` is only meaningful when scope === 'positions'; it is 1-based
 * with position 1 = the main image. main/util/imageScope.js is still the ONE
 * place the selection RULE lives; this file only builds its input.
 */

/** The default the existing behaviour must keep: main image only. */
export const IMAGE_SCOPE_DEFAULT = { scope: 'main', positions: [] };

/** Upper bound mirrors main/util/imageScope.js (the product image cap). */
export const MAX_IMAGE_POSITION = 50;

/** Always offer a few ticks so a "2nd photo" is pickable even when the
 *  loaded product rows have not reported an image count yet. */
export const MIN_TICK_COUNT = 5;

/**
 * Parse a free-text position list: "2, 4", "2 4", "2;4", "2-4".
 * Out-of-range / nonsense tokens are ignored; the result is deduped and
 * sorted, matching normalizePositions() on the main side.
 */
export function parsePositionsInput(text) {
  const out = new Set();
  for (const token of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
        if (i >= 1 && i <= MAX_IMAGE_POSITION) out.add(i);
      }
      continue;
    }
    const n = Number(token);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_POSITION) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Dedupe/sort/cap a position array. */
export function normalizePositionList(positions) {
  const out = new Set();
  for (const raw of Array.isArray(positions) ? positions : []) {
    if (Number.isInteger(raw) && raw >= 1 && raw <= MAX_IMAGE_POSITION) out.add(raw);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The ONE builder for the value shape, so the radio and the tick-boxes can
 * never disagree about what a mode means.
 */
export function buildImageScope(scope, positions) {
  if (scope === 'positions') {
    return { scope: 'positions', positions: normalizePositionList(positions) };
  }
  return { scope: scope === 'all' ? 'all' : 'main', positions: [] };
}

/** Does this value ask for more than one image per product? */
export function imageScopeIsMulti(value) {
  if (value?.scope === 'all') return true;
  return value?.scope === 'positions' && (value.positions?.length ?? 0) > 1;
}

/** True when the value is "Specific positions" with nothing ticked — the
 *  run must be held back rather than silently doing nothing. */
export function imageScopeNeedsPositions(value) {
  return value?.scope === 'positions' && (value.positions?.length ?? 0) === 0;
}

/**
 * Render a machine-readable `skippedReasons` map (the shape every bulk image
 * handler returns) as the shared one-line skip summary the toasts show:
 *
 *   { 'no 4th image': 2 }  →  "2 products skipped: no 4th image"
 *
 * Returns '' when nothing was skipped, so callers can append it blindly.
 */
export function summarizeSkippedReasons(reasons) {
  const entries = Object.entries(reasons || {}).filter(([, n]) => Number(n) > 0);
  if (entries.length === 0) return '';
  return entries
    .map(([reason, n]) => `${n} product${n === 1 ? '' : 's'} skipped: ${reason}`)
    .join('; ');
}

/**
 * One line for the post-run toast, shared by every bulk image operation so
 * the skip report and the product/image counts read the same everywhere.
 *
 *   formatBulkImageResult(res, { verb: 'Compressed', savedLabel: '1.2 MB saved' })
 *     → "Compressed 3 products (2 images each) · 6 images · 1.2 MB saved
 *        — 2 products skipped: no 4th image"
 *
 * `res` is the handler result (`products`, `images`, `failed`,
 * `skippedReasons`, `imagesByProduct`). `tone` follows the overlay modal's
 * convention: a clean run is success, anything skipped or failed is info,
 * and a run where every image failed is an error.
 */
export function formatBulkImageResult(res, { verb = 'Processed', savedLabel, extras = [] } = {}) {
  const prods = Number(res?.products ?? 0);
  const images = Number(res?.images ?? 0);
  const failed = Number(res?.failed ?? 0);
  const counts = Object.values(res?.imagesByProduct || {});
  const uniform = counts.length > 0 && counts.every((c) => c === counts[0]) ? counts[0] : 0;
  const each = uniform > 1 ? ` (${uniform} images each)` : '';
  const skip = summarizeSkippedReasons(res?.skippedReasons);

  const parts = [
    `${verb} ${prods} product${prods === 1 ? '' : 's'}${each}`,
    `${images} image${images === 1 ? '' : 's'}`,
  ];
  if (savedLabel) parts.push(savedLabel);
  for (const extra of extras) if (extra) parts.push(extra);
  let text = parts.join(' · ');
  if (failed > 0) text += ` · ${failed} failed`;
  if (skip) text += ` — ${skip}`;

  const tone = failed > 0 && images === 0
    ? 'error'
    : (failed > 0 || skip ? 'info' : 'success');
  return { text, tone };
}

