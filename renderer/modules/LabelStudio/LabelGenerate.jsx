import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Input, Pagination, Select, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { GenerationExperience } from '../../components/GenerationExperience.jsx';

export function LabelGenerate() {
  const companyId = useAppStore((s) => s.activeCompanyId); const products = useAppStore((s) => s.products); const addToast = useAppStore((s) => s.addToast);
  const [templates, setTemplates] = useState([]); const [templateId, setTemplateId] = useState(''); const [selected, setSelected] = useState([]); const [search, setSearch] = useState('');
  const [productPage, setProductPage] = useState(0); const [productPageSize, setProductPageSize] = useState(50);
  const [outputFolder, setOutputFolder] = useState(''); const [format, setFormat] = useState('pdf'); const [mode, setMode] = useState('sheet'); const [pageSize, setPageSize] = useState('A4'); const [orientation, setOrientation] = useState('portrait');
  const [marginMm, setMarginMm] = useState(8); const [gapMm, setGapMm] = useState(2); const [copies, setCopies] = useState(1); const [printers, setPrinters] = useState([]); const [printer, setPrinter] = useState('');
  const [working, setWorking] = useState(false); const [progress, setProgress] = useState(0); const [phase, setPhase] = useState(0); const [detail, setDetail] = useState(''); const [previewHtml, setPreviewHtml] = useState('');
  const templatesRequestRef = useRef(0); const previewRequestRef = useRef(0);
  useEffect(() => {
    ++templatesRequestRef.current;
    ++previewRequestRef.current;
    setTemplates([]); setTemplateId(''); setSelected([]); setProductPage(0); setPreviewHtml('');
    if (!companyId) return () => { templatesRequestRef.current += 1; };
    const loadTemplates = () => {
      const refreshId = ++templatesRequestRef.current;
      return window.api.labels.listTemplates(companyId)
        .then((rows) => {
          if (refreshId !== templatesRequestRef.current) return;
          setTemplates(rows); setTemplateId((current) => rows.some((row) => row.id === current) ? current : (rows[0]?.id || ''));
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
    const off = window.api.events.onProgress((ev) => { if (ev?.kind !== 'labels' || ev.complete) return; setProgress(ev.total ? ev.done / ev.total * 82 + 12 : 15); setPhase(ev.phase === 'finishing' ? 3 : 2); setDetail(ev.label || ''); });
    return () => { if (typeof off === 'function') off(); };
  }, []);
  const productRows = useMemo(() => (Array.isArray(products) ? products : []), [products]);
  const templateRows = useMemo(() => (Array.isArray(templates) ? templates : []), [templates]);
  const printerRows = useMemo(() => (Array.isArray(printers) ? printers : []), [printers]);
  const filtered = useMemo(() => { const q = search.toLowerCase(); return productRows.filter((p) => !q || `${p.sku} ${p.name}`.toLowerCase().includes(q)); }, [productRows, search]);
  const productPageInfo = useMemo(() => paginate(filtered.length, productPage, productPageSize), [filtered.length, productPage, productPageSize]);
  const visibleProducts = filtered.slice(productPageInfo.pageStart, productPageInfo.pageEnd);
  useEffect(() => { if (productPage !== productPageInfo.currentPage) setProductPage(productPageInfo.currentPage); }, [productPage, productPageInfo.currentPage]);
  useEffect(() => { setProductPage(0); }, [search, productPageSize]);
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
  async function pickFolder() { const f = await window.api.files.pickFolder(); if (f) setOutputFolder(f); }
  async function generate() {
    if (!selected.length) return addToast('Select at least one product', 'error'); if (!outputFolder) return addToast('Pick an output folder', 'error');
    setWorking(true); setProgress(6); setPhase(0); setDetail(`${selected.length} products`);
    try { setProgress(12); setPhase(1); const res = await window.api.labels.generate({ companyId, templateId, productIds: selected, outputFolder, format, layout }); setProgress(100); setPhase(3); setDetail('Ready'); addToast(`Created ${res.files.length} file${res.files.length === 1 ? '' : 's'}`, 'success'); }
    catch (e) { addToast(e.message, 'error'); } finally { setWorking(false); }
  }
  async function print() {
    if (!selected.length) return addToast('Select at least one product', 'error'); setWorking(true); setProgress(8); setPhase(0);
    try { await window.api.labels.print({ companyId, templateId, productIds: selected, layout, printOptions: { silent: !!printer, deviceName: printer, copies: 1 } }); setProgress(100); setPhase(3); addToast('Print job sent', 'success'); } catch (e) { addToast(e.message, 'error'); } finally { setWorking(false); }
  }
  if (!productRows.length) return <section className="page"><PageHeader title="Generate & Print" subtitle="Create labels from Product Library data." /><EmptyState title="No products yet" body="Add products to the Product Library before generating labels." /></section>;
  return <section className="page"><PageHeader title="Generate & Print" subtitle="Turn selected products into print-ready labels." actions={<div className="selection-count">{selected.length} selected</div>} />
    <div className="production-layout"><div className="production-panel"><div className="production-step"><span>1</span><div><strong>Choose a template</strong><Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{templateRows.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.widthMm}×{t.heightMm}mm</option>)}</Select></div></div>
      <div className="production-step"><span>2</span><div><strong>Select products</strong><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU or product name" /><div className="product-pick-actions"><button type="button" onClick={() => setSelected(visibleProducts.map((p) => p.id))}>Select visible</button><button type="button" onClick={() => setSelected([])}>Clear</button></div><div className="product-pick-list">{visibleProducts.map((p) => <label key={p.id} className={selected.includes(p.id) ? 'is-selected' : ''}><input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} /><span><strong>{p.sku}</strong>{p.name || 'Unnamed product'}</span><em>{p.barcode || 'No barcode'}</em></label>)}</div><Pagination total={filtered.length} pageStart={productPageInfo.pageStart} pageEnd={productPageInfo.pageEnd} currentPage={productPageInfo.currentPage} maxPage={productPageInfo.maxPage} pageSize={productPageSize} onPageChange={setProductPage} onPageSizeChange={setProductPageSize} /></div></div>
      <div className="production-step"><span>3</span><div><strong>Output</strong><div className="segmented"><button type="button" className={format === 'pdf' ? 'is-active' : ''} onClick={() => setFormat('pdf')}>PDF</button><button type="button" className={format === 'png' ? 'is-active' : ''} onClick={() => setFormat('png')}>PNG</button><button type="button" className={format === 'jpeg' ? 'is-active' : ''} onClick={() => setFormat('jpeg')}>JPEG</button></div>{format === 'pdf' ? <><div className="segmented"><button type="button" className={mode === 'sheet' ? 'is-active' : ''} onClick={() => setMode('sheet')}>Sheet layout</button><button type="button" className={mode === 'single' ? 'is-active' : ''} onClick={() => setMode('single')}>One per page</button></div>{mode === 'sheet' ? <><div className="production-grid"><label>Paper<Select value={pageSize} onChange={(e) => setPageSize(e.target.value)}><option>A4</option><option>Letter</option></Select></label><label>Orientation<Select value={orientation} onChange={(e) => setOrientation(e.target.value)}><option>portrait</option><option>landscape</option></Select></label><label>Margin (mm)<Input type="number" value={marginMm} onChange={(e) => setMarginMm(Number(e.target.value))} /></label><label>Gap (mm)<Input type="number" value={gapMm} onChange={(e) => setGapMm(Number(e.target.value))} /></label></div>{sheetFit ? <div className="sheet-fit-note"><strong>{sheetFit.total} labels per page</strong><span>{sheetFit.cols} across × {sheetFit.rows} down</span></div> : null}</> : null}</> : null}<label>Copies per product<Input type="number" min="1" max="100" value={copies} onChange={(e) => setCopies(Number(e.target.value))} /></label><div className="folder-picker"><Button variant="ghost" onClick={pickFolder}>Choose output folder…</Button><span>{outputFolder || 'No folder chosen'}</span></div></div></div>
      <div className="production-actions"><Button variant="primary" onClick={generate} disabled={working || !selected.length}>Generate files</Button><Select value={printer} onChange={(e) => setPrinter(e.target.value)}><option value="">Show printer dialog…</option>{printerRows.map((p) => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}</Select><Button variant="ghost" onClick={print} disabled={working || !selected.length}>Print labels</Button></div>
    </div><aside className="live-preview-card"><div className="live-preview-card__head"><span>Live preview</span><button type="button" onClick={preview}>Refresh</button></div>{previewHtml ? <iframe title="Label preview" srcDoc={previewHtml} /> : <div className="preview-placeholder">Choose a template and product</div>}<div className="live-preview-card__hint">Preview uses the first selected product</div></aside></div>
    <GenerationExperience open={working} title={format === 'pdf' ? 'Making your labels' : 'Rendering label artwork'} progress={progress} phase={phase} detail={detail} />
  </section>;
}
