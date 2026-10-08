/**
 * v0.14.3: client-mode runtime.
 *
 * When the app boots with `config.mode === 'client'` we:
 *   - SKIP local DB init (no `database.sqlite` on this Mac)
 *   - SKIP the local `app-image://` protocol that resolves to disk; replace
 *     it with a passthrough that fetches `/assets/<rel>` from the server
 *     with the user's bearer token attached.
 *   - Wire each known RPC channel up to `ipcMain.handle` so the renderer
 *     can call `window.api.products.list(...)` exactly like it always has
 *     — but the call hops to the server over HTTP and back.
 *
 * The set of "known RPC channels" is hand-rolled here, not auto-discovered
 * from the server, because:
 *   1. The renderer wires `window.api` from `preload.js`, which is a
 *      compile-time surface. If we tried to lazily install handlers as
 *      the renderer asked for them we'd lose the "throws fast when the
 *      channel doesn't exist" property — `ipcMain.handle` throws
 *      synchronously on a duplicate registration and we'd rather have
 *      the channel list be explicit and reviewable in one place.
 *   2. The server has a strict allow-list anyway (only channels passed
 *      to `expose()` are in the registry). The client list mirroring it
 *      is intentional belt-and-braces.
 *
 * To add a channel to the client surface:
 *   - Server side: call `expose('domain:action', handler)` in main/ipc.js
 *   - Client side: add `'domain:action'` to PROXIED_CHANNELS below
 *
 * Channels not in PROXIED_CHANNELS still register as `ipcMain.handle`
 * stubs that throw a clear "not available in client mode" error, so the
 * renderer surfaces an honest toast instead of hanging on an
 * unregistered channel.
 */

const { ipcMain, app, BrowserWindow } = require('electron');
const { containedMediaPath } = require('../util/mediaPaths');
// v0.49.43: 429 retry/backoff math (pure helper — no electron dep).
const { retryWaitMs, shouldRetry } = require('../util/rateLimitRetry');
// v0.1.18: the shared argument check, so client-mode local channels validate
// exactly like the server/standalone ones do.
const { validateArgs } = require('../util/validateArgs');
const { writeExclusiveFile, writeUniqueFile } = require('../util/exclusiveFile');
const { isLikelyMutationChannel, isReadAction, isTimeoutError, mutationOutcomeUnknown } = require('../util/rpcOutcome');
// v0.15.1: WebSocket client (same `ws` lib as the server). Used in
// client mode to subscribe to live update events. Loaded lazily so
// standalone / server mode doesn't pay the import cost.
let WebSocket = null;

/**
 * v0.1.18: register a LOCAL-ONLY client channel, with the same argument
 * checking the server/standalone path uses.
 *
 * These 35 channels exist on the client because they have to act on the
 * CLIENT's Mac — the dialog opens here, the folder is scanned here, the
 * spreadsheet is parsed here. That also means they can't go through
 * `expose()` in main/ipc/helpers.js (which would publish them to a server
 * this process doesn't have) and they can't use `exposeLocal()` either,
 * because helpers.js pulls in the DB and the server registry at module
 * scope and client mode has neither.
 *
 * So they call the shared rule directly. `validateArgs` lives in
 * main/util/validateArgs.js precisely so both processes can reach it — see
 * the note there. Until v0.1.18 these were bare `ipcMain.handle` calls, which
 * is how "local-only" quietly also meant "unvalidated".
 *
 * Signature contract is `(args) => result`, identical to `exposeLocal()`, so
 * a handler body can be moved between the two without edits.
 */
function handleLocal(channel, handler) {
  ipcMain.handle(channel, (_e, ...args) => {
    validateArgs(channel, args[0]);
    return handler(args[0]);
  });
}

/* ─── HTTP RPC ─────────────────────────────────────────────────── */

let _config = null;
let _connectionState = {
  // v0.26.38: added 'degraded' — used when the server RESPONDED but
  // with a 5xx on /api/ping. That means the network is fine and the
  // HTTP layer is up; something inside the server hiccuped. Distinct
  // from 'disconnected' (truly unreachable) so the user can tell the
  // two failure modes apart at a glance.
  status: 'unknown',     // 'unknown' | 'unconfigured' | 'connecting' | 'connected' | 'degraded' | 'disconnected'
  lastOkAt: 0,
  lastError: null,
  user: null,
  serverVersion: null,
  reconnectCount: 0,
  wsOpenCount: 0,
};
let _identityGeneration = 0;
let _pollTimer = null;
// ponytail: JSON/base64 keeps the 100 MiB encoded ceiling and buffers the
// payload. Add streaming only for an operation whose normal workload needs it.
const MAX_RPC_BODY_BYTES = 100 * 1024 * 1024;
const DRAG_PREP_TTL_MS = 5 * 60 * 1000;
const issuedDragPaths = new Map();

function takeIssuedDragPaths(paths) {
  const now = Date.now();
  for (const [filePath, expiresAt] of issuedDragPaths) {
    if (expiresAt < now) issuedDragPaths.delete(filePath);
  }
  const allowed = [];
  for (const filePath of paths) {
    const expiresAt = issuedDragPaths.get(filePath);
    issuedDragPaths.delete(filePath);
    if (expiresAt >= now) allowed.push(filePath);
  }
  return allowed;
}
// v0.26.38: debounce counter for the ping loop. We only flip the
// chip red after N consecutive failures — a single transient ping
// failure (slow GC, momentary packet loss, server's HTTP layer
// pausing for a sec) shouldn't make the connection chip blink red.
// 2 is enough to absorb single-tick noise without making real
// disconnections invisible. Resets to 0 on any 2xx ping or any
// successful RPC call.
let _consecutivePingFailures = 0;
const PING_FAILURE_THRESHOLD = 2;
// v0.26.38: bumped from 5s to 10s. 5s was too aggressive for slow
// Tailscale hops or a server doing a heavy sharp re-encode while a
// ping comes in — caused legitimate-but-slow round-trips to time
// out and flip the chip red. 10s still bounds the user's wait but
// gives realistic networks the headroom they need.
const PING_TIMEOUT_MS = 10_000;
/* Connectivity pass (0.1.94). The loop used to ping every 30s while healthy
 * and — because the failure backoff doubled from 30s and was capped at 30s —
 * waited another 30s before the confirming second ping. A black-holed server
 * (asleep, off Tailscale) therefore took ~77s to turn the chip red, and every
 * call made in the meantime hung for its full 120s. Now:
 *   - healthy: one /api/ping every 12s (a tiny GET; the server answers it
 *     without touching the database);
 *   - after one failure: confirm 1s later instead of 30s;
 *   - while disconnected: retry 2s → 4s → 8s → 10s cap, so recovery is seen
 *     within seconds of the server coming back. */
const PING_HEALTHY_INTERVAL_MS = 12_000;
const PING_CONFIRM_DELAY_MS = 1_000;
const PING_RETRY_MAX_MS = 10_000;
/* Ordinary reads give up after 20s (a product list of 2,500 rows is ~21 KB
 * gzipped); writes and uploads keep 120s, because a write that times out may
 * still have committed and a large upload legitimately takes a while. Preview
 * renders are reads that do real work on the server, so they keep 120s too. */
const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 120_000;
/* No response headers for this long on any call → ask /api/ping straight away
 * (short timeout). If that fails too, the server is gone: say so now instead
 * of when the call finally times out. The ping keeps a slow-but-alive server
 * (a big bulk upsert, an upload on a thin link) from being reported as down. */
const RPC_STALL_PROBE_MS = 15_000;
const RPC_STALL_PROBE_TIMEOUT_MS = 6_000;
let _pollInFlight = null;
let _reconnectCount = 0;

function getConnectionState() {
  return { ..._connectionState };
}

function setConnectionState(patch) {
  const wasDown = _connectionState.status === 'disconnected' || _connectionState.status === 'degraded';
  if (wasDown && patch.status === 'connected') {
    // Bumped on every recovery. Pushed with the state so the renderer's
    // ConnImg can retry images that failed while the server was away.
    _reconnectCount += 1;
    patch = { ...patch, reconnectCount: _reconnectCount };
  }
  _connectionState = { ..._connectionState, ...patch };
  // Push to renderer if a window is open.
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('client:connectionState', _connectionState);
    }
  } catch (_) { /* main window not up yet */ }
}

function baseUrl() {
  if (!_config?.clientServerUrl) return null;
  /* v0.1.31: normalise on read as well as on write. A config saved BEFORE the
   * write-side fix may still carry a path (the `…/m` mobile-viewer address),
   * and stripping it here means that Mac connects correctly on this build
   * rather than needing the user to retype the address. */
  const { normalizeServerUrl } = require('../util/fetchErrors');
  return normalizeServerUrl(_config.clientServerUrl).replace(/\/+$/, '');
}

function authHeader() {
  if (!_config?.clientToken) return null;
  return `Bearer ${_config.clientToken}`;
}

/**
 * v0.15.0: walk a renderer-supplied IPC arg and base64-encode any
 * binary payloads (ArrayBuffer / TypedArray / Buffer) we find inside
 * objects or arrays. JSON can't carry binary, so this is how
 * `images:importFromBytes` / `watermarks:uploadFromBytes` get across
 * the wire. The server's RPC dispatcher mirrors this with
 * `deserializeForServer()` and turns the marker back into a Node
 * Buffer the handler can hand straight to Sharp.
 *
 * Format: `{ __bin: true, b64: '<base64>' }`. Chosen because it's
 * trivially detectable (no plain object should have `__bin: true` as
 * its own field) and JSON-clean. ~33% overhead is fine for product
 * imagery (1–5 MB → 1.3–6.6 MB).
 */
/**
 * Inverse of serializeForServer + the server's serializeResultForWire.
 * The handler may return `{ bytes: <Buffer> }`; the server wraps that
 * as `{ bytes: { __bin, b64 } }`; we unwrap back to a Node Buffer so
 * the renderer (via Electron's structured-clone IPC) sees binary.
 */
function deserializeFromServer(val) {
  if (val == null) return val;
  if (Array.isArray(val)) return val.map(deserializeFromServer);
  if (typeof val === 'object') {
    if (val.__bin === true && typeof val.b64 === 'string') {
      return Buffer.from(val.b64, 'base64');
    }
    const out = {};
    for (const k of Object.keys(val)) out[k] = deserializeFromServer(val[k]);
    return out;
  }
  return val;
}

function serializeForServer(arg) {
  if (arg == null) return arg;
  if (arg instanceof ArrayBuffer) {
    return { __bin: true, b64: Buffer.from(arg).toString('base64') };
  }
  if (ArrayBuffer.isView(arg)) {
    return { __bin: true, b64: Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength).toString('base64') };
  }
  if (Buffer.isBuffer(arg)) {
    return { __bin: true, b64: arg.toString('base64') };
  }
  if (Array.isArray(arg)) return arg.map(serializeForServer);
  if (typeof arg === 'object') {
    const out = {};
    for (const k of Object.keys(arg)) out[k] = serializeForServer(arg[k]);
    return out;
  }
  return arg;
}

/**
 * Call a channel on the server. Returns whatever the handler returned
 * (`result` field of the JSON envelope). Throws if the server returns
 * an error status or `{ error }` body.
 *
 * Single-arg convention matches the server's expose() contract. The
 * preload calls `(method)(arg)` and we forward the same arg shape.
 */
/* ─── v0.26.33: RPC activity telemetry ─────────────────────────────
 *
 * Why this exists: on slow LAN / Tailscale links the initial slice
 * fetch (companies + brands + categories + products + dashboard +
 * exports + AI prompts + AI tasks) can take 5–15 seconds. Without a
 * visible "this is alive" signal, users assume the app is broken and
 * force-quit. The SyncOverlay reads from these events so the renderer
 * can show:
 *   - which RPC channel is currently in flight ("Loading products…")
 *   - bytes downloaded so far ("12.4 MB")
 *   - how many calls have completed
 *
 * Two surfaces consume this:
 *   1. Boot SyncOverlay — full-window during the initial bootstrap.
 *   2. Sidebar footer chip — persistent "↓ 2.3 MB · 47 calls" so the
 *      user has a heartbeat in steady-state too.
 *
 * Counters never decay; they're per-launch lifetime totals. The
 * renderer interprets "no activity for N ms" as quiet.
 */
const _syncStats = {
  totalBytesIn: 0,        // response bytes summed (post-headers, body only)
  totalBytesOut: 0,       // request bytes summed
  callCount: 0,           // total RPC calls completed (ok + failed)
  okCount: 0,
  errorCount: 0,
  lastActivityAt: 0,
  lastChannel: null,
  lastDurationMs: 0,
  startedAt: Date.now(),
  inFlight: 0,
};

function getSyncStats() { return { ..._syncStats }; }

function broadcastRpcActivity(payload) {
  // We don't import ../events here because that module is server-side
  // (talks to ws clients we don't have). Use direct BrowserWindow
  // dispatch on the local renderer instead — same pattern
  // dispatchIncoming() uses.
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('client:rpcActivity', payload);
    }
  } catch (_) {}
}

/** Per-attempt deadline for one RPC (see READ_TIMEOUT_MS). */
function rpcTimeoutMs(channel) {
  const action = String(channel || '').split(':').slice(1).join(':');
  if (!isLikelyMutationChannel(channel) && isReadAction(action) && !/preview/i.test(action)) {
    return READ_TIMEOUT_MS;
  }
  return WRITE_TIMEOUT_MS;
}

/* ─── Stall watchdog ─────────────────────────────────────────────
 * One unref'd interval checks the in-flight calls. A call that has waited
 * RPC_STALL_PROBE_MS without response headers triggers one short ping; if the
 * ping fails as well, the chip turns red and the offline banner appears now,
 * ~15s in, rather than when the call gives up. Nothing is aborted here — a
 * write that is merely slow is left to finish. */
const _rpcInFlight = new Set();
let _rpcWatchdog = null;
let _stallProbe = null;
/* A server busy with a long write (a big bulk upsert, an upload being
 * decoded) can miss one 6s ping while still alive. So the watchdog needs TWO
 * consecutive failed stall pings before it says anything, and when a write is
 * among the waiting calls it says "busy" (degraded, amber) rather than
 * "disconnected" — the regular ping loop, which it kicks, still flips to
 * disconnected on its own two-in-a-row rule if the server really is gone. */
let _stallProbeFailures = 0;
const STALL_PROBE_FAILURES_TO_REPORT = 2;

function ensureRpcWatchdog() {
  if (_rpcWatchdog) return;
  _rpcWatchdog = setInterval(checkStalledRpcs, 2_500);
  _rpcWatchdog.unref?.();
}

