/**
 * v0.49.31: pure path-safety + manifest helpers for the local
 * backup/restore feature (main/backupManager.js).
 *
 * The path and archive checks are kept here so backup and bundle restore
 * share one boundary. SQLite validation opens the staged database read-only;
 * the Electron-coupled orchestration (tar, db.backup(), dialogs) stays in
 * main/backupManager.js and main/serverBundle.js.
 *
 * The whole point of pulling these out: a restore EXTRACTS an archive
 * over the user's data folder. If an attacker (or a corrupted archive)
 * could smuggle a `../../etc/...` entry past us we'd write outside the
 * data folder. These guards are the defense, and they're the thing
 * most worth a regression test.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Bump when the on-disk backup layout changes incompatibly. Restore
// refuses a backup whose format it doesn't understand.
const BACKUP_FORMAT_VERSION = 1;

// Marker baked into every manifest so we can tell our backups apart
// from an arbitrary .tar.gz the user renamed.
const BACKUP_KIND = 'business-studio-kh-backup';

/* v0.1.82: this app was renamed from **Image Studio KH**, and the old app wrote
 * `image-studio-kh-backup` into the same manifest field. The data itself did not
 * change — same archive layout, and the database schema was already version 2,
 * which is what it still is (later columns arrive through addColumnIfMissing) —
 * so an old backup restores perfectly well. It was only ever the marker that
 * refused it, which is a rename, not an incompatibility.
 *
 * Recognised rather than rewritten: a restored archive keeps saying which app
 * made it, and the restore screen shows that version.
 *
 * 0.1.120: renamed again, Media Studio KH → Business Studio KH, so the names
 * this app itself used before are both accepted. Every older backup must still
 * list and restore. */
const LEGACY_BACKUP_KINDS = ['media-studio-kh-backup', 'image-studio-kh-backup'];

// Custom extension (a gzipped tar underneath). Custom so double-click
// in Finder doesn't auto-expand it and it's obviously ours.
const BACKUP_EXT = 'iskhbackup';

// The subfolder under <dataDir> where backups are written by default.
// Excluded from the archive itself so a backup never contains older
// backups (which would compound on disk geometrically).
const BACKUP_DIR_NAME = 'backups';

// Top-level entries of the data folder a backup captures. Anything not
// in this list (notably the backups/ folder and dotfiles) is left out.
// database.sqlite's -wal / -shm sidecars are handled separately by the
// snapshot step (db.backup() produces a single consistent file).
// Fuel F1: `fuel` (evidence photos) and `hr` (staff photos) travel too — they
// are not under assets/ on purpose (read only through permission-checked calls).
// Fixed Assets: `fixed-assets` (asset photos and documents — evidence, read only
// through assets:getFile) travels too, and is in ARCHIVE_TOP_LEVEL_DIRS below.
// Finance §6: `finance` (receipt photos — evidence, read only through the
// permission-checked finance:getReceipt channel) must travel in both lists too.
// Pick & Pack: `pack` (parcel photos — evidence, read only through the
// permission-checked pack:getPhoto channel) must travel in both lists too.
const BACKUP_DATA_ENTRIES = ['database.sqlite', 'assets', 'processed', 'ai-gallery', 'overlays', 'fuel', 'hr', 'fixed-assets', 'finance', 'pack'];

