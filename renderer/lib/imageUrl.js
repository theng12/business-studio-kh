/**
 * v0.22.8: shared helper for building `app-image://local/<path>` URLs
 * with a cache-busting version stamp.
 *
 * Why this exists:
 *
 *   The renderer renders the SAME `app-image://local/<sku>/001.jpg`
 *   URL whenever a product image at that position is displayed. The
 *   browser caches by URL. But the bytes at that URL can CHANGE
 *   without the URL changing — main/db/productImages.renumberFiles
 *   rewrites filenames on disk after every remove/reorder/setMain so
 *   on-disk paths stay contiguous (001..NNN). Result: tile at position
 *   3 shows stale bytes (the previous image at position 3) even after
 *   you delete or reorder.
 *
 *   The classic symptom: user deletes image C from
 *   [A, B, C, D, E]; server reindexes to [A, B, D, E] by renaming the
 *   files on disk; browser cache still serves C's pixels at the path
 *   that now holds D's bytes; the LAST tile is the only one removed
 *   from the DOM → the user thinks they accidentally deleted E.
 *
 * Fix: append `?v=<stamp>` so the cache key changes when bytes do.
 *
 *   - For product images, the stamp is `image.contentHash` (SHA-1 of
 *     the bytes — guaranteed unique per content, never lies).
 *   - For product main-thumb in the Library list/grid, we don't have
 *     a hash on the product row, so we use `product.updatedAt`. v0.22.8
 *     also makes the image-mutating IPC handlers bump `updated_at` on
 *     the parent product so this signal stays in step with reality.
 *
 * The protocol handler at main/protocol.js strips the `?v=…` segment
 * before resolving on disk, so the file lookup still works identically.
 *
 * Thumbnail tier: `appImageSrc(path, version, { w: 96 })` adds `w=<n>` so
 * list / grid views get a small cached WebP instead of decoding the stored
 * original (up to 1600 px). The width snaps UP to one of THUMB_WIDTHS; any
 * other value is dropped and the original is served. The thumbnail cache key
 * includes `v` and the file's size / mtime / inode, so the cache-busting
 * contract above holds for thumbnails too (main/util/thumbCache.js).
 * Full-size viewers (Lightbox, editors) must keep calling it WITHOUT `w`.
 */

// Keep in step with THUMB_WIDTHS in main/util/thumbCache.js
// (test/thumbCache.test.js pins the two lists to each other).
export const THUMB_WIDTHS = [96, 320, 640];

export function snapThumbWidth(w) {
  const n = Number(w);
  if (!Number.isInteger(n) || n <= 0) return null;
  for (const tier of THUMB_WIDTHS) if (n <= tier) return tier;
  return null;
}

export function appImageSrc(filepath, version, opts) {
  if (!filepath) return null;
  const url = `app-image://local/${encodeURIComponent(filepath)}`;
  const params = [];
  if (version != null && version !== '') params.push(`v=${encodeURIComponent(String(version))}`);
  const w = opts && opts.w != null ? snapThumbWidth(opts.w) : null;
  if (w) params.push(`w=${w}`);
  return params.length ? `${url}?${params.join('&')}` : url;
}
