/**
 * Main-process database hot paths, against real SQLite through the real
 * modules.
 *
 *   - the connection tuning pragmas and the two lookup indexes exist after
 *     initDb, and the queries they were added for actually use them;
 *   - the Dashboard's company-scoped queries return exactly what the old
 *     whole-table GROUP BY forms returned;
 *   - brands.get keeps working across a data-folder switch (its statement is
 *     cached per connection);
 *   - label run items land in one batch; bulk product updates keep their
 *     per-row outcome inside one transaction.
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

let db = null;
let companies = null;
let products = null;
let brands = null;
let dashboard = null;
let labelRuns = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
  brands = require('../main/db/brands');
  dashboard = require('../main/db/dashboard');
  labelRuns = require('../main/db/labelRuns');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function freshDb() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-mainperf-db-'));
  db.initDb(dataDir);
  return dataDir;
}

let imageSeq = 0;
function addImage(productId, filepath, orderIndex) {
  imageSeq += 1;
  db.getDb().prepare(`INSERT INTO product_images (id, product_id, filename, filepath, order_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(`img-${imageSeq}`, productId, path.basename(filepath), filepath, orderIndex, Date.now());
}

/** Two companies, so a query that ignores the company shows up. */
function seedCatalog() {
  freshDb();
  const a = companies.create({ name: 'Alpha', isActive: true });
  const b = companies.create({ name: 'Beta', isActive: true });
  companies.setActive(a.id);
  const made = { a: [], b: [] };
  for (const [key, company] of [['a', a], ['b', b]]) {
    for (let i = 0; i < 14; i += 1) {
      const p = products.create({
        companyId: company.id, sku: `${key.toUpperCase()}-${i}`, name: `${key} product ${i}`,
        barcode: i % 3 === 0 ? null : `88${i}`, priceRetail: i % 4 === 0 ? null : 10 + i,
      });
      // Distinct, deterministic recency so ORDER BY updated_at has no ties.
      db.getDb().prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(1_000_000 + i * 1000 + (key === 'b' ? 7 : 0), p.id);
      for (let n = 0; n < i % 4; n += 1) addImage(p.id, `${company.name}/_/${p.sku}/${p.sku}-${n}.jpg`, n);
      made[key].push(p);
    }
  }
  return { a, b, made };
}

test('initDb sets the tuning pragmas and leaves synchronous at its default', { skip: skipReason }, () => {
  const dataDir = freshDb();
  const conn = db.getDb();
  assert.equal(conn.pragma('temp_store', { simple: true }), 2, 'temp_store = MEMORY');
  assert.equal(conn.pragma('cache_size', { simple: true }), -32000);
  // Whatever an untouched connection in the same journal mode reports.
  const Database = require('better-sqlite3');
  const plain = new Database(path.join(dataDir, 'database.sqlite'));
  try {
    plain.pragma('journal_mode = WAL');
    assert.equal(conn.pragma('synchronous', { simple: true }), plain.pragma('synchronous', { simple: true }),
      'synchronous is not changed by initDb');
  } finally {
    plain.close();
  }
  assert.equal(db.SCHEMA_VERSION, 2, 'indexes are additive — no schema bump');
});

test('the filepath and company/recency indexes exist and the target queries use them', { skip: skipReason }, () => {
  freshDb();
  const conn = db.getDb();
  const names = (table) => conn.prepare(`PRAGMA index_list(${table})`).all().map((r) => r.name);
  assert.ok(names('product_images').includes('idx_product_images_filepath'));
  assert.ok(names('products').includes('idx_products_company_updated'));

  const plan = (sql, ...args) => conn.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');

  // productImages.countByFilepath — the duplicate-merge check.
  assert.match(plan('SELECT COUNT(*) AS n FROM product_images WHERE filepath = ?', 'x'), /idx_product_images_filepath/);

  // The Library list's sort and the Dashboard's "8 most recent".
  const recent = plan(`SELECT p.id FROM products p WHERE p.company_id = ? ORDER BY p.updated_at DESC LIMIT 8`, 'c');
  assert.match(recent, /idx_products_company_updated/);
  assert.doesNotMatch(recent, /TEMP B-TREE/, 'the sort is served by the index');
});

