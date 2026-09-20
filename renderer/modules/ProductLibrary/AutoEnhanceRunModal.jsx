/**
 * v0.40.0: AutoEnhanceRunModal — bulk "fix the hand-taken shots" pass.
 *
 * Runs the local sharp auto-enhance engine (white-balance + auto-levels +
 * gentle saturation/brightness) over the selected products' images and writes
 * them in place. Free, offline, no AI. Mirrors AutoCropRunModal: a live
 * before/after preview of the first product's main image (via
 * images:autoEnhancePreview) that updates with the controls, plus a per-run
 * "Skip preview" toggle that always starts off.
 *
 * Scope: "Main image only" (default) or "All images". In place, no per-image
 * undo — the preview is the safety net, so the modal says so.
 */

import { useCallback, useEffect, useState } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { useBulkPreview } from './useBulkPreview.js';

export function AutoEnhanceRunModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  const [whiteBalance, setWhiteBalance] = useState(true);
  const [autoLevels, setAutoLevels] = useState(true);
  const [saturation, setSaturation] = useState(108); // % → 1.08
  const [brightness, setBrightness] = useState(100);  // % → 1.00
  const [scope, setScope] = useState('main');
  const [submitting, setSubmitting] = useState(false);
  const [skipPreview, setSkipPreview] = useState(false); // per-run only

  const count = productIds?.length ?? 0;

  // Reset the controls each time we open. The sample image + preview state are
  // owned by useBulkPreview, which resets them on the same trigger.
  useEffect(() => {
    if (!open) return;
    setWhiteBalance(true);
    setAutoLevels(true);
    setSaturation(108);
    setBrightness(100);
    setScope('main');
    setSubmitting(false);
    setSkipPreview(false);
  }, [open]);

  // v0.1.16: the preview request, the debounce and the blob-URL lifecycle all
  // live in useBulkPreview now (shared with AutoCropRunModal). This is just the
  // enhance-specific request; it must stay a useCallback so the hook knows when
  // a control changed.
  const requestPreview = useCallback(async (sample) => {
    const res = await window.api.images.autoEnhancePreview({
      productId: sample.productId,
      filepath: sample.filepath,
      whiteBalance,
      autoLevels,
      saturation: saturation / 100,
      brightness: brightness / 100,
    });
    return res?.bytes;
  }, [whiteBalance, autoLevels, saturation, brightness]);

  const { sample, beforeUrl, afterUrl, previewBusy } = useBulkPreview({
    open, productIds, skipPreview, requestPreview, addToast,
  });

  async function handleSubmit() {
    if (count === 0) { addToast('No products selected', 'info'); return; }
    setSubmitting(true);
    try {
      const res = await window.api.images.autoEnhanceProducts({
        productIds,
        scope,
        whiteBalance,
        autoLevels,
        saturation: saturation / 100,
        brightness: brightness / 100,
      });
      const imgs = res?.images ?? 0;
      const prods = res?.products ?? 0;
      const failed = res?.failed ?? 0;
      const missing = res?.missing ?? 0;
      if (failed === 0 && missing === 0) {
        addToast(`Enhanced ${imgs} image${imgs === 1 ? '' : 's'} across ${prods} product${prods === 1 ? '' : 's'}`, 'success');
      } else {
        const bits = [`${imgs} image${imgs === 1 ? '' : 's'}`];
        if (failed) bits.push(`${failed} failed`);
        if (missing) bits.push(`${missing} missing on disk`);
        addToast(`Enhance done — ${bits.join(', ')}`, failed > 0 ? 'error' : 'info');
      }
      refreshProducts();
      onDone?.(res);
      onClose?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <Modal open={open} title="Auto-enhance images" onClose={onClose}>
      <div className="autocrop-run">
        <p className="autocrop-run__intro">
          A free, local fix-up for hand-taken shots: corrects colour casts
          (white balance), lifts dull exposure (auto-levels), and adds a gentle
          saturation boost — across the {count} selected product{count === 1 ? '' : 's'}.
          No AI, runs offline. Overwrites images in place (no per-image undo), so
          check the preview first.
        </p>

        {!skipPreview ? (
          <div className="autocrop-run__preview">
            <figure>
              <div className="autocrop-run__pv-img">
                {beforeUrl ? <img src={beforeUrl} alt="before" /> : <span className="muted">No sample image</span>}
              </div>
              <figcaption>Before{sample?.sku ? ` · ${sample.sku}` : ''}</figcaption>
            </figure>
            <div className="autocrop-run__pv-arrow" aria-hidden="true">→</div>
            <figure>
              <div className="autocrop-run__pv-img">
                {afterUrl ? (
                  <img src={afterUrl} alt="after" style={previewBusy ? { opacity: 0.5 } : undefined} />
                ) : (
                  <span className="muted">{sample ? 'Rendering…' : 'No sample image'}</span>
                )}
              </div>
              <figcaption>After (preview)</figcaption>
            </figure>
          </div>
        ) : null}

        <div className="autocrop-run__toggles">
          <label className="autocrop-run__skip">
            <input type="checkbox" checked={whiteBalance} onChange={(e) => setWhiteBalance(e.target.checked)} disabled={submitting} />
            <span>White balance (neutralise colour cast)</span>
          </label>
          <label className="autocrop-run__skip">
            <input type="checkbox" checked={autoLevels} onChange={(e) => setAutoLevels(e.target.checked)} disabled={submitting} />
            <span>Auto-levels (lift dull exposure)</span>
          </label>
        </div>

        <Field label="Saturation" hint={`${saturation}% — 100% leaves colour unchanged.`}>
          {({ id }) => (
            <div className="autocrop-run__slider">
              <input id={id} type="range" min="50" max="150" step="1" value={saturation} onChange={(e) => setSaturation(Number(e.target.value))} disabled={submitting} />
              <span className="autocrop-run__slider-val">{saturation}%</span>
            </div>
          )}
        </Field>

        <Field label="Brightness" hint={`${brightness}% — 100% leaves brightness unchanged.`}>
          {({ id }) => (
            <div className="autocrop-run__slider">
              <input id={id} type="range" min="70" max="130" step="1" value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} disabled={submitting} />
              <span className="autocrop-run__slider-val">{brightness}%</span>
            </div>
          )}
        </Field>

        <Field label="Apply to">
          {({ id }) => (
            <Select id={id} value={scope} onChange={(e) => setScope(e.target.value)} disabled={submitting}>
              <option value="main">Main image only</option>
              <option value="all">All images</option>
            </Select>
          )}
        </Field>

        <label className="autocrop-run__skip">
          <input type="checkbox" checked={skipPreview} onChange={(e) => setSkipPreview(e.target.checked)} disabled={submitting} />
          <span>Skip preview for this run</span>
        </label>

        <footer className="autocrop-run__footer">
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button variant="primary" disabled={submitting || count === 0} onClick={handleSubmit}>
            {submitting ? 'Enhancing…' : `Enhance ${count} product${count === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
