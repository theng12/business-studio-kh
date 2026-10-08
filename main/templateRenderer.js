/**
 * Overlay Studio renderer. Composites a template's elements onto an input
 * image using Sharp + bwip-js. Returns either bytes (for previews) or
 * writes to disk (for batch runs).
 *
 * Element schema (stored as JSON in image_templates.elements):
 *
 *   {
 *     id: uuid,
 *     type: 'text' | 'barcode' | 'image',
 *     // Position in 0..1 fractions of the template's *design* canvas.
 *     // The renderer rescales for whatever input image we end up
 *     // applying to (typically the processed file's actual dimensions).
 *     x: 0..1, y: 0..1,
 *     // Anchor of (x, y) on the element bounding box. 'tl'/'tr'/'bl'/'br'
 *     // /'tc'/'bc'/'lc'/'rc'/'c'.
 *     anchor: 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc' | 'lc' | 'rc' | 'c',
 *     // Element-specific width/height in fractions. Optional for text
 *     // (font size dominates); required for barcode + image.
 *     width?: 0..1, height?: 0..1,
 *     rotation?: degrees,
 *
 *     // type === 'text'
 *     content: '{sku}' | 'Some literal' | mix,
 *     font: { family, size, weight, italic, color },
 *     align?: 'left' | 'center' | 'right',
 *     bg?:   { color, opacity, padding, radius },
 *
 *     // type === 'barcode'
 *     content: '{sku}' | '{barcode}' | literal,
 *     format: 'code128' | 'code39' | 'ean13' | 'upca' | 'qrcode',
 *     showText?: boolean,
 *     bg?: { color, opacity, padding, radius },
 *
 *     // type === 'image'
 *     source: 'brand-icon' | 'product-image:0..N' | 'asset:<relativePath>',
 *     opacity?: 0..1,
 *   }
 *
 * Tokens supported in text/barcode content: {sku} {name} {brand}
 * {barcode} {color} {category} {description} {price_retail}
 * {price_wholesale} {date} {date_short}, plus {price_<group key>} for each
 * price group the active company defines (v0.1.78).
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
require('./util/sharpLimits');   // process-wide libvips cache cap (perf audit 2026-10)
const bwipjs = require('bwip-js');
const { getDataDir } = require('./db');
const { slugify } = require('./util/slug');
const { reframeImage } = require('./util/reframe');

/* ── Token fill ─────────────────────────────────────────────────── */

function fmtDate(d, short = false) {
  if (!(d instanceof Date)) d = new Date();
  if (short) return d.toISOString().slice(0, 10);
  return d.toLocaleDateString();
}

/**
 * Tokens an element's text may contain. `{price_<key>}` resolves a company
 * price group by its key (v0.1.78) — `{price_vip}` for a group keyed `vip` —
 * and prints the bare amount, the same as `{price_retail}` and
 * `{price_wholesale}`: every price token in this renderer means "the number",
 * and the currency is the template's own text.
 *
 * A token naming a group the company does not have is LEFT ALONE rather than
 * blanked, so a typo shows up as `{price_vip}` on the image instead of a
 * silently empty space.
 *
 * The Overlay Studio editor draws its own preview and carries a mirror of this
 * function (renderer/modules/OverlayStudio/EditorCanvas.jsx); the two are kept
 * in step by test/overlayTokens.test.js.
 */
function fillTokens(template, ctx = {}) {
  if (template == null) return '';
  return String(template)
    .replace(/\{sku\}/gi,             ctx.sku ?? '')
    .replace(/\{name\}/gi,            ctx.name ?? '')
    .replace(/\{brand\}/gi,           ctx.brand ?? '')
    .replace(/\{barcode\}/gi,         ctx.barcode ?? '')
    .replace(/\{color\}/gi,           ctx.colorFinish ?? ctx.color ?? '')
    .replace(/\{category\}/gi,        ctx.category ?? '')
    .replace(/\{description\}/gi,     ctx.description ?? '')
    .replace(/\{price_retail\}/gi,    ctx.priceRetail != null ? String(ctx.priceRetail) : '')
    .replace(/\{price_wholesale\}/gi, ctx.priceWholesale != null ? String(ctx.priceWholesale) : '')
    .replace(/\{price_([a-z0-9_-]+)\}/gi, (match, key) => {
      const known = ctx.prices && Object.prototype.hasOwnProperty.call(ctx.prices, String(key).toLowerCase());
      return known ? String(ctx.prices[String(key).toLowerCase()] ?? '') : match;
      // The value is the bare amount, exactly like {price_retail} and
      // {price_wholesale} above: a price token has always meant "the number,
      // and you write the currency yourself". v0.1.79 — a formatted group
      // price next to a raw retail price on the same image was the
      // inconsistency the owner spotted.
    })
    .replace(/\{date\}/gi,            fmtDate(ctx.date))
    .replace(/\{date_short\}/gi,      fmtDate(ctx.date, true));
}

/* ── Geometry helpers ───────────────────────────────────────────── */

/**
 * Resolve an element's pixel-space box given the input image dimensions.
 * Returns `{ left, top, width, height }` clamped to the image. We anchor
 * the box using the element's `anchor` corner so designers think in
 * "place this corner at this point" rather than always top-left.
 */
