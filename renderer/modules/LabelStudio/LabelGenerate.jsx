import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Input, Pagination, Select, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { GenerationExperience } from '../../components/GenerationExperience.jsx';
import { clearLabelRerun, peekLabelRerun } from './labelRerun.js';
import { NumberField } from './NumberField.jsx';
import { centerPreviewHtml, filterLabelProducts, loadGenerateSettings, saveGenerateSettings } from './labelGenerateState.js';

export function LabelGenerate() {
  const companyId = useAppStore((s) => s.activeCompanyId); const addToast = useAppStore((s) => s.addToast);
  // Every product in the company. `products` mirrors the Library's search and
  // filters, so after a Library search (or a Dashboard attention click) this
  // screen said "No products yet" and "Run again" dropped products. The
  // `?? s.products` only matters to component tests that stub the old field.
  const products = useAppStore((s) => s.allProducts ?? s.products);
  const refreshAllProducts = useAppStore((s) => s.refreshAllProducts);
  const brands = useAppStore((s) => s.brands) ?? []; const categories = useAppStore((s) => s.categories) ?? [];
  const refreshBrands = useAppStore((s) => s.refreshBrands); const refreshCategories = useAppStore((s) => s.refreshCategories);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [brandFilter, setBrandFilter] = useState(''); const [categoryFilter, setCategoryFilter] = useState('');
  // Where the last Generate wrote, for "Open folder".
  const [lastOutput, setLastOutput] = useState(null);
  const [templates, setTemplates] = useState([]); const [templateId, setTemplateId] = useState(''); const [selected, setSelected] = useState([]); const [search, setSearch] = useState('');
  const [productPage, setProductPage] = useState(0); const [productPageSize, setProductPageSize] = useState(50);
  const [outputFolder, setOutputFolder] = useState(''); const [format, setFormat] = useState('pdf'); const [mode, setMode] = useState('sheet'); const [pageSize, setPageSize] = useState('A4'); const [orientation, setOrientation] = useState('portrait');
  const [marginMm, setMarginMm] = useState(8); const [gapMm, setGapMm] = useState(2); const [copies, setCopies] = useState(1); const [printers, setPrinters] = useState([]); const [printer, setPrinter] = useState('');
  const [working, setWorking] = useState(false); const [progress, setProgress] = useState(0); const [phase, setPhase] = useState(0); const [detail, setDetail] = useState(''); const [previewHtml, setPreviewHtml] = useState('');
  const templatesRequestRef = useRef(0); const previewRequestRef = useRef(0);
  // "Run again" from Label History: the run's template wins once, when the
  // template list arrives (see labelRerun.js).
  const preferredTemplateRef = useRef(null);
  const productsRef = useRef(products); productsRef.current = products;
  useEffect(() => {
    ++templatesRequestRef.current;
    ++previewRequestRef.current;
    setTemplates([]); setTemplateId(''); setSelected([]); setProductPage(0); setPreviewHtml('');
    setBrandFilter(''); setCategoryFilter(''); setLastOutput(null);
    preferredTemplateRef.current = null;
    if (!companyId) return () => { templatesRequestRef.current += 1; };
    // This company's last-used output folder and layout (this Mac only).
    const saved = loadGenerateSettings(companyId);
    setOutputFolder(saved.outputFolder ?? ''); setPrinter(saved.printer ?? '');
    if (saved.format) setFormat(saved.format);
    if (saved.mode) setMode(saved.mode);
    if (saved.pageSize) setPageSize(saved.pageSize);
    if (saved.orientation) setOrientation(saved.orientation);
    if (saved.marginMm != null) setMarginMm(saved.marginMm);
    if (saved.gapMm != null) setGapMm(saved.gapMm);
    const rerun = peekLabelRerun(companyId);
    if (rerun) {
      preferredTemplateRef.current = rerun.templateId || '';
      // Products deleted since that run are left out of the selection.
      const known = new Set((Array.isArray(productsRef.current) ? productsRef.current : []).map((p) => p.id));
      setSelected(known.size ? rerun.productIds.filter((id) => known.has(id)) : rerun.productIds);
      setFormat(rerun.format); setMode(rerun.layout.mode); setPageSize(rerun.layout.pageSize); setOrientation(rerun.layout.orientation);
      setMarginMm(rerun.layout.marginMm); setGapMm(rerun.layout.gapMm); setCopies(rerun.layout.copies);
      if (rerun.printer) setPrinter(rerun.printer);
    }
    const loadTemplates = () => {
      const refreshId = ++templatesRequestRef.current;
      return window.api.labels.listTemplates(companyId)
        .then((rows) => {
          if (refreshId !== templatesRequestRef.current) return;
          const wanted = preferredTemplateRef.current;
          if (wanted != null) {
            preferredTemplateRef.current = null;
            clearLabelRerun();
            if (wanted && !rows.some((row) => row.id === wanted)) addToast('The template that run used has been deleted. Pick another one.', 'error');
          }
          setTemplates(rows); setTemplateId((current) => (wanted && rows.some((row) => row.id === wanted)) ? wanted : rows.some((row) => row.id === current) ? current : (rows[0]?.id || ''));
        })
        .catch((err) => { if (refreshId === templatesRequestRef.current) addToast(`Could not load label templates — ${err.message}`, 'error'); });
    };
    void loadTemplates();
    const offs = [];
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged((event) => { if (event?.kind === 'labels') void loadTemplates(); }));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => { void loadTemplates(); }));
    window.api.labels.listPrinters()
      .then(setPrinters)
      .catch((err) => addToast(`Could not read the printer list — ${err.message}`, 'error'));
    return () => { templatesRequestRef.current += 1; offs.forEach((off) => off?.()); };
  },
    // addToast is a Zustand action — a stable reference, so listing it cannot
    // make this effect re-run.
    [companyId, addToast]);
  useEffect(() => {
    if (!companyId) return;
    if (!(Array.isArray(productsRef.current) && productsRef.current.length)) refreshAllProducts?.();
    if (!brands.length) refreshBrands?.();
    if (!categories.length) refreshCategories?.();
    // Once per company: an empty company must not refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);
  useEffect(() => {
    const off = window.api.events.onProgress((ev) => { if (ev?.kind !== 'labels' || ev.complete) return; setProgress(ev.total ? ev.done / ev.total * 82 + 12 : 15); setPhase(ev.phase === 'finishing' ? 3 : 2); setDetail(ev.label || ''); });
    return () => { if (typeof off === 'function') off(); };
  }, []);
  const productRows = useMemo(() => (Array.isArray(products) ? products : []), [products]);
  const templateRows = useMemo(() => (Array.isArray(templates) ? templates : []), [templates]);
  const printerRows = useMemo(() => (Array.isArray(printers) ? printers : []), [printers]);
  // Every word must match somewhere in SKU, name or barcode ("bf 1611" finds
  // "BF-M1611-CH"), within the chosen brand and category.
  const filtered = useMemo(() => filterLabelProducts(productRows, { search, brandId: brandFilter, categoryId: categoryFilter }), [productRows, search, brandFilter, categoryFilter]);
  const productPageInfo = useMemo(() => paginate(filtered.length, productPage, productPageSize), [filtered.length, productPage, productPageSize]);
  const visibleProducts = filtered.slice(productPageInfo.pageStart, productPageInfo.pageEnd);
  useEffect(() => { if (productPage !== productPageInfo.currentPage) setProductPage(productPageInfo.currentPage); }, [productPage, productPageInfo.currentPage]);
  useEffect(() => { setProductPage(0); }, [search, productPageSize, brandFilter, categoryFilter]);
  const sheetFit = useMemo(() => {
    const t = templateRows.find((x) => x.id === templateId); if (!t || mode !== 'sheet') return null;
    const paper = pageSize === 'Letter' ? [215.9, 279.4] : [210, 297];
    const [pw, ph] = orientation === 'landscape' ? [paper[1], paper[0]] : paper;
    const cols = Math.max(1, Math.floor((pw - marginMm * 2 + gapMm) / (t.widthMm + gapMm)));
    const rows = Math.max(1, Math.floor((ph - marginMm * 2 + gapMm) / (t.heightMm + gapMm)));
    return { cols, rows, total: cols * rows };
  }, [templateRows, templateId, pageSize, orientation, marginMm, gapMm, mode]);
  const layout = { mode, pageSize, orientation, marginMm, gapMm, copies };
  const selectedProductId = selected[0];
  const selectedTemplate = templateRows.find((row) => row.id === templateId);
  const preview = useCallback(async () => { const requestId = ++previewRequestRef.current; const previewTemplateId = selectedTemplate?.id || templateId; if (!previewTemplateId) return; const productId = selectedProductId || productRows[0]?.id; if (!productId) return; try { const res = await window.api.labels.preview({ templateId: previewTemplateId, productId, layout: { mode: 'single' } }); if (requestId !== previewRequestRef.current) return; setPreviewHtml(res.html); } catch (e) { if (requestId === previewRequestRef.current) addToast(e.message, 'error'); } }, [templateId, selectedTemplate, selectedProductId, productRows, addToast]);
  useEffect(() => { const previewRef = previewRequestRef; ++previewRef.current; const id = setTimeout(preview, 200); return () => { clearTimeout(id); ++previewRef.current; }; }, [preview]);
  function toggle(id) { setSelected((x) => x.includes(id) ? x.filter((v) => v !== id) : [...x, id]); }
  const rememberSettings = (patch = {}) => saveGenerateSettings(companyId, { outputFolder, format, mode, pageSize, orientation, marginMm, gapMm, printer, ...patch });
  async function pickFolder() {
    try {
      const f = await window.api.files.pickFolder();
      if (f) { setOutputFolder(f); rememberSettings({ outputFolder: f }); }
    } catch (e) { addToast(e.message, 'error'); }
  }
  async function openOutput() {
    if (!lastOutput) return;
    try { await window.api.files.revealPath(lastOutput); } catch (e) { addToast(e.message, 'error'); }
  }
  async function generate() {
    if (!selected.length) return addToast('Select at least one product', 'error'); if (!outputFolder) return addToast('Pick an output folder', 'error');
    setWorking(true); setProgress(6); setPhase(0); setDetail(`${selected.length} products`); setLastOutput(null);
    rememberSettings();
    try { setProgress(12); setPhase(1); const res = await window.api.labels.generate({ companyId, templateId, productIds: selected, outputFolder, format, layout }); setProgress(100); setPhase(3); setDetail('Ready'); setLastOutput(res?.outputPath || null); addToast(`Created ${res.files.length} file${res.files.length === 1 ? '' : 's'}`, 'success'); }
    catch (e) { addToast(e.message, 'error'); } finally { setWorking(false); }
  }
  async function print() {
    if (!selected.length) return addToast('Select at least one product', 'error'); setWorking(true); setProgress(8); setPhase(0);
    rememberSettings();
    try { await window.api.labels.print({ companyId, templateId, productIds: selected, layout, printOptions: { silent: !!printer, deviceName: printer, copies: 1 } }); setProgress(100); setPhase(3); addToast('Print job sent', 'success'); } catch (e) { addToast(e.message, 'error'); } finally { setWorking(false); }
  }
  if (!companyId) {
    return <section className="page"><PageHeader title="Generate & Print" /><NoCompanyState purpose="make labels from its products" /></section>;
  }
  if (!productRows.length) {
    return (
      <section className="page">
        <PageHeader title="Generate & Print" subtitle="Create labels from Product Library data." />
        <EmptyState
          title="No products yet"
          body="Add products to the Product Library, then come back to make their labels."
          action={<Button variant="primary" onClick={() => setActiveModule('library')}>Go to Product Library</Button>}
        />
      </section>
    );
  }
  const segment = (active) => `segment${active ? ' is-active' : ''}`;
  // Why the two run buttons are greyed out, for their tooltips (§18).
  const blockedReason = working ? 'A run is already in progress' : !selected.length ? 'Select at least one product first' : undefined;
  return <section className="page"><PageHeader title="Generate & Print" subtitle="Turn selected products into print-ready labels." actions={<div className="selection-count">{selected.length} selected</div>} />
    <div className="production-layout"><div className="production-panel">
      <div className="production-step"><h2 className="section-title">1. Choose a template</h2><div className="production-step__body"><Select aria-label="Label template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{templateRows.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.widthMm}×{t.heightMm}mm</option>)}</Select></div></div>
      <div className="production-step"><h2 className="section-title">2. Select products</h2><div className="production-step__body">
        <Input type="search" aria-label="Search products" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU, name or barcode" />
        <div className="product-pick-filters">
          <Select aria-label="Filter by brand" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}>
            <option value="">All brands</option>
            <option value="__none">No brand</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Select aria-label="Filter by category" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            <option value="__none">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="product-pick-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected((current) => { const have = new Set(current); return [...current, ...visibleProducts.map((p) => p.id).filter((id) => !have.has(id))]; })} title="Add every product on this page to the selection">Add visible</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!filtered.length} onClick={() => setSelected((current) => { const have = new Set(current); return [...current, ...filtered.map((p) => p.id).filter((id) => !have.has(id))]; })} title="Add every product that matches the search and filters, on every page">Add all matching ({filtered.length})</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!selected.length} onClick={() => setSelected([])}>Clear selection</button>
        </div>
        {!filtered.length ? <p className="production-note">Nothing matches. Try a shorter search or clear the filters.</p> : null}
        <div className="product-pick-list">{visibleProducts.map((p) => <label key={p.id} className={selected.includes(p.id) ? 'is-selected' : ''}><input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} /><span><strong>{p.sku}</strong>{p.name || 'Unnamed product'}</span><em>{p.barcode || 'No barcode'}</em></label>)}</div>
        <Pagination total={filtered.length} pageStart={productPageInfo.pageStart} pageEnd={productPageInfo.pageEnd} currentPage={productPageInfo.currentPage} maxPage={productPageInfo.maxPage} pageSize={productPageSize} onPageChange={setProductPage} onPageSizeChange={setProductPageSize} />
      </div></div>
      <div className="production-step"><h2 className="section-title">3. Output</h2><div className="production-step__body">
        <div className="segments" role="group" aria-label="File format"><button type="button" className={segment(format === 'pdf')} onClick={() => setFormat('pdf')}>PDF</button><button type="button" className={segment(format === 'png')} onClick={() => setFormat('png')}>PNG</button><button type="button" className={segment(format === 'jpeg')} onClick={() => setFormat('jpeg')}>JPEG</button></div>
        {format === 'pdf' ? <><div className="segments" role="group" aria-label="Page layout"><button type="button" className={segment(mode === 'sheet')} onClick={() => setMode('sheet')}>Sheet layout</button><button type="button" className={segment(mode === 'single')} onClick={() => setMode('single')}>One per page</button></div>{mode === 'sheet' ? <><div className="production-grid"><label>Paper<Select value={pageSize} onChange={(e) => setPageSize(e.target.value)}><option>A4</option><option>Letter</option></Select></label><label>Orientation<Select value={orientation} onChange={(e) => setOrientation(e.target.value)}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></Select></label><label>Margin (mm)<NumberField value={marginMm} min={0} max={50} onCommit={setMarginMm} /></label><label>Gap (mm)<NumberField value={gapMm} min={0} max={50} onCommit={setGapMm} /></label></div>{sheetFit ? <div className="sheet-fit-note"><strong>{sheetFit.total} labels per page</strong><span>{sheetFit.cols} across × {sheetFit.rows} down</span></div> : null}</> : null}</> : null}
        {format === 'pdf' ? <label>Copies per product<NumberField value={copies} min={1} max={100} integer onCommit={setCopies} /></label> : <p className="production-note">One image file per product.</p>}
        <div className="folder-picker"><Button size="sm" onClick={pickFolder}>{outputFolder ? 'Change folder…' : 'Choose output folder…'}</Button><span title={outputFolder || undefined}>{outputFolder || 'No folder chosen'}</span></div>
      </div></div>
      <div className="production-actions"><Select aria-label="Printer" value={printer} onChange={(e) => setPrinter(e.target.value)}><option value="">Show printer dialog…</option>{printerRows.map((p) => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}</Select><Button onClick={print} disabled={working || !selected.length} title={blockedReason}>Print labels</Button><Button variant="primary" onClick={generate} disabled={working || !selected.length} title={blockedReason}>Generate files</Button></div>
      {lastOutput && !working ? <div className="production-done"><span>Saved to <code title={lastOutput}>{lastOutput}</code></span><Button size="sm" onClick={openOutput}>Open folder</Button></div> : null}
    </div><aside className="live-preview-card"><div className="live-preview-card__head"><h2 className="section-title">Live preview</h2><button type="button" className="btn btn--ghost btn--sm" onClick={preview}>Refresh</button></div>{previewHtml ? <iframe title="Label preview" srcDoc={centerPreviewHtml(previewHtml)} /> : <div className="preview-placeholder">Choose a template and product</div>}<div className="live-preview-card__hint">Preview uses the first selected product</div></aside></div>
    <GenerationExperience open={working} title={format === 'pdf' ? 'Making your labels' : 'Rendering label artwork'} progress={progress} phase={phase} detail={detail} />
  </section>;
}
