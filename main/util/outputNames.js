/**
 * Output file names a PERSON reads — the catalog PDF, the label PDF / PNGs.
 * Shared by standalone, server and client mode (AGENTS.md §15: a rule both
 * modes must agree on cannot live inside one mode's handler).
 *
 *   - Khmer survives: `slugifyUnicode`, not the ASCII `slugify`, which turned
 *     a Khmer catalog name into `catalog-…` and a Khmer label template name
 *     into `labels-…`.
 *   - The date is readable: `price-list-2026-10-08-1432.pdf`, not
 *     `catalog-1759912345678.pdf`. Minutes, not seconds; two exports in the
 *     same minute get `-2` (claimed at write time by writeUniqueFile) rather than
 *     overwriting each other.
 *
 * Pure apart from the optional `exists` check, so `npm test` covers it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { slugifyUnicode } = require('./slug');

function readableStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function outputBaseName(name, fallback, d = new Date()) {
  return `${slugifyUnicode(name, fallback)}-${readableStamp(d)}`;
}

/**
 * `<folder>/<base>.<ext>`, or `<base>-2.<ext>`, `-3`… when that is taken.
 *
 * A CHECK only, so never pick a name with this and write it later: two
 * exports in the same minute both saw the name free and the second
 * overwrote the first (audit 2026-10). Writers claim the name when the bytes
 * are written instead — `writeUniqueFile` (main/util/exclusiveFile.js, `wx`
 * with the same `-2`, `-3` suffixes), or `toPdf(…, { unique: true })`.
 */
function freeOutputPath(folder, base, ext, exists = fs.existsSync) {
  let candidate = path.join(folder, `${base}.${ext}`);
  for (let i = 2; exists(candidate); i += 1) candidate = path.join(folder, `${base}-${i}.${ext}`);
  return candidate;
}

module.exports = { readableStamp, outputBaseName, freeOutputPath };
