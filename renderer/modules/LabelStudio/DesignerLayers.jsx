import { elementLabel, inPaintOrder, toggleSelected } from './designerGeometry.js';

/**
 * v0.1.64: the layer list.
 *
 * The old editor offered only "Send back" / "Bring front" on the selected
 * element, so with more than a couple of elements there was no way to see the
 * stack, let alone pick something hidden behind something else. The original
 * Label Studio KH designer had a Layers panel; this is that, in this app's
 * markup, plus a direct answer to "hard to pick or select elements": clicking a
 * row selects it, and the eye/lock toggles are one click away.
 *
 * The list is drawn top-most first, which is the opposite of paint order —
 * that is how every design tool shows it.
 */
export function DesignerLayers({ elements, selectedIds, onSelect, onAction }) {
  const ordered = [...inPaintOrder(elements)].reverse();
  return (
    <div className="ld-layers">
      <div className="section-head ld-layers__head">
        <h3 className="section-title">Layers</h3>
        <span className="section-hint">{elements.length} element{elements.length === 1 ? '' : 's'}</span>
      </div>
      {ordered.length === 0 ? (
        <p className="ld-layers__empty">
          Nothing on the label yet. Use <strong>+ Text</strong>, or drag a type from the toolbar onto the label.
        </p>
      ) : (
        <ul>
          {ordered.map((el) => (
            <li
              key={el.id}
              className={`${selectedIds.includes(el.id) ? 'is-selected' : ''}${el.visible === false ? ' is-hidden' : ''}`}
            >
              <button
                type="button"
                className="ld-layers__name"
                onClick={(e) => onSelect(e.shiftKey
                  ? toggleSelected(selectedIds, el.id)
                  : [el.id])}
                onDoubleClick={() => onAction({ kind: 'rename', id: el.id })}
                title="Click to select, double-click to rename"
              >
                <span className={`ld-layers__type ld-layers__type--${el.type}`} aria-hidden />
                {elementLabel(el)}
              </button>
              <button
                type="button"
                className={`ld-layers__toggle${el.visible === false ? ' is-on' : ''}`}
                aria-label={el.visible === false ? 'Show' : 'Hide'}
                title={el.visible === false ? 'Show' : 'Hide'}
                onClick={() => onAction({ kind: 'hide', id: el.id, visible: el.visible === false })}
              >
                <EyeIcon off={el.visible === false} />
              </button>
              <button
                type="button"
                className={`ld-layers__toggle${el.locked ? ' is-on' : ''}`}
                aria-label={el.locked ? 'Unlock' : 'Lock'}
                title={el.locked ? 'Unlock' : 'Lock'}
                onClick={() => onAction({ kind: 'lock', id: el.id, locked: !el.locked })}
              >
                <LockIcon locked={!!el.locked} />
              </button>
              <button type="button" className="ld-layers__toggle" aria-label="Move up" title="Move up" onClick={() => onAction({ kind: 'reorder', id: el.id, dir: 1 })}><ArrowIcon up /></button>
              <button type="button" className="ld-layers__toggle" aria-label="Move down" title="Move down" onClick={() => onAction({ kind: 'reorder', id: el.id, dir: -1 })}><ArrowIcon /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* UI pass, 2026-10: inline SVG instead of the 🔒/🔓 emoji and ●/◌ glyphs, which
 * rendered at different sizes and colours from one Mac to the next (§18: no
 * emoji in UI text). Stroke icons follow `currentColor` like the sidebar's. */
function EyeIcon({ off }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1.5 7S3.5 3 7 3s5.5 4 5.5 4-2 4-5.5 4S1.5 7 1.5 7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="7" cy="7" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      {off ? <path d="M2.5 11.5l9-9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /> : null}
    </svg>
  );
}

function LockIcon({ locked }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3" y="6.25" width="8" height="5.75" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
      <path d={locked ? 'M4.75 6.25V4.5a2.25 2.25 0 014.5 0v1.75' : 'M4.75 6.25V4.5a2.25 2.25 0 014.4-.7'} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon({ up = false }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d={up ? 'M6 10V2.5M3 5.5l3-3 3 3' : 'M6 2v7.5M3 6.5l3 3 3-3'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
