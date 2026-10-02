// Products slice — Library list + the filter-agnostic `allProducts`
// list used by pickers, plus filters/sort/pagination and CRUD.

import { DEFAULT_FILTERS, DEFAULT_SORT, loadProductSort, saveProductSort } from './productsDefaults.js';

/* ─── v0.49.38: client-mode search race-condition guards ──────────
 *
 * Each keystroke in the Library search bar fires `refreshProducts()`,
 * which fires `window.api.products.list(companyId, filters)`. On the
 * server / standalone, the IPC hits a local SQLite query and returns
 * in ~1 ms, so a burst of keystrokes resolves in order. On a client,
 * the IPC goes over HTTP to the server Mac — and HTTP responses are
 * NOT guaranteed to arrive in send order. Typing "2213" used to fire
 * four parallel IPCs ("2", "22", "221", "2213"); whichever response
 * landed LAST won, regardless of which query it answered. So a user
 * would type a search, see the correct 4 rows for a moment, then watch
 * the list grow back to everything as the older partial-query responses
 * trickled in and overwrote the good answer.
 *
 * Two-part fix:
 *
 *   1. `searchDebounceTimer` — debounce setProductSearch so typing
 *      "2213" fires ONE IPC after the user stops, not four. 200 ms is
 *      the sweet spot: feels instant, coalesces normal typing speed.
 *
 *   2. `refreshSeq` / `refreshAllSeq` — sequence counters bumped on
 *      every call. When a response lands, only commit to the store if
 *      the captured sequence is still the LATEST. Older responses are
 *      discarded. Belt-and-braces — covers cases where multiple
 *      refreshes overlap for reasons other than typing (a remote
 *      catalog:changed event arriving while a user-triggered refresh
 *      is in flight, etc.).
 *
 * Module-level vars so the guards survive hot-reload and any future
 * store-slice re-creation. Persisted across React renders by design.
 */
let searchDebounceTimer = null;
let refreshSeq = 0;
let refreshAllSeq = 0;
const refreshRuns = new Map();
const refreshAllRuns = new Map();

/* A product edit refreshes the list itself (`updateProduct` awaits it), and
 * the same edit's `catalog:changed` event scheduled a second refresh 250 ms
 * later that returned the same rows. Each catalog event that touches products
 * bumps `productsInvalidation`; each committed fetch records the number it
 * STARTED after. A scheduled event refresh is skipped only when the current
 * view (and the full list) was fetched after that event — so the redundant
 * echo of our own edit drops out, while an edit from another Mac, which no
 * local fetch has followed, still refreshes. A counter, not a clock, so two
 * things in the same millisecond cannot be misordered. */
let productsInvalidation = 0;
const freshThrough = new Map();     // view key → invalidation its last committed fetch started after
const allFreshThrough = new Map();  // companyId → same, for the filter-agnostic list

function filtersAreDefault(filters) {
  return filters.search === '' &&
    (filters.brandIds == null || filters.brandIds.length === 0) &&
    (filters.categoryIds == null || filters.categoryIds.length === 0) &&
    filters.status == null &&
    filters.processStatus == null &&
    filters.hasImages == null;
}

