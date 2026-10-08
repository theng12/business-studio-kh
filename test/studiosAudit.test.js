/**
 * Production-studio audit, 2026-10 (Business Studio KH 0.1.93, ~2,500 products
 * with Khmer names). Pure checks — no database, no Electron — so they run
 * under plain `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadEsm(rel) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'zustand'],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

/* ── A. studios read the unfiltered product list ─────────────────────── */

test('every studio reads allProducts, not the Library-filtered products', () => {
  const files = [
    'renderer/modules/LabelStudio/LabelGenerate.jsx',
    'renderer/modules/LabelStudio/LabelTemplates.jsx',
    'renderer/modules/ExportCenter/index.jsx',
    'renderer/modules/CatalogStudio/index.jsx',
    'renderer/modules/CatalogStudio/DesignControls.jsx',
    'renderer/modules/SocialGrid/index.jsx',
    'renderer/modules/OverlayStudio/TemplateEditor.jsx',
  ];
  for (const file of files) {
    const src = read(file);
    assert.match(src, /s\.allProducts/, `${file} reads allProducts`);
    assert.doesNotMatch(src, /useAppStore\(\(s\) => s\.products\)/, `${file} still reads the filtered list`);
  }
});

/* ── B / C. searchable product pickers, dialog-aware shortcuts ────────── */

test('"Preview against" and "Preview with" are the searchable ProductCombobox', () => {
  for (const file of ['renderer/modules/OverlayStudio/TemplateEditor.jsx', 'renderer/modules/LabelStudio/LabelTemplates.jsx']) {
    const src = read(file);
    assert.match(src, /import \{ ProductCombobox \} from '\.\.\/AIStudio\/ProductCombobox\.jsx'/, file);
    assert.match(src, /<ProductCombobox/, file);
  }
  assert.match(read('renderer/modules/AIStudio/index.jsx'), /import \{ ProductCombobox \} from '\.\/ProductCombobox\.jsx'/);
});

test('designer shortcuts stand down while a modal dialog is open', () => {
  for (const file of [
    'renderer/modules/OverlayStudio/TemplateEditor.jsx',
    'renderer/modules/OverlayStudio/EditorCanvas.jsx',
    'renderer/modules/LabelStudio/LabelTemplates.jsx',
  ]) {
    const src = read(file);
    assert.match(src, /\[role="dialog"\]\[aria-modal="true"\]/, file);
    assert.match(src, /dialogOpen\(\)\) return/, file);
  }
});

test('the label layer rename no longer uses window.prompt', () => {
  assert.doesNotMatch(read('renderer/modules/LabelStudio/LabelTemplates.jsx'), /window\.prompt/);
  assert.match(read('renderer/modules/LabelStudio/DesignerLayers.jsx'), /function LayerRename/);
});

test('price-group tokens get insert chips; built-ins and unusable keys are skipped', () => {
  const { priceGroupTokens } = loadEsm('renderer/modules/OverlayStudio/elementDefaults.js');
  assert.deepEqual(priceGroupTokens([
    { key: 'VIP', label: 'VIP' }, { key: 'retail', label: 'Retail' }, { key: 'riel', label: '' },
    { key: 'has space', label: 'Bad' }, { key: 'vip', label: 'Dup' },
  ]), [{ token: '{price_vip}', label: 'VIP' }, { token: '{price_riel}', label: 'riel' }]);
  assert.deepEqual(priceGroupTokens(undefined), []);
});

/* ── C. number fields commit on blur, not on every keystroke ─────────── */

