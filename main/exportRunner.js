const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
require('./util/sharpLimits');   // process-wide libvips cache cap (perf audit 2026-10)
const { exportSubfolder, containedMediaPath } = require('./util/mediaPaths');
const { getDataDir } = require('./db');
const products = require('./db/products');
const productImages = require('./db/productImages');
const brands = require('./db/brands');
const { slugifyUnicode } = require('./util/slug');
const { formatIndexToken } = require('./util/exportIndex');
const { logSoftFailure } = require('./util/softFailure');
const { selectImages, MAX_IMAGE_POSITION } = require('./util/imageScope');
const { writeExclusiveFile } = require('./util/exclusiveFile');

/* ── Image scope ──────────────────────────────────────────────── */

/**
 * Which of a product's images an export writes. `{ mode: 'all' }` (the
 * default, and what every run did before this option existed), `{ mode:
 * 'main' }` (position 1 only) or `{ mode: 'first', count: N }` (positions
 * 1…N). Anything unrecognised falls back to 'all', so an older caller that
 * sends nothing keeps today's behaviour.
 */
function normalizeExportScope(scope) {
  const mode = scope && typeof scope === 'object' ? scope.mode : null;
  if (mode === 'main') return { mode: 'main', count: 1 };
  if (mode === 'first') {
    const n = Math.round(Number(scope.count));
    if (Number.isFinite(n) && n >= 1) return { mode: 'first', count: Math.min(MAX_IMAGE_POSITION, n) };
  }
  return { mode: 'all', count: null };
}

/**
 * The scoped image rows with their ORIGINAL index, so {INDEX} in a file name
 * still names the image's position in the product (image 1 stays `-001`).
 * The positions rule is the shared one in util/imageScope.js.
 */
function scopedImages(images, scope) {
  const list = Array.isArray(images) ? images : [];
  const s = normalizeExportScope(scope);
  if (s.mode === 'all') return list.map((img, i) => ({ img, i }));
  const positions = Array.from({ length: s.count }, (_, k) => k + 1);
  const { chosen } = selectImages(list, { positions });
  return chosen.map((img) => ({ img, i: list.indexOf(img) }));
}

/* ── Library copies made by "Also save to product library" ─────── */

/* A copy an export added back to the product is marked on its row
 * (original_filepath `export:<profileId>`, the same idea as the overlay's
 * `overlay:<templateId>`). Before this marker existed the only trace was
 * dedup_exempt, which nothing but this runner ever sets — so a legacy row
 * with that flag is an export copy too, of an unknown profile. */
const EXPORT_COPY_PREFIX = 'export:';
function exportCopyMarker(profile) {
  return `${EXPORT_COPY_PREFIX}${profile?.id || 'unsaved'}`;
}
function isExportCopy(img) {
  if (!img) return false;
  if (typeof img.originalFilepath === 'string' && img.originalFilepath.startsWith(EXPORT_COPY_PREFIX)) return true;
  return !!img.dedupExempt;
}

/**
 * The images an export reads from. An export copy is never re-exported:
 * exporting it again re-encoded the main photo once per run, generation after
 * generation (audit 2026-10). The originals are used instead, so image 1 is
 * the product's first real photo. A product whose only photos are export
 * copies still exports them rather than exporting nothing.
 */
function exportSources(images) {
  const list = Array.isArray(images) ? images : [];
  const originals = list.filter((img) => !isExportCopy(img));
  return originals.length > 0 ? originals : list;
}

/** The scope a run uses: the caller's, else the profile's stored one. */
function effectiveScope(imageScope, profile) {
  return normalizeExportScope(imageScope ?? profile?.imageScope ?? null);
}

/* ── Filename token builder ───────────────────────────────────── */

