/**
 * 2026-10-11: Library → Export → Excel workbook.
 *
 * Owner: "it must use the same columns as the import sample … either way it
 * must match", plus a frozen header row and readable column widths, and a
 * choice of all / filtered / selected rows. These cases read the real .xlsx
 * bytes back with the importer's own library and map every header through the
 * importer's own `autoGuess`, so an exported file is proven to import back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const esbuild = require('esbuild');
const { productColumns, buildProductSampleWorkbook, buildProductExportWorkbook } = require('../main/util/productWorkbook');
const fileHandler = require('../main/fileHandler');

const ROOT = path.join(__dirname, '..');
const GROUPS = [{ key: 'export', label: 'Export' }, { key: 'dealer-net', label: 'Dealer net' }];
const CUSTOM = ['custom.origin', 'custom.grade'];

function bundle(entry, shims = {}) {
  return esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand', '@imgly/background-removal'],
    plugins: [{
      name: 'shims',
      setup(build) {
        build.onResolve({ filter: /store\/index\.js$/ }, () => ({ path: 'store-shim', namespace: 'test' }));
        build.onLoad({ filter: /^store-shim$/, namespace: 'test' }, () => ({
          contents: shims.store || 'module.exports = { useAppStore: () => ({}) };', loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  }).then((out) => {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
    return mod.exports;
  });
}
const importModal = bundle('renderer/modules/ProductLibrary/ImportModal.jsx');
const scopeHelpers = bundle('renderer/modules/ProductLibrary/exportWorkbook.js');

function readBack(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return {
    wb,
    rows: XLSX.utils.sheet_to_json(wb.Sheets.Products, { header: 1, defval: '' }),
    instructions: XLSX.utils.sheet_to_json(wb.Sheets.Instructions, { header: 1, defval: '' }),
  };
}

function sheetXml(buf) {
  const zip = XLSX.CFB.read(buf, { type: 'buffer' });
  return Buffer.from(XLSX.CFB.find(zip, '/xl/worksheets/sheet1.xml').content).toString('utf8');
}

const brandsById = new Map([['b1', { name: 'Demo brand' }]]);
const categoriesById = new Map([['c1', { name: 'Tiles' }]]);
const FULL = {
  id: 'p1', sku: 'KT-6060-W', name: 'ក្បឿង Matte white', brandId: 'b1', categoryId: 'c1',
  barcode: '0885123456789', secondaryCode: 'ALT-1', subcategory: 'Wall', colorFinish: 'Matte white',
  description: 'Line one', unit: 'sqm', variant: '60 × 60 cm',
  priceRetail: 12.5, priceRetailCurrency: 'USD', priceWholesale: 41000, priceWholesaleCurrency: 'KHR',
  prices: { export: { amount: 4.75, currency: 'USD' }, 'dealer-net': 3 },
  tags: ['matte', 'ceramic'], status: 'inactive', supplierSku: 'FAC-1', hsCode: '6907.21',
  cartonQty: 4, cartonWCm: 62, cartonHCm: 12, cartonDCm: 62, weightPerUnitKg: 8.5, stockQty: 0,
  customFields: { origin: 'Vietnam', grade: 'A' },
};
const EMPTY = {
  id: 'p2', sku: 'EMPTY-1', name: '', priceRetailCurrency: 'USD', priceWholesaleCurrency: 'USD',
  prices: {}, tags: [], status: 'active', stockQty: null, customFields: {},
};

test('the import sample and the export have exactly the same columns, in the same order', () => {
  const sample = readBack(buildProductSampleWorkbook({ priceGroups: GROUPS, customFields: CUSTOM }));
  const exported = readBack(buildProductExportWorkbook({ products: [FULL], brandsById, categoriesById, priceGroups: GROUPS, customFields: CUSTOM }));
  assert.deepEqual(exported.rows[0], sample.rows[0]);
  assert.deepEqual(exported.instructions, sample.instructions, 'the same Instructions sheet travels with both');
  // The standalone sample download writes the same bytes' columns.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'msk-wb-')), 'sample.xlsx');
  fileHandler.writeProductSampleWorkbook(file, { priceGroups: GROUPS, customFields: CUSTOM });
  assert.deepEqual(readBack(fs.readFileSync(file)).rows[0], sample.rows[0]);
});

test('every column maps back through the importer to the field it came from', async () => {
  const { autoGuess } = await importModal;
  const expected = {
    SKU: 'sku', Brand: 'brand', Barcode: 'barcode', 'Secondary code': 'secondaryCode', Name: 'name',
    Category: 'category', Subcategory: 'subcategory', 'Color/Finish': 'colorFinish', Description: 'description',
    Unit: 'unit', Variant: 'variant', 'Retail price': 'priceRetail', 'Retail currency': 'priceRetailCurrency',
    'Wholesale price': 'priceWholesale', 'Wholesale currency': 'priceWholesaleCurrency',
    'Export price': 'price.export', 'Export currency': 'price.export.currency',
    'Dealer net price': 'price.dealer-net', 'Dealer net currency': 'price.dealer-net.currency',
    Tags: 'tags', Status: 'status', 'Supplier SKU': 'supplierSku', 'HS code': 'hsCode',
    'Units per carton': 'cartonQty', 'Carton width (cm)': 'cartonWCm', 'Carton height (cm)': 'cartonHCm',
    'Carton length (cm)': 'cartonDCm', 'Weight per unit (kg)': 'weightPerUnitKg', 'Stock on hand': 'stockQty',
    'custom.origin': 'custom.origin', 'custom.grade': 'custom.grade',
  };
  const headers = productColumns({ priceGroups: GROUPS, customFields: CUSTOM }).map((c) => c.header);
  assert.deepEqual(headers, Object.keys(expected), 'no column is missing or extra');
  for (const h of headers) assert.equal(autoGuess(h, GROUPS, CUSTOM), expected[h], `"${h}" must map to ${expected[h]}`);
});

test('exported cells hold the product\'s values (text stays text, numbers stay numbers)', () => {
  const { rows } = readBack(buildProductExportWorkbook({ products: [FULL, EMPTY], brandsById, categoriesById, priceGroups: GROUPS, customFields: CUSTOM }));
  const [headers, full, empty] = rows;
  const cell = (row, h) => row[headers.indexOf(h)];
  assert.equal(cell(full, 'SKU'), 'KT-6060-W');
  assert.equal(cell(full, 'Name'), 'ក្បឿង Matte white', 'Khmer survives');
  assert.equal(cell(full, 'Brand'), 'Demo brand');
  assert.equal(cell(full, 'Category'), 'Tiles');
  assert.equal(cell(full, 'Barcode'), '0885123456789', 'leading zero kept: barcode is text');
  assert.equal(cell(full, 'HS code'), '6907.21');
  assert.equal(cell(full, 'Wholesale price'), 41000);
  assert.equal(cell(full, 'Wholesale currency'), 'KHR');
  assert.equal(cell(full, 'Export price'), 4.75);
  assert.equal(cell(full, 'Export currency'), 'USD');
  assert.equal(cell(full, 'Dealer net price'), 3, 'a legacy bare-number group price still exports');
  assert.equal(cell(full, 'Tags'), 'matte, ceramic');
  assert.equal(cell(full, 'Status'), 'inactive');
  assert.equal(cell(full, 'Stock on hand'), 0, 'a counted zero is not blank');
  assert.equal(cell(full, 'custom.origin'), 'Vietnam');
  // A product with nothing filled in exports blanks — never "null", "NaN" or a stray currency.
  for (const h of ['Name', 'Retail price', 'Retail currency', 'Export price', 'Export currency', 'Stock on hand', 'custom.grade', 'Brand']) {
    assert.equal(cell(empty, h), '', `${h} is blank`);
  }
});

test('the header row is frozen and every column has a readable width', () => {
  for (const buf of [
    buildProductSampleWorkbook({ priceGroups: GROUPS }),
    buildProductExportWorkbook({ products: [FULL], brandsById, categoriesById, priceGroups: GROUPS }),
  ]) {
    const xml = sheetXml(buf);
    assert.match(xml, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
    const widths = [...xml.matchAll(/<col min="(\d+)" max="\d+" width="([\d.]+)"/g)];
    assert.equal(widths.length, productColumns({ priceGroups: GROUPS }).length, 'one width per column');
    assert.ok(widths.every(([, , w]) => Number(w) >= 10), 'no squeezed column');
  }
});

test('the frozen workbook still opens with the importer\'s reader (readWorkbook)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'msk-wb-')), 'export.xlsx');
  fs.writeFileSync(file, buildProductExportWorkbook({ products: [FULL], brandsById, categoriesById, priceGroups: GROUPS, customFields: CUSTOM }));
  const parsed = fileHandler.readWorkbook(file);
  const products = parsed.sheets.find((s) => s.name === 'Products');
  assert.equal(products.rowCount, 1);
  assert.equal(products.rows[0].SKU, 'KT-6060-W');
  assert.equal(products.looksLikeTitleRow, false);
});

test('all / filtered / selection choices', async () => {
  const { workbookScopeOptions, defaultWorkbookScope, workbookExportArgs } = await scopeHelpers;
  // No filter, nothing ticked: only "all" is usable.
  let opts = workbookScopeOptions({ totalCount: 5, filteredIds: ['a', 'b', 'c', 'd', 'e'], selectedIds: [] });
  assert.deepEqual(opts.map((o) => [o.scope, o.disabled]), [['all', false], ['filtered', true], ['selection', true]]);
  assert.equal(defaultWorkbookScope(opts), 'all');
  // A filter is on: it is offered and preferred.
  opts = workbookScopeOptions({ totalCount: 5, filteredIds: ['c', 'a'], selectedIds: [] });
  assert.equal(defaultWorkbookScope(opts), 'filtered');
  // A selection wins.
  opts = workbookScopeOptions({ totalCount: 5, filteredIds: ['c', 'a'], selectedIds: ['a'] });
  assert.equal(defaultWorkbookScope(opts), 'selection');
  // Arguments: ids only for filtered / selection, in the order given.
  assert.deepEqual(workbookExportArgs({ companyId: 'co', scope: 'all', filteredIds: ['x'] }), { companyId: 'co', scope: 'all' });
  assert.deepEqual(workbookExportArgs({ companyId: 'co', scope: 'filtered', filteredIds: ['c', 'a'] }), { companyId: 'co', scope: 'filtered', ids: ['c', 'a'] });
  assert.deepEqual(workbookExportArgs({ companyId: 'co', scope: 'selection', selectedIds: ['a'] }), { companyId: 'co', scope: 'selection', ids: ['a'] });
});

test('validator: scope and ids are checked the same way on both paths', () => {
  const { getValidator } = require('../main/server/validators');
  for (const channel of ['exports:getProductsWorkbook', 'exports:saveProductsWorkbook']) {
    const v = getValidator(channel);
    assert.equal(v({ scope: 'all' }), true);
    assert.equal(v({ scope: 'filtered', ids: ['a', 'b'] }), true);
    assert.equal(v({ scope: 'selection', ids: ['a'] }), true);
    assert.notEqual(v({ scope: 'everything' }), true);
    assert.notEqual(v({ scope: 'selection', ids: [] }), true);
    assert.notEqual(v({ scope: 'all', ids: ['a'] }), true);
    assert.notEqual(v({ scope: 'filtered', ids: [1] }), true);
  }
});
