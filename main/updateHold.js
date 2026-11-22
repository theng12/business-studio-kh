/**
 * Update hold — the app side of the fleet contract
 * (`_orchestra/youtube-stack/update-hold/CONTRACT.md`, owner 2026-11-15).
 *
 *   POST   /api/maintenance/hold?timeout_s=20&pause_s=120
 *   DELETE /api/maintenance/hold
 *   →      {"safe":bool,"unsettled":[],"dispatch_paused_s":120,"in_flight":N}
 *
 * The installer asks before it replaces this app. The hold stops this app
 * claiming new work, waits up to `timeout_s` for what is already running, and
 * answers whether a restart right now would strand anything. Everything here
 * lives in memory: the pause expires on a timer, so an install that aborts can
 * never leave an app that has stopped taking work — a restart always resumes.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_S = 20;
const MAX_TIMEOUT_S = 30;              // the contract's ceiling, not a job's own bound
const DEFAULT_PAUSE_S = 120;
const MAX_PAUSE_S = 900;
const SETTLE_POLL_MS = 200;
/**
 * How long a quit that follows a hold still counts as the installer's. The
 * Launcher quits straight after it reads the hold's answer, so this only has to
 * cover its own settle and swap; anything later is a person's quit.
 */
const UPDATER_QUIT_WINDOW_MS = 60 * 1000;
/** Bind attempts before the app accepts it cannot be held (a closing copy still holds the port). */
const BIND_ATTEMPTS = 3;
const BIND_RETRY_MS = 500;

/* 13181: this app's own LAN server is 13180, so the hold sits beside it on the
 * same machine. Loopback only, plain HTTP — the signed feed names the full URL
 * for the installer, and a remote caller has no business holding this app. */
const HOLD_PORT = 13181;

let pausedUntil = 0;
let pauseTimer = null;
let updaterHoldUntil = 0;
let holdGeneration = 0;
let available = false;
let log = (message) => process.stderr.write(`[update-hold] ${message}\n`);

function setLog(fn) { log = fn; }

function isPaused() { return Date.now() < pausedUntil; }

/**
 * Work a restart would strand, named by the id the next start follows. AI
 * generations carry their `ai_tasks` row; an export or a print render is one
 * long job with no row to re-dispatch, so the installer is told to wait for it
 * rather than quit inside it. Lookups never hold an installer hostage.
 *
 * The hold also refuses a new export (main/ipc/exports.js,
 * main/exportJournal.js) so an update cannot start one behind itself.
 */
function inFlightIds() {
  const ids = [];
  try {
    for (const id of require('./ai/queueRunner').inflightIds()) ids.push(`ai-task:${id}`);
  } catch (_) { ids.push('ai-work-status-unavailable'); }
  try {
    if (require('./ipc/exports').hasActiveRun()) ids.push('export-run');
  } catch (_) { ids.push('export-status-unavailable'); }
  try {
    if (require('./renderWindow').isRendering()) ids.push('render-job');
  } catch (_) { ids.push('render-status-unavailable'); }
  try {
    for (const id of require('./exportJournal').instance().inFlightIds()) ids.push(`local-export:${id}`);
  } catch (_) { ids.push('export-recovery-unavailable'); }
  return ids;
}

function pause(pauseS) {
  pausedUntil = Date.now() + pauseS * 1000;
  updaterHoldUntil = 0;
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => {
    pauseTimer = null;
    pausedUntil = 0;
    updaterHoldUntil = 0;
    resumed('the pause ran out');
  }, pauseS * 1000);
  pauseTimer.unref?.();
}

/**
 * Is this quit the installer's? True only shortly after an authenticated hold:
 * the Launcher POSTs the hold, reads `safe`, then quits. No hold, a released
 * hold, or one that has run out is a person's quit. A local process gains
 * nothing it did not already have — the hold needs the 0600
 * `~/Library/KHUpdater/state/hold-token`, and anything that can read that can
 * already `kill` this app, which needs no credential and skips no PIN.
 */
function isUpdaterQuit() {
  return isPaused() && Date.now() < updaterHoldUntil && inFlightIds().length === 0;
}

/** Did the loopback hold open? When it did not, no update may start (main/ipc/updates.js). */
function isAvailable() {
  return available;
}

function resumed(why) {
  log(`new work resumes: ${why}`);
  try { require('./ai/queueRunner').nudge(); } catch (_) { /* nothing queued */ }
}

/**
 * Stop claiming, settle within the bound, answer honestly. Waiting for the
 * work to finish is never the goal: what is still running at the deadline is
 * named in `unsettled` so the installer waits or reports it instead of
 * installing over it.
 */
async function takeHold(timeoutS, pauseS, inFlight = inFlightIds) {
  const generation = ++holdGeneration;
  pause(pauseS);
  const ids = () => { try { return inFlight() || []; } catch (_) { return ['work-status-unavailable']; } };
  const first = ids();
  log(`held: ${first.length ? first.join(', ') : 'nothing'} in flight, new work paused ${pauseS} s, settling for up to ${timeoutS} s`);

  const deadline = Date.now() + timeoutS * 1000;
  let remaining = first;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    remaining = ids();
  }
  if (remaining.length > 0) {
    log(`${remaining.join(', ')} still running at the ${timeoutS} s bound; this update must wait`);
  } else {
    log(`settled in under ${timeoutS} s`);
  }
  const stillHeld = generation === holdGeneration && isPaused();
  if (remaining.length === 0 && stillHeld) {
    updaterHoldUntil = Date.now() + Math.min(pausedUntil - Date.now(), UPDATER_QUIT_WINDOW_MS);
  }
  return {
    safe: remaining.length === 0 && stillHeld,
    unsettled: stillHeld ? remaining : [...remaining, 'hold-expired-or-released'],
    dispatch_paused_s: stillHeld ? pauseS : 0,
    in_flight: remaining.length,
  };
}

