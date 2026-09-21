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

test('skip leaves tags untouched and an empty status on insert defaults to active', { skip: skipReason }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-skip-tags-'));
  db.initDb(dir);
  try {
    const company = companies.create({ name: 'Skip Co', isActive: true });
    products.create({ companyId: company.id, sku: 'SKU-1', name: 'Keep', tags: ['keep'] });

    const skipRes = products.bulkUpsert(
      company.id,
      [{ sku: 'SKU-1', tags: ['replaced'] }],
      { dryRun: false, conflictPolicy: 'skip' },
    );
    assert.equal(skipRes.skips.length, 0);
    assert.equal(skipRes.changes[0].action, 'no_change', 'skip must report the row as unchanged');
    assert.deepEqual(products.getBySku(company.id, 'SKU-1').tags, ['keep'], 'skip must not replace tags');

    const created = products.bulkUpsert(
      company.id,
      [{ sku: 'SKU-2', status: '' }],
      { dryRun: false, conflictPolicy: 'merge' },
    );
    assert.equal(created.inserted, 1);
    assert.equal(products.getBySku(company.id, 'SKU-2').status, 'active', 'an empty status on insert must default to active');
  } finally {
    try { db.closeDb(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status is normalized at the boundary and no-op rows are not counted as updates', { skip: skipReason }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-status-norm-'));
  db.initDb(dir);
  try {
    const company = companies.create({ name: 'Status Co', isActive: true });
    const product = products.create({ companyId: company.id, sku: 'SKU-1', name: 'Keep', status: 'draft' });

    // A whitespace-only status must never be stored on an existing row.
    for (const policy of ['merge', 'overwrite']) {
      products.update(product.id, { status: 'draft' });
      products.bulkUpsert(company.id, [{ sku: 'SKU-1', status: '   ' }], { dryRun: false, conflictPolicy: policy });
      assert.equal(products.getBySku(company.id, 'SKU-1').status, 'draft', `${policy}: whitespace status must not overwrite`);
    }

    // Dry-run and live runs must agree about the status of a new row.
    const rows = [{ sku: 'SKU-2', status: '' }, { sku: 'SKU-2', status: 'active' }];
    const dry = products.bulkUpsert(company.id, rows.map((r) => ({ ...r })), { dryRun: true, conflictPolicy: 'merge' });
    const live = products.bulkUpsert(company.id, rows.map((r) => ({ ...r })), { dryRun: false, conflictPolicy: 'merge' });
    assert.equal(products.getBySku(company.id, 'SKU-2').status, 'active');
    const dryStatusDiff = (dry.changes[1].diffs ?? []).some((d) => d.field === 'status');
    const liveStatusDiff = (live.changes[1].diffs ?? []).some((d) => d.field === 'status');
    assert.equal(dryStatusDiff, liveStatusDiff, 'dry-run and live must agree on the status change');

    // A row that already matches is unchanged, not an update.
    const skip = products.bulkUpsert(company.id, [{ sku: 'SKU-1' }], { dryRun: false, conflictPolicy: 'skip' });
    assert.equal(skip.changes[0].action, 'no_change');
    assert.equal(skip.updated, 0, 'no-op rows must not be counted as updates');
  } finally {
    try { db.closeDb(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a repeated SKU in one call compares against the effective state, so preview matches batched Apply', { skip: skipReason }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-repeat-sku-'));
  db.initDb(dir);
  try {
    const company = companies.create({ name: 'Repeat Co', isActive: true });
    products.create({ companyId: company.id, sku: 'X', name: 'orig' });

    // One dry-run over both rows (what ImportPreview shows).
    const dry = products.bulkUpsert(
      company.id,
      [{ sku: 'X', name: 'one' }, { sku: 'X', name: 'orig' }],
      { dryRun: true, conflictPolicy: 'merge' },
    );

    // The batched Apply the dialog actually performs: one call per batch.
    const batch1 = products.bulkUpsert(company.id, [{ sku: 'X', name: 'one' }], { dryRun: false, conflictPolicy: 'merge' });
    const batch2 = products.bulkUpsert(company.id, [{ sku: 'X', name: 'orig' }], { dryRun: false, conflictPolicy: 'merge' });

    assert.deepEqual(
      dry.changes.map((c) => c.action),
      [...batch1.changes, ...batch2.changes].map((c) => c.action),
      'the single-call preview and the batched apply must agree on a repeated SKU',
    );
    assert.equal(products.getBySku(company.id, 'X').name, 'orig', 'the last row wins in both');
  } finally {
    try { db.closeDb(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
