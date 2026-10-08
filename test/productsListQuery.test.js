/**
 * Native measurement for products.list(). The old grouped form aggregated
 * every product_images row before applying company_id; the indexed correlated
 * form should touch only images belonging to the selected company.
 *
 * Plain Node skips these cases when better-sqlite3 is built for Electron:
 *   ELECTRON_RUN_AS_NODE=1 electron --test test/productsListQuery.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const Module = require('node:module');

let Database;
let skipReason = false;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`";
  } else {
    throw err;
  }
}

let db;
let products;
let activeCompany = 'company-active';

function escapeSearch(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function buildQuery(kind, filters = {}) {
  const params = [activeCompany];
  let where = 'WHERE p.company_id = ?';
  const addIds = (column, values) => {
    if (!Array.isArray(values) || values.length === 0) return;
    const hasNull = values.some((value) => value === null);
    const ids = values.filter((value) => value != null && value !== '');
    const parts = [];
    if (ids.length) {
      parts.push(`p.${column} IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
    if (hasNull) parts.push(`p.${column} IS NULL`);
    if (parts.length) where += ` AND (${parts.join(' OR ')})`;
  };
  addIds('brand_id', filters.brandIds);
  addIds('category_id', filters.categoryIds);
  if (filters.status) { where += ' AND p.status = ?'; params.push(filters.status); }
  if (filters.processStatus) { where += ' AND p.process_status = ?'; params.push(filters.processStatus); }
  const search = typeof filters.search === 'string' ? filters.search.trim() : '';
  if (search) {
    const term = `%${escapeSearch(search)}%`;
    where += " AND (p.sku LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.color_finish LIKE ? ESCAPE '\\')";
    params.push(term, term, term);
  }

  const columns = kind === 'grouped'
    ? `COALESCE(ic.image_count, 0) AS image_count,
       COALESCE(ic.processed_image_count, 0) AS processed_image_count,
       mi.filepath AS main_image_path`
    : `(SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
       (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
       (SELECT pi.filepath FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path`;
  const joins = kind === 'grouped'
    ? `LEFT JOIN (
         SELECT product_id, COUNT(*) AS image_count,
                SUM(CASE WHEN is_processed = 1 THEN 1 ELSE 0 END) AS processed_image_count
           FROM product_images GROUP BY product_id
       ) ic ON ic.product_id = p.id
       LEFT JOIN (
         SELECT product_id, filepath FROM (
           SELECT product_id, filepath,
                  ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY order_index ASC) AS rn
             FROM product_images
         ) WHERE rn = 1
       ) mi ON mi.product_id = p.id`
    : '';
  return {
    sql: `SELECT p.*, ${columns} FROM products p ${joins} ${where} ORDER BY p.updated_at DESC`,
    params,
  };
}

function populate() {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, sku TEXT NOT NULL,
      name TEXT, brand_id TEXT, category_id TEXT, color_finish TEXT,
      status TEXT, process_status TEXT, updated_at INTEGER
    );
    CREATE INDEX idx_products_company ON products(company_id);
    CREATE INDEX idx_products_updated_at ON products(updated_at);
    CREATE TABLE product_images (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, filename TEXT NOT NULL,
      filepath TEXT NOT NULL, order_index INTEGER NOT NULL, is_processed INTEGER NOT NULL,
      processed_filepath TEXT, content_hash TEXT, workspace_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_pi_product ON product_images(product_id);
    CREATE INDEX idx_pi_order ON product_images(product_id, order_index);
  `);
  const product = db.prepare(`INSERT INTO products
    (id, company_id, sku, name, brand_id, category_id, color_finish, status, process_status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const image = db.prepare(`INSERT INTO product_images
    (id, product_id, filename, filepath, order_index, is_processed)
    VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const [companyId, count, prefix, baseTime] of [
      [activeCompany, 1800, 'A', 200000],
      ['company-unrelated', 18000, 'U', 100000],
    ]) {
      for (let i = 0; i < count; i += 1) {
        const id = `${prefix.toLowerCase()}-${i}`;
        product.run(
          id, companyId, `${prefix}-${i}`, `${prefix === 'A' ? 'Active' : 'Unrelated'} ${i}`,
          i % 7 === 0 ? 'brand-1' : null,
          i % 5 === 0 ? 'cat-1' : null,
          i % 3 === 0 ? 'blue' : 'red',
          i % 4 === 0 ? 'archived' : 'active',
          i % 6 === 0 ? 'processed' : 'unprocessed',
          baseTime + i,
        );
        for (let order = 0; order < 3; order += 1) {
          image.run(`${id}-image-${order}`, id, `${id}-${order}.jpg`, `assets/${id}/${order}.jpg`, order, order === 1 ? 1 : 0);
        }
      }
    }
  })();
}

function medianMs(statement, params) {
  for (let i = 0; i < 2; i += 1) statement.all(...params);
  const samples = [];
  for (let i = 0; i < 9; i += 1) {
    const start = performance.now();
    statement.all(...params);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

test.before(() => {
  if (skipReason) return;
  populate();
  const originalLoad = Module._load;
  const productsPath = require.resolve('../main/db/products');
  Module._load = function(request, parent, isMain) {
    if (request === './index' && parent?.filename === productsPath) {
      return { getDb: () => db, getDataDir: () => '' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  products = require('../main/db/products');
  Module._load = originalLoad;
});

test.after(() => {
  db?.close();
});

test('correlated and grouped queries have identical complete rows and filters', { skip: skipReason }, () => {
  for (const filters of [
    {},
    { status: 'active' },
    { processStatus: 'processed' },
    { brandIds: ['brand-1', null], categoryIds: ['cat-1'], search: 'A-1_%' },
  ]) {
    const grouped = buildQuery('grouped', filters);
    const correlated = buildQuery('correlated', filters);
    assert.deepEqual(
      db.prepare(correlated.sql).all(...correlated.params),
      db.prepare(grouped.sql).all(...grouped.params),
      `query output differs for ${JSON.stringify(filters)}`,
    );
    const actual = products.list(activeCompany, filters);
    const expected = db.prepare(correlated.sql).all(...correlated.params);
    assert.deepEqual(
      actual.map((row) => ({
        id: row.id,
        imageCount: row.imageCount,
        processedImageCount: row.processedImageCount,
        mainImagePath: row.mainImagePath,
      })),
      expected.map((row) => ({
        id: row.id,
        imageCount: Number(row.image_count),
        processedImageCount: Number(row.processed_image_count),
        mainImagePath: row.main_image_path,
      })),
      `production list output differs for ${JSON.stringify(filters)}`,
    );
  }
});

test('indexed correlated list query beats global grouped aggregation', { skip: skipReason }, () => {
  const grouped = buildQuery('grouped');
  const correlated = buildQuery('correlated');
  const groupedStmt = db.prepare(grouped.sql);
  const correlatedStmt = db.prepare(correlated.sql);
  const groupedMedian = medianMs(groupedStmt, grouped.params);
  const correlatedMedian = medianMs(correlatedStmt, correlated.params);
  const groupedPlan = db.prepare(`EXPLAIN QUERY PLAN ${grouped.sql}`).all(...grouped.params).map((row) => row.detail).join(' | ');
  const correlatedPlan = db.prepare(`EXPLAIN QUERY PLAN ${correlated.sql}`).all(...correlated.params).map((row) => row.detail).join(' | ');
  assert.match(correlatedPlan, /idx_pi_order|product_id/);
  assert.match(groupedPlan, /SCAN product_images/);
  process.stdout.write(`products.list benchmark: correlated median ${correlatedMedian.toFixed(2)}ms; grouped median ${groupedMedian.toFixed(2)}ms\n`);
  process.stdout.write(`correlated plan: ${correlatedPlan}\ngrouped plan: ${groupedPlan}\n`);
});
