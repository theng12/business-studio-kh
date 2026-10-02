const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDb, getDataDir } = require('./index');
const { parseJson, getCallerUserId } = require('./_util');
const { productAssetDir, productImageBasename, TMP_PREFIX } = require('../util/assetPath');

// Late-required to avoid module-load circularity (products → productImages → products).
let _products;
function getProducts() { return _products ?? (_products = require('./products')); }
let _brands;
function getBrands() { return _brands ?? (_brands = require('./brands')); }
let _companies;
function getCompanies() { return _companies ?? (_companies = require('./companies')); }
let _imageManager;
function getImageManager() { return _imageManager ?? (_imageManager = require('../imageManager')); }

/**
 * One queue per product for the operations that pick or move filename slots.
 *
 * An add reads "how many photos are there" before it awaits the image encode,
 * and only claims the `-NNN` slot afterwards. Two adds into one product at once
 * (two AI auto-adds, a paste while the phone uploads) both read the same count
 * and both aimed at the same `-004.jpg`, so one photo was lost. Running them one
 * after another per product closes that gap; different products still run in
 * parallel.
 *
 * The stored tail is a promise that never rejects, so one failed operation does
 * not wedge every later one for that product. Do not call `addFromSource` /
 * `addFromBytes` from inside `fn` — they take this queue themselves, and
 * waiting on your own place in it never finishes.
 */
const imageQueues = new Map();
function withProductImageLock(productId, fn) {
  const prev = imageQueues.get(productId) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => {}, () => {});
  imageQueues.set(productId, tail);
  tail.then(() => { if (imageQueues.get(productId) === tail) imageQueues.delete(productId); });
  return run;
}

/**
 * Absolute path of a stored image filepath, refusing anything that would land
 * outside `<dataDir>/assets`. Stored paths are always relative and never climb,
 * so a path that does is either corrupt or hostile — `../database.sqlite` used
 * to reach the database itself through `images:removeFromProduct`.
 */
function assetAbsPath(filepath) {
  const root = path.resolve(getDataDir(), 'assets');
  const abs = path.resolve(root, String(filepath ?? ''));
  if (!filepath || abs === root || !abs.startsWith(root + path.sep)) {
    throw new Error('That image path is not inside the library, so it was not touched.');
  }
  return abs;
}

function rowToImage(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_id,
    filename: row.filename,
    filepath: row.filepath,
    originalFilepath: row.original_filepath,
    orderIndex: row.order_index,
    isProcessed: !!row.is_processed,
    processedFilepath: row.processed_filepath,
    workspaceSettings: parseJson(row.workspace_settings, {}),
    workspaceRevision: Number(row.workspace_revision ?? 0),
    contentHash: row.content_hash ?? null,
    perceptualHash: row.perceptual_hash ?? null,
    fileSize: row.file_size ?? null,
    dedupExempt: !!row.dedup_exempt,
    createdAt: row.created_at,
  };
}

/**
 * Look up an existing image on this product by SHA-1 hash. Returns the
 * relative filepath (e.g. "assets/KT-Ceramic/ROYAL/BF-R5232-GD/001.jpg")
 * if found, else null. imageManager uses this to dedup before deciding
 * on a filename.
 */
function findByHashForProduct(productId, contentHash) {
  if (!productId || !contentHash) return null;
  const row = getDb()
    .prepare(`SELECT filepath FROM product_images WHERE product_id = ? AND content_hash = ?`)
    .get(productId, contentHash);
  return row ? row.filepath : null;
}

function listByProduct(productId) {
  const out = getDb()
    .prepare(
      'SELECT * FROM product_images WHERE product_id = ? ORDER BY order_index ASC',
    )
    .all(productId)
    .map(rowToImage);
  // v0.31.0: lazily backfill file_size for rows that don't have it yet
  // (legacy rows + fresh imports). One stat per row, only when null, then
  // cached — so subsequent lists are free. Best-effort: a missing file
  // just leaves the size null rather than throwing.
  const db = getDb();
  const upd = db.prepare('UPDATE product_images SET file_size = ? WHERE id = ?');
  for (const img of out) {
    if (img.fileSize == null && img.filepath) {
      try {
        const sz = fs.statSync(path.join(getDataDir(), 'assets', img.filepath)).size;
        upd.run(sz, img.id);
        img.fileSize = sz;
      } catch (_) { /* file missing → leave null */ }
    }
  }
  return out;
}

