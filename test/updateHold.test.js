/**
 * The update hold (contract: _orchestra/youtube-stack/update-hold/CONTRACT.md).
 * The acceptance line that matters: a hold with live work queued refuses new
 * work and reports the REAL in_flight; the settle is bounded by timeout_s and
 * never waits for a job to finish; DELETE resumes; a hold with no DELETE
 * expires by itself. The claim gate itself is proved in aiQueueReliability.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const net = require('node:net');

const journalPath = require.resolve('../main/exportJournal');
require.cache[journalPath] = { id: journalPath, filename: journalPath, loaded: true, exports: { instance: () => ({ inFlightIds: () => [] }) } };
const hold = require('../main/updateHold');
const { takeHold, releaseHold, isPaused, startListener, isUpdaterQuit, isAvailable } = hold;

hold.setLog(() => {}); // the log is not what these assert

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEYS = ['dispatch_paused_s', 'in_flight', 'safe', 'unsettled'];

function makeTempToken(t, value = 'secret-hold-token-0123456789abcdef') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-hold-tok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hold-token');
  if (value !== null) fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return file;
}

test.afterEach(() => releaseHold());

test('a hold with nothing running is safe at once and pauses new work', async () => {
  assert.equal(isPaused(), false);
  const reply = await takeHold(20, 120, () => []);
  assert.deepEqual(Object.keys(reply).sort(), KEYS);
  assert.equal(reply.safe, true);
  assert.deepEqual(reply.unsettled, []);
  assert.equal(reply.dispatch_paused_s, 120);
  assert.equal(reply.in_flight, 0);
  assert.equal(isPaused(), true);
});

test('the settle is bounded by timeout_s and never waits for the work to finish', async () => {
  let running = ['ai-task:t1', 'ai-task:t2'];
  const startedAt = Date.now();
  const reply = await takeHold(0, 60, () => running);
  assert.ok(Date.now() - startedAt < 1000, 'a zero settle window answers immediately');
  assert.equal(reply.safe, false);
  assert.deepEqual(reply.unsettled, ['ai-task:t1', 'ai-task:t2']);
  assert.equal(reply.in_flight, 2, 'in_flight is what is really running');
  assert.equal(isUpdaterQuit(), false, 'an unsafe hold cannot authorize a kiosk quit');
  running = [];
});

test('work that settles inside the window makes the hold safe', async () => {
  let running = ['export-run'];
  setTimeout(() => { running = []; }, 300);
  const reply = await takeHold(5, 60, () => running);
  assert.equal(reply.safe, true);
  assert.deepEqual(reply.unsettled, []);
  assert.equal(reply.in_flight, 0);
});

test('releasing a settling hold cannot authorize a later quit', async () => {
  let running = ['export-run'];
  const pending = takeHold(2, 60, () => running);
  assert.equal(isUpdaterQuit(), false, 'settling has not yet proven safety');
  releaseHold();
  running = [];
  const reply = await pending;
  assert.equal(reply.safe, false);
  assert.equal(isUpdaterQuit(), false);
});

test('a failed work lookup fails closed', async () => {
  const reply = await takeHold(0, 60, () => { throw new Error('unavailable'); });
  assert.equal(reply.safe, false);
  assert.equal(isUpdaterQuit(), false);
});

test('DELETE resumes at once and reports no pause left', async () => {
  await takeHold(0, 300, () => []);
  assert.equal(isPaused(), true);
  const reply = releaseHold();
  assert.deepEqual(Object.keys(reply).sort(), KEYS);
  assert.equal(reply.dispatch_paused_s, 0);
  assert.equal(isPaused(), false);
});

test('a hold with no DELETE expires by itself after pause_s', async () => {
  await takeHold(0, 1, () => []);
  assert.equal(isPaused(), true);
  await sleep(1200);
  assert.equal(isPaused(), false, 'an aborted install never leaves the app refusing work');
});

test('the loopback listener answers the contract over plain HTTP and enforces hold-token', async (t) => {
  const token = 'test-token-alpha-0123456789';
  const tokenFile = makeTempToken(t, token);
  const server = startListener({ port: 0, tokenFile });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/maintenance/hold`;

  const noToken = await fetch(`${base}?timeout_s=1&pause_s=90`, { method: 'POST' });
  assert.equal(noToken.status, 401, 'POST without token is refused');
  assert.equal(isPaused(), false, 'refused POST pauses nothing');

  const wrongToken = await fetch(`${base}?timeout_s=1&pause_s=90`, {
    method: 'POST',
    headers: { 'X-Hub-Token': 'wrong-token' },
  });
  assert.equal(wrongToken.status, 401, 'POST with wrong token is refused');
  assert.equal(isPaused(), false, 'wrong token pauses nothing');

  const held = await fetch(`${base}?timeout_s=1&pause_s=90`, {
    method: 'POST',
    headers: { 'X-Hub-Token': token },
  });
  assert.equal(held.status, 200);
  const reply = await held.json();
  assert.deepEqual(Object.keys(reply).sort(), KEYS);
  assert.equal(reply.dispatch_paused_s, 90);
  assert.equal(isPaused(), true);

  const openDelete = await fetch(base, { method: 'DELETE' });
  assert.equal(openDelete.status, 401, 'DELETE without token is refused');
  assert.equal(isPaused(), true, 'refused DELETE does not release standing hold');

  const wrongDelete = await fetch(base, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert.equal(wrongDelete.status, 401, 'DELETE with wrong bearer token is refused');
  assert.equal(isPaused(), true);

  const resumed = await fetch(base, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).dispatch_paused_s, 0);
  assert.equal(isPaused(), false);

  assert.equal((await fetch(base)).status, 405, 'a GET cannot hold or resume');
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test('the listener reads hold-token per request and fails closed when missing or rotated', async (t) => {
  const token1 = 'rotated-token-1';
  const token2 = 'rotated-token-2';
  const tokenFile = makeTempToken(t, null); // file does not exist yet
  const server = startListener({ port: 0, tokenFile });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/maintenance/hold`;

  const missingFile = await fetch(`${base}?timeout_s=0&pause_s=60`, {
    method: 'POST',
    headers: { 'X-Hub-Token': token1 },
  });
  assert.equal(missingFile.status, 401, 'missing token file refuses the hold');
  assert.equal(isPaused(), false);

  fs.writeFileSync(tokenFile, '   \n', { mode: 0o600 });
  const emptyFile = await fetch(`${base}?timeout_s=0&pause_s=60`, {
    method: 'POST',
    headers: { 'X-Hub-Token': token1 },
  });
  assert.equal(emptyFile.status, 401, 'whitespace-only token file refuses the hold');
  assert.equal(isPaused(), false);

  fs.writeFileSync(tokenFile, `${token1}\n`, { mode: 0o600 });
  const firstOk = await fetch(`${base}?timeout_s=0&pause_s=60`, {
    method: 'POST',
    headers: { 'X-Hub-Token': token1 },
  });
  assert.equal(firstOk.status, 200);

  // Rotate on disk without restarting listener: old token is rejected, new token works.
  fs.writeFileSync(tokenFile, `${token2}\n`, { mode: 0o600 });
  const staleToken = await fetch(base, {
    method: 'DELETE',
    headers: { 'X-Hub-Token': token1 },
  });
  assert.equal(staleToken.status, 401, 'old token is rejected after file rotation');
  assert.equal(isPaused(), true);

  const rotatedOk = await fetch(base, {
    method: 'DELETE',
    headers: { 'X-Hub-Token': token2 },
  });
  assert.equal(rotatedOk.status, 200);
  assert.equal(isPaused(), false);
});

test('the listener refuses timeouts past the contract ceiling and bad numbers fall back', async (t) => {
  const token = 'ceiling-test-token';
  const tokenFile = makeTempToken(t, token);
  const server = startListener({ port: 0, tokenFile });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/maintenance/hold`;

  // 999 s asked for, 30 s ceiling: with nothing running it still answers at once,
  // and the pause it reports is the one it applied.
  const startedAt = Date.now();
  const reply = await (await fetch(`${base}?timeout_s=999&pause_s=abc`, {
    method: 'POST',
    headers: { 'X-Hub-Token': token },
  })).json();
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(reply.dispatch_paused_s, 120, 'pause_s=abc falls back to the 120 s default');
  assert.equal(reply.safe, true);
});

/* ── the installer's quit, and failing closed (0.1.115) ────────────── */

