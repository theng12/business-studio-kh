/**
 * Thumbnail tier on the server's `/assets/` route — what a client Mac's list
 * views download over Tailscale. The client-mode app-image:// protocol
 * forwards `?w=` verbatim, so this route must answer it: a small WebP,
 * labelled image/webp (HANDOFF: serveAsset's MIME rule), with its own ETag so
 * a revalidation is a 304 without re-encoding — and every root check exactly
 * as strict as without `w`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let sharp = null;
try { sharp = require('sharp'); sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }); } catch (_) { sharp = null; }
const SHARP_SKIP = sharp ? false : 'sharp does not load under this Node — run with Electron';

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stubModule('../main/db/users.js', {
  getByToken: (token) => token === 'thumb-token'
    ? { id: 'thumb-user', name: 'Thumb user', role: 'admin' }
    : null,
  touchLastSeen: () => {},
});

const server = require('../main/server');
const thumbs = require('../main/util/thumbCache');

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}

function get(port, assetPath, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/assets/${assetPath}`, {
    headers: { Authorization: 'Bearer thumb-token', Connection: 'close', ...headers },
  });
}

test('server /assets answers ?w= with a cached WebP thumbnail and keeps its root checks', { skip: SHARP_SKIP }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-thumb-server-test-'));
  const dataDir = path.join(dir, 'data');
  const cacheDir = path.join(dir, 'cache');
  thumbs.setThumbCacheDir(cacheDir);
  await fsp.mkdir(path.join(dataDir, 'assets', 'sku'), { recursive: true });
  await fsp.mkdir(path.join(dataDir, 'assets-sibling'), { recursive: true });
  const photo = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#a37' } })
    .jpeg({ quality: 90 }).toBuffer();
  await fsp.writeFile(path.join(dataDir, 'assets', 'sku', '001.jpg'), photo);
  await fsp.writeFile(path.join(dataDir, 'assets', 'sku', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fsp.writeFile(path.join(dataDir, 'assets', 'sku', 'broken.png'), 'not a png');
  await fsp.writeFile(path.join(dataDir, 'assets-sibling', 'outside.jpg'), photo);

  const port = await freePort();
  await server.bootServer({ port, dataDir });
  try {
    const original = await get(port, 'sku/001.jpg?v=h1');
    assert.equal(original.status, 200);
    assert.equal(original.headers.get('content-type'), 'image/jpeg');
    const originalEtag = original.headers.get('etag');
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), photo);

    // Same query shape the client protocol forwards (incl. its _auth fingerprint).
    const first = await get(port, 'sku/001.jpg?v=h1&w=96&_auth=0123456789abcdef');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/webp');
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal(first.headers.get('vary'), 'Authorization');
    const etag = first.headers.get('etag');
    assert.match(etag, /-w96"$/);
    assert.notEqual(etag, originalEtag);
    const body = Buffer.from(await first.arrayBuffer());
    assert.equal(Number(first.headers.get('content-length')), body.length);
    const meta = await sharp(body).metadata();
    assert.equal(meta.format, 'webp');
    assert.deepEqual([meta.width, meta.height], [154, 96]);
    assert.ok(body.length < photo.length / 4);

    // Revalidation is a 304 that still describes the thumbnail.
    const again = await get(port, 'sku/001.jpg?v=h1&w=96', { 'If-None-Match': etag });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('content-type'), 'image/webp');
    // …and the original's validator does not satisfy a thumbnail request.
    const crossed = await get(port, 'sku/001.jpg?v=h1&w=96', { 'If-None-Match': originalEtag });
    assert.equal(crossed.status, 200);
    await crossed.arrayBuffer();

    // Widths snap: 200 → 320.
    const snapped = await get(port, 'sku/001.jpg?w=200');
    assert.match(snapped.headers.get('etag'), /-w320"$/);
    assert.equal((await sharp(Buffer.from(await snapped.arrayBuffer())).metadata()).height, 320);

    // Anything that is not a thumbnail request serves the original bytes.
    for (const q of ['w=4000', 'w=abc', 'w=']) {
      const res = await get(port, `sku/001.jpg?${q}`);
      assert.equal(res.headers.get('content-type'), 'image/jpeg', q);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), photo, q);
    }
    const svg = await get(port, 'sku/logo.svg?w=96');
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await svg.text(), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const broken = await get(port, 'sku/broken.png?w=96');
    assert.equal(broken.status, 200);
    assert.equal(broken.headers.get('content-type'), 'image/png');
    assert.equal(await broken.text(), 'not a png');

    // Root checks are unchanged with w present.
    assert.equal((await get(port, '..%2Fassets-sibling%2Foutside.jpg?w=96')).status, 403);
    assert.equal((await get(port, 'processed/..%2F..%2Fassets-sibling%2Foutside.jpg?w=96')).status, 403);
    assert.equal((await get(port, 'sku/missing.jpg?w=96')).status, 404);
    const noAuth = await fetch(`http://127.0.0.1:${port}/assets/sku/001.jpg?w=96`, { headers: { Connection: 'close' } });
    assert.equal(noAuth.status, 401);
  } finally {
    await server.stopServer();
    thumbs.setThumbCacheDir(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
