const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let db, companies, brands, products, productImages, imageManager;
let skip = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db');
  companies = require('../main/db/companies');
  brands = require('../main/db/brands');
  products = require('../main/db/products');
  productImages = require('../main/db/productImages');
  imageManager = require('../main/imageManager');
} catch (err) {
  if (err.code !== 'ERR_DLOPEN_FAILED') throw err;
  skip = 'Run ELECTRON_RUN_AS_NODE=1 electron --test test/brandRenameIntegrity.test.js';
}

function fresh(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-brand-rename-'));
  db.initDb(dataDir);
  t.after(() => {
    db.closeDb();
    const trash = path.join(__dirname, '../_trash/brand-rename-tests');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dataDir, path.join(trash, path.basename(dataDir)));
  });
  const company = companies.create({ name: 'Shop' });
  const brand = brands.create({ companyId: company.id, name: 'Royal' });
  return { dataDir, company, brand };
}
function photo(f, brand, sku, rel, bytes) {
  const product = products.create({ companyId: f.company.id, brandId: brand.id, sku });
  const abs = path.join(f.dataDir, 'assets', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  const { image } = productImages.addRow(product.id, {
    filepath: rel, filename: path.basename(rel), originalFilepath: rel,
    contentHash: hash, orderIndex: 0,
  });
  return { product, image, abs, bytes, hash };
}
function unchanged(f, photos) {
  assert.equal(brands.get(f.brand.id).name, 'Royal');
  for (const p of photos) {
    assert.equal(fs.readFileSync(p.abs, 'utf8'), p.bytes);
    const row = db.getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(p.image.id);
    assert.equal(row.filepath, p.image.filepath);
    assert.equal(row.content_hash, p.hash);
  }
}

for (const otherName of ['A B', 'a b']) {
  test(`brand rename refuses slug/case ownership collision with ${otherName}`, { skip }, (t) => {
    const f = fresh(t);
    const other = brands.create({ companyId: f.company.id, name: otherName });
    const otherSlug = otherName === 'A B' ? 'A-B' : 'a-b';
    const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
    const b = photo(f, other, 'A 1', `Shop/${otherSlug}/A-1/A-1-001.jpg`, 'other-photo');
    assert.throws(() => brands.update(f.brand.id, { name: 'A&B' }), /image folder|already.*folder/i);
    unchanged(f, [a, b]);
    assert.equal(brands.get(other.id).name, otherName);
  });
}

test('brand rename checks ownership even when destination brand has no photos', { skip }, (t) => {
  const f = fresh(t);
  brands.create({ companyId: f.company.id, name: 'A B' });
  assert.throws(() => brands.update(f.brand.id, { name: 'A&B' }), /folder/i);
  unchanged(f, []);
});

test('brand rename succeeds for free destination and case-only self rename', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  brands.update(f.brand.id, { name: 'New Brand' });
  assert.equal(brands.get(f.brand.id).name, 'New Brand');
  let row = db.getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(a.image.id);
  assert.equal(row.filepath, 'Shop/New-Brand/A-1/A-1-001.jpg');
  assert.equal(row.content_hash, a.hash);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'assets', row.filepath), 'utf8'), a.bytes);
  brands.update(f.brand.id, { name: 'new brand' });
  row = db.getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(a.image.id);
  assert.equal(row.filepath, 'Shop/new-brand/A-1/A-1-001.jpg');
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'assets', row.filepath), 'utf8'), a.bytes);
});

test('a real filesystem move error is reported with rows and bytes unchanged', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  const rename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    if (!failed && String(to).includes('New-Brand')) { failed = true; throw new Error('injected move failure'); }
    return rename(from, to);
  };
  try { assert.throws(() => brands.update(f.brand.id, { name: 'New Brand' }), /injected move failure/); }
  finally { fs.renameSync = rename; }
  unchanged(f, [a]);
});

