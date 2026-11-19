/**
 * 0.1.94 connectivity pass — the rules that keep a client Mac and the phone
 * viewer honest about the server Mac being reachable.
 *
 * Pure JS (no database): the server is booted with the users table stubbed,
 * the way test/websocketLifecycle.test.js does it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const Module = require('node:module');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

/* ── 1. a timed-out read is not an "unknown outcome" ───────────────── */

test('read verbs are reads: a timed-out read never says it "may still have completed"', () => {
  const { isLikelyMutationChannel } = require('../main/util/rpcOutcome');
  for (const channel of [
    'products:list', 'images:listByProduct', 'companies:getActiveId', 'dashboard:recentBrands',
    'dashboard:recentProducts', 'dashboard:completeness', 'dashboard:stats', 'audit:countForEntity',
    'exports:listRuns', 'ai:estimateCost', 'templates:getApplyOutcome', 'pos:getProductCost',
  ]) {
    assert.equal(isLikelyMutationChannel(channel), false, `${channel} is a read`);
  }
  for (const channel of [
    'products:update', 'products:bulkUpsert', 'images:importFromBytes', 'companies:setActive',
    'images:reorderImages', 'templates:applyBulk', 'products:remove', 'images:findDuplicates',
  ]) {
    assert.equal(isLikelyMutationChannel(channel), true, `${channel} is treated as a write`);
  }
});

/* ── 2. plain-English network errors (AGENTS.md §18) ───────────────── */

test('network failures are explained in plain words, never as socket codes', () => {
  const { analyzeFetchError } = require('../main/util/fetchErrors');
  const wrap = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  const cases = [
    [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), /stopped answering/],
    [wrap(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })), /connection to the server Mac dropped/],
    [wrap(Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })), /stopped answering/],
    [wrap(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 13180 })), /isn't accepting connections on port 13180/],
    [wrap(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })), /Can't find the server Mac/],
    [wrap(Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH', address: '100.64.0.5' })), /No network route/],
    [wrap(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), /dropped/],
  ];
  for (const [err, expected] of cases) {
    const { message } = analyzeFetchError(err, 'http://100.64.0.5:13180');
    assert.match(message, expected);
    assert.doesNotMatch(message, /UND_ERR|aborted due to timeout|fetch failed/);
  }
});

test('a client still pointed at the Wi-Fi address is told the server only answers over Tailscale', () => {
  const { analyzeFetchError } = require('../main/util/fetchErrors');
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 13180 }),
  });

  const wifi = analyzeFetchError(refused, 'http://192.168.1.24:13180').message;
  assert.match(wifi, /no longer answers over Wi-Fi/, 'it names the real change, not a wrong port');
  assert.match(wifi, /Tailscale/, 'and says what to do instead');
  assert.doesNotMatch(wifi, /isn't accepting connections/);

  // Loopback and Tailscale keep the ordinary refusal: those addresses are the
  // ones the server still listens on, so a refusal there really is "not running".
  for (const url of ['http://127.0.0.1:13180', 'http://100.64.0.5:13180', 'http://studio-mac.local:13180']) {
    assert.match(analyzeFetchError(refused, url).message, /isn't accepting connections/, url);
  }
});

test('the preload strips Electron\'s "Error invoking remote method" prefix once', async () => {
  let api = null;
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../main/preload');
  delete require.cache[preloadPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer: {
          invoke: async (channel) => {
            throw new Error(`Error invoking remote method '${channel}': Error: The server Mac stopped answering.`);
          },
          on() {}, removeListener() {}, send() {},
        },
        webUtils: { getPathForFile: () => '' },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require('../main/preload');
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }
  await assert.rejects(api.products.list('company'), (err) => {
    assert.equal(err.message, 'The server Mac stopped answering.');
    return true;
  });
  await assert.rejects(api.client.reconnectNow(), /^Error: The server Mac stopped answering\.$/);
});

/* ── 3. client timing rules ─────────────────────────────────────────── */

