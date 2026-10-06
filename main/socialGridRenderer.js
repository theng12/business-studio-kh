/**
 * v0.1.25 — Social Grid: the HTML half.
 *
 * Builds ONE square image's worth of markup: a header, a grid of product
 * tiles, and a footer, laid out to fill an exact pixel canvas. The sibling
 * module main/util/socialGridModel.js decides which products appear and in
 * what order; this file only draws them.
 *
 * No electron and no sharp here — this returns a string. main/ipc/socialGrid.js
 * does the capturing. That keeps the markup testable in plain `node --test`.
 */

const { embeddedFontCss, esc } = require('./studioRenderer');
const { slugifyUnicode } = require('./util/slug');
// v0.1.80: resolvePrice and formatPrice were left behind when v0.1.55 moved
// price resolution onto the entry-aware helpers — dead imports, and two of the
// five long-standing lint warnings. The canonical pair is the one kept.
const { resolvePriceEntry, formatPriceWithEntry, describeStock, normalizeConfig } = require('./util/socialGridModel');

/* ── v0.1.81: overlays ───────────────────────────────────────────────
 * Text or image marks drawn over the whole post — a handle, a logo, a faint
 * diagonal "@shop". Everything is inline-styled from the config so a preview
 * preview and export use the same full-size markup; the preview capture is
 * reduced only after rendering (main/ipc/socialGrid.js).
 */
const ANCHOR_CSS = {
  tl: 'left:0;top:0',            tc: 'left:50%;top:0',        tr: 'right:0;top:0',
  cl: 'left:0;top:50%',          cc: 'left:50%;top:50%',      cr: 'right:0;top:50%',
  bl: 'left:0;bottom:0',         bc: 'left:50%;bottom:0',     br: 'right:0;bottom:0',
};
/**
 * The anchor CSS already pins the element's own edge to the canvas edge
 * (`right:0` puts its RIGHT edge there), so only a centred axis needs pulling
 * back by half the element. Getting this wrong shifts a corner mark entirely
 * off the picture — which is exactly what the first version of this did.
 */
function anchorTranslate(anchor, rotation) {
  const v = anchor[0];
  const h = anchor[1];
  const x = h === 'c' ? '-50%' : '0';
  const y = v === 'c' ? '-50%' : '0';
  return `translate(${x}, ${y}) rotate(${rotation}deg)`;
}

function overlayHtml(config, resolveImage) {
  const overlays = config.overlays || [];
  if (!overlays.length) return '';
  // Corner and edge marks hang inside the artwork by half the post padding, so
  // a watermark never sits half off the canvas or on the very trim edge.
  const inset = Math.round(config.padding * 0.5);
  const items = overlays.map((o) => {
    const pos = ANCHOR_CSS[o.anchor] || ANCHOR_CSS.br;
    const centred = o.anchor === 'cc';
    const style = [
      'position:absolute',
      pos,
      centred ? '' : `margin:${inset}px`,
      `opacity:${o.opacity}`,
      // Offsets first so they nudge the anchored position, then the anchor's
      // own alignment, then the rotation about the element's own centre.
      `transform:translate(${o.offsetX}px, ${o.offsetY}px) ${anchorTranslate(o.anchor, o.rotation)}`,
    ].filter(Boolean).join(';');
    if (o.type === 'image') {
      const src = resolveImage(o.src);
      if (!src) return '';
      return `<img class="ov ov--image" alt="" src="${src}" style="${style};width:${o.size}px;height:auto;display:block">`;
    }
    return `<div class="ov ov--text" style="${style};font-size:${o.size}px;font-weight:${o.weight};color:${esc(o.color)};white-space:nowrap;line-height:1.1">${esc(o.text)}</div>`;
  }).filter(Boolean).join('');
  return items ? `<div class="overlay-layer">${items}</div>` : '';
}

/* The render window loads this document from a file:// URL, so anything the
 * page needs — fonts and every product photo — has to be inlined. An
 * app-image:// URL would work in the app's own renderer but NOT in this
 * offscreen window, which is why photos arrive as base64 data URIs through
 * the `resolveImage` callback the caller supplies. */

/** Size the text down when a tile is small, so a 5x5 grid does not print
 *  28px names into a 180px cell. The user's chosen size is the size at a
 *  3-column layout; other densities scale around that. */
function scaleForDensity(config) {
  const base = 3;
  const actual = Math.max(1, config.columns);
  return Math.max(0.55, Math.min(1.6, base / actual));
}

