/**
 * v0.1.67: the foreign-key behaviour the new bulk deletes depend on.
 *
 * The Brands and Categories screens now delete in bulk through the same
 * `brands:remove` / `categories:remove` IPC the single-row delete uses, and
 * their confirm dialogs make a promise: "N products use them and will lose
 * their brand — their photos and other details are not affected." That
 * promise is only true because `products.brand_id` / `products.category_id`
 * are `ON DELETE SET NULL`. If someone ever changes a column definition, the
 * copy silently becomes a lie and users lose data they were told was safe.
 *
 * The Suppliers screen pre-checks the PO rollup and REFUSES suppliers with
 * purchase orders, because `purchase_orders.supplier_id` is `ON DELETE
 * RESTRICT`. This pins the database side of that refusal too.
 *
 * Real database through the real modules: `npm run test:native`. Under plain
 * `npm test` it SKIPs with that command as the reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let companies = null;
let products = null;
let brands = null;
let categories = null;
let suppliers = null;
let purchaseOrders = null;
let productImages = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  brands = require('../main/db/brands');
  categories = require('../main/db/categories');
  suppliers = require('../main/db/suppliers');
  purchaseOrders = require('../main/db/purchaseOrders');
  productImages = require('../main/db/productImages');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function freshCompany(name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-listtools-'));
  db.initDb(dataDir);
  return companies.create({ name, isActive: true });
}

test('deleting a brand and a category unassigns their products and leaves the rest alone', { skip: skipReason }, () => {
  const company = freshCompany('Set Null Co');
  const brand = brands.create({ companyId: company.id, name: 'Acme' });
  const category = categories.create({ companyId: company.id, name: 'Taps' });

  const product = products.create({
    companyId: company.id,
    sku: 'SETNULL-1',
    name: 'Keep me',
    brandId: brand.id,
    categoryId: category.id,
    priceRetail: 19.5,
    description: 'untouched',
  });

  // A row on disk, inserted without touching the filesystem (the DB only
  // stores the relative path), so "images intact" is a real assertion.
  productImages.addRow(product.id, { filepath: 'acme/setnull-1/001.jpg', filename: '001.jpg' });
  productImages.addRow(product.id, { filepath: 'acme/setnull-1/002.jpg', filename: '002.jpg' });
  assert.equal(productImages.listByProduct(product.id).length, 2);

  assert.equal(brands.remove(brand.id), true);
  assert.equal(categories.remove(category.id), true);

  const after = products.get(product.id);
  assert.equal(after.brandId, null, 'products.brand_id must be SET NULL, not cascade-deleted');
  assert.equal(after.categoryId, null, 'products.category_id must be SET NULL, not cascade-deleted');
  // Everything the confirm says is unaffected really is.
  assert.equal(after.sku, 'SETNULL-1');
  assert.equal(after.name, 'Keep me');
  assert.equal(after.priceRetail, 19.5);
  assert.equal(after.description, 'untouched');
  assert.equal(productImages.listByProduct(product.id).length, 2, 'image rows must survive the brand/category delete');
});

test('a supplier with a purchase order cannot be deleted — the DB refuses', { skip: skipReason }, () => {
  const company = freshCompany('Restrict Co');
  const supplier = suppliers.create({ companyId: company.id, name: 'Foshan Ceramic' });
  const po = purchaseOrders.create({ companyId: company.id, supplierId: supplier.id, poNumber: 'PO-1' });
  assert.ok(po && po.id);

  assert.throws(
    () => suppliers.remove(supplier.id),
    /purchase order/i,
    'suppliers.remove must refuse while a PO references the supplier',
  );
  // The refusal is real: both rows survive.
  assert.ok(suppliers.get(supplier.id), 'the supplier must still exist after the refused delete');
  assert.ok(purchaseOrders.get(po.id), 'the purchase order must still exist');
});

test('a supplier with no purchase orders deletes cleanly', { skip: skipReason }, () => {
  const company = freshCompany('Clean Co');
  const supplier = suppliers.create({ companyId: company.id, name: 'Never Used' });
  const res = suppliers.remove(supplier.id);
  assert.equal(res.deleted, 1);
  assert.equal(suppliers.get(supplier.id), null);
});
