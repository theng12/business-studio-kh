/**
 * The Library's client-side sort, shared by the table/grid (index.jsx) and
 * "Edit in table" (BulkTableModal), which used to show rows in database order
 * while the Library showed its own sort. Pure.
 *
 * The DB returns rows in `updated_at DESC`; every other order is applied here
 * so a header click needs no IPC round trip. `brandsById` / `categoriesById`
 * let brand/category sort by the resolved NAME, and one numeric collator makes
 * "AV-M81" < "AV-M8101" < "AV-M8200" read the way a person does.
 */
import { priceEntry } from '../../lib/prices.js';

const SORT_GETTERS = {
  sku:       (p) => p.sku ?? '',
  name:      (p) => p.name ?? '',
  brand:     (p, ix) => ix.brand.get(p.brandId)?.name ?? '',
  category:  (p, ix) => ix.category.get(p.categoryId)?.name ?? '',
  color:     (p) => p.colorFinish ?? '',
  images:    (p) => p.imageCount ?? 0,
  updated:   (p) => p.updatedAt ?? 0,
  // 0.1.94: the optional data columns. Missing values return null and always
  // sort LAST, whichever way the column is sorted.
  barcode:   (p) => p.barcode || null,
  retail:    (p) => priceEntry(p, 'retail').amount,
  wholesale: (p) => priceEntry(p, 'wholesale').amount,
  stock:     (p) => (p.stockQty == null || p.stockQty === '' ? null : Number(p.stockQty)),
};

function getterFor(key) {
  if (SORT_GETTERS[key]) return SORT_GETTERS[key];
  if (typeof key === 'string' && key.startsWith('price:')) {
    const group = key.slice('price:'.length);
    return (p) => priceEntry(p, group).amount;
  }
  return null;
}

/* One collator for every comparison. `localeCompare` with an options object
 * builds a fresh collator per call — sorting 2,000 SKUs took ~65 ms that way
 * and ~3.5 ms with this one. Same ordering: numeric, case/accent-insensitive. */
const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortProducts(rows, sort, brandsById = new Map(), categoriesById = new Map()) {
  const getter = getterFor(sort?.key);
  if (!getter) return rows;
  const ix = { brand: brandsById, category: categoriesById };
  const dir = sort.dir === 'desc' ? -1 : 1;
  // Slice first because Array#sort mutates in place — and our caller passes
  // the store's products array which must stay immutable for React.
  return rows.slice().sort((a, b) => {
    const av = getter(a, ix);
    const bv = getter(b, ix);
    if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return SORT_COLLATOR.compare(String(av), String(bv)) * dir;
  });
}

/**
 * 0.1.94: keep the order on screen stable while the user works.
 *
 * With the default "Edited ↓" sort every autosave moved the edited product to
 * the top, so the list reshuffled under the cursor. `previousIds` is the order
 * last shown for the SAME view (company, filters, sort, page); rows already on
 * it keep their place, rows it has never shown (a new product, a remote add)
 * go first, and rows that left the view drop out. A new view (another page,
 * filter or sort, a refresh) starts from a full sort — the caller decides that
 * by passing `previousIds = null`.
 */
export function stableOrder(previousIds, sorted) {
  if (!Array.isArray(previousIds)) return sorted;
  const byId = new Map(sorted.map((p) => [p.id, p]));
  const known = new Set(previousIds);
  const fresh = sorted.filter((p) => !known.has(p.id));
  const kept = [];
  for (const id of previousIds) {
    const row = byId.get(id);
    if (row) kept.push(row);
  }
  return fresh.length === 0 && kept.length === sorted.length && kept.every((p, i) => p === sorted[i])
    ? sorted
    : [...fresh, ...kept];
}

/**
 * 0.1.94: Shift-click range selection. Returns the ids from `anchorId` to
 * `targetId` inclusive, in `orderedIds` order, or just `[targetId]` when the
 * anchor is not in the list.
 */
export function selectionRange(orderedIds, anchorId, targetId) {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (a < 0 || b < 0) return [targetId];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return orderedIds.slice(from, to + 1);
}
