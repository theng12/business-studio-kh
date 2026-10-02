/**
 * Overlay Studio: the preview must be the export, smaller — and both must take
 * the template's shape.
 *
 * What these pin (each was a real report: "the preview looks different from
 * the applied result", "the photo doesn't fit the template shape", "the QR is
 * squashed", "the last letter is cut off"):
 *
 *   1. A downscaled preview (compose with `maxPx`) draws text at the SAME share
 *      of the picture as the full-size export. The preview used to shrink the
 *      photo and then draw a 96 px font at 96 px, i.e. twice as large.
 *   2. The output takes the template's shape: a photo of another aspect is
 *      letterboxed into it on opaque white, at the photo's own pixel density.
 *      Legacy templates with no design size keep the photo's own size.
 *   3. A QR code keeps its square shape in a non-square box.
 *   4. Text is never clipped at the right: the element is as wide as the ink.
 *   5. The editor drops out-of-order preview replies (sequence guard).
 *   6. The editor's mirror of the template-shape rule agrees with the server's.
 *   7. The editor draws its own text at the canvas scale (not raw pixels).
 *
 * Pure: compose() runs on synthetic images, the db module is stubbed for
 * getDataDir() like the other overlay tests. No Electron, no database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

require.cache[require.resolve('../main/db')] = {
  exports: { getDataDir: () => path.join('/tmp', 'msk-overlay-preview-test-data') },
};

const templateRenderer = require('../main/templateRenderer');
const ROOT = path.join(__dirname, '..');
const overlayCanvas = import('../renderer/modules/OverlayStudio/overlayCanvas.js');
const elementDefaults = import('../renderer/modules/OverlayStudio/elementDefaults.js');

/** A photo: grey field, so any yellow / black / white we look for is ours. */
async function photo(w, h, color = '#9aa4b0') {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
}

