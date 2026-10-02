/**
 * Thumbnail tier for `app-image://` and the server's `/assets/` route.
 *
 * Why this exists: the Library table draws a 36 px thumb and the grid a
 * ~200 px card, but both used to request the stored original (up to 1600 px).
 * A 200-row page therefore decoded hundreds of full-size photos on every mount
 * or page change, and a client Mac pulled every one of them over Tailscale.
 * A list view now asks for `?w=96` / `?w=640` and gets a small cached WebP.
 *
 * Shared by BOTH serving paths, so the two can never disagree (AGENTS.md §15:
 * a rule both modes must agree on cannot live inside one mode's handler):
 *   - main/protocol.js   registerImageProtocol  (standalone / server Mac)
 *   - main/server/index.js serveAsset            (what a client Mac fetches)
 * The client-mode protocol needs no copy: it forwards `w` in the query string
 * and the server answers with the thumbnail.
 *
 * Contract:
 *   - `w` is snapped UP to one of THUMB_WIDTHS; anything else (garbage, 0,
 *     larger than the biggest tier) means "serve the original".
 *   - Only jpg / jpeg / png / webp are thumbnailed. SVG, GIF and everything
 *     else keep the original path untouched.
 *   - The callers do every path-containment check FIRST and only hand this
 *     module an absolute path that already passed them. Nothing here widens
 *     what can be read.
 *   - Any failure returns null and the caller serves the original — a
 *     thumbnail problem must never become a broken image.
 *
 * Cache location (§21 packaging-safe paths): `<userData>/thumb-cache/`, NOT
 * the data folder — so backups, restores and the data-folder move never see
 * it, and losing it costs nothing but a regeneration. The directory holds
 * only files this module wrote (`<sha1>.webp` plus short-lived `.tmp` files);
 * pruning only ever removes names matching those patterns inside that one
 * directory. These are regenerable app cache, not user files, so the
 * "deletes go to the Trash" rule for user data does not apply to them.
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Keep in step with THUMB_WIDTHS in renderer/lib/imageUrl.js
// (test/thumbCache.test.js pins the two lists to each other).
const THUMB_WIDTHS = Object.freeze([96, 320, 640]);
const THUMB_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const THUMB_MIME = 'image/webp';
// Bump when the encoding below changes, so old cache entries stop matching.
const THUMB_FORMAT = 'webp-q80-outside-v1';

const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const CACHE_PRUNE_TARGET = 0.8; // prune down to 80% of the cap
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 2;
const MAX_FAILED_KEYS = 1000;

const CACHE_FILE_RE = /^[0-9a-f]{40}\.webp$/;
const TMP_FILE_RE = /^[0-9a-f]{40}\.[0-9a-z.]+\.tmp$/;

let cacheDirOverride = null;
let lastPruneAt = 0;
let pruning = null;
let active = 0;
const waiting = [];
const inflight = new Map();
const failedKeys = new Set();

/** Snap a requested width up to the nearest tier; null = serve the original. */
function snapThumbWidth(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  if (!(n > 0)) return null;
  for (const tier of THUMB_WIDTHS) if (n <= tier) return tier;
  return null;
}

function isThumbable(filePath) {
  return THUMB_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Identity of one thumbnail. `source` is the resolved absolute path the caller
 * already validated; `v` is the URL's version stamp; size / mtime / inode tie
 * it to the exact bytes on disk (filenames get renumbered after a reorder —
 * see renderer/lib/imageUrl.js — so the path alone is not enough).
 */
function thumbCacheKey({ source, v, size, mtimeMs, ino, w }) {
  return createHash('sha1')
    .update(JSON.stringify([THUMB_FORMAT, String(source), v == null ? '' : String(v),
      Number(size) || 0, Number(mtimeMs) || 0, String(ino ?? ''), Number(w) || 0]))
    .digest('hex');
}

function getThumbCacheDir() {
  if (cacheDirOverride) return cacheDirOverride;
  let base = null;
  try {
    // Under plain `node --test`, require('electron') is the binary path string
    // and has no `app`; fall back to the temp dir there.
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      base = electron.app.getPath('userData');
    }
  } catch (_) { /* not running inside Electron */ }
  return path.join(base || path.join(os.tmpdir(), 'media-studio-kh'), 'thumb-cache');
}

/** Tests only: point the cache somewhere disposable (null restores the default). */
function setThumbCacheDir(dir) {
  cacheDirOverride = dir ? path.resolve(dir) : null;
  lastPruneAt = 0;
}

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (active < MAX_CONCURRENT) run();
    else waiting.push(run);
  });
}