/* The forms these replaced, verbatim, as the oracle. */
const OLD_RECENT = `SELECT p.id, p.sku, p.name, p.updated_at,
     COALESCE(ic.cnt, 0)   AS image_count,
     mi.filepath           AS main_image_path
   FROM products p
   LEFT JOIN (SELECT product_id, COUNT(*) AS cnt FROM product_images GROUP BY product_id) ic ON ic.product_id = p.id
   LEFT JOIN product_images mi ON mi.product_id = p.id AND mi.order_index = 0
   WHERE p.company_id = ?
   ORDER BY p.updated_at DESC
   LIMIT ?`;
const OLD_COMPLETENESS = `SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN COALESCE(ic.n, 0) = 0 THEN 1 ELSE 0 END) AS missingImages,
    SUM(CASE WHEN p.barcode IS NULL OR TRIM(p.barcode) = '' THEN 1 ELSE 0 END) AS missingBarcode,
    SUM(CASE WHEN p.price_retail IS NULL THEN 1 ELSE 0 END) AS missingPrice,
    SUM(CASE WHEN p.process_status IS NULL OR p.process_status <> 'exported' THEN 1 ELSE 0 END) AS notExported
  FROM products p
  LEFT JOIN (SELECT product_id, COUNT(*) AS n FROM product_images GROUP BY product_id) ic ON ic.product_id = p.id
  WHERE p.company_id = ?`;

test('Dashboard recentProducts and completenessFor match the old whole-table queries', { skip: skipReason }, () => {
  const { a, b } = seedCatalog();
  for (const company of [a, b]) {
    for (const limit of [8, 3, 50]) {
      const expected = db.getDb().prepare(OLD_RECENT).all(company.id, limit).map((r) => ({
        id: r.id, sku: r.sku, name: r.name, updatedAt: r.updated_at,
        imageCount: r.image_count ?? 0, mainImagePath: r.main_image_path ?? null,
      }));
      assert.deepEqual(dashboard.recentProducts(company.id, limit), expected, `recentProducts(${company.name}, ${limit})`);
    }
    const old = db.getDb().prepare(OLD_COMPLETENESS).get(company.id);
    assert.deepEqual(dashboard.completenessFor(company.id), {
      total: Number(old.total), missingImages: Number(old.missingImages), missingBarcode: Number(old.missingBarcode),
      missingPrice: Number(old.missingPrice), notExported: Number(old.notExported),
    });
  }
  const recent = dashboard.recentProducts(a.id);
  assert.equal(recent.length, 8);
  assert.ok(recent.every((r) => r.sku.startsWith('A-')), 'only the asked-for company');
  assert.ok(recent.some((r) => r.imageCount > 0 && r.mainImagePath), 'fixture exercises the image lookups');
  assert.ok(dashboard.completenessFor(a.id).missingImages > 0, 'fixture exercises the no-images branch');
  assert.deepEqual(dashboard.completenessFor('no-such-company'),
    { total: 0, missingImages: 0, missingBarcode: 0, missingPrice: 0, notExported: 0 });
});

test('brands.get keeps working when the data folder switches to a new connection', { skip: skipReason }, () => {
  freshDb();
  const c1 = companies.create({ name: 'One', isActive: true });
  const b1 = brands.create({ companyId: c1.id, name: 'Royal' });
  assert.equal(brands.get(b1.id).name, 'Royal');
  assert.equal(brands.get(b1.id).productCount, 0);
  products.create({ companyId: c1.id, sku: 'R-1', brandId: b1.id });
  assert.equal(brands.get(b1.id).productCount, 1, 'the cached statement still re-reads the count');

  db.closeDb();
  freshDb();
  assert.equal(brands.get(b1.id), null, 'the new folder has no such brand — and no stale statement throws');
  const c2 = companies.create({ name: 'Two', isActive: true });
  const b2 = brands.create({ companyId: c2.id, name: 'Other' });
  assert.equal(brands.get(b2.id).name, 'Other');
});

