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
      <div className="ld-layers__head">
        <strong>Layers</strong>
        <span>{elements.length} element{elements.length === 1 ? '' : 's'}</span>
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
                className="ld-layers__toggle"
                aria-label={el.visible === false ? 'Show' : 'Hide'}
                title={el.visible === false ? 'Show' : 'Hide'}
                onClick={() => onAction({ kind: 'hide', id: el.id, visible: el.visible === false })}
              >
                {el.visible === false ? '◌' : '●'}
              </button>
              <button
                type="button"
                className="ld-layers__toggle"
                aria-label={el.locked ? 'Unlock' : 'Lock'}
                title={el.locked ? 'Unlock' : 'Lock'}
                onClick={() => onAction({ kind: 'lock', id: el.id, locked: !el.locked })}
              >
                {el.locked ? '🔒' : '🔓'}
              </button>
              <button type="button" className="ld-layers__toggle" aria-label="Move up" title="Move up" onClick={() => onAction({ kind: 'reorder', id: el.id, dir: 1 })}>↑</button>
              <button type="button" className="ld-layers__toggle" aria-label="Move down" title="Move down" onClick={() => onAction({ kind: 'reorder', id: el.id, dir: -1 })}>↓</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
