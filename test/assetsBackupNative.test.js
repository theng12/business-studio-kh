/**
 * Fixed Assets A0: backups and server bundles carry fixed-assets/ (asset
 * photos and documents) — and RESTORE them. A top-level folder that is in
 * BACKUP_DATA_ENTRIES but not in ARCHIVE_TOP_LEVEL_DIRS is written fine and
 * then refused on restore (it happened with fuel/ in the first 0.1.95 draft),
 * so this drives the real backup → restore and bundle export → import with an
 * asset photo and a PDF and checks both come back byte-identical, with the
 * register and its journal entry.
 *
 * RUNNING THIS. Real SQLite + real tar: `npm run test:native` (listed there explicitly).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err?.message))) {
    skipReason = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`";
  } else {
    throw err;
  }
}

let userDataRoot = '';
const fakeElectron = { app: { getPath: () => userDataRoot, getVersion: () => 'test' } };

let db; let companies; let assets; let config; let fileIndex; let files; let createBackup; let restoreBackup; let exportBundle; let importBundle;
if (!skipReason) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  db = require('../main/db');
  companies = require('../main/db/companies');
  assets = require('../main/db/fixedAssets');
  config = require('../main/db/assetConfig');
  fileIndex = require('../main/db/assetFileIndex');
  files = require('../main/assetFiles');
  ({ createBackup, restoreBackup } = require('../main/backupManager'));
  ({ exportBundle, importBundle } = require('../main/serverBundle'));
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
function closeDb() { try { db.closeDb(); } catch (_) { /* not open */ } }

async function fixture() {
  closeDb();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mskh-assets-backup-'));
  userDataRoot = path.join(root, 'user-data');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(userDataRoot, { recursive: true });
  await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir, firstLaunchHandled: true }));
  db.initDb(dataDir);
  return { root, dataDir };
}

async function seed(dataDir) {
  const sharp = require('sharp');
  const jpg = await sharp({ create: { width: 500, height: 300, channels: 3, background: { r: 200, g: 90, b: 10 } } }).jpeg().toBuffer();
  const company = companies.create({ name: 'Backup Shop', isActive: true });
  const a = assets.create({ companyId: company.id, categoryId: config.categoryByKey(company.id, 'computer').id, name: 'iMac',
    purchaseDate: '2026-02-01', inServiceDate: '2026-02-01', costMinor: 150_000, usefulLifeMonths: 36 });
  const { entry } = assets.activate(a.id);
  const out = [];
  for (const [kind, bytes] of [['photo', jpg], ['invoice', Buffer.from('%PDF-1.4\n% invoice\n%%EOF')]]) {
    const prepared = await files.prepareFile(kind, bytes);
    const staged = files.stageFile({ assetId: a.id, kind, prepared });
    db.getDb().transaction(() => fileIndex.insert({ companyId: company.id, assetId: a.id, row: staged.row }))();
    staged.commit();
    out.push({ rel: staged.row.relPath, sha: sha(fs.readFileSync(path.join(dataDir, staged.row.relPath))) });
  }
  return { assetId: a.id, entryId: entry.id, files: out };
}

function assertBack(dataDir, s) {
  for (const f of s.files) {
    assert.ok(f.rel.startsWith('fixed-assets/'));
    assert.equal(sha(fs.readFileSync(path.join(dataDir, f.rel))), f.sha, f.rel);
  }
}

test('backup → restore brings back fixed-assets/ byte-identical, with the register and its entry', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const s = await seed(env.dataDir);
    const archive = await createBackup({ destDir: path.join(env.root, 'backups') });
    for (const f of s.files) fs.writeFileSync(path.join(env.dataDir, f.rel), 'changed');
    const restored = await restoreBackup({ backupPath: archive.backupPath });
    assert.equal(restored.success, true);
    closeDb();
    assertBack(env.dataDir, s);
    db.initDb(env.dataDir);
    assert.equal(assets.get(s.assetId).recordState, 'active');
    assert.equal(require('../main/db/ledger').getEntry(s.entryId).totalMinor, 150_000);
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('server bundle export → import carries fixed-assets/', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const s = await seed(env.dataDir);
    const bundle = await exportBundle({ outputPath: path.join(env.root, 'shop.iskhbundle') });
    closeDb();
    const target = path.join(env.root, 'import-target');
    await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir: target, firstLaunchHandled: true }));
    const imported = await importBundle({ bundlePath: bundle.bundlePath, targetDataDir: target });
    assert.equal(imported.success, true);
    assertBack(target, s);
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});
