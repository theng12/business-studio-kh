/**
 * v0.49.31: local backup / restore.
 *
 * A practical, macOS-local safety net for the destructive/bulk
 * operations in the app (bulk product delete, duplicate-merge purge,
 * re-encode overwrite, data-folder change, etc.). NOT a cloud backup —
 * everything stays on this Mac's disk under the user's control.
 *
 * Design mirrors main/serverBundle.js (which already packages the data
 * folder for cross-Mac migration) so the two share their proven moves:
 *   - SQLite snapshot via better-sqlite3 .backup() — consistent even
 *     while the live connection is writing (no torn WAL pages).
 *   - tar.gz via the system `tar` (zero dependencies on macOS).
 *   - staging dir + copied asset trees with inventory checks so an archive
 *     never follows a live source tree while it is being changed.
 *
 * Where it differs from serverBundle:
 *   - Backups capture the FULL config.json (not just the portable
 *     subset) for reference, but restore only re-applies the portable
 *     keys — the live machine keeps its own dataDir / mode / network
 *     settings, exactly like an imported bundle.
 *   - Backups live in a `backups/` folder (default: under the data
 *     dir; the user can point them elsewhere). That folder is EXCLUDED
 *     from the archive so backups never nest inside backups.
 *   - There's a list/restore lifecycle: we enumerate existing backups,
 *     show size + date, and can restore one in place.
 *
 * Restore strategy (same as serverBundle.importBundle, for the same
 * reason): rename the current data folder aside to a timestamped
 * sibling, recreate it empty, extract the backup into it. Renaming the
 * folder is safe even with the DB connection open — on macOS the open
 * file descriptor follows the inode into the renamed folder, so the
 * dying connection can't write over the freshly-extracted database.
 * The caller relaunches afterward; the new connection opens the
 * restored DB cleanly. We best-effort carry the backups/ folder back
 * into the restored data dir so the user's backup history survives a
 * restore.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BACKUP_DIR_NAME,
  BACKUP_DATA_ENTRIES,
  backupStamp,
  backupFilename,
  isBackupFilename,
  validateManifest,
  resolveSafeDest,
  validateTarListing,
  validateExtractedTree,
} = require('./util/backupSafety');
const { SCHEMA_VERSION } = require('./db');
const {
  snapshotDataTrees,
  copyDataTrees,
} = require('./util/dataSnapshot');

// Config keys that are safe to re-apply on restore. Reuse the exact
// list serverBundle defined so the two stay in lockstep — anything
// machine-specific (dataDir, mode, ports, client creds) is excluded.
const { PORTABLE_CONFIG_KEYS } = require('./serverBundle');

/* ─── small shared helpers ─────────────────────────────────────── */

function runCommand(cmd, args, { onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    onSpawn?.(p);
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (err) => reject(err));
    p.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function snapshotDatabase(destPath) {
  const { getDb } = require('./db');
  const db = getDb();
  // Online backup — walks pager + WAL frames page-by-page, so it's
  // consistent even mid-write. Falls back to nothing: if there's no DB
  // yet (shouldn't happen on a configured install) the caller's
  // existsSync guard already bailed.
  await db.backup(destPath);
}

/**
 * Resolve the folder where backups are written. Defaults to
 * <dataDir>/backups but honours an explicit config.backupsDir if the
 * user pointed backups at another disk (external drive, etc.).
 */
function resolveBackupsDir(cfg) {
  if (cfg?.backupsDir && typeof cfg.backupsDir === 'string') {
    return cfg.backupsDir;
  }
  return path.join(cfg.dataDir, BACKUP_DIR_NAME);
}

/* ─── create ───────────────────────────────────────────────────── */

/**
 * The hidden name an archive is written under until it is complete. The
 * leading dot and the `.partial` suffix both keep it out of
 * isBackupFilename(), so listBackups, retention and restore never see it.
 */
function partialBackupPath(outputPath) {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath);
  return path.join(dir, `.${base}.${process.pid}-${Date.now()}.partial`);
}

/**
 * Write `outputPath` via a temp file in the same folder and rename it into
 * place on success (same folder ⇒ same disk ⇒ atomic). On failure only the
 * temp file — this run's own partial output — is removed, then the error is
 * rethrown. `write(tmpPath)` does the actual writing.
 */
async function writeArchiveAtomically(outputPath, write, job = null) {
  const tmpPath = partialBackupPath(outputPath);
  if (job) job.tmpArchive = tmpPath;
  let renamed = false;
  try {
    await write(tmpPath);
    await fsp.rename(tmpPath, outputPath);
    renamed = true;
    return outputPath;
  } finally {
    if (!renamed) {
      try { await fsp.rm(tmpPath, { force: true }); } catch (_) { /* best effort */ }
    }
    if (job) job.tmpArchive = null;
  }
}

