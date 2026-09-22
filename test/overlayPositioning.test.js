/**
 * Positioning checks across every place an image is placed on a canvas.
 *
 * Why this exists: the owner reported that an added image's position looked
 * like it was measured against the image's own box instead of the canvas, and
 * that the direction was reversed. The four paths that position an image are
 * covered here so the claim is either proven or disproven by the code, not by
 * reading it:
 *
 *   1. Overlay Studio image element → main/templateRenderer.js (the export)
 *   2. the same element in the editor → elementDefaults.js `elementBox`,
 *      which MUST agree with the renderer or the preview lies
 *   3. Image Workspace watermark corners → processingPipeline `cornerPosition`
 *   4. Reframe/inset nudge → main/util/reframe.js
 *
 * All assertions are on real rendered pixels (or the exact placement math),
 * so an inverted axis or an element-relative scale fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

// Stub the data dir so templateRenderer can be required outside Electron.
require.cache[require.resolve('../main/db')] = {
  exports: { getDataDir: () => path.join('/tmp', 'iskh-positioning-test-data') },
};

const templateRenderer = require('../main/templateRenderer');
const { cornerPosition } = require('../main/processingPipeline');
const { reframeImage } = require('../main/util/reframe');

const ROOT = path.join(__dirname, '..');

/* ── helpers ───────────────────────────────────────────────── */

async function whiteBase(w = 400, h = 400) {
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
}

/** Bounding box of dark pixels, or null when the image is blank. */
async function darkBounds(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function blackAsset(size = 64) {
  const file = path.join(os.tmpdir(), `iskh-pos-black-${process.pid}.png`);
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).png().toFile(file);
  return file;
}

function imageTemplate(el) {
  return {
    canvasWidth: 400,
    canvasHeight: 400,
    elements: [{
      id: 'i1', type: 'image', source: 'asset:pos/black.png',
      x: 0.5, y: 0.5, anchor: 'tl', width: 0.2, height: 0.2,
      ...el,
    }],
  };
}

async function renderImage(asset, el) {
  return templateRenderer.compose({
    inputImage: await whiteBase(),
    template: imageTemplate(el),
    context: {},
    resolveAsset: () => asset,
  });
}

/* ── 1. Overlay image element: canvas-based position ───────── */

test('overlay image — x/y are canvas fractions, not the element box', async () => {
  const asset = await blackAsset();
  try {
    const left = await darkBounds(await renderImage(asset, { x: 0.1, y: 0.1 }));
    const right = await darkBounds(await renderImage(asset, { x: 0.6, y: 0.1 }));
    assert.ok(left && right, 'both renders must contain the artwork');

    // x=0.1 → left edge at 10% of the 400px canvas = 40px.
    assert.ok(Math.abs(left.minX - 40) <= 3, `x=0.1 should sit at 40px, got ${left.minX}`);
    // x=0.6 → 240px. If position were scaled by the ELEMENT width (80px),
    // x=0.6 would land at 48px and this fails.
    assert.ok(Math.abs(right.minX - 240) <= 3, `x=0.6 should sit at 240px, got ${right.minX}`);
    // Direction: increasing x moves right.
    assert.ok(right.minX > left.minX, 'increasing x must move the image right');
    // Movement is the canvas delta (0.5 × 400 = 200px), not the element width.
    assert.ok(Math.abs((right.minX - left.minX) - 200) <= 4,
      `x delta should be 200px (canvas), got ${right.minX - left.minX}`);
  } finally { fs.rmSync(asset, { force: true }); }
});

test('overlay image — increasing y moves DOWN (axis not inverted)', async () => {
  const asset = await blackAsset();
  try {
    const top = await darkBounds(await renderImage(asset, { x: 0.1, y: 0.1 }));
    const bottom = await darkBounds(await renderImage(asset, { x: 0.1, y: 0.6 }));
    assert.ok(Math.abs(top.minY - 40) <= 3, `y=0.1 should sit at 40px, got ${top.minY}`);
    assert.ok(Math.abs(bottom.minY - 240) <= 3, `y=0.6 should sit at 240px, got ${bottom.minY}`);
    assert.ok(bottom.minY > top.minY, 'increasing y must move the image down');
  } finally { fs.rmSync(asset, { force: true }); }
});

test('overlay image — its size is the declared canvas fraction, not a tiny box', async () => {
  const asset = await blackAsset();
  try {
    const b = await darkBounds(await renderImage(asset, { width: 0.2, height: 0.2 }));
    assert.ok(b, 'artwork must render');
    assert.ok(Math.abs(b.width - 80) <= 4, `width 0.2 should be 80px, got ${b.width}`);
    assert.ok(Math.abs(b.height - 80) <= 4, `height 0.2 should be 80px, got ${b.height}`);
  } finally { fs.rmSync(asset, { force: true }); }
});

