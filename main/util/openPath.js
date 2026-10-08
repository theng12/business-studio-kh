/**
 * v0.1.25 — opening a folder or file in Finder, with the failure REPORTED.
 *
 * WHY THIS EXISTS. `shell.openPath()` does not reject when it fails. It
 * resolves to a STRING: empty on success, or a human-readable reason on
 * failure ("The file /Volumes/Backup/foo doesn't exist."). The obvious
 * `await shell.openPath(dir); return true;` therefore reports SUCCESS no
 * matter what happened, and the renderer — which had nothing to catch — showed
 * the user a button that did nothing at all when the folder was missing or on
 * an unmounted drive.
 *
 * Five call sites had that shape (`app:openDataFolder`, `app:openLogsFolder`,
 * `backups:openFolder`, and the client-mode copies of the first two), while
 * `labels:openOutput` had it right. The rule this encodes is simple: if the OS
 * says it could not open the thing, that is an ERROR, and it must reach the
 * user rather than being swallowed into a `return true`.
 *
 * `what` is folded into the message because these handlers are reached from
 * several buttons and "Could not open the folder: ..." is far more useful to a
 * user than a bare OS string.
 */
const { shell } = require('electron');

async function openPathOrThrow(target, what = 'folder') {
  if (!target || typeof target !== 'string') throw new Error('Nothing to open');
  const failure = await shell.openPath(target);
  if (failure) throw new Error(`Could not open the ${what}: ${failure}`);
  return true;
}

/* Directory extensions macOS shows as a single item (a "package"). Opening one
 * with shell.openPath LAUNCHES it (an .app runs, a .pkg starts an installer),
 * which is never what "Show in Finder" means. Lower-case, with the dot. */
const PACKAGE_EXTS = new Set([
  '.app', '.bundle', '.pkg', '.mpkg', '.framework', '.plugin', '.kext', '.xpc',
  '.appex', '.prefpane', '.qlgenerator', '.mdimporter', '.saver', '.component',
  '.photoslibrary', '.musiclibrary', '.tvlibrary', '.photolibrary', '.aplibrary',
  '.rtfd', '.key', '.pages', '.numbers', '.playground', '.xcodeproj', '.xcworkspace',
  '.scptd', '.workflow', '.action', '.download', '.band', '.logicx', '.imovielibrary',
  '.fcpbundle', '.lrdata', '.lrlibrary', '.sparsebundle', '.nib', '.docarchive',
]);

/** True when `absPath` (a directory) is one macOS treats as a package: a known
 *  package extension, or anything with a bundle's `Contents/Info.plist`. */
function isPackageDirectory(absPath, fs = require('node:fs'), path = require('node:path')) {
  const ext = path.extname(String(absPath || '')).toLowerCase();
  if (PACKAGE_EXTS.has(ext)) return true;
  try { return fs.statSync(path.join(absPath, 'Contents', 'Info.plist')).isFile(); } catch (_) { return false; }
}

/**
 * "Show in Finder" for an absolute path, shared by the standalone handler
 * (main/ipc/files.js) and client mode's local copy (main/client/index.js) so
 * the two cannot drift. A plain folder opens in Finder; a file — or a folder
 * macOS treats as a package (.app, .bundle, .pkg …) — is REVEALED (selected
 * in its parent window) and never opened, because opening a package runs it.
 */
async function revealPath(absPath, { fs = require('node:fs'), shellApi = shell } = {}) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { throw new Error(`Not found: ${absPath}`); }
  if (stat.isDirectory() && !isPackageDirectory(absPath, fs)) {
    const failure = await shellApi.openPath(absPath);
    if (failure) throw new Error(`Could not open the folder: ${failure}`);
    return true;
  }
  shellApi.showItemInFolder(absPath);
  return true;
}

module.exports = { openPathOrThrow, isPackageDirectory, revealPath, PACKAGE_EXTS };
