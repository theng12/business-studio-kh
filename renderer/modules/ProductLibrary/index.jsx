import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Pagination } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Lightbox } from '../../components/Lightbox.jsx';
import { ProductForm } from './ProductForm.jsx';
import { AutoMatchModal } from './AutoMatchModal.jsx';
import { DuplicateMergeModal } from './DuplicateMergeModal.jsx';
import { ImportModal } from './ImportModal.jsx';
import { ProcessDestinationModal } from '../../components/ProcessDestinationModal.jsx';
import { BulkEditModal } from './BulkEditModal.jsx';
// v0.1.66: spreadsheet-style bulk edit table — real cells, Excel paste, and
// photos pasted into the dedicated Image cell. Opened from the bulk
// "Image operations" menu below.
import { BulkTableModal } from './BulkTableModal.jsx';
import { BulkProductsAIRunModal } from './BulkProductsAIRunModal.jsx';
import { BulkOverlayRunModal } from './BulkOverlayRunModal.jsx';
import { BulkSocialRunModal } from './BulkSocialRunModal.jsx';
// v0.49.34: the combined "Convert · compress · resize" modal was split into
// three independent modals — one knob per tool. Same backend IPC; the
// renderer just gates which form fields each modal exposes.
import { BulkConvertModal } from './BulkConvertModal.jsx';
import { BulkCompressModal } from './BulkCompressModal.jsx';
import { BulkResizeModal } from './BulkResizeModal.jsx';
import { AutoCropRunModal } from './AutoCropRunModal.jsx';
import { BulkBgRemovalModal } from './BulkBgRemovalModal.jsx';
import { AutoEnhanceRunModal } from './AutoEnhanceRunModal.jsx';
import { confirmWithBackup } from '../../components/BackupReminder.jsx';
import { TableView } from './LibraryTable.jsx';
import {
  GridView,
  GridSortControl,
  GridSizeControl,
  GRID_SIZE_OPTIONS,
  GRID_SIZE_STORAGE_KEY,
  loadGridSize,
} from './LibraryGrid.jsx';
import {
  ColumnsControl,
  COLUMN_DEFS,
  loadVisibleColumns,
  saveVisibleColumns,
} from './LibraryColumns.jsx';
import { PROCESS_STATUS_OPTIONS, STATUS_OPTIONS } from './libraryConstants.js';
// v0.1.72: pure directional hover-intent test for the bulk menu's submenus.
import { pointsTowardRect } from './menuIntent.mjs';

/**
 * v0.26.23: persist the Table/Grid view toggle across navigation.
 * The Library module unmounts when the user navigates to another
 * tab (Settings, AI Studio, etc.) and re-mounts on return, so
 * `useState('table')` was resetting the view to Table every single
 * time. Same pattern as gridSize / hoverPreview / panelVisible
 * already used: load from localStorage on init, save on change.
 * Falls back to 'table' for fresh installs.
 */
const VIEW_STORAGE_KEY = 'ProductLibrary.view';
function loadView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === 'table' || v === 'grid') return v;
  } catch {}
  return 'table';
}
function saveView(v) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch {}
}

/**
 * v0.12.3: the hover-cycle behavior (cycle through every image on a
 * multi-image card when the user hovers it) is now a user preference.
 * Default remains 'on' so the v0.10.6 behavior is preserved for users
 * who like it. The +N badge that shows multi-image count is independent
 * of this setting and always visible.
 *
 * Stored via localStorage and read at mount; flipping it in Settings
 * takes effect the next time the user opens the Library (the module
 * re-mounts on navigation).
 */
const HOVER_PREVIEW_STORAGE_KEY = 'ProductLibrary.hoverPreview';
export function loadHoverPreview() {
  try {
    const v = localStorage.getItem(HOVER_PREVIEW_STORAGE_KEY);
    if (v === 'off') return false;
    if (v === 'on') return true;
  } catch {}
  return true;
}
export function saveHoverPreview(on) {
  try { localStorage.setItem(HOVER_PREVIEW_STORAGE_KEY, on ? 'on' : 'off'); } catch {}
}

/**
 * v0.22.1: side panel visibility preference. v0.10.7 made the
 * Library's right-side detail panel always-mounted so users could
 * keep product details visible while browsing — but there was no
 * way to retract it short of pressing Esc. The "always visible"
 * behavior eats ~480px of horizontal width, which gets cramped on
 * smaller MacBook displays.
 *
 * Now this is a user preference toggleable from the Library
 * toolbar. Persists in localStorage so the choice survives
 * relaunches. On fresh installs, defaults to OFF when the
 * viewport is narrower than 1400px (small displays); ON
 * otherwise (preserves the v0.10.7 behavior on big screens).
 */
