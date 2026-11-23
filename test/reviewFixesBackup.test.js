/**
 * Review fixes 11–13 — automatic backups (main/backupManager.js). Pure JS:
 * the database snapshot is never reached, so this runs under `npm test`.
 *
 *   11. An archive is written under a hidden `.partial` name and renamed into
 *       place only when complete. A failed write leaves no file that lists,
 *       counts as "the newest automatic backup", or takes a retention slot —
 *       and a "not due" check no longer wipes the failure from Settings.
 *   12. A future-dated automatic backup (clock set back, file copied in)
 *       neither makes every 3-hour check due nor lets each new backup push a
 *       good older one into the Trash.
 *   13. Retention runs INSIDE the tracked operation, so a restore or a
 *       data-folder move cannot start while files are being trashed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { isBackupFilename } = require('../main/util/backupSafety');

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

// listBackups() reads the config lazily; point it at a temp folder.
const fakeConfig = { cfg: null, loadConfig: () => fakeConfig.cfg };
const configPath = require.resolve('../main/config');
const fakeModule = new Module(configPath, module);
fakeModule.filename = configPath;
fakeModule.loaded = true;
fakeModule.exports = fakeConfig;
require.cache[configPath] = fakeModule;

function loadBackupManager() {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getVersion: () => '0.1.94' } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../main/backupManager'); }
  finally { Module._load = originalLoad; }
}
const b = loadBackupManager();

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ─── 11: atomic archive writes ─────────────────────────────────── */

test('an archive appears under its real name only when complete; a failed write leaves nothing behind', async () => {
  const dir = tmpDir('rf-backup-atomic-');
  const finalPath = path.join(dir, b.autoBackupFilename('2026-10-08-0900', '0.1.94'));

  // Failure part-way through (disk full, quit): the truncated temp file is
  // removed and no file with the backup name exists.
  let seenTmp = null;
  await assert.rejects(
    b.writeArchiveAtomically(finalPath, async (tmp) => {
      seenTmp = tmp;
      fs.writeFileSync(tmp, 'truncated tar.gz');
      throw new Error('ENOSPC: no space left on device');
    }),
    /ENOSPC/,
  );
  assert.equal(path.dirname(seenTmp), dir, 'temp file sits beside the result (same disk → atomic rename)');
  assert.equal(isBackupFilename(path.basename(seenTmp)), false, 'the temp name is never listed as a backup');
  assert.deepEqual(fs.readdirSync(dir), [], 'only our own partial output was removed, and it was');

  // A failure leaves an EXISTING file of the same name alone.
  fs.writeFileSync(finalPath, 'good backup');
  await assert.rejects(b.writeArchiveAtomically(finalPath, async () => { throw new Error('tar exited 1'); }));
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'good backup');
  fs.unlinkSync(finalPath);

  // Success: the result is renamed into place, no temp left.
  await b.writeArchiveAtomically(finalPath, async (tmp) => { fs.writeFileSync(tmp, 'complete'); });
  assert.deepEqual(fs.readdirSync(dir), [path.basename(finalPath)]);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'complete');
});

