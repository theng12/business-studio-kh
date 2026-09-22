import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Input, Modal } from '../../components/ui.jsx';
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

function TemplateVisual({ template, large = false }) {
  const columns = Math.min(4, template.config.columns || 3);
  return <div className={`catalog-template-visual catalog-template-visual--${template.id}${large ? ' is-large' : ''}`} style={{ '--catalog-primary': template.config.primaryColor, '--catalog-accent': template.config.accentColor }}>
    <div className="catalog-template-visual__cover"><span>PRODUCT CATALOG</span><strong>{template.name}</strong></div>
    <div className="catalog-template-visual__page" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {Array.from({ length: columns * 2 }, (_, i) => <span key={i}><i /><b /><em /></span>)}
    </div>
  </div>;
}

function ProjectCard({ project, onOpen, onDuplicate, onDelete }) {
  const c = project.config || {};
  const productLabel = c.selectionMode === 'explicit' ? `${(c.productIds || []).length} products` : 'All active products';
  return <article className="catalog-project-card">
    <button type="button" className="catalog-cover-mini" style={{ background: `linear-gradient(145deg, ${c.primaryColor || '#111827'}, ${c.accentColor || '#6366f1'})` }} onClick={onOpen}>
      <span>PRODUCT CATALOG</span><strong>{c.cover?.title || project.name}</strong><small>{c.columns || 3}-column · {c.pageSize || 'A4'}</small>
    </button>
    <div className="catalog-project-card__meta"><div><strong>{project.name}</strong><span>{productLabel} · {project.lastExportedAt ? `Exported ${new Date(project.lastExportedAt).toLocaleDateString()}` : 'Not exported yet'}</span></div>
      <div><Button variant="ghost" onClick={onDuplicate}>Duplicate</Button><Button variant="ghost" onClick={onDelete}>Delete</Button><Button onClick={onOpen}>Open</Button></div>
    </div>
  </article>;
}

