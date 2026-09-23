/**
 * v0.1.66: the bulk edit table — a spreadsheet-style grid for many products at
 * once, opened from the Library's bulk "Image operations ▾" menu after ticking
 * products.
 *
 * Two things make it different from the existing BulkEditModal:
 *
 *   1. Cells, not checkboxes. Every column is a real <input> (or <select>), so
 *      typing, tabbing and pasting from Excel behave the way a spreadsheet
 *      does. Nothing is written to the database until "Save all" runs a dry run
 *      and the user confirms the summary.
 *   2. Photos paste into ONE cell. The dedicated Image cell is the only place a
 *      clipboard image is accepted, so pasting a photo is always intentional —
 *      everywhere else the paste is text. Both image modes (Add / Make main)
 *      are non-destructive; there is deliberately no replace/overwrite mode.
 *
 * The paste arithmetic (refuse a wide block, refuse a tall one, skip blank
 * cells) lives in bulkGridPaste.js — pure, unit-tested, reused here unchanged.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { appImageSrc } from '../../lib/imageUrl.js';
import { CURRENCIES } from '../../lib/currencies.js';
import { STATUS_OPTIONS } from './libraryConstants.js';
import { GRID_MAX_ROWS, planPaste } from './bulkGridPaste.js';
import { productValue, buildSaveRows } from './bulkTableRows.js';
import { ColumnsControl } from './LibraryColumns.jsx';
import {
  BUILTIN_SETS, builtinSetColumns, loadColumnSelection, saveColumnSelection,
  resolveSelection, selectionColumns, toggleColumn, moveColumn,
  orderedCatalogue, isEverything, hiddenEditedColumns,
} from './bulkColumns.js';

const CURRENCY_CODES = CURRENCIES.map((c) => c.code);
const HISTORY_LIMIT = 200;

/** Which columns can receive pasted TEXT. The Image cell cannot. */
function isTextColumn(col) { return col.key !== 'image'; }

/** Columns that hold free text long enough to wrap; they render a textarea. */
function isLongTextColumn(col) { return col.long === true; }

/* ── column widths ──────────────────────────────────────────────────────
 * v0.1.68: every data column is drag-resizable. The width map lives in ONE
 * localStorage key as `{ [columnKey]: px }`, following the same
 * load-on-init / save-on-change pattern as ProductLibrary.panelVisible.
 * A value below that column's floor (or a type whose rules changed) is
 * clamped on read, so a stale map can never collapse a column to zero.
 */
const COLUMN_WIDTHS_STORAGE_KEY = 'BulkTable.columnWidths';
const ROWNUM_WIDTH = 44;
// Floor by type — ~90px for text, ~70px for numbers and short codes.
const COLUMN_WIDTH_RULES = {
  text: { width: 150, min: 90, max: 420 },
  number: { width: 100, min: 70, max: 200 },
  currency: { width: 92, min: 70, max: 160 },
  select: { width: 150, min: 90, max: 280 },
  image: { width: 120, min: 90, max: 220 },
};
// A few columns deserve more room (or a higher ceiling) than their type.
const COLUMN_WIDTH_BY_KEY = {
  name: { width: 190, min: 90, max: 480 },
  description: { width: 240, min: 90, max: 640 },
  tags: { width: 190, min: 90, max: 480 },
  sku: { width: 130, min: 90, max: 320 },
};
function columnWidthRule(col) {
  if (COLUMN_WIDTH_BY_KEY[col.key]) return COLUMN_WIDTH_BY_KEY[col.key];
  if (col.key.startsWith('custom:')) return { width: 150, min: 90, max: 480 };
  return COLUMN_WIDTH_RULES[col.type] ?? COLUMN_WIDTH_RULES.text;
}
function loadColumnWidths() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function saveColumnWidths(map) {
  try { localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(map)); } catch {}
}

/**
 * v0.1.68: a one-row textarea that grows to fit its value. The bulk table's
 * cells used to be single-line <input>s inside a `white-space: nowrap` cell,
 * so a long name/description/tag was clipped and appeared to "disappear".
 * Height is re-synced from scrollHeight on value change (which covers typing
 * and the paste path, since the paste handler writes through React state),
 * on focus, and on paste directly. `overflow: hidden` + a synced height is
 * the standard auto-grow; nothing gets its own scrollbar.
 */
function AutoGrowTextarea({ value, className, onFocus, ...props }) {
  const ref = useRef(null);
  const sync = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const needed = el.scrollHeight;
    el.style.height = `${needed}px`;
    // border-box: scrollHeight omits the border, so 1px of border can still
    // clip the last line — and `overflow: hidden` would hide it silently.
    if (el.scrollHeight > el.clientHeight) {
      el.style.height = `${needed + (el.scrollHeight - el.clientHeight)}px`;
    }
  };
  useLayoutEffect(sync, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      value={value}
      onInput={sync}
      onFocus={(e) => { sync(); onFocus?.(e); }}
      onPaste={() => requestAnimationFrame(sync)}
      {...props}
    />
  );
}