test('createBackup (manual and automatic) packs through the atomic writer, never straight into the final name', () => {
  const src = read('main/backupManager.js');
  const create = src.slice(src.indexOf('async function createBackupNow('), src.indexOf('/**\n * The local time stamped'));
  assert.ok(create.length > 100);
  assert.match(create, /writeArchiveAtomically\(outputPath, \(tmpPath\) =>\s*runCommand\('tar', \['-czf', tmpPath,/);
  assert.doesNotMatch(create, /'-czf', outputPath/);
});

test('a failed automatic backup is not counted, keeps its error through a "not due" check, and clears only on success', async () => {
  const dataDir = tmpDir('rf-backup-data-');
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir);
  fakeConfig.cfg = { dataDir, mode: 'standalone', autoBackupEnabled: true };
  const now = Date.now();

  // A leftover partial (an earlier quit mid-pack) is invisible to the listing.
  fs.writeFileSync(path.join(backupsDir, `.${b.autoBackupFilename('2026-10-08-0900', '0.1.94')}.123-1.partial`), 'x');
  const listed = await b.listBackups();
  assert.deepEqual(listed.backups, []);
  assert.equal(b.autoBackupDue({ lastAutoAt: b.lastAutoBackupAt(listed.backups, now), now }), true);

  const trashed = [];
  const base = {
    listBackups: b.listBackups,
    trashPath: async (p) => { trashed.push(p); return 'trashed'; },
    runTracked: (fn) => fn(),
    exists: () => true,
  };

  // 1. The archive fails part-way → error recorded, nothing listed.
  const failed = await b.runAutoBackupIfDue({
    now,
    deps: {
      ...base,
      createBackup: async () => b.writeArchiveAtomically(
        path.join(backupsDir, b.autoBackupFilename('2026-10-08-1000', '0.1.94')),
        async (tmp) => { fs.writeFileSync(tmp, 'half'); throw new Error('disk full'); },
      ),
    },
  });
  assert.equal(failed.error, 'disk full');
  assert.equal((await b.listBackups()).autoBackup.lastError, 'disk full');
  assert.equal((await b.listBackups()).backups.length, 0, 'the truncated file never became a backup');

  // 2. A check that finds nothing due (a manual-looking recent automatic
  //    backup dropped in by hand) must NOT erase the failure from Settings.
  const notDueDeps = {
    ...base,
    listBackups: async () => ({ backups: [{ fileName: 'business-studio-kh-backup-auto-v1-x.iskhbackup', backupPath: '/x', createdAt: now - DAY, auto: true }] }),
    createBackup: async () => { throw new Error('must not run'); },
  };
  const notDue = await b.runAutoBackupIfDue({ now, deps: notDueDeps });
  assert.equal(notDue.created, null);
  assert.equal((await b.listBackups()).autoBackup.lastError, 'disk full', 'still shown');

  // 3. A real backup clears it.
  const ok = await b.runAutoBackupIfDue({
    now,
    deps: {
      ...base,
      createBackup: async () => {
        const fileName = b.autoBackupFilename('2026-10-08-1100', '0.1.94');
        const out = path.join(backupsDir, fileName);
        await b.writeArchiveAtomically(out, async (tmp) => { fs.writeFileSync(tmp, 'ok'); });
        return { fileName, backupPath: out, sizeBytes: 2 };
      },
    },
  });
  assert.ok(ok.created);
  const after = await b.listBackups();
  assert.equal(after.autoBackup.lastError, null);
  assert.equal(after.backups.length, 1);
  assert.deepEqual(trashed, []);
});

/* ─── 12: future-dated automatic backups ─────────────────────────── */

function harness(initial, now0) {
  let files = [...initial];
  const calls = { created: 0, trashed: [], inside: false, trashedOutside: 0 };
  let clock = now0;
  const deps = {
    config: { loadConfig: () => ({ dataDir: '/data', mode: 'standalone', autoBackupEnabled: true }) },
    listBackups: async () => ({ backups: [...files].sort((x, y) => y.createdAt - x.createdAt) }),
    createBackup: async () => {
      calls.created += 1;
      const fresh = { fileName: `business-studio-kh-backup-auto-v1-n${calls.created}.iskhbackup`, backupPath: `/b/new-${calls.created}`, createdAt: clock, auto: true, sizeBytes: 1 };
      files.push(fresh);
      return fresh;
    },
    trashPath: async (p) => {
      if (!calls.inside) calls.trashedOutside += 1;
      calls.trashed.push(p);
      files = files.filter((f) => f.backupPath !== p);
      return 'trashed';
    },
    runTracked: async (fn) => {
      calls.inside = true;
      try { return await fn(); } finally { calls.inside = false; }
    },
    exists: () => true,
  };
  return { deps, calls, files: () => files, tick: (ms) => { clock += ms; return clock; } };
}

const auto = (name, createdAt) => ({ fileName: `business-studio-kh-backup-auto-v1-${name}.iskhbackup`, backupPath: `/b/${name}`, createdAt, auto: true });

test('a future-dated automatic backup does not make every 3-hour check due', async () => {
  const now = Date.UTC(2026, 9, 8, 9);
  const future = auto('future', now + 90 * DAY);
  const h = harness([future, auto('w1', now - 8 * DAY), auto('w2', now - 15 * DAY), auto('w3', now - 22 * DAY)], now);

  // Due: the newest backup that is not in the future is 8 days old.
  await b.runAutoBackupIfDue({ now, deps: h.deps });
  assert.equal(h.calls.created, 1);
  // A day of 3-hourly checks after that: nothing new (it used to back up and
  // retire a good backup on every single one).
  for (let i = 0; i < 8; i += 1) await b.runAutoBackupIfDue({ now: h.tick(3 * HOUR), deps: h.deps });
  assert.equal(h.calls.created, 1);
  assert.deepEqual(h.calls.trashed, []);
  assert.ok(h.files().some((f) => f.backupPath === '/b/future'), 'the future-dated file is kept (it may be the newest real data)');
});

test('retention: the just-made backup never sends a good one to the Trash because a future-dated one holds a slot', async () => {
  const now = Date.UTC(2026, 9, 8, 9);
  const future = auto('future', now + 30 * DAY);
  // 4 automatic files before the run (future + 3 good) → count − keep = 0, so
  // making a 5th must trash nothing. The old code sorted the future file as
  // newest, kept it plus three, and retired w3.
  const h = harness([future, auto('w1', now - 7 * DAY), auto('w2', now - 14 * DAY), auto('w3', now - 21 * DAY)], now);
  const res = await b.runAutoBackupIfDue({ now, deps: h.deps });
  assert.equal(h.calls.created, 1);
  assert.deepEqual(res.pruned, []);
  assert.deepEqual(h.calls.trashed, []);

  // With 4 good + the future one (5 before the run, count − keep = 1), a new
  // backup retires exactly one — the oldest good one — never the new one and
  // never the future-dated one.
  const h2 = harness([future, auto('w1', now - 7 * DAY), auto('w2', now - 14 * DAY), auto('w3', now - 21 * DAY), auto('w4', now - 28 * DAY)], now);
  await b.runAutoBackupIfDue({ now, deps: h2.deps });
  assert.deepEqual(h2.calls.trashed, ['/b/w4']);

  // Pure rule: the just-made one is kept even when its own timestamp reads
  // later than `now` (the archive finished after the check started).
  const late = auto('late', now + 5 * 60 * 1000);
  const prune = b.autoBackupsToPrune(
    [future, late, auto('w1', now - 7 * DAY), auto('w2', now - 14 * DAY), auto('w3', now - 21 * DAY), auto('w4', now - 28 * DAY)],
    { now, justMade: '/b/late' },
  );
  assert.deepEqual(prune.map((x) => x.backupPath), ['/b/w4']);
});

/* ─── 13: retention inside the tracked operation ────────────────── */

test('retention runs inside the tracked operation, so a restore cannot start mid-trash', async () => {
  const now = Date.UTC(2026, 9, 8, 9);
  const h = harness([1, 2, 3, 4, 5].map((w) => auto(`w${w}`, now - w * 7 * DAY)), now);
  const res = await b.runAutoBackupIfDue({ now, deps: h.deps });
  assert.equal(h.calls.created, 1);
  assert.deepEqual(h.calls.trashed, ['/b/w4', '/b/w5']);
  assert.equal(h.calls.trashedOutside, 0, 'every trash call happened while the operation was tracked');
  assert.equal(res.pruned.length, 2);

  // Maintenance active: nothing listed, made or trashed.
  const blocked = harness([1, 2, 3, 4, 5, 6].map((w) => auto(`w${w}`, now - w * 7 * DAY)), now);
  blocked.deps.runTracked = () => ({ skipped: 'maintenance' });
  assert.deepEqual(await b.runAutoBackupIfDue({ now, deps: blocked.deps }), { skipped: 'maintenance' });
  assert.deepEqual(blocked.calls.trashed, []);
});

/* ─── 29: order by the filename's time, not the copy's birth time ── */

test('backups are ordered and dated by the time in their filename, so a copied backups folder keeps its order', async () => {
  assert.equal(b.backupTimeFromName('business-studio-kh-backup-auto-v0.1.94-2026-10-08-0905.iskhbackup'), new Date(2026, 9, 8, 9, 5).getTime());
  assert.equal(b.backupTimeFromName('image-studio-kh-backup-v0.49.1-2025-01-31-2359.iskhbackup'), new Date(2025, 0, 31, 23, 59).getTime());
  assert.equal(b.backupTimeFromName('business-studio-kh-backup-renamed.iskhbackup'), null);
  assert.equal(b.backupTimeFromName('business-studio-kh-backup-v1-2026-02-30-1200.iskhbackup'), null, 'not a real date');

  const dataDir = tmpDir('rf-backup-order-');
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir);
  fakeConfig.cfg = { dataDir, mode: 'standalone', autoBackupEnabled: true };
  // Written newest-first, the way a copy can land them: birth times are now
  // the reverse of the real order.
  const names = ['2026-10-08-0900', '2026-10-01-0900', '2026-09-24-0900', '2026-09-17-0900', '2026-09-10-0900']
    .map((stamp) => b.autoBackupFilename(stamp, '0.1.94'));
  for (const name of names) fs.writeFileSync(path.join(backupsDir, name), 'x');
  const renamed = 'business-studio-kh-backup-auto-renamed.iskhbackup';
  fs.writeFileSync(path.join(backupsDir, renamed), 'x');
  const old = new Date(2026, 0, 1);
  fs.utimesSync(path.join(backupsDir, renamed), old, old);

  const { backups } = await b.listBackups();
  assert.deepEqual(backups.map((x) => x.fileName), [...names, renamed], 'newest name first; an unstamped file falls back to its mtime');
  const now = new Date(2026, 9, 9).getTime();
  assert.equal(b.lastAutoBackupAt(backups, now), new Date(2026, 9, 8, 9, 0).getTime());
  assert.equal(b.autoBackupDue({ lastAutoAt: b.lastAutoBackupAt(backups, now), now }), false, 'a copy does not reset the weekly clock');
  // Retention retires the OLDEST by name (and the renamed January file), never the newest.
  assert.deepEqual(b.autoBackupsToPrune(backups, { now }).map((x) => x.fileName), [names[4], renamed]);

  // The restore carry-over keeps timestamps too (belt and braces).
  assert.match(read('main/backupManager.js'), /fsp\.cp\(oldBackups, newBackups, \{ recursive: true, preserveTimestamps: true \}\)/);
});

/* ─── 30: free space, early retry, quit cleanup ─────────────────── */

test('free-space check: staging + archive need about twice the data on one disk, once each on two', () => {
  const GB = 1024 ** 3;
  const base = { dataBytes: 10 * GB, stagingDir: '/tmp', destDir: '/Volumes/Backup/backups' };
  assert.equal(b.backupSpaceShortfall({ ...base, sameVolume: true, stagingFree: 50 * GB, destFree: 50 * GB }), null);
  const short = b.backupSpaceShortfall({ ...base, sameVolume: true, stagingFree: 15 * GB, destFree: 15 * GB });
  assert.ok(short && short.needBytes > 20 * GB && short.freeBytes === 15 * GB);
  assert.equal(b.backupSpaceShortfall({ ...base, sameVolume: false, stagingFree: 11 * GB, destFree: 11 * GB }), null);
  assert.equal(b.backupSpaceShortfall({ ...base, sameVolume: false, stagingFree: 5 * GB, destFree: 50 * GB }).where, '/tmp');
  assert.equal(b.backupSpaceShortfall({ ...base, sameVolume: false, stagingFree: 50 * GB, destFree: 5 * GB }).where, '/Volumes/Backup/backups');
  assert.equal(b.backupSpaceShortfall({ ...base, sameVolume: true, stagingFree: null, destFree: null }), null, 'unknown free space never blocks');

  const src = read('main/backupManager.js');
  const create = src.slice(src.indexOf('async function createBackupNow('), src.indexOf('/**\n * The local time stamped'));
  assert.ok(create.indexOf('backupSpaceShortfall(') < create.indexOf('copyDataTrees('), 'checked before the copy starts');
  assert.match(src, /Not enough free space for \$\{auto \? 'an automatic' : 'a'\} backup — needs about/);
  assert.match(create, /const stageOnDest = !sameDisk\(os\.tmpdir\(\), backupsDir\);/, 'staged on the destination disk when the temp folder is elsewhere');
});

test('an automatic backup that failed because data changed mid-copy retries in 30 minutes, a few times a day', async () => {
  const now = new Date(2026, 9, 8, 10).getTime();
  const msg = 'Data folder changed during asset copy; retry when writes are idle';
  let retries = { day: null, count: 0 };
  for (let i = 0; i < b.AUTO_BACKUP_MAX_RETRIES_PER_DAY; i += 1) {
    const plan = b.autoRetryPlan(msg, retries, now + i * 1000);
    assert.equal(plan.retryInMs, 30 * 60 * 1000);
    retries = plan.retries;
  }
  assert.equal(b.autoRetryPlan(msg, retries, now).retryInMs, null, 'capped for the day');
  assert.equal(b.autoRetryPlan(msg, retries, now + 24 * 3600 * 1000).retryInMs, 30 * 60 * 1000, 'a new day resets the cap');
  assert.equal(b.autoRetryPlan('Not enough free space for an automatic backup', { day: null, count: 0 }, now).retryInMs, null);

  const h = harness([], now);
  h.deps.createBackup = async () => { throw new Error(msg); };
  const res = await b.runAutoBackupIfDue({ now, deps: h.deps });
  assert.equal(res.retryInMs, 30 * 60 * 1000);
  const src = read('main/backupManager.js');
  assert.match(src, /autoState\.retryTimer = setTimeout\(tick, res\.retryInMs\)/, 'the scheduler acts on it');
});

test('quitting stops tar and removes this run\'s staging copy and partial archive', async () => {
  const { activeJobs, runCommand } = b._internals;
  const dir = tmpDir('rf-backup-quit-');
  const stagingRoot = fs.mkdtempSync(path.join(dir, '.iskh-backup-staging-'));
  fs.writeFileSync(path.join(stagingRoot, 'copy.bin'), 'x');
  const job = { child: null, stagingRoot, tmpArchive: null, cancelled: false };
  activeJobs.add(job);
  const out = path.join(dir, b.autoBackupFilename('2026-10-08-0900', '0.1.94'));
  const writing = b.writeArchiveAtomically(out, (tmp) => {
    fs.writeFileSync(tmp, 'partial');
    return runCommand('sleep', ['30'], { onSpawn: (child) => { job.child = child; } });
  }, job);
  while (!job.child) await new Promise((r) => setTimeout(r, 5));
  b.cleanupActiveBackups();
  await assert.rejects(writing);
  assert.deepEqual(fs.readdirSync(dir), [], 'staging and partial gone, no backup appeared');
  assert.equal(activeJobs.size, 0);
  assert.match(read('main/backupManager.js'), /app\.on\('will-quit', cleanupActiveBackups\)/);
});

test('stale temp sweep removes only this app\'s own old leftovers', async () => {
  const dir = tmpDir('rf-backup-sweep-');
  const oldT = new Date(Date.now() - 24 * 3600 * 1000);
  const mk = (name, dirent = false, stale = true) => {
    const p = path.join(dir, name);
    if (dirent) fs.mkdirSync(p); else fs.writeFileSync(p, 'x');
    if (stale) fs.utimesSync(p, oldT, oldT);
  };
  mk('.iskh-backup-staging-abc', true);
  mk('.business-studio-kh-backup-auto-v1-2026-10-01-0900.iskhbackup.1-2.partial');
  mk('.business-studio-kh-backup-auto-v1-2026-10-08-0900.iskhbackup.1-3.partial', false, false); // fresh: maybe running
  mk('business-studio-kh-backup-v1-2026-01-01-0900.iskhbackup'); // a real backup
  mk('notes.partial'); // not ours
  await b._internals.sweepStaleTemp(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    '.business-studio-kh-backup-auto-v1-2026-10-08-0900.iskhbackup.1-3.partial',
    'business-studio-kh-backup-v1-2026-01-01-0900.iskhbackup',
    'notes.partial',
  ]);
});

