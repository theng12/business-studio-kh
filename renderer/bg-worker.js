/**
 * 0.1.125: the background-removal engine runs in this hidden window only.
 *
 * @imgly/background-removal's ONNX backend needs 'unsafe-eval', so it cannot
 * live in a window the user looks at (renderer/lib/bgRemoval.js talks to this
 * page over IPC instead — see main/bgRemovalWindow.js). The model stays loaded
 * here for the life of the window; the window is destroyed when the feature
 * goes idle, so nothing is held in the background.
 *
 *   in:  { id, bytes, type }                        source image
 *   out: { id, type: 'progress', key, ratio }
 *        { id, type: 'done', bytes }                PNG cutout
 *        { id, type: 'error', message }
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

window.bgWorker.onJob(async ({ id, bytes, type }) => {
  try {
    const engine = await loadEngine();
    const out = await engine(new Blob([bytes], { type: type || 'image/png' }), {
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        window.bgWorker.send({ id, type: 'progress', key, ratio: total > 0 ? current / total : 0 });
      },
    });
    window.bgWorker.send({ id, type: 'done', bytes: await out.arrayBuffer() });
  } catch (err) {
    window.bgWorker.send({ id, type: 'error', message: err?.message ?? String(err) });
  }
});
