/**
 * Fuel phone page (`/f`): the built page and its route.
 *   - main/fuelWebclientHtml.js is built from webclient/fuel/* (never stale);
 *   - the page is self-contained (no CDN, no external fonts), small, Khmer-capable,
 *     uses the camera through a file input and nothing that needs HTTPS;
 *   - GET /f serves it with no-store + a tight CSP, gzipped, without a token,
 *     while every API call still needs one.
 * Plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const { buildFuelHtml } = require('../scripts/build-webclient');
const html = buildFuelHtml(ROOT);
const app = fs.readFileSync(path.join(ROOT, 'webclient/fuel/app.js'), 'utf8');

test('main/fuelWebclientHtml.js is built from webclient/fuel/ (run scripts/build-webclient.js)', () => {
  const generated = require('../main/fuelWebclientHtml.js');
  assert.equal(generated, html, 'main/fuelWebclientHtml.js is stale; run node scripts/build-webclient.js');
});

test('the page is one self-contained document, far smaller than /m', () => {
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/i, 'no external scripts, styles or fonts');
  assert.doesNotMatch(html, /@import|fonts\.googleapis|cdn\./i);
  assert.equal((html.match(/<script>/g) || []).length, 2, 'logic.js and app.js are inlined');
  assert.doesNotMatch(html, /\/\*@INLINE /);
  const bytes = Buffer.byteLength(html);
  const gz = zlib.gzipSync(html).length;
  assert.ok(bytes < 200 * 1024, `page is ${bytes} bytes`);
  assert.ok(gz < 50 * 1024, `gzipped page is ${gz} bytes`);
  const viewer = require('../main/webclientHtml.js');
  assert.ok(bytes < Buffer.byteLength(viewer) / 2);
});

test('Khmer first, with a font stack phones already have', () => {
  assert.match(html, /<html lang="km">/);
  assert.match(html, /"Noto Sans Khmer"/, 'Android');
  assert.match(html, /"Khmer Sangam MN"/, 'iOS');
});

test('plain-HTTP rules: camera via a file input, nothing that needs a secure context, no location', () => {
  assert.match(app, /type: 'file', accept: 'image\/\*', capture: 'environment'/);
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /navigator\.share|getUserMedia|randomUUID|geolocation|serviceWorker/);
  // Photos are shrunk on the phone before upload.
  assert.match(app, /PHOTO_MAX_PX = 1600/);
  assert.match(app, /toBlob\(resolve, 'image\/jpeg'/);
  // The token arrives in the fragment and is removed from the address bar.
  assert.match(app, /history\.replaceState\(null, '', window\.location\.pathname/);
  assert.doesNotMatch(app, /[?&]token=/);
  // The page only ever talks to the server that served it.
  assert.match(app, /var baseUrl = window\.location\.origin;/);
});

test('every save goes through the outbox with a client_ref; time is never sent', () => {
  assert.match(app, /outbox\.add\(\{/);
  assert.match(app, /L\.makeClientRef\(device\)/);
  // A direct record-saving rpc() would bypass the outbox's retry rules.
  assert.doesNotMatch(app, /rpc\('fuel:record|rpc\('fuel:receiveTransfer/);
  assert.doesNotMatch(app, /\bat: Date\.now\(\)/);
});

/* ── the route ────────────────────────────────────────────────────── */

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /f serves the page without a token; the API still needs one', async (t) => {
  const usersPath = require.resolve('../main/db/users');
  const previousUsers = require.cache[usersPath];
  require.cache[usersPath] = { id: usersPath, filename: usersPath, loaded: true, exports: { getByToken: () => null, touchLastSeen: () => {} } };
  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getVersion: () => '9.9.9-fuel' } } };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
    if (previousUsers) require.cache[usersPath] = previousUsers;
    else delete require.cache[usersPath];
  });
  const server = require('../main/server');
  const port = await freePort();
  await server.bootServer({ port, dataDir: '/unused-fuel-page', wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());

  for (const p of ['/f', '/f/']) {
    const res = await get(port, p);
    assert.equal(res.status, 200, p);
    assert.equal(res.body.toString(), html);
    assert.match(res.headers['content-type'], /text\/html; charset=utf-8/);
    assert.equal(res.headers['cache-control'], 'no-store, max-age=0, must-revalidate');
    assert.equal(res.headers['x-app-version'], '9.9.9-fuel');
    assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
  const zipped = await get(port, '/f', { 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(zipped.body).toString(), html);
  // A token in the query string is never needed — and the page itself is not secret.
  assert.equal((await get(port, '/f?x=1')).status, 200);
  // Everything else still needs a token.
  assert.equal((await get(port, '/api/whoami')).status, 401);
  assert.equal((await get(port, '/fuel')).status, 401);
});

test('review fixes: opens in the browser (not a standalone web app), neutral check line, double-tap guard', () => {
  // A standalone iOS web app has its own empty storage: signed out, queued records invisible.
  assert.doesNotMatch(html, /<meta name="apple-mobile-web-app-capable"/);
  assert.match(html, /touch-action: manipulation/);
  assert.match(app, /MOUNT_GUARD_MS = 350/);
  assert.match(app, /e\.isTrusted && Date\.now\(\) - mountedAt < MOUNT_GUARD_MS/);
  // The recorder never sees what a check found — only that the office will look.
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /fl\.explanation|\.measured|\.expected/);
  assert.match(code, /tr\('office_check'\)/);
  // A Save never waits forever.
  assert.match(app, /SAVE_WAIT_MS = 30000/);
  // Charts are fetched with the lists, so a dip works if the connection drops later.
  assert.match(app, /rpc\('fuel:getChart', l\.id\)/);
  const setup = fs.readFileSync(path.join(ROOT, 'renderer/modules/Fuel/FuelPhoneSetup.jsx'), 'utf8');
  assert.match(setup, /Open as Web App/);
  assert.doesNotMatch(setup, /Keep it on the home screen/);
});

test('Send to farm asks who is taking it (drivers first, "Not known" allowed) and sends it', () => {
  assert.match(app, /key: 'carriedByEmployeeId', title: 'pick_carrier', search: true, none: 'carrier_unknown'/);
  assert.match(app, /if \(d\.carriedByEmployeeId\) args\.carriedByEmployeeId = d\.carriedByEmployeeId;/);
  assert.match(app, /if \(!!a\.isDriver !== !!b\.isDriver\) return a\.isDriver \? -1 : 1;/);
  assert.match(app, /\['field_carrier'/);
});