function getByFilepath(productId, filepath) {
  const row = getDb()
    .prepare('SELECT * FROM product_images WHERE product_id = ? AND filepath = ?')
    .get(productId, filepath);
  return rowToImage(row);
}

function getById(productId, imageId) {
  const row = getDb()
    .prepare('SELECT * FROM product_images WHERE product_id = ? AND id = ?')
    .get(productId, imageId);
  return rowToImage(row);
}

function nextOrderIndex(productId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM product_images WHERE product_id = ?')
    .get(productId);
  return (row?.m ?? -1) + 1;
}

/**
 * v0.12.0: compute the canonical asset directory for a product (relative
 * to dataDir). Needs the product, its brand (or null), and its company.
 * Looked up here rather than passed in because most callers only have
 * the productId.
 */
function dirForProduct(productId) {
  const product = getProducts().get(productId);
  if (!product) throw new Error('Product not found: ' + productId);
  const company = getCompanies().get(product.companyId);
  if (!company) throw new Error('Company not found for product: ' + product.companyId);
  const brand = product.brandId ? getBrands().get(product.brandId) : null;
  return { product, company, brand, dir: productAssetDir(company, brand, product) };
}

/**
 * Renumber every image in a product folder so the on-disk filename
 * matches its current `order_index`. Two-phase atomic rename: first move
 * each file to a `__tmp-<uuid>` name, then rename each tmp to its
 * canonical NNN slot. Crash-safe in that the next-boot recovery sweep
 * can match leftover __tmp files to DB rows via content_hash.
 *
 * Returns nothing — DB rows' filepath/filename fields are updated in
 * the same transaction as the file moves.
 */
