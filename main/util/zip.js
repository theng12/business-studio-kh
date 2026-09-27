/**
 * Minimal ZIP writer — "store" only, no compression.
 *
 * Why this exists: the phone viewer has to hand several finished overlay
 * images to a device as ONE file. Saving them one at a time meant one
 * full-size PNG per request (base64 inside a JSON reply), which is where the
 * "Load failed" reports came from; a zip turns N downloads into one.
 *
 * Why hand-rolled: no `archiver`/`jszip` dependency, the images inside are
 * already-compressed PNG/JPEG so deflating them again would cost CPU for
 * almost nothing, and the format's stored-entry subset is small enough to be
 * worth owning and testing (see test/zipWriter.test.js, which unpacks the
 * output with the system `unzip` rather than trusting our own reader).
 *
 * Deliberately NOT a general-purpose zip library: no compression, no zip64
 * (fine at these sizes, and it throws rather than writing a corrupt archive),
 * no encryption, no data descriptors.
 */
const { Buffer } = require('node:buffer');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what the format stores. */
function dosStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

/** `/` separators, no leading slash, no `..` — a zip entry name is a path. */
function safeEntryName(name) {
  const cleaned = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return cleaned || 'file';
}

const MAX_ENTRIES = 200;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;   // 512 MB: refuse rather than OOM

/**
 * Build a zip from `[{ name, data, date? }]`. Returns a Buffer.
 * Throws when the input would produce an archive this writer cannot describe
 * (too many entries, too large, or a size that needs zip64) — loudly, because
 * the alternative is a file the user cannot open.
 */
function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('createZip needs at least one entry');
  }
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`createZip: too many entries (${entries.length}, max ${MAX_ENTRIES})`);
  }

  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = safeEntryName(entry?.name);
    const data = Buffer.isBuffer(entry?.data) ? entry.data : Buffer.from(entry?.data ?? '');
    const nameBuf = Buffer.from(name, 'utf8');
    if (data.length > 0xffffffff) throw new Error('createZip: entry too large for a non-zip64 archive');

    const { time, date } = dosStamp(entry?.date);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);       // local file header
    local.writeUInt16LE(20, 4);               // version needed
    local.writeUInt16LE(0x0800, 6);           // UTF-8 names
    local.writeUInt16LE(0, 8);                // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);     // compressed size
    local.writeUInt32LE(data.length, 22);     // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);               // no extra field

    locals.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);         // central directory header
    dir.writeUInt16LE(20, 4);                 // version made by
    dir.writeUInt16LE(20, 6);                 // version needed
    dir.writeUInt16LE(0x0800, 8);             // UTF-8 names
    dir.writeUInt16LE(0, 10);                 // stored
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);                 // extra
    dir.writeUInt16LE(0, 32);                 // comment
    dir.writeUInt16LE(0, 34);                 // disk number
    dir.writeUInt16LE(0, 36);                 // internal attrs
    dir.writeUInt32LE(0, 38);                 // external attrs
    dir.writeUInt32LE(offset, 42);            // offset of local header
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
    if (offset > 0xffffffff) throw new Error('createZip: archive too large for a non-zip64 archive');
  }

  const centralBuf = Buffer.concat(central);
  if (offset + centralBuf.length > MAX_TOTAL_BYTES) {
    throw new Error('createZip: archive too large');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);           // end of central directory
  end.writeUInt16LE(0, 4);                    // this disk
  end.writeUInt16LE(0, 6);                    // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                   // no comment

  return Buffer.concat([...locals, centralBuf, end]);
}

module.exports = { createZip, crc32, safeEntryName };
