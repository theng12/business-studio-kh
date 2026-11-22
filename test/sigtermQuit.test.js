const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the withdrawn SIGTERM force-exit is absent', () => {
  const src = fs.readFileSync(path.join(__dirname, '../main/index.js'), 'utf8');
  assert.doesNotMatch(src, /sigterm:force-exit/);
  assert.match(src, /process\.on\('SIGTERM'[\s\S]*?app\.quit\(\)/);
});

function quitHandler({ active = [], paused = false } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '../main/index.js'), 'utf8');
  const start = src.indexOf('let serverShutdownInProgress = false;');
  const end = src.indexOf("process.on('SIGTERM'", start);
  assert.ok(start >= 0 && end > start);
  const state = { handler: null, stops: 0, quits: 0, work: active, paused, events: [], timers: [] };
  const hold = { inFlightIds: () => state.work, isPaused: () => state.paused, isUpdaterQuit: () => false };
  vm.runInNewContext(src.slice(start, end), {
    app: { on: (_, fn) => { state.handler = fn; }, quit() { state.quits += 1; } },
    require: (id) => id === './updateHold' ? hold
      : id === './kioskWindow' ? { revokeQuit() {} }
        : { getStatus: () => ({ running: true }), stopServer: () => { state.stops += 1; } },
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => state.events.push(args) } },
    logEvent() {}, eventLog: { flush() {} }, destroyTray() {},
    setTimeout: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; },
  });
  return state;
}

test('a refused kiosk quit or active job never stops the server', () => {
  const state = quitHandler({ active: ['export-run'] });
  state.handler({ defaultPrevented: true, preventDefault() { assert.fail('already refused'); } });
  assert.equal(state.stops, 0);
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  state.handler(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.stops, 0);
});

test('ordinary quit explains the refusal and leaves the work running', () => {
  const state = quitHandler({ active: ['ai-task:1'] });
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  state.handler(event);
  assert.equal(event.defaultPrevented, true);
  assert.match(state.events[0][1].error, /ai-task:1.*Try again/);
  assert.equal(state.events[0][1].complete, true);
  assert.equal(state.timers.length, 0);
  assert.equal(state.quits, 0);
  assert.equal(state.stops, 0);
});

test('an update hold never turns an ordinary quit into the installer quit', () => {
  const state = quitHandler({ active: ['ai-task:1'], paused: true });
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  state.handler(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.timers.length, 0);
  assert.equal(state.quits, 0);
});
