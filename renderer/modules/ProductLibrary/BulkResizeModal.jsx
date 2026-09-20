// v0.49.34: BulkResizeModal — change pixel dimensions in batch.
//
// Splits out of the v0.49.28-33 combined modal per the v0.49.34 spec: each
// operation is now independent. This one is the PIXEL RESIZE, no format
// change, fixed near-original re-encode quality.
//
// Two modes the user actually wants:
//   - "Max long edge"  — cap whichever side is longer at N px, preserve
//                        aspect, never upscale. The common "shrink everything
//                        to 2000px for the web" case.
//   - "Exact W × H"    — match a hard spec (e.g. Amazon 2000×2000). Three
//                        fit modes:
//                          cover   = crop excess to fill the target
//                          contain = letterbox to fit inside the target,
//                                    padding with the chosen background
//                          fill    = stretch to match exactly
//                        v0.49.34 adds the BACKGROUND COLOUR picker the
//                        v0.49.29 version was missing — without it,
//                        `contain` fit on JPEG produced black bars (sharp's
//                        default `{r:0,g:0,b:0,alpha:0}`), and on PNG /
//                        WebP it produced transparent bars that looked
//                        invisible against any background — both reading
//                        to users as "nothing changed". Now defaults to
//                        white and is user-pickable.
//
// Quality is fixed at 92 (near-original) — this modal is about pixel
// dimensions, not file-size reduction. Drop to the Compress modal if you
// also want to shrink bytes.
//
// v0.1.16: the modal chrome, the remembered-picks storage and the
// error-toast wrapper now live in BulkOpModal. This file is only the
// resize-specific form body and IPC call.

