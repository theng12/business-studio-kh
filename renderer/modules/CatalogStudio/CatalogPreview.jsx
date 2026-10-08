import { useEffect, useRef, useState } from 'react';
import { Button, Select } from '../../components/ui.jsx';
import { catalogPaper, paginatePreviewDocument } from './previewLayout.js';
import { applyPreviewFonts } from './previewFonts.js';

function scrollSheet(sheet) {
  if (!sheet) return;
  const win = sheet.ownerDocument.defaultView;
  win.scrollTo({ top: sheet.getBoundingClientRect().top + win.scrollY, left: 0 });
}

export function CatalogPreview({ preview, onRefresh, config = {}, state = 'idle', error = '', title = 'Catalog preview', fontsKey = '' }) {
  const frame = useRef(null); const sheets = useRef([]); const firstProduct = useRef(0);
  const loadSeq = useRef(0); const [count, setCount] = useState(0); const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState('page'); const [oversized, setOversized] = useState(false);
  const pageRef = useRef(0); pageRef.current = page;
  const fitRef = useRef(null);
  fitRef.current = () => {
    const el = frame.current; const doc = el?.contentDocument; if (!doc?.body) return;
    const width = catalogPaper(config).width * 96 / 25.4 + 32;
    const widthScale = Math.max(0.1, (el.clientWidth - 18) / width);
    const heightScale = Math.max(0.1, (el.clientHeight - 16) / (catalogPaper(config).height * 96 / 25.4 + 32));
    doc.body.style.zoom = zoom === 'page' ? Math.min(widthScale, heightScale) : zoom === 'fit' ? widthScale : Number(zoom) / 100;
    scrollSheet(sheets.current[pageRef.current]);
  };
  useEffect(() => {
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fitRef.current?.());
    if (frame.current) observer?.observe(frame.current);
    fitRef.current?.(); return () => observer?.disconnect();
  }, [zoom, preview]);
  useEffect(() => () => { loadSeq.current += 1; }, []);
  async function ready() {
    const seq = ++loadSeq.current; const el = frame.current; const doc = el?.contentDocument;
    if (!doc) return;
    // The fonts arrive once per session, not inside every srcdoc; load them
    // into this frame before measuring, so page breaks use the print faces.
    await applyPreviewFonts(doc, fontsKey);
    await doc.fonts?.ready;
    await Promise.all([...doc.images].map((img) => img.decode?.().catch(() => {}) ?? Promise.resolve()));
    if (seq !== loadSeq.current || frame.current?.contentDocument !== doc) return;
    const result = paginatePreviewDocument(doc, config); sheets.current = result.pages; firstProduct.current = result.firstProduct;
    setCount(result.pages.length); pageRef.current = 0; setPage(0); setOversized(result.oversized); fitRef.current?.();
  }
  function jump(next) {
    const target = Math.max(0, Math.min(count - 1, next)); pageRef.current = target; setPage(target);
    scrollSheet(sheets.current[target]);
  }
  return <main className="catalog-preview" aria-busy={state === 'refreshing'}>
    <div className="catalog-preview__head">
      <span role="status">{state === 'refreshing' ? 'Refreshing preview…' : error ? 'Preview needs attention' : title}</span>
      <Button size="sm" onClick={onRefresh}>Refresh</Button>
    </div>
    <div className="catalog-preview__tools">
      <Button size="sm" disabled={!count || page === 0} onClick={() => jump(page - 1)}>Previous page</Button>
      <Select aria-label="Preview page" value={page} disabled={!count} onChange={(e) => jump(Number(e.target.value))}>
        {Array.from({ length: count }, (_, i) => <option key={i} value={i}>Page {i + 1} of {count}</option>)}
      </Select>
      <Button size="sm" disabled={!count || page === count - 1} onClick={() => jump(page + 1)}>Next page</Button>
      <Button size="sm" disabled={!count} onClick={() => jump(firstProduct.current)}>First product</Button>
      <Select aria-label="Preview zoom" value={zoom} onChange={(e) => setZoom(e.target.value)}>
        <option value="page">Fit page</option><option value="fit">Fit width</option>{[50, 75, 100, 125, 150, 200].map((v) => <option value={v} key={v}>{v}%</option>)}
      </Select>
    </div>
    {error ? <div className="catalog-preview__message" role="alert">{error} <Button size="sm" onClick={onRefresh}>Retry</Button></div> : null}
    {oversized ? <div className="catalog-preview__message" role="status">A row is taller than this paper. Reduce photo height, text size or margins.</div> : null}
    <p className="catalog-preview__note">Screen page breaks are approximate. Check the exported PDF for final pagination.{error ? ' The preview below is from an earlier render.' : ''}</p>
    {preview ? <iframe ref={frame} title={title} srcDoc={preview} onLoad={ready} /> : <div className="preview-placeholder">{error ? 'Preview could not be built.' : 'Building preview…'}</div>}
  </main>;
}
