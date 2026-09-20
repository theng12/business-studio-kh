const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, net, protocol, session } = require('electron');

const disposableProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-electron-cache-probe-'));
app.setPath('userData', disposableProfile);
const hardTimeout = setTimeout(() => {
  process.stderr.write('Electron image-cache probe timed out\n');
  app.exit(1);
}, 15_000);

protocol.registerSchemesAsPrivileged([{
  scheme: 'app-image',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

function startAssetServer(name, initialBody) {
  const requests = [];
  let body = initialBody;
  const server = http.createServer((req, res) => {
    const token = req.headers.authorization || '';
    const record = { url: req.url, token, ifNoneMatch: req.headers['if-none-match'] || null };
    requests.push(record);
    if (token !== 'Bearer token-a' && token !== 'Bearer token-b') {
      res.writeHead(401, { 'Cache-Control': 'no-store' });
      res.end('denied');
      record.status = 401;
      record.bodyBytes = 6;
      return;
    }
    const etag = `"${name}-${body}"`;
    const headers = {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-cache',
      'Vary': 'Authorization',
      'ETag': etag,
    };
    if (record.ifNoneMatch === etag) {
      res.writeHead(304, headers);
      res.end();
      record.status = 304;
      record.bodyBytes = 0;
      return;
    }
    const bytes = Buffer.from(body);
    res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
    res.end(bytes);
    record.status = 200;
    record.bodyBytes = bytes.length;
  });
  return {
    requests,
    setBody(value) { body = value; },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

async function readImage(url) {
  const response = await net.fetch(url);
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()).toString() };
}

app.whenReady().then(async () => {
  await session.defaultSession.clearCache();
  const serverA = startAssetServer('server-a', 'one');
  const serverB = startAssetServer('server-b', 'other-server');
  let base = await serverA.listen();
  const baseB = await serverB.listen();
  let token = 'token-a';

  const { registerClientImageProtocol } = require('../main/protocol');
  registerClientImageProtocol(() => ({
    baseUrl: () => base,
    authHeader: () => `Bearer ${token}`,
  }));

  try {
    const imageV1 = 'app-image://local/products%2Fone.png?v=version-one';
    assert.deepEqual(await readImage(imageV1), { status: 200, body: 'one' });
    assert.deepEqual(await readImage(imageV1), { status: 200, body: 'one' });
    assert.equal(serverA.requests[1].ifNoneMatch, '"server-a-one"');
    assert.equal(serverA.requests[1].bodyBytes, 0);

    token = 'revoked';
    assert.deepEqual(await readImage(imageV1), { status: 401, body: 'denied' });
    assert.equal(serverA.requests[2].ifNoneMatch, null);

    token = 'token-b';
    assert.deepEqual(await readImage(imageV1), { status: 200, body: 'one' });
    assert.equal(serverA.requests[3].ifNoneMatch, null);

    serverA.setBody('two');
    const imageV2 = 'app-image://local/products%2Fone.png?v=version-two';
    assert.deepEqual(await readImage(imageV2), { status: 200, body: 'two' });
    assert.equal(serverA.requests[4].ifNoneMatch, null);

    base = baseB;
    assert.deepEqual(await readImage(imageV2), { status: 200, body: 'other-server' });
    assert.equal(serverB.requests[0].ifNoneMatch, null);

    process.stdout.write(`${JSON.stringify({
      repeatedBodyBytes: serverA.requests[0].bodyBytes + serverA.requests[1].bodyBytes,
      unchangedRevalidated: serverA.requests[1].status === 304,
      revokedStatus: serverA.requests[2].status,
      revokedConditional: Boolean(serverA.requests[2].ifNoneMatch),
      secondTokenStatus: serverA.requests[3].status,
      secondTokenConditional: Boolean(serverA.requests[3].ifNoneMatch),
      changedVersionStatus: serverA.requests[4].status,
      switchedServerStatus: serverB.requests[0].status,
      requests: serverA.requests.length + serverB.requests.length,
    })}\n`);
  } finally {
    await Promise.all([serverA.close(), serverB.close()]);
    clearTimeout(hardTimeout);
    try { fs.rmSync(disposableProfile, { recursive: true, force: true }); } catch (_) { /* disposable */ }
    app.quit();
  }
}).catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  clearTimeout(hardTimeout);
  try { fs.rmSync(disposableProfile, { recursive: true, force: true }); } catch (_) { /* disposable */ }
  app.exit(1);
});
