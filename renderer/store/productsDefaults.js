// Shared product-list defaults. Lives in its own module so the
// companies slice can reset filters on company switch without
// importing the whole products slice (which would create a cycle).

export const DEFAULT_FILTERS = {
  search: '',
  brandIds: [],          // [] = all, ['id'] = those, [null] = unassigned, ['id', null] = mix
  categoryIds: [],
  status: null,
  processStatus: null,
  attentionFilter: null, // Dashboard queue: missingBarcode | missingPrice | notExported
  hasImages: null,       // null = all, 'with' = imageCount > 0, 'without' = imageCount === 0
};

// Default sort: most-recently updated first (matches the DB ORDER BY in
// products.list). Switching to any other column does the sorting in the
// renderer so we don't need to round-trip to SQLite on every header click.
export const DEFAULT_SORT = { key: 'updated', dir: 'desc' };

// v0.26.48: persist the user's sort choice across reloads / company
// switches / app restarts. Same pattern as the other UI prefs (grid
// size, column visibility, hover preview). Global key — the user
// said they want their sort choice remembered, period; no
// per-company scoping needed.
//
// Validation on load: the saved key must match one of the columns
// the table/grid actually offers. Old saves pointing at a deprecated
// key fall back to DEFAULT_SORT silently.
const PRODUCT_SORT_STORAGE_KEY = 'ProductLibrary.sort';
// 0.1.94: + the optional data columns (barcode, retail, wholesale, stock) and
// any company price group (`price:<key>`).
const VALID_SORT_KEYS = new Set(['updated', 'sku', 'name', 'brand', 'category', 'color', 'images', 'barcode', 'retail', 'wholesale', 'stock']);
export function isValidSortKey(key) {
  return VALID_SORT_KEYS.has(key) || (typeof key === 'string' && /^price:[^\s]+$/.test(key));
}

export function loadProductSort() {
  try {
    const raw = localStorage.getItem(PRODUCT_SORT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SORT };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SORT };
    const key = isValidSortKey(parsed.key) ? parsed.key : DEFAULT_SORT.key;
    const dir = parsed.dir === 'asc' ? 'asc' : 'desc';
    return { key, dir };
  } catch {
    return { ...DEFAULT_SORT };
  }
}

export function saveProductSort(sort) {
  try {
    localStorage.setItem(PRODUCT_SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch { /* localStorage full / disabled — fall back to in-memory only */ }
}