test('only a quit that follows a hold is the installer\'s; a released or expired hold is a person\'s', async () => {
  assert.equal(isUpdaterQuit(), false, 'no hold, so a quit is a person\'s');
  await takeHold(0, 900, () => []);
  assert.equal(isUpdaterQuit(), true, 'the Launcher quits straight after its hold');
  releaseHold();
  assert.equal(isUpdaterQuit(), false, 'a released hold is not the installer\'s');

  await takeHold(0, 1, () => []);
  assert.equal(isUpdaterQuit(), true);
  await sleep(1200);
  assert.equal(isUpdaterQuit(), false, 'the marker expires with the pause, so it is never a latch');
});

test('the installer-quit window never outlives the pause it belongs to', () => {
  const src = fs.readFileSync(require.resolve('../main/updateHold.js'), 'utf8');
  assert.match(src, /UPDATER_QUIT_WINDOW_MS = 60 \* 1000/, 'a stale hold must not open the kiosk for long');
  assert.match(src, /Math\.min\(pausedUntil - Date\.now\(\), UPDATER_QUIT_WINDOW_MS\)/);
});

test('a hold port it cannot open fails closed: unholdable and said out loud', async (t) => {
  const tokenFile = makeTempToken(t, 'busy-port-token');
  const opened = startListener({ port: 0, tokenFile });
  await new Promise((resolve) => opened.once('listening', resolve));
  assert.equal(isAvailable(), true, 'a hold that opened is usable');
  await new Promise((resolve) => opened.close(resolve));

  const taken = net.createServer();
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => taken.close(resolve)));

  const logs = [];
  hold.setLog((m) => logs.push(m));
  t.after(() => hold.setLog(() => {}));
  const blocked = startListener({ port: taken.address().port, tokenFile });
  await sleep(2000); // three bind attempts, 500 ms apart

  assert.equal(blocked.listening, false);
  assert.equal(isAvailable(), false, 'the app knows it cannot be held, so no update may start');
  assert.ok(logs.some((l) => /cannot be held, so it will not start an update/.test(l)), 'and says so');
});
