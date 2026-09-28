/**
 * v0.1.85: put deleted files in the macOS Trash instead of erasing them.
 *
 * Why. The owner's report was "someone accidentally deleted a product", and the
 * old behaviour made that expensive: `products.remove` ran
 * `fs.rmSync(dir, { recursive: true, force: true })`, so the product's whole
 * image folder was gone the moment the confirm was accepted — and the confirm
 * itself said "This cannot be undone", which was true. A product that was
 * deleted by mistake could only come back from a backup.
 *
 * Now the folder is handed to the system Trash, so Finder's "Put Back" (or
 * emptying the Trash, deliberately) is the user's decision rather than ours.
 * The DB row is still deleted — this is a file-level safety net, not an undo
 * for the product entry.
 *
 * Two behaviours are deliberate:
 *
 *   1. **If the Trash is unavailable, the files are LEFT ALONE, not erased.**
 *      That is the same judgement `products.remove` already makes for a folder
 *      shared between two products ("leaving a few orphaned files behind is
 *      strictly better than destroying a product's images"). A stray folder is
 *      recoverable by hand; erased bytes are not.
 *   2. **Outside Electron — a `node --test` run, or `ELECTRON_RUN_AS_NODE=1` —
 *      there is no Trash to move anything to, so it removes the path.** Without
 *      that, the native tests would silently stop covering the delete path and
 *      a real leak (files surviving every delete) would go unnoticed.
 */

const fs = require('node:fs');

/**
 * The Electron `shell` module, or null when this is not an Electron main
 * process. `require('electron')` resolves to the API object inside Electron and
 * to a path string everywhere else, so the shape check is the test.
 */
function electronShell() {
  const electron = requireElectron();
  if (electron && typeof electron === 'object' && electron.shell) return electron.shell;
  return null;
}

/** True when `require('electron')` handed back the API object (a real main process). */
function inElectronMain() {
  const electron = requireElectron();
  return !!electron && typeof electron === 'object';
}

function requireElectron() {
  try {
    // eslint-disable-next-line global-require
    return require('electron');
  } catch (_) {
    return null;
  }
}

/**
 * Move one file or folder to the Trash.
 *
 * Resolves to a word rather than throwing, because every caller is doing this
 * best-effort after the database change has already been committed and has
 * nothing useful to do with a failure:
 *
 *   'missing'  — nothing was there
 *   'trashed'  — it is in the Trash
 *   'left'     — the Trash refused it; the path is untouched and still on disk
 *   'removed'  — no Trash available (tests), so it was deleted for real
 *
 * `opts.shell` lets a test supply the Trash. Only a test passes it; production
 * always asks the real Electron `shell`, and the "refused" branch is the one
 * worth testing because it is the branch that decides whether bytes survive.
 *
 * The failure directions are deliberate, and they differ by context:
 *   - **In the app, nothing is ever erased by this function.** If the Trash
 *     refuses the path, it is left where it is and the log says so. A stray
 *     folder is recoverable by hand; erased bytes are not.
 *   - **Outside Electron** — a `node --test` run, or `ELECTRON_RUN_AS_NODE=1`,
 *     where there is no Trash at all — it removes the path, so the native tests
 *     keep covering the delete path and a leak (files surviving every delete)
 *     cannot hide.
 */
async function trashPath(absPath, opts = {}) {
  if (!absPath || !fs.existsSync(absPath)) return 'missing';

  const explicit = 'shell' in opts;
  const shell = explicit ? opts.shell : electronShell();
  const usable = shell && typeof shell.trashItem === 'function';

  if (!explicit && !inElectronMain()) {
    // Not an Electron main process: no Trash exists to refuse anything.
    try {
      fs.rmSync(absPath, { recursive: true, force: true });
      return 'removed';
    } catch (err) {
      process.stderr.write(`[fileTrash] no Trash available and could not remove ${absPath}: ${err.message}\n`);
      return 'left';
    }
  }

  if (!usable) {
    process.stderr.write(`[fileTrash] no Trash available for ${absPath} — leaving it in place\n`);
    return 'left';
  }

  try {
    await shell.trashItem(absPath);
    return 'trashed';
  } catch (err) {
    // Deliberately NOT falling back to rm here — see the note above.
    process.stderr.write(
      `[fileTrash] could not move ${absPath} to the Trash (${err.message}) — leaving it in place\n`,
    );
    return 'left';
  }
}

/**
 * Fire-and-forget form for the synchronous database layer. The row is already
 * gone by the time this is called, so nothing waits on the file's fate; the
 * catch is only so a rejected promise can never surface as an unhandled
 * rejection in the main process.
 */
function trashPathInBackground(absPath) {
  trashPath(absPath).catch((err) => {
    process.stderr.write(`[fileTrash] ${absPath}: ${err.message}\n`);
  });
}

module.exports = { trashPath, trashPathInBackground, electronShell };
