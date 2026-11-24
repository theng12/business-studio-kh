/**
 * 0.1.125 — background removal left the visible window.
 *
 * The engine's ONNX backend needs 'unsafe-eval', so it runs in the hidden
 * window in main/bgRemovalWindow.js. These checks read the sources rather than
 * starting Electron: what can regress here is which file carries which policy
 * and which path the pixels take, and that is all visible in the text.
 *
 * The live proof (a real removal, and the window going away when idle) is the
 * hidden-instance probe in the release runbook — `node --test` cannot open a
 * BrowserWindow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

test('the visible windows carry no unsafe-eval; only the engine window does', () => {
  const index = stripComments(read('main/index.js'));
  // Both CSP branches (client-mode + standalone) — neither may allow eval.
  assert.doesNotMatch(index, /script-src[^;"]*'unsafe-eval'/, 'the app CSP must not allow unsafe-eval');
  assert.equal((index.match(/'wasm-unsafe-eval'/g) || []).length >= 2, true);
  assert.doesNotMatch(stripComments(read('renderer/index.html')), /script-src[^;"]*'unsafe-eval'/);

  const engine = read('main/bgRemovalWindow.js');
  assert.match(engine, /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:/);
  assert.match(engine, /relaxedCspFor/);
  assert.match(read('renderer/bg-worker.html'), /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:/);
});

test('both modes register the local channel and the header picks the policy by window', () => {
  assert.match(read('main/ipc/app.js'), /exposeLocal\('bgRemoval:remove'/);
  assert.match(read('main/client/index.js'), /handleLocal\('bgRemoval:remove'/);
  assert.match(read('main/server/validators.js'), /'bgRemoval:remove':/);
  const index = read('main/index.js');
  assert.equal((index.match(/relaxedCspFor\(details\.webContentsId\)/g) || []).length, 2,
    'both onHeadersReceived handlers (client + standalone) must ask the engine window');
});

test('the engine window is lazy and destroyed when idle', () => {
  const engine = read('main/bgRemovalWindow.js');
  assert.match(engine, /created on the first removal|created on first use/);
  assert.match(engine, /idleTimer = setTimeout\(teardown, IDLE_MS\)/);
  assert.match(engine, /if \(win && !win\.isDestroyed\(\)\) win\.destroy\(\)/);
  assert.doesNotMatch(engine, /setInterval/, 'nothing may poll in the background');
});

test('the renderer routes every call through the engine window', () => {
  const lib = read('renderer/lib/bgRemoval.js');
  assert.match(lib, /async function runEngine\(/);
  assert.match(lib, /window\.api\.bgRemoval\.remove\(/);
  assert.doesNotMatch(lib, /new Worker\(/, 'the module worker is gone');
  assert.match(read('main/preload.js'), /remove:\s+\(bytes, jobId, type\) => invoke\('bgRemoval:remove'/);
});