/**
 * v0.1.89: every string this page draws, for font detection. It used to scan
 * only the title, subtitle, footer, names and SKUs — so a Khmer brand name,
 * overlay text, a price or a stock line fell back to whatever the render
 * window had, and Khmer drew as boxes. Builds the same lines tileHtml does.
 */
function renderedText(config, products, brandMap) {
  const bits = [config.title, config.subtitle, config.footer];
  for (const o of config.overlays || []) if (o?.type !== 'image') bits.push(o?.text);
  for (const p of products || []) {
    if (!p) continue;
    bits.push(p.name, p.sku);
    if (config.showBrand) bits.push(brandMap?.get(p.brandId)?.name);
    if (config.showPrice) bits.push(formatPriceWithEntry(resolvePriceEntry(p, config), config));
    if (config.showStock) bits.push(describeStock(p, config));
  }
  return bits.filter(Boolean).map(String).join(' ');
}

function tileHtml(product, config, resolveImage, brandMap, scale) {
  const parts = [];

  if (config.showPhoto) {
    const src = resolveImage(product.mainImagePath);
    parts.push(src
      ? `<div class="photo"><img src="${src}" alt=""></div>`
      : '<div class="photo photo--empty"><span>No image</span></div>');
  }

  const lines = [];
  const brand = config.showBrand ? brandMap?.get(product.brandId) : null;
  if (brand) lines.push(`<div class="brand">${esc(brand.name)}</div>`);
  if (config.showName) lines.push(`<div class="name">${esc(product.name || product.sku || '')}</div>`);
  if (config.showSku && product.sku) lines.push(`<div class="sku">${esc(product.sku)}</div>`);
  if (config.showPrice) {
    // v0.1.55: format with the product's own currency (retail/wholesale/group);
    // `config.currencySymbol` is the fallback for rows without one.
    const price = formatPriceWithEntry(resolvePriceEntry(product, config), config);
    if (price) lines.push(`<div class="price">${esc(price)}</div>`);
  }
  if (config.showStock) {
    const stock = describeStock(product, config);
    if (stock) {
      const qty = product.stockQty == null ? null : Number(product.stockQty);
      const cls = qty != null && qty <= 0 ? 'stock stock--out' : 'stock';
      lines.push(`<div class="${cls}">${esc(stock)}</div>`);
    }
  }

  if (lines.length) parts.push(`<div class="meta">${lines.join('')}</div>`);
  return `<article class="tile">${parts.join('')}</article>`;
}

/**
 * One image.
 *
 * `ctx` = { products, brands, config, pageIndex, pageCount, resolveImage }
 * `pageCount` > 1 adds a "2 / 5" marker to the footer, because a series of
 * near-identical images is confusing to post without one.
 */
function buildPageHtml(ctx) {
  const config = normalizeConfig(ctx.config);
  const brandMap = ctx.brands instanceof Map ? ctx.brands : new Map((ctx.brands || []).map((b) => [b.id, b]));
  const resolveImage = ctx.resolveImage || (() => '');
  const scale = scaleForDensity(config);

  const total = config.columns * config.rows;
  const products = (ctx.products || []).slice(0, total);
  // Pad the final page with blank cells so every page's tiles are the same
  // size. Without this the last image of a series renders stretched tiles.
  while (products.length < total) products.push(null);

  const tiles = products.map((p) => (p
    ? tileHtml(p, config, resolveImage, brandMap, scale)
    : '<article class="tile tile--blank"></article>')).join('');

  const headerBits = [];
  if (config.title) headerBits.push(`<h1>${esc(config.title)}</h1>`);
  if (config.subtitle) headerBits.push(`<p>${esc(config.subtitle)}</p>`);
  const header = headerBits.length ? `<header>${headerBits.join('')}</header>` : '';

  const footerBits = [];
  if (config.footer) footerBits.push(`<span>${esc(config.footer)}</span>`);
  const pageCount = Number(ctx.pageCount) || 1;
  if (pageCount > 1) {
    const idx = Math.min(Math.max(1, Number(ctx.pageIndex) + 1 || 1), pageCount);
    footerBits.push(`<span class="pager">${idx} / ${pageCount}</span>`);
  }
  const footer = footerBits.length ? `<footer>${footerBits.join('')}</footer>` : '';

  // Font CSS is only worth embedding for text that actually needs it; an
  // ASCII-only post (the common case) pays nothing.
  const fonts = embeddedFontCss(renderedText(config, products, brandMap));

  const W = config.width;
  const H = config.height;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${esc(config.background)}}
