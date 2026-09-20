// v0.1.16: useBulkPreview — the live before/after preview shared by the bulk
// "run and preview" modals (AutoCropRunModal, AutoEnhanceRunModal).
//
// Those two had this whole block copy-pasted: load the first selected
// product's main image as a sample, call an IPC preview channel whenever the
// controls change (debounced 240ms), turn the returned PNG bytes into a blob
// URL, swap it in, and revoke the previous URL. That is ~45 lines each, and the
// blob-URL lifecycle is the part you do not want two divergent copies of —
// leaking one URL per slider drag adds up fast.
//
// It also fixes a latent bug in the copied version. The load effect depended on
// `productIds`, but the Product Library passes `productIds={Array.from(selectedIds)}`
// — a NEW array on every parent render. So any parent re-render (a toast, a
// background refresh) re-ran the effect, cleared `sample` and `afterUrl`, and
// refetched the image list, making the preview blink back to "Rendering…".
// The effect only ever reads `productIds[0]`, so that is what it depends on
// now: a string, stable across re-renders.
//
// The caller supplies `requestPreview`, which must be a `useCallback` over its
// own control values — that is what tells the hook when to re-render the
// preview.

import { useCallback, useEffect, useRef, useState } from 'react';
import { appImageSrc } from '../../lib/imageUrl.js';

const PREVIEW_DEBOUNCE_MS = 240;

/**
 * @param {object}   o
 * @param {boolean}  o.open            modal visibility
 * @param {string[]} o.productIds      selected product ids (only [0] is used)
 * @param {boolean}  o.skipPreview     user turned the preview off
 * @param {Function} o.requestPreview  async (sample) => bytes; must be stable
 * @param {Function} o.addToast        store toast
 * @returns {{ sample, beforeUrl, afterUrl, previewBusy }}
 */
export function useBulkPreview({ open, productIds, skipPreview, requestPreview, addToast }) {
  const [sample, setSample] = useState(null); // { productId, filepath, contentHash, sku }
  const [afterUrl, setAfterUrl] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const afterUrlRef = useRef(null);
  const debounceRef = useRef(null);

  // The sample is always the FIRST selected product's main image. Depend on
  // that id, not on the array, so a parent re-render can't restart this.
  const firstId = (productIds && productIds[0]) || null;

  useEffect(() => {
    if (!open) return undefined;
    setSample(null);
    setAfterUrl(null);
    if (!firstId) return undefined;

    let cancelled = false;
    window.api.images.listByProduct(firstId)
      .then((imgs) => {
        if (cancelled) return;
        const main = imgs && imgs[0];
        if (main) {
          setSample({
            productId: firstId,
            filepath: main.filepath,
            contentHash: main.contentHash,
            sku: main.sku,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, firstId]);

  const renderPreview = useCallback(async () => {
    if (!open || skipPreview || !sample) return;
    setPreviewBusy(true);
    try {
      const bytes = await requestPreview(sample);
      if (!bytes) return;
      const blob = new Blob(
        [bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)],
        { type: 'image/png' },
      );
      const url = URL.createObjectURL(blob);
      if (afterUrlRef.current) URL.revokeObjectURL(afterUrlRef.current);
      afterUrlRef.current = url;
      setAfterUrl(url);
    } catch (err) {
      addToast(`Preview failed: ${err.message}`, 'error');
    } finally {
      setPreviewBusy(false);
    }
  }, [open, skipPreview, sample, requestPreview, addToast]);

  // Debounced live preview whenever the controls (or the sample) change.
  useEffect(() => {
    if (!open || skipPreview) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [open, skipPreview, renderPreview]);

  // Revoke the last blob URL on unmount; the swap above revokes the previous
  // one on every new render, so this only catches the final one.
  useEffect(() => () => {
    if (afterUrlRef.current) URL.revokeObjectURL(afterUrlRef.current);
  }, []);

  // `sample` is loaded before the first preview render, so this is null until
  // then — the modals render "No sample image" in that case.
  const beforeUrl = sample ? appImageSrc(sample.filepath, sample.contentHash) : null;

  return { sample, beforeUrl, afterUrl, previewBusy };
}
