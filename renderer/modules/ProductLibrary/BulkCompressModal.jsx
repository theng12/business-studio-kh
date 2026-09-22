// v0.49.34: BulkCompressModal — re-encode at a chosen quality, same format.
//
// Splits out of the v0.49.28-33 combined modal per the v0.49.34 spec: each
// operation is now independent. This one is the QUALITY slider, no format
// change, no resize.
//
// Reuses `images:reencodeProducts` with targetFormat: 'keep' so the
// extension stays put. The backend infers the encoder (jpeg/webp/png) from
// the existing file extension. PNG inputs are still re-encoded (with
// compressionLevel 9) but the quality slider does nothing for them; the
// description says so, since the modal can't tell what the selection holds
// without an extra query per product.
//
// v0.1.16: the modal chrome, the remembered-picks storage and the
// error-toast wrapper now live in BulkOpModal. This file is only the
// compress-specific form body and IPC call.

import { useCallback } from 'react';
import { Field, Select, SliderField } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { BulkOpModal } from './BulkOpModal.jsx';
import { SCOPE_OPTIONS } from './libraryConstants.js';

const QUALITY_PRESETS = [
  { value: 60, label: 'Aggressive (60)' },
  { value: 75, label: 'Balanced (75)' },
  { value: 85, label: 'Catalog default (85)' },
  { value: 92, label: 'Near-original (92)' },
];

// v0.49.35: persisted across runs.
const STORAGE_KEY = 'Library.bulkCompress';
const SCHEMA_VERSION = 1;
const DEFAULTS = {
  quality: 85,
  stripMetadata: true,
  scope: 'main',
};

export function BulkCompressModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);

  const run = useCallback(async (state, ids) => {
    const res = await window.api.images.reencodeProducts({
      productIds: ids,
      targetFormat: 'keep',
      quality: state.quality,
      stripMetadata: state.stripMetadata,
      scope: state.scope,
      // Compress never resizes.
      resize: { mode: 'none' },
    });
    const mb = res?.bytesSaved ? (res.bytesSaved / (1024 * 1024)).toFixed(1) : '0.0';
    const failed = res?.failed || 0;
    const images = res?.images || 0;
    if (failed > 0) {
      addToast(
        `Compressed ${images}, ${failed} failed · ${mb} MB saved`,
        failed === images ? 'error' : 'info',
      );
    } else {
      addToast(
        `Compressed ${images} image${images === 1 ? '' : 's'} · ${mb} MB saved`,
        'success',
      );
    }
  }, [addToast]);

  return (
    <BulkOpModal
      open={open}
      productIds={productIds}
      onClose={onClose}
      onDone={onDone}
      storageKey={STORAGE_KEY}
      defaults={DEFAULTS}
      schemaVersion={SCHEMA_VERSION}
      titlePrefix="Compress"
      actionVerb="Compress"
      description={
        <>
          Re-encodes each selected image at the chosen quality, keeping its
          existing format. Use to shrink file size without changing the file
          extension. Destructive — overwrites the source bytes. PNG inputs
          are re-encoded losslessly (the slider has no effect on them; consider
          the Convert modal → WebP if you want PNG sizes down).
        </>
      }
      run={run}
    >
      {({ state, set, running }) => (
        <>
          <SliderField
            label="Quality"
            value={state.quality}
            min={1}
            max={100}
            hint="Lower = smaller file, more visible compression artefacts. 85 is the catalog default — visible artefacts begin to show below ~75 on flat backgrounds."
            disabled={running}
            onChange={(v) => set('quality', v)}
          />

          <div className="quality-presets" style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {QUALITY_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`preset-chip${state.quality === p.value ? ' is-active' : ''}`}
                onClick={() => set('quality', p.value)}
                disabled={running}
                title={`Set quality to ${p.value}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <Field label="Scope">
            {({ id }) => (
              <Select id={id} value={state.scope} onChange={(e) => set('scope', e.target.value)} disabled={running}>
                {SCOPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>

          <label className="toggle" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={state.stripMetadata}
              onChange={(e) => set('stripMetadata', e.target.checked)}
              disabled={running}
            />
            <span>Strip metadata (EXIF, GPS, colour profile)</span>
          </label>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Recommended ON. The pixels are rotated to bake EXIF orientation, so
            the image still reads the right way up.
          </p>
        </>
      )}
    </BulkOpModal>
  );
}
