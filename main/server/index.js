/**
 * v0.14.2: HTTP server for multi-Mac client/server mode.
 *
 * Design — single generic RPC endpoint backed by a channel registry.
 * Instead of writing 60+ REST routes that mirror the existing IPC API,
 * we register handlers by channel name (same names as `ipcMain.handle`)
 * and expose them all behind one POST endpoint:
 *
 *   POST /api/rpc
 *     Body: { "channel": "products:list", "args": { ... } }
 *     Auth: Authorization: Bearer <user-token>
 *     Returns: { "result": ... } or { "error": "..." }
 *
 * The same handler function serves local IPC AND remote HTTP. Adding a
 * new client-accessible channel means calling `expose(channel, handler)`
 * once in ipc.js. No route boilerplate.
 *
 * Asset files (images) are served separately via `GET /assets/<path>`
 * with the same `assetsRoot`-bounded security check the local
 * `app-image://` protocol uses.
 */

const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { logSoftFailure } = require('../util/softFailure');
const { isMaintenanceActive, runTrackedOperation } = require('../util/maintenanceLifecycle');
const path = require('node:path');
const fs = require('node:fs');
const MAX_RPC_BODY_BYTES = 100 * 1024 * 1024;
const RPC_BODY_TOO_LARGE_MESSAGE =
  'Request body exceeds 100 MiB. Binary RPC payloads are transfer-encoded; keep raw files or batches below 75 MiB.';
// v0.1.89: what a refused RPC says to the person on the other Mac / phone.
const FORBIDDEN_MESSAGE = "Your account doesn't have permission to do that. Ask the admin.";
// v0.15.1: WebSocket support for live-update push to clients.
// Loaded lazily inside bootServer() so dev workflows that don't run
// the server (standalone mode) don't pay the import cost.
let WebSocketServer = null;

// In-memory registry of channel → handler. Populated by ipc.js via
// `registerHandler(channel, fn)` after the local DB is up.
const handlers = new Map();

/**
 * Per-request caller identity. AsyncLocalStorage keeps concurrent RPC
 * handlers isolated across awaits, including when they complete out of
 * order. Helpers like `companies.getActiveId()` read this context to
 * scope state per user.
 *
 * The local renderer (server-mode admin or standalone) has NO caller
 * user — it goes through ipcMain.handle, not /api/rpc. In that case
 * `getCurrentUserId()` returns null and downstream code falls back
 * to the shared app_state.
 */
const callerUserId = new AsyncLocalStorage();
function getCurrentUserId() { return callerUserId.getStore() ?? null; }

/**
 * v0.15.0: undo the client's base64 envelope so binary payloads
 * (`{ __bin: true, b64: '...' }`) arrive at the handler as Node
 * Buffers — the form `productImages.addFromBytes` and friends already
 * accept. Mirrors `serializeForServer()` in main/client/index.js.
 */
function deserializeFromClient(arg) {
  if (arg == null) return arg;
  if (Array.isArray(arg)) return arg.map(deserializeFromClient);
  if (typeof arg === 'object') {
    if (arg.__bin === true && typeof arg.b64 === 'string') {
      return Buffer.from(arg.b64, 'base64');
    }
    const out = {};
    for (const k of Object.keys(arg)) out[k] = deserializeFromClient(arg[k]);
    return out;
  }
  return arg;
}

/**
 * v0.15.0: re-encode binary returns (e.g. `templates:renderPreview`
 * returns `{ bytes: <Buffer> }`) into the same `{ __bin, b64 }` envelope
 * for the wire. The client's rpc() helper undoes this on receipt.
 */
