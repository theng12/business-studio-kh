/**
 * Purchase-order landed cost, against real SQLite through the real modules.
 *
 * Each case is a bug that shipped:
 *   1. closing a received PO (the documented last step) cleared received_at
 *      and wiped its landed cost from every product on it;
 *   2. editing a received PO's lines / costs never refreshed product costs;
 *   3. changing the FX rate or currency never re-converted lines or costs,
 *      though the screen said it did;
 *   5. a "discount" cost line ADDED cost (stored and summed as positive);
 *   7. the received date could not be corrected, and the 3- / 12-month
 *      averages were frozen at the date of the last PO edit;
 *   6. deleting a product on a PO failed with a bare "FOREIGN KEY constraint
 *      failed";
 *  10. the Dashboard counted a product priced only at wholesale or through a
 *      price group as having "no price".
 *
 * RUNNING THIS. Needs the native binding built for ELECTRON's ABI:
 *
 *     npm run test:native
 *
 * Under plain `npm test` it SKIPs with that command as the reason.
 */
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
let dashboard = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  suppliers = require('../main/db/suppliers');
  purchaseOrders = require('../main/db/purchaseOrders');
  dashboard = require('../main/db/dashboard');
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

test.after(() => { Module._load = originalLoad; });

const DAY = 24 * 3600 * 1000;
const dirs = [];
test.after(() => {
  try { db?.getDb().close(); } catch (_) {}
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A fresh database with one company, one supplier and two products. */
function seed({ currency = 'USD', rate = 1 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-po-cost-'));
  dirs.push(dataDir);
  db.initDb(dataDir);
  const company = companies.create({ name: 'Co', isActive: true });
  const supplier = suppliers.create({ companyId: company.id, name: 'Supplier', defaultCurrency: currency });
  const a = products.create({ companyId: company.id, sku: 'A-1', name: 'Apple' });
  const b = products.create({ companyId: company.id, sku: 'B-1', name: 'Banana' });
  const po = purchaseOrders.create({
    companyId: company.id, supplierId: supplier.id, poNumber: 'PO-1', currency, exchangeRateToUsd: rate,
  });
  return { company, supplier, a, b, po };
}

const close = (x, y, msg) => assert.ok(Math.abs(x - y) < 1e-9, `${msg ?? ''} expected ${y}, got ${x}`);

test('1: closing a received PO keeps its landed cost; re-opening drops it', { skip: skipReason }, () => {
  const { a, po } = seed();
  purchaseOrders.addLine(po.id, { productId: a.id, qty: 10, unitPriceSupplierCurrency: 5 });
  purchaseOrders.addComponent(po.id, { kind: 'freight', amountSupplierCurrency: 50 });
  purchaseOrders.setStatus(po.id, 'received');
  const receivedAt = purchaseOrders.get(po.id).receivedAt;
  assert.ok(receivedAt > 0);
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 10);

  const closed = purchaseOrders.setStatus(po.id, 'closed');
  assert.equal(closed.receivedAt, receivedAt, 'closing keeps the received date');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 10, 'closed PO still counts');
  assert.equal(purchaseOrders.listProductCosts(closed.companyId).length, 1);

  // closed → received keeps the original date (no new stamp).
  assert.equal(purchaseOrders.setStatus(po.id, 'received').receivedAt, receivedAt);

  const reopened = purchaseOrders.setStatus(po.id, 'ordered');
  assert.equal(reopened.receivedAt, null, 'going back to ordered clears the date');
  assert.equal(purchaseOrders.getProductCost(a.id), null);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM product_landed_costs').get().n, 0);
});

test('1: a PO closed straight from draft is not a cost source', { skip: skipReason }, () => {
  const { a, po } = seed();
  purchaseOrders.addLine(po.id, { productId: a.id, qty: 1, unitPriceSupplierCurrency: 5 });
  const closed = purchaseOrders.setStatus(po.id, 'closed');
  assert.equal(closed.receivedAt, null);
  assert.equal(purchaseOrders.getProductCost(a.id), null);
});

test('2: editing lines, costs and payments on a received PO refreshes product costs', { skip: skipReason }, () => {
  const { a, b, po } = seed();
  const withA = purchaseOrders.addLine(po.id, { productId: a.id, qty: 10, unitPriceSupplierCurrency: 5 });
  purchaseOrders.setStatus(po.id, 'received');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 5);

  purchaseOrders.updateLine(withA.lines[0].id, { unitPriceSupplierCurrency: 6 });
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 6, 'line edit');

  const withC = purchaseOrders.addComponent(po.id, { kind: 'freight', amountSupplierCurrency: 20 });
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 8, 'component add');
  purchaseOrders.updateComponent(withC.components[0].id, { amountSupplierCurrency: 40 });
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 10, 'component edit');

  const withB = purchaseOrders.addLine(po.id, { productId: b.id, qty: 10, unitPriceSupplierCurrency: 6 });
  close(purchaseOrders.getProductCost(b.id).latestLandedCostUsd, 8, 'new line on a received PO gets a cost');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 8, 'the shared freight is re-split');

  purchaseOrders.addPayment(po.id, { amountSupplierCurrency: 120, ttFeeUsd: 24, ttFeeInLanded: true, status: 'paid' });
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 8 + 1.2, 'in-landed TT fee');

  purchaseOrders.removeComponent(withC.components[0].id);
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 6 + 1.2, 'component removed');

  const lineB = withB.lines.find((l) => l.productId === b.id);
  purchaseOrders.removeLine(lineB.id);
  assert.equal(purchaseOrders.getProductCost(b.id), null, 'the removed line no longer costs its product');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM product_landed_costs WHERE product_id = ?').get(b.id).n, 0);
});

