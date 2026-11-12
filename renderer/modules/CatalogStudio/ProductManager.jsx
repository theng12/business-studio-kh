import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Field, Input, Modal, Pagination, Select, Textarea, paginate } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';
import { catalogIdLists, filterCatalogProducts, idsInSortOrder, matchCatalogSkus, mergeCatalogIds, moveCatalogBlock, moveToEdge, pruneCatalogSelection } from './catalogSelection.js';

function ProductThumb({ product }) {
  const src = product.mainImagePath ? appImageSrc(product.mainImagePath, product.contentHash || product.updatedAt, { w: 96 }) : null;
  return <div className="catalog-product-avatar">{src ? <img src={src} alt="" loading="lazy" decoding="async" /> : String(product.sku || 'P').slice(0, 2).toUpperCase()}</div>;
}

const SORT_NAMES = { sku: 'SKU', name: 'product name' };

/* SVG move arrows — the app draws its own icons (no Unicode glyphs as icons). */
function MoveIcon({ kind }) {
  const d = {
    top: 'M3 2h6M6 10V4.5M3.7 6.8 6 4.5l2.3 2.3',
    up: 'M6 10V3M3.7 5.3 6 3l2.3 2.3',
    down: 'M6 2v7M3.7 6.7 6 9l2.3-2.3',
    bottom: 'M3 10h6M6 2v5.5M3.7 5.2 6 7.5l2.3-2.3',
  }[kind];
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function ProductManager({ products, config, onChange, brands = [], categories = [] }) {
  const availablePanel = useRef(null); const includedPanel = useRef(null);
  const [query, setQuery] = useState(''); const [includedQuery, setIncludedQuery] = useState('');
  const [brandId, setBrandId] = useState(''); const [categoryId, setCategoryId] = useState('');
  const [availablePage, setAvailablePage] = useState(0); const [availableSize, setAvailableSize] = useState(50);
  const [includedPage, setIncludedPage] = useState(0); const [includedSize, setIncludedSize] = useState(50);
  const [selectedAvailable, setSelectedAvailable] = useState([]); const [selectedIncluded, setSelectedIncluded] = useState([]);
  const [movePosition, setMovePosition] = useState('1');
  const [pasteOpen, setPasteOpen] = useState(false); const [skuText, setSkuText] = useState('');
  const productList = useMemo(() => (Array.isArray(products) ? products : []), [products]);
  const allById = useMemo(() => new Map(productList.map((p) => [p.id, p])), [productList]);
  const { storedIds, includedIds, hiddenIds } = useMemo(() => catalogIdLists(config, productList), [config, productList]);
  const includedSet = useMemo(() => new Set(includedIds), [includedIds]);
  const includedIndex = useMemo(() => new Map(includedIds.map((id, index) => [id, index])), [includedIds]);
  const availableProducts = useMemo(() => productList.filter((p) => p.status !== 'inactive' && !includedSet.has(p.id)), [productList, includedSet]);
  const availableIds = useMemo(() => availableProducts.map((p) => p.id), [availableProducts]);
  const available = useMemo(() => filterCatalogProducts(availableProducts, { query, brandId, categoryId }), [availableProducts, query, brandId, categoryId]);
  const included = useMemo(() => includedIds.map((id) => allById.get(id)).filter(Boolean), [includedIds, allById]);
  const includedMatching = useMemo(() => filterCatalogProducts(included, { query: includedQuery }), [included, includedQuery]);
  const inactive = hiddenIds.map((id) => allById.get(id)).filter(Boolean);
  const missingCount = hiddenIds.length - inactive.length;
  // Filtering does not deselect: batch counts include every selected product.
  // Products removed, made inactive or moved between lists cannot stay selected.
  useEffect(() => { setSelectedAvailable((ids) => pruneCatalogSelection(ids, availableIds)); }, [availableIds]);
  useEffect(() => { setSelectedIncluded((ids) => pruneCatalogSelection(ids, includedIds)); }, [includedIds]);
  const availableSelection = pruneCatalogSelection(selectedAvailable, availableIds);
  const includedSelection = pruneCatalogSelection(selectedIncluded, includedIds);
  const availableSelectedSet = new Set(availableSelection); const includedSelectedSet = new Set(includedSelection);
  const availableInfo = paginate(available.length, availablePage, availableSize);
  const includedInfo = paginate(includedMatching.length, includedPage, includedSize);
  useEffect(() => { if (availablePage !== availableInfo.currentPage) setAvailablePage(availableInfo.currentPage); }, [availablePage, availableInfo.currentPage]);
  useEffect(() => { if (includedPage !== includedInfo.currentPage) setIncludedPage(includedInfo.currentPage); }, [includedPage, includedInfo.currentPage]);
  useEffect(() => { setAvailablePage(0); }, [query, brandId, categoryId, availableSize]);
  useEffect(() => { setIncludedPage(0); }, [includedQuery, includedSize]);
  const availableShown = available.slice(availableInfo.pageStart, availableInfo.pageEnd);
  const includedShown = includedMatching.slice(includedInfo.pageStart, includedInfo.pageEnd);
  const sortBy = config.sortBy || 'manual'; const sortName = SORT_NAMES[sortBy] || sortBy;
  const maxMovePosition = Math.max(1, includedIds.length - includedSelection.length + 1);
  const validMove = Number.isInteger(Number(movePosition)) && Number(movePosition) >= 1 && Number(movePosition) <= maxMovePosition;
  const skuResult = useMemo(() => matchCatalogSkus(skuText, productList, [...includedIds, ...hiddenIds]), [skuText, productList, includedIds, hiddenIds]);

  function commit(visibleIds, { manual = false, dropHidden = false, keepHiddenIds = hiddenIds } = {}) {
    const productIds = dropHidden ? [...visibleIds] : mergeCatalogIds(storedIds, visibleIds, keepHiddenIds);
    onChange({ productIds, selectionMode: 'explicit', brandIds: [], categoryIds: [], ...(manual ? { sortBy: 'manual' } : {}) });
  }
  function focusSearch(panel, event) {
    if (event?.currentTarget?.contains?.(globalThis.document?.activeElement)) panel.current?.querySelector('input')?.focus();
  }
  function add(ids, event) { focusSearch(availablePanel, event); commit([...includedIds, ...ids]); }
  function toggle(setSelection, id) { setSelection((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]); }
  function selectRows(setSelection, rows) { setSelection((ids) => [...new Set([...ids, ...rows.map((p) => p.id)])]); }
  function move(id, direction) {
    const index = includedIndex.get(id); const target = index + direction;
    if (index == null || target < 0 || target >= includedIds.length) return;
    const next = [...includedIds]; [next[index], next[target]] = [next[target], next[index]];
    commit(next, { manual: true });
  }
  async function removeAll() {
    const count = includedIds.length + hiddenIds.length;
    if (!count) return;
    if (await confirm({
      title: `Remove all ${count} product${count === 1 ? '' : 's'} from this catalog?`,
      message: `${includedIds.length} active${hiddenIds.length ? ` and ${hiddenIds.length} inactive or missing` : ''} products will be removed from the catalog. You can undo this edit while this project stays open. Products in the library are not affected.`,
      confirmLabel: 'Remove all', danger: true,
    })) commit([], { dropHidden: true });
  }
  function pager(total, info, size, setPage, setSize) {
    return <Pagination total={total} pageStart={info.pageStart} pageEnd={info.pageEnd} currentPage={info.currentPage} maxPage={info.maxPage} pageSize={size} onPageChange={setPage} onPageSizeChange={setSize} />;
  }
  function selectionControls(rows, matching, selection, setSelection, panel) {
    return <div className="catalog-product-selection">
      <span>{selection.length} selected</span>
      <Button size="sm" disabled={!rows.length} onClick={() => selectRows(setSelection, rows)}>Select this page ({rows.length})</Button>
      <Button size="sm" disabled={!matching.length} onClick={() => selectRows(setSelection, matching)}>Select all matching ({matching.length})</Button>
      <Button size="sm" variant="ghost" disabled={!selection.length} onClick={(e) => { focusSearch(panel, e); setSelection([]); }}>Clear selection</Button>
    </div>;
  }
  return <section className="catalog-product-manager">
    <div className="section-head">
      <h2 className="section-title">{included.length} product{included.length === 1 ? '' : 's'} included</h2>
      <p className="section-hint">Pick products from the library, then arrange their order.</p>
      <div className="section-head__actions">
        {sortBy !== 'manual' && included.length > 1 ? <Button size="sm" onClick={() => commit(idsInSortOrder(includedIds, allById, sortBy), { manual: true })} title={`Save the ${sortName} order as this catalog's own order, then switch Sort by to Catalog order`}>Use {sortName} order</Button> : null}
        <Button size="sm" onClick={() => { setSkuText(''); setPasteOpen(true); }}>Paste SKUs…</Button>
        <Button variant="danger" size="sm" disabled={!includedIds.length && !hiddenIds.length} onClick={removeAll}>Remove all</Button>
      </div>
    </div>
    <div className="catalog-product-columns">
      <section className="catalog-product-panel" ref={availablePanel}>
        <header><div><strong>Product Library</strong><span>{available.length} matching · {availableProducts.length} available</span></div></header>
        <div className="catalog-product-filters">
          <Field label="Search the library">{({ id }) => <Input id={id} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SKU, name or barcode" aria-label="Search the product library" />}</Field>
          <Field label="Brand">{({ id }) => <Select id={id} value={brandId} onChange={(e) => setBrandId(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>
          <Field label="Category">{({ id }) => <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        </div>
        {selectionControls(availableShown, available, availableSelection, setSelectedAvailable, availablePanel)}
        <div className="catalog-product-batch">
          {availableSelection.length ? <Button variant="primary" size="sm" onClick={(e) => add(availableSelection, e)}>Add selected ({availableSelection.length})</Button> : null}
          <details className="catalog-product-add">
            <summary>Add products</summary>
            <div className="catalog-product-add__actions">
              <Button size="sm" disabled={!availableShown.length} onClick={(e) => add(availableShown.map((p) => p.id), e)}>Add this page ({availableShown.length})</Button>
              <Button size="sm" disabled={!available.length} onClick={(e) => add(available.map((p) => p.id), e)}>Add all matching ({available.length})</Button>
            </div>
          </details>
        </div>
        <div className="catalog-product-list">
          {availableShown.length ? availableShown.map((p) => <article key={p.id} className={`catalog-product-row${availableSelectedSet.has(p.id) ? ' is-selected' : ''}`}>
            <input type="checkbox" checked={availableSelectedSet.has(p.id)} onChange={() => toggle(setSelectedAvailable, p.id)} aria-label={`Select ${p.sku} from the product library`} />
            <ProductThumb product={p} />
            <div className="catalog-product-name"><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'}</span></div>
            <Button size="sm" onClick={(e) => add([p.id], e)} aria-label={`Add ${p.sku} to the catalog`}>Add</Button>
          </article>) : <div className="catalog-product-empty">{query.trim() || brandId || categoryId ? 'No matching products outside this catalog. Change the search or filters.' : 'Every active product is already included.'}</div>}
        </div>
        {pager(available.length, availableInfo, availableSize, setAvailablePage, setAvailableSize)}
      </section>
      <section className="catalog-product-panel catalog-product-panel--included" ref={includedPanel}>
        <header><div><strong>Included in catalog</strong><span>{sortBy === 'manual' ? 'Shown in catalog order' : `Printed sorted by ${sortName}; this order applies with Catalog order`}</span></div></header>
        <div className="catalog-product-search"><Field label="Search included products">{({ id }) => <Input id={id} value={includedQuery} onChange={(e) => setIncludedQuery(e.target.value)} placeholder="SKU, name or barcode" aria-label="Search included products" />}</Field></div>
        {selectionControls(includedShown, includedMatching, includedSelection, setSelectedIncluded, includedPanel)}
        {includedSelection.length ? <div className="catalog-product-batch">
          <Field label="Move selected to position" hint={`First selected product: 1–${maxMovePosition}.`}>{({ id }) => <Input id={id} type="number" min="1" max={maxMovePosition} step="1" value={movePosition} onChange={(e) => setMovePosition(e.target.value)} />}</Field>
          <Button size="sm" disabled={!validMove} onClick={() => commit(moveCatalogBlock(includedIds, includedSelection, movePosition), { manual: true })}>Move selected ({includedSelection.length})</Button>
          <Button variant="danger" size="sm" onClick={(e) => { focusSearch(includedPanel, e); commit(includedIds.filter((id) => !includedSelectedSet.has(id))); }}>Remove selected ({includedSelection.length})</Button>
        </div> : null}
        <div className="catalog-product-list">
          {includedShown.length ? includedShown.map((p) => {
            const index = includedIndex.get(p.id);
            return <article key={p.id} className={`catalog-product-row${includedSelectedSet.has(p.id) ? ' is-selected' : ''}`}>
              <input type="checkbox" checked={includedSelectedSet.has(p.id)} onChange={() => toggle(setSelectedIncluded, p.id)} aria-label={`Select ${p.sku} in the catalog`} />
              <span className="catalog-order-number">{index + 1}</span>
              <div className="catalog-product-name"><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'}</span></div>
              <div className="catalog-product-row-actions">
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} to the top`} title="Move to top" disabled={index === 0} onClick={() => commit(moveToEdge(includedIds, p.id, 'top'), { manual: true })}><MoveIcon kind="top" /></button>
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} up`} title="Move up" disabled={index === 0} onClick={() => move(p.id, -1)}><MoveIcon kind="up" /></button>
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} down`} title="Move down" disabled={index === included.length - 1} onClick={() => move(p.id, 1)}><MoveIcon kind="down" /></button>
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} to the bottom`} title="Move to bottom" disabled={index === included.length - 1} onClick={() => commit(moveToEdge(includedIds, p.id, 'bottom'), { manual: true })}><MoveIcon kind="bottom" /></button>
                <Button variant="danger" size="sm" aria-label={`Remove ${p.sku} from the catalog`} onClick={(e) => { focusSearch(includedPanel, e); commit(includedIds.filter((id) => id !== p.id)); }}>Remove</Button>
              </div>
            </article>;
          }) : <div className="catalog-product-empty"><strong>{includedQuery.trim() ? 'No matching included products' : 'No products added yet'}</strong><span>{includedQuery.trim() ? 'Change the search to see more products.' : 'Add products from the library to build this catalog.'}</span></div>}
          {inactive.length ? <div className="catalog-product-hidden">
            <p>{inactive.length} inactive — hidden from the catalog. They keep their place and print again if reactivated.</p>
            {inactive.map((p) => <article key={p.id} className="is-inactive">
              <ProductThumb product={p} /><div className="catalog-product-name"><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'} · inactive — hidden from the catalog</span></div>
              <div className="catalog-product-row-actions"><Button variant="danger" size="sm" aria-label={`Remove ${p.sku} from the catalog`} onClick={(e) => { focusSearch(includedPanel, e); commit(includedIds, { keepHiddenIds: hiddenIds.filter((id) => id !== p.id) }); }}>Remove</Button></div>
            </article>)}
          </div> : null}
          {missingCount ? <p className="catalog-product-hidden">{missingCount} missing product{missingCount === 1 ? '' : 's'} kept in the saved order.</p> : null}
        </div>
        {pager(includedMatching.length, includedInfo, includedSize, setIncludedPage, setIncludedSize)}
      </section>
    </div>
    <Modal open={pasteOpen} onClose={() => setPasteOpen(false)} title="Add products by SKU" footer={<><Button onClick={() => setPasteOpen(false)}>Cancel</Button><Button variant="primary" disabled={!skuResult.addIds.length} onClick={() => { add(skuResult.addIds); setPasteOpen(false); }}>Add matched ({skuResult.addIds.length})</Button></>}>
      <Field label="SKUs" hint="Separate SKUs with new lines, commas or tabs.">{({ id }) => <Textarea id={id} autoFocus rows={8} value={skuText} onChange={(e) => setSkuText(e.target.value)} />}</Field>
      <div className="catalog-sku-result" aria-live="polite">
        <p>{skuResult.addIds.length} ready to add · {skuResult.includedSkus.length} already included · {skuResult.duplicateCount} repeated entries skipped</p>
        {skuResult.unmatchedSkus.length ? <p><strong>Not found ({skuResult.unmatchedSkus.length}):</strong> {skuResult.unmatchedSkus.join(', ')}</p> : null}
        {skuResult.ambiguousSkus.length ? <p><strong>Ambiguous ({skuResult.ambiguousSkus.length}):</strong> {skuResult.ambiguousSkus.join(', ')}. These SKUs match multiple products; add the correct product from the library.</p> : null}
        {skuResult.inactiveSkus.length ? <p><strong>Inactive ({skuResult.inactiveSkus.length}):</strong> {skuResult.inactiveSkus.join(', ')}. Activate these products in the library before adding them.</p> : null}
      </div>
    </Modal>
  </section>;
}
