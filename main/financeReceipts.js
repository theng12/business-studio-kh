/**
 * Finance §6: receipt photos — private evidence, not catalogue assets.
 *
 *   - Stored under `<dataDir>/finance/receipts/<yyyy-mm>/<company>_<expense>_<uuid>.jpg`.
 *     NOT under `assets/`, so neither `app-image://` nor the server's `/assets/`
 *     route can serve them (both only read assets/, processed/ and ai-gallery/).
 *     The lead's permission-checked `finance:getReceipt` channel is the only reader.
 *   - Bytes are decoded by CONTENT (sharp), never by the original filename's
 *     extension, capped at MAX_RECEIPT_BYTES before decode and 80 MP at decode,
 *     then re-encoded to a JPEG with EXIF orientation applied. This handles a
 *     phone photo (HEIC is transcoded through macOS `sips`, as main/fuelPhotos.js
 *     does) and strips any payload that is not a picture.
 *   - Paths are validated against a strict pattern and resolved with realpath
 *     before writing or reading, so a symlinked `finance/` folder cannot make a
 *     receipt land — or be read — outside the data folder.
 *   - No deletion here. Replacing or removing a receipt leaves the old file on
 *     disk; the lead's database metadata/audit is what tracks superseded rows,
 *     so the bytes stay recoverable (plan §6).
 *
 * shortcut: the realpath check and the write are separate syscalls, so a local
 * attacker who can already write inside dataDir could race it; such an attacker
 * already owns the data folder. Revisit if a remote write path is ever added.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('./util/sharpLimits');
const { getDataDir } = require('./db/index');
const { canonicalizeExistingPath, isPathInside } = require('./util/backupSafety');

const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 80_000_000;
const MAX_ORIGINAL_NAME = 200;
const MAX_ID = 200;

// Company and expense ids are uuids (main/db uses crypto.randomUUID). Keep them
// to a filename-safe charset so they cannot introduce a path segment.
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
// The only relative path readReceipt will touch. Anything else is refused
// before the filesystem is consulted.
const REL_RE = /^finance\/receipts\/\d{4}-\d{2}\/[A-Za-z0-9_-]+\.jpg$/;

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes && bytes.__bin === true && typeof bytes.b64 === 'string') return Buffer.from(bytes.b64, 'base64');
  throw new Error('Receipt photo bytes are missing');
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function monthDir(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}`;
}

function requireId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error(`${label} must be a safe id of at most ${MAX_ID} characters`);
  }
  return value;
}

function normalizeOriginalName(name) {
  if (name == null) return '';
  if (typeof name !== 'string') throw new Error('originalName must be text');
  if (name.length > MAX_ORIGINAL_NAME) {
    throw new Error(`originalName must be at most ${MAX_ORIGINAL_NAME} characters`);
  }
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) throw new Error('originalName contains control characters');
  }
  return name;
}

/**
 * Validate a receipt relative path and resolve it to an absolute path that is
 * provably inside `<dataDir>/finance/receipts`. Realpath-resolves every
 * existing component, so a symlinked `finance/` or `receipts/` (or a symlinked
 * receipt file, on read) is refused rather than followed.
 */
function safeAbs(rel) {
  if (typeof rel !== 'string' || !REL_RE.test(rel)) {
    throw new Error('Receipt path is not a valid finance receipt path');
  }
  const dataRoot = canonicalizeExistingPath(getDataDir());
  const receiptsRoot = path.join(dataRoot, 'finance', 'receipts');
  const resolved = canonicalizeExistingPath(path.join(dataRoot, ...rel.split('/')));
  if (!isPathInside(receiptsRoot, resolved)) {
    throw new Error('Receipt path escapes the data folder');
  }
  return resolved;
}

async function decodableBuffer(buf) {
  const { isHeicBuffer, ensureDecodablePath } = require('./util/heic');
  if (!isHeicBuffer(buf) || process.platform !== 'darwin') return buf;
  const root = canonicalizeExistingPath(getDataDir());
  const scratch = canonicalizeExistingPath(path.join(root, 'finance', '_trash', 'receipt-scratch'));
  if (!isPathInside(path.join(root, 'finance'), scratch)) throw new Error('Receipt scratch path escapes the data folder');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const input = path.join(scratch, `receipt-${crypto.randomUUID()}.heic`);
  fs.writeFileSync(input, buf, { flag: 'wx', mode: 0o600 });
  // Keep both conversion files in private data trash, including in the packaged app.
  const res = await ensureDecodablePath(input, { outputDir: scratch });
  fs.chmodSync(res.path, 0o600);
  return fs.readFileSync(res.path);
}

/** Decode by content and re-encode with EXIF orientation applied. */
async function toJpeg(input) {
  const sharp = require('sharp');
  try {
    const source = await decodableBuffer(input);
    return await sharp(source, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (err) {
    throw new Error(`That file is not a photo the app can read (${err.message})`, { cause: err });
  }
}

/**
 * Store one receipt photo. The caller (lead's IPC handler) has already checked
 * the caller's company/branch permission; this function still validates the ids
 * and the name, and never accepts a filesystem path.
 *
 * Returns the metadata the lead records in the database:
 *   { relativePath, mime, sha256, originalName, size }
 */
async function storeReceipt({ companyId, expenseId, bytes, originalName } = {}) {
  requireId(companyId, 'companyId');
  requireId(expenseId, 'expenseId');
  const name = normalizeOriginalName(originalName);
  const input = toBuffer(bytes);

  if (!input.length) throw new Error('The receipt photo is empty');
  // Size is checked before any decode work: an oversized file never reaches sharp.
  if (input.length > MAX_RECEIPT_BYTES) {
    throw new Error(`Receipt photo is too large (max ${MAX_RECEIPT_BYTES / 1024 / 1024} MB)`);
  }

  const jpeg = await toJpeg(input);
  // Ids are capped in the filename so two maximum-length ids still leave the
  // name well under macOS's 255-byte NAME_MAX; the uuid keeps it unique.
  const rel = `finance/receipts/${monthDir()}/${companyId.slice(0, 40)}_${expenseId.slice(0, 40)}_${crypto.randomUUID()}.jpg`;
  const abs = safeAbs(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // wx: fail rather than follow or overwrite anything already at this path.
  fs.writeFileSync(abs, jpeg, { flag: 'wx' });

  return { relativePath: rel, mime: 'image/jpeg', sha256: sha256(jpeg), originalName: name, size: jpeg.length };
}

/**
 * Read a stored receipt for the renderer as a data URL. `metadata` is the row
 * the lead stored from storeReceipt. Validates the recorded path, refuses any
 * symlink that resolves outside the receipts folder, and (when present) checks
 * the recorded sha256 so a swapped file is reported rather than shown.
 */
function readReceipt(metadata) {
  if (!metadata || typeof metadata !== 'object') throw new Error('Receipt metadata is missing');
  const abs = safeAbs(metadata.relativePath);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('The receipt photo file is missing', { cause: err });
    throw err;
  }
  if (typeof metadata.sha256 === 'string' && metadata.sha256 && sha256(buf) !== metadata.sha256) {
    throw new Error('The receipt photo file does not match its recorded checksum');
  }
  const originalName = typeof metadata.originalName === 'string' ? metadata.originalName : '';
  // Stored files are always JPEG (storeReceipt re-encodes), so the type is fixed
  // here rather than trusted from the stored metadata.
  return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, originalName };
}

module.exports = { MAX_RECEIPT_BYTES, storeReceipt, readReceipt };
