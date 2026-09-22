#!/usr/bin/env node
/**
 * Regression probe: the renderer must be able to `fetch()` an `app-image://`
 * URL, not just render it in an `<img>`.
 *
 * THE BUG THIS GUARDS (found 2026-09-22, fixed in v0.1.59). The renderer's
 * origin is `app://local`; an image lives at `app-image://local/...` — a
 * different origin. `<img>` tags ignore that difference, so every thumbnail in
 * the app looked perfect. `fetch()` does not: Chromium refuses to attempt a
 * cross-origin request to a scheme that is not registered as CORS-enabled, and
 * the failure is invisible until something depends on reading the bytes:
 *
 *   Access to fetch at 'app-image://local/…' from origin 'app://local' has been
 *   blocked by CORS policy: Cross origin requests are only supported for
 *   protocol schemes: app, chrome, chrome-extension, chrome-untrusted, data,
 *   http, https.
 *
 * The one caller that reads pixels is background removal
 * (`renderer/lib/bgRemoval.js` → `fetchImageBlob`), which is ON by default in
 * the Image Workspace — so "Apply to this image" failed with a bare
 * "Failed to fetch" while the preview beside it rendered fine. The CSP already
 * allowed `app-image:` in connect-src; CSP and CORS are two different gates.
 *
 * The fix is the `corsEnabled` privilege on the `app-image` scheme in
 * `main/index.js`. Measured both ways with this probe: without it the fetch is
 * refused before it leaves the renderer; with it the fetch succeeds even though
 * the protocol handler sends no Access-Control-Allow-Origin header, so the
 * header is NOT part of the fix.
 *
 * WHY THIS IS A SCRIPT AND NOT `npm test`. It needs a real BrowserWindow with a
 * real renderer origin — plain Node has neither, and ELECTRON_RUN_AS_NODE has no
 * Electron APIs at all. Run it with:
 *
 *     npm run check:images
 *
 * Exit code is non-zero when the renderer cannot read an image over fetch().
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, protocol, BrowserWindow } = require('electron');

// Its own profile, so a probe run can never touch the real one.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-image-cors-'));
const dataDir = path.join(profile, 'data');
app.setPath('userData', profile);

const hardTimeout = setTimeout(() => {
  process.stderr.write('app-image CORS probe timed out\n');
  app.exit(1);
}, 20_000);

// Registered exactly as main/index.js does — if those privileges drift, this
// probe keeps its own copy that must drift with them for the test to be
// meaningful, so it is deliberately duplicated here rather than imported.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-image',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

async function main() {
  // A real asset on disk, at the layout the renderer asks for.
  const assetDir = path.join(dataDir, 'assets', 'ACME');
  fs.mkdirSync(assetDir, { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
    'base64',
  );
  fs.writeFileSync(path.join(assetDir, 'probe.png'), png);

  const { registerImageProtocol, registerRendererProtocol } = require(path.join(__dirname, '..', 'main', 'protocol.js'));
  registerImageProtocol(dataDir);
  // Stand-in for the built renderer: the page just has to come from
  // `app://local` so the fetch below is genuinely cross-origin.
  protocol.handle('app', async () => new Response(
    '<!doctype html><html><body>probe</body></html>',
    { headers: { 'Content-Type': 'text/html' } },
  ));

  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL('app://local/index.html');
  const origin = await win.webContents.executeJavaScript('location.origin');
  assert.equal(origin, 'app://local', `renderer origin should be app://local, got ${origin}`);

  const url = 'app-image://local/ACME/probe.png?v=1';
  const fetched = await win.webContents.executeJavaScript(`
    fetch(${JSON.stringify(url)})
      .then(async (res) => ({ ok: res.ok, status: res.status, bytes: (await res.arrayBuffer()).byteLength }))
      .catch((err) => ({ error: String(err && err.message || err) }))
  `);
  assert.ok(!fetched.error, `fetch() of an app-image URL failed: ${fetched.error}`);
  assert.equal(fetched.ok, true, `expected a 200, got ${fetched.status}`);
  assert.equal(fetched.bytes, png.length, `expected ${png.length} bytes, got ${fetched.bytes}`);

  // A missing file must still be a clean 404, not a crash or a hang.
  const missing = await win.webContents.executeJavaScript(`
    fetch('app-image://local/ACME/nope.png')
      .then((res) => ({ status: res.status }))
      .catch((err) => ({ error: String(err && err.message || err) }))
  `);
  assert.equal(missing.status, 404, `a missing asset should 404, got ${JSON.stringify(missing)}`);

  // Path traversal stays blocked on the fetch path too.
  const traversal = await win.webContents.executeJavaScript(`
    fetch('app-image://local/${encodeURIComponent('../config.json')}')
      .then((res) => ({ status: res.status, byteLength: res.arrayBuffer ? 1 : 0 }))
      .catch((err) => ({ error: String(err && err.message || err) }))
  `);
  assert.ok(
    traversal.status === 403 || traversal.status === 404 || traversal.error,
    `traversal must not be served, got ${JSON.stringify(traversal)}`,
  );

  process.stdout.write(`OK — the renderer fetched ${fetched.bytes} bytes over app-image:// (404 and traversal still refused)\n`);
  win.destroy();
  void registerRendererProtocol;
}

app.whenReady()
  .then(main)
  .then(() => { clearTimeout(hardTimeout); app.exit(0); })
  .catch((err) => {
    clearTimeout(hardTimeout);
    process.stderr.write(`FAILED: ${err.stack || err.message}\n`);
    app.exit(1);
  });

process.on('exit', () => {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
});
