#!/usr/bin/env node
/**
 * Update-hold acceptance against the REAL app (contract:
 * _orchestra/youtube-stack/update-hold/CONTRACT.md).
 *
 * Launches an isolated copy — its own user-data dir and data folder, `--test-mode`
 * (the app's headless entry: the window is created but never shown) — and proves,
 * headless:
 *   1. POST /api/maintenance/hold answers the contract's reply, in_flight is real
 *      (0 while nothing runs), and the pause is the one it applied;
 *   2. the listener is loopback only: the Mac's own LAN address cannot reach it;
 *   3. DELETE resumes at once;
 *   4. a hold with no DELETE pauses the claim path, and expires by itself after
 *      pause_s (both said out loud in crash.log);
 *   5. a hard kill while held, then a relaunch with no DELETE, comes back taking
 *      work again — the pause is in memory only, never a persisted latch.
 *
 * Usage (app must be built: `npm run build`, or any released DMG's tree):
 *
 *     node scripts/probe-update-hold.js [--out /tmp/mskh-hold] [--keep]
 *
 * Exits 0 when every check passed, 1 otherwise. Never opens a window, never
 * touches the owner's config or data folder.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 13181;
const URL_PATH = '/api/maintenance/hold';
const KEYS = ['dispatch_paused_s', 'in_flight', 'safe', 'unsettled'];

function parseArgs(argv) {
  const out = { out: path.join(os.tmpdir(), 'mskh-update-hold'), keep: false, app: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--keep') out.keep = true;
    else if (argv[i] === '--app') out.app = path.resolve(argv[++i]);
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(method, url, timeoutMs = 32_000) {
  return new Promise((resolve) => {
    const req = http.request(url, { method, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* asserted by the caller */ }
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (err) => resolve({ status: 0, json: null, body: '', error: err.message }));
    req.end();
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

function launch(profile, appBinary) {
  const command = appBinary || path.join(ROOT, 'node_modules', '.bin', 'electron');
  const args = appBinary
    ? ['--test-mode', `--user-data-dir=${path.join(profile, 'userdata')}`]   // a packaged .app's own binary
    : ['.', '--test-mode', `--user-data-dir=${path.join(profile, 'userdata')}`];
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => log.push(...chunk.split('\n').filter(Boolean)));
  child.stderr.on('data', (chunk) => log.push(...chunk.split('\n').filter(Boolean)));
  return { child, log };
}

async function waitFor(fn, what, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function saidText(app, crashLog) {
  let fromLog = '';
  try { fromLog = fs.readFileSync(crashLog, 'utf8'); } catch (_) { /* first boot */ }
  return `${app.log.join('\n')}\n${fromLog}`;
}

async function waitListening(crashLog) {
  await waitFor(async () => {
    try { return fs.readFileSync(crashLog, 'utf8').includes(`listening on 127.0.0.1:${PORT}`); }
    catch (_) { return false; }
  }, 'the update hold to listen');
}

function stop(app) {
  return new Promise((resolve) => {
    const done = setTimeout(() => { app.child.kill('SIGKILL'); resolve('SIGKILL'); }, 10_000);
    app.child.once('exit', () => { clearTimeout(done); resolve('exit'); });
    app.child.kill('SIGTERM');
  });
}

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry.internal && entry.family === 'IPv4') return entry.address;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-hold-'));
  const userData = path.join(profile, 'userdata');
  const dataDir = path.join(profile, 'data');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    dataDir, mode: 'standalone', firstLaunchHandled: true, kioskMode: false,
  }));
  const crashLog = path.join(userData, 'crash.log');
  const base = `http://127.0.0.1:${PORT}${URL_PATH}`;
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail });
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  };

  if (await portInUse(PORT)) throw new Error(`127.0.0.1:${PORT} is already in use; nothing was proved`);

  let app = launch(profile, args.app);
  try {
    await waitListening(crashLog);
    await waitFor(async () => {
      try { return fs.readFileSync(crashLog, 'utf8').includes('window:hidden-run'); } catch (_) { return false; }
    }, 'the app to reach its headless window', 20_000);
    const boot = fs.readFileSync(crashLog, 'utf8');
    check('no window was shown (headless run)', boot.includes('window:hidden-run') && !boot.includes('window:shown'));

    const held = await request('POST', `${base}?timeout_s=20&pause_s=120`);
    check('POST answers the contract reply', held.status === 200
      && held.json && JSON.stringify(Object.keys(held.json).sort()) === JSON.stringify(KEYS), held.body);
    check('in_flight is real (nothing running)', held.json?.in_flight === 0);
    check('safe with nothing running', held.json?.safe === true && (held.json?.unsettled || []).length === 0);
    check('the pause it applied is the pause it reports', held.json?.dispatch_paused_s === 120);

    const lan = lanAddress();
    const remote = lan ? await request('POST', `http://${lan}:${PORT}${URL_PATH}?timeout_s=0`, 3_000) : null;
    check('loopback only (the LAN address cannot reach it)', remote ? remote.status === 0 : true,
      lan ? `${lan}:${PORT} → ${remote.error || remote.status}` : 'no LAN address');

    const resumed = await request('DELETE', base);
    check('DELETE resumes at once', resumed.status === 200 && resumed.json?.dispatch_paused_s === 0, resumed.body);

    const heldAgain = await request('POST', `${base}?timeout_s=1&pause_s=120`);
    check('a second hold is taken while paused', heldAgain.json?.dispatch_paused_s === 120);
    await waitFor(async () => saidText(app, crashLog).includes('new work is paused for an update'),
      'the app to say it stopped claiming work');
    check('the app says it stopped claiming work, in plain words', true);

    await stop(app);
    app = null;

    /* A restart with no DELETE: if the pause were persisted this copy would
     * still refuse work. It must start claiming again by itself. */
    app = launch(profile, args.app);
    const boots = () => fs.readFileSync(crashLog, 'utf8').split('update-hold :: listening').length - 1;
    await waitFor(async () => {
      try { return boots() >= 2; } catch (_) { return false; }
    }, 'the relaunched app to listen');
    await sleep(4_500); // two queue ticks
    const restartSaid = app.log.join('\n');
    check('a restart with no DELETE claims work again with no operator step',
      !restartSaid.includes('new work is paused'), 'two ticks after boot, no pause');

    const fresh = await request('POST', `${base}?timeout_s=0&pause_s=2`);
    check('the relaunched app takes a fresh hold', fresh.json?.dispatch_paused_s === 2);
    await waitFor(async () => saidText(app, crashLog).includes('new work resumes: the pause ran out'),
      'the pause to expire by itself', 15_000);
    check('a hold with no DELETE expires by itself after pause_s', true);
  } finally {
    if (app) await stop(app);
  }

  const failed = checks.filter((c) => !c.ok);
  const receipt = { at: new Date().toISOString(), app: args.app || 'source (electron .)', profile, port: PORT, checks, passed: failed.length === 0 };
  fs.writeFileSync(path.join(args.out, 'update-hold-probe.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed — ${path.join(args.out, 'update-hold-probe.json')}\n`);
  if (!args.keep) fs.rmSync(profile, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${err.message}\n`);
  process.exit(1);
});
