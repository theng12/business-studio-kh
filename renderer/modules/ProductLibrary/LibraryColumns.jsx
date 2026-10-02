import { useEffect, useRef, useState } from 'react';

/**
 * v0.22.7: Library table columns — modular.
 *
 * The user picks which columns are visible via the "Columns" toolbar
 * button. SKU and the thumb stay locked-on (the thumb is the primary
 * visual anchor; SKU is the row identifier — hiding either turns the
 * table into a puzzle). Everything else can be toggled off and the
 * choice persists to localStorage.
 *
 * COLUMN_DEFS is the source of truth. The TableView reads it twice:
 * once for the header row, once for each TableRow's cells. Add a new
 * column → add it here, then add a `<th>` and `<td>` block that checks
 * `visibleCols.has(key)` to render it.
 */
export const COLUMN_DEFS = [
  { key: 'brand',    label: 'Brand',          defaultVisible: true,  optional: true },
  { key: 'name',     label: 'Name',           defaultVisible: true,  optional: true },
  { key: 'category', label: 'Category',       defaultVisible: true,  optional: true },
  { key: 'color',    label: 'Color / Finish', defaultVisible: true,  optional: true },
  { key: 'images',   label: 'Images',         defaultVisible: true,  optional: true },
  // v0.49.48: landed cost from the latest received PO. Default OFF —
  // most users browse the catalog without cost in view, and the data is
  // only present once POs have been received. Opt in via the column
  // picker. The cell click-throughs to the source PO when one exists.
  { key: 'cost',     label: 'Landed cost',    defaultVisible: false, optional: true },
  { key: 'process',  label: 'Process',        defaultVisible: true,  optional: true },
  { key: 'status',   label: 'Status',         defaultVisible: true,  optional: true },
  { key: 'edited',   label: 'Edited',         defaultVisible: true,  optional: true },
];
const COLUMNS_STORAGE_KEY = 'ProductLibrary.visibleColumns';
export function loadVisibleColumns() {
  // localStorage stores a comma-separated list of visible keys. Missing
  // keys fall back to their `defaultVisible`. That way adding a new
  // column in a future release doesn't make the user's existing saved
  // set hide it — they only see the new column off if they actively
  // turned it off.
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) {
      return new Set(COLUMN_DEFS.filter((c) => c.defaultVisible).map((c) => c.key));
    }

    /* v0.1.27: store the OFF list explicitly, as well as the on list.
     *
     * The old format was a plain CSV of the ON keys, and the loader re-added
     * any default-visible column that was "not mentioned". Turning OFF a
     * column that is on by default (Name, SKU …) therefore removed it from the
     * string, which made it look unmentioned, so it came straight back on the
     * next launch — the preference could never be saved. Recording the explicit
     * "off" set fixes that while keeping the same forward-compatible behaviour
     * for columns added in a future version: a key in neither list still takes
     * its default. */
    if (raw.startsWith('v2|')) {
      const [, onPart = '', offPart = ''] = raw.split('|');
      const on = new Set(onPart.split(',').map((x) => x.trim()).filter(Boolean));
      const off = new Set(offPart.split(',').map((x) => x.trim()).filter(Boolean));
      const upgraded = new Set();
      for (const c of COLUMN_DEFS) {
        if (on.has(c.key)) upgraded.add(c.key);
        else if (off.has(c.key)) continue;              // explicitly hidden
        else if (c.defaultVisible) upgraded.add(c.key);  // new column → default
      }
      return upgraded;
    }

    // Legacy v1 value (plain CSV of ON keys) — read it the old way so an
    // existing preference is not lost; it is rewritten in the new format on
    // the next toggle.
    const saved = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
    const next = new Set();
    for (const c of COLUMN_DEFS) {
      if (saved.has(c.key)) next.add(c.key);
      else if (!raw.includes(c.key) && c.defaultVisible) next.add(c.key);
    }
    return next;
  } catch {
    return new Set(COLUMN_DEFS.filter((c) => c.defaultVisible).map((c) => c.key));
  }
}
export function saveVisibleColumns(set) {
  try {
    // v0.1.27: write ON and OFF explicitly — see loadVisibleColumns.
    const on = COLUMN_DEFS.filter((c) => set.has(c.key)).map((c) => c.key);
    const off = COLUMN_DEFS.filter((c) => !set.has(c.key)).map((c) => c.key);
    localStorage.setItem(COLUMNS_STORAGE_KEY, `v2|${on.join(',')}|${off.join(',')}`);
  } catch {}
}