test('3: changing the FX rate or currency re-converts every line and cost', { skip: skipReason }, () => {
  const { a, po } = seed({ currency: 'CNY', rate: 0.14 });
  purchaseOrders.addLine(po.id, { productId: a.id, qty: 10, unitPriceSupplierCurrency: 100 });
  purchaseOrders.addComponent(po.id, { kind: 'freight', amountSupplierCurrency: 70 });
  purchaseOrders.setStatus(po.id, 'received');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 14 + 0.98);

  purchaseOrders.update(po.id, { exchangeRateToUsd: 0.15 });
  let d = purchaseOrders.getDetail(po.id);
  close(d.lines[0].unitPriceUsdAtPo, 15, 'line re-converted');
  close(d.components[0].amountUsd, 10.5, 'component re-converted');
  close(d.header.totalValueUsd, 150, 'header total recomputed');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 15 + 1.05, 'product cost follows');

  // Switching to USD with no rate converts 1:1.
  purchaseOrders.update(po.id, { currency: 'USD' });
  d = purchaseOrders.getDetail(po.id);
  assert.equal(d.header.exchangeRateToUsd, 1);
  close(d.lines[0].unitPriceUsdAtPo, 100);
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 107);

  // An unchanged rate rewrites nothing.
  const before = purchaseOrders.getDetail(po.id);
  purchaseOrders.update(po.id, { exchangeRateToUsd: 1 });
  assert.deepEqual(purchaseOrders.getDetail(po.id).lines, before.lines);
});

test('3b: switching back to a non-USD currency must name its rate — the old rate is never reused', { skip: skipReason }, () => {
  const { a, po } = seed({ currency: 'CNY', rate: 0.14 });
  purchaseOrders.addLine(po.id, { productId: a.id, qty: 10, unitPriceSupplierCurrency: 70 });
  purchaseOrders.setStatus(po.id, 'received');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 9.8);

  purchaseOrders.update(po.id, { currency: 'USD' });           // misclick
  assert.throws(() => purchaseOrders.update(po.id, { currency: 'CNY' }), /Enter the exchange rate for CNY/);
  assert.equal(purchaseOrders.getDetail(po.id).header.currency, 'USD', 'a refused switch changes nothing');

  purchaseOrders.update(po.id, { currency: 'CNY', exchangeRateToUsd: 0.14 });
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 9.8, 'back to the real cost');
});

test('5: a discount lowers landed cost — stored negative, and old positive rows read as negative', { skip: skipReason }, () => {
  const { a, po } = seed();
  purchaseOrders.addLine(po.id, { productId: a.id, qty: 10, unitPriceSupplierCurrency: 10 });
  const d = purchaseOrders.addComponent(po.id, { kind: 'discount', amountSupplierCurrency: 20 });
  assert.equal(d.components[0].amountSupplierCurrency, -20, 'entered positive, stored negative');
  assert.equal(d.components[0].amountUsd, -20);
  close(d.lines[0].calc.landedUnitCostUsd, 8);
  close(d.calc.totalComponentsUsd, -20);
  purchaseOrders.setStatus(po.id, 'received');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 8);
  close(purchaseOrders.get(po.id).totalComponentsUsd, -20, 'header cache');

  // A row saved before the fix: discount with a POSITIVE amount.
  db.getDb().prepare(`UPDATE po_cost_components SET amount_supplier_currency = 20, amount_usd = 20 WHERE po_id = ?`).run(po.id);
  purchaseOrders.recomputeHeader(po.id);
  close(purchaseOrders.getDetail(po.id).lines[0].calc.landedUnitCostUsd, 8, 'legacy positive discount still subtracts');
  close(purchaseOrders.getProductCost(a.id).latestLandedCostUsd, 8);

  // Changing the kind flips the sign with it.
  const comp = purchaseOrders.getDetail(po.id).components[0];
  const asFreight = purchaseOrders.updateComponent(comp.id, { kind: 'freight' });
  assert.equal(asFreight.components[0].amountSupplierCurrency, 20);
  close(asFreight.lines[0].calc.landedUnitCostUsd, 12);
  const backToDiscount = purchaseOrders.updateComponent(comp.id, { kind: 'discount', amountSupplierCurrency: 30 });
  assert.equal(backToDiscount.components[0].amountSupplierCurrency, -30);
  close(backToDiscount.lines[0].calc.landedUnitCostUsd, 7);
});