// Export-filename tokens want empty-string when the source value is missing
// so the surrounding separator collapses naturally — keep that semantics
// by passing fallback '' (the default) through.
//
// v0.1.89: Unicode-aware. The ASCII-only `slugify` turned a Khmer {NAME} or
// {BRAND} into an empty string, so `{NAME}-{INDEX}` became `001.jpg` for
// every product in the run. Asset folders keep the ASCII rule; only the
// names a person reads use this one.
function slugifyFilename(value) {
  return slugifyUnicode(value, '');
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolveToken(token, ctx) {
  switch (token) {
    case 'SKU':    return slugifyFilename(ctx.product.sku);
    case 'NAME':   return slugifyFilename(ctx.product.name ?? '');
    case 'COLOR':  return slugifyFilename(ctx.product.colorFinish ?? '');
    case 'BRAND':  return slugifyFilename(ctx.brand?.name ?? '');
    // v0.49.42: per-profile {INDEX} formatting — pad width (1–4) + an
    // optional fixed prefix (A001, B1, 0001, …). Falls back to a 3-digit
    // plain number when the profile predates these fields. ctx.profile is
    // threaded in by buildFilename's callers; default to {} defensively.
    case 'INDEX':  return formatIndexToken(ctx.imageIndex, ctx.profile ?? {});
    case 'DATE':   return ctx.dateStr;
    default:       return '';
  }
}

/**
 * Build a filename from a pattern like "{SKU}-{INDEX}".
 * Empty tokens are dropped from the join so a missing field doesn't leave
 * a dangling separator. Returns the base name (no extension).
 */
function buildFilename(pattern, ctx) {
  // Tokens are everything inside curly braces; everything else is treated as
  // a literal separator hint. We split on tokens, resolve each, drop empties,
  // then join with the dominant separator found in the pattern.
  const tokenRe = /\{([A-Z]+)\}/g;
  const parts = [];
  let match;
  let lastIndex = 0;
  while ((match = tokenRe.exec(pattern)) !== null) {
    if (match.index > lastIndex) {
      // Skip literal chunks for join purposes — they're separators.
    }
    const resolved = resolveToken(match[1], ctx);
    if (resolved) parts.push(resolved);
    lastIndex = match.index + match[0].length;
  }
  // Dominant separator: count - vs _ in the pattern.
  const dashes = (pattern.match(/-/g) || []).length;
  const unders = (pattern.match(/_/g) || []).length;
  const sep = unders > dashes ? '_' : dashes > 0 ? '-' : '';
  let name = parts.join(sep);
  if (!name) name = slugifyFilename(ctx.product.sku);
  return name;
}

/** Key for the in-run "already written" set. The Mac's disk is
 *  case-insensitive, so `A.jpg` and `a.jpg` are the same file. */
function claimKey(absPath) {
  return path.resolve(absPath).normalize('NFC').toLowerCase();
}

function uniqueOutputPath(dir, base, ext, claimed = null, exists = fs.existsSync) {
  const taken = (p) => exists(p) || (claimed ? claimed.has(claimKey(p)) : false);
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (taken(candidate)) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

/**
 * v0.26.24: collision-aware output path resolver. Returns
 *   { outPath, action }
 * where action is one of:
 *   'write'    — file didn't exist; just write it fresh
 *   'replace'  — file existed AND mode === 'replace'; overwrite
 *   'skip'     — file existed AND mode === 'skip'; do not touch
 *   'keepBoth' — file existed AND mode === 'keepBoth'; outPath has a
 *                `-2`, `-3` … suffix to dodge the collision
 *
 * Callers branch on `action`:
 *   - 'write' / 'replace' / 'keepBoth' → run the sharp pipeline at outPath
 *   - 'skip'                            → bump a skip counter, don't touch
 *
 * Default mode 'keepBoth' preserves the pre-v0.26.24 behaviour so the
 * exporter is backward-compatible if a caller forgets to specify.
 */
/*
 * v0.1.89: `claimed` is the set of paths THIS run has already written
 * (see claimKey). The collision policy is about files that were in the folder
 * before the run started; a name this run produced twice — a pattern with no
 * {INDEX}, or two products whose names slug the same — is never a "replace"
 * or a "skip". Before this, image 2 overwrote image 1 under Replace, and was
 * dropped under Skip. A repeat inside the run is always kept, with a suffix,
 * and reported as `inRun: true`.
 */
function resolveOutputPath(dir, base, ext, mode = 'keepBoth', claimed = null, exists = fs.existsSync) {
  const direct = path.join(dir, `${base}${ext}`);
  if (claimed && claimed.has(claimKey(direct))) {
    return { outPath: uniqueOutputPath(dir, base, ext, claimed, exists), action: 'keepBoth', inRun: true };
  }
  if (!exists(direct)) return { outPath: direct, action: 'write' };
  if (mode === 'replace') return { outPath: direct, action: 'replace' };
  if (mode === 'skip')    return { outPath: direct, action: 'skip' };
  // keepBoth: suffix until free
  return { outPath: uniqueOutputPath(dir, base, ext, claimed, exists), action: 'keepBoth' };
}

/**
 * v0.26.24: dry-run pass — walks the same product / image / filename
 * pipeline as runExport but DOESN'T touch disk. Used by the renderer
 * to detect collisions BEFORE prompting the user with the "Folder
 * already contains N matching files — replace / skip / keep both?"
 * modal.
 *
 * Returns `{ totalExpected, collisions: [{ name, sku }, …] }`
 * where `collisions` is capped at 10 entries (just enough for the
 * modal's "e.g. …" hint). `totalExpected` is the count of files the
 * export would TRY to write — not the count that would succeed,
 * since sharp errors / source-missing rows still skip.
 */
/**
 * v0.26.50: pure "what filenames would this export produce" computation,
 * with NO filesystem access. Split out of previewCollisions so client
 * mode can fetch the expected names from the server (which has the DB)
 * and then run the existence check against the CLIENT's own disk.
 *
 * Returns relative paths (subfolder/filename) so the caller can join
 * them onto whichever outputRoot is correct for their machine — the
 * server's, or the client's. This is the key to fixing the client-mode
 * collision check: filenames come from the server, fs.existsSync runs
 * locally where the files actually land.
 *
 * @returns {{ totalExpected: number, entries: Array<{rel: string, sku: string}> }}
 */
function expectedOutputs({ profile, productIds, imageScope = null }) {
  if (!profile || !Array.isArray(productIds) || productIds.length === 0) {
    return { totalExpected: 0, entries: [] };
  }
  const subfolder = exportSubfolder(profile.outputSubfolder);
  const ext = profile.format === 'png' ? '.png'
            : profile.format === 'webp' ? '.webp'
            : profile.format === 'avif' ? '.avif'
            : '.jpg';
  const dateStr = todayStr();
  const scope = effectiveScope(imageScope, profile);
  const entries = [];
  // Names this run would produce more than once get the same `-2`, `-3`
  // suffix the real run gives them, so the preview never reports a
  // "collision" with a file the run itself is about to write.
  const claimed = new Set();
  const never = () => false;
  for (const productId of productIds) {
    const product = products.get(productId);
    if (!product) continue;
    const brand = product.brandId ? brands.get(product.brandId) : null;
    const images = exportSources(productImages.listByProduct(productId));
    for (const { i } of scopedImages(images, scope)) {
      const ctx = { product, brand, imageIndex: i, dateStr, profile };
      const base = buildFilename(profile.namingPattern || '{SKU}-{INDEX}', ctx);
      const { outPath } = resolveOutputPath('/', base, ext, 'keepBoth', claimed, never);
      claimed.add(claimKey(outPath));
      const filename = path.basename(outPath);
      const rel = subfolder ? path.join(subfolder, filename) : filename;
      entries.push({ rel, sku: product.sku });
    }
  }
  return { totalExpected: entries.length, entries };
}

/**
 * Build the collision report for the export-time "files already exist"
 * modal. v0.26.50: now a thin wrapper over `expectedOutputs` + a local
 * fs.existsSync pass. The filename computation is the same as before;
 * only the structure changed so the name-computation half can be
 * reused over RPC in client mode.
 */
function previewCollisions({ profile, productIds, outputRoot, imageScope = null }) {
  if (!outputRoot) return { totalExpected: 0, collisionCount: 0, sampleCollisions: [] };
  const { totalExpected, entries } = expectedOutputs({ profile, productIds, imageScope });
  const collisions = [];
  for (const { rel, sku } of entries) {
    const direct = containedMediaPath(outputRoot, rel);
    if (fs.existsSync(direct)) collisions.push({ name: path.basename(direct), sku });
  }
  return {
    totalExpected,
    collisionCount: collisions.length,
    sampleCollisions: collisions.slice(0, 5),
  };
}

/* ── Sharp output pipeline ───────────────────────────────────── */

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
function parseHexColor(hex) {
  const fallback = { r: 255, g: 255, b: 255 };
  if (!HEX_RE.test(hex)) return fallback;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

async function encodeOneImage({ sourceAbs, profile }) {
  const meta = await sharp(sourceAbs).metadata();
  const bg = parseHexColor(profile.backgroundColor || '#FFFFFF');

  let pipeline = sharp(sourceAbs).rotate();

  // Resize to profile size (no upscaling).
  if (meta.width !== profile.width || meta.height !== profile.height) {
    pipeline = pipeline.resize({
      width:  profile.width,
      height: profile.height,
      fit:    'contain',
      background: { ...bg, alpha: 1 },
      withoutEnlargement: false,
    });
  }

  // Flatten if outputting JPG (no alpha support).
  if (profile.format === 'jpg' || profile.format === 'jpeg') {
    pipeline = pipeline.flatten({ background: bg });
  }

  // Format conversion.
  switch (profile.format) {
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 7 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: profile.quality ?? 88 });
      break;
    case 'avif':
      // AVIF keeps alpha (no flatten needed). Its quality scale runs
      // smaller than JPEG/WebP — ~50–65 already looks great at roughly
      // half the JPEG size, so default lower when the profile didn't set one.
      pipeline = pipeline.avif({ quality: profile.quality ?? 55 });
      break;
    case 'jpg':
    case 'jpeg':
    default:
      pipeline = pipeline.jpeg({ quality: profile.quality ?? 88, mozjpeg: true });
      break;
  }

  return pipeline.toBuffer();
}

/* Write one encoded output. 'replace' overwrites on purpose; every other
 * action claims the name with `wx` at WRITE time (writeExclusiveFile), so a
 * second export writing into the same folder at the same moment cannot have
 * picked the same name between our existence check and this write. On EEXIST
 * the next free `-2`, `-3`… is tried. Resolves to the path actually written. */
async function writeOutput(bytes, outFile, action, { dir, base, ext, claimed }) {
  if (action === 'replace') {
    await fs.promises.writeFile(outFile, bytes);
    return outFile;
  }
  let target = outFile;
  for (;;) {
    try {
      return await writeExclusiveFile(target, bytes);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      claimed.add(claimKey(target));
      target = uniqueOutputPath(dir, base, ext, claimed);
      claimed.add(claimKey(target));
    }
  }
}

/* ── Run ─────────────────────────────────────────────────────── */

/**
 * Run an export.
 *
 * @param {object} args
 * @param {Profile} args.profile
 * @param {string[]} args.productIds
 * @param {string} args.outputRoot — user-chosen folder
 * @param {(stage, payload) => void} [args.onProgress] — called for each image
 * @param {'replace'|'skip'|'keepBoth'} [args.onExisting] — v0.26.24
 *   collision policy when the output folder already contains a file with
 *   the same name. Defaults to 'keepBoth' (suffix with -2, -3) for
 *   backward compatibility with callers that haven't been updated.
 * @returns {Promise<{exported: number, skipped: number, replaced: number, products: number, outputPath: string, skips: Array<{sku, reason}>}>}
 */
async function runExport({ profile, productIds, outputRoot, onProgress, onExisting = 'keepBoth', saveToLibrary = false, isCancelled = null, imageScope = null }) {
  if (!profile) throw new Error('Profile is required');
  if (!outputRoot) throw new Error('Output folder is required');
  const outputPath = containedMediaPath(outputRoot, exportSubfolder(profile.outputSubfolder), 'Output subfolder', true);
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return { exported: 0, skipped: 0, products: 0, outputPath: outputRoot, skips: [] };
  }

  fs.mkdirSync(outputPath, { recursive: true });

  const ext = profile.format === 'png' ? '.png'
            : profile.format === 'webp' ? '.webp'
            : profile.format === 'avif' ? '.avif'
            : '.jpg';
  const dateStr = todayStr();
  // Missing scope = the profile's stored one (a caller that sends nothing
  // still gets what the profile says), and only then "all".
  const scope = effectiveScope(imageScope, profile);

  let exported = 0;
  let exportedFromRaw = 0;   // tally of how many used raw source vs processed
  let skipped = 0;
  // v0.26.24: split counters so the result toast can tell the user
  // "exported 47, replaced 12, skipped 3" rather than collapsing
  // replacements into the overall write count.
  let replaced = 0;
  let skippedExisting = 0;
  const skips = [];
  // v0.30.0: tally output file sizes so the result can tell the user how
  // much they're about to copy (and the per-file range — they care that
  // exports land around 50–150 KB for fast mobile loading).
  let totalBytes = 0;
  let minBytes = Infinity;
  let maxBytes = 0;
  // v0.31.0: when saveToLibrary is on, collect each product's exported
  // output paths here and import them back AFTER the main loop (importing
  // mid-loop would renumber on-disk files and invalidate the source paths
  // we still need to read). Map: productId → [outFile, …] in export order.
  //
  // Only the export of the MAIN image (position 1) is added back. Adding every
  // copy doubled a product's gallery on each run — a 6-image product came back
  // with 12, then 18 — which is not what "save to library" means to anyone.
  const toLibrary = saveToLibrary ? new Map() : null;
  // v0.1.89: paths written by this run, and how many names repeated inside it.
  const claimed = new Set();
  let renamedInRun = 0;
  // v0.1.89: Cancel. Checked before each image, so the image being encoded
  // finishes (a half-written file is worse than one more image) and nothing
  // after it starts. What was written stays written and is reported.
  let cancelled = false;
  let productsDone = 0;
  const cancelRequested = () => {
    if (!cancelled && typeof isCancelled === 'function' && isCancelled()) cancelled = true;
    return cancelled;
  };

  for (let p = 0; p < productIds.length; p++) {
    if (cancelRequested()) break;
    const productId = productIds[p];
    const product = products.get(productId);
    if (!product) {
      skipped++;
      // `category` lets the UI group similar skips and show a fix-it tip
      // rather than dumping a wall of identical-looking strings on the user.
      skips.push({ sku: `(missing ${productId})`, reason: 'product not found', category: 'not_found' });
      continue;
    }
    const brand = product.brandId ? brands.get(product.brandId) : null;
    const images = exportSources(productImages.listByProduct(productId));

    if (images.length === 0) {
      skipped++;
      skips.push({ sku: product.sku, reason: 'no images on this product', category: 'no_images' });
      continue;
    }

    let productExported = 0;
    const selected = scopedImages(images, scope);
    const wanted = new Set(selected.map(({ i }) => i));
    for (let i = 0; i < images.length; i++) {
      if (cancelRequested()) break;
      if (!wanted.has(i)) continue;   // outside this profile's image scope
      const img = images[i];

      // Export is now pass-through: use the processed file when one exists,
      // otherwise fall back to the raw source. The Sharp pipeline in
      // processOneImage() is just resize + format-convert — it doesn't
      // require the Workspace's background-removal step.
      //
      // The two paths resolve under different roots:
      //   processed:  <dataDir>/processed/<sku>/<file>.png   (Workspace output)
      //   raw:        <dataDir>/assets/<filepath>            (auto-match / import)
      //   ai-gallery: <dataDir>/ai-gallery/<sku>/...         (AI Studio output)
      let sourceAbs = null;
      let usedRaw = false;
      const processedRel = img.isProcessed && img.processedFilepath ? img.processedFilepath : null;
      if (processedRel) {
        const candidate = processedRel.startsWith('processed/') || processedRel.startsWith('ai-gallery/')
          ? path.join(getDataDir(), processedRel)
          : path.join(getDataDir(), 'assets', processedRel);
        if (fs.existsSync(candidate)) sourceAbs = candidate;
      }
      if (!sourceAbs && img.filepath) {
        // Raw source fallback — same resolution rules as app-image://.
        const candidate = img.filepath.startsWith('processed/') || img.filepath.startsWith('ai-gallery/')
          ? path.join(getDataDir(), img.filepath)
          : path.join(getDataDir(), 'assets', img.filepath);
        if (fs.existsSync(candidate)) {
          sourceAbs = candidate;
          usedRaw = true;
        }
      }
      if (!sourceAbs) {
        skipped++;
        skips.push({
          sku: product.sku,
          reason: `image ${i + 1} file missing on disk (neither processed nor raw source found)`,
          category: 'missing',
        });
        continue;
      }

      const ctx = { product, brand, imageIndex: i, dateStr, profile };
      const base = buildFilename(profile.namingPattern || '{SKU}-{INDEX}', ctx);
      // v0.26.24: collision-aware resolver. Returns { outPath, action }
      // where action drives the per-iteration branch below.
      const { outPath: plannedFile, action, inRun } = resolveOutputPath(outputPath, base, ext, onExisting, claimed);
      let outFile = plannedFile;

      containedMediaPath(outputRoot, path.relative(path.resolve(outputRoot), outFile));

      if (action === 'skip') {
        // File already exists at the canonical path and user chose
        // to keep existing. Don't run the sharp pipeline — just
        // count it. Still surfaces in the result so the toast can
        // say "12 skipped because they already existed".
        skipped++;
        skippedExisting++;
        skips.push({
          sku: product.sku,
          reason: `image ${i + 1}: already exists at "${path.basename(outFile)}" (skipped per collision policy)`,
          category: 'already_exists',
        });
        continue;
      }

      // Claimed before the encode, so a failed write still reserves the
      // name and the next image does not try to land on a half-written file.
      claimed.add(claimKey(outFile));
      if (inRun) renamedInRun++;
      try {
        const encoded = await encodeOneImage({ sourceAbs, profile });
        outFile = await writeOutput(encoded, plannedFile, action, { dir: outputPath, base, ext, claimed });
        exported++;
        productExported++;
        if (action === 'replace') replaced++;
        if (usedRaw) exportedFromRaw++;
        // Record the encoded output size for the run's size summary.
        let bytes = 0;
        try { bytes = fs.statSync(outFile).size; } catch (_) {}
        if (bytes > 0) {
          totalBytes += bytes;
          if (bytes < minBytes) minBytes = bytes;
          if (bytes > maxBytes) maxBytes = bytes;
        }
        if (toLibrary && i === 0) {
          if (!toLibrary.has(productId)) toLibrary.set(productId, []);
          toLibrary.get(productId).push(outFile);
        }
        onProgress?.('image', { product, imageIndex: i, totalProducts: productIds.length, productIndex: p, outFile, usedRaw, action, bytes });
      } catch (err) {
        skipped++;
        skips.push({
          sku: product.sku,
          reason: `image ${i + 1}: ${err.message}`,
          category: 'error',
        });
      }
    }

    // A product cut short by Cancel is not "exported".
    if (cancelled) break;
    productsDone++;

    // Complete requested work must be written this run. Collision Skip keeps an
    // existing file but does not prove it contains the current product image.
    if (productExported === selected.length && selected.length > 0 && selected.some(({ img }) => img.isProcessed)) {
      try {
        products.setProcessStatus(product.id, 'exported');
      } catch (err) {
        // v0.1.12: this is user-visible — the product's status pill would
        // still read "processed" even though it exported fine. Not fatal to the
        // run, but it must not be silent.
        logSoftFailure('exportRunner', `set process status "exported" for ${product.sku}`, err);
      }
    }
  }

  // v0.31.0: import-back pass. The export of each product's main image is
  // added to the product and made its main image, flagged dedup_exempt so
  // the near-duplicate scan never groups a small web export against its
  // hi-res original. Done after the export loop so renumbering here can't
  // disturb source paths we read above.
  //
  // Audit 2026-10: it used to APPEND every run, and the next run exported
  // that copy — the main photo was re-encoded generation after generation and
  // the gallery grew by one per run. Now the copy is marked with the profile
  // (exportCopyMarker), exports read originals only (exportSources), and the
  // copy this profile made last time is REPLACED: the new copy goes in first,
  // then the old one is removed through productImages.remove, which holds it
  // in Recently deleted. A user photo is never removed here.
  let savedToLibrary = 0;
  if (toLibrary) {
    const MAX = require('./imageManager').MAX_IMAGES_PER_PRODUCT;
    const marker = exportCopyMarker(profile);
    for (const [pid, files] of toLibrary) {
      let changed = false;
      for (const f of files.slice(0, 1)) {
        try {
          const before = productImages.listByProduct(pid);
          if (before.length >= MAX) break; // respect cap
          // makeMain: the add and the set-main by row id run in ONE turn of
          // the product's image lock, so no renumber can slip between them.
          const { image, skipped: addSkipped } = await productImages.addFromSource(pid, f, { originalFilepath: marker, makeMain: true });
          if (!image) continue;
          changed = true;
          if (!addSkipped) {
            try { productImages.setDedupExempt(image.id, true); } catch (err) { logSoftFailure('exportRunner', 'flag imported copy dedup-exempt', err); }
            savedToLibrary++;
          }
          // Previous copies from this same profile give way to the new one.
          // Re-listed inside the lock, by row id + content hash (the add
          // awaited, so anything read before it may be stale).
          await productImages.withProductImageLock(pid, () => {
            const stale = productImages.listByProduct(pid)
              .filter((img) => img.id !== image.id && img.originalFilepath === marker);
            for (const old of stale) {
              try { productImages.remove(pid, old.id, old.contentHash ?? undefined); } catch (err) { logSoftFailure('exportRunner', 'replace the previous library copy', err); }
            }
          });
        } catch (_) { /* per-image best-effort; don't fail the whole export */ }
      }
      /* The add and the set-main renumber the product's files, so the bytes
       * behind `<sku>-001.jpg` changed while its URL did not. Bump the stamp
       * the Library's thumbnails cache-bust on (AGENTS.md §12), the same way
       * every image IPC handler does. */
      if (changed) {
        try { products.touchUpdated(pid); } catch (err) { logSoftFailure('exportRunner', 'refresh product stamp after import-back', err); }
      }
    }
  }

  return {
    exported,
    exportedFromRaw,   // subset of `exported` that came from raw source
    savedToLibrary,    // v0.31.0: count appended back into the library
    // v0.26.24: replacement + already-existed counts so the result
    // toast can be precise. `replaced` ⊆ `exported`; both count
    // toward the user's "this file got written" total.
    replaced,
    skippedExisting,
    skipped,
    products: productIds.length,
    outputPath,
    skips,
    // v0.1.89: names this run produced twice, kept with a -2, -3 suffix.
    renamedInRun,
    // v0.1.89: Cancel. `productsDone` = products whose images all went
    // through before the stop; `exported` is still the count of files written.
    cancelled,
    productsDone,
    // v0.30.0: output size summary (bytes). avg = totalBytes / exported.
    totalBytes,
    minBytes: Number.isFinite(minBytes) ? minBytes : 0,
    maxBytes,
  };
}

module.exports = { runExport, buildFilename, slugifyFilename, previewCollisions, expectedOutputs, resolveOutputPath, claimKey, normalizeExportScope, scopedImages, exportSources, isExportCopy, exportCopyMarker, effectiveScope, writeOutput };