async function generate(source, out, width) {
  const sharp = require('sharp');
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out.slice(0, -'.webp'.length)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    // `fit: 'outside'` makes the SHORT side `width`: every list view crops
    // with object-fit: cover, so the short side is the one that must be sharp.
    await sharp(source)
      .rotate()
      .resize({ width, height: width, fit: 'outside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(tmp);
    await fsp.rename(tmp, out);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch (_) { /* never written */ }
    throw err;
  }
}

async function isFile(p) {
  try { return (await fsp.stat(p)).isFile(); } catch (_) { return false; }
}

/**
 * Return the path of a cached thumbnail for `source` at tier `w`, generating
 * it if needed. Returns null whenever the original should be served instead.
 * `stat` may be passed when the caller already has one (the server has an
 * open handle's fstat).
 */
async function getThumbnail(source, { v, w, stat } = {}) {
  const width = snapThumbWidth(w);
  if (!width || !isThumbable(source)) return null;
  let key;
  try {
    const st = stat || await fsp.stat(source);
    if (!st.isFile()) return null;
    key = thumbCacheKey({ source, v, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, w: width });
    if (failedKeys.has(key)) return null;
    const dir = getThumbCacheDir();
    const out = path.join(dir, `${key}.webp`);
    try {
      const hit = await fsp.stat(out);
      if (hit.isFile()) {
        // Cheap LRU: refresh a day-old entry's mtime so pruning (oldest
        // mtime first) keeps what is still being looked at.
        if (Date.now() - hit.mtimeMs > TOUCH_AFTER_MS) {
          const now = new Date();
          fsp.utimes(out, now, now).catch(() => { /* pruned meanwhile — harmless */ });
        }
        return out;
      }
    } catch (_) { /* miss */ }
    let job = inflight.get(key);
    if (!job) {
      job = withSlot(() => generate(source, out, width)).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    await job;
    maybePrune(dir);
    return (await isFile(out)) ? out : null;
  } catch (err) {
    if (key) {
      if (failedKeys.size >= MAX_FAILED_KEYS) failedKeys.clear();
      failedKeys.add(key);
    }
    try {
      process.stderr.write(`[thumb-cache] ${path.basename(String(source))} @${width}: ${err?.message || err} — serving original\n`);
    } catch (_) { /* logging must never throw */ }
    return null;
  }
}

/**
 * Keep the cache under `maxBytes`, removing the oldest (by mtime) entries
 * first, plus any abandoned `.tmp` files. Only names this module writes are
 * considered, and only directly inside `dir` — never a subfolder, never a
 * symlink.
 */
async function pruneThumbCache(dir = getThumbCacheDir(), { maxBytes = CACHE_MAX_BYTES, now = Date.now() } = {}) {
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return { removed: 0, totalBytes: 0 }; }
  const entries = [];
  let totalBytes = 0;
  let removed = 0;
  for (const name of names) {
    const isCache = CACHE_FILE_RE.test(name);
    const isTmp = !isCache && TMP_FILE_RE.test(name);
    if (!isCache && !isTmp) continue;
    const p = path.join(dir, name);
    let st;
    try { st = await fsp.lstat(p); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (isTmp) {
      if (now - st.mtimeMs > TMP_MAX_AGE_MS) {
        try { await fsp.unlink(p); removed += 1; } catch (_) { /* gone already */ }
      }
      continue;
    }
    entries.push({ p, size: st.size, mtimeMs: st.mtimeMs });
    totalBytes += st.size;
  }
  if (totalBytes > maxBytes) {
    const target = maxBytes * CACHE_PRUNE_TARGET;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of entries) {
      if (totalBytes <= target) break;
      try {
        await fsp.unlink(e.p);
        totalBytes -= e.size;
        removed += 1;
      } catch (_) { /* gone already */ }
    }
  }
  return { removed, totalBytes };
}

/** Fire-and-forget prune, at most once per PRUNE_INTERVAL_MS per process. */
function maybePrune(dir) {
  if (pruning || Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();
  pruning = pruneThumbCache(dir)
    .catch((err) => {
      try { process.stderr.write(`[thumb-cache] prune failed: ${err.message}\n`); } catch (_) { /* ignore */ }
    })
    .finally(() => { pruning = null; });
}

module.exports = {
  THUMB_WIDTHS,
  THUMB_MIME,
  CACHE_MAX_BYTES,
  snapThumbWidth,
  isThumbable,
  thumbCacheKey,
  getThumbCacheDir,
  setThumbCacheDir,
  getThumbnail,
  pruneThumbCache,
};