function resolveBox(el, imgW, imgH) {
  const w = Math.max(1, Math.round((el.width ?? 0) * imgW));
  const h = Math.max(1, Math.round((el.height ?? 0) * imgH));
  const ax = Math.round((el.x ?? 0) * imgW);
  const ay = Math.round((el.y ?? 0) * imgH);
  let left;
  let top;
  switch (el.anchor) {
    case 'tr': left = ax - w;       top = ay;            break;
    case 'bl': left = ax;           top = ay - h;        break;
    case 'br': left = ax - w;       top = ay - h;        break;
    case 'tc': left = ax - w / 2;   top = ay;            break;
    case 'bc': left = ax - w / 2;   top = ay - h;        break;
    case 'lc': left = ax;           top = ay - h / 2;    break;
    case 'rc': left = ax - w;       top = ay - h / 2;    break;
    case 'c':  left = ax - w / 2;   top = ay - h / 2;    break;
    case 'tl':
    default:   left = ax;           top = ay;            break;
  }
  // v0.1.54: clamp the BOX to the canvas on BOTH ends. This used to clamp only
  // the minimum, so an element could hang off the right/bottom edge in the
  // export while the editor still drew it off the left/top — the preview and
  // the rendered file disagreed near the edges, asymmetrically. The editor's
  // drag already keeps the box on-canvas; this makes the renderer agree.
  const maxLeft = Math.max(0, imgW - w);
  const maxTop  = Math.max(0, imgH - h);
  return {
    left: Math.min(Math.max(0, Math.round(left)), maxLeft),
    top:  Math.min(Math.max(0, Math.round(top)),  maxTop),
    width:  w,
    height: h,
  };
}

/* ── Output canvas (template shape) ─────────────────────────────── */

/**
 * Below this relative difference a photo counts as "already the template's
 * shape" and is used as-is — a 2000×2001 photo on a 2000×2000 template should
 * not gain a 1-pixel white band.
 */
const LETTERBOX_TOLERANCE = 0.005;

/**
 * The size of the picture an overlay is composed onto, at FULL resolution.
 *
 * Owner decision (2026-10-02): the output takes the TEMPLATE's shape. When a
 * template has a design size whose aspect differs from the photo, the photo is
 * letterboxed into that aspect on white — `contain`, never cropped, never
 * squashed — and every element is placed against that canvas, which is exactly
 * what the editor shows (a template-shaped canvas with the photo contained in
 * it — the backdrop <img> is `object-fit: contain` on the canvas's white).
 *
 * The canvas keeps the photo's own pixel density: it is the smallest rectangle
 * of the template's aspect that holds the photo at 1:1, so the photo is never
 * shrunk. With the bulk inset on, the canvas is the design size itself (that is
 * what reframeImage has always produced). A template with no design size (an
 * inline legacy shape) keeps the old rule: the photo's own size.
 *
 * `canvas: 'photo'` opts out of all of that (owner decision 2026-10-02): the
 * "Watermark external photos" tool keeps every photo's own size and shape —
 * no bands, no inset — and only adds the artwork. Product overlays use the
 * default, `'template'`.
 *
 * @returns {{ width:number, height:number, mode:'inset'|'letterbox'|'photo' }}
 */
function outputCanvasSize(template, photoW, photoH, canvas = 'template') {
  const tW = Number(template?.canvasWidth);
  const tH = Number(template?.canvasHeight);
  if (canvas === 'photo') {
    return {
      width: Math.max(1, Math.round(Number(photoW) || 0)),
      height: Math.max(1, Math.round(Number(photoH) || 0)),
      mode: 'photo',
    };
  }
  if (template?.inset?.enabled) {
    return {
      width: Math.max(16, Math.round(tW || 2000)),
      height: Math.max(16, Math.round(tH || 2000)),
      mode: 'inset',
    };
  }
  const pW = Math.max(1, Math.round(Number(photoW) || 0));
  const pH = Math.max(1, Math.round(Number(photoH) || 0));
  if (!(tW > 0 && tH > 0)) return { width: pW, height: pH, mode: 'photo' };
  const want = tW / tH;
  const have = pW / pH;
  if (Math.abs(have / want - 1) <= LETTERBOX_TOLERANCE) return { width: pW, height: pH, mode: 'photo' };
  if (have > want) return { width: pW, height: Math.max(pH, Math.round(pW / want)), mode: 'letterbox' };
  return { width: Math.max(pW, Math.round(pH * want)), height: pH, mode: 'letterbox' };
}

/**
 * How big one DESIGN pixel is on this canvas.
 *
 * Owner decision (2026-10-02): font size, padding, radius and every other
 * pixel-sized property are pixels of the template's DESIGN canvas, so a
 * template looks the same on every photo whatever its resolution — exactly as
 * laid out in the editor, which draws them at `canvasW / designW` too
 * (elementDefaults.js elementBox, EditorCanvas ElementContent). A 96 px font on
 * a 2000 px design is 4.8% of the width on a 800 px photo and on a 4000 px one.
 *
 * On a template-shaped canvas both axes give the same factor. On a canvas of
 * another shape (`canvas: 'photo'`, the external watermark) the smaller one is
 * used — the template contained in the photo — so text cannot outgrow the
 * picture's short side.
 *
 * A legacy template with no design size keeps the old meaning, pixels of the
 * full-size output: `fallback` (1 for an export, the preview's own scale for a
 * preview).
 */
function designPixelScale(template, imgW, imgH, fallback = 1) {
  const dW = Number(template?.canvasWidth);
  const dH = Number(template?.canvasHeight);
  if (!(dW > 0 && dH > 0)) return fallback;
  return Math.min(imgW / dW, imgH / dH);
}

/* ── Element → SVG/PNG buffer ───────────────────────────────────── */

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/** Rough text width (~0.55 em per character). Only a fallback now — used
 *  when the real ink measurement finds nothing (whitespace-only content). */
function approxTextWidth(text, fontSize) {
  return Math.ceil(String(text).length * fontSize * 0.55);
}

/**
 * Measure where a line of text actually puts ink, horizontally.
 *
 * The bg pill / element width used to come from approxTextWidth (0.55 em per
 * character). Bold and wide faces run well past that — "SKU-12345" at 96 px
 * bold inks ~505 px against a 476 px estimate — so the SVG was narrower than
 * the text and the last glyph was cut off at the right edge. Rendering the line
 * once on a generous canvas and reading back the alpha columns gives the real
 * extent, in the same renderer (librsvg / pango) that draws the final element.
 *
 * Returns `{ left, right }` in px relative to the text origin (left may be
 * negative for a glyph with a negative side bearing), or null when nothing
 * inked. The final render places the origin on a whole pixel, as this one does,
 * so the ink lands exactly where it was measured.
 */
