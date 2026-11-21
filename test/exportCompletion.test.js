const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharp = require('sharp');
const ROOT = path.resolve(__dirname, '..');
const profile = { width: 8, height: 8, format: 'png', namingPattern: '{SKU}-{INDEX}' };
async function fixture(body) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-export-completion-'));
  await fsp.mkdir(path.join(root, 'assets'));
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#b55' } }).png().toFile(path.join(root, 'assets', 'good.png'));
  await fsp.writeFile(path.join(root, 'assets', 'bad.png'), 'invalid-image');
  try { await body(root); } finally {
    const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'task6-fixtures');
    await fsp.mkdir(trash, { recursive: true });
    await fsp.rename(root, path.join(trash, path.basename(root)));
  }
}
function exporter(root, images) {
  const writes = [];
  const filename = path.join(ROOT, 'main/exportRunner.js');
  const req = createRequire(filename);
  const stubs = {
    './db': { getDataDir: () => root },
    './db/products': { get: (id) => id === 'p' ? { id: 'p', sku: 'P', processStatus: 'done' } : null, setProcessStatus: (...args) => writes.push(args) },
    './db/productImages': { listByProduct: () => images }, './db/brands': { get: () => null },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (id) => Object.hasOwn(stubs, id) ? stubs[id] : req(id), module, exports: module.exports, console, Buffer, process });
  return { run: (options = {}) => module.exports.runExport({ profile, productIds: ['p'], outputRoot: path.join(root, 'out'), ...options }), writes };
}

test('missing, failed and partially written export batches preserve prior product status', async () => {
  await fixture(async (root) => {
    for (const files of [['missing.png'], ['bad.png'], ['good.png', 'missing.png'], ['good.png', 'bad.png']]) {
      const { run, writes } = exporter(root, files.map((filepath) => ({ filepath, isProcessed: true })));
      const result = await run();
      assert.equal(result.exported, files[0] === 'good.png' ? 1 : 0);
      assert.ok(result.skipped > 0);
      assert.deepEqual(writes, [], files.join(', '));
    }
    const { run, writes } = exporter(root, [{ filepath: 'good.png', isProcessed: true }, { filepath: 'missing.png', isProcessed: false }]);
    assert.equal((await run()).exported, 1);
    assert.deepEqual(writes, [], 'a failed requested raw photo is still partial work');
  });
});

test('cancelled export preserves status even after one successful output', async () => {
  await fixture(async (root) => {
    const { run, writes } = exporter(root, [{ filepath: 'good.png', isProcessed: true }, { filepath: 'good.png', isProcessed: true }]);
    let written = false;
    const result = await run({ onProgress: () => { written = true; }, isCancelled: () => written });
    assert.equal(result.exported, 1); assert.equal(result.cancelled, true);
    assert.deepEqual(writes, []);
  });
});

test('collision Skip keeps existing bytes and prior status; complete writes alone advance processed products', async () => {
  await fixture(async (root) => {
    const { run, writes } = exporter(root, [{ filepath: 'good.png', isProcessed: true }]);
    const first = await run();
    assert.equal(first.exported, 1); assert.deepEqual(writes, [['p', 'exported']]);
    writes.length = 0;
    const file = path.join(root, 'out', 'P-001.png');
    await fsp.writeFile(file, 'existing-sentinel');
    const skipped = await run({ onExisting: 'skip' });
    assert.equal(skipped.exported, 0); assert.equal(skipped.skippedExisting, 1);
    assert.equal(await fsp.readFile(file, 'utf8'), 'existing-sentinel');
    assert.deepEqual(writes, []);
    const raw = exporter(root, [{ filepath: 'good.png', isProcessed: false }]);
    assert.equal((await raw.run()).exported, 1); assert.deepEqual(raw.writes, [], 'raw-only behavior stays unchanged');
  });
});

test('empty and unresolved products do not acquire an exported status', async () => {
  await fixture(async (root) => {
    const { run, writes } = exporter(root, []);
    assert.equal((await run()).exported, 0);
    assert.equal((await run({ productIds: ['missing'] })).exported, 0);
    assert.deepEqual(writes, []);
  });
});
