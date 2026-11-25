/**
 * 0.1.127: the shim's hold POST gets one 5 s try, so starting the check before
 * ~15 s of startup DB work made every launch silently skip the update. These
 * pin both halves of the fix: no check until the hold listener is bound (and
 * the main thread is free), and a bounded retry when that POST still refuses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createHoldStartGate, startUpdateCheck } = require('../main/updateCheck');
const root = path.join(__dirname, '..');

function fakeAddon(error) {
  return {
    startCalls: 0,
    start() { this.startCalls += 1; return 0; },
    lastError() { return error; },
    setStateCallback(fn) { this.emit = fn; },
  };
}

function fakeSchedule(delays, queued) {
  return (fn, ms) => {
    delays.push(ms);
    queued.push(fn);
    return { unref() {} };
  };
}

test('boot wires the check to the hold log; there is no early start path', () => {
  const index = fs.readFileSync(path.join(root, 'main/index.js'), 'utf8');
  assert.equal((index.match(/startUpdateCheck\(/g) || []).length, 1);
  assert.ok(index.indexOf('installTray(') < index.indexOf('startUpdateCheck('));
  assert.ok(index.indexOf('createHoldStartGate(') < index.indexOf('setLog('));
  assert.ok(index.indexOf('setLog(') < index.indexOf('startListener('));
  assert.match(index, /createHoldStartGate\(\{ startCheck: startSparkle \}\)/);
  assert.match(index, /onHoldLog\(message\)/);
});

test('the gate starts once, only when the hold listener answers', () => {
  let starts = 0;
  const gate = createHoldStartGate({ startCheck: () => { starts += 1; } });
  assert.equal(gate('checking hold token'), false);
  assert.equal(gate('taking hold'), false);
  assert.equal(starts, 0, 'other hold logs are not a ready endpoint');
  assert.equal(gate('listening on 127.0.0.1:13181'), true);
  assert.equal(gate('listening on 127.0.0.1:13181'), false);
  assert.equal(starts, 1, 'a bound port starts exactly one check');
});

test('a refused hold retries on backoff and stops at the third try', () => {
  const addon = fakeAddon('refused: connection refused');
  const delays = [];
  const queued = [];
  const heard = [];
  const result = startUpdateCheck({
    packaged: true,
    addon,
    schedule: fakeSchedule(delays, queued),
    log: (event, detail) => heard.push(`${event} ${detail}`),
  });
  assert.equal(result, addon);
  assert.equal(addon.startCalls, 1);

  addon.emit(0);
  assert.deepEqual(delays, [1000]);
  queued.shift()();
  addon.emit(0);
  assert.deepEqual(delays, [1000, 3000]);
  queued.shift()();
  addon.emit(0);
  assert.equal(addon.startCalls, 3);
  assert.equal(queued.length, 0, 'no fourth attempt is scheduled');
  assert.match(heard.at(-1), /^kh-sparkle:giveup after 3 tries: refused: connection refused$/);

  addon.emit(0);
  assert.equal(delays.length, 2, 'a late state cannot restart the loop');
  const starts = heard.filter((line) => line.startsWith('kh-sparkle:started'));
  assert.equal(starts.length, 3);
  assert.match(starts[1], /^kh-sparkle:started attempt 2\/3 in 1000ms after refused: connection refused$/);
  assert.match(starts[2], /^kh-sparkle:started attempt 3\/3 in 3000ms after refused: connection refused$/);
});

test('no update is a finished check, not a hold failure to retry', () => {
  const addon = fakeAddon('');
  const queued = [];
  const heard = [];
  startUpdateCheck({
    packaged: true,
    addon,
    schedule: fakeSchedule([], queued),
    log: (event, detail) => heard.push(`${event} ${detail}`),
  });
  addon.emit(0);
  assert.deepEqual(queued, []);
  assert.equal(addon.startCalls, 1);
  assert.equal(heard.some((line) => line.startsWith('kh-sparkle:giveup')), false);
});

test('non-hold updater errors log once and do not retry a no-op start', () => {
  const addon = fakeAddon('updater error [SUSparkleErrorDomain 1001]: network offline');
  const queued = [];
  const heard = [];
  startUpdateCheck({
    packaged: true,
    addon,
    schedule: fakeSchedule([], queued),
    log: (event, detail) => heard.push(`${event} ${detail}`),
  });
  addon.emit(0);
  assert.deepEqual(queued, []);
  assert.equal(addon.startCalls, 1);
  assert.equal(heard.at(-1), 'kh-sparkle:error updater error [SUSparkleErrorDomain 1001]: network offline');
});

test('stale refused error after a retry takes the hold does not schedule an extra attempt', () => {
  const addon = fakeAddon('refused: hold request failed: The request timed out.');
  const delays = [];
  const queued = [];
  const heard = [];
  const gate = createHoldStartGate({
    startCheck: (opts) => startUpdateCheck({
      packaged: true,
      addon,
      schedule: fakeSchedule(delays, queued),
      log: (event, detail) => heard.push(`${event} ${detail}`),
      ...opts,
    }),
  });
  assert.equal(gate('listening on 127.0.0.1:13181'), true);
  addon.emit(0); // attempt 1 refused
  assert.deepEqual(delays, [1000]);
  queued.shift()(); // attempt 2 runs
  gate('settled in under 20 s'); // hold succeeded on attempt 2; shim still retains attempt 1 lastError
  addon.emit(0); // Sparkle reports no update found
  assert.equal(addon.startCalls, 2);
  assert.equal(queued.length, 0, 'no bogus third attempt after hold succeeded');
  assert.equal(heard.some((line) => line.startsWith('kh-sparkle:giveup')), false);
});
