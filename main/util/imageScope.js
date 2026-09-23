/**
 * v0.1.69: the ONE place that decides which of a product's images an image
 * operation acts on, and why a product is skipped when none match.
 *
 * The bulk overlay apply ("Apply overlay") is the first caller. The rest of
 * the Image operations menu (Remove background, Auto crop, Enhance, Convert
 * format, Compress, Resize) will call the same `selectImages` so the
 * "main / all / specific positions" rule and its skip wording cannot drift
 * between operations. Keep this module free of Electron, sharp and the DB:
 * it takes a plain image-row array and returns plain rows. Callers own any
 * filesystem checks on the chosen rows.
 *
 * Contract — positions are 1-based and position 1 is the main image, i.e.
 * index 0 of productImages.listByProduct (ordered by order_index).
 *
 *   scope: 'main'  → the main image (processed variant preferred), as before.
 *   scope: 'all'   → every image row.
 *   positions      → an explicit 1-based list; when non-empty it wins over
 *                    `scope`. Every requested position the product has is
 *                    chosen; a requested position it lacks is simply not
 *                    chosen. A product is skipped, not failed, only when
 *                    NONE of the requested positions exist, and the reason
 *                    names the smallest missing position ("no 4th image").
 *
 * Pure JS on purpose: no DB, no sharp, no Electron — so the contract is
 * testable under plain `npm test` (see test/imageScope.test.js).
 */

/** Products cap at 50 images (MAX_IMAGES_PER_PRODUCT); a position beyond
 *  that can never name a real image, so reject it rather than carry it. */
const MAX_IMAGE_POSITION = 50;

/** "1st", "2nd", "3rd", "4th" … used in the skip messages the user reads. */
function ordinal(n) {
  const n100 = n % 100;
  if (n100 >= 11 && n100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Dedupe, sort and cap a raw positions input.
 * Always returns an array ([] for null/undefined/non-array), so callers can
 * treat "no positions" and "bad positions" the same way — the validator is
 * what rejects nonsense on the wire; this is the defensive layer behind it.
 */
function normalizePositions(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  for (const raw of input) {
    // Strict: only real integers. A numeric string ("2") is rejected here
    // exactly as the wire validator rejects it, so there is one rule.
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_IMAGE_POSITION) continue;
    seen.add(raw);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Resolve the chosen scope against one product's ordered image rows.
 *
 *   images    — productImages.listByProduct(productId) (index 0 = main)
 *   { scope, positions }
 *
 * Returns `{ chosen, skippedReason, positions, missing }`:
 *   chosen        — the image rows the operation should act on
 *   skippedReason — null when chosen is non-empty; otherwise "no Nth image"
 *                   (a requested position is out of range) or "no images"
 *   positions     — the normalized position list that was tried
 *   missing       — requested positions this product does not have
 */
function selectImages(images, { scope = 'main', positions } = {}) {
  const list = Array.isArray(images) ? images : [];
  const wanted = normalizePositions(positions);

  if (wanted.length > 0) {
    const chosen = [];
    const missing = [];
    for (const position of wanted) {
      const image = list[position - 1];
      if (image) chosen.push(image);
      else missing.push(position);
    }
    if (chosen.length === 0) {
      return {
        chosen: [],
        skippedReason: missing.length > 0 ? `no ${ordinal(missing[0])} image` : 'no images',
        positions: wanted,
        missing,
      };
    }
    return { chosen, skippedReason: null, positions: wanted, missing };
  }

  if (scope === 'all') {
    return {
      chosen: [...list],
      skippedReason: list.length > 0 ? null : 'no images',
      positions: [],
      missing: [],
    };
  }

  // 'main' (default) — processed variant preferred, exactly as before.
  const main = list.find((im) => im.isProcessed && im.processedFilepath) || list[0];
  return {
    chosen: main ? [main] : [],
    skippedReason: main ? null : 'no images',
    positions: [],
    missing: [],
  };
}

module.exports = {
  MAX_IMAGE_POSITION,
  ordinal,
  normalizePositions,
  selectImages,
};
