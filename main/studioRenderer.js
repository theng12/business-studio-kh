const fs = require('node:fs');
const path = require('node:path');
const bwipjs = require('bwip-js');
const { getDataDir } = require('./db');

function fontRoot() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'fonts') : null,
    path.join(process.cwd(), 'assets', 'fonts'),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(dir)) || null;
}

function embeddedFontCss(text) {
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
  const mime = (file) => file.endsWith('.otf') ? 'font/otf' : 'font/ttf';
  return faces.flatMap(([family, regular, bold]) => [[regular, 400], [bold, 700]].map(([file, weight]) => {
    const abs = path.join(root, file); if (!fs.existsSync(abs)) return '';
    return `@font-face{font-family:"${family}";src:url(data:${mime(file)};base64,${fs.readFileSync(abs).toString('base64')}) format("${file.endsWith('.otf') ? 'opentype' : 'truetype'}");font-weight:${weight};font-style:normal}`;
  })).join('');
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

function productValue(product, field) {
  if (!field) return '';
  if (field.startsWith('custom.')) return product.customFields?.[field.slice(7)] ?? '';
  if (field.startsWith('price.')) return product.prices?.[field.slice(6)] ?? '';
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

async function renderLabel(template, product, brand = null) {
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
      const src = assetDataUri(rel);
      parts.push(src ? `<img src="${src}" style="${style};object-fit:${esc(el.fit || 'contain')}"/>` : '');
      continue;
    }
    if (el.type === 'barcode' || el.type === 'qr') {
      const value = el.manualValue || productValue(product, el.field || (el.type === 'qr' ? 'sku' : 'barcode'));
      const src = await barcodeUri(value, el.type === 'qr' ? 'qr' : el.format, el.showText !== false);
      parts.push(src ? `<img src="${src}" style="${style};object-fit:fill"/>` : `<div class="empty-element" style="${style}">No ${el.type} value</div>`);
      continue;
    }
    let value = el.manualValue != null ? el.manualValue : productValue(product, el.field || 'name');
    if (el.type === 'date' && !value) value = new Date().toLocaleDateString('en-CA');
    if (el.type === 'country' && !value) value = product.countryOfOrigin || '';
    value = `${el.prefix || ''}${value ?? ''}${el.suffix || ''}`;
    parts.push(`<div style="${style};display:flex;align-items:${el.verticalAlign === 'top' ? 'flex-start' : el.verticalAlign === 'bottom' ? 'flex-end' : 'center'};justify-content:${el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start'};font-size:${Number(el.fontSize) || 10}pt;font-weight:${Number(el.fontWeight) || 400};font-style:${el.italic ? 'italic' : 'normal'};text-align:${el.align || 'left'};line-height:${Number(el.lineHeight) || 1.15};color:${esc(el.color || '#111827')};overflow:hidden;white-space:${el.wrap === false ? 'nowrap' : 'normal'}">${esc(value)}</div>`);
  }
  return `<section class="label" style="width:${template.widthMm}mm;height:${template.heightMm}mm;background:${esc(template.backgroundColor || '#fff')}">${parts.join('')}</section>`;
}

