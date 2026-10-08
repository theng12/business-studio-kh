/**
 * Fuel F1: evidence photos (docs/PEOPLE_AND_FUEL_PLAN.md §3.6, §5.3).
 *
 *   - Stored under `<dataDir>/fuel/<yyyy-mm>/<record-id>-<kind>.jpg` — NOT
 *     under `assets/`, so the server's `/assets/` route and the `app-image://`
 *     protocol cannot reach them (both only serve assets/, processed/ and
 *     ai-gallery/). They are read only through the permission-checked
 *     `fuel:getPhoto` / `staff:getPhoto` channels.
 *   - Resized to fit 1600 px, re-encoded as JPEG, and the stored file's
 *     sha256 is recorded (plus the uploaded original's), so a swapped file shows.
 *   - Staff photos live under `<dataDir>/hr/employees/<id>/` (the HR area).
 *   - Retention (owner decision: 24 months): older evidence photos move to
 *     Recently deleted (main/deletedItems.js), and from there to the Trash
 *     when the bin's own window passes. Nothing is erased here.
 *
 * Bytes arrive as a Buffer (RPC from a phone or client Mac — the server has
 * already unwrapped the `{ __bin, b64 }` envelope), an ArrayBuffer or a
 * typed array (local IPC).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
require('./util/sharpLimits');
const { getDataDir, getDb } = require('./db/index');
const { phnomPenhMonth } = require('./util/fuelAnomalies');

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_PHOTOS_PER_RECORD = 6;        // in one upload
const MAX_PHOTOS_PER_RECORD_TOTAL = 12; // ever, counting photos added later (fuel:addPhoto)
const MAX_EDGE = 1600;
const THUMB_EDGE = 320;
const EVIDENCE_OWNER_KINDS = ['fill', 'dip', 'delivery', 'transfer'];

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes && bytes.__bin === true && typeof bytes.b64 === 'string') return Buffer.from(bytes.b64, 'base64');
  throw new Error('Photo bytes are missing');
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function decodableBuffer(buf) {
  const { isHeicBuffer } = require('./util/heic');
  if (!isHeicBuffer(buf) || process.platform !== 'darwin') return buf;
  // iPhones can send HEIC; sharp's bundled libvips may not read it, so let macOS convert.
  const tmpIn = path.join(os.tmpdir(), `mskh-fuel-${crypto.randomUUID()}.heic`);
  fs.writeFileSync(tmpIn, buf);
  try {
    const { ensureDecodablePath } = require('./util/heic');
    const res = await ensureDecodablePath(tmpIn);
    try { return fs.readFileSync(res.path); } finally { res.cleanup?.(); }
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) { /* our own temp file */ }
  }
}

/**
 * Resize + re-encode one uploaded photo. Returns the JPEG and its facts.
 * Throws a plain message for anything that is not a readable picture.
 */