test('DB commit failure rolls a completed move back', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  db.getDb().exec("CREATE TRIGGER fail_brand_update BEFORE UPDATE ON brands BEGIN SELECT RAISE(ABORT, 'injected DB failure'); END");
  assert.throws(() => brands.update(f.brand.id, { name: 'New Brand' }), /injected DB failure/);
  unchanged(f, [a]);
});

test('mover preflights every company before moving any directory', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  const laterSource = path.join(f.dataDir, 'assets/Other/Royal/B-1');
  const occupied = path.join(f.dataDir, 'assets/Other/New/B-1/B-1-001.jpg');
  fs.mkdirSync(laterSource, { recursive: true });
  fs.writeFileSync(path.join(laterSource, 'B-1-001.jpg'), 'later-source');
  fs.mkdirSync(path.dirname(occupied), { recursive: true });
  fs.writeFileSync(occupied, 'occupied');
  assert.throws(() => imageManager.moveBrandDirEverywhere(['Shop', 'Other'], 'Royal', 'New'), /folder|occupied/i);
  unchanged(f, [a]);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'occupied');
});

test('mover refuses a target occupied after preflight and restores earlier moves', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  const second = path.join(f.dataDir, 'assets/Other/Royal/B-1');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'B-1-001.jpg'), 'later-source');
  const occupied = path.join(f.dataDir, 'assets/Other/New/late.jpg');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === path.dirname(occupied)) fs.writeFileSync(occupied, 'late-photo');
    return rename(from, to);
  };
  try { assert.throws(() => imageManager.moveBrandDirEverywhere(['Shop', 'Other'], 'Royal', 'New')); }
  finally { fs.renameSync = rename; }
  unchanged(f, [a]);
  assert.equal(fs.readFileSync(path.join(second, 'B-1-001.jpg'), 'utf8'), 'later-source');
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'late-photo');
});

test('case-only rename restores the original path if its DB commit fails', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  db.getDb().exec("CREATE TRIGGER fail_brand_update BEFORE UPDATE ON brands BEGIN SELECT RAISE(ABORT, 'case DB failure'); END");
  assert.throws(() => brands.update(f.brand.id, { name: 'royal' }), /case DB failure/);
  unchanged(f, [a]);
  assert.ok(fs.readdirSync(path.join(f.dataDir, 'assets/Shop')).includes('Royal'));
});

test('brand rename refuses a shared source folder rather than taking another brand photos', { skip }, (t) => {
  const f = fresh(t);
  brands.create({ companyId: f.company.id, name: 'Royal!' });
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  assert.throws(() => brands.update(f.brand.id, { name: 'New Brand' }), /folder/i);
  unchanged(f, [a]);
});

test('brand rename checks ownership across companies that share a slug', { skip }, (t) => {
  const f = fresh(t);
  const otherCompany = companies.create({ name: 'Shop!' });
  brands.create({ companyId: otherCompany.id, name: 'New Brand' });
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  assert.throws(() => brands.update(f.brand.id, { name: 'New Brand' }), /folder/i);
  unchanged(f, [a]);
});

test('failed empty-folder rename preserves the original directory', { skip }, (t) => {
  const f = fresh(t);
  const source = path.join(f.dataDir, 'assets/Shop/Royal');
  fs.mkdirSync(source, { recursive: true });
  db.getDb().exec("CREATE TRIGGER fail_brand_update BEFORE UPDATE ON brands BEGIN SELECT RAISE(ABORT, 'empty DB failure'); END");
  assert.throws(() => brands.update(f.brand.id, { name: 'New Brand' }), /empty DB failure/);
  assert.ok(fs.existsSync(source));
});

test('brand rename refuses another product image row in the source folder', { skip }, (t) => {
  const f = fresh(t);
  const other = brands.create({ companyId: f.company.id, name: 'Other' });
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  const b = photo(f, other, 'B-1', 'Shop/Royal/B-1/B-1-001.jpg', 'legacy-other-photo');
  assert.throws(() => brands.update(f.brand.id, { name: 'New Brand' }), /folder/i);
  unchanged(f, [a, b]);
});

