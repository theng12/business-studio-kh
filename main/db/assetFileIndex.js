/**
 * Fixed Assets A1: the index of an asset's photos and documents (`asset_files`).
 * Files live under <dataDir>/fixed-assets/ (main/assetFiles.js).
 *
 * Photos are ordered (position 0 = the main photo, AGENTS.md §12) and capped
 * per asset (`photoCapPerAsset`, default 20). Nothing is deleted: a file is
 * retired with a reason and its bytes stay.
 */

const { getDb } = require('./index');
const { str, badRequest, getCallerUserId, audit, notFound } = require('./_assetUtil');

function rowToFile(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, assetId: r.asset_id, kind: r.kind, position: r.position, relPath: r.rel_path,
    sha256: r.sha256, originalSha256: r.original_sha256 ?? null, mime: r.mime, bytes: r.bytes ?? null,
    width: r.width ?? null, height: r.height ?? null, originalName: r.original_name ?? null,
    uploadedByUserId: r.uploaded_by_user_id ?? null, uploadedAt: r.uploaded_at,
    retired: !!r.retired_at, retiredAt: r.retired_at ?? null, retiredReason: r.retired_reason ?? null,
  };
}

/** What a screen gets: never the path on disk. */
function publicFile(f) {
  if (!f) return null;
  const { relPath: _rel, companyId: _c, ...rest } = f;
  return rest;
}

function get(id) { return rowToFile(getDb().prepare('SELECT * FROM asset_files WHERE id = ?').get(id)); }

function list(assetId, { includeRetired = false, kind = null } = {}) {
  const where = ['asset_id = @assetId'];
  if (!includeRetired) where.push('retired_at IS NULL');
  if (kind) where.push('kind = @kind');
  return getDb().prepare(`SELECT * FROM asset_files WHERE ${where.join(' AND ')} ORDER BY kind = 'photo' DESC, position, uploaded_at`)
    .all({ assetId, kind }).map(rowToFile);
}

function countLive(assetId, photos) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM asset_files WHERE asset_id = ? AND retired_at IS NULL AND ${photos ? "kind = 'photo'" : "kind <> 'photo'"}`).get(assetId).n;
}

/** Insert a staged file's row. Photos go to the end of the photo order. Run inside the caller's transaction. */
function insert({ companyId, assetId, row }) {
  const db = getDb();
  const position = row.kind === 'photo'
    ? (db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM asset_files WHERE asset_id = ? AND kind = 'photo' AND retired_at IS NULL").get(assetId).m + 1)
    : 0;
  db.prepare(`
    INSERT INTO asset_files (id, company_id, asset_id, kind, position, rel_path, sha256, original_sha256, mime, bytes, width, height,
      original_name, uploaded_by_user_id, uploaded_at)
    VALUES (@id, @companyId, @assetId, @kind, @position, @relPath, @sha256, @originalSha256, @mime, @bytes, @width, @height,
      @originalName, @by, @now)
  `).run({ ...row, companyId, assetId, position, by: getCallerUserId(), now: Date.now() });
  return get(row.id);
}

/**
 * Re-order an asset's photos: `fileIds` is the new order (first = main). It
 * must name exactly the asset's live photos.
 */
function reorderPhotos(assetId, fileIds) {
  const live = list(assetId, { kind: 'photo' });
  const want = Array.isArray(fileIds) ? fileIds : [];
  if (want.length !== live.length || new Set(want).size !== want.length || !want.every((id) => live.some((f) => f.id === id))) {
    throw badRequest('The new order must list each of the asset\'s photos once');
  }
  const db = getDb();
  db.transaction(() => {
    const upd = db.prepare('UPDATE asset_files SET position = ? WHERE id = ?');
    want.forEach((id, i) => upd.run(i, id));
  })();
  audit('fixed_asset', assetId, 'photos:reorder', { before: { order: live.map((f) => f.id) }, after: { order: want } });
  return list(assetId, { kind: 'photo' });
}

/** Retire a file: hidden from the asset, bytes kept. Photos after it close the gap. */
function retire(id, reason) {
  const f = get(id);
  if (!f) throw notFound('File');
  if (f.retired) return f;
  const why = str(reason, 500);
  if (!why) throw badRequest('Say why the file is removed');
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE asset_files SET retired_at = ?, retired_reason = ?, retired_by_user_id = ? WHERE id = ?').run(Date.now(), why, getCallerUserId(), id);
    if (f.kind === 'photo') {
      const rest = db.prepare("SELECT id FROM asset_files WHERE asset_id = ? AND kind = 'photo' AND retired_at IS NULL ORDER BY position, uploaded_at").all(f.assetId);
      const upd = db.prepare('UPDATE asset_files SET position = ? WHERE id = ?');
      rest.forEach((r, i) => upd.run(i, r.id));
    }
  })();
  audit('fixed_asset', f.assetId, 'file:retire', { before: { fileId: id, kind: f.kind, sha256: f.sha256 }, after: { retired: true, reason: why } });
  return get(id);
}

module.exports = { get, list, insert, reorderPhotos, retire, countLive, publicFile, rowToFile };
