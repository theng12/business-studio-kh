const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db;
let companies;
let products;
let productImages;
let workspace;
let processingPipeline;
let imageDedup;
let validateArgs;
let sharp;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  productImages = require('../main/db/productImages');
  workspace = require('../main/ipc/workspace');
  processingPipeline = require('../main/processingPipeline');
  imageDedup = require('../main/imageDedup');
  ({ validateArgs } = require('../main/util/validateArgs'));
  sharp = require('sharp');
} catch (error) {
  if (error?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw error;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sha1(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

async function solidPng(red, green, blue) {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: red, g: green, b: blue } },
  }).png().toBuffer();
}

async function fixture(sku) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-workspace-concurrency-'));
  db.initDb(dataDir);
  const company = companies.create({ name: `Workspace ${sku}`, isActive: true });
  const product = products.create({ companyId: company.id, sku, name: sku });
  const bytes = await solidPng(160, 90, 30);
  const { dir } = productImages.dirForProduct(product.id);
  const filename = `${sku}-001.png`;
  const filepath = `${dir}/${filename}`;
  const absolutePath = path.join(dataDir, 'assets', filepath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  const image = productImages.addRow(product.id, {
    filepath,
    filename,
    originalFilepath: filepath,
    contentHash: sha1(bytes),
    orderIndex: 0,
  }).image;

  const handlers = new Map();
  workspace.register({
    expose(channel, handler) {
      handlers.set(channel, (args) => {
        validateArgs(channel, args);
        return handler(args);
      });
    },
    emitCatalogChange() {},
  });

  return { dataDir, handlers, product, image };
}

