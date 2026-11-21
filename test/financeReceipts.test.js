/**
 * Finance §6: receipt photos — private storage and backup coverage.
 *
 * Pins the properties that only show up with real files (and, for the restore
 * case, real SQLite + real tar — `npm run test:native`):
 *   1. A valid image round-trips: canonical JPEG on disk, metadata matches the
 *      bytes, and readReceipt hands the renderer a JPEG data URL.
 *   2. Content decides what is an image, not the filename extension; EXIF
 *      orientation is applied and stripped on the stored copy.
 *   3. Oversize bytes are refused before decode; non-images are refused after.
 *   4. Ids and originalName are bounded; traversal/absolute ids are refused.
 *   5. A receipt can never land or be read outside `<dataDir>/finance/receipts`
 *      through a symlink, and never under the public assets/ trees.
 *   6. Storing a replacement does not delete the previous file.
 *   7. backup → restore carries finance/ receipts back byte-identical — the
 *      exact failure mode fuelBackupNative.test.js exists for (a tree in
 *      BACKUP_DATA_ENTRIES but not ARCHIVE_TOP_LEVEL_DIRS is written fine and
 *      refused on restore).
 *
 * RUNNING THIS. Real SQLite + real files: `npm run test:native`. Under plain
 * `npm test` this file SKIPS with that command as the reason when the native
 * binding's ABI does not match.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err?.message))) {
    skipReason = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`";
  } else {
    throw err;
  }
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

let userDataRoot = '';
const fakeElectron = { app: { getPath: () => userDataRoot, getVersion: () => 'test' } };

let db; let receipts; let createBackup; let restoreBackup;
if (!skipReason) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  db = require('../main/db');
  receipts = require('../main/financeReceipts');
  ({ createBackup, restoreBackup } = require('../main/backupManager'));
}

const sharp = require('sharp');

function closeDb() { try { db.closeDb(); } catch (_) { /* not open */ } }

/**
 * The project rule is that nothing is erased — a finished fixture is MOVED
 * into a fixtures folder under the system temp dir, the same convention the
 * Finance scope test uses. A checkout keeps no `_trash` (owner 2026-11-18).
 */
function preserveFixture(root) {
  try {
    const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'finance-tests');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(root, path.join(trash, path.basename(root)));
  } catch (_) { /* leaving the fixture in temp beats failing the test */ }
}

async function fixture() {
  closeDb();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mskh-finance-receipts-'));
  userDataRoot = path.join(root, 'user-data');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(userDataRoot, { recursive: true });
  await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir, firstLaunchHandled: true }));
  db.initDb(dataDir);
  return { root, dataDir };
}

async function jpegBytes(width = 64, height = 48) {
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 240, b: 250 } } }).jpeg().toBuffer();
}

const ids = () => ({ companyId: randomUUID(), expenseId: randomUUID() });

test('receipt storage erases nothing — scratch files are preserved, not unlinked', () => {
  // The removal patterns are built from pieces so this test's own source does
  // not match them.
  const removal = new RegExp([
    'unlink' + 'Sync', 'rm' + 'Sync', 'fsp' + '.rm',
    '\\.cleanup' + '\\?\\.\\(\\)',
  ].join('|'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'financeReceipts.js'), 'utf8');
  assert.doesNotMatch(src, removal, 'no file is removed anywhere on the receipt path');
  assert.match(src, /'finance', '_trash', 'receipt-scratch'/, 'scratch conversions stay in private data trash in dev and packaged apps');
  assert.doesNotMatch(src, /__dirname/, 'receipt runtime storage never depends on source layout');
  assert.doesNotMatch(fs.readFileSync(__filename, 'utf8'), removal, 'the test itself removes nothing either');
});

test('HEIC conversion keeps its source and JPEG in private runtime trash', { skip: skipReason || process.platform !== 'darwin' }, async () => {
  const env = await fixture();
  try {
    const input = path.join(env.root, 'source.jpg');
    const heic = path.join(env.root, 'source.heic');
    fs.writeFileSync(input, await jpegBytes());
    execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', input, '--out', heic], { stdio: 'pipe' });
    const bytes = fs.readFileSync(heic);
    assert.equal(require('../main/util/heic').isHeicBuffer(bytes), true);
    const stored = await receipts.storeReceipt({ ...ids(), bytes, originalName: 'phone.heic' });
    assert.equal((await sharp(Buffer.from(receipts.readReceipt(stored).dataUrl.split(',')[1], 'base64')).metadata()).format, 'jpeg');
    const scratch = path.join(env.dataDir, 'finance', '_trash', 'receipt-scratch');
    const files = fs.readdirSync(scratch);
    assert.equal(files.filter(f => f.endsWith('.heic')).length, 1);
    assert.equal(files.filter(f => f.endsWith('.jpg')).length, 1);
    for (const file of files) assert.equal(fs.statSync(path.join(scratch, file)).mode & 0o777, 0o600);
  } finally { closeDb(); preserveFixture(env.root); }
});