/**
 * librsvg refuses a canvas wider than 32767 px, and a refused text element used
 * to vanish from the picture without a word (300 characters at 96 px bold, or a
 * long `{description}`). Every SVG this file draws for text stays under this.
 */
const MAX_TEXT_SVG_PX = 16000;

async function measureTextInk(content, attrs, fontSize) {
  const len = Math.max(1, String(content).length);
  const needed = Math.ceil(len * fontSize * 1.3) + Math.ceil(fontSize) * 2;
  if (needed > MAX_TEXT_SVG_PX) {
    // Too long to measure at size: measure at a smaller size that fits and
    // scale the extent back up (text width is linear in font size, to within
    // hinting — a pixel or two on a line this long).
    const f = MAX_TEXT_SVG_PX / needed;
    const small = Math.max(1, fontSize * f);
    const ink = await measureTextInk(content, attrs.replace(/font-size="[^"]*"/, `font-size="${small}"`), small);
    if (!ink) return null;
    const k = fontSize / small;
    return { left: Math.floor(ink.left * k), right: Math.ceil(ink.right * k) };
  }
  const margin = Math.ceil(fontSize);
  const h = Math.ceil(fontSize * 1.8);
  const baseline = Math.round(fontSize * 1.2);
  let w = needed;
  for (let attempt = 0; attempt < 3 && w <= MAX_TEXT_SVG_PX * 2; attempt += 1) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
      + `<text x="${margin}" y="${baseline}" ${attrs} fill="#000">${escapeXml(content)}</text></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const stride = info.width * info.channels;
    const colHasInk = (x) => {
      for (let y = 0, i = x * info.channels + 3; y < info.height; y += 1, i += stride) {
        if (data[i] > 0) return true;
      }
      return false;
    };
    let x0 = 0;
    while (x0 < info.width && !colHasInk(x0)) x0 += 1;
    if (x0 >= info.width) return null;
    let x1 = info.width - 1;
    while (x1 > x0 && !colHasInk(x1)) x1 -= 1;
    // Ink touching either edge means the canvas was too small — widen, retry.
    if (x0 > 0 && x1 < info.width - 1) return { left: x0 - margin, right: x1 + 1 - margin };
    w *= 2;
  }
  return null;
}

/**
 * @param {number} px — the size of one design pixel on this canvas (see
 *   designPixelScale). A 96 px font is drawn at 96 × px, so it keeps the same
 *   share of the picture on any photo and at any preview size.
 */
const KHMER_RE = /[\u1780-\u17FF\u19E0-\u19FF]/;
/** One text line's height in em: 1.45 for any Khmer, 1.15 otherwise. */
function overlayLineEm(text) {
  return KHMER_RE.test(String(text ?? '')) ? 1.45 : 1.15;
}

async function renderTextElement(el, ctx, imgW, imgH, px = 1) {
  const content = fillTokens(el.content ?? '', ctx);
  if (!content) return null;
  const fontSize = Math.max(1, Math.round(Math.max(8, Number(el.font?.size ?? 48)) * px));
  const fontFamily = el.font?.family ?? 'Inter, "Helvetica Neue", Arial, sans-serif';
  const fontWeight = el.font?.weight ?? 'normal';
  const fontStyle  = el.font?.italic ? 'italic' : 'normal';
  const color = el.font?.color ?? '#000';
  const padding = Math.round((el.bg?.padding ?? 0) * px);
  const radius  = Math.round((el.bg?.radius  ?? 0) * px);
  const bgColor = el.bg?.color ?? null;
  const bgOpacity = el.bg?.opacity ?? 1;
  // v0.1.5: element-level opacity, clamped. Applies to the WHOLE element
  // (text + caption band), not the band alone — the editor canvas does the
  // same via a CSS `opacity` on the element wrapper, so exports match.
  const elOpacity = Math.max(0, Math.min(1, Number(el.opacity ?? 1)));
  const attrs = `font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="${escapeXml(String(fontWeight))}" font-style="${fontStyle}"`;

  // Width: caller can constrain via el.width (fraction of image). Otherwise
  // the MEASURED ink width + padding, so the last glyph is never cut.
  const ink = await measureTextInk(content, attrs, fontSize);
  const inkW = ink ? ink.right - ink.left : approxTextWidth(content, fontSize);
  const inkLeft = ink ? ink.left : 0;
  const explicitW  = el.width ? Math.round(el.width * imgW) : null;
  const w = Math.max(1, explicitW ?? (inkW + padding * 2));
  // 1.45 em when the text has Khmer (stacked subscripts and below-vowels were
  // clipped by the 1.15 em box), 1.15 em otherwise. The extra height is split
  // above and below, so the baseline moves down by half of it. Mirrored in
  // renderer/modules/OverlayStudio/elementDefaults.js (`overlayLineEm`).
  const lineEm = overlayLineEm(content);
  const lineHeight = Math.round(fontSize * lineEm);
  const h = lineHeight + padding * 2;
  const extraTop = Math.round((lineHeight - Math.round(fontSize * 1.15)) / 2);

  // Place the INK (not the pen origin) in the box: flush left at the padding,
  // centred, or flush right at the padding. Whole-pixel origin so the glyphs
  // rasterise exactly as they did when measured.
  const align = el.align ?? 'left';
  const inkStart = align === 'center' ? (w - inkW) / 2
    : align === 'right' ? w - padding - inkW
      : padding;
  const originX = Math.round(inkStart - inkLeft);
  const textY = padding + extraTop + Math.round(fontSize * 0.85);   // baseline approx

  // Text wider than an explicit box still shows in full: the buffer grows past
  // the box and `offsetX` tells compose() where the box starts inside it. (The
  // editor draws the overflow too — its text node is not clipped.)
  // Capped (MAX_TEXT_SVG_PX): beyond that the text is clipped, never dropped.
  // Nothing past ~16000 px from the box could be on a photo anyway.
  const extraL = Math.min(MAX_TEXT_SVG_PX, Math.max(0, -(originX + inkLeft)));
  const extraR = Math.max(0, originX + inkLeft + inkW - w);
  const svgW = Math.min(MAX_TEXT_SVG_PX, w + extraL + extraR);

  const bg = bgColor
    ? `<rect x="${extraL}" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="${escapeXml(bgColor)}" fill-opacity="${bgOpacity}" />`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${h}" viewBox="0 0 ${svgW} ${h}">
    <g fill-opacity="${escapeXml(String(elOpacity))}">
    ${bg}
    <text x="${originX + extraL}" y="${textY}" ${attrs} fill="${escapeXml(color)}">${escapeXml(content)}</text>
    </g>
  </svg>`;

  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buf, naturalWidth: w, naturalHeight: h, offsetX: extraL, offsetY: 0 };
}