async function addImage(env, index, red, green, blue) {
  const bytes = await solidPng(red, green, blue);
  const { dir } = productImages.dirForProduct(env.product.id);
  const filename = `${env.product.sku}-${String(index + 1).padStart(3, '0')}.png`;
  const filepath = `${dir}/${filename}`;
  const absolutePath = path.join(env.dataDir, 'assets', filepath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return productImages.addRow(env.product.id, {
    filepath,
    filename,
    originalFilepath: filepath,
    contentHash: sha1(bytes),
    orderIndex: index,
  }).image;
}

function closeFixture(dataDir) {
  try { db.closeDb(); } catch (_) { /* best effort */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function payload(product, image, settings) {
  return {
    productId: product.id,
    imageId: image.id,
    expectedContentHash: image.contentHash,
    expectedWorkspaceRevision: image.workspaceRevision,
    settings,
  };
}

function isConflict(error) {
  return typeof error?.message === 'string' && error.message.includes('CONFLICT|');
}

function conflictDetails(error) {
  if (!isConflict(error)) return null;
  return JSON.parse(error.message.slice(error.message.indexOf('CONFLICT|') + 'CONFLICT|'.length));
}

test('workspace revisions are optional, but supplied revisions must be safe non-negative integers', { skip: skipReason }, () => {
  const accepted = [];
  for (const channel of ['workspace:saveSettings', 'workspace:processImage']) {
    const valid = {
      productId: 'product-1',
      imageId: 'image-1',
      expectedContentHash: 'hash-1',
      expectedWorkspaceRevision: 0,
      settings: {},
    };
    validateArgs(channel, valid);
    const withoutRevision = { ...valid };
    delete withoutRevision.expectedWorkspaceRevision;
    validateArgs(channel, withoutRevision);
    for (const invalid of [null, -1, 1.5, '0', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const args = { ...valid };
      args.expectedWorkspaceRevision = invalid;
      try {
        validateArgs(channel, args);
        accepted.push(`${channel}:${String(invalid)}`);
      } catch (error) {
        assert.match(error.message, /expectedWorkspaceRevision must be a non-negative safe integer/);
      }
    }
  }
  assert.deepEqual(accepted, [], 'malformed workspace revisions currently reach the handler');
});

test('Image Workspace rejects stale same-image writes', { skip: skipReason }, async (t) => {
  await t.test('a stale save cannot replace newer workspace settings', async () => {
    const env = await fixture('WORKSPACE-SAVE-CAS');
    try {
      const snapshotA = clone(env.image);
      const snapshotB = clone(env.image);
      const save = env.handlers.get('workspace:saveSettings');

      const winnerRows = save(payload(env.product, snapshotA, { brightness: 15 }));
      const winner = winnerRows.find((image) => image.id === env.image.id);
      let staleError = null;
      try { save(payload(env.product, snapshotB, { brightness: 90 })); } catch (error) { staleError = error; }

      const final = productImages.getById(env.product.id, env.image.id);
      const conflict = conflictDetails(staleError);
      assert.deepEqual(
        {
          staleRejected: isConflict(staleError),
          conflictKind: conflict?.kind,
          conflictName: conflict?.name,
          conflictRevision: conflict?.workspaceRevision,
          finalBrightness: final.workspaceSettings.brightness,
          finalRevision: final.workspaceRevision,
        },
        {
          staleRejected: true,
          conflictKind: 'workspaceImage',
          conflictName: env.image.filename,
          conflictRevision: winner.workspaceRevision,
          finalBrightness: 15,
          finalRevision: winner.workspaceRevision,
        },
      );
    } finally {
      closeFixture(env.dataDir);
    }
  });

  await t.test('sequential saves chain the returned workspace revision', async () => {
    const env = await fixture('WORKSPACE-SAVE-SEQUENTIAL');
    try {
      const save = env.handlers.get('workspace:saveSettings');
      const firstRows = save(payload(env.product, env.image, { brightness: 10 }));
      const first = firstRows.find((image) => image.id === env.image.id);
      const secondRows = save(payload(env.product, first, { brightness: 20 }));
      const second = secondRows.find((image) => image.id === env.image.id);

      assert.deepEqual(
        {
          initialRevision: env.image.workspaceRevision,
          firstRevision: first.workspaceRevision,
          secondRevision: second.workspaceRevision,
          finalBrightness: second.workspaceSettings.brightness,
        },
        { initialRevision: 0, firstRevision: 1, secondRevision: 2, finalBrightness: 20 },
      );
    } finally {
      closeFixture(env.dataDir);
    }
  });

  await t.test('an unversioned save deliberately overwrites settings but preserves output metadata', async () => {
    const env = await fixture('WORKSPACE-SAVE-BACKCOMPAT');
    try {
      const processed = productImages.setProcessedById(env.product.id, env.image.id, {
        isProcessed: true,
        processedFilepath: 'processed/WORKSPACE-SAVE-BACKCOMPAT/winner.png',
        workspaceSettings: { brightness: 10 },
      });
      const args = payload(env.product, processed, { brightness: 90 });
      delete args.expectedWorkspaceRevision;

      const rows = env.handlers.get('workspace:saveSettings')(args);
      const final = rows.find((image) => image.id === env.image.id);
      assert.deepEqual(
        {
          brightness: final.workspaceSettings.brightness,
          isProcessed: final.isProcessed,
          processedFilepath: final.processedFilepath,
          workspaceRevision: final.workspaceRevision,
        },
        {
          brightness: 90,
          isProcessed: true,
          processedFilepath: 'processed/WORKSPACE-SAVE-BACKCOMPAT/winner.png',
          workspaceRevision: 2,
        },
      );
    } finally {
      closeFixture(env.dataDir);
    }
  });

  await t.test('a stale process cannot replace newer settings or output', async () => {
    const env = await fixture('WORKSPACE-PROCESS-CAS');
    try {
      const snapshotA = clone(env.image);
      const snapshotB = clone(env.image);
      const processImage = env.handlers.get('workspace:processImage');
      const settingsA = {
        canvasWidth: 64,
        canvasHeight: 64,
        removeBackground: false,
        brightness: 10,
      };
      const settingsB = { ...settingsA, brightness: 80 };

      const first = await processImage(payload(env.product, snapshotA, settingsA));
      const firstAbsolutePath = path.join(env.dataDir, first.processedRelativePath);
      const firstBytes = fs.readFileSync(firstAbsolutePath);

      let staleError = null;
      try { await processImage(payload(env.product, snapshotB, settingsB)); } catch (error) { staleError = error; }

      const final = productImages.getById(env.product.id, env.image.id);
      const outputs = fs.readdirSync(path.dirname(firstAbsolutePath));
      assert.deepEqual(
        {
          staleRejected: isConflict(staleError),
          finalBrightness: final.workspaceSettings.brightness,
          referencesFirstOutput: final.processedFilepath === first.processedRelativePath,
          firstOutputPreserved: fs.readFileSync(firstAbsolutePath).equals(firstBytes),
          outputCount: outputs.length,
        },
        {
          staleRejected: true,
          finalBrightness: 10,
          referencesFirstOutput: true,
          firstOutputPreserved: true,
          outputCount: 1,
        },
      );
    } finally {
      closeFixture(env.dataDir);
    }
  });

  await t.test('processing retains its entry revision across the async pipeline', async () => {
    const env = await fixture('WORKSPACE-PROCESS-INFLIGHT');
    const originalProcess = processingPipeline.processImage;
    const started = deferred();
    const release = deferred();
    const winnerRelativePath = 'processed/WORKSPACE-PROCESS-INFLIGHT/winner.png';
    const winnerAbsolutePath = path.join(env.dataDir, winnerRelativePath);
    const winnerBytes = Buffer.from('prior-winner-output');
    const staleRelativePath = `processed/WORKSPACE-PROCESS-INFLIGHT/${crypto.randomUUID()}.png`;
    const staleAbsolutePath = path.join(env.dataDir, staleRelativePath);
    fs.mkdirSync(path.dirname(winnerAbsolutePath), { recursive: true });
    fs.writeFileSync(winnerAbsolutePath, winnerBytes);
    const winner = productImages.setProcessedById(env.product.id, env.image.id, {
      isProcessed: true,
      processedFilepath: winnerRelativePath,
      workspaceSettings: { brightness: 10 },
    });
    processingPipeline.processImage = async () => {
      started.resolve();
      await release.promise;
      fs.writeFileSync(staleAbsolutePath, 'uncommitted-stale-output');
      return { relativePath: staleRelativePath, absolutePath: staleAbsolutePath };
    };
    try {
      const snapshot = clone(winner);
      const processArgs = payload(env.product, snapshot, { brightness: 80 });
      delete processArgs.expectedWorkspaceRevision;
      const pending = env.handlers.get('workspace:processImage')(processArgs);
      await started.promise;
      env.handlers.get('workspace:saveSettings')(
        payload(env.product, snapshot, { brightness: 15 }),
      );
      release.resolve();

      let staleError = null;
      try { await pending; } catch (error) { staleError = error; }
      const final = productImages.getById(env.product.id, env.image.id);
      assert.deepEqual(
        {
          staleRejected: isConflict(staleError),
          finalBrightness: final.workspaceSettings.brightness,
          isProcessed: final.isProcessed,
          processedFilepath: final.processedFilepath,
          staleOutputExists: fs.existsSync(staleAbsolutePath),
          winnerOutputUnchanged: fs.readFileSync(winnerAbsolutePath).equals(winnerBytes),
        },
        {
          staleRejected: true,
          finalBrightness: 15,
          isProcessed: true,
          processedFilepath: winnerRelativePath,
          staleOutputExists: false,
          winnerOutputUnchanged: true,
        },
      );
    } finally {
      processingPipeline.processImage = originalProcess;
      release.resolve();
      closeFixture(env.dataDir);
    }
  });

  await t.test('merge revert advances the restored revision so a pre-merge snapshot stays stale', async () => {
    const env = await fixture('WORKSPACE-MERGE-REVERT');
    try {
      const staleSnapshot = clone(env.image);
      const other = await addImage(env, 1, 20, 140, 200);
      const savedRows = env.handlers.get('workspace:saveSettings')(
        payload(env.product, env.image, { brightness: 15 }),
      );
      const saved = savedRows.find((image) => image.id === env.image.id);
      assert.equal(saved.workspaceRevision, 1);

      const merged = imageDedup.mergeGroups({
        decisions: [{ productId: env.product.id, keepId: other.id, removeIds: [env.image.id] }],
      });
      assert.equal(productImages.getById(env.product.id, env.image.id), null);
      imageDedup.revertMergeOp(merged.opId);

      const restored = productImages.getById(env.product.id, env.image.id);
      let staleError = null;
      try {
        env.handlers.get('workspace:saveSettings')(
          payload(env.product, staleSnapshot, { brightness: 90 }),
        );
      } catch (error) {
        staleError = error;
      }
      const final = productImages.getById(env.product.id, env.image.id);
      assert.deepEqual(
        {
          restoredBrightness: restored.workspaceSettings.brightness,
          restoredRevision: restored.workspaceRevision,
          staleRejected: isConflict(staleError),
          finalBrightness: final.workspaceSettings.brightness,
          finalRevision: final.workspaceRevision,
        },
        {
          restoredBrightness: 15,
          restoredRevision: 2,
          staleRejected: true,
          finalBrightness: 15,
          finalRevision: 2,
        },
      );
    } finally {
      closeFixture(env.dataDir);
    }
  });

  await t.test('historical merge logs without a revision restore at revision one', async () => {
    const env = await fixture('WORKSPACE-MERGE-LEGACY');
    try {
      const other = await addImage(env, 1, 60, 100, 180);
      const merged = imageDedup.mergeGroups({
        decisions: [{ productId: env.product.id, keepId: other.id, removeIds: [env.image.id] }],
      });
      const database = db.getDb();
      const op = database.prepare('SELECT removed_json FROM image_merge_ops WHERE id = ?').get(merged.opId);
      const removed = JSON.parse(op.removed_json);
      delete removed[0].row.workspace_revision;
      database.prepare('UPDATE image_merge_ops SET removed_json = ? WHERE id = ?')
        .run(JSON.stringify(removed), merged.opId);

      imageDedup.revertMergeOp(merged.opId);

      assert.equal(productImages.getById(env.product.id, env.image.id).workspaceRevision, 1);
    } finally {
      closeFixture(env.dataDir);
    }
  });
});
