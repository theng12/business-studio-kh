/**
 * v0.1.69: ImageScopeField — the reusable "which images does this operation
 * act on?" control (Main image only · All images · Specific positions).
 *
 * It was built for the Overlay Studio bulk apply, but every image-affecting
 * operation in the Library's Image operations menu (Remove background, Auto
 * crop, Enhance, Convert format, Compress, Resize) should offer the same
 * choice with the same skip-and-report behaviour. Keeping the UI here — and
 * the value shape explicit — makes that a wiring job in each modal:
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
import { useEffect, useState } from 'react';

/** The default the existing behaviour must keep: main image only. */
export const IMAGE_SCOPE_DEFAULT = { scope: 'main', positions: [] };

/** Upper bound mirrors main/util/imageScope.js (the product image cap). */
const MAX_IMAGE_POSITION = 50;
/** Always offer a few ticks so a "2nd photo" is pickable even when the
 *  loaded product rows have not reported an image count yet. */
const MIN_TICK_COUNT = 5;

/**
 * Parse a free-text position list: "2, 4", "2 4", "2;4", "2-4".
 * Out-of-range / nonsense tokens are ignored; the result is deduped and
 * sorted, matching normalizePositions() on the main side.
 */
export function parsePositionsInput(text) {
  const out = new Set();
  for (const token of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
        if (i >= 1 && i <= MAX_IMAGE_POSITION) out.add(i);
      }
      continue;
    }
    const n = Number(token);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_POSITION) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Dedupe/sort/cap a position array. */
export function normalizePositionList(positions) {
  const out = new Set();
  for (const raw of Array.isArray(positions) ? positions : []) {
    if (Number.isInteger(raw) && raw >= 1 && raw <= MAX_IMAGE_POSITION) out.add(raw);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The ONE builder for the value shape, so the radio and the tick-boxes can
 * never disagree about what a mode means.
 */
export function buildImageScope(scope, positions) {
  if (scope === 'positions') {
    return { scope: 'positions', positions: normalizePositionList(positions) };
  }
  return { scope: scope === 'all' ? 'all' : 'main', positions: [] };
}

/** Does this value ask for more than one image per product? */
export function imageScopeIsMulti(value) {
  if (value?.scope === 'all') return true;
  return value?.scope === 'positions' && (value.positions?.length ?? 0) > 1;
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
    reset: () => {
      setValue(buildImageScope('main', []));
      setPositionsText('');
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
