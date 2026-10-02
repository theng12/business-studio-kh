/**
 * v0.38.0: BulkBgRemovalModal — "put these on a clean background" in batch.
 *
 * For each selected product it takes the MAIN image, removes the background
 * with the bundled local @imgly engine, mattes the cutout onto a solid colour
 * (white by default), then adds that as a new image and promotes it to
 * main — so the original (e.g. a colored or hand-taken shot) is KEPT at
 * position 1. The clean white-background result is exactly what Auto-crop
 * wants, so the usual flow is: Remove bg → Auto-crop.
 *
 * v0.49.33: removed the remove.bg engine option (along with its API-key
 * check + cost copy). The bundled local engine is the only path now.
 *
 * Why renderer-orchestrated (no new IPC): the existing single-image bg removal
 * already runs the engine in the renderer (fetching source bytes over the
 * app-image:// protocol — which proxies to the server in client mode), so this
 * just loops that same call and reuses images:importFromBytes + setMainImage,
 * both of which already work in standalone AND client mode. The compositing
 * onto white happens here on a canvas; only the final JPEG bytes cross IPC.
 *
 * Sequential with a Cancel button: bg removal is ML inference (~1-3s/image
 * locally), so we process one product at a time and let the user stop between
 * products. The local engine downloads a ~80MB model on first ever use.
 *
 * NOTE: needs a renderer to run the engine, so this is a desktop-app feature
 * (the iPad web viewer can't run @imgly) — by design.
 */

import { useState, useRef } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { removeBackground } from '../../lib/bgRemoval.js';
import { useAppStore } from '../../store/index.js';
import {
  ImageScopeField,
  imageScopeNeedsPositions,
  summarizeSkippedReasons,
  useDeepestGallery,
  useImageScope,
} from './ImageScopeField.jsx';

// Composite a transparent cutout Blob onto a solid colour, return JPEG bytes
// (ArrayBuffer). JPEG because the result is opaque (no alpha to preserve) and
// far smaller than PNG for a photo; the export pipeline re-encodes later anyway.
async function matteOnColor(cutoutBlob, hexColor) {
  const bmp = await createImageBitmap(cutoutBlob);
  const w = bmp.width;
  const h = bmp.height;
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hexColor;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const outBlob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    : await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  return outBlob.arrayBuffer();
}