test('a cleared number field is thrown away, not committed as 0', () => {
  const { parseNumberDraft } = loadEsm('renderer/modules/LabelStudio/NumberField.jsx');
  assert.equal(parseNumberDraft(''), null);
  assert.equal(parseNumberDraft('  '), null);
  assert.equal(parseNumberDraft('abc'), null);
  assert.equal(parseNumberDraft('12.5'), 12.5);
  assert.equal(parseNumberDraft('0', { min: 5 }), 5);
  assert.equal(parseNumberDraft('700', { max: 500 }), 500);
  assert.equal(parseNumberDraft('2.6', { integer: true }), 3);
  const designer = read('renderer/modules/LabelStudio/LabelTemplates.jsx');
  assert.doesNotMatch(designer, /onChange=\{\(e\) => (set\('(x|y|width|height|rotation|fontSize)'|change\(\{ (widthMm|heightMm))/);
  const generate = read('renderer/modules/LabelStudio/LabelGenerate.jsx');
  assert.doesNotMatch(generate, /Number\(e\.target\.value\)/);
});

/* ── C. Khmer line height: designer and print agree ──────────────────── */

test('Khmer text gets 1.45 line height in the label designer AND the printed label', () => {
  const studio = require('../main/studioRenderer');
  const fields = loadEsm('renderer/modules/LabelStudio/labelFields.js');
  const cases = [
    [{}, 'Kettle 2L'], [{}, 'កំសៀវ ២លីត្រ'], [{}, 'SKU ក'], [{ lineHeight: 1.2 }, 'កំសៀវ'],
    [{ lineHeight: 0 }, 'ABC'], [{}, ''], [{}, null],
  ];
  for (const [el, text] of cases) {
    assert.equal(fields.labelLineHeight(el, text), studio.labelLineHeight(el, text), `${JSON.stringify(el)} ${text}`);
  }
  assert.equal(studio.labelLineHeight({}, 'កំសៀវ'), 1.45);
  assert.equal(studio.labelLineHeight({}, 'Kettle'), 1.15);
  assert.equal(studio.labelLineHeight({ lineHeight: 1.3 }, 'កំសៀវ'), 1.3, 'an explicit template value wins');
});

test('the printed label uses the Khmer line height', async () => {
  const studio = require('../main/studioRenderer');
  const html = await studio.labelsDocument({
    template: { widthMm: 50, heightMm: 30, elements: [{ id: 'n', type: 'text', field: 'name', x: 0, y: 0, width: 40, height: 10 }] },
    products: [{ id: 'p', sku: 'S', name: 'កំសៀវ អគ្គិសនី ២លីត្រ' }],
  });
  assert.match(html, /line-height:1\.45/);
});

test('overlay text: editor box and export agree on the Khmer line height', () => {
  const { overlayLineEm } = require('../main/templateRenderer');
  const editor = loadEsm('renderer/modules/OverlayStudio/elementDefaults.js');
  for (const text of ['SKU-1', 'កំសៀវ', '', 'Price ៛4,000']) {
    assert.equal(editor.overlayLineEm(text), overlayLineEm(text), text);
  }
  assert.equal(overlayLineEm('កំសៀវ'), 1.45);
  assert.equal(overlayLineEm('SKU-1'), 1.15);
});

/* ── C. Generate & Print picker + remembered settings ────────────────── */

test('the label picker matches every word across SKU, name and barcode, within brand/category', () => {
  const { filterLabelProducts } = loadEsm('renderer/modules/LabelStudio/labelGenerateState.js');
  const products = [
    { id: 'a', sku: 'BF-M1611-CH', name: 'កំសៀវ Chrome', barcode: '885000111', brandId: 'b1', categoryId: 'c1' },
    { id: 'b', sku: 'BF-M1700', name: 'Pan', barcode: '885000222', brandId: 'b2', categoryId: null },
    { id: 'c', sku: 'ZZ-1', name: 'Pot', barcode: null, brandId: null, categoryId: 'c1' },
  ];
  const ids = (opts) => filterLabelProducts(products, opts).map((p) => p.id);
  assert.deepEqual(ids({ search: 'bf 1611' }), ['a']);
  assert.deepEqual(ids({ search: 'កំសៀវ chrome' }), ['a']);
  assert.deepEqual(ids({ search: '885000222' }), ['b']);
  assert.deepEqual(ids({ brandId: 'b2' }), ['b']);
  assert.deepEqual(ids({ brandId: '__none' }), ['c']);
  assert.deepEqual(ids({ categoryId: 'c1', search: 'bf' }), ['a']);
  assert.deepEqual(ids({ categoryId: '__none' }), ['b']);
});

test('remembered label settings survive only in a well-formed shape', () => {
  const { cleanGenerateSettings } = loadEsm('renderer/modules/LabelStudio/labelGenerateState.js');
  assert.deepEqual(cleanGenerateSettings({
    outputFolder: '/Users/x/Labels', format: 'png', mode: 'sheet', pageSize: 'Letter', orientation: 'landscape',
    marginMm: 6, gapMm: '2', printer: 'Zebra', junk: 1,
  }), { outputFolder: '/Users/x/Labels', printer: 'Zebra', format: 'png', mode: 'sheet', pageSize: 'Letter', orientation: 'landscape', marginMm: 6, gapMm: 2 });
  assert.deepEqual(cleanGenerateSettings({ format: 'gif', marginMm: -3, gapMm: 999, pageSize: 'A3' }), {});
  assert.deepEqual(cleanGenerateSettings(null), {});
});

test('the live label preview is centred on screen without touching the print document', () => {
  const { centerPreviewHtml } = loadEsm('renderer/modules/LabelStudio/labelGenerateState.js');
  const doc = '<!doctype html><html><head><style>x{}</style></head><body><section class="label"></section></body></html>';
  const centred = centerPreviewHtml(doc);
  assert.match(centred, /justify-content:center/);
  assert.ok(centred.indexOf('justify-content') < centred.indexOf('</head>'));
  assert.equal(centerPreviewHtml(''), '');
});

/* ── D. readable, Khmer-preserving output names ──────────────────────── */

test('catalog / label output names keep Khmer and carry a readable date', () => {
  const { outputBaseName, readableStamp, freeOutputPath } = require('../main/util/outputNames');
  const d = new Date(2026, 9, 8, 14, 32, 5);
  assert.equal(readableStamp(d), '2026-10-08-1432');
  assert.equal(outputBaseName('តារាងតម្លៃ ២០២៦', 'catalog', d), 'តារាងតម្លៃ-២០២៦-2026-10-08-1432');
  assert.equal(outputBaseName('', 'catalog', d), 'catalog-2026-10-08-1432');
  const taken = new Set(['/out/a.pdf', '/out/a-2.pdf']);
  assert.equal(freeOutputPath('/out', 'a', 'pdf', (p) => taken.has(p)), '/out/a-3.pdf');
  for (const file of ['main/ipc/catalogStudio.js', 'main/ipc/labels.js']) {
    assert.doesNotMatch(read(file), /slugify\([^)]*\)\}-\$\{Date\.now\(\)\}/, `${file} still names files with a raw timestamp`);
  }
  assert.match(read('main/ipc/templates.js'), /const tpl = slugifyUnicode\(template\.name/);
});

/* ── D. catalog preview payload ──────────────────────────────────────── */

test('a catalog preview asks for 640 px thumbnails and can hand its fonts back separately', () => {
  const studio = require('../main/studioRenderer');
  {
    const project = { name: 'C', config: { selectionMode: 'explicit', productIds: ['p'] } };
    const products = [{ id: 'p', sku: 'S', name: 'កំសៀវ', mainImagePath: null, updatedAt: 1 }];
    const fonts = {};
    const html = studio.buildCatalogHtml({ project, products }, { preview: true, fontsOut: fonts });
    assert.ok(!html.includes('@font-face'), 'fonts are not inlined when the caller takes them');
    if (fonts.key) {
      assert.match(fonts.css, /@font-face\{font-family:"MS Noto Khmer"/);
      assert.match(fonts.key, /MS Noto Khmer:400/);
    }
    // Without fontsOut the document is exactly as before.
    const inline = studio.buildCatalogHtml({ project, products }, { preview: true });
    if (fonts.key) assert.ok(inline.includes(fonts.css));
  }
  assert.match(read('main/studioRenderer.js'), /previewImageSrc\(p\.mainImagePath, p\.updatedAt, 640\)/);
});

test('the renderer turns the server font CSS into faces once', () => {
  const fonts = loadEsm('renderer/modules/CatalogStudio/previewFonts.js');
  const css = '@font-face{font-family:"MS Noto Khmer";src:url(data:font/ttf;base64,AAEC) format("truetype");font-weight:400;font-style:normal}'
    + '@font-face{font-family:"MS Noto";src:url(data:font/ttf;base64,AAED) format("truetype");font-weight:700;font-style:normal}';
  assert.deepEqual(fonts.parseFontFaceCss(css), [
    { family: 'MS Noto Khmer', base64: 'AAEC', weight: '400' },
    { family: 'MS Noto', base64: 'AAED', weight: '700' },
  ]);
  assert.equal(fonts.previewFontsKey(), '');
  assert.equal(fonts.rememberPreviewFonts({ fontsKey: 'k1', fontsCss: css }), 'k1');
  assert.equal(fonts.previewFontsKey(), 'k1');
  // A later response without CSS keeps the remembered set.
  assert.equal(fonts.rememberPreviewFonts({ fontsKey: 'k1' }), 'k1');
  assert.equal(fonts.previewFontsKey(), 'k1');
});

/* ── E / G. Export Center ────────────────────────────────────────────── */

test('"Ready" means the same thing on the badge and the Ready-only button', () => {
  const { exportReadiness, isExportReady } = loadEsm('renderer/modules/ExportCenter/exportCenterState.js');
  assert.equal(exportReadiness({ imageCount: 0 }), 'none');
  assert.equal(exportReadiness({ imageCount: 3, processedImageCount: 3 }), 'ready');
  assert.equal(exportReadiness({ imageCount: 3, processedImageCount: 1 }), 'mixed');
  assert.equal(exportReadiness({ imageCount: 3, processedImageCount: 0, processStatus: 'done' }), 'raw',
    'a stale processStatus no longer makes a raw product "ready"');
  assert.equal(isExportReady({ imageCount: 2, processedImageCount: 2, processStatus: 'raw' }), true);
  const src = read('renderer/modules/ExportCenter/index.jsx');
  assert.match(src, /filteredProducts\.filter\(isExportReady\)/);
  assert.match(src, /useState\(50\)/, 'queue page size defaults to 50 (§10)');
});

test('export image scope: main only, first N, all — and {INDEX} keeps the real position', () => {
  const { normalizeExportScope, scopedImages } = require('../main/exportRunner');
  const images = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const pick = (scope) => scopedImages(images, scope).map(({ img, i }) => `${img.id}${i}`);
  assert.deepEqual(pick(null), ['a0', 'b1', 'c2', 'd3'], 'nothing sent = every image, as before');
  assert.deepEqual(pick({ mode: 'main' }), ['a0']);
  assert.deepEqual(pick({ mode: 'first', count: 2 }), ['a0', 'b1']);
  assert.deepEqual(pick({ mode: 'first', count: 9 }), ['a0', 'b1', 'c2', 'd3']);
  assert.deepEqual(normalizeExportScope({ mode: 'first', count: 0 }), { mode: 'all', count: null });
  assert.deepEqual(normalizeExportScope({ mode: 'first', count: 400 }), { mode: 'first', count: 50 });
  assert.deepEqual(scopedImages([], { mode: 'main' }), []);
  const ui = loadEsm('renderer/modules/ExportCenter/exportCenterState.js');
  assert.deepEqual(ui.normalizeImageScope({ mode: 'first', count: '3' }), { mode: 'first', count: 3 });
  assert.equal(ui.imageScopeLabel({ mode: 'main' }), 'main image only');
});

test('"save to library" adds back only the main image export', () => {
  const runner = read('main/exportRunner.js');
  assert.match(runner, /if \(toLibrary && i === 0\) \{/);
});

test('validators: image scope and the reveal channel', () => {
  const { getValidator } = require('../main/server/validators');
  const run = getValidator('exports:run');
  assert.equal(run({ profileId: 'p', imageScope: { mode: 'first', count: 3 } }), true);
  assert.equal(run({ profileId: 'p' }), true);
  assert.match(String(run({ profileId: 'p', imageScope: { mode: 'first', count: 0 } })), /count/);
  assert.match(String(run({ profileId: 'p', imageScope: { mode: 'odd' } })), /mode/);
  assert.equal(getValidator('exports:runForClient')({ profileId: 'p', productIds: [], imageScope: { mode: 'main' } }), true);
  assert.equal(getValidator('exports:expectedOutputs')({ profileId: 'p', productIds: [], imageScope: { mode: 'all' } }), true);
  const reveal = getValidator('files:revealPath');
  assert.equal(reveal(os.tmpdir()), true);
  assert.notEqual(reveal('relative/path'), true);
  assert.notEqual(reveal(path.join(os.tmpdir(), 'msk-definitely-missing-9f2c1')), true);
  assert.notEqual(reveal(null), true);
  assert.equal(getValidator('catalogStudio:preview')({ id: 'x', fontsKey: 'MS Noto:400#12' }), true);
  assert.notEqual(getValidator('catalogStudio:preview')({ id: 'x', fontsKey: 5 }), true);
});

test('files:revealPath is local-only, in preload, and handled on the client Mac', () => {
  assert.match(read('main/ipc/files.js'), /exposeLocal\('files:revealPath'/);
  assert.match(read('main/preload.js'), /revealPath:\s*\(absPath\)\s*=> invoke\('files:revealPath', absPath\)/);
  assert.match(read('main/client/index.js'), /handleLocal\('files:revealPath'/);
  assert.doesNotMatch(read('main/ipc/files.js'), /\bexpose\('files:revealPath'/);
});

/* ── E. Social Grid ──────────────────────────────────────────────────── */

test('Social Grid shows real export progress, not a timer', () => {
  const src = read('renderer/modules/SocialGrid/index.jsx');
  assert.doesNotMatch(src, /setInterval\(\(\) => setProgress/);
  assert.match(src, /ev\?\.kind !== 'socialGrid'/);
  const { socialExportProgress } = loadEsm('renderer/modules/SocialGrid/index.jsx');
  assert.deepEqual(socialExportProgress({ done: 0, total: 4 }), { progress: 5, detail: 'Image 1 of 4' });
  assert.deepEqual(socialExportProgress({ done: 4, total: 4 }), { progress: 95, detail: 'Image 4 of 4' });
  assert.deepEqual(socialExportProgress({}), { progress: 5, detail: '' });
});

test('the bulk Social Grid run cannot be closed by Esc or the backdrop mid-run', () => {
  const src = read('renderer/modules/ProductLibrary/BulkSocialRunModal.jsx');
  assert.match(src, /onClose=\{submitting \? undefined : onClose\}/);
  assert.match(src, /closeOnBackdrop=\{!submitting\}/);
});

/* ── F. AI Studio promote ────────────────────────────────────────────── */

test('Promote names its target and never promotes a row the search hid', () => {
  const src = read('renderer/modules/AIStudio/PromoteToProductDialog.jsx');
  assert.match(src, /`Promote to \$\{target\.sku\}`/);
  assert.match(src, /setSelectedId\(filtered\[0\]\?\.id \?\? null\)/);
  assert.match(src, /targetProductId: target\.id/);
  const css = read('renderer/index.css');
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) 360px;/);
});

/* ── perf: overlay preview base cache + JPEG previews ────────────────── */

test('an opaque overlay preview comes back as JPEG and reuses its decoded base', async () => {
  const sharp = require('sharp');
  const tr = require('../main/templateRenderer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-ovl-prev-'));
  const photo = path.join(dir, 'p.jpg');
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#8899aa' } }).jpeg().toFile(photo);
  const template = { canvasWidth: 2000, canvasHeight: 2000, elements: [{ id: 't', type: 'text', content: 'SKU', x: 0.1, y: 0.1, font: { size: 64 } }] };
  const preview = await tr.composeDetailed({ inputImage: photo, template, maxPx: 600, previewJpeg: true });
  assert.equal(preview.mime, 'image/jpeg');
  assert.equal((await sharp(preview.bytes).metadata()).format, 'jpeg');
  const again = await tr.composeDetailed({ inputImage: photo, template, maxPx: 600, previewJpeg: true });
  assert.equal(again.width, preview.width);
  // Full size (every export) is untouched: PNG.
  const full = await tr.composeDetailed({ inputImage: photo, template });
  assert.equal(full.mime, 'image/png');
  // Without the flag a preview is PNG as before.
  const png = await tr.composeDetailed({ inputImage: photo, template, maxPx: 600 });
  assert.equal(png.mime, 'image/png');
});
