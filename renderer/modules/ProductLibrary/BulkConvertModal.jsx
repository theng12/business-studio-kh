// v0.49.34: BulkConvertModal — change image format in batch.
//
// Splits out of the v0.49.28-33 combined "Convert · compress · resize" modal
// per the v0.49.34 spec: each operation is now independent. This one is the
// FORMAT picker, no resize, no compression-only path.
//
// Reuses the same `images:reencodeProducts` IPC — only the args differ. The
// renderer just gates which knobs are exposed; the backend does the same
// sharp pass either way.
//
// v0.1.16: the modal chrome, the remembered-picks storage and the
// error-toast wrapper now live in BulkOpModal. This file is only the
// format-specific form body and IPC call.

import { useCallback } from 'react';
import { Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { BulkOpModal } from './BulkOpModal.jsx';
import { SCOPE_OPTIONS } from './libraryConstants.js';

const FORMAT_OPTIONS = [
  // No "keep" here — this modal is explicitly for changing the format.
  // If the user picks the same format as the source, the converter still
  // runs (and re-encodes at the chosen quality), which is fine but rare
  // intent. The Compress modal is the better tool for that case.
  { value: 'jpeg', label: 'JPEG (.jpg) — smaller, lossy, no alpha' },
  { value: 'png',  label: 'PNG (.png) — larger, lossless, alpha preserved' },
  { value: 'webp', label: 'WebP (.webp) — smaller than JPEG at same quality' },
];

// v0.49.35: persisted across runs. Bump SCHEMA_VERSION when the shape of
// DEFAULTS changes incompatibly so older stored blobs are dropped instead
// of fed into the new code path.
const STORAGE_KEY = 'Library.bulkConvert';
const SCHEMA_VERSION = 1;
const DEFAULTS = {
  targetFormat: 'jpeg',
  quality: 85,
  stripMetadata: true,
  scope: 'main',
};

export function BulkConvertModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);

  const run = useCallback(async (state, ids) => {
    const res = await window.api.images.reencodeProducts({
      productIds: ids,
      targetFormat: state.targetFormat,
      quality: state.quality,
      stripMetadata: state.stripMetadata,
      scope: state.scope,
      // Convert never resizes — pass mode:'none' explicitly so a future
      // backend change can't default-on a resize behind our back.
      resize: { mode: 'none' },
    });
    const mb = res?.bytesSaved ? (res.bytesSaved / (1024 * 1024)).toFixed(1) : '0.0';
    const failed = res?.failed || 0;
    const images = res?.images || 0;
    if (failed > 0) {
      addToast(
        `Converted ${images}, ${failed} failed · ${mb} MB saved`,
        failed === images ? 'error' : 'info',
      );
    } else {
      addToast(
        `Converted ${images} image${images === 1 ? '' : 's'} to ${state.targetFormat.toUpperCase()} · ${mb} MB saved`,
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
      titlePrefix="Convert format"
      actionVerb="Convert"
      description={
        <>
          Re-encodes each selected image into the target format. The file on
          disk is replaced and renamed when the extension changes (e.g.
          <code> sku-001.png → sku-001.jpg</code>).
          Destructive — the original bytes are overwritten.
        </>
      }
      run={run}
    >
      {({ state, set, running }) => {
        // Quality slider is meaningful for JPEG / WebP (lossy). PNG is
        // lossless, so hide it instead of greying it out — less cognitive load.
        const qualityRelevant = state.targetFormat === 'jpeg' || state.targetFormat === 'webp';
        return (
          <>
            <Field label="Target format" hint="Switching to JPEG drops alpha channels — any transparency lands on the background you'd fill behind it (use the Resize modal if you need an explicit fill).">
              {({ id }) => (
                <Select id={id} value={state.targetFormat} onChange={(e) => set('targetFormat', e.target.value)} disabled={running}>
                  {FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              )}
            </Field>

            {qualityRelevant ? (
              <Field
                label={`Quality: ${state.quality}`}
                hint="85 is the catalog sweet spot. JPEG / WebP only — PNG is lossless and ignores this."
              >
                {({ id }) => (
                  <input
                    id={id}
                    type="range"
                    min="1"
                    max="100"
                    step="1"
                    value={state.quality}
                    onChange={(e) => set('quality', Number(e.target.value))}
                    disabled={running}
                    style={{ width: '100%' }}
                  />
                )}
              </Field>
            ) : null}

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
              Recommended ON for catalog images. The pixels are rotated to bake EXIF
              orientation, so the image still displays the right way up afterwards.
            </p>
          </>
        );
      }}
    </BulkOpModal>
  );
}
