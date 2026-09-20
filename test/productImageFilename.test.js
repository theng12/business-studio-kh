/**
 * v0.1.16: `productImages.setFilepath` must update `filename` too.
 *
 * Why this exists. Converting a product image to another format renames the
 * file on disk (`.jpg` → `.webp`) and points the row at the new path. The
 * update moved `filepath` and `file_size` but left `filename` behind, so a
 * converted image kept advertising its OLD extension. Nothing errors — the
 * bytes are right and the file on disk is right — but the Lightbox caption,
 * the History modal and the AI Studio source label all read `filename`, so the
 * user is told a WebP file is a `.jpg`.
 *
 * `filename` is the current on-disk basename everywhere else in
 * main/db/productImages.js: it is `path.posix.basename(filepath)` on insert,
 * and the renumber pass updates `filepath` and `filename` in the same UPDATE.
 * This test pins `setFilepath` to that same convention.
 *
 * RUNNING THIS. It exercises the real module against a real temporary SQLite
 * database, because the bug was a missing column in an UPDATE — mirroring the
 * SQL here would have reproduced the bug rather than caught it. That means it
 * needs the native `better-sqlite3` binary, which this project builds for
 * ELECTRON's ABI (see `npm run native:host`). Plain `node --test` therefore
 * cannot load it, so:
 *
 *     npm run test:native      # runs this file under Electron's own Node
 *
 * Under the plain `npm test` run these two cases SKIP rather than fail, with
 * the command above in the reason. Everything else in test/ is pure JS and
 * runs in both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Load the DB stack, tolerating the ABI mismatch that plain `node --test` hits.
 * `require('better-sqlite3')` itself succeeds — the native binding is loaded
 * lazily on the first `new Database(...)` — so the probe below is what actually
 * forces the mismatch to surface. Anything other than ERR_DLOPEN_FAILED is a
 * real problem and is rethrown.
 */
let db = null;
let companies = null;
let products = null;
let productImages = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  productImages = require('../main/db/productImages');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

/** A fresh data dir + DB with one company, one product and one image row. */
function freshFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-setfilepath-'));
  db.initDb(dataDir);

  const company = companies.create({ name: 'Test Co', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'T-1', name: 'Test' });

  const relPath = 'Test-Co/_unassigned/T-1/T-1-001.jpg';
  const absPath = path.join(dataDir, 'assets', relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, Buffer.from('not really a jpeg, but 27 bytes.'));

  const { image } = productImages.addRow(product.id, {
    filepath: relPath,
    filename: path.posix.basename(relPath),
    originalFilepath: relPath,
    contentHash: 'deadbeef',
    orderIndex: 0,
  });

  return { dataDir, product, image, relPath, absPath };
}

/** The raw row, so assertions read the stored columns and not a mapper. */
function rowFor(imageId) {
  return db.getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(imageId);
}

test('setFilepath — follows an extension change and updates filename with it', { skip: skipReason }, () => {
  const { dataDir, product, image, relPath } = freshFixture();

  // The Convert flow writes the new file, then repoints the row.
  const newRel = relPath.replace(/\.jpg$/, '.webp');
  fs.writeFileSync(path.join(dataDir, 'assets', newRel), Buffer.alloc(4096, 7));

  const before = rowFor(image.id);
  assert.equal(before.filename, 'T-1-001.jpg');

  const updated = productImages.setFilepath(product.id, relPath, newRel);

  assert.equal(updated.filepath, newRel, 'filepath should follow the rename');
  assert.equal(updated.filename, 'T-1-001.webp', 'filename must follow the rename too');
  assert.equal(updated.fileSize, 4096, 'fileSize should be refreshed from the new file');

  // Same answer from a fresh read, so this is not a return-value artefact.
  const after = rowFor(image.id);
  assert.equal(after.filepath, newRel);
  assert.equal(after.filename, 'T-1-001.webp');
  assert.equal(after.file_size, 4096);

  // And the two columns agree, which is the actual invariant.
  assert.equal(after.filename, path.posix.basename(after.filepath));
});

test('setFilepath — a same-extension rewrite leaves the name alone', { skip: skipReason }, () => {
  // The Compress / Resize flows overwrite in place and never call setFilepath,
  // but if they ever do, the name must not drift.
  const { dataDir, product, image, relPath } = freshFixture();
  fs.writeFileSync(path.join(dataDir, 'assets', relPath), Buffer.alloc(1234, 3));

  const updated = productImages.setFilepath(product.id, relPath, relPath);

  assert.equal(updated.filepath, relPath);
  assert.equal(updated.filename, 'T-1-001.jpg');
  assert.equal(updated.fileSize, 1234);
  assert.equal(rowFor(image.id).filename, 'T-1-001.jpg');
});