test('stale sweep clears bundle staging and moves a week-old data copy aside', async () => {
  const dir = tmpDir('rf-backup-sweep2-');
  const now = Date.now();
  const age = (name, days) => {
    const t = new Date(now - days * DAY);
    fs.utimesSync(path.join(dir, name), t, t);
  };
  // The live folder plus the copy an import replaced eight days ago.
  fs.mkdirSync(path.join(dir, 'Biz'));
  fs.writeFileSync(path.join(dir, 'Biz', 'database.sqlite'), '');
  fs.mkdirSync(path.join(dir, 'Biz.bak.1700000000000'));
  fs.writeFileSync(path.join(dir, 'Biz.bak.1700000000000', 'database.sqlite'), '');
  age('Biz.bak.1700000000000', 8);
  // No live sibling: this copy may be the only surviving data — keep it.
  fs.mkdirSync(path.join(dir, 'Gone.pre-restore.1700000000000'));
  age('Gone.pre-restore.1700000000000', 30);
  // Sibling exists but holds no database: keep the copy.
  fs.mkdirSync(path.join(dir, 'Empty'));
  fs.mkdirSync(path.join(dir, 'Empty.bak.1700000000001'));
  age('Empty.bak.1700000000001', 8);
  // Recent copy: a restore may still be running — keep it.
  fs.mkdirSync(path.join(dir, 'Biz.pre-restore.1800000000000'));
  // A killed import's own staging is ours to remove.
  fs.mkdirSync(path.join(dir, '.iskh-bundle-extract-abc'));
  age('.iskh-bundle-extract-abc', 1);

  await b._internals.sweepStaleTemp(dir, now);

  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'Biz',
    'Biz.pre-restore.1800000000000',
    'Empty',
    'Empty.bak.1700000000001',
    'Gone.pre-restore.1700000000000',
    '_trash',
  ]);
  const swept = path.join(
    dir, '_trash', `${new Date(now).toISOString().slice(0, 10)} swept data copies`,
    'Biz.bak.1700000000000', 'database.sqlite',
  );
  assert.ok(fs.existsSync(swept), 'the replaced data copy was moved aside, not deleted');
});