function serializeResultForWire(val) {
  if (val == null) return val;
  if (Buffer.isBuffer(val)) {
    return { __bin: true, b64: val.toString('base64') };
  }
  if (val instanceof ArrayBuffer) {
    return { __bin: true, b64: Buffer.from(val).toString('base64') };
  }
  if (ArrayBuffer.isView(val)) {
    return { __bin: true, b64: Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64') };
  }
  if (Array.isArray(val)) return val.map(serializeResultForWire);
  if (typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[k] = serializeResultForWire(val[k]);
    return out;
  }
  return val;
}

function registerHandler(channel, fn) {
  if (typeof fn !== 'function') throw new Error(`registerHandler(${channel}): not a function`);
  handlers.set(channel, fn);
}

function getRegisteredChannels() {
  return Array.from(handlers.keys()).sort();
}

let _server = null;
let _bindings = null; // { port, addresses: string[] }
// A client gets two heartbeats (60s) to answer before it is dropped.
const WS_HEARTBEAT_MS = 30_000;
let _wss = null;
const _wsHeartbeats = new Map();

/**
 * Read the request body, JSON-parse it, and yield the parsed object.
 * Caps at 100MB to keep a misbehaving client from OOMing the server.
 */
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_RPC_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        const err = new Error(RPC_BODY_TOO_LARGE_MESSAGE);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error('Invalid JSON: ' + err.message)); }
    });
    req.on('error', (err) => { if (!tooLarge) reject(err); });
  });
}

/* Connectivity pass (0.1.94): compress big JSON answers. A 300-product
 * `products:list` is ~370 KB of JSON and ~21 KB gzipped; over a phone's
 * Tailscale link that is the difference between "instant" and "a few
 * seconds". Small answers go out as-is (gzip would only add CPU and a
 * header). Only when the caller says it accepts gzip — Node's fetch (the
 * client Mac) and every browser do. */
const GZIP_MIN_BYTES = 8 * 1024;

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
}

// Above this the payload is almost all base64 image bytes (a rendered
// preview, an uploaded file echoed back), which gzip barely shrinks.
const GZIP_MAX_BYTES = 32 * 1024 * 1024;

function writePlain(res, status, headers, buf) {
  res.writeHead(status, { ...headers, 'Content-Length': buf.length });
  res.end(buf);
}

/** Write a response body, gzipped off the event loop when that pays. */
function sendBody(req, res, status, headers, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (buf.length < GZIP_MIN_BYTES || buf.length > GZIP_MAX_BYTES || !acceptsGzip(req)) {
    writePlain(res, status, headers, buf);
    return;
  }
  require('node:zlib').gzip(buf, { level: 6 }, (err, zipped) => {
    if (res.headersSent || res.destroyed) return;
    if (err) { writePlain(res, status, headers, buf); return; }
    res.writeHead(status, {
      ...headers,
      'Content-Encoding': 'gzip',
      'Vary': headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding',
      'Content-Length': zipped.length,
    });
    res.end(zipped);
  });
}

function sendJson(res, status, body, req = null) {
  sendBody(req, res, status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  }, JSON.stringify(body));
}

function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const users = require('../db/users');
    const user = users.getByToken(token);
    if (!user) return null;
    users.touchLastSeen(user.id);
    return user;
  } catch (_) { return null; }
}

/**
 * Asset serving. URL form `/assets/<rel>` where `<rel>` is a path
 * relative to `<dataDir>/assets/`. Identical security checks to the
 * local `app-image://` protocol handler: must resolve inside the
 * assets / processed / ai-gallery roots, no `..`, no absolute paths.
 */
