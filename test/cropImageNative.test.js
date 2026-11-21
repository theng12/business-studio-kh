const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let skip = false;
try { new (require('better-sqlite3'))(':memory:').close(); } catch (err) {
  if (err.code !== 'ERR_DLOPEN_FAILED') throw err;
  skip = 'Run with ELECTRON_RUN_AS_NODE=1 electron --test test/cropImageNative.test.js';
}

test('crop preview and both destinations use the displayed raw-source rotation and pixels', { skip }, async () => {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle() {}, on() {} }, app: { getPath: () => os.tmpdir() }, BrowserWindow: { getAllWindows: () => [] } };
    return originalLoad.call(this, request, parent, isMain);
  };
  const db = require('../main/db');
  const companies = require('../main/db/companies');
  const products = require('../main/db/products');
  const images = require('../main/db/productImages');
  const ipc = require('../main/ipc/images');
  Module._load = originalLoad;
  const sharp = require('sharp');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-crop-'));
  try {
    db.initDb(dataDir);
    const company = companies.create({ name: 'Synthetic crop' });
    const product = products.create({ companyId: company.id, sku: 'CROP-FIXTURE' });
    const handlers = new Map();
    const expose = (name, fn) => handlers.set(name, async (opts) => {
      require('../main/util/validateArgs').validateArgs(name, opts);
      return fn(opts);
    });
    ipc.register({ expose, exposeLocal: expose, emitCatalogChange() {}, assertProductInActiveCompany() {} });
    const full = { x: 0, y: 0, width: 1, height: 1 };
    const largeBytes = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#777777' } }).png().toBuffer();
    const { image: importedLarge } = await images.addFromBytes(product.id, largeBytes, '.png', { originalFilepath: 'bounded-preview.png' });
    // Import normally downsizes photos. Model an existing full-size raw file
    // using the same immutable replacement API the crop writer uses.
    const largeTmp = path.join(dataDir, 'large-reference.png');
    fs.writeFileSync(largeTmp, largeBytes);
    const large = images.replaceImageFile(product.id, importedLarge.id, { tmpAbs: largeTmp, expectedHash: importedLarge.contentHash, newHash: require('node:crypto').createHash('sha1').update(largeBytes).digest('hex') });
    const largeOpts = { productId: product.id, imageId: large.id, expectedContentHash: large.contentHash, filepath: large.filepath, rect: full };
    const bounded = await handlers.get('images:cropPreview')({ ...largeOpts, previewMaxEdge: 1024 });
    const boundedMeta = await sharp(bounded.bytes).metadata();
    assert.deepEqual([bounded.outW, bounded.outH], [4000, 2000], 'coordinate math retains full source dimensions');
    assert.deepEqual([boundedMeta.width, boundedMeta.height], [1024, 512], 'UI reference PNG transfer is bounded');
    assert.ok(bounded.bytes.length < largeBytes.length && bounded.bytes.length < 1024 * 1024 * 4);
    await assert.rejects(handlers.get('images:cropPreview')({ ...largeOpts, previewMaxEdge: 0 }), /previewMaxEdge/);
    const squareBytes = await sharp(Buffer.from('<svg width="1600" height="1600"><rect width="1600" height="1600" fill="#44aa66"/><rect width="800" height="800" fill="#cc3344"/><rect x="800" y="800" width="800" height="800" fill="#3344cc"/></svg>')).png().toBuffer();
    const { image: square } = await images.addFromBytes(product.id, squareBytes, '.png', { originalFilepath: 'straighten-cap.png' });
    const squareOpts = { productId: product.id, imageId: square.id, expectedContentHash: square.contentHash, filepath: square.filepath, rect: full, rotation: 90, straighten: 45 };
    const squarePreview = await handlers.get('images:cropPreview')(squareOpts);
    assert.deepEqual([squarePreview.outW, squarePreview.outH], [2263, 2263], 'preview coordinates retain the expanded raw source');
    const squareSaved = await handlers.get('images:cropImage')({ ...squareOpts, destination: 'newImage' });
    const squareSavedBytes = fs.readFileSync(images.assetAbsPath(squareSaved.image.filepath));
    const squareMeta = await sharp(squareSavedBytes).metadata();
    assert.deepEqual([squareSaved.outW, squareSaved.outH], [squareMeta.width, squareMeta.height], 'new-copy reports persisted dimensions after import scaling');
    assert.deepEqual([squareMeta.width, squareMeta.height], [1600, 1600], 'the existing product import ceiling is preserved');
    const expectedCopy = await sharp(squarePreview.bytes).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    assert.deepEqual(await sharp(squareSavedBytes).raw().toBuffer(), await sharp(expectedCopy).raw().toBuffer(), 'selected crop pixels agree after the established import resize');
    const cropAudit = require('../main/db/auditLog').listForEntity('product', product.id).find((entry) => entry.action === 'image:crop' && entry.after?.destination === 'newImage');
    assert.deepEqual([cropAudit.after.outW, cropAudit.after.outH], [1600, 1600], 'audit records dimensions that exist on disk');
    const reusedSquare = await handlers.get('images:cropImage')({ ...squareOpts, destination: 'newImage' });
    assert.equal(reusedSquare.skipped, true);
    assert.equal(reusedSquare.image.id, squareSaved.image.id);
    assert.deepEqual([reusedSquare.outW, reusedSquare.outH], [1600, 1600], 'dedup returns actual reused-file dimensions');
    for (const [W, H] of [[400, 200], [200, 400]]) {
      const pixels = Buffer.alloc(W * H * 3);
      const colors = [[240, 20, 30], [20, 220, 40], [20, 40, 230], [230, 210, 20]];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = colors[(y >= H / 2 ? 2 : 0) + (x >= W / 2 ? 1 : 0)];
        pixels.set(c, (y * W + x) * 3);
      }
      const bytes = await sharp(pixels, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
      const { image } = await images.addFromBytes(product.id, bytes, '.png', { originalFilepath: `corners-${W}.png` });
      // A processed image exists, but crop always works on these raw corners.
      images.setProcessed(product.id, image.filepath, { isProcessed: true, processedFilepath: 'processed/unrelated.png', workspaceSettings: { brightness: 7, rotation: 90, sourceCropRect: full, cropRect: { x: 0.1, y: 0, width: 0.9, height: 1 } } });
      for (const [rotation, straighten] of [[0, 0], [90, 0], [90, 12]]) {
        const opts = { productId: product.id, imageId: image.id, expectedContentHash: image.contentHash, filepath: image.filepath, rotation, straighten };
        const preview = await handlers.get('images:cropPreview')({ ...opts, rect: full });
        const meta = await sharp(preview.bytes).metadata();
        assert.deepEqual([preview.outW, preview.outH], [meta.width, meta.height]);
        if (!straighten) assert.deepEqual([meta.width, meta.height], rotation ? [H, W] : [W, H]);
        let expected = rotation ? await sharp(bytes).rotate(rotation).png().toBuffer() : bytes;
        if (straighten) expected = await sharp(expected).rotate(straighten, { background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
        assert.deepEqual(await sharp(preview.bytes).raw().toBuffer(), await sharp(expected).raw().toBuffer(), 'full preview matches the independently rotated corner fixture');
        for (const ratio of [1, 4 / 3]) {
          const width = Math.min(0.5, 0.5 * ratio * meta.height / meta.width);
          const rect = { x: 0.1, y: 0.1, width, height: width * meta.width / (ratio * meta.height) };
          const cropped = await handlers.get('images:cropPreview')({ ...opts, rect });
          const saved = await handlers.get('images:cropImage')({ ...opts, rect, destination: 'newImage' });
          assert.equal(images.getById(product.id, image.id).workspaceSettings.rotation, 90, 'new-copy preserves original settings');
          if (!saved.skipped) assert.deepEqual(saved.image.workspaceSettings, {}, 'new copy starts without baked rotation settings');
          assert.ok(Math.abs(saved.outW / saved.outH - ratio) < 0.025, 'requested output ratio survives landscape/portrait sources');
          const savedBytes = fs.readFileSync(images.assetAbsPath(saved.image.filepath));
          assert.deepEqual(await sharp(savedBytes).raw().toBuffer(), await sharp(cropped.bytes).raw().toBuffer(), 'saved pixels equal preview pixels');
        }
      }
      const opts = { productId: product.id, filepath: image.filepath, imageId: image.id, expectedContentHash: image.contentHash, rotation: 90, straighten: 7, rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } };
      await assert.rejects(handlers.get('images:cropPreview')({ ...opts, rotation: 45 }), /multiple of 90/);
      await assert.rejects(handlers.get('images:cropImage')({ ...opts, expectedContentHash: 'stale-hash' }), /changed while cropping/);
      const preview = await handlers.get('images:cropPreview')(opts);
      const stalePathPreview = await handlers.get('images:cropPreview')({ ...opts, filepath: 'assets/a-path-that-was-renumbered.png' });
      assert.deepEqual(stalePathPreview.bytes, preview.bytes, 'immutable row identity selects the raw photo even after its path changes');
      const saved = await handlers.get('images:cropImage')({ ...opts, destination: 'overwrite' });
      assert.equal(saved.image.workspaceSettings.rotation, 0);
      assert.equal(saved.image.workspaceSettings.sourceCropRect, null);
      assert.equal(saved.image.workspaceSettings.cropStraighten, 0);
      assert.equal(saved.image.workspaceSettings.brightness, 7);
      assert.deepEqual(saved.image.workspaceSettings.cropRect, { x: 0.1, y: 0, width: 0.9, height: 1 });
      assert.equal(saved.image.isProcessed, false, 'old processed pixels cannot hide the new raw crop');
      assert.equal(saved.image.processedFilepath, null);
      assert.deepEqual(await sharp(fs.readFileSync(images.assetAbsPath(saved.image.filepath))).raw().toBuffer(), await sharp(preview.bytes).raw().toBuffer(), 'PNG overwrite keeps the preview pixels');
    }
  } finally {
    db.closeDb();
    const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'crop-tests');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dataDir, path.join(trash, path.basename(dataDir)));
  }
});
