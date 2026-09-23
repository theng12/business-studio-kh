/**
 * v0.1.71: the Overlay Studio editor must not warp the artwork.
 *
 * The customer had to switch placeholders OFF to place elements accurately
 * because a photo whose aspect differed from its element box looked stretched.
 * The positions were never the problem (test/overlayPositioning.test.js pins
 * elementBox == resolveBox); the ARTWORK FITTING was: the renderer resizes a
 * photo into its box with sharp `fit: 'contain'`, and the editor's plain
 * `<img>`s had to apply the identical rule.
 *
 * This file proves both halves:
 *
 *   1. the editor's pure fit mapping (renderer/modules/OverlayStudio/
 *      overlayFit.js) defaults to `contain` and honours an element's `fit`;
 *   2. a real render of a square photo in a wide 3:1 box is CONTAINED — the
 *      visible pixels keep the photo's own aspect ratio instead of being
 *      stretched across the box — and `fit: 'cover'` fills the box instead.
 *
 * The deliberately mismatched case is a square asset in a 3:1 box, the case
 * that looked wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const esbuild = require('esbuild');

// Stub the data dir so templateRenderer can be required outside Electron.
require.cache[require.resolve('../main/db')] = {
  exports: { getDataDir: () => path.join('/tmp', 'iskh-artwork-fit-data') },
};
const templateRenderer = require('../main/templateRenderer');

const ROOT = path.join(__dirname, '..');
let fitModule = null;
async function overlayFit() {
  if (fitModule) return fitModule;
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/OverlayStudio/overlayFit.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  fitModule = mod.exports;
  return fitModule;
}

/** Bounding box of dark (artwork) pixels, or null when the image is blank. */
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

async function squareAsset(size = 64) {
  const file = path.join(os.tmpdir(), `iskh-fit-square-${process.pid}-${size}.png`);
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .png().toFile(file);
  return file;
}

async function whiteBase(w = 400, h = 400) {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .png().toBuffer();
}

/** A 240×80 (3:1) element box on a 400×400 canvas holding a square photo. */
function wideBoxTemplate(el = {}) {
  return {
    canvasWidth: 400,
    canvasHeight: 400,
    elements: [{
      id: 'img-1', type: 'image', source: 'asset:fit/square.png',
      x: 0.5, y: 0.5, anchor: 'c', width: 0.6, height: 0.2,
      ...el,
    }],
  };
}

async function renderWideBox(asset, el) {
  return templateRenderer.compose({
    inputImage: await whiteBase(),
    template: wideBoxTemplate(el),
    context: {},
    resolveAsset: () => asset,
  });
}

/* ── 1. the pure mapping ────────────────────────────────────────────── */

test('the editor defaults an image element to contain and honours its own fit', async () => {
  const { fitForElement, BACKDROP_FIT, INSET_BLUR_FIT, INSET_FOREGROUND_FIT } = await overlayFit();
  assert.equal(fitForElement(undefined), 'contain', 'no element → the renderer default');
  assert.equal(fitForElement({}), 'contain', 'no fit key (every existing template) → contain');
  assert.equal(fitForElement({ fit: 'contain' }), 'contain');
  assert.equal(fitForElement({ fit: 'cover' }), 'cover', 'a chosen cover must reach the DOM');
  assert.equal(fitForElement({ fit: 'fill' }), 'fill');
  assert.equal(fitForElement({ fit: 'nonsense' }), 'contain', 'unknown value must not leak through');
  // The canvas backdrop is never stretched; the inset mirrors reframe.js.
  assert.equal(BACKDROP_FIT, 'contain');
  assert.equal(INSET_BLUR_FIT, 'cover');
  assert.equal(INSET_FOREGROUND_FIT, 'contain');
});

/* ── 1b. the truthful preview layer's fit (static CSS) ──────────────── */

const CSS_FILE = path.join(ROOT, 'renderer/index.css');

