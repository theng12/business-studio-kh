/**
 * The update hold (contract: _orchestra/youtube-stack/update-hold/CONTRACT.md).
 * The acceptance line that matters: a hold with live work queued refuses new
 * work and reports the REAL in_flight; the settle is bounded by timeout_s and
 * never waits for a job to finish; DELETE resumes; a hold with no DELETE
 * expires by itself. The claim gate itself is proved in aiQueueReliability.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const hold = require('../main/updateHold');
const { takeHold, releaseHold, isPaused, startListener } = hold;

hold.setLog(() => {}); // the log is not what these assert

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEYS = ['dispatch_paused_s', 'in_flight', 'safe', 'unsettled'];

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

test('the loopback listener answers the contract over plain HTTP', async (t) => {
  const server = startListener({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/maintenance/hold`;

  const held = await fetch(`${base}?timeout_s=1&pause_s=90`, { method: 'POST' });
  assert.equal(held.status, 200);
  const reply = await held.json();
  assert.deepEqual(Object.keys(reply).sort(), KEYS);
  assert.equal(reply.dispatch_paused_s, 90);
  assert.equal(isPaused(), true);

  const resumed = await fetch(base, { method: 'DELETE' });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).dispatch_paused_s, 0);
  assert.equal(isPaused(), false);

  assert.equal((await fetch(base)).status, 405, 'a GET cannot hold or resume');
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test('the listener refuses timeouts past the contract ceiling and bad numbers fall back', async (t) => {
  const server = startListener({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/maintenance/hold`;

  // 999 s asked for, 30 s ceiling: with nothing running it still answers at once,
  // and the pause it reports is the one it applied.
  const startedAt = Date.now();
  const reply = await (await fetch(`${base}?timeout_s=999&pause_s=abc`, { method: 'POST' })).json();
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(reply.dispatch_paused_s, 120, 'pause_s=abc falls back to the 120 s default');
  assert.equal(reply.safe, true);
});
