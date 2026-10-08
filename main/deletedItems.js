/**
 * v0.1.86: the recycle bin — deleted products and images come back.
 *
 * The owner's report was a product deleted by mistake, and v0.1.85 only fixed
 * half of it: the images were moved to the macOS Trash, but the product entry
 * was gone for good, so "put it back" meant re-creating the product by hand.
 * His next question was the obvious one — "did we have a restore button? like
 * able to restore within 7 or 15 or 30 days before it's permanently gone?"
 *
 * So this module keeps a deleted thing whole for a while:
 *
 *   - the rows (product + its image rows, or a single image row) are snapshotted
 *     as JSON before the delete;
 *   - the files are MOVED into `<dataDir>/.recycle/<id>/` — a rename, so it is
 *     instant even for a 2 GB product folder, and it is what makes restoring
 *     the pictures possible rather than merely the metadata;
 *   - a row in `deleted_items` remembers when it happened, who did it and what
 *     it was called.
 *
 * Restore puts the rows and the files back. Purge — automatic once the
 * retention window passes, or by hand — moves the held folder to the macOS
 * Trash before dropping the row, so even "permanently delete" has one more
 * layer behind it (see main/util/fileTrash.js).
 *
 * Two shapes of held item, `kind` in the table:
 *   'product' — payload = { productRow, imageRows[], assetDirRel, aiGalleryRel[], aiGalleryRows[] }
 *   'image'   — payload = { imageRow, fileRelpath }
 *
 * The folder layout on disk mirrors the original so restoring is a rename:
 *
 *   .recycle/<id>/assets/<the product's asset dir>   (kind 'product')
 *   .recycle/<id>/ai-gallery/<sku>/…                 (kind 'product')
 *   .recycle/<id>/file/<basename>                    (kind 'image')
 *
 * Deliberately NOT in the backup whitelist (BACKUP_DATA_ENTRIES), exactly like
 * the duplicate-merge quarantine (`.merge-trash`): a backup should carry the
 * live catalogue, not everything anyone ever deleted. The consequence, stated
 * in the panel, is that restoring a backup replaces the recycle bin too.
 *
 * The bin's ROWS do travel with a backup (they are in the database) while its
 * files do not, so a restored backup can list deletions whose pictures are not
 * there. Restore refuses those with a plain reason, and the boot sweep
 * (purgeExpired, which runs after the relaunch every restore ends with) drops
 * them from the list — see dropOrphanedHolds.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb, getDataDir } = require('./db/index');
const { trashPath } = require('./util/fileTrash');

const RECYCLE_DIR = '.recycle';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

function recycleRoot() {
  return path.join(getDataDir(), RECYCLE_DIR);
}

function heldDir(id) {
  return path.join(recycleRoot(), id);
}

function assetsAbs(rel) {
  return path.join(getDataDir(), 'assets', rel);
}

function dataAbs(rel) {
  return path.join(getDataDir(), rel);
}

function relFromData(abs) {
  return path.relative(getDataDir(), abs).split(path.sep).join('/');
}

function rowToItem(row, retentionDays) {
  if (!row) return null;
  const expiresAt = retentionDays > 0 ? row.deleted_at + retentionDays * DAY_MS : null;
  return {
    id: row.id,
    kind: row.kind,
    companyId: row.company_id ?? null,
    productId: row.product_id ?? null,
    label: row.label ?? '',
    detail: row.detail ?? '',
    deletedAt: row.deleted_at,
    deletedByUserId: row.deleted_by_user_id ?? null,
    expiresAt,
    daysLeft: expiresAt == null ? null : Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY_MS)),
  };
}

/** Move `from` into `dest`, falling back to a copy when a rename cannot cross devices. */
function moveInto(from, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(from, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, dest, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/* ─── holding a deletion ───────────────────────────────────────────── */

function insertItem({ id, kind, companyId, productId, label, detail, payload, userId }) {
  getDb()
    .prepare(
      `INSERT INTO deleted_items
         (id, kind, company_id, product_id, label, detail, payload_json, held_dir, deleted_at, deleted_by_user_id)
       VALUES (@id, @kind, @companyId, @productId, @label, @detail, @payload, @heldDir, @deletedAt, @userId)`,
    )
    .run({
      id,
      kind,
      companyId: companyId ?? null,
      productId: productId ?? null,
      label: label ?? '',
      detail: detail ?? '',
      payload: JSON.stringify(payload),
      heldDir: relFromData(heldDir(id)),
      deletedAt: Date.now(),
      userId: userId ?? null,
    });
  return id;
}

/**
 * Hold a deleted product. Called AFTER the row is gone, with the snapshot taken
 * before: `productRow` and `imageRows` come from `SELECT *`, so a restore is a
 * faithful re-insert rather than a reconstruction.
 *
 * `assetDirRel` is the product's folder relative to `<dataDir>/assets`
 * (`Company/Brand/SKU`). It is NOT moved when another product shares it — the
 * caller decides that (`moveAssets: false`) because their files cannot be told
 * apart, and a restore then simply re-inserts the rows over the files that are
 * still there.
 */
function holdProduct({ productRow, imageRows, assetDirRel, aiGalleryRel = [], aiGalleryRows = [], companyId, userId, moveAssets = true }) {
  const id = crypto.randomUUID();
  const dir = heldDir(id);
  let movedAssets = false;

  if (moveAssets && assetDirRel) {
    const from = assetsAbs(assetDirRel);
    if (fs.existsSync(from)) {
      moveInto(from, path.join(dir, 'assets'));
      movedAssets = true;
    }
  }
  if (aiGalleryRel.length > 0) {
    for (const rel of aiGalleryRel) {
      const from = dataAbs(rel);
      if (!fs.existsSync(from)) continue;
      moveInto(from, path.join(dir, 'ai-gallery', path.basename(path.dirname(rel)), path.basename(rel)));
    }
  }

  return insertItem({
    id,
    kind: 'product',
    companyId: companyId ?? productRow?.company_id ?? null,
    productId: productRow?.id ?? null,
    label: productRow?.sku || productRow?.name || 'product',
    detail: productRow?.name || '',
    payload: { productRow, imageRows, assetDirRel: assetDirRel ?? null, aiGalleryRel, aiGalleryRows, movedAssets },
    userId,
  });
}

/** Hold a deleted single image: the row plus the one file. */
function holdImage({ imageRow, fileRelpath, companyId, userId }) {
  const id = crypto.randomUUID();
  const dir = heldDir(id);
  const from = assetsAbs(fileRelpath);
  let moved = false;
  if (fs.existsSync(from)) {
    moveInto(from, path.join(dir, 'file', path.basename(fileRelpath)));
    moved = true;
  }
  return insertItem({
    id,
    kind: 'image',
    companyId: companyId ?? null,
    productId: imageRow?.product_id ?? null,
    label: imageRow?.filename || path.basename(fileRelpath),
    detail: 'photo',
    payload: { imageRow, fileRelpath, moved },
    userId,
  });
}

/**
 * Fuel F1: hold an evidence photo that passed its retention window (owner
 * decision 2026-10-08: 24 months, then Recently deleted -> Trash). The file
 * moves into the bin; the `fuel_photos` row stays (marked retired by the
 * caller), so restoring is a move back plus clearing `retired_at`.
 */
function holdFuelPhoto({ photoRow, companyId, label }) {
  const id = crypto.randomUUID();
  const from = dataAbs(photoRow.rel_path);
  let moved = false;
  if (fs.existsSync(from)) {
    moveInto(from, path.join(heldDir(id), 'file', path.basename(photoRow.rel_path)));
    moved = true;
  }
  return insertItem({
    id,
    kind: 'fuel-photo',
    companyId: companyId ?? null,
    productId: null,
    label: label || path.basename(photoRow.rel_path),
    detail: 'fuel photo',
    payload: { photoId: photoRow.id, relPath: photoRow.rel_path, sha256: photoRow.sha256, moved },
    userId: null,
  });
}

function restoreFuelPhoto(item) {
  const payload = JSON.parse(item.payload_json || '{}');
  const from = path.join(heldDir(item.id), 'file', path.basename(payload.relPath || ''));
  if (!payload.moved || !payload.relPath || !fs.existsSync(from)) throw new Error(MISSING_HOLD_MESSAGE);
  const to = dataAbs(payload.relPath);
  if (fs.existsSync(to)) throw new Error('A file is already back at that photo\'s place.');
  moveInto(from, to);
  const db = getDb();
  db.prepare('UPDATE fuel_photos SET retired_at = NULL, retired_reason = NULL, recycle_item_id = NULL WHERE id = ?').run(payload.photoId);
  db.prepare('DELETE FROM deleted_items WHERE id = ?').run(item.id);
  pruneEmptyDirs(heldDir(item.id));
  return { kind: 'fuel-photo', label: item.label, productId: null, photoId: payload.photoId };
}

/**
 * HR1: hold a clock-in photo past its retention window (24 months, owner
 * decision §7a). Same shape as holdFuelPhoto: the file moves into the bin, the
 * attendance event keeps its row (photo_retired_at set by the caller), and a
 * restore moves the file back and clears the mark. The label never names the
 * person — the bin is visible to anyone who may restore deleted products.
 */
function holdHrPhoto({ eventId, relPath, sha256, companyId, label }) {
  const id = crypto.randomUUID();
  const from = dataAbs(relPath);
  let moved = false;
  if (fs.existsSync(from)) {
    moveInto(from, path.join(heldDir(id), 'file', path.basename(relPath)));
    moved = true;
  }
  return insertItem({
    id,
    kind: 'hr-photo',
    companyId: companyId ?? null,
    productId: null,
    label: label || path.basename(relPath),
    detail: 'clock-in photo',
    payload: { eventId, relPath, sha256, moved },
    userId: null,
  });
}

function restoreHrPhoto(item) {
  const payload = JSON.parse(item.payload_json || '{}');
  const from = path.join(heldDir(item.id), 'file', path.basename(payload.relPath || ''));
  if (!payload.moved || !payload.relPath || !fs.existsSync(from)) throw new Error(MISSING_HOLD_MESSAGE);
  const to = dataAbs(payload.relPath);
  if (fs.existsSync(to)) throw new Error('A file is already back at that photo\'s place.');
  moveInto(from, to);
  const db = getDb();
  db.prepare('UPDATE attendance_events SET photo_retired_at = NULL, photo_recycle_item_id = NULL WHERE id = ?').run(payload.eventId);
  db.prepare('DELETE FROM deleted_items WHERE id = ?').run(item.id);
  pruneEmptyDirs(heldDir(item.id));
  return { kind: 'hr-photo', label: item.label, productId: null, eventId: payload.eventId };
}

/**
 * Undo a holdImage whose delete did not go through: the photo goes back to
 * the path it came from (its row is still there, pointing at it) and the bin
 * entry is dropped. If that path has been taken meanwhile the photo stays held
 * and listed, so it is never lost either way.
 */
function releaseImageHold(id) {
  const item = get(id);
  if (!item) return false;
  const payload = JSON.parse(item.payload_json || '{}');
  if (payload.moved) {
    const from = path.join(heldDir(id), 'file', path.basename(payload.fileRelpath));
    const to = assetsAbs(payload.fileRelpath);
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    fs.renameSync(from, to);
  }
  getDb().prepare('DELETE FROM deleted_items WHERE id = ?').run(id);
  pruneEmptyDirs(heldDir(id));
  return true;
}

/* ─── listing ──────────────────────────────────────────────────────── */

function list({ companyId, retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const rows = companyId
    ? getDb().prepare('SELECT * FROM deleted_items WHERE company_id = ? ORDER BY deleted_at DESC').all(companyId)
    : getDb().prepare('SELECT * FROM deleted_items ORDER BY deleted_at DESC').all();
  return rows.map((r) => rowToItem(r, retentionDays));
}

function get(id) {
  return getDb().prepare('SELECT * FROM deleted_items WHERE id = ?').get(id);
}

function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM deleted_items').get().n;
}

/* ─── restoring ────────────────────────────────────────────────────── */

/** Re-insert a raw row snapshot. Columns come from the snapshot, so a row
 *  written before a later additive column still restores (those are nullable
 *  or defaulted — AGENTS.md §14). */
function insertRow(table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
  getDb().prepare(sql).run(row);
}

/** Put a held folder or file back where it came from. A slot that has been
 *  taken in the meantime gets a fresh name rather than overwriting anything. */
function putBack(fromAbs, toAbs) {
  if (!fs.existsSync(fromAbs)) return null;
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  if (!fs.existsSync(toAbs)) {
    fs.renameSync(fromAbs, toAbs);
    return toAbs;
  }
  const ext = path.extname(toAbs);
  const alt = path.join(path.dirname(toAbs), `restored-${crypto.randomUUID()}${ext}`);
  fs.renameSync(fromAbs, alt);
  return alt;
}

/**
 * Remove directories under `dir` that are now empty. Used after a restore has
 * moved every file back out, so the recycle bin does not fill up with hollow
 * folders. Only ever removes EMPTY directories: anything still holding bytes is
 * left exactly where it is.
 */
function pruneEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (_) { /* not empty, or already gone */ }
}

/** True when a held item's files are expected in the bin but are not there —
 *  what a restored backup leaves behind (rows came back, `.recycle` did not). */
function holdIsMissing(item) {
  let payload;
  try { payload = JSON.parse(item.payload_json || '{}'); } catch (_) { return false; }
  if (item.kind === 'fuel-photo' || item.kind === 'hr-photo') {
    if (!payload.moved || !payload.relPath) return false;
    return !fs.existsSync(path.join(heldDir(item.id), 'file', path.basename(payload.relPath)));
  }
  if (item.kind === 'image') {
    if (!payload.moved || !payload.fileRelpath) return false;
    return !fs.existsSync(path.join(heldDir(item.id), 'file', path.basename(payload.fileRelpath)));
  }
  if (payload.movedAssets && payload.assetDirRel) {
    return !fs.existsSync(path.join(heldDir(item.id), 'assets'));
  }
  return false;
}

const MISSING_HOLD_MESSAGE =
  'The pictures for this item are no longer in Recently deleted, so it cannot be put back. '
  + 'This can happen after restoring a backup (backups do not carry deleted items) or if the '
  + 'files were missing when it was deleted. You can remove it from the list.';

/** Undo a set of putBack() placements, newest first. Only paths this restore
 *  actually placed are moved — never whatever happens to sit at the target. */
function undoPlacements(placed) {
  for (const [placedAbs, fromAbs] of [...placed].reverse()) {
    try {
      if (fs.existsSync(placedAbs) && !fs.existsSync(fromAbs)) {
        fs.mkdirSync(path.dirname(fromAbs), { recursive: true });
        fs.renameSync(placedAbs, fromAbs);
      }
    } catch (_) { /* left where it is; nothing is erased */ }
  }
}

function restoreProduct(item) {
  const payload = JSON.parse(item.payload_json || '{}');
  if (!payload.productRow) throw new Error('This item was stored without a product snapshot and cannot be restored');
  // A copy: the links fixed up below must not rewrite the stored snapshot.
  const productRow = { ...payload.productRow };
  const db = getDb();
  if (holdIsMissing(item)) throw new Error(MISSING_HOLD_MESSAGE);

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(productRow.company_id);
  if (!company) {
    throw new Error('The company this product belonged to has been deleted, so the product has nowhere to go back to.');
  }

  const clash = db
    .prepare('SELECT sku FROM products WHERE id = ? OR (company_id = ? AND sku = ?)')
    .get(productRow.id, productRow.company_id, productRow.sku);
  if (clash) {
    throw new Error(
      `A product with SKU “${clash.sku}” exists again. Rename or delete it first, then restore this one.`,
    );
  }

  /* A brand or category deleted while this product was in the bin would fail
   * the insert with "FOREIGN KEY constraint failed" — forever, since nothing
   * brings the brand back. Restore it without that link instead; the brand or
   * category can be set again afterwards. */
  if (productRow.brand_id && !db.prepare('SELECT 1 FROM brands WHERE id = ?').get(productRow.brand_id)) productRow.brand_id = null;
  if (productRow.category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(productRow.category_id)) productRow.category_id = null;

  /* Where the folder belongs NOW. The company or brand may have been renamed
   * (or the brand removed) since the delete, which moves the product's folder;
   * the held folder and the image rows follow the current one. */
  const brand = productRow.brand_id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(productRow.brand_id) : null;
  const { productAssetDir } = require('./util/assetPath');
  let targetDirRel = payload.assetDirRel;
  try { targetDirRel = productAssetDir(company, brand, productRow); } catch (_) { /* keep the old one */ }

  // The case-insensitive / punctuation rule products.create applies.
  const folderClash = require('./db/products').findAssetDirCollision(
    productRow.company_id, { sku: productRow.sku, brandId: productRow.brand_id }, productRow.id,
  );
  if (folderClash) {
    throw new Error(
      `“${folderClash.sku}” now uses the same image folder as this product. Rename one of them first, then restore this one.`,
    );
  }

  const dir = heldDir(item.id);
  const restores = [];
  let imageRows = payload.imageRows || [];
  if (payload.movedAssets && payload.assetDirRel) {
    const from = path.join(dir, 'assets');
    const to = assetsAbs(targetDirRel);
    if (fs.existsSync(to)) {
      // An empty leftover folder is not in the way; anything with files is.
      try { if (fs.readdirSync(to).length === 0) fs.rmdirSync(to); } catch (_) {}
      if (fs.existsSync(to)) {
        throw new Error(
          `The folder ${targetDirRel} already has files in it, so this product's pictures cannot go back there. Nothing was changed.`,
        );
      }
    }
    restores.push({ from, to, exact: true });
    if (targetDirRel !== payload.assetDirRel) {
      const oldPrefix = `${payload.assetDirRel}/`;
      imageRows = imageRows.map((r) => (r.filepath && r.filepath.startsWith(oldPrefix)
        ? { ...r, filepath: `${targetDirRel}/${r.filepath.slice(oldPrefix.length)}` }
        : r));
    }
  }
  const galleryPlaced = new Map(); // original rel → rel it landed at
  for (const rel of payload.aiGalleryRel || []) {
    const from = path.join(dir, 'ai-gallery', path.basename(path.dirname(rel)), path.basename(rel));
    if (fs.existsSync(from)) restores.push({ from, to: dataAbs(rel), rel });
  }

  /* Put the files back, recording where each one ACTUALLY landed. putBack
   * picks a fresh `restored-<uuid>` name when the target is taken; for the
   * product folder that would leave the rows pointing at somebody else's
   * folder, so the whole restore is called off and only what this restore
   * placed is moved back. */
  const placed = [];
  try {
    for (const r of restores) {
      const landed = putBack(r.from, r.to);
      if (!landed) continue;
      placed.push([landed, r.from]);
      if (r.exact && landed !== r.to) {
        throw new Error(
          `The folder ${targetDirRel} was taken while restoring, so this product's pictures were not put back. Nothing was changed.`,
        );
      }
      if (r.rel) galleryPlaced.set(r.rel, relFromData(landed));
    }
  } catch (err) {
    undoPlacements(placed);
    throw err;
  }

  try {
    db.transaction(() => {
      insertRow('products', productRow);
      for (const imageRow of imageRows) insertRow('product_images', imageRow);
      /* AI Studio's rows for this product (older holds have none). A row whose
       * file did not come back is skipped rather than restored as a broken
       * picture; a task that no longer exists is unlinked, not required. */
      for (const g of payload.aiGalleryRows || []) {
        const landedRel = galleryPlaced.get(g.filepath);
        if (!landedRel) continue;
        if (db.prepare('SELECT 1 FROM ai_gallery WHERE id = ?').get(g.id)) continue;
        const galleryRow = { ...g, filepath: landedRel };
        if (galleryRow.task_id && !db.prepare('SELECT 1 FROM ai_tasks WHERE id = ?').get(galleryRow.task_id)) {
          galleryRow.task_id = null;
        }
        insertRow('ai_gallery', galleryRow);
      }
      db.prepare('DELETE FROM deleted_items WHERE id = ?').run(item.id);
    })();
  } catch (err) {
    undoPlacements(placed);
    throw err;
  }

  pruneEmptyDirs(dir);
  return { kind: 'product', label: item.label, productId: productRow.id, images: imageRows.length };
}

function restoreImage(item) {
  const payload = JSON.parse(item.payload_json || '{}');
  const imageRow = payload.imageRow;
  if (!imageRow) throw new Error('This item was stored without an image snapshot and cannot be restored');
  const db = getDb();

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(imageRow.product_id);
  if (!product) {
    throw new Error('That product is gone too, so this photo has nowhere to go back to. Restore the product first.');
  }
  if (db.prepare('SELECT 1 FROM product_images WHERE id = ?').get(imageRow.id)) {
    throw new Error('This photo is already back on its product.');
  }

  const from = path.join(heldDir(item.id), 'file', path.basename(payload.fileRelpath || ''));
  /* No file in the bin, no restore. Re-inserting the row anyway pointed it at
   * whatever now sits at its old path — usually another live photo, which the
   * renumber that follows then shuffled — so two rows shared one file. */
  if (!payload.moved || !payload.fileRelpath || !fs.existsSync(from)) {
    throw new Error(MISSING_HOLD_MESSAGE);
  }

  const { MAX_IMAGES_PER_PRODUCT } = require('./imageManager');
  const count = db.prepare('SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?').get(imageRow.product_id).n;
  if (count >= MAX_IMAGES_PER_PRODUCT) {
    throw new Error(
      `This product already has ${count} photos, the most one product can hold (${MAX_IMAGES_PER_PRODUCT}). Remove one, then restore this photo.`,
    );
  }

  /* Land in the product's CURRENT folder (a SKU or brand change since the
   * delete moves it), under the old name only when no row owns that path and
   * nothing is on disk there. Otherwise a fresh name; the renumber below gives
   * it a clean slot either way. */
  const productImages = require('./db/productImages');
  let dirRel = path.posix.dirname(payload.fileRelpath);
  try { dirRel = productImages.dirForProduct(imageRow.product_id).dir; } catch (_) { /* keep the old one */ }
  const ext = path.extname(payload.fileRelpath);
  let wanted = path.posix.join(dirRel, path.posix.basename(payload.fileRelpath));
  const owned = db.prepare('SELECT 1 FROM product_images WHERE LOWER(filepath) = LOWER(?)').get(wanted);
  if (owned || fs.existsSync(assetsAbs(wanted))) {
    wanted = path.posix.join(dirRel, `restored-${crypto.randomUUID()}${ext}`);
  }
  const placed = putBack(from, assetsAbs(wanted));
  const filepath = relFromData(placed).replace(/^assets\//, '');

  // Append at the end: the rows that stayed behind were renumbered while this
  // one was away, so its old index belongs to another photo now.
  const next = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM product_images WHERE product_id = ?')
    .get(imageRow.product_id).n;
  try {
    db.transaction(() => {
      insertRow('product_images', {
        ...imageRow,
        filepath,
        filename: path.posix.basename(filepath),
        order_index: next,
      });
      db.prepare('DELETE FROM deleted_items WHERE id = ?').run(item.id);
    })();
  } catch (err) {
    try { fs.renameSync(placed, from); } catch (_) {}
    throw err;
  }

  /* Close the gap the restore just made. The survivors were renumbered while
   * this photo was away, so its old slot is taken and it may have needed a
   * fresh name (`restored-<uuid>.png`). Running the same renumber pass every
   * other image operation uses gives it back a clean `-004.png` slot —
   * AGENTS.md §12 keeps filenames contiguous so position N always means the
   * same file. */
  try { productImages.renumberFiles(imageRow.product_id); } catch (_) { /* cosmetic */ }
  try {
    const products = require('./db/products');
    products.recomputeProcessStatus(imageRow.product_id);
    products.touchUpdated(imageRow.product_id);
  } catch (_) { /* the photo is back; status catches up on the next edit */ }

  const restored = db.prepare('SELECT filepath FROM product_images WHERE id = ?').get(imageRow.id);
  pruneEmptyDirs(heldDir(item.id));
  return { kind: 'image', label: item.label, productId: imageRow.product_id, filepath: restored?.filepath ?? filepath };
}

function restore(id) {
  const item = get(id);
  if (!item) throw new Error('That deleted item is no longer in the list');
  if (item.kind === 'fuel-photo') return restoreFuelPhoto(item);
  if (item.kind === 'hr-photo') return restoreHrPhoto(item);
  return item.kind === 'image' ? restoreImage(item) : restoreProduct(item);
}

/* ─── purging ──────────────────────────────────────────────────────── */

/**
 * Remove one held item for good. The files go to the macOS Trash first, so a
 * purge is still recoverable in Finder until the Trash is emptied — the
 * "permanently gone" the user is warned about is not decided by this function
 * alone, and that is on purpose.
 */
function purge(id, { trash = trashPath } = {}) {
  const item = get(id);
  if (!item) return false;
  const dir = heldDir(id);
  if (fs.existsSync(dir)) {
    trash(dir).catch(() => { /* logged by the helper */ });
  }
  getDb().prepare('DELETE FROM deleted_items WHERE id = ?').run(id);
  return true;
}

function empty({ companyId } = {}, opts = {}) {
  const items = list({ companyId });
  let removed = 0;
  for (const it of items) {
    if (purge(it.id, opts)) removed += 1;
  }
  return { removed };
}

/**
 * Boot-time (and on-demand) sweep: anything older than the retention window is
 * purged. `retentionDays <= 0` means "keep until I say so" and purges nothing.
 */
function purgeExpired({ retentionDays = DEFAULT_RETENTION_DAYS } = {}, opts = {}) {
  // dropOrphanedHolds() is deliberately NOT run here. A hold that looks
  // missing at boot is not proof it is gone — the data folder may have been
  // moved without `.recycle/`, or be on a volume that is slow to appear — and
  // silently deleting the entry would make a recoverable item unrecoverable.
  // Such an entry stays listed; restoring it refuses with MISSING_HOLD_MESSAGE,
  // and it leaves with the retention window or a manual "delete forever".
  if (!(retentionDays > 0)) return { removed: 0, kept: count() };
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const stale = getDb().prepare('SELECT id FROM deleted_items WHERE deleted_at < ?').all(cutoff);
  let removed = 0;
  for (const row of stale) {
    if (purge(row.id, opts)) removed += 1;
  }
  return { removed, kept: count() };
}

/**
 * Forget bin entries whose held files are gone. After a backup restore or a
 * bundle import the database lists every deletion it knew about, but
 * `.recycle/` is not in either archive, so those entries can never be restored
 * — and restoring one used to point a photo row at another photo's file.
 * Only entries that were holding files and no longer are are dropped; one that
 * never moved files (a product whose folder was shared) can still be restored
 * and stays. Runs at boot through purgeExpired, i.e. right after the relaunch
 * every restore and import ends with. Nothing on disk is touched.
 *
 * Not called automatically (see purgeExpired): kept for an explicit,
 * user-initiated clean-up.
 */
function dropOrphanedHolds() {
  let dropped = 0;
  const del = getDb().prepare('DELETE FROM deleted_items WHERE id = ?');
  for (const item of getDb().prepare('SELECT * FROM deleted_items').all()) {
    if (holdIsMissing(item)) {
      del.run(item.id);
      dropped += 1;
    }
  }
  if (dropped > 0) {
    process.stderr.write(`[recycle] dropped ${dropped} deleted item(s) whose files are no longer held (e.g. after a backup restore)\n`);
  }
  return dropped;
}

module.exports = {
  RECYCLE_DIR,
  DEFAULT_RETENTION_DAYS,
  DAY_MS,
  holdProduct,
  holdImage,
  holdFuelPhoto,
  holdHrPhoto,
  releaseImageHold,
  dropOrphanedHolds,
  list,
  get,
  count,
  restore,
  purge,
  empty,
  purgeExpired,
  // exported for tests
  recycleRoot,
  heldDir,
};