/* In-flight backups, so quitting the app can stop `tar` and clear this run's
 * own temp output (the staging copy and the hidden partial archive). */
const activeJobs = new Set();
let quitHookInstalled = false;

function installQuitCleanup() {
  if (quitHookInstalled || typeof app?.on !== 'function') return;
  quitHookInstalled = true;
  app.on('will-quit', cleanupActiveBackups);
}

/** Stop every running backup and remove its temp files. Synchronous: it runs from will-quit. */
function cleanupActiveBackups() {
  for (const job of activeJobs) {
    job.cancelled = true;
    try { job.child?.kill('SIGTERM'); } catch (_) { /* already gone */ }
    for (const p of [job.tmpArchive, job.stagingRoot]) {
      if (!p) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  }
  activeJobs.clear();
}

/* One backup at a time — a manual one and the automatic one would otherwise
 * each stage a full copy of the data at once. */
let backupQueue = Promise.resolve();
function serializeBackup(fn) {
  const run = backupQueue.then(fn, fn);
  backupQueue = run.then(() => {}, () => {});
  return run;
}

/* ─── free space ─── */

const GB = 1024 ** 3;
const SPACE_MARGIN_BYTES = 200 * 1024 * 1024;

async function freeBytes(dir) {
  if (typeof fsp.statfs !== 'function') return null;
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (_) {
    return null; // unknown → do not block the backup on it
  }
}

/**
 * Whether a backup of `dataBytes` fits: the staging copy needs about the data
 * size, and the archive about the same again (photos barely compress). On one
 * disk both come out of the same free space. A `null` free figure is unknown
 * and never blocks. Returns null when it fits, else { needBytes, freeBytes, where }.
 */
function backupSpaceShortfall({ dataBytes, stagingFree, destFree, sameVolume, stagingDir, destDir }) {
  const each = Math.ceil(Number(dataBytes) * 1.05) + SPACE_MARGIN_BYTES;
  if (sameVolume) {
    const free = destFree ?? stagingFree;
    if (free != null && free < each * 2) return { needBytes: each * 2, freeBytes: free, where: destDir };
    return null;
  }
  if (stagingFree != null && stagingFree < each) return { needBytes: each, freeBytes: stagingFree, where: stagingDir };
  if (destFree != null && destFree < each) return { needBytes: each, freeBytes: destFree, where: destDir };
  return null;
}

function spaceMessage(shortfall, auto) {
  const gb = (n) => (Math.max(0.1, n / GB)).toFixed(1);
  return `Not enough free space for ${auto ? 'an automatic' : 'a'} backup — needs about ${gb(shortfall.needBytes)} GB, `
    + `${gb(shortfall.freeBytes)} GB free on ${shortfall.where}. Free some space or choose another backups folder in Settings → Backups.`;
}

async function sumInventoryBytes(dataDir, treeSnapshot) {
  let total = 0;
  for (const e of treeSnapshot || []) if (e.kind === 'file') total += Number(e.size) || 0;
  for (const f of ['database.sqlite', 'database.sqlite-wal']) {
    try { total += (await fsp.stat(path.join(dataDir, f))).size; } catch (_) { /* absent */ }
  }
  return total;
}

const STAGING_PREFIX = '.iskh-backup-staging-';
const STALE_TEMP_MS = 6 * 3600 * 1000;
// A killed bundle import or restore leaves a full copy of the previous data
// folder beside the live one (`<name>.bak.<ts>` / `<name>.pre-restore.<ts>`).
// It stays the safety copy for a week, then moves aside — never straight out.
const STALE_DATA_COPY_MS = 7 * 24 * 3600 * 1000;
const DATA_COPY_RE = /^(.+)\.(?:bak|pre-restore)\.\d{13}$/;

/** The replaced copies of one data folder; with liveName, only that folder's. */
function dataCopyOf(name, liveName) {
  const m = DATA_COPY_RE.exec(name);
  if (!m) return null;
  return liveName && m[1] !== liveName ? null : m;
}

/**
 * Remove this app's own leftovers from an earlier run that was killed before
 * it could clean up (hidden staging folders, `.partial` archives, bundle
 * extract staging), and move week-old data copies a killed import/restore
 * left behind into `<dir>/_trash/` — only at names this app creates, only
 * untouched ones, and a data copy only once the live folder holds a database.
 */
async function sweepStaleTemp(dir, now = Date.now(), { liveName = null } = {}) {
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return; }
  for (const name of names) {
    const ours = name.startsWith(STAGING_PREFIX)
      || name.startsWith('iskh-bundle-') // killed export/peek staging in the system temp folder
      || name.startsWith('.iskh-bundle-extract-') // killed import staging beside the target
      || /^\.(?:business|media|image)-studio-kh-backup-.+\.partial$/.test(name);
    const dataCopy = ours ? null : dataCopyOf(name, liveName);
    if (!ours && !dataCopy) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.lstat(full);
      if (ours) {
        if (now - st.mtimeMs < STALE_TEMP_MS) continue;
        await fsp.rm(full, { recursive: true, force: true });
        continue;
      }
      // Deleting the copy could be the only surviving data; move it instead,
      // and only when the live folder proves it was replaced by a real one.
      if (now - st.mtimeMs < STALE_DATA_COPY_MS) continue;
      if (!fs.existsSync(path.join(dir, dataCopy[1], 'database.sqlite'))) continue;
      const trashDir = path.join(dir, '_trash', `${new Date(now).toISOString().slice(0, 10)} swept data copies`);
      await fsp.mkdir(trashDir, { recursive: true });
      await fsp.rename(full, path.join(trashDir, name));
    } catch (_) { /* best effort */ }
  }
}

