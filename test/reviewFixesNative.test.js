/* 2026-10-08 review fixes against a real SQLite database and real files.
 * ELECTRON_RUN_AS_NODE=1 electron --test test/reviewFixesNative.test.js
 * (part of `npm run test:native`; SKIPs under plain `npm test`). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

let skip = false;
try { new (require('better-sqlite3'))(':memory:').close(); }
catch (error) { if (error.code !== 'ERR_DLOPEN_FAILED') throw error; skip = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`"; }

function fixture() {
  const db = require('../main/db');
  const companies = require('../main/db/companies');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-review-fixes-'));
  db.initDb(dataDir);
  const company = companies.create({ name: 'Review fixture' });
  companies.setActive(company.id);
  const handlers = new Map();
  const expose = (channel, fn) => handlers.set(channel, (args) => { require('../main/util/validateArgs').validateArgs(channel, args); return fn(args); });
  const registration = { expose, exposeLocal: expose, emitCatalogChange() {}, assertEntityInActiveCompany: (row) => row, assertProductInActiveCompany() {} };
  const filename = path.join(__dirname, '../main/ipc/images.js');
  const localRequire = require('node:module').createRequire(filename);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))((name) => name === 'electron' ? { ipcMain: { on() {} } } : localRequire(name), module, module.exports);
  module.exports.register(registration);
  return {
    db, dataDir, company, handlers,
    products: require('../main/db/products'),
    images: require('../main/db/productImages'),
    deleted: require('../main/deletedItems'),
  };
}

async function jpeg(color) {
  return require('sharp')({ create: { width: 6, height: 6, channels: 3, background: color } }).jpeg().toBuffer();
}
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
async function dominant(e, rel) {
  const { channels } = await require('sharp')(path.join(e.dataDir, 'assets', rel)).stats();
  const means = channels.slice(0, 3).map((ch) => ch.mean);
  return 'rgb'[means.indexOf(Math.max(...means))];
}

test('#1 import with makeMain: the added photo is main even when a remove renumbers in between', { skip }, async () => {
  const e = fixture();
  try {
    const product = e.products.create({ companyId: e.company.id, sku: 'MM-1' });
    const [a, b, c] = [await jpeg('#ff0000'), await jpeg('#00ff00'), await jpeg('#0000ff')];
    const { image: rowA } = await e.images.addFromBytes(product.id, a, '.jpg');
    await e.images.addFromBytes(product.id, b, '.jpg');
    const importFromBytes = e.handlers.get('images:importFromBytes');
    const remove = e.handlers.get('images:removeFromProduct');
    // Both in flight together: the add+set-main is one turn of the lock.
    const [res] = await Promise.all([
      importFromBytes({ productId: product.id, bytes: c, ext: '.jpg', makeMain: true }),
      remove({ productId: product.id, imageId: rowA.id, expectedContentHash: rowA.contentHash }),
    ]);
    assert.equal(res.madeMain, true);
    const list = e.images.listByProduct(product.id);
    assert.equal(list.length, 2);
    assert.equal(list[0].contentHash, sha1(c), 'the imported photo is main');
    // The importer re-encodes (the row keeps the SOURCE hash for dedup), so
    // check the pixels: the main slot on disk must be the blue photo.
    assert.equal(await dominant(e, list[0].filepath), 'b', 'and the main slot on disk holds its picture');
    assert.equal(await dominant(e, list[1].filepath), 'g');
    assert.equal(list[1].contentHash, sha1(b));
    // Without makeMain an import appends.
    const d = await jpeg('#ffff00');
    const plain = await importFromBytes({ productId: product.id, bytes: d, ext: '.jpg' });
    assert.equal(plain.madeMain, false);
    assert.equal(e.images.listByProduct(product.id).at(-1).contentHash, sha1(d));
    assert.throws(() => importFromBytes({ productId: product.id, bytes: d, ext: '.jpg', makeMain: 'yes' }), /makeMain/);
  } finally { e.db.closeDb(); }
});

test('#2 photo remove returns its bin entry, and restoring that id brings back THAT photo', { skip }, async () => {
  const e = fixture();
  try {
    const product = e.products.create({ companyId: e.company.id, sku: 'UNDO-1' });
    const bytes = [await jpeg('#111111'), await jpeg('#888888'), await jpeg('#eeeeee')];
    const rows = [];
    for (const b of bytes) rows.push((await e.images.addFromBytes(product.id, b, '.jpg')).image);
    const remove = e.handlers.get('images:removeFromProduct');
    const legacy = await remove({ productId: product.id, imageId: rows[2].id });
    assert.ok(Array.isArray(legacy), 'without withEntry the reply is still the photo list');
    const first = await remove({ productId: product.id, imageId: rows[0].id, withEntry: true });
    assert.ok(Array.isArray(first.images));
    assert.equal(typeof first.deletedEntryId, 'string');
    // A later removal is now the NEWEST bin entry for this product …
    const second = await remove({ productId: product.id, imageId: rows[1].id, withEntry: true });
    assert.notEqual(second.deletedEntryId, first.deletedEntryId);
    // … but Undo of the first toast restores exactly the first photo.
    e.deleted.restore(first.deletedEntryId);
    const hashes = e.images.listByProduct(product.id).map((r) => r.contentHash);
    assert.deepEqual(hashes, [sha1(bytes[0])]);
  } finally { e.db.closeDb(); }
});

test('#2 product removes report their bin entries', { skip }, () => {
  const e = fixture();
  try {
    const one = e.products.create({ companyId: e.company.id, sku: 'DEL-1' });
    const r = e.products.removeDetailed(one.id);
    assert.equal(r.deleted, true);
    assert.equal(e.deleted.get(r.deletedEntryId).kind, 'product');
    const two = e.products.create({ companyId: e.company.id, sku: 'DEL-2' });
    const three = e.products.create({ companyId: e.company.id, sku: 'DEL-3' });
    const bulk = e.products.bulkRemove([two.id, three.id]);
    assert.equal(bulk.deleted, 2);
    assert.equal(bulk.deletedEntryIds.length, 2);
    e.deleted.restore(bulk.deletedEntryIds[0]);
    assert.ok(e.products.get(two.id), 'the first id is the first product');
    assert.equal(e.products.remove(three.id), false, 'remove() still returns a boolean');
  } finally { e.db.closeDb(); }
});

test('#3 bulk upsert: a cleared group goes, a currency-less amount stays currency-less, stale rows are skipped', { skip }, () => {
  const e = fixture();
  try {
    const p = e.products.create({ companyId: e.company.id, sku: 'PR-1', prices: { khr: { amount: 41000, currency: 'KHR' }, vip: 8 } });
    const fresh = e.products.get(p.id);
    const res = e.products.bulkUpsert(e.company.id, [
      { sku: 'PR-1', prices: { khr: { amount: null, currency: null }, vip: { amount: 9 } }, expectedUpdatedAt: fresh.updatedAt },
    ], { conflictPolicy: 'overwrite' });
    assert.equal(res.updated, 1);
    const after = e.products.get(p.id);
    assert.equal('khr' in after.prices, false, 'clear removes the group');
    assert.deepEqual(after.prices.vip, { amount: 9 }, 'no currency invented');

    // Stale token: skipped as a conflict, nothing written.
    const stale = e.products.bulkUpsert(e.company.id, [
      { sku: 'PR-1', priceRetail: 99, expectedUpdatedAt: fresh.updatedAt - 1 },
    ], { conflictPolicy: 'overwrite' });
    assert.equal(stale.updated, 0);
    assert.equal(stale.skips[0].category, 'conflict');
    assert.notEqual(e.products.get(p.id).priceRetail, 99);
    // Dry run reports the same, so the modal refuses before writing.
    const dry = e.products.bulkUpsert(e.company.id, [{ sku: 'PR-1', priceRetail: 99, expectedUpdatedAt: 1 }], { conflictPolicy: 'overwrite', dryRun: true });
    assert.equal(dry.changes[0].action, 'skip');
    // A token never creates a product.
    const ghost = e.products.bulkUpsert(e.company.id, [{ sku: 'NOPE', priceRetail: 5, expectedUpdatedAt: 1 }], { conflictPolicy: 'overwrite' });
    assert.equal(e.products.getBySku(e.company.id, 'NOPE'), null);
    assert.equal(ghost.skips[0].category, 'conflict');
  } finally { e.db.closeDb(); }
});

test('#9 ⌘K supplier / PO search treats % and _ literally', { skip }, () => {
  const e = fixture();
  try {
    const suppliers = require('../main/db/suppliers');
    suppliers.create({ companyId: e.company.id, name: '100% Cotton' });
    suppliers.create({ companyId: e.company.id, name: '1000 Cotton' });
    suppliers.create({ companyId: e.company.id, name: 'a_b Trading' });
    suppliers.create({ companyId: e.company.id, name: 'axb Trading' });
    const { globalSearch } = require('../main/db/search');
    const names = (q) => globalSearch(e.company.id, q, 30, { includeCosting: true }).filter((r) => r.kind === 'supplier').map((r) => r.label).sort();
    assert.deepEqual(names('100%'), ['100% Cotton']);
    assert.deepEqual(names('a_b'), ['a_b Trading']);
    assert.deepEqual(names('cotton'), ['100% Cotton', '1000 Cotton'], 'case-insensitive as before');
    assert.deepEqual(names('Cot⁠ton'), ['100% Cotton', '1000 Cotton'], 'invisible characters ignored');
  } finally { e.db.closeDb(); }
});
