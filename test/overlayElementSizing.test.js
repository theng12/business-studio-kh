/**
 * v0.1.8: regression tests for Overlay Studio text sizing.
 *
 * The bug being pinned is a hardcoded 2000 standing in for the design
 * canvas width, in two places:
 *
 *   1. `elementBox()` computed a text element's on-screen box as
 *      `designPx × (canvasW / 2000)`. On a 2000-wide canvas that is right
 *      by coincidence; on a 3000-wide canvas it returns 1.5x the correct
 *      value, so the selection outline no longer matched the element.
 *
 *   2. The canvas preview multiplied font size by `canvasW / 2000`, while
 *      the server renderer (main/templateRenderer.js) used the font size
 *      verbatim — so preview and export disagreed on any canvas that was not
 *      2000 wide.
 *
 * Since 2026-10-02 (owner decision) font size and padding are DESIGN pixels on
 * both sides: the editor draws them at `canvasW / designW` and the renderer at
 * `outputW / designW` (designPixelScale), so a template looks the same on any
 * photo. The last tests below pin the renderer to elementBox.
 *
 * The invariant is NOT "same fraction at every design size" — a 48px font
 * genuinely is a smaller share of a 3000px canvas than of a 2000px one.
 * The invariant is that the element's DESIGN size is independent of the
 * canvas: the on-screen box must equal `designPx x (screen / design)`, with
 * no extra 2000 term anywhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// elementDefaults.js is an ES module (it uses `export`), so it cannot be
// require()d from this CommonJS test. Load it with a dynamic import.
const elementBoxModule = import('../renderer/modules/OverlayStudio/elementDefaults.js');
async function box(el, canvasW, canvasH, previewText, designW, designH) {
  const { elementBox } = await elementBoxModule;
  return elementBox(el, canvasW, canvasH, previewText, designW, designH);
}

/** Design-space size of the fallback box for an 8-char SKU at 48px / 12px. */
const DESIGN_W = Math.max(80, 'DEMO-001'.length * 48 * 0.55 + 12 * 2);
// One line (1.15 em) + padding top and bottom, like the renderer's
// `lineHeight + padding * 2` (it used to be max(1.15 em, 1 em + 2 × padding),
// which was shorter than the render whenever there was padding).
const DESIGN_H = 48 * 1.15 + 12 * 2;

function textEl(overrides = {}) {
  return {
    type: 'text',
    x: 0.5, y: 0.5, anchor: 'c',
    content: '{sku}',
    font: { size: 48, weight: 'bold' },
    bg: { padding: 12, radius: 6 },
    ...overrides,
  };
}

test('elementBox — recovers the true design width at any canvas size', async () => {
  const screen = 680;
  for (const [dw, dh] of [[2000, 2000], [3000, 2000], [4000, 4000], [1200, 900]]) {
    const canvasH = screen * (dh / dw);
    const b = await box(textEl(), screen, canvasH, 'DEMO-001', dw, dh);
    const inferred = b.width / (screen / dw);
    assert.ok(
      Math.abs(inferred - DESIGN_W) < 0.5,
      `design ${dw}x${dh}: inferred ${inferred.toFixed(1)}, expected ${DESIGN_W}`,
    );
  }
});

test('elementBox — on-screen size is designPx x (screen / design), nothing else', async () => {
  for (const { dw, dh, screen } of [
    { dw: 2000, dh: 2000, screen: 680 },
    { dw: 3000, dh: 2000, screen: 680 },
    { dw: 3000, dh: 2000, screen: 400 },
  ]) {
    const canvasH = screen * (dh / dw);
    const b = await box(textEl(), screen, canvasH, 'DEMO-001', dw, dh);
    // elementBox floors the box at 20x16 screen px so a brand-new empty
    // element stays grabbable — mirror that in the expectation.
    const expW = Math.max(20, DESIGN_W * (screen / dw));
    const expH = Math.max(16, DESIGN_H * (canvasH / dh));
    assert.ok(Math.abs(b.width - expW) < 0.5,
      `width wrong for ${dw} design at ${screen}px: ${b.width} (expected ${expW.toFixed(1)})`);
    assert.ok(Math.abs(b.height - expH) < 0.5,
      `height wrong for ${dh} design at ${screen}px: ${b.height} (expected ${expH.toFixed(1)})`);
  }
});

