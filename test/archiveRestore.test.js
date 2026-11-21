/**
 * Native archive boundary fixtures. These use real tar, real temporary folders,
 * and real better-sqlite3 because helper-only tests cannot prove that a failed
 * move leaves the original data folder usable.
 *
 * Plain `npm test` skips this file's cases when better-sqlite3 is compiled for
 * Electron's ABI. Run it with `ELECTRON_RUN_AS_NODE=1 electron --test
 * test/archiveRestore.test.js` (or include it in test:native).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');

let Database = null;
let skipReason = false;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`";
  } else {
    throw err;
  }
}

let userDataRoot = '';
const fakeElectron = {
  app: {
    getPath(name) {
      assert.equal(name, 'userData');
      return userDataRoot;
    },
    getVersion: () => 'test',
  },
};

let restoreBackup;
let importBundle;
if (!skipReason) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ restoreBackup } = require('../main/backupManager'));
  ({ importBundle } = require('../main/serverBundle'));
}

function writeDb(file, value, schemaVersion = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE fixture (value TEXT);');
  db.prepare('INSERT INTO fixture (value) VALUES (?)').run(value);
  db.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);');
  if (schemaVersion !== null) {
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run('schema_version', String(schemaVersion));
  }
  db.close();
}

function dbValue(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const value = db.prepare('SELECT value FROM fixture').get().value;
  db.close();
  return value;
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-task4-native-'));
  userDataRoot = path.join(root, 'user-data');
  const dataDir = path.join(root, 'live-data');
  await fsp.mkdir(userDataRoot, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir }));
  return { root, dataDir };
}

async function liveData(dataDir, marker = 'live') {
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.mkdir(dataDir, { recursive: true });
  writeDb(path.join(dataDir, 'database.sqlite'), marker);
  await fsp.writeFile(path.join(dataDir, 'live-marker.txt'), marker);
}

function makeArchive(root, kind, value, mutate, schemaVersion = 2, backupKind = 'business-studio-kh-backup') {
  const stageParent = fs.mkdtempSync(path.join(root, 'stage-'));
  const archiveRoot = path.join(stageParent, 'bundle');
  writeDb(path.join(archiveRoot, 'database.sqlite'), value, schemaVersion);
  const manifest = kind === 'backup'
    ? { kind: backupKind, backupFormatVersion: 1, appVersion: 'test', createdAt: Date.now(), includes: ['database.sqlite', 'assets/'] }
    : { bundleFormatVersion: 1, appVersion: 'test', createdAt: Date.now(), includes: ['database.sqlite', 'assets/'] };
  fs.writeFileSync(path.join(archiveRoot, 'manifest.json'), JSON.stringify(manifest));
  fs.mkdirSync(path.join(archiveRoot, 'assets'), { recursive: true });
  mutate?.(archiveRoot);
  const ext = kind === 'backup' ? '.iskhbackup' : '.iskhbundle';
  const archive = path.join(root, `${kind}-${value}${ext}`);
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stageParent, 'bundle']);
  return archive;
}

async function siblingNames(dataDir) {
  const parent = path.dirname(dataDir);
  const prefix = `${path.basename(dataDir)}.`;
  return (await fsp.readdir(parent)).filter((name) => name.startsWith(prefix));
}

test('a backup made by the OLD app (Business Studio KH) restores like a current one', { skip: skipReason }, async () => {
  // v0.1.82: the app was renamed, and the old build wrote
  // `kind: 'business-studio-kh-backup'`. The archive layout and the database schema
  // never changed, so the only thing standing between the owner and his old
  // data was that marker — recognised now, rather than rewritten.
  const env = await fixture();
  try {
    await liveData(env.dataDir, 'current');
    const archive = makeArchive(env.root, 'backup', 'legacy-data', null, 2, 'business-studio-kh-backup');
    const result = await restoreBackup({ backupPath: archive });
    assert.equal(result.success, true, 'an old backup restores');
    assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), 'legacy-data',
      'and its data is what lands in the data folder');
    assert.equal(await fsp.readFile(path.join(result.safetyDir, 'live-marker.txt'), 'utf8'), 'current',
      'the previous data is kept aside, as it is for any restore');
  } finally {
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('backup restore accepts a valid archive and retains the safety copy', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    await liveData(env.dataDir, 'old');
    const archive = makeArchive(env.root, 'backup', 'new');
    const result = await restoreBackup({ backupPath: archive });
    assert.equal(result.success, true);
    assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), 'new');
    assert.equal(await fsp.readFile(path.join(result.safetyDir, 'live-marker.txt'), 'utf8'), 'old');
  } finally {
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('backup restore rejects symlink and corrupt DB before touching live data', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    await liveData(env.dataDir, 'symlink-live');
    const symlinkArchive = makeArchive(env.root, 'backup', 'symlink', (archiveRoot) => {
      fs.symlinkSync('/tmp', path.join(archiveRoot, 'assets', 'link'));
    });
    await assert.rejects(() => restoreBackup({ backupPath: symlinkArchive }), /unsupported entry type|link entry/);
    assert.equal(await fsp.readFile(path.join(env.dataDir, 'live-marker.txt'), 'utf8'), 'symlink-live');
    assert.deepEqual(await siblingNames(env.dataDir), []);

    const corruptArchive = makeArchive(env.root, 'backup', 'corrupt', (archiveRoot) => {
      fs.writeFileSync(path.join(archiveRoot, 'database.sqlite'), 'not sqlite');
    });
    await assert.rejects(() => restoreBackup({ backupPath: corruptArchive }), /not a SQLite database|invalid/);
    assert.equal(await fsp.readFile(path.join(env.dataDir, 'live-marker.txt'), 'utf8'), 'symlink-live');
    assert.deepEqual(await siblingNames(env.dataDir), []);

    const missingArchive = makeArchive(env.root, 'backup', 'missing', (archiveRoot) => {
      fs.rmSync(path.join(archiveRoot, 'database.sqlite'));
    });
    await assert.rejects(() => restoreBackup({ backupPath: missingArchive }), /incomplete|database.sqlite/);
    assert.equal(await fsp.readFile(path.join(env.dataDir, 'live-marker.txt'), 'utf8'), 'symlink-live');
    assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), 'symlink-live');
    assert.deepEqual(await siblingNames(env.dataDir), []);
  } finally {
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('restore and import reject unsupported database schemas before touching live data', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    for (const schemaVersion of [1, 3, '2junk', '2.5', '2.0', '', null]) {
      await liveData(env.dataDir, `live-before-v${schemaVersion}`);
      const backup = makeArchive(env.root, 'backup', `backup-v${schemaVersion}`, null, schemaVersion);
      await assert.rejects(
        () => restoreBackup({ backupPath: backup }),
        /schema.*not supported|expected.*schema|schema.*version/i,
      );
      assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), `live-before-v${schemaVersion}`);
      assert.deepEqual(await siblingNames(env.dataDir), []);

      const bundle = makeArchive(env.root, 'bundle', `bundle-v${schemaVersion}`, null, schemaVersion);
      await assert.rejects(
        () => importBundle({ bundlePath: bundle, targetDataDir: env.dataDir }),
        /schema.*not supported|expected.*schema|schema.*version/i,
      );
      assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), `live-before-v${schemaVersion}`);
      assert.deepEqual(await siblingNames(env.dataDir), []);
    }
  } finally {
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('backup restore rolls back after a post-database move failure', { skip: skipReason }, async () => {
  const env = await fixture();
  const originalRename = fsp.rename;
  try {
    await liveData(env.dataDir, 'rollback-live');
    const archive = makeArchive(env.root, 'backup', 'partial');
    let databaseMoved = false;
    fsp.rename = async (from, to) => {
      if (databaseMoved && path.basename(from) === 'manifest.json') {
        throw new Error('fixture move failure after DB');
      }
      const result = await originalRename(from, to);
      if (path.basename(from) === 'database.sqlite') databaseMoved = true;
      return result;
    };
    await assert.rejects(() => restoreBackup({ backupPath: archive }), /fixture move failure/);
    assert.equal(await fsp.readFile(path.join(env.dataDir, 'live-marker.txt'), 'utf8'), 'rollback-live');
    assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), 'rollback-live');
    assert.deepEqual(await siblingNames(env.dataDir), []);
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('bundle import accepts valid data and protects live data on link or move failure', { skip: skipReason }, async () => {
  const env = await fixture();
  const originalRename = fsp.rename;
  try {
    await liveData(env.dataDir, 'bundle-live');
    const valid = makeArchive(env.root, 'bundle', 'bundle-new');
    const result = await importBundle({ bundlePath: valid, targetDataDir: env.dataDir });
    assert.equal(result.success, true);
    assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), 'bundle-new');

    await liveData(env.dataDir, 'bundle-link-live');
    const beforeLinkSiblings = await siblingNames(env.dataDir);
    const link = makeArchive(env.root, 'bundle', 'bundle-link', (archiveRoot) => {
      fs.symlinkSync('/tmp', path.join(archiveRoot, 'assets', 'link'));
    });
    await assert.rejects(() => importBundle({ bundlePath: link, targetDataDir: env.dataDir }), /unsupported entry type|link entry/);
    assert.equal(await fsp.readFile(path.join(env.dataDir, 'live-marker.txt'), 'utf8'), 'bundle-link-live');
    assert.deepEqual(await siblingNames(env.dataDir), beforeLinkSiblings);

    const partial = makeArchive(env.root, 'bundle', 'bundle-partial');
    const beforeMoveFailureSiblings = await siblingNames(env.dataDir);
    let databaseMoved = false;
    fsp.rename = async (from, to) => {
      if (databaseMoved && path.basename(from) === 'manifest.json') {
        throw new Error('fixture bundle move failure after DB');
      }
      const result = await originalRename(from, to);
      if (path.basename(from) === 'database.sqlite') databaseMoved = true;
      return result;
    };
    await assert.rejects(() => importBundle({ bundlePath: partial, targetDataDir: env.dataDir }), /fixture bundle move failure/);
    assert.equal(await fsp.readFile(path.join(env.dataDir, 'live-marker.txt'), 'utf8'), 'bundle-link-live');
    assert.equal(dbValue(path.join(env.dataDir, 'database.sqlite')), 'bundle-link-live');
    assert.deepEqual(await siblingNames(env.dataDir), beforeMoveFailureSiblings);
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});
