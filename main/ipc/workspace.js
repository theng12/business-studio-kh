/**
 * v0.21.2: workspace:* IPC handlers, extracted from ipc.js.
 *
 * Sharp pipeline runs on the server. `foregroundBytes` (when
 * present) arrives as a Buffer in client mode (deserialized from
 * the base64 envelope) or as an ArrayBuffer in local mode
 * (structured clone). `Buffer.from(...)` accepts either.
 *
 * If the renderer doesn't send foreground bytes, the server reads
 * the source image from disk and processes it directly — the
 * "fast path" used by the Workspace's "Process" button after
 * auto-save has persisted the user's settings.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const products = require('../db/products');
const productImages = require('../db/productImages');
const processingPipeline = require('../processingPipeline');
const { getDataDir } = require('../db');

function resolveImage(productId, imageId, expectedContentHash) {
  const image = productImages.getById(productId, imageId);
  if (!image) throw new Error('Image not found on product');
  if (image.contentHash !== expectedContentHash) {
    throw new Error('Image changed; reload and try again');
  }
  return image;
}

function sha1(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

async function readSource(productId, imageId, expectedContentHash) {
  const image = resolveImage(productId, imageId, expectedContentHash);
  let fd;
  try {
    // Row resolution and open happen in one synchronous JS turn. Reorder and
    // renumber are synchronous on this server thread, so they cannot place a
    // different row at this path before the descriptor pins the selected
    // image's inode. The potentially large read remains asynchronous.
    fd = fs.openSync(path.join(getDataDir(), 'assets', image.filepath), 'r');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Source image missing on disk', { cause: err });
    throw err;
  }

  try {
    const bytes = await new Promise((resolve, reject) => {
      fs.readFile(fd, (err, value) => (err ? reject(err) : resolve(value)));
    });
    const current = resolveImage(productId, imageId, expectedContentHash);
    return { image: current, bytes, sourceHash: sha1(bytes) };
  } finally {
    fs.closeSync(fd);
  }
}

function register({ expose, emitCatalogChange }) {
  // `foregroundBytes` is an envelope containing transformed bytes plus the
  // SHA-1 of the source fetched by the renderer. Recursive RPC serialization
  // restores its nested bytes to Buffer in client mode; structured clone keeps
  // the ArrayBuffer in local mode.
  expose('workspace:processImage', async ({ productId, imageId, expectedContentHash, settings, foregroundBytes } = {}) => {
    const product = products.get(productId);
    if (!product) throw new Error('Product not found');
    if (!expectedContentHash) {
      throw new Error('Image identity unavailable; re-import the image and try again');
    }
    const source = await readSource(productId, imageId, expectedContentHash);
    let target = source.image;
    let fgBuffer = source.bytes;
    if (foregroundBytes) {
      if (!foregroundBytes.bytes || !foregroundBytes.sourceHash) {
        throw new Error('Foreground source identity unavailable; reload and try again');
      }
      if (foregroundBytes.sourceHash !== source.sourceHash) {
        throw new Error('Image changed; reload and try again');
      }
      fgBuffer = Buffer.from(foregroundBytes.bytes);
    }

    let output;
    let attached = false;
    try {
      output = await processingPipeline.processImage({
        sku: product.sku,
        originalFilename: target.filename,
        foregroundBuffer: fgBuffer,
        settings,
      });

      // The pipeline is async. Another client can reorder, remove, or replace
      // this image while it runs, so resolve the immutable row again before
      // writing anything back.
      target = resolveImage(productId, imageId, expectedContentHash);
      productImages.setProcessedById(productId, target.id, {
        isProcessed: true,
        processedFilepath: output.relativePath,
        workspaceSettings: settings,
      });
      attached = true;
      products.recomputeProcessStatus(productId);
      emitCatalogChange('images', 'processed', productId);
    } catch (err) {
      if (!attached && output?.absolutePath) {
        try { await fs.promises.unlink(output.absolutePath); } catch (_) { /* uncommitted cleanup is best-effort */ }
      }
      throw err;
    }

    return {
      images: productImages.listByProduct(productId),
      processedRelativePath: output.relativePath,
    };
  });

  expose('workspace:saveSettings', ({ productId, imageId, expectedContentHash, settings } = {}) => {
    const target = resolveImage(productId, imageId, expectedContentHash);
    productImages.setProcessedById(productId, target.id, {
      isProcessed: target.isProcessed,
      processedFilepath: target.processedFilepath,
      workspaceSettings: settings,
    });
    return productImages.listByProduct(productId);
  });
}

module.exports = { register };
