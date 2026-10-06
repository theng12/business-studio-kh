/**
 * v0.1.89: the UX sweep's database-backed half (the pure half is
 * test/uxSweep.test.js).
 *
 *   - an export run whose names repeat inside the run keeps every file, under
 *     Replace as well as Keep both, with Khmer names intact;
 *   - Cancel stops between images and reports what was written;
 *   - brand and category edits reach the audit log, and the History filters
 *     (who / when / text) find them;
 *   - search returns suppliers and PO numbers only when asked to.
 *
 * Needs the real better-sqlite3 binding, built for Electron's ABI:
 *
 *     ELECTRON_RUN_AS_NODE=1 electron --test test/uxSweepNative.test.js
 *
 * Under plain `npm test` every case SKIPs with that reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-uxsweep-'));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: `UX Co ${Date.now()}`, isActive: true });
  companies.setActive(company.id);
  return { dataDir, company };
}

async function productWithImage(dataDir, companyId, sku, name) {
  const sharp = require('sharp');
  const products = require('../main/db/products');
  const productImages = require('../main/db/productImages');
  const product = products.create({ companyId, sku, name });
  const rel = `ux/${sku}/${sku}-001.png`;
  const abs = path.join(dataDir, 'assets', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c00' } }).png().toFile(abs);
  productImages.addRow(product.id, {
    filepath: rel, filename: path.posix.basename(rel), originalFilepath: rel, contentHash: sku, orderIndex: 0,
  });
  return product;
}

const PROFILE = { width: 16, height: 16, format: 'png', namingPattern: '{NAME}', backgroundColor: '#FFFFFF' };

test('a run whose names repeat keeps every file, in Khmer, under Replace', { skip: skipReason }, async () => {
  const { dataDir, company } = fresh();
  const a = await productWithImage(dataDir, company.id, 'A-1', 'អាវ');
  const b = await productWithImage(dataDir, company.id, 'B-1', 'អាវ');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-uxsweep-out-'));
  const { runExport, expectedOutputs } = require('../main/exportRunner');

  const expected = expectedOutputs({ profile: PROFILE, productIds: [a.id, b.id] }).entries.map((e) => e.rel);
  assert.deepEqual(expected, ['អាវ.png', 'អាវ-2.png'], 'the preview names what the run will write');

  const res = await runExport({ profile: PROFILE, productIds: [a.id, b.id], outputRoot: out, onExisting: 'replace' });
  assert.equal(res.exported, 2);
  assert.equal(res.replaced, 0, 'nothing was in the folder before the run');
  assert.equal(res.renamedInRun, 1);
  assert.deepEqual(fs.readdirSync(out).sort(), ['អាវ-2.png', 'អាវ.png']);
});

test('Cancel stops between images and reports what was written', { skip: skipReason }, async () => {
  const { dataDir, company } = fresh();
  const ids = [];
  for (const sku of ['C-1', 'C-2', 'C-3']) ids.push((await productWithImage(dataDir, company.id, sku, sku)).id);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-uxsweep-cancel-'));
  const { runExport } = require('../main/exportRunner');
  let written = 0;
  const res = await runExport({
    profile: { ...PROFILE, namingPattern: '{SKU}' },
    productIds: ids,
    outputRoot: out,
    isCancelled: () => written >= 1,
    onProgress: (stage) => { if (stage === 'image') written += 1; },
  });
  assert.equal(res.cancelled, true);
  assert.equal(res.exported, 1);
  assert.equal(res.productsDone, 1);
  assert.deepEqual(fs.readdirSync(out), ['C-1.png']);
});

test('brand and category edits reach History, and its filters find them', { skip: skipReason }, () => {
  const { company } = fresh();
  const brands = require('../main/db/brands');
  const categories = require('../main/db/categories');
  const audit = require('../main/db/auditLog');
  const since = Date.now() - 1;

  const brand = brands.create({ companyId: company.id, name: 'ម៉ាក Nike' });
  brands.update(brand.id, { color: '#ff0000' });
  brands.update(brand.id, { color: '#ff0000' }); // no change → no row
  const cat = categories.create({ companyId: company.id, name: 'Shoes' });
  categories.update(cat.id, { name: 'Shoes 50%' });
  categories.remove(cat.id);
  brands.remove(brand.id);

  const brandRows = audit.listRecent({ entityType: 'brand' }).filter((r) => r.entityId === brand.id);
  assert.deepEqual(brandRows.map((r) => r.action).sort(), ['create', 'delete', 'update']);
  const catRows = audit.listRecent({ entityType: 'category' }).filter((r) => r.entityId === cat.id);
  assert.deepEqual(catRows.map((r) => r.action).sort(), ['create', 'delete', 'update']);

  // Who: this Mac's own edits carry no user id.
  assert.ok(audit.countRecent({ userId: audit.NO_USER, since }) >= 6);
  // When: nothing in the future.
  assert.equal(audit.countRecent({ since: Date.now() + 60_000 }), 0);
  // Text: a changed value, with LIKE's % taken literally.
  const pct = audit.listRecent({ q: '50%', since });
  assert.ok(pct.some((r) => r.entityId === cat.id && r.action === 'update'));
  assert.equal(audit.countRecent({ q: '5_%', since }), 0, '"_" is a literal, not a wildcard');
});

test('search returns suppliers and PO numbers only when costing is allowed', { skip: skipReason }, () => {
  const { company } = fresh();
  const suppliers = require('../main/db/suppliers');
  const pos = require('../main/db/purchaseOrders');
  const { globalSearch } = require('../main/db/search');
  const sup = suppliers.create({ companyId: company.id, name: 'Guangzhou Widgets' });
  pos.create({ companyId: company.id, supplierId: sup.id, poNumber: 'PO-7781', incoterm: 'FOB' });

  assert.deepEqual(globalSearch(company.id, 'Guangzhou', 30).map((r) => r.kind), []);
  assert.deepEqual(globalSearch(company.id, 'Guangzhou', 30, { includeCosting: true }).map((r) => r.kind), ['supplier']);
  const po = globalSearch(company.id, '7781', 30, { includeCosting: true });
  assert.equal(po[0].kind, 'po');
  assert.equal(po[0].label, 'PO-7781');
  assert.equal(po[0].sublabel, 'Guangzhou Widgets');
});

test('export profile paths validate before SQLite writes and stored paths validate at runtime', { skip: skipReason }, async () => {
  const { dataDir, company } = fresh();
  const profiles = require('../main/db/exportProfiles');
  const { runExport, expectedOutputs } = require('../main/exportRunner');
  try {
    for (const outputSubfolder of ['../outside', '/outside', 'C:\\outside', 'nested\\..\\outside']) {
      assert.throws(() => profiles.create({ companyId: company.id, name: 'Unsafe', outputSubfolder }), /subfolder|relative/i);
    }
    assert.equal(profiles.list(company.id).length, 0);
    const profile = profiles.create({ companyId: company.id, name: 'Safe', outputSubfolder: 'nested/photos' });
    assert.throws(() => profiles.update(profile.id, { name: 'Changed', outputSubfolder: '../outside' }), /subfolder|relative/i);
    assert.equal(profiles.get(profile.id).name, 'Safe');
    assert.equal(profiles.get(profile.id).outputSubfolder, 'nested/photos');
    const product = await productWithImage(dataDir, company.id, 'BOUNDARY-1', 'Boundary');
    const outputRoot = path.join(dataDir, 'output');
    const result = await runExport({ profile, productIds: [product.id], outputRoot });
    assert.equal(result.exported, 1);
    assert.equal(fs.readdirSync(path.join(outputRoot, 'nested/photos')).length, 1);
    // Legacy rows do not pass through create/update, so runtime must enforce it.
    db.getDb().prepare('UPDATE export_profiles SET output_subfolder = ? WHERE id = ?').run('../outside', profile.id);
    const legacy = profiles.get(profile.id);
    assert.throws(() => expectedOutputs({ profile: legacy, productIds: [product.id] }), /subfolder|relative/i);
    await assert.rejects(runExport({ profile: legacy, productIds: [product.id], outputRoot }), /subfolder|relative/i);
    assert.equal(fs.existsSync(path.join(dataDir, 'outside')), false);
  } finally {
    db.closeDb();
    // This is disposable test data, never the configured owner data folder.
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