import { useCallback } from 'react';
import { Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { BulkOpModal } from './BulkOpModal.jsx';
import { SCOPE_OPTIONS } from './libraryConstants.js';

const RESIZE_MODES = [
  { value: 'longEdge', label: 'Max long edge (preserve aspect, never upscale)' },
  { value: 'exact',    label: 'Exact width × height' },
];

const FIT_MODES = [
  { value: 'cover',   label: 'Cover — fill target, crop excess (no padding)' },
  { value: 'contain', label: 'Contain — fit inside target, pad sides with chosen bg' },
  { value: 'fill',    label: 'Fill — stretch to exact target (distorts aspect ratio)' },
];

const BG_SWATCHES = ['#FFFFFF', '#F5F5F5', '#000000', '#808080', '#1A1A1A'];

// v0.49.35: persisted across runs.
const STORAGE_KEY = 'Library.bulkResize';
const SCHEMA_VERSION = 1;
const DEFAULTS = {
  resizeMode: 'longEdge',
  longEdge: 2000,
  width: 2000,
  height: 2000,
  fit: 'cover',
  background: '#FFFFFF',
  stripMetadata: true,
  scope: 'main',
};

export function BulkResizeModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);

  const run = useCallback(async (state, ids) => {
    const resize = state.resizeMode === 'longEdge'
      ? { mode: 'longEdge', longEdge: state.longEdge }
      : { mode: 'exact', width: state.width, height: state.height, fit: state.fit, background: state.background };
    const res = await window.api.images.reencodeProducts({
      productIds: ids,
      // Resize never changes format — pass 'keep' so the extension stays.
      targetFormat: 'keep',
      // Near-original quality so resize doesn't double as a compress.
      quality: 92,
      stripMetadata: state.stripMetadata,
      scope: state.scope,
      resize,
    });
    const mb = res?.bytesSaved ? (res.bytesSaved / (1024 * 1024)).toFixed(1) : '0.0';
    const failed = res?.failed || 0;
    const images = res?.images || 0;
    const label = state.resizeMode === 'longEdge'
      ? `≤ ${state.longEdge}px long edge`
      : `${state.width}×${state.height} (${state.fit})`;
    if (failed > 0) {
      addToast(
        `Resized ${images}, ${failed} failed · ${label}`,
        failed === images ? 'error' : 'info',
      );
    } else {
      addToast(
        `Resized ${images} image${images === 1 ? '' : 's'} to ${label} · ${mb} MB saved`,
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
      titlePrefix="Resize"
      actionVerb="Resize"
      description={
        <>
          Resamples each selected image to the chosen pixel dimensions. Re-encodes
          at near-original quality (92) — to also shrink file size, use the
          Compress modal afterwards. Destructive — overwrites the source bytes.
        </>
      }
      run={run}
    >
      {({ state, set, running }) => {
        const showBackground = state.resizeMode === 'exact' && state.fit === 'contain';
        return (
          <>
            <Field label="Mode">
              {({ id }) => (
                <Select id={id} value={state.resizeMode} onChange={(e) => set('resizeMode', e.target.value)} disabled={running}>
                  {RESIZE_MODES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              )}
            </Field>

            {state.resizeMode === 'longEdge' ? (
              <Field label="Max long edge (px)" hint="Whichever side is longer gets capped at this; the other side scales to preserve aspect ratio. Images already smaller are left alone (no upscaling).">
                {({ id }) => (
                  <input
                    id={id}
                    type="number"
                    min="16"
                    max="8000"
                    step="100"
                    value={state.longEdge}
                    onChange={(e) => set('longEdge', Number(e.target.value) || 0)}
                    disabled={running}
                    style={{ width: 140, padding: '6px 8px' }}
                  />
                )}
              </Field>
            ) : null}

            {state.resizeMode === 'exact' ? (
              <>
                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  <Field label="Width (px)">
                    {({ id }) => (
                      <input
                        id={id}
                        type="number"
                        min="16"
                        max="8000"
                        step="100"
                        value={state.width}
                        onChange={(e) => set('width', Number(e.target.value) || 0)}
                        disabled={running}
                        style={{ width: 120, padding: '6px 8px' }}
                      />
                    )}
                  </Field>
                  <Field label="Height (px)">
                    {({ id }) => (
                      <input
                        id={id}
                        type="number"
                        min="16"
                        max="8000"
                        step="100"
                        value={state.height}
                        onChange={(e) => set('height', Number(e.target.value) || 0)}
                        disabled={running}
                        style={{ width: 120, padding: '6px 8px' }}
                      />
                    )}
                  </Field>
                </div>

                <Field label="Fit mode" hint="How to handle aspect-ratio mismatch between source and target. If the source aspect already matches the target, all three modes produce the same pixels (no visible difference).">
                  {({ id }) => (
                    <Select id={id} value={state.fit} onChange={(e) => set('fit', e.target.value)} disabled={running}>
                      {FIT_MODES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  )}
                </Field>

                {/* v0.49.34: background colour picker for `contain` fit. Only
                    visible when fit:'contain' is selected because the colour is
                    irrelevant for cover (no padding produced) and fill (no
                    padding produced). Hiding instead of greying drops one
                    control off the form when it doesn't matter. */}
                {showBackground ? (
                  <Field
                    label="Background colour"
                    hint="The colour painted into the padding when the source aspect doesn’t match the target. Only used by Contain. JPEG outputs flatten transparency onto this colour too."
                  >
                    {() => (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <input
                          type="color"
                          value={state.background}
                          onChange={(e) => set('background', e.target.value.toUpperCase())}
                          disabled={running}
                          style={{ width: 44, height: 32, padding: 0, border: '1px solid var(--border, #ccc)', borderRadius: 4 }}
                          aria-label="Pick background colour"
                        />
                        <span className="muted" style={{ fontFamily: 'monospace', minWidth: 70 }}>{state.background}</span>
                        <div className="swatch-row" style={{ display: 'flex', gap: 6 }}>
                          {BG_SWATCHES.map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => set('background', c)}
                              disabled={running}
                              title={c}
                              aria-label={`Set background to ${c}`}
                              style={{
                                width: 22, height: 22, border: '1px solid var(--border, #ccc)',
                                borderRadius: 4, background: c, cursor: running ? 'default' : 'pointer',
                                outline: state.background.toUpperCase() === c.toUpperCase() ? '2px solid var(--accent, #3b82f6)' : 'none',
                                outlineOffset: 1,
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </Field>
                ) : null}
              </>
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
              Pixels are rotated to bake EXIF orientation first, so the width/height
              you set above are the dimensions you’ll see in viewers — no "my 2000×3000
              portrait came out 3000×2000 landscape" surprises.
            </p>
          </>
        );
      }}
    </BulkOpModal>
  );
}
