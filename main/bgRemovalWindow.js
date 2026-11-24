/**
 * 0.1.125: the background-removal engine's own hidden window.
 *
 * @imgly/background-removal's ONNX backend generates code at runtime
 * (`new Function`), which only `'unsafe-eval'` permits. Rather than keep that
 * in every window the user can see, the engine runs here — one hidden window
 * whose own policy is `main/bgRemovalWindow.js`'s RELAXED_CSP — and the visible
 * windows stay at `'wasm-unsafe-eval'` (main/index.js, renderer/index.html).
 *
 * Lazy by design (owner 2026-11-19, "apps stay small in the background"): the
 * window is created on the first removal, and destroyed once IDLE_MS passes
 * with no job. Nothing runs when the feature is not in use.
 *
 * Flow: renderer → `bgRemoval:remove` → this module → the page in
 * renderer/bg-worker.html (renderer/bg-worker.js) → PNG bytes back.
 * Progress goes to the main window as `bgRemoval:progress`.
 */
const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

// Short in the test hook so the hidden-instance probe can watch it go away.
const IDLE_MS = Number(process.env.MSKH_BG_WORKER_IDLE_MS) || 60_000;
// A job's own ceiling. The first run downloads the ~80 MB model, so this is
// generous; past it the engine state is unknown, so the window is destroyed.
const JOB_TIMEOUT_MS = 10 * 60_000;

const RELAXED_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://staticimgly.com data: blob:",
].join('; ');

let getMainWindow = () => null;
let win = null;
let loading = null;
let idleTimer = null;
let seq = 0;
const jobs = new Map(); // job seq -> { jobId, timer, resolve, reject }

function init({ getMainWindow: getter }) {
  getMainWindow = typeof getter === 'function' ? getter : () => null;
  ipcMain.on('bg:from-worker', (event, msg) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const job = jobs.get(msg?.id);
    if (!job) return;
    if (msg.type === 'progress') {
      const target = getMainWindow();
      if (target && !target.isDestroyed()) {
        target.webContents.send('bgRemoval:progress', { jobId: job.jobId, key: msg.key, ratio: msg.ratio });
      }
      return;
    }
    jobs.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.type === 'done') job.resolve(msg.bytes);
    else job.reject(new Error(msg.message || 'Background removal failed'));
    if (jobs.size === 0) scheduleIdle();
  });
}

/** The worker window's relaxed policy, or null for every other document. */
function relaxedCspFor(webContentsId) {
  if (!win || win.isDestroyed() || win.webContents.id !== webContentsId) return null;
  return RELAXED_CSP;
}

function pageUrl() {
  const dev = process.env.VITE_DEV_SERVER_URL;
  return dev ? `${dev.replace(/\/$/, '')}/bg-worker.html` : 'app://local/bg-worker.html';
}

function ensureWindow() {
  if (loading) return loading;
  win = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    title: 'Background removal',
    webPreferences: {
      preload: path.join(__dirname, 'bgWorkerPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as the main window (main/index.js): the preload is CommonJS.
      sandbox: false,
      // A hidden window is throttled by default; inference would crawl.
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', (_e, details) => {
    failAll(new Error(`The background-removal engine stopped (${details.reason})`));
    teardown();
  });
  win.on('closed', () => { win = null; loading = null; });
  loading = win.loadURL(pageUrl()).catch((err) => {
    const failure = new Error(`The background-removal engine could not start: ${err.message}`);
    failAll(failure);
    teardown();
    throw failure;
  });
  // Callers await their own job; this only surfaces a load failure once.
  loading.catch(() => {});
  return loading;
}

function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdle() {
  clearIdle();
  idleTimer = setTimeout(teardown, IDLE_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

function failAll(err) {
  for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(err); }
  jobs.clear();
}

function teardown() {
  clearIdle();
  failAll(new Error('The background-removal engine was closed before the job finished'));
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  loading = null;
}

/**
 * Run one removal. `args` is what the renderer sent: `{ jobId, bytes, type }`.
 * Resolves to the PNG bytes as an ArrayBuffer.
 */
async function remove(args = {}) {
  const { jobId = '', bytes } = args;
  if (!bytes) throw new Error('Background removal needs image bytes');
  clearIdle();
  await ensureWindow();

  const raw = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const id = ++seq;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error('Background removal took longer than 10 minutes and was stopped'));
      if (jobs.size === 0) teardown();
    }, JOB_TIMEOUT_MS);
    jobs.set(id, { jobId, timer, resolve, reject });
    try {
      win.webContents.send('bg:job', { id, bytes: raw, type: args.type || 'image/png' });
    } catch (err) {
      jobs.delete(id);
      clearTimeout(timer);
      reject(new Error(`The background-removal engine could not start: ${err.message}`));
    }
  });
}

module.exports = { init, remove, relaxedCspFor, teardown, RELAXED_CSP, IDLE_MS, JOB_TIMEOUT_MS };
