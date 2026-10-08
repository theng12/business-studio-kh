import { memo, useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/ui.jsx';
import { CompactAttribution } from '../../components/Attribution.jsx';
import { ConnImg } from '../../components/ConnImg.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';
import { formatPriceEntry, priceEntry } from '../../lib/prices.js';
import { PROCESS_STATUS_OPTIONS, STATUS_OPTIONS, findOption } from './libraryConstants.js';

// v0.49.48: compact USD formatter for the Cost column.
function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A single-click on the thumbnail previews; a double-click opens the Workspace. */
const THUMB_DOUBLE_CLICK_MS = 240;

export function TableView({
  rows, brandsById, categoriesById, onOpen, onProcess, onPreview, onOpenWorkspace, sort, onSort,
  selectedProductId, selectedIds, onToggleSelected, onToggleAllVisible,
  // v0.22.7: which optional columns to render. Header + body both
  // consult this; SKU + thumb + select + actions are not in the set
  // (they're locked-on).
  visibleCols,
  // 0.1.94: the price-group columns this company has ([{ key, label }]).
  priceGroupCols = [],
  // v0.49.48: landed-cost map (productId → cost row) + click-through to
  // the source PO. Only consulted when the 'cost' column is visible.
  productCosts, onOpenCost,
}) {
  // v0.18.1: header checkbox state — checked when ALL visible rows
  // are in the selection set, indeterminate when some are.
  const visibleIds = rows.map((p) => p.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds?.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selectedIds?.has(id));
  const show = (key) => !visibleCols || visibleCols.has(key);

  /* 0.1.94: keyboard. The rows are a roving-tabindex group — one row is in
   * the tab order (the open product, else the last one moved to, else the
   * first); ↑ / ↓ move between rows, Enter opens the focused one (through the
   * Library's normal flush-then-switch path), Space ticks it. */
  const [focusId, setFocusId] = useState(null);
  const tbodyRef = useRef(null);
  const tabRowId = (focusId && visibleIds.includes(focusId)) ? focusId
    : (selectedProductId && visibleIds.includes(selectedProductId)) ? selectedProductId
      : visibleIds[0];
  function focusRow(id) {
    setFocusId(id);
    const el = Array.from(tbodyRef.current?.children ?? []).find((tr) => tr.dataset?.id === id);
    el?.focus();
  }
  function onRowsKeyDown(e) {
    if (e.target?.tagName !== 'TR') return; // keys inside a cell's control are the control's
    const at = visibleIds.indexOf(e.target.dataset.id);
    if (at < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(visibleIds[Math.max(0, Math.min(visibleIds.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusRow(visibleIds[e.key === 'Home' ? 0 : visibleIds.length - 1]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(rows[at]);
    } else if (e.key === ' ' && onToggleSelected) {
      e.preventDefault();
      onToggleSelected(rows[at].id, { shift: e.shiftKey });
    }
  }

  return (
    <div className="lib-table-wrap">
      <table className="lib-table">
        <thead>
          <tr>
            <th className="col-select">
              {selectedIds ? (
                <input
                  type="checkbox"
                  aria-label={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                  checked={allVisibleSelected}
                  ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                  onChange={() => onToggleAllVisible?.(!allVisibleSelected)}
                />
              ) : null}
            </th>
            <th className="col-thumb"></th>
            <SortHeader sortKey="sku"      label="SKU"            sort={sort} onSort={onSort} className="col-sku" />
            {show('brand')    ? <SortHeader sortKey="brand"    label="Brand"          sort={sort} onSort={onSort} className="col-brand" /> : null}
            {show('name')     ? <SortHeader sortKey="name"     label="Name"           sort={sort} onSort={onSort} className="col-name" /> : null}
            {show('category') ? <SortHeader sortKey="category" label="Category"       sort={sort} onSort={onSort} className="col-category" /> : null}
            {show('color')    ? <SortHeader sortKey="color"    label="Color / Finish" sort={sort} onSort={onSort} className="col-color" /> : null}
            {show('barcode')  ? <SortHeader sortKey="barcode"  label="Barcode"        sort={sort} onSort={onSort} className="col-barcode" /> : null}
            {show('retail')   ? <SortHeader sortKey="retail"   label="Retail"         sort={sort} onSort={onSort} numeric className="col-price" /> : null}
            {show('wholesale') ? <SortHeader sortKey="wholesale" label="Wholesale"    sort={sort} onSort={onSort} numeric className="col-price" /> : null}
            {priceGroupCols.filter((g) => show(`price:${g.key}`)).map((g) => (
              <SortHeader key={g.key} sortKey={`price:${g.key}`} label={g.label} sort={sort} onSort={onSort} numeric className="col-price" />
            ))}
            {show('stock')    ? <SortHeader sortKey="stock"    label="Stock"          sort={sort} onSort={onSort} numeric className="col-stock" /> : null}
            {show('images')   ? <SortHeader sortKey="images"   label="Images"         sort={sort} onSort={onSort} numeric className="col-images" /> : null}
            {show('cost')     ? <th className="col-num col-cost">Landed cost</th> : null}
            {show('process')  ? <th className="col-process">Process</th> : null}
            {show('status')   ? <th className="col-status">Status</th> : null}
            {/* v0.22.5: "Edited" column surfaces the per-row attribution
                (relative time + editor name) right in the list, so you
                don't have to open the side panel to see who last touched
                a row. v0.22.7 made this column user-toggleable. */}
            {show('edited')   ? <SortHeader sortKey="updated" label="Edited" sort={sort} onSort={onSort} className="col-edited" /> : null}
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody ref={tbodyRef} onKeyDown={onRowsKeyDown}>
          {rows.map((p) => (
            <TableRow
              key={p.id}
              product={p}
              brand={p.brandId ? brandsById.get(p.brandId) : null}
              category={p.categoryId ? categoriesById.get(p.categoryId) : null}
              onOpen={onOpen}
              onProcess={onProcess}
              onPreview={onPreview}
              onOpenWorkspace={onOpenWorkspace}
              selected={p.id === selectedProductId}
              checked={selectedIds?.has(p.id) ?? false}
              onToggleCheck={onToggleSelected}
              visibleCols={visibleCols}
              priceGroupCols={priceGroupCols}
              cost={productCosts?.get(p.id) || null}
              onOpenCost={onOpenCost}
              tabbable={p.id === tabRowId}
              onFocusRow={setFocusId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Sortable column header. Click toggles direction; clicking a different
 * column starts in 'asc' (text) or 'desc' (numeric) — that policy lives in
 * the store's setProductSort.
 *
 * 0.1.94: the click target is a real <button> (reachable by keyboard) and
 * the header carries `aria-sort`.
 */
function SortHeader({ sortKey, label, sort, onSort, numeric = false, className = '' }) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <th
      className={`lib-th-sort${active ? ' is-active' : ''}${numeric ? ' col-num' : ''}${className ? ` ${className}` : ''}`}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        className="lib-th-sort__btn"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
      >
        <span>{label}</span>
        <span className="lib-th-sort__arrow" aria-hidden>
          {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
        </span>
      </button>
    </th>
  );
}

/** A price read the one sanctioned way (priceEntry / formatPriceEntry). */
function PriceCell({ product, source }) {
  const text = formatPriceEntry(priceEntry(product, source));
  return <td className="col-num col-price">{text || <span className="muted">—</span>}</td>;
}

/**
 * Memoized table row. React.memo with the default shallow-prop compare is
 * enough here because:
 *   - `product`, `brand`, `category` are immutable per render of the parent;
 *   - `onOpen` / `onProcess` are stable via useCallback in the parent.
 * The result: filter typing and page-change re-renders the parent without
 * re-rendering every row.
 */
const TableRow = memo(function TableRow({
  product: p, brand, category, onOpen, onProcess, onPreview, onOpenWorkspace, selected,
  checked, onToggleCheck,
  // v0.22.7: respect the column picker. When undefined we fall back to
  // "show all" so TableRow stays usable for any caller that hasn't
  // adopted the picker yet (none today, but easy to keep symmetric).
  visibleCols, priceGroupCols,
  // v0.49.48: landed-cost row for this product (or null) + PO opener.
  cost, onOpenCost,
  tabbable, onFocusRow,
}) {
  const proc = findOption(PROCESS_STATUS_OPTIONS, p.processStatus);
  const stat = findOption(STATUS_OPTIONS, p.status);
  const hasImage = !!p.mainImagePath;
  const show = (key) => !visibleCols || visibleCols.has(key);
  const thumbTimer = useRef(null);
  useEffect(() => () => clearTimeout(thumbTimer.current), []);
  function onThumbClick(e) {
    e.stopPropagation();
    clearTimeout(thumbTimer.current);
    // Wait out a possible second click: a double-click goes to the Workspace.
    thumbTimer.current = setTimeout(() => onPreview(p), onOpenWorkspace ? THUMB_DOUBLE_CLICK_MS : 0);
  }
  function onThumbDoubleClick(e) {
    e.stopPropagation();
    clearTimeout(thumbTimer.current);
    onOpenWorkspace?.(p);
  }
  return (
    <tr
      className={`lib-row${selected ? ' is-selected' : ''}${checked ? ' is-checked' : ''}`}
      onClick={() => onOpen(p)}
      aria-selected={selected || undefined}
      tabIndex={tabbable ? 0 : -1}
      data-id={p.id}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocusRow?.(p.id); }}
    >
      <td className="col-select" onClick={(e) => e.stopPropagation()}>
        {onToggleCheck ? (
          <input
            type="checkbox"
            aria-label={`Select ${p.sku}`}
            checked={!!checked}
            // 0.1.94: Shift-click ticks (or clears) the whole range since the last tick.
            onChange={(e) => onToggleCheck(p.id, { shift: !!e.nativeEvent?.shiftKey })}
          />
        ) : null}
      </td>
      <td
        className={`col-thumb${hasImage ? ' col-thumb--clickable' : ''}`}
        onClick={hasImage ? onThumbClick : undefined}
        onDoubleClick={hasImage && onOpenWorkspace ? onThumbDoubleClick : undefined}
        title={hasImage ? (onOpenWorkspace ? 'Preview images · double-click to open in Image Workspace' : 'Preview images') : undefined}
      >
        {hasImage ? (
          // v0.22.8: ?v=<updatedAt> cache-busts after image deletes /
          // reorders / set-main. The path `<sku>-001.jpg` stays the
          // same but the bytes inside change when the user makes a
          // different image the main one; without the version stamp
          // the table thumb shows stale pixels.
          // w=96: the cell is 36 px, so a small cached WebP covers retina
          // without decoding the full-size original for every row.
          // 0.1.94: ConnImg — a thumbnail that failed while a client Mac
          // was offline loads again once the connection is back.
          <ConnImg src={appImageSrc(p.mainImagePath, p.updatedAt, { w: 96 })} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <div className="thumb-placeholder" aria-hidden>·</div>
        )}
      </td>
      {/* UI pass, 2026-10: SKU never breaks mid-string (ellipsis + full
          value in the tooltip); Name wraps to at most two lines; the
          short text columns stay on one line. With the detail panel
          open the table scrolls sideways instead of stacking one word
          per line. */}
      <td className="col-sku"><span className="lib-cell-ellipsis" title={p.sku}>{p.sku}</span></td>
      {show('brand')    ? <td className="col-brand">{brand?.name ?? <span className="muted">—</span>}</td> : null}
      {show('name')     ? <td className="col-name">{p.name ? <span className="lib-cell-clamp" title={p.name}>{p.name}</span> : <span className="muted">—</span>}</td> : null}
      {/* 0.1.94: Khmer category names ran ~270px; the cell ellipsizes at
          ~160px with the full name in the tooltip. */}
      {show('category') ? <td className="col-category">{category?.name ? <span className="lib-cell-ellipsis lib-cell-ellipsis--category" title={category.name}>{category.name}</span> : <span className="muted">—</span>}</td> : null}
      {show('color')    ? <td className="col-color">{p.colorFinish ?? <span className="muted">—</span>}</td> : null}
      {show('barcode')  ? <td className="col-barcode">{p.barcode ? <span className="lib-cell-ellipsis" title={p.barcode}>{p.barcode}</span> : <span className="muted">—</span>}</td> : null}
      {show('retail')   ? <PriceCell product={p} source="retail" /> : null}
      {show('wholesale') ? <PriceCell product={p} source="wholesale" /> : null}
      {(priceGroupCols || []).filter((g) => show(`price:${g.key}`)).map((g) => <PriceCell key={g.key} product={p} source={g.key} />)}
      {show('stock')    ? <td className="col-num col-stock">{p.stockQty == null ? <span className="muted">—</span> : Number(p.stockQty).toLocaleString()}</td> : null}
      {show('images')   ? <td className="col-num col-images">{p.imageCount}/50</td> : null}
      {show('cost') ? (
        <td className="col-num col-cost" onClick={(e) => e.stopPropagation()}>
          {cost && cost.latestLandedCostUsd != null ? (
            cost.latestPoId ? (
              <button
                type="button"
                className="lib-cost-link"
                title="Open the source purchase order"
                onClick={() => onOpenCost?.(cost.latestPoId)}
              >
                {fmtUsd(cost.latestLandedCostUsd)}
              </button>
            ) : (
              <span title="Latest landed cost">{fmtUsd(cost.latestLandedCostUsd)}</span>
            )
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      ) : null}
      {show('process')  ? <td className="col-process">{proc ? <Badge tone={proc.tone}>{proc.label}</Badge> : null}</td> : null}
      {show('status')   ? <td className="col-status">{stat ? <Badge tone={stat.tone}>{stat.label}</Badge> : null}</td> : null}
      {show('edited') ? (
        <td className="col-edited">
          <CompactAttribution updatedAt={p.updatedAt} updatedByUserId={p.updatedByUserId} />
        </td>
      ) : null}
      <td className="col-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="row-action"
          // 0.1.94: it opens a chooser, not the Workspace directly.
          title="Choose where to process: Image Workspace, AI Studio, Overlay or Social post"
          onClick={() => onProcess(p)}
        >Process →</button>
      </td>
    </tr>
  );
});
