/**
 * Main-process render hot paths (pure JS — runs under plain `npm test`).
 *
 *   1. The bundled fonts are read and base64'd once per process, not on every
 *      label / catalog / social render. The CJK faces are ~17 MB files each.
 *   2. A PREVIEW document (the catalog / label preview iframes) references
 *      photos as app-image URLs instead of inlining them as base64, and leaves
 *      out the embedded fonts the renderer's CSP refuses anyway. The export
 *      document (offscreen window → PDF / PNG) still inlines both.
 *   3. Script detection reads what the catalog renders, not every product
 *      handed in — a template preview passes the whole catalog and draws nine.
 *
 * studioRenderer resolves `./db` lazily for the data folder; it is stubbed
 * here (stubModule) so no SQLite binding is needed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/* Seed the module cache with a stand-in for main/db/index.js. studioRenderer
 * requires it lazily, at call time, so a load-time stub would be gone by then. */
function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-mainperf-render-'));
const PHOTO_REL = 'Co/Brand/SKU 1/SKU-1-001.jpg';
fs.mkdirSync(path.join(dataDir, 'assets', path.dirname(PHOTO_REL)), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'assets', PHOTO_REL), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

stubModule('../main/db', { getDataDir: () => dataDir });
const renderer = require('../main/studioRenderer');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('each bundled font file is read once per process, however many renders ask for it', (t) => {
  const fontRoot = path.join(process.cwd(), 'assets', 'fonts');
  if (!fs.existsSync(path.join(fontRoot, 'NotoSansKhmer-Regular.ttf'))) {
    t.skip('assets/fonts not present in this checkout');
    return;
  }
  const reads = new Map();
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string' && file.startsWith(fontRoot)) reads.set(file, (reads.get(file) || 0) + 1);
    return original.call(this, file, ...rest);
  };
  try {
    const first = renderer.embeddedFontCss('សួស្តី');
    const second = renderer.embeddedFontCss('សួស្តី អង្គរ');
    assert.ok(first.includes('"MS Noto Khmer"') && first.includes('"MS Noto"'), 'Khmer text embeds Khmer + Noto');
    assert.equal(second, first, 'the cached rules are the same rules');
  } finally {
    fs.readFileSync = original;
  }
  assert.ok(reads.size >= 4, `expected the four Noto/Khmer faces to be read, got ${[...reads.keys()]}`);
  for (const [file, n] of reads) assert.equal(n, 1, `${path.basename(file)} was read ${n} times`);
});

const project = {
  id: 'proj', name: 'Spring',
  config: { selectionMode: 'explicit', productIds: ['p1', 'p2'] },
};
const products = [
  { id: 'p1', sku: 'SKU-1', name: 'Tile', mainImagePath: PHOTO_REL, updatedAt: 1700000000000 },
  { id: 'p2', sku: 'SKU-2', name: 'No photo on disk', mainImagePath: 'Co/Brand/SKU-2/missing.jpg', updatedAt: 1 },
  // Not selected: its Khmer name must not pull fonts into the document.
  { id: 'p3', sku: 'SKU-3', name: 'សួស្តី', mainImagePath: null, updatedAt: 1 },
];

test('a catalog PREVIEW references photos by app-image URL, with the cache stamp', () => {
  const html = renderer.buildCatalogHtml({ project, products }, { preview: true });
  // `w=640`: the preview asks for the cached thumbnail, not the original (§9).
  const expected = `app-image://local/${encodeURIComponent(PHOTO_REL)}?v=1700000000000&w=640`;
  assert.ok(html.includes(`src="${expected}"`), 'the photo is an app-image URL');
  assert.ok(!html.includes('data:image/'), 'no photo is inlined as base64');
  assert.ok(html.includes('No image'), 'a missing file still shows the placeholder');
  assert.ok(!html.includes('@font-face'), 'the preview carries no embedded fonts');
});

test('the catalog EXPORT document still inlines photos for the offscreen window', () => {
  const html = renderer.buildCatalogHtml({ project, products });
  assert.ok(html.includes('src="data:image/jpeg;base64,'), 'the photo is inlined');
  assert.ok(!html.includes('app-image://'), 'nothing depends on the app-image protocol');
});

test('fonts follow the products a catalog renders, not every product passed in', () => {
  const html = renderer.buildCatalogHtml({ project, products });
  assert.ok(!html.includes('@font-face'), 'an unselected Khmer product must not embed fonts');
  const khmerSelected = { ...project, config: { ...project.config, productIds: ['p3'] } };
  const withKhmer = renderer.buildCatalogHtml({ project: khmerSelected, products });
  if (fs.existsSync(path.join(process.cwd(), 'assets', 'fonts', 'NotoSansKhmer-Regular.ttf'))) {
    assert.ok(withKhmer.includes('"MS Noto Khmer"'), 'a rendered Khmer product embeds the Khmer face');
  }
});

test('a label PREVIEW uses app-image URLs and the small print fonts; the print document inlines', async () => {
  const template = {
    widthMm: 50, heightMm: 30,
    elements: [
      { type: 'productImage', x: 0, y: 0, width: 20, height: 20 },
      { type: 'text', field: 'name', x: 20, y: 0, width: 30, height: 10 },
    ],
  };
  const product = { id: 'p1', sku: 'SKU-1', name: 'សួស្តី', mainImagePath: PHOTO_REL, updatedAt: 42 };
  const preview = await renderer.labelsDocument({ template, products: [product], layout: { mode: 'single' }, preview: true });
  assert.ok(preview.includes(`app-image://local/${encodeURIComponent(PHOTO_REL)}?v=42`));
  if (fs.existsSync(path.join(process.cwd(), 'assets', 'fonts', 'NotoSansKhmer-Regular.ttf'))) {
    assert.ok(preview.includes('@font-face{font-family:"MS Noto Khmer"'), 'a Khmer preview draws with the print font (owner, 2026-10-02)');
  }
  const print = await renderer.labelsDocument({ template, products: [product], layout: { mode: 'single' } });
  assert.ok(print.includes('data:image/jpeg;base64,'));
  assert.ok(!print.includes('app-image://'));
});

test('a PREVIEW leaves the 17 MB CJK faces to the Mac; the print embeds them', async () => {
  const template = { widthMm: 50, heightMm: 30, elements: [{ type: 'text', field: 'name', x: 0, y: 0, width: 50, height: 10 }] };
  const product = { id: 'p1', sku: 'SKU-1', name: '\u4e2d\u6587', mainImagePath: null, updatedAt: 1 };
  const preview = await renderer.labelsDocument({ template, products: [product], layout: { mode: 'single' }, preview: true });
  // The family is always NAMED in the font stack; what must be absent is its @font-face.
  assert.ok(!preview.includes('@font-face{font-family:"MS Noto SC"'), 'no CJK face embedded in a preview');
  if (fs.existsSync(path.join(process.cwd(), 'assets', 'fonts', 'NotoSansSC-Regular.otf'))) {
    const print = await renderer.labelsDocument({ template, products: [product], layout: { mode: 'single' } });
    assert.ok(print.includes('@font-face{font-family:"MS Noto SC"'), 'the print still embeds it');
  }
});