test('brand rename refuses legacy colliding SKU folders within the same brand', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  const b = products.create({ companyId: f.company.id, brandId: f.brand.id, sku: 'B-1' });
  db.getDb().prepare('UPDATE products SET sku = ? WHERE id = ?').run('A 1', b.id);
  assert.throws(() => brands.update(f.brand.id, { name: 'New Brand' }), /SKU.*folder/i);
  unchanged(f, [a]);
});

test('brand rename rewrites owned legacy path casing along with the moved folder', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  // Existing Mac rows can differ in case from the directory entry.
  db.getDb().prepare('UPDATE product_images SET filepath = ? WHERE id = ?')
    .run('shop/royal/A-1/A-1-001.jpg', a.image.id);
  brands.update(f.brand.id, { name: 'New Brand' });
  const row = db.getDb().prepare('SELECT filepath FROM product_images WHERE id = ?').get(a.image.id);
  assert.equal(row.filepath, 'Shop/New-Brand/A-1/A-1-001.jpg');
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'assets', row.filepath), 'utf8'), a.bytes);
});

test('case-only final move failure restores original spelling, rows and photos', { skip }, (t) => {
  const f = fresh(t);
  const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
  const rename = fs.renameSync;
  const destination = path.join(f.dataDir, 'assets/Shop/royal');
  let failed = false;
  fs.renameSync = (from, to) => {
    if (!failed && String(to) === destination) {
      failed = true;
      throw new Error('injected case-only final-move failure');
    }
    return rename(from, to);
  };
  try {
    assert.throws(() => brands.update(f.brand.id, { name: 'royal' }),
      (err) => err.message === 'injected case-only final-move failure');
  } finally { fs.renameSync = rename; }
  assert.ok(failed);
  unchanged(f, [a]);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'assets/Shop')), ['Royal']);
  const restoredHash = crypto.createHash('sha1').update(fs.readFileSync(a.abs)).digest('hex');
  assert.equal(restoredHash, a.hash);
});

for (const obstacle of ['replaced empty folder', 'occupied reservation']) {
  test(`case-only rollback preserves a foreign ${obstacle}`, { skip }, (t) => {
    const f = fresh(t);
    const a = photo(f, f.brand, 'A-1', 'Shop/Royal/A-1/A-1-001.jpg', 'royal-photo');
    const rename = fs.renameSync;
    const destination = path.join(f.dataDir, 'assets/Shop/royal');
    let failed = false;
    let foreignInode;
    fs.renameSync = (from, to) => {
      if (!failed && String(to) === destination) {
        failed = true;
        if (obstacle === 'replaced empty folder') {
          rename(destination, path.join(f.dataDir, 'displaced-empty-reservation'));
          fs.mkdirSync(destination);
        } else {
          fs.writeFileSync(path.join(destination, 'late-photo.jpg'), 'foreign-photo');
        }
        foreignInode = fs.lstatSync(destination).ino;
        throw new Error('injected final-move failure with obstacle');
      }
      return rename(from, to);
    };
    try {
      assert.throws(() => brands.update(f.brand.id, { name: 'royal' }), /need recovery/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.lstatSync(destination).ino, foreignInode);
    if (obstacle === 'occupied reservation') {
      assert.equal(fs.readFileSync(path.join(destination, 'late-photo.jpg'), 'utf8'), 'foreign-photo');
    }
    assert.equal(brands.get(f.brand.id).name, 'Royal');
    const row = db.getDb().prepare('SELECT filepath, content_hash FROM product_images WHERE id = ?').get(a.image.id);
    assert.equal(row.filepath, a.image.filepath);
    assert.equal(row.content_hash, a.hash);
    const stage = fs.readdirSync(path.join(f.dataDir, 'assets/Shop')).find((name) => name.startsWith('__brand-rename-'));
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'assets/Shop', stage, 'A-1/A-1-001.jpg'), 'utf8'), a.bytes);
  });
}