function checkStalledRpcs() {
  if (_rpcInFlight.size === 0) {
    clearInterval(_rpcWatchdog);
    _rpcWatchdog = null;
    return;
  }
  const now = performance.now();
  let stalled = null;
  for (const flight of _rpcInFlight) {
    if (!flight.headers && !flight.probed && now - flight.startedPerf >= RPC_STALL_PROBE_MS) {
      flight.probed = true;
      stalled = flight;
    }
  }
  if (!stalled || _stallProbe || _connectionState.status === 'disconnected') return;
  const url = baseUrl();
  if (!url) return;
  _stallProbe = fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(RPC_STALL_PROBE_TIMEOUT_MS) })
    .then((res) => {
      if (!res.ok) throw Object.assign(new Error(`Status ${res.status}`), { httpStatus: res.status });
      _stallProbeFailures = 0;
    })
    .catch((err) => {
      if (err?.httpStatus) { _stallProbeFailures = 0; return; } // the server answered — slow, not gone
      process.stderr.write(`[client rpc] ${stalled.channel} has had no response for ${Math.round(RPC_STALL_PROBE_MS / 1000)}s and /api/ping failed: ${err?.message || err}\n`);
      const verdict = stallProbeVerdict(++_stallProbeFailures, [..._rpcInFlight].map((f) => f.channel));
      if (verdict === 'retry') {
        // One miss: probe again on the next tick before saying anything.
        stalled.probed = false;
        return;
      }
      _stallProbeFailures = 0;
      if (verdict === 'busy') {
        setConnectionState({
          status: 'degraded',
          lastError: 'The server Mac is busy — it is still working on a save or upload from this Mac and has not answered a quick check. Leave it to finish.',
        });
        schedulePoll(PING_CONFIRM_DELAY_MS);
        return;
      }
      const { analyzeFetchError } = require('../util/fetchErrors');
      _consecutivePingFailures = PING_FAILURE_THRESHOLD;
      setConnectionState({ status: 'disconnected', lastError: analyzeFetchError(err, url).message });
      schedulePoll(PING_CONFIRM_DELAY_MS);
    })
    .finally(() => { _stallProbe = null; });
}

/** Pure: what a failed stall ping means. 'retry' until the second
 *  consecutive miss; then 'busy' if a write is among the waiting calls
 *  (the server may just be working on it), else 'down'. */
function stallProbeVerdict(failures, inFlightChannels) {
  if (failures < STALL_PROBE_FAILURES_TO_REPORT) return 'retry';
  return (inFlightChannels || []).some((c) => isLikelyMutationChannel(c)) ? 'busy' : 'down';
}

