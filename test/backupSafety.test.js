/**
 * v0.49.31: tests for the backup/restore path-safety + manifest
 * helpers. A restore extracts an archive over the user's data folder,
 * so any path-traversal escape here would let a corrupt/hostile backup
 * write outside the data dir. These guards are the defense; this is
 * their regression test. The Electron-coupled orchestration in
 * main/backupManager.js can't be unit-tested without booting the app,
 * so the pure helpers carry the safety contract and the coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BACKUP_EXT,
  isPathInside,
  safeArchiveEntry,
  resolveSafeDest,
  backupStamp,
  backupFilename,
  isBackupFilename,
  entriesLookLikeDataDir,
  validateManifest,
  BACKUP_DATA_ENTRIES,
  ARCHIVE_TOP_LEVEL_DIRS,
  validateTarListing,
} = require('../main/util/backupSafety');

/* ── isPathInside ──────────────────────────────────────────────── */

test('isPathInside — true for a nested child', () => {
  assert.equal(isPathInside('/data', '/data/assets/a.jpg'), true);
  assert.equal(isPathInside('/data', '/data/database.sqlite'), true);
});

test('isPathInside — false for the root itself', () => {
  assert.equal(isPathInside('/data', '/data'), false);
});

test('isPathInside — false for a sibling or parent escape', () => {
  assert.equal(isPathInside('/data', '/data/../etc/passwd'), false);
  assert.equal(isPathInside('/data', '/other/x'), false);
  assert.equal(isPathInside('/data', '/datax/y'), false); // prefix-but-not-child
});

/* ── safeArchiveEntry ──────────────────────────────────────────── */

test('safeArchiveEntry — passes normal relative paths', () => {
  assert.equal(safeArchiveEntry('assets/products/a.jpg'), 'assets/products/a.jpg');
  assert.equal(safeArchiveEntry('manifest.json'), 'manifest.json');
});

test('safeArchiveEntry — rejects posix traversal', () => {
  assert.throws(() => safeArchiveEntry('../escape'), /traversal/);
  assert.throws(() => safeArchiveEntry('assets/../../escape'), /traversal/);
  assert.throws(() => safeArchiveEntry('a/b/../../../c'), /traversal/);
});

test('safeArchiveEntry — rejects windows-style traversal', () => {
  assert.throws(() => safeArchiveEntry('..\\escape'), /traversal/);
  assert.throws(() => safeArchiveEntry('assets\\..\\..\\escape'), /traversal/);
});

test('safeArchiveEntry — rejects empty / non-string input', () => {
  assert.throws(() => safeArchiveEntry(''));
  assert.throws(() => safeArchiveEntry('   '));
  assert.throws(() => safeArchiveEntry(null));
  assert.throws(() => safeArchiveEntry(undefined));
});

test('safeArchiveEntry — rejects absolute paths', () => {
  assert.throws(() => safeArchiveEntry('/database.sqlite'), /absolute/);
  assert.throws(() => safeArchiveEntry('C:\\Windows\\system32\\config'), /absolute/);
  assert.throws(() => safeArchiveEntry('/../../etc/passwd'), /absolute/);
});

/* ── resolveSafeDest ───────────────────────────────────────────── */

test('resolveSafeDest — resolves inside the root', () => {
  const root = '/tmp/restore-target';
  assert.equal(resolveSafeDest(root, 'assets/a.jpg'), path.resolve(root, 'assets/a.jpg'));
  assert.equal(resolveSafeDest(root, 'database.sqlite'), path.resolve(root, 'database.sqlite'));
});

test('resolveSafeDest — throws when an entry would escape the root', () => {
  const root = '/tmp/restore-target';
  assert.throws(() => resolveSafeDest(root, '../../etc/passwd'), /traversal|escapes/);
  assert.throws(() => resolveSafeDest(root, 'assets/../../../escape'), /traversal|escapes/);
});

/* ── backupStamp / backupFilename / isBackupFilename ───────────── */

test('backupStamp — formats a fixed date deterministically', () => {
  // Construct in local time so the assertion matches the local-time formatter.
  const d = new Date(2026, 4, 31, 21, 7); // 2026-05-31 21:07 local
  assert.equal(backupStamp(d), '2026-05-31-2107');
});

test('backupFilename — includes version + stamp + extension', () => {
  const name = backupFilename('2026-05-31-2107', '0.49.31');
  assert.equal(name, 'media-studio-kh-backup-v0.49.31-2026-05-31-2107.iskhbackup');
  assert.ok(name.endsWith(`.${BACKUP_EXT}`));
});

test('backupFilename — tolerates a missing version', () => {
  assert.equal(backupFilename('2026-05-31-2107'), 'media-studio-kh-backup-2026-05-31-2107.iskhbackup');
});