test('storeReceipt → readReceipt round trip keeps the bytes and stays out of public assets', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const bytes = await jpegBytes();
    const meta = await receipts.storeReceipt({ ...ids(), bytes, originalName: 'fuel receipt.jpg' });

    assert.equal(meta.mime, 'image/jpeg');
    assert.equal(meta.originalName, 'fuel receipt.jpg');
    assert.match(meta.relativePath, /^finance\/receipts\/\d{4}-\d{2}\/[A-Za-z0-9_-]+\.jpg$/);
    assert.ok(Number.isInteger(meta.size) && meta.size > 0);

    const abs = path.join(env.dataDir, meta.relativePath);
    const stored = fs.readFileSync(abs);
    assert.equal(sha(stored), meta.sha256);
    assert.equal(stored.length, meta.size);
    assert.equal(stored[0], 0xff);
    assert.equal(stored[1], 0xd8);

    for (const root of ['assets', 'processed', 'ai-gallery']) {
      assert.ok(!meta.relativePath.startsWith(`${root}/`), `${meta.relativePath} must not be public`);
      assert.ok(!abs.startsWith(path.join(env.dataDir, root) + path.sep), `${abs} must not be public`);
    }

    const out = receipts.readReceipt(meta);
    assert.equal(out.originalName, 'fuel receipt.jpg');
    assert.ok(out.dataUrl.startsWith('data:image/jpeg;base64,'));
    const decoded = Buffer.from(out.dataUrl.split(',')[1], 'base64');
    assert.equal(sha(decoded), meta.sha256);
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('content decides the image, not the extension; EXIF orientation is applied and stripped', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 0, g: 120, b: 0 } } })
      .png().toBuffer();
    const pngMeta = await receipts.storeReceipt({ ...ids(), bytes: png, originalName: 'receipt.png' });
    const pngStored = fs.readFileSync(path.join(env.dataDir, pngMeta.relativePath));
    assert.equal(pngStored[0], 0xff, 'stored copy is JPEG whatever the name said');
    assert.equal(pngStored[1], 0xd8);

    const oriented = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 10, b: 10 } } })
      .withMetadata({ orientation: 6 })
      .jpeg().toBuffer();
    const oMeta = await receipts.storeReceipt({ ...ids(), bytes: oriented, originalName: 'IMG_0001.HEIC' });
    const info = await sharp(fs.readFileSync(path.join(env.dataDir, oMeta.relativePath))).metadata();
    assert.equal(info.format, 'jpeg');
    assert.equal(info.width, 20, 'orientation 6 rotates the pixels 90°');
    assert.equal(info.height, 40);
    assert.equal(info.orientation, undefined, 'the stored copy carries no orientation tag');
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('oversize is refused before decode; a non-image is refused by the decoder', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    assert.equal(receipts.MAX_RECEIPT_BYTES, 15 * 1024 * 1024);

    // Garbage of the maximum size + 1 byte: if the size gate were after decode,
    // the error would be the decoder's, not the size message.
    const huge = Buffer.alloc(receipts.MAX_RECEIPT_BYTES + 1, 0x41);
    await assert.rejects(
      () => receipts.storeReceipt({ ...ids(), bytes: huge, originalName: 'big.jpg' }),
      /too large \(max 15 MB\)/,
    );

    await assert.rejects(
      () => receipts.storeReceipt({ ...ids(), bytes: Buffer.from('this is not an image at all'), originalName: 'fake.jpg' }),
      /not a photo the app can read/,
    );
    await assert.rejects(
      () => receipts.storeReceipt({ ...ids(), bytes: Buffer.alloc(0), originalName: 'empty.jpg' }),
      /empty/,
    );
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('ids and originalName are bounded; traversal and absolute ids are refused', { skip: skipReason }, async () => {
  const env = await fixture();
  const bytes = await jpegBytes();
  try {
    for (const companyId of ['../escape', '../../etc', '/etc/passwd', 'a/b', 'x'.repeat(201), '']) {
      await assert.rejects(
        () => receipts.storeReceipt({ companyId, expenseId: randomUUID(), bytes, originalName: 'r.jpg' }),
        /companyId must be a safe id/,
        `companyId ${JSON.stringify(companyId)} must be refused`,
      );
    }
    await assert.rejects(
      () => receipts.storeReceipt({ companyId: randomUUID(), expenseId: '../x', bytes, originalName: 'r.jpg' }),
      /expenseId must be a safe id/,
    );
    await assert.rejects(
      () => receipts.storeReceipt({ ...ids(), bytes, originalName: 'x'.repeat(201) }),
      /at most 200 characters/,
    );
    await assert.rejects(
      () => receipts.storeReceipt({ ...ids(), bytes, originalName: 'bad\u0000name.jpg' }),
      /control characters/,
    );

    // A missing name is allowed (the phone picker does not have to send one).
    const meta = await receipts.storeReceipt({ ...ids(), bytes });
    assert.equal(meta.originalName, '');
    // Maximum-length ids still produce a filename the filesystem accepts.
    const longIds = await receipts.storeReceipt({ companyId: 'a'.repeat(200), expenseId: 'b'.repeat(200), bytes });
    assert.ok(path.basename(longIds.relativePath).length < 255);
    // Nothing escaped: the only finance files are the two just stored.
    const monthDirAbs = path.dirname(path.join(env.dataDir, meta.relativePath));
    assert.deepEqual(fs.readdirSync(monthDirAbs).sort(), [path.basename(longIds.relativePath), path.basename(meta.relativePath)].sort());
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('a symlinked receipts folder cannot make a write land outside the data folder', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const outside = path.join(env.root, 'outside');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(path.join(env.dataDir, 'finance'), { recursive: true });
    fs.symlinkSync(outside, path.join(env.dataDir, 'finance', 'receipts'), 'dir');
    const bytes = await jpegBytes();

    await assert.rejects(
      () => receipts.storeReceipt({ ...ids(), bytes, originalName: 'r.jpg' }),
      /escapes the data folder/,
    );
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written through the symlink');
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('a receipt file swapped for a symlink is refused on read, not followed', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const meta = await receipts.storeReceipt({ ...ids(), bytes: await jpegBytes(), originalName: 'r.jpg' });
    const abs = path.join(env.dataDir, meta.relativePath);
    const secret = path.join(env.root, 'secret.jpg');
    fs.writeFileSync(secret, 'not for the renderer');
    // Move the receipt aside rather than erasing it — the file is preserved
    // inside the fixture folder, which the whole fixture then preserves.
    const aside = path.join(env.root, 'receipt-aside.jpg');
    fs.renameSync(abs, aside);
    fs.symlinkSync(secret, abs);

    assert.throws(() => receipts.readReceipt(meta), /escapes the data folder/);

    // Arbitrary metadata paths are refused before the filesystem is consulted.
    assert.throws(() => receipts.readReceipt({ ...meta, relativePath: 'assets/products/x.jpg' }), /not a valid finance receipt path/);
    assert.throws(() => receipts.readReceipt({ ...meta, relativePath: 'finance/receipts/../../database.sqlite' }), /not a valid finance receipt path/);
    assert.throws(() => receipts.readReceipt({ ...meta, relativePath: '/etc/passwd' }), /not a valid finance receipt path/);
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('a swapped file is reported by its checksum rather than shown', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const meta = await receipts.storeReceipt({ ...ids(), bytes: await jpegBytes(20, 20), originalName: 'r.jpg' });
    const other = await jpegBytes(21, 21);
    fs.writeFileSync(path.join(env.dataDir, meta.relativePath), other);
    assert.throws(() => receipts.readReceipt(meta), /does not match its recorded checksum/);
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('storing a replacement keeps the previous receipt file (nothing is deleted)', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const { companyId, expenseId } = ids();
    const first = await receipts.storeReceipt({ companyId, expenseId, bytes: await jpegBytes(10, 10), originalName: 'a.jpg' });
    const second = await receipts.storeReceipt({ companyId, expenseId, bytes: await jpegBytes(11, 11), originalName: 'b.jpg' });
    assert.notEqual(first.relativePath, second.relativePath);
    assert.equal(sha(fs.readFileSync(path.join(env.dataDir, first.relativePath))), first.sha256);
    assert.equal(sha(fs.readFileSync(path.join(env.dataDir, second.relativePath))), second.sha256);
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});

test('backup → restore brings back a finance receipt byte-identical', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const meta = await receipts.storeReceipt({ ...ids(), bytes: await jpegBytes(), originalName: 'receipt.jpg' });
    const archive = await createBackup({ destDir: path.join(env.root, 'backups') });

    // Damage the live copy so the restore has to put it back.
    fs.writeFileSync(path.join(env.dataDir, meta.relativePath), 'changed');
    const restored = await restoreBackup({ backupPath: archive.backupPath });
    assert.equal(restored.success, true);
    closeDb();

    const buf = fs.readFileSync(path.join(env.dataDir, meta.relativePath));
    assert.equal(sha(buf), meta.sha256);
    assert.ok(meta.relativePath.startsWith('finance/receipts/'));
  } finally {
    closeDb();
    preserveFixture(env.root);
  }
});
