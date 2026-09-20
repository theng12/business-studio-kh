import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Input, Modal, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { GenerationExperience } from '../../components/GenerationExperience.jsx';
import { useAppStore } from '../../store/index.js';

const THEMES = [
  { id: 'modern', name: 'Modern', description: 'Soft cards, generous spacing, bold cover.' },
  { id: 'minimal', name: 'Minimal', description: 'Editorial grid with sharp, quiet typography.' },
  { id: 'retail', name: 'Retail', description: 'Price-forward cards for sales catalogs.' },
];

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

function FieldRow({ field, onChange }) {
  return <div className="catalog-field-row"><input type="checkbox" checked={field.visible !== false} onChange={(e) => onChange({ visible: e.target.checked })} /><span>{field.label}</span><label><input type="checkbox" checked={!!field.bold} onChange={(e) => onChange({ bold: e.target.checked })} /> Bold</label><label><input type="checkbox" checked={field.showLabel !== false} onChange={(e) => onChange({ showLabel: e.target.checked })} /> Label</label></div>;
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

function CatalogEditor({ projectId, onBack }) {
  const products = useAppStore((s) => s.products); const addToast = useAppStore((s) => s.addToast);
  const [project, setProject] = useState(null); const [preview, setPreview] = useState(''); const [saveState, setSaveState] = useState('saved'); const [savedAt, setSavedAt] = useState(null);
  const [working, setWorking] = useState(false); const [progress, setProgress] = useState(0); const [tab, setTab] = useState('products'); const timer = useRef(null);
  /* v0.1.27: the pending edit is FLUSHED on unmount, not thrown away. The
   * autosave waits 550 ms, so "tweak a setting, click ← Catalog projects"
   * discarded the change silently — the debounce timer was merely cleared. */
  const pending = useRef(null);
  const saveRef = useRef(null);
  useEffect(() => { let cancelled = false; window.api.catalogStudio.get(projectId).then((p) => { if (!cancelled) { setProject(p); setSavedAt(p.updatedAt); } }).catch((e) => addToast(e.message, 'error')); return () => { cancelled = true; clearTimeout(timer.current); if (pending.current) void saveRef.current?.(pending.current); }; }, [projectId, addToast]);
  const refreshPreview = useCallback(async () => { try { const r = await window.api.catalogStudio.preview(projectId); setPreview(r.html); } catch (e) { addToast(e.message, 'error'); } }, [projectId, addToast]);
  useEffect(() => { if (!project) return undefined; const id = setTimeout(refreshPreview, 260); return () => clearTimeout(id); }, [project?.updatedAt, refreshPreview]);
  const save = useCallback(async (value = project) => { if (!value) return; clearTimeout(timer.current); setSaveState('saving'); try { const row = await window.api.catalogStudio.update(value.id, value); setProject(row); setSavedAt(Date.now()); setSaveState('saved'); } catch (e) { setSaveState('dirty'); addToast(e.message, 'error'); } }, [project, addToast]);
  saveRef.current = save;
  function change(patch) { const next = { ...project, ...patch }; setProject(next); pending.current = next; setSaveState('dirty'); clearTimeout(timer.current); timer.current = setTimeout(() => { pending.current = null; save(next); }, 550); }
  function updateConfig(patch) { change({ config: { ...project.config, ...patch } }); }
  async function exportPdf() {
    // v0.1.27: inside a try — a failing dialog used to reject out of the
    // click handler with no toast, so the button looked dead.
    let folder;
    try { folder = await window.api.files.pickFolder(); } catch (e) { addToast(e.message, 'error'); return; }
    if (!folder) return;
    setWorking(true); setProgress(8); let pulse = null;
    try { pulse = setInterval(() => setProgress((x) => Math.min(88, x + 7)), 180); const res = await window.api.catalogStudio.exportPdf(project.id, folder); setProgress(100); await new Promise((r) => setTimeout(r, 650)); addToast(`Catalog exported to ${res.outputPath}`, 'success'); setProject(await window.api.catalogStudio.get(project.id)); }
    catch (e) { addToast(e.message, 'error'); } finally { if (pulse) clearInterval(pulse); setWorking(false); }
  }
  if (!project) return <div className="page-loading">Loading catalog…</div>;
  const c = project.config || {}; const fields = c.fields || DEFAULT_FIELDS;
  return <section className="page catalog-editor-page">
    <div className="catalog-editor-back"><Button variant="ghost" onClick={onBack}>← Catalog projects</Button><span>Editing project</span></div>
    <PageHeader title={project.name} subtitle="Catalog Studio" actions={<><SaveStatus state={saveState} savedAt={savedAt} onSave={() => save()} /><Button onClick={exportPdf}>Export PDF</Button></>} />
    <div className="catalog-editor-tabs"><button type="button" className={tab === 'products' ? 'is-active' : ''} onClick={() => setTab('products')}><span>1</span><div><strong>Products</strong><small>Choose and arrange catalog items</small></div></button><button type="button" className={tab === 'design' ? 'is-active' : ''} onClick={() => setTab('design')}><span>2</span><div><strong>Layout & design</strong><small>Style pages and product cards</small></div></button></div>
    {tab === 'products' ? <div className="catalog-product-workspace"><ProductManager products={products} config={c} onChange={updateConfig} /><LivePreview preview={preview} onRefresh={refreshPreview} /></div> :
      <div className="catalog-editor"><aside className="catalog-controls"><section><h3>Project</h3><label>Name<Input value={project.name} onChange={(e) => change({ name: e.target.value })} /></label><label>Description<Input value={project.description || ''} onChange={(e) => change({ description: e.target.value })} /></label></section>
        <section><h3>Cover</h3><label className="switch-row"><input type="checkbox" checked={c.cover?.enabled !== false} onChange={(e) => updateConfig({ cover: { ...c.cover, enabled: e.target.checked } })} /><span>Include cover page</span></label><label>Title<Input value={c.cover?.title || project.name} onChange={(e) => updateConfig({ cover: { ...c.cover, title: e.target.value } })} /></label><label>Subtitle<Input value={c.cover?.subtitle || ''} onChange={(e) => updateConfig({ cover: { ...c.cover, subtitle: e.target.value } })} /></label></section>
        <section><h3>Layout</h3><div className="control-grid"><label>Page<Select value={c.pageSize || 'A4'} onChange={(e) => updateConfig({ pageSize: e.target.value })}><option>A4</option><option>Letter</option></Select></label><label>Orientation<Select value={c.orientation || 'portrait'} onChange={(e) => updateConfig({ orientation: e.target.value })}><option>portrait</option><option>landscape</option></Select></label><label>Columns<Select value={c.columns || 3} onChange={(e) => updateConfig({ columns: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</Select></label><label>Gap (mm)<Input type="number" value={c.gapMm || 5} onChange={(e) => updateConfig({ gapMm: Number(e.target.value) })} /></label><label>Group products<Select value={c.groupBy || 'none'} onChange={(e) => updateConfig({ groupBy: e.target.value })}><option value="none">No grouping</option><option value="category">By category</option><option value="brand">By brand</option></Select></label><label>Sort by<Select value={c.sortBy || 'manual'} onChange={(e) => updateConfig({ sortBy: e.target.value })}><option value="manual">Catalog order</option><option value="sku">SKU</option><option value="name">Product name</option></Select></label></div></section>
        <section><h3>Style</h3><div className="theme-choices">{THEMES.map((t) => <button type="button" key={t.id} className={(c.theme || 'modern') === t.id ? 'is-active' : ''} onClick={() => updateConfig({ theme: t.id })}><strong>{t.name}</strong><span>{t.description}</span></button>)}</div><div className="control-grid"><label>Primary<Input type="color" value={c.primaryColor || '#111827'} onChange={(e) => updateConfig({ primaryColor: e.target.value })} /></label><label>Accent<Input type="color" value={c.accentColor || '#6366f1'} onChange={(e) => updateConfig({ accentColor: e.target.value })} /></label></div></section>
        <section><h3>Card fields</h3>{fields.map((f, i) => <FieldRow key={f.key} field={f} onChange={(patch) => updateConfig({ fields: fields.map((x, n) => n === i ? { ...x, ...patch } : x) })} />)}</section>
      </aside><LivePreview preview={preview} onRefresh={refreshPreview} /></div>}
    <GenerationExperience open={working} title="Building your catalog" progress={progress} phase={Math.min(3, Math.floor(progress / 28))} detail={project.name} />
  </section>;
}

export function CatalogTemplates() {
  const companyId = useAppStore((s) => s.activeCompanyId); const addToast = useAppStore((s) => s.addToast); const openCatalogProject = useAppStore((s) => s.openCatalogProject); const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [previewTemplate, setPreviewTemplate] = useState(null); const [createTemplate, setCreateTemplate] = useState(null); const [name, setName] = useState(''); const [creating, setCreating] = useState(false);
  function begin(template) { setCreateTemplate(template); setName(template.name); }
  async function create() { if (!createTemplate || !companyId) return; setCreating(true); try { const title = name.trim() || createTemplate.name; const project = await window.api.catalogStudio.create({ companyId, name: title, description: createTemplate.description, config: projectConfig(createTemplate, title) }); setCreateTemplate(null); setName(''); openCatalogProject(project.id); } catch (e) { addToast(e.message, 'error'); } finally { setCreating(false); } }
  return <section className="page"><PageHeader title="Catalog Templates" subtitle="Start with a proven layout, then choose exactly which products belong in the catalog." actions={<Button variant="ghost" onClick={() => setActiveModule('catalogprojects')}>View projects</Button>} />
    <div className="studio-intro studio-intro--catalog"><div><span className="studio-intro__icon">T</span><div><strong>Choose the structure before adding products</strong><p>Every template remains editable after you create a project.</p></div></div><span className="studio-intro__badge">{CATALOG_TEMPLATES.length} templates</span></div>
    <div className="catalog-template-grid">{CATALOG_TEMPLATES.map((template) => <article className="catalog-template-card" key={template.id}><TemplateVisual template={template} /><div className="catalog-template-card__body"><span>{template.eyebrow}</span><strong>{template.name}</strong><p>{template.description}</p><small>Best for: {template.bestFor}</small><div><Button variant="ghost" onClick={() => setPreviewTemplate(template)}>Preview</Button><Button onClick={() => begin(template)}>Use template</Button></div></div></article>)}</div>
    <Modal open={!!previewTemplate} onClose={() => setPreviewTemplate(null)} title={previewTemplate?.name || 'Catalog template'} footer={<><Button variant="ghost" onClick={() => setPreviewTemplate(null)}>Close</Button><Button onClick={() => { const selected = previewTemplate; setPreviewTemplate(null); begin(selected); }}>Use this template</Button></>}>{previewTemplate ? <div className="catalog-template-detail"><TemplateVisual template={previewTemplate} large /><p>{previewTemplate.description}</p><strong>Best for</strong><span>{previewTemplate.bestFor}</span><div className="catalog-template-facts"><span>{previewTemplate.config.columns} columns</span><span>{previewTemplate.config.theme} style</span><span>{previewTemplate.config.fields.length} product fields</span></div></div> : null}</Modal>
    <Modal open={!!createTemplate} onClose={() => setCreateTemplate(null)} title="Create catalog project" footer={<><Button variant="ghost" onClick={() => setCreateTemplate(null)}>Cancel</Button><Button disabled={creating} onClick={create}>{creating ? 'Creating…' : 'Create and add products'}</Button></>}><label className="field"><span className="field__label">Project name</span><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2026 Wholesale Collection" /><span className="field__hint">Using the {createTemplate?.name} template. You can change every layout setting later.</span></label></Modal>
  </section>;
}

export function CatalogProjects() {
  const companyId = useAppStore((s) => s.activeCompanyId); const addToast = useAppStore((s) => s.addToast); const setActiveModule = useAppStore((s) => s.setActiveModule);
  const pendingProjectId = useAppStore((s) => s.pendingCatalogProjectId); const clearPendingCatalogNav = useAppStore((s) => s.clearPendingCatalogNav);
  const [projects, setProjects] = useState([]); const [editing, setEditing] = useState(null);
  const load = useCallback(() => companyId && window.api.catalogStudio.list(companyId).then(setProjects).catch((e) => addToast(e.message, 'error')), [companyId, addToast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (pendingProjectId) { setEditing(pendingProjectId); clearPendingCatalogNav(); } }, [pendingProjectId, clearPendingCatalogNav]);
  if (editing) return <CatalogEditor projectId={editing} onBack={() => { setEditing(null); void load(); }} />;
  return <section className="page"><PageHeader title="Catalog Projects" subtitle="Manage saved catalogs and continue where you left off." actions={<Button onClick={() => setActiveModule('catalogtemplates')}>+ New from template</Button>} />
    <div className="studio-intro studio-intro--catalog"><div><span className="studio-intro__icon">C</span><div><strong>Your catalog workspace</strong><p>Open a project to manage its products, ordering, layout and PDF output.</p></div></div><span className="studio-intro__badge">{projects.length} project{projects.length === 1 ? '' : 's'}</span></div>
    <div className="catalog-project-grid">{projects.length ? projects.map((p) => <ProjectCard key={p.id} project={p} onOpen={() => setEditing(p.id)} onDuplicate={async () => { try { await window.api.catalogStudio.duplicate(p.id); void load(); } catch (e) { addToast(e.message, 'error'); } }} onDelete={async () => { if (!(await confirm({ title: `Delete “${p.name}”?`, message: 'The catalog project is removed. Products and images are not affected.', danger: true }))) return; try { await window.api.catalogStudio.remove(p.id); void load(); } catch (e) { addToast(e.message, 'error'); } }} />) : <EmptyState title="No catalog projects" body="Choose a template, then add products from your library." action={<Button onClick={() => setActiveModule('catalogtemplates')}>Browse catalog templates</Button>} />}</div>
  </section>;
}

export const CatalogStudio = CatalogProjects;
