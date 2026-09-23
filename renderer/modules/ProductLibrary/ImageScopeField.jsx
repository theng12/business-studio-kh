/**
 * v0.1.69: ImageScopeField — the reusable "which images does this operation
 * act on?" control (Main image only · All images · Specific positions).
 *
 * v0.1.70: every image-affecting operation in the Library's Image operations
 * menu uses it — Remove background, Auto crop, Enhance, Convert format,
 * Compress and Resize — so the ask is the same everywhere and the answer
 * travels the same contract. The pure value builders / parser moved to
 * imageScopeValue.mjs so they can be unit-tested without React; they are
 * re-exported here so existing imports keep working.
 *
 *     const imageScope = useImageScope();
 *     ...
 *     <ImageScopeField
 *       name="bulk-bg-image-scope"
 *       value={imageScope.value}
 *       onChange={(v) => imageScope.set(v)}
 *       galleryDepth={deepestGalleryCount}
 *     />
 *     ... send imageScope.value to the main handler.
 *
 * The value shape is the contract shared with main/util/imageScope.js:
 *
 *     { scope: 'main' | 'all' | 'positions', positions: number[] }
 *
 * `positions` is only meaningful when scope === 'positions'; it is 1-based
 * with position 1 = the main image.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import {
  IMAGE_SCOPE_DEFAULT,
  MAX_IMAGE_POSITION,
  MIN_TICK_COUNT,
  buildImageScope,
  formatBulkImageResult,
  imageScopeIsMulti,
  imageScopeNeedsPositions,
  normalizePositionList,
  parsePositionsInput,
  summarizeSkippedReasons,
} from './imageScopeValue.mjs';

export {
  IMAGE_SCOPE_DEFAULT,
  MAX_IMAGE_POSITION,
  buildImageScope,
  formatBulkImageResult,
  imageScopeIsMulti,
  imageScopeNeedsPositions,
  normalizePositionList,
  parsePositionsInput,
  summarizeSkippedReasons,
};

/**
 * Deepest gallery among the products a run will touch, so the tick-boxes are
 * sized to the real data. Reads the store's filter-agnostic `allProducts` —
 * the Library's filtered page may hold none of the selected rows. Every
 * image-operation modal uses this so they agree on the number.
 */
export function useDeepestGallery(productIds) {
  const allProducts = useAppStore((s) => s.allProducts);
  return useMemo(() => {
    const wanted = new Set(productIds ?? []);
    let max = 0;
    for (const p of allProducts || []) {
      if (!wanted.has(p.id)) continue;
      max = Math.max(max, Number(p.imageCount ?? 0));
    }
    return max;
  }, [allProducts, productIds]);
}

/**
 * State holder for the control, so a caller wires three lines:
 *   const imageScope = useImageScope();
 *   <ImageScopeField value={imageScope.value} onChange={imageScope.set} ... />
 *   send(imageScope.value)
 */
export function useImageScope(initial = IMAGE_SCOPE_DEFAULT) {
  const [value, setValue] = useState(buildImageScope(initial.scope, initial.positions));
  const [positionsText, setPositionsText] = useState((initial.positions ?? []).join(', '));

  return {
    value,
    positionsText,
    set: (next) => setValue(buildImageScope(next?.scope, next?.positions)),
    reset: (next = IMAGE_SCOPE_DEFAULT) => {
      setValue(buildImageScope(next.scope, next.positions));
      setPositionsText((next.positions ?? []).join(', '));
    },
    setScope: (scope) => {
      if (scope === 'positions') {
        setValue(buildImageScope('positions', value.positions));
      } else {
        setValue(buildImageScope(scope, []));
        setPositionsText('');
      }
    },
    togglePosition: (position) => {
      const positions = value.positions.includes(position)
        ? value.positions.filter((p) => p !== position)
        : [...value.positions, position];
      const next = buildImageScope('positions', positions);
      setValue(next);
      setPositionsText(next.positions.join(', '));
    },
    setText: (text) => {
      setPositionsText(text);
      setValue(buildImageScope('positions', parsePositionsInput(text)));
    },
  };
}

/**
 * The control itself, controlled by `value` / `onChange`.
 *
 *   name         radio-group name (give each modal its own)
 *   galleryDepth highest image count among the products this run will touch
 *   disabled     lock the whole field while a run is in flight
 */
export function ImageScopeField({
  value = IMAGE_SCOPE_DEFAULT,
  onChange,
  name = 'image-scope',
  galleryDepth = 0,
  disabled = false,
  legend = 'Apply to which images',
}) {
  const scope = value?.scope === 'positions' ? 'positions' : value?.scope === 'all' ? 'all' : 'main';
  const positions = Array.isArray(value?.positions) ? value.positions : [];
  // A string key keeps the "follow the parent's value" effect from depending
  // on a fresh array identity each render.
  const positionsKey = positions.join(',');
  const [text, setText] = useState(positionsKey ? positionsKey.split(',').join(', ') : '');

  // Follow the value when the parent resets it (e.g. on modal open).
  useEffect(() => {
    setText(positionsKey ? positionsKey.split(',').join(', ') : '');
  }, [positionsKey]);

  const tickCount = Math.min(MAX_IMAGE_POSITION, Math.max(galleryDepth, MIN_TICK_COUNT));
  const emit = (nextScope, nextPositions) => onChange?.(buildImageScope(nextScope, nextPositions));

  return (
    <fieldset className="bulk-overlay-run__group">
      <legend>{legend}</legend>
      <label className="bulk-overlay-run__radio">
        <input
          type="radio"
          name={name}
          checked={scope === 'main'}
          onChange={() => emit('main', [])}
          disabled={disabled}
        />
        <span>
          <strong>Main image only</strong>
          <span className="muted"> — act on just the product&rsquo;s main image</span>
        </span>
      </label>
      <label className="bulk-overlay-run__radio">
        <input
          type="radio"
          name={name}
          checked={scope === 'all'}
          onChange={() => emit('all', [])}
          disabled={disabled}
        />
        <span>
          <strong>All images of each product</strong>
          <span className="muted"> — act on every image, not just the main one</span>
        </span>
      </label>
      <label className="bulk-overlay-run__radio">
        <input
          type="radio"
          name={name}
          checked={scope === 'positions'}
          onChange={() => emit('positions', positions)}
          disabled={disabled}
        />
        <span>
          <strong>Specific positions</strong>
          <span className="muted"> — tick the image numbers to act on. Products without those images are skipped and reported.</span>
        </span>
      </label>
      {scope === 'positions' ? (
        <div className="image-scope__positions">
          <div className="image-scope__ticks">
            {Array.from({ length: tickCount }, (_, i) => i + 1).map((pos) => (
              <label key={pos} className={`image-scope__tick${positions.includes(pos) ? ' is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={positions.includes(pos)}
                  onChange={() => {
                    const next = positions.includes(pos)
                      ? positions.filter((p) => p !== pos)
                      : [...positions, pos];
                    emit('positions', next);
                  }}
                  disabled={disabled}
                  aria-label={`Position ${pos}`}
                />
                <span>{pos}</span>
              </label>
            ))}
          </div>
          <input
            className="input image-scope__input"
            type="text"
            value={text}
            onChange={(e) => { setText(e.target.value); emit('positions', parsePositionsInput(e.target.value)); }}
            placeholder="e.g. 2, 4"
            aria-label="Specific positions"
            disabled={disabled}
          />
          <p className="field__hint">
            Position 1 is the main image. Products without those images are skipped and reported.
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
