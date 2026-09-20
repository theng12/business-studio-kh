/**
 * v0.1.18: which file kinds the local path channels will accept.
 *
 * Why this is its own module. The rule "only image files can be previewed by
 * path" has to be enforced in three places that must not drift:
 *
 *   1. main/server/validators.js — the early, readable rejection. This is the
 *      one that applies in BOTH standalone and client mode.
 *   2. main/ipc/files.js        — the standalone/server handler, at the sink.
 *   3. main/client/index.js     — no code needed: it registers through
 *      handleLocal(), which runs the same validators, so (1) covers it.
 *
 * It was first written inline in main/ipc/files.js only, and that turned out to
 * be wrong: client mode has its OWN implementation of those handlers, so a
 * handler-level check silently does not exist there. Anything both modes must
 * agree on belongs in a place both can require — hence this file, which depends
 * on nothing.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Extensions the OS image pickers can return, plus what the importers accept. */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

/** Extensions `files:pickWorkbook` / `files:parseWorkbook` deal in. */
const WORKBOOK_EXTS = new Set(['.xlsx', '.xls', '.csv', '.tsv']);

/** True when `p` is a path whose extension is one of the accepted image kinds. */
function isImagePath(p) {
  return typeof p === 'string' && p.length > 0 && IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

/** True when `p` is a path whose extension is one of the accepted workbook kinds. */
function isWorkbookPath(p) {
  return typeof p === 'string' && p.length > 0 && WORKBOOK_EXTS.has(path.extname(p).toLowerCase());
}

/** True for an absolute path — the local file channels are meaningless without one. */
function isAbsolutePath(p) {
  return typeof p === 'string' && p.length > 0 && path.isAbsolute(p);
}

/**
 * v0.1.19: list the image files in a folder — top level plus one level of
 * subfolders, hidden files skipped, sorted.
 *
 * Moved here from main/ipc/files.js so client mode can offer the same channel
 * with the same behaviour. It has to run on whichever machine owns the folder,
 * and both modes must agree on what "scan this folder" returns; two copies would
 * drift.
 *
 * Note this is deliberately shallower than imageManager.scanImagesRecursive
 * (5 levels), which backs `ai:scanBulkFolder`. The two are different tools with
 * different expectations, so this change does not merge them.
 */
function scanImageFilesIn(folderPath) {
  const out = [];
  function scan(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 1) scan(full, depth + 1); }
      else if (IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  scan(folderPath, 0);
  out.sort();
  return out;
}


/**
 * v0.1.25 — a file extension that is safe to INTERPOLATE INTO A PATH.
 *
 * WHY THIS IS A SHARED RULE. An extension arriving over IPC is attacker- or
 * bug-controlled text, and the obvious sanitiser is not enough:
 *
 *     const safeExt = (ext || '.png').toLowerCase().replace(/^([^.])/, '.$1');
 *     const tmpPath = path.join(tmpDir, `paste${safeExt}`);
 *
 * `path.join` NORMALISES `..`, so an ext of
 * `'.png/../../../../../../tmp/owned.jpg'` resolves to `/var/tmp/owned.jpg` —
 * a write outside the temp directory, to a path the caller chose. That shape
 * existed in two places (`main/imageManager.js` for pasted images and
 * `main/ipc/ai.js` for bulk-AI sources), while `labels:importAssetFromBytes`
 * got it right, which is exactly the drift a shared helper prevents.
 *
 * The rule: an extension is a dot followed by 2-5 alphanumerics, nothing else.
 * Anything that does not match — including a path, a separator, a NUL, or an
 * over-long string — falls back to the default rather than being partially
 * cleaned, because a partially-cleaned path is what caused this.
 */
function safeFileExt(ext, fallback = '.png') {
  const raw = typeof ext === 'string' ? ext.trim().toLowerCase() : '';
  const dotted = raw && !raw.startsWith('.') ? `.${raw}` : raw;
  return /^\.[a-z0-9]{2,5}$/.test(dotted) ? dotted : fallback;
}

module.exports = {
  IMAGE_EXTS,
  WORKBOOK_EXTS,
  isImagePath,
  isWorkbookPath,
  isAbsolutePath,
  scanImageFilesIn,
  safeFileExt,
};