// v0.26.42: async asset serving. Pre-v0.26.42 this used existsSync +
// statSync, which blocked the entire HTTP server while the kernel
// statted the file. On iCloud-stored data dirs that's potentially
// seconds per request — and the server runs ALL HTTP requests on
// the same event loop, so one slow stat froze every other client.
// Now uses fs.promises and only this single request waits.
async function serveAsset(req, res, urlPath, dataDir) {
  const rel = decodeURIComponent(urlPath.replace(/^\/assets\//, ''));
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end(); return;
  }
  // Mirror protocol.js's three-root resolution.
  const assetsRoot = path.normalize(path.join(dataDir, 'assets'));
  const processedRoot = path.normalize(path.join(dataDir, 'processed'));
  const aiGalleryRoot = path.normalize(path.join(dataDir, 'ai-gallery'));
  let abs;
  if (rel.startsWith('processed/') || rel.startsWith('ai-gallery/')) {
    abs = path.join(dataDir, rel);
  } else {
    abs = path.join(assetsRoot, rel);
  }
  const normalized = path.normalize(abs);
  if (
    !isPathWithinRoot(assetsRoot, normalized) &&
    !isPathWithinRoot(processedRoot, normalized) &&
    !isPathWithinRoot(aiGalleryRoot, normalized)
  ) {
    res.writeHead(403); res.end(); return;
  }
  // Open first, then inspect that same handle. This closes the deletion race
  // between stat() and createReadStream() and also rejects directories before
  // sending a 200 response.
  let handle;
  let stat;
  try {
    handle = await fs.promises.open(normalized, 'r');
    stat = await handle.stat();
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch (_) { /* original error wins */ }
    }
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      res.writeHead(404); res.end(); return;
    }
    process.stderr.write(`[serveAsset] stat error: ${err.message}\n`);
    res.writeHead(500); res.end(); return;
  }
  if (!stat.isFile()) {
    await handle.close();
    res.writeHead(404); res.end(); return;
  }
  const ext = path.extname(normalized).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.png'  ? 'image/png' :
    ext === '.webp' ? 'image/webp' :
    ext === '.svg'  ? 'image/svg+xml' :
    'application/octet-stream';
  const etag = `"${stat.ino}-${stat.size}-${stat.mtimeMs}-${stat.ctimeMs}"`;
  const headers = {
    'Content-Type': mime,
    'Cache-Control': 'private, no-cache',
    'Vary': 'Authorization',
    'ETag': etag,
    'Last-Modified': stat.mtime.toUTCString(),
  };

  // Thumbnail tier (`?w=96` etc. from a client Mac's list views): answer with
  // a small cached WebP built by the same helper the local app-image://
  // protocol uses (main/util/thumbCache.js). Reached only after the root
  // checks above; any failure falls back to the original bytes.
  let thumbs = null;
  let thumbW = null;
  const queryAt = req.url.indexOf('?');
  const query = new URLSearchParams(queryAt === -1 ? '' : req.url.slice(queryAt + 1));
  if (query.has('w')) {
    thumbs = require('../util/thumbCache');
    thumbW = thumbs.isThumbable(normalized) ? thumbs.snapThumbWidth(query.get('w')) : null;
  }
  // The thumbnail is WebP whatever the original's extension — it is labelled
  // so (HANDOFF: serveAsset's MIME rule) and gets its own validator.
  const thumbEtag = thumbW ? `"${stat.ino}-${stat.size}-${stat.mtimeMs}-${stat.ctimeMs}-w${thumbW}"` : null;
  if (req.headers['if-none-match'] === (thumbEtag || etag)) {
    await handle.close();
    res.writeHead(304, thumbEtag ? { ...headers, 'Content-Type': thumbs.THUMB_MIME, 'ETag': thumbEtag } : headers);
    res.end();
    return;
  }
  if (thumbW) {
    const thumbPath = await thumbs.getThumbnail(normalized, { v: query.get('v'), w: thumbW, stat });
    if (thumbPath) {
      let thumbHandle;
      try {
        thumbHandle = await fs.promises.open(thumbPath, 'r');
        const thumbStat = await thumbHandle.stat();
        const original = handle;
        handle = thumbHandle;
        stat = thumbStat;
        headers['Content-Type'] = thumbs.THUMB_MIME;
        headers.ETag = thumbEtag;
        original.close().catch(() => { /* nothing left to read from it */ });
      } catch (_) {
        // Evicted between generation and open — serve the original.
        if (thumbHandle) {
          try { await thumbHandle.close(); } catch (__) { /* original wins */ }
        }
      }
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  const stream = handle.createReadStream({ autoClose: true });
  await new Promise((resolve) => {
    stream.on('error', (err) => {
      process.stderr.write(`[serveAsset] read error: ${err.message}\n`);
      if (!res.destroyed) res.destroy(err);
    });
    stream.on('close', resolve);
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  });
}

/** This Mac's name as other Macs see it: the Bonjour name without `.local`. */
function serverDisplayName() {
  try {
    const raw = String(require('node:os').hostname() || '').trim();
    return raw.replace(/\.local$/i, '') || null;
  } catch (_) {
    return null;
  }
}

/* ─── Keep the server Mac awake while it serves ─────────────────────
 * Connectivity pass (0.1.94). A Mac that idles to sleep takes the whole
 * shop offline: the client Macs go red and the phone viewer stops loading.
 * While the HTTP server is listening we hold Electron's
 * 'prevent-app-suspension' blocker (the system may still turn the display
 * off; it just does not sleep). Settings → Multi-Mac → "Keep this Mac awake
 * while serving" turns it off; the setting is re-read every few seconds, so
 * the switch takes effect without a restart. Released when the server stops. */
const KEEP_AWAKE_RECHECK_MS = 5_000;
let _keepAwakeId = null;
let _keepAwakeTimer = null;

function keepAwakeWanted() {
  try { return require('../config').loadConfig().serverKeepAwake !== false; }
  catch (_) { return true; }
}

function applyKeepAwake(listening) {
  let powerSaveBlocker = null;
  try { ({ powerSaveBlocker } = require('electron')); } catch (_) { /* not in Electron */ }
  if (!powerSaveBlocker || typeof powerSaveBlocker.start !== 'function') return;
  const want = listening && keepAwakeWanted();
  const holding = _keepAwakeId != null && powerSaveBlocker.isStarted(_keepAwakeId);
  if (want && !holding) {
    _keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
    process.stdout.write('[server] keeping this Mac awake while serving\n');
  } else if (!want && holding) {
    powerSaveBlocker.stop(_keepAwakeId);
    _keepAwakeId = null;
    process.stdout.write('[server] no longer keeping this Mac awake\n');
  }
}

function startKeepAwake() {
  applyKeepAwake(true);
  if (_keepAwakeTimer) return;
  _keepAwakeTimer = setInterval(() => applyKeepAwake(!!_server), KEEP_AWAKE_RECHECK_MS);
  _keepAwakeTimer.unref?.();
}

function stopKeepAwake() {
  if (_keepAwakeTimer) { clearInterval(_keepAwakeTimer); _keepAwakeTimer = null; }
  applyKeepAwake(false);
}

function getKeepAwakeStatus() {
  return { wanted: keepAwakeWanted(), holding: _keepAwakeId != null };
}

function isPathWithinRoot(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function handleRequest(req, res, dataDir) {
  // CORS preflight: clients are Electron renderers loaded from app://
  // protocol. Allow them.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const urlPath = req.url.split('?')[0];

  // Public health check — no auth required so clients can verify
  // they have the right URL before pasting in a token.
  if (req.method === 'GET' && urlPath === '/api/ping') {
    // v0.26.52: was `require('../../package.json').version`, which
    // works in the dev source layout but THROWS in the packaged app —
    // the compiled file lives at dist-electron/main/server/index.js
    // inside the asar, so `../../package.json` points at a
    // non-existent dist-electron/package.json. The throw made the
    // ENTIRE ping endpoint return 500, which surfaced to clients as a
    // permanent "Server hiccup" (amber) chip + a failing network
    // diagnostic ("reachable but not an Media Studio KH server"),
    // even though /api/whoami and all RPC calls worked fine. Use
    // app.getVersion() — the canonical Electron API that reads the
    // version correctly in both dev and production. Inline-required
    // to match the lazy-require style used elsewhere in this file.
    const appVersion = require('electron').app.getVersion();
    // Connectivity pass: the server Mac's name, so a client's chip can say
    // which Mac it is connected to. The same name Bonjour already announces
    // on the network (`<name>.local`), so this reveals nothing new.
    sendJson(res, 200, { ok: true, app: 'media-studio-kh', version: appVersion, name: serverDisplayName() });
    return;
  }

  // v0.34.0: the mobile/iPad web viewer page. Public like a login page —
  // the user still needs a token to talk to the API. Gated by the
  // `webViewerEnabled` config flag (read per-request, default ON, so the
  // Settings toggle takes effect with no restart). Served from a compiled
  // string (require('../webclientHtml')), never a source-tree file, so it
  // survives packaging (AGENTS.md §21).
  if (req.method === 'GET' && (urlPath === '/m' || urlPath === '/m/')) {
    let enabled = true;
    try { enabled = require('../config').loadConfig().webViewerEnabled !== false; } catch (_) {}
    if (!enabled) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('The mobile web viewer is turned off.');
      return;
    }
    let html;
    try { html = require('../webclientHtml'); } catch (_) { html = ''; }
    if (!html) { res.writeHead(500); res.end('viewer unavailable'); return; }
    // v0.49.4: `no-cache` was a footgun — it tells the browser "you MAY cache,
    // but must revalidate," and iOS Safari (especially the iPad) interpreted
    // that loosely enough to serve stale HTML across releases. Confirmed
    // symptom: iPad showed the pre-v0.47.0 layout (no ⋯ menu, Auto-crop in
    // the detail header) while the iPhone got the current build from the
    // SAME server. `no-store` is the universally-respected "do not cache".
    // The Pragma + Expires lines exist for older proxies that still gate on
    // HTTP/1.0 semantics — cheap belt-and-braces.
    // AGENTS.md §21: version comes from `app.getVersion()`, NEVER from
    // `require('../../package.json')` — the relative path resolves in dev but
    // breaks in the packaged build (the compiled file moves to
    // `dist-electron/main/server/index.js`). Same trap as the v0.26.52 bug.
    let version = '';
    try {
      version = require('electron').app.getVersion() || '';
    } catch (err) {
      // v0.1.12: an empty version here means clients show "v0.0.0" in the
      // sidebar and the diagnostics chip can't compare builds — the exact
      // symptom of the v0.26.52 packaging bug. Never let it be silent.
      logSoftFailure('server', 'read app version for /api/ping', err);
    }
    sendBody(req, res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      // Surfaces the running version in DevTools / `curl -I` so future
      // "is my iPad stale?" questions can be answered in 5 seconds.
      'X-App-Version': version,
    }, html);
    return;
  }

  // Fuel F1: the phone fuel page (docs/PEOPLE_AND_FUEL_PLAN.md §5.3). Public
  // like `/m` — every call it makes still needs a token with `fuel.record` or
  // `fuel.manage`. Served from the compiled string in main/fuelWebclientHtml.js
  // (scripts/build-webclient.js), never a source-tree file (AGENTS.md §21).
  // Not tied to the `webViewerEnabled` switch: that turns off the catalogue
  // viewer, and must not silently stop the pump phones recording fuel.
  if (req.method === 'GET' && (urlPath === '/f' || urlPath === '/f/')) {
    let html;
    try { html = require('../fuelWebclientHtml'); } catch (_) { html = ''; }
    if (!html) { res.writeHead(500); res.end('fuel page unavailable'); return; }
    let version = '';
    try { version = require('electron').app.getVersion() || ''; } catch (err) {
      logSoftFailure('server', 'read app version for /f', err);
    }
    sendBody(req, res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-App-Version': version,
      // The page needs nothing but itself and this server.
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    }, html);
    return;
  }

  // Pick & Pack Phase 0: the packing bench page (docs/PICK_AND_PACK_PLAN.md
  // §3.2–3.3). Public like `/m` and `/f` — every call it makes needs a token
  // with `pack.work` or `orders.manage`. Served from the compiled string in
  // main/packWebclientHtml.js (scripts/build-webclient.js), never a
  // source-tree file (AGENTS.md §21).
  if (req.method === 'GET' && (urlPath === '/pack' || urlPath === '/pack/')) {
    let html;
    try { html = require('../packWebclientHtml'); } catch (_) { html = ''; }
    if (!html) { res.writeHead(500); res.end('pack page unavailable'); return; }
    let version = '';
    try { version = require('electron').app.getVersion() || ''; } catch (err) {
      logSoftFailure('server', 'read app version for /pack', err);
    }
    sendBody(req, res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-App-Version': version,
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    }, html);
    return;
  }

  if (isMaintenanceActive()) {
    sendJson(res, 503, { error: 'Media Studio KH is performing maintenance and will restart shortly.' });
    return;
  }
  // Everything else requires auth.
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'Invalid or missing token' });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/whoami') {
    // v0.49.51: include the user's resolved capability list so the client
    // can gate its UI by capability (custom roles have no fixed rank).
    const { capsForRole } = require('../util/permissions');
    sendJson(res, 200, {
      user: { id: user.id, name: user.name, role: user.role, caps: capsForRole(user.role) },
      registeredChannels: getRegisteredChannels(),
    }, req);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/rpc') {
    // v0.20.0: rate-limit each user before even reading the body.
    const { checkRate, WINDOW_MS, LIMIT } = require('./rateLimit');
    const gate = checkRate(user.id);
    if (!gate.ok) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
      });
      res.end(JSON.stringify({
        error: `Rate limit exceeded (${LIMIT} calls per ${WINDOW_MS / 1000}s). Try again in a moment.`,
      }));
      return;
    }

    let body;
    const declaredBytes = Number(req.headers['content-length']);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RPC_BODY_BYTES) {
      req.resume();
      sendJson(res, 413, { error: RPC_BODY_TOO_LARGE_MESSAGE });
      return;
    }
    try { body = await readJsonBody(req); }
    catch (err) { sendJson(res, err.statusCode || 400, { error: err.message }); return; }
    const channel = body?.channel;
    if (!channel) { sendJson(res, 400, { error: 'channel required' }); return; }
    const handler = handlers.get(channel);
    if (!handler) { sendJson(res, 404, { error: `Unknown channel: ${channel}` }); return; }

    // v0.20.0: validate args before invoking the handler. Channels
    // without a registered validator pass through (current
    // behavior); registered ones return a clear 400 on bad shape.
    // Note: validators see the SERIALIZED args (with `__bin`
    // envelopes still wrapped) so bytes-handling channels write
    // their validators to expect that shape.
    const { getValidator } = require('./validators');
    const validate = getValidator(channel);
    if (validate) {
      const result = validate(body.args);
      if (result !== true) {
        sendJson(res, 400, { error: `Bad request: ${result}` });
        return;
      }
    }

    // v0.45.0: role-based authorisation. Runs AFTER shape validation so a
    // viewer trying to hit `products:update` gets "Forbidden" rather than a
    // misleading "Bad request" if the payload also happens to be wrong.
    // Local IPC is bypassed entirely — this only fires for /api/rpc.
    const { isAllowed, impliedChannels } = require('../util/permissions');
    if (!isAllowed(user.role, channel)
      || (impliedChannels?.(channel, body.args) ?? []).some((c) => !isAllowed(user.role, c))) {
      // v0.1.89: a plain sentence — this text is shown as-is in a toast on
      // the other Mac and on the phone. The role and the channel name are
      // in the server's own log instead.
      process.stdout.write(`[server] 403 role "${user.role}" → ${channel}\n`);
      sendJson(res, 403, { error: FORBIDDEN_MESSAGE });
      return;
    }

    try {
      const result = await callerUserId.run(
        user.id,
        () => handler(deserializeFromClient(body.args)),
      );
      sendJson(res, 200, { result: serializeResultForWire(result) }, req);
    } catch (err) {
      // Surface the error message but not the stack trace by default. A refusal
      // a handler threw on purpose (main/util/userError.js) is 422, so a client
      // can tell "the server said no" (do not retry) from "the server failed".
      const { isUserFacing, USER_ERROR_STATUS } = require('../util/userError');
      sendJson(res, isUserFacing(err) ? USER_ERROR_STATUS : 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (req.method === 'GET' && urlPath.startsWith('/assets/')) {
    // v0.26.42: await — serveAsset is now async. The outer handler
    // doesn't need the result (status is written directly to `res`)
    // but we DO want errors to be catchable by handleRequest's
    // try/catch up the stack.
    await serveAsset(req, res, urlPath, dataDir);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Boot the HTTP server. Returns a promise that resolves to the
 * { port, addresses } binding info, or rejects if the port is taken.
 * Listens on 0.0.0.0 so Tailscale / LAN clients can reach it.
 */
function bootServer({ port, dataDir, wsHeartbeatMs = WS_HEARTBEAT_MS }) {
  if (_server) return Promise.resolve(_bindings);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      runTrackedOperation(`http:${req.method || 'UNKNOWN'}`, () => handleRequest(req, res, dataDir)).catch((err) => {
        if (err?.code === 'APP_MAINTENANCE') {
          try { sendJson(res, 503, { error: err.message }); } catch (_) {}
          return;
        }
        process.stderr.write(`[server] unhandled: ${err.stack || err.message}\n`);
          // Last-seen / presence bookkeeping. Failing to stamp a timestamp must not
        try { sendJson(res, 500, { error: 'Internal server error' }); } catch (_) {}
      });
    });
    srv.on('error', reject);

    // v0.15.1: attach a WebSocket server to the same HTTP port.
    // Endpoint: ws://host:port/api/events?token=<bearer>. We can't
    // pass an Authorization header from a browser-style WebSocket
    // client, so the token rides in the query string. The transport
    // is private (Tailscale / LAN) so the leak risk is low; we log
    // only the user.name + connection event, never the raw token.
    try {
      if (!WebSocketServer) WebSocketServer = require('ws').WebSocketServer;
      const events = require('../events');
      const users = require('../db/users');
      const wss = new WebSocketServer({ noServer: true });
      _wss = wss;

      srv.on('upgrade', (req, socket, head) => {
        if (isMaintenanceActive()) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const url = req.url || '';
        if (!url.startsWith('/api/events')) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }
        // Parse the token query param. Anything else is rejected.
        let token = '';
        try {
          token = new URL(url, 'http://x').searchParams.get('token') || '';
        } catch (_) { /* malformed URL */ }
        if (!token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        let user = null;
        try {
          user = users.getByToken(token);
        } catch (_) { /* db unavailable */ }
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        try { users.touchLastSeen(user.id); } catch (_) {}

        wss.handleUpgrade(req, socket, head, (ws) => {
          // v0.15.3: attach the user record so presence queries can
          // list "who's online" without crawling the users table.
          events.addWsClient(ws, user);
          process.stdout.write(`[server] ws connected: ${user.name} (clients=${events.getWsClientCount()})\n`);
          // Greeting frame so the client knows the connection is
          // live before any catalog event fires.
          try {
            const { capsForRole } = require('../util/permissions');
            ws.send(JSON.stringify({
              channel: 'server:hello',
              payload: { user: { id: user.id, name: user.name, role: user.role, caps: capsForRole(user.role) } },
            }));
          } catch (_) {}
          ws.on('close', () => {
            events.removeWsClient(ws);
            process.stdout.write(`[server] ws disconnected: ${user.name} (clients=${events.getWsClientCount()})\n`);
          });
          ws.on('error', (err) => {
            process.stderr.write(`[server] ws error: ${err.message}\n`);
            events.removeWsClient(ws);
          });
          // Heartbeat ping every 30s so dead connections (laptop lid
          // closed, network drop) are detected and cleaned up
          // instead of lingering in _wsClients forever.
          //
          // Connectivity pass (0.1.94): sending a ping alone detected
          // nothing — a half-open socket accepts writes into the kernel
          // buffer without complaint. Standard isAlive/pong check now: a
          // client that has not answered (pong, its own ping, or any
          // message) since the previous tick is terminated, which also
          // drops it from presence.
          ws.isAlive = true;
          const markAlive = () => { ws.isAlive = true; };
          ws.on('pong', markAlive);
          ws.on('ping', markAlive);
          ws.on('message', markAlive);
          const interval = setInterval(() => {
            if (ws.readyState !== 1) {
              clearInterval(interval);
              return;
            }
            if (ws.isAlive === false) {
              process.stdout.write(`[server] ws unresponsive, dropping: ${user.name}\n`);
              clearInterval(interval);
              try { ws.terminate(); } catch (_) {}
              events.removeWsClient(ws);
              return;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch (_) {}
          }, wsHeartbeatMs);
          _wsHeartbeats.set(ws, interval);
          ws.on('close', () => {
            clearInterval(_wsHeartbeats.get(ws));
            _wsHeartbeats.delete(ws);
          });
          ws.on('close', () => clearInterval(interval));
        });
      });
    } catch (err) {
      process.stderr.write(`[server] ws init failed: ${err.message}\n`);
    }

    srv.listen(port, '0.0.0.0', () => {
      _server = srv;
      _bindings = { port, addresses: collectLocalAddresses() };
      process.stdout.write(`[server] listening on port ${port}\n`);
      try { startKeepAwake(); } catch (err) { logSoftFailure('server', 'keep this Mac awake', err); }
      resolve(_bindings);
    });
  });
}

