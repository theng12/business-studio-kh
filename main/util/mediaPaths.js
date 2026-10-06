const fs = require('node:fs');
const path = require('node:path');
const { canonicalizeExistingPath, isPathInside } = require('./backupSafety');
const { isHeicBuffer } = require('./heic');

// Keep the same relative-path contract for saved profiles, drafts and RPC files.
// Reject traversal rather than normalizing it into a different customer path.
function relativeMediaPath(value, label = 'Image path', allowEmpty = false) {
  if (allowEmpty && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value || value.includes('\0')
    || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\')
    || value.split(/[/\\]/).includes('..')) {
    throw new Error(`${label} must be a relative path without traversal`);
  }
  return value.replace(/\\/g, '/');
}

function exportSubfolder(value) {
  return relativeMediaPath(value, 'Output subfolder', true);
}

function canonicalMediaPath(input) {
  let cursor = path.resolve(input);
  for (;;) {
    try {
      // realpath's ENOENT fallback alone misses dangling leaf/ancestor links.
      if (fs.lstatSync(cursor).isSymbolicLink() && !fs.existsSync(cursor)) {
        throw new Error('Output/image path contains a dangling symlink');
      }
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      cursor = parent;
    }
  }
  return canonicalizeExistingPath(input);
}

// Existing ancestors and leaf symlinks must remain in the chosen root even
// when the final directory/file does not exist yet.
function containedMediaPath(root, rel, label = 'Output path', allowEmpty = false) {
  const safeRel = relativeMediaPath(rel, label, allowEmpty);
  const dest = path.resolve(root, safeRel);
  const canonicalRoot = canonicalMediaPath(root);
  const canonicalDest = canonicalMediaPath(dest);
  if (canonicalDest !== canonicalRoot && !isPathInside(canonicalRoot, canonicalDest)) {
    throw new Error(`${label} escapes its allowed root`);
  }
  return dest;
}

function artworkPath(dataDir, rel) {
  const safeRel = relativeMediaPath(rel, 'Artwork image path');
  const match = /^(assets|processed|ai-gallery)\/(.+)$/.exec(safeRel);
  const kind = match ? match[1] : 'assets';
  const imageRel = match ? match[2] : safeRel;
  const root = containedMediaPath(dataDir, kind, 'Artwork image root');
  return containedMediaPath(root, imageRel, 'Artwork image path');
}

// Byte signatures, not a filename's claimed extension, select the image MIME.
// ponytail: signatures identify the raster kind, not full decodability; use
// decoder verification if corrupt-image diagnostics require it. SVG/HTML and arbitrary files are
// never embedded as an image. HEIC detection is shared with the importer.
function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (isHeicBuffer(bytes)) return 'image/heic';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))) return 'image/avif';
  throw new Error('Artwork must contain a supported image (JPEG, PNG, WebP, HEIC or AVIF)');
}

// A missing valid reference keeps the existing empty-artwork behavior. Unsafe
// paths and nonmedia bytes are errors; never fall back to another filesystem root.
function readArtwork(dataDir, rel, { headerOnly = false } = {}) {
  if (rel == null || rel === '') return null;
  const abs = artworkPath(dataDir, rel);
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    if (!fs.fstatSync(fd).isFile()) throw new Error('Artwork must be an image file');
    let bytes;
    if (headerOnly) {
      bytes = Buffer.alloc(32);
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, size);
    } else bytes = fs.readFileSync(fd);
    return { abs, bytes, mime: imageMime(bytes) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { relativeMediaPath, exportSubfolder, containedMediaPath, artworkPath, readArtwork };
