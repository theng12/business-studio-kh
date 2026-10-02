/**
 * Data-safety fixes in the image and recycle-bin paths — each case is a way a
 * photo used to be erased, overwritten or attached to the wrong product.
 *
 *   1. images:removeFromProduct with a path the product does not own (a stale
 *      screen, or `../database.sqlite`) erased that file. It must refuse and
 *      touch nothing, and a failed hold must not erase the photo either.
 *   2. SKUs that differ only by letter case (`abc-1` / `ABC-1`) are one folder
 *      on the Mac's disk, so they shared — and overwrote — each other's photos.
 *      Same for two companies whose names land on one folder.
 *   3. A renumber must never rename over a file it does not own.
 *   4. An in-place edit that finishes after a set-main lands on the photo it
 *      started from, not on whatever now sits at the old path; and one whose
 *      photo changed meanwhile is refused.
 *   5. Two adds into one product at once each get their own slot.
 *   6. A recycle-bin entry whose held file is gone (a restored backup) refuses
 *      to restore instead of pointing a row at another photo's file, and the
 *      boot sweep forgets it.
 *   7. A product whose brand was deleted meanwhile restores (without the brand)
 *      instead of failing forever on the foreign key.
 *   8. A product restore never takes over a folder somebody else now uses.
 *   9. Reverting / purging a duplicate merge hands leftover photos to the
 *      Trash helper instead of `rmSync`.
 *  10. A restored product gets its AI gallery rows back.
 *
 * RUNNING THIS. Real SQLite + real files: `npm run test:native`.
 * Under plain `npm test` these cases SKIP with that command as the reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/* The Trash helper is replaced before anything loads it, so the merge cases
 * can see WHAT would be handed to the Trash — and the bytes stay on disk for
 * the assertions. (Outside Electron the real helper deletes for real.) */
const trashed = [];
const fileTrashPath = require.resolve('../main/util/fileTrash');
require.cache[fileTrashPath] = {
  id: fileTrashPath,
  filename: fileTrashPath,
  loaded: true,
  exports: {
    trashPath: async (abs) => { trashed.push(abs); return 'trashed'; },
    trashPathInBackground: (abs) => { trashed.push(abs); },
    electronShell: () => null,
  },
};

let db = null;
let companies = null;
let brands = null;
let products = null;
let productImages = null;
let deleted = null;
let imageDedup = null;
let sharp = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  brands = require('../main/db/brands');
  products = require('../main/db/products');
  productImages = require('../main/db/productImages');
  deleted = require('../main/deletedItems');
  imageDedup = require('../main/imageDedup');
  sharp = require('sharp');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