/**
 * v0.26.4: barcode rendering — bars only via bwip-js, human-readable
 * text rendered separately as SVG-text below. Mirrors the editor
 * preview in EditorCanvas.jsx so what you see in Overlay Studio is
 * what the exported image gets.
 *
 * Old behaviour: bwip-js's includetext rendered text INSIDE the SVG
 * at fixed positions in its natural coordinate system. When we then
 * stretched the SVG to the target box size with `fit: 'contain'`,
 * the SVG letterboxed (height inspector value had no visible effect)
 * AND for EAN-13 the rightmost digits visually overlapped the right
 * guard bars. Both fixed by separating bars from text.
 *
 * Numbers below the bars follow the standard's expected grouping
 * (formatBarcodeText in barcodePreview.js): EAN-13 = "8 395100 802107",
 * UPC-A = "0 39510 08021 7", EAN-8 = "1234 5678".
 */
function formatBarcodeHumanText(content, format) {
  const s = String(content ?? '').trim();
  if (!s) return '';
  if (format === 'ean13' && /^\d{13}$/.test(s)) {
    return `${s[0]} ${s.slice(1, 7)} ${s.slice(7)}`;
  }
  if (format === 'upca' && /^\d{12}$/.test(s)) {
    return `${s[0]} ${s.slice(1, 6)} ${s.slice(6, 11)} ${s[11]}`;
  }
  if (format === 'ean8' && /^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)} ${s.slice(4)}`;
  }
  return s;
}

/** Two-dimensional symbols: these have a fixed shape and are never stretched. */
const TWO_D_BARCODES = new Set(['qrcode']);

async function renderBarcodeElement(el, ctx, imgW, imgH, px = 1) {
  const content = fillTokens(el.content ?? '', ctx).trim();
  if (!content) return null;
  const bcid = {
    code128: 'code128',
    code39:  'code39',
    ean13:   'ean13',
    upca:    'upca',
    qrcode:  'qrcode',
  }[el.format] ?? 'code128';

  const boxW = Math.max(Math.round(64 * px), Math.round((el.width ?? 0.25) * imgW));
  const boxH = Math.max(Math.round(32 * px), Math.round((el.height ?? 0.08) * imgH));

  // The background pill (when there is one) IS the element's box, and the
  // symbol sits inside it by the padding — the editor has always drawn it that
  // way (border-box). The pill used to be the box PLUS the padding, so it
  // spilled past the outline the editor showed.
  const padding = Math.round((el.bg?.padding ?? 0) * px);
  const radius  = Math.round((el.bg?.radius  ?? 0) * px);
  const bgColor = el.bg?.color ?? null;
  const bgOpacity = el.bg?.opacity ?? 1;
  const inset = bgColor ? padding : 0;
  const targetW = Math.max(1, boxW - inset * 2);
  const targetH = Math.max(1, boxH - inset * 2);

  const showText = el.showText !== false && bcid !== 'qrcode';
  // Bars take ~78% of vertical space when text is shown; text takes
  // ~22%. Same ratio as the editor preview so what-you-see matches.
  const barsH = showText ? Math.round(targetH * 0.78) : targetH;
  const textH = Math.max(0, targetH - barsH);

  // Render bars-only with bwip-js. `includetext: false` skips the
  // bottom digits; we draw them ourselves below.
  let barsPng;
  try {
    barsPng = await bwipjs.toBuffer({
      bcid,
      text: content,
      scale: 3,                 // hi-res raster; resized down with Sharp
      // A bar height is a 1-D idea; given to a QR code it stretches the
      // symbol out of square, so 2-D codes keep bwip's own (square) shape.
      ...(TWO_D_BARCODES.has(bcid) ? {} : { height: Math.max(8, Math.round(barsH / 4)) }),
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0,
      backgroundcolor: 'FFFFFF',
    });
  } catch (err) {
    throw new Error(`Barcode "${content}" couldn't be encoded as ${bcid}: ${err.message}`, { cause: err });
  }

  // A 1-D barcode fills the box: scaled uniformly across (SCANNERS only care
  // about relative bar widths, which a uniform horizontal scale keeps), with
  // whatever bar height the box gives it — the editor draws the same. A QR code
  // has a fixed square shape, so it is CONTAINED in the box on the white plate
  // instead of being squashed into it (barcodePreview.js does the same).
  const resizedBars = await sharp(barsPng)
    .resize(targetW, barsH, TWO_D_BARCODES.has(bcid)
      ? { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }
      : { fit: 'fill' })
    .png()
    .toBuffer();

  // v0.1.5: element opacity — see renderTextElement. The opaque white
  // scanner-contrast background is deliberately NOT faded; only the bars
  // and digits are, matching the editor where the white plate stays solid.
  const elOpacity = Math.max(0, Math.min(1, Number(el.opacity ?? 1)));

  // Compose bars + text on a transparent canvas of the target size.
  const layers = [{ input: resizedBars, left: 0, top: 0 }];
  const showDigits = showText && textH >= 8 * px;
  if (showDigits) {
    const humanText = formatBarcodeHumanText(content, bcid);
    // Scale font size to the allocated text height — 70% of the slot
    // gives a readable label without crowding the bars above.
    const fontPx = Math.max(Math.round(8 * px), Math.round(textH * 0.7));
    // Letter-spacing for readability of grouped digits.
    const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${targetW}" height="${textH}">
      <text x="${targetW / 2}" y="${textH * 0.78}"
        text-anchor="middle"
        font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="${fontPx}"
        font-variant-numeric="tabular-nums"
        letter-spacing="${Math.round(fontPx * 0.04)}"
        fill="#000">${escapeXml(humanText)}</text>
    </svg>`;
    const textBuf = await sharp(Buffer.from(textSvg)).png().toBuffer();
    layers.push({ input: textBuf, left: 0, top: barsH });
  }

  // Underlying white background — barcodes need a light background
  // for scanner contrast even when the surrounding element bg is off.
  const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${targetW}" height="${targetH}">
    <rect width="${targetW}" height="${targetH}" fill="#ffffff" />
  </svg>`;
  let barcodeCard = await sharp(Buffer.from(baseSvg))
    .composite(layers)
    .png()
    .toBuffer();

  // Fade bars + digits together, after they're flattened onto the plate, so
  // the plate's white stays fully opaque. `dest-in` with a uniform grey
  // multiplies the layer alpha by the grey level.
  if (elOpacity < 1) {
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${targetW}" height="${targetH}">` +
      `<rect x="0" y="0" width="${targetW}" height="${barsH + (showDigits ? textH : 0)}" ` +
      `fill="#000" fill-opacity="${elOpacity}"/></svg>`,
    );
    barcodeCard = await sharp(barcodeCard)
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  }

  if (!bgColor) {
    return { buf: barcodeCard, naturalWidth: targetW, naturalHeight: targetH };
  }

  // Compose on a bg pill the size of the element's box, card inset by padding.
  const pillW = boxW;
  const pillH = boxH;
  const pillSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${pillH}">
    <rect x="0" y="0" width="${pillW}" height="${pillH}" rx="${radius}" ry="${radius}" fill="${escapeXml(bgColor)}" fill-opacity="${bgOpacity}" />
  </svg>`;
  const composed = await sharp(Buffer.from(pillSvg))
    .composite([{ input: barcodeCard, left: padding, top: padding }])
    .png()
    .toBuffer();
  return { buf: composed, naturalWidth: pillW, naturalHeight: pillH };
}

/**
 * Where an element's asset actually lives, given its data-folder-relative path.
 *
 * v0.1.19: this is a parameter rather than a hard-coded `path.join(getDataDir(),
 * 'assets', rel)` for two reasons.
 *
 *   1. It makes composition work without a LOCAL data folder. A client Mac has
 *      none — its data is on the server — so it can now supply a resolver that
 *      fetches the asset from the server instead. See
 *      main/client/index.js → makeAssetResolver.
 *   2. It makes `getDataDir()` lazy. It used to be called at the top of
 *      renderImageElement for EVERY image element, even one whose source was an
 *      inline/absolute path that never needed the data folder — and on a client
 *      that call throws "Data dir not set". Now it is only reached when a
 *      data-folder asset is genuinely being resolved.
 *
 * The default keeps the previous behaviour exactly, so every existing caller is
 * unaffected.
 */
function defaultResolveAsset(rel) {
  return path.join(getDataDir(), 'assets', rel);
}

/**
 * v0.1.71: the CSS object-fit values the editor can set on an image element.
 * `contain` is the default and matches this renderer's resize; `cover` crops
 * to fill the box. Mirrored by renderer/modules/OverlayStudio/overlayFit.js so
 * the editor and the export cannot drift (test/overlayArtworkFit.test.js pins
 * the pair).
 */
const IMAGE_FITS = ['contain', 'cover', 'fill'];
function sharpFitForImageElement(el) {
  return IMAGE_FITS.includes(el?.fit) ? el.fit : 'contain';
}

async function renderImageElement(el, ctx, imgW, imgH, resolveAsset, strictImageAssets = false, px = 1) {
  if (!el.source) return null;

  // Work out which data-folder asset this element refers to (if any), then let
  // the caller turn that into a readable absolute path.
  let rel = null;
  if (el.source === 'brand-icon') {
    if (ctx.brandIcon) rel = ctx.brandIcon;
  } else if (el.source.startsWith('product-image:')) {
    const idx = Number(el.source.split(':')[1] ?? 0);
    rel = ctx.productImages?.[idx]?.filepath ?? null;
  } else if (el.source.startsWith('asset:')) {
    const r = el.source.slice('asset:'.length);
    if (r && !path.isAbsolute(r)) rel = r;
  }
  if (!rel) return null;

  const abs = await resolveAsset(rel);
  if (!abs || !fs.existsSync(abs)) {
    if (strictImageAssets) throw new Error(`Required overlay artwork not found: ${rel}`);
    return null;
  }

  const targetW = Math.max(Math.round(16 * px), Math.round((el.width  ?? 0.15) * imgW));
  const targetH = Math.max(Math.round(16 * px), Math.round((el.height ?? 0.15) * imgH));
  const opacity = Math.max(0, Math.min(1, el.opacity ?? 1));

  let pipeline = sharp(abs).resize(targetW, targetH, { fit: sharpFitForImageElement(el), background: { r: 0, g: 0, b: 0, alpha: 0 } });
  if (opacity < 1) {
    /* v0.1.53: the mask MUST be `opacity`, not `1 - opacity`.
     *
     * `dest-in` keeps the destination in proportion to the source's ALPHA, so
     * a black rect at `fill-opacity: X` multiplies the image's alpha by X.
     * Using `1 - opacity` inverted the control: 0% rendered fully opaque
     * (the mask was solid), 80% rendered at 20% alpha, and 100% skipped this
     * branch entirely and rendered fully opaque — so the slider felt backwards
     * and only 100% looked right. The text and barcode paths already mask with
     * the opacity value directly; this brings the image element in line. */
    pipeline = pipeline.composite([{
      input: Buffer.from(
        `<svg width="${targetW}" height="${targetH}"><rect width="100%" height="100%" fill="black" fill-opacity="${opacity}"/></svg>`,
      ),
      blend: 'dest-in',
    }]);
  }
  const buf = await pipeline.png().toBuffer();
  return { buf, naturalWidth: targetW, naturalHeight: targetH };
}

/* ── Top-level compose ──────────────────────────────────────────── */

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 255, g: 255, b: 255, alpha: 0 };

/**
 * Build the picture the elements are composed onto: `outW × outH`, in the
 * template's shape (see outputCanvasSize). Returns `{ input, raw }` — `raw` is
 * the raw-pixel description when `input` is an uncompressed pixel buffer
 * (letterbox, preview, blank), null when it is something sharp can open as is.
 * Raw, not PNG: encoding a 6000×6000 letterboxed photo to PNG only to decode it
 * again for the composite was most of the export time.
 *
 *   - inset    — reframeImage at the (possibly scaled) design size, as before.
 *   - letterbox — the photo, scaled by `s`, centred; the bands are white, or
 *                transparent when the photo itself has an alpha channel (a
 *                cut-out product on transparency must not come out sitting in
 *                an opaque white box; a JPG output flattens to white anyway).
 *   - photo    — the photo itself; untouched at full size (s = 1), so an export
 *                whose photo already has the template's shape is the same
 *                input it always was.
 *   - no photo — a white canvas of the design size.
 */
async function buildBase({ inputImage, template, full, photoW, photoH, hasAlpha, s, outW, outH }) {
  if (inputImage == null) {
    return {
      input: Buffer.alloc(outW * outH * 4, 255),
      raw: { width: outW, height: outH, channels: 4 },
    };
  }
  if (full.mode === 'inset') {
    const inset = template.inset;
    try {
      const input = await reframeImage({
        inputImage,
        canvasW: s === 1 ? (template.canvasWidth || 2000) : outW,
        canvasH: s === 1 ? (template.canvasHeight || 2000) : outH,
        scale: Math.max(0.3, Math.min(1, Number(inset.scale ?? 0.85))),
        fillMode: inset.fillMode === 'blur' ? 'blur' : 'color',
        fillColor: inset.fillColor || '#FFFFFF',
        // The blur radius is in pixels too, so a downscaled preview blurs by
        // the same share of the picture.
        ...(s === 1 ? {} : { blurSigma: Math.max(0.3, 28 * s) }),
      });
      return { input, raw: null };
    } catch (err) {
      // Inset is an enhancement — if it fails, fall back to the plain
      // template-shaped canvas rather than aborting the whole overlay render.
      process.stderr.write(`[overlay] inset failed, using the plain photo: ${err.message}\n`);
      const fb = outputCanvasSize({ canvasWidth: template.canvasWidth || 2000, canvasHeight: template.canvasHeight || 2000 }, photoW, photoH);
      const fs2 = outW / fb.width;
      return buildBase({
        inputImage, template, full: fb, photoW, photoH, hasAlpha, s: fs2, outW, outH: Math.max(1, Math.round(fb.height * fs2)),
      });
    }
  }
  if (full.mode === 'letterbox') {
    const pw = Math.min(outW, Math.max(1, Math.round(photoW * s)));
    const ph = Math.min(outH, Math.max(1, Math.round(photoH * s)));
    const left = Math.floor((outW - pw) / 2);
    const top = Math.floor((outH - ph) / 2);
    let pipe = sharp(inputImage, { failOn: 'none' });
    if (pw !== photoW || ph !== photoH) pipe = pipe.resize(pw, ph, { fit: 'fill' });
    const { data, info } = await pipe
      .extend({
        left, right: outW - pw - left, top, bottom: outH - ph - top,
        background: hasAlpha ? CLEAR : WHITE,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { input: data, raw: { width: info.width, height: info.height, channels: info.channels } };
  }
  if (s === 1) return { input: inputImage, raw: null };
  const { data, info } = await sharp(inputImage, { failOn: 'none' })
    .resize(outW, outH, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { input: data, raw: { width: info.width, height: info.height, channels: info.channels } };
}

/* Perf audit 2026-10: every debounced editor preview decoded and resized the
 * full-size photo again (~400 ms each). A preview base depends only on the
 * photo file and the preview geometry, so the last few are kept in memory,
 * keyed by path + size + mtime (a re-saved photo misses) and the geometry.
 * Previews only (s < 1): an export always reads the file. Small on purpose —
 * a 900 px RGBA base is ~3 MB; 8 of them stay well under 30 MB. */
const PREVIEW_BASE_CACHE_MAX = 8;
const previewBaseCache = new Map();
function previewBaseKey(inputImage, args) {
  if (typeof inputImage !== 'string') return null;
  let st;
  try { st = fs.statSync(inputImage); } catch { return null; }
  const { template, full, s, outW, outH } = args;
  return JSON.stringify([inputImage, st.size, st.mtimeMs, full.mode, full.width, full.height, s, outW, outH,
    template?.canvasWidth, template?.canvasHeight, full.mode === 'inset' ? template?.inset : null]);
}
async function cachedPreviewBase(args) {
  const key = args.s < 1 ? previewBaseKey(args.inputImage, args) : null;
  if (!key) return buildBase(args);
  if (previewBaseCache.has(key)) {
    const hit = previewBaseCache.get(key);
    previewBaseCache.delete(key); previewBaseCache.set(key, hit);   // most recent last
    return hit;
  }
  const base = await buildBase(args);
  previewBaseCache.set(key, base);
  while (previewBaseCache.size > PREVIEW_BASE_CACHE_MAX) previewBaseCache.delete(previewBaseCache.keys().next().value);
  return base;
}

/** Open a base from buildBase with sharp. */
function openBase(base) {
  return base.raw ? sharp(base.input, { raw: base.raw }) : sharp(base.input, { failOn: 'none' });
}

/**
 * Where a rendered element's buffer goes. `box` is the element's box on the
 * canvas; the buffer may be larger than the box (text overflowing an explicit
 * width), with the box starting at (offsetX, offsetY) inside it. Rotation turns
 * about the BOX centre, like the editor's CSS `transform-origin: 50% 50%`.
 */
async function placeRendered(el, rendered, box) {
  const offX = rendered.offsetX || 0;
  const offY = rendered.offsetY || 0;
  let composite = { input: rendered.buf, left: box.left - offX, top: box.top - offY };
  // v0.23.0: apply rotation if non-zero. sharp.rotate() expands the
  // output canvas to fit the rotated content (so a 100×100 square
  // rotated 45° becomes ~142×142). We compensate by shifting the
  // composite anchor so the element's CENTER stays at the same
  // canvas position the editor previews.
  const rot = Number(el.rotation ?? 0);
  if (Number.isFinite(rot) && Math.abs(rot) > 0.01) {
    try {
      const rotatedBuf = await sharp(rendered.buf, { failOn: 'none' })
        .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      const rotMeta = await sharp(rotatedBuf).metadata();
      const srcMeta = (offX || offY) ? await sharp(rendered.buf).metadata() : null;
      const oldW = srcMeta?.width ?? box.width;
      const oldH = srcMeta?.height ?? box.height;
      const newW = rotMeta.width ?? oldW;
      const newH = rotMeta.height ?? oldH;
      if (!srcMeta) {
        composite = {
          input: rotatedBuf,
          left: Math.round(box.left - (newW - oldW) / 2),
          top:  Math.round(box.top  - (newH - oldH) / 2),
        };
      } else {
        // The buffer's centre is off the box's centre by (dx, dy); after the
        // turn that offset is turned too.
        const dx = oldW / 2 - offX - box.width / 2;
        const dy = oldH / 2 - offY - box.height / 2;
        const t = rot * Math.PI / 180;
        const cx = box.left + box.width / 2 + dx * Math.cos(t) - dy * Math.sin(t);
        const cy = box.top + box.height / 2 + dx * Math.sin(t) + dy * Math.cos(t);
        composite = { input: rotatedBuf, left: Math.round(cx - newW / 2), top: Math.round(cy - newH / 2) };
      }
    } catch (err) {
      process.stderr.write(`[overlay] element ${el.id ?? '?'} rotate(${rot}) failed: ${err.message}\n`);
      // Fall through with the unrotated composite — better to ship a
      // wrong-orientation render than a blank one.
    }
  }
  return composite;
}

/**
 * sharp refuses to composite a layer larger than the base ("must have same
 * dimensions or smaller") even when most of it would land off-canvas. Crop such
 * a layer to the part that is on the canvas; leave everything else untouched.
 */
async function fitLayerToCanvas(composite, W, H) {
  const meta = await sharp(composite.input).metadata();
  const lw = meta.width ?? 0;
  const lh = meta.height ?? 0;
  if (lw <= W && lh <= H) return composite;
  const x0 = Math.max(0, -composite.left);
  const y0 = Math.max(0, -composite.top);
  const x1 = Math.min(lw, W - composite.left);
  const y1 = Math.min(lh, H - composite.top);
  if (x1 <= x0 || y1 <= y0) return null;
  const input = await sharp(composite.input)
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .png()
    .toBuffer();
  return { input, left: composite.left + x0, top: composite.top + y0 };
}

/**
 * Compose a template onto a photo and report the geometry used.
 *
 * @param {object} args
 * @param {Buffer | string | null} args.inputImage — bytes, an absolute path, or
 *   null for "no photo" (a white canvas of the design size).
 * @param {object} args.template — { canvasWidth, canvasHeight, inset, elements }
 * @param {object} args.context  — { sku, name, brand, brandIcon, ... }
 * @param {Function} [args.resolveAsset] — (relPath) => absolute path | null.
 *   Turns a data-folder-relative asset path into something readable. Defaults
 *   to the local data folder; a client Mac passes a resolver that pulls the
 *   asset from the server instead. See defaultResolveAsset above.
 * @param {boolean} [args.strictImageAssets=false] — fail when a configured
 *   image asset cannot be resolved/rendered. External-file batches use this
 *   so required artwork cannot be silently omitted.
 * @param {number} [args.maxPx] — preview only: cap the OUTPUT's longest side.
 *   The whole composition is drawn at that scale — the photo AND every
 *   pixel-sized measurement (font size, padding, radius, minimum sizes) — so
 *   the preview is the export, smaller. Omit it (every export does) and
 *   nothing is scaled.
 * @param {'template'|'photo'} [args.canvas='template'] — `'template'`: the
 *   output takes the template's shape (letterbox / inset, see
 *   outputCanvasSize). `'photo'`: keep the photo's own size and shape and only
 *   add the elements — the external watermark tool.
 * @returns {Promise<{ bytes: Buffer, width: number, height: number,
 *   fullWidth: number, fullHeight: number, pxScale: number, mode: string }>}
 *   `fullWidth × fullHeight` is the size the export of this photo has.
 */
async function composeDetailed({
  inputImage,
  template,
  context = {},
  resolveAsset = defaultResolveAsset,
  strictImageAssets = false,
  maxPx = null,
  canvas = 'template',
  // Preview only: an opaque result may come back as JPEG (`mime` says which)
  // — a 0.6–2.3 MB PNG per debounced edit was most of the preview's time.
  previewJpeg = false,
}) {
  if (!template || !Array.isArray(template.elements)) {
    throw new Error('Template missing or has no elements');
  }

  // The photo's own size, then the full-resolution canvas it becomes.
  let photoW;
  let photoH;
  let hasAlpha = false;
  if (inputImage == null) {
    photoW = Math.max(16, Math.round(Number(template.canvasWidth) || 2000));
    photoH = Math.max(16, Math.round(Number(template.canvasHeight) || 2000));
  } else {
    const meta = await sharp(inputImage, { failOn: 'none' }).metadata();
    photoW = meta.width ?? template.canvasWidth ?? 2000;
    photoH = meta.height ?? template.canvasHeight ?? 2000;
    hasAlpha = !!meta.hasAlpha;
  }
  // v0.27.0: with the inset on, reframeImage shrinks the photo to a fill % of
  // the design canvas and fills the margin, so the elements always get a safe
  // zone. Otherwise the photo is letterboxed into the template's shape.
  const full = outputCanvasSize(template, photoW, photoH, canvas === 'photo' ? 'photo' : 'template');

  // Preview scale. 1 for every export.
  const cap = Number(maxPx);
  const s = Number.isFinite(cap) && cap > 0
    ? Math.min(1, cap / Math.max(full.width, full.height))
    : 1;
  const outW = s === 1 ? full.width : Math.max(1, Math.round(full.width * s));
  const outH = s === 1 ? full.height : Math.max(1, Math.round(full.height * s));

  const base = await cachedPreviewBase({ inputImage, template, full, photoW, photoH, hasAlpha, s, outW, outH });
  // Read the base's real size rather than trusting the arithmetic (reframe
  // rounds on its own).
  const baseMeta = base.raw ?? await openBase(base).metadata();
  const imgW = baseMeta.width ?? outW;
  const imgH = baseMeta.height ?? outH;
  // Pixel-sized measurements are design pixels (legacy: output pixels).
  const px = designPixelScale(template, imgW, imgH, s === 1 ? 1 : imgW / full.width);

  const composites = [];
  for (const el of template.elements) {
    // v0.26.0: respect the visible flag. `false` = explicitly hidden;
    // both `true` and undefined (legacy templates) render normally.
    if (el.visible === false) continue;
    let rendered = null;
    try {
      if (el.type === 'text')    rendered = await renderTextElement(el, context, imgW, imgH, px);
      else if (el.type === 'barcode') rendered = await renderBarcodeElement(el, context, imgW, imgH, px);
      else if (el.type === 'image')   rendered = await renderImageElement(
        el, context, imgW, imgH, resolveAsset, strictImageAssets, px,
      );
    } catch (err) {
      if (strictImageAssets && el.type === 'image') throw err;
      // Per-element failure shouldn't kill the whole composite — surface
      // through stderr so the runner can capture it in batch results.
      process.stderr.write(`[overlay] element ${el.id ?? '?'} (${el.type}) failed: ${err.message}\n`);
      continue;
    }
    if (!rendered) continue;
    // Use the rendered buffer's *actual* dimensions for the anchor math,
    // but place using the element's declared box. Most elements declare a
    // width/height, but text often doesn't — fall back to natural.
    const box = resolveBox(
      { ...el, width: el.width ?? rendered.naturalWidth / imgW, height: el.height ?? rendered.naturalHeight / imgH },
      imgW,
      imgH,
    );
    const layer = await fitLayerToCanvas(await placeRendered(el, rendered, box), imgW, imgH);
    if (layer) composites.push(layer);
  }

  // A JPEG preview only when nothing in it can be transparent: a real photo
  // without alpha (the blank canvas is white, an inset fills its margin).
  const asJpeg = previewJpeg && s < 1 && !hasAlpha;
  const pipeline = composites.length === 0 ? openBase(base) : openBase(base).composite(composites);
  const bytes = asJpeg
    ? await pipeline.flatten({ background: WHITE }).jpeg({ quality: 88 }).toBuffer()
    // Nothing rendered — return the (possibly reframed) base unchanged,
    // still as PNG so the caller has a uniform output format.
    : composites.length === 0
      ? await pipeline.png().toBuffer()
      : await pipeline.png({ compressionLevel: 7 }).toBuffer();
  return {
    bytes,
    mime: asJpeg ? 'image/jpeg' : 'image/png',
    width: imgW,
    height: imgH,
    fullWidth: full.width,
    fullHeight: full.height,
    pxScale: px,
    mode: inputImage == null ? 'blank' : full.mode,
  };
}

/**
 * Compose a template onto a photo. PNG bytes — see composeDetailed for the
 * arguments and for the template-shape rule.
 * @returns {Promise<Buffer>}
 */
async function compose(args) {
  return (await composeDetailed(args)).bytes;
}

/* ── Output path helper ─────────────────────────────────────────── */

/**
 * Where overlay outputs live on disk:
 *   <dataDir>/overlays/<template-slug>/<sku>/<filename>--<template-slug>.png
 * Separate root from `processed/` so overlay-baked variants never collide
 * with the bare processed file.
 */
function outputPathFor(template, productSku, originalFilename) {
  const templateSlug = slugify(template.name, 'template');
  const safeSku = slugify(productSku, 'unknown');
  const base = originalFilename
    ? originalFilename.replace(/\.[^.]+$/, '')
    : 'image';
  const dir = path.join(getDataDir(), 'overlays', templateSlug, safeSku);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${base}--${templateSlug}.png`;
  return {
    absolute: path.join(dir, filename),
    relative: `overlays/${templateSlug}/${safeSku}/${filename}`,
  };
}

module.exports = {
  defaultResolveAsset, compose, composeDetailed, fillTokens, outputPathFor, outputCanvasSize, designPixelScale,
  // Exported for tests: the editor's elementBox mirrors this, and a parity
  // test is the only thing that keeps the two from drifting apart.
  resolveBox, overlayLineEm };