function stopServer() {
  if (!_server) return Promise.resolve();
  try { stopKeepAwake(); } catch (err) { logSoftFailure('server', 'release keep-awake', err); }
  const events = require('../events');
  events.closeAllWsClients({ terminate: true });
  for (const interval of _wsHeartbeats.values()) clearInterval(interval);
  _wsHeartbeats.clear();
  try { _wss?.close(); } catch (_) {}
  _wss = null;
  return new Promise((resolve) => {
    _server.close(() => {
      _server = null;
      _bindings = null;
      // v0.20.0: clear rate-limit state so stale token buckets
      // don't survive a server stop / restart cycle.
      try { require('./rateLimit').reset(); } catch (_) {}
      resolve();
    });
  });
}

function getStatus() {
  return _bindings
    ? { running: true, ..._bindings, keepAwake: getKeepAwakeStatus().holding }
    : { running: false };
}

/**
 * Collect interesting local IPs the client could connect to: LAN IPs
 * (192.168.*, 10.*, 172.16-31.*) and Tailscale (100.64-127.*) on the
 * server Mac. Loopback / link-local skipped. Used by Settings to show
 * the admin the right URL to paste into clients.
 *
 * v0.26.35: also emit the `<hostname>.local` Bonjour name as a first-
 * class entry (kind='mdns'). macOS publishes the computer name over
 * mDNS automatically — any Mac on the same Wi-Fi resolves it
 * regardless of what DHCP did with the IP. This is the easy fix for
 * the most common LAN-client breakage: your router gave the server
 * Mac a new IP after a sleep / reboot and now every client's
 * `clientServerUrl` is stale. With the `.local` hostname they don't
 * see the IP change at all — DNS resolves freshly each connect.
 *
 * Caveat: mDNS only works inside one broadcast domain. Multi-subnet
 * setups (managed switches with VLANs, mesh routers with isolation
 * mode, public Wi-Fi networks that block mDNS) won't resolve
 * `.local`. The IPs stay in the list as fallback for those cases.
 *
 * Why we don't strip `.local` if `os.hostname()` already includes it:
 * on macOS, `os.hostname()` returns the LocalHostName which already
 * ends in `.local` if Sharing is on. Detect + reuse rather than
 * append blindly.
 */