async function preparePhoto(bytes, { maxEdge = MAX_EDGE } = {}) {
  const original = toBuffer(bytes);
  if (!original.length) throw new Error('The photo is empty');
  if (original.length > MAX_PHOTO_BYTES) throw new Error(`The photo is too large (over ${MAX_PHOTO_BYTES / 1024 / 1024} MB)`);
  const sharp = require('sharp');
  let input;
  try { input = await decodableBuffer(original); } catch (err) { throw new Error(`That photo could not be read: ${err.message}`, { cause: err }); }
  let out;
  try {
    out = await sharp(input, { limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new Error(`That file is not a photo the app can read (${err.message})`, { cause: err });
  }
  return {
    buffer: out.data,
    sha256: sha256(out.data),
    originalSha256: sha256(original),
    bytes: out.data.length,
    width: out.info.width,
    height: out.info.height,
  };
}

function safeName(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60); }

/** `fuel/<yyyy-mm>/<record-id>-<kind>[-n].jpg`, unique on disk and in the index. */
function evidenceRelPath(at, recordId, kind, taken = new Set()) {
  const dir = `fuel/${phnomPenhMonth(at)}`;
  const base = `${safeName(recordId)}-${safeName(kind)}`;
  for (let n = 1; n < 1000; n += 1) {
    const rel = `${dir}/${n === 1 ? base : `${base}-${n}`}.jpg`;
    if (taken.has(rel)) continue;
    if (fs.existsSync(absPath(rel))) continue;
    const used = getDb().prepare('SELECT 1 FROM fuel_photos WHERE rel_path = ?').get(rel);
    if (!used) return rel;
  }
  throw new Error('Too many photos of that kind on one record');
}

function absPath(rel) {
  const root = getDataDir();
  const abs = path.normalize(path.join(root, rel));
  const allowed = [path.join(root, 'fuel') + path.sep, path.join(root, 'hr') + path.sep];
  if (!allowed.some((p) => abs.startsWith(p))) throw new Error('Photo path outside the fuel/hr folders');
  return abs;
}

/**
 * Write prepared photos for one record to temporary names, so a failed
 * database insert leaves nothing behind that looks like evidence. Returns
 * `{ rows, commit, abort }`: insert `rows` into fuel_photos inside the record's
 * transaction, then call commit() (rename to the final names) or abort().
 */
function stagePhotos({ recordId, at, photos }) {
  if (!Array.isArray(photos) || !photos.length) return { rows: [], commit: () => {}, abort: () => {} };
  const taken = new Set();
  const staged = [];
  try {
    for (const p of photos) {
      const rel = evidenceRelPath(at, recordId, p.kind, taken);
      taken.add(rel);
      const abs = absPath(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.${crypto.randomUUID()}.part`;
      fs.writeFileSync(tmp, p.prepared.buffer, { flag: 'wx' });
      staged.push({ tmp, abs, row: {
        id: crypto.randomUUID(), kind: p.kind, relPath: rel, sha256: p.prepared.sha256, originalSha256: p.prepared.originalSha256,
        bytes: p.prepared.bytes, width: p.prepared.width, height: p.prepared.height,
      } });
    }
  } catch (err) {
    for (const s of staged) { try { fs.unlinkSync(s.tmp); } catch (_) { /* our own .part file */ } }
    throw err;
  }
  return {
    rows: staged.map((s) => s.row),
    commit: () => { for (const s of staged) fs.renameSync(s.tmp, s.abs); },
    abort: () => { for (const s of staged) { try { fs.unlinkSync(s.tmp); } catch (_) { /* our own .part file */ } } },
  };
}

/** Validate + prepare a list of `{ kind, bytes }` uploads for one record type. */
async function prepareUploads(ownerKind, uploads) {
  const { PHOTO_KINDS } = require('./db/fuelRecords');
  const list = uploads == null ? [] : uploads;
  if (!Array.isArray(list)) throw new Error('photos must be a list');
  if (list.length > MAX_PHOTOS_PER_RECORD) throw new Error(`At most ${MAX_PHOTOS_PER_RECORD} photos per record`);
  const allowed = PHOTO_KINDS[ownerKind] || [];
  const out = [];
  for (const u of list) {
    if (!allowed.includes(u?.kind)) throw new Error(`Photo kind must be one of: ${allowed.join(', ')}`);
    out.push({ kind: u.kind, prepared: await preparePhoto(u.bytes) });
  }
  return out;
}

/** Read a stored photo (or a small thumbnail of it). Checks the hash on full reads. */
async function readPhotoFile(rel, { thumb = false, expectedSha256 = null } = {}) {
  const abs = absPath(rel);
  if (!fs.existsSync(abs)) {
    const err = new Error('The photo file is missing (it may have moved to Recently deleted)');
    err.code = 'PHOTO_MISSING';
    throw err;
  }
  const buf = fs.readFileSync(abs);
  const intact = expectedSha256 ? sha256(buf) === expectedSha256 : null;
  if (!thumb) return { bytes: buf, mime: 'image/jpeg', intact };
  const sharp = require('sharp');
  const small = await sharp(buf).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  return { bytes: small, mime: 'image/jpeg', intact };
}

/* ─── staff photo ─────────────────────────────────────────────── */

async function saveStaffPhoto(employeeId, bytes) {
  const prepared = await preparePhoto(bytes, { maxEdge: 800 });
  const rel = `hr/employees/${safeName(employeeId)}/photo-${Date.now()}.jpg`;
  const abs = absPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, prepared.buffer, { flag: 'wx' });
  return { relPath: rel, sha256: prepared.sha256 };
}

/* ─── retention ───────────────────────────────────────────────── */

function monthsAgo(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

/**
 * Move evidence photos older than the retention window to Recently deleted.
 * The record keeps its photo row (marked retired, with the hash), so the
 * record still shows that a photo existed and when it was retired.
 */
function sweepRetention({ companyId = null, now = Date.now() } = {}) {
  const fuel = require('./db/fuel');
  const deletedItems = require('./deletedItems');
  const db = getDb();
  const companyIds = companyId ? [companyId] : db.prepare('SELECT DISTINCT company_id FROM fuel_photos WHERE retired_at IS NULL').all().map((r) => r.company_id);
  let retired = 0;
  let missing = 0;
  for (const cid of companyIds) {
    const months = fuel.getSettings(cid).photoRetentionMonths;
    const cutoff = monthsAgo(now, months);
    const rows = db.prepare(`
      SELECT * FROM fuel_photos p WHERE company_id = ? AND retired_at IS NULL AND uploaded_at < ?
         AND owner_kind IN (${EVIDENCE_OWNER_KINDS.map(() => '?').join(',')})
         -- Evidence for a flag still open, or one confirmed as theft, is kept
         -- whatever its age: retiring it would remove the proof.
         AND NOT EXISTS (
           SELECT 1 FROM fuel_flags fl
            WHERE (fl.subject_id = p.owner_id OR instr(fl.subject, p.owner_id) > 0)
              AND ((fl.status = 'open' AND fl.resolved_at IS NULL) OR fl.status = 'confirmed'))
         LIMIT 2000
    `).all(cid, cutoff, ...EVIDENCE_OWNER_KINDS);
    for (const row of rows) {
      const abs = absPath(row.rel_path);
      const exists = fs.existsSync(abs);
      let holdId = null;
      if (exists) {
        holdId = deletedItems.holdFuelPhoto({ photoRow: row, companyId: cid, label: `Fuel photo (${row.kind}) ${new Date(row.uploaded_at).toISOString().slice(0, 10)}` });
      } else {
        missing += 1;
      }
      db.prepare('UPDATE fuel_photos SET retired_at = ?, retired_reason = ?, recycle_item_id = ? WHERE id = ?')
        .run(now, `Older than ${months} months`, holdId, row.id);
      retired += 1;
    }
  }
  return { retired, missing };
}

module.exports = {
  MAX_PHOTO_BYTES, MAX_PHOTOS_PER_RECORD, MAX_PHOTOS_PER_RECORD_TOTAL, EVIDENCE_OWNER_KINDS,
  toBuffer, preparePhoto, prepareUploads, stagePhotos, readPhotoFile, saveStaffPhoto, sweepRetention, absPath, evidenceRelPath,
};
