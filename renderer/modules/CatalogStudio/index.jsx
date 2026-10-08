import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Field, Input, Modal, Pagination, Select, paginate } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { shortcutBlocked } from '../../components/ShortcutsModal.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { GenerationExperience } from '../../components/GenerationExperience.jsx';
import { useAppStore } from '../../store/index.js';
import { createLatestSaveQueue } from '../../lib/latestSaveQueue.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { parseConflictError, resolveSaveConflict } from '../../components/ConflictModal.jsx';
import { DesignControls } from './DesignControls.jsx';
import { CatalogTemplateBuilder } from './TemplateBuilder.jsx';
import { ProductManager } from './ProductManager.jsx';
import { CatalogPreview } from './CatalogPreview.jsx';
import { previewFontsKey, rememberPreviewFonts } from './previewFonts.js';
import { keepTypedName } from '../LabelStudio/editorRules.js';
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
    config: { theme: 'retail', columns: 4, primaryColor: '#0f766e', accentColor: '#14b8a6', groupBy: 'category', priceGroup: 'wholesale', fields: [
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

export function CatalogEditor({ projectId, onBack }) {
  // Every product in the company. `products` is the Library's filtered view,
  // so after a Library search the catalog's own products showed as "missing"
  // and the picker offered only the search results. (`?? s.products` only
  // for component tests that stub the old field.)
  const products = useAppStore((s) => s.allProducts ?? s.products);
  const refreshAllProducts = useAppStore((s) => s.refreshAllProducts);
  const brands = useAppStore((s) => s.brands) ?? []; const categories = useAppStore((s) => s.categories) ?? []; const addToast = useAppStore((s) => s.addToast);
  const companySwitching = useAppStore((s) => s.companySwitching);
  // v0.1.55: this company's named price groups, so the catalog can print one.
  // `?? []` because the component tests stub the store with only the slices a
  // given case needs — a missing list must read as "no groups", not crash.
  const companies = useAppStore((s) => s.companies) ?? [];
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const catalogPriceGroups = (companies.find((c) => c.id === activeCompanyId)?.priceGroups) ?? [];
  useEffect(() => {
    if (activeCompanyId && !(Array.isArray(products) && products.length)) refreshAllProducts?.();
    // Once per company — an empty company must not refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompanyId]);
  const [project, setProject] = useState(null); const [preview, setPreview] = useState(''); const [saveState, setSaveState] = useState('saved'); const [savedAt, setSavedAt] = useState(null);
  const [working, setWorking] = useState(false); const [progress, setProgress] = useState(0); const [tab, setTab] = useState('products'); const timer = useRef(null);
  // The PDF this session exported last, for the "Open PDF" button.
  const [lastExport, setLastExport] = useState(null);
  const [printing, setPrinting] = useState(false);
  const [previewState, setPreviewState] = useState('refreshing'); const [previewError, setPreviewError] = useState('');
  // Which remembered font set the current preview HTML expects (previewFonts.js).
  const [previewFonts, setPreviewFonts] = useState('');
  const previewSeq = useRef(0);
  // ponytail: keep at most 20 local snapshots; durable history would require its own product direction.
  const history = useRef({ past: [], future: [] }); const [historyVersion, setHistoryVersion] = useState(0);
  const resetHistory = useCallback(() => { history.current = { past: [], future: [] }; setHistoryVersion((v) => v + 1); }, []);
  // v0.1.63: the template builder, opened from this project's design.
  const [templateDraft, setTemplateDraft] = useState(null);
  const [designOpenSections, setDesignOpenSections] = useState({ Layout: true });
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
          if (result.choice === 'refresh') { resetHistory(); previewSeq.current += 1; setPreviewState('refreshing'); setPreviewError(''); }
          return true;
        }
        await flushPending();
        return true;
      } catch (nextError) {
        dirty.current = true; setSaveState('dirty'); addToast(nextError.message, 'error');
        return false;
      }
    }
  }, [addToast, ensureSaveQueue, flushPending, projectId, resetHistory]);
  useEffect(() => registerCompanySwitchFlusher(flushPending), [flushPending]);
  useEffect(() => { let cancelled = false; const generation = ++editorGeneration.current; previewSeq.current += 1; setProject(null); setPreview(''); resetHistory(); setDesignOpenSections({ Layout: true }); saveQueue.current = null; latest.current = null; dirty.current = false; window.api.catalogStudio.get(projectId).then((p) => { if (!cancelled && generation === editorGeneration.current) { setProject(p); latest.current = p; acknowledgedRevision.current = p.updatedAt; setSavedAt(p.updatedAt); } }).catch((e) => { if (!cancelled && generation === editorGeneration.current) addToast(e.message, 'error'); }); return () => { cancelled = true; clearTimeout(timer.current); if (dirty.current && latest.current) void saveRef.current?.(latest.current); editorGeneration.current += 1; previewSeq.current += 1; }; }, [projectId, addToast, resetHistory]);
  useEffect(() => {
    const offs = [];
    const generation = editorGeneration.current;
    const refresh = (event) => {
      if (event?.kind !== 'catalogStudio' || event.id !== projectId || dirty.current) return;
      if (event.op === 'delete') { onBack(); return; }
      const seq = ++remoteSeq.current;
      window.api.catalogStudio.get(projectId).then((row) => {
        if (generation !== editorGeneration.current || seq !== remoteSeq.current || dirty.current) return;
        if (row.updatedAt === acknowledgedRevision.current) return;
        const changed = JSON.stringify(editableProject(row)) !== JSON.stringify(editableProject(latest.current));
        if (changed) { resetHistory(); previewSeq.current += 1; setPreviewState('refreshing'); setPreviewError(''); }
        setProject(row); latest.current = row; acknowledgedRevision.current = row.updatedAt;
        saveQueue.current?.setRevision(row.updatedAt); setSavedAt(row.updatedAt);
      }).catch((e) => { if (generation === editorGeneration.current && seq === remoteSeq.current) addToast(e.message, 'error'); });
    };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => refresh({ kind: 'catalogStudio', id: projectId, op: 'update' })));
    return () => offs.forEach((off) => off?.());
  }, [projectId, onBack, addToast, resetHistory]);
  const refreshPreview = useCallback(async () => {
    const seq = ++previewSeq.current; const generation = editorGeneration.current;
    setPreviewState('refreshing'); setPreviewError('');
    try {
      await flushPending();
      if (seq !== previewSeq.current || generation !== editorGeneration.current) return;
      const r = await window.api.catalogStudio.preview(projectId, previewFontsKey());
      if (seq !== previewSeq.current || generation !== editorGeneration.current) return;
      setPreviewFonts(rememberPreviewFonts(r)); setPreview(r.html); setPreviewState('idle');
    } catch (e) {
      if (seq !== previewSeq.current || generation !== editorGeneration.current) return;
      setPreviewState('error'); setPreviewError(parseConflictError(e) ? 'This catalog changed elsewhere. Use Save to review it, then refresh the preview.' : e.message);
    }
  }, [projectId, flushPending]);
  useEffect(() => { if (!project) return undefined; const id = setTimeout(refreshPreview, 600); return () => clearTimeout(id); }, [project, refreshPreview]);
  function applyChange(next) {
    remoteSeq.current += 1; previewSeq.current += 1; setPreviewState('refreshing'); setPreviewError('');
    setProject(next); latest.current = next; dirty.current = true; setSaveState('dirty');
    clearTimeout(timer.current); timer.current = setTimeout(() => save(next), 550);
  }
  function change(patch) {
    if (companySwitching) return;
    history.current.past.push({ name: latest.current.name, description: latest.current.description, config: structuredClone(latest.current.config) });
    if (history.current.past.length > 20) history.current.past.shift();
    history.current.future = []; setHistoryVersion((v) => v + 1);
    applyChange({ ...latest.current, ...patch });
  }
  function stepHistory(direction) {
    if (companySwitching) return;
    const from = direction === 'undo' ? history.current.past : history.current.future;
    const to = direction === 'undo' ? history.current.future : history.current.past;
    const snapshot = from.pop(); if (!snapshot) return;
    to.push({ name: latest.current.name, description: latest.current.description, config: structuredClone(latest.current.config) });
    setHistoryVersion((v) => v + 1); applyChange({ ...latest.current, ...snapshot });
  }
  function historyShortcut(e) {
    if (e.defaultPrevented || e.isComposing || e.nativeEvent?.isComposing || !(e.metaKey || e.ctrlKey) || e.altKey || e.key?.toLowerCase() !== 'z'
      || shortcutBlocked(e.target, globalThis.document) || ['INPUT', 'SELECT'].includes(e.target?.tagName?.toUpperCase()) || e.target?.closest?.('[role="dialog"]')) return;
    const direction = e.shiftKey ? 'redo' : 'undo';
    if (companySwitching || !(direction === 'undo' ? history.current.past : history.current.future).length) return;
    e.preventDefault(); stepHistory(direction);
  }
  function updateConfig(patch) { change({ config: { ...latest.current.config, ...patch } }); }
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
  return <section className="page catalog-editor-page" onKeyDown={historyShortcut}>
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
            config: { ...project.config, cover: { enabled: project.config.cover?.enabled !== false }, selectionMode: 'explicit', productIds: [], brandIds: [], categoryIds: [] },
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
    <div className="toolbar catalog-editor-toolbar" data-history-version={historyVersion}>
      <Button size="sm" disabled={!history.current.past.length || companySwitching} onClick={() => stepHistory('undo')} title="Undo catalog edit (⌘Z / Ctrl+Z)">Undo</Button>
      <Button size="sm" disabled={!history.current.future.length || companySwitching} onClick={() => stepHistory('redo')} title="Redo catalog edit (⌘⇧Z / Ctrl+Shift+Z)">Redo</Button>
      <div className="segments" role="tablist" aria-label="Catalog editor" onKeyDown={(e) => {
        const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')]; const at = tabs.indexOf(e.target);
        if (at < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus(); tabs[next].click();
      }}>
        <button type="button" role="tab" tabIndex={tab === 'products' ? 0 : -1} aria-selected={tab === 'products'} className={`segment${tab === 'products' ? ' is-active' : ''}`} onClick={() => setTab('products')} title="Choose and arrange catalog items">Products</button>
        <button type="button" role="tab" tabIndex={tab === 'design' ? 0 : -1} aria-selected={tab === 'design'} className={`segment${tab === 'design' ? ' is-active' : ''}`} onClick={() => setTab('design')} title="Style pages and product cards">Layout & design</button>
      </div>
    </div>
    {tab === 'products' ? <div className="catalog-product-workspace"><ProductManager products={products} brands={brands} categories={categories} config={c} onChange={updateConfig} /><CatalogPreview preview={preview} fontsKey={previewFonts} onRefresh={refreshPreview} config={c} state={previewState} error={previewError} /></div> :
      <div className="catalog-editor">
        <aside className="catalog-sidebar">
          <section className="catalog-sidebar__section">
            <h3 className="section-title">Project</h3>
            <Field label="Name">{({ id }) => <Input id={id} value={project.name} onChange={(e) => change({ name: e.target.value })} />}</Field>
            <Field label="Description">{({ id }) => <Input id={id} value={project.description || ''} onChange={(e) => change({ description: e.target.value })} />}</Field>
          </section>
          <DesignControls
            config={c}
            openSections={designOpenSections}
            onOpenSectionsChange={setDesignOpenSections}
            onChange={updateConfig}
            priceGroups={catalogPriceGroups}
            coverTitle={{ value: c.cover?.title || project.name, onChange: (title) => updateConfig({ cover: { ...c.cover, title } }) }}
            coverSubtitle={{ value: c.cover?.subtitle || '', onChange: (subtitle) => updateConfig({ cover: { ...c.cover, subtitle } }) }}
          />
        </aside>
        <CatalogPreview preview={preview} fontsKey={previewFonts} onRefresh={refreshPreview} config={c} state={previewState} error={previewError} />
      </div>}
    <GenerationExperience open={working} title="Building your catalog" progress={progress} phase={Math.min(3, Math.floor(progress / 28))} detail={project.name} />
  </section>;
}

