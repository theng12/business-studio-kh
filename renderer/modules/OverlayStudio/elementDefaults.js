/**
 * Element factory + token constants. Lives in its own file so both the
 * editor and the eventual Phase 3 batch-config dialog can import from the
 * same source of truth.
 */
import { nanoidish } from './nanoidish.js';

export const TOKENS = [
  '{sku}', '{name}', '{brand}', '{barcode}', '{color}',
  '{category}', '{description}', '{price_retail}', '{price_wholesale}',
  '{date}', '{date_short}',
];

export const ANCHORS = [
  ['tl', 'Top left'],   ['tc', 'Top center'],   ['tr', 'Top right'],
  ['lc', 'Center left'],['c',  'Center'],       ['rc', 'Center right'],
  ['bl', 'Bottom left'],['bc', 'Bottom center'],['br', 'Bottom right'],
];

export const BARCODE_FORMATS = [
  { value: 'code128', label: 'Code 128 (alphanumeric)' },
  { value: 'code39',  label: 'Code 39' },
  { value: 'ean13',   label: 'EAN-13 (13 digits)' },
  { value: 'upca',    label: 'UPC-A (12 digits)' },
  { value: 'qrcode',  label: 'QR code' },
];

export const IMAGE_SOURCES = [
  { value: 'brand-icon',        label: "Brand icon (product's brand)" },
  { value: 'product-image:0',   label: 'Product image #1 (main)' },
  { value: 'product-image:1',   label: 'Product image #2' },
  { value: 'product-image:2',   label: 'Product image #3' },
  // 'asset:<path>' handled separately in the inspector — upload flow comes
  // in Phase 4 when we hook the existing asset import path through.
];

export function defaultElement(type) {
  const base = {
    id: `el-${nanoidish()}`,
    type,
    x: 0.5, y: 0.5, anchor: 'c',
    // v0.23.0: rotation in degrees, normalised to (-180, 180]. 0 = upright.
    // Stored on the element so it survives save/load + server-side render.
    // Rotation pivot is the element's visual center (CSS transform-origin
    // 50% 50%) — same in the editor and in the templateRenderer.
    rotation: 0,
    // v0.26.0 (Phase 4): layer flags.
    //   visible: when false, element is greyed out in the editor and
    //     skipped entirely by the server-side renderer (no composite).
    //     Useful for "temporarily hide this to see what's underneath".
    //   locked:  when true, element can't be moved/resized/rotated in
    //     the editor (the body's pointer events still fire so you can
    //     SELECT it, but drag handlers no-op). Inspector fields still
    //     work — locked is a "don't accidentally bump it" guard, not a
    //     "make this read-only" guard.
    visible: true,
    locked: false,
  };
  if (type === 'text') {
    return {
      ...base,
      content: '{sku}',
      font: { family: 'Inter, "Helvetica Neue", Arial, sans-serif', size: 48, weight: 'bold', color: '#111111' },
      align: 'left',
      bg: { color: '#FFFFFF', opacity: 0.9, padding: 12, radius: 6 },
    };
  }
  if (type === 'barcode') {
    return {
      ...base,
      x: 0.95, y: 0.95, anchor: 'br',
      // Code128's natural rendered aspect is roughly 4:1 (bars + human-readable
      // line); a 0.28 × 0.07 box gives that ratio without weird letterboxing.
      // Was 0.28 × 0.10 in v0.10.0 — looked stretched-tall.
      width: 0.28, height: 0.07,
      content: '{sku}',
      format: 'code128',
      showText: true,
      bg: { color: '#FFFFFF', opacity: 1, padding: 12, radius: 6 },
    };
  }
  if (type === 'image') {
    return {
      ...base,
      x: 0.05, y: 0.05, anchor: 'tl',
      width: 0.15, height: 0.15,
      source: 'brand-icon',
      opacity: 1,
    };
  }
  throw new Error(`Unknown element type: ${type}`);
}

