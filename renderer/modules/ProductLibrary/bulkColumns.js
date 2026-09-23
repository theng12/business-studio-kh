/**
 * v0.1.71 — the bulk table's column catalogue and selection rules.
 *
 * The bulk table already had a column CATALOGUE (one entry per product field,
 * per price-group amount/currency pair, per custom field) and persisted column
 * WIDTHS. This adds *selection*: which of those columns is on screen, in what
 * order, and the named sets that make a view reusable.
 *
 * Three sources of selection, deliberately separate:
 *
 *   1. **Everything** (the historical behaviour, and the default) — every
 *      catalogue column, in catalogue order. `null` selection means this, so a
 *      brand-new custom field still auto-appears until the user opts out.
 *   2. **Built-in sets** — plain data, no storage. Their key lists are a
 *      MEMBERSHIP test: the on-screen order still follows the catalogue.
 *   3. **Saved sets** — company-scoped rows in `bulk_column_sets`, ordered
 *      arrays of keys. Unknown/removed keys are dropped, never fatal.
 *
 * Everything in this module is pure so the rules can be tested without a DOM.
 */
export const COLUMNS_STORAGE_KEY = 'BulkTable.columns';

/**
 * Built-in sets, in menu order. `everything` is the sentinel for "no explicit
 * selection"; the others name keys and are filtered against the live catalogue
 * so a key that the catalogue does not offer (e.g. a price group that was
 * renamed) simply does not appear.
 */
export const BUILTIN_SETS = [
  { key: 'everything', label: 'Everything', all: true },
  { key: 'basics', label: 'Basics', columns: ['sku', 'name', 'brandId', 'categoryId', 'status', 'stockQty'] },
  {
    key: 'prices',
    label: 'Prices',
    columns: ['sku', 'name', 'priceRetail', 'priceRetailCurrency', 'priceWholesale', 'priceWholesaleCurrency'],
    // Every price group's amount + currency column, whichever the company has.
    dynamic: 'prices',
  },
  {
    key: 'logistics',
    label: 'Logistics',
    columns: ['sku', 'name', 'supplierSku', 'hsCode', 'cartonWCm', 'cartonHCm', 'cartonDCm', 'weightPerUnitKg'],
  },
];

/** `null` means Everything (explicit arrays are order-significant). */
export function builtinSetColumns(setKey, catalogueKeys) {
  const set = BUILTIN_SETS.find((s) => s.key === setKey);
  if (!set) return null;
  if (set.all) return [...catalogueKeys];
  const wanted = new Set(set.columns ?? []);
  if (set.dynamic === 'prices') {
    for (const key of catalogueKeys) {
      if (key.startsWith('price:') || key.startsWith('priceCurrency:')) wanted.add(key);
    }
  }
  // Order follows the catalogue: the key list is membership, not order.
  return catalogueKeys.filter((k) => wanted.has(k));
}

/**
 * Turn whatever is in localStorage / a saved row into a usable selection.
 *
 *   - not an array           → `null` (Everything)
 *   - an array               → only keys the catalogue offers, de-duplicated,
 *                              in the stored order (order is the point of a
 *                              hand-arranged view)
 *
 * An empty array stays empty — the user explicitly hid every column.
 */
export function resolveSelection(stored, catalogueKeys) {
  if (!Array.isArray(stored)) return null;
  const available = new Set(catalogueKeys);
  const seen = new Set();
  const out = [];
  for (const raw of stored) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key || seen.has(key) || !available.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The explicit ordered selection for a `null` (Everything) selection. */
export function selectionColumns(selection, catalogueKeys) {
  return resolveSelection(selection, catalogueKeys) ?? [...catalogueKeys];
}

/** True when the selection is exactly the whole catalogue, in catalogue order. */
export function isEverything(selection, catalogueKeys) {
  const list = resolveSelection(selection, catalogueKeys);
  if (list === null) return true;
  return list.length === catalogueKeys.length && list.every((k, i) => k === catalogueKeys[i]);
}

/** Toggle one column on (appended) or off. `null` means Everything. */
export function toggleColumn(selection, key, catalogueKeys) {
  const current = selectionColumns(selection, catalogueKeys);
  return current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
}

/** Move a column one slot up (-1) or down (+1) in the explicit order. */
export function moveColumn(selection, key, dir, catalogueKeys) {
  const current = selectionColumns(selection, catalogueKeys);
  const index = current.indexOf(key);
  if (index === -1) return current;
  const target = index + (dir < 0 ? -1 : 1);
  if (target < 0 || target >= current.length) return current;
  const next = [...current];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * The picker's display order: selected columns in their chosen order first,
 * then every unselected catalogue column in catalogue order. With the default
 * (Everything) selection this is simply the catalogue order, so a fresh table
 * looks exactly as it did before this feature.
 */
export function orderedCatalogue(catalogueKeys, selection) {
  const selected = resolveSelection(selection, catalogueKeys);
  if (selected === null) return [...catalogueKeys];
  const chosen = new Set(selected);
  return [...selected, ...catalogueKeys.filter((k) => !chosen.has(k))];
}

/** How many edited columns are currently hidden (so the toolbar can say so). */
export function hiddenEditedColumns(edits, catalogueKeys, selection) {
  const visible = new Set(selectionColumns(selection, catalogueKeys));
  const hidden = new Set();
  for (const key of Object.keys(edits)) {
    const sep = key.indexOf(':');
    const col = key.slice(sep + 1);
    if (col && !visible.has(col)) hidden.add(col);
  }
  return hidden.size;
}

/* ── localStorage: the last-used selection, instant and offline ───────── */

export function loadColumnSelection() {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveColumnSelection(selection) {
  try {
    // Everything is stored by ABSENCE, so a column added in a later release
    // (a new custom field) still appears for users who never narrowed it.
    if (selection === null || selection === undefined) {
      localStorage.removeItem(COLUMNS_STORAGE_KEY);
    } else {
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(selection));
    }
  } catch { /* storage disabled — the in-memory selection still works */ }
}
