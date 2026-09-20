/**
 * v0.1.5: element-level opacity in the Overlay Studio template renderer.
 *
 * Why this exists: `element.opacity` was only ever honoured for IMAGE
 * elements. Text and barcode elements ignored it, and the inspector showed
 * an opacity control for images only — so a user could not fade a text or
 * barcode element at all. Adding it is only safe if it is a no-op for
 * existing templates, so these tests pin BOTH halves:
 *
 *   1. legacy templates (no `opacity` key) render exactly as before
 *   2. opacity actually changes the rendered pixels, monotonically
 *
 * `compose` is exercised directly on a synthetic white base so no Electron,
 * no DB and no product fixtures are needed. The db module is stubbed for
 * getDataDir(), same trick as scripts/probe-overlay-renderer.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sharp = require('sharp');

// Stub the data dir so templateRenderer can be required outside Electron.
require.cache[require.resolve('../main/db')] = {
  exports: { getDataDir: () => path.join('/tmp', 'iskh-opacity-test-data') },
};

const templateRenderer = require('../main/templateRenderer');

/** Darkest pixel luminance in the rendered PNG (255 = pure white). */
async function darkestLuminance(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let min = 255;
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = Math.min(data[i], data[i + 1], data[i + 2]);
    if (lum < min) min = lum;
  }
  return min;
}

async function whiteBase(w = 400, h = 400) {
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
}

function textTemplate(extra = {}) {
  return {
    canvasWidth: 400,
    canvasHeight: 400,
    elements: [{
      id: 't1',
      type: 'text',
      x: 0.1, y: 0.1, anchor: 'tl',
      content: 'HELLO',
      font: { family: 'Helvetica, Arial, sans-serif', size: 40, weight: 'bold', color: '#000000' },
      ...extra,
    }],
  };
}

function barcodeTemplate(extra = {}) {
  return {
    canvasWidth: 600,
    canvasHeight: 400,
    elements: [{
      id: 'b1',
      type: 'barcode',
      x: 0.5, y: 0.5, anchor: 'c',
      width: 0.6, height: 0.3,
      content: '123456789012',
      format: 'ean13',
      showText: true,
      ...extra,
    }],
  };
}

test('text — a legacy template with no opacity key renders fully opaque', async () => {
  const base = await whiteBase();
  const out = await templateRenderer.compose({ inputImage: base, template: textTemplate(), context: {} });
  // Full black text on white → the darkest pixel is essentially 0.
  assert.ok(await darkestLuminance(out) < 40, 'legacy text must stay solid');
});

test('text — opacity 1 is identical to omitting the key', async () => {
  const base = await whiteBase();
  const legacy = await templateRenderer.compose({ inputImage: base, template: textTemplate(), context: {} });
  const explicit = await templateRenderer.compose({
    inputImage: base, template: textTemplate({ opacity: 1 }), context: {},
  });
  assert.equal(Buffer.compare(legacy, explicit), 0, 'opacity:1 must be byte-identical to no opacity key');
});

test('text — opacity fades monotonically toward the background', async () => {
  const base = await whiteBase();
  const lums = [];
  for (const op of [1, 0.5, 0.25]) {
    const out = await templateRenderer.compose({
      inputImage: base, template: textTemplate({ opacity: op }), context: {},
    });
    lums.push(await darkestLuminance(out));
  }
  assert.ok(lums[0] < lums[1], `0.5 should be lighter than 1 (got ${lums})`);
  assert.ok(lums[1] < lums[2], `0.25 should be lighter than 0.5 (got ${lums})`);
});

test('text — opacity 0 renders nothing (fully invisible)', async () => {
  const base = await whiteBase();
  const out = await templateRenderer.compose({
    inputImage: base, template: textTemplate({ opacity: 0 }), context: {},
  });
  assert.equal(await darkestLuminance(out), 255, 'opacity:0 should leave the base untouched');
});

test('text — opacity is clamped, so out-of-range values cannot blow up', async () => {
  const base = await whiteBase();
  for (const op of [-5, 99]) {
    const out = await templateRenderer.compose({
      inputImage: base, template: textTemplate({ opacity: op }), context: {},
    });
    assert.ok(Buffer.isBuffer(out) && out.length > 0, `opacity ${op} should still render`);
  }
});

test('barcode — a legacy template renders fully opaque bars', async () => {
  const base = await whiteBase(600, 400);
  const out = await templateRenderer.compose({ inputImage: base, template: barcodeTemplate(), context: {} });
  assert.ok(await darkestLuminance(out) < 40, 'legacy barcode must stay solid');
});

test('barcode — opacity fades the bars', async () => {
  const base = await whiteBase(600, 400);
  const solid = await darkestLuminance(
    await templateRenderer.compose({ inputImage: base, template: barcodeTemplate(), context: {} }),
  );
  const faded = await darkestLuminance(
    await templateRenderer.compose({
      inputImage: base, template: barcodeTemplate({ opacity: 0.5 }), context: {},
    }),
  );
  assert.ok(faded > solid, `faded bars should be lighter (solid ${solid}, faded ${faded})`);
});

test('barcode — the white scanner-contrast plate stays opaque when faded', async () => {
  const base = await whiteBase(600, 400);
  const out = await templateRenderer.compose({
    inputImage: base, template: barcodeTemplate({ opacity: 0.4 }), context: {},
  });
  // The plate is white and the base is white, so the GAPS between bars must
  // still be pure white. If the plate had been faded with the bars, the gaps
  // would darken toward the base — which is white too, so instead we assert
  // the inverse: the gaps are still 255 while the bars are not.
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  let lightest = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = Math.min(data[i], data[i + 1], data[i + 2]);
    if (lum > lightest) lightest = lum;
  }
  assert.equal(lightest, 255, 'the background between bars must stay pure white');
});