export function createProductsSlice(set, get) {
  return {
    // — Product data
    products: [],
    // Bumped when a purchase order or supplier changes (here or on another
    // Mac): the Library's Cost column refetches on it.
    poRevision: 0,
    bumpPoRevision() { set((s) => ({ poRevision: s.poRevision + 1 })); },
    // v0.17.0: start true so the Library shows the loading spinner on
    // first paint, not a flash of "No products yet" before the first
    // refresh resolves (especially noticeable in client mode where the
    // RPC takes a beat).
    productsLoading: true,
    productFilters: { ...DEFAULT_FILTERS },
    // v0.26.48: seed sort from localStorage so the user's choice
    // survives reloads, navigation, and app restarts. Falls back to
    // DEFAULT_SORT (recently-updated descending) on first run or if
    // the stored key is no longer in the catalog.
    productSort: loadProductSort(),
    page: 0,
    pageSize: 50,

    /**
     * v0.11.3: filter-agnostic list of every product in the active company.
     * Separate from `products` (which mirrors the Library's filters) so
     * global pickers — AI Studio's source combobox, the Promote-to-product
     * dialog, etc. — can show every product regardless of what's filtered
     * in the Library. Refreshed on company switch and after every product
     * mutation (create / update / delete) alongside `products`.
     */
    allProducts: [],

    /* ─── Filters ─── */

    setProductSearch(search) {
      set((s) => ({ productFilters: { ...s.productFilters, search }, page: 0 }));
      // v0.49.38: debounced refresh. The state above lands instantly
      // so the controlled <input> stays responsive; the IPC fires
      // 200 ms after the LAST keystroke so typing "2213" is one DB
      // query, not four. Without this, on client mode the four
      // parallel responses could land out of order and the last to
      // arrive (often the older, broader query) would overwrite the
      // user's intended search result.
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        get().refreshProducts();
      }, 200);
    },
    toggleBrandFilter(value) {
      // value can be a brand id or null (for unassigned).
      set((s) => {
        const cur = s.productFilters.brandIds ?? [];
        const has = cur.some((v) => v === value);
        const next = has ? cur.filter((v) => v !== value) : [...cur, value];
        return { productFilters: { ...s.productFilters, brandIds: next }, page: 0 };
      });
      get().refreshProducts();
    },
    clearBrandFilter() {
      set((s) => ({ productFilters: { ...s.productFilters, brandIds: [] }, page: 0 }));
      get().refreshProducts();
    },
    // v0.1.67: deterministic "show only unassigned" for the Brands screen's
    // All · Unassigned chip. `toggleBrandFilter(null)` cannot express this —
    // it toggles null against a filter that may already hold brand ids — so
    // the setter resets the other filters and pins brandIds to exactly
    // [null], which is the store's own "unassigned" encoding.
    setBrandFilterUnassigned() {
      set({ productFilters: { ...DEFAULT_FILTERS, brandIds: [null] }, page: 0 });
      get().refreshProducts();
    },
    toggleCategoryFilter(value) {
      set((s) => {
        const cur = s.productFilters.categoryIds ?? [];
        const has = cur.some((v) => v === value);
        const next = has ? cur.filter((v) => v !== value) : [...cur, value];
        return { productFilters: { ...s.productFilters, categoryIds: next }, page: 0 };
      });
      get().refreshProducts();
    },
    clearCategoryFilter() {
      set((s) => ({ productFilters: { ...s.productFilters, categoryIds: [] }, page: 0 }));
      get().refreshProducts();
    },
    // v0.1.67: the Categories screen's All · Uncategorized counterpart.
    setCategoryFilterUnassigned() {
      set({ productFilters: { ...DEFAULT_FILTERS, categoryIds: [null] }, page: 0 });
      get().refreshProducts();
    },
    setStatusFilter(status) {
      set((s) => ({ productFilters: { ...s.productFilters, status }, page: 0 }));
      get().refreshProducts();
    },
    setProcessStatusFilter(processStatus) {
      set((s) => ({ productFilters: { ...s.productFilters, processStatus }, page: 0 }));
      get().refreshProducts();
    },
    setHasImagesFilter(hasImages) {
      // Tri-state: null | 'with' | 'without'. Client-side filter (cheap on the
      // already-fetched list); we just refetch + slice in the renderer.
      set((s) => ({ productFilters: { ...s.productFilters, hasImages }, page: 0 }));
    },
    resetFilters() {
      // v0.26.48: when the user explicitly clicks "Reset filters" we
      // DO reset sort to default — that matches the intent of the
      // button. Also persist the reset to localStorage so a reload
      // after reset doesn't resurface the old saved sort.
      saveProductSort(DEFAULT_SORT);
      set({ productFilters: { ...DEFAULT_FILTERS }, productSort: { ...DEFAULT_SORT }, page: 0 });
      get().refreshProducts();
    },

    /* ─── Sort ─── */

    setProductSort(key) {
      // Clicking the same column toggles direction. Clicking a different
      // column starts in 'asc' for text columns, 'desc' for numeric/date
      // columns so the most-useful values surface first.
      const NUMERIC_DEFAULTS_DESC = new Set(['images', 'updated']);
      set((s) => {
        const prev = s.productSort;
        const nextSort = prev.key === key
          ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: NUMERIC_DEFAULTS_DESC.has(key) ? 'desc' : 'asc' };
        // v0.26.48: persist to localStorage. Same pattern as the
        // other UI prefs (grid card size, view toggle, column
        // visibility, hover preview). Synchronous write inside set()
        // is fine — localStorage.setItem is microseconds.
        saveProductSort(nextSort);
        return { productSort: nextSort, page: 0 };
      });
    },

    /* ─── Pagination ─── */

    setPage(page) { set({ page }); },
    setPageSize(pageSize) { set({ pageSize, page: 0 }); },

    /* ─── Data ─── */

    async refreshProducts() {
      if (!window.api) return;
      const companyId = get().activeCompanyId;
      const filters = get().productFilters;
      const requestedSeq = ++refreshSeq;
      const defaultView = filtersAreDefault(filters);
      // A default-view response also owns allProducts. Invalidate any older
      // filter-agnostic request before awaiting so it cannot overwrite this
      // newer snapshot when it eventually resolves.
      const requestedAllSeq = defaultView || !companyId ? ++refreshAllSeq : null;
      if (!companyId) {
        set({ products: [], allProducts: [], productsLoading: false });
        return;
      }
      const key = JSON.stringify([companyId, filters]);
      const existing = refreshRuns.get(key);
      if (existing) {
        existing.queued = true;
        existing.seq = requestedSeq;
        existing.allSeq = requestedAllSeq;
        return existing.promise;
      }
      const run = { queued: false, seq: requestedSeq, allSeq: requestedAllSeq, promise: null };

      const runOnce = async (seq, allSeq) => {
        // Loading is for a list with nothing to show yet (first load, a
        // company switch — which empties `products` — or a view that is
        // still empty). A background refresh of a list already on screen
        // keeps it, so the Library header doesn't flicker to "Loading…" on
        // every edit or remote change.
        if (get().products.length === 0) set({ productsLoading: true });
        const through = productsInvalidation;
        try {
          const list = await window.api.products.list(companyId, filters);
          if (seq !== refreshSeq || get().activeCompanyId !== companyId) return;
          freshThrough.set(key, through);
          if (defaultView) {
            const ownsAll = allSeq === refreshAllSeq;
            if (ownsAll) allFreshThrough.set(companyId, through);
            set({
              products: list,
              productsLoading: false,
              ...(ownsAll ? { allProducts: list } : {}),
            });
          } else {
            set({ products: list, productsLoading: false });
            await get().refreshAllProducts();
          }
          if (seq !== refreshSeq || get().activeCompanyId !== companyId) return;
          const { page, pageSize } = get();
          const maxPage = Math.max(0, Math.ceil(list.length / pageSize) - 1);
          if (page > maxPage) set({ page: maxPage });
        } catch (err) {
          if (seq !== refreshSeq || get().activeCompanyId !== companyId) return;
          set({ productsLoading: false });
          get().addToast(err.message, 'error');
        }
      };

      run.promise = (async () => {
        do {
          run.queued = false;
          await runOnce(run.seq, run.allSeq);
        } while (run.queued && get().activeCompanyId === companyId &&
          JSON.stringify(get().productFilters) === JSON.stringify(filters));
      })().finally(() => { refreshRuns.delete(key); });
      refreshRuns.set(key, run);
      return run.promise;
    },

    /**
     * v0.11.3: refresh the full, filter-agnostic product list used by
     * AI Studio's source combobox and the Promote-to-product dialog. Calls
     * `products.list(companyId, {})` so the result never depends on whatever
     * the Library currently has filtered. Safe to call alongside
     * `refreshProducts()` — they hit the same IPC but with different
     * arguments.
     */
    async refreshAllProducts() {
      if (!window.api) return;
      if (filtersAreDefault(get().productFilters)) {
        const companyId = get().activeCompanyId;
        const key = JSON.stringify([companyId, get().productFilters]);
        return refreshRuns.get(key)?.promise ?? get().refreshProducts();
      }
      const companyId = get().activeCompanyId;
      const requestedSeq = ++refreshAllSeq;
      if (!companyId) {
        set({ allProducts: [] });
        return;
      }
      const existing = refreshAllRuns.get(companyId);
      if (existing) {
        existing.queued = true;
        existing.seq = requestedSeq;
        return existing.promise;
      }
      const run = { queued: false, seq: requestedSeq, promise: null };

      const runOnce = async (seq) => {
        const through = productsInvalidation;
        try {
          const list = await window.api.products.list(companyId, {});
          if (seq !== refreshAllSeq || get().activeCompanyId !== companyId) return;
          allFreshThrough.set(companyId, through);
          set({ allProducts: list });
        } catch (err) {
          if (seq === refreshAllSeq && get().activeCompanyId === companyId) {
            get().addToast(err.message, 'error');
          }
        }
      };

      run.promise = (async () => {
        do {
          run.queued = false;
          await runOnce(run.seq);
        } while (run.queued && get().activeCompanyId === companyId);
      })().finally(() => { refreshAllRuns.delete(companyId); });
      refreshAllRuns.set(companyId, run);
      return run.promise;
    },

    /** Record that a catalog event touched products; returns its number. */
    noteProductsInvalidated() {
      productsInvalidation += 1;
      return productsInvalidation;
    },

    /**
     * True when both the Library's current view and the full list were
     * fetched (and committed) after invalidation `n` — i.e. a refresh now
     * would return what is already in the store.
     */
    productsFreshThrough(n) {
      const companyId = get().activeCompanyId;
      if (!companyId) return false;
      const key = JSON.stringify([companyId, get().productFilters]);
      return (freshThrough.get(key) ?? 0) >= n && (allFreshThrough.get(companyId) ?? 0) >= n;
    },

    async createProduct(input) {
      const companyId = get().activeCompanyId;
      if (!companyId) throw new Error('Select a company first');
      const created = await window.api.products.create({ ...input, companyId });
      await Promise.all([
        get().refreshProducts(),
        get().refreshDashboard(),
      ]);
      return created;
    },
    async updateProduct(id, patch) {
      const updated = await window.api.products.update(id, patch);
      await get().refreshProducts();
      return updated;
    },
    async removeProduct(id) {
      await window.api.products.remove(id);
      await Promise.all([
        get().refreshProducts(),
        get().refreshDashboard(),
      ]);
    },
  };
}
