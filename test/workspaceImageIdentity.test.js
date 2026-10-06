const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { getValidator } = require('../main/server/validators');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

let db = null;
let companies = null;
let products = null;
let productImages = null;
let workspace = null;
let processingPipeline = null;
let sharp = null;
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
  sharp = require('sharp');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-workspace-identity-'));
  db.initDb(dataDir);
  const company = companies.create({ name: 'Identity Test', isActive: true });
  const handlers = new Map();
  workspace.register({
    expose: (channel, handler) => handlers.set(channel, handler),
    emitCatalogChange() {},
  });

  function addCompany(name) {
    return companies.create({ name, isActive: true });
  }

  function addProduct(sku, companyId = company.id) {
    return products.create({ companyId, sku, name: sku });
  }

  function addImage(product, index, contentHash, bytes = Buffer.from(`${product.sku}-${index}`)) {
    const { dir } = productImages.dirForProduct(product.id);
    const filename = `${product.sku}-${String(index + 1).padStart(3, '0')}.jpg`;
    const filepath = `${dir}/${filename}`;
    const absPath = path.join(dataDir, 'assets', filepath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, bytes);
    return productImages.addRow(product.id, {
      filepath,
      filename,
      originalFilepath: filepath,
      contentHash,
      orderIndex: index,
    }).image;
  }

  return { dataDir, handlers, addCompany, addProduct, addImage };
}

function sha1(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

async function solidPng(red, green, blue) {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: red, g: green, b: blue } },
  }).png().toBuffer();
}

function identityPayload(product, image, settings = {}, extra = {}) {
  return {
    productId: product.id,
    imageId: image.id,
    expectedContentHash: image.contentHash,
    settings,
    ...extra,
  };
}

test('workspace validators require an immutable image identity', () => {
  for (const channel of ['workspace:saveSettings', 'workspace:processImage']) {
    const validate = getValidator(channel);
    assert.equal(validate({ productId: 'product-1', imageId: 'image-1', expectedContentHash: 'hash-1' }), true);
    assert.notEqual(validate({ productId: 'product-1', filepath: '001.jpg' }), true);
    assert.notEqual(validate({ productId: 'product-1', imageId: 'image-1' }), true);
    assert.notEqual(validate({ productId: 'product-1', imageId: 'image-1', expectedContentHash: 42 }), true);
  }
});