/**
 * Create a backup of the active data folder + config.json. Writes a
 * single .iskhbackup (tar.gz) into the backups folder.
 *
 * @param {object} args
 * @param {string} [args.destDir]  Override the backups folder for this
 *   one backup (e.g. a Save dialog pick). Defaults to resolveBackupsDir.
 * @param {(stage: string) => void} [args.onProgress]
 *   Stages: 'snapshot' | 'manifest' | 'archive' | 'cleanup' | 'done'.
 */
function createBackup(opts = {}) {
  return serializeBackup(() => createBackupNow(opts));
}

async function createBackupNow({ destDir, onProgress, auto = false } = {}) {
  installQuitCleanup();
  const config = require('./config');
  const cfg = config.loadConfig();
  const dataDir = cfg.dataDir;
  if (!dataDir || !fs.existsSync(dataDir)) {
    throw new Error('No data folder configured or it does not exist on disk');
  }

  const backupsDir = destDir || resolveBackupsDir(cfg);
  await fsp.mkdir(backupsDir, { recursive: true });

  const createdAt = Date.now();
  const stamp = backupStamp(new Date(createdAt));
  const fileName = auto ? autoBackupFilename(stamp, app.getVersion()) : backupFilename(stamp, app.getVersion());
  const outputPath = path.join(backupsDir, fileName);

  // Stage into a temp dir (mkdtemp). When the system temp folder is on
  // another disk than the destination (an external backups drive), stage on
  // the destination's disk instead, so the boot disk never has to hold a full
  // copy of the data. A hidden name keeps it out of the backup listing.
  const stageOnDest = !sameDisk(os.tmpdir(), backupsDir);
  const stagingParent = stageOnDest ? backupsDir : os.tmpdir();
  await sweepStaleTemp(backupsDir);
  // Killed exports/imports and restores leave their staging and the replaced
  // data copy elsewhere; sweep those spots too, so a single nightly backup
  // bounds them without waiting for another import to run.
  await sweepStaleTemp(os.tmpdir());
  const dataParent = path.dirname(dataDir);
  if (dataParent !== backupsDir) await sweepStaleTemp(dataParent, Date.now(), { liveName: path.basename(dataDir) });
  const stagingRoot = await fsp.mkdtemp(path.join(stagingParent, stageOnDest ? STAGING_PREFIX : 'iskh-backup-'));
  const stagingName = `iskh-backup-${stamp}`;
  const stagingDir = path.join(stagingRoot, stagingName);
  await fsp.mkdir(stagingDir);
  const job = { child: null, stagingRoot, tmpArchive: null, cancelled: false };
  activeJobs.add(job);

  try {
    // 1. Record the asset trees before the DB snapshot. A backup must
    //    not combine a database snapshot with files from a later write.
    onProgress?.('snapshot');
    const dbSrc = path.join(dataDir, 'database.sqlite');
    const includes = [];
    if (fs.existsSync(dbSrc)) {
      const trees = BACKUP_DATA_ENTRIES.filter((n) => n !== 'database.sqlite');
      const treeSnapshot = await snapshotDataTrees(dataDir, trees);
      // Free space before the copy: staging + archive need about twice the
      // data, and an unattended run must not fill the boot disk.
      const dataBytes = await sumInventoryBytes(dataDir, treeSnapshot);
      const shortfall = backupSpaceShortfall({
        dataBytes,
        stagingFree: await freeBytes(stagingRoot),
        destFree: await freeBytes(backupsDir),
        sameVolume: stageOnDest || sameDisk(stagingRoot, backupsDir),
        stagingDir: stagingParent,
        destDir: backupsDir,
      });
      if (shortfall) {
        const err = new Error(spaceMessage(shortfall, auto));
        err.code = 'BACKUP_NO_SPACE';
        throw err;
      }
      await snapshotDatabase(path.join(stagingDir, 'database.sqlite'));
      const includedTrees = await copyDataTrees(dataDir, stagingDir, trees, treeSnapshot);
      includes.push('database.sqlite');
      for (const name of includedTrees) includes.push(name + '/');
    } else {
      // No DB yet — refuse, because a "backup" with no database isn't
      // worth restoring and would fail validation on the way back in.
      throw new Error('No database found in the data folder — nothing to back up yet');
    }

    // 2. Full config.json copy (informational + portable-key restore).
    onProgress?.('manifest');
    const cfgPath = config.configPath();
    if (fs.existsSync(cfgPath)) {
      await fsp.copyFile(cfgPath, path.join(stagingDir, 'config.json'));
      includes.push('config.json');
    }

    const manifest = {
      kind: BACKUP_KIND,
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      appVersion: app.getVersion(),
      createdAt,
      ...(auto ? { automatic: true } : {}),
      sourceDataDir: dataDir,   // informational; restore uses the live dataDir
      includes,
    };
    await fsp.writeFile(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // 4. Pack the regular-file staging tree; live data is never
    //    referenced from the archive operation. The archive is written
    //    under a hidden temp name and renamed into place only once tar has
    //    finished, so a full disk or a quit mid-pack never leaves a
    //    truncated file that lists (and counts) as a good backup.
    onProgress?.('archive');
    if (job.cancelled) throw new Error('Backup cancelled: the app is quitting');
    await writeArchiveAtomically(outputPath, (tmpPath) =>
      runCommand('tar', ['-czf', tmpPath, '-C', stagingRoot, stagingName], { onSpawn: (child) => { job.child = child; } }), job);

    onProgress?.('done');
    const stat = await fsp.stat(outputPath);
    return {
      backupPath: outputPath,
      fileName,
      sizeBytes: stat.size,
      createdAt,
      includes,
      backupsDir,
    };
  } finally {
    activeJobs.delete(job);
    onProgress?.('cleanup');
    try { await fsp.rm(stagingRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * The local time stamped into a backup filename by backupStamp()
 * (YYYY-MM-DD-HHmm), in ms — or null when the name has none or it is not a
 * real date. The last such stamp in the name wins.
 */
function backupTimeFromName(name) {
  const matches = [...String(name || '').matchAll(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/g)];
  const m = matches[matches.length - 1];
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || t.getHours() !== h || t.getMinutes() !== mi) return null;
  return t.getTime();
}

/* ─── list ─────────────────────────────────────────────────────── */

/**
 * Enumerate backups in the backups folder, newest first. Pure listing
 * — reads the file's mtime + size and (cheaply, via the filename)
 * recognises ours. We do NOT crack open each archive's manifest here
 * (that's a tar spawn per file); the renderer asks for a manifest
 * preview only when the user is about to restore a specific one.
 */
async function listBackups() {
  const config = require('./config');
  const cfg = config.loadConfig();
  const backupsDir = resolveBackupsDir(cfg);
  let names;
  try {
    names = await fsp.readdir(backupsDir);
  } catch (err) {
    // No folder yet (fresh install): still report the automatic-backup
    // status, or a client reads its absence as an out-of-date server.
    if (err.code === 'ENOENT') return { backupsDir, backups: [], autoBackup: autoBackupStatus(cfg, backupsDir, []) };
    throw err;
  }
  const backups = [];
  for (const name of names) {
    if (!isBackupFilename(name)) continue;
    const full = path.join(backupsDir, name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) continue;
      backups.push({
        fileName: name,
        backupPath: full,
        sizeBytes: stat.size,
        // The time in the FILENAME, not the file's birth time: a restore or
        // a data-folder move copies the backups folder, and every copy is
        // "born" in copy order — retention then trashed the newest backup and
        // the next automatic one was pushed back a week. mtime only when the
        // name carries no readable time (a renamed file).
        createdAt: backupTimeFromName(name) ?? Math.round(stat.mtimeMs || 0),
        auto: isAutoBackupName(name),
      });
    } catch (_) { /* skip unreadable */ }
  }
  backups.sort((a, b) => b.createdAt - a.createdAt);
  return { backupsDir, backups, autoBackup: autoBackupStatus(cfg, backupsDir, backups) };
}

/* ─── automatic weekly backups ─────────────────────────────────── */

/**
 * 0.1.94 — owner's decision: a weekly automatic backup while the app is
 * open, keeping the newest four automatic ones.
 *
 *   - Checked shortly after launch and every few hours after that; when the
 *     newest AUTOMATIC backup in the backups folder is 7+ days old (or there
 *     is none), one is made in the background.
 *   - Automatic backups are told apart by their filename
 *     (`business-studio-kh-backup-auto-…`), which isBackupFilename() already
 *     accepts, so they list and restore like any other.
 *   - Retention only ever touches automatic backups: the oldest beyond four
 *     go to the macOS Trash (main/util/fileTrash.js — never erased). A
 *     backup the user made by hand is never pruned.
 *   - Only the Mac that holds the data runs it: main/index.js starts the
 *     scheduler on the standalone / server boot path, and the check refuses
 *     client mode too, in case that ever changes.
 *   - It runs as a tracked operation, so a restore or data-folder move waits
 *     for it instead of moving the folder out from under the archive.
 */
const AUTO_BACKUP_INTERVAL_MS = 7 * 24 * 3600 * 1000;
const AUTO_BACKUP_KEEP = 4;
const AUTO_BACKUP_CHECK_MS = 3 * 3600 * 1000;
const AUTO_BACKUP_FIRST_CHECK_MS = 2 * 60 * 1000;
const AUTO_PREFIX = 'business-studio-kh-backup-auto-';
// A write into the data folder during the copy fails the snapshot check; on a
// busy day that is common, so an automatic run retries sooner than the next
// 3-hour check — a few times a day at most.
const AUTO_BACKUP_RETRY_MS = 30 * 60 * 1000;
const AUTO_BACKUP_MAX_RETRIES_PER_DAY = 4;
const RETRYABLE_BACKUP_ERROR = /Data folder changed during|Staged data does not match the source snapshot/;

function autoBackupFilename(stamp, appVersion) {
  return backupFilename(stamp, appVersion).replace('business-studio-kh-backup-', AUTO_PREFIX);
}

function isAutoBackupName(name) {
  return typeof name === 'string' && name.startsWith(AUTO_PREFIX) && isBackupFilename(name);
}

/**
 * Newest automatic backup's time, or null. A backup dated after `now` (the
 * clock was set back, or a file was copied in) is ignored: counting it as
 * the newest would either postpone backups until that date or — as it did
 * before — make every 3-hour check "due" and churn the retention slots.
 */
function lastAutoBackupAt(backups, now = Date.now()) {
  let best = null;
  for (const b of backups || []) {
    if (!(b.auto ?? isAutoBackupName(b.fileName))) continue;
    const at = Number(b.createdAt);
    if (!Number.isFinite(at) || at > now) continue;
    if (best == null || at > best) best = at;
  }
  return best;
}

/** True when an automatic backup should run now. */
function autoBackupDue({ lastAutoAt, now = Date.now(), intervalMs = AUTO_BACKUP_INTERVAL_MS } = {}) {
  if (lastAutoAt == null || !Number.isFinite(Number(lastAutoAt))) return true;
  // A future time counts as "just made" (clamped to now). lastAutoBackupAt
  // already skips future-dated files, so this only guards direct callers.
  const last = Math.min(Number(lastAutoAt), now);
  return now - last >= intervalMs;
}

/**
 * The automatic backups to retire: every automatic one beyond the newest
 * `keep`, oldest last. Manual backups are never in the result.
 *
 * Future-dated automatic backups (later than `now`) are neither counted
 * toward `keep` nor retired: one may be the newest real backup (the clock
 * went backwards), and letting it hold a slot would let each new backup push
 * a good older one into the Trash. `justMade` (a backupPath) is always kept
 * and counted first, whatever its timestamp says.
 */
function autoBackupsToPrune(backups, { keep = AUTO_BACKUP_KEEP, now = Date.now(), justMade = null } = {}) {
  const isJustMade = (b) => justMade != null && b.backupPath === justMade;
  const autos = (backups || [])
    .filter((b) => b.auto ?? isAutoBackupName(b.fileName))
    .filter((b) => isJustMade(b) || !(Number(b.createdAt) > now))
    .sort((a, b) => (isJustMade(b) - isJustMade(a)) || (b.createdAt - a.createdAt));
  return autos.slice(Math.max(0, keep));
}

/** True when the two paths live on the same disk (the nearest existing ancestor of each). */
function sameDisk(a, b) {
  const devOf = (p) => {
    let cur = path.resolve(p);
    for (;;) {
      try { return fs.statSync(cur).dev; } catch (_) { /* climb */ }
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  };
  const da = devOf(a);
  const db = devOf(b);
  return da != null && db != null && da === db;
}

const autoState = {
  running: false, lastError: null, lastErrorAt: null, timer: null, firstTimer: null,
  retryTimer: null, retries: { day: null, count: 0 },
};

/**
 * How soon to retry an automatic backup that failed with `message`, or null
 * to wait for the regular check. Only the "data changed while copying" error
 * is retried early, at most AUTO_BACKUP_MAX_RETRIES_PER_DAY times per day.
 * Returns the delay and the updated per-day count.
 */
function autoRetryPlan(message, retries, now) {
  const day = new Date(now).toDateString();
  const count = retries?.day === day ? retries.count : 0;
  if (!RETRYABLE_BACKUP_ERROR.test(String(message || ''))) return { retryInMs: null, retries: { day, count } };
  if (count >= AUTO_BACKUP_MAX_RETRIES_PER_DAY) return { retryInMs: null, retries: { day, count } };
  return { retryInMs: AUTO_BACKUP_RETRY_MS, retries: { day, count: count + 1 } };
}

function autoBackupStatus(cfg, backupsDir, backups) {
  const lastAt = lastAutoBackupAt(backups, Date.now());
  return {
    enabled: cfg?.autoBackupEnabled !== false,
    intervalDays: AUTO_BACKUP_INTERVAL_MS / (24 * 3600 * 1000),
    keep: AUTO_BACKUP_KEEP,
    lastAt,
    nextDueAt: lastAt == null ? null : lastAt + AUTO_BACKUP_INTERVAL_MS,
    running: autoState.running,
    lastError: autoState.lastError,
    lastErrorAt: autoState.lastErrorAt,
    // "Same disk as the data" is the real risk (one drive failing takes both);
    // a backups folder inside the data folder is the default case of it.
    sameDiskAsData: cfg?.dataDir ? sameDisk(backupsDir, cfg.dataDir) : false,
  };
}

/**
 * Make an automatic backup if one is due, then retire automatic backups
 * beyond the newest four. Never throws: a failure is logged and remembered
 * for Settings, and the next check retries.
 *
 * `deps` lets a test supply the pieces; production passes nothing.
 */
async function runAutoBackupIfDue({ now = Date.now(), log = () => {}, deps = {} } = {}) {
  const config = deps.config || require('./config');
  const list = deps.listBackups || listBackups;
  const create = deps.createBackup || createBackup;
  const trash = deps.trashPath || require('./util/fileTrash').trashPath;
  const track = deps.runTracked || ((fn) => {
    const lifecycle = require('./util/maintenanceLifecycle');
    if (lifecycle.isMaintenanceActive()) return { skipped: 'maintenance' };
    return lifecycle.runTrackedOperation('backups:auto', fn);
  });
  if (autoState.running) return { skipped: 'running' };
  const cfg = config.loadConfig();
  if (cfg.mode === 'client') return { skipped: 'client' };
  if (cfg.autoBackupEnabled === false) return { skipped: 'disabled' };
  autoState.running = true;
  try {
    // The whole check — listing, the backup AND the retention that follows —
    // runs as ONE tracked operation, so a restore or data-folder move cannot
    // start while old backups are still being moved to the Trash.
    const outcome = await track(async () => {
      const before = await list();
      let created = null;
      if (autoBackupDue({ lastAutoAt: lastAutoBackupAt(before.backups, now), now })) {
        // A custom folder on an external drive that is not plugged in: making
        // it would quietly create /Volumes/<drive>/… on the internal disk.
        if (cfg.backupsDir && !(deps.exists || fs.existsSync)(cfg.backupsDir)) {
          throw new Error(`The backups folder is not available: ${cfg.backupsDir}. Connect the drive, or choose another folder in Settings → Backups.`);
        }
        created = await create({ auto: true });
        log('backup:auto', `${created.fileName} ${created.sizeBytes} bytes`);
      }
      const after = created ? await list() : before;
      const pruned = [];
      const toPrune = autoBackupsToPrune(after.backups, { now, justMade: created?.backupPath ?? null });
      for (const old of toPrune) {
        const outcome = await trash(old.backupPath);
        pruned.push({ fileName: old.fileName, outcome });
        log('backup:auto-retired', `${old.fileName} → ${outcome}`);
      }
      return { created, pruned };
    });
    if (outcome?.skipped) return outcome;
    // Only a backup that was actually made clears an earlier failure; a
    // "not due yet" check proves nothing and must not hide the error.
    if (outcome?.created) {
      autoState.lastError = null;
      autoState.lastErrorAt = null;
    }
    return outcome;
  } catch (err) {
    autoState.lastError = err.message;
    autoState.lastErrorAt = now;
    log('backup:auto-failed', err.message);
    const plan = autoRetryPlan(err.message, autoState.retries, now);
    autoState.retries = plan.retries;
    return plan.retryInMs ? { error: err.message, retryInMs: plan.retryInMs } : { error: err.message };
  } finally {
    autoState.running = false;
  }
}

/** Start the weekly check (first one a couple of minutes after launch). Returns a stop function. */
function startAutoBackupScheduler({ log = () => {} } = {}) {
  stopAutoBackupScheduler();
  const tick = () => {
    runAutoBackupIfDue({ log }).then((res) => {
      if (!res?.retryInMs || !autoState.timer) return;
      clearTimeout(autoState.retryTimer);
      autoState.retryTimer = setTimeout(tick, res.retryInMs);
      autoState.retryTimer.unref?.();
    }).catch(() => { /* never throws; belt-and-braces */ });
  };
  autoState.firstTimer = setTimeout(tick, AUTO_BACKUP_FIRST_CHECK_MS);
  autoState.timer = setInterval(tick, AUTO_BACKUP_CHECK_MS);
  autoState.firstTimer.unref?.();
  autoState.timer.unref?.();
  return stopAutoBackupScheduler;
}

function stopAutoBackupScheduler() {
  clearTimeout(autoState.firstTimer);
  clearInterval(autoState.timer);
  clearTimeout(autoState.retryTimer);
  autoState.firstTimer = null;
  autoState.timer = null;
  autoState.retryTimer = null;
}

/** The single most-recent backup (or null). Cheap call for the "last backup was…" affordance. */
async function lastBackup() {
  const { backups } = await listBackups();
  return backups[0] ?? null;
}

/* ─── preview ──────────────────────────────────────────────────── */

/**
 * Extract just the manifest from a backup and validate it. Returns the
 * parsed manifest (+ bundlePath/size) or throws a user-readable error.
 */
async function previewBackup(backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error('Backup file not found');
  }
  const { stdout: names } = await runCommand('tar', ['-tzf', backupPath]);
  const { stdout: verbose } = await runCommand('tar', ['-tvzf', backupPath]);
  const listing = validateTarListing(names, verbose);
  const prefix = listing.rootName;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-backup-peek-'));
  try {
    await runCommand('tar', ['-xzf', backupPath, '-C', tmpDir, `${prefix}/manifest.json`]);
    const manifestText = await fsp.readFile(path.join(tmpDir, prefix, 'manifest.json'), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(manifestText);
    } catch (err) {
      throw new Error(`Backup manifest is malformed JSON: ${err.message}`, { cause: err });
    }
    const check = validateManifest(parsed);
    if (!check.ok) throw new Error(check.error);
    const stat = await fsp.stat(backupPath);
    return { ...parsed, backupPath, backupSizeBytes: stat.size };
  } finally {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ─── restore ──────────────────────────────────────────────────── */

/**
 * Restore a backup over the live data folder. The caller is
 * responsible for getting explicit user consent (this REPLACES the
 * data folder) and for relaunching the app afterward — the running
 * SQLite connection still holds the old DB's handle, so the restored
 * DB only takes effect on next launch.
 *
 * Safety:
 *   - Validates the manifest before touching anything.
 *   - Every extracted entry is path-checked (resolveSafeDest) so a
 *     corrupt archive can't escape the data folder.
 *   - The existing data folder is RENAMED aside (not deleted) to a
 *     timestamped sibling, so the user can recover from Finder if the
 *     restore turns out wrong. Nothing of theirs is destroyed.
 *
 * @param {object} args
 * @param {string} args.backupPath
 * @param {(stage: string) => void} [args.onProgress]
 *   Stages: 'verify' | 'safety-copy' | 'extract' | 'merge-config' | 'done'.
 */
async function restoreBackup({ backupPath, onProgress, runReplacement } = {}) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error('Backup file not found');
  }
  const config = require('./config');
  const cfg = config.loadConfig();
  const dataDir = cfg.dataDir;
  if (!dataDir) throw new Error('No data folder configured');

  onProgress?.('verify');
  const manifest = await previewBackup(backupPath); // throws on invalid

  // Extract into a temp staging dir FIRST, validate every entry, then
  // swap it in. This means a corrupt archive fails before we've
  // touched the live data folder at all.
  onProgress?.('extract');
  // Keep staging beside the configured data folder so the final moves stay
  // on one filesystem (the folder may be on an external drive).
  const dataParent = path.dirname(path.resolve(dataDir));
  await fsp.mkdir(dataParent, { recursive: true });
  const tmpRoot = await fsp.mkdtemp(path.join(dataParent, '.iskh-restore-'));
  let safetyDir = null;
  let previousPortableConfig = null;
  try {
    await runCommand('tar', ['-xzf', backupPath, '-C', tmpRoot]);
    const tmpEntries = await fsp.readdir(tmpRoot);
    if (tmpEntries.length !== 1) {
      throw new Error('Backup structure unexpected (expected a single top-level folder)');
    }
    const backupRoot = path.join(tmpRoot, tmpEntries[0]);

    // Validate the extracted tree before renaming the live data folder. This
    // catches links/special files that tar listings may represent differently
    // on another native implementation and proves the staged DB is usable.
    await validateExtractedTree(backupRoot, { expectedSchemaVersion: SCHEMA_VERSION });

    // Path-check every entry we're about to bring in. resolveSafeDest
    // throws on any traversal/escape — belt-and-braces over the archive
    // listing and extracted-tree checks above.
    const restoredEntries = await fsp.readdir(backupRoot);
    for (const ent of restoredEntries) {
      resolveSafeDest(dataDir, ent); // validates; we move dirs wholesale below
    }

    const install = async () => {
      onProgress?.('safety-copy');
      const existedBefore = fs.existsSync(dataDir);
      if (existedBefore) {
        safetyDir = `${dataDir}.pre-restore.${Date.now()}`;
        await fsp.rename(dataDir, safetyDir);
      }
      await fsp.mkdir(dataDir, { recursive: true });

      // Move each restored entry into the (now empty) data folder.
      for (const ent of restoredEntries) {
        const src = path.join(backupRoot, ent);
        const dst = resolveSafeDest(dataDir, ent);
        await fsp.rename(src, dst);
      }

      // Carry the user's backup history back into the restored folder so
      // a restore doesn't hide their other backups. Best-effort; the
      // safety copy still holds them if this fails.
      if (safetyDir) {
        const oldBackups = path.join(safetyDir, BACKUP_DIR_NAME);
        const newBackups = path.join(dataDir, BACKUP_DIR_NAME);
        try {
          if (fs.existsSync(oldBackups) && !fs.existsSync(newBackups)) {
            await fsp.cp(oldBackups, newBackups, { recursive: true, preserveTimestamps: true });
          }
        } catch (_) { /* leave history in the safety copy */ }
      }

      // Re-apply ONLY the portable config keys from the backup's
      // config.json (AI keys, presets, export prefs). Never touches
      // dataDir / mode / network — the live machine keeps those.
      onProgress?.('merge-config');
      const restoredCfgPath = path.join(dataDir, 'config.json');
      if (fs.existsSync(restoredCfgPath)) {
        let restoredCfg = null;
        try {
          restoredCfg = JSON.parse(await fsp.readFile(restoredCfgPath, 'utf8'));
        } catch (err) {
          process.stderr.write(`[backup restore] backed-up config.json malformed (${err.message}) — skipping config merge\n`);
        }
        if (restoredCfg && typeof restoredCfg === 'object') {
          const merged = {};
          for (const k of PORTABLE_CONFIG_KEYS) {
            if (restoredCfg[k] !== undefined) merged[k] = restoredCfg[k];
          }
          if (Object.keys(merged).length > 0) {
            const previous = config.loadConfig();
            previousPortableConfig = Object.fromEntries(Object.keys(merged).map((key) => [key, previous[key]]));
            config.updateConfig(merged);
          }
        }
        // The restored config.json sits inside the data folder, which
        // is NOT where the app reads config from (that's userData). It's
        // harmless to leave as a record of what was restored.
      }

      onProgress?.('done');
      return {
        success: true,
        restoredManifest: manifest,
        dataDir,
        safetyDir,   // where the prior data was moved (null if data dir was empty)
      };
    };
    // Keep rollback inside maintenance, before it reopens the original DB.
    const replace = async () => {
      try {
        return await install();
      } catch (err) {
        const failures = [];
        if (safetyDir && fs.existsSync(safetyDir)) {
          try {
            await fsp.rm(dataDir, { recursive: true, force: true });
            await fsp.rename(safetyDir, dataDir);
          } catch (rollbackErr) { failures.push(rollbackErr.message); }
        }
        if (previousPortableConfig) {
          try { config.updateConfig(previousPortableConfig); }
          catch (rollbackErr) { failures.push(rollbackErr.message); }
        }
        if (failures.length) {
          const originalPath = safetyDir && fs.existsSync(safetyDir) ? safetyDir : dataDir;
          const recoveryError = new Error(
            `${err.message} Recovery failed: ${failures.join('; ')}. Original data: ${originalPath}. Quit and recover the original data and settings before reopening.`,
            { cause: err },
          );
          recoveryError.code = 'MAINTENANCE_ROLLBACK_FAILED';
          throw recoveryError;
        }
        throw err;
      }
    };
    return await (runReplacement ? runReplacement(replace) : replace());
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  createBackup,
  listBackups,
  lastBackup,
  previewBackup,
  restoreBackup,
  resolveBackupsDir,
  writeArchiveAtomically,
  backupTimeFromName,
  backupSpaceShortfall,
  cleanupActiveBackups,
  autoRetryPlan,
  AUTO_BACKUP_RETRY_MS,
  AUTO_BACKUP_MAX_RETRIES_PER_DAY,
  // test seams
  _internals: { activeJobs, runCommand, serializeBackup, sweepStaleTemp },
  // 0.1.94 automatic weekly backups
  AUTO_BACKUP_INTERVAL_MS,
  AUTO_BACKUP_KEEP,
  autoBackupFilename,
  isAutoBackupName,
  autoBackupDue,
  autoBackupsToPrune,
  lastAutoBackupAt,
  runAutoBackupIfDue,
  startAutoBackupScheduler,
  stopAutoBackupScheduler,
};