export function BulkTableModal({ open, productIds, filters, onClose, onDone }) {
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const companies = useAppStore((s) => s.companies);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);

  const priceGroups = useMemo(
    () => (companies.find((c) => c.id === activeCompanyId)?.priceGroups) ?? [],
    [companies, activeCompanyId],
  );

  // Snapshot of the rows ON SCREEN. Deliberately not derived from the live
  // store: pasting a photo bumps updated_at, which re-sorts the Library by
  // "most recently updated", and a live list would shuffle the row indices
  // under the user's cursor (an edit would then land on the wrong product).
  const [rows, setRows] = useState([]);
  const [candidateCount, setCandidateCount] = useState(0);
  const [scope, setScope] = useState('selected');
  // edits['<rowIndex>:<columnKey>'] = the string the user typed or pasted.
  const [edits, setEdits] = useState({});
  const [imageMode, setImageMode] = useState('add'); // 'add' | 'main'
  const [imageState, setImageState] = useState({}); // rowIndex -> { count, mainImagePath, stamp }
  const [confirm, setConfirm] = useState(null);     // dry-run summary / refusal
  const [closePrompt, setClosePrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  // v0.1.68: remembered column widths (`{ [key]: px }`), loaded once at mount.
  const [colWidths, setColWidths] = useState(loadColumnWidths);
  const [resizingKey, setResizingKey] = useState(null);

  const historyRef = useRef([]);
  const imagesAddedRef = useRef(0);
  // Mirror of colWidths so a live drag can read the latest map without waiting
  // for a re-render, and so the drag's mouseup persists exactly what is shown.
  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;
  const dragRef = useRef(null);
  /* Where a paste will land. Kept in a ref, and mirrored from the real DOM
   * focus at paste time, because React state updates from onFocus are batched:
   * reading `focused` directly made a paste that arrived in the same tick as
   * the click land on the PREVIOUS cell. That is a real data-integrity bug
   * (found by the UI crawl), not a test artifact. */
  const focusedRef = useRef(null);
  function focusCell(row, key) {
    focusedRef.current = { row, key };
  }
  function cellInFocus() {
    const el = document.activeElement;
    const row = Number(el?.dataset?.row);
    const key = el?.dataset?.col;
    if (Number.isInteger(row) && key) return { row, key };
    return focusedRef.current;
  }
  const stateRef = useRef({});
  stateRef.current = { rows, edits, imageMode, confirm };

  /* ── scope loading ──────────────────────────────────────────────────── */

  function buildCandidates(scopeValue) {
    const state = useAppStore.getState();
    if (scopeValue === 'selected') {
      // Look in BOTH slices: `products` is the freshest filtered view and
      // `allProducts` is the filter-agnostic cache. A product created moments
      // ago can be in one and not yet the other.
      const byId = new Map();
      for (const p of state.allProducts ?? []) byId.set(p.id, p);
      for (const p of state.products ?? []) byId.set(p.id, p);
      return (productIds ?? []).map((id) => byId.get(id)).filter(Boolean);
    }
    let arr = state.products ?? [];
    const f = filters ?? state.productFilters ?? {};
    if (f.hasImages === 'with') arr = arr.filter((p) => Number(p.imageCount ?? 0) > 0);
    if (f.hasImages === 'without') arr = arr.filter((p) => Number(p.imageCount ?? 0) === 0);
    return arr;
  }

  function resetLocalState(base, nextScope) {
    setScope(nextScope);
    setRows(base.slice(0, GRID_MAX_ROWS));
    setCandidateCount(base.length);
    setEdits({});
    setImageState({});
    setConfirm(null);
    setClosePrompt(false);
    setImageMode('add');
    historyRef.current = [];
    imagesAddedRef.current = 0;
  }

  useEffect(() => {
    if (!open) return;
    const selected = buildCandidates('selected');
    if (selected.length > 0) {
      resetLocalState(selected, 'selected');
      return;
    }
    const filtered = buildCandidates('filter');
    resetLocalState(filtered, 'filter');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function switchScope(next) {
    if (next === scope) return;
    resetLocalState(buildCandidates(next), next);
  }

  /* ── columns ────────────────────────────────────────────────────────── */

  const customKeys = useMemo(() => {
    const set = new Set();
    for (const p of rows) for (const k of Object.keys(p.customFields ?? {})) set.add(k);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const columns = useMemo(() => {
    const cols = [
      { key: 'name', label: 'Name', type: 'text', long: true },
      { key: 'sku', label: 'SKU', type: 'text' },
      {
        key: 'brandId', label: 'Brand', type: 'select',
        options: [{ value: '', label: '— Unassigned —' }, ...brands.map((b) => ({ value: b.id, label: b.name }))],
      },
      {
        key: 'categoryId', label: 'Category', type: 'select',
        options: [{ value: '', label: '— Unassigned —' }, ...categories.map((c) => ({ value: c.id, label: c.name }))],
      },
      { key: 'subcategory', label: 'Subcategory', type: 'text' },
      { key: 'colorFinish', label: 'Color / Finish', type: 'text' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'variant', label: 'Variant', type: 'text' },
      { key: 'description', label: 'Description', type: 'text', long: true },
      { key: 'tags', label: 'Tags (comma-separated)', type: 'text', long: true },
      { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
      { key: 'stockQty', label: 'Stock', type: 'number' },
      { key: 'priceRetail', label: 'Retail price', type: 'number' },
      { key: 'priceRetailCurrency', label: 'Retail currency', type: 'currency' },
      { key: 'priceWholesale', label: 'Wholesale price', type: 'number' },
      { key: 'priceWholesaleCurrency', label: 'Wholesale currency', type: 'currency' },
    ];
    for (const g of priceGroups) {
      cols.push({ key: `price:${g.key}`, label: `${g.label} price`, type: 'number' });
      cols.push({ key: `priceCurrency:${g.key}`, label: `${g.label} currency`, type: 'currency' });
    }
    for (const k of customKeys) {
      cols.push({ key: `custom:${k}`, label: k, type: 'text', long: true });
    }
    // v0.1.71: logistics & sourcing — the fields the Logistics built-in set
    // needs, and the same field names bulkUpsert already accepts.
    cols.push({ key: 'supplierSku', label: 'Supplier SKU', type: 'text' });
    cols.push({ key: 'hsCode', label: 'HS code', type: 'text' });
    cols.push({ key: 'cartonWCm', label: 'Carton width (cm)', type: 'number' });
    cols.push({ key: 'cartonHCm', label: 'Carton height (cm)', type: 'number' });
    cols.push({ key: 'cartonDCm', label: 'Carton depth (cm)', type: 'number' });
    cols.push({ key: 'weightPerUnitKg', label: 'Weight (kg)', type: 'number' });
    cols.push({ key: 'image', label: 'Image', type: 'image' });
    return cols;
  }, [brands, categories, priceGroups, customKeys]);

  const catalogueKeys = useMemo(() => columns.map((c) => c.key), [columns]);

  /* v0.1.71: which columns are on screen, and in what order. The selection is
   * an ordered array of keys, or `null` for Everything (the historical
   * behaviour, and the default). Saved sets live in the database; the
   * last-used selection lives in localStorage so it is instant and offline. */
  const [colSelection, setColSelection] = useState(loadColumnSelection);

  const visibleColumns = useMemo(() => {
    const resolved = resolveSelection(colSelection, catalogueKeys);
    if (resolved === null) return columns;
    const byKey = new Map(columns.map((c) => [c.key, c]));
    return resolved.map((k) => byKey.get(k)).filter(Boolean);
  }, [columns, catalogueKeys, colSelection]);

  const visibleKeySet = useMemo(() => new Set(visibleColumns.map((c) => c.key)), [visibleColumns]);

  /* The picker lists selected columns in their chosen order first, then the
   * rest of the catalogue — so arrows reorder what is on screen, and a fresh
   * table (Everything) is simply catalogue order. */
  const pickerCatalogue = useMemo(() => {
    const order = orderedCatalogue(catalogueKeys, colSelection);
    const byKey = new Map(columns.map((c) => [c.key, c]));
    return order.map((k) => byKey.get(k)).filter(Boolean);
  }, [columns, catalogueKeys, colSelection]);

  function applySelection(selection) {
    const resolved = selection === null ? null : resolveSelection(selection, catalogueKeys);
    setColSelection(resolved);
    saveColumnSelection(resolved);
  }

  function toggleColumnVisibility(key) {
    applySelection(toggleColumn(colSelection, key, catalogueKeys));
    setActiveSet('__custom');
  }

  function moveColumnOrder(key, dir) {
    applySelection(moveColumn(colSelection, key, dir, catalogueKeys));
    setActiveSet('__custom');
  }

  /* ── saved sets (company-scoped, in the database) ───────────────────── */

  const [savedSets, setSavedSets] = useState([]);
  const [activeSet, setActiveSet] = useState('everything');
  const [setForm, setSetForm] = useState(null); // { mode: 'save'|'rename', id?, name }
  const [setsBusy, setSetsBusy] = useState(false);

  useEffect(() => {
    if (!open || !activeCompanyId) return;
    let alive = true;
    window.api.bulkColumns.list(activeCompanyId)
      .then((rows) => { if (alive) setSavedSets(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* offline / not reachable — built-ins still work */ });
    return () => { alive = false; };
  }, [open, activeCompanyId]);

  async function saveSet(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) { addToast('Give the set a name first.', 'info'); return; }
    const columns = selectionColumns(colSelection, catalogueKeys);
    setSetsBusy(true);
    try {
      const row = await window.api.bulkColumns.create({ companyId: activeCompanyId, name: trimmed, columns });
      setSavedSets((prev) => [row, ...prev]);
      setActiveSet(row.id);
      setSetForm(null);
      addToast(`Saved column set “${row.name}”.`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSetsBusy(false);
    }
  }

  async function renameSet(id, name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) { addToast('Give the set a name first.', 'info'); return; }
    setSetsBusy(true);
    try {
      const row = await window.api.bulkColumns.update(id, { name: trimmed });
      setSavedSets((prev) => prev.map((s) => (s.id === id ? row : s)));
      setSetForm(null);
      addToast(`Renamed to “${row.name}”.`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSetsBusy(false);
    }
  }

  async function deleteSet(id) {
    const target = savedSets.find((s) => s.id === id);
    setSetsBusy(true);
    try {
      await window.api.bulkColumns.remove(id);
      setSavedSets((prev) => prev.filter((s) => s.id !== id));
      if (activeSet === id) setActiveSet('everything');
      addToast(`Deleted column set “${target?.name ?? ''}”.`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSetsBusy(false);
    }
  }

  function chooseSet(value) {
    setSetForm(null);
    if (value === '') { applySelection(null); setActiveSet('everything'); return; }
    const builtin = BUILTIN_SETS.find((s) => s.key === value);
    if (builtin) {
      applySelection(builtinSetColumns(value, catalogueKeys));
      setActiveSet(value);
      return;
    }
    const saved = savedSets.find((s) => s.id === value);
    if (saved) {
      applySelection(saved.columns);
      setActiveSet(value);
    }
  }

  const activeSavedSet = savedSets.find((s) => s.id === activeSet) ?? null;
  const isEverythingSelection = isEverything(colSelection, catalogueKeys);

  // Paste walks the columns ON SCREEN, so hiding one takes it out of the
  // paste block. (Edits in a hidden column are still kept and saved — see the
  // hidden-edit note in the toolbar.)
  const textColumns = useMemo(() => visibleColumns.filter(isTextColumn), [visibleColumns]);
  const textColumnKeys = useMemo(() => textColumns.map((c) => c.key), [textColumns]);

  /* ── edits + undo ───────────────────────────────────────────────────── */

  function commitEdits(updater, coalesceKey) {
    setEdits((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (next === prev) return prev;
      const now = Date.now();
      const top = historyRef.current[historyRef.current.length - 1];
      const coalesce = coalesceKey && top && top.key === coalesceKey && now - top.ts < 900;
      if (!coalesce) {
        historyRef.current.push({ edits: prev, key: coalesceKey ?? null, ts: now });
        if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
      } else {
        top.ts = now;
      }
      return next;
    });
  }

  function setCell(row, key, value) {
    commitEdits((prev) => {
      const next = { ...prev };
      next[`${row}:${key}`] = value;
      return next;
    }, `${row}:${key}`);
  }

  function undo() {
    const entry = historyRef.current.pop();
    if (!entry) {
      addToast('Nothing to undo in the table.', 'info');
      return;
    }
    setEdits(entry.edits);
    setConfirm(null);
    setClosePrompt(false);
  }

  function cellValue(row, key) {
    const edited = edits[`${row}:${key}`];
    if (edited !== undefined) return edited;
    return productValue(rows[row], key);
  }

  /* ── column widths: drag, auto-fit, reset ───────────────────────────── */

  /** The px width for a column: the stored value clamped to its type's floor
   *  and ceiling, or the default when nothing is stored. */
  function widthOf(col) {
    const rule = columnWidthRule(col);
    const stored = Number(colWidths[col.key]);
    if (Number.isFinite(stored) && stored > 0) return Math.min(rule.max, Math.max(rule.min, stored));
    return rule.width;
  }

  function applyWidth(key, px) {
    const next = { ...colWidthsRef.current, [key]: px };
    colWidthsRef.current = next;
    setColWidths(next);
    saveColumnWidths(next);
  }

  function beginResize(e, col) {
    e.preventDefault();
    e.stopPropagation();
    const rule = columnWidthRule(col);
    const startX = e.clientX;
    const startWidth = widthOf(col);
    dragRef.current = { key: col.key, startX, startWidth, rule };
    setResizingKey(col.key);
    const onMove = (ev) => {
      const drag = dragRef.current;
      if (!drag) return;
      const px = Math.round(Math.min(drag.rule.max, Math.max(drag.rule.min, drag.startWidth + (ev.clientX - drag.startX))));
      const next = { ...colWidthsRef.current, [drag.key]: px };
      colWidthsRef.current = next;
      setColWidths(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dragRef.current = null;
      setResizingKey(null);
      // Persist once at the end of the gesture, not on every mousemove.
      saveColumnWidths(colWidthsRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** Double-click the resize strip: size the column to its widest rendered
   *  value (or its header), clamped to the type's floor and ceiling. A canvas
   *  measure is enough — the grid uses one font size throughout. */
  function autoFitColumn(col) {
    const rule = columnWidthRule(col);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    ctx.font = `12px ${family}`;
    let widest = ctx.measureText(col.label).width;
    const sel = `[data-row][data-col="${CSS.escape(col.key)}"]`;
    for (const el of document.querySelectorAll(sel)) {
      const raw = 'value' in el ? el.value : (el.selectedOptions?.[0]?.textContent ?? '');
      for (const line of String(raw ?? '').split('\n')) {
        widest = Math.max(widest, ctx.measureText(line).width);
      }
    }
    // +26px covers cell padding, the sort/resize strip and a little breathing room.
    applyWidth(col.key, Math.round(Math.min(rule.max, Math.max(rule.min, widest + 26))));
  }

  /** Forget every remembered width. */
  function resetColumns() {
    colWidthsRef.current = {};
    setColWidths({});
    try { localStorage.removeItem(COLUMN_WIDTHS_STORAGE_KEY); } catch {}
    addToast('Column widths reset.', 'info');
  }

  /* One prompt per action: opening one dismisses the other, so the dry-run
   * summary and the unsaved-close prompt can never stack. */
  function showConfirm(next) {
    setClosePrompt(false);
    setConfirm(next);
  }

  /* ── keyboard: ⌘Z undo, ⌘V / ⇧⌘V set the image mode ─────────────────── */

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = String(e.key || '').toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        undo();
      } else if (key === 'v') {
        // The paste event itself carries no modifier state, so the keydown
        // latches which mode the paste that follows should use. This is what
        // makes ⌘V = add and ⇧⌘V = make main.
        setImageMode(e.shiftKey ? 'main' : 'add');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* ── image cell ─────────────────────────────────────────────────────── */

  function imageFor(row) {
    const local = imageState[row];
    if (local) return local;
    const p = rows[row];
    return {
      count: Number(p?.imageCount ?? 0),
      mainImagePath: p?.mainImagePath ?? null,
      stamp: p?.updatedAt ?? null,
    };
  }

  async function pasteImage(imageItems, f) {
    const { rows: currentRows, imageMode: mode } = stateRef.current;
    if (!f || f.key !== 'image') return;
    const product = currentRows[f.row];
    if (!product) return;
    if (imageItems.length > 1) {
      addToast(`The clipboard has ${imageItems.length} images — paste them one at a time.`, 'info');
      return;
    }
    const item = imageItems[0];
    const blob = item.getAsFile ? item.getAsFile() : null;
    if (!blob) return;
    const label = `row ${f.row + 1}${product.sku ? ` (${product.sku})` : ''}`;
    try {
      const buf = await blob.arrayBuffer();
      const subtype = (blob.type.split('/')[1] || 'png').toLowerCase();
      const ext = subtype === 'jpeg' ? '.jpg' : `.${subtype}`;
      const res = await window.api.images.importFromBytes(product.id, buf, ext);
      if (res?.skipped) {
        addToast('Same image already on this product — skipped.', 'info');
      } else {
        imagesAddedRef.current += 1;
      }
      // Make main also runs on a skipped duplicate: the bytes are already on
      // the product, and "make THIS the main" is still the user's intent.
      if (mode === 'main' && res?.added?.filepath) {
        await window.api.images.setMainImage(product.id, res.added.filepath);
      }
      const list = Array.isArray(res?.images) ? res.images : [];
      setImageState((prev) => {
        const before = prev[f.row]?.count ?? Number(product.imageCount ?? 0);
        // First image on a product becomes the main one in the database, so
        // mirror that locally instead of showing a blank thumbnail.
        const mainImagePath = mode === 'main'
          ? (res?.added?.filepath ?? prev[f.row]?.mainImagePath ?? null)
          : (before === 0 ? (res?.added?.filepath ?? null) : (prev[f.row]?.mainImagePath ?? product.mainImagePath ?? null));
        return { ...prev, [f.row]: { count: list.length, mainImagePath, stamp: Date.now() } };
      });
      addToast(mode === 'main' ? 'Photo pasted as the main image' : 'Photo added as a new image', 'success');
    } catch (err) {
      // The 50-image cap throws from main — name the row and move on. This is
      // never fatal to the rest of the table.
      addToast(`${label}: ${err.message}`, 'error');
    }
  }

  /* ── paste (text + image) ───────────────────────────────────────────── */

  function onPaste(e) {
    // The DOM focus is the truth — see the note on focusedRef above.
    const f = cellInFocus();
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((it) => String(it.type || '').startsWith('image/'));

    if (imageItems.length > 0) {
      if (!f || f.key !== 'image') {
        addToast('Paste photos into the Image cell — every other cell takes text.', 'info');
        return;
      }
      e.preventDefault();
      pasteImage(imageItems, f);
      return;
    }

    if (!f || f.key === 'image') {
      addToast('The Image cell takes a pasted photo. Text goes in the other columns.', 'info');
      return;
    }

    const text = e.clipboardData?.getData('text/plain') ?? '';
    const colIndex = textColumnKeys.indexOf(f.key);
    const plan = planPaste({
      text,
      rowIndex: f.row,
      colIndex,
      columns: textColumnKeys,
      rowCount: stateRef.current.rows.length,
    });
    e.preventDefault();
    if (!plan.ok) {
      addToast(plan.reason, 'info');
      return;
    }
    commitEdits((prev) => {
      const next = { ...prev };
      for (const cell of plan.cells) next[`${cell.row}:${cell.key}`] = cell.value;
      return next;
    }, null);
    addToast(`Pasted ${plan.cells.length} cell${plan.cells.length === 1 ? '' : 's'}.`, 'success');
  }

  /* ── saving ─────────────────────────────────────────────────────────── */

  /**
   * Turn the edited cells into one bulkUpsert row per changed product.
   *
   * v0.1.71: the builder moved to bulkTableRows.js so the two rules that must
   * hold are unit-testable:
   *   - SKU is ALWAYS read (even when its column is hidden) — it keys the row;
   *   - edits are iterated by key, so an edit in a hidden column still saves.
   * This thin wrapper only supplies the visible rows + the edit map.
   */
  function buildRows() {
    return buildSaveRows(rows, edits);
  }

  async function runDryRun() {
    if (Object.keys(edits).length === 0) {
      addToast('No cell edits to save yet.', 'info');
      return;
    }
    const { saveRows, meta, problems } = buildRows();
    if (problems.length) {
      const summary = problems.map((p) => `row ${p.rowNo}: ${p.reason}`).join('; ');
      showConfirm({ kind: 'refuse', summary: `Save refused — ${summary}` });
      addToast(`Save refused — ${summary}`, 'error');
      return;
    }
    if (saveRows.length === 0) {
      addToast('No cell edits to save yet.', 'info');
      return;
    }
    setBusy(true);
    try {
      const dry = await window.api.products.bulkUpsert(activeCompanyId, saveRows, {
        conflictPolicy: 'overwrite', dryRun: true,
      });
      const changes = Array.isArray(dry?.changes) ? dry.changes : [];
      const dryProblems = [];
      changes.forEach((ch, i) => {
        const m = meta[i];
        if (!m || !ch) return;
        if (ch.action === 'skip') {
          dryProblems.push({ rowNo: m.rowNo, reason: ch.reason || 'skipped' });
        } else if (ch.action === 'update' && ch.existingId !== m.id) {
          dryProblems.push({ rowNo: m.rowNo, reason: `SKU “${m.sku}” is already used by another product` });
        } else if (ch.action === 'insert' && !m.skuEdited) {
          dryProblems.push({ rowNo: m.rowNo, reason: `SKU “${m.sku}” no longer matches a product` });
        }
      });
      const updated = changes.filter((c) => c && c.action === 'update').length;
      const renames = changes.filter((c) => c && c.action === 'insert').length;
      const summary = [
        `${updated} updated`,
        renames ? `${renames} renamed` : null,
        dryProblems.length ? `${dryProblems.length} skipped` : null,
      ].filter(Boolean).join(' · ');
      const detail = dryProblems.map((p) => `row ${p.rowNo}: ${p.reason}`).join('; ');
      if (dryProblems.length) {
        const text = `Save refused · ${summary} — ${detail}`;
        showConfirm({ kind: 'refuse', summary: text });
        addToast(text, 'error');
        return;
      }
      showConfirm({
        kind: 'save', summary: `${summary}${detail ? ` — ${detail}` : ''}`,
        rows: saveRows, meta, updated, renames, count: saveRows.length,
      });
      addToast(`Ready to save · ${summary}`, 'info');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function commitSave() {
    const pending = confirm;
    if (!pending || pending.kind !== 'save') return;
    setBusy(true);
    try {
      /* A changed SKU is a RENAME, and bulkUpsert is keyed by SKU — it can only
       * match or insert, never rename. So the renames go through the existing
       * products:update channel first, then bulkUpsert sees the new SKUs and
       * writes the rest of the touched fields. */
      for (const m of pending.meta) {
        if (m.skuEdited) await window.api.products.update(m.id, { sku: m.sku });
      }
      const live = await window.api.products.bulkUpsert(activeCompanyId, pending.rows, {
        conflictPolicy: 'overwrite', dryRun: false,
      });
      // A pure SKU rename reports no field diff, so count those too or
      // "Saved 0 products" would be printed for a save that did rename one.
      const pureRenames = pending.meta.filter((m) => m.skuEdited && m.onlySku).length;
      const saved = (live?.updated ?? 0) + pureRenames;
      const added = imagesAddedRef.current;
      addToast(
        `Saved ${saved} product${saved === 1 ? '' : 's'}${added ? ` · ${added} image${added === 1 ? '' : 's'} added` : ''}.`,
        'success',
      );
      useAppStore.getState().refreshProducts?.();
      useAppStore.getState().refreshAllProducts?.();
      setEdits({});
      historyRef.current = [];
      setConfirm(null);
      setClosePrompt(false);
      onDone?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /* ── closing ────────────────────────────────────────────────────────── */

  function requestClose() {
    if (Object.keys(edits).length > 0) {
      // Dismiss any open summary first: one action, one prompt.
      setConfirm(null);
      setClosePrompt(true);
      return;
    }
    onClose?.();
  }

  /* ── render ─────────────────────────────────────────────────────────── */

  if (!open) return null;

  const dirty = Object.keys(edits).length;
  const truncated = candidateCount - rows.length;
  const totalWidth = ROWNUM_WIDTH + visibleColumns.reduce((sum, c) => sum + widthOf(c), 0);
  // Edits are keyed by product + FIELD, so hiding a column never discards them.
  // The toolbar says how many are tucked away so nothing disappears silently.
  const hiddenDirty = hiddenEditedColumns(edits, catalogueKeys, colSelection);

  /* v0.1.71: the sets menu that rides above the shared ColumnsControl list.
   * Built-ins are code-only; saved sets are company-scoped DB rows. */
  const setSelectValue = isEverythingSelection
    ? 'everything'
    : (BUILTIN_SETS.some((s) => s.key === activeSet) || savedSets.some((s) => s.id === activeSet))
      ? activeSet
      : '__custom';
  const columnsHeader = (
    <div className="bulk-columns__sets">
      <div className="bulk-columns__sets-row">
        <Select
          aria-label="Column set"
          className="bulk-columns__set-select"
          value={setSelectValue}
          disabled={setsBusy}
          onChange={(e) => chooseSet(e.target.value)}
        >
          <option value="__custom">Custom</option>
          <optgroup label="Built-in">
            {BUILTIN_SETS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </optgroup>
          {savedSets.length ? (
            <optgroup label="Saved">
              {savedSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </optgroup>
          ) : null}
        </Select>
      </div>
      <div className="bulk-columns__set-actions">
        <button
          type="button"
          className="lib-columns__reset"
          disabled={setsBusy}
          onClick={() => setSetForm({ mode: 'save', name: '' })}
        >Save as set…</button>
        {activeSavedSet ? (
          <>
            <button
              type="button"
              className="lib-columns__reset"
              disabled={setsBusy}
              onClick={() => setSetForm({ mode: 'rename', id: activeSavedSet.id, name: activeSavedSet.name })}
            >Rename</button>
            <button
              type="button"
              className="lib-columns__reset"
              disabled={setsBusy}
              onClick={() => deleteSet(activeSavedSet.id)}
            >Delete</button>
          </>
        ) : null}
      </div>
      {setForm ? (
        <div className="bulk-columns__set-form">
          <input
            className="input bulk-columns__set-input"
            aria-label="Set name"
            placeholder="Set name"
            value={setForm.name}
            disabled={setsBusy}
            onChange={(e) => setSetForm((f) => ({ ...f, name: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (setForm.mode === 'rename') renameSet(setForm.id, setForm.name);
              else saveSet(setForm.name);
            }}
          />
          <button
            type="button"
            className="lib-columns__reset"
            disabled={setsBusy}
            onClick={() => (setForm.mode === 'rename' ? renameSet(setForm.id, setForm.name) : saveSet(setForm.name))}
          >{setForm.mode === 'rename' ? 'Rename set' : 'Save set'}</button>
          <button
            type="button"
            className="lib-columns__reset"
            disabled={setsBusy}
            onClick={() => setSetForm(null)}
          >Cancel</button>
        </div>
      ) : null}
    </div>
  );

  return (
    <Modal
      open={open}
      size="xxl"
      title={`Bulk table · ${rows.length} product${rows.length === 1 ? '' : 's'}`}
      onClose={requestClose}
    >
      <div className="bulk-table" onPaste={onPaste}>
        <div className="bulk-table__toolbar">
          <fieldset className="bulk-overlay-run__group bulk-table__scope">
            <legend>Scope</legend>
            <label className="bulk-overlay-run__radio">
              <input
                type="radio"
                name="bulk-table-scope"
                checked={scope === 'selected'}
                onChange={() => switchScope('selected')}
              />
              <span>
                Selected <span className="muted">({(productIds ?? []).length})</span>
              </span>
            </label>
            <label className="bulk-overlay-run__radio">
              <input
                type="radio"
                name="bulk-table-scope"
                checked={scope === 'filter'}
                onChange={() => switchScope('filter')}
              />
              <span>
                Current Library filter <span className="muted">({candidateCount} match{scope === 'filter' && truncated ? `, first ${rows.length} shown` : ''})</span>
              </span>
            </label>
          </fieldset>

          <div className="bulk-table__imagectl">
            <span className="bulk-table__imagectl-label">Add · Make main</span>
            <div className="ws-toolbar__group">
              <button
                type="button"
                className={`segment${imageMode === 'add' ? ' is-active' : ''}`}
                aria-pressed={imageMode === 'add'}
                onClick={() => setImageMode('add')}
                title="⌘V — paste the photo as a new image, your main image stays put"
              >Add</button>
              <button
                type="button"
                className={`segment${imageMode === 'main' ? ' is-active' : ''}`}
                aria-pressed={imageMode === 'main'}
                onClick={() => setImageMode('main')}
                title="⇧⌘V — paste the photo and make it the main image (position 0)"
              >Make main</button>
            </div>
          </div>

          <div className="bulk-table__spacer" />
          {hiddenDirty > 0 ? (
            <span
              className="bulk-table__hidden-edits"
              role="status"
              title="Edits are keyed by product and field, so hiding a column does not discard them — they are still saved."
            >
              {hiddenDirty} hidden column edit{hiddenDirty === 1 ? '' : 's'} kept
            </span>
          ) : null}
          <ColumnsControl
            defs={pickerCatalogue}
            visibleCols={visibleKeySet}
            onToggle={toggleColumnVisibility}
            onMove={moveColumnOrder}
            onReset={() => { applySelection(null); setActiveSet('everything'); }}
            label={`Columns ▾ · ${visibleColumns.length}/${columns.length}`}
            lockedItems={[]}
            header={columnsHeader}
            title="Choose which columns appear in the bulk table"
            resetTitle="Show every column (the Everything set)"
          />
          <Button onClick={resetColumns} disabled={busy} title="Forget the saved column widths and go back to the defaults">Reset columns</Button>
          <Button onClick={undo} disabled={busy} title="Undo the last cell edit (⌘Z)">Undo</Button>
          <Button variant="primary" onClick={runDryRun} disabled={busy || dirty === 0} className="bulk-table__save">
            {busy ? 'Working…' : 'Save all'}
          </Button>
          <Button onClick={requestClose} disabled={busy}>Close</Button>
        </div>

        {truncated > 0 ? (
          <p className="bulk-table__notice">
            {candidateCount} products match, and the table holds up to {GRID_MAX_ROWS}. The first {rows.length} are shown
            (the Library is sorted newest first) — narrow the filter to reach the rest.
          </p>
        ) : null}

        <div className="bulk-table__scroll">
          <table className="bulk-table__grid" style={{ tableLayout: 'fixed', width: `${totalWidth}px`, minWidth: '100%' }}>
            <colgroup>
              <col data-col="#" style={{ width: `${ROWNUM_WIDTH}px` }} />
              {visibleColumns.map((c) => <col key={c.key} data-col={c.key} style={{ width: `${widthOf(c)}px` }} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="bulk-table__rownum" scope="col">#</th>
                {visibleColumns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.label}
                    className={resizingKey === c.key ? 'is-resizing' : undefined}
                  >
                    <span className="bulk-table__th-label">{c.label}</span>
                    <span
                      className="bulk-table__resizer"
                      data-col-resize={c.key}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${c.label} column`}
                      title="Drag to resize · double-click to fit the widest value"
                      onMouseDown={(e) => beginResize(e, c)}
                      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); autoFitColumn(c); }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((product, r) => (
                <tr key={product.id ?? r} className="bulk-table__row" data-row={r}>
                  <td className="bulk-table__rownum">{r + 1}</td>
                  {visibleColumns.map((c) => {
                    if (c.type === 'image') {
                      const img = imageFor(r);
                      return (
                        <td key={c.key} className="bulk-table__cell bulk-table__cell--image">
                          <div
                            className="bulk-table__image"
                            tabIndex={0}
                            data-row={r}
                            data-col="image"
                            aria-label={`Image for row ${r + 1}: ${img.count} of 50`}
                            onFocus={() => focusCell(r, 'image')}
                          >
                            {img.mainImagePath ? (
                              <img className="bulk-table__thumb" src={appImageSrc(img.mainImagePath, img.stamp)} alt="" />
                            ) : (
                              <span className="bulk-table__thumb bulk-table__thumb--empty" aria-hidden="true" />
                            )}
                            <span className="bulk-table__image-count" data-col="image-count">{img.count} / 50</span>
                          </div>
                        </td>
                      );
                    }
                    const value = cellValue(r, c.key);
                    if (c.type === 'select') {
                      return (
                        <td key={c.key} className="bulk-table__cell">
                          <Select
                            data-row={r}
                            data-col={c.key}
                            value={value == null ? '' : String(value)}
                            onFocus={() => focusCell(r, c.key)}
                            onChange={(e) => setCell(r, c.key, e.target.value)}
                            aria-label={`${c.label} row ${r + 1}`}
                          >
                            {c.options.map((o) => <option key={o.value || '__blank'} value={o.value}>{o.label}</option>)}
                          </Select>
                        </td>
                      );
                    }
                    // Long free-text columns wrap and grow instead of clipping.
                    if (isLongTextColumn(c)) {
                      return (
                        <td key={c.key} className="bulk-table__cell bulk-table__cell--wrap">
                          <AutoGrowTextarea
                            className="bulk-table__textarea"
                            data-row={r}
                            data-col={c.key}
                            value={value == null ? '' : String(value)}
                            onFocus={() => focusCell(r, c.key)}
                            onChange={(e) => setCell(r, c.key, e.target.value)}
                            aria-label={`${c.label} row ${r + 1}`}
                          />
                        </td>
                      );
                    }
                    const isCurrency = c.type === 'currency';
                    return (
                      <td key={c.key} className="bulk-table__cell">
                        <input
                          className={`bulk-table__input${c.type === 'number' ? ' bulk-table__input--num' : ''}`}
                          type={c.type === 'number' ? 'number' : 'text'}
                          step={c.type === 'number' ? 'any' : undefined}
                          list={isCurrency ? 'bulk-table-currency-codes' : undefined}
                          data-row={r}
                          data-col={c.key}
                          value={value == null ? '' : String(value)}
                          onFocus={() => focusCell(r, c.key)}
                          onChange={(e) => setCell(r, c.key, e.target.value)}
                          aria-label={`${c.label} row ${r + 1}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <datalist id="bulk-table-currency-codes">
          {CURRENCY_CODES.map((code) => <option key={code} value={code} />)}
        </datalist>

        <p className="bulk-table__hint">
          Paste into the Image cell only — <strong>⌘V</strong> adds the photo last and keeps your main image, <strong>⇧⌘V</strong> makes
          the pasted photo the main one (nothing is ever overwritten). Pasting text anywhere else fills cells from the focused
          cell, and is refused whole if it does not fit. <strong>⌘Z</strong> undoes a cell edit.
        </p>

        {confirm ? (
          <div className={`bulk-table__confirm${confirm.kind === 'refuse' ? ' is-error' : ''}`} role="status">
            <span className="bulk-table__confirm-text">{confirm.summary}</span>
            <div className="bulk-table__spacer" />
            {confirm.kind === 'save' ? (
              <>
                <Button onClick={() => setConfirm(null)} disabled={busy}>Keep editing</Button>
                <Button variant="primary" onClick={commitSave} disabled={busy}>
                  {busy ? 'Saving…' : `Save ${confirm.count ?? 0} product${(confirm.count ?? 0) === 1 ? '' : 's'}`}
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirm(null)}>Dismiss</Button>
            )}
          </div>
        ) : null}

        {closePrompt ? (
          <div className="bulk-table__confirm is-error" role="status">
            <span className="bulk-table__confirm-text">
              You have {dirty} unsaved cell edit{dirty === 1 ? '' : 's'}. Close without saving?
            </span>
            <div className="bulk-table__spacer" />
            <Button onClick={() => setClosePrompt(false)}>Keep editing</Button>
            <Button variant="danger" onClick={() => { setClosePrompt(false); onClose?.(); }}>Discard and close</Button>
          </div>
        ) : null}

        <div className="bulk-table__footer-note">
          {dirty > 0
            ? `${dirty} unsaved cell edit${dirty === 1 ? '' : 's'} — nothing is written until you confirm the Save all summary.`
            : 'No unsaved edits.'}
        </div>
      </div>
    </Modal>
  );
}
