/**
 * 0.1.94: Auto-match images — preview first, then import.
 *
 * The owner's decision: auto-match shows what it WOULD do (which products get
 * which photos, what did not match, what is over the 50-photo cap) before
 * anything is written, and new photos join the END of a product's photos —
 * they become the main image only when "Make the first matched photo the main
 * image" is ticked.
 *
 * Shared by both handlers of `images:autoMatchBySku` — main/ipc/images.js
 * (standalone / server) and main/client/index.js (client mode, where the
 * folder is on this Mac and the products are on the server) — so the two can
 * never plan differently. Pure apart from `path`.
 */

const path = require('node:path');

function relativeTo(folderPath, abs) {
  try {
    const rel = path.relative(folderPath, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  } catch (_) {
    return abs;
  }
}

function lexicallyInside(root, target) {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when `filePath` is a file somewhere inside `folderPath`.
 *
 * Lexical AND real: the path must sit under the folder as written, and once
 * symlinks are resolved (fs.realpathSync on both sides) it must still be
 * under the folder's real location — a symlink inside the picked folder that
 * points at ~/Library or another drive is refused. A path that does not exist
 * (or cannot be resolved) is refused; there would be nothing to import.
 */
function isInsideFolder(folderPath, filePath, fs = require('node:fs')) {
  if (typeof folderPath !== 'string' || typeof filePath !== 'string' || !folderPath || !filePath) return false;
  if (!lexicallyInside(path.resolve(folderPath), path.resolve(filePath))) return false;
  try {
    return lexicallyInside(fs.realpathSync(folderPath), fs.realpathSync(filePath));
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} args
 * @param {Map<string, Array<{sourcePath:string}>>} args.groups  lower-cased SKU → sorted candidates
 * @param {Map<string, object>} args.skuToProduct                lower-cased SKU → product row
 * @param {(product:object) => number} args.imageCountOf         photos the product has now
 * @param {number} args.max                                      the per-product cap
 * @param {string} args.folderPath
 * @returns {{ products: Array, files: number, capSkipped: number }}
 */
function buildAutoMatchPlan({ groups, skuToProduct, imageCountOf, max, folderPath }) {
  const products = [];
  let files = 0;
  let capSkipped = 0;
  for (const [sku, candidates] of groups) {
    const product = skuToProduct.get(sku);
    if (!product) continue;
    const existingCount = Math.max(0, Number(imageCountOf(product)) || 0);
    const room = Math.max(0, max - existingCount);
    const take = candidates.slice(0, room);
    const over = candidates.slice(room);
    products.push({
      productId: product.id,
      sku: product.sku,
      name: product.name ?? null,
      existingCount,
      files: take.map((c) => ({ sourcePath: c.sourcePath, rel: relativeTo(folderPath, c.sourcePath) })),
      capSkipped: over.map((c) => relativeTo(folderPath, c.sourcePath)),
    });
    files += take.length;
    capSkipped += over.length;
  }
  products.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' }));
  return { products, files, capSkipped };
}

/** Unmatched files as sorted relative paths (first `cap`), with an extension tally. */
function summarizeUnmatched(unmatched, folderPath, cap = 500) {
  const relative = unmatched
    .map((abs) => relativeTo(folderPath, abs))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const extCounts = {};
  for (const rel of relative) {
    const ext = (path.extname(rel) || '(no ext)').toLowerCase();
    extCounts[ext] = (extCounts[ext] ?? 0) + 1;
  }
  return {
    unmatchedFiles: unmatched.length,
    unmatchedSamples: relative.slice(0, cap),
    unmatchedSamplesCapped: relative.length > cap,
    unmatchedExtCounts: extCounts,
  };
}

/** Check one entry of an import batch. Returns an error string, or null when fine. */
function importEntryProblem(folderPath, entry) {
  if (!entry || typeof entry !== 'object') return 'Not a file entry';
  if (typeof entry.productId !== 'string' || !entry.productId) return 'No product';
  if (typeof entry.sourcePath !== 'string' || !isInsideFolder(folderPath, entry.sourcePath)) {
    return 'That file is not inside the chosen folder';
  }
  return null;
}

module.exports = {
  buildAutoMatchPlan,
  summarizeUnmatched,
  isInsideFolder,
  importEntryProblem,
  relativeTo,
};
