const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

let Database; let skipReason = false;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (err) {
  if (err.code !== 'ERR_DLOPEN_FAILED') throw err;
  skipReason = "Run with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/aiGalleryOwnership.test.js";
}
function load(relative, stubs) {
  const sandbox = { require: (name) => name in stubs ? stubs[name] : require(name), module: { exports: {} }, Buffer, Date, process };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), sandbox);
  return sandbox.module.exports;
}

test('local and RPC gallery promotion authorize source before any product/file side effect', { skip: skipReason }, async () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ai_gallery (id TEXT PRIMARY KEY, task_id TEXT, product_id TEXT, company_id TEXT, filepath TEXT, prompt TEXT, provider TEXT, model TEXT, is_favorite INTEGER, promoted_to_product INTEGER, created_at INTEGER)`);
    const gallery = load('main/db/aiGallery.js', { './index': { getDb: () => db }, 'node:crypto': crypto });
    const local = new Map(); const rpc = new Map(); const sideEffects = [];
    const companies = { getActiveId: () => 'company-a' };
    const products = {
      get: (id) => ({ id, companyId: 'company-a' }),
      create: () => { sideEffects.push('create'); return { id: 'new-product', companyId: 'company-a' }; },
      recomputeProcessStatus: () => {}, touchUpdated: () => {},
    };
    const helpers = load('main/ipc/helpers.js', {
      electron: { ipcMain: { handle: (channel, fn) => local.set(channel, (args) => fn(null, args)) } },
      '../events': { broadcast: () => {} },
      '../util/validateArgs': require('../main/util/validateArgs'),
      '../util/maintenanceLifecycle': { runTrackedOperation: (_channel, fn) => fn() },
      '../server': { registerHandler: (channel, fn) => rpc.set(channel, fn) },
      '../db/companies': companies, '../db/products': products,
    });
    const ipc = load('main/ipc/ai.js', {
      'node:fs': { promises: { readFile: () => { sideEffects.push('read'); throw new Error('unexpected file read'); } } },
      '../config': {}, '../util/softFailure': {}, '../util/fileTrash': {},
      '../db/companies': companies, '../db/products': products,
      '../db/productImages': { listByProduct: () => [], addFromSource: async () => { sideEffects.push('import'); return { image: { id: 'image', filepath: 'image.png' } }; } },
      '../db/aiTasks': {}, '../db/aiPrompts': {}, '../db/aiGallery': gallery,
      '../ai/models': {}, '../ai/costs': {}, '../ai/providers/openai': {}, '../ai/queueRunner': {},
      '../imageManager': { MAX_IMAGES_PER_PRODUCT: 50 }, '../db': { getDataDir: () => '/synthetic-data' },
      '../util/fileKinds': require('../main/util/fileKinds'),
    });
    ipc.register(helpers);
    const foreign = gallery.create({ companyId: 'company-b', filepath: 'ai-gallery/foreign.png', provider: 'openai', model: 'gpt-image-2' });
    for (const routes of [local, rpc]) {
      const promote = routes.get('ai:promoteGalleryToProduct');
      for (const dest of [{ targetProductId: 'product-a' }, { newProduct: { sku: 'NEW' } }]) {
        const before = sideEffects.length;
        await assert.rejects(promote({ galleryId: foreign.id, ...dest }), /different company|Cross-company/);
        assert.equal(sideEffects.length, before);
        assert.equal(gallery.get(foreign.id).productId, null);
        assert.equal(gallery.get(foreign.id).promotedToProduct, false);
      }
      for (const productId of [null, 'product-a']) {
        const own = gallery.create({ companyId: 'company-a', productId, filepath: 'ai-gallery/own.png', provider: 'openai', model: 'gpt-image-2' });
        await promote({ galleryId: own.id, targetProductId: 'product-a' });
        assert.equal(gallery.get(own.id).productId, 'product-a');
        assert.equal(gallery.get(own.id).promotedToProduct, true);
      }
    }
    assert.deepEqual(sideEffects, ['import', 'import', 'import', 'import']);
  } finally { db.close(); }
});