function ProductManager({ products, config, onChange }) {
  const [query, setQuery] = useState('');
  const activeProducts = useMemo(() => products.filter((p) => p.status !== 'inactive'), [products]);
  const productMap = useMemo(() => new Map(activeProducts.map((p) => [p.id, p])), [activeProducts]);
  const includedIds = useMemo(() => {
    if (config.selectionMode === 'explicit') return (config.productIds || []).filter((id) => productMap.has(id));
    if (config.productIds?.length) return config.productIds.filter((id) => productMap.has(id));
    return activeProducts.map((p) => p.id);
  }, [config.selectionMode, config.productIds, productMap, activeProducts]);
  const includedSet = useMemo(() => new Set(includedIds), [includedIds]);
  const normalized = query.trim().toLowerCase();
  const available = useMemo(() => activeProducts.filter((p) => !includedSet.has(p.id) && (!normalized || `${p.sku} ${p.name || ''} ${p.barcode || ''}`.toLowerCase().includes(normalized))), [activeProducts, includedSet, normalized]);
  const included = includedIds.map((id) => productMap.get(id)).filter(Boolean);
  function commit(ids, manual = false) {
    onChange({ productIds: ids, selectionMode: 'explicit', brandIds: [], categoryIds: [], ...(manual ? { sortBy: 'manual' } : {}) });
  }
  function move(id, direction) {
    const index = includedIds.indexOf(id); const target = index + direction;
    if (index < 0 || target < 0 || target >= includedIds.length) return;
    const next = [...includedIds]; [next[index], next[target]] = [next[target], next[index]]; commit(next, true);
  }
  return <section className="catalog-product-manager">
    <div className="catalog-product-manager__heading"><div><span>Catalog contents</span><strong>{included.length} product{included.length === 1 ? '' : 's'} included</strong><p>Pick products from the shared library, then arrange their catalog order.</p></div><Button variant="ghost" onClick={() => commit([])}>Remove all</Button></div>
    <div className="catalog-product-columns">
      <section className="catalog-product-panel"><header><div><strong>Product Library</strong><span>{available.length} available</span></div><Button variant="ghost" disabled={!available.length} onClick={() => commit([...includedIds, ...available.map((p) => p.id)])}>Add all shown</Button></header><div className="catalog-product-search"><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU, name or barcode" /></div><div className="catalog-product-list">
        {available.length ? available.map((p) => <article key={p.id}><div className="catalog-product-avatar">{String(p.sku || 'P').slice(0, 2).toUpperCase()}</div><div><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'}</span></div><Button variant="ghost" onClick={() => commit([...includedIds, p.id])}>Add</Button></article>) : <div className="catalog-product-empty">{normalized ? 'No matching products outside this catalog.' : 'Every active product is already included.'}</div>}
      </div></section>
      <section className="catalog-product-panel catalog-product-panel--included"><header><div><strong>Included in catalog</strong><span>Shown in this order</span></div></header><div className="catalog-product-list">
        {included.length ? included.map((p, index) => <article key={p.id}><span className="catalog-order-number">{index + 1}</span><div><strong>{p.sku}</strong><span>{p.name || 'Unnamed product'}</span></div><div className="catalog-product-row-actions"><button type="button" aria-label={`Move ${p.sku} up`} disabled={index === 0} onClick={() => move(p.id, -1)}>↑</button><button type="button" aria-label={`Move ${p.sku} down`} disabled={index === included.length - 1} onClick={() => move(p.id, 1)}>↓</button><button type="button" onClick={() => commit(includedIds.filter((id) => id !== p.id))}>Remove</button></div></article>) : <div className="catalog-product-empty"><strong>No products added yet</strong><span>Add products from the library to build this catalog.</span></div>}
      </div></section>
    </div>
  </section>;
}

function LivePreview({ preview, onRefresh }) {
  return <main className="catalog-preview"><div className="catalog-preview__bar"><span>Live PDF preview</span><Button variant="ghost" onClick={onRefresh}>Refresh</Button></div>{preview ? <iframe title="Catalog preview" srcDoc={preview} /> : <div className="preview-placeholder">Building preview…</div>}</main>;
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
          setProject(row); latest.current = row; dirty.current = false; setSavedAt(Date.now()); setSaveState('saved');
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
  if (!project) return <div className="page-loading">Loading catalog…</div>;
  if (templateDraft) {
    return (
      <CatalogTemplateBuilder
        draft={templateDraft}
        onClose={() => setTemplateDraft(null)}
        onSaved={() => setTemplateDraft(null)}
      />
    );
  }
  const c = project.config || {};
  return <section className="page catalog-editor-page">
    <div className="catalog-editor-back"><Button variant="ghost" onClick={leaveEditor}>← Catalog projects</Button><span>Editing project</span></div>
    <PageHeader title={project.name} subtitle="Catalog Studio" actions={<><SaveStatus state={saveState} savedAt={savedAt} onSave={saveNow} /><Button
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
      </Button><Button onClick={exportPdf}>Export PDF</Button></>} />
    <div className="catalog-editor-tabs"><button type="button" className={tab === 'products' ? 'is-active' : ''} onClick={() => setTab('products')}><span>1</span><div><strong>Products</strong><small>Choose and arrange catalog items</small></div></button><button type="button" className={tab === 'design' ? 'is-active' : ''} onClick={() => setTab('design')}><span>2</span><div><strong>Layout & design</strong><small>Style pages and product cards</small></div></button></div>
    {tab === 'products' ? <div className="catalog-product-workspace"><ProductManager products={products} config={c} onChange={updateConfig} /><LivePreview preview={preview} onRefresh={refreshPreview} /></div> :
      <div className="catalog-editor"><aside className="catalog-controls"><section><h3>Project</h3><label>Name<Input value={project.name} onChange={(e) => change({ name: e.target.value })} /></label><label>Description<Input value={project.description || ''} onChange={(e) => change({ description: e.target.value })} /></label></section>
        <DesignControls
          config={c}
          onChange={updateConfig}
          priceGroups={catalogPriceGroups}
          coverTitle={{ value: c.cover?.title || project.name, onChange: (title) => updateConfig({ cover: { ...c.cover, title } }) }}
          coverSubtitle={{ value: c.cover?.subtitle || '', onChange: (subtitle) => updateConfig({ cover: { ...c.cover, subtitle } }) }}
        />
      </aside><LivePreview preview={preview} onRefresh={refreshPreview} /></div>}
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

  return <section className="page">
    <PageHeader
      title="Catalog Templates"
      subtitle="Build your own layouts, or start from a proven one — then choose exactly which products belong in each catalog."
      actions={(
        <>
          <Button variant="ghost" onClick={() => setActiveModule('catalogprojects')}>View projects</Button>
          <Button variant="primary" onClick={() => setBuilderDraft({ name: '', description: '', config: {} })} disabled={!companyId}>
            + New template
          </Button>
        </>
      )}
    />

    <div className="studio-intro studio-intro--catalog">
      <div>
        <span className="studio-intro__icon">T</span>
        <div>
          <strong>Build the look once, use it for every catalog</strong>
          <p>A template holds the page size, grid, style, cover and product-card fields — never the products. Open one in the builder and the preview is a real page render of your own catalogue.</p>
        </div>
      </div>
      <span className="studio-intro__badge">{templates.length} saved · {CATALOG_TEMPLATES.length} proven</span>
    </div>

    {/* ── my templates ─────────────────────────────────────────────── */}
    <section className="catalog-section">
      <div className="catalog-section__head">
        <h2>My templates</h2>
        <span className="muted">Yours to edit, duplicate and reuse in any catalog.</span>
      </div>
      {templates.length ? (
        <div className="catalog-template-grid">
          {templates.map((t) => (
            <article className="catalog-template-card catalog-template-card--mine" key={t.id}>
              <TemplateVisual template={{ id: t.config.theme || 'modern', name: t.name, config: t.config }} />
              <div className="catalog-template-card__body">
                <span>{(t.config.columns || 3)} columns · {t.config.pageSize || 'A4'} {t.config.orientation || 'portrait'}</span>
                <strong>{t.name}</strong>
                <p>{t.description || 'No description.'}</p>
                <small>
                  {(t.config.fields || []).filter((f) => f.visible !== false).length} card fields
                  {' · '}{(t.config.theme || 'modern')} style
                  {t.config.coverEnabled === false ? ' · no cover' : ' · cover page'}
                </small>
                <div>
                  <Button variant="ghost" onClick={() => setBuilderDraft({ id: t.id, name: t.name, description: t.description || '', config: { ...t.config } })}>Edit</Button>
                  <Button variant="ghost" onClick={async () => { try { await window.api.catalogStudio.duplicateTemplate(t.id); void loadTemplates(); } catch (e) { addToast(e.message, 'error'); } }}>Duplicate</Button>
                  <Button variant="ghost" onClick={async () => {
                    if (!(await confirm({ title: `Delete “${t.name}”?`, message: 'Catalogs already created from it are not affected.', danger: true }))) return;
                    try { await window.api.catalogStudio.removeTemplate(t.id); void loadTemplates(); } catch (e) { addToast(e.message, 'error'); }
                  }}>Delete</Button>
                  <Button onClick={() => begin({ ...t, builtIn: false })}>Use in a new catalog</Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="catalog-section__empty">
          No templates of your own yet. Press <strong>+ New template</strong> to build one, or open a proven layout below and save your version of it.
        </p>
      )}
    </section>

    {/* ── proven layouts ───────────────────────────────────────────── */}
    <section className="catalog-section">
      <div className="catalog-section__head">
        <h2>Proven layouts</h2>
        <span className="muted">Ready-made structures. Use one as-is, or open it in the builder and save your own version.</span>
      </div>
      <div className="catalog-template-grid">{CATALOG_TEMPLATES.map((template) => <article className="catalog-template-card" key={template.id}><TemplateVisual template={template} /><div className="catalog-template-card__body"><span>{template.eyebrow}</span><strong>{template.name}</strong><p>{template.description}</p><small>Best for: {template.bestFor}</small><div><Button variant="ghost" onClick={() => setPreviewTemplate(template)}>Preview</Button><Button variant="ghost" onClick={() => setBuilderDraft({ name: `${template.name} (mine)`, description: template.description, config: clone(template.config) })}>Open in builder</Button><Button onClick={() => begin(template)}>Use template</Button></div></div></article>)}</div>
    </section>

    <Modal open={!!previewTemplate} onClose={() => setPreviewTemplate(null)} title={previewTemplate?.name || 'Catalog template'} footer={<><Button variant="ghost" onClick={() => setPreviewTemplate(null)}>Close</Button><Button onClick={() => { const selected = previewTemplate; setPreviewTemplate(null); begin(selected); }}>Use this template</Button></>}>{previewTemplate ? <div className="catalog-template-detail"><TemplateVisual template={previewTemplate} large /><p>{previewTemplate.description}</p><strong>Best for</strong><span>{previewTemplate.bestFor}</span><div className="catalog-template-facts"><span>{previewTemplate.config.columns} columns</span><span>{previewTemplate.config.theme} style</span><span>{previewTemplate.config.fields.length} product fields</span></div></div> : null}</Modal>
    <Modal open={!!createTemplate} onClose={() => setCreateTemplate(null)} title="Create catalog project" footer={<><Button variant="ghost" onClick={() => setCreateTemplate(null)}>Cancel</Button><Button disabled={creating} onClick={create}>{creating ? 'Creating…' : 'Create and add products'}</Button></>}><label className="field"><span className="field__label">Project name</span><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2026 Wholesale Collection" /><span className="field__hint">Using {createTemplate?.builtIn ? 'the' : 'your'} {createTemplate?.name} template. You can change every layout setting later.</span></label></Modal>
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
  return <section className="page"><PageHeader title="Catalog Projects" subtitle="Manage saved catalogs and continue where you left off." actions={<Button onClick={() => setActiveModule('catalogtemplates')}>+ New from template</Button>} />
    <div className="studio-intro studio-intro--catalog"><div><span className="studio-intro__icon">C</span><div><strong>Your catalog workspace</strong><p>Open a project to manage its products, ordering, layout and PDF output.</p></div></div><span className="studio-intro__badge">{projects.length} project{projects.length === 1 ? '' : 's'}</span></div>
    <div className="catalog-project-grid">{projects.length ? projects.map((p) => <ProjectCard key={p.id} project={p} onOpen={() => setEditing(p.id)} onDuplicate={async () => { try { await window.api.catalogStudio.duplicate(p.id); void load(); } catch (e) { addToast(e.message, 'error'); } }} onDelete={async () => { if (!(await confirm({ title: `Delete “${p.name}”?`, message: 'The catalog project is removed. Products and images are not affected.', danger: true }))) return; try { await window.api.catalogStudio.remove(p.id); void load(); } catch (e) { addToast(e.message, 'error'); } }} />) : <EmptyState title="No catalog projects" body="Choose a template, then add products from your library." action={<Button onClick={() => setActiveModule('catalogtemplates')}>Browse catalog templates</Button>} />}</div>
  </section>;
}

export const CatalogStudio = CatalogProjects;