async function labelsDocument({ template, products, brands = [], layout = {} }) {
  const brandsById = new Map(brands.map((b) => [b.id, b]));
  const labels = await Promise.all(products.map((p) => renderLabel(template, p, brandsById.get(p.brandId))));
  const mode = layout.mode || 'sheet';
  const pageSize = layout.pageSize || 'A4';
  const orientation = layout.orientation || 'portrait';
  const margin = Math.max(0, Number(layout.marginMm) || 8);
  const gap = Math.max(0, Number(layout.gapMm) || 2);
  const copies = Math.max(1, Math.min(100, Number(layout.copies) || 1));
  const repeated = labels.flatMap((html) => Array.from({ length: copies }, () => html));
  const fonts = embeddedFontCss(JSON.stringify({ template, products }));
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
    const value = product.prices?.[config.priceGroup] ?? product.priceRetail ?? '';
    return value === '' ? '' : `${config.currencySymbol || '$'}${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  return productValue(product, key);
}

function buildCatalogHtml({ project, products, brands = [], categories = [], company = null }) {
  const c = project.config || {};
  const fonts = embeddedFontCss(JSON.stringify({ project, products, brands, categories, company }));
  const brandMap = new Map(brands.map((b) => [b.id, b]));
  const categoryMap = new Map(categories.map((x) => [x.id, x]));
  const selected = products.filter((p) => p.status !== 'inactive')
    .filter((p) => !c.productIds?.length || c.productIds.includes(p.id))
    .filter((p) => !c.brandIds?.length || c.brandIds.includes(p.brandId))
    .filter((p) => !c.categoryIds?.length || c.categoryIds.includes(p.categoryId))
    .sort((a, b) => String(c.sortBy === 'name' ? a.name : a.sku).localeCompare(String(c.sortBy === 'name' ? b.name : b.sku), undefined, { numeric: true }));
  const fields = c.fields || [
    { key: 'sku', label: 'SKU', visible: true }, { key: 'name', label: 'Name', visible: true, bold: true },
    { key: 'colorFinish', label: 'Color / Finish', visible: true }, { key: 'price', label: 'Price', visible: true, bold: true },
  ];
  const card = (p) => {
    const image = assetDataUri(p.mainImagePath);
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
  const title = c.cover?.title || project.name;
  const subtitle = c.cover?.subtitle || company?.name || '';
  const cover = c.cover?.enabled === false ? '' : `<section class="cover"><div class="cover-orb"></div><div class="eyebrow">PRODUCT CATALOG</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p><div class="cover-count">${selected.length} products</div></section>`;
  const cols = Math.max(1, Math.min(5, Number(c.columns) || 3));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fonts}@page{size:${c.pageSize || 'A4'} ${c.orientation || 'portrait'};margin:${Number(c.marginMm) || 10}mm}*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"MS Noto Khmer","MS Noto Thai","MS Noto SC","MS Noto JP","MS Noto KR","MS Noto",Arial,sans-serif;color:#162033;-webkit-print-color-adjust:exact;print-color-adjust:exact}.cover{height:calc(100vh - 20mm);position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;padding:22mm;background:linear-gradient(145deg,${esc(c.primaryColor || '#111827')},${esc(c.accentColor || '#6366f1')});color:white;break-after:page}.cover-orb{position:absolute;width:150mm;height:150mm;border-radius:50%;right:-50mm;top:-55mm;background:rgba(255,255,255,.12);filter:blur(1px)}.eyebrow{font-size:9pt;letter-spacing:.22em;font-weight:700;opacity:.75}.cover h1{font-size:38pt;line-height:1.02;margin:6mm 0 3mm;max-width:150mm}.cover p{font-size:14pt;opacity:.78}.cover-count{margin-top:14mm;font-size:9pt;opacity:.65}.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:${Number(c.gapMm) || 5}mm}.card{border:1px solid #e5e7eb;border-radius:${c.theme === 'minimal' ? '0' : '4mm'};overflow:hidden;break-inside:avoid;background:white}.photo{width:100%;aspect-ratio:1;object-fit:contain;background:#f8fafc;display:block}.placeholder{display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:9pt}.card-body{padding:4mm}.brand{font-size:7pt;letter-spacing:.08em;text-transform:uppercase;color:${esc(c.accentColor || '#6366f1')};font-weight:700;margin-bottom:1.5mm}.field{font-size:8.5pt;color:#475569;margin-top:1mm;display:flex;gap:2mm;justify-content:space-between}.field span{color:#94a3b8}.field.bold{font-size:11pt;font-weight:700;color:#111827}.section-title{grid-column:1/-1;font-size:20pt;margin:2mm 0 4mm;color:${esc(c.primaryColor || '#111827')}}
  </style></head><body>${cover}<main class="grid">${cards || '<p>No products match this catalog.</p>'}</main></body></html>`;
}

module.exports = { labelsDocument, buildCatalogHtml, barcodeUri, assetDataUri };