test('overlay image — every anchor resolves to the matching corner of the canvas', async () => {
  const asset = await blackAsset();
  try {
    const at = async (anchor, x, y) => darkBounds(await renderImage(asset, { anchor, x, y }));
    const tl = await at('tl', 0.05, 0.05);
    const tr = await at('tr', 0.95, 0.05);
    const bl = await at('bl', 0.05, 0.95);
    const br = await at('br', 0.95, 0.95);
    assert.ok(tl.minX < 100 && tl.minY < 100, `tl wrong: ${JSON.stringify(tl)}`);
    assert.ok(tr.maxX > 300 && tr.minY < 100, `tr wrong: ${JSON.stringify(tr)}`);
    assert.ok(bl.minX < 100 && bl.maxY > 300, `bl wrong: ${JSON.stringify(bl)}`);
    assert.ok(br.maxX > 300 && br.maxY > 300, `br wrong: ${JSON.stringify(br)}`);
  } finally { fs.rmSync(asset, { force: true }); }
});

/* ── 2. Editor ↔ renderer parity ───────────────────────────── */

/** Bundle the renderer's ESM elementDefaults so we can call elementBox. */
function loadElementDefaults() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/modules/OverlayStudio/elementDefaults.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test('editor elementBox matches the renderer resolveBox for every anchor', () => {
  const { elementBox } = loadElementDefaults();
  const canvasW = 600;
  const canvasH = 400;
  for (const anchor of ['tl', 'tc', 'tr', 'lc', 'c', 'rc', 'bl', 'bc', 'br']) {
    for (const [x, y] of [[0.05, 0.05], [0.5, 0.5], [0.95, 0.95]]) {
      const el = { type: 'image', anchor, x, y, width: 0.2, height: 0.15 };
      const editor = elementBox(el, canvasW, canvasH);
      const server = templateRenderer.resolveBox(el, canvasW, canvasH);
      assert.deepEqual(
        { left: Math.round(editor.left), top: Math.round(editor.top), width: Math.round(editor.width), height: Math.round(editor.height) },
        { left: server.left, top: server.top, width: server.width, height: server.height },
        `editor/server disagree for anchor=${anchor} x=${x} y=${y}`,
      );
    }
  }
});

/* ── 3. Image Workspace watermark corners ─────────────────── */

test('watermark — each corner maps to the correct corner of the canvas', () => {
  const W = 1000, H = 800, wmW = 180, wmH = 60, margin = 30;
  const tl = cornerPosition('tl', W, H, wmW, wmH, margin);
  const tr = cornerPosition('tr', W, H, wmW, wmH, margin);
  const bl = cornerPosition('bl', W, H, wmW, wmH, margin);
  const br = cornerPosition('br', W, H, wmW, wmH, margin);

  assert.deepEqual(tl, { left: margin, top: margin });
  assert.deepEqual(tr, { left: W - wmW - margin, top: margin });
  assert.deepEqual(bl, { left: margin, top: H - wmH - margin });
  assert.deepEqual(br, { left: W - wmW - margin, top: H - wmH - margin });
  // Sanity: left corners stay in the left half, right corners the right half.
  assert.ok(tl.left < W / 2 && bl.left < W / 2 && tr.left > W / 2 && br.left > W / 2);
  assert.ok(tl.top < H / 2 && tr.top < H / 2 && bl.top > H / 2 && br.top > H / 2);
});

/* ── 4. Reframe nudge ──────────────────────────────────────── */

/** A white canvas with a black centred square, so movement is measurable. */
async function framedSource(w = 400, h = 400) {
  const fg = await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).composite([{ input: fg, left: Math.round((w - 120) / 2), top: Math.round((h - 120) / 2) }]).png().toBuffer();
}

test('reframe nudge — +1 moves right, -1 moves left (no inversion)', async () => {
  const src = await framedSource();
  const at = async (offsetX) => darkBounds(await reframeImage({
    inputImage: src, canvasW: 400, canvasH: 400, scale: 0.5, offsetX, offsetY: 0,
    fillMode: 'color', fillColor: '#FFFFFF',
  }));
  const left = await at(-1);
  const centre = await at(0);
  const right = await at(1);
  assert.ok(left && centre && right, 'all three nudge renders must contain the product');
  assert.ok(left.minX < centre.minX, `-1 should be left of centre (${left.minX} vs ${centre.minX})`);
  assert.ok(right.minX > centre.minX, `+1 should be right of centre (${right.minX} vs ${centre.minX})`);
});

test('reframe nudge — the offset scale is proportional, not saturated', async () => {
  const src = await framedSource();
  const at = async (offsetX) => darkBounds(await reframeImage({
    inputImage: src, canvasW: 400, canvasH: 400, scale: 0.5, offsetX, offsetY: 0,
    fillMode: 'color', fillColor: '#FFFFFF',
  }));
  const half = await at(0.5);
  const full = await at(1);
  assert.ok(half.minX < full.minX, `0.5 should sit between centre and +1 (${half.minX} vs ${full.minX})`);
});

test('reframe — the UI converts its -100..100 sliders to the -1..1 fraction', () => {
  // Regression: the sliders passed their raw percent straight through, so any
  // value past 1 collapsed to the same extreme nudge.
  const src = fs.readFileSync(path.join(ROOT, 'renderer/modules/ProductLibrary/ReframeModal.jsx'), 'utf8');
  const divided = (src.match(/offsetX: offsetX \/ 100/g) || []).length;
  assert.ok(divided >= 2, `expected both reframe calls to divide the nudge by 100, found ${divided}`);
});
