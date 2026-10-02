import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Field, Input, Modal, Pagination, paginate } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { GenerationExperience } from '../../components/GenerationExperience.jsx';
import { useAppStore } from '../../store/index.js';
import { createLatestSaveQueue } from '../../lib/latestSaveQueue.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { parseConflictError, resolveSaveConflict } from '../../components/ConflictModal.jsx';
import { DesignControls } from './DesignControls.jsx';
import { CatalogTemplateBuilder } from './TemplateBuilder.jsx';
import { catalogIdLists, idsInSortOrder, mergeCatalogIds, moveToEdge } from './catalogSelection.js';
import { keepTypedName } from '../LabelStudio/editorRules.js';
import { appImageSrc } from '../../lib/imageUrl.js';
import { timeAgo } from '../../lib/format.js';

/* v0.1.63: the design controls, the theme list and the card-field defaults all
 * moved out of this file so the template builder can share them. The five
 * BUILT-IN layouts below stay here: they are the "proven layouts" the Templates
 * page offers as starting points, and they are copied into the builder rather
 * than stored, so a new install has something to click without any seeding. */
const DEFAULT_FIELDS = [
  { key: 'sku', label: 'SKU', visible: true },
  { key: 'name', label: 'Name', visible: true, bold: true },
  { key: 'colorFinish', label: 'Color / Finish', visible: true },
  { key: 'price', label: 'Price', visible: true, bold: true },
];

