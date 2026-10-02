/**
 * Single source of truth for the slugify rule used across the main process:
 * imageManager (asset filenames), exportRunner (filename tokens),
 * processingPipeline (processed/<sku>/ folders), queueRunner (ai-gallery/<sku>/),
 * templateRenderer (overlay output filenames).
 *
 * Preserves the input's case — collapse non-[A-Za-z0-9] runs to '-', trim
 * leading/trailing '-', cap to 60 chars. Returns `fallback` (default '')
 * when the result would be empty — callers that don't want an empty string
 * (e.g. directory names) supply their own fallback ('unassigned',
 * 'unknown', 'asset', …).
 *
 * v0.11.6: case is now preserved. Earlier versions force-lowercased every
 * slug; user SKUs like `BF-R5232-GD` ended up as `products/bf-r5232-gd.jpg`
 * which made it harder to match files against the SKU when browsing in
 * Finder or in export filenames. Safe on macOS (case-insensitive FS — old
 * lowercase files are still found by case-insensitive existsSync). For
 * case-sensitive filesystems, the worst case is a stale lowercase
 * directory sitting next to a new mixed-case one; content-hash dedup
 * still prevents duplicate bytes from being written.
 */
function slugify(str, fallback = '') {
  const s = String(str ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/**
 * v0.1.89: the slug for names a PERSON reads — export filenames, Social Grid
 * series names. Same shape as `slugify` (case kept, runs of anything else
 * collapse to '-', trimmed, 60 characters) but letters, digits and combining
 * marks from EVERY script survive, so a Khmer product name stays Khmer
 * instead of collapsing to nothing. `slugify` above is deliberately left
 * ASCII-only: asset folders and processed/<sku>/ paths depend on it.
 *
 * NFC first, so a name typed with decomposed vowels and the same name typed
 * precomposed produce the same file name. The 60-character cap counts code
 * points (not UTF-16 units) and never splits a base letter from its marks.
 */
function slugifyUnicode(str, fallback = '') {
  const collapsed = String(str ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const chars = Array.from(collapsed);
  let end = Math.min(chars.length, 60);
  // Do not end on a base letter whose combining marks were cut off.
  while (end > 0 && end < chars.length && /\p{M}/u.test(chars[end])) end -= 1;
  const s = chars.slice(0, end).join('').replace(/-+$/g, '');
  return s || fallback;
}

module.exports = { slugify, slugifyUnicode };
