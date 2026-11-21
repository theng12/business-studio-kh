const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
let skip = false;
try { new (require('better-sqlite3'))(':memory:').close(); }
catch (error) { if (error.code !== 'ERR_DLOPEN_FAILED') throw error; skip = 'Run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/productOrganizationConcurrency.test.js'; }
function fixture() {
  const db = require('../main/db'); const companies = require('../main/db/companies');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-po-concurrency-')); db.initDb(dataDir);
  const company = companies.create({ name: 'Organization fixture' }); companies.setActive(company.id);
  const handlers = new Map();
  const expose = (channel, fn) => handlers.set(channel, (args) => { require('../main/util/validateArgs').validateArgs(channel, args); return fn(args); });
  const registration = { expose, exposeLocal: expose, emitCatalogChange() {}, assertEntityInActiveCompany: (row) => row, assertProductInActiveCompany() {} };
  require('../main/ipc/catalog').register(registration);
  const filename = path.join(__dirname, '../main/ipc/images.js');
  const localRequire = require('node:module').createRequire(filename);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))((name) => name === 'electron' ? { ipcMain: { on() {} } } : localRequire(name), module, module.exports);
  module.exports.register(registration);
  return { db, dataDir, company, handlers, companies, products: require('../main/db/products'), images: require('../main/db/productImages'), categories: require('../main/db/categories') };
}
function cleanup(e) {
  e.db.closeDb(); const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'task-2-tests'); fs.mkdirSync(trash, { recursive: true }); fs.renameSync(e.dataDir, path.join(trash, path.basename(e.dataDir)));
}
for (const kind of ['companies', 'categories']) test(`${kind} stale snapshots conflict through shared IPC/RPC handler, overwrite remains explicit`, { skip }, async () => {
  const e = fixture();
  try {
    const original = kind === 'companies' ? e.company : e.categories.create({ companyId: e.company.id, name: 'Original' });
    const update = e.handlers.get(`${kind}:update`);
    const first = update({ id: original.id, patch: { name: 'Newer', expectedUpdatedAt: original.updatedAt } });
    assert.ok(first.updatedAt > original.updatedAt);
    assert.throws(() => update({ id: original.id, patch: { name: 'Stale', expectedUpdatedAt: original.updatedAt } }), /CONFLICT\|/);
    assert.equal(e[kind].get(original.id).name, 'Newer');
    const overwritten = update({ id: original.id, patch: { name: 'Deliberate overwrite' } });
    assert.ok(overwritten.updatedAt > first.updatedAt);
    assert.equal(overwritten.name, 'Deliberate overwrite');
  } finally { cleanup(e); }
});
test('deferred remove identity follows its row after reorder and refuses changed, missing or foreign rows', { skip }, async () => {
  const e = fixture();
  try {
    const product = e.products.create({ companyId: e.company.id, sku: 'PO-ID' });
    const sharp = require('sharp'); const rows = [];
    for (let n = 0; n < 2; n++) {
      const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: n ? '#ff0000' : '#0000ff' } }).jpeg().toBuffer();
      const { dir } = e.images.dirForProduct(product.id); const filename = `PO-ID-00${n + 1}.jpg`; const filepath = `${dir}/${filename}`;
      fs.mkdirSync(path.join(e.dataDir, 'assets', dir), { recursive: true }); fs.writeFileSync(path.join(e.dataDir, 'assets', filepath), bytes);
      rows.push(e.images.addRow(product.id, { filepath, filename, contentHash: crypto.createHash('sha1').update(bytes).digest('hex'), orderIndex: n }).image);
    }
    const confirmed = { productId: product.id, imageId: rows[0].id, expectedContentHash: rows[0].contentHash };
    e.images.reorder(product.id, rows.slice().reverse().map((r) => r.filepath));
    const remove = e.handlers.get('images:removeFromProduct');
    await assert.rejects(remove({ ...confirmed, expectedContentHash: 'old-bytes' }), /changed while/);
    await assert.rejects(remove({ ...confirmed, imageId: 'missing' }), /not on this product/);
    const other = e.products.create({ companyId: e.company.id, sku: 'OTHER' });
    await assert.rejects(remove({ ...confirmed, productId: other.id }), /not on this product/);
    assert.throws(() => remove({ productId: product.id, filepath: rows[0].filepath }), /imageId/);
    const result = await remove(confirmed);
    assert.deepEqual(result.map((r) => r.id), [rows[1].id]);
    const survivor = e.images.getById(product.id, rows[1].id);
    assert.equal(crypto.createHash('sha1').update(fs.readFileSync(path.join(e.dataDir, 'assets', survivor.filepath))).digest('hex'), rows[1].contentHash);
    assert.equal(require('../main/deletedItems').count(), 1);
  } finally { cleanup(e); }
});