test('the data-folder sweep takes only copies of the live data folder by name', async () => {
  const dir = tmpDir('rf-backup-sweep3-');
  const now = Date.now();
  const old = new Date(now - 8 * DAY);
  for (const n of ['Biz', 'Biz.bak.1700000000000', 'Other.bak.1700000000001']) {
    fs.mkdirSync(path.join(dir, n));
    fs.writeFileSync(path.join(dir, n, 'database.sqlite'), '');
  }
  fs.utimesSync(path.join(dir, 'Biz.bak.1700000000000'), old, old);
  fs.utimesSync(path.join(dir, 'Other.bak.1700000000001'), old, old);

  await b._internals.sweepStaleTemp(dir, now, { liveName: 'Biz' });

  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes('Other.bak.1700000000001'), "another folder's copy is untouched");
  assert.ok(!left.includes('Biz.bak.1700000000000'), 'our old data copy was moved aside');
});

/* ─── 31: one backup at a time ──────────────────────────────────── */

test('manual and automatic backups run one at a time', async () => {
  const { serializeBackup } = b._internals;
  let running = 0;
  let maxRunning = 0;
  const job = (fail) => serializeBackup(async () => {
    running += 1; maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 10));
    running -= 1;
    if (fail) throw new Error('boom');
    return 'ok';
  });
  const results = await Promise.allSettled([job(false), job(true), job(false)]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled'], 'a failure does not block the next');
  assert.match(read('main/backupManager.js'), /function createBackup\(opts = \{\}\) \{\s*return serializeBackup\(\(\) => createBackupNow\(opts\)\);/);
});

/* ─── 32: status on a fresh install ─────────────────────────────── */

test('listBackups reports the automatic-backup status even before the backups folder exists', async () => {
  const dataDir = tmpDir('rf-backup-fresh-');
  fakeConfig.cfg = { dataDir, mode: 'standalone', autoBackupEnabled: true };
  const res = await b.listBackups();
  assert.deepEqual(res.backups, []);
  assert.ok(res.autoBackup, 'status present');
  assert.equal(res.autoBackup.enabled, true);
  assert.equal(res.autoBackup.lastAt, null);
});