test('label run items are written as one batch', { skip: skipReason }, () => {
  freshDb();
  const c = companies.create({ name: 'Labels Co', isActive: true });
  const [p1, p2, p3] = ['A', 'B', 'C'].map((sku) => products.create({ companyId: c.id, sku }));
  const run = labelRuns.create({ companyId: c.id, templateName: 'T', format: 'png', productCount: 3 });
  const ids = labelRuns.addItems(run.id, [
    { productId: p1.id, sku: 'A', filePath: '/x/a.png' },
    { productId: p2.id, sku: 'B', filePath: '/x/b.png' },
    { productId: p3.id, sku: 'C', filePath: '/x/c.png', productSnapshot: { name: 'C' } },
  ]);
  assert.equal(ids.length, 3);
  const rows = db.getDb().prepare('SELECT sku, file_path, product_snapshot FROM label_generation_items WHERE run_id = ? ORDER BY sku').all(run.id);
  assert.deepEqual(rows.map((r) => r.sku), ['A', 'B', 'C']);
  assert.equal(JSON.parse(rows[2].product_snapshot).name, 'C');
  assert.deepEqual(labelRuns.addItems(run.id, []), []);

  // All or nothing: a bad item leaves none of the batch behind.
  const run2 = labelRuns.create({ companyId: c.id, templateName: 'T', format: 'png', productCount: 2 });
  assert.throws(() => labelRuns.addItems(run2.id, [
    { productId: p1.id, sku: 'A' }, { productId: 'no-such-product', sku: 'X' },
  ]), /FOREIGN KEY/);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM label_generation_items WHERE run_id = ?').get(run2.id).n, 0);
});

test('products:bulkUpdate reports each row as before, inside one transaction', { skip: skipReason }, () => {
  const { a, b, made } = seedCatalog();
  const handlers = new Map();
  const events = [];
  require('../main/ipc/products').register({
    expose: (name, handler) => handlers.set(name, handler),
    emitCatalogChange: (...args) => events.push(args),
    assertEntityInActiveCompany: (row) => row,
  });
  const bulkUpdate = handlers.get('products:bulkUpdate');

  // Count the transactions that COMMIT (top level) — a nested one is a
  // savepoint inside the batch's. Without the outer transaction each
  // update() would commit on its own: one per updated row.
  const conn = db.getDb();
  const original = conn.transaction.bind(conn);
  let commits = 0;
  conn.transaction = (fn) => {
    const run = original(fn);
    return (...args) => { if (!conn.inTransaction) commits += 1; return run(...args); };
  };
  let result;
  try {
    result = bulkUpdate({
      ids: [made.a[0].id, 'missing-id', made.b[0].id, made.a[1].id],
      patch: { status: 'inactive', sku: 'NOT-ALLOWED' },
    });
  } finally {
    conn.transaction = original;
  }

  assert.equal(result.updated, 2);
  assert.deepEqual(result.failed.map((f) => f.error), ['Product not found', 'Cross-company']);
  assert.equal(products.get(made.a[0].id).status, 'inactive');
  assert.equal(products.get(made.a[1].id).status, 'inactive');
  assert.equal(products.get(made.a[0].id).sku, 'A-0', 'SKU stays outside the bulk allow-list');
  assert.equal(products.get(made.b[0].id).status, 'active', 'the other company is untouched');
  assert.equal(commits, 1, 'one commit for the batch, not one per row');
  assert.equal(events.length, 1, 'one catalog event for the batch');
  assert.ok(a && b);
});