async function raw(buf) {
  return sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

/** Bounding box of the pixels `match(r, g, b, a)` accepts, or null. */
async function bbox(buf, match) {
  const { data, info } = await raw(buf);
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 4;
      if (match(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, imgW: info.width, imgH: info.height };
}

const isYellow = (r, g, b) => r > 230 && g > 210 && b < 90;
const isDark = (r, g, b) => r < 80 && g < 80 && b < 80;

function pillTemplate(cw, ch, extra = {}) {
  return {
    canvasWidth: cw,
    canvasHeight: ch,
    elements: [{
      id: 't', type: 'text', x: 0.05, y: 0.05, anchor: 'tl',
      content: '{sku}',
      font: { family: 'Helvetica, Arial, sans-serif', size: 96, weight: 'bold', color: '#000000' },
      bg: { color: '#ffeb3b', padding: 12 },
      ...extra,
    }],
  };
}

/* ── 1. preview = export, smaller ───────────────────────────────────── */

test('a downscaled preview draws text at the same share of the picture as the export', async () => {
  for (const [pw, ph, cw, ch] of [[1600, 1600, 2000, 2000], [1600, 1200, 1080, 1350], [1200, 1600, 2000, 2000]]) {
    const input = await photo(pw, ph);
    const template = pillTemplate(cw, ch);
    const ctx = { sku: 'SKU-12345' };
    const full = await templateRenderer.composeDetailed({ inputImage: input, template, context: ctx });
    const exportBox = await bbox(full.bytes, isYellow);
    for (const maxPx of [400, 800, 1200]) {
      const prev = await templateRenderer.composeDetailed({ inputImage: input, template, context: ctx, maxPx });
      assert.ok(Math.max(prev.width, prev.height) <= maxPx, `preview ${prev.width}x${prev.height} exceeds ${maxPx}`);
      assert.equal(prev.fullWidth, full.width, 'preview reports the export width');
      assert.equal(prev.fullHeight, full.height, 'preview reports the export height');
      const previewBox = await bbox(prev.bytes, isYellow);
      const fe = exportBox.w / exportBox.imgW;
      const fp = previewBox.w / previewBox.imgW;
      // Rounding a 96 px font to whole pixels at 1/4 scale costs at most ~3%.
      assert.ok(Math.abs(fp / fe - 1) < 0.04,
        `${pw}x${ph} on ${cw}x${ch} @${maxPx}: preview text is ${(fp * 100).toFixed(2)}% wide, export ${(fe * 100).toFixed(2)}%`);
      // Same place, too.
      assert.ok(Math.abs(previewBox.x0 / previewBox.imgW - exportBox.x0 / exportBox.imgW) < 0.01);
      assert.ok(Math.abs(previewBox.y0 / previewBox.imgH - exportBox.y0 / exportBox.imgH) < 0.01);
    }
  }
});

test('an export (no maxPx) is untouched by the preview scale: same bytes as a maxPx above its size', async () => {
  const input = await photo(400, 500);
  const template = {
    canvasWidth: 800, canvasHeight: 1000,
    elements: [{ id: 'b', type: 'barcode', format: 'code128', content: 'ABC-123', x: 0.5, y: 0.9, anchor: 'bc', width: 0.6, height: 0.15 }],
  };
  const a = await templateRenderer.compose({ inputImage: input, template, context: {} });
  const b = await templateRenderer.compose({ inputImage: input, template, context: {}, maxPx: 5000 });
  assert.ok(a.equals(b));
});

test('a photo already in the template shape is used as-is — no resample, no band', async () => {
  const input = await photo(300, 300, '#123456');
  const out = await templateRenderer.composeDetailed({
    inputImage: input, template: { canvasWidth: 2000, canvasHeight: 2000, elements: [] }, context: {},
  });
  assert.equal(out.mode, 'photo');
  const a = await raw(input);
  const b = await raw(out.bytes);
  assert.equal(b.info.width, 300);
  assert.equal(b.info.height, 300);
  assert.ok(a.data.equals(b.data), 'pixels changed');
});

/* ── 2. template shape, white bands ─────────────────────────────────── */

test('a landscape photo on a 4:5 template becomes a 4:5 picture with white bands, photo at 1:1', async () => {
  const input = await photo(1600, 1200, '#336699');
  const out = await templateRenderer.composeDetailed({
    inputImage: input, template: { canvasWidth: 1080, canvasHeight: 1350, elements: [] }, context: {},
  });
  assert.equal(out.mode, 'letterbox');
  assert.equal(out.width, 1600, 'the photo is not shrunk');
  assert.equal(out.height, 2000);
  const { data, info } = await raw(out.bytes);
  const px = (x, y) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
  // Bands: (2000 - 1200) / 2 = 400 px top and bottom, opaque white.
  assert.deepEqual(px(0, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(1599, 399), [255, 255, 255, 255]);
  assert.deepEqual(px(800, 1600), [255, 255, 255, 255]);
  assert.deepEqual(px(800, 1999), [255, 255, 255, 255]);
  // The photo, centred, untouched.
  assert.deepEqual(px(0, 400), [0x33, 0x66, 0x99, 255]);
  assert.deepEqual(px(1599, 1599), [0x33, 0x66, 0x99, 255]);
});

test('a portrait photo on a square template is pillarboxed; a square photo on a 4:5 one gets top/bottom bands', async () => {
  const tall = await templateRenderer.composeDetailed({
    inputImage: await photo(1200, 1600), template: { canvasWidth: 2000, canvasHeight: 2000, elements: [] }, context: {},
  });
  assert.deepEqual([tall.width, tall.height], [1600, 1600]);
  const sq = await templateRenderer.composeDetailed({
    inputImage: await photo(1600, 1600), template: { canvasWidth: 1080, canvasHeight: 1350, elements: [] }, context: {},
  });
  assert.deepEqual([sq.width, sq.height], [1600, 2000]);
});

test('elements are placed against the template-shaped canvas, as the editor places them', async () => {
  // A text at y = 0.05 on a 4:5 template sits 5% down the 4:5 picture, i.e.
  // inside the top white band for a landscape photo — exactly where the
  // editor (a 4:5 canvas with the photo contained in it) draws it.
  const out = await templateRenderer.composeDetailed({
    inputImage: await photo(1600, 1200), template: pillTemplate(1080, 1350), context: { sku: 'A1' },
  });
  const b = await bbox(out.bytes, isYellow);
  assert.equal(b.x0, Math.round(0.05 * 1600));
  assert.equal(b.y0, Math.round(0.05 * 2000));
});

test('a template with no design size keeps the photo size (legacy behaviour)', async () => {
  const out = await templateRenderer.composeDetailed({
    inputImage: await photo(640, 480), template: { elements: [] }, context: {},
  });
  assert.deepEqual([out.width, out.height, out.mode], [640, 480, 'photo']);
});

test('inset on: the canvas is the design size, and a preview scales it down whole', async () => {
  const template = {
    canvasWidth: 1000, canvasHeight: 1250,
    inset: { enabled: true, scale: 0.8, fillMode: 'color', fillColor: '#FFFFFF' },
    ...pillTemplate(1000, 1250),
  };
  const input = await photo(1600, 1200);
  const full = await templateRenderer.composeDetailed({ inputImage: input, template, context: { sku: 'X-9' } });
  assert.deepEqual([full.width, full.height, full.mode], [1000, 1250, 'inset']);
  const prev = await templateRenderer.composeDetailed({ inputImage: input, template, context: { sku: 'X-9' }, maxPx: 500 });
  assert.deepEqual([prev.width, prev.height], [400, 500]);
  const a = await bbox(full.bytes, isYellow);
  const b = await bbox(prev.bytes, isYellow);
  assert.ok(Math.abs((b.w / b.imgW) / (a.w / a.imgW) - 1) < 0.04);
});

test('no photo: a white canvas of the design size, already at the preview scale', async () => {
  const out = await templateRenderer.composeDetailed({
    inputImage: null, template: pillTemplate(1080, 1350), context: { sku: 'Z' }, maxPx: 540,
  });
  assert.deepEqual([out.width, out.height, out.fullWidth, out.fullHeight], [432, 540, 1080, 1350]);
});

/* ── 3. QR keeps its shape ──────────────────────────────────────────── */

test('a QR code in a non-square box stays square (contained, not squashed)', async () => {
  // 0.3 × 0.3 of a 4:5 picture is a 3:3.75 box. It used to be filled.
  const out = await templateRenderer.compose({
    inputImage: await photo(800, 1000, '#c0c0c0'),
    template: {
      canvasWidth: 800, canvasHeight: 1000,
      elements: [{ id: 'q', type: 'barcode', format: 'qrcode', content: 'HELLO-QR', x: 0.5, y: 0.5, anchor: 'c', width: 0.3, height: 0.3 }],
    },
    context: {},
  });
  const b = await bbox(out, isDark);
  assert.ok(b, 'no QR modules found');
  assert.ok(Math.abs(b.w / b.h - 1) < 0.03, `QR is ${b.w}x${b.h}`);
  assert.ok(b.w <= Math.round(0.3 * 800));
});

test('a barcode background pill stays inside the element box (the symbol is inset by the padding)', async () => {
  const out = await templateRenderer.compose({
    inputImage: await photo(1000, 1000, '#ffffff'),
    template: {
      canvasWidth: 1000, canvasHeight: 1000,
      elements: [{
        id: 'b', type: 'barcode', format: 'code128', content: 'ABC', x: 0.1, y: 0.1, anchor: 'tl',
        width: 0.4, height: 0.2, bg: { color: '#ffeb3b', padding: 20 },
      }],
    },
    context: {},
  });
  const b = await bbox(out, isYellow);
  assert.deepEqual([b.x0, b.y0, b.w, b.h], [100, 100, 400, 200]);
});

/* ── 4. text is never clipped ───────────────────────────────────────── */

async function referenceInkWidth(text, size, weight) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * text.length * 2}" height="${size * 2}">`
    + `<text x="${size}" y="${size * 1.3}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="#000">${text}</text></svg>`;
  return (await bbox(await sharp(Buffer.from(svg)).png().toBuffer(), (r, g, b, a) => a > 0)).w;
}

test('wide bold text is never clipped: the element is as wide as its ink', async () => {
  for (const text of ['WWWMMM', 'SKU-12345', 'Khmer Ceramic Bowl']) {
    const out = await templateRenderer.compose({
      inputImage: await photo(2000, 600, '#ffffff'),
      template: {
        canvasWidth: 2000, canvasHeight: 600,
        elements: [{
          id: 't', type: 'text', x: 0.02, y: 0.1, anchor: 'tl', content: text,
          font: { family: 'Helvetica, Arial, sans-serif', size: 96, weight: 'bold', color: '#000000' },
        }],
      },
      context: {},
    });
    const drawn = await bbox(out, isDark);
    const ref = await referenceInkWidth(text, 96, 'bold');
    // The composite threshold (dark pixels only) trims a pixel or two of
    // antialiasing on each side; a clipped glyph loses far more.
    assert.ok(drawn.w >= ref - 4, `"${text}": drawn ${drawn.w} px of ${ref} px of ink — clipped`);
  }
});

test('right-aligned text in a pill keeps its padding on the right', async () => {
  const out = await templateRenderer.compose({
    inputImage: await photo(1200, 400, '#ffffff'),
    template: {
      canvasWidth: 1200, canvasHeight: 400,
      elements: [{
        id: 't', type: 'text', x: 0.05, y: 0.1, anchor: 'tl', content: 'WIDE BOLD', align: 'right',
        font: { family: 'Helvetica, Arial, sans-serif', size: 80, weight: 'bold', color: '#000000' },
        bg: { color: '#ffeb3b', padding: 16 },
      }],
    },
    context: {},
  });
  const pill = await bbox(out, isYellow);
  const ink = await bbox(out, isDark);
  assert.ok(ink.x1 < pill.x1, 'ink reaches the pill edge');
  assert.ok(pill.x1 - ink.x1 >= 12, `right padding is ${pill.x1 - ink.x1} px, expected ~16`);
  assert.ok(ink.x0 - pill.x0 >= 12, `left padding is ${ink.x0 - pill.x0} px, expected ~16`);
});

test('an element larger than the picture is cropped to it rather than dropped', async () => {
  const out = await templateRenderer.compose({
    inputImage: await photo(300, 200, '#ffffff'),
    template: {
      canvasWidth: 300, canvasHeight: 200,
      elements: [{
        id: 't', type: 'text', x: 0, y: 0, anchor: 'tl', content: 'TOO WIDE FOR THIS',
        font: { family: 'Helvetica, Arial, sans-serif', size: 120, weight: 'bold', color: '#000000' },
      }],
    },
    context: {},
  });
  assert.ok(await bbox(out, isDark), 'the text vanished');
});

/* ── 5. sequence guard ──────────────────────────────────────────────── */

test('createLatestGuard: only the newest request may land; invalidate drops all in flight', async () => {
  const { createLatestGuard } = await overlayCanvas;
  const g = createLatestGuard();
  const a = g.next();
  const b = g.next();
  assert.equal(g.isLatest(a), false);
  assert.equal(g.isLatest(b), true);
  g.invalidate();
  assert.equal(g.isLatest(b), false);
});

test('the editor checks the guard before showing a render and before clearing "Updating…"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/modules/OverlayStudio/EditorCanvas.jsx'), 'utf8');
  const fetchAt = src.indexOf('window.api.templates.renderPreview(');
  const guardAt = src.indexOf('if (!guard.isLatest(stamp)) return;', fetchAt);
  const showAt = src.indexOf('setTruthfulPng(url)', fetchAt);
  assert.ok(fetchAt > 0 && guardAt > fetchAt && showAt > guardAt, 'a stale reply can still be shown');
  assert.match(src, /if \(guard\.isLatest\(stamp\)\) setPreviewBusy\(false\)/);
  // Switching product / template drops the old picture and every reply in flight.
  assert.match(src, /previewGuardRef\.current\.invalidate\(\)/);
  assert.match(src, /setTruthfulPng\(null\)/);
  // The preview size comes from the canvas, not a fixed constant.
  assert.match(src, /previewMaxPx\(canvasSize\.w, canvasSize\.h, dpr\)/);
  assert.doesNotMatch(src, /PREVIEW_MAX_PX/);
  // Interaction can't get stuck.
  assert.match(src, /addEventListener\('blur', onUp\)/);
  assert.match(src, /onLostPointerCapture=\{onPointerUp\}/);
});