body{font-family:-apple-system,BlinkMacSystemFont,"MS Noto Khmer","MS Noto Thai","MS Noto SC","MS Noto JP","MS Noto KR","MS Noto",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.post{position:relative;width:${W}px;height:${H}px;padding:${config.padding}px;display:flex;flex-direction:column;gap:${config.gap}px;background:${esc(config.background)}}
.overlay-layer{position:absolute;inset:0;pointer-events:none;z-index:5}
.ov{pointer-events:none}
header{flex:none;display:flex;flex-direction:column;gap:${Math.round(config.gap / 2)}px}
header h1{font-size:${config.titleSize}px;font-weight:800;line-height:1.06;letter-spacing:-0.02em;color:#0f172a}
header p{font-size:${config.subtitleSize}px;font-weight:500;color:#64748b}
footer{flex:none;display:flex;align-items:center;justify-content:space-between;font-size:${config.footerSize}px;font-weight:600;color:#64748b}
footer .pager{font-variant-numeric:tabular-nums;color:#94a3b8}
.grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(${config.columns},minmax(0,1fr));grid-template-rows:repeat(${config.rows},minmax(0,1fr));gap:${config.gap}px}
.tile{min-height:0;min-width:0;display:flex;flex-direction:column;background:${esc(config.tileBackground)};border-radius:${config.radius}px;overflow:hidden}
.tile--blank{background:transparent}
.photo{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:${esc(config.tileBackground)}}
.photo img{width:100%;height:100%;object-fit:${config.photoFit === 'cover' ? 'cover' : 'contain'};display:block}
.photo--empty{color:#94a3b8;font-size:${Math.round(16 * scale)}px}
.meta{flex:none;display:flex;flex-direction:column;gap:${Math.max(1, Math.round(3 * scale))}px;padding:${Math.round(12 * scale)}px ${Math.round(14 * scale)}px}
.name{font-size:${Math.round(config.nameSize * scale)}px;font-weight:700;line-height:1.18;color:#0f172a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.brand{font-size:${Math.round(config.metaSize * scale)}px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1}
.sku{font-size:${Math.round(config.metaSize * scale)}px;color:#94a3b8;font-variant-numeric:tabular-nums}
.price{font-size:${Math.round(config.priceSize * scale)}px;font-weight:800;color:#0f172a;font-variant-numeric:tabular-nums}
.stock{font-size:${Math.round(config.metaSize * scale)}px;font-weight:600;color:#059669}
.stock--out{color:#dc2626}
  </style></head><body><div class="post">${header}<main class="grid">${tiles}</main>${footer}${overlayHtml(config, resolveImage)}</div></body></html>`;
}

/** A stable, filesystem-safe base name for the series, e.g. "nike-grid".
 *  v0.1.89: Unicode-aware — a Khmer title names the file in Khmer instead of
 *  collapsing to "social-grid" for every post. */
function seriesSlug(products, config) {
  const raw = config.title || (products?.[0]?.name ?? '') || 'social-grid';
  return slugifyUnicode(String(raw).toLowerCase(), 'social-grid');
}

/**
 * v0.1.89: never overwrite. Returns the series base name to write under: the
 * slug itself when none of its files exist in the folder, otherwise
 * `slug-2`, `slug-3` … — whichever first leaves EVERY page of the series
 * free, so a series is never split across two names. `exists(fileName)` is
 * asked per file name; both export paths (this Mac, and a client Mac writing
 * the server's bytes) call this one rule.
 */
function freeSeriesSlug(slug, pageCount, ext, exists) {
  const clash = (base) => {
    for (let i = 0; i < Math.max(1, pageCount); i += 1) {
      if (exists(fileNameFor(base, i, pageCount, ext))) return true;
    }
    return false;
  };
  if (!clash(slug)) return slug;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!clash(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

/**
 * `name.png`, or `name-01.png … name-12.png` when the selection needs a series.
 *
 * Zero-padded to the width of the page count so that a 12-image set sorts in
 * reading order in Finder (name-02 before name-10). Without the padding a
 * Finder window lists 1, 10, 11, 2, 3 …, which makes a series impossible to
 * post in order.
 */
function fileNameFor(slug, index, pageCount, ext) {
  if (pageCount <= 1) return `${slug}.${ext}`;
  const width = String(pageCount).length;
  return `${slug}-${String(index + 1).padStart(width, '0')}.${ext}`;
}

module.exports = { buildPageHtml, seriesSlug, freeSeriesSlug, scaleForDensity, fileNameFor, overlayHtml, renderedText };
