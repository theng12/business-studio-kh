// Companies slice — multi-tenant: company list + active company id +
// CRUD. Switching company triggers refetches in dependent slices.

// v0.26.48: DEFAULT_SORT no longer imported here — sort is now
// persisted globally and survives company switches, so the slice
// doesn't need to reset it. See store/products.js + productsDefaults.js.
import { DEFAULT_FILTERS } from './productsDefaults.js';
import { flushCompanySwitches } from '../lib/companySwitch.js';

let switchSeq = 0;
let switchChain = Promise.resolve();
let pendingSwitches = 0;
let reconcileSeq = 0;

function companyContextPatch(id) {
  return {
    activeCompanyId: id ?? null,
    productFilters: { ...DEFAULT_FILTERS },
    page: 0,
    brands: [],
    brandsLoading: !!id,
    categories: [],
    products: [],
    allProducts: [],
    productsLoading: !!id,
    dashboardStats: null,
    dashboardRecentBrands: [],
    dashboardRecentProducts: [],
    dashboardCompleteness: null,
    exportProfiles: [],
    exportQueueIds: [],
    selectedExportProfileId: null,
    exportLastResult: null,
    aiPrompts: [],
    aiTasks: [],
    aiGalleryByProduct: {},
    aiSourceProductId: null,
    aiSourceImagePath: null,
    activeProductId: null,
    workspaceImages: [],
    workspaceImageIndex: 0,
    workspaceProductSku: '',
    workspaceProductName: '',
    pendingPoId: null,
    pendingPoSupplierId: null,
    pendingCatalogProjectId: null,
    pendingCatalogTemplateId: null,
    pendingLibraryProductId: null,
    pendingLabelProducts: null,
    pendingCatalogProducts: null,
  };
}

function refreshCompanyData(get) {
  return Promise.all([
    get().refreshBrands(),
    get().refreshCategories(),
    get().refreshProducts(),
    get().refreshDashboard(),
    get().refreshExportProfiles(),
    get().refreshAiPrompts(),
    get().refreshAiTasks(),
  ]);
}

export function createCompaniesSlice(set, get) {
  return {
    // — Multi-tenant
    companies: [],
    activeCompanyId: null,
    companySwitching: false,

    async refreshCompanies() {
      if (!window.api) return;
      try { set({ companies: await window.api.companies.list() }); }
      catch (err) { get().addToast(err.message, 'error'); }
    },

    applyActiveCompanyContext(id) {
      if ((id ?? null) !== get().activeCompanyId) {
        set(companyContextPatch(id));
        // The exchange rate is per company; a boot or switch must never keep
        // showing the previous company's figure.
        void get().refreshHouseRate();
      }
    },

    async setActiveCompany(id) {
      const seq = ++switchSeq;
      pendingSwitches += 1;
      const write = switchChain.then(async () => {
        await flushCompanySwitches();
        set({ companySwitching: true });
        return window.api.companies.setActive(id);
      });
      switchChain = write.catch(() => {});
      /* v0.1.28: surface a failure. The server rejects when the company no
       * longer exists, or when a client's link is down — and the caller in the
       * sidebar and the Companies page did not catch, so "Set active" simply
       * did nothing with no explanation. */
      try {
        await write;
      } catch (err) {
        pendingSwitches -= 1;
        if (seq !== switchSeq) return;
        get().addToast(`Couldn't switch company: ${err.message}`, 'error');
        try {
          const activeId = await window.api.companies.getActiveId();
          if (seq === switchSeq) {
            get().applyActiveCompanyContext(activeId);
            await refreshCompanyData(get);
          }
        } catch (_) { /* keep the last known context */ }
        if (seq === switchSeq) set({ companySwitching: false });
        return;
      }
      pendingSwitches -= 1;
      if (seq !== switchSeq) return;
      // v0.26.48: preserve the user's persisted sort choice across
      // company switches. Pre-fix this reset productSort to
      // DEFAULT_SORT every time, defeating the localStorage persistence.
      // Filters DO reset (search/brand/category are intrinsically
      // per-company), but sort preference is global UI ergonomics.
      get().applyActiveCompanyContext(id);
      set({ companySwitching: false });
      await refreshCompanyData(get);
    },

    async reconcileActiveCompany() {
      const seq = ++reconcileSeq;
      const switchAtStart = switchSeq;
      const switchWasPending = pendingSwitches > 0;
      const id = await window.api.companies.getActiveId();
      if (seq !== reconcileSeq || switchAtStart !== switchSeq || switchWasPending || pendingSwitches > 0) return;
      get().applyActiveCompanyContext(id);
      await Promise.all([get().refreshCompanies(), refreshCompanyData(get)]);
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
      get().applyActiveCompanyContext(activeId);
      await refreshCompanyData(get);
    },
  };
}