let counter = 0;
function freshDataDir() {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-safety-${counter}-`));
  db.initDb(dataDir);
  return dataDir;
}

function abs(dataDir, rel) {
  return path.join(dataDir, 'assets', rel);
}

/** A product with N real files and rows at the canonical slots. */
function productWithImages({ companyName = 'Shop', sku = 'P-1', brandId = null, images = 2 } = {}) {
  const dataDir = freshDataDir();
  const company = companies.create({ name: companyName, isActive: true });
  const product = products.create({ companyId: company.id, sku, name: sku, brandId: brandId ?? undefined });
  const { dir } = productImages.dirForProduct(product.id);
  const rels = [];
  for (let i = 1; i <= images; i += 1) {
    const rel = path.posix.join(dir, `${sku}-${String(i).padStart(3, '0')}.jpg`);
    fs.mkdirSync(path.dirname(abs(dataDir, rel)), { recursive: true });
    fs.writeFileSync(abs(dataDir, rel), `bytes-${i}`);
    productImages.addRow(product.id, {
      filepath: rel, filename: path.posix.basename(rel), contentHash: `hash-${i}`, orderIndex: i - 1,
    });
    rels.push(rel);
  }
  return { dataDir, company, product, dir, rels };
}

function cleanup(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/* ─── 1. remove() ─────────────────────────────────────────────────── */

test('removing a path the product does not own throws and erases nothing', { skip: skipReason }, () => {
  const { dataDir, product, rels } = productWithImages();
  const other = products.create({ companyId: product.companyId, sku: 'OTHER-1' });
  const { dir: otherDir } = productImages.dirForProduct(other.id);
  const otherRel = path.posix.join(otherDir, 'OTHER-1-001.jpg');
  fs.mkdirSync(path.dirname(abs(dataDir, otherRel)), { recursive: true });
  fs.writeFileSync(abs(dataDir, otherRel), 'someone else');

  // Another product's photo — what a stale screen would send.
  assert.throws(() => productImages.remove(product.id, otherRel), /not on this product/);
  assert.equal(fs.readFileSync(abs(dataDir, otherRel), 'utf8'), 'someone else');

  // A path that climbs out of the library.
  const dbFile = path.join(dataDir, 'database.sqlite');
  const dbExisted = fs.existsSync(dbFile);
  assert.throws(() => productImages.remove(product.id, '../database.sqlite'), /not inside the library/);
  assert.equal(fs.existsSync(dbFile), dbExisted, 'the database file is untouched');

  assert.equal(productImages.listByProduct(product.id).length, rels.length, 'no row was removed');
  for (const rel of rels) assert.ok(fs.existsSync(abs(dataDir, rel)));
  assert.equal(deleted.count(), 0, 'nothing went to the bin either');
  cleanup(dataDir);
});

test('if the photo cannot be held, it is not deleted at all', { skip: skipReason }, () => {
  const { dataDir, product, rels } = productWithImages();
  // A FILE where the bin's folder should be makes every hold fail.
  fs.writeFileSync(path.join(dataDir, '.recycle'), 'in the way');

  assert.throws(() => productImages.remove(product.id, rels[0]));
  assert.equal(fs.readFileSync(abs(dataDir, rels[0]), 'utf8'), 'bytes-1', 'the photo is still there');
  assert.equal(productImages.listByProduct(product.id).length, 2, 'and so is its row');
  cleanup(dataDir);
});

test('assetAbsPath refuses anything outside <dataDir>/assets', { skip: skipReason }, () => {
  const dataDir = freshDataDir();
  for (const bad of ['../database.sqlite', '../../etc/passwd', '', 'a/../../x']) {
    assert.throws(() => productImages.assetAbsPath(bad), /not inside the library/, bad);
  }
  assert.equal(productImages.assetAbsPath('A/B/c.jpg'), path.join(dataDir, 'assets', 'A', 'B', 'c.jpg'));
  cleanup(dataDir);
});

/* ─── 2. case-insensitive folder collisions ───────────────────────── */

test('SKUs that differ only by letter case cannot share a folder', { skip: skipReason }, () => {
  const dataDir = freshDataDir();
  const company = companies.create({ name: 'Shop', isActive: true });
  products.create({ companyId: company.id, sku: 'abc-1' });
  assert.throws(
    () => products.create({ companyId: company.id, sku: 'ABC-1' }),
    /share an image folder with "abc-1"/,
  );
  const b = products.create({ companyId: company.id, sku: 'XYZ-9' });
  assert.throws(() => products.update(b.id, { sku: 'Abc 1' }), /share an image folder/);
  cleanup(dataDir);
});

test('two companies whose names land on one folder do not share product folders', { skip: skipReason }, () => {
  const dataDir = freshDataDir();
  const first = companies.create({ name: 'A&B', isActive: true });
  const second = companies.create({ name: 'A B', isActive: true });
  products.create({ companyId: first.id, sku: 'SKU-1' });
  assert.throws(() => products.create({ companyId: second.id, sku: 'sku-1' }), /share an image folder/);
  cleanup(dataDir);
});

test('a bulk import refuses a case-variant SKU, within the file and against the catalogue', { skip: skipReason }, () => {
  const dataDir = freshDataDir();
  const company = companies.create({ name: 'Shop', isActive: true });
  products.create({ companyId: company.id, sku: 'old-1' });
  const result = products.bulkUpsert(company.id, [
    { sku: 'NEW-1', name: 'a' },
    { sku: 'new 1', name: 'b' },
    { sku: 'OLD-1', name: 'c' },
    { sku: 'FINE-2', name: 'd' },
  ]);
  assert.equal(result.inserted, 2, 'NEW-1 and FINE-2 go in');
  assert.deepEqual(result.skips.map((s) => s.sku).sort(), ['OLD-1', 'new 1']);
  for (const s of result.skips) assert.match(s.reason, /share an image folder/);
  cleanup(dataDir);
});

test('deleting one of two case-variant products (old data) leaves the shared folder alone', { skip: skipReason }, () => {
  const { dataDir, company, product, rels } = productWithImages({ sku: 'dup-1' });
  // Simulate data written before the guard.
  const id = crypto.randomUUID();
  db.getDb().prepare(`INSERT INTO products (id, company_id, sku, name, status, tags, prices, custom_fields,
      track_inventory, process_status, created_at, updated_at)
    VALUES (?, ?, 'DUP-1', 'x', 'active', '[]', '{}', '{}', 0, 'unprocessed', 0, 0)`).run(id, company.id);

  products.remove(id);
  for (const rel of rels) assert.ok(fs.existsSync(abs(dataDir, rel)), `${rel} survived its neighbour's delete`);
  assert.equal(productImages.listByProduct(product.id).length, 2);
  cleanup(dataDir);
});

