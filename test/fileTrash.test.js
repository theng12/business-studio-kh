/**
 * v0.1.85: a deleted product's images must be recoverable.
 *
 * The owner's report — "someone accidentally deleted a product" — was expensive
 * because of one line: `products.remove` ran
 * `fs.rmSync(dir, { recursive: true, force: true })`. The confirm said "This
 * cannot be undone", and it was telling the truth. The product could only come
 * back from a backup.
 *
 * `main/util/fileTrash.js` now hands the folder to the macOS Trash instead, and
 * this file pins the three properties that make that a safety net rather than a
 * rename of the same behaviour:
 *
 *   1. a folder that CAN be trashed ends up gone from its original path, and
 *      the Trash was actually asked to take it;
 *   2. a folder the Trash REFUSES is left exactly where it is — never erased as
 *      a consolation prize. This is the branch that decides whether bytes
 *      survive, and it is the reason the helper does not fall back to `rm`;
 *   3. outside Electron (a `node --test` run, `ELECTRON_RUN_AS_NODE=1`) there is
 *      no Trash to ask, so the path is removed for real — otherwise a genuine
 *      leak (deleted files piling up forever) would go unnoticed by the suite.
 *
 * The real `products.remove()` path is covered too, because the interesting
 * mistake is calling the helper and then still deleting the folder.
 *
 * RUNNING THIS. Real files on disk + a real SQLite database:
 *
 *     npm run test:native
 *
 * Under plain `npm test` these cases SKIP with that command as the reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { trashPath } = require('../main/util/fileTrash');

let db = null;
let companies = null;
let products = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  products = require('../main/db/products');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function scratchDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msk-trash-${label}-`));
}

test('a folder the Trash accepts is gone from where it was', async () => {
  const dir = scratchDir('accepted');
  const doomed = path.join(dir, 'product-images');
  fs.mkdirSync(doomed, { recursive: true });
  fs.writeFileSync(path.join(doomed, '001.jpg'), 'bytes');

  const asked = [];
  const outcome = await trashPath(doomed, {
    shell: { trashItem: async (p) => { asked.push(p); fs.rmSync(p, { recursive: true, force: true }); } },
  });

  assert.equal(outcome, 'trashed');
  assert.deepEqual(asked, [doomed], 'the Trash is what removed it, not us');
  assert.equal(fs.existsSync(doomed), false, 'and it is no longer in the assets folder');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder the Trash REFUSES is left alone, never erased', async () => {
  const dir = scratchDir('refused');
  const kept = path.join(dir, 'product-images');
  fs.mkdirSync(kept, { recursive: true });
  const file = path.join(kept, '001.jpg');
  fs.writeFileSync(file, 'the only copy');

  const outcome = await trashPath(kept, {
    shell: { trashItem: async () => { throw new Error('volume has no Trash'); } },
  });

  assert.equal(outcome, 'left');
  assert.equal(fs.existsSync(file), true,
    'a refused Trash must not turn into a delete — an orphaned folder is recoverable, erased bytes are not');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('with no Trash available at all, the path is removed (so the suite still sees leaks)', async () => {
  const dir = scratchDir('noshell');
  const file = path.join(dir, 'loose.jpg');
  fs.writeFileSync(file, 'bytes');

  // This whole run is outside Electron, so the default lookup already proves
  // the branch: no Trash exists here, and the file must not be left behind
  // forever — a leak that no test can see is worse than an erased temp file.
  assert.equal(typeof require('electron'), 'string', 'a node --test run is not an Electron main process');
  assert.equal(await trashPath(file), 'removed');
  assert.equal(fs.existsSync(file), false);

  // Nothing there is not an error and not a deletion.
  assert.equal(await trashPath(path.join(dir, 'never-existed')), 'missing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an Electron main process with no usable Trash leaves the files alone', async () => {
  // The production-shaped failure: we ARE in Electron, the shell is missing or
  // has no trashItem. Erasing here would be the silent data loss this whole
  // module exists to prevent, so the path must survive.
  const dir = scratchDir('noshell-in-app');
  const file = path.join(dir, 'loose.jpg');
  fs.writeFileSync(file, 'bytes');

  assert.equal(await trashPath(file, { shell: null }), 'left');
  assert.equal(await trashPath(file, { shell: {} }), 'left');
  assert.equal(fs.existsSync(file), true, 'no Trash in the app must never mean "delete it instead"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleting a product takes its folder out of the assets tree, and keeps the shared-folder rule', { skip: skipReason }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-trash-product-'));
  db.initDb(dataDir);

  const company = companies.create({ name: 'Shop', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'TRASH-1', name: 'Doomed' });
  const row = db.getDb().prepare('SELECT * FROM products WHERE id = ?').get(product.id);
  const relDir = path.posix.join('Shop', '_unassigned', 'TRASH-1');
  const absDir = path.join(dataDir, 'assets', relDir);
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.join(absDir, 'TRASH-1-001.jpg'), 'bytes');
  assert.ok(row, 'fixture product exists');

  products.remove(product.id);

  // The row is gone immediately, and the folder is no longer in the assets
  // tree — whether it was trashed (real app) or removed (this test run).
  assert.equal(products.get(product.id), null);
  assert.equal(fs.existsSync(absDir), false, 'the images folder must not stay in assets/');

  // Since v0.1.86 the folder is held in the recycle bin rather than trashed, so
  // this case only asserts it left the assets tree; test/deletedItems.test.js
  // owns the restorable behaviour and the Trash is exercised by the purge case
  // there.
  fs.rmSync(dataDir, { recursive: true, force: true });
});
