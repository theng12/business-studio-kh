/**
 * 2026-10-11: the product Excel export against a real database.
 *
 * Proves the server-side builder behind exports:getProductsWorkbook /
 * exports:saveProductsWorkbook: all / filtered / selected rows in the order the
 * Library sends, another company's ids ignored, and a full round trip — export,
 * read back, import into a second company with bulkUpsert — keeping every
 * field (prices with currencies, price groups, custom fields, stock,
 * logistics, tags, status).
 *
 * Needs better-sqlite3 built for Electron's ABI: `npm run test:native`
 * (SKIPs under plain `npm test`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

let skipReason = false;
let db; let companies; let products; let brands; let categories; let exportsIpc;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  brands = require('../main/db/brands');
  categories = require('../main/db/categories');
  exportsIpc = require('../main/ipc/exports');
} catch {
  skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
}

const GROUPS = [{ key: 'export', label: 'Export' }];

function setup() {
  db.initDb(fs.mkdtempSync(path.join(os.tmpdir(), 'msk-prodwb-')));
  const co = companies.create({ name: 'KT Ceramic', isActive: true });
  companies.update(co.id, { priceGroups: GROUPS });
  const brand = brands.create({ companyId: co.id, name: 'Demo brand' });
  const cat = categories.create({ companyId: co.id, name: 'Tiles' });
  const mk = (sku, extra = {}) => products.create({ companyId: co.id, sku, name: `Name ${sku}`, ...extra });
  const a = mk('A-1', {
    brandId: brand.id, categoryId: cat.id, barcode: '0885123456789', secondaryCode: 'ALT-1',
    subcategory: 'Wall', colorFinish: 'Matte', description: 'ក្បឿង desc', unit: 'sqm', variant: '60x60',
    priceRetail: 12.5, priceRetailCurrency: 'USD', priceWholesale: 41000, priceWholesaleCurrency: 'KHR',
    prices: { export: { amount: 4.75, currency: 'THB' } }, tags: ['matte', 'ceramic'], status: 'inactive',
    supplierSku: 'FAC-1', hsCode: '6907.21', cartonQty: 4, cartonWCm: 62, cartonHCm: 12, cartonDCm: 62,
    weightPerUnitKg: 8.5, stockQty: 7, customFields: { origin: 'Vietnam' },
  });
  const b = mk('B-2');
  const c = mk('C-3');
  return { co, a, b, c };
}

function rowsOf(bytes) {
  const wb = XLSX.read(bytes, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets.Products, { defval: '' });
}

test('all / filtered / selection, in the order sent; other ids ignored', { skip: skipReason }, () => {
  const { co, a, b, c } = setup();
  const all = exportsIpc.buildProductsWorkbook({ companyId: co.id, scope: 'all' });
  assert.equal(all.count, 3);
  assert.equal(all.companyId, co.id);
  assert.match(all.filename, /^products-KT-Ceramic-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(rowsOf(all.bytes).map((r) => r.SKU).sort(), ['A-1', 'B-2', 'C-3']);

  const filtered = exportsIpc.buildProductsWorkbook({ scope: 'filtered', ids: [c.id, a.id, 'not-a-product', c.id] });
  assert.equal(filtered.count, 2);
  assert.deepEqual(rowsOf(filtered.bytes).map((r) => r.SKU), ['C-3', 'A-1'], 'Library order kept, duplicates and unknown ids dropped');
  assert.match(filtered.filename, /-filtered-/);

  const selected = exportsIpc.buildProductsWorkbook({ scope: 'selection', ids: [b.id] });
  assert.deepEqual(rowsOf(selected.bytes).map((r) => r.SKU), ['B-2']);
  assert.match(selected.filename, /-selected-/);

  // Another company's product ids never leak into this company's export.
  const other = companies.create({ name: 'Other', isActive: false });
  const foreign = products.create({ companyId: other.id, sku: 'X-9', name: 'Foreign' });
  const mixed = exportsIpc.buildProductsWorkbook({ scope: 'selection', ids: [foreign.id, b.id] });
  assert.deepEqual(rowsOf(mixed.bytes).map((r) => r.SKU), ['B-2']);
  assert.throws(() => exportsIpc.buildProductsWorkbook({ companyId: other.id, scope: 'all' }), /Cross-company/);
});

test('export → import into another company keeps every field', { skip: skipReason }, () => {
  const { co, a } = setup();
  const [row] = rowsOf(exportsIpc.buildProductsWorkbook({ scope: 'selection', ids: [a.id] }).bytes);

  // A second company with the same price group, as the importer would see it.
  const target = companies.create({ name: 'Copy', isActive: true });
  companies.update(target.id, { priceGroups: GROUPS });
  const brand = brands.create({ companyId: target.id, name: row.Brand });
  const cat = categories.create({ companyId: target.id, name: row.Category });
  const num = (v) => (v === '' ? null : Number(v));
  // The same per-field rules as the importer's buildRows (ImportModal.jsx).
  const imported = {
    sku: row.SKU, name: row.Name, brandId: brand.id, categoryId: cat.id, barcode: String(row.Barcode),
    secondaryCode: row['Secondary code'], subcategory: row.Subcategory, colorFinish: row['Color/Finish'],
    description: row.Description, unit: row.Unit, variant: row.Variant,
    priceRetail: num(row['Retail price']), priceRetailCurrency: row['Retail currency'],
    priceWholesale: num(row['Wholesale price']), priceWholesaleCurrency: row['Wholesale currency'],
    prices: { export: { amount: num(row['Export price']), currency: row['Export currency'] } },
    tags: String(row.Tags).split(',').map((s) => s.trim()).filter(Boolean), status: row.Status,
    supplierSku: row['Supplier SKU'], hsCode: String(row['HS code']), cartonQty: num(row['Units per carton']),
    cartonWCm: num(row['Carton width (cm)']), cartonHCm: num(row['Carton height (cm)']),
    cartonDCm: num(row['Carton length (cm)']), weightPerUnitKg: num(row['Weight per unit (kg)']),
    stockQty: num(row['Stock on hand']), customFields: { origin: row['custom.origin'] },
  };
  const res = products.bulkUpsert(target.id, [imported], { conflictPolicy: 'overwrite' });
  assert.ok(res, 'bulkUpsert ran');
  const copy = products.list(target.id, {}).find((p) => p.sku === 'A-1');
  const original = products.get(a.id);
  for (const key of ['name', 'barcode', 'secondaryCode', 'subcategory', 'colorFinish', 'description', 'unit',
    'variant', 'priceRetail', 'priceRetailCurrency', 'priceWholesale', 'priceWholesaleCurrency', 'status',
    'supplierSku', 'hsCode', 'cartonQty', 'cartonWCm', 'cartonHCm', 'cartonDCm', 'weightPerUnitKg', 'stockQty']) {
    assert.deepEqual(copy[key], original[key], key);
  }
  assert.deepEqual(copy.tags, original.tags);
  assert.deepEqual(copy.customFields, original.customFields);
  assert.equal(copy.prices.export.amount, 4.75);
  assert.equal(copy.prices.export.currency, 'THB');
  assert.equal(co.id === target.id, false);
});