test('templates:renderPreview scales inside compose and reports the export size', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/ipc/templates.js'), 'utf8');
  const start = src.indexOf("expose('templates:renderPreview'");
  const body = src.slice(start, src.indexOf("expose('templates:sampleBgColor'", start));
  assert.match(body, /composeDetailed\(\{[\s\S]*maxPx: capPx/);
  assert.match(body, /fullWidth: result\.fullWidth/);
  // The old pre-shrink of the photo is what made preview text twice too big.
  assert.doesNotMatch(body, /fit: 'inside'/);
});

/* ── 6. editor mirror of the shape rule ─────────────────────────────── */

test('outputCanvasSize: the editor mirror agrees with the renderer', async () => {
  const { outputCanvasSize } = await overlayCanvas;
  const templates = [
    { canvasWidth: 2000, canvasHeight: 2000 },
    { canvasWidth: 1080, canvasHeight: 1350 },
    { canvasWidth: 1920, canvasHeight: 1080 },
    { canvasWidth: 1000, canvasHeight: 1000, inset: { enabled: true } },
    { canvasWidth: 1000, canvasHeight: 1000, inset: { enabled: false } },
    {},
  ];
  const photos = [[1600, 1600], [1600, 1200], [1200, 1600], [2000, 2001], [4032, 3024], [37, 911]];
  for (const t of templates) {
    for (const [w, h] of photos) {
      assert.deepEqual(outputCanvasSize(t, w, h), templateRenderer.outputCanvasSize(t, w, h), JSON.stringify({ t, w, h }));
    }
  }
});

test('previewMaxPx follows the canvas in device pixels, within 256..1600', async () => {
  const { previewMaxPx } = await overlayCanvas;
  assert.equal(previewMaxPx(600, 750, 1), 768);
  assert.equal(previewMaxPx(600, 750, 2), 1536);
  assert.equal(previewMaxPx(900, 900, 2), 1600);
  assert.equal(previewMaxPx(50, 50, 1), 256);
});

/* ── 7. the editor's own drawing is at the canvas scale ─────────────── */

test('elementBox uses a measured ink width when the editor supplies one', async () => {
  const { elementBox } = await elementDefaults;
  const el = { type: 'text', x: 0, y: 0, anchor: 'tl', content: 'WWW', font: { size: 100 }, bg: { padding: 10 } };
  const estimated = elementBox(el, 1000, 1000, 'WWW', 1000, 1000);
  const measured = elementBox(el, 1000, 1000, 'WWW', 1000, 1000, () => 300);
  assert.equal(Math.round(estimated.width), Math.round(3 * 100 * 0.55 + 20));
  assert.equal(Math.round(measured.width), 320);
});

test('the editor draws text at canvasW / outputW, the same scale as its box', async () => {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/OverlayStudio/EditorCanvas.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(path.join(ROOT, 'package.json')), mod, mod.exports);
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const html = renderToString(React.createElement(mod.exports.ElementContent, {
    element: { id: 't', type: 'text', content: 'ABC', font: { size: 96 }, bg: { color: '#fff', padding: 12, radius: 8 } },
    box: { left: 0, top: 0, width: 100, height: 40 },
    productContext: {}, canvasW: 400, canvasH: 500, designW: 1600, designH: 2000, filledContent: 'ABC',
  }));
  // 96 px of a 1600 px output, shown 400 px wide → 24 px; padding 12 → 3 px.
  assert.match(html, /font-size:24px/);
  assert.match(html, /padding:3px/);
  assert.match(html, /border-radius:2px/);
});