test('7: the received date is editable and the averages age with today', { skip: skipReason }, () => {
  const { company, supplier, a, po } = seed();
  assert.throws(() => purchaseOrders.update(po.id, { receivedAt: Date.now() }), /received or closed/,
    'a draft PO has no received date to set');

  purchaseOrders.addLine(po.id, { productId: a.id, qty: 10, unitPriceSupplierCurrency: 10 });
  purchaseOrders.setStatus(po.id, 'received');
  assert.throws(() => purchaseOrders.update(po.id, { receivedAt: null }), /valid date/);

  const old = Date.now() - 100 * DAY;
  purchaseOrders.update(po.id, { receivedAt: old });
  assert.equal(purchaseOrders.get(po.id).receivedAt, old);
  let cost = purchaseOrders.getProductCost(a.id);
  close(cost.latestLandedCostUsd, 10);
  assert.equal(cost.latestReceivedAt, old);
  assert.equal(cost.avgLandedCostUsd3mo, null, '100 days ago is outside the 3-month window');
  close(cost.avgLandedCostUsd12mo, 10);

  // The cache row was written while the PO was fresh; a read must still
  // apply today's window rather than trusting the cached average.
  db.getDb().prepare('UPDATE product_landed_costs SET avg_landed_cost_usd_3mo = 999 WHERE product_id = ?').run(a.id);
  assert.equal(purchaseOrders.getProductCost(a.id).avgLandedCostUsd3mo, null);

  const po2 = purchaseOrders.create({ companyId: company.id, supplierId: supplier.id, poNumber: 'PO-2' });
  purchaseOrders.addLine(po2.id, { productId: a.id, qty: 30, unitPriceSupplierCurrency: 14 });
  purchaseOrders.setStatus(po2.id, 'received');
  cost = purchaseOrders.getProductCost(a.id);
  close(cost.latestLandedCostUsd, 14, 'the newest receipt is the latest');
  assert.equal(cost.latestPoId, po2.id);
  close(cost.avgLandedCostUsd3mo, 14);
  close(cost.avgLandedCostUsd12mo, (10 * 10 + 30 * 14) / 40, 'qty-weighted over both');

  // Back-dating the newer PO before the older one changes which is latest.
  purchaseOrders.update(po2.id, { receivedAt: old - DAY });
  cost = purchaseOrders.listProductCosts(company.id).find((c) => c.productId === a.id);
  close(cost.latestLandedCostUsd, 10);
  assert.equal(cost.latestPoId, po.id);
  assert.equal(cost.avgLandedCostUsd3mo, null);
});

test('6: deleting a product on a PO names the PO instead of a foreign-key error', { skip: skipReason }, () => {
  const { a, b, po } = seed();
  purchaseOrders.addLine(po.id, { productId: a.id, qty: 1, unitPriceSupplierCurrency: 1 });
  assert.throws(() => products.remove(a.id), /^Error: SKU A-1 is on purchase order PO-1\. Remove it from that PO first\.$/);
  assert.ok(products.get(a.id), 'nothing was removed');
  const bulk = products.bulkRemove([a.id]);
  assert.equal(bulk.deleted, 0);
  assert.match(bulk.failed[0].error, /purchase order PO-1/);
  assert.equal(products.remove(b.id), true, 'a product on no PO still deletes');
});

test('10: "no price" counts only products with no price anywhere', { skip: skipReason }, () => {
  const { company } = seed();
  // seed() made A-1 and B-1 with no price at all.
  products.create({ companyId: company.id, sku: 'R', priceRetail: 5 });
  products.create({ companyId: company.id, sku: 'W', priceWholesale: 4 });
  products.create({ companyId: company.id, sku: 'G', prices: { vip: { amount: 3, currency: 'USD' } } });
  products.create({ companyId: company.id, sku: 'L', prices: { vip: 2 } });
  products.create({ companyId: company.id, sku: 'E', prices: { vip: { amount: null, currency: 'USD' }, x: '' } });
  assert.equal(dashboard.completenessFor(company.id).missingPrice, 3, 'A-1, B-1 and E');
});