const PANEL_VISIBLE_STORAGE_KEY = 'ProductLibrary.panelVisible';
function loadPanelVisible() {
  try {
    const v = localStorage.getItem(PANEL_VISIBLE_STORAGE_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch {}
  // v0.1.67: ONE state now backs the FILTER column (and, with it, the
  // detail panel — see togglePanel). The filter column must default
  // open at every window size: the old viewport-based default existed
  // only to give the 480px detail panel room on a 13" screen, and
  // leaving first-run filters collapsed would hide the very controls
  // this feature is about. The user retracts it deliberately.
  return true;
}
function savePanelVisible(on) {
  try { localStorage.setItem(PANEL_VISIBLE_STORAGE_KEY, on ? 'on' : 'off'); } catch {}
}

/**
 * v0.1.67: per-group open/closed state for the Library filter column.
 * One key holds a `{ [label]: boolean }` map; a group missing from the
 * map is OPEN, so the default is exactly the pre-v0.1.67 behaviour and
 * a corrupt/absent value degrades to "everything open". Same
 * localStorage load-on-init / save-on-change pattern as
 * PANEL_VISIBLE_STORAGE_KEY above and the sidebar's closed sections.
 */
const FILTER_GROUPS_STORAGE_KEY = 'ProductLibrary.filterGroups';
function loadFilterGroups() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTER_GROUPS_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function saveFilterGroups(map) {
  try { localStorage.setItem(FILTER_GROUPS_STORAGE_KEY, JSON.stringify(map)); } catch {}
}

/**
 * Client-side sort for the Library. The DB already returns rows in
 * `updated_at DESC` order; switching to any other column re-sorts in-memory
 * so we don't need a separate IPC roundtrip for every header click.
 *
 * `brandsById` / `categoriesById` let us sort by the *resolved name* of the
 * lookup (so "MACEPRO" sorts under M, not by the brand's UUID). We use
 * a numeric collator (SORT_COLLATOR) so SKUs like "AV-M8101", "AV-M81",
 * "AV-M8200" sort the way a human reads them rather than lexicographically.
 */
const SORT_GETTERS = {
  sku:      (p) => p.sku ?? '',
  name:     (p) => p.name ?? '',
  brand:    (p, ix) => ix.brand.get(p.brandId)?.name ?? '',
  category: (p, ix) => ix.category.get(p.categoryId)?.name ?? '',
  color:    (p) => p.colorFinish ?? '',
  images:   (p) => p.imageCount ?? 0,
  updated:  (p) => p.updatedAt ?? 0,
};

/* One collator for every comparison. `localeCompare` with an options object
 * builds a fresh collator per call — sorting 2,000 SKUs took ~65 ms that way
 * and ~3.5 ms with this one. Same ordering: numeric, case/accent-insensitive. */
const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortProducts(rows, sort, brandsById, categoriesById) {
  const getter = SORT_GETTERS[sort.key];
  if (!getter) return rows;
  const ix = { brand: brandsById, category: categoriesById };
  const dir = sort.dir === 'desc' ? -1 : 1;
  // Slice first because Array#sort mutates in place — and our caller passes
  // the store's products array which must stay immutable for React.
  return rows.slice().sort((a, b) => {
    const av = getter(a, ix);
    const bv = getter(b, ix);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return SORT_COLLATOR.compare(String(av), String(bv)) * dir;
  });
}

export function ProductLibrary() {
  const products = useAppStore((s) => s.products);
  const loading = useAppStore((s) => s.productsLoading);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const filters = useAppStore((s) => s.productFilters);
  const sort = useAppStore((s) => s.productSort);
  const page = useAppStore((s) => s.page);
  const pageSize = useAppStore((s) => s.pageSize);
  const setProductSearch = useAppStore((s) => s.setProductSearch);
  const toggleBrandFilter = useAppStore((s) => s.toggleBrandFilter);
  const clearBrandFilter = useAppStore((s) => s.clearBrandFilter);
  const toggleCategoryFilter = useAppStore((s) => s.toggleCategoryFilter);
  const clearCategoryFilter = useAppStore((s) => s.clearCategoryFilter);
  const setStatusFilter = useAppStore((s) => s.setStatusFilter);
  const setProcessStatusFilter = useAppStore((s) => s.setProcessStatusFilter);
  const setHasImagesFilter = useAppStore((s) => s.setHasImagesFilter);
  const setProductSort = useAppStore((s) => s.setProductSort);
  const resetFilters = useAppStore((s) => s.resetFilters);
  const setPage = useAppStore((s) => s.setPage);
  const setPageSize = useAppStore((s) => s.setPageSize);
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  // v0.11.2: "Process →" in the Library opens a small router modal asking
  // whether to take the product to Image Workspace or AI Studio. The
  // store actions below cover both paths; the modal calls one of them.
  const setAiSourceProduct = useAppStore((s) => s.setAiSourceProduct);

  const [editing, setEditing] = useState(null); // product or 'new' or null
  // v0.26.23: seed from localStorage so the user's choice survives
  // module unmount/remount on tab switches. Wrap setView so the
  // value is written back on every change — single source of truth.
  const [view, setViewRaw] = useState(loadView);
  const setView = (v) => { setViewRaw(v); saveView(v); };
  const [gridSize, setGridSize] = useState(loadGridSize); // 'compact' | 'comfortable' | 'roomy' | 'large'
  // v0.22.1: side-panel visibility toggle. When OFF the right
  // column is removed from the layout grid, freeing ~480px of
  // horizontal width — crucial on smaller MacBook displays.
  // v0.1.67: this ONE boolean now backs the filter column too. The
  // filter column collapses to a narrow rail instead of vanishing, and
  // the detail panel follows it — so "Hide filters" always yields the
  // grid maximum width, and the toolbar button and the panel's own
  // chevron can never disagree about the state.
  // ponytail: ceiling — the filter rail and the 480px detail panel share
  // this boolean, so you cannot retract the filters while keeping the
  // detail panel. Splitting them would mean a second state and a second
  // toolbar control; do that only if someone asks for it.
  const [panelVisible, setPanelVisible] = useState(loadPanelVisible);
  function togglePanel() {
    setPanelVisible((prev) => {
      const next = !prev;
      savePanelVisible(next);
      // Keep the editing state untouched on toggle: hiding +
      // re-showing the panel keeps the user on the same product
      // instead of forcing them to re-click.
      return next;
    });
  }
  // v0.1.67: per-group open/closed state, persisted in localStorage.
  const [filterGroups, setFilterGroups] = useState(loadFilterGroups);
  const isGroupOpen = (label) => filterGroups[label] !== false;
  function toggleFilterGroup(label) {
    setFilterGroups((prev) => {
      const next = { ...prev, [label]: prev[label] === false };
      saveFilterGroups(next);
      return next;
    });
  }
  // v0.1.67: ⌘/Ctrl+B retracts the filter column, mirroring the
  // sidebar's collapse control. Bound here (not in App.jsx) because it
  // only means anything on this screen, and it must respect the same
  // single `panelVisible` state the two buttons use.
  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'b' && e.key !== 'B') return;
      e.preventDefault();
      setPanelVisible((prev) => {
        const next = !prev;
        savePanelVisible(next);
        return next;
      });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // v0.12.3: respect the user's hover-preview preference. Read once on
  // mount — if the user flips it in Settings, navigating back here
  // re-mounts the module and picks up the new value.
  const [hoverPreview] = useState(loadHoverPreview);
  const [autoMatchOpen, setAutoMatchOpen] = useState(false);
  const [dedupOpen, setDedupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [lightbox, setLightbox] = useState(null); // { product, images, startIndex } | null
  // The product the user just clicked "Process →" for. The destination
  // router modal owns the actual route choice (Workspace or AI Studio).
  const [processingProduct, setProcessingProduct] = useState(null);
  // v0.18.1: multi-select for bulk edit. Stored as a Set of product
  // ids; the toolbar appears as soon as the set is non-empty.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  // v0.1.66: the bulk edit table modal.
  const [bulkTableOpen, setBulkTableOpen] = useState(false);
  // v0.22.0: bulk AI run modal + bulk delete confirm state.
  const [bulkAiOpen, setBulkAiOpen] = useState(false);
  // v0.26.15: Overlay Studio bulk-apply modal. Same toolbar
  // position as the AI bulk modal so the two batch surfaces are
  // discoverable side-by-side.
  const [bulkOverlayOpen, setBulkOverlayOpen] = useState(false);
  // v0.1.62: apply a Social Grid template to selected products / the filter.
  const [bulkSocialOpen, setBulkSocialOpen] = useState(false);
  const [socialApplyProductId, setSocialApplyProductId] = useState(null);
  // v0.49.34: three independent bulk modals replace the combined
  // "Convert · compress · resize" — same backend, focused UIs.
  const [bulkConvertOpen, setBulkConvertOpen] = useState(false);
  const [bulkCompressOpen, setBulkCompressOpen] = useState(false);
  const [bulkResizeOpen, setBulkResizeOpen] = useState(false);
  // v0.37.0: batch auto-crop-to-product modal (trim + uniform reframe).
  const [autoCropOpen, setAutoCropOpen] = useState(false);
  // v0.38.0: bulk background-removal modal (clean white bg on main image).
  const [bulkBgOpen, setBulkBgOpen] = useState(false);
  // v0.40.0: bulk auto-enhance modal (white-balance + levels + saturation).
  const [autoEnhanceOpen, setAutoEnhanceOpen] = useState(false);
  // v0.26.16: when the user picks "Overlay Studio" from the Process
  // router (single-product Process button on a row / side panel),
  // we stash the single product id so the BulkOverlayRunModal
  // opens with productIds=[id] instead of the multi-select array.
  // Cleared when the modal closes.
  const [overlayApplyProductId, setOverlayApplyProductId] = useState(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // v0.22.7: which table columns the user wants visible. Persisted to
  // localStorage. Read by TableView when rendering the header + each
  // row; the data the columns *display* still comes from the products
  // slice, this only controls which cells render.
  const [visibleCols, setVisibleCols] = useState(loadVisibleColumns);
  function toggleColumn(key) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveVisibleColumns(next);
      return next;
    });
  }
  function resetColumns() {
    const next = new Set(COLUMN_DEFS.filter((c) => c.defaultVisible).map((c) => c.key));
    saveVisibleColumns(next);
    setVisibleCols(next);
  }

  // v0.49.48: landed-cost map for the Cost column. Keyed by productId →
  // { latestLandedCostUsd, latestPoId, ... }. Fetched in one bulk call,
  // only when the Cost column is actually visible (skip the query
  // otherwise). Re-fetched when the product set changes, since a PO
  // received elsewhere updates these numbers.
  const [productCosts, setProductCosts] = useState(() => new Map());
  const poRevision = useAppStore((s) => s.poRevision);
  const costColumnVisible = visibleCols.has('cost');

  /**
   * v0.22.0: bulk delete with a clear danger confirm. Same
   * cascade behavior as single-row delete — DB rows go via the
   * normal ON DELETE CASCADE chain, on-disk asset folders are
   * rm-rf'd, and ai-gallery files are unlinked. No undo.
   */
  /**
   * v0.22.0: bulk delete with a clear danger confirm. Same
   * cascade behavior as single-row delete — DB rows go via the
   * normal ON DELETE CASCADE chain, on-disk asset folders are
   * rm-rf'd, and ai-gallery files are unlinked. No undo.
   *
   * v0.1.85: two changes after the owner reported an accidental product
   * delete. The button is no longer in the toolbar row next to "Image
   * operations" — it is the only item in a "⋯ More ▾" menu — and the confirm
   * now requires the word DELETE to be typed. The asset folders go to the
   * Trash rather than being erased (main/util/fileTrash.js), so the pictures
   * can be put back; the product entries still cannot.
   */
  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const ok = await confirmWithBackup({
      title: `Delete ${ids.length} product${ids.length === 1 ? '' : 's'}?`,
      message: 'The products, their images, their AI generations and their metadata are removed from the library.',
      detail:
        'They are not gone yet: they wait in Settings → Recently deleted, with their photos, and one click '
        + 'puts each one back exactly as it was. After the keep window they leave that list and their files '
        + "go to the Mac's Trash.", 
      danger: true,
      confirmLabel: `Delete ${ids.length}`,
      requireText: 'DELETE',
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      const res = await window.api.products.bulkRemove(ids);
      const failedCount = res?.failed?.length ?? 0;
      if (failedCount === 0) {
        useAppStore.getState().addToast(`Deleted ${res.deleted} product${res.deleted === 1 ? '' : 's'} — restore from Settings → Recently deleted if that was a mistake.`, 'success');
      } else {
        useAppStore.getState().addToast(
          `Deleted ${res.deleted} of ${ids.length} — ${failedCount} failed.`,
          'info',
        );
      }
      clearSelection();
      useAppStore.getState().refreshProducts();
      useAppStore.getState().refreshAllProducts?.();
      useAppStore.getState().refreshDashboard?.();
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    } finally {
      setBulkDeleting(false);
    }
  }

  // Stable identities: both reach memoized TableRow / GridCard, and a fresh
  // function each render re-rendered every visible row on every keystroke.
  const toggleSelected = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setManySelected = useCallback((ids, on) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  function clearSelection() { setSelectedIds(new Set()); }

  // Persist the grid-size choice so it survives reloads. localStorage write
  // is cheap (synchronous string set) — fine inside an effect.
  useEffect(() => {
    try { localStorage.setItem(GRID_SIZE_STORAGE_KEY, gridSize); } catch {}
  }, [gridSize]);

  const gridCardMinPx = useMemo(
    () => (GRID_SIZE_OPTIONS.find((o) => o.value === gridSize) ?? GRID_SIZE_OPTIONS[1]).px,
    [gridSize],
  );
  // The detail panel is ALWAYS mounted now (per the user's request to keep
  // product details persistently visible). These derived flags tell the
  // panel which mode to render: empty placeholder, new-product form, or
  // edit-existing-product form.
  const isCreatingProduct = editing === 'new';
  /* v0.1.27: a counter so "+ New product" always means "start a NEW blank form".
   *
   * The handler was `setEditing('new')`, which is a no-op when `editing` is
   * already `'new'` — React sees no state change, nothing re-renders, and the
   * panel kept showing the product that had just been created. The next Save
   * then updated THAT product instead of creating another. Incrementing a
   * counter alongside gives ProductForm something new to react to. */
  const [createNonce, setCreateNonce] = useState(0);
  const editingProduct = isCreatingProduct ? null : editing;
  const selectedProductId = editingProduct?.id ?? null;

  /* v0.1.11: this used to be an early `return` HERE, which made every hook
   * declared below it conditional — React requires the same hooks in the same
   * order on every render, so switching to (or away from) a company with no
   * active selection changed the hook count and React errored out. The flag is
   * computed here and the empty state now renders from inside the single main
   * return, below all hooks. */
  const noCompanySelected = !activeCompanyId;

  const brandsById = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);
  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  // v0.49.48: pull the bulk landed-cost map for the Cost column. Gated on
  // the column being visible + a company being active. `products.length`
  // in the deps means it refreshes after imports / deletes, and poRevision
  // (bumped by a purchaseOrder / supplier catalog event) after a PO changes
  // here or on another Mac.
  useEffect(() => {
    if (!activeCompanyId || !costColumnVisible) return;
    let cancelled = false;
    window.api.purchaseOrders.listProductCosts(activeCompanyId)
      .then((list) => {
        if (cancelled) return;
        const map = new Map();
        for (const c of (Array.isArray(list) ? list : [])) map.set(c.productId, c);
        setProductCosts(map);
      })
      .catch(() => { if (!cancelled) setProductCosts(new Map()); });
    return () => { cancelled = true; };
  }, [activeCompanyId, costColumnVisible, products.length, poRevision]);

  const openPurchaseOrder = useAppStore((s) => s.openPurchaseOrder);

  // Client-side hasImages filter + sort applied to the SQL result. This way
  // the SQL stays simple and toggling a sort header doesn't roundtrip to
  // SQLite. The sort is stable (preserves DB order within equal keys).
  //
  // `Number(p.imageCount)` coerces BigInt / string-shaped counts safely.
  // better-sqlite3 normally returns integers as Number, but rows that
  // round-tripped through some JSON paths can come back as strings — and
  // strict equality `"0" === 0` is false, which is what was breaking the
  // "No images" filter for users with certain DB states.
  const filteredAndSorted = useMemo(() => {
    let arr = products;
    if (filters.hasImages === 'with')    arr = arr.filter((p) => Number(p.imageCount ?? 0) > 0);
    if (filters.hasImages === 'without') arr = arr.filter((p) => Number(p.imageCount ?? 0) === 0);
    return sortProducts(arr, sort, brandsById, categoriesById);
  }, [products, filters.hasImages, sort, brandsById, categoriesById]);

  const total = filteredAndSorted.length;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const currentPage = Math.min(page, maxPage);
  const pageStart = currentPage * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, total);
  const visible = filteredAndSorted.slice(pageStart, pageEnd);

  const brandFilterEmpty = !filters.brandIds || filters.brandIds.length === 0;
  const categoryFilterEmpty = !filters.categoryIds || filters.categoryIds.length === 0;
  const hasActiveFilters =
    filters.search !== '' ||
    !brandFilterEmpty ||
    !categoryFilterEmpty ||
    filters.status !== null ||
    filters.processStatus !== null ||
    filters.hasImages !== null;

  async function handleDownloadSample() {
    try {
      const saved = await window.api.samples.generateProductSheet();
      if (saved) useAppStore.getState().addToast(`Saved to ${saved}`, 'success');
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    }
  }

  // v0.36.0: export the whole catalog as a CSV/feed (generic / Shopify /
  // Google Shopping). The IPC returns the CSV text; we trigger a download
  // client-side (works on desktop AND the iPad web viewer). Prepend a UTF-8
  // BOM so Excel opens Khmer/Unicode names correctly.
  async function handleExportCsv(format) {
    if (!format) return;
    try {
      const res = await window.api.exports.catalogCsv(activeCompanyId, format);
      if (!res || !res.csv) { useAppStore.getState().addToast('Nothing to export', 'info'); return; }
      const blob = new Blob(['﻿' + res.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.filename || 'catalog.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      useAppStore.getState().addToast(`Exported ${res.count} product${res.count === 1 ? '' : 's'} (${format})`, 'success');
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    }
  }

  // Stable row handlers so memoized rows don't re-render on every parent
  // state change (filter typing, page change, etc.). Without useCallback the
  // arrow functions get a fresh identity each render, defeating React.memo.
  // Re-clicking the open product keeps the panel as it is: a fresh row object
  // would re-run the form's reset and replace what is on screen.
  const handleOpen = useCallback((p) => setEditing((cur) => (
    cur && cur !== 'new' && p && cur.id === p.id ? cur : p
  )), []);
  const startNewProduct = useCallback(() => {
    setEditing('new');
    setCreateNonce((n) => n + 1);
  }, []);
  // "Process →" now opens a small destination picker — Image Workspace or
  // AI Studio. The actual store call happens inside the modal callbacks
  // below. Kept the function name + signature so existing call sites
  // (table row, side panel footer) don't need to change.
  const handleProcess = useCallback((p) => setProcessingProduct(p), []);

  const goToWorkspace = useCallback(() => {
    if (!processingProduct) return;
    openProductInWorkspace(processingProduct.id);
    setProcessingProduct(null);
  }, [processingProduct, openProductInWorkspace]);

  const goToAiStudio = useCallback(() => {
    if (!processingProduct) return;
    setAiSourceProduct(processingProduct.id);
    // Note: the module key is `aistudio` (no hyphen, no space) — same as
    // in store/index.js MODULES allowlist. v0.11.2 shipped with the wrong
    // 'ai' name which silently no-op'd (the allowlist guard logged a
    // console.warn but nothing visible happened in the UI).
    setActiveModule('aistudio');
    setProcessingProduct(null);
  }, [processingProduct, setAiSourceProduct, setActiveModule]);

  // v0.26.16: third option from the Process router — open the
  // Overlay Studio apply modal pre-targeted at this product. Reuses
  // the same BulkOverlayRunModal as the bulk-toolbar path, with a
  // single-product productIds array so the scope toggle naturally
  // shows "Selected (1)". The user can flip to "Current Library
  // filter" inside the modal if they change their mind.
  const goToOverlay = useCallback(() => {
    if (!processingProduct) return;
    // Stash the single product id so the modal mounts with it.
    setOverlayApplyProductId(processingProduct.id);
    setProcessingProduct(null);
    setBulkOverlayOpen(true);
  }, [processingProduct]);

  // v0.1.62: fourth destination — Social Grid. Same trick as the overlay
  // route: hand the modal a single-product productIds array so it mounts on
  // "Selected (1)" and the user can widen it from there.
  const goToSocial = useCallback(() => {
    if (!processingProduct) return;
    setSocialApplyProductId(processingProduct.id);
    setProcessingProduct(null);
    setBulkSocialOpen(true);
  }, [processingProduct]);

  // Thumbnail click → open the lightbox with all the product's images.
  // We hit IPC at click time (rather than preloading every product's image
  // list) so a 500-product library doesn't carry image arrays in memory.
  const handlePreview = useCallback(async (p, startIndex = 0) => {
    try {
      const images = await window.api.images.listByProduct(p.id);
      if (!images || images.length === 0) {
        useAppStore.getState().addToast('No images on this product yet', 'info');
        return;
      }
      setLightbox({
        product: p,
        images,
        startIndex,
      });
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    }
  }, []);

  // Stable props for the memoized TableRow (onOpenCost) and ProductForm (the
  // rest) — an inline arrow here re-rendered every row and the whole panel on
  // each Library render.
  const handleOpenCost = useCallback((poId) => { if (poId) openPurchaseOrder(poId); }, [openPurchaseOrder]);
  const closePanel = useCallback(() => setEditing(null), []);
  // v0.26.13: side-panel thumbs open the same Lightbox the row/grid thumbs do.
  // ProductForm only knows the index — Library owns the Lightbox state and
  // fetches the image list via handlePreview's existing IPC path.
  const previewEditing = useMemo(
    () => (editingProduct ? (startIndex) => handlePreview(editingProduct, startIndex) : null),
    [editingProduct, handlePreview],
  );
  /* Duplicate jumps the panel to the copy. `editing` is this screen's own
   * selection; the store's activeProductId (which Duplicate used to set) is the
   * Image Workspace's product, so the panel stayed on the original. Fetch the
   * full row — the panel reads every field and the concurrency token from it. */
  const handleDuplicated = useCallback(async (created) => {
    try {
      const full = await window.api.products.get(created.id);
      setEditing(full ?? created);
    } catch {
      setEditing(created);
    }
  }, []);

  return (
    <div className="page page--library">
      {noCompanySelected ? (
        <div className="page">
          <PageHeader title="Product Library" />
          <EmptyState
            title="No company selected"
            body="Create or select a company before adding products."
            action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Company</Button>}
          />
        </div>
      ) : null}
      {/* UI pass, 2026-10: the header carries only page-level actions
          (secondary menus, then the one primary at the far right); the
          search · view · filters · columns controls moved to the house
          `.toolbar` row underneath (docs/UI_GUIDE.md). Import-ish actions
          share one "Import" menu and the CSV feeds an "Export" menu, which
          replaces the old bare "CSV…" select. */}
      <PageHeader
        title="Product Library"
        subtitle={loading
          ? 'Loading…'
          : `${total} product${total === 1 ? '' : 's'}${hasActiveFilters ? ' (filtered)' : ''}`}
        actions={
          <>
            <Button onClick={() => setDedupOpen(true)}>Merge duplicates…</Button>
            <HeaderMenu
              label="Import"
              items={[
                { label: 'Import Excel/CSV…', hint: 'Add or update products from a spreadsheet.', onClick: () => setImportOpen(true) },
                { label: 'Download sample', hint: 'A workbook with every column this company uses.', onClick: handleDownloadSample },
                { label: 'Auto-match images…', hint: 'Match a folder of photos to products by SKU.', onClick: () => setAutoMatchOpen(true) },
              ]}
            />
            {/* v0.36.0: catalog CSV / marketplace feed export. */}
            <HeaderMenu
              label="Export"
              title="Export the whole catalog as a CSV / marketplace feed"
              items={[
                { label: 'Catalog CSV', hint: 'Every product with its fields.', onClick: () => handleExportCsv('generic') },
                { label: 'Shopify CSV', hint: 'Shopify product import format.', onClick: () => handleExportCsv('shopify') },
                { label: 'Google Shopping feed', hint: 'Google Merchant Center format.', onClick: () => handleExportCsv('google') },
              ]}
            />
            <Button variant="primary" onClick={startNewProduct}>+ New product</Button>
          </>
        }
      />

      <div className="toolbar lib-toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="search-input"
            /* v0.49.37: dropped the misleading "tags" hint — tags
               haven't been part of the Library search since v0.26.49
               when the scope narrowed to (sku, name, color_finish).
               Now the placeholder matches what actually gets searched. */
            placeholder="Search SKU, name, color…"
            aria-label="Search products"
            value={filters.search}
            onChange={(e) => setProductSearch(e.target.value)}
          />
        </div>
        {view === 'grid' ? (
          <>
            <GridSortControl sort={sort} onSort={setProductSort} />
            <GridSizeControl value={gridSize} onChange={setGridSize} />
          </>
        ) : null}
        <div className="toolbar__spacer" />
        <div className="segments" role="group" aria-label="View">
          <button
            type="button"
            className={`segment${view === 'table' ? ' is-active' : ''}`}
            onClick={() => setView('table')}
            title="Table view"
            aria-pressed={view === 'table'}
          >Table</button>
          <button
            type="button"
            className={`segment${view === 'grid' ? ' is-active' : ''}`}
            onClick={() => setView('grid')}
            title="Grid view"
            aria-pressed={view === 'grid'}
          >Grid</button>
        </div>
        {/* v0.22.1: side-panel show/hide. Persists in
            localStorage. Defaults OFF on narrow first-load
            viewports (<1400px) so small MacBook screens
            don't feel squashed.
            v0.1.67: the same boolean retracts the FILTER column
            to a rail (and the detail panel with it), so the
            tooltip names the filter column — the width win is
            the point. The panel header has a twin control. */}
        <button
          type="button"
          className={`lib-toolbar-btn lib-panel-toggle${panelVisible ? ' is-active' : ''}`}
          onClick={togglePanel}
          title={panelVisible
            ? 'Hide filters for a bigger view (⌘B)'
            : 'Show filters (⌘B)'}
          aria-label={panelVisible ? 'Hide filters' : 'Show filters'}
          aria-pressed={panelVisible}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 3.5h11l-4.25 5v4l-2.5 1.25V8.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          <span>Filters</span>
        </button>
        {view === 'table' ? (
          // v0.22.7: column picker — only meaningful for the
          // table view (grid card content is curated). Lives in
          // a small popover; closes on outside click + Esc.
          <ColumnsControl
            visibleCols={visibleCols}
            onToggle={toggleColumn}
            onReset={resetColumns}
          />
        ) : null}
        {/* v0.26.21: manual refresh affordance. Catalog events
            already auto-refresh from server-driven changes, but a
            manual button is good for two reasons: (1) a peace-of-
            mind "give me the latest" button users expect, (2) a
            cheap escape hatch if any auto-refresh path ever
            misses an edge case (like the AI-promote updated_at
            bug fixed in this same release). Refreshes the same
            slices the catalog dispatcher does. */}
        <RefreshButton />
      </div>

      <div className={`lib-layout${panelVisible ? ' lib-layout--has-panel' : ' lib-layout--filters-collapsed'}`}>
        <aside className={`lib-filters${panelVisible ? '' : ' is-collapsed'}`} aria-label="Filters">
          {/* v0.1.67: the filter column's own retract control, mirroring
              Sidebar.jsx's collapse button: chevron flips direction,
              title/aria-label flips too, aria-pressed tracks the
              collapsed state, and it is always visible — collapsed
              leaves this rail and the chevron is the way back. It
              shares the ONE `panelVisible` boolean with the toolbar
              button, so the two can never disagree. */}
          <div className="lib-filters__head">
            <button
              type="button"
              className="lib-filters__collapse"
              onClick={togglePanel}
              title={panelVisible
                ? 'Hide filters for a bigger view (⌘B)'
                : 'Show filters (⌘B)'}
              aria-label={panelVisible
                ? 'Hide filters for a bigger view'
                : 'Show filters'}
              aria-pressed={!panelVisible}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d={panelVisible ? 'M10 4 6 8l4 4' : 'M6 4l4 4-4 4'}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {panelVisible ? <span className="lib-filters__title">Filters</span> : null}
          </div>

          {panelVisible ? (
            <div className="lib-filters__body">
              {/* v0.1.67: reset moved from the bottom of the column to
                  the top, directly under the search box, so it is
                  reachable without scrolling past every brand. */}
              {hasActiveFilters ? (
                <button type="button" className="lib-filters__reset" onClick={resetFilters}>
                  Reset all filters
                </button>
              ) : null}

              <FilterGroup label="Brand" open={isGroupOpen('Brand')} onToggle={() => toggleFilterGroup('Brand')} canClear={!brandFilterEmpty} onClear={clearBrandFilter}>
                {brands.map((b) => (
                  <FilterPill
                    key={b.id}
                    active={(filters.brandIds ?? []).includes(b.id)}
                    onClick={() => toggleBrandFilter(b.id)}
                  >{b.name}</FilterPill>
                ))}
                <FilterPill
                  active={(filters.brandIds ?? []).includes(null)}
                  onClick={() => toggleBrandFilter(null)}
                >Unassigned</FilterPill>
              </FilterGroup>

              <FilterGroup label="Category" open={isGroupOpen('Category')} onToggle={() => toggleFilterGroup('Category')} canClear={!categoryFilterEmpty} onClear={clearCategoryFilter}>
                {categories.map((c) => (
                  <FilterPill
                    key={c.id}
                    active={(filters.categoryIds ?? []).includes(c.id)}
                    onClick={() => toggleCategoryFilter(c.id)}
                  >{c.name}</FilterPill>
                ))}
                <FilterPill
                  active={(filters.categoryIds ?? []).includes(null)}
                  onClick={() => toggleCategoryFilter(null)}
                >Uncategorized</FilterPill>
              </FilterGroup>

              <FilterGroup label="Status" open={isGroupOpen('Status')} onToggle={() => toggleFilterGroup('Status')}>
                <FilterPill active={filters.status === null} onClick={() => setStatusFilter(null)}>Any</FilterPill>
                {STATUS_OPTIONS.map((o) => (
                  <FilterPill
                    key={o.value}
                    active={filters.status === o.value}
                    onClick={() => setStatusFilter(o.value)}
                  >{o.label}</FilterPill>
                ))}
              </FilterGroup>

              <FilterGroup label="Process status" open={isGroupOpen('Process status')} onToggle={() => toggleFilterGroup('Process status')}>
                <FilterPill active={filters.processStatus === null} onClick={() => setProcessStatusFilter(null)}>Any</FilterPill>
                {PROCESS_STATUS_OPTIONS.map((o) => (
                  <FilterPill
                    key={o.value}
                    active={filters.processStatus === o.value}
                    onClick={() => setProcessStatusFilter(o.value)}
                  >{o.label}</FilterPill>
                ))}
              </FilterGroup>

              <FilterGroup label="Images" open={isGroupOpen('Images')} onToggle={() => toggleFilterGroup('Images')}>
                <FilterPill active={filters.hasImages === null} onClick={() => setHasImagesFilter(null)}>Any</FilterPill>
                <FilterPill active={filters.hasImages === 'with'} onClick={() => setHasImagesFilter('with')}>With images</FilterPill>
                <FilterPill active={filters.hasImages === 'without'} onClick={() => setHasImagesFilter('without')}>No images</FilterPill>
              </FilterGroup>
            </div>
          ) : null}
        </aside>

        <section className="lib-main">
          {/* v0.17.0: distinguish "loading first batch" from "empty
             catalog". Without this, the EmptyState briefly flashes
             on every Library mount before products arrive — most
             noticeable on client mode where the first refresh
             round-trips the network. */}
          {loading && total === 0 ? (
            <div className="lib-loading">
              <div className="lib-loading__spinner" aria-hidden="true" />
              <div className="lib-loading__label">Loading products…</div>
            </div>
          ) : total === 0 ? (
            <EmptyState
              title={hasActiveFilters ? 'No products match these filters' : 'No products yet'}
              body={hasActiveFilters
                ? 'Try resetting filters or adjusting the search.'
                : 'Create your first product to get started.'}
              action={
                hasActiveFilters ? (
                  <Button onClick={resetFilters}>Reset filters</Button>
                ) : (
                  <Button variant="primary" onClick={startNewProduct}>+ New product</Button>
                )
              }
            />
          ) : (
            <>
              {selectedIds.size > 0 ? (
                <div className="lib-bulk-toolbar">
                  <span className="lib-bulk-toolbar__count">
                    {selectedIds.size} selected
                  </span>
                  <div className="lib-bulk-toolbar__spacer" />
                  {/* UI pass, 2026-10: the count lives once, in "N selected";
                      the buttons no longer repeat it, so the bar fits a
                      ~560px column without wrapping its labels.
                      v0.49.30: toolbar shape:
                       AI Studio  →  Image operations ▾  |  Edit fields  |  Delete N  |  Clear
                      AI Studio stays its own top-level button — it has cost
                      + provider-queue implications that don\'t belong in
                      the same menu as free local sharp passes.
                      Image operations groups the six free local image-
                      changing bulk modals (bg removal, auto-crop / reframe,
                      auto-enhance, re-encode, apply overlay), split inside
                      the menu by destructive vs non-destructive so the user
                      sees which actions overwrite originals before clicking.
                      Edit fields is metadata-only — stays its own button.
                      Delete + Clear stay inline (destructive affordance / escape). */}
                  <Button onClick={() => setBulkAiOpen(true)} disabled={bulkDeleting} title="Queues a paid OpenAI image generation for each — confirms cost before running.">
                    AI Studio…
                  </Button>
                  <BulkActionsMenu
                    label="Image operations ▾"
                    disabled={bulkDeleting}
                    sections={[
                      {
                        label: 'Non-destructive · original kept',
                        items: [
                          { label: 'Remove background',  hint: 'Cutout via @imgly. Adds the result as a new image and promotes it to main; original demotes to #2.', onClick: () => setBulkBgOpen(true) },
                          { label: 'Apply overlay',      hint: 'Composite an Overlay template onto the main image. Defaults to Append (new image); Replace main is opt-in.', onClick: () => setBulkOverlayOpen(true) },
                          { label: 'Social post',        hint: 'Render a Social Grid template from these products into one or more post-sized images (saved to a folder, and optionally kept as a Social Grid post).', onClick: () => setBulkSocialOpen(true) },
                        ],
                      },
                      {
                        label: 'Destructive · overwrites originals',
                        items: [
                          {
                            // v0.49.45 — renamed from "Auto-crop / reframe"
                            // because the side-panel per-image Reframe button
                            // is the actual reframe tool (better controls).
                            // This bulk action is the trim-edges-and-resize
                            // automation; reframe is what the user does
                            // manually per image. Clearer names: bulk = "Auto
                            // crop", side panel = "Reframe".
                            label: 'Auto crop',
                            hint: 'Trim background edges and recompose to a uniform fill. For precise per-image reframe, open the side panel.',
                            onClick: () => setAutoCropOpen(true),
                          },
                          { label: 'Enhance',             hint: 'White-balance + auto-levels + saturation. Rewrites the source file in place.', onClick: () => setAutoEnhanceOpen(true) },
                          // v0.49.34: three focused tools instead of one combined modal.
                          { label: 'Convert format',      hint: 'Re-encode images as JPEG, PNG or WebP — choose which in the dialog.', onClick: () => setBulkConvertOpen(true) },
                          { label: 'Compress',            hint: 'Re-encode at a chosen quality, keep the existing format. Shrinks file size without renaming.', onClick: () => setBulkCompressOpen(true) },
                          { label: 'Resize',              hint: 'Change pixel dimensions — cap the long edge, or set exact W × H with a fit mode and (for Contain) a background colour.', onClick: () => setBulkResizeOpen(true) },
                        ],
                      },
                      {
                        // v0.1.66: the spreadsheet grid. Placed here because
                        // that is where the owner asked for it — it is the
                        // one bulk surface that pastes photos as well as text.
                        label: 'Table',
                        items: [
                          {
                            label: 'Edit in table',
                            hint: 'Spreadsheet-style grid: type or paste a block of cells across many products, and paste a photo into the Image cell (Add or Make main — never overwrites). Nothing is written until you confirm the Save all summary.',
                            onClick: () => setBulkTableOpen(true),
                          },
                        ],
                      },
                    ]}
                  />
                  <Button onClick={() => setBulkEditOpen(true)} disabled={bulkDeleting} title="Bulk-update metadata fields (brand, category, status, etc.) — doesn’t touch the image bytes.">
                    Edit fields…
                  </Button>
                  {/* v0.1.85: Delete used to sit right here, a red button beside
                      "Image operations" — which is how a product got deleted by
                      someone reaching for an image action. It is now the only
                      item behind this menu, twice removed from anything else,
                      and the confirm needs DELETE typed. */}
                  <BulkActionsMenu
                    variant="default"
                    searchable={false}
                    label="⋯ More ▾"
                    disabled={bulkDeleting}
                    sections={[
                      {
                        label: 'Danger',
                        items: [
                          {
                            label: `Delete ${selectedIds.size} product${selectedIds.size === 1 ? '' : 's'}…`,
                            hint: 'Removes the products with their images and AI generations. They wait in Settings → Recently deleted so you can put them back. You will be asked to type DELETE to confirm.',
                            danger: true,
                            onClick: handleBulkDelete,
                          },
                        ],
                      },
                    ]}
                  />
                  <Button variant="ghost" onClick={clearSelection} disabled={bulkDeleting}>Clear</Button>
                </div>
              ) : null}
              {view === 'table' ? (
                <TableView
                  rows={visible}
                  brandsById={brandsById}
                  categoriesById={categoriesById}
                  onOpen={handleOpen}
                  onProcess={handleProcess}
                  onPreview={handlePreview}
                  sort={sort}
                  onSort={setProductSort}
                  selectedProductId={selectedProductId}
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                  onToggleAllVisible={(on) => setManySelected(visible.map((p) => p.id), on)}
                  visibleCols={visibleCols}
                  productCosts={productCosts}
                  onOpenCost={handleOpenCost}
                />
              ) : (
                <GridView
                  rows={visible}
                  brandsById={brandsById}
                  onOpen={handleOpen}
                  onPreview={handlePreview}
                  selectedProductId={selectedProductId}
                  cardMinPx={gridCardMinPx}
                  hoverPreview={hoverPreview}
                  // v0.26.48: bulk-select wired into grid cards. Same
                  // selectedIds Set the table view uses, same toggle
                  // callback. The bulk toolbar at the top of the page
                  // (Edit selected / AI / Overlay / Delete) reacts to
                  // selection from either view interchangeably.
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                />
              )}

              <Pagination
                total={total}
                pageStart={pageStart}
                pageEnd={pageEnd}
                currentPage={currentPage}
                maxPage={maxPage}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </>
          )}
        </section>

        {panelVisible ? (
          <ProductForm
            product={editingProduct}
            isCreating={isCreatingProduct}
            createKey={createNonce}
            onClose={closePanel}
            onStartCreate={startNewProduct}
            onProcess={handleProcess}
            onPreview={previewEditing}
            onDuplicated={handleDuplicated}
          />
        ) : null}
      </div>

      <AutoMatchModal open={autoMatchOpen} onClose={() => setAutoMatchOpen(false)} />
      <DuplicateMergeModal open={dedupOpen} onClose={() => setDedupOpen(false)} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />

      <BulkEditModal
        open={bulkEditOpen}
        count={selectedIds.size}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkEditOpen(false)}
        onDone={() => { setBulkEditOpen(false); clearSelection(); }}
      />

      <BulkTableModal
        open={bulkTableOpen}
        productIds={Array.from(selectedIds)}
        filters={filters}
        onClose={() => setBulkTableOpen(false)}
        onDone={() => { setBulkTableOpen(false); clearSelection(); }}
      />

      <BulkProductsAIRunModal
        open={bulkAiOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkAiOpen(false)}
        onDone={() => { setBulkAiOpen(false); /* keep selection so user can re-queue if needed */ }}
      />

      <BulkOverlayRunModal
        open={bulkOverlayOpen}
        // v0.26.16: when the Process router routed a single product
        // here, that id wins over the multi-select. Otherwise we use
        // the toolbar's selected ids as before.
        productIds={overlayApplyProductId ? [overlayApplyProductId] : Array.from(selectedIds)}
        filters={filters}
        onClose={() => { setBulkOverlayOpen(false); setOverlayApplyProductId(null); }}
        onDone={() => { setBulkOverlayOpen(false); setOverlayApplyProductId(null); }}
      />

      <BulkSocialRunModal
        open={bulkSocialOpen}
        productIds={socialApplyProductId ? [socialApplyProductId] : Array.from(selectedIds)}
        onClose={() => { setBulkSocialOpen(false); setSocialApplyProductId(null); }}
        onDone={() => { setBulkSocialOpen(false); setSocialApplyProductId(null); }}
      />

      <AutoCropRunModal
        open={autoCropOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setAutoCropOpen(false)}
        onDone={() => setAutoCropOpen(false)}
      />

      <BulkBgRemovalModal
        open={bulkBgOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkBgOpen(false)}
        onDone={() => setBulkBgOpen(false)}
      />

      <AutoEnhanceRunModal
        open={autoEnhanceOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setAutoEnhanceOpen(false)}
        onDone={() => setAutoEnhanceOpen(false)}
      />

      {/* v0.49.34: three independent modals replace the combined
          BulkReencodeModal. All three call images:reencodeProducts; the
          renderer side just constrains which knobs each surfaces. */}
      <BulkConvertModal
        open={bulkConvertOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkConvertOpen(false)}
        onDone={() => setBulkConvertOpen(false)}
      />
      <BulkCompressModal
        open={bulkCompressOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkCompressOpen(false)}
        onDone={() => setBulkCompressOpen(false)}
      />
      <BulkResizeModal
        open={bulkResizeOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkResizeOpen(false)}
        onDone={() => setBulkResizeOpen(false)}
      />

      <ProcessDestinationModal
        open={processingProduct !== null}
        product={processingProduct}
        onClose={() => setProcessingProduct(null)}
        onPickWorkspace={goToWorkspace}
        onPickAiStudio={goToAiStudio}
        onPickOverlay={goToOverlay}
        onPickSocial={goToSocial}
      />

      <Lightbox
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
        images={lightbox?.images ?? []}
        startIndex={lightbox?.startIndex ?? 0}
        title={lightbox ? (lightbox.product.name
          ? `${lightbox.product.sku} · ${lightbox.product.name}`
          : lightbox.product.sku) : null}
        // v0.26.14: pass productId so the Lightbox can offer the
        // Flip H / Flip V buttons (destructive — rewrites the source
        // file). When the user flips, we splice the updated image row
        // back into the open lightbox's `images` array so the rest
        // of the strip stays consistent without a re-fetch.
        productId={lightbox?.product?.id ?? null}
        onImageMutated={(updated) => {
          setLightbox((prev) => {
            if (!prev || !updated?.filepath) return prev;
            const next = prev.images.map((img) =>
              img.filepath === updated.filepath ? { ...img, ...updated } : img,
            );
            return { ...prev, images: next };
          });
        }}
      />
    </div>
  );
}

