const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let db;
let skip = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db');
} catch (error) {
  if (error.code !== 'ERR_DLOPEN_FAILED') throw error;
  skip = 'Electron ABI required: run npm run test:native';
}

test('native export completion preserves missing/partial/Skip/cancelled statuses and advances complete writes', { skip }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-completion-native-'));
  try {
    const data = path.join(root, 'data');
    db.initDb(data);
    const companies = require('../main/db/companies');
    const products = require('../main/db/products');
    const images = require('../main/db/productImages');
    const sharp = require('sharp');
    const { runExport } = require('../main/exportRunner');
    const company = companies.create({ name: 'Completion fixture' });
    companies.setActive(company.id);
    const profile = { width: 8, height: 8, format: 'png', namingPattern: '{SKU}-{INDEX}' };
    async function product(sku, files) {
      const p = products.create({ companyId: company.id, sku, name: sku });
      for (let i = 0; i < files.length; i++) {
        const rel = `${sku}/${i}.png`;
        if (files[i] !== 'missing') {
          const abs = path.join(data, 'assets', rel);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          if (files[i] === 'bad') await fsp.writeFile(abs, 'invalid-image');
          else await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c66' } }).png().toFile(abs);
        }
        images.addRow(p.id, { filepath: rel, filename: `${i}.png`, orderIndex: i, contentHash: `${sku}-${i}` });
        images.setProcessed(p.id, rel, { isProcessed: true });
      }
      products.setProcessStatus(p.id, 'done');
      return p;
    }
    const missing = await product('Missing', ['missing']);
    const failed = await product('Failed', ['bad']);
    const partial = await product('Partial', ['good', 'missing']);
    const cancelled = await product('Cancelled', ['good', 'good']);
    const complete = await product('Complete', ['good', 'good']);
    for (const p of [missing, failed, partial]) {
      await runExport({ profile, productIds: [p.id], outputRoot: path.join(root, p.sku) });
      assert.equal(products.get(p.id).processStatus, 'done', p.sku);
    }
    let wrote = false;
    await runExport({ profile, productIds: [cancelled.id], outputRoot: path.join(root, 'cancelled'), isCancelled: () => wrote, onProgress: () => { wrote = true; } });
    assert.equal(products.get(cancelled.id).processStatus, 'done');
    const outputRoot = path.join(root, 'complete');
    await runExport({ profile, productIds: [complete.id], outputRoot });
    assert.equal(products.get(complete.id).processStatus, 'exported');
    products.setProcessStatus(complete.id, 'done');
    const result = await runExport({ profile, productIds: [complete.id], outputRoot, onExisting: 'skip' });
    assert.equal(result.skippedExisting, 2);
    assert.equal(products.get(complete.id).processStatus, 'done');
  } finally {
    db.closeDb();
    const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'task6-fixtures');
    await fsp.mkdir(trash, { recursive: true });
    await fsp.rename(root, path.join(trash, path.basename(root)));
  }
});