function loadClientModule() {
  const originalLoad = Module._load;
  const clientPath = require.resolve('../main/client');
  delete require.cache[clientPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain: { handle() {}, on() {} }, app: { getVersion: () => 'test' }, BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../main/client'); }
  finally { Module._load = originalLoad; delete require.cache[clientPath]; }
}

test('reads give up after 20s, writes and preview renders keep 120s', () => {
  const { rpcTimeoutMs } = loadClientModule();
  assert.equal(rpcTimeoutMs('products:list'), 20_000);
  assert.equal(rpcTimeoutMs('companies:getActiveId'), 20_000);
  assert.equal(rpcTimeoutMs('dashboard:completeness'), 20_000);
  assert.equal(rpcTimeoutMs('products:update'), 120_000);
  assert.equal(rpcTimeoutMs('images:importFromBytes'), 120_000);
  assert.equal(rpcTimeoutMs('catalogStudio:preview'), 120_000, 'a preview render does real work on the server');
  assert.equal(rpcTimeoutMs('labels:preview'), 120_000);
});

test('after a missed ping the next one comes 1s later, then backs off to 10s', () => {
  const { pingRetryDelay } = loadClientModule();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(pingRetryDelay), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
});

/* ── 4. server: compression, server name, dead-socket cleanup ───────── */

const usersStub = {
  getByToken: (token) => (token === 'conn-token' ? { id: 'conn-user', name: 'Conn', role: 'admin' } : null),
  touchLastSeen: () => {},
};

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function rawGet(port, urlPath, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('the server gzips big JSON and the /m page, names itself on /api/ping, and drops dead sockets', async (t) => {
  const usersPath = require.resolve('../main/db/users');
  const previousUsers = require.cache[usersPath];
  require.cache[usersPath] = { id: usersPath, filename: usersPath, loaded: true, exports: usersStub };
  // /api/ping reads the version from Electron's `app`; plain Node has none.
  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getVersion: () => '9.9.9-test' } } };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const server = require('../main/server');
  const port = await freePort();
  server.registerHandler('connectivity:big', async () => Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, sku: `SKU-${i}`, name: 'A product with a reasonably long name' })));
  server.registerHandler('connectivity:small', async () => ({ ok: true }));
  await server.bootServer({ port, dataDir: '/unused-connectivity', wsHeartbeatMs: 150 });
  try {
    await t.test('ping names the server Mac', async () => {
      const res = await rawGet(port, '/api/ping');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body.toString());
      assert.equal(body.version, '9.9.9-test');
      assert.equal(typeof body.name, 'string');
      assert.ok(body.name.length > 0);
      assert.doesNotMatch(body.name, /\.local$/);
    });

    await t.test('big RPC answers are gzipped for a client that accepts it', async () => {
      const auth = { Authorization: 'Bearer conn-token', 'Content-Type': 'application/json' };
      const payload = JSON.stringify({ channel: 'connectivity:big', args: null });
      const zipped = await rawGet(port, '/api/rpc', { ...auth, 'Accept-Encoding': 'gzip, deflate' }, 'POST', payload);
      assert.equal(zipped.status, 200);
      assert.equal(zipped.headers['content-encoding'], 'gzip');
      assert.match(zipped.headers.vary, /Accept-Encoding/);
      const plainText = zlib.gunzipSync(zipped.body).toString();
      assert.equal(JSON.parse(plainText).result.length, 400);
      assert.ok(zipped.body.length < plainText.length / 4, `gzip should shrink the list (${zipped.body.length} vs ${plainText.length})`);

      const plain = await rawGet(port, '/api/rpc', auth, 'POST', payload);
      assert.equal(plain.headers['content-encoding'], undefined, 'no gzip without Accept-Encoding');
      assert.equal(JSON.parse(plain.body.toString()).result.length, 400);

      const small = await rawGet(port, '/api/rpc', { ...auth, 'Accept-Encoding': 'gzip' }, 'POST', JSON.stringify({ channel: 'connectivity:small' }));
      assert.equal(small.headers['content-encoding'], undefined, 'small answers are not worth compressing');
      assert.deepEqual(JSON.parse(small.body.toString()).result, { ok: true });

      // Node's own fetch (the client Mac's transport) decodes it transparently.
      const viaFetch = await fetch(`http://127.0.0.1:${port}/api/rpc`, { method: 'POST', headers: auth, body: payload });
      assert.equal((await viaFetch.json()).result.length, 400);
    });

    await t.test('the phone viewer page is gzipped', async () => {
      const res = await rawGet(port, '/m', { 'Accept-Encoding': 'gzip' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.match(zlib.gunzipSync(res.body).toString(), /<html/i);
      assert.equal(res.headers['cache-control'], 'no-store, max-age=0, must-revalidate');
    });

    await t.test('a socket that stops answering pings is terminated; a live one stays', async () => {
      const dead = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=conn-token`, { autoPong: false });
      const live = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=conn-token`);
      await Promise.all([dead, live].map((ws) => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); })));
      const closedAt = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('unresponsive socket was not dropped')), 3000);
        dead.once('close', () => { clearTimeout(timer); resolve(Date.now()); });
      });
      assert.ok(closedAt);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(live.readyState, WebSocket.OPEN, 'a socket that answers pings is kept');
      live.close();
    });
  } finally {
    await server.stopServer();
    if (previousUsers) require.cache[usersPath] = previousUsers;
    else delete require.cache[usersPath];
  }
});

