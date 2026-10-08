/* Scoped dashboard queues and catalog search. In-memory DB only.
 * ELECTRON_RUN_AS_NODE=1 electron --test test/attentionSearchNative.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
let Database;
let skip = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (error) { if (error.code === 'ERR_DLOPEN_FAILED') skip = "Electron ABI — run npm run test:native"; else throw error; }
let db;
let products;
let dashboard;
let search;
test.before(() => {
  if (skip) return;
  db = new Database(':memory:');
  db.exec(`CREATE TABLE products(id TEXT PRIMARY KEY, company_id TEXT, sku TEXT, name TEXT,
    brand_id TEXT, category_id TEXT, color_finish TEXT, barcode TEXT, status TEXT,
    process_status TEXT, price_retail REAL, price_wholesale REAL, prices TEXT, updated_at INTEGER);
    CREATE TABLE product_images(id TEXT, product_id TEXT, filepath TEXT, order_index INTEGER, is_processed INTEGER,
      processed_filepath TEXT, content_hash TEXT, workspace_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE brands(id TEXT, company_id TEXT, name TEXT);
    CREATE TABLE categories(id TEXT, company_id TEXT, name TEXT);
    CREATE TABLE catalog_projects(id TEXT, company_id TEXT, name TEXT, description TEXT, updated_at INTEGER);
    CREATE TABLE catalog_templates(id TEXT, company_id TEXT, name TEXT, description TEXT, updated_at INTEGER);`);
  const insert = db.prepare(`INSERT INTO products(id, company_id, sku, barcode, process_status, price_retail, price_wholesale, prices, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [
    ['none', null, null, null, null, '{}'],
    ['retail-zero', '  ', 'processed', 0, null, '{}'],
    ['wholesale-zero', 'ok', 'exported', null, 0, '{}'],
    ['group-zero', 'ok', 'exported', null, null, '{"vip":{"amount":0}}'],
    ['legacy-zero', 'ok', 'unprocessed', null, null, '{"vip":0}'],
    ['group-blank', '', 'unprocessed', null, null, '{"vip":{"amount":""}}'],
    ['columns-blank', 'ok', 'exported', '', '', '{}'],
    ['invalid-price', 'ok', 'unprocessed', null, null, '{"vip":{"amount":"invalid"}}'],
  ];
  rows.forEach(([id, ...values], index) => insert.run(id, 'active', `needle-${id}`, ...values, index));
  insert.run('foreign', 'other', 'needle-foreign', null, null, null, null, '{}', 10);
  db.prepare('INSERT INTO catalog_projects VALUES (?, ?, ?, ?, ?)').run('project', 'active', 'Needle catalog', 'Catalog detail', 1);
  db.prepare('INSERT INTO catalog_projects VALUES (?, ?, ?, ?, ?)').run('foreign-project', 'other', 'Needle foreign', null, 1);
  db.prepare('INSERT INTO catalog_templates VALUES (?, ?, ?, ?, ?)').run('template', 'active', 'Reusable layout', 'Needle design', 1);
  db.prepare('INSERT INTO catalog_templates VALUES (?, ?, ?, ?, ?)').run('foreign-template', 'other', 'Needle foreign', null, 1);
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './index' && /main\/db\/(products|dashboard|search)\.js$/.test(parent?.filename)) return { getDb: () => db, getDataDir: () => '' };
    return original.call(this, request, parent, isMain);
  };
  try { products = require('../main/db/products'); dashboard = require('../main/db/dashboard'); search = require('../main/db/search'); }
  finally { Module._load = original; }
});
test.after(() => db?.close());

test('attention queues match company completeness including zero and blank prices', { skip }, () => {
  const counts = dashboard.completenessFor('active');
  const expected = {
    missingBarcode: ['none', 'retail-zero', 'group-blank'],
    missingPrice: ['none', 'group-blank', 'columns-blank', 'invalid-price'],
    notExported: ['none', 'retail-zero', 'legacy-zero', 'group-blank', 'invalid-price'],
  };
  for (const [attentionFilter, ids] of Object.entries(expected)) {
    const list = products.list('active', { attentionFilter });
    assert.deepEqual(list.map((row) => row.id).sort(), ids.sort());
    assert.equal(list.length, counts[attentionFilter]);
    assert.ok(list.every((row) => row.companyId === 'active'));
  }
  assert.equal(counts.total, 8);
  assert.deepEqual(products.list('active', { attentionFilter: 'missingBarcode', search: 'group' }).map((row) => row.id), ['group-blank']);
});
test('catalog results are opt-in, scoped, saved IDs and discoverable among many product/brand hits', { skip }, () => {
  const brand = db.prepare('INSERT INTO brands VALUES (?, ?, ?)');
  for (let index = 0; index < 15; index += 1) brand.run(`brand-${index}`, 'active', `Needle brand ${index}`);
  assert.ok(!search.globalSearch('active', 'needle').some((row) => row.kind.startsWith('catalog')));
  const results = search.globalSearch('active', 'needle', 8, { includeCatalog: true });
  assert.ok(results.some((row) => row.kind === 'catalogProject' && row.id === 'project'));
  assert.ok(results.some((row) => row.kind === 'catalogTemplate' && row.id === 'template'));
  assert.ok(!results.some((row) => row.id.startsWith('foreign')));
  assert.ok(results.length <= 8);
  const template = search.globalSearch('active', 'reusable', 30, { includeCatalog: true });
  assert.deepEqual(template.map((row) => [row.kind, row.id]), [['catalogTemplate', 'template']]);
});
