export function catalogPaper(config = {}) {
  let [width, height] = config.pageSize === 'Letter' ? [215.9, 279.4] : [210, 297];
  if (config.orientation === 'landscape') [width, height] = [height, width];
  const raw = Number(config.marginMm ?? 10);
  return { width, height, margin: Number.isFinite(raw) ? Math.max(0, Math.min(60, raw)) : 10 };
}

export function packCatalogRows(rows, height, gap) {
  const pages = []; let page = []; let used = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const needed = row.height + (row.heading && rows[i + 1] ? gap + rows[i + 1].height : 0);
    if (page.length && used + gap + needed > height) { pages.push(page); page = []; used = 0; }
    used += (page.length ? gap : 0) + row.height; page.push(row);
  }
  if (page.length) pages.push(page);
  return pages;
}

// Screen sheets reuse the print renderer's cards. Chromium print fragmentation
// can differ: the exported PDF remains the authoritative pagination.
export function paginatePreviewDocument(doc, config = {}) {
  const paper = catalogPaper(config); const mm = 96 / 25.4;
  const grid = doc.querySelector('main.grid'); if (!grid) return { pages: [], firstProduct: 0, oversized: false };
  const body = doc.body; const cover = body.querySelector('.cover');
  // margin auto: at "Fit page" (and any zoom narrower than the frame) the
  // sheets sit in the middle of the preview, not against its left edge.
  body.style.cssText = `margin:0 auto;padding:16px;background:#e8e8eb;width:${paper.width * mm + 32}px;`;
  if (doc.documentElement?.style) doc.documentElement.style.background = '#e8e8eb';
  grid.style.width = `${(paper.width - 2 * paper.margin) * mm}px`;
  const children = [...grid.children]; const columns = config.layoutMode === 'list' ? 1 : Math.max(1, Math.min(5, Number(config.columns) || 3));
  const gap = Math.max(0, Number(config.gapMm ?? 5)) * mm;
  const top = Math.max(paper.margin, config.headerText ? 10 : 0);
  const bottom = Math.max(paper.margin, config.footerText || config.pageNumbers ? 10 : 0);
  const contentHeight = (paper.height - top - bottom) * mm;
  const rows = []; let row = [];
  const flush = () => { if (row.length) { rows.push({ nodes: row, height: Math.max(...row.map((n) => n.getBoundingClientRect().height)) }); row = []; } };
  for (const node of children) {
    if (node.classList.contains('section-title') || node.classList.contains('empty')) {
      flush(); const style = doc.defaultView.getComputedStyle(node);
      rows.push({ nodes: [node], height: node.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0), heading: node.classList.contains('section-title') });
    } else { row.push(node); if (row.length === columns) flush(); }
  }
  flush();
  const pages = []; body.replaceChildren();
  const sheet = () => {
    const page = doc.createElement('section'); page.className = 'catalog-screen-sheet';
    page.style.cssText = `width:${paper.width}mm;min-height:${paper.height}mm;padding:${top}mm ${paper.margin}mm ${bottom}mm;background:white;margin-bottom:16px;position:relative;box-shadow:0 2px 6px #0002;`;
    body.append(page); pages.push(page); return page;
  };
  const decorate = (page, content) => {
    if (config.headerText) { const h = doc.createElement('header'); h.textContent = config.headerText; h.style.cssText = 'position:absolute;top:2mm;left:4mm;right:4mm;font-size:9pt;overflow-wrap:anywhere'; page.append(h); }
    page.append(content);
    if (config.footerText || config.pageNumbers) {
      const f = doc.createElement('footer'); f.textContent = [config.footerText, config.pageNumbers ? `Page ${pages.length}` : ''].filter(Boolean).join(' · ');
      f.style.cssText = 'position:absolute;bottom:2mm;left:4mm;right:4mm;font-size:9pt;overflow-wrap:anywhere'; page.append(f);
    }
  };
  if (cover) { const p = sheet(); cover.style.height = `${contentHeight}px`; decorate(p, cover); }
  const firstProduct = pages.length;
  for (const packed of packCatalogRows(rows, contentHeight, gap)) {
    const p = sheet(); const next = grid.cloneNode(false); next.style.width = '100%'; next.style.minHeight = `${contentHeight}px`;
    for (const r of packed) for (const node of r.nodes) next.append(node);
    decorate(p, next);
  }
  return { pages, firstProduct, oversized: rows.some((r) => r.height > contentHeight) };
}
