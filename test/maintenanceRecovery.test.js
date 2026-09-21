const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

let Database;
let skip = false;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err.code !== 'ERR_DLOPEN_FAILED') throw err;
  skip = 'Run with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test';
}

// Real config, real SQLite/WAL, real IPC registration; only desktop/process and
// provider boundaries are faked. All fault injection remains in this fixture.
async function fixture(t, { failRelaunch = false, failAfterConfig = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-maintenance-recovery-'));
  const dataDir = path.join(root, 'live');
  const userData = path.join(root, 'user-data');
  const handlers = new Map();
  const calls = [];
  let failurePending = failAfterConfig;
  const originalLoad = Module._load;
  const modules = [
    '../main/config', '../main/util/maintenanceLifecycle', '../main/ipc/helpers',
    '../main/serverBundle', '../main/backupManager', '../main/ipc/serverBundle',
    '../main/ipc/backups', '../main/ipc/settings',
  ];
  for (const name of modules) delete require.cache[require.resolve(name)];
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return {
      app: {
        getPath: () => userData, getVersion: () => 'test',
        relaunch() { calls.push('relaunch'); if (failRelaunch) throw new Error('fixture relaunch failure'); },
        exit() { calls.push('exit'); },
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {}, shell: {},
    };
    if (request === '../server') return { registerHandler() {}, getCurrentUserId: () => null };
    if (request === '../ai/queueRunner') return {
      stop: async () => calls.push('stop'), start: () => calls.push('start'),
    };
    if (request === '../events') return { broadcast(channel, payload) {
      if (failurePending && channel === 'progress:event' && payload.phase === 'done') {
        failurePending = false;
        throw new Error('fixture failure after config merge');
      }
    } };
    return originalLoad.call(this, request, parent, isMain);
  };
  const db = require('../main/db');
  t.after(async () => {
    db.closeDb();
    Module._load = originalLoad;
    for (const name of modules) delete require.cache[require.resolve(name)];
    await fsp.rm(root, { recursive: true, force: true });
  });
  const config = require('../main/config');
  config.saveConfig({ dataDir, openaiConcurrency: 3, firstLaunchHandled: false });
  db.initDb(dataDir);
  db.getDb().pragma('wal_autocheckpoint = 0');
  db.setAppState('fixture', 'original');
  assert.ok(fs.statSync(path.join(dataDir, 'database.sqlite-wal')).size > 32);
  await fsp.mkdir(path.join(dataDir, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'assets', 'marker.txt'), 'original');
  const helpers = require('../main/ipc/helpers');
  for (const name of ['serverBundle', 'backups', 'settings']) {
    require(`../main/ipc/${name}`).register(helpers);
  }
  const maintenance = require('../main/util/maintenanceLifecycle');
  return { root, dataDir, calls, db, config, maintenance,
    invoke: (channel, args) => handlers.get(channel)({}, args) };
}

function archive(env, kind) {
  const stage = path.join(env.root, 'bundle');
  fs.mkdirSync(path.join(stage, 'assets'), { recursive: true });
  const db = new Database(path.join(stage, 'database.sqlite'));
  db.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO app_state VALUES (?, ?)').run('schema_version', '2');
  db.prepare('INSERT INTO app_state VALUES (?, ?)').run('fixture', 'imported');
  db.close();
  fs.writeFileSync(path.join(stage, 'assets', 'marker.txt'), 'imported');
  fs.writeFileSync(path.join(stage, kind === 'bundle' ? 'config.partial.json' : 'config.json'),
    JSON.stringify({ openaiConcurrency: 9, customPresets: [{ name: 'dummy' }] }));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
    ...(kind === 'bundle' ? { bundleFormatVersion: 1 } : { backupFormatVersion: 1, kind: 'media-studio-kh-backup' }),
    appVersion: 'test', createdAt: Date.now(), includes: ['database.sqlite', 'assets/'],
  }));
  const archivePath = path.join(env.root, `fixture.iskh${kind}`);
  execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', env.root, 'bundle']);
  return archivePath;
}

function importArchive(env, kind, archivePath) {
  return kind === 'bundle'
    ? env.invoke('servers:importBundle', { bundlePath: archivePath, targetDataDir: env.dataDir })
    : env.invoke('backups:restore', { backupPath: archivePath });
}

function diskState(dataDir, key) {
  const disk = new Database(path.join(dataDir, 'database.sqlite'), { readonly: true, fileMustExist: true });
  try { return disk.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value; }
  finally { disk.close(); }
}

