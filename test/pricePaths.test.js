/**
 * One product, one set of prices, every surface that prints them.
 *
 * The overlay's `{price_vip}` was the symptom the owner found; this walks the
 * OTHER price surfaces with a single fixture — a catalog page, a label, and
 * both CSV exports — so "custom pricing works" means the same thing
 * everywhere, and a surface that quietly drops or mis-formats a group fails
 * here rather than on a customer's PDF.
 *
 * Native (`npm run test:native`): the company/product rows need the database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run this test with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron";
  } else {
    throw err;
  }
}

test('every surface that prints a price agrees about custom groups', { skip: skipReason }, async () => {
  const originalLoad = Module._load;
  Module._load = function testLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() }, ipcMain: { handle() {}, on() {} }, shell: {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const db = require('../main/db');
  const companies = require('../main/db/companies');
  const products = require('../main/db/products');
  const studioRenderer = require('../main/studioRenderer');
  const { buildCatalogCsv } = require('../main/util/catalogCsv');
  Module._load = originalLoad;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-price-paths-'));
  try {
    db.initDb(dataDir);
    const company = companies.create({ name: 'Paths Company' });
    companies.update(company.id, {
      priceGroups: [{ key: 'vip', label: 'VIP' }, { key: 'dealer', label: 'Dealer' }],
    });

    const product = products.create({
      companyId: company.id,
      sku: 'PATHS-1',
      name: 'Paths product',
      priceRetail: 100,
      priceRetailCurrency: 'USD',
      priceWholesale: 80,
      priceWholesaleCurrency: 'USD',
      prices: {
        vip: { amount: 1234.5, currency: 'USD' },
        dealer: 55,                      // the legacy bare-number shape
      },
    });
    const row = products.get(product.id);
    const groups = companies.get(company.id).priceGroups;

    // ── a catalog page, printing the VIP price ──────────────────────────
    const catalogHtml = studioRenderer.buildCatalogHtml({
      project: {
        name: 'VIP catalog',
        config: {
          priceGroup: 'vip',
          fields: [
            { key: 'sku', label: 'SKU', visible: true },
            { key: 'price', label: 'VIP', visible: true },
            { key: 'price.dealer', label: 'Dealer', visible: true },
          ],
        },
      },
      products: [row],
      brands: [],
      categories: [],
      company: companies.get(company.id),
    });
    assert.match(catalogHtml, /\$1,234\.50/, 'the catalog prints the group price, formatted with its currency');
    assert.match(catalogHtml, /\$55\.00|\b55\b/, 'and a group stored as a bare number is not dropped');
    assert.doesNotMatch(catalogHtml, /NaN/, 'never a NaN');

    // ── a label, printing the same group ────────────────────────────────
    const labelsHtml = await studioRenderer.labelsDocument({
      template: {
        name: 'VIP label', widthMm: 50, heightMm: 30,
        elements: [
          { id: 'e1', type: 'text', field: 'sku', x: 2, y: 2, width: 40, height: 6, fontSize: 9 },
          { id: 'e2', type: 'price', field: 'price.vip', x: 2, y: 10, width: 40, height: 8, fontSize: 14 },
          { id: 'e3', type: 'price', field: 'priceRetail', prefix: '$', x: 2, y: 18, width: 40, height: 8, fontSize: 14 },
          { id: 'e4', type: 'price', field: 'price.dealer', suffix: ' USD', x: 2, y: 24, width: 40, height: 5, fontSize: 9 },
        ],
      },
      products: [row],
      brands: [],
      layout: {},
    });
    assert.match(labelsHtml, /1,234\.50/, 'the label prints the VIP price too');
    // Owner's decision (2026-10-02): a label price is a bare formatted number,
    // and the currency is the element's own prefix/suffix — applied once.
    assert.doesNotMatch(labelsHtml, /\$1,234\.50/, 'a group price on a label carries no currency of its own');
    assert.match(labelsHtml, />\$100\.00</, 'retail prints as 100.00 with the template prefix once');
    assert.doesNotMatch(labelsHtml, /\$\$/, 'never a doubled symbol');
    assert.match(labelsHtml, />55\.00 USD</, 'a legacy bare-number group formats the same way, with the suffix');

    // ── the generic catalog sheet ───────────────────────────────────────
    const generic = buildCatalogCsv({
      products: [row], brandsById: new Map(), categoriesById: new Map(), priceGroups: groups, format: 'generic',
    });
    const header = generic.split('\r\n')[0];
    assert.match(header, /VIP price,VIP currency/, 'one column per group, like the Excel export');
    assert.match(header, /Dealer price,Dealer currency/);
    const line = generic.split('\r\n')[1];
    assert.match(line, /1234\.5,USD/, 'the VIP amount and its currency travel with the sheet');
    assert.match(line, /\b55\b/, 'the legacy-shaped group is exported, not blank');

    // ── the Google feed ─────────────────────────────────────────────────
    const google = buildCatalogCsv({
      products: [row], brandsById: new Map(), categoriesById: new Map(), priceGroups: groups, format: 'google',
    });
    assert.match(google.split('\r\n')[1], /100 USD/, 'the feed quotes the currency the price is actually in');

    const rielProduct = products.create({
      companyId: company.id, sku: 'PATHS-2', name: 'Riel product',
      priceRetail: 41000, priceRetailCurrency: 'KHR',
    });
    const rielFeed = buildCatalogCsv({
      products: [products.get(rielProduct.id)], brandsById: new Map(), categoriesById: new Map(), format: 'google',
    });
    assert.match(rielFeed.split('\r\n')[1], /41000 KHR/, 'a riel price is not exported as USD');
    assert.doesNotMatch(rielFeed, /USD/, 'and nothing claims dollars for it');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