/* ── 5. renderer helpers ────────────────────────────────────────────── */

async function bundleExports(entryCode) {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    stdin: { contents: entryCode, resolveDir: ROOT, loader: 'js' },
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
    external: ['react', 'react/jsx-runtime', 'zustand', 'zustand/*'],
  });
  const mod = { exports: {} };
  const stubs = {
    react: { forwardRef: (fn) => fn, useEffect() {}, useState: (v) => [v, () => {}] },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' },
  };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(
    (id) => stubs[id] || { create: () => () => ({}) }, mod, mod.exports,
  );
  return mod.exports;
}

test('the first hello of a boot does not reload what bootstrap just loaded; reconnects do', async () => {
  const { shouldSkipHelloResync, HELLO_RESYNC_GRACE_MS } = await bundleExports(
    "export { shouldSkipHelloResync, HELLO_RESYNC_GRACE_MS } from './renderer/store/bootstrap.js';",
  );
  const now = 100_000;
  const base = { wsOpenCount: 1, helloIndex: 1, bootstrapReady: true, bootstrapDoneAt: now - 1000, now };
  assert.equal(shouldSkipHelloResync(base), true, 'greeting right after bootstrap');
  assert.equal(shouldSkipHelloResync({ ...base, bootstrapReady: false }), true, 'greeting during bootstrap');
  assert.equal(shouldSkipHelloResync({ ...base, bootstrapDoneAt: now - HELLO_RESYNC_GRACE_MS - 1 }), false, 'too long after bootstrap');
  assert.equal(shouldSkipHelloResync({ ...base, helloIndex: 2 }), false, 'a second hello is a reconnect');
  assert.equal(shouldSkipHelloResync({ ...base, wsOpenCount: 2 }), false, 'a new socket is a reconnect');
  assert.equal(shouldSkipHelloResync({ ...base, wsOpenCount: undefined }), false, 'unknown → reconcile, as before');
});

test('ConnImg retries a failed image once the connection has come back', async () => {
  const { withRetryParam, shouldRetryImage } = await bundleExports(
    "export { withRetryParam, shouldRetryImage } from './renderer/components/ConnImg.jsx';",
  );
  assert.equal(withRetryParam('app-image://local/a.jpg?v=1&w=96', 3), 'app-image://local/a.jpg?v=1&w=96&r=3');
  assert.equal(withRetryParam('app-image://local/a.jpg', 2), 'app-image://local/a.jpg?r=2');
  assert.equal(withRetryParam('app-image://local/a.jpg?r=2&w=96', 5), 'app-image://local/a.jpg?w=96&r=5');
  assert.equal(withRetryParam('app-image://local/a.jpg', 0), 'app-image://local/a.jpg');
  const failed = { appMode: 'client', status: 'connected', reconnectCount: 4, failedAt: 3 };
  assert.equal(shouldRetryImage(failed), true);
  assert.equal(shouldRetryImage({ ...failed, reconnectCount: 3 }), false, 'no reconnect since the failure');
  assert.equal(shouldRetryImage({ ...failed, status: 'disconnected' }), false, 'still down');
  assert.equal(shouldRetryImage({ ...failed, appMode: 'standalone' }), false, 'a local file does not heal by reconnecting');
  assert.equal(shouldRetryImage({ ...failed, failedAt: null }), false, 'nothing failed');
});

/* ── 6. the phone viewer ────────────────────────────────────────────── */

