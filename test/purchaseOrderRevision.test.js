const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};
let db, companies, products, suppliers, pos, skip = false;
try {
  new (require('better-sqlite3'))(':memory:').close();
  db = require('../main/db'); companies = require('../main/db/companies');
  products = require('../main/db/products'); suppliers = require('../main/db/suppliers'); pos = require('../main/db/purchaseOrders');
} catch (error) {
  if (error.code !== 'ERR_DLOPEN_FAILED') throw error;
  skip = "Electron ABI required: ELECTRON_RUN_AS_NODE=1 electron --test test/purchaseOrderRevision.test.js";
}
let dir;
test.after(() => {
  Module._load = originalLoad;
  try { db?.getDb().close(); } catch {}
  if (dir) {
    const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'test-data'); fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dir, path.join(trash, path.basename(dir)));
  }
});

test('PO header and full child edits reject stale revisions; every cost mutation advances the parent token', { skip }, () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-po-revision-')); db.initDb(dir);
  const company = companies.create({ name: 'Revision check' });
  const supplier = suppliers.create({ companyId: company.id, name: 'Supplier' });
  const product = products.create({ companyId: company.id, sku: 'A', name: 'Apple' });
  const po = pos.create({ companyId: company.id, supplierId: supplier.id, currency: 'USD' });
  const revision = () => pos.get(po.id).updatedAt;
  const originalNow = Date.now; Date.now = () => po.updatedAt;
  try {
    const h = pos.update(po.id, { notes: 'first', expectedUpdatedAt: revision() });
    assert.ok(h.updatedAt > po.updatedAt, 'equal clock milliseconds still advance');
    assert.throws(() => pos.update(po.id, { notes: 'stale', expectedUpdatedAt: po.updatedAt }), /CONFLICT\|/);
    assert.equal(pos.get(po.id).notes, 'first');
    assert.throws(() => pos.update(po.id, { notes: 'bad', expectedUpdatedAt: NaN }), /finite number/);
    let before = revision();
    const line = pos.addLine(po.id, { productId: product.id, qty: 2, unitPriceSupplierCurrency: 5 }).lines[0];
    assert.ok(revision() > before); before = revision();
    pos.updateLine(line.id, { qty: 3, expectedUpdatedAt: before });
    assert.ok(revision() > before);
    assert.throws(() => pos.updateLine(line.id, { qty: 9, expectedUpdatedAt: before }), /CONFLICT\|/);
    const component = pos.addComponent(po.id, { kind: 'discount', amountSupplierCurrency: 1 }).components[0];
    before = revision(); pos.updateComponent(component.id, { amountSupplierCurrency: 2, expectedUpdatedAt: before });
    assert.ok(revision() > before);
    assert.throws(() => pos.updateComponent(component.id, { label: 'stale', expectedUpdatedAt: before }), /CONFLICT\|/);
    const payment = pos.addPayment(po.id, { amountSupplierCurrency: 2, fxRateToUsd: 1 }).payments[0];
    before = revision(); pos.updatePayment(payment.id, { reference: 'first', expectedUpdatedAt: before });
    assert.ok(revision() > before);
    assert.throws(() => pos.updatePayment(payment.id, { reference: 'stale', expectedUpdatedAt: before }), /CONFLICT\|/);
    before = revision(); pos.setStatus(po.id, 'received', null, before);
    assert.ok(revision() > before);
    assert.throws(() => pos.setStatus(po.id, 'ordered', null, before), /CONFLICT\|/);
    assert.equal(pos.get(po.id).status, 'received');
    assert.ok(pos.get(po.id).receivedAt > 0);
    // Intentional overwrite remains supported; no schema bump is needed.
    pos.update(po.id, { notes: 'overwrite' }); assert.equal(pos.get(po.id).notes, 'overwrite');
  } finally { Date.now = originalNow; }
});
