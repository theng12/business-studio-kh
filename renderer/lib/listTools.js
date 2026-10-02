/**
 * v0.1.67: the search / sort / selection rules shared by the simple list tabs.
 *
 * Brands, Categories and Suppliers are the same shape — a name, a count, a
 * rename and a delete — so they get the same tools instead of three
 * implementations that drift. This is deliberately NOT a data-table framework:
 * it is the four pure functions those three screens need, so the fiddly part
 * (range selection) can be tested without a DOM.
 *
 * The Product Library keeps its own table; it has images, prices and process
 * state, and generalising over both would cost more than it saves.
 */

/** Case-insensitive "does this row match what was typed", across the given keys. */
export function filterRows(rows, query, keys) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => keys.some((key) => String(row?.[key] ?? '').toLowerCase().includes(q)));
}

/* One collator for every comparison. `localeCompare` with an options object
 * builds a fresh collator per call, which is most of the cost of sorting a
 * long list; `Intl.Collator#compare` with the same options gives the same
 * order without it. */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Name order, ignoring case, and numeric so "Brand 2" sorts before "Brand 10". */
export const byName = (a, b) =>
  NAME_COLLATOR.compare(String(a?.name ?? ''), String(b?.name ?? ''));

/**
 * Sort a copy by one of the screen's own comparators, falling back to name —
 * a stored sort key from an older version must never leave the list unsorted.
 * `extra` carries the screen-specific ones, e.g. most products or most POs.
 */
export function sortRows(rows, sortKey, extra = {}) {
  const comparators = { name: byName, nameDesc: (a, b) => byName(b, a), ...extra };
  const cmp = comparators[sortKey] || byName;
  return [...rows].sort(cmp);
}

/**
 * What a click on row `index` does to the selection.
 *
 *   plain      → that row alone
 *   ⌘/Ctrl     → add or remove that row
 *   Shift      → the range from the last clicked row, added to the selection
 *
 * Returns the new selection and where a following Shift-click should measure
 * from, so a range can be extended by clicking again.
 */
export function nextSelection({ selected = [], ids = [], index, lastIndex = null, shiftKey = false, metaKey = false }) {
  const id = ids[index];
  if (id == null) return { selected: [...selected], lastIndex: lastIndex ?? index };

  if (shiftKey && lastIndex != null && ids[lastIndex] != null) {
    const from = Math.min(index, lastIndex);
    const to = Math.max(index, lastIndex);
    const range = ids.slice(from, to + 1);
    return { selected: Array.from(new Set([...selected, ...range])), lastIndex };
  }
  if (metaKey) {
    const has = selected.includes(id);
    return { selected: has ? selected.filter((x) => x !== id) : [...selected, id], lastIndex: index };
  }
  return { selected: [id], lastIndex: index };
}

/** Every id in view — what "select all" means (the visible rows, not the whole DB). */
export function allIds(rows) {
  return rows.map((row) => row.id);
}
