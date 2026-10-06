/**
 * v0.1.86: the recycle bin — delete, restore, purge, expire.
 *
 * The owner's accident produced two questions: what happens to a deleted
 * product, and can we have a restore window ("7 or 15 or 30 days before it's
 * permanently gone"). This file drives the real module against a real temporary
 * data folder, because every property worth having here is about FILES —
 * whether the pictures left the assets tree, whether they came back, and
 * whether the row that comes back still points at something real.
 *
 * The properties pinned:
 *
 *   1. Deleting a product moves its folder into `.recycle/<id>/` (a rename, not
 *      a copy) and writes one `deleted_items` row carrying the snapshot.
 *   2. Restoring re-inserts the product AND its image rows with the ids and
 *      filepaths they had, and the files are back where those rows point — a
 *      restore that leaves broken image links would look like it worked and
 *      would not.
 *   3. A photo deleted on its own comes back too, appended at the end because
 *      the surviving photos were renumbered while it was away.
 *   4. Restoring refuses when the SKU exists again, and says so.
 *   5. The retention sweep removes only what is older than the window, and
 *      `0` means "keep until I say so".
 *   6. Purging sends the files to the macOS Trash rather than shredding them.
 *
 * RUNNING THIS. Real SQLite + real files: `npm run test:native`.
 * Under plain `npm test` these cases SKIP with that command as the reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let companies = null;
let products = null;
let productImages = null;
let deleted = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  productImages = require('../main/db/productImages');
  deleted = require('../main/deletedItems');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

let counter = 0;
/** A data dir with one company and one product carrying two real image files. */
function fixture({ sku = 'REC-1', images = 2 } = {}) {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-recycle-${counter}-`));
  db.initDb(dataDir);
  const company = companies.create({ name: 'Shop', isActive: true });
  const product = products.create({ companyId: company.id, sku, name: `Widget ${sku}`, status: 'active' });

  const relDir = path.posix.join('Shop', '_unassigned', sku.replace(/[^A-Za-z0-9._-]+/g, '-'));
  const files = [];
  for (let i = 1; i <= images; i += 1) {
    const rel = path.posix.join(relDir, `${sku}-${String(i).padStart(3, '0')}.jpg`);
    const abs = path.join(dataDir, 'assets', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `bytes-${i}`);
    productImages.addRow(product.id, {
      filepath: rel,
      filename: path.posix.basename(rel),
      originalFilepath: rel,
      contentHash: `hash-${i}`,
      orderIndex: i - 1,
    });
    files.push(rel);
  }
  return { dataDir, company, product, relDir, files };
}

function assetsPath(dataDir, rel) {
  return path.join(dataDir, 'assets', rel);
}

test('deleting a product holds its rows and its folder instead of erasing them', { skip: skipReason }, () => {
  const { dataDir, product, relDir } = fixture();

  products.remove(product.id);

  assert.equal(products.get(product.id), null, 'the product is out of the library');
  assert.equal(fs.existsSync(assetsPath(dataDir, relDir)), false, 'and its folder left the assets tree');

  const items = deleted.list({});
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'product');
  assert.equal(items[0].label, 'REC-1');
  assert.ok(items[0].daysLeft > 25, `a fresh item has its whole window ahead of it, saw ${items[0].daysLeft}`);

  const held = deleted.heldDir(items[0].id);
  assert.equal(fs.existsSync(path.join(held, 'assets')), true, 'the folder is held for restore');
  assert.equal(
    fs.readFileSync(path.join(held, 'assets', 'REC-1-001.jpg'), 'utf8'), 'bytes-1',
    'with the bytes intact — this is what the macOS Trash route could not give back',
  );
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('restoring brings the product, its photos and the files back together', { skip: skipReason }, () => {
  const { dataDir, product, files } = fixture();
  const before = productImages.listByProduct(product.id).map((i) => ({ id: i.id, filepath: i.filepath, order: i.orderIndex }));
  products.remove(product.id);
  assert.equal(deleted.count(), 1);

  const item = deleted.list({})[0];
  deleted.restore(item.id);

  const restored = products.get(product.id);
  assert.ok(restored, 'the product is back with the SAME id');
  assert.equal(restored.sku, 'REC-1');
  const after = productImages.listByProduct(product.id).map((i) => ({ id: i.id, filepath: i.filepath, order: i.orderIndex }));
  assert.deepEqual(after, before, 'the image rows are the ones that were deleted, in the same order');

  // The point of the whole feature: the rows point at files that exist.
  for (const rel of files) {
    assert.equal(fs.existsSync(assetsPath(dataDir, rel)), true, `${rel} is back on disk`);
    assert.equal(fs.readFileSync(assetsPath(dataDir, rel), 'utf8'), `bytes-${files.indexOf(rel) + 1}`);
  }
  assert.equal(deleted.count(), 0, 'and it left the deleted list');
  assert.equal(fs.existsSync(deleted.heldDir(item.id)), false,
    'and the hollow folder it left behind is gone — the bin must not fill up with empty directories');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a photo deleted on its own comes back too, at the end of the gallery', { skip: skipReason }, () => {
  const { dataDir, product, files } = fixture({ sku: 'REC-2', images: 3 });
  const doomed = files[1]; // the middle one: deleting it renumbers the third

  productImages.remove(product.id, productImages.listByProduct(product.id).find((row) => row.filepath === doomed).id);

  // The path `REC-2-002.jpg` exists again immediately — renumberFiles promoted
  // the third photo into it. So the assertion has to be about the BYTES, which
  // is also the reason an async Trash move would have been unsafe here.
  const survivors = productImages.listByProduct(product.id).map((i) => i.filepath);
  assert.equal(survivors.length, 2);
  const bytesOnDisk = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(path.join(dataDir, 'assets'));
    return out;
  };
  assert.equal(bytesOnDisk().includes('bytes-2'), false, "the deleted photo's bytes left the assets tree");
  assert.equal(bytesOnDisk().includes('bytes-3'), true, 'while the survivor took its slot');

  const item = deleted.list({}).find((i) => i.kind === 'image');
  assert.ok(item, 'the photo is in the deleted list');
  assert.equal(item.label, path.posix.basename(doomed));

  deleted.restore(item.id);

  const after = productImages.listByProduct(product.id);
  assert.equal(after.length, 3, 'three photos again');
  const restoredRow = after.find((i) => {
    const abs = assetsPath(dataDir, i.filepath);
    return fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === 'bytes-2';
  });
  assert.ok(restoredRow, 'the deleted photo is back on disk and a row points at it');
  assert.equal(restoredRow.orderIndex, 2, 'appended at the end — the survivors were renumbered while it was away');
  assert.equal(restoredRow.filename, 'REC-2-003.jpg',
    'and it lands in a clean numbered slot rather than a restored-<uuid> name');
  for (const row of after) {
    assert.equal(fs.existsSync(assetsPath(dataDir, row.filepath)), true, `${row.filepath} exists for its row`);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('restoring refuses when the SKU exists again, and says what to do', { skip: skipReason }, () => {
  const { dataDir, company, product } = fixture({ sku: 'REC-3' });
  products.remove(product.id);
  const item = deleted.list({})[0];

  // Someone re-created the product by hand while it sat in the bin.
  products.create({ companyId: company.id, sku: 'REC-3', name: 'Re-made' });

  assert.throws(() => deleted.restore(item.id), /already|exists again|Rename or delete/i);
  assert.equal(deleted.count(), 1, 'the held copy is still there, so nothing was lost by the refusal');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the retention window removes only what is past it, and 0 keeps everything', { skip: skipReason }, () => {
  const { dataDir, product } = fixture({ sku: 'REC-4' });
  products.remove(product.id);
  const item = deleted.list({})[0];

  // Fresh item, 30-day window: untouched.
  assert.deepEqual(deleted.purgeExpired({ retentionDays: 30 }), { removed: 0, kept: 1 });

  // Age it past a 7-day window.
  db.getDb()
    .prepare('UPDATE deleted_items SET deleted_at = ? WHERE id = ?')
    .run(Date.now() - 8 * deleted.DAY_MS, item.id);

  assert.equal(deleted.list({}).length, 1, 'still listed…');
  assert.equal(deleted.list({ retentionDays: 7 })[0].daysLeft, 0, '…with no days left');
  assert.deepEqual(deleted.purgeExpired({ retentionDays: 7 }), { removed: 1, kept: 0 });
  assert.equal(deleted.count(), 0);
  assert.equal(products.get(product.id), null, 'and it is still deleted — the sweep only clears the bin');

  // 0 = "until I clear it".
  const again = fixture({ sku: 'REC-5' });
  products.remove(again.product.id);
  db.getDb()
    .prepare('UPDATE deleted_items SET deleted_at = ?')
    .run(Date.now() - 400 * deleted.DAY_MS);
  assert.deepEqual(deleted.purgeExpired({ retentionDays: 0 }), { removed: 0, kept: 1 });
  assert.equal(deleted.count(), 1, 'nothing is swept while the window is off');

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(again.dataDir, { recursive: true, force: true });
});

test('purging hands the held files to the Trash, not to the void', { skip: skipReason }, () => {
  const { dataDir, product } = fixture({ sku: 'REC-6' });
  products.remove(product.id);
  const item = deleted.list({})[0];
  const held = deleted.heldDir(item.id);

  const trashed = [];
  deleted.purge(item.id, { trash: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); } });

  assert.deepEqual(trashed, [held], 'the held folder is what gets trashed');
  assert.equal(fs.existsSync(held), false);
  assert.equal(deleted.count(), 0, 'and the row is gone');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the bin is scoped per company, and empty() clears one company only', { skip: skipReason }, () => {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-recycle-${counter}-`));
  db.initDb(dataDir);
  const a = companies.create({ name: 'A', isActive: true });
  const b = companies.create({ name: 'B', isActive: false });
  const pa = products.create({ companyId: a.id, sku: 'A-1', name: 'A one' });
  const pb = products.create({ companyId: b.id, sku: 'B-1', name: 'B one' });

  products.remove(pa.id);
  products.remove(pb.id);
  assert.equal(deleted.list({}).length, 2);
  assert.equal(deleted.list({ companyId: a.id }).length, 1);
  assert.equal(deleted.list({ companyId: a.id })[0].label, 'A-1');

  deleted.empty({ companyId: a.id }, { trash: async () => {} });
  assert.equal(deleted.list({}).length, 1, 'only company A was cleared');
  assert.equal(deleted.list({})[0].label, 'B-1');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