function useCatalogCollection(rows) {
  const [query, setQuery] = useState(''); const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(0); const [size, setSize] = useState(50);
  const filtered = useMemo(() => rows.filter((r) => `${r.name} ${r.description || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : Number(b.updatedAt) - Number(a.updatedAt)), [rows, query, sort]);
  const info = paginate(filtered.length, page, size);
  useEffect(() => { setPage(0); }, [query, sort, size]);
  useEffect(() => { if (page !== info.currentPage) setPage(info.currentPage); }, [page, info.currentPage]);
  return { rows: filtered.slice(info.pageStart, info.pageEnd), controls: <div className="toolbar catalog-collection-tools">
    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or description" aria-label="Search saved catalogs" />
    <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort saved catalogs"><option value="recent">Recently updated</option><option value="name">Name</option></Select>
  </div>, pager: <Pagination total={filtered.length} pageStart={info.pageStart} pageEnd={info.pageEnd} currentPage={info.currentPage} maxPage={info.maxPage} pageSize={size} onPageChange={setPage} onPageSizeChange={setSize} /> };
}

export function CatalogTemplates() {
  const pendingTemplateId = useAppStore((s) => s.pendingCatalogTemplateId);
  const clearPendingTemplate = useAppStore((s) => s.clearPendingCatalogTemplateNav);
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
  const builderIntent = useRef(0);
  function cancelPendingTemplate() { builderIntent.current += 1; clearPendingTemplate?.(); }
  function openBuilder(draft) { cancelPendingTemplate(); setBuilderDraft(draft); }
  const requestSeq = useRef(0);
  const collection = useCatalogCollection(templates);

  const loadTemplates = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!companyId) { setTemplates([]); return; }
    try {
      const rows = await window.api.catalogStudio.listTemplates(companyId);
      if (seq === requestSeq.current) setTemplates(rows);
    } catch (e) { if (seq === requestSeq.current) addToast(e.message, 'error'); }
  }, [companyId, addToast]);

  useEffect(() => {
    if (!pendingTemplateId || !companyId) return undefined;
    let cancelled = false;
    const intent = ++builderIntent.current;
    // The store's guarded navigation has already approved leaving the old draft.
    setBuilderDraft(null);
    const stillCurrent = () => {
      const state = useAppStore.getState?.();
      return !cancelled && intent === builderIntent.current && (!state || (state.activeCompanyId === companyId && state.pendingCatalogTemplateId === pendingTemplateId));
    };
    window.api.catalogStudio.getTemplate(pendingTemplateId).then((row) => {
      if (!stillCurrent()) return;
      if (!row || row.id !== pendingTemplateId || row.companyId !== companyId) throw new Error('Catalog template is no longer available in this company');
      setBuilderDraft(row); clearPendingTemplate?.();
    }).catch((e) => {
      if (!stillCurrent()) return;
      addToast(e.message, 'error'); clearPendingTemplate?.();
    });
    return () => { cancelled = true; };
  }, [pendingTemplateId, companyId, clearPendingTemplate, addToast]);
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);
  useEffect(() => {
    const offs = [];
    const refresh = (event) => { if (!event || event.kind === 'catalogStudio') void loadTemplates(); };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => { void loadTemplates(); }));
    return () => offs.forEach((off) => off?.());
  }, [loadTemplates]);

  function begin(template) {
    cancelPendingTemplate();
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
          : { ...createTemplate.config, cover: { ...(createTemplate.config.cover || {}), title, subtitle: '' } },
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
        onClose={() => openBuilder(null)}
        onSaved={() => { openBuilder(null); void loadTemplates(); }}
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
          <Button variant="primary" onClick={() => openBuilder({ name: '', description: '', config: {} })} disabled={!companyId}>
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
      {templates.length ? collection.controls : null}
      {templates.length ? (
        <div className="card-grid catalog-template-grid">
          {collection.rows.map((t) => (
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
                <Button size="sm" onClick={() => openBuilder({ id: t.id, updatedAt: t.updatedAt, name: t.name, description: t.description || '', config: { ...t.config } })}>Edit</Button>
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
      {templates.length ? <>{!collection.rows.length ? <p className="section-hint">No matching templates.</p> : null}{collection.pager}</> : null}
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
              <Button size="sm" onClick={() => { cancelPendingTemplate(); setPreviewTemplate(template); }}>Preview</Button>
              <Button size="sm" onClick={() => openBuilder({ name: `${template.name} (mine)`, description: template.description, config: clone(template.config) })}>Open in builder</Button>
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
        {({ id }) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing && !creating) { e.preventDefault(); void create(); } }} placeholder="e.g. 2026 Wholesale Collection" />}
      </Field>
    </Modal>
  </section>;
}

export function CatalogProjects() {
  const companyId = useAppStore((s) => s.activeCompanyId); const addToast = useAppStore((s) => s.addToast); const setActiveModule = useAppStore((s) => s.setActiveModule);
  const pendingProjectId = useAppStore((s) => s.pendingCatalogProjectId); const clearPendingCatalogNav = useAppStore((s) => s.clearPendingCatalogNav);
  const [projects, setProjects] = useState([]); const [editing, setEditing] = useState(null); const requestSeq = useRef(0);
  const collection = useCatalogCollection(projects);
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
    {projects.length ? collection.controls : null}
    {projects.length ? (
      <div className="card-grid card-grid--compact">
        {collection.rows.map((p) => <ProjectCard key={p.id} project={p} onOpen={() => setEditing(p.id)} onDuplicate={() => duplicateProject(p)} onDelete={() => deleteProject(p)} />)}
      </div>
    ) : (
      <EmptyState
        title="No catalog projects yet"
        body="Choose a template, then add products from your library."
        action={<Button onClick={() => setActiveModule('catalogtemplates')}>Browse templates</Button>}
      />
    )}
    {projects.length ? <>{!collection.rows.length ? <p className="section-hint">No matching projects.</p> : null}{collection.pager}</> : null}
  </section>;
}

export const CatalogStudio = CatalogProjects;
