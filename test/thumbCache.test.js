/**
 * Thumbnail tier for app-image:// (main/util/thumbCache.js + main/protocol.js
 * + renderer/lib/imageUrl.js).
 *
 * The Library list/grid used to decode the stored original (up to 1600 px)
 * for every row. These pin:
 *   - the URL helper: `w` snaps up to a fixed tier, old two-argument calls
 *     are byte-for-byte unchanged, and the renderer/main tier lists agree;
 *   - the cache key moves with every input that identifies the bytes;
 *   - the protocol's path-containment checks are exactly as strict with `w`;
 *   - a real thumbnail is generated (EXIF-rotated, short side = tier), a
 *     non-raster or unreadable file falls back to the original, and pruning
 *     only ever touches its own cache files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const Module = require('node:module');

const thumbs = require('../main/util/thumbCache');

const ROOT = path.join(__dirname, '..');

let sharp = null;
try { sharp = require('sharp'); sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }); } catch (_) { sharp = null; }
const SHARP_SKIP = sharp ? false : 'sharp does not load under this Node — run with Electron';

function loadRendererImageUrl() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/lib/imageUrl.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

function loadProtocol(electron) {
  const originalLoad = Module._load;
  const filename = require.resolve('../main/protocol');
  delete require.cache[filename];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../main/protocol'); }
  finally { Module._load = originalLoad; }
}

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-thumb-test-'));
  try { return await run(dir); }
  finally {
    thumbs.setThumbCacheDir(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('snapThumbWidth snaps up to a tier and refuses everything else', () => {
  assert.deepEqual([...thumbs.THUMB_WIDTHS], [96, 320, 640]);
  assert.equal(thumbs.snapThumbWidth('1'), 96);
  assert.equal(thumbs.snapThumbWidth(36), 96);
  assert.equal(thumbs.snapThumbWidth('96'), 96);
  assert.equal(thumbs.snapThumbWidth('97'), 320);
  assert.equal(thumbs.snapThumbWidth(400), 640);
  assert.equal(thumbs.snapThumbWidth('640'), 640);
  for (const bad of ['641', 5000, '0', 0, '-5', 'abc', '', null, undefined, '96px', '1e2', '9.5', ' ']) {
    assert.equal(thumbs.snapThumbWidth(bad), null, `w=${JSON.stringify(bad)} must serve the original`);
  }
});

test('only raster formats sharp reads are thumbnailed', () => {
  for (const ok of ['a.jpg', 'a.JPEG', 'x/y.png', 'z.webp']) assert.ok(thumbs.isThumbable(ok), ok);
  for (const no of ['a.svg', 'a.gif', 'a.heic', 'a.zip', 'a', '']) assert.ok(!thumbs.isThumbable(no), no);
});

test('renderer URL helper: tiers match main, old calls unchanged, w snapped', () => {
  const r = loadRendererImageUrl();
  assert.deepEqual(r.THUMB_WIDTHS, [...thumbs.THUMB_WIDTHS], 'renderer and main thumbnail tiers drifted apart');
  // Existing two-argument calls produce exactly what they always did.
  assert.equal(r.appImageSrc(null), null);
  assert.equal(r.appImageSrc(''), null);
  assert.equal(r.appImageSrc('sku/001.jpg'), 'app-image://local/sku%2F001.jpg');
  assert.equal(r.appImageSrc('sku/001.jpg', 'abc'), 'app-image://local/sku%2F001.jpg?v=abc');
  assert.equal(r.appImageSrc('sku/001.jpg', 0), 'app-image://local/sku%2F001.jpg?v=0');
  assert.equal(r.appImageSrc('sku/001.jpg', ''), 'app-image://local/sku%2F001.jpg');
  assert.equal(r.appImageSrc('a b.jpg', '2026-01-01 10:00'), 'app-image://local/a%20b.jpg?v=2026-01-01%2010%3A00');
  // Thumbnail tier.
  assert.equal(r.appImageSrc('sku/001.jpg', 'abc', { w: 36 }), 'app-image://local/sku%2F001.jpg?v=abc&w=96');
  assert.equal(r.appImageSrc('sku/001.jpg', 'abc', { w: 320 }), 'app-image://local/sku%2F001.jpg?v=abc&w=320');
  assert.equal(r.appImageSrc('sku/001.jpg', null, { w: 500 }), 'app-image://local/sku%2F001.jpg?w=640');
  assert.equal(r.appImageSrc('sku/001.jpg', 'abc', { w: 5000 }), 'app-image://local/sku%2F001.jpg?v=abc');
  assert.equal(r.appImageSrc('sku/001.jpg', 'abc', { w: 'x' }), 'app-image://local/sku%2F001.jpg?v=abc');
  assert.equal(r.appImageSrc('sku/001.jpg', 'abc', {}), 'app-image://local/sku%2F001.jpg?v=abc');
});

test('Library list views ask for thumbnails, lazily; full-size viewers do not', async () => {
  const table = await fsp.readFile(path.join(ROOT, 'renderer/modules/ProductLibrary/LibraryTable.jsx'), 'utf8');
  const grid = await fsp.readFile(path.join(ROOT, 'renderer/modules/ProductLibrary/LibraryGrid.jsx'), 'utf8');
  assert.match(table, /appImageSrc\(p\.mainImagePath, p\.updatedAt, \{ w: 96 \}\)\} alt="" loading="lazy" decoding="async"/);
  assert.match(grid, /appImageSrc\(activePath, p\.updatedAt, \{ w: \d+ \}\)/);
  // 0.1.94: ConnImg is the <img> that retries after a client-mode reconnect.
  assert.match(grid, /<(?:img|ConnImg) src=\{thumbSrc\} alt="" loading="lazy" decoding="async" \/>/);
  const lightbox = await fsp.readFile(path.join(ROOT, 'renderer/components/Lightbox.jsx'), 'utf8');
  assert.doesNotMatch(lightbox, /\{\s*w:\s*\d+\s*\}/, 'the Lightbox must keep showing the original');
});

test('cache key changes with every input that identifies the bytes', () => {
  const base = { source: '/d/assets/a/001.jpg', v: 'h1', size: 100, mtimeMs: 1.5, ino: 7, w: 96 };
  const key = thumbs.thumbCacheKey(base);
  assert.match(key, /^[0-9a-f]{40}$/);
  assert.equal(thumbs.thumbCacheKey({ ...base }), key, 'deterministic');
  for (const [field, value] of [['source', '/d/assets/a/002.jpg'], ['v', 'h2'], ['size', 101],
    ['mtimeMs', 1.6], ['ino', 8], ['w', 320]]) {
    assert.notEqual(thumbs.thumbCacheKey({ ...base, [field]: value }), key, `${field} must be part of the key`);
  }
  assert.notEqual(thumbs.thumbCacheKey({ ...base, v: null }), key);
});

function fileFetchElectron() {
  const handlers = new Map();
  const fetched = [];
  return {
    handlers,
    fetched,
    electron: {
      protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
      net: {
        fetch: async (fileUrl) => {
          const p = fileURLToPath(fileUrl);
          fetched.push(p);
          return new Response(await fsp.readFile(p));
        },
      },
    },
  };
}

test('protocol containment is exactly as strict when w is present', async () => {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    thumbs.setThumbCacheDir(path.join(dir, 'cache'));
    await fsp.mkdir(path.join(dataDir, 'assets'), { recursive: true });
    await fsp.mkdir(path.join(dataDir, 'assets-sibling'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'assets-sibling', 'outside.jpg'), 'outside');
    await fsp.writeFile(path.join(dataDir, 'config.json'), '{}');
    const h = fileFetchElectron();
    loadProtocol(h.electron).registerImageProtocol(dataDir);
    const handler = h.handlers.get('app-image');

    for (const u of [
      'app-image://local/..%2Fassets-sibling%2Foutside.jpg?w=96',
      'app-image://local/..%2Fassets-sibling%2Foutside.jpg?v=1&w=96',
      'app-image://local/processed%2F..%2F..%2Fassets-sibling%2Foutside.jpg?w=96',
      `app-image://local/${encodeURIComponent(path.join(dataDir, 'assets-sibling', 'outside.jpg'))}?w=96`,
      'app-image://local/..%2Fconfig.json?w=96',
    ]) {
      const res = await handler({ url: u });
      assert.equal(res.status, 403, u);
    }
    assert.equal(h.fetched.length, 0, 'nothing outside the roots was read');
    assert.equal((await handler({ url: 'app-image://local/missing.jpg?w=96' })).status, 404);
  });
});

test('protocol serves a real EXIF-rotated thumbnail and falls back to the original otherwise', { skip: SHARP_SKIP }, async () => {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    const cacheDir = path.join(dir, 'cache');
    thumbs.setThumbCacheDir(cacheDir);
    const assets = path.join(dataDir, 'assets', 'sku');
    await fsp.mkdir(assets, { recursive: true });
    const photo = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#3a7' } })
      .jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
    await fsp.writeFile(path.join(assets, '001.jpg'), photo);
    await fsp.writeFile(path.join(assets, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fsp.writeFile(path.join(assets, 'broken.jpg'), 'not really a jpeg');

    const h = fileFetchElectron();
    loadProtocol(h.electron).registerImageProtocol(dataDir);
    const handler = h.handlers.get('app-image');

    // Several simultaneous requests for one thumbnail share one generation.
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      handler({ url: 'app-image://local/sku%2F001.jpg?v=h1&w=96' })));
    const bodies = await Promise.all(results.map((r) => r.arrayBuffer()));
    for (const r of results) assert.equal(r.status, 200);
    const thumb = Buffer.from(bodies[0]);
    const meta = await sharp(thumb).metadata();
    assert.equal(meta.format, 'webp');
    // Orientation 6 = rotate 90°: the 1600×1000 frame displays as 1000×1600,
    // so the short side (width) is the tier.
    assert.equal(meta.width, 96);
    assert.equal(meta.height, 154);
    assert.ok(thumb.length < photo.length / 4, 'thumbnail is a fraction of the original');
    const cached = (await fsp.readdir(cacheDir));
    assert.equal(cached.length, 1, `one cache file, no leftovers: ${cached.join(', ')}`);
    assert.match(cached[0], /^[0-9a-f]{40}\.webp$/);

    // No `w` → the original, untouched.
    const original = await handler({ url: 'app-image://local/sku%2F001.jpg?v=h1' });
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), photo);

    // A new version stamp is a new cache entry.
    await (await handler({ url: 'app-image://local/sku%2F001.jpg?v=h2&w=96' })).arrayBuffer();
    assert.equal((await fsp.readdir(cacheDir)).length, 2);

    // SVG and unreadable files serve the original — never a broken image.
    const svg = await handler({ url: 'app-image://local/sku%2Flogo.svg?w=96' });
    assert.equal(await svg.text(), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const broken = await handler({ url: 'app-image://local/sku%2Fbroken.jpg?w=96' });
    assert.equal(broken.status, 200);
    assert.equal(await broken.text(), 'not really a jpeg');
    // Out-of-range width serves the original as well.
    const huge = await handler({ url: 'app-image://local/sku%2F001.jpg?w=4000' });
    assert.deepEqual(Buffer.from(await huge.arrayBuffer()), photo);
  });
});

test('pruning removes oldest cache files only, and only its own', async () => {
  await withTempDir(async (dir) => {
    const cacheDir = path.join(dir, 'cache');
    await fsp.mkdir(path.join(cacheDir, 'sub'), { recursive: true });
    const now = Date.now();
    const names = [];
    for (let i = 0; i < 5; i += 1) {
      const name = `${String(i).repeat(40)}.webp`;
      names.push(name);
      const p = path.join(cacheDir, name);
      await fsp.writeFile(p, Buffer.alloc(100));
      const t = new Date(now - (10 - i) * 60_000); // i=0 is the oldest
      await fsp.utimes(p, t, t);
    }
    const oldTmp = `${'a'.repeat(40)}.123.abc.tmp`;
    const freshTmp = `${'b'.repeat(40)}.123.abc.tmp`;
    await fsp.writeFile(path.join(cacheDir, oldTmp), 'x');
    await fsp.writeFile(path.join(cacheDir, freshTmp), 'x');
    const old = new Date(now - 2 * 60 * 60 * 1000);
    await fsp.utimes(path.join(cacheDir, oldTmp), old, old);
    await fsp.writeFile(path.join(cacheDir, 'keep.txt'), Buffer.alloc(10_000));
    await fsp.writeFile(path.join(cacheDir, 'sub', `${'c'.repeat(40)}.webp`), Buffer.alloc(10_000));
    await fsp.writeFile(path.join(dir, `${'d'.repeat(40)}.webp`), 'outside the cache dir');

    // 500 bytes of cache against a 300-byte cap → prune to 240 → keep newest 2.
    const result = await thumbs.pruneThumbCache(cacheDir, { maxBytes: 300, now });
    const left = (await fsp.readdir(cacheDir)).sort();
    assert.deepEqual(left, [...names.slice(3), freshTmp, 'keep.txt', 'sub'].sort());
    assert.equal(result.totalBytes, 200);
    assert.equal(result.removed, 4); // three oldest entries + the abandoned tmp
    assert.ok(await fsp.stat(path.join(dir, `${'d'.repeat(40)}.webp`)));
    // A missing directory is not an error.
    assert.deepEqual(await thumbs.pruneThumbCache(path.join(dir, 'nope')), { removed: 0, totalBytes: 0 });
  });
});

test('cache lives under userData, never the data folder', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'main/util/thumbCache.js'), 'utf8');
  assert.match(src, /getPath\('userData'\)/);
  assert.doesNotMatch(src, /__dirname/, 'runtime cache must not resolve from the source tree (§21)');
  assert.doesNotMatch(src, /dataDir/);
});