/* ─── 3. renumber never clobbers ──────────────────────────────────── */

test('a renumber refuses to rename over a file that is not one of its own', { skip: skipReason }, () => {
  const dataDir = freshDataDir();
  const company = companies.create({ name: 'Shop', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'R-1' });
  const { dir } = productImages.dirForProduct(product.id);
  const mine = path.posix.join(dir, 'R-1-005.jpg');
  const foreign = path.posix.join(dir, 'R-1-001.jpg');
  fs.mkdirSync(path.dirname(abs(dataDir, mine)), { recursive: true });
  fs.writeFileSync(abs(dataDir, mine), 'mine');
  fs.writeFileSync(abs(dataDir, foreign), 'not mine');
  productImages.addRow(product.id, { filepath: mine, filename: 'R-1-005.jpg', orderIndex: 0 });

  assert.throws(() => productImages.renumberFiles(product.id), /is not one of its photos/);
  assert.equal(fs.readFileSync(abs(dataDir, foreign), 'utf8'), 'not mine', 'the stranger is untouched');
  assert.equal(fs.readFileSync(abs(dataDir, mine), 'utf8'), 'mine', 'and so is the product\'s own photo');
  assert.equal(productImages.listByProduct(product.id)[0].filepath, mine, 'the row still points at it');
  cleanup(dataDir);
});

/* ─── 4. in-place edits follow the row ────────────────────────────── */

test('an in-place edit lands on the row it started from even after a set-main', { skip: skipReason }, () => {
  const { dataDir, product, rels } = productWithImages();
  const [, second] = productImages.listByProduct(product.id);
  assert.equal(second.filepath, rels[1]);

  // The edit's slow part is done: the new bytes wait in a tmp file.
  const tmp = path.join(path.dirname(abs(dataDir, rels[1])), '__edit-tmp.jpg');
  fs.writeFileSync(tmp, 'edited second');

  // Meanwhile someone made photo 2 the main one: every file was renumbered.
  productImages.setMain(product.id, second.filepath);
  assert.equal(fs.readFileSync(abs(dataDir, rels[1]), 'utf8'), 'bytes-1', 'the old path now holds photo 1');

  const updated = productImages.replaceImageFile(product.id, second.id, {
    tmpAbs: tmp, newHash: 'hash-edited', expectedHash: second.contentHash,
  });
  assert.equal(updated.id, second.id);
  assert.equal(updated.filepath, rels[0], 'photo 2 lives at slot 1 now');
  assert.equal(fs.readFileSync(abs(dataDir, rels[0]), 'utf8'), 'edited second');
  assert.equal(fs.readFileSync(abs(dataDir, rels[1]), 'utf8'), 'bytes-1', 'photo 1 was not overwritten');
  assert.equal(productImages.getById(product.id, second.id).contentHash, 'hash-edited');
  cleanup(dataDir);
});

test('an in-place edit of a photo that changed meanwhile is refused and changes nothing', { skip: skipReason }, () => {
  const { dataDir, product, rels } = productWithImages();
  const [first] = productImages.listByProduct(product.id);
  const tmp = path.join(path.dirname(abs(dataDir, rels[0])), '__edit-tmp.jpg');
  fs.writeFileSync(tmp, 'late edit');

  assert.throws(
    () => productImages.replaceImageFile(product.id, first.id, { tmpAbs: tmp, newHash: 'x', expectedHash: 'stale-hash' }),
    /changed by another edit/,
  );
  assert.equal(fs.readFileSync(abs(dataDir, rels[0]), 'utf8'), 'bytes-1');

  productImages.remove(product.id, rels[0]);
  assert.throws(
    () => productImages.replaceImageFile(product.id, first.id, { tmpAbs: tmp, newHash: 'x', expectedHash: first.contentHash }),
    /was removed/,
  );
  cleanup(dataDir);
});

