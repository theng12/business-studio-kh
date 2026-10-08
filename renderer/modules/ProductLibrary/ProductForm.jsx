import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Field, Input, Select, Textarea } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { confirmWithBackup } from '../../components/BackupReminder.jsx';
import { Attribution } from '../../components/Attribution.jsx';
import { HistoryModal } from '../../components/HistoryModal.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';
import { CURRENCIES } from '../../lib/currencies.js';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { parseConflictError, showConflict } from '../../components/ConflictModal.jsx';
import { createLatestSaveQueue } from '../../lib/latestSaveQueue.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { ReframeModal } from './ReframeModal.jsx';
import { ConnImg } from '../../components/ConnImg.jsx';
import { undoImageDeletes, undoProductDeletes } from './undoDelete.js';
import { importableImageFiles, extOfImageFile, pasteTargetIsTextField } from './imageDrop.js';

// v0.27.0: raised 20 → 50 (matches imageManager.MAX_IMAGES_PER_PRODUCT
// server-side). This is the client-side guard for the ProductForm image
// grid; the authoritative cap is still enforced in IPC.
const MAX_IMAGES = 50;

// v0.31.0: human-readable file size for the image grid.
function fmtBytes(n) {
  if (!n || n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'draft',    label: 'Draft' },
];

function emptyForm() {
  return {
    sku: '',
    name: '',
    brandId: '',
    barcode: '',
    secondaryCode: '',
    categoryId: '',
    subcategory: '',
    colorFinish: '',
    variant: '',
    unit: '',
    status: 'active',
    tags: '',
    description: '',
    priceRetail: '',
    priceWholesale: '',
    // v0.1.55: each price field carries its own currency, and the company can
    // define extra named price groups stored per product in `prices` as
    // { [groupKey]: { amount, currency } }.
    priceRetailCurrency: 'USD',
    priceWholesaleCurrency: 'USD',
    prices: {},
    expiryDate: '',
    taxRate: '',
    reorderPoint: '',
    reorderQuantity: '',
    trackInventory: false,
    stockQty: '',
    variantAttributes: '',
    countryOfOrigin: '',
    // v0.49.48: logistics & sourcing — feed PO line prefills + landed cost.
    supplierId: '',
    supplierSku: '',
    hsCode: '',
    cartonQty: '',
    cartonWCm: '',
    cartonHCm: '',
    cartonDCm: '',
    weightPerUnitKg: '',
  };
}

function productToForm(p) {
  return {
    sku: p.sku ?? '',
    name: p.name ?? '',
    brandId: p.brandId ?? '',
    barcode: p.barcode ?? '',
    secondaryCode: p.secondaryCode ?? '',
    categoryId: p.categoryId ?? '',
    subcategory: p.subcategory ?? '',
    colorFinish: p.colorFinish ?? '',
    variant: p.variant ?? '',
    unit: p.unit ?? '',
    status: p.status ?? 'active',
    tags: Array.isArray(p.tags) ? p.tags.join(', ') : '',
    description: p.description ?? '',
    priceRetail: p.priceRetail == null ? '' : String(p.priceRetail),
    priceWholesale: p.priceWholesale == null ? '' : String(p.priceWholesale),
    priceRetailCurrency: p.priceRetailCurrency ?? 'USD',
    priceWholesaleCurrency: p.priceWholesaleCurrency ?? 'USD',
    // Accepts both the current `{ amount, currency }` shape and a legacy bare
    // number for a group value.
    prices: Object.fromEntries(
      Object.entries(p.prices ?? {}).map(([key, v]) => [
        key,
        (v && typeof v === 'object')
          ? { amount: v.amount == null ? '' : String(v.amount), currency: v.currency ?? 'USD' }
          : { amount: v == null ? '' : String(v), currency: 'USD' },
      ]),
    ),
    expiryDate: p.expiryDate ?? '',
    taxRate: p.taxRate ?? '',
    reorderPoint: p.reorderPoint ?? '',
    reorderQuantity: p.reorderQuantity ?? '',
    trackInventory: !!p.trackInventory,
    stockQty: p.stockQty == null ? '' : String(p.stockQty),
    variantAttributes: p.variantAttributes ?? '',
    countryOfOrigin: p.countryOfOrigin ?? '',
    // v0.49.48: logistics & sourcing.
    supplierId: p.supplierId ?? '',
    supplierSku: p.supplierSku ?? '',
    hsCode: p.hsCode ?? '',
    cartonQty: p.cartonQty == null ? '' : String(p.cartonQty),
    cartonWCm: p.cartonWCm == null ? '' : String(p.cartonWCm),
    cartonHCm: p.cartonHCm == null ? '' : String(p.cartonHCm),
    cartonDCm: p.cartonDCm == null ? '' : String(p.cartonDCm),
    weightPerUnitKg: p.weightPerUnitKg == null ? '' : String(p.weightPerUnitKg),
  };
}

