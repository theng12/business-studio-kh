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
 *   'product' — payload = { productRow, imageRows[], assetDirRel, aiGalleryRel[] }
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
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb, getDataDir } = require('./db/index');
const { trashPath, trashPathInBackground } = require('./util/fileTrash');

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
function holdProduct({ productRow, imageRows, assetDirRel, aiGalleryRel = [], companyId, userId, moveAssets = true }) {
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
    payload: { productRow, imageRows, assetDirRel: assetDirRel ?? null, aiGalleryRel, movedAssets },
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

function restoreProduct(item) {
  const payload = JSON.parse(item.payload_json || '{}');
  const productRow = payload.productRow;
  if (!productRow) throw new Error('This item was stored without a product snapshot and cannot be restored');
  const db = getDb();

  const clash = db
    .prepare('SELECT sku FROM products WHERE id = ? OR (company_id = ? AND sku = ?)')
    .get(productRow.id, productRow.company_id, productRow.sku);
  if (clash) {
    throw new Error(
      `A product with SKU “${clash.sku}” exists again. Rename or delete it first, then restore this one.`,
    );
  }

  const dir = heldDir(item.id);
  const moved = [];
  const restores = [];
  if (payload.movedAssets && payload.assetDirRel) {
    const from = path.join(dir, 'assets');
    const to = assetsAbs(payload.assetDirRel);
    if (fs.existsSync(from)) { restores.push([from, to]); moved.push(to); }
  }
  for (const rel of payload.aiGalleryRel || []) {
    const from = path.join(dir, 'ai-gallery', path.basename(path.dirname(rel)), path.basename(rel));
    if (fs.existsSync(from)) restores.push([from, dataAbs(rel)]);
  }

  const putBackAll = () => { for (const [from, to] of restores) putBack(from, to); };
  const undoPutBack = () => {
    for (const to of moved) {
      try { if (fs.existsSync(to)) fs.renameSync(to, path.join(heldDir(item.id), 'assets')); } catch (_) {}
    }
  };

  putBackAll();
  try {
    db.transaction(() => {
      insertRow('products', productRow);
      for (const imageRow of payload.imageRows || []) insertRow('product_images', imageRow);
      db.prepare('DELETE FROM deleted_items WHERE id = ?').run(item.id);
    })();
  } catch (err) {
    undoPutBack();
    throw err;
  }

  pruneEmptyDirs(dir);
  return { kind: 'product', label: item.label, productId: productRow.id, images: (payload.imageRows || []).length };
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

  const from = path.join(heldDir(item.id), 'file', path.basename(payload.fileRelpath));
  const to = assetsAbs(payload.fileRelpath);
  const placed = putBack(from, to);
  const filepath = placed && path.basename(placed) !== path.basename(to) ? relFromData(placed).replace(/^assets\//, '') : payload.fileRelpath;

  // Append at the end: the rows that stayed behind were renumbered while this
  // one was away, so its old index belongs to another photo now.
  const next = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM product_images WHERE product_id = ?')
    .get(imageRow.product_id).n;
  try {
    db.transaction(() => {
      insertRow('product_images', { ...imageRow, filepath, order_index: next });
      db.prepare('DELETE FROM deleted_items WHERE id = ?').run(item.id);
    })();
  } catch (err) {
    if (placed) { try { fs.renameSync(placed, from); } catch (_) {} }
    throw err;
  }

  /* Close the gap the restore just made. The survivors were renumbered while
   * this photo was away, so its old slot is taken and `putBack` had to invent a
   * name (`restored-<uuid>.png`). Running the same renumber pass every other
   * image operation uses gives it back a clean `-004.png` slot — AGENTS.md §12
   * keeps filenames contiguous so position N always means the same file. */
  try { require('./db/productImages').renumberFiles(imageRow.product_id); } catch (_) { /* cosmetic */ }

  pruneEmptyDirs(heldDir(item.id));
  return { kind: 'image', label: item.label, productId: imageRow.product_id, filepath };
}

function restore(id) {
  const item = get(id);
  if (!item) throw new Error('That deleted item is no longer in the list');
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
  if (!(retentionDays > 0)) return { removed: 0, kept: count() };
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const stale = getDb().prepare('SELECT id FROM deleted_items WHERE deleted_at < ?').all(cutoff);
  let removed = 0;
  for (const row of stale) {
    if (purge(row.id, opts)) removed += 1;
  }
  return { removed, kept: count() };
}

module.exports = {
  RECYCLE_DIR,
  DEFAULT_RETENTION_DAYS,
  DAY_MS,
  holdProduct,
  holdImage,
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