function renumberFiles(productId) {
  const { product, dir } = dirForProduct(productId);
  const images = listByProduct(productId); // already sorted by order_index
  if (images.length === 0) return;

  const dataDir = getDataDir();
  // Stored filepaths are relative to `<dataDir>/assets/`. Prepend that
  // segment whenever we touch the actual filesystem.
  const assetsRoot = path.join(dataDir, 'assets');
  const dirAbs = path.join(assetsRoot, dir);

  // Compute desired final state per image. The basename is
  // `<sku-slug>-NNN` so a file dragged out of its folder still reads as
  // belonging to the product (v0.12.1 change — v0.12.0 used bare NNN).
  const plan = images.map((img, idx) => {
    const ext = path.extname(img.filepath).toLowerCase() || '.jpg';
    const newBase = productImageBasename(product, idx);
    const newName = `${newBase}${ext}`;
    const newRel = path.posix.join(dir, newName);
    return { id: img.id, oldRel: img.filepath, newRel, newName };
  });

  // Skip if everything's already in place.
  const realMoves = plan.filter((p) => p.oldRel !== p.newRel);
  if (realMoves.length === 0) return;

  fs.mkdirSync(dirAbs, { recursive: true });

  /* Refuse to land on a file this plan does not own. Every slot a move targets
   * must be empty or about to be vacated by one of this product's own moves —
   * anything else belongs to someone else (a product whose SKU differs only by
   * case shares this folder on macOS, or a stray file) and renaming over it
   * would silently replace their photo. Compared case-insensitively because
   * the disk is. Checked before anything moves, so a refusal changes nothing. */
  const vacated = new Set(realMoves.map((m) => m.oldRel.toLowerCase()));
  for (const m of realMoves) {
    if (vacated.has(m.newRel.toLowerCase())) continue;
    if (fs.existsSync(path.join(assetsRoot, m.newRel))) {
      const err = new Error(
        `The photos of "${product.sku}" could not be put back in order: ${m.newName} is already in `
        + 'its folder and is not one of its photos. Nothing was renamed, so no photo was replaced.',
      );
      err.code = 'RENUMBER_REFUSED';   // nothing moved — reorder() rolls its order back on this
      throw err;
    }
  }

  // Phase 1: move every involved file to a unique tmp name. Done outside
  // the DB tx because rename is synchronous and we want to fail-fast on
  // disk errors before touching the DB. If phase 1 errors mid-loop, we
  // leave behind tmp files for the boot recovery sweep to reconcile via
  // content_hash; the DB remains unchanged so the app is still consistent.
  const tmpMap = new Map(); // id → tmpRel
  for (const m of realMoves) {
    const oldAbs = path.join(assetsRoot, m.oldRel);
    if (!fs.existsSync(oldAbs)) continue;
    const tmpRel = path.posix.join(dir, `${TMP_PREFIX}${crypto.randomUUID()}${path.extname(m.oldRel)}`);
    const tmpAbs = path.join(assetsRoot, tmpRel);
    fs.renameSync(oldAbs, tmpAbs);
    tmpMap.set(m.id, tmpRel);
  }

  // Phase 2: in one DB transaction, rename each tmp to the canonical
  // path and update the row.
  const db = getDb();
  const upd = db.prepare('UPDATE product_images SET filepath = ?, filename = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const m of plan) {
      const tmpRel = tmpMap.get(m.id);
      if (tmpRel) {
        const tmpAbs = path.join(assetsRoot, tmpRel);
        const newAbs = path.join(assetsRoot, m.newRel);
        if (fs.existsSync(tmpAbs)) {
          if (fs.existsSync(newAbs)) {
            /* Something appeared in the slot after the check above. Never
             * rename over it: keep this photo under a name of its own and
             * point the row there, so both files survive. */
            const keptName = `${path.posix.basename(m.newName, path.extname(m.newName))}-kept-${crypto.randomUUID().slice(0, 8)}${path.extname(m.newName)}`;
            const keptRel = path.posix.join(dir, keptName);
            fs.renameSync(tmpAbs, path.join(assetsRoot, keptRel));
            process.stderr.write(`[images.renumber] ${m.newRel} was taken; kept ${m.id} as ${keptRel}\n`);
            upd.run(keptRel, keptName, m.id);
            continue;
          }
          fs.renameSync(tmpAbs, newAbs);
        }
      }
      upd.run(m.newRel, m.newName, m.id);
    }
  });
  tx();
}

/**
 * Insert a row + write the source file into the product's nested folder
 * at the next available NNN slot. Returns { image, skipped } where
 * skipped=true means dedup-by-content-hash hit an existing row and no
 * new file was written.
 *
 * Used by the IPC handlers for `images:importForProduct`, the auto-match
 * pipeline, the AI promote-to-product flow, and tests.
 *
 * Runs in the product's image queue (see withProductImageLock), so two adds
 * into one product cannot pick the same slot. The order index is read again
 * at insert time rather than reused from before the encode: a remove that ran
 * meanwhile would otherwise leave a gap.
 */
function addFromSource(productId, sourcePath, { originalFilepath } = {}) {
  return withProductImageLock(productId, () => addImage(productId, originalFilepath, (im, opts) =>
    im.importProductImage(sourcePath, opts)));
}

function addFromBytes(productId, buffer, ext, { originalFilepath } = {}) {
  return withProductImageLock(productId, () => addImage(productId, originalFilepath, (im, opts) =>
    im.importProductImageFromBytes(buffer, ext, opts)));
}