/** Resolve existing symlinks while preserving any not-yet-created suffix. */
function canonicalizeExistingPath(inputPath) {
  let cursor = path.resolve(inputPath);
  const suffix = [];
  while (true) {
    try {
      return path.resolve(fs.realpathSync.native(cursor), ...suffix);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Is `child` strictly inside `parent`? Used to reject any archive
 * entry that would extract outside the target folder. Resolves both
 * sides first so `..` segments and symlink-ish trickery normalize
 * away before comparison.
 *
 * Returns false when child === parent (an entry can't BE the root) and
 * when child climbs out via `..`.
 */
function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * Validate a single archive-entry relative path before extraction.
 * Rejects absolute paths, empty strings, and anything containing a
 * `..` traversal segment. Returns the cleaned relative path or throws.
 */
function safeArchiveEntry(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('Archive entry path is empty');
  }
  const trimmed = relPath.trim();
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error(`Unsafe archive entry (absolute path): ${relPath}`);
  }
  const cleaned = trimmed.replace(/^[/\\]+/, '');
  // Split on either separator so a Windows-style entry can't sneak a
  // `..` past a posix-only check.
  const segments = cleaned.split(/[/\\]/);
  if (segments.some((s) => s === '..')) {
    throw new Error(`Unsafe archive entry (path traversal): ${relPath}`);
  }
  return cleaned;
}

const ARCHIVE_TOP_LEVEL_FILES = new Set([
  'database.sqlite',
  'manifest.json',
  'config.json',
  'config.partial.json',
]);
// Fuel F1: fuel/ (evidence photos) and hr/ (staff photos) must be restorable too —
// they are in BACKUP_DATA_ENTRIES, and an archive entry outside this set is refused.
// Fixed Assets: fixed-assets/ likewise (in both lists, or every backup holding an asset photo is unrestorable).
// Finance §6: finance/ likewise (receipt photos are evidence; a backup holding one must restore).
const ARCHIVE_TOP_LEVEL_DIRS = new Set(['assets', 'processed', 'ai-gallery', 'overlays', 'fuel', 'hr', 'fixed-assets', 'finance', 'pack']);

function archivePathSupported(relPath) {
  const cleaned = relPath.replace(/\/$/, '');
  if (ARCHIVE_TOP_LEVEL_FILES.has(cleaned)) return true;
  const slash = cleaned.indexOf('/');
  const top = slash === -1 ? cleaned : cleaned.slice(0, slash);
  return ARCHIVE_TOP_LEVEL_DIRS.has(top);
}

/**
 * Validate the name/type listings produced by the native tar implementation.
 * The two listings are paired by archive order; this avoids parsing filenames
 * containing spaces out of tar's human-readable verbose format.
 */
function validateTarListing(namesText, verboseText) {
  const names = String(namesText || '').split('\n').filter(Boolean);
  const verbose = String(verboseText || '').split('\n').filter(Boolean);
  if (names.length === 0 || names.length !== verbose.length) {
    throw new Error('Archive listing is missing or inconsistent');
  }

  const first = safeArchiveEntry(names[0]).replace(/\/$/, '');
  const rootName = first;
  if (!rootName || names[0] !== `${rootName}/`) {
    throw new Error('Archive structure unexpected (expected a single top-level folder)');
  }

  const entries = [];
  for (let i = 0; i < names.length; i += 1) {
    const raw = safeArchiveEntry(names[i]);
    if (raw !== rootName && !raw.startsWith(`${rootName}/`)) {
      throw new Error(`Archive contains multiple top-level entries: ${names[i]}`);
    }
    const relPath = raw === rootName ? '' : raw.slice(rootName.length + 1);
    const type = verbose[i][0];
    if (!['d', '-'].includes(type)) {
      throw new Error(`Archive contains unsupported entry type: ${names[i]}`);
    }
    if (i === 0 && type !== 'd') {
      throw new Error(`Archive root is not a directory: ${names[i]}`);
    }
    const cleanRelPath = relPath.replace(/\/$/, '');
    if (ARCHIVE_TOP_LEVEL_DIRS.has(cleanRelPath) && type !== 'd') {
      throw new Error(`Archive directory has the wrong entry type: ${names[i]}`);
    }
    if (ARCHIVE_TOP_LEVEL_FILES.has(cleanRelPath) && type !== '-') {
      throw new Error(`Archive file has the wrong entry type: ${names[i]}`);
    }
    if (relPath && !archivePathSupported(relPath)) {
      throw new Error(`Archive contains unsupported path: ${names[i]}`);
    }
    entries.push({ name: names[i], relPath, type });
  }

  const relPaths = new Set(entries.map((e) => e.relPath.replace(/\/$/, '')));
  if (!relPaths.has('manifest.json') || !relPaths.has('database.sqlite')) {
    throw new Error('Archive is incomplete — manifest.json and database.sqlite are required');
  }
  return { rootName, entries };
}

async function validateExtractedTree(rootDir, { openDatabase, expectedSchemaVersion } = {}) {
  const rootAbs = path.resolve(rootDir);
  const rootStat = await fsp.lstat(rootAbs).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Archive root is not a regular directory');
  }
  const walk = async (dir) => {
    const children = await fsp.readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const abs = path.join(dir, child.name);
      const rel = path.relative(rootAbs, abs).replace(/\\/g, '/');
      resolveSafeDest(rootAbs, rel);
      const stat = await fsp.lstat(abs);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
        throw new Error(`Archive contains a link entry: ${rel}`);
      }
      if (stat.isDirectory()) {
        if (!archivePathSupported(rel)) throw new Error(`Archive contains unsupported path: ${rel}`);
        await walk(abs);
      } else if (!stat.isFile()) {
        throw new Error(`Archive contains a special entry: ${rel}`);
      } else if (!archivePathSupported(rel)) {
        throw new Error(`Archive contains unsupported path: ${rel}`);
      }
      const cleanRel = rel.replace(/\/$/, '');
      if (ARCHIVE_TOP_LEVEL_DIRS.has(cleanRel) && !stat.isDirectory()) {
        throw new Error(`Archive directory has the wrong entry type: ${rel}`);
      }
      if (ARCHIVE_TOP_LEVEL_FILES.has(cleanRel) && !stat.isFile()) {
        throw new Error(`Archive file has the wrong entry type: ${rel}`);
      }
    }
  };
  await walk(rootAbs);
  const dbPath = path.join(rootAbs, 'database.sqlite');
  await validateSQLiteDatabase(dbPath, { openDatabase, expectedSchemaVersion });
  return true;
}

