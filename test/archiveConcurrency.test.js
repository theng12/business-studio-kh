const test = require('node:test');
const assert = require('node:assert/strict');
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
    skipReason = "better-sqlite3 is built for Electron's ABI — run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/archiveConcurrency.test.js";
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
let snapshotDataTrees;
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
  ({ snapshotDataTrees } = require('../main/util/dataSnapshot'));
}

function closeDb() {
  try { db.closeDb(); } catch (_) {}
}

async function fixture() {
  closeDb();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-archive-concurrency-'));
  userDataRoot = path.join(root, 'user-data');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(userDataRoot, { recursive: true });
  await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir, firstLaunchHandled: true }));
  db.initDb(dataDir);

  const company = companies.create({ name: 'Archive ABA Company', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'ABA-001', name: 'Archive ABA product' });
  const { dir } = productImages.dirForProduct(product.id);
  const firstPath = path.posix.join(dir, 'ABA-001-001.bin');
  const secondPath = path.posix.join(dir, 'ABA-001-002.bin');
  const firstBytes = Buffer.from('selected-red-image-bytes');
  const secondBytes = Buffer.from('other-blue-image-bytes');
  await fsp.mkdir(path.join(dataDir, 'assets', dir), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'assets', firstPath), firstBytes);
  await fsp.writeFile(path.join(dataDir, 'assets', secondPath), secondBytes);
  const first = productImages.addRow(product.id, {
    filepath: firstPath,
    filename: path.posix.basename(firstPath),
    contentHash: 'synthetic-red',
    orderIndex: 0,
  }).image;
  const second = productImages.addRow(product.id, {
    filepath: secondPath,
    filename: path.posix.basename(secondPath),
    contentHash: 'synthetic-blue',
    orderIndex: 1,
  }).image;
  const initialInventory = await snapshotDataTrees(dataDir, ['assets']);

  return {
    root,
    dataDir,
    product,
    initialInventory,
    expectedOrderIds: [first.id, second.id],
    expectedBytesById: new Map([
      [first.id, firstBytes],
      [second.id, secondBytes],
    ]),
  };
}

function installBackupBoundaryABA(env) {
  const database = db.getDb();
  const originalBackup = database.backup;
  let reorderCount = 0;
  const scheduled = [];
  const reverseCurrentOrder = () => {
    const reversed = productImages.listByProduct(env.product.id).map((image) => image.filepath).reverse();
    productImages.reorder(env.product.id, reversed);
    reorderCount += 1;
  };
  const scheduleReverse = () => {
    scheduled.push(new Promise((resolve, reject) => {
      setImmediate(() => {
        try { reverseCurrentOrder(); resolve(); }
        catch (err) { reject(err); }
      });
    }));
  };

  database.backup = async function(destination) {
    scheduleReverse();
    const result = await originalBackup.call(database, destination);
    scheduleReverse();
    return result;
  };

  return {
    restore() { database.backup = originalBackup; },
    async assertRan() {
      await Promise.all(scheduled);
      assert.equal(reorderCount, 2, 'the real A-to-B-to-A reorder sequence must complete');
    },
  };
}

function assertRowsOwnExpectedBytes(dataDir, expectedBytesById) {
  const archiveDb = new Database(path.join(dataDir, 'database.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const rows = archiveDb.prepare('SELECT id, filepath, order_index FROM product_images ORDER BY order_index').all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const actual = fs.readFileSync(path.join(dataDir, 'assets', row.filepath));
      assert.deepEqual(
        actual,
        expectedBytesById.get(row.id),
        `archive row ${row.id} at ${row.filepath} must still own its expected bytes`,
      );
    }
  } finally {
    archiveDb.close();
  }
}

async function archiveMayRejectButMustNeverRestoreMismatch(env, create, restore) {
  const timing = installBackupBoundaryABA(env);
  let archived;
  let archiveError = null;
  try {
    archived = await create();
  } catch (err) {
    archiveError = err;
  }
  try {
    await timing.assertRan();
  } finally {
    timing.restore();
  }
  if (archiveError) {
    assert.match(archiveError.message, /changed|snapshot|retry|idle/i);
    return;
  }
  assert.deepEqual(
    productImages.listByProduct(env.product.id).map((image) => image.id),
    env.expectedOrderIds,
    'the live SQLite rows must finish back at state A',
  );
  assert.deepEqual(
    await snapshotDataTrees(env.dataDir, ['assets']),
    env.initialInventory,
    'the live file-tree hash inventory must finish back at state A',
  );
  closeDb();
  const restoredDataDir = await restore(archived);
  assertRowsOwnExpectedBytes(restoredDataDir, env.expectedBytesById);
}

test('exportBundle never restores SQLite image mappings from B with an A file tree', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const bundlePath = path.join(env.root, 'aba.iskhbundle');
    await archiveMayRejectButMustNeverRestoreMismatch(
      env,
      () => exportBundle({ outputPath: bundlePath }),
      async ({ bundlePath: createdBundle }) => {
        const targetDataDir = path.join(env.root, 'import-target');
        await importBundle({ bundlePath: createdBundle, targetDataDir });
        return targetDataDir;
      },
    );
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('createBackup never restores SQLite image mappings from B with an A file tree', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    await archiveMayRejectButMustNeverRestoreMismatch(
      env,
      () => createBackup({ destDir: path.join(env.root, 'backups') }),
      async ({ backupPath }) => {
        await restoreBackup({ backupPath });
        return env.dataDir;
      },
    );
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});
