const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');

function loadSocialGrid(capture) {
  const filename = path.join(ROOT, 'main/ipc/socialGrid.js');
  const req = createRequire(filename);
  const module = { exports: {} };
  const products = Array.from({ length: 64 }, (_, i) => ({
    id: `p${i}`, sku: `SKU-${i}`, name: `Product ${i}`, status: 'active', priceRetail: i + 1,
  }));
  const stubs = {
    '../db/socialGridPresets': {},
    '../db/socialGridTemplates': {},
    '../db/products': { list: () => products },
    '../db/brands': { list: () => [] },
    '../db/companies': { getActiveId: () => 'company' },
    '../studioRenderer': { assetDataUri: () => '' },
    '../renderWindow': { withWindow: capture },
    '../events': { broadcast() {} },
  };
  module.exports = {};
  const source = fs.readFileSync(filename, 'utf8');
  const run = new Function('require', 'module', 'exports', source);
  run((id) => (Object.hasOwn(stubs, id) ? stubs[id] : req(id)), module, module.exports);
  const handlers = new Map();
  module.exports.register({
    expose: (name, fn) => handlers.set(name, fn),
    exposeLocal: (name, fn) => handlers.set(name, fn),
    emitCatalogChange() {},
    assertEntityInActiveCompany: (row) => row,
  });
  return handlers;
}

async function markerImage(width, height) {
  const x = Math.round(width / 2 - 100);
  const y = Math.round(height / 2);
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><rect x="${x}" y="${y}" width="20" height="20" fill="#ff0000"/></svg>`);
  return sharp(svg).png().toBuffer();
}

for (const [width, height] of [[1600, 900], [900, 1600]]) {
  test(`preview keeps full export geometry and caps the final ${width}x${height} PNG`, async () => {
    const captures = [];
    const bytes = await markerImage(width, height);
    const handlers = loadSocialGrid(async (html, options, task) => {
      captures.push({ html, options });
      return task({ webContents: { capturePage: async () => ({ toPNG: () => bytes }) } });
    });
    const config = {
      width, height, columns: 8, rows: 8, padding: 0, gap: 0, radius: 0,
      nameSize: 6, priceSize: 6, metaSize: 6, titleSize: 6, subtitleSize: 6, footerSize: 6,
      overlays: [{ type: 'text', text: '@shop', anchor: 'cc', offsetX: -100, offsetY: 0, size: 6 }],
    };

    const preview = await handlers.get('socialGrid:preview')({ config });
    const exported = await handlers.get('socialGrid:exportBytes')({ config });
    const previewBytes = Buffer.from(preview.dataUrl.split(',')[1], 'base64');
    const previewMeta = await sharp(previewBytes).metadata();
    const exportMeta = await sharp(exported.files[0].bytes).metadata();
    const factor = 560 / Math.max(width, height);

    assert.equal(captures.length, 2);
    assert.equal(captures[0].html, captures[1].html, 'preview and export capture the exact same document');
    assert.deepEqual(captures.map(({ options }) => options), [
      { width, height, zoomFactor: 1 }, { width, height, zoomFactor: 1 },
    ], 'preview captures at the saved design dimensions');
    assert.match(captures[0].html, /\.post\{[^}]*padding:0px/);
    assert.match(captures[0].html, /\.grid\{[^}]*gap:0px/);
    assert.match(captures[0].html, /\.tile\{[^}]*border-radius:0px/);
    assert.match(captures[0].html, /translate\(-100px, 0px\)/, 'signed watermark offsets survive');
    assert.match(captures[0].html, /grid-template-columns:repeat\(8,/);
    assert.equal((captures[0].html.match(/<article class="tile">/g) || []).length, 64, 'dense grid stays dense');
    assert.equal(exportMeta.width, width);
    assert.equal(exportMeta.height, height);
    assert.equal(previewMeta.width, Math.round(width * factor));
    assert.equal(previewMeta.height, Math.round(height * factor));
    assert.ok(previewMeta.width <= 560 && previewMeta.height <= 560, 'both preview dimensions stay capped');
    const reducedExport = await sharp(exported.files[0].bytes)
      .resize(previewMeta.width, previewMeta.height, { fit: 'fill' })
      .png({ compressionLevel: 9 }).toBuffer();
    assert.deepEqual(previewBytes, reducedExport, 'preview pixels equal the exported fixture reduced to preview size');

    const { data, info } = await sharp(previewBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let redX = 0; let redY = 0; let redCount = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset] > 240 && data[offset + 1] < 20 && data[offset + 2] < 20) {
          redX += x; redY += y; redCount += 1;
        }
      }
    }
    assert.ok(redCount > 0, 'the geometry marker survives final PNG resizing');
    const expectedX = ((width / 2 - 100) + 10) * factor;
    const expectedY = (height / 2 + 10) * factor;
    assert.ok(Math.abs(redX / redCount - expectedX) <= 1.5, 'horizontal marker geometry scales with the final image');
    assert.ok(Math.abs(redY / redCount - expectedY) <= 1.5, 'vertical marker geometry scales with the final image');
  });
}