async function addImage(productId, originalFilepath, importFn) {
  const { product, dir } = dirForProduct(productId);
  const existing = listByProduct(productId);
  const baseName = productImageBasename(product, existing.length);

  const im = getImageManager();
  const hashLookup = (h) => findByHashForProduct(productId, h);
  const { relativePath, hash, skipped } = await importFn(im, {
    destDirRel: dir,
    baseName,
    existingHashLookup: hashLookup,
  });

  if (skipped) {
    const reused = getByFilepath(productId, relativePath);
    return { image: reused, skipped: true };
  }

  const id = crypto.randomUUID();
  const ts = Date.now();
  const order = nextOrderIndex(productId);
  const filename = path.posix.basename(relativePath);
  getDb()
    .prepare(
      `INSERT INTO product_images
       (id, product_id, filename, filepath, original_filepath, order_index, is_processed, processed_filepath, workspace_settings, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?, ?)`,
    )
    .run(id, productId, filename, relativePath, originalFilepath ?? null, order, hash ?? null, ts);

  return {
    image: rowToImage(getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(id)),
    skipped: false,
  };
}

/**
 * Remove an image. The file goes into the recycle bin and the DB row is
 * deleted, then the remaining images are renumbered so order_index + filename
 * slots stay contiguous (001, 002, 003 with no gaps).
 *
 * v0.1.86: it used to `unlinkSync` the file, which made a mis-clicked photo
 * unrecoverable — and it was the *other* half of the owner's complaint that
 * product and image deletion sit too close together. The file is now moved
 * (renamed) into `<dataDir>/.recycle/<id>/` by `deletedItems.holdImage` BEFORE
 * the renumber pass. That order matters and is why this is not a Trash move:
 * renumbering immediately promotes `003` into the freed `002` slot, so a
 * delayed move would race it and could take the wrong bytes.
 */
function remove(productId, filepath) {
  const db = getDb();
  // Throws for a path that would leave <dataDir>/assets — checked even though
  // the row lookup below would also miss it, so no future edit can reach disk
  // with one.
  assetAbsPath(filepath);

  const rawRow = db.prepare('SELECT * FROM product_images WHERE product_id = ? AND filepath = ?').get(productId, filepath);
  /* No row, no disk. This used to unlink `<assets>/<filepath>` anyway, so a
   * stale screen (the photo already renumbered or deleted elsewhere) erased
   * another product's or another position's file, and a crafted path erased
   * the database. A path this product does not own is never touched. */
  if (!rawRow) {
    throw new Error('That photo is not on this product any more (it may have been moved or deleted already). Refresh and try again.');
  }

  /* Hold the file BEFORE the row goes and before the renumber: holding renames
   * it into the recycle bin, and the renumber right after promotes `003` into
   * the freed slot. If the hold fails, nothing is deleted — the photo and its
   * row stay exactly as they were and the caller gets the reason. */
  const product = db.prepare('SELECT company_id FROM products WHERE id = ?').get(productId);
  let heldId;
  try {
    heldId = require('../deletedItems').holdImage({
      imageRow: rawRow,
      fileRelpath: filepath,
      companyId: product?.company_id ?? null,
      userId: getCallerUserId(),
    });
  } catch (err) {
    throw new Error(
      `The photo could not be moved to Recently deleted, so it was not deleted (${err.message}).`,
      { cause: err },
    );
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM product_images WHERE id = ?').run(rawRow.id);
    // Reindex order_index to keep it contiguous.
    const remaining = db
      .prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY order_index ASC')
      .all(productId);
    const update = db.prepare('UPDATE product_images SET order_index = ? WHERE id = ?');
    remaining.forEach((r, i) => update.run(i, r.id));
  });
  try {
    tx();
  } catch (err) {
    // The row is still there, so the photo goes back to it.
    require('../deletedItems').releaseImageHold(heldId);
    throw err;
  }

  // Renumber surviving files to close the gap. If the deleted file was
  // 002, then 003 → 002, 004 → 003, etc. The delete itself is done by now, so
  // a renumber that refuses (a stranger's file in a slot) is logged rather
  // than reported as a failed delete; every row still points at its own file.
  try {
    renumberFiles(productId);
  } catch (err) {
    process.stderr.write(`[images.remove] renumber after delete skipped: ${err.message}\n`);
  }
}

