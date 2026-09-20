const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  validateTarListing,
  validateExtractedTree,
  validateSQLiteDatabase,
} = require('../main/util/backupSafety');

const verbose = (type, name) => `${type}rw-r--r--  0 user  staff  1 Jan  1 00:00 ${name}`;

function validListing() {
  const names = [
    'bundle/',
    'bundle/database.sqlite',
    'bundle/manifest.json',
    'bundle/assets/',
    'bundle/assets/image.png',
  ].join('\n') + '\n';
  const details = [
    verbose('d', 'bundle/'),
    verbose('-', 'bundle/database.sqlite'),
    verbose('-', 'bundle/manifest.json'),
    verbose('d', 'bundle/assets/'),
    verbose('-', 'bundle/assets/image.png'),
  ].join('\n') + '\n';
  return { names, details };
}

test('validateTarListing accepts the supported legacy archive layout', () => {
  const listing = validateTarListing(...Object.values(validListing()));
  assert.equal(listing.rootName, 'bundle');
  assert.deepEqual(listing.entries.map((entry) => entry.relPath), [
    '', 'database.sqlite', 'manifest.json', 'assets/', 'assets/image.png',
  ]);
});

test('validateTarListing rejects links, special entries, escapes, and extra content', () => {
  const base = validListing();
  assert.throws(() => validateTarListing(
    base.names + 'bundle/assets/link\n',
    base.details + verbose('l', 'bundle/assets/link') + '\n',
  ), /unsupported entry type/);
  assert.throws(() => validateTarListing(
    base.names + 'bundle/assets/hard\n',
    base.details + verbose('h', 'bundle/assets/hard') + '\n',
  ), /unsupported entry type/);
  assert.throws(() => validateTarListing(
    base.names + 'bundle/assets/device\n',
    base.details + verbose('b', 'bundle/assets/device') + '\n',
  ), /unsupported entry type/);
  assert.throws(() => validateTarListing(
    'bundle/\nbundle/database.sqlite\nbundle/manifest.json\nbundle/tmp.txt\n',
    [verbose('d', 'bundle/'), verbose('-', 'bundle/database.sqlite'), verbose('-', 'bundle/manifest.json'), verbose('-', 'bundle/tmp.txt')].join('\n') + '\n',
  ), /unsupported path/);
  assert.throws(() => validateTarListing(
    'bundle/\nbundle/database.sqlite\nbundle/manifest.json\nother/file\n',
    [verbose('d', 'bundle/'), verbose('-', 'bundle/database.sqlite'), verbose('-', 'bundle/manifest.json'), verbose('-', 'other/file')].join('\n') + '\n',
  ), /multiple top-level/);
  assert.throws(() => validateTarListing(
    'bundle/\nbundle/manifest.json\n',
    [verbose('d', 'bundle/'), verbose('-', 'bundle/manifest.json')].join('\n') + '\n',
  ), /incomplete/);
});

function fakeDatabase() {
  return {
    prepare() { return { get: () => ({ quick_check: 'ok' }) }; },
    close() {},
  };
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iskh-archive-safety-'));
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'manifest.json'), '{}');
  await fs.writeFile(path.join(root, 'database.sqlite'), Buffer.from('SQLite format 3\u0000fixture'));
  return root;
}

test('validateExtractedTree accepts a regular staged SQLite tree', async () => {
  const root = await makeFixture();
  try {
    await assert.doesNotReject(() => validateExtractedTree(root, { openDatabase: fakeDatabase }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateExtractedTree rejects symlink and hardlink fixtures', async () => {
  const root = await makeFixture();
  try {
    await fs.symlink('/tmp', path.join(root, 'assets', 'link'));
    await assert.rejects(() => validateExtractedTree(root, { openDatabase: fakeDatabase }), /link entry/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const hardRoot = await makeFixture();
  try {
    await fs.link(path.join(hardRoot, 'database.sqlite'), path.join(hardRoot, 'assets', 'hard'));
    await assert.rejects(() => validateExtractedTree(hardRoot, { openDatabase: fakeDatabase }), /link entry/);
  } finally {
    await fs.rm(hardRoot, { recursive: true, force: true });
  }
});

test('validateSQLiteDatabase rejects a corrupt database before opening it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iskh-corrupt-db-'));
  const dbPath = path.join(root, 'database.sqlite');
  try {
    await fs.writeFile(dbPath, 'not sqlite');
    await assert.rejects(() => validateSQLiteDatabase(dbPath, { openDatabase: () => {
      throw new Error('must not open corrupt input');
    } }), /not a SQLite database/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
