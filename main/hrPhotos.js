/**
 * HR1: clock-in photos and staff documents on disk
 * (docs/PEOPLE_AND_FUEL_PLAN.md §3.1, §5.2, §7b; AGENTS.md §9 "Fuel and
 * staff photos are NOT assets").
 *
 *   - Clock-in photos: `<dataDir>/hr/attendance/<yyyy-mm>/<event-id>.jpg`,
 *     resized to fit 1280 px, JPEG, sha256 recorded on the event. Kept
 *     `photoRetentionMonths` (24), then moved to Recently deleted (kind
 *     `hr-photo`) and from there to the Trash; the event row stays.
 *   - Documents: `<dataDir>/hr/employees/<employee-id>/docs/<doc-id>.<ext>`.
 *     Images are resized to fit 2400 px and re-encoded as JPEG; PDFs are kept
 *     as sent (checked to start with %PDF). Documents are never swept —
 *     they are kept until voided, and a voided document keeps its file.
 *   - Neither folder is under assets/, so `/assets/` and `app-image://`
 *     cannot serve them; they are read only through `attendance:getPhoto` and
 *     `hr:readDocument` (both hr.manage). The kiosk and the phone never read a
 *     clock-in photo back.
 *   - `hr/` is already in BACKUP_DATA_ENTRIES and ARCHIVE_TOP_LEVEL_DIRS
 *     (main/util/backupSafety.js), so both travel in every backup.
 *
 * Writes go to a `.part` name first and are renamed only after the database
 * row is committed (same pattern as fuel evidence), so a failed insert never
 * leaves a file that looks like evidence.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb } = require('./db/index');
const fuelPhotos = require('./fuelPhotos');
const { ppMonth, ppDate } = require('./util/attendanceCalc');

const CLOCK_EDGE = 1280;
const DOC_EDGE = 2400;
const MAX_DOC_BYTES = 15 * 1024 * 1024;
const DOC_KINDS = ['id_card', 'contract', 'certificate', 'photo', 'other'];

function safeName(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60); }

function stageFile(rel, buffer) {
  const abs = fuelPhotos.absPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) throw new Error('A file with that name already exists');
  const tmp = `${abs}.${crypto.randomUUID()}.part`;
  fs.writeFileSync(tmp, buffer, { flag: 'wx' });
  return {
    commit: () => fs.renameSync(tmp, abs),
    abort: () => { try { fs.unlinkSync(tmp); } catch (_) { /* our own .part file */ } },
  };
}

/** Resize + stage a clock-in photo. Returns { relPath, sha256, commit, abort }. */
async function stageClockPhoto({ eventId, at, bytes }) {
  const prepared = await fuelPhotos.preparePhoto(bytes, { maxEdge: CLOCK_EDGE });
  const rel = `hr/attendance/${ppMonth(at)}/${safeName(eventId)}.jpg`;
  const staged = stageFile(rel, prepared.buffer);
  return { relPath: rel, sha256: prepared.sha256, ...staged };
}

function sniffPdf(buf) { return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-'; }

/** Stage a document: a PDF as sent, or a photo/scan resized to JPEG. */
async function stageDocument({ employeeId, docId, bytes }) {
  const buf = fuelPhotos.toBuffer(bytes);
  if (!buf.length) throw new Error('The file is empty');
  if (buf.length > MAX_DOC_BYTES) throw new Error(`The file is too large (over ${MAX_DOC_BYTES / 1024 / 1024} MB)`);
  let out;
  let ext;
  let mime;
  let originalSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (sniffPdf(buf)) {
    out = buf; ext = 'pdf'; mime = 'application/pdf';
  } else {
    const prepared = await fuelPhotos.preparePhoto(buf, { maxEdge: DOC_EDGE });
    out = prepared.buffer; ext = 'jpg'; mime = 'image/jpeg'; originalSha256 = prepared.originalSha256;
  }
  const rel = `hr/employees/${safeName(employeeId)}/docs/${safeName(docId)}.${ext}`;
  const staged = stageFile(rel, out);
  return { relPath: rel, mime, sha256: crypto.createHash('sha256').update(out).digest('hex'), originalSha256, bytes: out.length, ...staged };
}

/** Read a stored HR file. Images may be thumbnailed; the hash is checked on every read. */
async function readHrFile(rel, { thumb = false, expectedSha256 = null, mime = 'image/jpeg' } = {}) {
  if (mime === 'application/pdf') {
    const abs = fuelPhotos.absPath(rel);
    if (!fs.existsSync(abs)) { const err = new Error('The file is missing'); err.code = 'PHOTO_MISSING'; throw err; }
    const buf = fs.readFileSync(abs);
    const intact = expectedSha256 ? crypto.createHash('sha256').update(buf).digest('hex') === expectedSha256 : null;
    return { bytes: buf, mime, intact };
  }
  return fuelPhotos.readPhotoFile(rel, { thumb, expectedSha256 });
}

function monthsAgo(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

/**
 * Move clock-in photos older than the company's retention to Recently
 * deleted. Photos of an event still waiting for review are kept whatever their
 * age. Returns { retired, missing }.
 */
function sweepRetention({ companyId = null, now = Date.now() } = {}) {
  const db = getDb();
  const hr = require('./db/hr');
  const deletedItems = require('./deletedItems');
  const companyIds = companyId ? [companyId]
    : db.prepare('SELECT DISTINCT company_id FROM attendance_events WHERE photo_path IS NOT NULL AND photo_retired_at IS NULL').all().map((r) => r.company_id);
  let retired = 0;
  let missing = 0;
  for (const cid of companyIds) {
    const months = hr.getSettings(cid).photoRetentionMonths;
    const cutoff = monthsAgo(now, months);
    const rows = db.prepare(`SELECT id, at, photo_path, photo_sha256 FROM attendance_events
       WHERE company_id = ? AND photo_path IS NOT NULL AND photo_retired_at IS NULL AND at < ? AND review_status <> 'pending' LIMIT 2000`).all(cid, cutoff);
    for (const row of rows) {
      const exists = fs.existsSync(fuelPhotos.absPath(row.photo_path));
      let holdId = null;
      if (exists) {
        holdId = deletedItems.holdHrPhoto({ eventId: row.id, relPath: row.photo_path, sha256: row.photo_sha256, companyId: cid, label: `Clock-in photo ${ppDate(row.at)}` });
      } else {
        missing += 1;
      }
      db.prepare('UPDATE attendance_events SET photo_retired_at = ?, photo_recycle_item_id = ? WHERE id = ?').run(now, holdId, row.id);
      retired += 1;
    }
  }
  return { retired, missing };
}

module.exports = { DOC_KINDS, MAX_DOC_BYTES, stageClockPhoto, stageDocument, readHrFile, sweepRetention };
