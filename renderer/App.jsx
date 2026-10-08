import { lazy, Suspense, useEffect, useState } from 'react';
import { useAppStore } from './store/index.js';
import { Sidebar, NAV, useUserCaps } from './components/Sidebar.jsx';
import { hasAnyCap } from './lib/capabilities.js';
import { ToastHost } from './components/Toast.jsx';
import { Button } from './components/ui.jsx';
import { ProgressOverlay } from './components/ProgressOverlay.jsx';
// v0.26.44: ClientSyncOverlay (the full-window first-sync splash) was
// removed. The sidebar NetworkChip now shows boot-sync progress
// inline — no more blocking modal.
import { ConflictModalHost } from './components/ConflictModal.jsx';
import { ShortcutsModal, shortcutBlocked, modalDialogOpen } from './components/ShortcutsModal.jsx';
import { handleSaveShortcut } from './lib/saveShortcut.js';
import { SearchPalette } from './components/SearchPalette.jsx';
// v0.26.44: RemoteChangesBanner removed. Remote events from other
// Macs now auto-apply silently (debounced via catalogEvents.js so
// bursts coalesce to a single per-slice refetch). Conflict detection
// at save time (v0.17.2) still catches the rare two-people-edited-
// the-same-row case. Users can audit cross-Mac edits via the History
// page.
import { PageErrorBoundary } from './components/PageErrorBoundary.jsx';
import { OfflineBanner } from './components/OfflineBanner.jsx';
// v0.49.31: routes split into eager + lazy. Eager = small modules + likely
// first-paint targets (Dashboard is the default; ProductLibrary is the most
// common landing once a company is picked). Lazy = anything heavy whose
// code shouldn\'t weigh down boot. Net effect on the renderer bundle was
// 1,878 KB → ~870 KB main + 4 separate route chunks. See PageFallback
// below for the loading state that fills the brief async gap while a
// chunk fetches.
//
// Why these picks, specifically:
//   - Dashboard, ProductLibrary: shown immediately on most boots — lazy-
//     loading them just paints a flash of skeleton for no real win.
//   - Companies, Brands, Settings, Support: small modules; the lazy split
//     overhead costs more bytes than it saves.
//   - ImageWorkspace, AIStudio, OverlayStudio, ExportCenter, History:
//     heavy, only visited on demand. Lazy-loading is a pure win — boot
//     is faster, the chunk only downloads when the user actually navigates.
//
// React.lazy() requires a default export, but our modules use named exports
// to keep tree-shaking friendly. The `.then(...)` adapter rewraps them so
// the dynamic import returns `{default: Component}` as React expects.
import { Dashboard } from './modules/Dashboard/index.jsx';
import { Companies } from './modules/Companies/index.jsx';
import { Brands } from './modules/Brands/index.jsx';
import { ProductLibrary } from './modules/ProductLibrary/index.jsx';
import { Settings } from './modules/Settings/index.jsx';
import { Support } from './modules/Support/index.jsx';
// v0.49.46: Suppliers — Phase 1 of the costing system. Eagerly imported
// because it's tiny (a single table + a modal form) and pre-loading is
// cheap.
import { Suppliers } from './modules/Suppliers/index.jsx';
// v0.49.47: Purchase Orders + Cost Calculator — Phases 2-4 of the
// costing system. Lazy-split (PO detail page + line editor pull in
// enough chrome that they earn a chunk; Cost Calculator is small but
// no reason to pull it onto the boot path).
const PurchaseOrders = lazy(() =>
  import('./modules/PurchaseOrders/index.jsx').then((m) => ({ default: m.PurchaseOrders })),
);
const CostCalculator = lazy(() =>
  import('./modules/CostCalculator/index.jsx').then((m) => ({ default: m.CostCalculator })),
);