const viewer = fs.readFileSync(path.join(ROOT, 'webclient/index.html'), 'utf8');

function viewerSearch() {
  const start = viewer.indexOf('/* search:begin');
  const end = viewer.indexOf('/* search:end */');
  assert.ok(start > 0 && end > start, 'the search block markers are gone');
  const ctx = {};
  vm.runInNewContext(`${viewer.slice(start, end)}
    this.fields = productSearchFields; this.matches = productMatchesSearch;`, ctx);
  return (product, query, brand = '') => ctx.matches(ctx.fields(product, brand), query);
}

test('phone search: every word must match, codes ignore separators, Khmer zero-width marks are ignored', () => {
  const match = viewerSearch();
  const p = { sku: 'AB-123', name: 'Blue ceramic vase', colorFinish: 'Matte', barcode: '885 0001 112' };
  assert.equal(match(p, 'AB 123'), true, '"AB 123" finds AB-123');
  assert.equal(match(p, 'ab123'), true);
  assert.equal(match(p, 'blue vase'), true, 'words in any order');
  assert.equal(match(p, 'blue bowl'), false, 'every word must match');
  assert.equal(match(p, 'matte'), true, 'colour / finish');
  assert.equal(match(p, '8850001112'), true, 'barcode without its spaces');
  assert.equal(match(p, 'acme vase', 'Acme'), true, 'brand name');
  const khmer = { sku: 'KH-1', name: 'ចាន​ធំ' };
  assert.equal(match(khmer, 'ចានធំ'), true, 'a zero-width space in the stored name');
  assert.equal(match({ sku: 'KH-2', name: 'ចានធំ' }, 'ចាន‌ធំ'), true, 'a zero-width joiner in the query');
  assert.equal(match({ sku: 'KH-3', name: 'é' }, 'é'), true, 'NFC: decomposed and composed é are the same');
  assert.equal(match(p, ''), true);
});

test('phone viewer: thumbnails for lists, no per-card image lookups, never the token form for a network failure', () => {
  assert.match(viewer, /assetUrl\(rel, p\.id, \{ w: 320/, 'cards ask for the 320px thumbnail');
  assert.match(viewer, /assetUrl\(rel, productId, \{ w: 640/, 'gallery tiles ask for the 640px thumbnail');
  assert.match(viewer, /hasOwnProperty\.call\(p, 'mainImagePath'\)/, 'cards use the main image named by products:list');
  assert.doesNotMatch(viewer, /showConnect\('Connected, but loading failed/, 'a load failure must not send the user back to the token form');
  // A deadline for the answer to start, then a separate one for the body
  // (test/reviewFixesWebclient.test.js runs it); AbortSignal.timeout could
  // not be re-armed once headers arrived, so a slow list body was cut off.
  assert.match(viewer, /function fetchT\(url, options, ms\)[\s\S]{0,1200}ctrl\.abort\(\)/, 'requests have a deadline');
  assert.match(viewer, /addEventListener\('popstate'/, 'Android Back closes the product sheet');
  assert.match(viewer, /history\.replaceState\(/, 'the pairing token is removed from the address bar');
  assert.match(viewer, /\(\?:\^#\|&\)t=/, 'the pairing token is read from the fragment');
  // Platform-neutral setup copy (the brother's phone is Android).
  const connectSection = viewer.slice(viewer.indexOf('<section id="connect">'), viewer.indexOf('</section>'));
  assert.doesNotMatch(connectSection, /iPad|Safari/);
});

test('Settings → Multi-Mac: no stale release copy, platform-neutral viewer copy, keep-awake toggle, real switch to client mode', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'renderer/modules/Settings/MultiMacPanel.jsx'), 'utf8');
  assert.doesNotMatch(panel, /Networking ships in v0\.14\.1/);
  assert.doesNotMatch(panel, /in Safari on (your|the) phone\/iPad/);
  assert.match(panel, /Keep this Mac awake while serving/);
  assert.match(panel, /setOne\('serverKeepAwake'/);
  assert.match(panel, /Switch to Client mode & restart/);
  assert.match(panel, /settings\.setMode\('client'\)/);
  assert.match(panel, /Show QR/);
  const config = fs.readFileSync(path.join(ROOT, 'main/config.js'), 'utf8');
  assert.match(config, /serverKeepAwake: true/);
});