/** Verify regular-file identity and SQLite's own consistency check. */
async function validateSQLiteDatabase(filePath, { openDatabase, expectedSchemaVersion } = {}) {
  const stat = await fsp.lstat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.nlink > 1) {
    throw new Error('Archive database.sqlite is not a regular file');
  }
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 16 || header.toString('ascii') !== 'SQLite format 3\u0000') {
      throw new Error('Archive database.sqlite is not a SQLite database');
    }
  } finally {
    await handle.close();
  }

  const Database = openDatabase || require('better-sqlite3');
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const result = db.prepare('PRAGMA quick_check').get();
    if (!result || result.quick_check !== 'ok') {
      throw new Error('Archive database.sqlite failed SQLite quick_check');
    }
    if (Number.isInteger(expectedSchemaVersion)) {
      let schemaVersion = null;
      try {
        const row = db.prepare("SELECT value FROM app_state WHERE key = 'schema_version'").get();
        schemaVersion = row?.value;
      } catch (_) { /* reported by the exact-version check below */ }
      if (schemaVersion !== String(expectedSchemaVersion)) {
        const found = schemaVersion == null ? 'missing' : JSON.stringify(schemaVersion);
        throw new Error(
          `Archive database schema version ${found} is not supported; expected v${expectedSchemaVersion}.`,
        );
      }
    }
  } catch (err) {
    if (/Archive database/.test(err.message)) throw err;
    throw new Error(`Archive database.sqlite is invalid: ${err.message}`, { cause: err });
  } finally {
    try { db?.close(); } catch (_) {}
  }
  return true;
}

/**
 * Resolve an archive entry against a destination root and assert the
 * result stays inside that root. Returns the absolute destination.
 * Throws on any escape. This is the belt-and-braces check run for
 * every extracted file even after safeArchiveEntry().
 */