const ImageWorkspace = lazy(() =>
  import('./modules/ImageWorkspace/index.jsx').then((m) => ({ default: m.ImageWorkspace })),
);
const AIStudio = lazy(() =>
  import('./modules/AIStudio/index.jsx').then((m) => ({ default: m.AIStudio })),
);
const OverlayStudio = lazy(() =>
  import('./modules/OverlayStudio/index.jsx').then((m) => ({ default: m.OverlayStudio })),
);
const ExportCenter = lazy(() =>
  import('./modules/ExportCenter/index.jsx').then((m) => ({ default: m.ExportCenter })),
);
const History = lazy(() =>
  import('./modules/History/index.jsx').then((m) => ({ default: m.History })),
);
const LabelTemplates = lazy(() => import('./modules/LabelStudio/LabelTemplates.jsx').then((m) => ({ default: m.LabelTemplates })));
const LabelGenerate = lazy(() => import('./modules/LabelStudio/LabelGenerate.jsx').then((m) => ({ default: m.LabelGenerate })));
const BarcodeStudio = lazy(() => import('./modules/LabelStudio/BarcodeStudio.jsx').then((m) => ({ default: m.BarcodeStudio })));
const LabelJobs = lazy(() => import('./modules/LabelStudio/LabelJobs.jsx').then((m) => ({ default: m.LabelJobs })));
const CatalogTemplates = lazy(() => import('./modules/CatalogStudio/index.jsx').then((m) => ({ default: m.CatalogTemplates })));
const CatalogProjects = lazy(() => import('./modules/CatalogStudio/index.jsx').then((m) => ({ default: m.CatalogProjects })));
const SocialGrid = lazy(() => import('./modules/SocialGrid/index.jsx').then((m) => ({ default: m.SocialGrid })));
// Fuel F1 + the thin staff list — lazy: only the people who keep fuel records open them.
const FuelOverview = lazy(() => import('./modules/Fuel/FuelOverview.jsx').then((m) => ({ default: m.FuelOverview })));
const FuelAssets = lazy(() => import('./modules/Fuel/FuelAssets.jsx').then((m) => ({ default: m.FuelAssets })));
const FuelFills = lazy(() => import('./modules/Fuel/FuelFills.jsx').then((m) => ({ default: m.FuelFills })));
const FuelTanks = lazy(() => import('./modules/Fuel/FuelTanks.jsx').then((m) => ({ default: m.FuelTanks })));
const FuelPrices = lazy(() => import('./modules/Fuel/FuelPrices.jsx').then((m) => ({ default: m.FuelPrices })));
const FuelReports = lazy(() => import('./modules/Fuel/FuelReports.jsx').then((m) => ({ default: m.FuelReports })));
const Staff = lazy(() => import('./modules/Staff/index.jsx').then((m) => ({ default: m.Staff })));

const PAGES = {
  dashboard: Dashboard,
  company:   Companies,
  brands:    Brands,
  suppliers:      Suppliers,
  purchaseorders: PurchaseOrders,
  costcalc:       CostCalculator,
  library:   ProductLibrary,
  workspace: ImageWorkspace,
  aistudio:  AIStudio,
  overlay:   OverlayStudio,
  export:    ExportCenter,
  labeltemplates: LabelTemplates,
  labelgenerate: LabelGenerate,
  barcodes: BarcodeStudio,
  labeljobs: LabelJobs,
  catalogtemplates: CatalogTemplates,
  catalogprojects: CatalogProjects,
  catalogstudio: CatalogProjects,
  socialgrid: SocialGrid,
  fueloverview: FuelOverview,
  fuelassets: FuelAssets,
  fuelfills: FuelFills,
  fueltanks: FuelTanks,
  fuelprices: FuelPrices,
  fuelreports: FuelReports,
  staff: Staff,
  history:   History,
  settings:  Settings,
  support:   Support,
};

/**
 * v0.49.31: brief loading state shown while a lazy-loaded route chunk fetches.
 * Designed to match the existing app shell — sidebar stays visible (it\'s
 * rendered outside this Suspense boundary), the main content area shows a
 * subtle centred spinner + label. On a local Electron install the chunk
 * fetch resolves in under ~50 ms, so this is rarely visible — it\'s here
 * for completeness, not as a focal point. Reuses the existing `.muted`
 * type style so it blends with the rest of the app\'s loading copy.
 */
function PageFallback() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: 'var(--c-text-subtle)',
        fontSize: 13,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '2px solid currentColor',
          borderTopColor: 'transparent',
          display: 'inline-block',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <span>Loading…</span>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* Derived from the sidebar's own NAV list, so a shortcut can never again be
 * advertised by the sidebar and missing here. Each entry keeps the item's
 * `caps`, because the keyboard must respect the same permissions the nav does —
 * previously ⌘3/⌘4/⌘5 opened modules the sidebar had hidden for this role. */
const SHORTCUTS = (() => {
  const map = {};
  for (const section of NAV) {
    for (const item of section.items || []) {
      if (item.shortcut) map[item.shortcut] = { module: item.id, caps: item.caps };
    }
  }
  return map;
})();