/**
 * Compute the on-canvas pixel box for an element given the canvas size
 * in CSS pixels (NOT the design canvas — the editor scales the design
 * canvas to fit the viewport). Mirrors the main-process renderer's
 * `resolveBox` so the editor preview matches the actual render.
 *
 * `previewText` is optional and only used for text-element width
 * estimation when the element doesn't declare an explicit width. Caller
 * passes the token-filled content so the bg pill auto-sizes to fit
 * "BF-R5232-GD" instead of the un-filled "{sku}" string.
 *
 * `designW × designH` is the template's design size: font size and padding
 * are design pixels, shown on screen at `canvasW / designW` — the same factor
 * the export uses for its own output size (templateRenderer designPixelScale).
 *
 * `measureInk(text, el)` is optional: it returns the text's real inked width in
 * those same pixels (the editor measures with a canvas 2D context). The server
 * sizes a text box from the measured ink since the clipped-glyph fix, so the
 * editor's box should too; without a measurer (tests, no DOM) the old ~0.55 em
 * per character estimate is used.
 */
export function elementBox(el, canvasW, canvasH, previewText = null, designW = 2000, designH = 2000, measureInk = null) {
  const explicitW = (el.width  ?? 0) * canvasW;
  const explicitH = (el.height ?? 0) * canvasH;
  // Text fallback: estimate from the actual content + font + padding so a
  // 12-char SKU doesn't get clipped at the bg pill's right edge. The
  // ~0.55em-per-char heuristic matches the main-process renderer's
  // approxTextWidth(); padding * 2 matches the SVG pill's L+R padding so
  // the editor preview = the baked output.
  //
  // v0.1.8: the design→screen scale is `canvasW / designW`, using the
  // template's ACTUAL canvas width. This used to be a hardcoded
  // `canvasW / 2000`, which silently assumed every template was 2000px
  // wide: on a 3000px template the selection outline was computed 50% too
  // large relative to the text, so clicking an element showed a box that
  // did not match what was drawn inside it.
  let fallbackW = explicitW;
  let fallbackH = explicitH;
  if (el.type === 'text') {
    // The renderer never draws below 8 px (renderTextElement).
    const fontSize = Math.max(8, Number(el.font?.size ?? 48));
    const padding = (el.bg?.padding ?? 0);
    const scaleX = designW ? canvasW / designW : 1;
    const scaleY = designH ? canvasH / designH : 1;
    const sample = previewText && previewText.length > 0 ? previewText : (el.content || '');
    // Width = text width (measured ink, else character count × 0.55em) +
    // horizontal padding × 2, in DESIGN px, then scaled to the editor's CSS
    // pixel size. Clamp to a sane
    // minimum so a brand-new empty text element is still grabbable.
    const measured = typeof measureInk === 'function' && sample ? measureInk(sample, el) : null;
    const textWpx = Number.isFinite(measured) && measured > 0 ? measured : sample.length * fontSize * 0.55;
    const designWpx = Math.max(80, textWpx + padding * 2);
    // Height = one line (1.15 em) + padding top and bottom — the renderer's
    // `lineHeight + padding * 2`. This was `max(1.15 em, 1 em + 2 × padding)`,
    // which came out shorter than the render whenever there was padding
    // (120 vs 134 px for a 96 px font with 12 px padding), so a
    // bottom-anchored text sat lower in the export than in the editor.
    const designHpx = fontSize * 1.15 + padding * 2;
    fallbackW = designWpx * scaleX;
    fallbackH = designHpx * scaleY;
  }
  const w = Math.max(20, explicitW || fallbackW);
  const h = Math.max(16, explicitH || fallbackH);
  const ax = (el.x ?? 0) * canvasW;
  const ay = (el.y ?? 0) * canvasH;
  let left, top;
  switch (el.anchor) {
    case 'tr': left = ax - w;     top = ay;         break;
    case 'bl': left = ax;         top = ay - h;     break;
    case 'br': left = ax - w;     top = ay - h;     break;
    case 'tc': left = ax - w / 2; top = ay;         break;
    case 'bc': left = ax - w / 2; top = ay - h;     break;
    case 'lc': left = ax;         top = ay - h / 2; break;
    case 'rc': left = ax - w;     top = ay - h / 2; break;
    case 'c':  left = ax - w / 2; top = ay - h / 2; break;
    case 'tl':
    default:   left = ax;         top = ay;         break;
  }
  // v0.1.54: clamp to the canvas on both ends, exactly like the renderer's
  // resolveBox. Without it the editor drew a corner-anchored element off the
  // left/top edge (negative left) while the exported render pinned it to 0 —
  // the preview and the file disagreed, which read as "the position is wrong".
  const maxLeft = Math.max(0, canvasW - w);
  const maxTop  = Math.max(0, canvasH - h);
  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top:  Math.min(Math.max(0, top),  maxTop),
    width: w,
    height: h,
  };
}