function resolveSafeDest(rootDir, relPath) {
  const cleaned = safeArchiveEntry(relPath);
  const dest = path.resolve(rootDir, cleaned);
  const rootAbs = path.resolve(rootDir);
  if (dest !== rootAbs && !isPathInside(rootAbs, dest)) {
    throw new Error(`Archive entry escapes target folder: ${relPath}`);
  }
  return dest;
}

/**
 * Build the timestamp slug used in backup filenames. Pure — the caller
 * supplies the Date so this stays testable (no Date.now() inside).
 * Format: YYYY-MM-DD-HHmm (local time), e.g. 2026-05-31-2147.
 */
function backupStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}`
  );
}

/** Default backup filename for a given timestamp slug + app version. */
function backupFilename(stamp, appVersion) {
  const v = appVersion ? `v${appVersion}-` : '';
  return `business-studio-kh-backup-${v}${stamp}.${BACKUP_EXT}`;
}

/**
 * Recognise a filename produced by backupFilename(). Used to filter a
 * backups/ folder listing down to actual backups (so a stray file the
 * user dropped in there doesn't show up as a restorable backup) and to
 * reject restore requests pointed at a non-backup file.
 */
function isBackupFilename(name) {
  if (typeof name !== 'string') return false;
  // v0.1.82 and 0.1.120: `image-studio-kh-backup-…` and `media-studio-kh-backup-…`
  // are what this app wrote before its two renames. The old files have to LIST in
  // the restore picker, or the user cannot pick the very backup they are trying
  // to restore.
  return new RegExp(`^(?:business|media|image)-studio-kh-backup-.+\\.${BACKUP_EXT}$`).test(name);
}

/**
 * Decide whether a list of a folder's top-level entry names looks like
 * one of our data folders. Mirrors the fs-based looksLikeOurDataDir in
 * main/ipc/settings.js but takes the names directly so it's pure +
 * testable. A folder qualifies if it has the DB or any asset tree.
 */
function entriesLookLikeDataDir(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => BACKUP_DATA_ENTRIES.includes(e));
}

/**
 * Validate a parsed manifest object. Returns { ok: true, manifest } on
 * success or { ok: false, error } with a user-readable reason. Kept as
 * a return value (not a throw) so callers can format the message into a
 * toast without a try/catch — but restoreBackup throws on { ok:false }.
 */
function validateManifest(obj) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Backup manifest is missing or not an object' };
  }
  if (obj.kind !== BACKUP_KIND && !LEGACY_BACKUP_KINDS.includes(obj.kind)) {
    return { ok: false, error: 'Not a Business Studio KH backup (wrong or missing kind marker)' };
  }
  if (!Number.isInteger(obj.backupFormatVersion)) {
    return { ok: false, error: 'Backup manifest has no valid format version' };
  }
  if (obj.backupFormatVersion > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      error: `Backup was made by a newer version of the app (format v${obj.backupFormatVersion}; this app understands up to v${BACKUP_FORMAT_VERSION}). Update the app, then restore.`,
    };
  }
  if (!Array.isArray(obj.includes) || obj.includes.length === 0) {
    return { ok: false, error: 'Backup manifest lists no contents' };
  }
  if (!obj.includes.includes('database.sqlite')) {
    return { ok: false, error: 'Backup is incomplete — it has no database snapshot' };
  }
  return { ok: true, manifest: obj };
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  LEGACY_BACKUP_KINDS,
  BACKUP_EXT,
  BACKUP_DIR_NAME,
  BACKUP_DATA_ENTRIES,
  ARCHIVE_TOP_LEVEL_DIRS,
  canonicalizeExistingPath,
  isPathInside,
  safeArchiveEntry,
  resolveSafeDest,
  validateTarListing,
  validateExtractedTree,
  validateSQLiteDatabase,
  backupStamp,
  backupFilename,
  isBackupFilename,
  entriesLookLikeDataDir,
  validateManifest,
};