test('a format conversion never lands on a slot another file holds', { skip: skipReason }, () => {
  const { dataDir, product, rels } = productWithImages();
  const [first] = productImages.listByProduct(product.id);
  const pngTwin = rels[0].replace(/\.jpg$/, '.png');
  fs.writeFileSync(abs(dataDir, pngTwin), 'a stray png');
  const tmp = path.join(path.dirname(abs(dataDir, rels[0])), '__convert-tmp.png');
  fs.writeFileSync(tmp, 'converted');

  assert.throws(
    () => productImages.replaceImageFile(product.id, first.id, { tmpAbs: tmp, newHash: 'x', expectedHash: first.contentHash, newExt: '.png' }),
    /already exists/,
  );
  assert.equal(fs.readFileSync(abs(dataDir, pngTwin), 'utf8'), 'a stray png');
  assert.equal(fs.readFileSync(abs(dataDir, rels[0]), 'utf8'), 'bytes-1');
  cleanup(dataDir);
});

/* ─── 5. concurrent adds ──────────────────────────────────────────── */

test('two adds into one product at once get two slots and keep both photos', { skip: skipReason }, async () => {
  const dataDir = freshDataDir();
  const company = companies.create({ name: 'Shop', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'C-1' });
  const red = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).png().toBuffer();

  const [a, b] = await Promise.all([
    productImages.addFromBytes(product.id, red, '.png'),
    productImages.addFromBytes(product.id, blue, '.png'),
  ]);
  assert.equal(a.skipped, false);
  assert.equal(b.skipped, false);
  assert.notEqual(a.image.filepath, b.image.filepath, 'different slots');
  const list = productImages.listByProduct(product.id);
  assert.deepEqual(list.map((i) => i.orderIndex), [0, 1]);
  const hashes = list.map((i) => crypto.createHash('sha1').update(fs.readFileSync(abs(dataDir, i.filepath))).digest('hex'));
  assert.notEqual(hashes[0], hashes[1], 'the two files hold two different pictures');
  cleanup(dataDir);
});

test('the per-product queue keeps going after a failed operation', { skip: skipReason }, async () => {
  const order = [];
  await assert.rejects(productImages.withProductImageLock('p', async () => { order.push(1); throw new Error('boom'); }));
  await productImages.withProductImageLock('p', () => { order.push(2); });
  assert.deepEqual(order, [1, 2]);
});

test('a refused renumber leaves the old order in place, not the new one', { skip: skipReason }, () => {
  // Two photos stored under non-canonical names, and a stray file sitting in
  // the slot the renumber would move the new main into.
  const dataDir = freshDataDir();
  const company = companies.create({ name: 'Shop', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'P-9', name: 'P-9' });
  const { dir } = productImages.dirForProduct(product.id);
  const rels = ['odd-a.jpg', 'odd-b.jpg'].map((name, i) => {
    const rel = path.posix.join(dir, name);
    fs.mkdirSync(path.dirname(abs(dataDir, rel)), { recursive: true });
    fs.writeFileSync(abs(dataDir, rel), `bytes-${i}`);
    productImages.addRow(product.id, { filepath: rel, filename: name, contentHash: `h-${i}`, orderIndex: i });
    return rel;
  });
  const stray = abs(dataDir, path.posix.join(dir, 'P-9-001.jpg'));
  fs.writeFileSync(stray, 'not a photo of this product');

  assert.throws(() => productImages.setMain(product.id, rels[1]), /could not be put back in order/);
  assert.deepEqual(productImages.listByProduct(product.id).map((i) => i.filepath), rels,
    'the main image is still the original one — the refusal did not half-apply');
  assert.equal(fs.readFileSync(stray, 'utf8'), 'not a photo of this product');
  cleanup(dataDir);
});

/* ─── 6. bin entries whose files are gone ─────────────────────────── */

test('restoring a photo whose held file is gone refuses, and the boot sweep keeps it listed', { skip: skipReason }, () => {
  const { dataDir, product, rels } = productWithImages({ images: 3 });
  productImages.remove(product.id, rels[1]);
  const item = deleted.list({})[0];
  // What a backup restore leaves: the row is listed, `.recycle` is not there.
  fs.rmSync(deleted.heldDir(item.id), { recursive: true, force: true });

  const before = productImages.listByProduct(product.id).map((i) => i.filepath);
  assert.throws(() => deleted.restore(item.id), /no longer in Recently deleted/);
  assert.deepEqual(productImages.listByProduct(product.id).map((i) => i.filepath), before,
    'no row was added on top of another photo');

  // A missing hold is not proof the files are gone (a moved data folder, a
  // slow volume), so boot must never silently drop the entry.
  deleted.purgeExpired({ retentionDays: 30 });
  assert.equal(deleted.count(), 1, 'the entry stays listed until it expires or is removed by hand');
  assert.equal(deleted.dropOrphanedHolds(), 1, 'an explicit clean-up can still forget it');
  assert.equal(deleted.count(), 0);
  cleanup(dataDir);
});

