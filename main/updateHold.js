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

const http = require('node:http');

const DEFAULT_TIMEOUT_S = 20;
const MAX_TIMEOUT_S = 30;              // the contract's ceiling, not a job's own bound
const DEFAULT_PAUSE_S = 120;
const MAX_PAUSE_S = 900;
const SETTLE_POLL_MS = 200;

/* 13181: this app's own LAN server is 13180, so the hold sits beside it on the
 * same machine. Loopback only, plain HTTP — the signed feed names the full URL
 * for the installer, and a remote caller has no business holding this app. */
const HOLD_PORT = 13181;

let pausedUntil = 0;
let pauseTimer = null;
let log = (message) => process.stderr.write(`[update-hold] ${message}\n`);

function setLog(fn) { log = fn; }

function isPaused() { return Date.now() < pausedUntil; }

/**
 * Work a restart would strand, named by the id the next start follows. AI
 * generations carry their `ai_tasks` row; an export or a print render is one
 * long job with no row to re-dispatch, so the installer is told to wait for it
 * rather than quit inside it. Lookups never hold an installer hostage.
 *
 * shortcut: the hold closes the queue's claim path; it does not refuse a
 * person's own export or render, only report it in flight — upgrade when an
 * update must freeze every user action, not just queued work.
 */
function inFlightIds() {
  const ids = [];
  try {
    for (const id of require('./ai/queueRunner').inflightIds()) ids.push(`ai-task:${id}`);
  } catch (_) { /* runner not up yet */ }
  try {
    if (require('./ipc/exports').hasActiveRun()) ids.push('export-run');
  } catch (_) { /* no export runner in this mode */ }
  try {
    if (require('./renderWindow').isRendering()) ids.push('render-job');
  } catch (_) { /* no render window in this mode */ }
  return ids;
}

function pause(pauseS) {
  pausedUntil = Date.now() + pauseS * 1000;
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => {
    pauseTimer = null;
    pausedUntil = 0;
    resumed('the pause ran out');
  }, pauseS * 1000);
  pauseTimer.unref?.();
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
  pause(pauseS);
  const ids = () => { try { return inFlight() || []; } catch (_) { return []; } };
  const first = ids();
  log(`held: ${first.length ? first.join(', ') : 'nothing'} in flight, new work paused ${pauseS} s, settling for up to ${timeoutS} s`);

  const deadline = Date.now() + timeoutS * 1000;
  let remaining = first;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    remaining = ids();
  }
  if (remaining.length > 0) {
    log(`${remaining.join(', ')} still running at the ${timeoutS} s bound; the next start follows it, so this update waits`);
  } else {
    log(`settled in under ${timeoutS} s`);
  }
  return {
    safe: remaining.length === 0,
    unsettled: remaining,
    dispatch_paused_s: pauseS,
    in_flight: remaining.length,
  };
}

/** Resume at once. Never required — the pause expires by itself. */
function releaseHold() {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
  const wasPaused = isPaused();
  pausedUntil = 0;
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
 * keep. A port already in use is logged and the app carries on — the installer
 * then refuses to install over the running copy instead of quitting it mid-job.
 */
function startListener({ port = HOLD_PORT } = {}) {
  const server = http.createServer((req, res) => {
    const [pathname, search = ''] = (req.url || '').split('?');
    if (pathname !== '/api/maintenance/hold') return send(res, 404, { error: 'Not found' });
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
  server.on('error', (err) => log(`listener failed on 127.0.0.1:${port}: ${err.message}`));
  server.listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}`));
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
};
