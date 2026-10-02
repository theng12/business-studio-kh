const fs = require('node:fs');
const path = require('node:path');
const bwipjs = require('bwip-js');
const { priceEntry, formatPriceEntry } = require('./util/prices');
const { formatAmount } = require('./util/currencies');

/* v0.1.25: resolved lazily rather than at module load.
 *
 * `require('./db')` pulls in better-sqlite3, which is compiled for Electron's
 * ABI — so a top-level require here made every module that merely BUILDS HTML
 * unloadable under plain `node --test`. The Social Grid's HTML builder is
 * imported by test/socialGridRenderer.test.js and has no use for a database,
 * so the dependency is deferred until a caller actually resolves an asset
 * path. Same pattern as getAudit() in main/db/products.js. */
let _db = null;
function getDataDir() { return (_db ?? (_db = require('./db'))).getDataDir(); }

function fontRoot() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'fonts') : null,
    path.join(process.cwd(), 'assets', 'fonts'),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(dir)) || null;
}

/* `preview: true` keeps a document light enough to rebuild on every debounced
 * edit: the Latin, Khmer and Thai faces (~2 MB together, cached) are embedded
 * so the preview draws with the same fonts as the print, while the ~17 MB
 * Chinese / Japanese / Korean faces are left to the Mac's own fonts. The
 * owner's call (2026-10-02): previews match print for the small fonts only. */
const LARGE_FACE_FAMILIES = new Set(['MS Noto JP', 'MS Noto KR', 'MS Noto SC']);

function embeddedFontCss(text, { preview = false } = {}) {
  // The control-character range is intentional: this asks "is any character
  // outside plain ASCII?" so we know whether to embed a Unicode font.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(text || '')) return '';
  const root = fontRoot(); if (!root) return '';
  const faces = [
    ['MS Noto', 'NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'],
    ...(/[\u1780-\u17ff]/.test(text) ? [['MS Noto Khmer', 'NotoSansKhmer-Regular.ttf', 'NotoSansKhmer-Bold.ttf']] : []),
    ...(/[\u0e00-\u0e7f]/.test(text) ? [['MS Noto Thai', 'NotoSansThai-Regular.ttf', 'NotoSansThai-Bold.ttf']] : []),
    ...(/[\u3040-\u30ff]/.test(text) ? [['MS Noto JP', 'NotoSansJP-Regular.otf', 'NotoSansJP-Bold.otf']] : []),
    ...(/[\uac00-\ud7af]/.test(text) ? [['MS Noto KR', 'NotoSansKR-Regular.otf', 'NotoSansKR-Bold.otf']] : []),
    ...(/[\u3400-\u9fff]/.test(text) ? [['MS Noto SC', 'NotoSansSC-Regular.otf', 'NotoSansSC-Bold.otf']] : []),
  ];
  return faces.filter(([family]) => !(preview && LARGE_FACE_FAMILIES.has(family)))
    .flatMap(([family, regular, bold]) => [[regular, 400], [bold, 700]]
    .map(([file, weight]) => fontFaceCss(family, path.join(root, file), weight))).join('');
}

/* One `@font-face` rule per (family, file, weight), built once per process.
 *
 * The CJK faces are ~17 MB files each, and every label/catalog/social render
 * and every debounced preview used to read and base64 them again — two CJK
 * scripts meant ~90 MB of file reads and encoding per keystroke. The bundled
 * fonts never change while the app runs, so the finished rule is cached. A
 * missing file is cached as '' too: the font folder ships with the app. */
const fontFaceCache = new Map();

