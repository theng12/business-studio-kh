const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let Database = null;
let skipReason = false;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/archiveRoundTrip.test.js";
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

let db;
let companies;
let products;
let productImages;
let createBackup;
let restoreBackup;
let exportBundle;
let importBundle;
if (!skipReason) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  db = require('../main/db');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  productImages = require('../main/db/productImages');
  ({ createBackup, restoreBackup } = require('../main/backupManager'));
  ({ exportBundle, importBundle } = require('../main/serverBundle'));
}

function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

function closeDb() {
  try { db.closeDb(); } catch (_) {}
}

async function fixture() {
  closeDb();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-archive-roundtrip-'));
  userDataRoot = path.join(root, 'user-data');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(userDataRoot, { recursive: true });
  await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir, firstLaunchHandled: true }));
  db.initDb(dataDir);
  return { root, dataDir };
}

function seedData(dataDir) {
  const company = companies.create({ name: 'Archive Company', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'ARCHIVE-001', name: 'Archive product' });
  const originalPath = 'Archive-Company/_unassigned/ARCHIVE-001/ARCHIVE-001-001.bin';
  const processedPath = 'processed/ARCHIVE-001-001.bin';
  const originalBytes = Buffer.from('synthetic-original-image-bytes');
  const processedBytes = Buffer.from('synthetic-processed-image-bytes');
  fs.mkdirSync(path.dirname(path.join(dataDir, 'assets', originalPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(dataDir, processedPath)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'assets', originalPath), originalBytes);
  fs.writeFileSync(path.join(dataDir, processedPath), processedBytes);
  productImages.addRow(product.id, {
    filepath: originalPath,
    filename: path.posix.basename(originalPath),
    originalFilepath: originalPath,
    contentHash: sha1(originalBytes),
    orderIndex: 0,
  });
  productImages.setProcessed(product.id, originalPath, {
    isProcessed: true,
    processedFilepath: processedPath,
    workspaceSettings: { synthetic: true },
  });

  const pendingWalProduct = products.create({
    companyId: company.id,
    sku: 'PENDING-WAL-001',
    name: 'Pending WAL row',
  });
  assert.equal(db.getDb().pragma('journal_mode', { simple: true }), 'wal');
  assert.ok(fs.existsSync(path.join(dataDir, 'database.sqlite-wal')), 'fixture should hold a live WAL');
  return { product, pendingWalProduct, originalPath, processedPath, originalBytes, processedBytes };
}

function assertRestored(dataDir, expected) {
  const database = new Database(path.join(dataDir, 'database.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const image = database.prepare('SELECT * FROM product_images WHERE product_id = ?').get(expected.product.id);
    const pending = database.prepare('SELECT * FROM products WHERE id = ?').get(expected.pendingWalProduct.id);
    assert.equal(image.filepath, expected.originalPath);
    assert.equal(image.processed_filepath, expected.processedPath);
    assert.equal(image.content_hash, sha1(expected.originalBytes));
    assert.equal(image.is_processed, 1);
    assert.equal(pending.sku, 'PENDING-WAL-001', 'online SQLite snapshot must include the pending WAL row');
  } finally {
    database.close();
  }
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'assets', expected.originalPath)), expected.originalBytes);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, expected.processedPath)), expected.processedBytes);
  assert.equal(sha1(fs.readFileSync(path.join(dataDir, 'assets', expected.originalPath))), sha1(expected.originalBytes));
  assert.equal(sha1(fs.readFileSync(path.join(dataDir, expected.processedPath))), sha1(expected.processedBytes));
}

test('createBackup then restoreBackup round-trips real SQLite, WAL, and original/processed assets', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const expected = seedData(env.dataDir);
    const archive = await createBackup({ destDir: path.join(env.root, 'backups') });
    assert.ok(fs.statSync(archive.backupPath).size > 0, 'createBackup should produce a real archive');
    await fsp.writeFile(path.join(env.dataDir, 'mutated-after-backup.txt'), 'replace me');
    const restored = await restoreBackup({ backupPath: archive.backupPath });
    assert.equal(restored.success, true);
    closeDb();
    assertRestored(env.dataDir, expected);
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('exportBundle then importBundle round-trips real SQLite, WAL, and original/processed assets', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const expected = seedData(env.dataDir);
    const bundlePath = path.join(env.root, 'archive.iskhbundle');
    const bundle = await exportBundle({ outputPath: bundlePath });
    assert.ok(fs.statSync(bundle.bundlePath).size > 0, 'exportBundle should produce a real archive');

    closeDb();
    const targetDataDir = path.join(env.root, 'import-target');
    db.initDb(targetDataDir);
    fs.writeFileSync(path.join(targetDataDir, 'replace-me.txt'), 'old target data');
    closeDb();
    await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir: targetDataDir, firstLaunchHandled: true }));

    const imported = await importBundle({ bundlePath: bundle.bundlePath, targetDataDir });
    assert.equal(imported.success, true);
    assertRestored(targetDataDir, expected);
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});
