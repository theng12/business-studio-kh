const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

let Database; let skipReason = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (err) {
  if (err.code !== 'ERR_DLOPEN_FAILED') throw err;
  skipReason = 'Run with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/aiProductImageCap.test.js';
}
function load(relative, stubs) {
  const filename = path.join(__dirname, '..', relative); const localRequire = createRequire(filename);
  const sandbox = { require: (name) => name in stubs ? stubs[name] : localRequire(name), module: { exports: {} }, Buffer, Date, process };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
  return sandbox.module.exports;
}

test('the existing product lock enforces cap before writing, and at-cap identical imports still deduplicate', { skip: skipReason }, async () => {
  const db = new Database(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-ai-cap-'));
  try {
    const schema = fs.readFileSync(path.join(__dirname, '../main/db/index.js'), 'utf8');
    const table = schema.match(/CREATE TABLE IF NOT EXISTS product_images \([\s\S]*?\n {4}\);/);
    assert.ok(table);
    db.exec("CREATE TABLE products (id TEXT PRIMARY KEY); INSERT INTO products VALUES ('product')");
    db.exec(table[0]);
    for (const migration of schema.matchAll(/addColumnIfMissing\(db, 'product_images', '([^']+)', '([^']+)'\)/g)) {
      if (!db.prepare('PRAGMA table_info(product_images)').all().some((col) => col.name === migration[1])) {
        db.exec(`ALTER TABLE product_images ADD COLUMN ${migration[1]} ${migration[2]}`);
      }
    }
    const bridge = { getDb: () => db, getDataDir: () => root };
    const imageManager = load('main/imageManager.js', { './db': bridge });
    const productImages = load('main/db/productImages.js', {
      './index': bridge,
      './products': { get: () => ({ id: 'product', sku: 'CAP', companyId: 'company' }) },
      './companies': { get: () => ({ id: 'company', name: 'Cap fixture' }) },
      './brands': { get: () => null }, '../imageManager': imageManager,
      '../util/fileTrash': { trashPathInBackground: () => { throw new Error('unexpected trash'); } },
    });
    const sharp = require('sharp');
    const png = (color) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();
    const red = await png('#ff0000'); const blue = await png('#0000ff'); const green = await png('#00ff00');
    const source = path.join(root, 'red.png'); fs.writeFileSync(source, red);
    const first = await productImages.addFromSource('product', source);
    for (let i = 1; i < imageManager.MAX_IMAGES_PER_PRODUCT - 1; i += 1) {
      productImages.addRow('product', { filepath: `placeholder-${i}.png`, filename: `placeholder-${i}.png`, contentHash: `hash-${i}`, orderIndex: i });
    }
    const results = await Promise.allSettled([
      productImages.addFromBytes('product', blue, '.png'),
      productImages.addFromBytes('product', green, '.png'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /Image cap reached \(50\)/);
    assert.equal(productImages.listByProduct('product').length, 50);
    const { dir } = productImages.dirForProduct('product');
    const folder = path.join(root, 'assets', dir);
    const beforeFiles = fs.readdirSync(folder).sort();
    const beforeHash = crypto.createHash('sha1').update(fs.readFileSync(path.join(root, 'assets', first.image.filepath))).digest('hex');
    for (const duplicate of [() => productImages.addFromSource('product', source), () => productImages.addFromBytes('product', red, '.png')]) {
      const reused = await duplicate(); assert.equal(reused.skipped, true); assert.equal(reused.image.id, first.image.id);
    }
    await assert.rejects(productImages.addFromBytes('product', green, '.png'), /Image cap reached/);
    assert.equal(productImages.listByProduct('product').length, 50);
    assert.deepEqual(fs.readdirSync(folder).sort(), beforeFiles);
    assert.equal(crypto.createHash('sha1').update(fs.readFileSync(path.join(root, 'assets', first.image.filepath))).digest('hex'), beforeHash);
  } finally {
    db.close();
    // Project policy preserves discarded fixture files rather than erasing them.
    const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'ai-cap-fixtures'); fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(root, path.join(trash, path.basename(root)));
  }
});
