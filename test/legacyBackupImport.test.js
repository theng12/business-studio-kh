/**
 * "Can I import the old Business Studio KH backup into Business Studio KH?"
 *
 * The data itself is compatible — the database schema was 2 in the old app and
 * is 2 now (additive columns are added at boot), and the archive layout is the
 * same (this repo was seeded from that app). What stood in the way was two
 * name guards written when the app was renamed:
 *
 *   - `isBackupFilename` only listed `media-studio-kh-backup-…`, so an old file
 *     did not even appear in the restore list.
 *   - `validateManifest` only accepted `kind: 'media-studio-kh-backup'`, so a
 *     renamed file was then refused: "Not an Business Studio KH backup".
 *
 * This test builds a REAL archive in each shape and drives the real code, so
 * "the old backup still restores" is a checked claim rather than a promise.
 * Native because it snapshots a database through better-sqlite3.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run this test with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron";
  } else {
    throw err;
  }
}

const LEGACY_KIND = 'business-studio-kh-backup';

/**
 * A minimal but REAL backup archive: the same layout the app writes (a single
 * top-level folder holding manifest.json, database.sqlite, and the data
 * folders), packed with the system tar.
 */
function writeArchive({ dir, folderName, fileName, kind }) {
  const root = path.join(dir, folderName);
  fs.mkdirSync(path.join(root, 'assets', 'SKU-1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'SKU-1', '001.png'), 'not-a-real-png');
  const Database = require('better-sqlite3');
  const db = new Database(path.join(root, 'database.sqlite'));
  db.exec('CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT); CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);');
  db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run('schema_version', '2');
  db.prepare('INSERT INTO products (id, sku) VALUES (?, ?)').run('p1', 'LEGACY-1');
  db.close();
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    kind,
    backupFormatVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion: '0.49.40',
    includes: ['database.sqlite', 'assets'],
  }, null, 2));
  const out = path.join(dir, fileName);
  execFileSync('tar', ['-czf', out, '-C', dir, folderName]);
  return out;
}

function withModules(fn) {
  const originalLoad = Module._load;
  Module._load = function testLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() }, ipcMain: { handle() {}, on() {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn({
      backupManager: require('../main/backupManager.js'),
      safety: require('../main/util/backupSafety.js'),
    });
  } finally {
    Module._load = originalLoad;
  }
}

test('an Business Studio KH backup is still recognised, name and manifest', { skip: skipReason }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-legacy-backup-'));
  try {
    const legacy = writeArchive({
      dir, folderName: 'legacy-backup', fileName: 'business-studio-kh-backup-v0.49.40-2026-07-01.iskhbackup', kind: LEGACY_KIND,
    });
    const current = writeArchive({
      dir, folderName: 'current-backup', fileName: 'media-studio-kh-backup-v0.1.81-2026-09-27.iskhbackup', kind: 'media-studio-kh-backup',
    });

    const { safety, backupManager } = withModules((mods) => mods);

    assert.equal(safety.isBackupFilename(path.basename(legacy)), true,
      'the old name must list in the restore picker, not be filtered out as a stray file');
    assert.equal(safety.isBackupFilename(path.basename(current)), true, 'and today’s name still lists');

    const preview = await backupManager.previewBackup(legacy);
    assert.equal(preview.kind, LEGACY_KIND, 'the manifest is read, not rewritten');
    assert.equal(preview.appVersion, '0.49.40');

    const today = await backupManager.previewBackup(current);
    assert.equal(today.kind, 'media-studio-kh-backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that is not a backup at all is still refused', { skip: skipReason }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-legacy-refuse-'));
  try {
    const { safety, backupManager } = withModules((mods) => mods);
    assert.equal(safety.isBackupFilename('media-studio-kh-backup-note.txt'), false);
    assert.equal(safety.isBackupFilename('holiday-photos.iskhbackup'), false);

    // Right name, wrong manifest marker: the structural checks still run.
    const impostor = writeArchive({
      dir, folderName: 'impostor', fileName: 'media-studio-kh-backup-v9-2026-09-27.iskhbackup', kind: 'something-else',
    });
    await assert.rejects(() => backupManager.previewBackup(impostor), /not a .*backup|wrong or missing kind/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an Business Studio KH server bundle needs no allowance at all', () => {
  // The other migration route — Settings → Multi-Mac → Export server bundle —
  // checks the bundle FORMAT version and the archive structure, never an
  // app-name marker, so an old .iskhbundle imports as it stands.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'serverBundle.js'), 'utf8');
  assert.match(source, /BUNDLE_FORMAT_VERSION = 1/, 'format v1, unchanged since the fork');
  assert.doesNotMatch(source, /media-studio-kh-bundle|business-studio-kh-bundle/,
    'no app-name marker in the bundle path');
});