test('a restored photo never shares a filepath with a live row', { skip: skipReason }, () => {
  const { dataDir, product, rels } = productWithImages({ images: 2 });
  productImages.remove(product.id, rels[0]);
  // The survivor was renumbered into rels[0]; the held file is named rels[0] too.
  assert.equal(productImages.listByProduct(product.id)[0].filepath, rels[0]);
  deleted.restore(deleted.list({})[0].id);

  const list = productImages.listByProduct(product.id);
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((i) => i.filepath.toLowerCase())).size, 2, 'two rows, two files');
  assert.equal(fs.readFileSync(abs(dataDir, list[0].filepath), 'utf8'), 'bytes-2');
  assert.equal(fs.readFileSync(abs(dataDir, list[1].filepath), 'utf8'), 'bytes-1');
  cleanup(dataDir);
});

test('a photo restore that would pass the per-product cap is refused', { skip: skipReason }, () => {
  const { MAX_IMAGES_PER_PRODUCT } = require('../main/imageManager');
  const { dataDir, product, rels, dir } = productWithImages({ images: 1 });
  productImages.remove(product.id, rels[0]);
  for (let i = 0; i < MAX_IMAGES_PER_PRODUCT; i += 1) {
    productImages.addRow(product.id, { filepath: `${dir}/filler-${i}.jpg`, filename: `filler-${i}.jpg`, orderIndex: i });
  }
  assert.throws(() => deleted.restore(deleted.list({})[0].id), /the most one product can hold/);
  assert.equal(deleted.count(), 1, 'it stays in the bin');
  cleanup(dataDir);
});

/* ─── 7 / 8 / 10. product restore ─────────────────────────────────── */

test('a product whose brand was deleted meanwhile restores without the brand', { skip: skipReason }, () => {
  const dataDir = freshDataDir();
  const company = companies.create({ name: 'Shop', isActive: true });
  const brand = brands.create({ companyId: company.id, name: 'Royal' });
  const product = products.create({ companyId: company.id, sku: 'B-1', brandId: brand.id });
  const { dir } = productImages.dirForProduct(product.id);
  assert.equal(dir, 'Shop/Royal/B-1');
  const rel = `${dir}/B-1-001.jpg`;
  fs.mkdirSync(path.dirname(abs(dataDir, rel)), { recursive: true });
  fs.writeFileSync(abs(dataDir, rel), 'royal photo');
  productImages.addRow(product.id, { filepath: rel, filename: 'B-1-001.jpg', orderIndex: 0 });

  products.remove(product.id);
  brands.remove(brand.id);
  deleted.restore(deleted.list({})[0].id);

  const back = products.get(product.id);
  assert.ok(back, 'restored — not "FOREIGN KEY constraint failed"');
  assert.equal(back.brandId, null);
  const [img] = productImages.listByProduct(product.id);
  assert.equal(img.filepath, 'Shop/_unassigned/B-1/B-1-001.jpg', 'the row follows the folder it now belongs in');
  assert.equal(fs.readFileSync(abs(dataDir, img.filepath), 'utf8'), 'royal photo');
  cleanup(dataDir);
});

test('a product whose company was deleted refuses to restore with a reason', { skip: skipReason }, () => {
  const { dataDir, company, product } = productWithImages();
  products.remove(product.id);
  db.getDb().prepare('DELETE FROM companies WHERE id = ?').run(company.id);
  const item = deleted.get(deleted.list({})[0].id);
  assert.throws(() => deleted.restore(item.id), /company this product belonged to has been deleted/);
  cleanup(dataDir);
});

test('a product restore never takes over a folder with somebody else\'s files', { skip: skipReason }, () => {
  const { dataDir, product, dir } = productWithImages();
  products.remove(product.id);
  const item = deleted.list({})[0];
  // Someone put files where this product's folder used to be.
  fs.mkdirSync(abs(dataDir, dir), { recursive: true });
  fs.writeFileSync(abs(dataDir, `${dir}/stranger.jpg`), 'stranger');

  assert.throws(() => deleted.restore(item.id), /already has files in it/);
  assert.equal(fs.readFileSync(abs(dataDir, `${dir}/stranger.jpg`), 'utf8'), 'stranger');
  assert.ok(fs.existsSync(path.join(deleted.heldDir(item.id), 'assets', 'P-1-001.jpg')), 'the held photos stay held');
  assert.equal(products.get(product.id), null);
  cleanup(dataDir);
});