/**
 * Reorder the image list to match `newOrderFilepaths` (a permutation of
 * the current set). Updates order_index then renumbers files so disk
 * matches DB.
 */
function reorder(productId, newOrderFilepaths) {
  const db = getDb();
  const current = listByProduct(productId).map((i) => i.filepath);
  if (newOrderFilepaths.length !== current.length) {
    throw new Error('Reorder must include every image');
  }
  const setA = new Set(current);
  const setB = new Set(newOrderFilepaths);
  if (setA.size !== setB.size || [...setA].some((x) => !setB.has(x))) {
    throw new Error('Reorder must be a permutation of existing images');
  }
  const writeOrder = db.transaction((order) => {
    const upd = db.prepare('UPDATE product_images SET order_index = ? WHERE product_id = ? AND filepath = ?');
    order.forEach((fp, idx) => upd.run(idx, productId, fp));
  });
  writeOrder(newOrderFilepaths);

  // Rewrite on-disk filenames to match the new order. A refused renumber has
  // moved nothing, so put the old order back too: otherwise the user is told
  // it failed while the database already holds the new main / order.
  try {
    renumberFiles(productId);
  } catch (err) {
    if (err?.code === 'RENUMBER_REFUSED') writeOrder(current);
    throw err;
  }
}

function setMain(productId, filepath) {
  const current = listByProduct(productId).map((i) => i.filepath);
  if (!current.includes(filepath)) throw new Error('Image not on product');
  const next = [filepath, ...current.filter((p) => p !== filepath)];
  reorder(productId, next);
}

/** Make the image with this row id the main one. Prefer this over `setMain`
 *  after an await: the id survives a renumber, the filepath does not. */
function setMainById(productId, imageId) {
  const img = getById(productId, imageId);
  if (!img) throw new Error('Image not on product');
  setMain(productId, img.filepath);
}

function setProcessed(productId, filepath, { isProcessed, processedFilepath, workspaceSettings }) {
  const params = {
    productId,
    filepath,
    isProcessed: isProcessed ? 1 : 0,
    processedFilepath: processedFilepath ?? null,
    workspaceSettings: JSON.stringify(workspaceSettings ?? {}),
  };
  getDb()
    .prepare(
      `UPDATE product_images
       SET is_processed = @isProcessed,
           processed_filepath = @processedFilepath,
           workspace_settings = @workspaceSettings,
           workspace_revision = workspace_revision + 1
       WHERE product_id = @productId AND filepath = @filepath`,
    )
    .run(params);
}

function workspaceConflict(image) {
  return new Error(`CONFLICT|${JSON.stringify({
    kind: 'workspaceImage',
    id: image?.id ?? null,
    name: image?.filename ?? null,
    workspaceRevision: image?.workspaceRevision ?? null,
  })}`);
}

function assertWorkspaceRevision(image, expectedWorkspaceRevision) {
  if (image.workspaceRevision !== expectedWorkspaceRevision) throw workspaceConflict(image);
}

function setProcessedById(productId, imageId, input) {
  const { isProcessed, processedFilepath, workspaceSettings } = input;
  const guarded = Object.prototype.hasOwnProperty.call(input, 'expectedWorkspaceRevision');
  const params = {
    productId,
    imageId,
    isProcessed: isProcessed ? 1 : 0,
    processedFilepath: processedFilepath ?? null,
    workspaceSettings: JSON.stringify(workspaceSettings ?? {}),
    expectedWorkspaceRevision: guarded ? input.expectedWorkspaceRevision : null,
    guarded: guarded ? 1 : 0,
  };
  const result = getDb()
    .prepare(
      `UPDATE product_images
       SET is_processed = @isProcessed,
           processed_filepath = @processedFilepath,
           workspace_settings = @workspaceSettings,
           workspace_revision = workspace_revision + 1
       WHERE product_id = @productId AND id = @imageId
         AND (@guarded = 0 OR workspace_revision = @expectedWorkspaceRevision)`,
    )
    .run(params);
  if (guarded && result.changes === 0) {
    throw workspaceConflict(getById(productId, imageId) || { id: imageId });
  }
  return getById(productId, imageId);
}