/** The declaration body of the first `selector { … }` rule in index.css. */
function cssRule(selector) {
  const src = fs.readFileSync(CSS_FILE, 'utf8');
  const start = src.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} must exist in renderer/index.css`);
  return src.slice(start, src.indexOf('}', start) + 1);
}

test('the truthful preview layer never crops the rendered PNG (object-fit: contain)', () => {
  // The layer sits exactly on the canvas box. `cover` would crop the PNG
  // whenever its aspect ratio does not exactly equal the box — a mismatch
  // against the letterboxed backdrop right beside it, and exactly the kind
  // of artefact v0.1.71 removed from element artwork. `contain` is the
  // honest choice: identical when the aspect matches, no crop when it does not.
  const rule = cssRule('.ovl-canvas__truthful');
  assert.match(rule, /object-fit:\s*contain\b/,
    'the truthful PNG must be contained, never cropped');
  assert.doesNotMatch(rule, /object-fit:\s*cover\b/,
    'the truthful PNG must not use cover (it would crop a mismatched PNG)');
});

test('the surrounding canvas layers pin the deliberate cover exception', () => {
  // Backdrop and inset foreground show the whole image; the inset blur is the
  // one deliberate `cover` (a blurred fill must cover its box).
  assert.match(cssRule('.ovl-canvas__backdrop'), /object-fit:\s*contain\b/);
  assert.match(cssRule('.ovl-canvas__inset-fg'), /object-fit:\s*contain\b/);
  assert.match(cssRule('.ovl-canvas__inset-blur'), /object-fit:\s*cover\b/);
});

/* ── 2. the renderer half ───────────────────────────────────────────── */

test('a square photo in a wide 3:1 box renders contained, not stretched', async () => {
  const asset = await squareAsset(64);
  try {
    const bounds = await darkBounds(await renderWideBox(asset, { fit: 'contain' }));
    assert.ok(bounds, 'artwork must render');
    const aspect = bounds.width / bounds.height;
    assert.ok(Math.abs(aspect - 1) <= 0.05,
      `a square photo must stay square inside the 3:1 box, got ${bounds.width}×${bounds.height} (aspect ${aspect.toFixed(2)})`);
    assert.ok(bounds.width <= 100,
      `contain must not stretch the square across the 240px box, got ${bounds.width}px wide`);
  } finally { fs.rmSync(asset, { force: true }); }
});

test('fit: cover fills the 3:1 box (the explicit exception), proving the element fit is read', async () => {
  const asset = await squareAsset(64);
  try {
    const bounds = await darkBounds(await renderWideBox(asset, { fit: 'cover' }));
    assert.ok(bounds, 'artwork must render');
    assert.ok(Math.abs((bounds.width / bounds.height) - 3) <= 0.2,
      `cover must fill the 3:1 box, got ${bounds.width}×${bounds.height}`);
    assert.ok(bounds.width >= 230, `cover should span the box width, got ${bounds.width}px`);
  } finally { fs.rmSync(asset, { force: true }); }
});

test('the editor mapping and the renderer agree on the visible aspect for the mismatched case', async () => {
  const asset = await squareAsset(64);
  try {
    const bounds = await darkBounds(await renderWideBox(asset, { fit: 'contain' }));
    const rendererAspect = bounds.width / bounds.height;

    // Reproduce what the editor's <img> draws: box 240×80, natural 64×64,
    // object-fit contain → the fitted content rect.
    const { fitForElement } = await overlayFit();
    const boxW = 240; const boxH = 80;
    const natW = 64; const natH = 64;
    const fit = fitForElement({ fit: 'contain' });
    assert.equal(fit, 'contain');
    const scale = Math.min(boxW / natW, boxH / natH);
    const editorAspect = (natW * scale) / (natH * scale);

    assert.ok(Math.abs(rendererAspect - editorAspect) <= 0.05,
      `editor aspect ${editorAspect.toFixed(2)} must match the renderer's ${rendererAspect.toFixed(2)}`);
  } finally { fs.rmSync(asset, { force: true }); }
});
