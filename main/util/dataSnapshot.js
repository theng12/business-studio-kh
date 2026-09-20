const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(filePath));
  return hash.digest('hex');
}

async function inventoryTree(rootDir, treeNames) {
  const entries = [];

  async function walk(absPath, relPath) {
    const stat = await fsp.lstat(absPath, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error(`Data folder contains a symbolic link: ${relPath}`);
    }
    const identity = {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
    if (stat.isDirectory()) {
      entries.push({ kind: 'directory', path: relPath, ...identity });
      for (const child of await fsp.readdir(absPath)) {
        await walk(path.join(absPath, child), path.join(relPath, child));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Data folder contains an unsupported entry: ${relPath}`);
    }
    entries.push({
      kind: 'file',
      path: relPath,
      size: Number(stat.size),
      sha256: await hashFile(absPath),
      ...identity,
    });
  }

  for (const name of treeNames) {
    const absPath = path.join(rootDir, name);
    try {
      await walk(absPath, name);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return entries;
}

function sameInventory(expected, actual, { includeIdentity = true } = {}) {
  const comparable = (entries) => includeIdentity
    ? entries
    : entries.map(({ dev, ino, ctimeNs, ...entry }) => entry);
  return JSON.stringify(comparable(expected)) === JSON.stringify(comparable(actual));
}

async function snapshotDataTrees(dataDir, treeNames) {
  return inventoryTree(dataDir, treeNames);
}

async function assertSnapshotUnchanged(dataDir, treeNames, expected, phase) {
  const actual = await inventoryTree(dataDir, treeNames);
  if (!sameInventory(expected, actual)) {
    throw new Error(`Data folder changed during ${phase}; retry when writes are idle`);
  }
  return actual;
}

async function copyDataTrees(dataDir, stagingRoot, treeNames, expected) {
  await assertSnapshotUnchanged(dataDir, treeNames, expected, 'snapshot staging');
  for (const name of treeNames) {
    const source = path.join(dataDir, name);
    const target = path.join(stagingRoot, name);
    try {
      await fsp.lstat(source);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  }
  await assertSnapshotUnchanged(dataDir, treeNames, expected, 'asset copy');
  const staged = await inventoryTree(stagingRoot, treeNames);
  if (!sameInventory(expected, staged, { includeIdentity: false })) {
    throw new Error('Staged data does not match the source snapshot; retry when writes are idle');
  }
  return treeNames.filter((name) => expected.some((entry) => entry.path === name));
}

module.exports = {
  snapshotDataTrees,
  assertSnapshotUnchanged,
  copyDataTrees,
};