function FilterGroup({ label, open = true, onToggle, canClear, onClear, children }) {
  return (
    <div className="filter-group">
      <div className="filter-group__head">
        {/* v0.1.67: the whole label is the collapse toggle (a bigger hit
            target than a bare chevron), with aria-expanded carrying the
            state for screen readers and the static wiring test. */}
        <button
          type="button"
          className="filter-group__toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label} filters`}
        >
          <span className="filter-group__label">{label}</span>
          <svg
            className={`filter-group__chevron${open ? '' : ' is-closed'}`}
            width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"
          >
            <path d="m2 3 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {canClear ? (
          <button type="button" className="filter-group__clear" onClick={onClear}>Clear</button>
        ) : null}
      </div>
      {open ? <div className="filter-group__items">{children}</div> : null}
    </div>
  );
}

function FilterPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={`filter-pill${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}


/**
 * UI pass, 2026-10: a plain one-level dropdown for the page header
 * ("Import ▾", "Export ▾"). Same look and behaviour as the side panel's
 * "Copy ▾" / "⋯" menus (`.copy-menu`): click toggles, Esc or a click
 * outside closes, each item runs and closes. The two-level
 * BulkActionsMenu below stays for the bulk toolbar, where its search and
 * submenus earn their keep.
 */
function HeaderMenu({ label, title, items }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="copy-menu lib-header-menu" ref={rootRef}>
      <Button
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
        <svg className="lib-header-menu__caret" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {open ? (
        <div className="copy-menu__panel" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              className="copy-menu__item"
              role="menuitem"
              onClick={() => { setOpen(false); it.onClick(); }}
            >
              <span className="copy-menu__label">{it.label}</span>
              {it.hint ? <span className="copy-menu__hint">{it.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * v0.26.21: manual Refresh button for the Library header. The store
 * already auto-refreshes via the catalog-event bus, but a manual
 * button is two things at once: (1) the muscle-memory "give me the
 * latest" affordance users expect from any data-driven page, (2) a
 * cheap escape hatch when an auto-refresh path silently misses a
 * change (like the AI promote `updated_at` bug fixed alongside this
 * button — that bug existed because we forgot one `touchUpdated`
 * call; future similar misses are recoverable in one click).
 *
 * Refreshes the same slices the catalog dispatcher does for
 * `kind: 'images'` + `kind: 'product'`: products, allProducts,
 * brands, categories, dashboard. The spin animation runs for a
 * minimum of 600ms even if the IPC returns faster — gives the user
 * positive feedback that the click did something rather than
 * flashing on-and-off in < 50ms on a local DB hit.
 */
function RefreshButton() {
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshAllProducts = useAppStore((s) => s.refreshAllProducts);
  const refreshBrands = useAppStore((s) => s.refreshBrands);
  const refreshCategories = useAppStore((s) => s.refreshCategories);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    const startedAt = Date.now();
    try {
      await Promise.all([
        refreshProducts?.(),
        refreshAllProducts?.(),
        refreshBrands?.(),
        refreshCategories?.(),
        refreshDashboard?.(),
      ]);
    } finally {
      // Minimum visible spin so the user sees feedback.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 600) await new Promise((r) => setTimeout(r, 600 - elapsed));
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className={`lib-refresh-btn${busy ? ' is-spinning' : ''}`}
      onClick={onClick}
      disabled={busy}
      title="Refresh"
      aria-label="Refresh Library"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {/* circular arrow — refresh icon, stroke-based per AGENTS.md §16 */}
        <path
          d="M14 8a6 6 0 1 1-1.76-4.24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M14 2.5v3h-3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </button>
  );
}

/**
 * v0.49.29: dropdown menu for the Library bulk toolbar.
 *
 * `sections` is an array of `{label, items: [{label, hint, onClick}]}` so the
 * caller decides the grouping (Generate, Edit, future Manage / Export …).
 * New bulk actions slot into a category instead of pushing the toolbar wider.
 *
 * Behaviour:
 *   - Esc or click-outside closes the menu.
 *   - Each item runs its onClick AND closes the menu.
 *   - The button is disabled when nothing is selected or a bulk op is running.
 *
 * Built inline (not a generic Popover primitive) because this is the only
 * caller and the styling is purpose-specific. If we ever need a second
 * popover in the app, extract then.
 */
/* v0.1.69: the "Image operations ▾" menu.
 *
 * It had grown to three flat sections that ran off the bottom of the window
 * with no way to scroll, so the last section could not be reached. The
 * approved shape is a two-level menu:
 *
 *   - the section labels are submenu triggers ("Non-destructive ▸", …) that
 *     open their items sideways;
 *   - a search field sits at the top of the panel always and flattens the
 *     whole tree into ONE filtered list once a query is typed, each row
 *     naming its section, because searching a tree is where people get lost;
 *   - both panels bound their own height to the space actually free, scroll
 *     when longer, and flip (the main panel up, the submenu up and/or to the
 *     left) so neither ever leaves the window;
 *   - keyboard: ↑/↓ walk the current level with the search field as the first
 *     stop at the top level, → opens a submenu, ← closes it, Enter activates,
 *     Esc clears a typed query first and only closes the whole menu once the
 *     search field is empty. Hover opens a section's submenu immediately when
 *     none is open, and keeps an open submenu while the pointer is travelling
 *     toward it.
 *
 * ponytail: hover intent is one pure geometry test (pointsTowardRect in
 * menuIntent.mjs) plus the fallback delay below. The ceiling is that test: it
 * only protects the straight path from a trigger into its own submenu, and a
 * submenu still closes only on Esc / click-outside / switching sections, so a
 * fast diagonal pass can open one and leave it open until the pointer settles.
 * If switching ever feels slow or eager, tune HOVER_OPEN_DELAY_MS; no further
 * machinery is planned.
 */
const SUBMENU_WIDTH = 300;
const MENU_EDGE = 8;
// Fallback only: the delay used when the pointer crossed onto a new trigger
// without a clear direction (first sample, or a stationary pointer), so the
// shared-submenu path still ends up switching rather than sticking forever.
// A pointer heading at the open submenu is protected by pointsTowardRect and
// never waits. Short enough that "stop on a trigger" still feels immediate.
const HOVER_OPEN_DELAY_MS = 120;

/**
 * The Library's two-level action menu. Used for "Image operations" and, since
 * v0.1.85, for the single-item "⋯ More" menu that holds Delete.
 *
 * `variant` and `searchable` exist for that second caller: a destructive item
 * behind a menu should not be dressed as the primary action (blue), and one
 * row does not need a filter field above it. Defaults keep the image-operations
 * menu exactly as it was.
 */
function BulkActionsMenu({ label, count, disabled, sections, variant = 'primary', searchable = true }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState('down'); // main panel: 'down' | 'up'
  const [maxHeight, setMaxHeight] = useState(null);
  const [query, setQuery] = useState('');
  const [openSection, setOpenSection] = useState(null); // section label | null
  const [subPosition, setSubPosition] = useState(null); // { top, left, maxHeight }
  const containerRef = useRef(null);
  const panelRef = useRef(null);
  const submenuRef = useRef(null);
  const searchRef = useRef(null);
  const sectionTriggerRef = useRef(null);
  const hoverTimerRef = useRef(null);
  const pointerRef = useRef(null); // last pointer sample { x, y }
  const hoveredTriggerRef = useRef(null); // section trigger under the pointer

  const searching = query.trim().length > 0;

  // Search flattens the sections into one list; each row carries its section.
  const flatItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const sec of sections) {
      const section = sec.label.split(' · ')[0];
      for (const it of sec.items) {
        if (`${it.label} ${it.hint || ''}`.toLowerCase().includes(q)) out.push({ ...it, section });
      }
    }
    return out;
  }, [sections, query]);

  const openSectionData = useMemo(
    () => sections.find((sec) => sec.label === openSection) || null,
    [sections, openSection],
  );

  function closeSubmenu() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setOpenSection(null);
    setSubPosition(null);
    sectionTriggerRef.current = null;
  }

  function closeAll() {
    closeSubmenu();
    hoveredTriggerRef.current = null;
    pointerRef.current = null;
    setOpen(false);
    setQuery('');
    setPlacement('down');
    setMaxHeight(null);
  }

  function focusTriggerButton() {
    containerRef.current?.querySelector('button')?.focus();
  }

  // The ROW elements the keyboard walks at the CURRENT level.
  function focusables() {
    if (searching) return [...(panelRef.current?.querySelectorAll('.lib-bulk-menu__item') ?? [])];
    if (openSection) return [...(submenuRef.current?.querySelectorAll('.lib-bulk-menu__item') ?? [])];
    return [...(panelRef.current?.querySelectorAll('.lib-bulk-menu__section-trigger') ?? [])];
  }

  // The search field is the first stop of the top level, so ↓ from it lands on
  // the first visible row (the flattened results when a query is typed) and ↑
  // from that row comes back. Inside a submenu the cycle stays local to it.
  function navFocusables() {
    const rows = focusables();
    if (openSection || !searchRef.current) return rows;
    return [searchRef.current, ...rows];
  }

  function moveFocus(delta) {
    const items = navFocusables();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = current === -1 ? (delta > 0 ? 0 : items.length - 1) : current + delta;
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
  }

  function openSubmenu(sectionLabel, triggerEl) {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    sectionTriggerRef.current = triggerEl;
    setOpenSection(sectionLabel);
  }

  // Directional hover intent. Each pointer sample records where the pointer
  // is, then looks at which section trigger (if any) it is over. Crossing onto
  // a different trigger:
  //   - with no submenu open, open that section immediately;
  //   - with a submenu open and the movement aimed at it, keep it — the
  //     pointer is on its way to the submenu, not choosing a new section;
  //   - otherwise fall back to a short delay before switching.
  function onPointerMove(e) {
    const next = { x: e.clientX, y: e.clientY };
    const prev = pointerRef.current;
    pointerRef.current = next;
    const trigger = e.target?.closest?.('.lib-bulk-menu__section-trigger') || null;
    if (trigger === hoveredTriggerRef.current) return;
    hoveredTriggerRef.current = trigger;
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (!trigger) return;
    const sectionLabel = trigger.dataset.sectionLabel;
    if (!sectionLabel || openSection === sectionLabel) return;
    if (!openSection) { openSubmenu(sectionLabel, trigger); return; }
    const rect = submenuRef.current?.getBoundingClientRect();
    if (prev && rect && pointsTowardRect(prev, next, rect)) return;
    hoverTimerRef.current = setTimeout(() => openSubmenu(sectionLabel, trigger), HOVER_OPEN_DELAY_MS);
  }

  function onPointerLeave() {
    hoveredTriggerRef.current = null;
    pointerRef.current = null;
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
  }

  // Esc / click-outside close. Arrow keys walk the current level (search field
  // included, see navFocusables); → opens a submenu from its trigger, ← closes
  // it. Enter/Space on a button is its native click, so it is deliberately not
  // handled here — except Enter in the search field, which activates the first
  // visible row.
  useEffect(() => {
    if (!open) return undefined;
    function onDocDown(e) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) closeAll();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        // Standard menu-search behaviour: the first Esc clears a typed query
        // and keeps the menu open; only an empty field closes the whole menu.
        if (query.length > 0) {
          e.preventDefault();
          setQuery('');
          searchRef.current?.focus();
          return;
        }
        closeAll(); focusTriggerButton(); return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); return; }
      // Home/End still jump between ROWS; while the search field has the caret
      // they keep their native text-editing meaning.
      if (e.key === 'Home') { if (e.target === searchRef.current) return; e.preventDefault(); focusables()[0]?.focus(); return; }
      if (e.key === 'End') { if (e.target === searchRef.current) return; e.preventDefault(); const items = focusables(); items[items.length - 1]?.focus(); return; }
      if (e.key === 'ArrowRight') {
        if (searching) return;
        const active = document.activeElement;
        if (active?.classList?.contains('lib-bulk-menu__section-trigger')) {
          e.preventDefault();
          openSubmenu(active.dataset.sectionLabel, active);
          setTimeout(() => { focusables()[0]?.focus(); }, 0);
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        if (!openSection) return;
        e.preventDefault();
        const label = openSection;
        closeSubmenu();
        setTimeout(() => {
          panelRef.current?.querySelector(`[data-section-label="${label.replace(/"/g, '\\"')}"]`)?.focus();
        }, 0);
        return;
      }
      if (e.key === 'Enter' && e.target === searchRef.current) {
        const first = focusables()[0];
        if (first) { e.preventDefault(); first.click(); }
      }
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, searching, openSection, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the first row when the menu opens; the search field is one ↑ (or Tab)
  // away, and ↑/↓ cycle between them.
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => { focusables()[0]?.focus(); }, 0);
    return () => clearTimeout(timer);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close any submenu when the search flattens the tree.
  useEffect(() => {
    if (searching && openSection) closeSubmenu();
  }, [searching]); // eslint-disable-line react-hooks/exhaustive-deps

  // Main panel bounds: re-measure on open, when the content changes, on
  // resize and on any ancestor scroll.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const container = containerRef.current;
      const panel = panelRef.current;
      if (!container || !panel) return;
      const rect = container.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - MENU_EDGE;
      const above = rect.top - MENU_EDGE;
      const natural = panel.scrollHeight;
      const nextPlacement = natural > below && above > below ? 'up' : 'down';
      const available = nextPlacement === 'up' ? above : below;
      setPlacement(nextPlacement);
      setMaxHeight(Math.max(0, Math.min(natural, available)));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, searching, flatItems.length, sections]);

  // Submenu bounds: side placement, vertical flip, scrolling. Re-measures on
  // panel scroll so it stays anchored to its trigger row.
  useLayoutEffect(() => {
    if (!open || !openSection) return undefined;
    const measure = () => {
      const container = containerRef.current;
      const panel = panelRef.current;
      const submenu = submenuRef.current;
      const trigger = sectionTriggerRef.current;
      if (!container || !panel || !submenu || !trigger) return;
      const cRect = container.getBoundingClientRect();
      const pRect = panel.getBoundingClientRect();
      const tRect = trigger.getBoundingClientRect();
      const natural = submenu.scrollHeight;
      const below = window.innerHeight - tRect.top - MENU_EDGE;
      const above = tRect.top - MENU_EDGE;
      const flipUp = natural > below && above > below;
      const available = flipUp ? above : below;
      const height = Math.max(0, Math.min(natural, available));
      let topViewport = flipUp ? tRect.bottom - height : tRect.top;
      topViewport = Math.max(MENU_EDGE, Math.min(topViewport, window.innerHeight - MENU_EDGE - height));
      // Sideways by default; flip to the LEFT when the right edge would leave
      // the window, and clamp inside it if neither side fully fits.
      let leftViewport = pRect.right + 4;
      if (leftViewport + SUBMENU_WIDTH > window.innerWidth - MENU_EDGE) {
        leftViewport = pRect.left - 4 - SUBMENU_WIDTH;
        if (leftViewport < MENU_EDGE) leftViewport = Math.max(MENU_EDGE, window.innerWidth - MENU_EDGE - SUBMENU_WIDTH);
      }
      setSubPosition({
        top: topViewport - cRect.top,
        left: leftViewport - cRect.left,
        maxHeight: height,
      });
    };
    measure();
    const panel = panelRef.current;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    panel?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      panel?.removeEventListener('scroll', measure);
    };
  }, [open, openSection]);

  function toggle() {
    setOpen((v) => {
      if (!v) { setQuery(''); setPlacement('down'); setMaxHeight(null); }
      else closeSubmenu();
      return !v;
    });
  }

  // v0.49.30: caller can pass a custom `label` (e.g. "Image operations (N) ▾").
  // Falls back to the v0.49.29 generic label when not given.
  const triggerLabel = label || `Bulk actions${count != null ? ` (${count})` : ''} ▾`;

  return (
    <div
      className="lib-bulk-menu"
      ref={containerRef}
      onMouseMove={onPointerMove}
      onMouseLeave={onPointerLeave}
    >
      <Button
        variant={variant}
        onClick={toggle}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); } }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {triggerLabel}
      </Button>
      {open ? (
        <div
          className="lib-bulk-menu__panel"
          role="menu"
          ref={panelRef}
          style={{
            maxHeight: maxHeight != null ? `${maxHeight}px` : undefined,
            ...(placement === 'up' ? { top: 'auto', bottom: 'calc(100% + 4px)' } : null),
          }}
        >
          {/* v0.1.72: present for the long tree, where searching earns its
              space. v0.1.85: `searchable={false}` for the one-item "⋯ More"
              menu, where a filter box above a single row is just noise. */}
          {searchable ? (
            <div className="lib-bulk-menu__search">
              <input
                ref={searchRef}
                className="input lib-bulk-menu__search-input"
                type="search"
                value={query}
                placeholder="Filter operations…"
                aria-label="Filter operations"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          {searching ? (
            flatItems.length === 0 ? (
              <div className="lib-bulk-menu__empty">No matching operations</div>
            ) : (
              flatItems.map((it) => (
                <button
                  key={`${it.section}:${it.label}`}
                  type="button"
                  className="lib-bulk-menu__item"
                  onClick={() => { closeAll(); it.onClick(); }}
                  role="menuitem"
                >
                  <div className="lib-bulk-menu__item-label">{it.label}</div>
                  <div className="lib-bulk-menu__flat-meta">{it.section}</div>
                </button>
              ))
            )
          ) : (
            sections.map((sec, sx) => (
              <div key={sec.label} className="lib-bulk-menu__section">
                {sx > 0 ? <div className="lib-bulk-menu__divider" /> : null}
                <button
                  type="button"
                  className={`lib-bulk-menu__section-trigger${openSection === sec.label ? ' is-open' : ''}`}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={openSection === sec.label}
                  data-section-label={sec.label}
                  onClick={(e) => {
                    if (openSection === sec.label) closeSubmenu();
                    else openSubmenu(sec.label, e.currentTarget);
                  }}
                >
                  <span className="lib-bulk-menu__section-label">{sec.label}</span>
                  <span className="lib-bulk-menu__chevron" aria-hidden>▸</span>
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
      {open && openSection && openSectionData ? (
        <div
          className="lib-bulk-menu__submenu"
          role="menu"
          aria-label={openSection}
          ref={submenuRef}
          style={{
            top: subPosition ? `${subPosition.top}px` : undefined,
            left: subPosition ? `${subPosition.left}px` : undefined,
            maxHeight: subPosition ? `${subPosition.maxHeight}px` : undefined,
            visibility: subPosition ? 'visible' : 'hidden',
          }}
        >
          <div className="lib-bulk-menu__heading">{openSectionData.label}</div>
          {openSectionData.items.map((it) => (
            <button
              key={it.label}
              type="button"
              className={`lib-bulk-menu__item${it.danger ? ' lib-bulk-menu__item--danger' : ''}`}
              onClick={() => { closeAll(); it.onClick(); }}
              role="menuitem"
            >
              <div className="lib-bulk-menu__item-label">{it.label}</div>
              {it.hint ? <div className="lib-bulk-menu__item-hint">{it.hint}</div> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

