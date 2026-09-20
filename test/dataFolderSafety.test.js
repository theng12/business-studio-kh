const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let Database = null;
let nativeSkipReason = false;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    nativeSkipReason = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`";
  } else {
    throw err;
  }
}

function loadSettings({ dataDir, updateConfig, backupDb = null }) {
  const handlers = {};
  const fakeElectron = {
    app: { relaunch() {}, exit() {} },
    dialog: {},
    shell: {},
  };
  const fakeConfig = {
    loadConfig: () => ({ dataDir }),
    updateConfig,
  };
  const fakeDb = {
    ...(backupDb ? { getDb: () => ({ backup: backupDb }) } : {}),
    closeDb() {},
    initDb() {},
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === '../config') return fakeConfig;
    if (request === '../db') return fakeDb;
    if (request === '../ai/queueRunner') return { stop: async () => {}, start() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
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

test('data-folder move rejects a symlink alias of the source', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-data-folder-alias-'));
  try {
    const oldPath = path.join(root, 'old');
    const aliasPath = path.join(root, 'old-alias');
    await fsp.mkdir(oldPath, { recursive: true });
    await fsp.writeFile(path.join(oldPath, 'database.sqlite'), 'old-db');
    await fsp.symlink(oldPath, aliasPath);
    const updates = [];
    const { handlers, restore } = loadSettings({ dataDir: oldPath, updateConfig: (patch) => updates.push(patch) });

    try {
      await assert.rejects(
        () => handlers['settings:changeDataFolder']({ newPath: aliasPath, move: true }),
        /current folder|overlap/i,
      );
      assert.deepEqual(updates, []);
      assert.equal(await fsp.readFile(path.join(oldPath, 'database.sqlite'), 'utf8'), 'old-db');
    } finally { restore(); }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('data-folder move rejects a missing destination nested under a symlink alias', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-data-folder-alias-child-'));
  try {
    const oldPath = path.join(root, 'old');
    const aliasPath = path.join(root, 'old-alias');
    const newPath = path.join(aliasPath, 'nested');
    await fsp.mkdir(oldPath, { recursive: true });
    await fsp.writeFile(path.join(oldPath, 'database.sqlite'), 'old-db');
    await fsp.symlink(oldPath, aliasPath);
    const updates = [];
    const { handlers, restore } = loadSettings({ dataDir: oldPath, updateConfig: (patch) => updates.push(patch) });

    try {
      await assert.rejects(
        () => handlers['settings:changeDataFolder']({ newPath, move: true }),
        /current folder|overlap/i,
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

test('data-folder move snapshots pending WAL frames into the destination database', { skip: nativeSkipReason }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-data-folder-wal-'));
  let db;
  try {
    const oldPath = path.join(root, 'old');
    const newPath = path.join(root, 'new');
    await fsp.mkdir(path.join(oldPath, 'assets'), { recursive: true });
    db = new Database(path.join(oldPath, 'database.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE fixture (value TEXT);');
    db.prepare('INSERT INTO fixture (value) VALUES (?)').run('pending-wal');
    assert.equal(fs.existsSync(path.join(oldPath, 'database.sqlite-wal')), true);

    const updates = [];
    const { handlers, restore } = loadSettings({
      dataDir: oldPath,
      updateConfig: (patch) => updates.push(patch),
      backupDb: (destination) => db.backup(destination),
    });
    try {
      await handlers['settings:changeDataFolder']({ newPath, move: true });
    } finally {
      restore();
    }

    const moved = new Database(path.join(newPath, 'database.sqlite'), { readonly: true });
    try {
      assert.equal(moved.prepare('SELECT value FROM fixture').get().value, 'pending-wal');
    } finally {
      moved.close();
    }
    assert.deepEqual(updates, [{ dataDir: newPath, firstLaunchHandled: true }]);
  } finally {
    db?.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
