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
 *      the server renderer (main/templateRenderer.js) has always used the
 *      font size verbatim — so preview and export disagreed on any canvas
 *      that was not 2000 wide.
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
const DESIGN_H = Math.max(48 * 1.15, 48 + 12 * 2);

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
