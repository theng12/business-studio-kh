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

module.exports = { openPathOrThrow };
