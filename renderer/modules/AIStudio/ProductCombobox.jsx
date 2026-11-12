import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Searchable product picker for the AI Studio Source section. The native
 * <Select> doesn't filter, so once a company has more than a couple dozen
 * SKUs it becomes painful to find a specific product. This combobox:
 *
 *   - Shows the currently-selected product label when collapsed.
 *   - Opens on focus / click and reveals a typeahead input + filtered list.
 *   - Filters by SKU or Name (case-insensitive substring, order-independent
 *     for multi-word queries like "blue mace 6101").
 *   - Caps the rendered list to 100 entries to keep things snappy for
 *     companies with thousands of products — once the user types, the
 *     filter narrows it down anyway.
 *   - Keyboard: ↑/↓ to move, Enter to pick, Esc to close, Tab to commit
 *     focus elsewhere.
 *   - Closes on outside click via a global mousedown listener.
 *
 * Shared by Overlay Studio ("Preview against") and Label Studio ("Preview
 * with") too — a native <select> of ~2,500 products cannot be searched.
 * `placeholder` is the collapsed label with nothing picked; `clearLabel`
 * (or `allowClear={false}`) controls the "no product" row.
 */
export function ProductCombobox({ id, products, value, onChange, placeholder = '— Pick a product —', clearLabel = 'Clear selection', allowClear = true, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = useMemo(
    () => products.find((p) => p.id === value) ?? null,
    [products, value],
  );

  // Multi-word AND search across SKU + Name. "ag m81" matches "AV-M8111-AG".
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const base = !terms.length
      ? products
      : products.filter((p) => {
          const hay = `${p.sku ?? ''} ${p.name ?? ''} ${p.barcode ?? ''}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
    return base.slice(0, 100);
  }, [products, query]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // When the dropdown opens, focus the search input and reset the highlight
  // to the first row. Resetting the query on close would lose typing if the
  // user clicked outside accidentally — we keep it instead.
  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      // Focus on next tick — the input only mounts when `open` flips to true.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function pick(product) {
    onChange(product?.id ?? null);
    setOpen(false);
    setQuery('');
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIdx]) pick(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      // Close only the list — not the editor or dialog this picker sits in.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  // Keep the highlighted row scrolled into view when the user moves with the
  // arrow keys past the visible window of the dropdown list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const buttonLabel = selected
    ? (selected.name ? `${selected.sku} · ${selected.name}` : selected.sku)
    : placeholder;

  return (
    <div className="product-combobox" ref={wrapRef}>
      <button
        type="button"
        id={id}
        className={`product-combobox__trigger${selected ? '' : ' is-placeholder'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={selected ? buttonLabel : undefined}
      >
        <span className="product-combobox__label">{buttonLabel}</span>
        <span className="product-combobox__chev" aria-hidden><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      </button>

      {open ? (
        <div className="product-combobox__pop" role="listbox">
          <input
            ref={inputRef}
            type="text"
            className="product-combobox__search"
            placeholder={`Search ${products.length} product${products.length === 1 ? '' : 's'}…`}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
          />
          <ul ref={listRef} className="product-combobox__list">
            {selected && allowClear ? (
              <li
                key="__clear"
                className="product-combobox__row product-combobox__row--clear"
                onClick={() => pick(null)}
              >
                {clearLabel}
              </li>
            ) : null}
            {filtered.length === 0 ? (
              <li className="product-combobox__empty">No products match “{query}”</li>
            ) : (
              filtered.map((p, i) => (
                <li
                  key={p.id}
                  data-idx={i}
                  className={`product-combobox__row${i === activeIdx ? ' is-active' : ''}${p.id === value ? ' is-selected' : ''}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(p)}
                >
                  <span className="product-combobox__sku">{p.sku}</span>
                  {p.name ? <span className="product-combobox__name">{p.name}</span> : null}
                </li>
              ))
            )}
            {!query && products.length > filtered.length ? (
              <li className="product-combobox__hint">
                Showing first {filtered.length} of {products.length}. Type to search.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