const CATALOG_TEMPLATES = [
  {
    id: 'modern',
    name: 'Modern product grid',
    eyebrow: 'Everyday catalog',
    description: 'A balanced three-column catalog for mixed product collections.',
    bestFor: 'Retail collections, seasonal ranges, general sharing',
    config: { theme: 'modern', columns: 3, primaryColor: '#111827', accentColor: '#6366f1', fields: DEFAULT_FIELDS },
  },
  {
    id: 'wholesale',
    name: 'Wholesale price catalog',
    eyebrow: 'Price focused',
    description: 'A denser four-column layout that keeps SKU, unit and wholesale price easy to scan.',
    bestFor: 'Dealers, distributors, sales teams',
    config: { theme: 'retail', columns: 4, primaryColor: '#0f766e', accentColor: '#14b8a6', groupBy: 'category', fields: [
      { key: 'sku', label: 'SKU', visible: true, bold: true }, { key: 'name', label: 'Product', visible: true },
      { key: 'unit', label: 'Unit', visible: true }, { key: 'price', label: 'Wholesale', visible: true, bold: true },
    ] },
  },
  {
    id: 'lookbook',
    name: 'Minimal lookbook',
    eyebrow: 'Image focused',
    description: 'A spacious two-column presentation that lets product photography lead.',
    bestFor: 'Premium ranges, furniture, design collections',
    config: { theme: 'minimal', columns: 2, primaryColor: '#18181b', accentColor: '#a16207', fields: [
      { key: 'name', label: 'Name', visible: true, bold: true, showLabel: false },
      { key: 'colorFinish', label: 'Finish', visible: true, showLabel: false }, { key: 'sku', label: 'SKU', visible: true },
    ] },
  },
  {
    id: 'promotion',
    name: 'Retail promotion',
    eyebrow: 'Offer focused',
    description: 'Bold color, large pricing and compact cards for promotional product sheets.',
    bestFor: 'Campaigns, monthly offers, in-store handouts',
    config: { theme: 'retail', columns: 3, primaryColor: '#7c2d12', accentColor: '#f97316', fields: [
      { key: 'name', label: 'Product', visible: true, bold: true }, { key: 'price', label: 'Price', visible: true, bold: true },
      { key: 'sku', label: 'SKU', visible: true }, { key: 'description', label: 'Details', visible: true },
    ] },
  },
  {
    id: 'specification',
    name: 'Specification sheet',
    eyebrow: 'Detail focused',
    description: 'A clean technical layout with more room for product identifiers and attributes.',
    bestFor: 'Trade buyers, specifications, internal range books',
    config: { theme: 'minimal', columns: 2, primaryColor: '#1e3a5f', accentColor: '#3b82f6', fields: [
      { key: 'sku', label: 'SKU', visible: true, bold: true }, { key: 'name', label: 'Product', visible: true, bold: true },
      { key: 'description', label: 'Description', visible: true }, { key: 'unit', label: 'Unit', visible: true },
      { key: 'countryOfOrigin', label: 'Origin', visible: true },
    ] },
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function editableProject(project, expectedUpdatedAt) {
  return {
    name: project.name,
    description: project.description,
    config: project.config,
    ...(expectedUpdatedAt == null ? {} : { expectedUpdatedAt }),
  };
}

function projectConfig(template, title) {
  return {
    pageSize: 'A4', orientation: 'portrait', gapMm: 5, marginMm: 10,
    groupBy: template.config.groupBy || 'none', sortBy: 'manual', selectionMode: 'explicit',
    productIds: [], brandIds: [], categoryIds: [], templateId: template.id,
    cover: { enabled: true, title, subtitle: '' },
    ...clone(template.config),
  };
}

/* A miniature of the template: the cover in its colours, then one page of
 * product tiles. Two rows of tiles share the page's fixed height (the CSS
 * bounds the rows and clips), so a 2-column layout can no longer grow past the
 * preview box and draw over the card's own text. */
function TemplateVisual({ template, large = false }) {
  const columns = Math.min(4, template.config.columns || 3);
  return <div className={`catalog-template-visual catalog-template-visual--${template.id}${large ? ' is-large' : ''}`} style={{ '--catalog-primary': template.config.primaryColor, '--catalog-accent': template.config.accentColor }} aria-hidden="true">
    <div className="catalog-template-visual__cover"><strong>{template.name}</strong></div>
    <div className="catalog-template-visual__page" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {Array.from({ length: columns * 2 }, (_, i) => <span key={i}><i /><b /><em /></span>)}
    </div>
  </div>;
}

/* House card (docs/UI_GUIDE.md): cover miniature, then name + facts, then one
 * row of actions — primary Open first, Duplicate, and Delete (danger) last. The
 * cover keeps the catalog's OWN colours: they are the user's print design, not
 * app chrome. */
function ProjectCard({ project, onOpen, onDuplicate, onDelete }) {
  const c = project.config || {};
  const count = (c.productIds || []).length;
  const productLabel = c.selectionMode === 'explicit' ? `${count} product${count === 1 ? '' : 's'}` : 'All active products';
  return <article className="card catalog-card">
    <div className="card__media">
      <button type="button" className="catalog-cover-mini" style={{ background: `linear-gradient(145deg, ${c.primaryColor || '#111827'}, ${c.accentColor || '#6366f1'})` }} onClick={onOpen} aria-label={`Open ${project.name}`}>
        <strong>{c.cover?.title || project.name}</strong>
      </button>
    </div>
    <div className="card__body">
      <span className="card__eyebrow">{c.columns || 3} columns · {c.pageSize || 'A4'}</span>
      <h3 className="card__title">{project.name}</h3>
      <p className="card__meta">{productLabel} · {project.lastExportedAt ? `Exported ${timeAgo(project.lastExportedAt)}` : 'Not exported yet'}</p>
    </div>
    <div className="card__actions">
      <Button variant="primary" size="sm" onClick={onOpen}>Open</Button>
      <Button size="sm" onClick={onDuplicate}>Duplicate</Button>
      <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
    </div>
  </article>;
}

function ProductThumb({ product }) {
  const src = product.mainImagePath ? appImageSrc(product.mainImagePath, product.contentHash || product.updatedAt, { w: 96 }) : null;
  return <div className="catalog-product-avatar">{src ? <img src={src} alt="" loading="lazy" decoding="async" /> : String(product.sku || 'P').slice(0, 2).toUpperCase()}</div>;
}

const SORT_NAMES = { sku: 'SKU', name: 'product name' };

function ProductManager({ products, config, onChange }) {
  const [query, setQuery] = useState('');
  const [availablePage, setAvailablePage] = useState(0); const [availableSize, setAvailableSize] = useState(50);
  const [includedPage, setIncludedPage] = useState(0); const [includedSize, setIncludedSize] = useState(50);
  const productList = useMemo(() => (Array.isArray(products) ? products : []), [products]);
  const allById = useMemo(() => new Map(productList.map((p) => [p.id, p])), [productList]);
  const activeProducts = useMemo(() => productList.filter((p) => p.status !== 'inactive'), [productList]);
  // includedIds: what prints. hiddenIds: saved ids that are inactive (or gone)
  // — kept in place on every edit, see catalogSelection.js.
  const { storedIds, includedIds, hiddenIds } = useMemo(() => catalogIdLists(config, productList), [config, productList]);
  const includedSet = useMemo(() => new Set(includedIds), [includedIds]);
  const normalized = query.trim().toLowerCase();
  const available = useMemo(() => activeProducts.filter((p) => !includedSet.has(p.id) && (!normalized || `${p.sku} ${p.name || ''} ${p.barcode || ''}`.toLowerCase().includes(normalized))), [activeProducts, includedSet, normalized]);
  const included = includedIds.map((id) => allById.get(id)).filter(Boolean);
  const inactive = hiddenIds.map((id) => allById.get(id)).filter(Boolean);
  // §10 pagination, one pager per list.
  const availableInfo = paginate(available.length, availablePage, availableSize);
  const includedInfo = paginate(included.length, includedPage, includedSize);
  useEffect(() => { if (availablePage !== availableInfo.currentPage) setAvailablePage(availableInfo.currentPage); }, [availablePage, availableInfo.currentPage]);
  useEffect(() => { if (includedPage !== includedInfo.currentPage) setIncludedPage(includedInfo.currentPage); }, [includedPage, includedInfo.currentPage]);
  useEffect(() => { setAvailablePage(0); }, [normalized, availableSize]);
  useEffect(() => { setIncludedPage(0); }, [includedSize]);
  const availableShown = available.slice(availableInfo.pageStart, availableInfo.pageEnd);
  const includedShown = included.slice(includedInfo.pageStart, includedInfo.pageEnd);
  const sortBy = config.sortBy || 'manual';

  function commit(visibleIds, { manual = false, dropHidden = false, keepHiddenIds = hiddenIds } = {}) {
    const productIds = dropHidden ? [...visibleIds] : mergeCatalogIds(storedIds, visibleIds, keepHiddenIds);
    onChange({ productIds, selectionMode: 'explicit', brandIds: [], categoryIds: [], ...(manual ? { sortBy: 'manual' } : {}) });
  }
  function move(id, direction) {
    const index = includedIds.indexOf(id); const target = index + direction;
    if (index < 0 || target < 0 || target >= includedIds.length) return;
    const next = [...includedIds]; [next[index], next[target]] = [next[target], next[index]]; commit(next, { manual: true });
  }
  async function removeAll() {
    const count = included.length + inactive.length;
    if (!count) return;
    const ok = await confirm({
      title: `Remove all ${count} product${count === 1 ? '' : 's'} from this catalog?`,
      message: inactive.length
        ? `That is ${included.length} shown and ${inactive.length} inactive. The catalog's order is lost, and there is no undo. Products in the library are not affected.`
        : "The catalog's order is lost, and there is no undo. Products in the library are not affected.",
      confirmLabel: 'Remove all',
      danger: true,
    });
    if (ok) commit([], { dropHidden: true });
  }
  function applySortAsOrder() {
    commit(idsInSortOrder(includedIds, allById, sortBy), { manual: true });
  }
  const sortName = SORT_NAMES[sortBy] || sortBy;
  return <section className="catalog-product-manager">
    <div className="section-head">
      <h2 className="section-title">{included.length} product{included.length === 1 ? '' : 's'} included</h2>
      <p className="section-hint">Pick products from the library, then arrange their order.</p>
      <div className="section-head__actions">
        {sortBy !== 'manual' && included.length > 1 ? <Button size="sm" onClick={applySortAsOrder} title={`Save the ${sortName} order as this catalog's own order, then switch Sort by to Catalog order`}>Use {sortName} order</Button> : null}
        <Button variant="danger" size="sm" disabled={!included.length && !inactive.length} onClick={removeAll}>Remove all</Button>
      </div>
    </div>
    <div className="catalog-product-columns">
      <section className="catalog-product-panel">
        <header>
          <div><strong>Product Library</strong><span>{available.length} available</span></div>
          <Button size="sm" disabled={!available.length} onClick={() => commit([...includedIds, ...available.map((p) => p.id)])}>Add all shown</Button>
        </header>
        <div className="catalog-product-search"><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU, name or barcode" aria-label="Search the product library" /></div>
        <div className="catalog-product-list">
          {availableShown.length ? availableShown.map((p) => (
            <article key={p.id}>
              <ProductThumb product={p} />
              <div><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'}</span></div>
              <Button size="sm" onClick={() => commit([...includedIds, p.id])} aria-label={`Add ${p.sku} to the catalog`}>Add</Button>
            </article>
          )) : <div className="catalog-product-empty">{normalized ? 'No matching products outside this catalog.' : 'Every active product is already included.'}</div>}
        </div>
        <Pagination total={available.length} pageStart={availableInfo.pageStart} pageEnd={availableInfo.pageEnd} currentPage={availableInfo.currentPage} maxPage={availableInfo.maxPage} pageSize={availableSize} onPageChange={setAvailablePage} onPageSizeChange={setAvailableSize} />
      </section>
      <section className="catalog-product-panel catalog-product-panel--included">
        <header>
          <div><strong>Included in catalog</strong><span>{sortBy === 'manual' ? 'Shown in this order' : `Printed sorted by ${sortName}; this order applies with Catalog order`}</span></div>
        </header>
        <div className="catalog-product-list">
          {includedShown.length ? includedShown.map((p, i) => {
            const index = includedInfo.pageStart + i;
            return <article key={p.id}>
              <span className="catalog-order-number">{index + 1}</span>
              <div><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'}</span></div>
              <div className="catalog-product-row-actions">
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} to the top`} title="Move to top" disabled={index === 0} onClick={() => commit(moveToEdge(includedIds, p.id, 'top'), { manual: true })}>⤒</button>
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} up`} title="Move up" disabled={index === 0} onClick={() => move(p.id, -1)}>↑</button>
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} down`} title="Move down" disabled={index === included.length - 1} onClick={() => move(p.id, 1)}>↓</button>
                <button type="button" className="catalog-icon-btn" aria-label={`Move ${p.sku} to the bottom`} title="Move to bottom" disabled={index === included.length - 1} onClick={() => commit(moveToEdge(includedIds, p.id, 'bottom'), { manual: true })}>⤓</button>
                <Button variant="danger" size="sm" aria-label={`Remove ${p.sku} from the catalog`} onClick={() => commit(includedIds.filter((id) => id !== p.id))}>Remove</Button>
              </div>
            </article>;
          }) : <div className="catalog-product-empty"><strong>No products added yet</strong><span>Add products from the library to build this catalog.</span></div>}
          {inactive.length ? <div className="catalog-product-hidden">
            <p>{inactive.length} inactive — hidden from the catalog. They keep their place and print again if reactivated.</p>
            {inactive.map((p) => (
              <article key={p.id} className="is-inactive">
                <ProductThumb product={p} />
                <div><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'} · inactive — hidden from the catalog</span></div>
                <div className="catalog-product-row-actions">
                  <Button variant="danger" size="sm" aria-label={`Remove ${p.sku} from the catalog`} onClick={() => commit(includedIds, { keepHiddenIds: hiddenIds.filter((id) => id !== p.id) })}>Remove</Button>
                </div>
              </article>
            ))}
          </div> : null}
        </div>
        <Pagination total={included.length} pageStart={includedInfo.pageStart} pageEnd={includedInfo.pageEnd} currentPage={includedInfo.currentPage} maxPage={includedInfo.maxPage} pageSize={includedSize} onPageChange={setIncludedPage} onPageSizeChange={setIncludedSize} />
      </section>
    </div>
  </section>;
}

function LivePreview({ preview, onRefresh }) {
  return <main className="catalog-preview">
    <div className="catalog-preview__head"><span>Live PDF preview</span><Button size="sm" onClick={onRefresh}>Refresh</Button></div>
    {preview ? <iframe title="Catalog preview" srcDoc={preview} /> : <div className="preview-placeholder">Building preview…</div>}
  </main>;
}

export function CatalogEditor({ projectId, onBack }) {
  const products = useAppStore((s) => s.products); const addToast = useAppStore((s) => s.addToast);
  const companySwitching = useAppStore((s) => s.companySwitching);
  // v0.1.55: this company's named price groups, so the catalog can print one.
  // `?? []` because the component tests stub the store with only the slices a
  // given case needs — a missing list must read as "no groups", not crash.
  const companies = useAppStore((s) => s.companies) ?? [];
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const catalogPriceGroups = (companies.find((c) => c.id === activeCompanyId)?.priceGroups) ?? [];
  const [project, setProject] = useState(null); const [preview, setPreview] = useState(''); const [saveState, setSaveState] = useState('saved'); const [savedAt, setSavedAt] = useState(null);
  const [working, setWorking] = useState(false); const [progress, setProgress] = useState(0); const [tab, setTab] = useState('products'); const timer = useRef(null);
  // The PDF this session exported last, for the "Open PDF" button.
  const [lastExport, setLastExport] = useState(null);
  const [printing, setPrinting] = useState(false);
  // v0.1.63: the template builder, opened from this project's design.
  const [templateDraft, setTemplateDraft] = useState(null);
  /* v0.1.27: the pending edit is FLUSHED on unmount, not thrown away. The
   * autosave waits 550 ms, so "tweak a setting, click ← Catalog projects"
   * discarded the change silently — the debounce timer was merely cleared. */
  const saveRef = useRef(null);
  const latest = useRef(null);
  const dirty = useRef(false);
  const saveQueue = useRef(null);
  const acknowledgedRevision = useRef(null);
  const editorGeneration = useRef(0);
  const remoteSeq = useRef(0);
  const ensureSaveQueue = useCallback(() => {
    if (!saveQueue.current) {
      const generation = editorGeneration.current;
      saveQueue.current = createLatestSaveQueue({
        initialRevision: acknowledgedRevision.current,
        persist: (next, expectedUpdatedAt) => window.api.catalogStudio.update(next.id, editableProject(next, expectedUpdatedAt)),
        onStart: () => { if (generation === editorGeneration.current) setSaveState('saving'); },
        onSuccess: (row, value) => {
          if (generation !== editorGeneration.current) return;
          acknowledgedRevision.current = row.updatedAt;
          if (latest.current !== value) return;
          // Keep a typed trailing space in the name box (see keepTypedName).
          const adopted = keepTypedName(value, row);
          setProject(adopted); latest.current = adopted; dirty.current = false; setSavedAt(Date.now()); setSaveState('saved');
        },
        onError: (e) => {
          if (generation !== editorGeneration.current) return;
          dirty.current = true; setSaveState('dirty');
          if (!parseConflictError(e)) addToast(e.message, 'error');
        },
      });
    }
    return saveQueue.current;
  }, [addToast]);
  const save = useCallback((value = latest.current) => {
    if (!value) return Promise.resolve();
    clearTimeout(timer.current);
    ensureSaveQueue().enqueue(value);
    return Promise.resolve();
  }, [ensureSaveQueue]);
  saveRef.current = save;
  const flushPending = useCallback(() => {
    if (!dirty.current || !latest.current) return Promise.resolve();
    clearTimeout(timer.current);
    return ensureSaveQueue().flush(() => dirty.current ? latest.current : null);
  }, [ensureSaveQueue]);
  const saveNow = useCallback(async () => {
    const generation = editorGeneration.current;
    try {
      await flushPending();
      return true;
    } catch (error) {
      let overwrittenDraft = null;
      try {
        const result = await resolveSaveConflict(error, {
          refresh: () => window.api.catalogStudio.get(projectId),
          overwrite: () => {
            if (generation !== editorGeneration.current || latest.current?.id !== projectId) return Promise.reject(new Error('Editor changed before conflict resolution'));
            overwrittenDraft = latest.current;
            return window.api.catalogStudio.update(overwrittenDraft.id, editableProject(overwrittenDraft));
          },
        });
        if (result.choice === 'cancel') return false;
        if (generation !== editorGeneration.current || latest.current?.id !== projectId) return false;
        const row = result.row;
        acknowledgedRevision.current = row.updatedAt;
        ensureSaveQueue().setRevision(row.updatedAt);
        if (result.choice === 'refresh' || latest.current === overwrittenDraft) {
          setProject(row); latest.current = row; dirty.current = false; setSavedAt(Date.now()); setSaveState('saved');
          return true;
        }
        await flushPending();
        return true;
      } catch (nextError) {
        dirty.current = true; setSaveState('dirty'); addToast(nextError.message, 'error');
        return false;
      }
    }
  }, [addToast, ensureSaveQueue, flushPending, projectId]);
  useEffect(() => registerCompanySwitchFlusher(flushPending), [flushPending]);
  useEffect(() => { let cancelled = false; const generation = ++editorGeneration.current; saveQueue.current = null; latest.current = null; dirty.current = false; window.api.catalogStudio.get(projectId).then((p) => { if (!cancelled && generation === editorGeneration.current) { setProject(p); latest.current = p; acknowledgedRevision.current = p.updatedAt; setSavedAt(p.updatedAt); } }).catch((e) => { if (!cancelled && generation === editorGeneration.current) addToast(e.message, 'error'); }); return () => { cancelled = true; clearTimeout(timer.current); if (dirty.current && latest.current) void saveRef.current?.(latest.current); editorGeneration.current += 1; }; }, [projectId, addToast]);
  useEffect(() => {
    const offs = [];
    const generation = editorGeneration.current;
    const refresh = (event) => {
      if (event?.kind !== 'catalogStudio' || event.id !== projectId || dirty.current) return;
      if (event.op === 'delete') { onBack(); return; }
      const seq = ++remoteSeq.current;
      window.api.catalogStudio.get(projectId).then((row) => {
        if (generation === editorGeneration.current && seq === remoteSeq.current && !dirty.current) { setProject(row); latest.current = row; acknowledgedRevision.current = row.updatedAt; saveQueue.current?.setRevision(row.updatedAt); setSavedAt(row.updatedAt); }
      }).catch((e) => { if (generation === editorGeneration.current && seq === remoteSeq.current) addToast(e.message, 'error'); });
    };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => refresh({ kind: 'catalogStudio', id: projectId, op: 'update' })));
    return () => offs.forEach((off) => off?.());
  }, [projectId, onBack, addToast]);
  const refreshPreview = useCallback(async () => { try { const r = await window.api.catalogStudio.preview(projectId); setPreview(r.html); } catch (e) { addToast(e.message, 'error'); } }, [projectId, addToast]);
  useEffect(() => { if (!project) return undefined; const id = setTimeout(refreshPreview, 260); return () => clearTimeout(id); }, [project, refreshPreview]);
  function change(patch) { if (companySwitching) return; remoteSeq.current += 1; const next = { ...project, ...patch }; setProject(next); latest.current = next; dirty.current = true; setSaveState('dirty'); clearTimeout(timer.current); timer.current = setTimeout(() => save(next), 550); }
  function updateConfig(patch) { change({ config: { ...project.config, ...patch } }); }
  async function leaveEditor() {
    try { await flushPending(); onBack(); }
    catch (error) { if (parseConflictError(error)) addToast('This catalog changed elsewhere. Use Save to review it before leaving.', 'error'); }
  }
  async function exportPdf() {
    // v0.1.27: inside a try — a failing dialog used to reject out of the
    // click handler with no toast, so the button looked dead.
    let folder;
    try { folder = await window.api.files.pickFolder(); } catch (e) { addToast(e.message, 'error'); return; }
    if (!folder) return;
    setWorking(true); setProgress(8); let pulse = null;
    try {
      pulse = setInterval(() => setProgress((x) => Math.min(88, x + 7)), 180);
      if (dirty.current) await flushPending();
      const generation = editorGeneration.current;
      const exportDraft = latest.current || project;
      const baselineRevision = acknowledgedRevision.current;
      const res = await window.api.catalogStudio.exportPdf(exportDraft.id, folder);
      setProgress(100);
      setLastExport(res.outputPath);
      addToast(`Catalog exported to ${res.outputPath}`, 'success');
      const row = await window.api.catalogStudio.get(exportDraft.id);
      const ownsBaseline = generation === editorGeneration.current
        && latest.current?.id === exportDraft.id
        && row.id === exportDraft.id
        && acknowledgedRevision.current === baselineRevision
        && Number(row.updatedAt) >= Number(baselineRevision);
      if (ownsBaseline && latest.current === exportDraft && !dirty.current) {
        acknowledgedRevision.current = row.updatedAt;
        saveQueue.current?.setRevision(row.updatedAt);
        setProject(row);
        latest.current = row;
        dirty.current = false;
      } else if (ownsBaseline && dirty.current
        && JSON.stringify(editableProject(row)) === JSON.stringify(editableProject(exportDraft))) {
        acknowledgedRevision.current = row.updatedAt;
        saveQueue.current?.setRevision(row.updatedAt);
      }
    }
    catch (e) { addToast(parseConflictError(e) ? 'This catalog changed elsewhere. Use Save to review it before exporting.' : e.message, 'error'); } finally { if (pulse) clearInterval(pulse); setWorking(false); }
  }
  async function openExport() {
    if (!lastExport) return;
    // The same open-a-file channel Label History uses; it runs on this Mac,
    // which is where the export was written.
    try { await window.api.labels.openOutput(lastExport); } catch (e) { addToast(e.message, 'error'); }
  }
  async function printCatalog() {
    setPrinting(true);
    try {
      if (dirty.current) await flushPending();
      const res = await window.api.catalogStudio.print((latest.current || project).id);
      if (res?.openedPdf) addToast('The catalog PDF is open in Preview — print it from there (⌘P).', 'info');
    } catch (e) {
      addToast(parseConflictError(e) ? 'This catalog changed elsewhere. Use Save to review it before printing.' : e.message, 'error');
    } finally { setPrinting(false); }
  }
  if (!project) return <div className="page-loading">Loading catalog…</div>;
  if (templateDraft) {
    return (
      <CatalogTemplateBuilder
        draft={templateDraft}
        // Opened from this catalog ("Save as template"), so Back returns here.
        backLabel={project.name || 'Catalog'}
        onClose={() => setTemplateDraft(null)}
        onSaved={() => setTemplateDraft(null)}
      />
    );
  }
  const c = project.config || {};
  return <section className="page catalog-editor-page">
    <PageHeader
      title={project.name}
      subtitle="Catalog project"
      backTo={{ label: 'Catalog projects', onClick: leaveEditor }}
      actions={<>
        <SaveStatus state={saveState} savedAt={savedAt} onSave={saveNow} />
        <Button
          onClick={() => setTemplateDraft({
            name: `${project.name} template`,
            description: `Layout from “${project.name}”.`,
            // The design only: the products belong to this catalog, and the cover
            // title is its name. Save as template is a starting point the user
            // reviews in the builder, not a silent copy.
            config: { ...project.config, selectionMode: 'explicit', productIds: [], brandIds: [], categoryIds: [] },
          })}
          title="Open this catalog's layout in the template builder — the products stay with the catalog."
        >
          Save as template
        </Button>
        <Button onClick={printCatalog} disabled={printing || working}>{printing ? 'Preparing…' : 'Print…'}</Button>
        {lastExport ? <Button onClick={openExport} title={lastExport}>Open PDF</Button> : null}
        <Button variant="primary" onClick={exportPdf}>Export PDF</Button>
      </>}
    />
    <div className="toolbar catalog-editor-toolbar">
      <div className="segments" role="tablist" aria-label="Catalog editor">
        <button type="button" role="tab" aria-selected={tab === 'products'} className={`segment${tab === 'products' ? ' is-active' : ''}`} onClick={() => setTab('products')} title="Choose and arrange catalog items">Products</button>
        <button type="button" role="tab" aria-selected={tab === 'design'} className={`segment${tab === 'design' ? ' is-active' : ''}`} onClick={() => setTab('design')} title="Style pages and product cards">Layout & design</button>
      </div>
    </div>
    {tab === 'products' ? <div className="catalog-product-workspace"><ProductManager products={products} config={c} onChange={updateConfig} /><LivePreview preview={preview} onRefresh={refreshPreview} /></div> :
      <div className="catalog-editor">
        <aside className="catalog-sidebar">
          <section className="catalog-sidebar__section">
            <h3 className="section-title">Project</h3>
            <Field label="Name">{({ id }) => <Input id={id} value={project.name} onChange={(e) => change({ name: e.target.value })} />}</Field>
            <Field label="Description">{({ id }) => <Input id={id} value={project.description || ''} onChange={(e) => change({ description: e.target.value })} />}</Field>
          </section>
          <DesignControls
            config={c}
            onChange={updateConfig}
            priceGroups={catalogPriceGroups}
            coverTitle={{ value: c.cover?.title || project.name, onChange: (title) => updateConfig({ cover: { ...c.cover, title } }) }}
            coverSubtitle={{ value: c.cover?.subtitle || '', onChange: (subtitle) => updateConfig({ cover: { ...c.cover, subtitle } }) }}
          />
        </aside>
        <LivePreview preview={preview} onRefresh={refreshPreview} />
      </div>}
    <GenerationExperience open={working} title="Building your catalog" progress={progress} phase={Math.min(3, Math.floor(progress / 28))} detail={project.name} />
  </section>;
}

export function CatalogTemplates() {
  const companyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const openCatalogProject = useAppStore((s) => s.openCatalogProject);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [createTemplate, setCreateTemplate] = useState(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  // v0.1.63: my templates + the builder.
  const [templates, setTemplates] = useState([]);
  const [builderDraft, setBuilderDraft] = useState(null);
  const requestSeq = useRef(0);

  const loadTemplates = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!companyId) { setTemplates([]); return; }
    try {
      const rows = await window.api.catalogStudio.listTemplates(companyId);
      if (seq === requestSeq.current) setTemplates(rows);
    } catch (e) { if (seq === requestSeq.current) addToast(e.message, 'error'); }
  }, [companyId, addToast]);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);
  useEffect(() => {
    const offs = [];
    const refresh = (event) => { if (!event || event.kind === 'catalogStudio') void loadTemplates(); };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => { void loadTemplates(); }));
    return () => offs.forEach((off) => off?.());
  }, [loadTemplates]);

  function begin(template) {
    setCreateTemplate(template);
    setName(template.name);
  }

  /** Create a project from a saved template, or from a proven layout. */
  async function create() {
    if (!createTemplate || !companyId) return;
    setCreating(true);
    try {
      const title = name.trim() || createTemplate.name;
      const builtIn = !!createTemplate.builtIn;
      const project = await window.api.catalogStudio.create({
        companyId,
        name: title,
        description: createTemplate.description,
        config: builtIn
          ? projectConfig(createTemplate, title)
          // A saved template already carries a complete design; only the cover
          // title is the project's own.
          : { ...createTemplate.config, cover: { ...(createTemplate.config.cover || {}), title } },
      });
      setCreateTemplate(null);
      setName('');
      openCatalogProject(project.id);
    } catch (e) {
      addToast(e.message, 'error');
    } finally {
      setCreating(false);
    }
  }

  if (builderDraft) {
    return (
      <CatalogTemplateBuilder
        draft={builderDraft}
        onClose={() => setBuilderDraft(null)}
        onSaved={() => { setBuilderDraft(null); void loadTemplates(); }}
      />
    );
  }

  async function duplicateTemplate(t) {
    try { await window.api.catalogStudio.duplicateTemplate(t.id); void loadTemplates(); } catch (e) { addToast(e.message, 'error'); }
  }
  async function deleteTemplate(t) {
    if (!(await confirm({ title: `Delete “${t.name}”?`, message: 'Catalogs already created from it are not affected.', confirmLabel: 'Delete template', danger: true }))) return;
    try { await window.api.catalogStudio.removeTemplate(t.id); void loadTemplates(); } catch (e) { addToast(e.message, 'error'); }
  }

  return <section className="page">
    <PageHeader
      title="Catalog Templates"
      subtitle="A template holds the page size, grid, style, cover and card fields — never the products."
      actions={(
        <>
          <Button onClick={() => setActiveModule('catalogprojects')}>View projects</Button>
          <Button variant="primary" onClick={() => setBuilderDraft({ name: '', description: '', config: {} })} disabled={!companyId}>
            + New template
          </Button>
        </>
      )}
    />

    {/* ── my templates ─────────────────────────────────────────────── */}
    <section className="catalog-section">
      <div className="section-head">
        <h2 className="section-title">My templates</h2>
        <p className="section-hint">Yours to edit, duplicate and reuse in any catalog.</p>
      </div>
      {templates.length ? (
        <div className="card-grid catalog-template-grid">
          {templates.map((t) => (
            <article className="card catalog-card" key={t.id}>
              <div className="card__media">
                <TemplateVisual template={{ id: t.config.theme || 'modern', name: t.name, config: t.config }} />
              </div>
              <div className="card__body">
                <span className="card__eyebrow">{(t.config.columns || 3)} columns · {t.config.pageSize || 'A4'} {t.config.orientation || 'portrait'}</span>
                <h3 className="card__title">{t.name}</h3>
                <p className="card__meta">{t.description || 'No description.'}</p>
                <p className="card__meta">
                  {(t.config.fields || []).filter((f) => f.visible !== false).length} card fields
                  {' · '}{(t.config.theme || 'modern')} style
                  {t.config.coverEnabled === false ? ' · no cover' : ' · cover page'}
                </p>
              </div>
              <div className="card__actions">
                <Button variant="primary" size="sm" onClick={() => begin({ ...t, builtIn: false })}>Use template</Button>
                <Button size="sm" onClick={() => setBuilderDraft({ id: t.id, name: t.name, description: t.description || '', config: { ...t.config } })}>Edit</Button>
                <Button size="sm" onClick={() => duplicateTemplate(t)}>Duplicate</Button>
                <Button variant="danger" size="sm" onClick={() => deleteTemplate(t)}>Delete</Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No templates of your own yet"
          body="Press + New template to build one, or open a proven layout below in the builder and save your version."
        />
      )}
    </section>

    {/* ── proven layouts ───────────────────────────────────────────── */}
    <section className="catalog-section">
      <div className="section-head">
        <h2 className="section-title">Proven layouts</h2>
        <p className="section-hint">Use one as it is, or open it in the builder and save your own version.</p>
      </div>
      <div className="card-grid catalog-template-grid">
        {CATALOG_TEMPLATES.map((template) => (
          <article className="card catalog-card" key={template.id}>
            <div className="card__media"><TemplateVisual template={template} /></div>
            <div className="card__body">
              <span className="card__eyebrow">{template.eyebrow}</span>
              <h3 className="card__title">{template.name}</h3>
              <p className="card__meta">{template.description}</p>
              <p className="card__meta">Best for: {template.bestFor}</p>
            </div>
            <div className="card__actions">
              <Button variant="primary" size="sm" onClick={() => begin(template)}>Use template</Button>
              <Button size="sm" onClick={() => setPreviewTemplate(template)}>Preview</Button>
              <Button size="sm" onClick={() => setBuilderDraft({ name: `${template.name} (mine)`, description: template.description, config: clone(template.config) })}>Open in builder</Button>
            </div>
          </article>
        ))}
      </div>
    </section>

    <Modal
      open={!!previewTemplate}
      onClose={() => setPreviewTemplate(null)}
      title={previewTemplate?.name || 'Catalog template'}
      footer={<><Button onClick={() => setPreviewTemplate(null)}>Close</Button><Button variant="primary" onClick={() => { const selected = previewTemplate; setPreviewTemplate(null); begin(selected); }}>Use this template</Button></>}
    >
      {previewTemplate ? <div className="catalog-template-detail">
        <TemplateVisual template={previewTemplate} large />
        <p>{previewTemplate.description}</p>
        <p><strong>Best for:</strong> {previewTemplate.bestFor}</p>
        <div className="catalog-template-facts"><span>{previewTemplate.config.columns} columns</span><span>{previewTemplate.config.theme} style</span><span>{previewTemplate.config.fields.length} product fields</span></div>
      </div> : null}
    </Modal>
    <Modal
      open={!!createTemplate}
      onClose={() => setCreateTemplate(null)}
      title="Create catalog project"
      footer={<><Button onClick={() => setCreateTemplate(null)}>Cancel</Button><Button variant="primary" disabled={creating} onClick={create}>{creating ? 'Creating…' : 'Create and add products'}</Button></>}
    >
      <Field label="Project name" hint={`Using ${createTemplate?.builtIn ? 'the' : 'your'} ${createTemplate?.name} template. You can change every layout setting later.`}>
        {({ id }) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2026 Wholesale Collection" />}
      </Field>
    </Modal>
  </section>;
}

export function CatalogProjects() {
  const companyId = useAppStore((s) => s.activeCompanyId); const addToast = useAppStore((s) => s.addToast); const setActiveModule = useAppStore((s) => s.setActiveModule);
  const pendingProjectId = useAppStore((s) => s.pendingCatalogProjectId); const clearPendingCatalogNav = useAppStore((s) => s.clearPendingCatalogNav);
  const [projects, setProjects] = useState([]); const [editing, setEditing] = useState(null); const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!companyId) { setProjects([]); setEditing(null); return; }
    try {
      const rows = await window.api.catalogStudio.list(companyId);
      if (seq === requestSeq.current) setProjects(rows);
    } catch (e) { if (seq === requestSeq.current) addToast(e.message, 'error'); }
  }, [companyId, addToast]);
  useEffect(() => { setEditing(null); void load(); }, [companyId, load]);
  useEffect(() => {
    const offs = [];
    const refresh = (event) => { if (!event || event.kind === 'catalogStudio') void load(); };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => { void load(); }));
    return () => offs.forEach((off) => off?.());
  }, [load]);
  useEffect(() => { if (pendingProjectId) { setEditing(pendingProjectId); clearPendingCatalogNav(); } }, [pendingProjectId, clearPendingCatalogNav]);
  if (editing) return <CatalogEditor key={editing} projectId={editing} onBack={() => { setEditing(null); void load(); }} />;
  async function duplicateProject(p) {
    try { await window.api.catalogStudio.duplicate(p.id); void load(); } catch (e) { addToast(e.message, 'error'); }
  }
  async function deleteProject(p) {
    if (!(await confirm({ title: `Delete “${p.name}”?`, message: 'The catalog project is removed. Products and images are not affected.', confirmLabel: 'Delete catalog', danger: true }))) return;
    try { await window.api.catalogStudio.remove(p.id); void load(); } catch (e) { addToast(e.message, 'error'); }
  }
  return <section className="page">
    <PageHeader
      title="Catalog Projects"
      subtitle="Open a catalog to manage its products, order, layout and PDF."
      actions={<Button variant="primary" onClick={() => setActiveModule('catalogtemplates')}>+ New from template</Button>}
    />
    {projects.length ? (
      <div className="card-grid card-grid--compact">
        {projects.map((p) => <ProjectCard key={p.id} project={p} onOpen={() => setEditing(p.id)} onDuplicate={() => duplicateProject(p)} onDelete={() => deleteProject(p)} />)}
      </div>
    ) : (
      <EmptyState
        title="No catalog projects yet"
        body="Choose a template, then add products from your library."
        action={<Button onClick={() => setActiveModule('catalogtemplates')}>Browse templates</Button>}
      />
    )}
  </section>;
}

export const CatalogStudio = CatalogProjects;