test('isBackupFilename — accepts our names, rejects others', () => {
  assert.equal(isBackupFilename('media-studio-kh-backup-v0.49.31-2026-05-31-2107.iskhbackup'), true);
  assert.equal(isBackupFilename('media-studio-kh-backup-2026-05-31-2107.iskhbackup'), true);
  assert.equal(isBackupFilename('random.tar.gz'), false);
  assert.equal(isBackupFilename('media-studio-kh-backup.txt'), false);
  assert.equal(isBackupFilename('.DS_Store'), false);
  assert.equal(isBackupFilename(null), false);
});

/* ── entriesLookLikeDataDir ────────────────────────────────────── */

test('entriesLookLikeDataDir — true when DB or an asset tree is present', () => {
  assert.equal(entriesLookLikeDataDir(['database.sqlite', 'config.json']), true);
  assert.equal(entriesLookLikeDataDir(['assets']), true);
  assert.equal(entriesLookLikeDataDir(['processed', 'ai-gallery']), true);
});

test('entriesLookLikeDataDir — false for empty / unrelated folders', () => {
  assert.equal(entriesLookLikeDataDir([]), false);
  assert.equal(entriesLookLikeDataDir(['Documents', 'notes.txt']), false);
  assert.equal(entriesLookLikeDataDir('not-an-array'), false);
});

/* ── finance receipts: backup + restore allowlists ─────────────── */

const verbose = (type, name) => `${type}rw-r--r--  0 user  staff  1 Jan  1 00:00 ${name}`;

test('finance is in BOTH backup and restore allowlists', () => {
  assert.ok(BACKUP_DATA_ENTRIES.includes('finance'), 'a finance receipt must be captured by a backup');
  assert.ok(ARCHIVE_TOP_LEVEL_DIRS.has('finance'), 'a backup holding a finance receipt must be restorable');
  // The fuel/hr regression: every captured tree must also be accepted on restore.
  for (const entry of BACKUP_DATA_ENTRIES) {
    if (entry !== 'database.sqlite') {
      assert.ok(ARCHIVE_TOP_LEVEL_DIRS.has(entry), `${entry} is backed up but would be refused on restore`);
    }
  }
});

test('archive validation accepts a finance/receipts entry and refuses it without the allowlist', () => {
  const names = [
    'bundle/',
    'bundle/database.sqlite',
    'bundle/manifest.json',
    'bundle/finance/',
    'bundle/finance/receipts/',
    'bundle/finance/receipts/2026-11/company_expense_id.jpg',
  ];
  const details = names.map((name, i) => verbose(i === 0 || name.endsWith('/') ? 'd' : '-', name));
  const accept = () => validateTarListing(`${names.join('\n')}\n`, `${details.join('\n')}\n`);

  const listing = accept();
  assert.ok(listing.entries.some((e) => e.relPath === 'finance/receipts/2026-11/company_expense_id.jpg'));
  assert.equal(entriesLookLikeDataDir(['finance']), true);

  // Prove the acceptance is the allowlist at work, not an accident.
  ARCHIVE_TOP_LEVEL_DIRS.delete('finance');
  try {
    assert.throws(accept, /unsupported path/);
  } finally {
    ARCHIVE_TOP_LEVEL_DIRS.add('finance');
  }
});

/* ── validateManifest ──────────────────────────────────────────── */

function goodManifest() {
  return {
    kind: BACKUP_KIND,
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    appVersion: '0.49.31',
    createdAt: 1748725620000,
    includes: ['database.sqlite', 'config.json', 'assets/'],
  };
}

test('validateManifest — accepts a well-formed manifest', () => {
  const res = validateManifest(goodManifest());
  assert.equal(res.ok, true);
  assert.equal(res.manifest.kind, BACKUP_KIND);
});

test('validateManifest — rejects a wrong/missing kind marker', () => {
  const m = goodManifest(); delete m.kind;
  assert.equal(validateManifest(m).ok, false);
  const m2 = goodManifest(); m2.kind = 'something-else';
  assert.equal(validateManifest(m2).ok, false);
});

test('validateManifest — rejects a newer format version', () => {
  const m = goodManifest(); m.backupFormatVersion = BACKUP_FORMAT_VERSION + 1;
  const res = validateManifest(m);
  assert.equal(res.ok, false);
  assert.match(res.error, /newer version/);
});

test('validateManifest — rejects a non-integer format version', () => {
  const m = goodManifest(); m.backupFormatVersion = 'one';
  assert.equal(validateManifest(m).ok, false);
});

test('validateManifest — rejects a manifest with no DB snapshot', () => {
  const m = goodManifest(); m.includes = ['assets/', 'config.json'];
  const res = validateManifest(m);
  assert.equal(res.ok, false);
  assert.match(res.error, /no database snapshot/);
});

test('validateManifest — rejects empty / non-object input', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest(undefined).ok, false);
  assert.equal(validateManifest('x').ok, false);
  const m = goodManifest(); m.includes = [];
  assert.equal(validateManifest(m).ok, false);
});