export default function App() {
  const activeModule = useAppStore((s) => s.activeModule);
  const companySwitching = useAppStore((s) => s.companySwitching);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const isModuleAvailable = useAppStore((s) => s.isModuleAvailable);
  /* Same derivation the Sidebar uses, so a keyboard shortcut and the visible nav
   * can never disagree about what this role may open. */
  const appMode = useAppStore((s) => s.appMode);
  // Narrow selectors, never the whole `clientConnection` object: main pushes
  // that object on every RPC, and subscribing to it re-rendered the shell and
  // the active page per request. `useUserCaps` returns a stable array, so the
  // shortcut effect below keeps its keydown listener between pushes.
  const clientStatus = useAppStore((s) => s.clientConnection?.status);
  const userCaps = useUserCaps();
  /* v0.1.31: is this Mac a client that has not been pointed at a server yet?
   * That is a SETUP step, not a fault — but every request fails until it is
   * done, and the failure appeared as a red error on each screen in turn. One
   * banner that says what to do beats a wall of identical errors.
   *
   * Driven by the main process's LIVE connection state, not by the mirrored
   * config value. The mirror is only refreshed on bootstrap, so it stayed ''
   * after the address was typed — which made the banner sit there forever,
   * including after a successful connection. Main pushes `unconfigured` on
   * every poll tick while there is no address and stops the moment there is
   * one, so this clears itself. */
  const clientUnconfigured = appMode === 'client' && clientStatus === 'unconfigured';
  const bootstrap = useAppStore((s) => s.bootstrap);
  const platform = useAppStore((s) => s.platform);
  const [ready, setReady] = useState(false);
  // v0.18.0: shortcuts modal toggled via Cmd/Ctrl+? — discovery hook
  // for everything the keyboard can do in the app.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // v0.18.2: global search palette toggled via Cmd/Ctrl+K.
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    bootstrap().finally(() => setReady(true));
  }, [bootstrap]);

  useEffect(() => {
    const onKey = (e) => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!cmdOrCtrl || e.altKey) return;
      // 0.1.95: ⌘S saves the editor on screen (renderer/lib/saveShortcut.js);
      // not under a modal dialog. The browser default is always prevented.
      if (handleSaveShortcut(e, { dialogOpen: modalDialogOpen(document) })) return;
      // v0.18.0: Cmd/Ctrl + ? opens the shortcuts list. The `?` key
      // typically requires Shift on US keyboards, so we accept either
      // with Shift held OR the literal key '?' (some layouts produce
      // it without). `/` is the unshifted physical key on US layout
      // so we also accept Cmd+Shift+/.
      //
      // v0.1.89: these two may CLOSE their own panel from anywhere, but do
      // not open on top of another modal dialog.
      const dialogOpen = modalDialogOpen(document);
      if (e.key === '?' || (e.shiftKey && (e.key === '/' || e.key === '?'))) {
        e.preventDefault();
        setShortcutsOpen((v) => (v ? false : !dialogOpen));
        return;
      }
      // v0.18.2: Cmd/Ctrl + K opens the search palette.
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setSearchOpen((v) => (v ? false : !dialogOpen));
        return;
      }
      if (e.shiftKey) return;
      const shortcut = SHORTCUTS[e.key];
      if (!shortcut) return;
      // v0.1.89: never switch pages under an open dialog or while typing —
      // the page change unmounts the form and the typing is lost.
      if (shortcutBlocked(e.target, document)) return;
      const { module: target, caps } = shortcut;
      if (!isModuleAvailable(target)) return;
      // Capability gate, matching the sidebar: a shortcut must not reach a
      // module this role cannot see.
      if (!hasAnyCap(userCaps, caps)) return;
      e.preventDefault();
      setActiveModule(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveModule, isModuleAvailable, userCaps]);

  const Page = PAGES[activeModule] ?? Dashboard;
  const isMac = platform === 'darwin';

  return (
    <div className="shell">
      <Sidebar onSearch={() => { if (!modalDialogOpen(document)) setSearchOpen(true); }} />
      <main className="shell__content" inert={companySwitching ? '' : undefined} aria-busy={companySwitching || undefined}>
        <div className={`titlebar${isMac ? ' titlebar--mac' : ''}`} />
        {clientUnconfigured ? (
          <div className="setup-banner" role="status">
            <strong>This Mac is set to Client mode but has no server address yet.</strong>
            <span>
              Nothing can load until it knows which Mac holds the data. Enter the server
              address and user token in Settings &rarr; Multi-Mac, or switch back to Standalone
              if this Mac should use its own data folder.
            </span>
            <Button variant="primary" onClick={() => setActiveModule('settings')}>Open Settings</Button>
          </div>
        ) : null}
        <OfflineBanner />
        {ready ? (
          <PageErrorBoundary pageKey={activeModule}>
            {/* v0.49.31: Suspense INSIDE the error boundary so a chunk-
                load failure surfaces through PageErrorBoundary\'s "we hit
                a snag" UI instead of an unstyled crash. The fallback only
                renders while a lazy route fetches; eager routes render
                synchronously. */}
            <Suspense fallback={<PageFallback />}>
              <Page />
            </Suspense>
          </PageErrorBoundary>
        ) : null}
      </main>
      <ToastHost />
      <ProgressOverlay />
      {/* v0.26.44: ClientSyncOverlay + RemoteChangesBanner removed.
          Sync progress moved to the sidebar NetworkChip (less
          intrusive — user can keep working while data loads).
          Remote-change auto-apply replaced the Refresh banner. */}
      <ConflictModalHost />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
