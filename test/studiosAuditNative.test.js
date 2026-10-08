/**
 * Export Center image scope + "save to library", against a real database
 * (studios audit 2026-10). Needs Electron's Node: `npm run test:native`.
 */
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

test('image scope picks main / first N / all, and save-to-library adds back only the main export', { skip }, async () => {
  // Left in the system temp folder afterwards (never deleted by a test).
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-studios-audit-native-'));
  try {
    const data = path.join(root, 'data');
    db.initDb(data);
    const companies = require('../main/db/companies');
    const products = require('../main/db/products');
    const images = require('../main/db/productImages');
    const sharp = require('sharp');
    const { runExport, expectedOutputs } = require('../main/exportRunner');
    const company = companies.create({ name: 'Scope fixture' });
    companies.setActive(company.id);
    const profile = { width: 8, height: 8, format: 'png', namingPattern: '{SKU}-{INDEX}' };
    async function gallery(sku) {
      const p = products.create({ companyId: company.id, sku, name: sku });
      for (let i = 0; i < 3; i++) {
        const rel = `${sku}/${i}.png`;
        const abs = path.join(data, 'assets', rel);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await sharp({ create: { width: 8, height: 8, channels: 3, background: ['#c66', '#6c6', '#66c'][i] } }).png().toFile(abs);
        images.addRow(p.id, { filepath: rel, filename: `${i}.png`, orderIndex: i, contentHash: `${sku}-${i}` });
      }
      return p;
    }
    const p = await gallery('GAL');
    const names = (result) => result.entries.map((e) => e.rel);
    assert.deepEqual(names(expectedOutputs({ profile, productIds: [p.id], imageScope: { mode: 'main' } })), ['GAL-001.png']);
    assert.deepEqual(names(expectedOutputs({ profile, productIds: [p.id], imageScope: { mode: 'first', count: 2 } })), ['GAL-001.png', 'GAL-002.png']);
    assert.equal(expectedOutputs({ profile, productIds: [p.id] }).totalExpected, 3, 'no scope = every image');

    const main = await runExport({ profile, productIds: [p.id], outputRoot: path.join(root, 'main'), imageScope: { mode: 'main' }, saveToLibrary: true });
    assert.equal(main.exported, 1);
    assert.equal(main.savedToLibrary, 1);
    assert.equal(images.listByProduct(p.id).length, 4);

    const q = await gallery('ALL');
    const all = await runExport({ profile, productIds: [q.id], outputRoot: path.join(root, 'all'), saveToLibrary: true });
    assert.equal(all.exported, 3, 'all images by default');
    assert.equal(all.savedToLibrary, 1, 'only the main export goes back — the gallery no longer doubles');
    assert.equal(images.listByProduct(q.id).length, 4);
  } finally {
    db.closeDb();
  }
});