/**
 * v0.22.7: small toolbar control to toggle Library table columns
 * on/off. Closes on outside click + Esc. Anchor button shows the
 * visible-count so the user can tell at a glance which mode they're
 * in (e.g. "Columns · 5/8").
 *
 * v0.1.71: GENERALIZED, not forked. The bulk edit table needed the same
 * picker over its own (larger, dynamic) catalogue, plus reorder arrows and a
 * sets menu. Rather than copy the popover, every part that differed became an
 * optional prop — the Library call site passes none of them, so its markup and
 * behaviour are unchanged:
 *
 *   defs           the catalogue (defaults to COLUMN_DEFS)
 *   label          trigger text override
 *   lockedItems    the pinned "Always shown" rows (default: SKU + Thumbnail)
 *   header         extra node above the list (the bulk table's sets menu)
 *   onMove         when given, each row gets up/down arrows (no drag reorder)
 */
export function ColumnsControl({
  visibleCols,
  onToggle,
  onReset,
  defs = COLUMN_DEFS,
  label,
  lockedItems = [{ label: 'SKU + Thumbnail', note: 'Always shown' }],
  header = null,
  onMove = null,
  resetTitle = 'Show all default columns',
  title = 'Choose which columns appear in the table',
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      // Close if the click landed outside both the popover and the
      // trigger button. The button has its own onClick toggle so we
      // don't want to instantly re-close after it opens.
      const pop = popRef.current;
      const btn = btnRef.current;
      if (pop && !pop.contains(e.target) && btn && !btn.contains(e.target)) {
        setOpen(false);
      }
    };
    // Esc closes the popover only — not the dialog it sits in (the bulk-edit
    // table's Modal listens on window, which this document listener precedes).
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visibleCount = visibleCols.size;
  const totalOptional = defs.length;
  // Reorder arrows belong to the SELECTED rows only, and the bulk table
  // renders selected rows first (see bulkColumns.orderedCatalogue), so the
  // last selected row is at display index selectedCount - 1.
  const selectedCount = defs.filter((c) => visibleCols.has(c.key)).length;

  return (
    <div className="ws-toolbar__group lib-columns">
      <button
        ref={btnRef}
        type="button"
        className={`segment${open ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title={title}
      >
        {label ?? `Columns · ${visibleCount}/${totalOptional}`}
      </button>
      {open ? (
        <div ref={popRef} className="lib-columns__pop" role="menu">
          {header}
          <div className="lib-columns__head">
            <span>Show columns</span>
            <button
              type="button"
              className="lib-columns__reset"
              onClick={() => { onReset(); setOpen(false); }}
              title={resetTitle}
            >Reset</button>
          </div>
          <ul className="lib-columns__list">
            {lockedItems.map((item) => (
              <li key={item.label} className="lib-columns__item lib-columns__item--locked">
                <label>
                  <input type="checkbox" checked disabled />
                  <span>{item.label}</span>
                </label>
                <span className="lib-columns__lock-note">{item.note}</span>
              </li>
            ))}
            {defs.map((c, index) => (
              <li key={c.key} className="lib-columns__item" data-col-key={c.key}>
                <label>
                  <input
                    type="checkbox"
                    checked={visibleCols.has(c.key)}
                    onChange={() => onToggle(c.key)}
                  />
                  <span>{c.label}</span>
                </label>
                {onMove && visibleCols.has(c.key) ? (
                  <span className="lib-columns__move">
                    <button
                      type="button"
                      className="lib-columns__move-btn"
                      disabled={index === 0}
                      aria-label={`Move ${c.label} up`}
                      title="Move up"
                      onClick={() => onMove(c.key, -1)}
                    >↑</button>
                    <button
                      type="button"
                      className="lib-columns__move-btn"
                      disabled={index === selectedCount - 1}
                      aria-label={`Move ${c.label} down`}
                      title="Move down"
                      onClick={() => onMove(c.key, 1)}
                    >↓</button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