function filenameFromRelative(relativePath) {
  return path.basename(relativePath);
}

/**
 * v0.12.0: legacy entry retained for callers that pre-compute the file
 * write themselves (e.g. the boot migration). Inserts a row pointing at
 * an already-written file without touching disk. Skips the renumber
 * sweep because the migration handles ordering in bulk at the end.
 */
function addRow(productId, { filepath, originalFilepath, filename, contentHash, orderIndex }) {
  const existing = getByFilepath(productId, filepath);
  if (existing) return { image: existing, skipped: true };

  const id = crypto.randomUUID();
  const ts = Date.now();
  const order = orderIndex ?? nextOrderIndex(productId);
  getDb()
    .prepare(
      `INSERT INTO product_images
       (id, product_id, filename, filepath, original_filepath, order_index, is_processed, processed_filepath, workspace_settings, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?, ?)`,
    )
    .run(id, productId, filename, filepath, originalFilepath ?? null, order, contentHash ?? null, ts);

  return { image: rowToImage(getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(id)), skipped: false };
}

/**
 * v0.26.14: callers that mutate the on-disk source file in place
 * (flip-source, future in-place crop, etc.) need to bump the row's
 * content_hash so the renderer's `?v=<hash>` cache-bust changes and
 * the browser actually fetches the new pixels. Also returns the
 * refreshed row so the caller doesn't need a separate read.
 */
function setContentHash(productId, filepath, hash) {
  // v0.31.0: the bytes just changed (flip / reframe / in-place edit), so
  // refresh the cached file_size too — otherwise the Library would show a
  // stale size after an edit.
  let size = null;
  try { size = fs.statSync(path.join(getDataDir(), 'assets', filepath)).size; } catch (_) {}
  getDb()
    .prepare(
      `UPDATE product_images
       SET content_hash = ?, file_size = ?
       WHERE product_id = ? AND filepath = ?`,
    )
    .run(hash ?? null, size, productId, filepath);
  return getByFilepath(productId, filepath);
}

/**
 * Replace an image's bytes with a finished file, landing on the row's CURRENT
 * path.
 *
 * Every in-place editor (crop overwrite, reframe, auto-crop, auto-enhance,
 * compress/convert, flip, overlay overwrite) reads the photo, spends a while
 * encoding, then writes back. If a set-main, reorder or delete renumbered the
 * product meanwhile, the path it read now holds a different photo, and writing
 * there replaced that photo while stamping the hash onto the wrong row. So the
 * caller carries the row id and the content_hash it started from, and this
 * re-reads the row: gone → refuse; hash moved on (someone else edited it) →
 * refuse; otherwise write to wherever that row lives now.
 *
 * Synchronous on purpose: the lookup, the rename and the row update happen in
 * one JS turn, and every renumber is synchronous too, so nothing can move the
 * file between them. `tmpAbs` must already be fully written (in the product's
 * folder, so the rename stays on one disk). On a refusal it is left for the
 * caller to clean up.
 *
 * `newExt` (with dot) is for a format conversion: the file is renamed to that
 * extension and the old file is removed only after the row points at the new
 * one — the same contract the converter always had. A slot already taken by
 * another file is refused rather than overwritten.
 */
