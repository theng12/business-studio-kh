const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stubModule('../main/db/users.js', {
  getByToken: (token) => token === 'asset-token'
    ? { id: 'asset-user', name: 'Asset user', role: 'admin' }
    : null,
  touchLastSeen: () => {},
});

const server = require('../main/server');

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
    headers: { Authorization: 'Bearer asset-token', Connection: 'close', ...headers },
  });
}

function oversizedRpc(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/rpc',
      method: 'POST',
      headers: {
        Authorization: 'Bearer asset-token',
        'Content-Type': 'application/json',
        'Content-Length': 100 * 1024 * 1024 + 1,
        Connection: 'close',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('asset HTTP path conditionally revalidates private bytes and handles invalid file targets', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-asset-server-test-'));
  const assetDir = path.join(dataDir, 'assets');
  const siblingDir = path.join(dataDir, 'assets-sibling');
  await fsp.mkdir(assetDir, { recursive: true });
  await fsp.mkdir(siblingDir, { recursive: true });
  await fsp.mkdir(path.join(assetDir, 'directory'), { recursive: true });
  const asset = path.join(assetDir, 'product.png');
  const vanishing = path.join(assetDir, 'vanishing.png');
  const broken = path.join(assetDir, 'broken.png');
  await fsp.writeFile(asset, 'version-one');
  await fsp.writeFile(vanishing, 'old-bytes');
  await fsp.writeFile(broken, 'unreadable-after-open');
  await fsp.writeFile(path.join(siblingDir, 'outside.png'), 'outside');

  const port = await freePort();
  await server.bootServer({ port, dataDir });
  try {
    const first = await get(port, 'product.png?v=hash-one');
    const firstBody = await first.text();
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.equal(firstBody, 'version-one');
    assert.ok(etag);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal(first.headers.get('vary'), 'Authorization');

    const oversized = await oversizedRpc(port);
    assert.equal(oversized.status, 413);
    assert.match(oversized.body.error, /100 MiB.*75 MiB/i);

    const unchanged = await get(port, 'product.png?v=hash-one', { 'If-None-Match': etag });
    assert.equal(unchanged.status, 304);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fsp.writeFile(asset, 'version-two');
    const changed = await get(port, 'product.png?v=hash-two');
    assert.equal(changed.status, 200);
    assert.equal(await changed.text(), 'version-two');
    assert.notEqual(changed.headers.get('etag'), etag);

    const directory = await get(port, 'directory');
    assert.equal(directory.status, 404);

    /* v0.1.78: the overlay batch zip is written under `processed/overlay-zips/`
       and the phone downloads it through THIS route. Nothing else on the phone
       path serves from `processed/`, so pin it: a fourth served root, or a
       change to the prefix rule, would break every batch download. */
    await fsp.mkdir(path.join(dataDir, 'processed', 'overlay-zips'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'processed', 'overlay-zips', 'batch.zip'), 'zipped-bytes');
    const zip = await get(port, 'processed/overlay-zips/batch.zip');
    assert.equal(zip.status, 200);
    assert.equal(await zip.text(), 'zipped-bytes');
    // …and the prefix rule is not a way out of the roots.
    const escapedProcessed = await get(port, 'processed/..%2Foutside.txt');
    assert.equal(escapedProcessed.status, 403);

    const escaped = await get(port, '..%2Fassets-sibling%2Foutside.png');
    assert.equal(escaped.status, 403);

    const originalOpen = fs.promises.open;
    const brokenStat = await fsp.stat(broken);
    fs.promises.open = async (filename, ...args) => {
      if (filename === vanishing) {
        const err = new Error('deleted before open');
        err.code = 'ENOENT';
        throw err;
      }
      if (filename === broken) {
        return {
          stat: async () => brokenStat,
          close: async () => {},
          createReadStream: () => {
            const stream = new PassThrough();
            process.nextTick(() => stream.destroy(new Error('synthetic read failure')));
            return stream;
          },
        };
      }
      return originalOpen.call(fs.promises, filename, ...args);
    };
    try {
      const disappeared = await get(port, 'vanishing.png');
      assert.equal(disappeared.status, 404);

      await assert.rejects(
        get(port, 'broken.png').then((response) => response.arrayBuffer()),
        /terminated|fetch failed|other side closed/i,
      );
    } finally {
      fs.promises.open = originalOpen;
    }
  } finally {
    await server.stopServer();
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});
