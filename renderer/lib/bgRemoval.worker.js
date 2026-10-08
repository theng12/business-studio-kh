/**
 * 0.1.94: background removal off the main thread.
 *
 * @imgly/background-removal (ONNX in WebAssembly) used to run on the
 * renderer's main thread and froze the whole window for ~7.9 s per photo
 * (measured). This module Worker runs the same engine with the same options;
 * renderer/lib/bgRemoval.js keeps its API and talks to it with messages:
 *
 *   in:  { id, blob }                         the source image
 *   out: { id, type: 'progress', key, ratio } while the model loads / runs
 *        { id, type: 'done', blob }           the PNG cutout
 *        { id, type: 'error', message }       the engine's own error message
 *
 * No cross-origin isolation is needed: without SharedArrayBuffer ONNX runs
 * single-threaded, which is fine here — the point is that the UI stays free.
 */
let enginePromise = null;

function loadEngine() {
  if (!enginePromise) {
    enginePromise = import('@imgly/background-removal').then((m) => {
      const engine = m.removeBackground ?? m.default;
      if (typeof engine !== 'function') {
        throw new Error('Failed to load @imgly/background-removal — engine export not found');
      }
      return engine;
    });
    enginePromise.catch(() => { enginePromise = null; });
  }
  return enginePromise;
}

self.onmessage = async (event) => {
  const { id, blob } = event.data || {};
  try {
    const engine = await loadEngine();
    const out = await engine(blob, {
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        self.postMessage({ id, type: 'progress', key, ratio: total > 0 ? current / total : 0 });
      },
    });
    self.postMessage({ id, type: 'done', blob: out });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
};
