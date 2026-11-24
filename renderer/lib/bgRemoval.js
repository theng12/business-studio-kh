// Thin wrapper around the local background-removal engine. The rest of the
// renderer doesn't import the heavy WASM module directly — we lazy-load on
// first use so the initial app boot doesn't pay for the model download.
//
// v0.49.33: collapsed to a single engine — `@imgly/background-removal` (WASM,
// offline after first download). The paid remove.bg cloud path was removed
// entirely: it added a second failure surface (HTTPS to a third-party + API
// key + monthly quota counter) that beta testers kept tripping over, and the
// local engine has been good enough on M-series Macs for the catalog work
// this app is built for. If we ever need an "always-works fallback" again,
// it would be smaller to re-introduce one provider rather than continue
// maintaining the two-engine switch infrastructure.
//
// Why download fragility used to bite specifically in client mode: the
// renderer's CSP `connect-src` whitelist needs to include
// `https://staticimgly.com` for the @imgly model to fetch. Standalone mode
// had that; client mode's override in main/index.js did NOT — see the
// v0.49.33 fix there. Symptom on the client was a "no available backend"
// error that looked like a model-loader bug but was a CSP block.

const cutoutCache = new Map(); // filepath -> { blob, bytes }
const inFlight = new Map();    // same key -> Promise

/* ─── 0.1.125: the engine runs in its own hidden window ──────────────────
 *
 * 0.1.94 moved it off this thread into a module Worker, but a Worker inherits
 * this document's CSP — so the visible window had to allow 'unsafe-eval' for
 * the engine's ONNX backend. It now runs in main/bgRemovalWindow.js's hidden
 * window, whose own policy relaxes that, and this renderer only passes pixels
 * over IPC. The window is created on first use and destroyed when idle. */

/** The engine call, in the hidden window. Resolves to the PNG Blob. */
async function runEngine(blob, onProgress) {
  const jobId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `bg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const off = onProgress
    ? window.api.bgRemoval.onProgress((p) => { if (p.jobId === jobId) onProgress(p.key, p.ratio); })
    : null;
  try {
    const bytes = await window.api.bgRemoval.remove(await blob.arrayBuffer(), jobId, blob.type);
    return new Blob([bytes], { type: 'image/png' });
  } finally {
    off?.();
  }
}

/**
 * Generate a small but valid PNG via canvas. Used by prefetchLocalModel
 * to warm the @imgly engine cache without needing a user-supplied image.
 *
 * Pre-v0.22.12 we hand-rolled a 64-byte 1×1 PNG, but @imgly v1.5.x
 * tightened its input validation and started rejecting it with
 * "The source image could not be decoded." 64×64 is a comfortable
 * size — well above any internal min-size threshold, small enough
 * that the inference itself stays sub-second.
 *
 * Canvas-generated PNGs are guaranteed valid by the browser, so this
 * sidesteps every "is my hand-crafted PNG actually correct?" question
 * the next time @imgly tightens validation again.
 */
async function makeWarmupBlob() {
  const SIZE = 64;
  // OffscreenCanvas is broadly supported in Electron renderers; fall back
  // to a hidden DOM canvas if it isn't there for some reason.
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(SIZE, SIZE);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // A small dark dot in the center gives the model something
    // foreground-shaped to chew on — not strictly required, but makes
    // the warm-up exercise the actual segmentation path (not just the
    // "image is uniform → bail out fast" path).
    ctx.fillStyle = '#202020';
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 4, 0, Math.PI * 2);
    ctx.fill();
    return c.convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#202020';
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 4, 0, Math.PI * 2);
    ctx.fill();
    c.toBlob((b) => resolve(b), 'image/png');
  });
}

/**
 * Trigger the @imgly engine load + a small no-op inference so the WASM
 * runtime and model weights are cached. Used by the "Download model now"
 * button in Settings so the user isn't stuck waiting the first time they
 * open the Workspace.
 *
 * v0.22.12: switched the warm-up image from a hand-crafted 64-byte
 * 1×1 PNG to a canvas-generated 64×64 PNG because @imgly v1.5.x
 * rejected the tiny one with "The source image could not be decoded".
 * The model + WASM still cache the same way; only the input changed.
 */
export async function prefetchLocalModel(onProgress) {
  let blob;
  try {
    blob = await makeWarmupBlob();
  } catch (err) {
    throw new Error(`Failed to build warm-up image: ${err.message}`, { cause: err });
  }
  if (!blob) throw new Error('Failed to build warm-up image (canvas returned null)');
  try {
    // 0.1.125: warmed where it will run — in the engine window (see runEngine).
    await runEngine(blob, onProgress);
  } catch (err) {
    // Reuse the same friendly translator the workspace uses so users get
    // the actionable "check internet" / "CSP" hints instead of the raw
    // ONNX-backend jargon.
    throw new Error(friendlyLocalEngineError(err), { cause: err });
  }
}

export async function fetchImageBlob(filepath, version) {
  const stamp = version ? `?v=${encodeURIComponent(version)}` : '';
  const url = `app-image://local/${encodeURIComponent(filepath)}${stamp}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load image (${res.status})`);
  return res.blob();
}

