/**
 * Ops & system screens audit (0.1.94) — the database halves. Needs Electron's
 * Node (better-sqlite3 is built for its ABI):
 *
 *   ELECTRON_RUN_AS_NODE=1 electron --test test/opsAuditNative.test.js
 *
 * Under plain `npm test` it reports skip with that command as the reason.
 *
 *   - The PO list's Dashboard filters: 'open' (draft/ordered/in transit) and
 *     'owed' (committed, not fully paid).
 *   - PO search finds a PO by a SKU, product name or supplier SKU on its lines.
 *   - The global History feed names products/brands of EVERY company (it used
 *     to say "(deleted product)" for the other company's live products).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getVersion: () => '0.1.94' } };
  return originalLoad.call(this, request, parent, isMain);
};

let db, companies, products, brands, suppliers, pos, auditLog, skip = false;
try {
  new (require('better-sqlite3'))(':memory:').close();
  db = require('../main/db');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  brands = require('../main/db/brands');
  suppliers = require('../main/db/suppliers');
  pos = require('../main/db/purchaseOrders');
  auditLog = require('../main/db/auditLog');
} catch (error) {
  if (error.code !== 'ERR_DLOPEN_FAILED') throw error;
  skip = 'Electron ABI required: ELECTRON_RUN_AS_NODE=1 electron --test test/opsAuditNative.test.js';
}

let dir;
test.before(() => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-ops-audit-'));
  db.initDb(dir);
});
test.after(() => {
  Module._load = originalLoad;
  try { db?.getDb().close(); } catch {}
  if (dir) {
    // Never rm: test data goes to the project's _trash (AGENTS.md working rule).
    const trash = path.join(__dirname, '../_trash/test-data');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dir, path.join(trash, path.basename(dir)));
  }
});

test('PO list: open / owed filters and search by a line SKU, name or supplier SKU', { skip }, () => {
  const company = companies.create({ name: 'Ops audit PO' });
  const supplier = suppliers.create({ companyId: company.id, name: 'Shenzhen Co' });
  const lamp = products.create({ companyId: company.id, sku: 'LAMP-2213', name: 'Desk lamp' });
  const fan = products.create({ companyId: company.id, sku: 'FAN-1', name: 'Ceiling fan' });

  const draft = pos.create({ companyId: company.id, supplierId: supplier.id, poNumber: 'PO-1', currency: 'USD' });
  const ordered = pos.create({ companyId: company.id, supplierId: supplier.id, poNumber: 'PO-2', currency: 'USD' });
  const paid = pos.create({ companyId: company.id, supplierId: supplier.id, poNumber: 'PO-3', currency: 'USD' });
  const received = pos.create({ companyId: company.id, supplierId: supplier.id, poNumber: 'PO-4', currency: 'USD' });

  pos.addLine(draft.id, { productId: fan.id, qty: 1, unitPriceSupplierCurrency: 5 });
  pos.addLine(ordered.id, { productId: lamp.id, qty: 10, unitPriceSupplierCurrency: 3, supplierSku: 'SZ-LMP-9' });
  pos.addLine(paid.id, { productId: fan.id, qty: 2, unitPriceSupplierCurrency: 4 });
  pos.addLine(received.id, { productId: fan.id, qty: 1, unitPriceSupplierCurrency: 1 });
  pos.setStatus(ordered.id, 'ordered');
  pos.setStatus(paid.id, 'ordered');
  pos.addPayment(paid.id, { amountSupplierCurrency: 8, fxRateToUsd: 1, status: 'paid' });
  pos.setStatus(received.id, 'received');

  const numbers = (filters) => pos.list(company.id, filters).map((p) => p.poNumber).sort();
  assert.deepEqual(numbers({ status: 'open' }), ['PO-1', 'PO-2', 'PO-3']);
  // Owed: committed (not a draft) and not fully paid. PO-3 is paid in full.
  assert.deepEqual(numbers({ status: 'owed' }), ['PO-2', 'PO-4']);
  assert.deepEqual(numbers({ status: 'ordered' }), ['PO-2', 'PO-3'], 'a plain status still filters exactly');

  assert.deepEqual(numbers({ search: 'lamp-2213' }), ['PO-2'], 'our SKU, any case');
  assert.deepEqual(numbers({ search: 'Desk' }), ['PO-2'], 'product name');
  assert.deepEqual(numbers({ search: 'SZ-LMP' }), ['PO-2'], "supplier's own SKU");
  assert.deepEqual(numbers({ search: 'PO-4' }), ['PO-4'], 'PO number still works');
  assert.deepEqual(numbers({ search: 'Shenzhen' }).length, 4, 'supplier name still works');
  assert.deepEqual(numbers({ search: '50%' }), [], 'LIKE wildcards in the search are literal');
  assert.deepEqual(numbers(null), ['PO-1', 'PO-2', 'PO-3', 'PO-4'], 'null filters are tolerated');
});

test('History feed names products and brands of every company, and only real deletions as deleted', { skip }, () => {
  const a = companies.create({ name: 'Company A' });
  const b = companies.create({ name: 'Company B' });
  const pa = products.create({ companyId: a.id, sku: 'A-1', name: 'ផលិតផល A' });
  const pb = products.create({ companyId: b.id, sku: 'B-1', name: 'Product B' });
  const brandB = brands.create({ companyId: b.id, name: 'Brand B' });
  auditLog.log({ entityType: 'product', entityId: pa.id, action: 'update', before: { name: 'x' }, after: { name: 'y' }, userId: null });
  auditLog.log({ entityType: 'product', entityId: pb.id, action: 'update', before: { name: 'x' }, after: { name: 'y' }, userId: null });
  auditLog.log({ entityType: 'image', entityId: pb.id, action: 'image:add', before: null, after: { path: 'p.jpg' }, userId: null });
  auditLog.log({ entityType: 'brand', entityId: brandB.id, action: 'update', before: { color: '#000' }, after: { color: '#fff' }, userId: null });
  auditLog.log({ entityType: 'product', entityId: 'gone-123', action: 'delete', before: { sku: 'OLD-9' }, after: null, userId: null });

  const rows = auditLog.listRecent({ limit: 50 });
  const byId = (id, type) => rows.find((r) => r.entityId === id && (!type || r.entityType === type));
  assert.deepEqual(byId(pa.id).entity, { exists: true, sku: 'A-1', name: 'ផលិតផល A', companyId: a.id, companyName: 'Company A' });
  assert.equal(byId(pb.id, 'product').entity.companyName, 'Company B', 'the other company resolves too');
  assert.equal(byId(pb.id, 'image').entity.sku, 'B-1', 'image rows are named from their product');
  assert.equal(byId(brandB.id).entity.name, 'Brand B');
  assert.equal(byId('gone-123').entity.exists, false, 'a real deletion still reads as deleted');
});
