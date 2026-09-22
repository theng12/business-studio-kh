/**
 * v0.1.55: custom price groups + per-field currency.
 *
 * Why this exists. The catalog/social renderers have always read
 * `product.prices[priceGroup]`, but nothing in the app ever wrote that map and
 * there was no way to name a group — so "custom price" was unreachable. These
 * cases pin the storage that makes it real: a company-level group list, and a
 * per-product amount + currency per group.
 *
 * RUNNING THIS. It exercises the real modules against a real temporary SQLite
 * database, because the risks are about actual column storage and the product
 * INSERT/UPDATE, which need the native `better-sqlite3` binding built for
 * ELECTRON's ABI:
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

function freshCompany(name = 'Price Co') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-price-'));
  db.initDb(dataDir);
  return companies.create({ name, isActive: true });
}

test('the new columns exist (additive, no schema bump)', { skip: skipReason }, () => {
  const company = freshCompany();
  const productCols = db.getDb().prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  const companyCols = db.getDb().prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
  assert.ok(productCols.includes('price_retail_currency'), 'products.price_retail_currency missing');
  assert.ok(productCols.includes('price_wholesale_currency'), 'products.price_wholesale_currency missing');
  assert.ok(companyCols.includes('price_groups'), 'companies.price_groups missing');
  assert.equal(company.priceGroups.length, 0, 'a new company has no price groups');
});

test('companies store named price groups, dropping blanks and duplicates', { skip: skipReason }, () => {
  const company = freshCompany('Groups Co');
  const updated = companies.update(company.id, {
    priceGroups: [
      { key: 'retail', label: 'Retail' },
      { key: 'wholesale', label: 'Wholesale' },
      { key: 'wholesale', label: 'Duplicate key' },   // dropped
      { key: '', label: 'No key' },                    // dropped
      { key: 'blank-label', label: '   ' },            // dropped
    ],
  });
  assert.deepEqual(updated.priceGroups, [
    { key: 'retail', label: 'Retail' },
    { key: 'wholesale', label: 'Wholesale' },
  ]);
  // And it survives a re-read (i.e. it is really in the column).
  assert.deepEqual(companies.get(company.id).priceGroups, updated.priceGroups);
});

test('a product stores a per-field currency and a per-group amount', { skip: skipReason }, () => {
  const company = freshCompany('Product Prices Co');
  const p = products.create({
    companyId: company.id,
    sku: 'P-1',
    name: 'Widget',
    priceRetail: 12.5,
    priceRetailCurrency: 'USD',
    priceWholesale: 40000,
    priceWholesaleCurrency: 'KHR',
    prices: {
      export: { amount: 88, currency: 'CNY' },
    },
  });

  const read = products.get(p.id);
  assert.equal(read.priceRetail, 12.5);
  assert.equal(read.priceRetailCurrency, 'USD');
  assert.equal(read.priceWholesale, 40000);
  assert.equal(read.priceWholesaleCurrency, 'KHR');
  assert.deepEqual(read.prices, { export: { amount: 88, currency: 'CNY' } });
});

test('a product with no currencies reads back as USD', { skip: skipReason }, () => {
  const company = freshCompany('Default Currency Co');
  const p = products.create({ companyId: company.id, sku: 'P-2', name: 'Plain' });
  const read = products.get(p.id);
  assert.equal(read.priceRetailCurrency, 'USD');
  assert.equal(read.priceWholesaleCurrency, 'USD');
  assert.deepEqual(read.prices, {});
});

test('an unknown currency code is normalised to USD, never stored raw', { skip: skipReason }, () => {
  const company = freshCompany('Bad Currency Co');
  const p = products.create({
    companyId: company.id, sku: 'P-3', name: 'Odd',
    priceRetailCurrency: 'NOT-A-CURRENCY',
  });
  assert.equal(products.get(p.id).priceRetailCurrency, 'USD');
});

test('updating prices and currency persists both', { skip: skipReason }, () => {
  const company = freshCompany('Update Prices Co');
  const p = products.create({ companyId: company.id, sku: 'P-4', name: 'Editable' });
  products.update(p.id, {
    priceRetail: 9.99,
    priceRetailCurrency: 'THB',
    prices: { export: { amount: 5, currency: 'KHR' } },
  });
  const read = products.get(p.id);
  assert.equal(read.priceRetail, 9.99);
  assert.equal(read.priceRetailCurrency, 'THB');
  assert.deepEqual(read.prices, { export: { amount: 5, currency: 'KHR' } });
});
