/**
 * templates:renderPreview, end to end against a real database: the preview the
 * editor shows is the export, smaller, and in the template's shape.
 *
 * The pure half of this lives in test/overlayPreview.test.js. This half runs
 * the IPC handler itself — product lookup, image pick, `maxPx` — because the
 * bug was in the handler: it shrank the photo BEFORE compose, so every
 * pixel-sized thing (font size, padding) came out too large in the preview.
 *
 * Needs better-sqlite3 built for Electron:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/overlayPreviewIpc.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run this test with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron";
  } else {
    throw err;
  }
}

async function yellowBox(buf) {
  const sharp = require('sharp');
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity; let x1 = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 4;
      if (data[i] > 230 && data[i + 1] > 210 && data[i + 2] < 90) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  return { frac: (x1 - x0 + 1) / info.width, width: info.width, height: info.height };
}

test('renderPreview: template-shaped, same text share as the export, reports the export size', { skip: skipReason }, async () => {
  const originalLoad = Module._load;
  Module._load = function testLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcMain: { handle: () => {}, on: () => {} },
        app: { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const db = require('../main/db');
  const companies = require('../main/db/companies');
  const products = require('../main/db/products');
  const productImages = require('../main/db/productImages');
  const imageTemplates = require('../main/db/imageTemplates');
  const templates = require('../main/ipc/templates');
  const templateRenderer = require('../main/templateRenderer');
  const sharp = require('sharp');
  Module._load = originalLoad;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-overlay-preview-'));
  try {
    db.initDb(dataDir);
    const company = companies.create({ name: 'Synthetic Preview Co' });
    const product = products.create({ companyId: company.id, sku: 'PRV-12345', name: 'Synthetic product' });
    // A landscape photo for a 4:5 template — the case that used to come out
    // the photo's shape, with text twice too large in the preview.
    const source = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#8899aa' } }).png().toBuffer();
    await productImages.addFromBytes(product.id, source, '.png', { originalFilepath: 'synthetic.png' });
    const template = imageTemplates.create({
      name: 'Synthetic 4:5',
      canvasWidth: 1080,
      canvasHeight: 1350,
      elements: [{
        id: 't', type: 'text', x: 0.05, y: 0.05, anchor: 'tl', content: '{sku}',
        font: { family: 'Helvetica, Arial, sans-serif', size: 96, weight: 'bold', color: '#000000' },
        bg: { color: '#ffeb3b', padding: 12 },
      }],
    });

    const handlers = new Map();
    const expose = (channel, fn) => handlers.set(channel, fn);
    templates.register({ expose, exposeLocal: expose, emitCatalogChange: () => {} });
    const renderPreview = handlers.get('templates:renderPreview');

    const preview = await renderPreview({ templateId: template.id, productId: product.id, maxPx: 800 });
    assert.deepEqual([preview.fullWidth, preview.fullHeight], [1600, 2000], 'export size: the photo letterboxed to 4:5');
    assert.deepEqual([preview.width, preview.height], [640, 800]);

    const full = await renderPreview({ templateId: template.id, productId: product.id });
    assert.deepEqual([full.width, full.height], [1600, 2000]);

    // And compose() as the export paths call it (no maxPx) gives that same
    // picture from the same photo.
    const exported = await templateRenderer.compose({
      inputImage: source, template: imageTemplates.get(template.id), context: { sku: 'PRV-12345' },
    });
    const e = await yellowBox(exported);
    const p = await yellowBox(preview.bytes);
    assert.deepEqual([e.width, e.height], [1600, 2000]);
    assert.ok(Math.abs(p.frac / e.frac - 1) < 0.04, `preview text ${(p.frac * 100).toFixed(2)}% vs export ${(e.frac * 100).toFixed(2)}%`);
  } finally {
    try { db.closeDb?.(); } catch (_) { /* ignore */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