async function sha1Blob(blob) {
  const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifySource(inputBlob, { expectedSourceHash, validateSource } = {}) {
  const sourceHash = await sha1Blob(inputBlob);
  if (expectedSourceHash && sourceHash !== expectedSourceHash) {
    throw new Error('Image changed; reload and try again');
  }
  await validateSource?.(sourceHash);
  return sourceHash;
}

async function removeViaLocal(filepath, onProgress, version, sourceIdentity) {
  const inputBlob = await fetchImageBlob(filepath, version);
  const sourceHash = await verifySource(inputBlob, sourceIdentity);
  try {
    const outBlob = await runEngine(inputBlob, onProgress);
    const bytes = await outBlob.arrayBuffer();
    return { blob: outBlob, bytes, sourceHash };
  } catch (err) {
    throw new Error(friendlyLocalEngineError(err), { cause: err });
  }
}

/**
 * Translate the @imgly / ONNX-runtime error messages into something that
 * tells the user what to actually do. The raw messages reference internals
 * (publicPath, WASM backends, blob URLs) that mean nothing to a beta tester.
 *
 * v0.49.33: dropped the "switch to remove.bg" fallback advice — that engine
 * no longer exists. Network-failure messages now point at the cache panel +
 * client-mode CSP, which is the actual root cause for the two ways this
 * fails ((1) no internet on first run, (2) client-mode CSP blocked the
 * download before v0.49.33's fix).
 */
function friendlyLocalEngineError(err) {
  const msg = err?.message ?? String(err);
  if (/no available backend|Failed to fetch dynamically imported module/i.test(msg)) {
    return (
      'Background-removal engine failed to start (ONNX WASM backend couldn\'t load). ' +
      'On a fresh install this almost always means the ~80 MB model couldn\'t download — ' +
      'check your internet connection, then click "Download model now" in Settings → ' +
      'AI Generation → Local model cache.'
    );
  }
  if (/Resource (.+) not found|publicPath is configured/i.test(msg)) {
    return (
      'Couldn\'t fetch the @imgly model assets. Check your internet connection — ' +
      'the first run pulls ~80 MB from staticimgly.com. After that it\'s cached and offline.'
    );
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return (
      'Couldn\'t reach staticimgly.com to download the background-removal model. ' +
      'First run needs internet to fetch the ~80 MB model; after that it works offline. ' +
      'If you\'re on a client Mac and this happened after restoring from a backup, try ' +
      'restarting the app — the CSP allow-list for the model host is set at boot.'
    );
  }
  // v0.22.12: @imgly v1.5.x rejects very small / unusual images with
  // "The source image could not be decoded." When the user hits this
  // from the Settings prefetch it means our warm-up image is bad
  // (fixed in v0.22.12). When they hit it from the Workspace it means
  // their product photo is in a format @imgly doesn't grok — usually
  // HEIC, AVIF, or an exotic CMYK JPEG.
  if (/could not be decoded|cannot be decoded|unsupported image format/i.test(msg)) {
    return (
      'The image couldn\'t be decoded by the background-removal engine. ' +
      '@imgly accepts PNG, JPEG, and WebP — try converting HEIC / AVIF / CMYK ' +
      'images first. If this is the warm-up running from Settings, you\'re on ' +
      'an older build; rebuild from v0.22.12 or later.'
    );
  }
  return `Background removal failed: ${msg}`;
}

/**
 * Run background removal on the image at `filepath` using the local engine.
 * Returns the cutout as both a Blob (for display) and an ArrayBuffer (for IPC).
 *
 * v0.49.33: dropped the `opts.engine` / `opts.apiKey` parameters; there's
 * only one engine now. Callers passed `{ engine, apiKey }` previously —
 * leaving extra opts in place is harmless (we just ignore them).
 *
 * @param {string} filepath
 * @param {(stage: string, ratio: number) => void} [onProgress]
 * @param {string} [version] cache stamp for mutable positional paths
 * @param {{expectedSourceHash?: string, validateSource?: (sourceHash: string) => Promise<void>}} [sourceIdentity]
 */
export async function removeBackground(filepath, onProgress, version, sourceIdentity) {
  /* v0.1.27: the cache key includes a `version` stamp.
   *
   * It used to be keyed by filepath alone, and image files are rewritten IN
   * PLACE — flipping, cropping to source, or the server renumbering positions
   * after a delete all change the bytes behind the same relative path. So the
   * second background removal for that path silently reused the FIRST one's
   * cutout and composited it onto the new pixels, producing an output that
   * mixed two different images.
   *
   * Callers pass the row's `contentHash`, which the server recomputes on every
   * byte-changing edit (see main/ipc/images.js), so a stale entry can no longer
   * be reached. Passing nothing keeps the old filepath-only behaviour rather
   * than breaking, which matters for any caller added later that has no hash. */
  const key = version ? `${filepath}::${version}` : filepath;
  if (cutoutCache.has(key)) {
    const cached = cutoutCache.get(key);
    if (sourceIdentity?.expectedSourceHash && cached.sourceHash !== sourceIdentity.expectedSourceHash) {
      throw new Error('Image changed; reload and try again');
    }
    await sourceIdentity?.validateSource?.(cached.sourceHash);
    return cached;
  }
  if (inFlight.has(key)) {
    const result = await inFlight.get(key);
    if (sourceIdentity?.expectedSourceHash && result.sourceHash !== sourceIdentity.expectedSourceHash) {
      throw new Error('Image changed; reload and try again');
    }
    await sourceIdentity?.validateSource?.(result.sourceHash);
    return result;
  }

  const job = (async () => {
    const result = await removeViaLocal(filepath, onProgress, version, sourceIdentity);
    cutoutCache.set(key, result);
    return result;
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Drop cached cutouts. Optional now: because the cache is keyed by
 * (filepath, contentHash), a changed image is simply a different entry and the
 * stale one can no longer be hit. Kept for callers that want to free the
 * memory of a large blob explicitly.
 */
export function clearCutoutCache(filepath) {
  if (!filepath) { cutoutCache.clear(); return; }
  for (const key of [...cutoutCache.keys()]) {
    if (key === filepath || key.startsWith(`${filepath}::`)) cutoutCache.delete(key);
  }
}

export async function rawImageBytes(filepath) {
  const blob = await fetchImageBlob(filepath);
  return blob.arrayBuffer();
}
