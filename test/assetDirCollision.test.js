/**
 * v0.1.27 — two products must never share one image folder.
 *
 * The on-disk directory is `company/brand/<slug(sku)>`, and slugify collapses
 * every run of non-alphanumerics to a single `-`, so `A-1`, `A 1`, `A/1` and
 * `A_1` all name the SAME folder. UNIQUE(company_id, sku) is on the raw SKU, so
 * all of them could legitimately exist — and then they shared a directory and a
 * `<slug>-NNN` filename pattern. Deleting one product ran
 * `rmSync(dir, { recursive: true })` and destroyed the others' images, leaving
 * their rows pointing at files that no longer existed.
 *
 * Two protections are pinned here:
 *   1. Creating (or re-pointing) a product onto a folder another product owns
 *      is REFUSED with an error naming the conflict.
 *   2. If a collision already exists — data created before the guard — deleting
 *      one product removes only its own files and leaves the folder standing.
 *
 * RUNNING THIS. Real SQLite + real files on disk, because the bug was about
 * files being deleted. Needs the native binding, which is built for Electron's
 * ABI:
 *
 *     npm run test:native
 *
 * Under plain `npm test` these cases SKIP with that command as the reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let companies = null;
let brands = null;
let products = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  brands = require('../main/db/brands');
  products = require('../main/db/products');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-slug-'));
  db.initDb(dataDir);
  const company = companies.create({ name: 'KT Ceramic', isActive: true });
  const brand = brands.create({ companyId: company.id, name: 'Royal' });
  return { dataDir, company, brand };
}

/** Insert straight into the table, bypassing the guard, to simulate old data. */
function forceProduct(companyId, sku, brandId) {
  const id = require('node:crypto').randomUUID();
  const ts = Date.now();
  db.getDb()
    .prepare(`INSERT INTO products (id, company_id, sku, name, brand_id, status, tags, prices,
               custom_fields, track_inventory, process_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'active', '[]', '{}', '{}', 0, 'unprocessed', ?, ?)`)
    .run(id, companyId, sku, sku, brandId, ts, ts);
  return products.get(id);
}

test('creating a product is allowed when its folder is free', { skip: skipReason }, () => {
  const { company, brand } = fresh();
  const a = products.create({ companyId: company.id, sku: 'A-1', brandId: brand.id });
  assert.ok(a.id);
  const b = products.create({ companyId: company.id, sku: 'B-1', brandId: brand.id });
  assert.ok(b.id, 'a genuinely different SKU still works');
});

test('creating a product whose SKU slugs to a taken folder is REFUSED', { skip: skipReason }, () => {
  const { company, brand } = fresh();
  products.create({ companyId: company.id, sku: 'A-1', brandId: brand.id });

  for (const clashing of ['A 1', 'A/1', 'A_1', 'A.1']) {
    assert.throws(
      () => products.create({ companyId: company.id, sku: clashing, brandId: brand.id }),
      /share an image folder/i,
      `${clashing} should have been refused`,
    );
  }
  // The error must name the conflict, or the user cannot act on it.
  try {
    products.create({ companyId: company.id, sku: 'A 1', brandId: brand.id });
    assert.fail('expected a throw');
  } catch (err) {
    assert.match(err.message, /A-1/, 'the message names the SKU it collides with');
  }
});

test('the same slug under a DIFFERENT brand is not a collision', { skip: skipReason }, () => {
  const { company, brand } = fresh();
  const other = brands.create({ companyId: company.id, name: 'Plain' });
  products.create({ companyId: company.id, sku: 'A-1', brandId: brand.id });
  // A different RAW sku (so the company-wide SKU uniqueness rule is satisfied)
  // that slugs to the same string — fine, because the brand is part of the path.
  const ok = products.create({ companyId: company.id, sku: 'A 1', brandId: other.id });
  assert.ok(ok.id, 'brand is part of the folder, so this is a different product');
});

test('renaming a SKU onto another product folder is REFUSED', { skip: skipReason }, () => {
  const { company, brand } = fresh();
  products.create({ companyId: company.id, sku: 'A-1', brandId: brand.id });
  const second = products.create({ companyId: company.id, sku: 'B-2', brandId: brand.id });

  assert.throws(
    () => products.update(second.id, { sku: 'A 1' }),
    /share an image folder/i,
  );
  // And the product is untouched.
  assert.equal(products.get(second.id).sku, 'B-2');
});

test('deleting a product that SHARES a folder leaves the folder and other files alone', { skip: skipReason }, () => {
  const { dataDir, company, brand } = fresh();
  // Simulate data created before the guard existed.
  const first = forceProduct(company.id, 'A-1', brand.id);
  const second = forceProduct(company.id, 'A 1', brand.id);

  const assetPath = require('../main/util/assetPath');
  const dir = assetPath.productAssetDir(company, brand, first);
  const absDir = path.join(dataDir, 'assets', dir);
  fs.mkdirSync(absDir, { recursive: true });

  // Worth being precise about what can and cannot be saved here: a genuine
  // slug collision produces the same <slug>-NNN basename too, so the two
  // products' "own" files are physically the same file and the second writer
  // has already overwritten the first. Nothing below can undo that — which is
  // exactly why the guard above exists. What IS recoverable is everything else
  // in that folder, e.g. files left under an older SKU name, and the folder
  // itself, which the second product still needs.
  const sharedFile = path.join(absDir, `${assetPath.productImageBasename(first, 0)}.jpg`);
  const staleFile = path.join(absDir, 'OLD-SKU-NAME-001.jpg');
  fs.writeFileSync(sharedFile, Buffer.from('shared bytes'));
  fs.writeFileSync(staleFile, Buffer.from('belongs to the surviving product history'));

  products.remove(first.id);

  assert.ok(fs.existsSync(absDir), 'the folder is NOT removed while another product still owns it');
  assert.equal(fs.existsSync(staleFile), true,
    "a file that does not belong to the deleted product must survive — removing the whole "
    + 'folder is what destroyed other products\' images');
  // Nothing at all is removed. The two products' filenames collide as well as
  // their folder, so there is no honest way to tell whose bytes these are —
  // and deleting "ours" would take the survivor's only copy with it.
  assert.equal(fs.existsSync(sharedFile), true,
    'a shared-named file is left alone: it may be the surviving product\'s only copy');

  // And the other product is of course still there, with its row intact.
  assert.ok(products.get(second.id), 'the surviving product still exists');
  assert.equal(products.get(second.id).sku, 'A 1');
});

test('deleting a product with its OWN folder still cleans the folder up', { skip: skipReason }, () => {
  const { dataDir, company, brand } = fresh();
  const solo = products.create({ companyId: company.id, sku: 'SOLO-1', brandId: brand.id });

  const assetPath = require('../main/util/assetPath');
  const absDir = path.join(dataDir, 'assets', assetPath.productAssetDir(company, brand, solo));
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.join(absDir, 'SOLO-1-001.jpg'), Buffer.from('x'));

  products.remove(solo.id);
  assert.equal(fs.existsSync(absDir), false, 'an unshared folder is still removed as before');
});
