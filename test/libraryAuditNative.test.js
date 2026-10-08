/* 0.1.94 Library audit — the search rule against a real SQLite database.
 * In-memory DB only.  ELECTRON_RUN_AS_NODE=1 electron --test test/libraryAuditNative.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
let Database;
let skip = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (error) { if (error.code === 'ERR_DLOPEN_FAILED') skip = 'Electron ABI — run npm run test:native'; else throw error; }
let db;
let products;
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
    CREATE TABLE categories(id TEXT, company_id TEXT, name TEXT);`);
  const insert = db.prepare(`INSERT INTO products(id, company_id, sku, name, color_finish, barcode, prices, updated_at)
    VALUES (?, 'co', ?, ?, ?, ?, '{}', ?)`);
  insert.run('m8101', 'AV-M8101', 'MACEPRO floor tile', 'Matte Blue', '8851234567890', 1);
  insert.run('m81', 'AV-M81', 'Wall tile', 'Gloss White', null, 2);
  insert.run('khmer', 'KH-1', 'ក្រ​ឡា ប្រផេះ', null, null, 3);       // stored with a zero-width space
  insert.run('nfd', 'EP-1', 'Épice blanche', null, null, 4);        // decomposed é
  insert.run('other-barcode', 'ZZ-9', 'Contains 885123 in its name', null, '9990001112223', 5);
  db.prepare("INSERT INTO products(id, company_id, sku, name, prices, updated_at) VALUES ('foreign', 'other', 'AV-M8101', 'x', '{}', 9)").run();
  db.prepare("INSERT INTO product_images(id, product_id, filepath, order_index, is_processed) VALUES ('i1', 'm8101', 'a/av-m8101-001.jpg', 0, 0)").run();
  db.prepare("INSERT INTO brands VALUES ('b1', 'co', 'MACEPRO Tiles')").run();
  db.prepare("INSERT INTO categories VALUES ('c1', 'co', 'ក្រ‌ឡា')").run();
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === './index' && /main\/db\/(products|search)\.js$/.test(parent?.filename)) return { getDb: () => db, getDataDir: () => '' };
    return original.call(this, request, parent, isMain);
  };
  try { products = require('../main/db/products'); search = require('../main/db/search'); }
  finally { Module._load = original; }
});
test.after(() => db?.close());

const ids = (rows) => rows.map((r) => r.id).sort();

test('Library search: words are ANDed in any order', { skip }, () => {
  assert.deepEqual(ids(products.list('co', { search: 'blue macepro' })), ['m8101']);
  assert.deepEqual(ids(products.list('co', { search: 'tile' })), ['m81', 'm8101']);
  assert.deepEqual(ids(products.list('co', { search: 'tile white' })), ['m81']);
  assert.deepEqual(products.list('co', { search: 'tile purple' }), []);
});

test('Library search: SKU separators are ignored and image counts still come back', { skip }, () => {
  const rows = products.list('co', { search: 'avm8101' });
  assert.deepEqual(ids(rows), ['m8101']);
  assert.equal(rows[0].imageCount, 1, 'the narrowed query still runs the image subqueries');
  assert.equal(rows[0].mainImagePath, 'a/av-m8101-001.jpg');
  assert.deepEqual(ids(products.list('co', { search: 'av m81' })), ['m81', 'm8101']);
});

test('Library search: an exact barcode finds its product; a fragment does not', { skip }, () => {
  assert.deepEqual(ids(products.list('co', { search: '8851234567890' })), ['m8101']);
  assert.deepEqual(ids(products.list('co', { search: '885123' })), ['other-barcode'], 'only the name that contains it');
});

test('Library search: Khmer and NFC', { skip }, () => {
  assert.deepEqual(ids(products.list('co', { search: 'ក្រឡា' })), ['khmer']);
  assert.deepEqual(ids(products.list('co', { search: 'Épice' })), ['nfd']);
});

test('Library search keeps the other filters and the company scope', { skip }, () => {
  assert.ok(products.list('co', { search: 'AV-M8101' }).every((r) => r.companyId === 'co'));
  assert.deepEqual(products.list('co', { search: 'AV-M8101', status: 'draft' }), []);
});

test('⌘K ranks an exact SKU first, then a SKU prefix, and tags an exact barcode', { skip }, () => {
  const hits = search.globalSearch('co', 'av-m81').filter((r) => r.kind === 'product');
  assert.deepEqual(hits.map((r) => r.id), ['m81', 'm8101'], 'exact SKU before a prefix match even though it is older');
  const barcode = search.globalSearch('co', '8851234567890').filter((r) => r.kind === 'product');
  assert.deepEqual(barcode.map((r) => [r.id, r.extra]), [['m8101', 'barcode']]);
  assert.equal(search.globalSearch('co', 'AV-M8101').find((r) => r.kind === 'product').extra, null);
});

test('⌘K brands and categories use the same word / zero-width rule', { skip }, () => {
  assert.deepEqual(search.globalSearch('co', 'tiles mace').filter((r) => r.kind === 'brand').map((r) => r.id), ['b1']);
  assert.deepEqual(search.globalSearch('co', 'ក្រឡា').filter((r) => r.kind === 'category').map((r) => r.id), ['c1']);
});