function fontFaceCss(family, abs, weight) {
  const key = `${family}\0${abs}\0${weight}`;
  if (fontFaceCache.has(key)) return fontFaceCache.get(key);
  let css = '';
  if (fs.existsSync(abs)) {
    const otf = abs.endsWith('.otf');
    css = `@font-face{font-family:"${family}";src:url(data:${otf ? 'font/otf' : 'font/ttf'};base64,${fs.readFileSync(abs).toString('base64')}) format("${otf ? 'opentype' : 'truetype'}");font-weight:${weight};font-style:normal}`;
  }
  fontFaceCache.set(key, css);
  return css;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fileDataUri(abs) {
  if (!abs || !fs.existsSync(abs)) return '';
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

function assetDataUri(rel) {
  if (!rel) return '';
  const candidates = [
    path.join(getDataDir(), 'assets', rel),
    path.join(getDataDir(), rel),
    path.isAbsolute(rel) ? rel : '',
  ].filter(Boolean);
  return fileDataUri(candidates.find((p) => fs.existsSync(p)));
}

/* The src for an image in a PREVIEW document — one shown in the app's own
 * window, never handed to the offscreen print/capture window.
 *
 * A catalog preview used to inline every product photo as base64, rebuilt on
 * each edit and structured-cloned over IPC (and over the network in client
 * mode). An `app-image://local/<rel>?v=<stamp>` URL is a few dozen bytes, and
 * the preview iframe (srcdoc, so it shares the renderer's CSP, which allows
 * `img-src app-image:`) loads it through the same protocol the Library uses —
 * on a client Mac that protocol proxies the server, which is where this HTML
 * is built. The stamp follows renderer/lib/imageUrl.js: the file behind a
 * renumbered path can change while the path does not.
 *
 * The protocol serves `<dataDir>/assets/<rel>` (and `processed/` /
 * `ai-gallery/` from the data folder itself), and refuses absolute paths, so
 * anything that is not a plain file under assets/ keeps the data URI. The
 * existence check keeps the "No image" placeholder for a missing file. */
function previewImageSrc(rel, version) {
  if (!rel || path.isAbsolute(rel) || /^(processed|ai-gallery)\//.test(rel) || rel.split(/[\\/]/).includes('..')) {
    return assetDataUri(rel);
  }
  if (!fs.existsSync(path.join(getDataDir(), 'assets', rel))) return assetDataUri(rel);
  const url = `app-image://local/${encodeURIComponent(rel)}`;
  return version == null || version === '' ? url : `${url}?v=${encodeURIComponent(String(version))}`;
}

/* The price source a field key names, or null when it is not a price:
 * `priceRetail` → retail, `priceWholesale` → wholesale, `price.<key>` → that
 * company price group. */
function priceSourceFor(field) {
  if (field === 'priceRetail') return 'retail';
  if (field === 'priceWholesale') return 'wholesale';
  if (typeof field === 'string' && field.startsWith('price.')) return field.slice(6);
  return null;
}

/* A label price is a BARE formatted number — "1,234.50" — and the currency is
 * the template's own text (the element's prefix/suffix). Owner's decision,
 * 2026-10-02: retail used to print raw ("12.5") while a group printed
 * "$1,234.50", so a "$" prefix gave "$$1,234.50" on one and "$12.5" on the
 * other. en-US grouping, with the price's own currency's decimals — two for
 * USD ("1,234.50"), none for riel ("41,000"), the app-wide currency rule. Mirrored for the designer
 * canvas in renderer/modules/LabelStudio/labelFields.js (labelPriceText);
 * test/labelCatalog.test.js keeps the two copies in step. */
function labelPriceAmount(entry) {
  if (!entry || entry.amount == null) return '';
  return formatAmount(entry.amount, entry.currency);
}

function productValue(product, field) {
  if (!field) return '';
  if (field.startsWith('custom.')) return product.customFields?.[field.slice(7)] ?? '';
  // v0.1.55: a group value is { amount, currency } (or a legacy bare number),
  // so every price goes through priceEntry rather than off the column/map.
  const source = priceSourceFor(field);
  if (source) return labelPriceAmount(priceEntry(product, source));
  return product[field] ?? '';
}

async function barcodeUri(value, type = 'code128', includeText = true) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const bcid = type === 'qr' ? 'qrcode' : type === 'ean13' ? 'ean13' :
    type === 'upca' ? 'upca' : type === 'code39' ? 'code39' : 'code128';
  try {
    const bytes = await bwipjs.toBuffer({ bcid, text, scale: 4, height: 12,
      includetext: includeText && bcid !== 'qrcode', textxalign: 'center',
      paddingwidth: 0, paddingheight: 0, backgroundcolor: 'FFFFFF' });
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
}

function elementStyle(el) {
  return [
    'position:absolute', `left:${Number(el.x) || 0}mm`, `top:${Number(el.y) || 0}mm`,
    `width:${Math.max(0.5, Number(el.width) || 10)}mm`, `height:${Math.max(0.5, Number(el.height) || 5)}mm`,
    `transform:rotate(${Number(el.rotation) || 0}deg)`, 'transform-origin:center',
    `z-index:${Number(el.zIndex) || 1}`, el.opacity != null ? `opacity:${el.opacity}` : '',
  ].filter(Boolean).join(';');
}

async function renderLabel(template, product, brand = null, preview = false) {
  const parts = [];
  for (const el of template.elements || []) {
    if (el.visible === false) continue;
    const style = elementStyle(el);
    if (el.type === 'rect' || el.type === 'colorbar' || el.type === 'strip') {
      parts.push(`<div style="${style};background:${esc(el.fill || '#e2e8f0')};border:${Number(el.borderWidth) || 0}px solid ${esc(el.borderColor || '#111827')};border-radius:${Number(el.radius) || 0}px"></div>`);
      continue;
    }
    if (el.type === 'divider') {
      parts.push(`<div style="${style};height:0;border-top:${Math.max(0.25, Number(el.thickness) || 1)}px solid ${esc(el.color || '#111827')}"></div>`);
      continue;
    }
    if (el.type === 'productImage' || el.type === 'logo' || el.type === 'image' || el.type === 'cert') {
      const rel = el.type === 'productImage' ? product.mainImagePath : el.type === 'logo' ? brand?.icon : el.src;
      const stamp = el.type === 'productImage' ? product.updatedAt : el.type === 'logo' ? brand?.updatedAt : null;
      const src = preview ? previewImageSrc(rel, stamp) : assetDataUri(rel);
      parts.push(src ? `<img src="${src}" style="${style};object-fit:${esc(el.fit || 'contain')}"/>` : '');
      continue;
    }
    if (el.type === 'barcode' || el.type === 'qr') {
      const value = el.manualValue || productValue(product, el.field || (el.type === 'qr' ? 'sku' : 'barcode'));
      const src = await barcodeUri(value, el.type === 'qr' ? 'qr' : el.format, el.showText !== false);
      parts.push(src ? `<img src="${src}" style="${style};object-fit:fill"/>` : `<div class="empty-element" style="${style}">No ${el.type} value</div>`);
      continue;
    }
    // A cleared "Manual text" box is '' — that means "use the product field",
    // as its placeholder says and as the designer canvas draws it.
    let value = el.manualValue != null && el.manualValue !== '' ? el.manualValue : productValue(product, el.field || 'name');
    if (el.type === 'date' && !value) value = new Date().toLocaleDateString('en-CA');
    if (el.type === 'country' && !value) value = product.countryOfOrigin || '';
    value = `${el.prefix || ''}${value ?? ''}${el.suffix || ''}`;
    parts.push(`<div style="${style};display:flex;align-items:${el.verticalAlign === 'top' ? 'flex-start' : el.verticalAlign === 'bottom' ? 'flex-end' : 'center'};justify-content:${el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start'};font-size:${Number(el.fontSize) || 10}pt;font-weight:${Number(el.fontWeight) || 400};font-style:${el.italic ? 'italic' : 'normal'};text-align:${el.align || 'left'};line-height:${Number(el.lineHeight) || 1.15};color:${esc(el.color || '#111827')};overflow:hidden;white-space:${el.wrap === false ? 'nowrap' : 'normal'}">${esc(value)}</div>`);
  }
  return `<section class="label" style="width:${template.widthMm}mm;height:${template.heightMm}mm;background:${esc(template.backgroundColor || '#fff')}">${parts.join('')}</section>`;
}

/* `preview: true` — same meaning as for buildCatalogHtml below: shown in the
 * app's own iframe, so app-image URLs and no embedded fonts. */
async function labelsDocument({ template, products, brands = [], layout = {}, preview = false }) {
  const brandsById = new Map(brands.map((b) => [b.id, b]));
  const labels = await Promise.all(products.map((p) => renderLabel(template, p, brandsById.get(p.brandId), preview)));
  const mode = layout.mode || 'sheet';
  const pageSize = layout.pageSize || 'A4';
  const orientation = layout.orientation || 'portrait';
  const margin = Math.max(0, Number(layout.marginMm) || 8);
  const gap = Math.max(0, Number(layout.gapMm) || 2);
  const copies = Math.max(1, Math.min(100, Number(layout.copies) || 1));
  const repeated = labels.flatMap((html) => Array.from({ length: copies }, () => html));
  const fonts = embeddedFontCss(JSON.stringify({ template, products }), { preview });
  const singleSize = `${template.widthMm}mm ${template.heightMm}mm`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${mode === 'single' ? singleSize : `${pageSize} ${orientation}`}; margin: ${mode === 'single' ? '0' : `${margin}mm`}; }
    ${fonts}*{box-sizing:border-box}html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"MS Noto Khmer","MS Noto Thai","MS Noto SC","MS Noto JP","MS Noto KR","MS Noto",Arial,sans-serif;color:#111827;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{display:${mode === 'single' ? 'block' : 'grid'};grid-template-columns:repeat(auto-fill,${template.widthMm}mm);grid-auto-rows:${template.heightMm}mm;gap:${gap}mm;align-content:start}
    .label{position:relative;overflow:hidden;break-inside:avoid;page-break-inside:avoid}.empty-element{border:1px dashed #cbd5e1;color:#94a3b8;font-size:7pt;display:flex;align-items:center;justify-content:center}
    ${mode === 'single' ? '.label{break-after:page}.label:last-child{break-after:auto}' : ''}
  </style></head><body>${repeated.join('')}</body></html>`;
}

function catalogValue(product, key, config) {
  if (key === 'price') {
    // `config.priceGroup` selects the source: retail / wholesale / a named
    // group. Each product's own currency wins; `config.currencySymbol` is only
    // the fallback for rows written before per-field currencies existed.
    const source = config.priceGroup || 'retail';
    const entry = priceEntry(product, source);
    // Match the old behaviour for the real columns: group/wholesale fall back
    // to retail when empty (a blank cell used to print an empty string, and
    // retail was the documented fallback for the wholesale template).
    if (entry.amount == null && source !== 'retail') {
      return formatPriceEntry(priceEntry(product, 'retail'), config.currencySymbol || '$');
    }
    return formatPriceEntry(entry, config.currencySymbol || '$');
  }
  // A catalog card prints a price WITH its currency (the catalog has no
  // per-field prefix/suffix; its own "Currency fallback" setting covers rows
  // without a currency). So a retail / wholesale / group card field formats
  // exactly like the main "Price" row, rather than as the label's bare number.
  const source = priceSourceFor(key);
  if (source) return formatPriceEntry(priceEntry(product, source), config.currencySymbol || '$');
  return productValue(product, key);
}

/* `preview: true` is for a document shown in the app's own preview iframe:
 * photos become app-image URLs (see previewImageSrc) and the embedded fonts
 * are left out. The renderer's CSP has no `font-src`, so `default-src 'self'`
 * already blocks a data: font inside that srcdoc iframe — measured: the
 * face reports status "error" and Chromium logs the CSP refusal — and the
 * preview has always drawn its text with the Mac's own fonts. Building and
 * cloning tens of MB of font CSS that is then refused bought nothing. The
 * PDF export renders in an offscreen window with no such CSP and keeps both. */
function buildCatalogHtml({ project, products, brands = [], categories = [], company = null }, { preview = false } = {}) {
  const c = project.config || {};
  const brandMap = new Map(brands.map((b) => [b.id, b]));
  const categoryMap = new Map(categories.map((x) => [x.id, x]));
  const explicitSelection = c.selectionMode === 'explicit';
  const manualOrder = new Map((c.productIds || []).map((id, index) => [id, index]));
  const selected = products.filter((p) => p.status !== 'inactive')
    .filter((p) => explicitSelection ? c.productIds?.includes(p.id) : (!c.productIds?.length || c.productIds.includes(p.id)))
    .filter((p) => !c.brandIds?.length || c.brandIds.includes(p.brandId))
    .filter((p) => !c.categoryIds?.length || c.categoryIds.includes(p.categoryId))
    .sort((a, b) => c.sortBy === 'manual'
      ? (manualOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (manualOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      : String(c.sortBy === 'name' ? a.name : a.sku).localeCompare(String(c.sortBy === 'name' ? b.name : b.sku), undefined, { numeric: true }));
  // Script detection reads only what this document renders: the selected
  // products, not the whole catalog handed in (a template preview passes every
  // product and renders nine).
  const fonts = embeddedFontCss(JSON.stringify({ project, products: selected, brands, categories, company }), { preview });
  const fields = c.fields || [
    { key: 'sku', label: 'SKU', visible: true }, { key: 'name', label: 'Name', visible: true, bold: true },
    { key: 'colorFinish', label: 'Color / Finish', visible: true }, { key: 'price', label: 'Price', visible: true, bold: true },
  ];
  const card = (p) => {
    const image = preview ? previewImageSrc(p.mainImagePath, p.updatedAt) : assetDataUri(p.mainImagePath);
    const rows = fields.filter((f) => f.visible !== false).map((f) => {
      const value = catalogValue(p, f.key, c);
      return value === '' || value == null ? '' : `<div class="field ${f.bold ? 'bold' : ''}">${f.showLabel === false ? '' : `<span>${esc(f.label || f.key)}</span>`}${esc(value)}</div>`;
    }).join('');
    const brand = brandMap.get(p.brandId);
    return `<article class="card">${image ? `<img class="photo" src="${image}">` : '<div class="photo placeholder">No image</div>'}<div class="card-body">${brand ? `<div class="brand">${esc(brand.name)}</div>` : ''}${rows}</div></article>`;
  };
  let cards = selected.map(card).join('');
  if (c.groupBy === 'brand' || c.groupBy === 'category') {
    const groups = new Map();
    for (const product of selected) {
      const entity = c.groupBy === 'brand' ? brandMap.get(product.brandId) : categoryMap.get(product.categoryId);
      const name = entity?.name || (c.groupBy === 'brand' ? 'Other brands' : 'Uncategorized');
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(product);
    }
    cards = Array.from(groups.entries()).map(([name, rows]) => `<h2 class="section-title">${esc(name)}</h2>${rows.map(card).join('')}`).join('');
  }
  /* The cover is `height:100vh`. Measured in Electron's printToPDF (A4, 20 mm
   * margins): in print, 100vh is the page's CONTENT box — 257 mm fits on one
   * page, 258 mm spills onto a second — so the margins are already taken out.
   * The old `calc(100vh - 20mm)` subtracted them a second time and left the
   * cover 20 mm short of the page at every margin setting. */
  const title = c.cover?.title || project.name;
  const subtitle = c.cover?.subtitle || company?.name || '';
  const cover = c.cover?.enabled === false ? '' : `<section class="cover"><div class="cover-orb"></div><div class="eyebrow">PRODUCT CATALOG</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p><div class="cover-count">${selected.length} ${selected.length === 1 ? 'product' : 'products'}</div></section>`;
  const cols = Math.max(1, Math.min(5, Number(c.columns) || 3));
  const marginMm = Math.max(0, Number(c.marginMm) || 10);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fonts}@page{size:${c.pageSize || 'A4'} ${c.orientation || 'portrait'};margin:${marginMm}mm}*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"MS Noto Khmer","MS Noto Thai","MS Noto SC","MS Noto JP","MS Noto KR","MS Noto",Arial,sans-serif;color:#162033;-webkit-print-color-adjust:exact;print-color-adjust:exact}.cover{height:100vh;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;padding:22mm;background:linear-gradient(145deg,${esc(c.primaryColor || '#111827')},${esc(c.accentColor || '#6366f1')});color:white;break-after:page}.cover-orb{position:absolute;width:150mm;height:150mm;border-radius:50%;right:-50mm;top:-55mm;background:rgba(255,255,255,.12);filter:blur(1px)}.eyebrow{font-size:9pt;letter-spacing:.22em;font-weight:700;opacity:.75}.cover h1{font-size:38pt;line-height:1.02;margin:6mm 0 3mm;max-width:150mm}.cover p{font-size:14pt;opacity:.78}.cover-count{margin-top:14mm;font-size:9pt;opacity:.65}.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:${Number(c.gapMm) || 5}mm}.card{border:1px solid #e5e7eb;border-radius:${c.theme === 'minimal' ? '0' : '4mm'};overflow:hidden;break-inside:avoid;background:white}.photo{width:100%;aspect-ratio:1;object-fit:contain;background:#f8fafc;display:block}.placeholder{display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:9pt}.card-body{padding:4mm}.brand{font-size:7pt;letter-spacing:.08em;text-transform:uppercase;color:${esc(c.accentColor || '#6366f1')};font-weight:700;margin-bottom:1.5mm}.field{font-size:8.5pt;color:#475569;margin-top:1mm;display:flex;gap:2mm;justify-content:space-between}.field span{color:#94a3b8}.field.bold{font-size:11pt;font-weight:700;color:#111827}.section-title{grid-column:1/-1;font-size:20pt;margin:2mm 0 4mm;color:${esc(c.primaryColor || '#111827')};break-after:avoid;page-break-after:avoid;break-inside:avoid;page-break-inside:avoid}
  </style></head><body>${cover}<main class="grid">${cards || '<p>No products have been added to this catalog yet.</p>'}</main></body></html>`;
}

/* v0.1.25: `embeddedFontCss` and `esc` are exported for socialGridRenderer.js.
 * A square social post must render its text in the SAME fonts a catalog does —
 * including the Khmer/Thai/JP/SC fallbacks — and the offscreen render window
 * cannot reach `assets/fonts` on its own, so the font CSS has to be inlined.
 * Re-exporting beats copying: one place decides which scripts get embedded. */
module.exports = { labelsDocument, buildCatalogHtml, barcodeUri, assetDataUri, embeddedFontCss, esc, labelPriceAmount, productValue };