for (const kind of ['bundle', 'backup']) {
  test(`${kind}: rollback completes before reopening the original WAL database`, { skip }, async (t) => {
    const env = await fixture(t);
    const archivePath = archive(env, kind);
    const originalRename = fsp.rename;
    let databaseMoved = false;
    fsp.rename = async (from, to) => {
      if (databaseMoved && path.basename(from) === 'manifest.json') throw new Error('fixture post-database failure');
      const result = await originalRename(from, to);
      if (path.basename(from) === 'database.sqlite') databaseMoved = true;
      return result;
    };
    try { await assert.rejects(importArchive(env, kind, archivePath), /fixture post-database failure/); }
    finally { fsp.rename = originalRename; }
    assert.equal(env.maintenance.isMaintenanceActive(), false);
    await env.maintenance.runTrackedOperation('test:recovered-write', () => env.db.setAppState('late-write', 'visible'));
    assert.equal(diskState(env.dataDir, 'late-write'), 'visible');
    assert.equal(env.db.getAppState('fixture'), 'original');
    assert.equal(diskState(env.dataDir, 'fixture'), 'original');
  });

  test(`${kind}: portable config and assets roll back before queue recovery`, { skip }, async (t) => {
    const env = await fixture(t, { failAfterConfig: true });
    const before = env.config.loadConfig();
    await assert.rejects(importArchive(env, kind, archive(env, kind)), /fixture failure after config merge/);
    assert.equal(env.config.loadConfig().openaiConcurrency, 3);
    assert.deepEqual(env.config.loadConfig().customPresets, before.customPresets);
    assert.equal(fs.readFileSync(path.join(env.dataDir, 'assets', 'marker.txt'), 'utf8'), 'original');
    env.db.setAppState('late-write', 'visible');
    assert.equal(diskState(env.dataDir, 'late-write'), 'visible');
    assert.equal(env.maintenance.isMaintenanceActive(), false);
  });

  test(`${kind}: committed archive and config survive a failed relaunch`, { skip }, async (t) => {
    const env = await fixture(t, { failRelaunch: true });
    await assert.rejects(importArchive(env, kind, archive(env, kind)), { code: 'MAINTENANCE_RESTART_FAILED' });
    assert.equal(diskState(env.dataDir, 'fixture'), 'imported');
    assert.equal(env.config.loadConfig().openaiConcurrency, 9);
    assert.equal(fs.readFileSync(path.join(env.dataDir, 'assets', 'marker.txt'), 'utf8'), 'imported');
    assert.equal(env.maintenance.isMaintenanceActive(), true);
    assert.equal(env.calls.includes('start'), false);
  });

  for (const fault of ['folder', 'config']) {
    test(`${kind}: failed ${fault} rollback keeps the database closed and safety folder reachable`, { skip }, async (t) => {
      const env = await fixture(t, { failAfterConfig: true });
      const originalRename = fsp.rename;
      const originalUpdate = env.config.updateConfig;
      fsp.rename = async (from, to) => {
        if (fault === 'folder' && /\.(bak|pre-restore)\./.test(from)) throw new Error('fixture rollback failure');
        return originalRename(from, to);
      };
      env.config.updateConfig = (patch) => {
        if (fault === 'config' && patch.openaiConcurrency === 3) throw new Error('fixture rollback failure');
        return originalUpdate(patch);
      };
      let failure;
      try {
        await assert.rejects(importArchive(env, kind, archive(env, kind)), (err) => {
          failure = err;
          return err.code === 'MAINTENANCE_ROLLBACK_FAILED';
        });
      } finally {
        fsp.rename = originalRename;
        env.config.updateConfig = originalUpdate;
      }
      assert.equal(env.maintenance.isMaintenanceActive(), true);
      assert.throws(() => env.db.getDb(), /not initialized/);
      assert.equal(env.calls.includes('start'), false);
      assert.equal(env.calls.includes('relaunch'), false);
      // Folder restore failure keeps the original in its named safety folder;
      // config restore failure still allows the original folder to be restored.
      const originalPath = fault === 'folder'
        ? path.join(env.root, fs.readdirSync(env.root).find((name) => /^live\.(bak|pre-restore)\./.test(name)))
        : env.dataDir;
      assert.equal(diskState(originalPath, 'fixture'), 'original');
      assert.ok(failure.message.includes(originalPath));
    });
  }
}

for (const move of [true, false]) {
  test(`data folder: committed target survives relaunch failure (move=${move})`, { skip }, async (t) => {
    const env = await fixture(t, { failRelaunch: true });
    const next = path.join(env.root, 'next');
    const oldHandle = env.db.getDb();
    await assert.rejects(env.invoke('settings:changeDataFolder', { newPath: next, move }),
      { code: 'MAINTENANCE_RESTART_FAILED' });
    assert.equal(fs.existsSync(next), true);
    assert.equal(env.config.loadConfig().dataDir, next);
    assert.equal(oldHandle.open, false);
    if (move) {
      assert.equal(diskState(next, 'fixture'), 'original');
      assert.equal(fs.readFileSync(path.join(next, 'assets', 'marker.txt'), 'utf8'), 'original');
    } else {
      assert.deepEqual(fs.readdirSync(next), []);
    }
    assert.equal(diskState(env.dataDir, 'fixture'), 'original');
    assert.equal(env.maintenance.isMaintenanceActive(), true);
  });
}

for (const failRecovery of [false, true]) {
  test(`data folder: config write failure recovers or remains blocked (rollback failure=${failRecovery})`, { skip }, async (t) => {
    const env = await fixture(t);
    const next = path.join(env.root, 'next');
    const originalUpdate = env.config.updateConfig;
    env.config.updateConfig = (patch) => {
      if (patch.dataDir === next) {
        originalUpdate(patch);
        throw new Error('fixture failure after config persistence');
      }
      if (failRecovery) throw new Error('fixture config rollback failure');
      return originalUpdate(patch);
    };
    try {
      await assert.rejects(env.invoke('settings:changeDataFolder', { newPath: next, move: true }),
        failRecovery ? { code: 'MAINTENANCE_ROLLBACK_FAILED' } : /fixture failure after config persistence/);
    } finally { env.config.updateConfig = originalUpdate; }
    assert.equal(env.maintenance.isMaintenanceActive(), failRecovery);
    assert.equal(diskState(env.dataDir, 'fixture'), 'original');
    if (failRecovery) {
      assert.throws(() => env.db.getDb(), /not initialized/);
      assert.equal(diskState(next, 'fixture'), 'original');
      assert.equal(env.config.loadConfig().dataDir, next);
      assert.equal(env.calls.includes('start'), false);
    } else {
      assert.equal(env.config.loadConfig().dataDir, env.dataDir);
      assert.equal(env.config.loadConfig().firstLaunchHandled, false);
      assert.equal(fs.existsSync(next), false);
      env.db.setAppState('late-write', 'visible');
      assert.equal(diskState(env.dataDir, 'late-write'), 'visible');
    }
  });
}