test('a restored product gets its AI gallery rows back', { skip: skipReason }, () => {
  const { dataDir, company, product } = productWithImages();
  const galleryRel = 'ai-gallery/P-1/shot.png';
  fs.mkdirSync(path.join(dataDir, 'ai-gallery', 'P-1'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, galleryRel), 'ai pixels');
  const galleryId = crypto.randomUUID();
  db.getDb().prepare(`INSERT INTO ai_gallery (id, task_id, product_id, filepath, prompt, provider, model, created_at, company_id)
    VALUES (?, NULL, ?, ?, 'a prompt', 'openai', 'model-x', 1, ?)`).run(galleryId, product.id, galleryRel, company.id);

  products.remove(product.id);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM ai_gallery').get().n, 0, 'cascaded away with the product');
  deleted.restore(deleted.list({})[0].id);

  const row = db.getDb().prepare('SELECT * FROM ai_gallery WHERE id = ?').get(galleryId);
  assert.ok(row, 'the gallery row came back');
  assert.equal(row.product_id, product.id);
  assert.equal(row.prompt, 'a prompt');
  assert.equal(fs.readFileSync(path.join(dataDir, row.filepath), 'utf8'), 'ai pixels');
  cleanup(dataDir);
});

/* ─── 9. merge revert / purge ─────────────────────────────────────── */

test('reverting a merge whose product is gone hands the photo to the Trash, never rmSync', { skip: skipReason }, () => {
  const { dataDir, product } = productWithImages();
  const [keep, drop] = productImages.listByProduct(product.id);
  const { opId } = imageDedup.mergeGroups({ decisions: [{ productId: product.id, keepId: keep.id, removeIds: [drop.id] }] });
  const qDir = path.join(dataDir, '.merge-trash', opId);
  assert.equal(fs.readdirSync(qDir).length, 1, 'the duplicate is quarantined');

  products.remove(product.id);
  trashed.length = 0;
  const result = imageDedup.revertMergeOp(opId);
  assert.equal(result.restored, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(trashed, [qDir], 'the leftover goes to the Trash helper');
  assert.equal(fs.readdirSync(qDir).length, 1, 'and nothing erased it in place');
  cleanup(dataDir);
});

test('purging merges goes through the Trash helper too', { skip: skipReason }, () => {
  const { dataDir, product } = productWithImages({ images: 3 });
  const [keep, drop1, drop2] = productImages.listByProduct(product.id);
  const op1 = imageDedup.mergeGroups({ decisions: [{ productId: product.id, keepId: keep.id, removeIds: [drop1.id] }] }).opId;
  const op2 = imageDedup.mergeGroups({ decisions: [{ productId: product.id, keepId: keep.id, removeIds: [drop2.id] }] }).opId;

  trashed.length = 0;
  imageDedup.purgeMergeOp(op1);
  assert.deepEqual(trashed, [path.join(dataDir, '.merge-trash', op1)]);
  assert.ok(fs.existsSync(path.join(dataDir, '.merge-trash', op1)), 'not erased in place');

  trashed.length = 0;
  imageDedup.purgeAll();
  assert.deepEqual(trashed, [path.join(dataDir, '.merge-trash')], 'one move for the whole quarantine');
  assert.ok(fs.existsSync(path.join(dataDir, '.merge-trash', op2)));
  cleanup(dataDir);
});

test('reverting a merge restores the photo next to — not on top of — the renumbered survivors', { skip: skipReason }, () => {
  const { dataDir, product } = productWithImages({ images: 3 });
  const [, middle] = productImages.listByProduct(product.id);
  const { opId } = imageDedup.mergeGroups({ decisions: [{ productId: product.id, keepId: middle.id, removeIds: [productImages.listByProduct(product.id)[0].id] }] });
  imageDedup.revertMergeOp(opId);

  const list = productImages.listByProduct(product.id);
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((i) => i.filepath)).size, 3);
  const bytes = list.map((i) => fs.readFileSync(abs(dataDir, i.filepath), 'utf8')).sort();
  assert.deepEqual(bytes, ['bytes-1', 'bytes-2', 'bytes-3'], 'every photo is still there exactly once');
  cleanup(dataDir);
});