function toNumberOrNull(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * v0.1.55: form `prices` → the stored shape.
 * `{ [groupKey]: { amount, currency } }`, dropping groups left blank. Accepts a
 * bare number too so an older form value can't crash the save.
 */
function buildPrices(map) {
  const out = {};
  for (const [key, v] of Object.entries(map ?? {})) {
    const obj = (v && typeof v === 'object') ? v : { amount: v, currency: 'USD' };
    const amount = toNumberOrNull(obj.amount);
    if (amount == null) continue;
    out[key] = { amount, currency: obj.currency || 'USD' };
  }
  return out;
}

/* Memoized: every prop the Library passes is stable (state, or a useCallback /
 * useMemo there), so typing in the Library's search box or ticking a row no
 * longer re-renders this ~1,500-line form. Store subscriptions still update it. */
export const ProductForm = memo(function ProductForm({ product, visible = true, isCreating = false, createKey = 0, onClose, onStartCreate, onProcess, onPreview, onDuplicated, onRegisterFlush }) {
  // The panel is persistently mounted (per the user's request to keep the
  // detail view always visible). There are three modes:
  //   - `product` truthy            → edit-existing form
  //   - `isCreating` truthy         → blank new-product form
  //   - neither                     → friendly empty placeholder
  // `onClose` clears the active selection back to the empty state (it does
  // not unmount this component anymore).
  const isEmpty = !product && !isCreating;
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const createProduct = useAppStore((s) => s.createProduct);
  const updateProduct = useAppStore((s) => s.updateProduct);
  const removeProduct = useAppStore((s) => s.removeProduct);
  // v0.17.2: used to repopulate the form after a conflict-refresh.
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const createBrand = useAppStore((s) => s.createBrand);
  const createCategory = useAppStore((s) => s.createCategory);
  const addToast = useAppStore((s) => s.addToast);
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);
  // v0.49.48: active company drives the supplier dropdown in the
  // Logistics & sourcing section.
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companies = useAppStore((s) => s.companies) ?? [];
  // v0.1.55: this company's named price groups (Settings → General → Price
  // groups). Each becomes an extra amount + currency row below.
  const priceGroups = (companies.find((c) => c.id === activeCompanyId)?.priceGroups) ?? [];
  const [suppliers, setSuppliers] = useState([]);
  // v0.49.39: drag-out is hidden in client mode (the multi-file
  // drag-out IPC is a no-op there pending Phase 2 — see
  // main/client/index.js for the rationale). "Copy to folder…" still
  // works in every mode because the bytes get pulled through the
  // app-image:// protocol passthrough.
  const appMode = useAppStore((s) => s.appMode);

  const [form, setForm] = useState(emptyForm());
  const [images, setImages] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState('saved');
  const [savedAt, setSavedAt] = useState(null);
  const autoSaveTimer = useRef(null);
  /** The un-written autosave payload, retained until acknowledged, including a failed navigation flush. */
  const autoSavePayload = useRef(null);
  const skipNextAutoSave = useRef(true);
  // Row identity survives the server's filename-slot renumbering.
  const [selectedImageIds, setSelectedImageIds] = useState(() => new Set());
  // Copying-in-progress flag so we can disable the buttons + show
  // "Copying…" during the IPC roundtrip. Folder picker latency + fetch
  // time means a 20-image copy isn't instant on a slow client link.
  const [copyingImages, setCopyingImages] = useState(false);
  // v0.49.39: side-panel "Copy ▾" dropdown visibility. Closes on
  // outside-click via a window-level handler installed when open.
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  // v0.1.85: the footer's "⋯" menu — home of Delete product. See handleDelete.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // v0.49.40: drag-prep state. In client mode the drag pill needs to
  // download bytes from the server first; the dragstart handler
  // awaits the download before calling startDrag. Shows a "Preparing
  // {n}…" label so the user knows to keep holding their mouse — on
  // Tailscale at 5 product images this typically completes inside
  // 1 sec, well before the OS would cancel the gesture. In
  // standalone mode prepareDrag is instant so this state flickers
  // by too fast to see (and the pill label is back to "Drag" before
  // the next paint).
  const [draggingPrep, setDraggingPrep] = useState(false);
  // v0.29.0: per-image Reframe modal target ({ id, filepath, ... } | null).
  const [reframeTarget, setReframeTarget] = useState(null);
  // v0.18.0: Duplicate button busy state. Separate from saving so
  // the Save button shows its own spinner correctly during a save.
  const [duplicating, setDuplicating] = useState(false);
  // v0.22.6: history modal for this product's audit trail.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [skuError, setSkuError] = useState(null);
  const [activeProductId, setActiveProductId] = useState(product?.id ?? null);
  // 0.1.94: inline "+ New brand / category" (window.prompt does nothing in
  // Electron). `{ kind: 'brand' | 'category', name }` while the field is open.
  const [inlineCreate, setInlineCreate] = useState(null);
  const [inlineCreating, setInlineCreating] = useState(false);
  // 0.1.94: a file is being dragged over the panel (drop highlight), and the
  // image import that a paste / drop / multi-pick started is running.
  const [dropActive, setDropActive] = useState(false);
  const [importingImages, setImportingImages] = useState(false);
  const panelRef = useRef(null);
  /* v0.1.27: the optimistic-concurrency token has to advance with each write.
   *
   * It used to be read from the `product` prop every time. `product` is the
   * Library's local `editing` row (renderer/modules/ProductLibrary/index.jsx),
   * and nothing ever re-points it at the refreshed store row — so the token
   * stayed frozen at the value loaded when the panel opened. The server bumps
   * `updated_at` on every write, so the FIRST save succeeded and every later one
   * was rejected with CONFLICT: edit a field, wait for the autosave, edit
   * another, and the second edit never persisted.
   *
   * Track the token from what the server actually returns instead. */
  const lastSavedUpdatedAt = useRef(null);
  /** Mirrors activeProductId for the unmount flush, which cannot read state. */
  const activeProductIdRef = useRef(null);
  /* Bumped every time the panel is re-pointed at another product (or at the
   * blank / create form). The panel is never remounted on a switch — the
   * Library renders it without a `key` — so a save or image fetch started for
   * product A can resolve while B is on screen. Anything that awaits captures
   * this first and drops its state/ref writes when it has moved: otherwise B
   * inherited A's concurrency token (every later B autosave was a CONFLICT), or
   * a finished create re-pointed the panel id at the new row while B was shown,
   * so Delete removed the wrong product. */
  const selectionGen = useRef(0);
  /** One "changed elsewhere" toast per conflict, not one per pause in typing. */
  const conflictToasted = useRef(false);

  const noteSaved = useCallback((gen, id, updatedAt) => {
    if (gen !== selectionGen.current || id !== activeProductIdRef.current) return false;
    lastSavedUpdatedAt.current = updatedAt ?? null;
    conflictToasted.current = false;
    return true;
  }, []);

  const makeSaveQueue = useCallback((id, gen, revision) => {
    return createLatestSaveQueue({
      initialRevision: revision,
      persist: (draft, expectedUpdatedAt) => {
        // Consume the deliberate bypass before sending this one request. A
        // failed overwrite keeps the draft and the queue's acknowledged token.
        const overwrite = draft.overwriteOnce === true;
        delete draft.overwriteOnce;
        return updateProduct(id, { ...draft.payload, ...(overwrite ? {} : { expectedUpdatedAt }) });
      },
      onStart: () => { if (gen === selectionGen.current) setSaveState('saving'); },
      onSuccess: (row, draft) => {
        if (!noteSaved(gen, id, row.updatedAt)) return;
        if (autoSavePayload.current !== draft) return;
        autoSavePayload.current = null;
        setSaveState('saved');
        setSavedAt(Date.now());
        setSkuError(null);
      },
      onError: (err, draft) => {
        if (gen !== selectionGen.current) return;
        setSaveState('dirty');
        if (parseConflictError(err)) {
          if (!conflictToasted.current) addToast(`${draft.payload.sku} changed elsewhere. Your draft is kept here. Click Save to review it.`, 'error');
          conflictToasted.current = true;
        } else addToast(`${draft.payload.sku}: ${err.message}. Your draft is kept here; click Save to retry.`, 'error');
      },
    });
  }, [updateProduct, addToast, noteSaved]);

  const saveQueue = useRef(null);
  const flushOwed = useCallback(async () => {
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = null;
    const owed = autoSavePayload.current;
    if (owed && !owed.payload.sku.trim()) {
      const message = 'SKU is required. Keep this product open and correct it before leaving.';
      setSkuError(message);
      addToast(message, 'error');
      throw new Error(message);
    }
    await saveQueue.current?.flush(() => autoSavePayload.current);
  }, [addToast]);
  useEffect(() => registerCompanySwitchFlusher(flushOwed), [flushOwed]);
  useEffect(() => {
    onRegisterFlush?.(flushOwed);
    return () => onRegisterFlush?.(null);
  }, [flushOwed, onRegisterFlush]);

  useEffect(() => {
    selectionGen.current += 1;
    const gen = selectionGen.current;
    if (product) {
      /* `product` is the Library's snapshot from when the row was clicked; the
       * store's list is refreshed after every write. Re-showing the panel (⌘B
       * remounts it) used to load that old snapshot, so the first autosave was
       * a false "changed elsewhere". Start from whichever copy is newer — the
       * fields AND the token together, so a newer edit from another Mac is
       * never overwritten by a form that has not seen it. */
      const { products: listed, allProducts } = useAppStore.getState();
      const stored = (listed || []).find((p) => p.id === product.id)
        || (allProducts || []).find((p) => p.id === product.id);
      const source = stored && Number(stored.updatedAt) > Number(product.updatedAt) ? stored : product;
      skipNextAutoSave.current = true;
      setForm(productToForm(source));
      lastSavedUpdatedAt.current = source.updatedAt ?? null;
      saveQueue.current = makeSaveQueue(product.id, gen, source.updatedAt);
      autoSavePayload.current = null;
      setActiveProductId(product.id);
      activeProductIdRef.current = product.id;
      window.api?.images.listByProduct(product.id)
        .then((rows) => { if (gen === selectionGen.current) setImages(rows); })
        .catch(() => { if (gen === selectionGen.current) setImages([]); });
    } else {
      // Either creating a new product or showing the empty state — either
      // way we want a clean form so the next interaction starts fresh.
      saveQueue.current = null;
      autoSavePayload.current = null;
      setForm(emptyForm());
      setImages([]);
      setActiveProductId(null);
      activeProductIdRef.current = null;
      lastSavedUpdatedAt.current = null;
    }
    setSkuError(null);
    setSaving(false);
    // The pill belongs to the product now on screen, not to a save of the last one.
    setSaveState('saved');
    setSavedAt(null);
    conflictToasted.current = false;
    // v0.49.39: drop any per-image selection when the displayed product
    // changes. IDs reference rows of the OLD product; carrying
    // them over would either match nothing or (worse) match a same-
    // path image of the new product. Always reset.
    setSelectedImageIds(new Set());
    setCopyMenuOpen(false);
    setInlineCreate(null);
    // createKey changes when the user asks for ANOTHER new product while the
    // panel is already in create mode; without it the effect would not re-run
    // and the previously created product would stay on screen. */
  }, [product, isCreating, createKey, makeSaveQueue]);

  // v0.49.48: load this company's suppliers for the sourcing dropdown.
  // Includes archived (status 'all') so a product attached to a now-
  // archived supplier still renders that supplier's name rather than
  // falling back to a bare id.
  useEffect(() => {
    if (!activeCompanyId) { setSuppliers([]); return; }
    window.api.suppliers.list(activeCompanyId, { status: 'all' })
      .then((list) => setSuppliers(Array.isArray(list) ? list : []))
      .catch(() => setSuppliers([]));
  }, [activeCompanyId]);

  // v0.49.39: when the loaded image list shrinks (delete, reorder
  // renumber, etc.), drop selected image IDs that no longer exist.
  // Same fix the Library does for selected product ids.
  useEffect(() => {
    setSelectedImageIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(images.map((im) => im.id));
      let changed = false;
      const next = new Set();
      for (const fp of prev) {
        if (live.has(fp)) next.add(fp);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [images]);

  // v0.49.39: close the "Copy" dropdown on outside click. Capture
  // phase so a click on the dropdown trigger itself (which manages its
  // own toggle) reaches us first and we don't re-close right after the
  // open. Bail when the menu is closed to keep the listener cost zero
  // in the common case.
  //
  // v0.1.85: the same rule now covers the footer's "⋯" menu. Both are
  // tagged with a data attribute rather than sharing one flag, so opening
  // one does not leave the other's panel mounted behind it.
  useEffect(() => {
    if (!copyMenuOpen && !moreMenuOpen) return undefined;
    function onDocClick(e) {
      if (e.target.closest && e.target.closest('[data-copy-menu], [data-product-more-menu]')) return;
      setCopyMenuOpen(false);
      setMoreMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [copyMenuOpen, moreMenuOpen]);

  // v0.26.18: live-refresh the panel's image grid whenever ANY image
  // mutation hits the currently-displayed product. Previously the
  // useEffect above only re-loaded when `product` (identity) changed,
  // so an Overlay Studio apply / AI promote / etc. against the
  // already-displayed product left the panel showing stale pixels
  // until the user clicked off and back. The store's catalog-event
  // dispatcher refreshes the LIBRARY products + workspace; the side-
  // panel's images array is local to this component so it needs its
  // own subscription.
  useEffect(() => {
    if (!activeProductId || !window.api?.events?.onCatalogChanged) return undefined;
    const off = window.api.events.onCatalogChanged((evt) => {
      if (evt?.kind !== 'images') return;
      // evt.id is either the product id (single-product paths emit it)
      // or null (end-of-batch broad signal). Match either way for this
      // product, falling back to a refetch on null so a bulk batch
      // refresh still reaches us.
      if (evt.id != null && evt.id !== activeProductId) return;
      const gen = selectionGen.current;
      window.api.images.listByProduct(activeProductId)
        .then((rows) => { if (gen === selectionGen.current) setImages(rows); })
        .catch(() => { /* keep stale list rather than blank */ });
    });
    return off;
  }, [activeProductId]);

  const isCreate = !activeProductId;
  const skuValid = form.sku.trim().length > 0;

  const setField = (key) => (e) => {
    const value = e && e.target ? e.target.value : e;
    setForm((f) => ({ ...f, [key]: value }));
  };

  /* 0.1.94: "+" beside Brand / Category opens a small inline name field. It
   * used window.prompt, which Electron does not implement, so the button did
   * nothing. Enter adds, Esc (handled here, so the panel stays open) cancels. */
  async function submitInlineCreate() {
    const pending = inlineCreate;
    const name = pending?.name?.trim();
    if (!pending || !name || inlineCreating) return;
    setInlineCreating(true);
    try {
      if (pending.kind === 'brand') {
        const b = await createBrand({ name });
        setForm((f) => ({ ...f, brandId: b.id }));
        addToast(`Brand "${b.name}" added`, 'success');
      } else {
        const c = await createCategory({ name });
        setForm((f) => ({ ...f, categoryId: c.id }));
        addToast(`Category "${c.name}" added`, 'success');
      }
      setInlineCreate(null);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setInlineCreating(false);
    }
  }

  function inlineCreateField(kind) {
    if (inlineCreate?.kind !== kind) return null;
    const label = kind === 'brand' ? 'New brand name' : 'New category name';
    return (
      <div className="field__row pf-inline-create">
        <Input
          autoFocus
          aria-label={label}
          placeholder={label}
          value={inlineCreate.name}
          disabled={inlineCreating}
          onChange={(e) => setInlineCreate({ kind, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitInlineCreate(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setInlineCreate(null); }
          }}
        />
        <Button size="sm" onClick={submitInlineCreate} disabled={inlineCreating || !inlineCreate.name.trim()}>
          {inlineCreating ? 'Adding…' : 'Add'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setInlineCreate(null)} disabled={inlineCreating}>Cancel</Button>
      </div>
    );
  }

  function buildPayload() {
    return {
      sku: form.sku.trim(),
      name: form.name.trim() || null,
      brandId: form.brandId || null,
      barcode: form.barcode.trim() || null,
      secondaryCode: form.secondaryCode.trim() || null,
      categoryId: form.categoryId || null,
      subcategory: form.subcategory.trim() || null,
      colorFinish: form.colorFinish.trim() || null,
      variant: form.variant.trim() || null,
      unit: form.unit.trim() || null,
      status: form.status,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      description: form.description.trim() || null,
      priceRetail: toNumberOrNull(form.priceRetail),
      priceWholesale: toNumberOrNull(form.priceWholesale),
      priceRetailCurrency: form.priceRetailCurrency || 'USD',
      priceWholesaleCurrency: form.priceWholesaleCurrency || 'USD',
      prices: buildPrices(form.prices),
      expiryDate: form.expiryDate.trim() || null,
      taxRate: form.taxRate.trim() || null,
      reorderPoint: form.reorderPoint.trim() || null,
      reorderQuantity: form.reorderQuantity.trim() || null,
      trackInventory: !!form.trackInventory,
      // v0.1.25: blank stays null ("not counted"), which is not the same as 0.
      stockQty: toNumberOrNull(form.stockQty),
      variantAttributes: form.variantAttributes.trim() || null,
      countryOfOrigin: form.countryOfOrigin.trim() || null,
      // v0.49.48: logistics & sourcing — defaults that prefill PO lines.
      supplierId: form.supplierId || null,
      supplierSku: form.supplierSku.trim() || null,
      hsCode: form.hsCode.trim() || null,
      cartonQty: toNumberOrNull(form.cartonQty),
      cartonWCm: toNumberOrNull(form.cartonWCm),
      cartonHCm: toNumberOrNull(form.cartonHCm),
      cartonDCm: toNumberOrNull(form.cartonDCm),
      weightPerUnitKg: toNumberOrNull(form.weightPerUnitKg),
    };
  }

  async function handleSave() {
    if (!skuValid) {
      setSkuError('SKU is required');
      return;
    }
    // Save writes the same payload the debounce would, so it supersedes it —
    // leaving the timer armed meant a second write right behind this one, sent
    // with the token this one is about to replace (a CONFLICT).
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = null;
    const gen = selectionGen.current;
    const current = () => gen === selectionGen.current;
    const id = activeProductId;
    setSaving(true);
    setSaveState('saving');
    try {
      if (isCreate) {
        const created = await createProduct(buildPayload());
        addToast(`Created ${created.sku}`, 'success');
        if (!current()) return;
        // The refs move with the state: the autosave and the unmount flush
        // read them, and the token is the created row's own.
        setActiveProductId(created.id);
        activeProductIdRef.current = created.id;
        lastSavedUpdatedAt.current = created.updatedAt ?? null;
        saveQueue.current = makeSaveQueue(created.id, gen, created.updatedAt);
        setSaveState('saved');
        setSavedAt(Date.now());
        setSkuError(null);
      } else {
        autoSavePayload.current ??= { id, payload: buildPayload() };
        try {
          await flushOwed();
          if (current()) addToast(`Saved ${form.sku}`, 'success');
        } catch (err) {
          const conflict = parseConflictError(err);
          if (!conflict) throw err;
          if (!current()) return;
          const choice = await showConflict(conflict);
          if (!current()) return;
          if (choice === 'refresh') {
            const fresh = await window.api.products.get(id);
            if (!fresh) throw new Error('This product was removed. Your draft is still here.', { cause: err });
            if (!current()) return;
            skipNextAutoSave.current = true;
            autoSavePayload.current = null;
            setForm(productToForm(fresh));
            lastSavedUpdatedAt.current = fresh.updatedAt ?? null;
            saveQueue.current.setRevision(fresh.updatedAt);
            conflictToasted.current = false;
            setSaveState('saved');
            await refreshProducts();
            addToast('Form refreshed with the latest data', 'info');
          } else if (choice === 'overwrite') {
            // Explicit owner choice is the only path that omits the token.
            autoSavePayload.current.overwriteOnce = true;
            await flushOwed();
            if (current()) addToast(`Overwrote ${form.sku}`, 'success');
          } else setSaveState('dirty');
        }
      }
    } catch (err) {
      if (current()) {
        setSkuError(err.message);
        setSaveState('dirty');
      }
      addToast(err.message, 'error');
    } finally {
      if (current()) setSaving(false);
    }
  }

  // Existing products auto-save after 500ms of quiet typing. The explicit
  // Save button remains and writes the same payload for deliberate commits.
  useEffect(() => {
    if (isEmpty || isCreate || !activeProductId) return undefined;
    if (skipNextAutoSave.current) { skipNextAutoSave.current = false; return undefined; }
    clearTimeout(autoSaveTimer.current);
    setSaveState('dirty');
    autoSavePayload.current = { id: activeProductId, payload: buildPayload() };
    autoSaveTimer.current = setTimeout(() => {
      const owed = autoSavePayload.current;
      if (owed?.payload.sku.trim()) saveQueue.current?.enqueue(owed);
    }, 500);
    return () => clearTimeout(autoSaveTimer.current);
    // Form is the intentional trigger; the store actions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // All authorized exits await the flusher before unmounting. Cleanup only
  // disarms the debounce: a rejected write must never be silently discarded.
  useEffect(() => () => clearTimeout(autoSaveTimer.current), []);

  /**
   * v0.1.85: delete moved off the footer into the "⋯" menu, and now needs the
   * SKU typed to confirm.
   *
   * The owner's report: "someone accidentally deleted a product... product
   * deletion and image deletion is so close together they can easily make a
   * mistake." The old layout put a red `Delete` in the footer beside
   * Duplicate/Cancel — one click, one Enter, product gone, and (before this
   * release) its images erased from disk with no way back.
   *
   * Two things changed, and they are independent:
   *   - the button is behind a menu, so it cannot be hit by aiming at
   *     something else in the same row;
   *   - the confirm will not fire until the SKU is typed, so a slip of the
   *     mouse plus a stray Enter is no longer enough.
   * The image files also go to the Trash now (main/util/fileTrash.js).
   */
  async function handleDelete() {
    const id = activeProductId;
    const gen = selectionGen.current;
    if (!id) return;
    const sku = (form.sku || '').trim();
    const ok = await confirmWithBackup({
      title: `Delete ${sku || 'this product'}?`,
      message: 'The product, its images, its AI generations and its metadata are removed from the library.',
      detail:
        'It is not gone yet: it waits in Settings → Recently deleted, with its photos, and one click '
        + 'puts it back exactly as it was. After the keep window it leaves that list and its files go '
        + 'to the Mac\'s Trash.',
      danger: true,
      confirmLabel: 'Delete product',
      requireText: sku || form.name || 'DELETE',
    });
    if (!ok) return;
    try {
      await flushOwed();
      await removeProduct(id);
      const companyId = activeCompanyId;
      addToast(`Deleted ${sku || 'product'} — restore it from Settings → Recently deleted if that was a mistake.`, 'success', {
        // 0.1.94: Undo puts it straight back from the recycle bin.
        action: {
          label: 'Undo',
          onClick: () => undoProductDeletes({
            companyId,
            productIds: [id],
            addToast,
            onRestored: () => {
              const st = useAppStore.getState();
              st.refreshProducts?.();
              st.refreshAllProducts?.();
              st.refreshDashboard?.();
            },
          }),
        },
      });
      if (gen === selectionGen.current) onClose();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  /**
   * v0.18.0: duplicate the current product. Server appends " (copy)"
   * (or " (copy 2)" / etc. on collision) to SKU and name, clones
   * every scalar field, clones images (content-addressed dedup so
   * no extra bytes on disk), and resets process status to
   * 'unprocessed'.
   *
   * Confirmation is a simple yes/no; v0.18.0 ships with images
   * always included since that's the dominant use case. A future
   * pass can add an "include images" toggle to a dedicated modal.
   */
  async function handleDuplicate() {
    const id = activeProductId;
    const gen = selectionGen.current;
    if (!id) return;
    const ok = await confirm({
      title: `Duplicate ${form.sku || 'this product'}?`,
      message: 'A new product will be created with the same fields and images. The new SKU appends " (copy)" to the original.',
      detail: 'You can edit the SKU and name on the new product right after.',
      confirmLabel: 'Duplicate',
    });
    if (!ok) return;
    setDuplicating(true);
    try {
      await flushOwed();
      const created = await window.api.products.duplicate(id, true);
      addToast(`Duplicated to ${created.sku}`, 'success');
      useAppStore.getState().refreshProducts();
      useAppStore.getState().refreshAllProducts?.();
      // Jump the side panel to the new product so the user can edit
      // its SKU / name without hunting for it in the table. The panel's
      // product is the Library's own selection, so the Library does the
      // jump; the store's activeProductId it used to set here is the Image
      // Workspace's product, and the panel stayed on the original.
      if (gen === selectionGen.current) onDuplicated?.(created);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setDuplicating(false);
    }
  }

  function handleProcess() {
    if (!activeProductId) return;
    // v0.11.2: prefer the parent-supplied router (Library opens the
    // destination picker modal). Fall back to the direct workspace jump
    // if a parent didn't wire `onProcess` — keeps any future re-use of
    // ProductForm outside Library working.
    if (onProcess) {
      onProcess(product);
    } else {
      openProductInWorkspace(activeProductId);
      onClose();
    }
  }

  /* ─── Image grid handlers ─── */

  /**
   * 0.1.94: one importer for every way a photo arrives — "+ Add image" (now a
   * multi-select picker), ⌘V (every pasted image, not just the first) and
   * drag-and-drop from Finder. Each source is `{ path }` (a file on this Mac,
   * through images:importForProduct) or `{ file }` (a File/Blob, through
   * images:importFromBytes — which is also what a client Mac needs, since the
   * server cannot read a path on this Mac). Sequential, so each add lands in
   * the next slot under the product's image lock; stops at the 50-photo cap.
   */
  async function importImages(sources, { pasted = false } = {}) {
    const gen = selectionGen.current;
    const productId = activeProductId;
    if (!productId) {
      addToast(`Save the product first, then ${pasted ? 'paste' : 'add'} images.`, 'info');
      return;
    }
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      addToast(`Image cap is ${MAX_IMAGES}.`, 'error');
      return;
    }
    let added = 0;
    let skipped = 0;
    let overCap = 0;
    const failures = [];
    let latest = null;
    setImportingImages(true);
    try {
      for (const src of sources) {
        if (added >= room) { overCap += 1; continue; }
        try {
          const res = src.path
            ? await window.api.images.importForProduct(productId, src.path)
            : await window.api.images.importFromBytes(productId, await src.file.arrayBuffer(), extOfImageFile(src.file));
          if (Array.isArray(res?.images)) latest = res.images;
          if (res?.skipped) skipped += 1;
          else added += 1;
        } catch (err) {
          failures.push(err.message);
          if (/cap/i.test(err.message)) break;
        }
      }
    } finally {
      if (gen === selectionGen.current) setImportingImages(false);
    }
    if (latest && gen === selectionGen.current && productId === activeProductIdRef.current) setImages(latest);
    if (added > 0) useAppStore.getState().refreshProducts();
    if (sources.length === 1 && failures.length === 0) {
      if (skipped) addToast('Same image already on this product — skipped.', 'info');
      else addToast(pasted ? 'Image pasted' : 'Image added', 'success');
      return;
    }
    const parts = [`${added} image${added === 1 ? '' : 's'} added`];
    if (skipped) parts.push(`${skipped} already on this product`);
    if (overCap) parts.push(`${overCap} over the ${MAX_IMAGES}-image cap`);
    if (failures.length) parts.push(`${failures.length} failed: ${failures[0]}`);
    addToast(parts.join(' · '), failures.length ? 'error' : added ? 'success' : 'info');
  }

  async function handleAddImage() {
    if (!activeProductId) {
      addToast('Save the product first, then add images.', 'info');
      return;
    }
    if (images.length >= MAX_IMAGES) {
      addToast(`Image cap is ${MAX_IMAGES}.`, 'error');
      return;
    }
    try {
      // 0.1.94: pick several at once — the handler always supported it.
      const picked = await window.api.files.pickImageFile({ multiple: true });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length === 0) return;
      await importImages(paths.map((path) => ({ path })));
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleSetMain(filepath) {
    const gen = selectionGen.current;
    const productId = activeProductId;
    try {
      const next = await window.api.images.setMainImage(productId, filepath);
      if (gen === selectionGen.current && productId === activeProductIdRef.current) setImages(next);
      useAppStore.getState().refreshProducts();
      // v0.12.4: explicit toast so the user sees confirmation. Without
      // it, the operation looks silent — especially when both involved
      // images look similar (the visual swap is subtle).
      addToast('Set as main', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleReorder(filepath, direction) {
    const gen = selectionGen.current;
    const productId = activeProductId;
    const idx = images.findIndex((i) => i.filepath === filepath);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= images.length) return;
    const next = [...images];
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      const updated = await window.api.images.reorderImages(productId, next.map((i) => i.filepath));
      if (gen === selectionGen.current && productId === activeProductIdRef.current) setImages(updated);
      useAppStore.getState().refreshProducts();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleRemoveImage(filepath) {
    const gen = selectionGen.current;
    const productId = activeProductId;
    const tile = images.find((i) => i.filepath === filepath);
    if (!tile?.id) return;
    const isMain = tile.id === images[0]?.id;
    const basename = (filepath?.split('/').pop() ?? 'this image');
    const ok = await confirm({
      title: 'Remove this image?',
      message: isMain
        ? `Position 1 (main image) will be removed${images.length > 1 ? '; the next image takes its place' : ''}.`
        : `"${basename}" will be removed from this product.`,
      detail: 'Restore this photo from Settings → Recently deleted if you remove it by mistake.',
      danger: true,
      confirmLabel: 'Remove image',
      // v0.26.21: power-user shortcut. Shift+D fires the confirm
      // without reaching for the mouse. Hint is shown next to the
      // button label automatically (⇧D).
      hotkey: 'shift+d',
    });
    if (!ok) return;
    try {
      const next = await window.api.images.removeFromProduct(productId, tile.id, tile.contentHash ?? null);
      if (gen === selectionGen.current && productId === activeProductIdRef.current) setImages(next);
      useAppStore.getState().refreshProducts();
      // v0.22.9: explicit success toast that names the file that was
      // removed. Beyond the basic "yes it worked" feedback, this is
      // the explicit visual confirmation of WHICH file the click
      // affected — important now that the surrounding tiles re-flow
      // and the user can't easily eyeball which one disappeared.
      addToast(`Removed ${basename} — restore it from Settings → Recently deleted.`, 'success', {
        action: { label: 'Undo', onClick: () => undoRemovedImages(productId, 1) },
      });
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  /** 0.1.94: Undo on a photo-remove toast — the newest `count` held photos. */
  function undoRemovedImages(productId, count) {
    return undoImageDeletes({
      companyId: activeCompanyId,
      productId,
      count,
      addToast,
      onRestored: () => {
        useAppStore.getState().refreshProducts?.();
        if (productId !== activeProductIdRef.current) return;
        const gen = selectionGen.current;
        window.api.images.listByProduct(productId)
          .then((rows) => { if (gen === selectionGen.current) setImages(rows); })
          .catch(() => {});
      },
    });
  }

  /**
   * 0.1.94: "Remove selected…" on the selection strip (its hint promised a
   * Delete that did not exist). One confirm, then each photo is removed by its
   * ROW ID and content hash, one after another — the server renumbers the
   * survivors' files after each removal, but ids and hashes do not move, so
   * the order is safe (HANDOFF: image lock / renumber rules). Each removal is
   * held in Recently deleted like a single remove.
   */
  async function handleRemoveSelected() {
    const gen = selectionGen.current;
    const productId = activeProductId;
    const targets = images.filter((im) => selectedImageIds.has(im.id));
    if (!productId || targets.length === 0) return;
    const n = targets.length;
    const includesMain = targets.some((t) => t.id === images[0]?.id);
    const ok = await confirm({
      title: `Remove ${n} photo${n === 1 ? '' : 's'}?`,
      message: includesMain
        ? `The main image (position 1) is one of them${n < images.length ? '; the first photo left becomes the main image' : ''}.`
        : `${n === 1 ? 'It' : 'They'} will be removed from this product.`,
      detail: 'Restore them from Settings → Recently deleted if you remove them by mistake.',
      danger: true,
      confirmLabel: `Remove ${n}`,
    });
    if (!ok) return;
    let removed = 0;
    let latest = null;
    const failures = [];
    for (const t of targets) {
      try {
        latest = await window.api.images.removeFromProduct(productId, t.id, t.contentHash ?? null);
        removed += 1;
      } catch (err) {
        failures.push(err.message);
      }
    }
    if (latest && gen === selectionGen.current && productId === activeProductIdRef.current) setImages(latest);
    if (removed > 0) useAppStore.getState().refreshProducts();
    if (failures.length === 0) {
      addToast(`Removed ${removed} photo${removed === 1 ? '' : 's'} — restore from Settings → Recently deleted.`, 'success', {
        action: { label: 'Undo', onClick: () => undoRemovedImages(productId, removed) },
      });
    } else {
      addToast(`Removed ${removed} of ${n} — ${failures[0]}`, 'error');
    }
  }

  /* ─── v0.49.39: multi-image copy + drag-out helpers ────────────── */

  // Toggle a single image's selection. The ImageTile checkbox calls
  // this — passes the row ID. Toggling the selection of an image
  // that's currently the only-selected one leaves the set empty,
  // which auto-hides the selection toolbar (the JSX below tests
  // size > 0). No animation; the toolbar just disappears.
  function toggleImageSelected(imageId) {
    setSelectedImageIds((prev) => {
      const next = new Set(prev);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
  }

  function clearImageSelection() {
    setSelectedImageIds(new Set());
  }

  function selectAllImages() {
    setSelectedImageIds(new Set(images.map((im) => im.id)));
  }

  // Pop the OS folder picker, copy the chosen filepaths there.
  // `scope` is 'selected' | 'all' | 'main' — affects the filepath
  // list AND the toast wording. The handler routes through one IPC
  // (`images:copyImagesToFolder`) so the backend writer is the same
  // path; we just preset which subset of images get included.
  async function handleCopyImagesToFolder(scope) {
    if (!activeProductId) return;
    if (images.length === 0) {
      addToast('No images on this product.', 'info');
      return;
    }
    let filepaths;
    if (scope === 'main') {
      filepaths = [images[0].filepath];
    } else if (scope === 'selected') {
      filepaths = images
        .filter((im) => selectedImageIds.has(im.id))
        .map((im) => im.filepath);
      if (filepaths.length === 0) {
        addToast('Select at least one image first.', 'info');
        return;
      }
    } else { // 'all'
      filepaths = images.map((im) => im.filepath);
    }
    setCopyingImages(true);
    setCopyMenuOpen(false);
    try {
      const res = await window.api.images.copyImagesToFolder({
        productId: activeProductId,
        // Renderer passes the SKU directly so the main handler doesn't
        // need to hit the DB — same code path works in standalone,
        // server, AND client mode (no local DB available on a client).
        sku: form.sku || 'product',
        filepaths,
      });
      if (res?.canceled) {
        // User cancelled the folder picker — silently exit; no toast,
        // they made an explicit choice.
        return;
      }
      const copied = res?.copied ?? 0;
      const failed = (res?.failures || []).length;
      if (copied > 0 && failed === 0) {
        addToast(`Copied ${copied} image${copied === 1 ? '' : 's'} to ${res.folder}`, 'success');
      } else if (copied > 0) {
        addToast(`Copied ${copied}, ${failed} failed.`, 'info');
      } else {
        addToast('No images copied — see Crash log for details.', 'error');
      }
    } catch (err) {
      addToast(`Copy failed: ${err.message}`, 'error');
    } finally {
      setCopyingImages(false);
    }
  }

  // Drag handle's onDragStart. preventDefault() is REQUIRED — without
  // it Chromium starts its OWN drag of the button's HTML and our IPC
  // races against that, so we get a weird mixed drag (Chromium's HTML
  // ghost + Electron's file drop) on some targets. preventDefault
  // suppresses the default; we then prepareDrag (which downloads
  // bytes to a temp dir in client mode, no-op resolve in standalone)
  // and ask main to start a proper native multi-file drag via
  // webContents.startDrag.
  //
  // v0.49.40 timing note: dragstart is fired by Chromium the moment
  // the user has moved enough pixels with the button held. We
  // preventDefault synchronously, then do async prep, then call
  // startDragOut. The OS keeps the gesture alive while the user
  // continues to hold the button — as long as startDragOut fires
  // before the user releases the mouse, the native drag begins. On
  // standalone this is sub-millisecond. On client with a fast
  // Tailscale link, ~200–800ms for typical product image sizes.
  async function handleDragOutStart(e, scope) {
    e.preventDefault();
    if (!activeProductId) return;
    let filepaths;
    if (scope === 'selected') {
      filepaths = images
        .filter((im) => selectedImageIds.has(im.id))
        .map((im) => im.filepath);
    } else { // 'all'
      filepaths = images.map((im) => im.filepath);
    }
    if (filepaths.length === 0) return;
    setDraggingPrep(true);
    try {
      const prep = await window.api.images.prepareDrag(activeProductId, filepaths);
      const paths = Array.isArray(prep?.files) ? prep.files : [];
      if (paths.length === 0) {
        addToast(
          (prep?.failed?.[0]?.error)
            ? `Drag prep failed: ${prep.failed[0].error}`
            : 'Drag prep returned no files.',
          'error',
        );
        return;
      }
      if (Array.isArray(prep.failed) && prep.failed.length) {
        addToast(`Drag prepared with ${prep.failed.length} skipped (server unreachable).`, 'info');
      }
      window.api.images.startDragOut(paths);
    } catch (err) {
      // Likely client-mode network error or the server rejected the
      // request. Surface plainly — the user's mouse is probably
      // already released; no live drag to cancel.
      addToast(`Drag prep failed: ${err.message}`, 'error');
    } finally {
      setDraggingPrep(false);
    }
  }

  /* 0.1.94: ⌘V imports EVERY pasted image (it took the first one), and it is
   * no longer limited to a click inside the form grid: the panel catches a
   * paste anywhere in it, and while it is open a paste anywhere on the page
   * also lands here — unless the focus is in a text field (that paste is text)
   * or a dialog is open (the bulk table takes its own pastes). */
  function handlePaste(e) {
    const files = [];
    for (const it of Array.from(e.clipboardData?.items ?? [])) {
      if (!String(it?.type ?? '').startsWith('image/')) continue;
      const file = it.getAsFile?.();
      if (file) files.push(file);
    }
    if (files.length === 0) return undefined;
    e.preventDefault();
    if (importingImages) {
      addToast('Still adding the last images — paste again in a moment.', 'info');
      return undefined;
    }
    return importImages(files.map((file) => ({ file })), { pasted: true });
  }
  const handlePasteRef = useRef(handlePaste);
  handlePasteRef.current = handlePaste;
  useEffect(() => {
    if (!visible || !activeProductId) return undefined;
    const onDocPaste = (e) => {
      if (e.defaultPrevented) return;
      if (panelRef.current?.contains?.(e.target)) return; // the panel's own onPaste ran
      if (pasteTargetIsTextField(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      handlePasteRef.current(e);
    };
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, [visible, activeProductId]);

  /* 0.1.94: drop photos from Finder onto the panel. The bytes go through
   * images:importFromBytes, which works the same on a client Mac. A drag that
   * started inside the panel (a thumbnail, the "Drag N" pill) is ignored, so
   * dropping one of this product's own thumbnails back cannot add a low-res
   * copy of it. */
  const internalDragRef = useRef(false);
  function dragHasFiles(e) {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }
  function handleDragOver(e) {
    if (!activeProductId || internalDragRef.current || !dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  }
  function handleDragLeave(e) {
    if (panelRef.current?.contains?.(e.relatedTarget)) return;
    setDropActive(false);
  }
  function handleDrop(e) {
    if (internalDragRef.current) { internalDragRef.current = false; return undefined; }
    if (!dragHasFiles(e)) return undefined;
    e.preventDefault();
    setDropActive(false);
    if (!activeProductId) {
      addToast('Save the product first, then add images.', 'info');
      return undefined;
    }
    const files = importableImageFiles(e.dataTransfer?.files);
    if (files.length === 0) {
      addToast('Only image files can be dropped here.', 'info');
      return undefined;
    }
    return importImages(files.map((file) => ({ file })));
  }

  const title = isEmpty
    ? 'Product details'
    : isCreate
      ? 'New product'
      : `Edit product · ${form.sku}`;

  /* Esc clears the current selection (reverts to the empty placeholder).
   *
   * v0.1.29: SKIP when a modal is open. The old comment here claimed a no-op
   * when the panel was empty kept "other handlers on the page (e.g. modal
   * close)" in priority — but both this and <Modal> listen on `window`, and
   * `stopPropagation()` does not stop a SIBLING listener on the same target.
   * So pressing Esc inside, say, the import dialog closed the dialog AND
   * cleared the product panel behind it. Checking for an open dialog is
   * order-independent, which matters because listener order depends on which
   * component mounted first. (Lightbox uses stopImmediatePropagation for the
   * same reason, but that only works when it is registered FIRST; this is the
   * robust direction.) */
  /* A control that already handled Esc (a SearchableSelect closing its list,
   * the brand / category / supplier pickers) marks it defaultPrevented; that
   * Esc must not also close the panel. onClose lives in a ref so the listener
   * is registered once, not on every Library render. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (isEmpty || !visible) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;  // a focused control already used it
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;  // a modal owns Esc
      e.stopPropagation();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isEmpty, visible]);

  if (isEmpty) {
    return (
      <aside className="lib-panel lib-panel--empty" role="complementary" aria-label={title}>
        <header className="lib-panel__head">
          <div className="lib-panel__title">{title}</div>
        </header>
        <div className="lib-panel__empty">
          <svg
            className="lib-panel__empty-icon"
            width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden
          >
            <rect x="8" y="10" width="40" height="36" rx="4" stroke="currentColor" strokeWidth="1.5" />
            <path d="M16 22h24M16 30h24M16 38h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div className="lib-panel__empty-title">No product selected</div>
          <div className="lib-panel__empty-body">
            Click any product in the list to view and edit its details here,
            or start a new one.
          </div>
          {onStartCreate ? (
            <Button variant="primary" onClick={onStartCreate}>+ New product</Button>
          ) : null}
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={panelRef}
      className={`lib-panel${dropActive ? ' is-drop-target' : ''}`}
      role="complementary"
      aria-label={title}
      onPaste={handlePaste}
      // Capture phase, so the "Drag N" pill (which starts a native drag of its
      // own and cancels this one) is told apart by its target.
      onDragStartCapture={(e) => { if (!e.target?.closest?.('.image-select-bar__drag')) internalDragRef.current = true; }}
      onDragEndCapture={() => { internalDragRef.current = false; }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="lib-panel__head">
        <div className="lib-panel__title">{title}</div>
        {!isCreate ? <SaveStatus state={saveState} savedAt={savedAt} /> : null}
        <button
          type="button"
          className="lib-panel__close"
          aria-label="Close (Esc)"
          title="Close (Esc)"
          onClick={onClose}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="lib-panel__body">
        <div className="form-grid">
        <Field label="SKU" required error={skuError} span="full">
          {({ id }) => (
            <Input
              id={id}
              autoFocus
              value={form.sku}
              invalid={!!skuError}
              onChange={(e) => { setField('sku')(e); if (skuError) setSkuError(null); }}
              placeholder="e.g. BBC-TILE-001"
            />
          )}
        </Field>

        <Field label="Name">
          {({ id }) => <Input id={id} value={form.name} onChange={setField('name')} />}
        </Field>

        <Field label="Brand">
          {({ id }) => inlineCreateField('brand') ?? (
            <div className="field__row">
              <Select id={id} value={form.brandId} onChange={setField('brandId')}>
                <option value="">— Unassigned —</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </Select>
              <button type="button" className="field__inline-btn" onClick={() => setInlineCreate({ kind: 'brand', name: '' })} title="Create new brand" aria-label="Create new brand">
                +
              </button>
            </div>
          )}
        </Field>

        <Field label="Barcode" hint="EAN, UPC, or other">
          {({ id }) => <Input id={id} value={form.barcode} onChange={setField('barcode')} />}
        </Field>

        <Field label="Secondary code" hint="Supplier code or alt SKU">
          {({ id }) => <Input id={id} value={form.secondaryCode} onChange={setField('secondaryCode')} />}
        </Field>

        <Field label="Category">
          {({ id }) => inlineCreateField('category') ?? (
            <div className="field__row">
              {/* v0.22.19: searchable. With 70+ categories the native
                  <select> was a long scroll; this is type-to-filter
                  with keyboard nav (↑↓ + Enter). The "+ New" inline
                  button stays for quick creation. */}
              <SearchableSelect
                id={id}
                value={form.categoryId || ''}
                options={categories}
                getLabel={(c) => c.name}
                getValue={(c) => c.id}
                getSecondary={(c) => c.productCount != null
                  ? `${c.productCount} product${c.productCount === 1 ? '' : 's'}`
                  : null}
                onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}
                emptyLabel="— Uncategorized —"
                emptyValue=""
              />
              <button type="button" className="field__inline-btn" onClick={() => setInlineCreate({ kind: 'category', name: '' })} title="Create new category" aria-label="Create new category">
                +
              </button>
            </div>
          )}
        </Field>

        <Field label="Subcategory">
          {({ id }) => <Input id={id} value={form.subcategory} onChange={setField('subcategory')} />}
        </Field>

        <Field label="Color / Finish">
          {({ id }) => <Input id={id} value={form.colorFinish} onChange={setField('colorFinish')} placeholder="e.g. Matte White" />}
        </Field>

        <Field label="Variant" hint="Size, material, etc.">
          {({ id }) => <Input id={id} value={form.variant} onChange={setField('variant')} />}
        </Field>

        <Field label="Unit" hint="e.g. sqm, piece, box">
          {({ id }) => <Input id={id} value={form.unit} onChange={setField('unit')} />}
        </Field>

        <Field label="Status">
          {({ id }) => (
            <Select id={id} value={form.status} onChange={setField('status')}>
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
        </Field>

        <Field label="Retail price">
          {({ id }) => (
            <div className="price-row">
              <Input id={id} type="number" step="any" value={form.priceRetail} onChange={setField('priceRetail')} placeholder="0.00" />
              <Select
                value={form.priceRetailCurrency || 'USD'}
                onChange={(e) => setForm((f) => ({ ...f, priceRetailCurrency: e.target.value }))}
                aria-label="Retail price currency"
                style={{ width: 118 }}
              >
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{`${c.symbol} ${c.code}`}</option>)}
              </Select>
            </div>
          )}
        </Field>

        <Field label="Wholesale price">
          {({ id }) => (
            <div className="price-row">
              <Input id={id} type="number" step="any" value={form.priceWholesale} onChange={setField('priceWholesale')} placeholder="0.00" />
              <Select
                value={form.priceWholesaleCurrency || 'USD'}
                onChange={(e) => setForm((f) => ({ ...f, priceWholesaleCurrency: e.target.value }))}
                aria-label="Wholesale price currency"
                style={{ width: 118 }}
              >
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{`${c.symbol} ${c.code}`}</option>)}
              </Select>
            </div>
          )}
        </Field>

        {/* v0.1.55: custom price groups. Defined once per company in
            Settings → General → Price groups; each product fills in its own
            amount + currency here. Stored in the product's `prices` map, which
            Catalog Studio and Social Grid can render via config.priceGroup. */}
        {priceGroups.map((g) => {
          const cur = form.prices?.[g.key] ?? { amount: '', currency: 'USD' };
          return (
            <Field key={g.key} label={g.label}>
              {({ id }) => (
                <div className="price-row">
                  <Input
                    id={id}
                    type="number"
                    step="any"
                    value={cur.amount ?? ''}
                    placeholder="0.00"
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      prices: { ...(f.prices ?? {}), [g.key]: { ...(f.prices?.[g.key] ?? {}), amount: e.target.value } },
                    }))}
                  />
                  <Select
                    value={cur.currency || 'USD'}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      prices: { ...(f.prices ?? {}), [g.key]: { ...(f.prices?.[g.key] ?? {}), currency: e.target.value } },
                    }))}
                    aria-label={`${g.label} currency`}
                    style={{ width: 118 }}
                  >
                    {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{`${c.symbol} ${c.code}`}</option>)}
                  </Select>
                </div>
              )}
            </Field>
          );
        })}

        <Field label="Tags" hint="Comma-separated" span="full">
          {({ id }) => <Input id={id} value={form.tags} onChange={setField('tags')} />}
        </Field>

        <Field label="Description" span="full">
          {({ id }) => <Textarea id={id} value={form.description} onChange={setField('description')} rows={3} />}
        </Field>

        <div className="field field--full pf-logistics">
          <div className="pf-logistics__head">
            <span className="field__label">Labels &amp; catalog</span>
            <span className="field__hint" style={{ marginTop: 0 }}>Shared fields available to Label Studio and Catalog Studio.</span>
          </div>
          <div className="pf-logistics__grid">
            <Field label="Country of origin">{({ id }) => <Input id={id} value={form.countryOfOrigin} onChange={setField('countryOfOrigin')} />}</Field>
            <Field label="Expiry date">{({ id }) => <Input id={id} type="date" value={form.expiryDate} onChange={setField('expiryDate')} />}</Field>
            <Field label="Tax rate" hint="Stored as entered">{({ id }) => <Input id={id} value={form.taxRate} onChange={setField('taxRate')} placeholder="e.g. 10%" />}</Field>
            <Field label="Variant attributes">{({ id }) => <Input id={id} value={form.variantAttributes} onChange={setField('variantAttributes')} placeholder="Color: Red, Size: M" />}</Field>
            <Field label="Reorder point">{({ id }) => <Input id={id} value={form.reorderPoint} onChange={setField('reorderPoint')} />}</Field>
            <Field label="Reorder quantity">{({ id }) => <Input id={id} value={form.reorderQuantity} onChange={setField('reorderQuantity')} />}</Field>
            <Field label="Stock on hand" hint="How many you have now. Leave blank if you don't count it.">{({ id }) => <Input id={id} type="number" step="any" value={form.stockQty} onChange={setField('stockQty')} placeholder="e.g. 24" />}</Field>
            <label className="field"><span className="field__label">Inventory</span><span className="field__row"><input type="checkbox" checked={form.trackInventory} onChange={(e) => setForm((f) => ({ ...f, trackInventory: e.target.checked }))} /> Track inventory for this product</span></label>
          </div>
        </div>

        {/* v0.49.48: Logistics & sourcing. These default onto Purchase
            Order line items when this product is added to a PO, and feed
            the landed-cost volume/weight allocation. All optional. */}
        <div className="field field--full pf-logistics">
          <div className="pf-logistics__head">
            <span className="field__label">Logistics &amp; sourcing</span>
            <span className="field__hint" style={{ marginTop: 0 }}>
              Defaults that prefill Purchase Order lines + feed landed-cost volume / weight allocation. All optional.
            </span>
          </div>
          <div className="pf-logistics__grid">
            <Field label="Default supplier">
              {({ id }) => (
                <Select id={id} value={form.supplierId} onChange={setField('supplierId')}>
                  <option value="">— none —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.status === 'archived' ? ' (archived)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Supplier SKU" hint="The supplier's own item code">
              {({ id }) => <Input id={id} value={form.supplierSku} onChange={setField('supplierSku')} />}
            </Field>
            <Field label="HS code" hint="Customs tariff code">
              {({ id }) => <Input id={id} value={form.hsCode} onChange={setField('hsCode')} placeholder="e.g. 6907.21" />}
            </Field>
            <Field label="Units per carton">
              {({ id }) => <Input id={id} type="number" min="0" step="1" value={form.cartonQty} onChange={setField('cartonQty')} />}
            </Field>
            <Field label="Carton W (cm)">
              {({ id }) => <Input id={id} type="number" min="0" step="0.1" value={form.cartonWCm} onChange={setField('cartonWCm')} />}
            </Field>
            <Field label="Carton H (cm)">
              {({ id }) => <Input id={id} type="number" min="0" step="0.1" value={form.cartonHCm} onChange={setField('cartonHCm')} />}
            </Field>
            <Field label="Carton D (cm)">
              {({ id }) => <Input id={id} type="number" min="0" step="0.1" value={form.cartonDCm} onChange={setField('cartonDCm')} />}
            </Field>
            <Field label="Weight per unit (kg)">
              {({ id }) => <Input id={id} type="number" min="0" step="0.001" value={form.weightPerUnitKg} onChange={setField('weightPerUnitKg')} />}
            </Field>
          </div>
        </div>

        {/* Image grid */}
        <div className="field field--full">
          <div className="image-grid__header">
            <span className="field__label">
              Images <span className="image-grid__count">
                {images.length} / {MAX_IMAGES}
                {(() => {
                  const totalSize = images.reduce((s, im) => s + (im.fileSize || 0), 0);
                  return totalSize > 0 ? ` · ${fmtBytes(totalSize)}` : '';
                })()}
              </span>
            </span>
            {/* v0.49.39: "Copy ▾" dropdown — main / all / save to folder. Only
                shows when there's at least one image (otherwise there's
                nothing to copy). Sits next to "+ Add image" so the related
                actions (write to grid / read out of grid) live together. */}
            {activeProductId && images.length > 0 ? (
              <div className="copy-menu" data-copy-menu>
                <Button
                  onClick={() => setCopyMenuOpen((v) => !v)}
                  disabled={copyingImages}
                  title="Save copies of these images to a folder"
                  aria-expanded={copyMenuOpen}
                  aria-haspopup="menu"
                >
                  {copyingImages ? 'Copying…' : 'Copy ▾'}
                </Button>
                {copyMenuOpen ? (
                  <div className="copy-menu__panel" data-copy-menu role="menu">
                    <button
                      type="button"
                      className="copy-menu__item"
                      role="menuitem"
                      onClick={() => handleCopyImagesToFolder('main')}
                      disabled={copyingImages}
                    >
                      <span className="copy-menu__label">Save main image to folder…</span>
                      <span className="copy-menu__hint">The first image only</span>
                    </button>
                    <button
                      type="button"
                      className="copy-menu__item"
                      role="menuitem"
                      onClick={() => handleCopyImagesToFolder('all')}
                      disabled={copyingImages}
                    >
                      <span className="copy-menu__label">Save all {images.length} images to folder…</span>
                      <span className="copy-menu__hint">Named {(form.sku || 'product').replace(/[^A-Za-z0-9._-]+/g, '-')}-001, -002, …</span>
                    </button>
                    <div className="copy-menu__sep" aria-hidden />
                    <button
                      type="button"
                      className="copy-menu__item"
                      role="menuitem"
                      onClick={() => {
                        selectAllImages();
                        setCopyMenuOpen(false);
                      }}
                      disabled={copyingImages}
                    >
                      <span className="copy-menu__label">Select all for multi-action</span>
                      <span className="copy-menu__hint">Tick boxes appear on each image — then Copy, Drag or Remove from the strip</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <Button onClick={handleAddImage} disabled={!activeProductId || images.length >= MAX_IMAGES || importingImages}>
              {importingImages ? 'Adding…' : '+ Add image'}
            </Button>
          </div>
          <p className="field__hint">
            {activeProductId
              ? 'Paste (⌘V) or drop photos here. The same photo is skipped automatically.'
              : 'Save the product first, then add images.'}
          </p>
          {/* v0.49.39: multi-select action strip. Appears only when the
              user has ticked at least one image (selectAllImages() from
              the Copy ▾ menu can also seed the selection). Three actions:
                - "Copy selected to folder…" — folder picker + writes N
                  files with the same clean naming as the dropdown's
                  "Save all" option.
                - "Drag selected" — multi-file native drag. Hidden in
                  client mode where startDragOut is a no-op. The button
                  is `draggable` and its onDragStart preventDefault()s
                  Chromium's default drag so main can start a proper
                  native one via webContents.startDrag.
                - "Clear" — drops the selection. Same affordance as the
                  Esc key would do if we wired one. */}
          {selectedImageIds.size > 0 ? (
            <div className="image-select-bar">
              <span className="image-select-bar__count">
                {selectedImageIds.size} selected
              </span>
              <Button
                onClick={() => handleCopyImagesToFolder('selected')}
                disabled={copyingImages}
              >
                {copyingImages ? 'Copying…' : 'Copy to folder…'}
              </Button>
              {/* v0.49.40: drag pill works in ALL modes now. In client
                  mode the dragstart handler awaits a download from the
                  server before the OS-level drag begins; the label
                  changes to "Preparing N…" during that window so the
                  user knows to keep their mouse held. */}
              <button
                type="button"
                className={`image-select-bar__drag${draggingPrep ? ' is-prepping' : ''}`}
                draggable
                onDragStart={(e) => handleDragOutStart(e, 'selected')}
                // Click is a no-op — the button only does anything
                // during a drag gesture. Prevent default so the click
                // doesn't accidentally submit a parent form.
                onClick={(e) => e.preventDefault()}
                title={appMode === 'client'
                  ? 'Click and drag onto any drop target — files download from the server on demand'
                  : 'Click and drag to copy these files to Finder, Mail, Slack, or any drop target'}
              >
                {draggingPrep
                  ? `Preparing ${selectedImageIds.size}…`
                  : `⤴ Drag ${selectedImageIds.size}`}
              </button>
              <Button variant="danger" onClick={handleRemoveSelected} disabled={copyingImages}>
                Remove selected…
              </Button>
              <Button variant="ghost" onClick={clearImageSelection}>Clear</Button>
            </div>
          ) : null}
          {images.length === 0 ? (
            <div className="image-grid__empty">No images yet.</div>
          ) : (
            <div className="image-grid">
              {images.map((img, i) => (
                <ImageTile
                  // v0.22.8: key by row id, not filepath. The server
                  // renumbers files on remove/reorder so filepath
                  // changes for surviving rows — keying by filepath
                  // makes React think a tile in the middle was removed
                  // when actually the LAST tile was. Row id is stable
                  // through renames so React removes the correct DOM
                  // node for the actually-deleted image.
                  key={img.id ?? img.filepath}
                  image={img}
                  index={i}
                  total={images.length}
                  onSetMain={() => handleSetMain(img.filepath)}
                  onMoveLeft={() => handleReorder(img.filepath, -1)}
                  onMoveRight={() => handleReorder(img.filepath, 1)}
                  onRemove={() => handleRemoveImage(img.filepath)}
                  // v0.26.13: clicking the thumb opens the Lightbox at
                  // this index. Library owns the Lightbox state so it
                  // can also be opened from row/grid thumbs — we just
                  // hand the index back up.
                  onPreview={onPreview ? () => onPreview(i) : null}
                  onReframe={() => setReframeTarget(img)}
                  // v0.49.39: multi-select state for this tile.
                  selected={selectedImageIds.has(img.id)}
                  onToggleSelected={() => toggleImageSelected(img.id)}
                />
              ))}
            </div>
          )}
        </div>
        </div>
      </div>

      {!isCreate && product?.updatedAt ? (
        <div className="lib-panel__attribution">
          <Attribution
            updatedAt={product.updatedAt}
            updatedByUserId={product.updatedByUserId}
          />
          {/* v0.22.6: gateway into the audit trail. Kept as a tiny
              text-style link so it doesn't compete with Save/Delete
              for visual weight — power users go to History rarely. */}
          <button
            type="button"
            className="lib-panel__history-link"
            onClick={() => setHistoryOpen(true)}
            title="See every recorded edit to this product"
          >
            History →
          </button>
        </div>
      ) : null}

      {/* v0.22.6: full audit log feed for this product, including the
          interleaved image add/remove/set-main/reorder events. */}
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        entityType="product"
        entityId={activeProductId}
        title={`History — ${form.sku || 'product'}`}
      />

      {/* v0.29.0: per-image reframe. Commits in place + bumps the
          content hash, so on save we just refetch the image list to pick
          up the new cache-bust stamp. */}
      <ReframeModal
        open={!!reframeTarget}
        productId={activeProductId}
        image={reframeTarget}
        onClose={() => setReframeTarget(null)}
        onSaved={() => {
          if (activeProductId) {
            const gen = selectionGen.current;
            window.api.images.listByProduct(activeProductId)
              .then((rows) => { if (gen === selectionGen.current) setImages(rows); })
              .catch(() => {});
          }
        }}
      />


      <footer className="lib-panel__footer">
        {!isCreate ? (
          <>
            {/* v0.1.85: Delete used to be a red button right here, one slip away
                from Duplicate and Cancel. It now lives in this "⋯" menu, which
                is also where anything else destructive should go. */}
            <div className="copy-menu" data-product-more-menu>
              <Button
                onClick={() => setMoreMenuOpen((v) => !v)}
                title="More actions"
                aria-expanded={moreMenuOpen}
                aria-haspopup="menu"
                aria-label="More actions"
              >
                ⋯
              </Button>
              {moreMenuOpen ? (
                <div className="copy-menu__panel copy-menu__panel--up" role="menu">
                  {/* 0.1.94: Duplicate moved in here — the footer needed
                      ~414px in a ≤400px panel and Save was clipped. */}
                  <button
                    type="button"
                    className="copy-menu__item"
                    role="menuitem"
                    disabled={duplicating}
                    onClick={() => { setMoreMenuOpen(false); handleDuplicate(); }}
                  >
                    <span className="copy-menu__label">{duplicating ? 'Duplicating…' : 'Duplicate…'}</span>
                    <span className="copy-menu__hint">A copy with the same fields and photos; its SKU ends in “(copy)”.</span>
                  </button>
                  <div className="copy-menu__sep" aria-hidden />
                  <button
                    type="button"
                    className="copy-menu__item copy-menu__item--danger"
                    role="menuitem"
                    onClick={() => { setMoreMenuOpen(false); handleDelete(); }}
                  >
                    <span className="copy-menu__label">Delete product…</span>
                    <span className="copy-menu__hint">
                      Removes this product, its images and its AI generations. It waits in Settings →
                      Recently deleted so you can put it back; you will be asked to type
                      {form.sku ? ` “${form.sku}”` : ' the name'} to confirm.
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        <div className="lib-panel__footer-spacer" />
        {!isCreate ? (
          <Button onClick={handleProcess} title="Choose where to process this product: Image Workspace, AI Studio, Overlay or Social post">Process →</Button>
        ) : null}
        {/* 0.1.94: an existing product saves as you type, so this button
            closes the panel (after the pending save). Only a new, unsaved
            product has something to cancel. */}
        <Button onClick={onClose}>{isCreate ? 'Cancel' : 'Close'}</Button>
        <Button variant="primary" disabled={!skuValid || saving} onClick={handleSave}>
          {saving ? 'Saving…' : isCreate ? 'Create' : 'Save'}
        </Button>
      </footer>
    </aside>
  );
});

function ImageTile({ image, index, total, onSetMain, onMoveLeft, onMoveRight, onRemove, onPreview, onReframe, selected, onToggleSelected }) {
  // v0.22.9: cache-bust strictly. Order of preference for the
  // version stamp:
  //   1. image.contentHash — content-addressed, definitive.
  //   2. image.id          — row-addressed, stable per row identity.
  //   3. image.filepath    — last resort, BROKEN by itself because
  //                          renumberFiles recycles paths across rows
  //                          (the row that used to be at /004 now
  //                          lives at /003 after a delete).
  //
  // v0.22.8 used (1) || (3), which broke for legacy rows that
  // predate the content_hash column backfill from v0.10.x — their
  // contentHash is null, the fallback to filepath defeats the
  // cache bust, and the user still sees stale pixels after delete.
  // v0.22.9 inserts row id between content hash and filepath: id
  // differs between the deleted row and the surviving row that
  // takes its filepath slot, so the URL ?v=<id> definitively
  // changes even without a content hash.
  // Side-panel tiles are ~100 px squares: the 320 tier, never the full photo.
  const src = appImageSrc(image.filepath, image.contentHash || image.id || image.filepath, { w: 320 });
  const isMain = index === 0;
  // v0.26.13: thumb is now clickable to open the Lightbox. We wrap the
  // <img> in a transparent button so it gets keyboard focus + an ARIA
  // role for free. The existing controls (Set as main / Remove / arrows)
  // are siblings outside this button so their own clicks aren't shadowed
  // — no stopPropagation gymnastics needed.
  return (
    <div className={`image-tile${isMain ? ' is-main' : ''}${selected ? ' is-selected' : ''}`}>
      {/* v0.49.39: per-image multi-select checkbox. Sits top-LEFT so
          it doesn't overlap the existing X remove (top-right) or the
          Reframe button. Visible on hover OR when ANY image on the
          product is selected (so the rest of the grid shows their
          empty boxes too — Mac Finder pattern: once selection mode
          starts, all targets become tickable). */}
      {onToggleSelected ? (
        <label
          className="image-tile__check"
          onClick={(e) => e.stopPropagation()}
          title="Select for multi-action (Copy, Drag or Remove)"
          aria-label={`Select image #${index + 1}`}
        >
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelected}
          />
          <span className="image-tile__check-box" aria-hidden />
        </label>
      ) : null}
      {onPreview ? (
        <button
          type="button"
          className="image-tile__preview-btn"
          onClick={onPreview}
          aria-label={`Preview image #${index + 1} full size`}
          title="Click to preview"
        >
          <ConnImg src={src} alt="" loading="lazy" draggable={false} />
        </button>
      ) : (
        <ConnImg src={src} alt="" loading="lazy" draggable={false} />
      )}
      {isMain ? <span className="image-tile__badge">Main</span> : (
        <button type="button" className="image-tile__set-main" onClick={onSetMain}>
          Set as main
        </button>
      )}
      <button
        type="button"
        className="image-tile__remove"
        aria-label={`Remove ${isMain ? 'main ' : ''}image ${index + 1}`}
        title={`Remove ${isMain ? 'main ' : ''}image ${index + 1}`}
        onClick={onRemove}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {onReframe ? (
        <button
          type="button"
          className="image-tile__reframe"
          onClick={onReframe}
          title="Reframe — shrink this image within its frame and fill the margin"
        >Reframe</button>
      ) : null}
      <div className="image-tile__nav">
        <button
          type="button"
          className="image-tile__nav-btn"
          onClick={onMoveLeft}
          disabled={index === 0}
          aria-label="Move earlier"
        >←</button>
        <span className="image-tile__pos">
          #{index + 1}{image.fileSize ? <span className="image-tile__size"> · {fmtBytes(image.fileSize)}</span> : null}
        </span>
        <button
          type="button"
          className="image-tile__nav-btn"
          onClick={onMoveRight}
          disabled={index === total - 1}
          aria-label="Move later"
        >→</button>
      </div>
    </div>
  );
}
