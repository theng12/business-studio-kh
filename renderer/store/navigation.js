// Navigation slice — active module + workspace product id, plus the
// MODULES allowlist + ALWAYS_AVAILABLE gating used by `isModuleAvailable`.

import { flushCompanySwitches } from '../lib/companySwitch.js';

// Whitelist of routable module names. Must stay in sync with PAGES in
// App.jsx — `setActiveModule` rejects anything not in this set.
//
// HISTORICAL FOOTGUN: when v0.10.0 added Overlay Studio I forgot to add
// 'overlay' here, so every click on the sidebar entry was *silently*
// swallowed by the guard in setActiveModule. The page never even
// attempted to render — so the page error boundary added in v0.10.2
// couldn't help. Fixed in v0.10.3, plus a console.warn on unknown
// module names so future regressions are at least visible in devtools.
// v0.26.31: 'history' added — global audit-log feed page.
// v0.49.46: 'suppliers' added — OPERATIONS section Phase 1.
// v0.49.47: 'purchaseorders' + 'costcalc' added — OPERATIONS Phase 2-4.
const MODULES = ['dashboard', 'company', 'brands', 'library', 'workspace', 'export', 'aistudio', 'overlay',
  'labeltemplates', 'labelgenerate', 'barcodes', 'labeljobs', 'catalogtemplates', 'catalogprojects', 'catalogstudio',
  'socialgrid',
  'suppliers', 'purchaseorders', 'costcalc', 'history', 'settings', 'support'];
// Overlay Studio templates are global (not company-scoped), so the module
// stays clickable even when no company has been picked yet — matches the
// header copy inside the module itself.
// v0.26.31: 'history' is also always-available — it reads from the
// global audit_log which doesn't require an active company. Useful
// even before any company has been created (just shows an empty list).
const ALWAYS_AVAILABLE = new Set(['dashboard', 'company', 'settings', 'support', 'overlay', 'history']);

export function createNavigationSlice(set, get) {
  let navigationIntent = 0;

  async function navigate(patch, intent = ++navigationIntent, companyId = get().activeCompanyId) {
    try {
      await flushCompanySwitches();
      if (intent !== navigationIntent || get().activeCompanyId !== companyId) return false;
      set(patch);
      return true;
    } catch (error) {
      get().addToast(`Couldn't leave this editor: ${error.message}`, 'error');
      return false;
    }
  }

  return {
    // — Navigation
    activeModule: 'dashboard',

    // — Workspace context
    activeProductId: null,

    // — v0.49.48: cross-module PO navigation. The Library Cost column +
    // the Suppliers "Orders" button jump into the Purchase Orders module
    // with context. These transient fields carry that context across the
    // module switch; the PO module consumes + clears them on mount.
    //   pendingPoId           → open this PO's detail page directly
    //   pendingPoSupplierId   → open the PO list pre-filtered to this supplier
    pendingPoId: null,
    pendingPoSupplierId: null,
    pendingCatalogProjectId: null,
    pendingCatalogTemplateId: null,
    pendingLibraryProductId: null,

    async setActiveModule(name) {
      if (!MODULES.includes(name)) {
        // Loud-fail in dev/devtools instead of silently dropping the request
        // — the v0.10.0 "Overlay Studio doesn't open" bug was a missing
        // entry here, and the silent return made it invisible. The console
        // line costs nothing in prod and saves hours when a route is
        // mistyped or forgotten.
        // v0.1.25: the message used to say "Update MODULES in store/index.js",
        // which is the wrong file — the allowlist is at the top of THIS file.
        // A breadcrumb that points at the wrong place costs more than none.
        console.warn(`[store] setActiveModule("${name}") ignored — not in the MODULES allowlist at the top of renderer/store/navigation.js. Add it there, or the click keeps doing nothing silently.`);
        return false;
      }
      const intent = ++navigationIntent;
      if (name === get().activeModule) return true;
      return navigate({ activeModule: name }, intent);
    },

    setActiveProductId(id) {
      set({ activeProductId: id });
    },

    /* 0.1.94: `opts.navIds` is the list Image Workspace's ◀ ▶ step through —
     * the Library's filtered + sorted ids at the moment it opened the product,
     * frozen. Stepping the live list lost its place: processing bumps
     * updated_at, so the product jumped to the top, and under an "Unprocessed"
     * filter it dropped out of the list altogether. Any other entry point
     * (Dashboard, AI Studio) passes nothing and the Workspace falls back to the
     * whole company. The Workspace's own ◀ ▶ pass the list they stepped. */
    openProductInWorkspace(productId, opts = {}) {
      const navIds = Array.isArray(opts?.navIds) ? opts.navIds : null;
      return navigate({ activeProductId: productId, activeModule: 'workspace', workspaceNavIds: navIds });
    },
    workspaceNavIds: null,

    // v0.49.48: jump to a specific PO detail (from the Library Cost column).
    openPurchaseOrder(poId) {
      return navigate({ pendingPoId: poId, pendingPoSupplierId: null, activeModule: 'purchaseorders' });
    },
    // v0.49.48: jump to the PO list filtered by a supplier (from Suppliers).
    openPurchaseOrdersForSupplier(supplierId) {
      return navigate({ pendingPoSupplierId: supplierId, pendingPoId: null, activeModule: 'purchaseorders' });
    },
    // Consumed by the PO module once it's read the pending intent.
    clearPendingPoNav() {
      set({ pendingPoId: null, pendingPoSupplierId: null });
    },

    openLibraryProduct(productId, companyId = get().activeCompanyId) {
      return navigate({ pendingLibraryProductId: productId, activeModule: 'library' }, ++navigationIntent, companyId);
    },
    clearPendingLibraryNav() { set({ pendingLibraryProductId: null }); },
    openCatalogProject(projectId, companyId = get().activeCompanyId) {
      return navigate({ pendingCatalogProjectId: projectId, activeModule: 'catalogprojects' }, ++navigationIntent, companyId);
    },
    openCatalogTemplate(templateId, companyId = get().activeCompanyId) {
      return navigate({ pendingCatalogTemplateId: templateId, activeModule: 'catalogtemplates' }, ++navigationIntent, companyId);
    },
    clearPendingCatalogTemplateNav() { set({ pendingCatalogTemplateId: null }); },
    clearPendingCatalogNav() {
      set({ pendingCatalogProjectId: null });
    },

    isModuleAvailable(name) {
      if (ALWAYS_AVAILABLE.has(name)) return true;
      return !!get().activeCompanyId;
    },
  };
}