function replaceImageFile(productId, imageId, { tmpAbs, newHash, expectedHash, newExt = null }) {
  const cur = getById(productId, imageId);
  if (!cur) {
    throw new Error('That photo was removed while it was being edited, so the edit was not saved. Refresh and try again.');
  }
  if (expectedHash != null && cur.contentHash != null && cur.contentHash !== expectedHash) {
    throw new Error('That photo was changed by another edit while this one was running, so this edit was not saved. Refresh and try again.');
  }
  const oldAbs = assetAbsPath(cur.filepath);
  const oldExt = path.extname(cur.filepath);
  const changingExt = !!newExt && newExt.toLowerCase() !== oldExt.toLowerCase();
  const targetRel = changingExt ? cur.filepath.slice(0, cur.filepath.length - oldExt.length) + newExt : cur.filepath;
  const targetAbs = assetAbsPath(targetRel);
  if (changingExt && fs.existsSync(targetAbs)) {
    throw new Error(`${path.posix.basename(targetRel)} already exists next to this photo, so it was not converted (nothing was replaced).`);
  }

  fs.renameSync(tmpAbs, targetAbs);
  let size = null;
  try { size = fs.statSync(targetAbs).size; } catch (_) {}
  getDb()
    .prepare('UPDATE product_images SET filepath = ?, filename = ?, content_hash = ?, file_size = ? WHERE id = ? AND product_id = ?')
    .run(targetRel, path.posix.basename(targetRel), newHash ?? null, size, imageId, productId);
  if (changingExt) {
    // Superseded by the converted file the row now points at.
    try { fs.unlinkSync(oldAbs); } catch (_) { /* a leftover is harmless; the row is right */ }
  }
  return getById(productId, imageId);
}

/**
 * v0.49.28: update a row's stored filepath. Used by the re-encode flow when
 * the format conversion changes the file extension (e.g. PNG → JPEG); the
 * file on disk gets a new name and the row needs to follow it. Returns the
 * refreshed row.
 *
 * v0.1.16: also update `filename`. `filename` is the CURRENT on-disk basename
 * everywhere else in this file — it is `path.posix.basename(filepath)` on
 * insert (see addImage/addRow) and the renumber pass updates both columns
 * together. Leaving it behind meant a converted image kept advertising its old
 * extension: convert `DEMO-001-001.jpg` to WebP and the Lightbox caption, the
 * History modal and the AI source label still said `.jpg` while the bytes on
 * disk were WebP.
 */
function setFilepath(productId, oldFilepath, newFilepath) {
  let size = null;
  try { size = fs.statSync(path.join(getDataDir(), 'assets', newFilepath)).size; } catch (_) {}
  getDb()
    .prepare(
      `UPDATE product_images
       SET filepath = ?, filename = ?, file_size = ?
       WHERE product_id = ? AND filepath = ?`,
    )
    .run(newFilepath, path.posix.basename(newFilepath), size, productId, oldFilepath);
  return getByFilepath(productId, newFilepath);
}

/** v0.31.0: mark a row exempt from the near-duplicate scan (set on
 *  export-derived copies so they're never flagged against their original). */
function setDedupExempt(id, exempt) {
  getDb()
    .prepare('UPDATE product_images SET dedup_exempt = ? WHERE id = ?')
    .run(exempt ? 1 : 0, id);
}

/** v0.28.0: store a row's perceptual hash by id (used by the dedup scan's
 *  lazy backfill — it computes the dHash from the file then caches it). */
function setPerceptualHashById(id, hash) {
  getDb()
    .prepare('UPDATE product_images SET perceptual_hash = ? WHERE id = ?')
    .run(hash ?? null, id);
}

/** v0.28.0: count product_image rows that still reference a given relative
 *  filepath — so the merge knows whether a file is safe to move to
 *  quarantine (only when no OTHER row points at it). */
function countByFilepath(filepath) {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM product_images WHERE filepath = ?')
    .get(filepath);
  return row?.n ?? 0;
}

module.exports = {
  withProductImageLock,
  assetAbsPath,
  replaceImageFile,
  setMainById,
  listByProduct,
  getById,
  addFromSource,
  addFromBytes,
  addRow,
  remove,
  reorder,
  setMain,
  setProcessed,
  setProcessedById,
  assertWorkspaceRevision,
  setContentHash,
  setFilepath,
  setPerceptualHashById,
  setDedupExempt,
  countByFilepath,
  getByFilepath,
  findByHashForProduct,
  filenameFromRelative,
  renumberFiles,
  dirForProduct,
};
