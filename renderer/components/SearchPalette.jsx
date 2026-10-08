/**
 * v0.18.2: global search palette (Cmd+K).
 *
 * 0.1.94: products match with the Library's rule (main/db/search.js — every
 * word must match, SKU separators ignored, Khmer-safe) plus an EXACT barcode,
 * which shows a "barcode" tag; an exact SKU / barcode hit is ranked first.
 *
 * Opens via the Cmd/Ctrl+K shortcut wired in App.jsx. Searches
 * across products (SKU, name, color/finish — v0.49.37 narrowed from
 * the original sku+name+barcode+secondary_code+description+color set;
 * a barcode hit looks identical to a name hit in the dropdown, so
 * users couldn't tell why a row was matching), brands (name), and
 * categories (name), plus permitted saved catalogs/templates and operations
 * records for the active company. Live results as you type
 * with a 150ms debounce so we don't hammer the server on every keystroke.
 *
 * Keyboard model:
 *   - ↑ / ↓ — move the highlight
 *   - Enter — open the highlighted result
 *   - Esc   — close the palette
 *   - Tab   — closes (matches Spotlight / Raycast)
 *
 * Click also opens. Picking a result:
 *   - product  → open Library, set side-panel to that product
 *   - brand    → open Library filtered to that brand (v0.1.89 — it used to
 *                land on the Brands page with nothing selected)
 *   - category → open Library with that category filtered
 *   - supplier → open Purchase Orders filtered to that supplier (v0.1.89)
 *   - po       → open that purchase order (v0.1.89)
 *   - catalogProject / catalogTemplate → open the saved editor after flushing drafts
 * Suppliers and POs only come back for an account that may see costing —
 * the server decides (main/ipc/search.js).
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/index.js';
import { useUserCaps } from './Sidebar.jsx';
import { hasCap } from '../lib/capabilities.js';

const DEBOUNCE_MS = 150;

function kindBadge(kind) {
  switch (kind) {
    case 'product':  return 'Product';
    case 'brand':    return 'Brand';
    case 'category': return 'Category';
    case 'supplier': return 'Supplier';
    case 'po':       return 'PO';
    case 'catalogProject': return 'Catalog';
    case 'catalogTemplate': return 'Template';
    default:         return kind || '';
  }
}

export function SearchPalette({ open, onClose }) {
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const openLibraryProduct = useAppStore((s) => s.openLibraryProduct);
  const openCatalogProject = useAppStore((s) => s.openCatalogProject);
  const openCatalogTemplate = useAppStore((s) => s.openCatalogTemplate);
  const resetFilters = useAppStore((s) => s.resetFilters);
  const setCategoryFilter = useAppStore((s) => s.toggleCategoryFilter);
  const toggleBrandFilter = useAppStore((s) => s.toggleBrandFilter);
  const openPurchaseOrder = useAppStore((s) => s.openPurchaseOrder);
  const openPurchaseOrdersForSupplier = useAppStore((s) => s.openPurchaseOrdersForSupplier);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const userCaps = useUserCaps();
  const canSeeCosting = hasCap(userCaps, 'costing.view');
  const canSeeCatalog = hasCap(userCaps, 'catalog.design');

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const [searching, setSearching] = useState(false);
  // v0.1.89: a failed search says so. It used to read "No matches", which is
  // a different — and wrong — answer.
  const [searchError, setSearchError] = useState(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  /** Monotonic id for the newest search, so an older response can be ignored. */
  const searchSeq = useRef(0);
  const resultScope = useRef(null);
  const currentScope = `${activeCompanyId}|${query.trim()}|${canSeeCosting}|${canSeeCatalog}`;
  const visibleResults = resultScope.current === currentScope ? results : [];
  /* 0.1.94: Enter pressed before the results for what is typed have arrived
   * (a barcode scanner types and presses Enter in one burst) is queued and
   * opens the top result once they land, instead of being dropped. The top
   * result is the best one: the server ranks an exact SKU / barcode first. */
  const [enterQueued, setEnterQueued] = useState(false);

  // Reset state every time the palette opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setSearchError(null);
    setHighlight(0);
    setEnterQueued(false);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    /* v0.1.27: every effect run claims a new sequence number, and a response
     * is only committed if it is still the newest.
     *
     * The previous guard was `if (query.trim() === q)` — but `q` is derived
     * from `query` in the SAME render closure, so it compared a value with
     * itself and was always true. An in-flight search for an earlier query
     * could therefore land after a newer one and overwrite it with staler
     * results (and clear the "searching" indicator while the new one was still
     * running). Claiming the number up front also covers the empty-query path,
     * which returns early and used to leave any pending search able to resolve. */
    const seq = (searchSeq.current += 1);
    const fresh = () => seq === searchSeq.current;
    const q = query.trim();
    setResults([]);
    setHighlight(0);
    setSearchError(null);
    resultScope.current = null;
    if (!open || !activeCompanyId || !q) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const hits = await window.api.search.global(q, 30, activeCompanyId);
        if (fresh()) {
          resultScope.current = currentScope;
          setResults((Array.isArray(hits) ? hits : []).filter((r) =>
            (!['supplier', 'po'].includes(r.kind) || canSeeCosting) &&
            (!['catalogProject', 'catalogTemplate'].includes(r.kind) || canSeeCatalog)));
          setSearchError(null);
          setHighlight(0);
        }
      } catch (err) {
        if (fresh()) {
          setResults([]);
          setSearchError(err?.message || String(err));
          setEnterQueued(false);
        }
      } finally {
        if (fresh()) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      searchSeq.current += 1;
    };
  }, [query, open, activeCompanyId, canSeeCosting, canSeeCatalog, currentScope]);

  async function openResult(r) {
    if (!r || resultScope.current !== currentScope || searching) return;
    const companyId = activeCompanyId;
    let opened;
    if (r.kind === 'product') {
      opened = await openLibraryProduct(r.productId, companyId);
    } else if (r.kind === 'catalogProject' && canSeeCatalog) {
      opened = await openCatalogProject(r.id, companyId);
    } else if (r.kind === 'catalogTemplate' && canSeeCatalog) {
      opened = await openCatalogTemplate(r.id, companyId);
    } else if (r.kind === 'supplier' && canSeeCosting) {
      opened = await openPurchaseOrdersForSupplier?.(r.id);
    } else if (r.kind === 'po' && canSeeCosting) {
      opened = await openPurchaseOrder?.(r.id);
    } else if (r.kind === 'brand' || r.kind === 'category') {
      opened = await setActiveModule('library');
      if (opened && useAppStore.getState().activeCompanyId === companyId) {
        resetFilters();
        if (r.kind === 'brand') {
          toggleBrandFilter?.(r.id);
        } else {
          setCategoryFilter?.(r.id);
        }
      } else opened = false;
    }
    if (opened) onClose?.();
  }

  useEffect(() => {
    if (!enterQueued || searching || resultScope.current !== currentScope) return;
    setEnterQueued(false);
    if (visibleResults[0]) openResult(visibleResults[0]);
    // openResult is recreated each render; the queue fires on the results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterQueued, searching, currentScope, results]);

  function onKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      onClose?.();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, Math.min(visibleResults.length - 1, h + 1)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (query.trim() && (searching || resultScope.current !== currentScope)) {
        setEnterQueued(true);
        return;
      }
      openResult(visibleResults[highlight]);
      return;
    }
  }

  if (!open) return null;
  const showResults = query.trim().length > 0;

  return (
    <div className="palette-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose?.();
    }}>
      <div className="palette" role="dialog" aria-label="Search palette">
        <div className="palette__input-wrap">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            placeholder={!activeCompanyId ? 'Pick a company first'
              : `Search products, brands, categories${canSeeCatalog ? ', catalogs, templates' : ''}${canSeeCosting ? ', suppliers, POs' : ''}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!activeCompanyId}
          />
          {searching ? <span className="palette__hint">searching…</span> : null}
        </div>

        {showResults ? (
          <div className="palette__results">
            {searchError && !searching ? (
              <div className="palette__empty palette__empty--error" role="alert">
                Search failed: {searchError}
              </div>
            ) : visibleResults.length === 0 && !searching ? (
              <div className="palette__empty">No matches for &ldquo;{query}&rdquo;.</div>
            ) : (
              <ul role="listbox">
                {visibleResults.map((r, i) => (
                  <li
                    key={`${r.kind}:${r.id}`}
                    role="option"
                    aria-selected={i === highlight}
                    className={`palette__row${i === highlight ? ' is-active' : ''}`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => openResult(r)}
                  >
                    <span className="palette__kind">{kindBadge(r.kind)}</span>
                    <span className="palette__label">{r.label}</span>
                    {r.sublabel ? <span className="palette__sub">{r.sublabel}</span> : null}
                    {r.extra ? <span className="palette__extra">{r.extra}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="palette__hint-row">
            Type to search · ↑↓ navigate · Enter to open · Esc to close
          </div>
        )}
      </div>
    </div>
  );
}
