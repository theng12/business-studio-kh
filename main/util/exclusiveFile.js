const path = require('node:path');
const fsp = require('node:fs/promises');

async function writeExclusiveFile(filePath, bytes) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'wx');
    await handle.writeFile(bytes);
    await handle.close();
    return filePath;
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch (_) { /* original error wins */ }
      try { await fsp.rm(filePath, { force: true }); } catch (_) { /* best effort */ }
    }
    throw err;
  }
}

/** Write bytes under a collision-safe name without a check/write race. */
async function writeUniqueFile(folder, desiredName, bytes) {
  const safeName = path.basename(String(desiredName || 'file'));
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('A valid filename is required');
  const parsed = path.parse(safeName);
  let suffix = 1;

  for (;;) {
    const name = suffix === 1 ? safeName : `${parsed.name}-${suffix}${parsed.ext}`;
    const filePath = path.join(folder, name);
    try {
      return await writeExclusiveFile(filePath, bytes);
    } catch (err) {
      if (err.code === 'EEXIST') {
        suffix += 1;
        continue;
      }
      throw err;
    }
  }
}

module.exports = { writeExclusiveFile, writeUniqueFile };
