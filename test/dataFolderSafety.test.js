const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadSettings({ dataDir, updateConfig, backupDb = null }) {
  const handlers = {};
  const fakeElectron = { app: {}, dialog: {}, shell: {} };
  const fakeConfig = {
    loadConfig: () => ({ dataDir }),
    updateConfig,
  };
  const fakeDb = backupDb ? { getDb: () => ({ backup: backupDb }) } : {};
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === '../config') return fakeConfig;
    if (request === '../db') return fakeDb;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../main/ipc/settings')];
    const { register } = require('../main/ipc/settings');
    register({ expose: () => {}, exposeLocal: (channel, handler) => { handlers[channel] = handler; } });
    return { handlers, restore: () => { Module._load = originalLoad; } };
  } finally {
    if (!backupDb) Module._load = originalLoad;
  }
}

test('data-folder move rejects a non-empty destination before changing config', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-data-folder-'));
  try {
    const oldPath = path.join(root, 'old');
    const newPath = path.join(root, 'new');
    await fsp.mkdir(path.join(oldPath, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(oldPath, 'database.sqlite'), 'old-db');
    await fsp.mkdir(newPath, { recursive: true });
    await fsp.writeFile(path.join(newPath, 'database.sqlite'), 'destination-db');
    const updates = [];
    const { handlers, restore } = loadSettings({ dataDir: oldPath, updateConfig: (patch) => updates.push(patch) });

    try {
      await assert.rejects(
        () => handlers['settings:changeDataFolder']({ newPath, move: true }),
        /empty|conflict|already contains/i,
      );
      assert.deepEqual(updates, []);
      assert.equal(await fsp.readFile(path.join(newPath, 'database.sqlite'), 'utf8'), 'destination-db');
      assert.equal(await fsp.readFile(path.join(oldPath, 'database.sqlite'), 'utf8'), 'old-db');
    } finally { restore(); }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('data-folder move rejects a destination nested inside the source', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-data-folder-nested-'));
  try {
    const oldPath = path.join(root, 'old');
    const newPath = path.join(oldPath, 'nested');
    await fsp.mkdir(oldPath, { recursive: true });
    await fsp.writeFile(path.join(oldPath, 'database.sqlite'), 'old-db');
    const updates = [];
    const { handlers, restore } = loadSettings({ dataDir: oldPath, updateConfig: (patch) => updates.push(patch) });

    try {
      await assert.rejects(
        () => handlers['settings:changeDataFolder']({ newPath, move: true }),
        /inside|overlap|source|destination|subdirectory/i,
      );
      assert.deepEqual(updates, []);
      assert.equal(fs.existsSync(newPath), false);
      assert.equal(await fsp.readFile(path.join(oldPath, 'database.sqlite'), 'utf8'), 'old-db');
    } finally { restore(); }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('successful data-folder move returns no source-cleanup authorization', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-data-folder-success-'));
  try {
    const oldPath = path.join(root, 'old');
    const newPath = path.join(root, 'new');
    await fsp.mkdir(path.join(oldPath, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(oldPath, 'database.sqlite'), 'old-db');
    await fsp.writeFile(path.join(oldPath, 'assets', 'photo.jpg'), 'photo');
    const updates = [];
    const { handlers, restore } = loadSettings({
      dataDir: oldPath,
      updateConfig: (patch) => updates.push(patch),
      backupDb: async (destination) => fsp.copyFile(path.join(oldPath, 'database.sqlite'), destination),
    });

    try {
      const result = await handlers['settings:changeDataFolder']({ newPath, move: true });
      assert.equal(result.newPath, newPath);
      assert.notEqual(result.oldStillHasData, true);
      assert.equal(await fsp.readFile(path.join(newPath, 'database.sqlite'), 'utf8'), 'old-db');
      assert.equal(await fsp.readFile(path.join(newPath, 'assets', 'photo.jpg'), 'utf8'), 'photo');
      assert.deepEqual(updates, [{ dataDir: newPath, firstLaunchHandled: true }]);
      assert.equal(fs.existsSync(path.join(oldPath, 'database.sqlite')), true);
    } finally { restore(); }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