test('elementBox — no extra 1.5x when the canvas is 3000 wide', async () => {
  const screen = 680;
  const b = await box(textEl(), screen, screen, 'DEMO-001', 3000, 2000);
  const correct = DESIGN_W * (screen / 3000);
  assert.ok(Math.abs(b.width - correct) < 0.5,
    `expected ${correct.toFixed(1)}, got ${b.width.toFixed(1)} (buggy ${(correct * 1.5).toFixed(1)})`);
});

test('elementBox — explicit width/height map to the same canvas fraction', async () => {
  const el = textEl({ width: 0.25, height: 0.1 });
  for (const [dw, dh] of [[2000, 2000], [3000, 2000], [1200, 900]]) {
    const b = await box(el, 600, 400, null, dw, dh);
    assert.equal(b.width, 0.25 * 600, `explicit width wrong at ${dw}x${dh}`);
    assert.equal(b.height, 0.1 * 400, `explicit height wrong at ${dw}x${dh}`);
  }
});

test('elementBox — falls back to 2000 only when no design size is supplied', async () => {
  const el = textEl();
  const withDesign = await box(el, 600, 600, 'DEMO-001', 2000, 2000);
  const withoutDesign = await box(el, 600, 600, 'DEMO-001', undefined, undefined);
  assert.equal(withoutDesign.width, withDesign.width);
  assert.equal(withoutDesign.height, withDesign.height);
});

test('elementBox — anchor placement stays centred', async () => {
  const b = await box(textEl(), 600, 600, 'DEMO-001', 3000, 2000);
  assert.ok(Math.abs((b.left + b.width / 2) - 0.5 * 600) < 1e-6, 'centre x drifted');
  assert.ok(Math.abs((b.top + b.height / 2) - 0.5 * 600) < 1e-6, 'centre y drifted');
});

/* ── renderer ↔ editor: same box, any photo size ───────────────────── */

function rendererWithStubbedDb() {
  const path = require('node:path');
  require.cache[require.resolve('../main/db')] = {
    exports: { getDataDir: () => path.join('/tmp', 'msk-overlay-sizing-test-data') },
  };
  return require('../main/templateRenderer');
}

async function pillBox(buf) {
  const sharp = require('sharp');
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 4;
      if (data[i] > 230 && data[i + 1] > 210 && data[i + 2] < 90) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, imgW: info.width, imgH: info.height };
}

test('renderer — the text box height equals elementBox height, in design pixels, on any photo', async () => {
  const sharp = require('sharp');
  const templateRenderer = rendererWithStubbedDb();
  const el = textEl({ x: 0.1, y: 0.1, anchor: 'tl', bg: { color: '#ffeb3b', padding: 12 } });
  for (const photoPx of [1000, 2000, 3000]) {
    const input = await sharp({ create: { width: photoPx, height: photoPx, channels: 3, background: '#808080' } }).png().toBuffer();
    const out = await templateRenderer.compose({
      inputImage: input, template: { canvasWidth: 2000, canvasHeight: 2000, elements: [el] }, context: { sku: 'DEMO-001' },
    });
    const pill = await pillBox(out);
    const editor = await box(el, photoPx, photoPx, 'DEMO-001', 2000, 2000);
    // Whole-pixel rounding of the scaled font / padding: within 2 px.
    assert.ok(Math.abs(pill.h - editor.height) <= 2,
      `${photoPx}px photo: render ${pill.h}px tall, editor box ${editor.height.toFixed(1)}px`);
  }
});

test('renderer — the same template gives the same relative text size on an 800 px and a 1600 px photo', async () => {
  const sharp = require('sharp');
  const templateRenderer = rendererWithStubbedDb();
  const template = {
    canvasWidth: 2000, canvasHeight: 2000,
    elements: [textEl({ x: 0.1, y: 0.1, anchor: 'tl', font: { size: 96, weight: 'bold' }, bg: { color: '#ffeb3b', padding: 12 } })],
  };
  const fracs = [];
  for (const photoPx of [800, 1600]) {
    const input = await sharp({ create: { width: photoPx, height: photoPx, channels: 3, background: '#808080' } }).png().toBuffer();
    const pill = await pillBox(await templateRenderer.compose({ inputImage: input, template, context: { sku: 'SKU-12345' } }));
    fracs.push(pill.w / pill.imgW);
  }
  assert.ok(Math.abs(fracs[0] / fracs[1] - 1) < 0.03, `800px: ${(fracs[0] * 100).toFixed(2)}%, 1600px: ${(fracs[1] * 100).toFixed(2)}%`);
});