function collectLocalAddresses() {
  const os = require('node:os');
  const ifs = os.networkInterfaces();
  const out = [];

  // v0.26.35: mDNS hostname entry. Listed FIRST when no Tailscale
  // address is present — for LAN-only users this is the friendliest
  // option to recommend to clients ("type ServerMac.local instead of
  // an IP that might change tomorrow").
  try {
    const raw = os.hostname();
    if (raw && typeof raw === 'string') {
      const trimmed = raw.trim();
      const host = trimmed.toLowerCase().endsWith('.local') ? trimmed : `${trimmed}.local`;
      // Only surface if the hostname is a reasonable shape — empty
      // strings or single-word "localhost" wouldn't actually work.
      if (host && host !== '.local' && host !== 'localhost.local') {
        out.push({ name: 'Bonjour hostname', ip: host, kind: 'mdns' });
      }
    }
  } catch (_) { /* hostname unavailable — fine, we still have IPs */ }

  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] || []) {
      if (iface.family !== 'IPv4') continue;
      if (iface.internal) continue;
      const ip = iface.address;
      // Categorize: Tailscale gets priority because it's the
      // recommended transport.
      let kind;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) kind = 'tailscale';
      else if (/^192\.168\./.test(ip)) kind = 'lan';
      else if (/^10\./.test(ip)) kind = 'lan';
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) kind = 'lan';
      else continue; // skip public / unusual ranges
      out.push({ name, ip, kind });
    }
  }
  // v0.26.35: sort order — Tailscale first (most robust across
  // networks), then mDNS (most robust within one network, survives
  // IP changes), then raw LAN IPs (most brittle but most universally
  // supported — works even on weird subnet setups where mDNS doesn't).
  const kindRank = { tailscale: 0, mdns: 1, lan: 2 };
  out.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9));
  return out;
}

module.exports = {
  registerHandler,
  getRegisteredChannels,
  getCurrentUserId,
  bootServer,
  stopServer,
  getStatus,
  collectLocalAddresses,
};
