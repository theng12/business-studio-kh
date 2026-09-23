/**
 * v0.37.0: AutoCropRunModal — "tidy up a batch of shots" surface.
 * v0.38.0: added a live before/after preview on a sample image + a
 *          "skip preview" toggle (persisted) for once you trust it.
 *
 * Runs the reframe engine with autoCrop:true over EVERY image of the
 * selected products: it trims the solid background border down to the
 * product's bounding box, then re-frames each product to the same fill %
 * and margin on a fill-coloured canvas. The payoff is a uniform catalog
 * look from a mixed bag of tight/loose/AI shots — without hand-reframing
 * each one.
 *
 * Preview: the modal shows the first selected product's main image
 * before → after, re-rendering as you drag the sliders. It uses the same
 * images:reframePreview channel as the per-image Reframe tab (which now
 * honours autoCrop), so the preview is byte-for-byte what the batch will
 * produce on that image. A "Skip preview" checkbox hides the pane for the
 * current run — it is a pure in-session toggle that always starts OFF
 * (preview shown) each time the modal opens; nothing is remembered.
 *
 * The batch itself is synchronous like BulkOverlayRunModal: the button
 * blocks ("Auto-cropping…") until the backend returns stats. The edit is
 * in place and overwrites the file (no per-image undo), so the modal says
 * so up front and the preview is the safety net.
 */

import { useCallback, useEffect, useState } from 'react';
import { Modal, Button, Field, Select, SliderField } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { useBulkPreview } from './useBulkPreview.js';
import {
  ImageScopeField,
  formatBulkImageResult,
  imageScopeNeedsPositions,
  useDeepestGallery,
  useImageScope,
} from './ImageScopeField.jsx';

export function AutoCropRunModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const galleryDepth = useDeepestGallery(productIds);

  const [fillPct, setFillPct] = useState(88);      // product fill % → scale
  const [tolerance, setTolerance] = useState(12);  // background match → trimThreshold
  const [fillMode, setFillMode] = useState('color');
  const [fillColor, setFillColor] = useState('#FFFFFF');
  const [submitting, setSubmitting] = useState(false);
  // v0.1.70: "which images" choice. Auto crop has always processed every
  // image of each product, so `all` stays its default.
  const imageChoice = useImageScope({ scope: 'all', positions: [] });

  // In-session only: always starts OFF (preview shown) on open, not remembered.
  const [skipPreview, setSkipPreview] = useState(false);

  const count = productIds?.length ?? 0;

  // Reset the controls each time we open. The sample image + preview state are
  // owned by useBulkPreview, which resets them on the same trigger.
  useEffect(() => {
    if (!open) return;
    setFillPct(88);
    setTolerance(12);
    setFillMode('color');
    setFillColor('#FFFFFF');
    setSubmitting(false);
    setSkipPreview(false);
    imageChoice.reset({ scope: 'all', positions: [] });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // v0.1.16: the preview request, the debounce and the blob-URL lifecycle all
  // live in useBulkPreview now (shared with AutoEnhanceRunModal). This is just
  // the crop-specific request; it must stay a useCallback so the hook knows
  // when a control changed.
  const requestPreview = useCallback(async (sample) => {
    const res = await window.api.images.reframePreview({
      productId: sample.productId,
      filepath: sample.filepath,
      scale: fillPct / 100,
      offsetX: 0,
      offsetY: 0,
      fillMode,
      fillColor,
      autoCrop: true,
      trimThreshold: tolerance,
    });
    return res?.bytes;
  }, [fillPct, tolerance, fillMode, fillColor]);

  const { sample, beforeUrl, afterUrl, previewBusy } = useBulkPreview({
    open, productIds, skipPreview, requestPreview, addToast,
  });

  async function handleSubmit() {
    if (count === 0) { addToast('No products selected', 'info'); return; }
    setSubmitting(true);
    try {
      const res = await window.api.images.autoCropProducts({
        productIds,
        scope: imageChoice.value.scope,
        positions: imageChoice.value.positions,
        scale: fillPct / 100,
        fillMode,
        fillColor,
        trimThreshold: tolerance,
      });
      const missing = res?.missing ?? 0;
      const { text, tone } = formatBulkImageResult(res, {
        verb: 'Auto-cropped',
        extras: [missing ? `${missing} missing on disk` : ''],
      });
      addToast(text, tone);
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
    <Modal open={open} title="Auto-crop to product" onClose={onClose}>
      <div className="autocrop-run">
        <p className="autocrop-run__intro">
          Trims the background border down to the product, then re-frames every
          image of the {count} selected product{count === 1 ? '' : 's'} to the
          same fill and margin — for a uniform catalog look. Works best on
          solid / white backgrounds; busy or full-bleed shots are just
          re-centered. This overwrites the images in place (no per-image undo),
          so check the preview first.
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

        <SliderField
          label="Product fill"
          value={fillPct}
          min={60}
          max={100}
          suffix="%"
          hint={`Product fills ~${fillPct}% of the frame; the rest is margin.`}
          disabled={submitting}
          onChange={setFillPct}
        />

        <SliderField
          label="Background tolerance"
          value={tolerance}
          min={2}
          max={40}
          hint="How aggressively to treat near-corner colours as background. Raise it if off-white / noisy backgrounds aren't trimming; lower it if the product edge gets clipped."
          disabled={submitting}
          onChange={setTolerance}
        />

        <Field label="Margin fill">
          {({ id }) => (
            <div className="autocrop-run__fill">
              <Select id={id} value={fillMode} onChange={(e) => setFillMode(e.target.value)} disabled={submitting}>
                <option value="color">Solid colour</option>
                <option value="blur">Blurred copy of the image</option>
              </Select>
              {fillMode === 'color' ? (
                <input
                  type="color"
                  className="autocrop-run__swatch"
                  value={fillColor}
                  onChange={(e) => setFillColor(e.target.value.toUpperCase())}
                  disabled={submitting}
                  aria-label="Margin fill colour"
                  title="Margin fill colour"
                />
              ) : null}
            </div>
          )}
        </Field>

        <ImageScopeField
          name="autocrop-image-scope"
          value={imageChoice.value}
          onChange={imageChoice.set}
          galleryDepth={galleryDepth}
          disabled={submitting}
        />

        <label className="autocrop-run__skip">
          <input
            type="checkbox"
            checked={skipPreview}
            onChange={(e) => setSkipPreview(e.target.checked)}
            disabled={submitting}
          />
          <span>Skip preview for this run</span>
        </label>

        <footer className="autocrop-run__footer">
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button variant="primary" disabled={submitting || count === 0 || imageScopeNeedsPositions(imageChoice.value)} onClick={handleSubmit}>
            {submitting ? 'Auto-cropping…' : `Auto-crop ${count} product${count === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
