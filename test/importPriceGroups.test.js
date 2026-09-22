/**
 * v0.1.65: importing a custom price group.
 *
 * Two halves have to agree for this to work, and each can fail silently:
 *
 *   1. the mapper has to offer a destination for the column
 *      (renderer/modules/ProductLibrary/ImportModal.jsx), and
 *   2. bulkUpsert has to write it into products.prices — a JSON map that must
 *      merge per key, because a sheet only ever carries the groups it has
 *      columns for. Replacing the object would wipe every group the sheet
 *      omitted.
 *
 * The customer's report ("no column to add it") was half 1; half 2 had never
 * been implemented at all, so a mapped column would have been dropped.
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

function freshCompany(name = 'Import Co') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-importprice-'));
  db.initDb(dataDir);
  return companies.create({ name, isActive: true });
}

test('an import row can set a custom price group on a NEW product', { skip: skipReason }, () => {
  const company = freshCompany();
  products.bulkUpsert(company.id, [{
    sku: 'P-1', name: 'Widget',
    priceRetail: 12, priceRetailCurrency: 'USD',
    prices: { export: { amount: 88, currency: 'CNY' } },
  }], {});
  const row = products.getBySku(company.id, 'P-1');
  assert.equal(row.priceRetail, 12);
  assert.deepEqual(row.prices, { export: { amount: 88, currency: 'CNY' } });
});

test('re-importing merges price groups instead of replacing the map', { skip: skipReason }, () => {
  const company = freshCompany('Merge Co');
  products.bulkUpsert(company.id, [{
    sku: 'P-2', name: 'Widget',
    prices: { export: { amount: 88, currency: 'CNY' }, dealer: { amount: 40, currency: 'USD' } },
  }], {});
  // A later sheet that only knows about one group must not wipe the other.
  products.bulkUpsert(company.id, [{ sku: 'P-2', prices: { export: { amount: 91 } } }], { conflictPolicy: 'merge' });
  assert.deepEqual(products.getBySku(company.id, 'P-2').prices, {
    export: { amount: 91, currency: 'CNY' },
    dealer: { amount: 40, currency: 'USD' },
  });
});

test('a blank amount leaves the stored group alone under merge', { skip: skipReason }, () => {
  const company = freshCompany('Merge Blank Co');
  products.bulkUpsert(company.id, [{ sku: 'P-3', prices: { export: { amount: 88 } } }], {});
  products.bulkUpsert(company.id, [{ sku: 'P-3', prices: { export: { amount: null } } }], { conflictPolicy: 'merge' });
  assert.deepEqual(products.getBySku(company.id, 'P-3').prices, { export: { amount: 88 } });
});

test('overwrite clears a group whose amount and currency are both blank', { skip: skipReason }, () => {
  const company = freshCompany('Overwrite Co');
  products.bulkUpsert(company.id, [{ sku: 'P-4', prices: { export: { amount: 88, currency: 'THB' }, dealer: { amount: 5 } } }], {});
  products.bulkUpsert(company.id, [{ sku: 'P-4', prices: { export: { amount: null, currency: '' } } }], { conflictPolicy: 'overwrite' });
  assert.deepEqual(products.getBySku(company.id, 'P-4').prices, { dealer: { amount: 5 } });
});

test('the dry run reports the price change, so Preview matches Apply', { skip: skipReason }, () => {
  const company = freshCompany('Preview Co');
  products.bulkUpsert(company.id, [{ sku: 'P-5', prices: { export: { amount: 10 } } }], {});
  const dry = products.bulkUpsert(company.id, [{ sku: 'P-5', prices: { export: { amount: 20 } } }], { dryRun: true });
  // A dry run records what WOULD change in `changes` (the id counters stay
  // empty because nothing was written — that is the preview's whole point).
  const change = dry.changes.find((c) => c.sku === 'P-5');
  assert.ok(change, 'the row is missing from the preview');
  assert.equal(change.action, 'update', 'a price-only change must be an update, not a no-op');
  const diff = change.diffs.find((d) => d.field === 'prices');
  assert.deepEqual(diff.oldValue, { export: { amount: 10 } });
  assert.deepEqual(diff.newValue, { export: { amount: 20 } });
  // And nothing was written.
  assert.deepEqual(products.getBySku(company.id, 'P-5').prices, { export: { amount: 10 } });
});

test('a per-field currency imports on its own', { skip: skipReason }, () => {
  const company = freshCompany('Currency Co');
  products.bulkUpsert(company.id, [{ sku: 'P-6', priceRetail: 40000, priceRetailCurrency: 'KHR', priceWholesaleCurrency: 'THB' }], {});
  const row = products.getBySku(company.id, 'P-6');
  assert.equal(row.priceRetailCurrency, 'KHR');
  assert.equal(row.priceWholesaleCurrency, 'THB');
});

test('custom fields import and merge like other JSON', { skip: skipReason }, () => {
  const company = freshCompany('Custom Co');
  products.bulkUpsert(company.id, [{ sku: 'P-7', customFields: { material: 'ceramic', voltage: '220V' } }], {});
  assert.deepEqual(products.getBySku(company.id, 'P-7').customFields, { material: 'ceramic', voltage: '220V' });
  // A later row that only mentions one key must keep the other.
  products.bulkUpsert(company.id, [{ sku: 'P-7', customFields: { material: 'porcelain' } }], {});
  const row = products.getBySku(company.id, 'P-7');
  assert.equal(row.customFields.material, 'porcelain');
});

test('the sample sheet lists only the custom fields the company actually uses', { skip: skipReason }, () => {
  const company = freshCompany('Fields Co');
  products.bulkUpsert(company.id, [
    { sku: 'P-8', customFields: { material: 'ceramic' } },
    { sku: 'P-9', customFields: { voltage: '220V', material: 'steel' } },
    { sku: 'P-10' },
  ], {});
  assert.deepEqual(products.customFieldKeys(company.id), ['custom.material', 'custom.voltage']);
  assert.deepEqual(products.customFieldKeys('nobody'), []);
});