/** Resume at once. Never required — the pause expires by itself. */
function releaseHold() {
  holdGeneration += 1;
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
  const wasPaused = isPaused();
  pausedUntil = 0;
  updaterHoldUntil = 0;
  if (wasPaused) resumed('the installer said so');
  const left = inFlightIds();
  return {
    safe: left.length === 0,
    unsettled: left,
    dispatch_paused_s: 0,
    in_flight: left.length,
  };
}

function bounded(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Connection': 'close',
  });
  res.end(text);
}

/**
 * The loopback listener. Started on every boot, whatever the mode: an update
 * can replace a standalone, kiosk or client copy, and each one has work to
 * keep. A port already in use is retried, then reported as unholdable and
 * logged; from then on the app refuses to start an update (see
 * `isAvailable`), because an update with nobody able to hold it is the
 * mid-job install this endpoint exists to prevent.
 *
 * Per-request credential check (matching Printer/UpdateHold): POST and DELETE
 * require the updater's `~/Library/KHUpdater/state/hold-token` via
 * `X-Hub-Token` or `Authorization: Bearer`. Missing file, missing header, or
 * mismatch returns 401 so an unauthenticated local process cannot hold or
 * release this app.
 */
function defaultTokenFile() {
  return process.env.BUSINESS_STUDIO_HOLD_TOKEN_FILE
    || process.env.KHU_HOLD_TOKEN_FILE
    || path.join(os.homedir(), 'Library', 'KHUpdater', 'state', 'hold-token');
}

function configuredToken(tokenFile) {
  try {
    const text = fs.readFileSync(tokenFile, 'utf8').trim();
    return text || null;
  } catch (_) {
    return null;
  }
}

function offeredCredential(req) {
  const hubHeader = req.headers['x-hub-token'];
  const hub = Array.isArray(hubHeader) ? hubHeader[0] : hubHeader;
  if (typeof hub === 'string' && hub.trim()) return hub.trim();
  const authHeader = req.headers.authorization;
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    return token || null;
  }
  return null;
}

function sameToken(offered, configured) {
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (i < a.length ? a[i] : 0) ^ (i < b.length ? b[i] : 0);
  }
  return diff === 0;
}

function startListener({ port = HOLD_PORT, tokenFile } = {}) {
  const resolvedTokenFile = tokenFile || defaultTokenFile();
  const server = http.createServer((req, res) => {
    const [pathname, search = ''] = (req.url || '').split('?');
    if (pathname !== '/api/maintenance/hold') return send(res, 404, { error: 'Not found' });
    if (req.method === 'POST' || req.method === 'DELETE') {
      const configured = configuredToken(resolvedTokenFile);
      const offered = offeredCredential(req);
      if (!configured || !offered || !sameToken(offered, configured)) {
        return send(res, 401, { error: 'unauthorized' });
      }
    }
    if (req.method === 'POST') {
      const query = new URLSearchParams(search);
      const timeoutS = bounded(query.get('timeout_s'), DEFAULT_TIMEOUT_S, 0, MAX_TIMEOUT_S);
      const pauseS = bounded(query.get('pause_s'), DEFAULT_PAUSE_S, 1, MAX_PAUSE_S);
      takeHold(timeoutS, pauseS).then(
        (reply) => send(res, 200, reply),
        (err) => send(res, 500, { error: err.message }),
      );
      return;
    }
    if (req.method === 'DELETE') return send(res, 200, releaseHold());
    return send(res, 405, { error: 'Use POST to hold this app, or DELETE to let it work again.' });
  });
  // Fail closed (owner 2026-11-19): an app that cannot open its hold port must
  // not start an update it cannot be held for, so a port a closing copy still
  // holds is retried and giving up is said out loud (updates:openUpdater refuses).
  let attempts = 0;
  const listen = () => {
    server.listen(port, '127.0.0.1', () => {
      available = true;
      log(`listening on 127.0.0.1:${port}`);
    });
  };
  server.on('error', (err) => {
    if (server.listening) { log(`listener error on 127.0.0.1:${port}: ${err.message}`); return; }
    attempts += 1;
    if (attempts < BIND_ATTEMPTS) { setTimeout(listen, BIND_RETRY_MS).unref?.(); return; }
    available = false;
    log(`no hold on 127.0.0.1:${port} after ${attempts} tries (${err.message}); this app cannot be held, so it will not start an update`);
  });
  listen();
  server.unref?.();
  return server;
}

module.exports = {
  HOLD_PORT,
  isPaused,
  inFlightIds,
  takeHold,
  releaseHold,
  startListener,
  setLog,
  isUpdaterQuit,
  isAvailable,
};
