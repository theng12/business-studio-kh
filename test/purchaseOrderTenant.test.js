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

let db = null;
let companies = null;
let products = null;
let suppliers = null;
let purchaseOrders = null;
let posHandler = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  suppliers = require('../main/db/suppliers');
  purchaseOrders = require('../main/db/purchaseOrders');
  const handlers = new Map();
  require('../main/ipc/purchaseOrders').register({
    expose(channel, handler) { handlers.set(channel, handler); },
  });
  posHandler = handlers.get('pos:addLine');
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}
test('purchase-order line insertion rejects a product from another company', { skip: skipReason }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-po-tenant-'));
  try {
    db.initDb(dataDir);
    const companyA = companies.create({ name: 'Company A', isActive: true });
    const companyB = companies.create({ name: 'Company B', isActive: false });
    const supplierA = suppliers.create({ companyId: companyA.id, name: 'Supplier A' });
    const productA = products.create({ companyId: companyA.id, sku: 'A-1', name: 'A product' });
    const productB = products.create({ companyId: companyB.id, sku: 'B-1', name: 'B product' });
    const po = purchaseOrders.create({ companyId: companyA.id, supplierId: supplierA.id });
    const before = db.getDb().prepare(`
      SELECT total_value_supplier, total_value_usd, lines_count
      FROM purchase_orders WHERE id = ?
    `).get(po.id);

    assert.throws(
      () => posHandler({ poId: po.id, input: { productId: productB.id, qty: 2, unitPriceSupplierCurrency: 10 } }),
      /Product does not belong to purchase order company/,
    );
    assert.deepEqual(
      db.getDb().prepare(`
        SELECT total_value_supplier, total_value_usd, lines_count
        FROM purchase_orders WHERE id = ?
      `).get(po.id),
      before,
    );
    assert.equal(purchaseOrders.getDetail(po.id).lines.length, 0);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) AS count FROM po_lines WHERE po_id = ?').get(po.id).count, 0);

    const matching = posHandler({ poId: po.id, input: { productId: productA.id, qty: 2, unitPriceSupplierCurrency: 10 } });
    assert.equal(matching.lines.length, 1);
    assert.equal(matching.lines[0].productId, productA.id);
  } finally {
    try { db.getDb().close(); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
    Module._load = originalLoad;
  }
});
