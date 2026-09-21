/**
 * Regression for the Overwrite policy and the NOT NULL `status` column.
 *
 * When import rows carried a blank Status cell as `status: null`, the overwrite
 * branch wrote the null through, the NOT NULL constraint failed, and the WHOLE
 * row was skipped — so every other intended update on that row was silently
 * lost. The DB boundary now ignores a null/empty status and leaves the existing
 * value alone.
 *
 * Needs Electron's Node (better-sqlite3 ABI): `npm run test:native`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db;
let companies;
let products;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
} catch (error) {
  if (error?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`";
  } else {
    throw error;
  }
}

test('overwrite ignores a null status instead of skipping the whole row', { skip: skipReason }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-overwrite-null-'));
  db.initDb(dir);
  try {
    const company = companies.create({ name: 'Overwrite Co', isActive: true });
    const created = products.create({ companyId: company.id, sku: 'SKU-1', name: 'Existing', priceRetail: 10 });
    assert.equal(created.status, 'active');

    const res = products.bulkUpsert(
      company.id,
      [{ sku: 'SKU-1', status: null, name: null, priceRetail: null }],
      { dryRun: false, conflictPolicy: 'overwrite' },
    );
    assert.equal(res.skips.length, 0, 'a null status must not fail the row');
    assert.equal(res.updated, 1, 'the row must still be updated');
    const after = products.getBySku(company.id, 'SKU-1');
    assert.equal(after.status, 'active', 'status is NOT NULL and must be left alone');
    assert.equal(after.name, null, 'other clears on the same row must still apply');
    assert.equal(after.priceRetail, null);

    products.update(after.id, { name: 'Keep', priceRetail: 5, status: 'draft' });
    products.bulkUpsert(
      company.id,
      [{ sku: 'SKU-1', status: null, name: null, priceRetail: null }],
      { dryRun: false, conflictPolicy: 'merge' },
    );
    const merged = products.getBySku(company.id, 'SKU-1');
    assert.equal(merged.status, 'draft', 'merge ignores a null status');
    assert.equal(merged.name, 'Keep', 'merge never blanks a value');
    assert.equal(merged.priceRetail, 5);
  } finally {
    try { db.closeDb(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
