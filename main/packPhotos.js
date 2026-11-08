/**
 * Pick & Pack — parcel photo evidence (docs/PICK_AND_PACK_PLAN.md §4, §7).
 *
 * Stored under `<dataDir>/pack/<yyyy-mm>/<order-id>/<kind>-<n>.jpg` — NOT
 * under `assets/`, so `/assets/` and `app-image://` cannot reach them. They are
 * read only through the permission-checked `pack:getPhoto` channel.
 *
 * The resize + hash pipeline is the same one fuel evidence uses
 * (main/fuelPhotos.js `preparePhoto`); only the folder is different. The
 * stored file's sha256 is kept on the row, so a swapped file shows.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir } = require('./db/index');
const { preparePhoto } = require('./fuelPhotos');
const { phnomPenhMonth } = require('./util/fuelAnomalies');

const THUMB_EDGE = 640;

function safeName(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60); }

function absPath(rel) {
  const root = getDataDir();
  const abs = path.normalize(path.join(root, rel));
  if (!abs.startsWith(path.join(root, 'pack') + path.sep)) throw new Error('Photo path outside the pack folder');
  return abs;
}

/** Resize, hash and write one parcel photo. Returns the row facts for parcel_photos. */
async function saveParcelPhoto(orderId, kind, bytes) {
  const prepared = await preparePhoto(bytes);
  const dir = `pack/${phnomPenhMonth(Date.now())}/${safeName(orderId)}`;
  const base = `${safeName(kind)}`;
  let rel;
  for (let n = 1; n < 1000; n += 1) {
    rel = `${dir}/${n === 1 ? base : `${base}-${n}`}.jpg`;
    if (!fs.existsSync(absPath(rel))) break;
    rel = null;
  }
  if (!rel) throw new Error('Too many photos on this parcel');
  const abs = absPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, prepared.buffer, { flag: 'wx' });
  return {
    relPath: rel,
    sha256: prepared.sha256,
    bytes: prepared.bytes,
    width: prepared.width,
    height: prepared.height,
  };
}

/** Read a stored photo (or a thumbnail), checking the hash on full reads. */
async function readParcelPhoto(rel, { thumb = false, expectedSha256 = null } = {}) {
  const abs = absPath(rel);
  if (!fs.existsSync(abs)) {
    const err = new Error('The photo file is missing');
    err.code = 'PHOTO_MISSING';
    throw err;
  }
  const buf = fs.readFileSync(abs);
  const intact = expectedSha256 ? crypto.createHash('sha256').update(buf).digest('hex') === expectedSha256 : null;
  if (!thumb) return { bytes: buf, mime: 'image/jpeg', intact };
  const sharp = require('sharp');
  const small = await sharp(buf).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 }).toBuffer();
  return { bytes: small, mime: 'image/jpeg', intact };
}

module.exports = { saveParcelPhoto, readParcelPhoto };
