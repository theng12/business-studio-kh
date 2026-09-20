/**
 * v0.1.25: the "Stock on hand" field on products.
 *
 * Why this exists. Social Grid filters and sorts by how many units are on hand,
 * and before this change the app had no such number — it had a "Track
 * inventory for this product" checkbox and a reorder point, but nowhere to
 * record the count they were about. So this field is new data that the customer
 * maintains by hand and through the spreadsheet import, which makes two things
 * worth pinning down:
 *
 *   1. A BLANK count must survive as NULL and must not read back as 0. Blank
 *      means "never counted"; 0 means "counted, none left". The grid shows
 *      "Sold out" for one and nothing at all for the other, and a filter for
 *      "out of stock" must not sweep up the whole uncounted catalogue.
 *
 *   2. A spreadsheet import that has no stock column must LEAVE EXISTING
 *      COUNTS ALONE. The import merges by SKU, and the danger is a price list
 *      that silently resets every product's stock to zero — which would look
 *      like a data loss and would be one.
 *
 * RUNNING THIS. It exercises the real module against a real temporary SQLite
 * database, because the risks above are about actual column storage and SQL
 * UPDATE semantics — mirroring the SQL here would reproduce the bug instead of
 * catching it. That needs the native `better-sqlite3` binding, which this
 * project builds for ELECTRON's ABI (see `npm run native:host`), so plain
 * `node --test` cannot load it:
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
let products = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function freshCompany() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-stock-'));
  db.initDb(dataDir);
  return companies.create({ name: 'Stock Co', isActive: true });
}

/** The raw column, so assertions cannot be satisfied by a mapper. */
function rawStock(id) {
  return db.getDb().prepare('SELECT stock_qty FROM products WHERE id = ?').get(id)?.stock_qty;
}

test('the products table has a stock_qty column', { skip: skipReason }, () => {
  const company = freshCompany();
  const p = products.create({ companyId: company.id, sku: 'S-1', name: 'Widget' });
  const columns = db.getDb().prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  assert.ok(columns.includes('stock_qty'), 'stock_qty is missing from the schema');
  assert.equal(rawStock(p.id), null, 'an untouched product has no count');
});

test('a blank stock count stores as NULL and does not come back as zero', { skip: skipReason }, () => {
  const company = freshCompany();
  const blank = products.create({ companyId: company.id, sku: 'S-2', name: 'Not counted' });
  const zero = products.create({ companyId: company.id, sku: 'S-3', name: 'None left', stockQty: 0 });

  assert.equal(rawStock(blank.id), null);
  assert.equal(rawStock(zero.id), 0);
  assert.equal(products.get(blank.id).stockQty, null, 'blank must not read back as 0');
  assert.equal(products.get(zero.id).stockQty, 0);
  assert.notEqual(products.get(blank.id).stockQty, products.get(zero.id).stockQty,
    'the whole feature treats these two differently');
});

test('stock updates round-trip, and can be cleared back to blank', { skip: skipReason }, () => {
  const company = freshCompany();
  const p = products.create({ companyId: company.id, sku: 'S-4', name: 'Widget' });

  products.update(p.id, { stockQty: 24 });
  assert.equal(products.get(p.id).stockQty, 24);

  products.update(p.id, { stockQty: 0 });
  assert.equal(products.get(p.id).stockQty, 0, 'zero is a real value, not "unset"');

  // Clearing the box must return the product to "not counted".
  products.update(p.id, { stockQty: null });
  assert.equal(products.get(p.id).stockQty, null, 'clearing must not leave 0 behind');
});

test('a fractional count survives, because units can be kg or litres', { skip: skipReason }, () => {
  const company = freshCompany();
  const p = products.create({ companyId: company.id, sku: 'S-5', stockQty: 2.5 });
  assert.equal(products.get(p.id).stockQty, 2.5);
});

test('an import with no stock column leaves existing counts untouched', { skip: skipReason }, () => {
  const company = freshCompany();
  const p = products.create({ companyId: company.id, sku: 'S-6', name: 'Widget', stockQty: 12 });

  // A price-list import: same SKU, a new retail price, and no stock column at
  // all. Under the default 'merge' policy this must not touch stock.
  const result = products.bulkUpsert(company.id, [
    { sku: 'S-6', name: 'Widget', priceRetail: 19.99 },
  ], { conflictPolicy: 'merge' });

  assert.equal(result.updated, 1, 'the existing row was matched by SKU');
  assert.equal(result.inserted, 0, 'and was updated rather than duplicated');
  assert.equal(products.get(p.id).priceRetail, 19.99, 'the import did apply');
  assert.equal(products.get(p.id).stockQty, 12, 'and did NOT reset the stock count');
});

test('an import WITH a stock column does apply the new count', { skip: skipReason }, () => {
  const company = freshCompany();
  const p = products.create({ companyId: company.id, sku: 'S-7', name: 'Widget', stockQty: 12 });

  products.bulkUpsert(company.id, [{ sku: 'S-7', stockQty: 5 }], { conflictPolicy: 'merge' });
  assert.equal(products.get(p.id).stockQty, 5);

  // ...and can legitimately record a counted zero.
  products.bulkUpsert(company.id, [{ sku: 'S-7', stockQty: 0 }], { conflictPolicy: 'merge' });
  assert.equal(products.get(p.id).stockQty, 0);
});

test('a newly inserted import row can carry a stock count', { skip: skipReason }, () => {
  const company = freshCompany();
  products.bulkUpsert(company.id, [{ sku: 'S-8', name: 'Brand new', stockQty: 7 }], { conflictPolicy: 'merge' });
  const created = products.list(company.id).find((p) => p.sku === 'S-8');
  assert.ok(created, 'the row was inserted');
  assert.equal(created.stockQty, 7, 'the insert path carries stock through');
});

test('adding stock_qty did not disturb the existing inventory columns', { skip: skipReason }, () => {
  const company = freshCompany();
  const p = products.create({
    companyId: company.id, sku: 'S-9', name: 'Widget',
    trackInventory: true, reorderPoint: '5', reorderQuantity: '20', stockQty: 3,
  });
  const read = products.get(p.id);
  assert.equal(read.trackInventory, true);
  assert.equal(read.reorderPoint, '5');
  assert.equal(read.reorderQuantity, '20');
  assert.equal(read.stockQty, 3);
});