test('workspace handlers retain the selected image row across concurrent image changes', { skip: skipReason }, async (t) => {
  await t.test('save resolves the original row after another client reorders files', () => {
    const { handlers, addProduct, addImage } = fixture();
    const product = addProduct('SAVE-REORDER');
    const original = addImage(product, 0, 'hash-original');
    const other = addImage(product, 1, 'hash-other');
    const originalPath = original.filepath;

    productImages.reorder(product.id, [other.filepath, original.filepath]);
    handlers.get('workspace:saveSettings')(identityPayload(product, original, { brightness: 42 }));

    const after = productImages.listByProduct(product.id);
    const savedOriginal = after.find((image) => image.id === original.id);
    const untouchedOther = after.find((image) => image.id === other.id);
    assert.notEqual(savedOriginal.filepath, originalPath, 'the original row moved to a different positional filename');
    assert.equal(savedOriginal.workspaceSettings.brightness, 42);
    assert.deepEqual(untouchedOther.workspaceSettings, {});
  });

  await t.test('save rejects a deleted image row instead of retargeting its old position', async () => {
    const { handlers, addProduct, addImage } = fixture();
    const product = addProduct('SAVE-REMOVED');
    const image = addImage(product, 0, 'hash-removed');
    productImages.remove(product.id, productImages.listByProduct(product.id).find((row) => row.filepath === image.filepath).id);

    assert.throws(
      () => handlers.get('workspace:saveSettings')(identityPayload(product, image, { brightness: 11 })),
      /Image not found on product/,
    );
  });

  await t.test('save rejects an image ID owned by another product', async () => {
    const { handlers, addProduct, addImage } = fixture();
    const product = addProduct('SAVE-OWNER');
    const otherProduct = addProduct('SAVE-FOREIGN');
    const foreignImage = addImage(otherProduct, 0, 'hash-foreign');

    assert.throws(
      () => handlers.get('workspace:saveSettings')(identityPayload(product, foreignImage, { brightness: 12 })),
      /Image not found on product/,
    );
  });

  await t.test('save rejects changed content from the originally selected image row', async () => {
    const { handlers, addProduct, addImage } = fixture();
    const product = addProduct('SAVE-STALE');
    const image = addImage(product, 0, 'hash-before');
    productImages.setContentHash(product.id, image.filepath, 'hash-after');

    assert.throws(
      () => handlers.get('workspace:saveSettings')(identityPayload(product, image, { brightness: 13 })),
      /Image changed; reload and try again/,
    );
  });

  await t.test('process rechecks the image identity after its async pipeline completes', async () => {
    const { handlers, addProduct, addImage } = fixture();
    const product = addProduct('PROCESS-STALE');
    const image = addImage(product, 0, 'hash-before');
    const started = deferred();
    const release = deferred();
    const originalProcess = processingPipeline.processImage;
    processingPipeline.processImage = async () => {
      started.resolve();
      await release.promise;
      return { relativePath: 'processed/PROCESS-STALE/PROCESS-STALE-001.png' };
    };
    try {
      const pending = handlers.get('workspace:processImage')(identityPayload(product, image, { canvasWidth: 64 }));
      await started.promise;
      productImages.setContentHash(product.id, image.filepath, 'hash-after');
      release.resolve();
      await assert.rejects(() => pending, /Image changed; reload and try again/);
      assert.equal(productImages.getById(product.id, image.id).isProcessed, false);
    } finally {
      processingPipeline.processImage = originalProcess;
    }
  });

  await t.test('process pins the selected image before an ABA path cycle can substitute another row', async () => {
    const { dataDir, handlers, addProduct, addImage } = fixture();
    const product = addProduct('PROCESS-READ-ABA');
    const red = await solidPng(255, 0, 0);
    const blue = await solidPng(0, 0, 255);
    const original = addImage(product, 0, sha1(red), red);
    const other = addImage(product, 1, sha1(blue), blue);
    const originalAbs = path.join(dataDir, 'assets', original.filepath);
    const originalOpenSync = fs.openSync;
    const originalReadFile = fs.promises.readFile;
    let reorderedAfterOpen = false;
    let asyncReads = 0;

    const reorderById = (ids) => {
      const byId = new Map(productImages.listByProduct(product.id).map((image) => [image.id, image]));
      productImages.reorder(product.id, ids.map((id) => byId.get(id).filepath));
    };

    // New acquisition opens the selected row's file before yielding. Exercise
    // a real synchronous rename immediately after that open: the descriptor
    // must remain attached to the selected image's inode.
    fs.openSync = (...args) => {
      const fd = originalOpenSync(...args);
      if (!reorderedAfterOpen && args[0] === originalAbs) {
        reorderedAfterOpen = true;
        reorderById([other.id, original.id]);
      }
      return fd;
    };

    // Regression for the previous double-read algorithm. Its two pathname
    // reads can both observe B while the row path completes an A→B→A cycle.
    fs.promises.readFile = async (...args) => {
      asyncReads += 1;
      if (asyncReads === 1) {
        reorderById([other.id, original.id]);
        return originalReadFile(...args);
      }
      if (asyncReads === 2) {
        reorderById([original.id, other.id]);
        const bytes = await originalReadFile(...args);
        reorderById([other.id, original.id]);
        return bytes;
      }
      return originalReadFile(...args);
    };

    try {
      const result = await handlers.get('workspace:processImage')(identityPayload(product, original, {
        canvasWidth: 64,
        canvasHeight: 64,
        productFillPct: 100,
        removeBackground: false,
      }));
      const { data, info } = await sharp(path.join(dataDir, result.processedRelativePath))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const center = ((Math.floor(info.height / 2) * info.width) + Math.floor(info.width / 2)) * info.channels;

      assert.ok(data[center] > 200 && data[center + 2] < 50,
        'processed pixels must come from the selected red row, not the blue row occupying its old path');
      assert.equal(productImages.getById(product.id, original.id).isProcessed, true);
    } finally {
      fs.openSync = originalOpenSync;
      fs.promises.readFile = originalReadFile;
    }
  });

  await t.test('JPEG import identity hashes source bytes, not Sharp-reencoded stored bytes', async () => {
    const { dataDir, handlers, addProduct } = fixture();
    const product = addProduct('JPEG-HASH-CONTRACT');
    const sourcePath = path.join(dataDir, 'realistic-source.jpg');
    const pixels = Buffer.alloc(24 * 24 * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = (i / 3) % 256;
      pixels[i + 1] = (i / 9) % 256;
      pixels[i + 2] = 255 - ((i / 3) % 256);
    }
    await sharp(pixels, { raw: { width: 24, height: 24, channels: 3 } })
      .jpeg({ quality: 61 })
      .toFile(sourcePath);

    const sourceHash = sha1(fs.readFileSync(sourcePath));
    const { image } = await productImages.addFromSource(product.id, sourcePath, {
      originalFilepath: sourcePath,
    });
    const storedHash = sha1(fs.readFileSync(path.join(dataDir, 'assets', image.filepath)));

    assert.equal(image.contentHash, sourceHash, 'database identity keeps the imported source hash');
    assert.notEqual(storedHash, image.contentHash,
      'Sharp re-encoding means the stored asset bytes intentionally have a different hash');

    const result = await handlers.get('workspace:processImage')(identityPayload(product, image, {
      canvasWidth: 64,
      canvasHeight: 64,
      removeBackground: false,
    }));
    assert.equal(productImages.getById(product.id, image.id).processedFilepath, result.processedRelativePath);
  });

  await t.test('same-SKU products in different companies keep distinct processed files', async () => {
    const { dataDir, handlers, addCompany, addProduct, addImage } = fixture();
    const otherCompany = addCompany('Other Identity Test');
    const firstProduct = addProduct('SHARED-SKU');
    const secondProduct = addProduct('SHARED-SKU', otherCompany.id);
    const red = await solidPng(255, 0, 0);
    const blue = await solidPng(0, 0, 255);
    const firstImage = addImage(firstProduct, 0, sha1(red), red);
    const secondImage = addImage(secondProduct, 0, sha1(blue), blue);
    const settings = { canvasWidth: 64, canvasHeight: 64, productFillPct: 100, removeBackground: false };

    const first = await handlers.get('workspace:processImage')(identityPayload(firstProduct, firstImage, settings));
    const second = await handlers.get('workspace:processImage')(identityPayload(secondProduct, secondImage, settings));

    assert.notEqual(first.processedRelativePath, second.processedRelativePath);
    const firstBytes = fs.readFileSync(path.join(dataDir, first.processedRelativePath));
    const secondBytes = fs.readFileSync(path.join(dataDir, second.processedRelativePath));
    assert.notDeepEqual(firstBytes, secondBytes, 'each row keeps the output generated from its own source');
  });

  await t.test('stale processing leaves the previously referenced output and settings unchanged', async () => {
    const { dataDir, handlers, addProduct, addImage } = fixture();
    const product = addProduct('STALE-OUTPUT');
    const source = await solidPng(40, 180, 80);
    const image = addImage(product, 0, sha1(source), source);
    const previousRelativePath = 'processed/STALE-OUTPUT/STALE-OUTPUT-001.png';
    const previousAbsolutePath = path.join(dataDir, previousRelativePath);
    const previousBytes = Buffer.from('previous-referenced-output');
    fs.mkdirSync(path.dirname(previousAbsolutePath), { recursive: true });
    fs.writeFileSync(previousAbsolutePath, previousBytes);
    productImages.setProcessedById(product.id, image.id, {
      isProcessed: true,
      processedFilepath: previousRelativePath,
      workspaceSettings: { brightness: 7 },
    });

    const originalProcess = processingPipeline.processImage;
    let generated;
    processingPipeline.processImage = async (args) => {
      generated = await originalProcess(args);
      productImages.setContentHash(product.id, image.filepath, 'changed-during-process');
      return generated;
    };
    try {
      await assert.rejects(
        () => handlers.get('workspace:processImage')(identityPayload(product, image, {
          canvasWidth: 64,
          canvasHeight: 64,
          removeBackground: false,
        })),
        /Image changed; reload and try again/,
      );

      const after = productImages.getById(product.id, image.id);
      assert.equal(after.processedFilepath, previousRelativePath);
      assert.equal(after.workspaceSettings.brightness, 7);
      assert.deepEqual(fs.readFileSync(previousAbsolutePath), previousBytes);
      if (generated.absolutePath !== previousAbsolutePath) {
        assert.equal(fs.existsSync(generated.absolutePath), false, 'rejected attempt output is removed');
      }
    } finally {
      processingPipeline.processImage = originalProcess;
    }
  });

  await t.test('process rejects legacy rows without a verifiable content identity', async () => {
    const { handlers, addProduct, addImage } = fixture();
    const product = addProduct('PROCESS-LEGACY');
    const source = await solidPng(10, 20, 30);
    const image = addImage(product, 0, null, source);

    await assert.rejects(
      () => handlers.get('workspace:processImage')(identityPayload(product, image)),
      /Image identity unavailable; re-import the image and try again/,
    );
  });

  await t.test('normal process writes settings and output to the selected image row', async () => {
    const { handlers, addProduct, addImage } = fixture();
    const product = addProduct('PROCESS-NORMAL');
    const source = await solidPng(120, 80, 40);
    const image = addImage(product, 0, sha1(source), source);

    const result = await handlers.get('workspace:processImage')(identityPayload(product, image, {
      canvasWidth: 64,
      canvasHeight: 64,
      removeBackground: false,
    }));

    const processed = productImages.getById(product.id, image.id);
    assert.equal(processed.isProcessed, true);
    assert.equal(processed.workspaceSettings.canvasWidth, 64);
    assert.equal(processed.processedFilepath, result.processedRelativePath);
  });
});