export function BulkBgRemovalModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const galleryDepth = useDeepestGallery(productIds);

  const [fillColor, setFillColor] = useState('#FFFFFF');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { i, n, label }
  // v0.1.70: "which images" choice. Remove background has always acted on the
  // main image only, so `main` stays its default.
  const imageChoice = useImageScope();
  // v0.43.0: parallel workers — bg removal is ML inference + canvas matte +
  // upload; running 2-3 in parallel overlaps the I/O and gives real wall-clock
  // wins for batches. Defaults to 2 (conservative); 4 is the cap.
  const [concurrency, setConcurrency] = useState(2);
  const cancelRef = useRef(false);

  const count = productIds?.length ?? 0;

  async function run() {
    if (count === 0) { addToast('No products selected', 'info'); return; }
    cancelRef.current = false;
    setRunning(true);

    const { scope, positions } = imageChoice.value;
    let done = 0;          // products whose image(s) were processed
    let imagesDone = 0;    // cutouts added (a product can contribute several)
    let noImage = 0;       // products with no usable images at all
    let skipped = 0;       // products missing every requested position
    let failed = 0;
    const skippedReasons = {};
    const failures = [];
    const cursor = { i: 0 };
    const workers = Math.max(1, Math.min(4, Number(concurrency) || 1));

    // One product start→finish. Increments `done` on success; per-product
    // errors are caught so a failure doesn't drop the worker.
    async function processOne(productId) {
      try {
        // v0.1.70: ask the main process for the shared image selection
        // (main / all / positions + why skipped). The @imgly engine can only
        // run in a renderer, so the loop lives here — but the RULE does not.
        const listed = await window.api.images.listByProduct({ productId, scope, positions });
        const all = Array.isArray(listed) ? listed : (listed?.images || []);
        const targets = Array.isArray(listed?.chosen)
          ? listed.chosen
          : (scope === 'all' ? all : all.slice(0, 1)); // defensive: legacy array shape
        if (targets.length === 0) {
          const reason = listed?.skippedReason || (all.length === 0 ? 'no images' : 'no requested image');
          if (all.length === 0) noImage += 1;
          skipped += 1;
          skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
          return;
        }
        const mainRow = all[0] || null;
        // The cutout that replaces the main image is promoted only AFTER every
        // target of this product is done. Setting main renumbers the product's
        // files, so doing it straight away made the remaining targets' paths
        // (read once, above) point at different photos — "all" or a position
        // list then cut out the wrong pictures.
        let promoteTo = null;
        const promote = async () => {
          if (promoteTo) await window.api.images.setMainImage(productId, promoteTo);
          promoteTo = null;
        };

        // `finally`: a cutout already made for the main image is promoted even
        // when a later target fails or the run is stopped.
        try {
          for (const img of targets) {
            if (cancelRef.current) return;
            const sku = img.sku || '';
            setProgress({ i: done, n: count, label: `${sku} · removing background…`.trim() });

            const { blob } = await removeBackground(
              img.filepath,
              (stage, ratio) => {
                if (cancelRef.current) return;
                // v0.49.33: only the local engine remains. Stages come in as
                // `fetch:<resource>` while the model downloads on first run,
                // and as `inference` / friends during the segmentation pass.
                const label = String(stage).startsWith('fetch:')
                  ? `downloading model… ${Math.round(ratio * 100)}%`
                  : `removing background… ${Math.round(ratio * 100)}%`;
                setProgress({ i: done, n: count, label: `${sku} · ${label}`.trim() });
              },
              // v0.1.27: stamp the cache so a rewritten image cannot reuse an old cutout.
              img.contentHash || img.id,
            );
            if (cancelRef.current) return;

            const bytes = await matteOnColor(blob, fillColor);
            if (cancelRef.current) return;
            const res = await window.api.images.importFromBytes(productId, bytes, '.jpg');
            const added = res?.added;
            // Only promote the cutout when the source WAS the main image (the
            // default scope). For "all" / other positions the new cutouts are
            // appended and the original main is left alone — a position the
            // user did not ask to change stays put.
            // ponytail: promotion is all-or-nothing per product, tied to the
            // main image being among the targets; per-position promotion would
            // need a destination control this modal does not have.
            // Appending does not renumber, so this path stays valid until the
            // promotion below.
            if (added?.filepath && mainRow && img.filepath === mainRow.filepath) {
              promoteTo = added.filepath;
            }
            imagesDone += 1;
            setProgress({ i: done, n: count, label: `${sku} · done` });
          }
        } finally {
          await promote();
        }
        done += 1;
      } catch (err) {
        failed += 1;
        if (failures.length < 5) failures.push(err.message);
      }
    }

    // Worker: drains the shared cursor until empty or cancelled. JS is
    // single-threaded so cursor++ + counters are race-free; workers only
    // interleave on awaits.
    async function worker() {
      while (!cancelRef.current) {
        const i = cursor.i;
        cursor.i += 1;
        if (i >= productIds.length) return;
        await processOne(productIds[i]);
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));

    setRunning(false);
    setProgress(null);
    refreshProducts();

    const cancelled = cancelRef.current;
    const skip = summarizeSkippedReasons(skippedReasons);
    const bits = [`${done} product${done === 1 ? '' : 's'} done`];
    if (imagesDone > done) bits.push(`${imagesDone} images`);
    if (failed) bits.push(`${failed} failed`);
    let summary = `${cancelled ? 'Stopped — ' : ''}background removed: ${bits.join(', ')}`;
    if (skip) summary += ` — ${skip}`;
    addToast(summary, failed > 0 ? 'error' : (skip ? 'info' : 'success'));
    if (failed > 0 && failures.length) addToast(failures[0], 'error');
    onDone?.({ done, imagesDone, noImage, skipped, skippedReasons, failed, cancelled });
    if (!cancelled) onClose?.();
  }

  if (!open) return null;

  return (
    <Modal open={open} title="Remove background (bulk)" onClose={running ? undefined : onClose} closeOnBackdrop={!running}>
      <div className="bulkbg">
        <p className="bulkbg__intro">
          Removes the background from each of the {count} selected product
          {count === 1 ? '' : 's'}&rsquo; chosen image(s), places the product on a
          solid background, and adds the clean cutout as a new image. When the
          main image is one of them it becomes the new main; the original shot
          is kept, so nothing is lost. The clean result is ready for Auto-crop.
        </p>

        <Field label="Background colour">
          {({ id }) => (
            <div className="bulkbg__fill">
              <input
                id={id}
                type="color"
                className="autocrop-run__swatch"
                value={fillColor}
                onChange={(e) => setFillColor(e.target.value.toUpperCase())}
                disabled={running}
                aria-label="Background colour"
              />
              <span className="muted">{fillColor}</span>
            </div>
          )}
        </Field>

        <ImageScopeField
          name="bgremoval-image-scope"
          value={imageChoice.value}
          onChange={imageChoice.set}
          galleryDepth={galleryDepth}
          disabled={running}
        />

        <Field label="Parallel workers" hint="How many products to process at once. More = faster on big selections, but each one slows down a bit. Try 2 first; bump up if your Mac has cycles to spare.">
          {({ id }) => (
            <Select id={id} value={String(concurrency)} onChange={(e) => setConcurrency(Number(e.target.value))} disabled={running}>
              <option value="1">1 (sequential — gentlest)</option>
              <option value="2">2 (recommended)</option>
              <option value="3">3</option>
              <option value="4">4 (max — heavy)</option>
            </Select>
          )}
        </Field>

        <p className="bulkbg__engine muted">
          Engine: <strong>local (@imgly, offline)</strong>
          {' '}— first run downloads a ~80 MB model, then it works offline.
          Pre-download from Settings → AI Generation → Local model cache.
        </p>

        {running && progress ? (
          <div className="bulkbg__progress">
            <div className="bulkbg__bar"><span style={{ width: `${Math.round((progress.i / progress.n) * 100)}%` }} /></div>
            <div className="bulkbg__status">{progress.i} / {progress.n} done — {progress.label}</div>
          </div>
        ) : null}

        <footer className="autocrop-run__footer">
          {running ? (
            <Button variant="danger" onClick={() => { cancelRef.current = true; }}>Stop</Button>
          ) : (
            <Button onClick={onClose}>Cancel</Button>
          )}
          <div style={{ flex: 1 }} />
          <Button variant="primary" disabled={running || count === 0 || imageScopeNeedsPositions(imageChoice.value)} onClick={run}>
            {running ? 'Working…' : `Remove background · ${count}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
