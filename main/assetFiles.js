/**
 * Fixed Assets A1: asset photos and documents are EVIDENCE, not catalogue
 * assets (AGENTS.md §9; docs/ASSETS_AND_BRANCHES_PLAN.md §2 gap 3, §3.4).
 *
 *   - Stored under `<dataDir>/fixed-assets/files/<yyyy-mm>/` — NOT under
 *     `assets/` (the catalogue's folder, served by /assets/ and app-image://),
 *     so they are read only through the permission-checked `assets:getFile`.
 *   - Photos are resized to fit 1600 px and re-encoded as JPEG (the fuel
 *     pipeline, main/fuelPhotos.js). Documents may be a photo of the paper
 *     (same treatment) or a PDF (kept byte for byte).
 *   - The stored file's sha256 is recorded (and the uploaded original's), so a
 *     swapped file shows.
 *   - Nothing is ever deleted or swept: a file is RETIRED with a reason and
 *     disappears from the asset page; its bytes stay (§3.3: "Asset files are
 *     never swept").
 *   - `fixed-assets` is in BOTH BACKUP_DATA_ENTRIES and ARCHIVE_TOP_LEVEL_DIRS
 *     (main/util/backupSafety.js) and in the server bundle's trees.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir, getDb } = require('./db/index');
const { toBuffer, preparePhoto } = require('./fuelPhotos');

const ROOT_DIR = 'fixed-assets';
const FILE_KINDS = ['photo', 'invoice', 'warranty', 'registration', 'insurance', 'other'];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_DOCUMENTS_PER_ASSET = 100;
const THUMB_EDGE = 320;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function isPdf(buf) { return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-'; }

/** Resize a photo, or keep a PDF as it is. Throws a plain sentence for anything else. */
async function prepareFile(kind, bytes) {
  if (!FILE_KINDS.includes(kind)) throw new Error(`File kind must be one of: ${FILE_KINDS.join(', ')}`);
  const buf = toBuffer(bytes);
  if (!buf.length) throw new Error('The file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new Error(`The file is too large (over ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
  if (isPdf(buf)) {
    if (kind === 'photo') throw new Error('A photo must be a picture, not a PDF — add the PDF as a document');
    return { buffer: buf, sha256: sha256(buf), originalSha256: sha256(buf), bytes: buf.length, width: null, height: null, mime: 'application/pdf', ext: 'pdf' };
  }
  const p = await preparePhoto(buf);
  return { ...p, mime: 'image/jpeg', ext: 'jpg' };
}

function absPath(rel) {
  const root = path.join(getDataDir(), ROOT_DIR) + path.sep;
  const abs = path.normalize(path.join(getDataDir(), rel));
  if (!abs.startsWith(root)) throw new Error('File path outside the fixed-assets folder');
  return abs;
}

function safeName(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60); }

function monthOf(at) { return new Date(Number(at) + 7 * 3600 * 1000).toISOString().slice(0, 7); }

/** `fixed-assets/files/<yyyy-mm>/<asset>-<kind>[-n].<ext>`, free on disk and in the index. */
function relPathFor(assetId, kind, ext, at = Date.now()) {
  const dir = `${ROOT_DIR}/files/${monthOf(at)}`;
  const base = `${safeName(assetId)}-${safeName(kind)}`;
  for (let n = 1; n < 10000; n += 1) {
    const rel = `${dir}/${n === 1 ? base : `${base}-${n}`}.${ext}`;
    if (fs.existsSync(absPath(rel))) continue;
    if (getDb().prepare('SELECT 1 FROM asset_files WHERE rel_path = ?').get(rel)) continue;
    return rel;
  }
  throw new Error('Too many files of that kind on one asset');
}

/**
 * Write a prepared file under a temporary name. Returns `{ row, commit, abort }`:
 * insert `row` inside the database transaction, then commit() (rename to the
 * final name) or abort(). A failed insert leaves nothing that looks like evidence.
 */
function stageFile({ assetId, kind, prepared, originalName = null }) {
  const rel = relPathFor(assetId, kind, prepared.ext);
  const abs = absPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${crypto.randomUUID()}.part`;
  fs.writeFileSync(tmp, prepared.buffer, { flag: 'wx' });
  return {
    row: {
      id: crypto.randomUUID(), kind, relPath: rel, sha256: prepared.sha256, originalSha256: prepared.originalSha256,
      mime: prepared.mime, bytes: prepared.bytes, width: prepared.width, height: prepared.height,
      originalName: originalName ? String(originalName).slice(0, 200) : null,
    },
    commit: () => fs.renameSync(tmp, abs),
    abort: () => { try { fs.unlinkSync(tmp); } catch (_) { /* our own .part file */ } },
  };
}

/** Read a stored file (or a small JPEG thumbnail of a photo). Checks the hash on full reads. */
async function readFile(rel, { thumb = false, expectedSha256 = null, mime = 'image/jpeg' } = {}) {
  const abs = absPath(rel);
  if (!fs.existsSync(abs)) {
    const err = new Error('The file is missing from the fixed-assets folder');
    err.code = 'FILE_MISSING';
    throw err;
  }
  const buf = fs.readFileSync(abs);
  const intact = expectedSha256 ? sha256(buf) === expectedSha256 : null;
  if (!thumb || mime !== 'image/jpeg') return { bytes: buf, mime, intact };
  const sharp = require('sharp');
  const small = await sharp(buf).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  return { bytes: small, mime: 'image/jpeg', intact };
}

module.exports = { ROOT_DIR, FILE_KINDS, MAX_FILE_BYTES, MAX_DOCUMENTS_PER_ASSET, prepareFile, stageFile, readFile, absPath, isPdf };
