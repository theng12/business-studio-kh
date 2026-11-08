/**
 * Pick & Pack Phase 0 against a real database and a real data folder.
 *
 * Covers: additive schema, import upsert + saved mapping, quick add snapshots,
 * scan match / not-in-order, the photo-required rule and its threshold, seal
 * immutability at the SQLite layer, and the packer-facing read having no price.
 *
 * RUNNING: `npm run test:native`. Under plain `npm test` these cases SKIP.
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
  if (err && (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err.message)))) {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

let counter = 0;
function fixture() {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-pack-${counter}-`));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: `Shop ${counter}`, isActive: true });
  return { dataDir, company };
}

function mods() {
  return {
    products: require('../main/db/products'),
    pack: require('../main/db/pack'),
    photos: require('../main/packPhotos'),
  };
}

async function jpeg() {
  const sharp = require('sharp');
  return sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 180, g: 120, b: 60 } } }).jpeg().toBuffer();
}

test('schema is additive and idempotent', { skip: skipReason }, () => {
  const { dataDir } = fixture();
  db.closeDb();
  db.initDb(dataDir);
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['orders', 'order_lines', 'parcel_photos', 'order_import_mappings', 'pack_settings']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.equal(db.getDb().prepare("SELECT value FROM app_state WHERE key = 'schema_version'").get().value, '2');
});

test('import upserts by company+source+ref, never blanks fields, and reuses the saved mapping', { skip: skipReason }, () => {
  const { company } = fixture();
  const { products, pack } = mods();
  const p1 = products.create({ companyId: company.id, sku: 'SKU-1', name: 'Lamp', barcode: '111' });
  const p2 = products.create({ companyId: company.id, sku: 'SKU-2', name: 'Chair', barcode: '222' });

  pack.saveMapping(company.id, 'marketplace', { Ref: 'externalRef', SKU: 'sku', Qty: 'quantity' });
  assert.deepEqual(pack.getMapping(company.id, 'marketplace'), { Ref: 'externalRef', SKU: 'sku', Qty: 'quantity' });

  const first = pack.importOrders(company.id, 'marketplace', [
    { externalRef: 'A-1', customerName: 'Sokha', customerPhone: '0123', sku: 'SKU-1', quantity: 1 },
    { externalRef: 'A-1', sku: 'SKU-2', quantity: 2 },
  ]);
  assert.equal(first.created, 1);
  assert.equal(first.linesAdded, 2);

  const second = pack.importOrders(company.id, 'marketplace', [
    { externalRef: 'A-1', sku: 'SKU-1', quantity: 3 },
  ]);
  assert.equal(second.updated, 1);
  const got = pack.getOrder(company.id, second.orderIds[0]);
  assert.equal(got.order.customerName, 'Sokha', 'a repeat import must not blank a field it did not supply');
  assert.equal(got.order.customerPhone, '0123');
  assert.equal(got.lines.find((l) => l.sku === 'SKU-1').quantity, 3);
  assert.equal(got.lines.find((l) => l.sku === 'SKU-2').quantity, 2, 'a line missing from the new file is kept');

  const dry = pack.importOrders(company.id, 'marketplace', [{ externalRef: 'A-2', sku: 'SKU-1', quantity: 1 }], { dryRun: true });
  assert.equal(dry.created, 1);
  assert.equal(pack.listOrders(company.id).length, 1, 'a dry run writes nothing');

  assert.ok(p1.id && p2.id);
});

test('quick add snapshots the SKU and name', { skip: skipReason }, () => {
  const { company } = fixture();
  const { products, pack } = mods();
  const product = products.create({ companyId: company.id, sku: 'SNAP-1', name: 'Old name' });
  const res = pack.quickAdd(company.id, {
    source: 'chat', customerName: 'Dara', customerPhone: '099',
    lines: [{ productId: product.id, quantity: 2 }],
  });
  products.update(product.id, { name: 'New name' });
  const line = res.lines[0];
  assert.equal(line.sku, 'SNAP-1');
  assert.equal(line.name, 'Old name', 'the line keeps the name it was added with');
  assert.equal(line.quantity, 2);
});

test('scan matches barcode or SKU and says when the item is not in the order', { skip: skipReason }, () => {
  const { company } = fixture();
  const { products, pack } = mods();
  const product = products.create({ companyId: company.id, sku: 'SCAN-1', name: 'Box', barcode: '9001' });
  const res = pack.quickAdd(company.id, { source: 'manual', customerName: 'A', lines: [{ productId: product.id, quantity: 2 }] });
  const orderId = res.order.id;

  const byBarcode = pack.scan(company.id, orderId, '9001');
  assert.equal(byBarcode.matched, true);
  assert.equal(byBarcode.line.confirmedQty, 1);

  const bySku = pack.scan(company.id, orderId, 'scan-1');
  assert.equal(bySku.matched, true);
  assert.equal(bySku.line.confirmedQty, 2);

  const wrong = pack.scan(company.id, orderId, '0000');
  assert.equal(wrong.matched, false);
  assert.equal(wrong.message, 'Not in this order');
});

test('photo rule: always by default, optional below an explicit threshold', { skip: skipReason }, () => {
  const { company } = fixture();
  const { pack } = mods();
  const make = (ref, value) => {
    const r = pack.importOrders(company.id, 'sheet', [{ externalRef: ref, value, currency: 'USD', sku: 'X', quantity: 1 }]);
    return pack.getOrder(company.id, r.orderIds[0]);
  };
  const small = make('S-1', 10);
  const large = make('L-1', 100);
  assert.equal(small.photoRequired, true, 'a photo is always required by default');

  pack.updateSettings(company.id, { photoRequiredAboveMinor: 5000, currency: 'USD' });
  assert.equal(pack.getOrder(company.id, small.order.id).photoRequired, false);
  assert.equal(pack.getOrder(company.id, large.order.id).photoRequired, true);
});

test('seal needs a photo (when required) and every line confirmed; then the record is immutable', { skip: skipReason }, async () => {
  const { company, dataDir } = fixture();
  const { products, pack, photos } = mods();
  const product = products.create({ companyId: company.id, sku: 'SEAL-1', name: 'Box', barcode: '777' });
  const res = pack.quickAdd(company.id, { source: 'manual', customerName: 'A', lines: [{ productId: product.id, quantity: 1 }] });
  const orderId = res.order.id;

  assert.throws(() => pack.seal(company.id, orderId), /Confirm every item first/);
  pack.scan(company.id, orderId, '777');

  assert.throws(() => pack.seal(company.id, orderId), /photo before sealing/);
  const stored = await photos.saveParcelPhoto(orderId, 'sealed', await jpeg());
  pack.addPhotoRow(company.id, orderId, { kind: 'sealed', ...stored });
  assert.ok(stored.relPath.startsWith('pack/'));
  assert.ok(stored.relPath.includes(`/${orderId}/`));
  assert.match(stored.relPath, /sealed.*\.jpg$/);

  const sealed = pack.seal(company.id, orderId);
  assert.equal(sealed.order.status, 'packed');

  const row = db.getDb().prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  assert.ok(row.packed_at);
  const photo = db.getDb().prepare('SELECT * FROM parcel_photos WHERE order_id = ?').get(orderId);
  assert.equal(photo.sha256, stored.sha256);
  assert.ok(fs.existsSync(path.join(dataDir, photo.rel_path)));

  // Application layer refuses.
  assert.throws(() => pack.updateOrder(company.id, orderId, { customerName: 'B' }), /sealed/);
  assert.throws(() => pack.removeOrder(company.id, orderId), /sealed/);
  assert.throws(() => pack.addPhotoRow(company.id, orderId, { kind: 'sealed', ...stored }), /sealed/);

  // SQLite layer refuses too, even when the app code is bypassed.
  assert.throws(() => db.getDb().prepare('UPDATE orders SET customer_name = ? WHERE id = ?').run('B', orderId), /sealed/);
  assert.throws(() => db.getDb().prepare('DELETE FROM order_lines WHERE order_id = ?').run(orderId), /sealed/);
  assert.throws(() => db.getDb().prepare('UPDATE parcel_photos SET kind = ? WHERE order_id = ?').run('contents', orderId), /sealed/);
  assert.throws(() => db.getDb().prepare('DELETE FROM parcel_photos WHERE order_id = ?').run(orderId), /sealed/);
  assert.throws(() => db.getDb().prepare('DELETE FROM orders WHERE id = ?').run(orderId), /sealed/);
});

test('the pack-facing read has no price or order value; photos are company-scoped', { skip: skipReason }, async () => {
  const { company } = fixture();
  const companies = require('../main/db/companies');
  const other = companies.create({ name: 'Other', isActive: false });
  const { products, pack, photos } = mods();
  const product = products.create({ companyId: company.id, sku: 'PRIV-1', name: 'Box' });
  const res = pack.quickAdd(company.id, {
    source: 'chat', customerName: 'A', value: 99, currency: 'USD',
    lines: [{ productId: product.id, quantity: 1 }],
  });
  const orderId = res.order.id;
  const forPacking = pack.getOrder(company.id, orderId, { forPacking: true });
  const json = JSON.stringify(forPacking);
  assert.equal(Object.prototype.hasOwnProperty.call(forPacking.order, 'valueMinor'), false);
  assert.doesNotMatch(json, /price|valueMinor/i);
  assert.equal(pack.getOrder(company.id, orderId).order.valueMinor, 9900);

  const stored = await photos.saveParcelPhoto(orderId, 'contents', await jpeg());
  const photo = pack.addPhotoRow(company.id, orderId, { kind: 'contents', ...stored });
  assert.equal(pack.getPhoto(company.id, photo.id).id, photo.id);
  assert.throws(() => pack.getPhoto(other.id, photo.id), /not found/i);
});
