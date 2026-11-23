/**
 * v0.49.31: backups:* IPC handlers — local backup / restore.
 *
 * Data operations (create/list/preview/restore) run on the data-owning Mac
 * through `expose()` and are available to authorized remote clients. Finder
 * operations remain local through `exposeLocal()` because they must open on
 * the Mac the user is looking at.
 *
 * Channels:
 *   - backups:create     → snapshot DB + assets + config into a new
 *                          .iskhbackup in the backups folder. Emits
 *                          progress:event so the existing
 *                          ProgressOverlay shows a bar.
 *   - backups:list       → { backupsDir, backups:[{fileName, backupPath,
 *                          sizeBytes, createdAt}] }, newest first.
 *   - backups:last       → the single most-recent backup or null.
 *   - backups:preview    → parsed + validated manifest of one backup.
 *   - backups:reveal     → reveal a specific backup in Finder.
 *   - backups:openFolder → open the backups folder in Finder.
 *   - backups:pickFolder → choose a custom backups folder (persists
 *                          config.backupsDir).
 *   - backups:pickFile   → choose one .iskhbackup from anywhere on this
 *                          Mac (v0.1.83) — for a backup that lives outside
 *                          the backups folder, such as the ones the old
 *                          Image Studio KH app wrote.
 *   - backups:restore    → REPLACE the data folder from a backup. The
 *                          owning process restarts after remote restores;
 *                          local renderers relaunch after the response.
 */

const fsp = require('node:fs/promises');
const { app, dialog, shell } = require('electron');
const { openPathOrThrow } = require('../util/openPath');
const backupManager = require('../backupManager');
const events = require('../events');
const config = require('../config');
const { runDataMaintenance } = require('../util/maintenanceLifecycle');

/**
 * v0.1.22: creating, listing, previewing and restoring a backup go through
 * expose() so a client Mac can do them — they act on the server's data folder,
 * which is where the data is, and the server's `system.manage` capability gate
 * decides who may. `reveal`, `openFolder` and `pickFolder` deliberately stay
 * exposeLocal(): each opens a Finder window or a folder picker, which must
 * appear on the Mac the user is looking at, and the folder it would open is on
 * the other one.
 */
function register({ expose, exposeLocal }) {
  expose('backups:create', async () => {
    const opId = `backup-create-${Date.now()}`;
    const stages = ['snapshot', 'manifest', 'archive', 'cleanup', 'done'];
    const labels = {
      snapshot: 'Snapshotting database',
      manifest: 'Writing manifest',
      archive:  'Packing backup',
      cleanup:  'Cleaning up',
      done:     'Done',
    };
    events.broadcast('progress:event', {
      id: opId, kind: 'backup-create', done: 0, total: stages.length,
      phase: 'starting', label: 'Preparing backup…',
    });
    try {
      const result = await backupManager.createBackup({
        onProgress: (stage) => {
          const idx = stages.indexOf(stage);
          events.broadcast('progress:event', {
            id: opId, kind: 'backup-create',
            done: idx >= 0 ? idx + 1 : 0,
            total: stages.length,
            phase: stage,
            label: labels[stage] ?? stage,
          });
        },
      });
      events.broadcast('progress:event', { id: opId, complete: true });
      return result;
    } catch (err) {
      events.broadcast('progress:event', { id: opId, complete: true, error: err.message });
      throw err;
    }
  });

  expose('backups:list', () => backupManager.listBackups());
  expose('backups:last', () => backupManager.lastBackup());

  expose('backups:preview', async (args) => {
    const backupPath = args?.backupPath;
    if (!backupPath) throw new Error('backupPath is required');
    return backupManager.previewBackup(backupPath);
  });

  exposeLocal('backups:reveal', async (args) => {
    const backupPath = args?.backupPath;
    if (!backupPath) throw new Error('backupPath is required');
    shell.showItemInFolder(backupPath);
    return true;
  });

  exposeLocal('backups:openFolder', async () => {
    const cfg = config.loadConfig();
    const dir = backupManager.resolveBackupsDir(cfg);
    // Create it first so "Open" works even before the first backup —
    // shell.openPath on a missing dir just returns an error string.
    await fsp.mkdir(dir, { recursive: true });
    // v0.1.25: report the failure instead of discarding it. openPath resolves
    // with an error string, so the old bare `await` returned success even when
    // nothing opened.
    await openPathOrThrow(dir, 'backups folder');
    return dir;
  });

  exposeLocal('backups:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose backups folder',
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const next = res.filePaths[0];
    config.updateConfig({ backupsDir: next });
    return next;
  });

  /**
   * v0.1.83: pick a backup file from anywhere on this Mac.
   *
   * The folder list is the normal route, but it cannot reach a backup written
   * somewhere else — most importantly the ones the old Image Studio KH app
   * left outside this app's backups folder, which is the "I have the old
   * backup, can I bring it in?" case. Requiring a Finder copy first, and then
   * a trip out of this panel and back for the list to notice it, was
   * unnecessary friction.
   *
   * `exposeLocal()` for the same reason as `backups:pickFolder`: the dialog
   * and the file are on the Mac the user is looking at. The panel hides the
   * button in client mode, where the picked file would be on the client's
   * disk while the restore runs against the server's data folder.
   *
   * Nothing is validated here beyond a cancelled dialog: the path goes to the
   * same `backups:preview` + `backups:restore` pair the list uses, and both
   * verify the manifest before anything is replaced.
   */
  exposeLocal('backups:pickFile', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Choose a backup to restore',
      filters: [
        { name: 'Business Studio KH backup', extensions: ['iskhbackup'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  expose('backups:restore', async (args) => {
    const backupPath = args?.backupPath;
    if (!backupPath) throw new Error('backupPath is required');

    const opId = `backup-restore-${Date.now()}`;
    const stages = ['verify', 'extract', 'safety-copy', 'merge-config', 'done'];
    const labels = {
      verify:        'Verifying backup',
      extract:       'Extracting backup',
      'safety-copy': 'Moving current data aside',
      'merge-config': 'Restoring preferences',
      done:          'Done',
    };
    events.broadcast('progress:event', {
      id: opId, kind: 'backup-restore', done: 0, total: stages.length,
      phase: 'starting', label: 'Preparing restore…',
    });
    try {
      const result = await backupManager.restoreBackup({
        backupPath,
        runReplacement: (replace) => runDataMaintenance({
          label: 'restoring a backup',
          dataDir: config.loadConfig().dataDir,
          replace,
        }),
        onProgress: (stage) => {
          const idx = stages.indexOf(stage);
          events.broadcast('progress:event', {
            id: opId, kind: 'backup-restore',
            done: idx >= 0 ? idx + 1 : 0,
            total: stages.length,
            phase: stage,
            label: labels[stage] ?? stage,
          });
        },
      });
      events.broadcast('progress:event', { id: opId, complete: true });
      // Restart from main after the response is queued. Correctness must not
      // depend on either renderer issuing a second IPC after live data changed.
      let remote = false;
      try { remote = Boolean(require('../server').getCurrentUserId?.()); } catch (_) {}
      if (!result.restartScheduled) {
        app.relaunch();
        setTimeout(() => app.exit(0), 500);
      }
      return {
        ...result,
        restartScheduled: true,
        ...(remote ? { serverRestartScheduled: true } : {}),
      };
    } catch (err) {
      events.broadcast('progress:event', { id: opId, complete: true, error: err.message });
      throw err;
    }
  });
}

module.exports = { register };
