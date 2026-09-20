// Companies slice — multi-tenant: company list + active company id +
// CRUD. Switching company triggers refetches in dependent slices.

// v0.26.48: DEFAULT_SORT no longer imported here — sort is now
// persisted globally and survives company switches, so the slice
// doesn't need to reset it. See store/products.js + productsDefaults.js.
import { DEFAULT_FILTERS } from './productsDefaults.js';

export function createCompaniesSlice(set, get) {
  return {
    // — Multi-tenant
    companies: [],
    activeCompanyId: null,

    async refreshCompanies() {
      if (!window.api) return;
      try { set({ companies: await window.api.companies.list() }); }
      catch (err) { get().addToast(err.message, 'error'); }
    },

    async setActiveCompany(id) {
      /* v0.1.28: surface a failure. The server rejects when the company no
       * longer exists, or when a client's link is down — and the caller in the
       * sidebar and the Companies page did not catch, so "Set active" simply
       * did nothing with no explanation. */
      try {
        await window.api.companies.setActive(id);
      } catch (err) {
        get().addToast(`Couldn't switch company: ${err.message}`, 'error');
        return;
      }
      // v0.26.48: preserve the user's persisted sort choice across
      // company switches. Pre-fix this reset productSort to
      // DEFAULT_SORT every time, defeating the localStorage persistence.
      // Filters DO reset (search/brand/category are intrinsically
      // per-company), but sort preference is global UI ergonomics.
      set({
        activeCompanyId: id,
        productFilters: { ...DEFAULT_FILTERS },
        page: 0,
        exportQueueIds: [],
        selectedExportProfileId: null,
      });
      await Promise.all([
        get().refreshBrands(),
        get().refreshCategories(),
        get().refreshProducts(),
        get().refreshAllProducts(),
        get().refreshDashboard(),
        get().refreshExportProfiles(),
        /* v0.1.27: also clear/refill the AI queue.
         *
         * This list omitted aiTasks, and the AI Studio page loads its queue
         * once on mount with an empty dependency list — so after switching
         * company the previous company's tasks (and their prompt text) stayed
         * on screen. Every button on them then failed server-side with "Task
         * belongs to a different company", which was silent until the previous
         * release made those failures raise a toast. */
        get().refreshAiTasks(),
      ]);
    },

    async createCompany(input) {
      const created = await window.api.companies.create(input);
      await get().refreshCompanies();
      // If this is the first company, the main process auto-set it active.
      if (!get().activeCompanyId) {
        const activeId = await window.api.companies.getActiveId();
        if (activeId) await get().setActiveCompany(activeId);
      }
      return created;
    },

    async updateCompany(id, patch) {
      const updated = await window.api.companies.update(id, patch);
      await get().refreshCompanies();
      return updated;
    },

    async removeCompany(id) {
      await window.api.companies.remove(id);
      await get().refreshCompanies();
      const activeId = await window.api.companies.getActiveId();
      set({ activeCompanyId: activeId });
      if (activeId) {
        await Promise.all([
          get().refreshBrands(),
          get().refreshCategories(),
          get().refreshProducts(),
          get().refreshAllProducts(),
          get().refreshDashboard(),
        ]);
      } else {
        set({ brands: [], categories: [], products: [], allProducts: [], dashboardStats: null });
      }
    },
  };
}