async function rpc(channel, args, timeoutMs) {
  const url = baseUrl();
  const auth = authHeader();
  if (!url) throw new Error('Server URL not set (Settings → Multi-Mac → Client mode)');
  if (!auth) throw new Error('Server token not set (Settings → Multi-Mac → Client mode)');

  // Optional caller budget spans headers, body, and 429 backoff/retries.
  // Ordinary calls retain their existing per-attempt 120-second timeout.
  const budgetSignal = timeoutMs == null ? null : AbortSignal.timeout(timeoutMs);
  const startedAt = Date.now();
  const requestBody = JSON.stringify({ channel, args: serializeForServer(args) });
  const requestBytes = Buffer.byteLength(requestBody, 'utf8');
  _syncStats.inFlight += 1;
  _syncStats.lastChannel = channel;
  // Stall watchdog bookkeeping (see RPC_STALL_PROBE_MS). performance.now(),
  // not Date.now(), so a test that fakes the wall clock cannot trip it.
  const flight = { channel, startedPerf: performance.now(), headers: false, probed: false };
  _rpcInFlight.add(flight);
  ensureRpcWatchdog();
  // Fire a "started" event so the overlay can show the current
  // channel immediately, not just after the response lands.
  broadcastRpcActivity({
    phase: 'start', channel, startedAt, requestBytes,
    stats: getSyncStats(),
  });

  let res;
  let responseBytes = 0;
  let body;
  try {
    if (requestBytes > MAX_RPC_BODY_BYTES) {
      _syncStats.errorCount += 1;
      throw new Error(
        'This transfer exceeds the server’s 100 MiB request limit. ' +
        'Binary data expands during transfer encoding, so keep raw files or batches below 75 MiB.',
      );
    }
    // v0.49.43: retry loop for HTTP 429. The server's /api/rpc limiter
    // (120 calls / 10s per token) returns a 429 + Retry-After when a
    // burst — e.g. a post-bulk-op refetch — exceeds it. Previously we
    // threw immediately and failed the whole operation; now we wait the
    // hinted interval and retry a bounded number of times so transient
    // bursts self-heal. Non-429 responses fall straight through.
    const perAttemptMs = rpcTimeoutMs(channel);
    for (let attempt = 0; ; attempt++) {
      const signal = budgetSignal || AbortSignal.timeout(perAttemptMs);
      try {
        budgetSignal?.throwIfAborted();
        res = await fetch(`${url}/api/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: requestBody,
          // v0.32.0: every other fetch here has a timeout EXCEPT this one —
          // so a stalled call (slow Tailscale hop, server mid-GC, a response
          // that starts then hangs) blocked forever. That's the "first sync
          // stuck at 29.7 KB" + "CSV import never finishes" symptom: one hung
          // call freezes the whole bootstrap await-chain with no error. 120s
          // is generous for a big bulkUpsert / full product list, but finite,
          // so a genuine stall now rejects → the chip turns red + the UI
          // recovers instead of spinning forever.
          signal,
        });
        flight.headers = true;

        // Keep body consumption inside the same transport error boundary as
        // headers: a timed-out write response is still an unknown outcome.
        let responseText = '';
        body = null;
        try {
          responseText = await res.text();
          responseBytes += Buffer.byteLength(responseText, 'utf8');
          if (responseText) body = JSON.parse(responseText);
        } catch (err) {
          if (signal.aborted || isTimeoutError(err)) throw err;
          // Preserve ordinary response parsing behavior.
        }
      } catch (err) {
        if (channel !== 'templates:getApplyOutcome' && isLikelyMutationChannel(channel) &&
            (isTimeoutError(err) || isTimeoutError(signal.reason))) {
          // The server handler is not cancelled by an HTTP client abort. Do
          // not turn an unknown write outcome into a blind duplicate retry.
          const unknown = mutationOutcomeUnknown(channel, err);
          setConnectionState({ status: 'disconnected', lastError: unknown.message });
          _syncStats.errorCount += 1;
          throw unknown;
        }
        // Network-level failure → flag disconnected so the sidebar chip can
        // turn red. v0.26.34: route through analyzeFetchError so the
        // toast shows the actual reason ("Server refused the connection
        // on port 13180") instead of the opaque "fetch failed".
        const { analyzeFetchError } = require('../util/fetchErrors');
        const analyzed = analyzeFetchError(err, url);
        setConnectionState({ status: 'disconnected', lastError: analyzed.message });
        _syncStats.errorCount += 1;
        // A read that timed out is simply a failed read — it has nothing to
        // "complete". Say so in words the user can act on (§18).
        const readTimedOut = (isTimeoutError(err) || isTimeoutError(signal.reason)) && !isLikelyMutationChannel(channel);
        throw new Error(
          readTimedOut ? `${analyzed.message} Nothing was changed.` : analyzed.message,
          { cause: err },
        );
      }

      // Rate limited → wait the server's Retry-After (or backoff) and try
      // again, up to the helper's cap. After the cap, fall through and let
      // the !res.ok branch surface the rate-limit message as a normal error.
      if (res.status === 429 && shouldRetry(attempt)) {
        const waitMs = retryWaitMs(res.headers.get('retry-after'), attempt);
        process.stdout.write(`[client rpc] 429 on ${channel}; retrying in ${waitMs}ms (attempt ${attempt + 1})\n`);
        if (budgetSignal) {
          await require('node:timers/promises').setTimeout(waitMs, undefined, { signal: budgetSignal });
        } else {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        continue;
      }
      break;
    }

    if (res.status === 401) {
      setConnectionState({ status: 'disconnected', lastError: 'Token rejected' });
      _syncStats.errorCount += 1;
      throw new Error('Token rejected by server. Ask the admin to regenerate.');
    }
    if (!res.ok) {
      let msg = body?.error || `Server returned ${res.status}`;
      _syncStats.errorCount += 1;
      // A 404 "Unknown channel: X" means the SERVER is on an older build
      // that doesn't have this channel — almost always a client that was
      // updated ahead of the server after a feature release (e.g. the
      // OPERATIONS / costing channels landed in v0.49.46+). Rewrite the
      // raw server error into an actionable one that names the version
      // gap, instead of showing the user "Unknown channel: suppliers:list".
      if (res.status === 404 && /^Unknown channel:/.test(String(msg))) {
        const sv = _connectionState.serverVersion;
        const cv = app.getVersion();
        msg =
          `This feature needs a newer version on the server. ` +
          `The server Mac is running ${sv ? `v${sv}` : 'an older version'}, which doesn’t have it yet — ` +
          `update Business Studio KH on the server to v${cv} (install the DMG there, then quit and reopen it). ` +
          `Existing features keep working; only newer ones are missing until the server matches.`;
      }
      // Don't flip connection state on per-call errors (e.g. "Product not
      // found" is a 500 — the server itself is fine). Only network/auth
      // failures count as disconnection.
      throw new Error(msg);
    }
    // Successful call → also a successful health check. Bump lastOkAt
    // so the sidebar chip stays green. v0.26.38: also reset the ping
    // debounce counter and clear 'degraded' state — a successful RPC
    // is strictly a stronger signal than a successful /api/ping (it
    // exercises more of the server's stack).
    _consecutivePingFailures = 0;
    if (_connectionState.status !== 'connected') {
      setConnectionState({ status: 'connected', lastOkAt: Date.now(), lastError: null });
    } else {
      setConnectionState({ lastOkAt: Date.now() });
    }
    _syncStats.okCount += 1;
    return deserializeFromServer(body?.result);
  } finally {
    _rpcInFlight.delete(flight);
    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;
    _syncStats.inFlight = Math.max(0, _syncStats.inFlight - 1);
    _syncStats.callCount += 1;
    _syncStats.totalBytesIn += responseBytes;
    _syncStats.totalBytesOut += requestBytes;
    _syncStats.lastActivityAt = endedAt;
    _syncStats.lastDurationMs = durationMs;
    broadcastRpcActivity({
      phase: 'end', channel, startedAt, endedAt, durationMs,
      requestBytes, responseBytes,
      ok: !!res?.ok,
      stats: getSyncStats(),
    });
  }
}

/* ─── Live updates (WebSocket subscription) ────────────────────── */

let _ws = null;
let _wsReconnectTimer = null;
let _wsBackoffMs = 1000;

/**
 * Forward an incoming WS event frame into the renderer over IPC.
 * The renderer already has subscribers (`window.api.ai.onTaskUpdate`,
 * etc.); we re-emit on the SAME channels the standalone path uses so
 * the renderer doesn't need to know whether it's running locally or
 * over the wire.
 *
 * `client:catalogChanged` is the one new channel — used by clients to
 * refetch when another Mac edits the catalog. The store wires this up
 * to the existing `refreshProducts / refreshBrands / etc.` actions.
 */
function dispatchIncoming({ channel, payload }) {
  if (!channel) return;
  if (channel === 'server:hello' && payload?.user?.id) {
    _identityGeneration += 1;
    setConnectionState({ status: 'connected', lastError: null, user: payload.user });
  }
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch (_) {}
}

function wsUrl() {
  const base = baseUrl();
  if (!base || !_config?.clientToken) return null;
  // http(s) → ws(s). URL parsing handles the protocol swap cleanly.
  try {
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/api/events';
    u.searchParams.set('token', _config.clientToken);
    return u.toString();
  } catch (_) {
    return null;
  }
}

/* Connectivity pass (0.1.94): the socket used to be trusted until the OS told
 * us it had closed. A half-open socket — the laptop roamed networks, the
 * server Mac slept with the lid shut, Tailscale re-keyed the path — never
 * closes on its own, so live updates silently stopped while the chip stayed
 * green (reproduced: 90s with zero events and no reconnect). Now:
 *   - every frame, ping and pong counts as "alive"; this side also pings every
 *     WS_CLIENT_PING_MS so a live socket always has traffic;
 *   - nothing heard for WS_DEAD_AFTER_MS → terminate() and reconnect;
 *   - the opening handshake gives up after WS_HANDSHAKE_TIMEOUT_MS;
 *   - a successful HTTP ping while the socket is down reconnects at once
 *     instead of waiting out a backoff of up to 30s, and so does waking the
 *     Mac from sleep (powerMonitor 'resume'). */
const WS_CLIENT_PING_MS = 25_000;
const WS_DEAD_AFTER_MS = 75_000;
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_OPEN = 1;
const WS_CONNECTING = 0;
let _wsLastFrameAt = 0;
let _wsOpenCount = 0;
let _wsLastPingAt = 0;
let _wsLiveness = null;

function wsIsUp() {
  return !!_ws && (_ws.readyState === WS_OPEN || _ws.readyState === WS_CONNECTING);
}

function startWsClient() {
  if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
  if (wsIsUp()) return;
  if (!WebSocket) {
    try { WebSocket = require('ws'); }
    catch (err) {
      process.stderr.write(`[client ws] require failed: ${err.message}\n`);
      return;
    }
  }
  const url = wsUrl();
  if (!url) {
    // Nothing to connect to yet — try again later (URL may be set
    // after the user pastes credentials in Settings).
    _wsReconnectTimer = setTimeout(startWsClient, 5000);
    _wsReconnectTimer.unref?.();
    return;
  }

  let ws;
  try {
    ws = new WebSocket(url, { handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS });
  } catch (err) {
    process.stderr.write(`[client ws] construct failed: ${err.message}\n`);
    scheduleReconnect();
    return;
  }
  _ws = ws;
  _wsLastFrameAt = performance.now();
  _wsLastPingAt = _wsLastFrameAt;
  const heard = () => { if (_ws === ws) _wsLastFrameAt = performance.now(); };

  ws.on('open', () => {
    process.stdout.write('[client ws] connected\n');
    _wsOpenCount += 1;
    // Published so the renderer can tell the session's FIRST socket (whose
    // greeting arrives while bootstrap is loading the same data) from a
    // reconnect (renderer/store/bootstrap.js shouldSkipHelloResync).
    setConnectionState({ wsOpenCount: _wsOpenCount });
    heard();
    _wsBackoffMs = 1000;
  });
  ws.on('ping', heard);
  ws.on('pong', heard);

  ws.on('message', (data) => {
    heard();
    try {
      const frame = JSON.parse(data.toString('utf8'));
      dispatchIncoming(frame);
    } catch (err) {
      process.stderr.write(`[client ws] parse error: ${err.message}\n`);
    }
  });

  ws.on('close', () => {
    // A socket we already replaced (terminate + reconnect) must not schedule
    // a second reconnect or clear the new one.
    if (_ws !== ws) return;
    process.stdout.write('[client ws] disconnected\n');
    _ws = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    process.stderr.write(`[client ws] error: ${err.message}\n`);
    // The 'close' handler will run after this and schedule reconnect.
  });

  ensureWsLiveness();
}

function ensureWsLiveness() {
  if (_wsLiveness) return;
  _wsLiveness = setInterval(checkWsLiveness, 5_000);
  _wsLiveness.unref?.();
}

function checkWsLiveness() {
  const ws = _ws;
  if (!ws || ws.readyState !== WS_OPEN) return;
  const now = performance.now();
  if (now - _wsLastFrameAt > WS_DEAD_AFTER_MS) {
    process.stdout.write(`[client ws] nothing heard for ${Math.round((now - _wsLastFrameAt) / 1000)}s — dropping the socket and reconnecting\n`);
    restartWs('silent');
    return;
  }
  if (now - _wsLastPingAt >= WS_CLIENT_PING_MS && typeof ws.ping === 'function') {
    _wsLastPingAt = now;
    try { ws.ping(); } catch (_) { /* close handler reconnects */ }
  }
}

/**
 * Drop the current socket (if any) and connect again now, with the backoff
 * reset. `reason` is only for the log.
 */
function restartWs(reason) {
  const old = _ws;
  _ws = null;
  _wsBackoffMs = 1000;
  if (old) {
    try { typeof old.terminate === 'function' ? old.terminate() : old.close?.(); } catch (_) { /* already gone */ }
  }
  if (reason) process.stdout.write(`[client ws] reconnecting (${reason})\n`);
  startWsClient();
}

/**
 * Called when we have fresh evidence the server is reachable (a good ping,
 * the Mac waking up, the user pressing Retry). A socket that is down
 * reconnects immediately; one that is "open" but has been silent for longer
 * than a ping cycle is presumed half-open and replaced.
 */
function nudgeWs({ suspectSilentMs = WS_CLIENT_PING_MS + 10_000 } = {}) {
  if (!wsUrl()) return;
  if (!wsIsUp()) { restartWs(_ws ? 'stale' : null); return; }
  if (_ws.readyState === WS_OPEN && performance.now() - _wsLastFrameAt > suspectSilentMs) {
    restartWs('silent after the server came back');
  }
}

function scheduleReconnect() {
  if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
  _wsReconnectTimer = setTimeout(startWsClient, _wsBackoffMs);
  _wsReconnectTimer.unref?.();
  _wsBackoffMs = Math.min(_wsBackoffMs * 2, 30_000);
}

/* ─── Connection polling ───────────────────────────────────────── */

/**
 * Background ping. Hits `/api/ping` (public) so it works even if the
 * token is stale — the renderer's auth-failure path covers the token
 * case separately. Backs off to 30s on success and rapidly retries
 * (2s → 4s → 8s → 16s → 30s cap) on failure.
 *
 * Stays running for the entire client-mode session. There's no
 * stopPolling() because client mode IS the entire session — `setMode`
 * relaunches the app to flip back to standalone.
 */
/**
 * v0.22.3: fetch /api/whoami once and stash the result in
 * `_connectionState.user`. The renderer reads this through the
 * `client:connectionState` IPC to figure out which user it is — used
 * by v0.22.2's self-vs-remote classification for catalog:changed
 * events. Without this, the renderer would treat its OWN echoed edits
 * as "from another user" and queue them behind the Refresh banner
 * instead of auto-applying.
 *
 * One-shot: we only fetch when user is null. If the server is
 * restarted with a different user table, the token would 401 first
 * and force a reconfigure anyway, so we don't need to refresh user
 * info on every reconnect.
 */
async function ensureWhoami() {
  if (_connectionState.user?.id) return; // already have it
  const identityGeneration = _identityGeneration;
  const url = baseUrl();
  const auth = authHeader();
  if (!url || !auth) return; // nothing to query with
  try {
    const res = await fetch(`${url}/api/whoami`, {
      headers: { Authorization: auth },
      // v0.26.40: bumped 5s → 8s to match the other client-mode
      // fetch ceilings (testConnection, diagnoseServer). 5s was too
      // aggressive for slow Tailscale hops during the very-first
      // boot — see the rationale on PING_TIMEOUT_MS above.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return; // 401 path handled by RPC error flow
    const body = await res.json().catch(() => null);
    if (identityGeneration === _identityGeneration && body?.user?.id) {
      setConnectionState({ user: body.user });
    }
  } catch (_) {
    /* network blip — try again on next ping */
  }
}

function schedulePoll(delayMs) {
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = setTimeout(() => { _pollTimer = null; return pollOnce(); }, delayMs);
  _pollTimer.unref?.();
}

/**
 * One /api/ping, then schedule the next. Concurrent callers (the timer, a
 * Retry click, a wake from sleep) share the same in-flight ping. Resolves to
 * the connection state after this ping.
 */
function pollOnce() {
  if (_pollInFlight) return _pollInFlight;
  _pollInFlight = pollTick()
    .catch((err) => {
      process.stderr.write(`[client ping] tick failed: ${err?.message || err}\n`);
      return PING_HEALTHY_INTERVAL_MS;
    })
    .then((nextMs) => {
      schedulePoll(nextMs);
      return getConnectionState();
    })
    .finally(() => { _pollInFlight = null; });
  return _pollInFlight;
}

/** Returns the delay before the next ping. */
async function pollTick() {
  const url = baseUrl();
  if (!url) {
    /* No URL configured yet — keep waiting, the user is probably about to
     * fill it in.
     *
     * v0.1.31: also PUBLISH that fact. The renderer needs to tell "this Mac
     * is a client with no server set" apart from "the server is down" — the
     * first is a setup step, the second is a fault — and it cannot work that
     * out from a mirrored config value that goes stale the moment the user
     * types an address. This is pushed live, every tick, so the banner
     * disappears on its own once an address is saved. */
    setConnectionState({ status: 'unconfigured', lastError: null });
    return 5000;
  }

  // v0.26.38: three-way ping classification, replacing the old
  // binary throw-on-anything-not-2xx logic. The previous code
  // treated a 500 response identically to a fetch-failed network
  // error, which made the chip flash red on transient server
  // hiccups even though the network was fine — see the bug report
  // we tracked down before this build.
  //
  // The three outcomes:
  //   - 2xx                → connected (green)
  //   - 5xx response       → degraded (amber); server is REACHABLE
  //                          but its HTTP layer returned an error.
  //                          Log it so headless servers leave a
  //                          breadcrumb in the crash.log.
  //   - 4xx (except 401)   → degraded; same as 5xx — the server
  //                          responded, so the connection is fine.
  //                          (401 is handled by /rpc separately —
  //                          /api/ping doesn't require auth.)
  //   - fetch threw /
  //     timeout / 401 ping → counts toward `_consecutivePingFailures`;
  //                          flips to disconnected only after
  //                          PING_FAILURE_THRESHOLD in a row.
  //
  // The debounce on consecutive failures is the meat of this fix.
  // A single noisy poll cycle no longer triggers a red glow — you
  // need 2 in a row, which is much rarer than 1 in isolation.
  let res = null;
  let netError = null;
  try {
    res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  } catch (err) {
    netError = err;
  }

  if (res && res.ok) {
    // Healthy ping.
    const body = await res.json().catch(() => ({}));
    const wasDown = _connectionState.status !== 'connected';
    _consecutivePingFailures = 0;
    const patch = {
      lastOkAt: Date.now(),
      serverVersion: body?.version ?? null,
      // Connectivity pass: the server Mac's own name (newer servers send it),
      // shown in the sidebar chip so "connected" says connected to WHAT.
      serverName: typeof body?.name === 'string' && body.name ? body.name : (_connectionState.serverName ?? null),
    };
    setConnectionState(wasDown ? { ...patch, status: 'connected', lastError: null } : patch);
    ensureWhoami();
    // The server answers again — make sure live updates do too, now rather
    // than after the socket's own backoff.
    nudgeWs(wasDown ? { suspectSilentMs: WS_CLIENT_PING_MS + 10_000 } : { suspectSilentMs: WS_DEAD_AFTER_MS });
    return PING_HEALTHY_INTERVAL_MS;
  }
  if (res && !res.ok) {
    // Server replied with a non-2xx — connection is fine, server
    // had a hiccup. Don't flip to disconnected; flag as degraded
    // and leave a breadcrumb in stderr (mirrors to crash.log on
    // the server admin's `tail` workflow, useful for the headless
    // mac-mini case where they don't see UI errors).
    const detail = `Status ${res.status}`;
    process.stderr.write(`[client ping] server responded with ${detail} on /api/ping at ${new Date().toISOString()}\n`);
    // Reset the network-failure debounce — this ISN'T a network
    // failure. The degraded state replaces it cleanly.
    _consecutivePingFailures = 0;
    setConnectionState({
      status: 'degraded',
      lastError: `The server Mac answered with an error (${detail}). The connection is fine — something inside the server hiccuped; it usually clears by itself.`,
    });
    return PING_HEALTHY_INTERVAL_MS;
  }
  // Genuine network failure (fetch threw, timed out, etc).
  // Debounce — only flip to disconnected after two in a row, so
  // single-tick noise doesn't make the chip blink red.
  _consecutivePingFailures += 1;
  const isFinal = _consecutivePingFailures >= PING_FAILURE_THRESHOLD;
  if (isFinal) {
    // §18: the same plain-English reading every other client-mode network
    // failure gets — never the raw "The operation was aborted due to timeout".
    const { analyzeFetchError } = require('../util/fetchErrors');
    setConnectionState({ status: 'disconnected', lastError: analyzeFetchError(netError, url).message });
  } else {
    // Single failure — don't change the user-visible status yet.
    // Log quietly so we can investigate later if it's a pattern.
    process.stderr.write(
      `[client ping] transient failure (${_consecutivePingFailures}/${PING_FAILURE_THRESHOLD}): ${netError?.message || 'unknown'}\n`,
    );
  }
  return pingRetryDelay(_consecutivePingFailures);
}

/** 1 failure → confirm after 1s; then 2s, 4s, 8s, capped at 10s. */
function pingRetryDelay(failures) {
  if (failures <= 1) return PING_CONFIRM_DELAY_MS;
  return Math.min(2_000 * 2 ** (failures - 2), PING_RETRY_MAX_MS);
}

function startPolling() {
  // First tick fires soon after boot so the badge transitions out of
  // 'unknown' quickly.
  _pollTimer = setTimeout(() => { _pollTimer = null; return pollOnce(); }, 500);
  _pollTimer.unref?.();
  watchPower();
}

/**
 * Ping now and bring the live-update socket back if it is down. Used by the
 * Retry button, "Test connection now", and waking from sleep. Resolves to the
 * connection state after the ping, so the caller can say what happened.
 */
async function reconnectNow(reason = 'retry') {
  process.stdout.write(`[client] reconnect requested (${reason})\n`);
  // When the user asks (Retry, Test connection now) this one ping decides —
  // they are looking at the answer. Waking from sleep keeps the usual
  // two-strike debounce: Wi-Fi often needs a few seconds to come back.
  if (reason === 'retry' || reason === 'test') _consecutivePingFailures = PING_FAILURE_THRESHOLD - 1;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  const state = await pollOnce();
  if (state.status === 'connected') nudgeWs({ suspectSilentMs: reason === 'resume' ? 0 : WS_CLIENT_PING_MS + 10_000 });
  return state;
}

let _powerWatched = false;
function watchPower() {
  if (_powerWatched) return;
  let powerMonitor = null;
  try { ({ powerMonitor } = require('electron')); } catch (_) { /* not in Electron */ }
  if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
  _powerWatched = true;
  // After sleep every socket is suspect and the ping timer may be minutes
  // stale. Check at once; a dead socket is replaced (suspectSilentMs: 0).
  powerMonitor.on('resume', () => { void reconnectNow('resume'); });
  powerMonitor.on('unlock-screen', () => { void reconnectNow('unlock'); });
}

/* ─── Channel proxies ──────────────────────────────────────────── */

/**
 * The list of channels the renderer is allowed to invoke in client
 * mode. Each one is forwarded to the server's `/api/rpc` endpoint with
 * the same argument shape as the local IPC would have received.
 *
 * Keep this in sync with the `expose()` calls in main/ipc.js. v0.14.3
 * ships just the Library read path; v0.14.4 grows the list.
 */
const PROXIED_CHANNELS = [
  // v0.14.3 — first wave: Library + side panel + company switcher.
  // (v0.26.36: `app:getVersion` and `app:getPlatform` USED to be
  // here, RPC'd to the server. That was wrong — a client always
  // knows its OWN version (it's baked into the bundle) and its OWN
  // platform (it's process.platform). Proxying them caused the
  // sidebar footer to show `v0.0.0` whenever bootstrap ran before
  // the server was reachable — boot order race that's especially
  // visible on a freshly-configured client. They're now registered
  // as local handlers below, identical to standalone/server mode.)
  'companies:list',
  'companies:get',
  'companies:getActiveId',
  'companies:setActive',
  'products:list',
  'products:get',
  'images:listByProduct',
  'brands:list',
  'brands:get',
  'categories:list',
  // v0.14.4 — second wave: dashboard, exports list, AI Studio reads,
  // Overlay template reads.
  'dashboard:stats',
  'dashboard:recentBrands',
  'dashboard:recentProducts',
  'dashboard:completeness',
  'exports:listProfiles',
  'exports:getProfile',
  'exports:filenamePreview',
  'exports:listRuns',
  // v0.36.0: catalog CSV/feed (pure data; renderer downloads it).
  'exports:catalogCsv',
  'ai:listModels',
  'ai:estimateCost',
  'ai:listPrompts',
  'ai:listTasks',
  'ai:listGallery',
  'ai:listBulkGallery',
  'templates:list',
  'templates:get',
  'templates:listRuns',
  'labels:listTemplates','labels:getTemplate','labels:preview','labels:previewDraft','labels:barcodePreview','labels:listRuns',
  'catalogStudio:list','catalogStudio:get','catalogStudio:preview',
  // v0.27.0: eyedropper — server holds the image bytes, so proxy it.
  'templates:sampleBgColor',
  // v0.15.0 — write endpoints. Catalog CRUD, image reorder/set-main/
  // remove, AI prompt CRUD, AI task lifecycle, gallery favorite/remove/
  // promote, export profile CRUD, template CRUD + renderPreview,
  // workspace processing, bytes-uploads (images / watermarks).
  'companies:create', 'companies:update', 'companies:remove',
  'products:create',  'products:update',  'products:remove', 'products:bulkUpsert',
  'products:duplicate',
  'products:bulkUpdate',
  'products:bulkRemove',
  // v0.18.2: global search palette.
  'search:global',
  // v0.22.6: audit log feed (history modal in the side panel).
  'audit:listForEntity', 'audit:countForEntity',
  // v0.26.31: global feed for the History sidebar page.
  'audit:listRecent', 'audit:countRecent',
  // v0.33.0: history retention — stats + clear run on the server's log.
  'audit:historyStats', 'audit:clearHistory',
  'brands:create',    'brands:update',    'brands:remove',
  'categories:create','categories:update','categories:remove',
  // v0.49.46: OPERATIONS — suppliers CRUD. Pure DB operations on the
  // server, no local filesystem access needed, so straight RPC works.
  // POs and cost components added in v0.49.47.
  'suppliers:list','suppliers:get','suppliers:create','suppliers:update',
  'suppliers:archive','suppliers:unarchive','suppliers:remove',
  // v0.49.47: OPERATIONS — Purchase Orders + landed cost. All channels
  // operate on the shared catalog DB (no local filesystem), safe to RPC.
  'pos:list','pos:get','pos:getDetail','pos:listForSupplier','pos:listForProduct','pos:getProductCost',
  'pos:listProductCosts','pos:supplierSpendRollup',
  'pos:create','pos:update','pos:setStatus','pos:remove',
  'pos:addLine','pos:updateLine','pos:removeLine',
  'pos:addComponent','pos:updateComponent','pos:removeComponent',
  'pos:listPayments','pos:addPayment','pos:updatePayment','pos:removePayment',
  // Fixed Assets & Branches A0/A1: the register, branches, rates and the
  // ledger live with the data on the server (database + its fixed-assets/
  // folder) — straight RPC. The one exception is assets:saveImportSample
  // (handleLocal below: the Save dialog opens on this Mac).
  'assets:getSettings','assets:updateSettings','assets:listCategories','assets:createCategory','assets:updateCategory',
  'assets:list','assets:get','assets:create','assets:update','assets:previewActivation','assets:activate','assets:cancelDraft',
  'assets:addFile','assets:getFile','assets:reorderFiles','assets:retireFile','assets:transfer','assets:voidEvent',
  'assets:reverseEvent','assets:listEvents','assets:getSchedule','assets:linkFuelAsset','assets:unlinkFuelAsset',
  'assets:createFuelAsset','assets:importColumns','assets:importPlan','assets:importApply','assets:getImportSample',
  'assets:previewDepreciation','assets:runDepreciation','assets:listRuns','assets:reverseRun','assets:checkIntegrity',
  'assets:previewDisposal','assets:dispose','assets:partialDispose','assets:markLost','assets:markFound','assets:impair','assets:revalue',
  'assets:getTaxYear','assets:setPoolOpening','assets:markTaxYearFiled','assets:unfileTaxYear','assets:getReport','assets:getWorkbook',
  'branches:list','branches:get','branches:create','branches:update','branches:close','branches:suggestFromFuel',
  'fx:list','fx:rateOn','fx:setRate','fx:voidRate','ledger:listAccounts','ledger:updateAccount','ledger:getEntry',
  'ledger:entriesForAsset','ledger:listPeriods','ledger:checkIntegrity','ledger:lockPeriod','ledger:unlockPeriod',
  'assets:setCustodian','assets:setStatus','assets:recordRepair','assets:recordCapex','assets:changeLife','assets:changeSalvage',
  'assets:addNote',
  // Fuel F1: the staff list and every fuel record live with the data on the
  // server — pure DB + the server's own fuel/ folder — so straight RPC. The one
  // exception is fuel:saveMonthlyWorkbook (handleLocal below: dialog on this Mac).
  'staff:list','staff:get','staff:create','staff:update','staff:markLeft','staff:reactivate','staff:setPhoto','staff:getPhoto','staff:me',
  'fuel:getSettings','fuel:updateSettings','fuel:listAssetTypes','fuel:createAssetType','fuel:updateAssetType',
  'fuel:listAssets','fuel:getAsset','fuel:createAsset','fuel:updateAsset','fuel:setAssetPhoto',
  'fuel:listLocations','fuel:getLocation','fuel:createLocation','fuel:updateLocation',
  'fuel:getChart','fuel:setChart','fuel:getDipLitres','fuel:getChartSuggestion',
  'fuel:listStations','fuel:createStation','fuel:updateStation',
  'fuel:listPrices','fuel:setPrice','fuel:voidPrice','fuel:listMeterResets','fuel:recordMeterReset',
  'fuel:recordFill','fuel:recordDip','fuel:recordDelivery','fuel:setDeliveryDips','fuel:recordTransfer','fuel:receiveTransfer',
  'fuel:addPhoto','fuel:getPhoto','fuel:listFills','fuel:getFill','fuel:listDips','fuel:listDeliveries','fuel:listTransfers',
  'fuel:listPendingTransfers','fuel:listMyRecent','fuel:reviewFill','fuel:correctFill','fuel:voidRecord','fuel:voidMyRecord',
  'fuel:listFlags','fuel:reviewFlag','fuel:recomputeFlags','fuel:getOverview',
  'fuel:getMonthlyReport','fuel:getMonthlyWorkbook','fuel:sweepPhotoRetention',
  // Pure math — could run client-side, but proxying keeps the formula
  // logic centralised + lets us patch it server-side without re-shipping
  // the client.
  'costing:suggestedRetail','costing:realizedMargin','costing:containerFillPct',
  'ai:createPrompt','ai:updatePrompt','ai:removePrompt',
  'ai:queueTask','ai:repairTask','ai:queueFreshTask','ai:cancelTask','ai:removeTask',
  'ai:favoriteGallery','ai:removeGallery','ai:promoteGalleryToProduct',
  'exports:createProfile','exports:updateProfile','exports:removeProfile','exports:duplicateProfile',
  'templates:create','templates:update','templates:remove','templates:duplicate','templates:renderPreview',
  // v0.1.78: the zip is composed and written on the SERVER (that is where the
  // images live); the client then fetches it from the server's asset route like
  // any other file, so this channel is proxied verbatim.
  'templates:renderZip',
  // v0.1.27: templates:applyToProduct / applyBulk / applyByFilter are NO LONGER
  // proxied verbatim — they have a local bridge below (see
  // registerOverlayApplyBridges). Leaving them here as well would register
  // ipcMain.handle twice for the same channel, which Electron rejects at boot.
  'labels:createTemplate','labels:updateTemplate','labels:deleteTemplate','labels:duplicateTemplate','labels:deleteRun',
  'catalogStudio:create','catalogStudio:update','catalogStudio:delete','catalogStudio:duplicate',
  // v0.1.25: Social Grid's preset CRUD + resolve + preview all run on the
  // server — the products, their stock counts and their image files live
  // there. Only the EXPORT is local (below), because the finished PNGs have to
  // land on this Mac's disk; the server renders them and ships the bytes.
  'socialGrid:list','socialGrid:get','socialGrid:create','socialGrid:update',
  'socialGrid:delete','socialGrid:duplicate','socialGrid:preview',
  'socialGrid:markExported',
  // 0.1.95: Cancel for an export runs where the render runs — on the server.
  'socialGrid:cancelExport',
  // v0.1.62: the templates and the pre-flight count live with the data, so a
  // client Mac asks the server for them like any other social-grid call.
  // v0.1.63: catalog templates live with the data too.
  'catalogStudio:listTemplates','catalogStudio:getTemplate','catalogStudio:saveTemplate',
  'catalogStudio:updateTemplate','catalogStudio:deleteTemplate','catalogStudio:duplicateTemplate',
  'catalogStudio:previewTemplate',
  'socialGrid:listTemplates','socialGrid:getTemplate','socialGrid:saveTemplate',
  'socialGrid:updateTemplate','socialGrid:deleteTemplate','socialGrid:duplicateTemplate',
  'socialGrid:plan',
  // v0.1.71: named bulk-table column sets live with the data too — a client
  // Mac asks the server for the company's saved views.
  'bulkColumns:list','bulkColumns:create','bulkColumns:update','bulkColumns:remove',
  // v0.1.72: the remembered width map and the duplicate action also live with
  // the data, so a client Mac proxies them to the server like the sets.
  'bulkColumns:duplicate','bulkColumns:getWidths','bulkColumns:setWidths',
  // v0.26.15: apply-template handlers (single + bulk + by-filter).
  'images:setMainImage','images:reorderImages','images:removeFromProduct','images:flipSource',
  'images:importFromBytes','watermarks:uploadFromBytes',
  // v0.28.0: near-duplicate scan/merge/revert. All run server-side (the
  // image files + DB live there), so clients just proxy.
  'images:findDuplicates','images:mergeDuplicates','images:autoMergeDuplicates','images:listMergeOps',
  'images:revertMerge','images:purgeMerge','images:quarantineInfo','images:purgeAllMerges',
  // v0.29.0: per-image reframe — server holds the image bytes, so proxy.
  'images:reframePreview','images:reframeImage','images:sampleImageBgColor',
  // v0.49.15: aspect-ratio crop — both preview + commit run on the server
  // (where the actual image pixels live).
  'images:cropPreview','images:cropImage',
  // v0.37.0: batch auto-crop runs entirely on the server (where the files are).
  'images:autoCropProducts',
  // v0.40.0: auto-enhance (preview + batch) — server holds the bytes.
  'images:autoEnhancePreview','images:autoEnhanceProducts',
  // v0.49.28: bulk re-encode (format convert + compress) — server-side.
  'images:reencodeProducts',
  // v0.49.34: header-only metadata read for the Lightbox caption.
  // Hits sharp().metadata() + fs.stat on the server; same row data
  // either way, so proxy.
  'images:getMetadata',
  // v0.49.39: bulk copy-images-to-folder. The IPC handler in main
  // fetches bytes via the app-image:// protocol (which already
  // proxies to the server in client mode with the bearer token),
  // so the call itself lives LOCALLY on the client — it picks the
  // folder on the client's disk and writes there. NOT proxied to
  // the server. The reason we DON'T list it in PROXIED_CHANNELS
  // is exactly this: the client's local handler is what runs.
  // (See the local override block below for the registration.)
  // — startDragOut is also local-only: it must call
  // event.sender.startDrag(), which is the CLIENT renderer's drag.
  // v0.16.0: bytes-based brand icon upload (client reads the icon
  // file locally, sends bytes; server runs normal importBrandIcon).
  'brands:uploadIconFromBytes',
  // v0.16.1: bytes-based bulk AI source upload + bytes-back-to-client
  // bulk export. The standalone-named `ai:queueBulkBatch` and
  // `ai:exportBulkImage` channels are overridden locally below to
  // bridge to these via bytes.
  'ai:queueBulkBatchFromBytes',
  'ai:queueBulkForProducts',
  'ai:exportBulkImageBytes',
  // v0.16.2: bytes-back-to-client export. Server zips its temp
  // output, client writes each file under its own outputRoot.
  'exports:runForClient',
  // v0.1.89: Cancel reaches the run where it happens — on the server.
  'exports:cancel',
  'workspace:processImage','workspace:saveSettings',
  // v0.15.3 — attribution + presence.
  'users:listForAttribution',
  'users:presence',

  // v0.1.22: server-owned operations, now reachable from a client Mac.
  //
  // These act on the DATA (accounts, tokens, the backup archive), not on the Mac
  // showing the screen, so they belong on the server — and the server already
  // gates every one of them by capability (users.manage for accounts,
  // system.manage for backups). Proxying them therefore does not widen access:
  // an editor on a client Mac is still refused, by the server, with a clear
  // message. What it removes is the need to walk to the data Mac to add a user
  // or take a backup.
  'users:list','users:create','users:update','users:remove','users:setDeactivated','users:regenerateToken','users:ensureOwner',
  'roles:list','roles:get','roles:capabilities','roles:create','roles:update','roles:remove',
  'backups:create','backups:list','backups:last','backups:preview','backups:restore',
  // v0.1.86: the recycle bin acts on the data folder, so a client Mac can
  // list, restore and purge just like the backups it sits beside.
  'deleted:list','deleted:restore','deleted:purge','deleted:empty',
];

/**
 * Channels NOT yet portable to client mode. We register an
 * ipcMain.handle stub so the renderer gets a useful toast instead of
 * hanging on an unregistered channel. v0.15.0 migrates these.
 */
const NOT_YET_PORTABLE = [
  // (v0.16.2 moved exports:run to a local bridge — bytes flow back
  // from the server's temp folder and we write them under the
  // client's chosen outputRoot.)
  // (v0.16.1 moved ai:queueBulkBatch + ai:exportBulkImage to local
  // bridges below — no longer stubbed.)
  // (v0.16.2 moved exports:run to a local bridge — see below.)
  // Provider keys live in the client's local config (per-Mac), so
  // these reads must stay local.
  'ai:testOpenai',
  // Users / roles / server controls are NOT here: the account and permission
  // channels are proxied to the server (see PROXIED_CHANNELS above, v0.1.22) and
  // the server's capability gate decides who may use them, so a client Mac can
  // manage users. The array below only holds channels nothing can serve yet.
  // (The names used to sit inside this comment, which made it look as though
  // they were stubbed here when they had already become proxyable.)
  // v0.49.51: roles + permission matrix (admin manages on the server).
  'server:status','server:addresses','server:start','server:stop',
  // Settings — data folder lives locally.
  'settings:pickAndSetDataFolder','settings:changeDataFolder',
  // v0.49.33: `settings:testRemoveBg` + `settings:bumpRemoveBgUsage`
  // were removed when the paid bg-removal engine was dropped.
  // v0.26.51: data-folder trash + server-bundle migration. These all
  // operate on a LOCAL data folder, which a client doesn't have (its
  // data lives on the server). The Migration UI in Settings is
  // already gated to non-client modes, and the data-folder-change
  // flow is stubbed above — so these are unreachable in client mode.
  // Stubbed anyway so a future code path that reaches them fails with
  // a clear message instead of "No handler registered".
  'settings:trashFolder',
  'servers:exportBundle','servers:importBundle','servers:previewBundle','servers:applyImportedDataDir',
  // v0.1.22: creating, listing, previewing and restoring a backup now WORK on a
  // client — they act on the server's data folder, so they are proxied (see
  // PROXIED_CHANNELS above). The four below are the exceptions, because they
  // open a Finder window, a folder picker or a file picker: those must appear on
  // the Mac the user is looking at, and the folder or file they name is on the
  // other one. (v0.1.83 added the file picker to this list; the Backups panel
  // hides that button in client mode, and this stub is the belt to that brace.)
  'backups:reveal','backups:openFolder','backups:pickFolder','backups:pickFile',
];

/**
 * Install all the ipcMain handlers a client-mode renderer needs.
 * Returns the connection-state getter so the caller (main/index.js)
 * can wire `client:connectionState` IPC.
 */
function registerClientProxies(loadConfigFn) {
  _config = loadConfigFn();

  // Re-read config on each `settings:setMany` call so a token swap
  // takes effect without a relaunch.
  function refreshConfig() {
    try { _config = loadConfigFn(); } catch (_) { /* ignore */ }
  }

  /* RPC-proxied channels — forward args verbatim to the server. The server's
   * dispatcher validates these on arrival, which is the only path they have. */
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, (_e, arg) => rpc(channel, arg));
  }

  /* Locally-handled stubs (operations that don't make sense to RPC). */

  // v0.26.36: keep `app:getVersion` + `app:getPlatform` LOCAL even
  // in client mode. The client always knows its own version (it's
  // baked into the bundle) and its own platform (process.platform).
  // Pre-v0.26.36 these were proxied through RPC to the server, which
  // (a) was wasteful (one round-trip per boot for a constant), and
  // (b) caused the sidebar footer to show "v0.0.0" whenever the
  // server was unreachable during bootstrap — a freshly-configured
  // client where the user hadn't entered the right URL yet would
  // get stuck on v0.0.0 forever until they fixed connection AND
  // relaunched. Trivial to make local; the server's version is
  // surfaced separately via `serverVersion` in the connection state.
  handleLocal('app:getVersion',  () => app.getVersion());
  handleLocal('app:getPlatform', () => process.platform);

  // v0.26.51: model-cache panel handlers. These inspect / clear THIS
  // Mac's Electron HTTP cache (where the ~80 MB @imgly model lives),
  // so they're per-Mac local operations — never proxied to the
  // server. Pre-v0.26.51 they were only registered in standalone /
  // server mode (main/ipc/app.js), so a client opening Settings got
  // "No handler registered for 'app:getCacheInfo'". Same shared
  // helper both modes use.
  {
    const { readCacheInfo, clearAppCache } = require('../util/appCache');
    handleLocal('app:getCacheInfo', () => readCacheInfo());
    handleLocal('app:clearCache', () => clearAppCache());
  }

  // v0.26.51: crash-log tail reader. The About tab's "Recent crash
  // log" panel calls this, and the About tab is visible in ALL modes
  // — so a client opening it hit "No handler registered for
  // 'app:readCrashLog'". The crash.log on the CLIENT's disk is the
  // relevant one (its own lifecycle events), so this stays local.
  handleLocal('app:readCrashLog', async ({ lines = 100 } = {}) => {
    const fsp = require('node:fs/promises');
    const path = require('node:path');
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    try {
      const content = await fsp.readFile(logPath, 'utf8');
      const all = content.split('\n');
      const tail = all.slice(Math.max(0, all.length - Math.min(lines, 200)));
      return { content: tail.join('\n'), path: logPath, lines: tail.length };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { content: '(no crash.log yet — nothing has been logged)', path: logPath, lines: 0 };
      }
      throw err;
    }
  });

  handleLocal('app:getVersionInfo', () => ({
    app: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    mode: 'client',
    server: baseUrl(),
    // v0.1.22: which Mac this is — see the note on the server-side handler in
    // main/ipc/app.js.
    hostname: require('node:os').hostname(),
  }));

  handleLocal('app:openExternal', async (target) => {
    const { shell } = require('electron');
    if (typeof target !== 'string') throw new Error('Disallowed URL scheme');
    let parsed;
    try { parsed = new URL(target); } catch { throw new Error('Disallowed URL scheme'); }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Disallowed URL scheme');
    await shell.openExternal(target);
    return true;
  });

  /* v0.1.25: same fix as the server-side handlers — openPath resolves with an
   * error string, so the old versions reported success unconditionally. */
  handleLocal('app:openDataFolder', async () => {
    // In client mode, "data folder" doesn't really exist. Open the
    // userData folder so the user can grab logs etc.
    const { openPathOrThrow } = require('../util/openPath');
    return openPathOrThrow(app.getPath('userData'), 'app folder');
  });

  handleLocal('app:openLogsFolder', async () => {
    const { openPathOrThrow } = require('../util/openPath');
    return openPathOrThrow(app.getPath('userData'), 'logs folder');
  });

  handleLocal('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  handleLocal('settings:getAll', () => {
    // The renderer needs at minimum: mode, the active company id (so
    // bootstrap doesn't hang waiting on getActiveId), and the small
    // bits the settings UI reads. Return a curated subset based on
    // the client's local config so iCloud / removebg / theme prefs are
    // per-Mac (which is the right behavior — settings shouldn't sync).
    const cfg = _config || loadConfigFn();
    return {
      ...cfg,
      // No "is iCloud" badge on clients — the asset folder lives on
      // the server.
      dataDirIsCloud: false,
    };
  });

  handleLocal('settings:setOne', ({ key, value }) => {
    const { updateConfig, assertKnownConfigKeys } = require('../config');
    // v0.1.18: same unknown-key rule as the standalone handler.
    assertKnownConfigKeys({ [key]: value });
    const next = updateConfig({ [key]: value });
    refreshConfig();
    return next;
  });
  handleLocal('settings:setMany', (patch) => {
    const { updateConfig, assertKnownConfigKeys } = require('../config');
    assertKnownConfigKeys(patch ?? {});
    const next = updateConfig(patch ?? {});
    refreshConfig();
    return next;
  });
  handleLocal('settings:setMode', async (nextMode) => {
    if (!['standalone', 'server', 'client'].includes(nextMode)) {
      throw new Error(`Invalid mode: ${nextMode}`);
    }
    const { updateConfig } = require('../config');
    updateConfig({ mode: nextMode });
    setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
    return { ok: true, mode: nextMode };
  });

  handleLocal('client:testConnection', async ({ url, token }) => {
    // v0.26.34: shared error analyser — see main/util/fetchErrors.js
    // for the full mapping table. Replaces the old `${err.message}`
    // pass-through that surfaced an opaque "fetch failed".
    const { validateServerUrl, analyzeFetchError } = require('../util/fetchErrors');
    const { normalizeServerUrl } = require('../util/fetchErrors');
    // v0.1.31: same normalisation as the runtime path — see baseUrl().
    const urlCheck = validateServerUrl(normalizeServerUrl(url));
    if (!urlCheck.ok) throw new Error(urlCheck.error);
    if (!token || !String(token).trim()) {
      throw new Error('User token is empty. Ask the server admin to give you the long random string from their Settings → Multi-Mac → Users page.');
    }
    const base = url.replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const analyzed = analyzeFetchError(err, base);
      throw new Error(analyzed.message, { cause: err });
    }
    if (res.status === 401) throw new Error('Token rejected by server. Ask the admin to regenerate it (their Settings → Multi-Mac → Users → ↻ button), then paste the new one here.');
    if (!res.ok) throw new Error(`Server returned ${res.status}. The address is reachable but isn't speaking the Business Studio KH protocol — is this URL pointing at a different app?`);
    const data = await res.json();
    return { ok: true, user: data.user, registeredChannels: data.registeredChannels };
  });

  /* v0.26.34: step-by-step network diagnostic. See ipc/settings.js
     for the standalone-mode twin handler. */
  handleLocal('client:diagnoseServer', async ({ url, token } = {}) => {
    const { diagnoseServer } = require('../util/fetchErrors');
    return diagnoseServer({ url, token });
  });

  /* Connection-state IPC for the renderer's sidebar badge. */
  handleLocal('client:connectionState', () => getConnectionState());

  /* Connectivity pass (0.1.94): a REAL check, for the offline banner's Retry
   * and the connection legend's "Test connection now". Pings the server now,
   * reconnects the live-update socket if it is down, and returns the state
   * that ping produced — not the cached snapshot the legend used to re-read. */
  handleLocal('client:reconnectNow', (args) => reconnectNow(args?.reason === 'test' ? 'test' : 'retry'));

  /* v0.26.33: RPC activity stats — exposed as a one-shot snapshot for
     the sidebar chip + SyncOverlay seed. Continuous updates flow via
     the `client:rpcActivity` push channel (see broadcastRpcActivity). */
  handleLocal('client:syncStats', () => getSyncStats());

  /* ─── v0.16.0: client-mode local handlers ──────────────────────
   * These channels run on the client's own Mac (the OS dialog is its
   * dialog, the disk scan is its disk). They don't talk to the server
   * directly — but `images:importForProduct` and friends DO end up
   * sending bytes to the server via the RPC layer at the end.
   * That keeps the renderer API identical: callers don't branch on
   * mode.
   */
  registerClientFileHandlers();
  registerClientImageImportBridges();

  /* Stubs for the still-not-portable channels. Throw a clear,
   * actionable error so the user understands why something didn't
   * work.
   */
  for (const channel of NOT_YET_PORTABLE) {
    ipcMain.handle(channel, () => {
      throw new Error(`"${channel}" is not yet available in client mode. Switch this Mac to standalone in Settings, or wait for the next release.`);
    });
  }

  startPolling();
  // v0.15.1: open the live-update WebSocket. Failures are non-fatal —
  // the HTTP ping loop is the primary connection-state signal; the
  // WS is best-effort on top.
  startWsClient();
  return { getConnectionState };
}

/* ─── v0.16.0: file handlers that run locally on the client Mac ─── */

function registerClientFileHandlers() {
  const { dialog } = require('electron');
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  // imageManager pulls in db/index.js at load time, but the parts we
  // use here (scanImagesRecursive, slugify, groupAndSortMatches) don't
  // call getDataDir. Safe in client mode.
  const imageManager = require('../imageManager');

  handleLocal('files:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  handleLocal('files:pickImageFile', async ({ multiple = false } = {}) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return multiple ? res.filePaths : res.filePaths[0];
  });

  handleLocal('files:pickWorkbook', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv', 'tsv'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  handleLocal('files:parseWorkbook', (filePath) => {
    // Spreadsheet parsing is pure (just reads the file with xlsx), so
    // it works the same on client or server. The file path is on the
    // client's disk — exactly where we want it for a client-mode flow
    // that bulkUpserts to the server right after parsing.
    const fileHandler = require('../fileHandler');
    return fileHandler.readWorkbook(filePath);
  });

  handleLocal('files:readImageThumb', async (absPath) => {
    /* v0.1.29: match the server twin exactly.
     *
     * main/ipc/files.js rejects anything that is not an absolute path AND not
     * an image, because this channel reads a file by a path the renderer chose.
     * This copy only checked that it was a string, so the two modes disagreed
     * about what was acceptable — the kind of divergence that lets a rule hold
     * in one mode and quietly not exist in the other. The shared helpers live in
     * main/util/fileKinds.js precisely so both can use them. */
    const { isAbsolutePath, isImagePath } = require('../util/fileKinds');
    if (!isAbsolutePath(absPath)) throw new Error('An absolute image path is required');
    if (!isImagePath(absPath)) throw new Error('Only image files can be previewed');
    if (!fs.existsSync(absPath)) throw new Error('File not found');
    const sharp = require('sharp');
    const buf = await sharp(absPath)
      .rotate()
      .resize({ width: 160, height: 160, fit: 'cover' })
      .jpeg({ quality: 72 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  });

  // ai:scanBulkFolder runs on the picker's Mac (the user just picked
  // a folder there). The result is a list of paths that we then read
  // bytes from before queueing AI tasks — that's handled separately
  // in v0.16.2.
  // v0.1.19: the folder scan has to run on the Mac that owns the folder, so
  // client mode needs its own copy — same shared scanner as the server side, so
  // both modes agree on what "scan this folder" returns.
  handleLocal('files:scanImageFiles', (folderPath) => {
    const { isAbsolutePath, scanImageFilesIn } = require('../util/fileKinds');
    if (!isAbsolutePath(folderPath)) throw new Error('An absolute folder path is required');
    return scanImageFilesIn(folderPath);
  });

  handleLocal('ai:scanBulkFolder', (folderPath) => {
    if (!folderPath) throw new Error('folderPath required');
    const paths = imageManager.scanImagesRecursive(folderPath);
    return paths.slice(0, 1000).map((abs) => {
      let size = 0;
      try { size = fs.statSync(abs).size; } catch (_) {}
      return { abs, rel: path.relative(folderPath, abs), name: path.basename(abs), size };
    });
  });

  // Fixed Assets A1: the import sample is built on the server (it lists the
  // company's categories and branches); the Save dialog opens on THIS Mac.
  handleLocal('assets:saveWorkbook', async (args = {}) => {
    const res = await rpc('assets:getWorkbook', args || {});
    const bytes = Buffer.isBuffer(res?.bytes) ? res.bytes : Buffer.from(res?.bytes || []);
    const out = await dialog.showSaveDialog({
      title: 'Save fixed-asset workbook',
      defaultPath: res?.filename || 'fixed-assets.xlsx',
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (out.canceled || !out.filePath) return null;
    require('node:fs').writeFileSync(out.filePath, bytes);
    return out.filePath;
  });

  handleLocal('assets:saveImportSample', async () => {
    const res = await rpc('assets:getImportSample');
    const bytes = Buffer.isBuffer(res?.bytes) ? res.bytes : Buffer.from(res?.bytes || []);
    const out = await dialog.showSaveDialog({
      title: 'Save sample workbook',
      defaultPath: res?.filename || 'fixed-assets-import-sample.xlsx',
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (out.canceled || !out.filePath) return null;
    require('node:fs').writeFileSync(out.filePath, bytes);
    return out.filePath;
  });

  // Fuel F1: the workbook is built on the server (where the data is) and the
  // Save dialog opens on THIS Mac, so the bytes come back over RPC.
  handleLocal('fuel:saveMonthlyWorkbook', async ({ month } = {}) => {
    const res = await rpc('fuel:getMonthlyWorkbook', { month });
    const bytes = Buffer.isBuffer(res?.bytes) ? res.bytes : Buffer.from(res?.bytes || []);
    const out = await dialog.showSaveDialog({
      title: 'Save fuel workbook',
      defaultPath: res?.filename || `fuel-${month}.xlsx`,
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (out.canceled || !out.filePath) return null;
    require('node:fs').writeFileSync(out.filePath, bytes);
    return out.filePath;
  });

  handleLocal('samples:generateProductSheet', async () => {
    // The sample workbook is a constant the renderer doesn't need
    // server data for. Local handler is fine.
    const res = await dialog.showSaveDialog({
      title: 'Save sample workbook',
      defaultPath: 'media-studio-kh-products-sample.xlsx',
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const fileHandler = require('../fileHandler');
    fileHandler.writeProductSampleWorkbook(res.filePath);
    return res.filePath;
  });

  /* ─── v0.1.21: labels, generated and printed on THIS Mac ──────────────
   *
   * A client Mac has no database and no assets — but it has the output folder
   * the user picked and the printer they want to print on, which is the whole
   * point of printing from this Mac. So the work splits: the server builds the
   * label document from its data, and this process turns that document into
   * files or paper.
   *
   * `labels:buildDocument` returns a complete, self-contained HTML string (all
   * artwork already inlined as data URIs), so nothing else has to travel. The
   * rendering and printing helpers are the same ones the server uses
   * (`main/renderWindow.js`), which is why the output is identical either way.
   */

  handleLocal('labels:listPrinters', () => {
    // Printers belong to THIS Mac. It has always been able to answer this;
    // it was simply stubbed, so the printer list came back empty with no
    // explanation.
    return require('../renderWindow').listPrinters();
  });

  // "Show in Finder" after a run — the files are on THIS (client) Mac, so it
  // never goes to the server. Same rule as main/ipc/files.js.
  handleLocal('files:revealPath', async (absPath) => {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) throw new Error('An absolute path is required');
    // Same shared rule as the standalone handler: packages are revealed, never opened.
    return require('../util/openPath').revealPath(absPath);
  });

  handleLocal('labels:openOutput', async ({ outputPath } = {}) => {
    // The file is on this Mac's disk, so it must be opened here.
    if (!outputPath || typeof outputPath !== 'string') throw new Error('Output path required');
    const { openPathOrThrow } = require('../util/openPath');
    return openPathOrThrow(outputPath, 'label file');
  });

  handleLocal('labels:saveBarcode', async ({ value, format, outputFolder } = {}) => {
    // Barcode rendering is pure (bwip-js, no data), so this is entirely local.
    const { barcodeUri } = require('../studioRenderer');
    const { slugify } = require('../util/slug');
    if (!outputFolder) throw new Error('Pick an output folder');
    const dataUrl = await barcodeUri(value, format, true);
    if (!dataUrl) throw new Error('The barcode value is not valid for that format');
    await fsp.mkdir(outputFolder, { recursive: true });
    const { writeUniqueFile } = require('../util/exclusiveFile');
    const outputPath = await writeUniqueFile(outputFolder, `${slugify(value, 'barcode')}-${format || 'code128'}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return { outputPath };
  });

  handleLocal('labels:generate', async ({ companyId, templateId, productIds, outputFolder, format = 'pdf', layout = {} } = {}) => {
    if (!outputFolder || typeof outputFolder !== 'string') throw new Error('Pick an output folder');
    await fsp.mkdir(outputFolder, { recursive: true });

    const renderer = require('../renderWindow');
    const { slugifyUnicode } = require('../util/slug');
    const events = require('../events');
    const opId = `label-${Date.now()}`;
    const made = [];
    let items;
    let templateName;

    try {
      if (format === 'pdf') {
        // The server holds the template, the products and the artwork; it builds
        // the document. This Mac writes the file, because this is where the user
        // asked for it. The document is self-contained (artwork inlined), so
        // nothing else has to travel.
        const built = await rpc('labels:buildDocument', { companyId, templateId, productIds, layout });
        templateName = built.templateName;
        events.broadcast('progress:event', { id: opId, kind: 'labels', done: 0, total: built.products.length, phase: 'rendering', label: templateName });
        const { outputBaseName } = require('../util/outputNames');
        // Name claimed atomically at write time (unique → `wx`, `-2` on EEXIST).
        const target = await renderer.toPdf(built.html, path.join(outputFolder, `${outputBaseName(templateName, 'labels')}.pdf`), { orientation: layout.orientation, unique: true });
        made.push({ filePath: target });
        items = built.products.map((product) => ({ ...product, filePath: target }));
        events.broadcast('progress:event', { id: opId, kind: 'labels', done: built.products.length, total: built.products.length, phase: 'finishing', label: templateName });
      } else {
        // One file per label. Ask for a document per product in a single call —
        // a batch document is one page and cannot be split back into labels.
        const built = await rpc('labels:buildDocument', { companyId, templateId, productIds, layout, perProduct: true });
        templateName = built.templateName;
        events.broadcast('progress:event', { id: opId, kind: 'labels', done: 0, total: built.documents.length, phase: 'rendering', label: templateName });
        // Same pixel maths the server uses, so a label rendered here is the same
        // size as one rendered there: mm → px at the chosen dpi.
        const dpi = Math.max(72, Number(layout.dpi) || 203);
        const scale = dpi / 25.4;
        const ext = format === 'jpeg' ? 'jpg' : 'png';
        for (let i = 0; i < built.documents.length; i += 1) {
          const doc = built.documents[i];
          const target = path.join(outputFolder, `${slugifyUnicode(doc.sku, 'label')}-${slugifyUnicode(templateName, 'label')}.${ext}`);
          const actualPath = await renderer.toImage(doc.html, target, {
            format,
            width: Math.ceil(built.widthMm * scale),
            height: Math.ceil(built.heightMm * scale),
            quality: 92,
            zoomFactor: dpi / 96,
            unique: true,
          });
          made.push({ filePath: actualPath, productId: doc.productId, sku: doc.sku });
          events.broadcast('progress:event', { id: opId, kind: 'labels', done: i + 1, total: built.documents.length, phase: 'rendering', label: doc.sku });
        }
      }

      // The history lives with the data, so the outcomes go back to the server.
      // The file paths recorded are THIS Mac's — which is where the files are.
      const { run } = await rpc('labels:recordRun', {
        companyId,
        templateId,
        templateName,
        format,
        layoutMode: layout.mode || 'single',
        outputPath: format === 'pdf' ? made[0]?.filePath : outputFolder,
        settings: layout,
        originHost: require('node:os').hostname(),
        items: items || made.map((entry) => ({
          productId: entry.productId ?? null,
          sku: entry.sku ?? null,
          filePath: entry.filePath,
        })),
      });
      return { run, files: made.map((entry) => entry.filePath), outputPath: run.outputPath };
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }
  });

  handleLocal('labels:print', async ({ companyId, templateId, productIds, layout = {}, printOptions = {} } = {}) => {
    const built = await rpc('labels:buildDocument', { companyId, templateId, productIds, layout });
    // Printing has to happen on the Mac with the printer attached to it.
    const result = await require('../renderWindow').printHtml(built.html, printOptions);
    await rpc('labels:recordRun', {
      companyId,
      templateId,
      templateName: built.templateName,
      format: 'print',
      layoutMode: layout.mode || 'single',
      settings: { layout, printOptions },
      originHost: require('node:os').hostname(),
      items: (Array.isArray(productIds) ? productIds : []).map((productId) => ({ productId })),
    });
    return result;
  });

  handleLocal('catalogStudio:print', async ({ id } = {}) => {
    // The printer is on THIS Mac, but the catalog's photos are on the server,
    // and its HTML embeds every one of them — so, as for the export, the
    // server renders the PDF and only the PDF travels. Electron cannot drive a
    // print dialog for a PDF document, so the file opens in Preview, where
    // the user prints it; the renderer says so.
    const res = await rpc('catalogStudio:exportBytes', { id });
    const tmpRoot = require('node:os').tmpdir();
    // These PDFs embed every photo (tens of MB each). They cannot be removed
    // right after opening — Preview is still reading them — so each print
    // clears this handler's own temp folders from earlier prints (> 1 day).
    // Only `msk-catalog-print-*` folders under the OS temp dir, never user files.
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const name of await fsp.readdir(tmpRoot)) {
        if (!name.startsWith('msk-catalog-print-')) continue;
        const abs = path.join(tmpRoot, name);
        const st = await fsp.lstat(abs).catch(() => null);
        if (st && st.isDirectory() && !st.isSymbolicLink() && st.mtimeMs < cutoff) {
          await fsp.rm(abs, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (_) { /* best-effort housekeeping */ }
    const dir = await fsp.mkdtemp(path.join(tmpRoot, 'msk-catalog-print-'));
    const target = path.join(dir, res.fileName);
    await fsp.writeFile(target, Buffer.from(res.bytes));
    const { openPathOrThrow } = require('../util/openPath');
    await openPathOrThrow(target, 'catalog PDF');
    return { ok: true, openedPdf: true };
  });

  handleLocal('catalogStudio:export', async ({ id, outputFolder } = {}) => {
    // The catalog is built from server data (and every product image in it), so
    // the server renders the PDF; this Mac writes it where the user asked. The
    // finished PDF travels rather than the source HTML — for a catalog that is
    // the smaller of the two by a wide margin, because the HTML embeds every
    // image as base64.
    if (!outputFolder || typeof outputFolder !== 'string') throw new Error('Pick an output folder');
    const res = await rpc('catalogStudio:exportBytes', { id });
    await fsp.mkdir(outputFolder, { recursive: true });
    // Never over an earlier export (the server's name carries a minute stamp).
    const outputPath = await writeUniqueFile(outputFolder, res.fileName, Buffer.from(res.bytes));
    // 'Exported' is a property of the catalog, which lives on the server.
    await rpc('catalogStudio:markExported', { id });
    return { outputPath };
  });

  /* v0.1.25 — Social Grid export, on the CLIENT's Mac.
   *
   * Same handover as the catalog above and for the same reason: a client has
   * no database and no product photos, so it cannot lay a grid out — but it
   * does have the folder the user picked. The server renders every page and
   * returns the finished images; this Mac writes them.
   *
   * A grid is a SERIES (a brand of 24 products at 3x3 is three images), so
   * unlike the catalog this writes a list of files and reports them all back.
   */
  handleLocal('socialGrid:export', async ({ config, outputFolder, presetId, runId } = {}) => {
    if (!outputFolder || typeof outputFolder !== 'string') throw new Error('Pick an output folder');
    // 0.1.95: the renderer's run id travels to the server, which registers it
    // so a proxied `socialGrid:cancelExport` can stop the render between
    // images (or before the first, if the Cancel got there first); the images
    // made before the cancel come back and are written. The server's progress
    // events reach this Mac over the socket — if the socket drops mid-run the
    // closing event never comes, so it is also sent locally when this ends.
    const namedRun = typeof runId === 'string' && /^social-[A-Za-z0-9-]{1,64}$/.test(runId);
    try {
      return await exportSocialToFolder({ config, outputFolder, presetId, runId });
    } finally {
      if (namedRun) require('../events').broadcast('progress:event', { id: runId, complete: true });
    }
  });
  async function exportSocialToFolder({ config, outputFolder, presetId, runId }) {
    const res = await rpc('socialGrid:exportBytes', { config, runId });
    const files = Array.isArray(res?.files) ? res.files : [];
    const cancelled = res?.cancelled === true;
    if (cancelled && !files.length) {
      return { outputPaths: [], pageCount: res.pageCount ?? 0, productCount: res.productCount ?? 0, written: 0, cancelled: true };
    }
    if (!files.length) throw new Error('No products match these filters — nothing to export');
    await fsp.mkdir(outputFolder, { recursive: true });
    // v0.1.89: the same never-overwrite rule as the server's own export
    // (freeSeriesSlug in main/socialGridRenderer.js), checked against THIS
    // Mac's folder: the server named the files, but only this Mac can see
    // what is already in the folder it picked.
    const { freeSeriesSlug, fileNameFor } = require('../socialGridRenderer');
    const ext = (path.extname(files[0]?.fileName || '') || '.png').slice(1);
    // A cancelled set is partial; name it as the full series it was planned as.
    const pageCount = cancelled ? Math.max(files.length, Number(res.pageCount) || 0) : files.length;
    const served = String(files[0]?.fileName || '');
    const servedBase = pageCount > 1 ? served.replace(/-\d+\.[^.]+$/, '') : served.replace(/\.[^.]+$/, '');
    const base = freeSeriesSlug(servedBase || 'social-grid', pageCount, ext,
      (name) => fs.existsSync(path.join(outputFolder, name)));
    const outputPaths = [];
    for (let i = 0; i < files.length; i += 1) {
      const target = path.join(outputFolder, path.basename(fileNameFor(base, i, pageCount, ext)));
      await fsp.writeFile(target, Buffer.from(files[i].bytes), { flag: 'wx' });
      outputPaths.push(target);
    }
    // 'Last exported' belongs to the preset, which lives on the server.
    if (presetId && !cancelled) await rpc('socialGrid:markExported', { id: presetId });
    return { outputPaths, pageCount: res.pageCount ?? files.length, productCount: res.productCount ?? 0, written: outputPaths.length, cancelled };
  }

  /* ─── v0.1.27: overlay-apply bridges ────────────────────────────────
   *
   * These three are proxied for every destination EXCEPT "save to folder",
   * which the server cannot do on the client's behalf: the folder was chosen
   * with THIS Mac's picker, and a write performed on the server lands in a
   * directory tree on the other computer while the user's own folder stays
   * empty. For that one destination the server is asked to return the
   * composed bytes and they are written here — the same handover the label,
   * catalog, Social Grid and watermark paths use.
   */
  function makeOverlayApplyHandler(channel) {
    return async (args = {}) => {
      // A dry run does not mutate anything and has no durable outcome to
      // reconcile. Real bulk runs use one ID for the request, progress event,
      // and run-history row so a timed-out client can ask what happened
      // without replaying the mutation.
      if (args.dryRun) return rpc(channel, args);
      const tracked = channel === 'templates:applyBulk' || channel === 'templates:applyByFilter';
      const operationId = tracked ? (args.operationId || require('node:crypto').randomUUID()) : null;
      const destination = args.destination ?? {};
      const request = tracked ? { ...args, operationId } : { ...args };
      const collect = destination.kind === 'saveToFolder';
      if (collect && (!destination.folder || typeof destination.folder !== 'string')) {
        throw new Error('Pick an output folder');
      }
      if (collect) request.destination = { ...destination, collect: true };

      let res;
      try {
        res = await rpc(channel, request);
      } catch (err) {
        if (!tracked || err?.code !== 'RPC_OUTCOME_UNKNOWN') throw err;

        const deadline = Date.now() + 30_000;
        let outcome;
        let lastOutcomeError;
        while (Date.now() < deadline) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          try {
            outcome = await rpc('templates:getApplyOutcome', { operationId }, remainingMs);
            lastOutcomeError = null;
          } catch (outcomeError) {
            // A restart can briefly refuse connections. Retry only transport
            // uncertainty; authenticated HTTP errors have no nested cause and
            // still surface immediately.
            if (outcomeError?.code !== 'RPC_OUTCOME_UNKNOWN' && !outcomeError?.cause) {
              throw outcomeError;
            }
            lastOutcomeError = outcomeError;
          }
          if (outcome?.status !== 'pending' && outcome) break;
          const waitMs = Math.min(250, deadline - Date.now());
          if (waitMs <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }

        if (outcome?.status === 'succeeded') {
          if (collect) {
            throw new Error(
              'The overlay completed on the server, but its response bytes were lost after the connection timed out. ' +
              'No files were saved on this Mac. Run the export again to create the local files.',
              { cause: err },
            );
          }
          return {
            operationId,
            reconciled: true,
            status: 'succeeded',
            summary: outcome.summary,
          };
        }
        if (outcome?.status === 'failed') {
          throw new Error(
            'The overlay operation failed on the server. Refresh product data before retrying.',
            { cause: err },
          );
        }
        if (outcome?.status === 'lost') {
          throw new Error(
            'The server cannot confirm whether the overlay operation completed. ' +
              'Refresh product data before deciding whether to run it again.',
            { cause: err },
          );
        }
        if (lastOutcomeError) {
          throw new Error(
            'Could not reconnect to confirm the overlay result. Refresh product data before deciding whether to run it again.',
            { cause: err },
          );
        }
        throw new Error(
          'The overlay operation is still running on the server. ' +
            'Wait for progress to finish, then refresh product data; do not run it again yet.',
          { cause: err },
        );
      }

      if (!collect) return res;
      const outputs = Array.isArray(res?.outputs) ? res.outputs : [];
      const folder = path.resolve(destination.folder);
      /* v0.1.29: say so if the server produced nothing to write. Silently
       * writing zero files is how the first cut of this bridge behaved — the
       * export reported success and the folder stayed empty. A missing
       * `outputs` array means the two sides disagree about the reply shape,
       * which is worth an error rather than a shrug. */
      if (outputs.length === 0) {
        const nothingToDo = Array.isArray(res?.done) && res.done.length === 0;
        if (!nothingToDo) {
          throw new Error('The server returned no overlay images to save — nothing was written.');
        }
        return { ...res, outputs: [], outputFolder: folder };
      }
      await fsp.mkdir(folder, { recursive: true });

      const written = [];
      for (const out of outputs) {
        if (!out?.bytes) { written.push(null); continue; }
        // Name collision is resolved HERE, because only this Mac can see what
        // is already in the folder. Same -2, -3 … convention as the server.
        const dest = await writeUniqueFile(folder, out.name || 'overlay.png', Buffer.from(out.bytes));
        written.push(dest);
      }

      return {
        ...res,
        // Drop the bytes and report where each file actually landed on THIS Mac.
        outputs: outputs.map((out, i) => {
          const { bytes: _bytes, ...rest } = out;
          return written[i] ? { ...rest, outputFilepath: written[i], savedTo: written[i] } : rest;
        }),
        outputFolder: folder,
      };
    };
  }
  /* Registered with LITERAL channel names, not a loop over an array.
   * test/clientReachability.test.js reads these strings out of the source to
   * prove every channel the UI calls is served in client mode; a loop would
   * make it report these as missing. The guard is right to work that way — an
   * indirect registration is genuinely harder to verify — so the code is
   * explicit instead of the check being loosened. */
  handleLocal('templates:applyToProduct', makeOverlayApplyHandler('templates:applyToProduct'));
  handleLocal('templates:applyBulk', makeOverlayApplyHandler('templates:applyBulk'));
  handleLocal('templates:applyByFilter', makeOverlayApplyHandler('templates:applyByFilter'));

  handleLocal('labels:importAsset', async ({ sourcePath, name } = {}) => {
    // The artwork file is on this Mac, so read it here and send the bytes — the
    // server cannot reach this disk. Same approach as brands:uploadIcon.
    if (!sourcePath || typeof sourcePath !== 'string') throw new Error('An artwork file path is required');
    const bytes = await fsp.readFile(sourcePath);
    return rpc('labels:importAssetFromBytes', {
      bytes, ext: path.extname(sourcePath), name: name || 'label-art',
    });
  });

  /**
   * v0.1.19: watermark loose image files (Overlay Studio → "Watermark external
   * photos"), on the CLIENT's Mac.
   *
   * Why this used to be unavailable here: the original handler ran on the
   * server, so the file paths — which point at the client's disk — meant nothing
   * there, and the UI simply hid the tool in client mode. But the photos ARE on
   * this Mac, so this is exactly where the work belongs. The one piece the
   * client cannot read is the template's logo/watermark asset, which lives in
   * the server's data folder; that is fetched over HTTP and cached in a temp
   * folder for the duration of the batch.
   *
   * The composing itself is main/util/externalOverlay.js, shared with the server
   * handler, so both modes produce identical output.
   */
  handleLocal('templates:applyToExternal', async ({ templateId, inputPaths, outputFolder } = {}) => {
    if (!templateId) throw new Error('templateId required');
    const { applyTemplateToFiles, validateExternalRequest } = require('../util/externalOverlay');
    validateExternalRequest({ inputPaths, outputFolder });

    const template = await rpc('templates:get', templateId);
    if (!template) throw new Error('Template not found');

    const events = require('../events');
    const os = require('node:os');
    const opId = `overlay-external-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const label = template.name || 'Watermark';
    events.broadcast('progress:event', {
      id: opId, kind: 'overlay-external', done: 0, total: inputPaths.length,
      phase: 'applying', label,
    });

    // Assets live on the server. Download each one once into a temp folder and
    // hand compose() the local path. Nothing is written next to the user's
    // photos, and the temp folder is removed in the finally block.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-ext-assets-'));
    const cache = new Map();
    let n = 0;
    const resolveAsset = async (rel) => {
      if (!rel) return null;
      if (cache.has(rel)) return cache.get(rel);
      const base = baseUrl();
      const auth = authHeader();
      if (!base || !auth) {
        throw new Error(`Could not load overlay artwork "${rel}": server connection is not configured`);
      }
      let res;
      try {
        res = await fetch(`${base}/assets/${encodeURI(rel)}`, {
          headers: { Authorization: auth },
        });
      } catch (err) {
        throw new Error(`Could not load overlay artwork "${rel}": ${err.message}`, { cause: err });
      }
      if (!res.ok) {
        throw new Error(`Could not load overlay artwork "${rel}": server returned ${res.status}`);
      }
      n += 1;
      const abs = path.join(tmpDir, `${n}-${path.basename(rel)}`);
      await fsp.writeFile(abs, Buffer.from(await res.arrayBuffer()));
      cache.set(rel, abs);
      return abs;
    };

    try {
      return await applyTemplateToFiles({
        template,
        inputPaths,
        outputFolder,
        resolveAsset,
        onProgress: ({ done, total, label: progressLabel }) => {
          events.broadcast('progress:event', {
            id: opId, kind: 'overlay-external', done, total, phase: 'applying', label: progressLabel,
          });
        },
      });
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  });
}

/* ─── v0.16.0: read-then-upload bridges for image imports ───────── */

/**
 * The renderer's existing API surface assumes:
 *   - `images:importForProduct(productId, sourcePath)` — bytes the
 *     handler reads from disk
 *   - `images:autoMatchBySku(companyId, folderPath)` — folder scan
 *     plus per-match import
 *   - `brands:uploadIcon(sourcePath, name)` — bytes from disk
 *   - `watermarks:upload(sourcePath)` — bytes from disk
 *
 * In client mode the path is on a DIFFERENT Mac than the server. We
 * keep the same channel names but the client-side handler reads
 * bytes locally first, then calls the bytes-based RPC equivalent on
 * the server. Callers don't notice the difference.
 */
function registerClientImageImportBridges() {
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const imageManager = require('../imageManager');

  handleLocal('images:importForProduct', async ({ productId, sourcePath } = {}) => {
    if (!productId) throw new Error('productId required');
    if (!sourcePath) throw new Error('sourcePath required');
    const bytes = await fsp.readFile(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
    return rpc('images:importFromBytes', { productId, bytes, ext });
  });

  handleLocal('brands:uploadIcon', async ({ sourcePath, name } = {}) => {
    if (!sourcePath) throw new Error('sourcePath required');
    const bytes = await fsp.readFile(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    // The server doesn't yet have a bytes-based brand-icon upload —
    // add `brands:uploadIconFromBytes` on the server side and proxy
    // to that. See ipc.js for the handler.
    return rpc('brands:uploadIconFromBytes', { bytes, ext, name });
  });

  handleLocal('watermarks:upload', async ({ sourcePath } = {}) => {
    if (!sourcePath) throw new Error('sourcePath required');
    const bytes = await fsp.readFile(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const name = path.basename(sourcePath, path.extname(sourcePath));
    // Server already has watermarks:uploadFromBytes (v0.15.0).
    return rpc('watermarks:uploadFromBytes', { bytes, ext, name });
  });

  /**
   * v0.16.1: bulk AI queue from a folder on the client's Mac. Read
   * each file's bytes locally and forward them to the server's
   * bytes-based handler. The renderer's existing AI Studio Bulk flow
   * calls `ai:queueBulkBatch(sourcePaths, ...)`; this handler keeps
   * the same shape and converts paths → bytes silently.
   */
  handleLocal('ai:queueBulkBatch', async (input = {}) => {
    if (!Array.isArray(input?.sourcePaths) || input.sourcePaths.length === 0) {
      throw new Error('No source images supplied');
    }
    // v0.17.1: progress for the read-bytes-locally phase. The
    // server-side enqueue then happens in one RPC call (we batch
    // everything in `sources`), so there's no per-task progress
    // beyond "reading file N of M".
    const events = require('../events');
    const opId = `bulk-queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const total = input.sourcePaths.length;
    events.broadcast('progress:event', {
      id: opId, kind: 'bulk-queue', done: 0, total, phase: 'reading',
    });

    const sources = [];
    const skipped = [];
    for (const sp of input.sourcePaths) {
      try {
        const bytes = await fsp.readFile(sp);
        sources.push({
          bytes,
          ext: path.extname(sp).toLowerCase() || '.jpg',
          name: path.basename(sp),
        });
      } catch (err) {
        skipped.push({ sourcePath: sp, error: err.message });
      }
      events.broadcast('progress:event', {
        id: opId, kind: 'bulk-queue', done: sources.length + skipped.length, total,
        phase: 'reading', label: path.basename(sp),
      });
    }
    if (sources.length === 0) {
      events.broadcast('progress:event', { id: opId, complete: true });
      return { queued: 0, tasks: [], skipped };
    }
    events.broadcast('progress:event', {
      id: opId, kind: 'bulk-queue', done: sources.length, total, phase: 'uploading',
    });
    let result;
    try {
      /* v0.1.27: strip exportDir.
       *
       * The folder was chosen through THIS Mac's folder picker, then forwarded
       * verbatim, and the server's queue runner mkdirs it and copies finished
       * generations into it — so the images landed on the SERVER's disk inside
       * a directory tree the client invented, while the folder the user picked
       * stayed empty. Generation results already come back through the gallery,
       * which works in client mode; only this side-channel did not.
       *
       * Removed rather than rewritten locally because the queue is asynchronous
       * — the bytes arrive much later, on the server's schedule — so there is
       * nothing here to write them to. The export-folder control is hidden in
       * client mode; see BulkSourcePanel. */
      const { exportDir: _ignoredExportDir, ...safeOptions } = input.options ?? {};
      result = await rpc('ai:queueBulkBatchFromBytes', {
        companyId: input.companyId,
        provider: input.provider,
        model: input.model,
        prompt: input.prompt,
        options: safeOptions,
        promptTemplateId: input.promptTemplateId,
        sources,
      });
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }
    // Merge the locally-detected read failures into the server's
    // skipped list so the renderer's stats are complete.
    return {
      ...result,
      skipped: [...(result?.skipped ?? []), ...skipped],
    };
  });

  /**
   * v0.16.2: Export Center run from a client Mac. The server runs
   * the Sharp pipeline against its own DB + assets (where the files
   * actually live), produces output into a temp folder, then sends
   * us the bytes for every file. We write each one under the
   * user's chosen outputRoot. The renderer's return-shape contract
   * is preserved — same `{ exported, skipped, products, outputPath,
   * skips }` so the Export Center's result modal Just Works.
   */
  handleLocal('exports:run', async ({ profileId, productIds, outputRoot, onExisting, saveToLibrary, runId, imageScope } = {}) => {
    if (!profileId) throw new Error('profileId required');
    if (!outputRoot) throw new Error('outputRoot required');
    // v0.31.0: forward saveToLibrary — the server appends the exports to
    // ITS library (the shared source of truth) + broadcasts a catalog
    // change, which this client picks up like any other remote edit.
    const result = await rpc('exports:runForClient', { profileId, productIds, saveToLibrary, runId, imageScope });
    const files = Array.isArray(result?.files) ? result.files : [];

    /* v0.1.27: honour the collision choice the user already made.
     *
     * The export happens on the server into a fresh temp folder, so from the
     * server's point of view nothing ever collides — it reports zero existing
     * files and hands back the bytes. The collision the user answered the
     * modal about is with THEIR output folder, and only this Mac can see it.
     * `onExisting` was previously dropped on the floor here (it was not even
     * destructured), so "Skip files that already exist" and "Keep both" both
     * silently overwrote. The policy is now applied where the files actually
     * land, and the counters are corrected to match what really happened so
     * the result toast is not a work of fiction. */
    const nodeFs = require('node:fs');
    const mode = ['replace', 'skip', 'keepBoth'].includes(onExisting) ? onExisting : 'keepBoth';
    const outRootAbs = path.resolve(outputRoot);
    let skippedExisting = 0;
    let replaced = 0;
    const skippedNow = [];
    const written = [];

    for (const f of files) {
      const rel = f?.relPath;
      let dest = containedMediaPath(outRootAbs, rel);

      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const bytes = Buffer.from(f.bytes);
      if (mode === 'skip') {
        try {
          await writeExclusiveFile(dest, bytes);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          skippedExisting += 1;
          skippedNow.push({ sku: path.basename(rel), reason: 'Already exists in the output folder' });
          continue;
        }
      } else if (mode === 'replace') {
        if (nodeFs.existsSync(dest)) replaced += 1;
        await fsp.writeFile(dest, bytes);
      } else {
        dest = await writeUniqueFile(path.dirname(dest), path.basename(dest), bytes);
      }
      written.push(dest);
    }

    // Drop the bytes from the return value — renderer doesn't need
    // them and we shouldn't keep them in store memory.
    const { files: _files, ...rest } = result;
    return {
      ...rest,
      outputPath: outRootAbs,
      // Correct the server's counters to describe THIS Mac's output folder.
      exported: written.length,
      replaced,
      skippedExisting,
      skipped: (rest.skipped ?? 0) + skippedExisting,
      skips: [...(rest.skips ?? []), ...skippedNow],
    };
  });

  /**
   * v0.26.50: client-mode local bridge for the export collision check.
   *
   * The bug this fixes: `exports:checkCollisions` was exposed on the
   * server and bound in preload, but never added to the client's
   * proxy list — so a client calling it got "No handler registered for
   * 'exports:checkCollisions'". (The export itself still ran via the
   * exports:run bridge; only the pre-flight collision warning broke.)
   *
   * Why we can't just proxy it to the server: the collision check does
   * fs.existsSync against the OUTPUT folder, and in client mode that
   * folder is on the CLIENT's disk (e.g. the user's Desktop). The
   * server can't see it — proxying would check the server's filesystem
   * and report "no collisions" even when the client's Desktop is full
   * of same-named files.
   *
   * The fix mirrors the exports:run bridge: fetch the expected
   * filenames from the server (which has the DB + naming pattern),
   * then run the existence check LOCALLY against the client's
   * outputRoot. Same return shape as the server-side previewCollisions
   * so the Export Center's collision modal works identically.
   */
  handleLocal('exports:checkCollisions', async ({ profileId, productIds, outputRoot, imageScope } = {}) => {
    if (!profileId || !outputRoot) {
      return { totalExpected: 0, collisionCount: 0, sampleCollisions: [] };
    }
    const { totalExpected, entries } = await rpc('exports:expectedOutputs', { profileId, productIds, imageScope });
    const outRootAbs = path.resolve(outputRoot);
    const collisions = [];
    for (const { rel, sku } of (entries || [])) {
      const dest = containedMediaPath(outRootAbs, rel);
      try {
        if (fs.existsSync(dest)) collisions.push({ name: path.basename(dest), sku });
      } catch { /* ignore unreadable path */ }
    }
    return {
      totalExpected: totalExpected ?? 0,
      collisionCount: collisions.length,
      sampleCollisions: collisions.slice(0, 5),
    };
  });

  /**
   * v0.16.1: export a bulk gallery image to a path on the client's
   * Mac. Fetches the bytes from the server, opens the save dialog
   * locally, writes the file. Same return contract as the
   * standalone version (returns destination path or null on cancel).
   */
  handleLocal('ai:exportBulkImage', async ({ galleryId } = {}) => {
    if (!galleryId) throw new Error('galleryId required');
    const result = await rpc('ai:exportBulkImageBytes', { galleryId });
    if (!result?.bytes) throw new Error('No image bytes returned');
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.getFocusedWindow();
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save AI result as…',
      defaultPath: result.defaultName || 'bulk-export.png',
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, Buffer.from(result.bytes));
    return filePath;
  });

  /**
   * v0.49.39: client-mode local handlers for the multi-image copy +
   * drag-out feature.
   *
   * Both must run LOCALLY on the client Mac (they touch the client's
   * filesystem + the client's renderer drag state), not be proxied to
   * the server. The bytes for each image come back via net.fetch
   * through the app-image:// protocol — which `registerClientImageProtocol`
   * has already wired up to HTTPS the remote server with the bearer
   * token. So one net.fetch call here does both "auth" and "transfer"
   * without us duplicating the proxy logic.
   *
   * Two reasons these don't appear in PROXIED_CHANNELS:
   *   (1) copyImagesToFolder pops a folder picker on THIS Mac and
   *       writes files to THIS Mac's disk. The server has no business
   *       resolving paths on a different machine.
   *   (2) startDragOut calls webContents.startDrag — that's THIS
   *       renderer's drag operation. The server doesn't have a
   *       webContents instance for the client's window.
   */
  handleLocal('images:copyImagesToFolder', async ({ productId, filepaths, targetFolder, sku: providedSku } = {}) => {
    if (!productId) throw new Error('productId is required');
    if (!Array.isArray(filepaths) || filepaths.length === 0) {
      throw new Error('filepaths must be a non-empty array');
    }

    // Folder picker — exactly the same dialog the standalone handler
    // uses, just initiated from the client's main process. No server
    // round-trip for the picker.
    const { dialog: dlg, shell: shl, net: nt } = require('electron');
    let folder = targetFolder;
    if (!folder) {
      const res = await dlg.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: filepaths.length === 1 ? 'Save image copy to…' : `Save ${filepaths.length} image copies to…`,
      });
      if (res.canceled || !res.filePaths[0]) {
        return { copied: 0, folder: null, canceled: true, failures: [] };
      }
      folder = res.filePaths[0];
    }

    // No local DB on the client, so the SKU MUST come from the
    // renderer (which has the product loaded in the side panel). Falls
    // back to 'product' if missing so the copy doesn't fail outright
    // on a stale renderer.
    const sku = ((providedSku || 'product').toString().trim() || 'product')
      .replace(/[^A-Za-z0-9._-]+/g, '-');

    // Resolve every destination before starting I/O so completion order cannot
    // change filenames. Three transfers gave a useful speedup without turning
    // a copy action into an unbounded request burst.
    // ponytail: at most three complete image bodies are buffered; stream this
    // operation if larger normal images make that memory ceiling a problem.
    const jobs = [];
    for (let i = 0; i < filepaths.length; i += 1) {
      const rel = filepaths[i];
      const ext = path.extname(rel) || '.jpg';
      const idx = String(i + 1).padStart(3, '0');
      const baseName = `${sku}-${idx}${ext}`;

      // Reserve each destination atomically before any downloads start. This
      // keeps names deterministic while preventing another simultaneous copy
      // action from claiming a path between existsSync() and writeFile().
      let final = path.join(folder, baseName);
      let collisionN = 1;
      let output = null;
      let reservationError = null;
      while (!output) {
        try {
          output = await fsp.open(final, 'wx');
        } catch (err) {
          if (err.code !== 'EEXIST') {
            reservationError = err;
            break;
          }
          final = path.join(folder, `${sku}-${idx} (${collisionN})${ext}`);
          collisionN += 1;
        }
      }
      jobs.push({ rel, final, output, reservationError });
    }

    const results = new Array(jobs.length);
    let cursor = 0;
    async function copyNext() {
      while (cursor < jobs.length) {
        const i = cursor;
        cursor += 1;
        const { rel, final, output, reservationError } = jobs[i];

        try {
          if (reservationError) throw reservationError;
          // The app-image:// protocol handler is the client-mode
          // passthrough that HTTPs to the server with the bearer token
          // and proxies the bytes back. So net.fetch hides all the
          // "where do these bytes live" complexity from us.
          const url = `app-image://local/${encodeURIComponent(rel)}`;
          const res = await nt.fetch(url);
          if (!res.ok) throw new Error(`fetch returned ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          await output.writeFile(buf);
          await output.close();
          results[i] = null;
        } catch (err) {
          if (output) {
            try { await output.close(); } catch (_) { /* original error wins */ }
            try { await fsp.rm(final, { force: true }); } catch (_) { /* best effort */ }
          }
          results[i] = { filename: path.basename(rel), error: err.message };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, () => copyNext()));
    const failures = results.filter(Boolean);
    const copied = results.length - failures.length;

    if (copied > 0) {
      try { shl.openPath(folder); } catch (_) { /* non-fatal */ }
    }

    return { copied, folder, canceled: false, failures };
  });

  /* ─── v0.49.40: client-mode multi-file drag-out ─────────────────
   *
   * Replaces the v0.49.39 no-op. Two channels work together:
   *
   *   images:prepareDrag (invoke) — download N files from the server
   *     to a per-drag temp directory and return the resolved local
   *     paths. The renderer calls this on mousedown of the drag pill
   *     so the bytes are usually ready by the time the user moves
   *     enough pixels for `ondragstart` to fire. Returns
   *     `{ tmpDir, files: [absPath, …], failed: [...] }`. Renderer
   *     keeps the result in component state and hands the paths to
   *     `startDragOut` when the actual drag begins.
   *
   *   images:startDragOut (send) — fires the OS-level drag. In
   *     client mode the args include `preparedPaths` (the absolute
   *     temp-dir paths from a prior prepareDrag). startDrag is
   *     synchronous from main's perspective once the temp files
   *     exist; calling it from inside the IPC.on handler is fast
   *     enough that the OS picks up the user's still-held mouse.
   *
   * Two-step on purpose: a single onDragStart that BOTH downloads
   * AND drags would race the user's mouse-release on a slow link.
   * Pre-fetching on mousedown gives the bytes a head start; the
   * dragstart that follows ~100–300ms later finds files already
   * landed. On fast LAN this all happens in <100ms; on Tailscale
   * with a few 1–2 MB images it's still under a second.
   *
   * Lifetime: each prepareDrag creates a unique temp dir at
   * `os.tmpdir()/iskh-drag-<rand>/`. Cleanup runs 5 min after the
   * download completes (browsers / Mail.app etc. read attached files
   * lazily — 5 min is enough headroom). For the rare crash-mid-drag
   * case we rely on macOS's per-reboot /tmp cleanup; an in-app
   * sweep on next launch is a future improvement if real leaks
   * become visible.
   */
  handleLocal('images:prepareDrag', async ({ productId, filepaths } = {}) => {
    if (!productId) throw new Error('productId is required');
    if (!Array.isArray(filepaths) || filepaths.length === 0) {
      throw new Error('filepaths must be a non-empty array');
    }
    const { net: nt } = require('electron');
    const os = require('node:os');
    const crypto = require('node:crypto');
    const productImageRows = await rpc('images:listByProduct', productId);
    if (!Array.isArray(productImageRows)) throw new Error('Could not verify product images with the server');
    const productFilepaths = new Set(productImageRows.map((image) => image.filepath));

    // Unique temp dir per drag. Path collisions inside it are still
    // possible if the user dragged duplicate filenames from different
    // product subfolders, but we handle that defensively below.
    const dragId = `iskh-drag-${crypto.randomBytes(4).toString('hex')}`;
    const tmpDir = path.join(os.tmpdir(), dragId);
    await fsp.mkdir(tmpDir, { recursive: true });

    const failed = [];
    const downloaded = [];
    // Parallel downloads — bandwidth-limited by HTTPS to the server,
    // not CPU; Promise.all is fine for typical (≤20) selection sizes.
    await Promise.all(filepaths.map(async (rel) => {
      try {
        if (typeof rel !== 'string' || !productFilepaths.has(rel)) {
          throw new Error('image is not attached to this product');
        }
        const baseName = path.basename(rel) || 'image.jpg';

        // app-image:// in client mode routes to HTTPS server with
        // bearer token (registerClientImageProtocol). Same auth
        // surface the Lightbox uses for thumbs — no duplicate token
        // plumbing here.
        const url = `app-image://local/${encodeURIComponent(rel)}`;
        const res = await nt.fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const final = await writeUniqueFile(tmpDir, baseName, buf);
        issuedDragPaths.set(final, Date.now() + DRAG_PREP_TTL_MS);
        downloaded.push(final);
      } catch (err) {
        failed.push({ filepath: rel, error: err.message });
      }
    }));

    if (downloaded.length === 0) {
      // Total failure — clean up the empty temp dir and report.
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
      throw new Error(
        failed.length === 1
          ? `Couldn't download ${failed[0].filepath}: ${failed[0].error}`
          : `All ${filepaths.length} downloads failed — check connection.`,
      );
    }

    // Schedule cleanup of THIS temp dir. The drag itself usually
    // completes in seconds, but receiving apps may read the bytes
    // lazily — 5 minutes is paranoia-safe without leaving the temp
    // dir around forever.
    const cleanupTimer = setTimeout(() => {
      for (const filePath of downloaded) issuedDragPaths.delete(filePath);
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }, DRAG_PREP_TTL_MS);
    cleanupTimer.unref?.();

    return { tmpDir, files: downloaded, failed };
  });

  ipcMain.on('images:startDragOut', async (event, args = {}) => {
    const preparedPaths = args && typeof args === 'object' ? args.preparedPaths : null;
    if (!Array.isArray(preparedPaths) || preparedPaths.length === 0) {
      // No prepared paths — the renderer either skipped prepareDrag
      // (which client mode requires) or the drag was triggered with
      // a stale/empty cache. Silently no-op rather than blow up the
      // user's drag gesture.
      return;
    }
    // Defensive existence check — temp files may have been cleaned
    // up by the 5 min timer if the user prepared a drag and then
    // sat on the pill for too long.
    const livePaths = takeIssuedDragPaths(preparedPaths).filter((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (livePaths.length === 0) return;

    const { nativeImage } = require('electron');
    const sharp = require('sharp');
    let icon;
    try {
      const iconBuf = await sharp(livePaths[0], { failOn: 'none' })
        .rotate()
        .resize(64, 64, { fit: 'inside' })
        .png()
        .toBuffer();
      icon = nativeImage.createFromBuffer(iconBuf);
      if (icon.isEmpty()) icon = nativeImage.createEmpty();
    } catch (_) {
      icon = nativeImage.createEmpty();
    }

    try {
      event.sender.startDrag({ files: livePaths, icon });
    } catch (err) {
      console.error('[client startDragOut] startDrag threw:', err.message);
    }
  });

  /**
   * Auto-match in client mode:
   *   1. Scan the client's folder locally for image files.
   *   2. Fetch the SKU list from the server.
   *   3. Group + sort matches purely on the client (no DB needed).
   *   4. Stream per-file uploads to the server via importFromBytes.
   *   5. Aggregate the same diagnostic stats the server-side handler
   *      returns so the result modal looks identical.
   */
  handleLocal('images:autoMatchBySku', async ({ companyId, folderPath, dryRun, files } = {}) => {
    if (!companyId) throw new Error('companyId is required');
    if (!folderPath) throw new Error('Folder path is required');

    /* 0.1.94: preview, then import — the same two modes as the standalone
     * handler (main/ipc/images.js), planned by the same shared
     * main/util/autoMatchPlan.js. The folder is on THIS Mac, so the scan and
     * the file reads happen here; the products and the photos are the
     * server's, so they go over RPC. */
    if (dryRun === true) {
      const { buildAutoMatchPlan, summarizeUnmatched } = require('../util/autoMatchPlan');
      const list = await rpc('products:list', { companyId });
      if (!Array.isArray(list)) throw new Error('Could not fetch product list from server');
      const skuToProduct = new Map(list.map((p) => [p.sku.toLowerCase(), p]));
      const allImages = imageManager.scanImagesRecursive(folderPath);
      const { groups, unmatched } = imageManager.groupAndSortMatches(allImages, folderPath, new Set(skuToProduct.keys()));
      const plan = buildAutoMatchPlan({
        groups, skuToProduct, imageCountOf: (p) => p.imageCount, max: imageManager.MAX_IMAGES_PER_PRODUCT, folderPath,
      });
      return {
        dryRun: true,
        ...plan,
        ...summarizeUnmatched(unmatched, folderPath),
        scannedFiles: allImages.length,
        totalProducts: list.length,
        matchedSkus: plan.products.length,
        maxImagesPerProduct: imageManager.MAX_IMAGES_PER_PRODUCT,
      };
    }
    if (Array.isArray(files)) {
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const { importEntryProblem, relativeTo } = require('../util/autoMatchPlan');
      if (files.length > 200) throw new Error('Too many files in one batch (max 200)');
      let imported = 0;
      let skippedDup = 0;
      const failures = [];
      const touched = new Set();
      for (const entry of files) {
        const problem = importEntryProblem(folderPath, entry);
        if (problem) {
          failures.push({ filepath: String(entry?.sourcePath ?? ''), sku: entry?.sku ?? '', error: problem });
          continue;
        }
        try {
          const bytes = await fsp.readFile(entry.sourcePath);
          const ext = path.extname(entry.sourcePath).toLowerCase() || '.jpg';
          // makeMain rides on the add itself: the server sets the main image
          // by row id inside the same product-lock turn as the add. A second
          // set-main-by-filepath RPC here could hit a different photo if
          // another Mac renumbered the product's files in between.
          const res = await rpc('images:importFromBytes', {
            productId: entry.productId, bytes, ext,
            ...(entry.makeMain === true ? { makeMain: true } : {}),
          });
          if (res?.skipped) skippedDup += 1;
          else { imported += 1; touched.add(entry.productId); }
        } catch (err) {
          failures.push({ filepath: relativeTo(folderPath, entry.sourcePath), sku: entry.sku ?? '', error: err.message });
        }
      }
      return { imported, skippedDup, failures, productsTouched: [...touched] };
    }

    // v0.17.1: progress events. In client mode `broadcast` only
    // delivers to the local renderer (no WS server here), which is
    // exactly what we want — the user staring at the import modal.
    const events = require('../events');
    const opId = `auto-match-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    events.broadcast('progress:event', {
      id: opId, kind: 'auto-match', done: 0, total: null, phase: 'scanning',
    });

    const list = await rpc('products:list', { companyId });
    if (!Array.isArray(list)) throw new Error('Could not fetch product list from server');
    const skuToProduct = new Map(list.map((p) => [p.sku.toLowerCase(), p]));
    const skuSet = new Set(skuToProduct.keys());

    const allImages = imageManager.scanImagesRecursive(folderPath);
    const { groups, unmatched } = imageManager.groupAndSortMatches(allImages, folderPath, skuSet);

    // We don't know the server's MAX_IMAGES_PER_PRODUCT for sure
    // (the imageManager constant is local), but the server-side cap
    // is also imageManager.MAX_IMAGES_PER_PRODUCT — they're the same
    // module bundled into both processes, so the number matches.
    const MAX = imageManager.MAX_IMAGES_PER_PRODUCT;
    let productsTouched = 0;
    let imagesImported = 0;
    let imagesSkippedDup = 0;
    let imagesSkippedCap = 0;
    const failures = [];

    // Pre-tally for a determinate bar.
    let total = 0;
    for (const [, candidates] of groups) total += candidates.length;
    let done = 0;

    try {
      for (const [sku, candidates] of groups) {
        const product = skuToProduct.get(sku);
        if (!product) continue;
        const remainingCap = MAX - (product.imageCount ?? 0);
        const capped = candidates.slice(0, Math.max(0, remainingCap));
        imagesSkippedCap += candidates.length - capped.length;
        done += candidates.length - capped.length;

        let touched = false;
        for (const c of capped) {
          try {
            const bytes = await fsp.readFile(c.sourcePath);
            const ext = path.extname(c.sourcePath).toLowerCase() || '.jpg';
            const res = await rpc('images:importFromBytes', {
              productId: product.id, bytes, ext,
            });
            if (res?.skipped) imagesSkippedDup += 1;
            else { imagesImported += 1; touched = true; }
          } catch (err) {
            failures.push({
              filepath: path.relative(folderPath, c.sourcePath) || path.basename(c.sourcePath),
              sku: product.sku,
              error: err.message,
            });
          }
          done += 1;
          events.broadcast('progress:event', {
            id: opId, kind: 'auto-match', done, total,
            phase: 'uploading', label: product.sku,
          });
        }
        if (touched) productsTouched += 1;
      }
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }

    // Mirror the shape the server-side handler returns so the result
    // modal's existing fields just work. We don't recompute the
    // "products still empty" list here — fetching it would require a
    // post-import products:list round-trip; let the renderer do that
    // itself if it wants the precise number.
    const unmatchedRelative = unmatched
      .map((abs) => {
        try {
          const rel = path.relative(folderPath, abs);
          return rel && !rel.startsWith('..') ? rel : abs;
        } catch (_) { return abs; }
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const UNMATCHED_CAP = 500;
    const unmatchedSamples = unmatchedRelative.slice(0, UNMATCHED_CAP);
    const extCounts = {};
    for (const rel of unmatchedRelative) {
      const ext = (path.extname(rel) || '(no ext)').toLowerCase();
      extCounts[ext] = (extCounts[ext] ?? 0) + 1;
    }

    return {
      productsTouched,
      imagesImported,
      imagesSkippedDup,
      imagesSkippedCap,
      imagesFailed: failures.length,
      failures,
      unmatchedFiles: unmatched.length,
      unmatchedSamples,
      unmatchedSamplesCapped: unmatched.length > unmatchedSamples.length,
      unmatchedExtCounts: extCounts,
      productsStillEmpty: [],          // skipped — see comment above
      productsStillEmptyCapped: false,
      scannedFiles: allImages.length,
      totalProducts: list.length,
      matchedSkus: groups.size,
      maxImagesPerProduct: MAX,
    };
  });
}

module.exports = {
  registerClientProxies,
  getConnectionState,
  reconnectNow,
  // Pure timing rules, exported for test/connectivity.test.js.
  rpcTimeoutMs,
  pingRetryDelay,
  stallProbeVerdict,
  rpc,
  baseUrl,
  authHeader,
};
