/**
 * Label Studio + Catalog Studio review fixes (2026-10-02).
 *
 * Pure rules first — label price format, catalog selection, the trailing-space
 * rule, Run again, the image capture size — then static wiring checks for the
 * confirms and the catalog print channel, which `npm test` cannot mount.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadEsm(rel) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const studio = require('../main/studioRenderer');

const PRODUCT = {
  id: 'p1', sku: 'SKU-1', name: 'Kettle', status: 'active',
  priceRetail: 1234.5, priceRetailCurrency: 'USD',
  priceWholesale: '12.5', priceWholesaleCurrency: null,
  prices: { vip: { amount: 1234.5, currency: 'USD' }, dealer: 55, riel: { amount: 41000, currency: 'KHR' } },
};

/* ── 1. label prices: one bare format for every price field ─────────── */

test('retail, wholesale and group prices print as the same bare number on a label', () => {
  assert.equal(studio.productValue(PRODUCT, 'priceRetail'), '1,234.50');
  assert.equal(studio.productValue(PRODUCT, 'priceWholesale'), '12.50', 'a raw "12.5" column is formatted, not printed raw');
  assert.equal(studio.productValue(PRODUCT, 'price.vip'), '1,234.50', 'a group carries no "$" of its own any more');
  assert.equal(studio.productValue(PRODUCT, 'price.dealer'), '55.00', 'the legacy bare-number group shape too');
  assert.equal(studio.productValue(PRODUCT, 'price.riel'), '41,000', 'riel has no decimals — the app-wide currency rule');
  assert.equal(studio.productValue(PRODUCT, 'price.missing'), '', 'a blank price stays blank');
  assert.equal(studio.productValue({ priceRetail: null }, 'priceRetail'), '');
  assert.equal(studio.productValue(PRODUCT, 'sku'), 'SKU-1', 'non-price fields are untouched');
});

test('the designer canvas mirror formats exactly like the printer', () => {
  const fields = loadEsm('renderer/modules/LabelStudio/labelFields.js');
  const prices = loadEsm('renderer/lib/prices.js');
  for (const field of ['priceRetail', 'priceWholesale', 'price.vip', 'price.dealer', 'price.riel', 'price.missing']) {
    const source = fields.labelPriceSource(field);
    assert.ok(source, `${field} is a price field`);
    assert.equal(fields.labelPriceAmount(prices.priceEntry(PRODUCT, source)), studio.productValue(PRODUCT, field),
      `canvas and printer disagree about ${field}`);
  }
  assert.equal(fields.labelPriceSource('name'), null);
});

test('a label applies the template prefix/suffix once — no "$$"', async () => {
  const html = await studio.labelsDocument({
    template: {
      widthMm: 50, heightMm: 30,
      elements: [
        { id: 'a', type: 'price', field: 'priceRetail', prefix: '$', x: 0, y: 0, width: 40, height: 8 },
        { id: 'b', type: 'price', field: 'price.vip', prefix: '$', x: 0, y: 10, width: 40, height: 8 },
        { id: 'c', type: 'text', field: 'price.riel', suffix: ' ៛', x: 0, y: 20, width: 40, height: 8 },
      ],
    },
    products: [PRODUCT],
  });
  assert.equal((html.match(/>\$1,234\.50</g) || []).length, 2, 'retail and the group print identically');
  assert.doesNotMatch(html, /\$\$/);
  assert.match(html, />41,000 ៛</);
  const cleared = await studio.labelsDocument({
    template: { widthMm: 50, heightMm: 30, elements: [{ id: 'm', type: 'text', field: 'sku', manualValue: '', x: 0, y: 0, width: 40, height: 8 }] },
    products: [PRODUCT],
  });
  assert.match(cleared, />SKU-1</, 'a cleared Manual text box falls back to the product field, as the canvas shows');
});

test('starter templates keep their "$" prefix, and the Inspector edits prefix/suffix', () => {
  const starters = read('main/db/labelTemplates.js');
  assert.equal((starters.match(/field: 'priceRetail'[^}]*prefix: '\$'/g) || []).length, 2);
  const designer = read('renderer/modules/LabelStudio/LabelTemplates.jsx');
  assert.match(designer, /<label>Prefix<Input value=\{element\.prefix \|\| ''\}/);
  assert.match(designer, /<label>Suffix<Input value=\{element\.suffix \|\| ''\}/);
});

/* ── catalog prices keep the catalog's own (currency) format ────────── */

test('catalog card price fields print with their currency, like the main Price row', () => {
  const html = studio.buildCatalogHtml({
    project: { name: 'C', config: { currencySymbol: '$', fields: [
      { key: 'price', label: 'Price' }, { key: 'price.vip', label: 'VIP' },
      { key: 'price.riel', label: 'Riel' }, { key: 'price.dealer', label: 'Dealer' },
    ] } },
    products: [PRODUCT],
  });
  assert.match(html, /<span>Price<\/span>\$1,234\.50/);
  assert.match(html, /<span>VIP<\/span>\$1,234\.50/);
  assert.match(html, /<span>Riel<\/span>៛41,000/);
  assert.match(html, /<span>Dealer<\/span>\$55/, 'a legacy group falls back to the catalog currency symbol');
});

/* ── 9. catalog copy and print CSS ──────────────────────────────────── */

test('the catalog cover counts in proper English and fills the page', () => {
  const one = studio.buildCatalogHtml({ project: { name: 'C', config: {} }, products: [PRODUCT] });
  assert.match(one, /class="cover-count">1 product</);
  const two = studio.buildCatalogHtml({ project: { name: 'C', config: {} }, products: [PRODUCT, { ...PRODUCT, id: 'p2' }] });
  assert.match(two, /class="cover-count">2 products</);
  // In print, 100vh is already the page's content box (measured): the cover
  // must not subtract the margins a second time.
  assert.match(one, /\.cover\{height:100vh;/);
  assert.doesNotMatch(one, /100vh - 20mm/);
  assert.match(studio.buildCatalogHtml({ project: { name: 'C', config: { marginMm: 15 } }, products: [] }), /margin:15mm\}/);
});

test('catalog section headings stay with their products', () => {
  const html = studio.buildCatalogHtml({
    project: { name: 'C', config: { groupBy: 'brand' } }, products: [{ ...PRODUCT, brandId: 'b' }],
    brands: [{ id: 'b', name: 'Brand' }],
  });
  const rule = html.match(/\.section-title\{[^}]*\}/)[0];
  assert.match(rule, /break-after:avoid/);
  assert.match(rule, /break-inside:avoid/);
});

/* ── 3. catalog edits keep inactive products ─────────────────────────── */

test('a catalog edit keeps inactive ids where they were', () => {
  const sel = loadEsm('renderer/modules/CatalogStudio/catalogSelection.js');
  const products = ['a', 'h', 'b', 'c'].map((id) => ({ id, sku: id.toUpperCase(), status: id === 'h' ? 'inactive' : 'active' }));
  const config = { selectionMode: 'explicit', productIds: ['a', 'h', 'b', 'c', 'gone'] };
  const lists = sel.catalogIdLists(config, products);
  assert.deepEqual(lists.includedIds, ['a', 'b', 'c'], 'only active products print');
  assert.deepEqual(lists.hiddenIds, ['h', 'gone']);

  // Remove B, move C up, add D: the inactive H keeps its slot every time.
  assert.deepEqual(sel.mergeCatalogIds(lists.storedIds, ['a', 'c'], lists.hiddenIds), ['a', 'h', 'c', 'gone']);
  assert.deepEqual(sel.mergeCatalogIds(lists.storedIds, ['a', 'c', 'b'], lists.hiddenIds), ['a', 'h', 'c', 'b', 'gone']);
  assert.deepEqual(sel.mergeCatalogIds(lists.storedIds, ['a', 'b', 'c', 'd'], lists.hiddenIds), ['a', 'h', 'b', 'c', 'gone', 'd']);
  assert.deepEqual(sel.mergeCatalogIds(lists.storedIds, [], lists.hiddenIds), ['h', 'gone'], 'removing the shown ones keeps the hidden ones');
  // Dropping one hidden id on purpose (its own Remove button).
  assert.deepEqual(sel.mergeCatalogIds(lists.storedIds, lists.includedIds, ['gone']), ['a', 'b', 'c', 'gone']);

  // "All active products" (no stored list) has nothing hidden to keep.
  const all = sel.catalogIdLists({ selectionMode: 'all', productIds: [] }, products);
  assert.deepEqual(all.includedIds, ['a', 'b', 'c']);
  assert.deepEqual(sel.mergeCatalogIds(all.storedIds, ['c', 'a'], all.hiddenIds), ['c', 'a']);
});

test('ordering helpers: move to top/bottom and the current sort as manual order', () => {
  const sel = loadEsm('renderer/modules/CatalogStudio/catalogSelection.js');
  assert.deepEqual(sel.moveToEdge(['a', 'b', 'c'], 'c', 'top'), ['c', 'a', 'b']);
  assert.deepEqual(sel.moveToEdge(['a', 'b', 'c'], 'a', 'bottom'), ['b', 'c', 'a']);
  const byId = new Map([['x', { sku: 'SKU-10', name: 'b' }], ['y', { sku: 'SKU-9', name: 'c' }], ['z', { sku: 'SKU-100', name: 'a' }]]);
  assert.deepEqual(sel.idsInSortOrder(['x', 'y', 'z'], byId, 'sku'), ['y', 'x', 'z'], 'numeric-aware, like the renderer');
  assert.deepEqual(sel.idsInSortOrder(['x', 'y', 'z'], byId, 'name'), ['z', 'x', 'y']);
});

test('the product manager wires the selection rules, a confirmed Remove all, and pagination', () => {
  const src = read('renderer/modules/CatalogStudio/index.jsx');
  assert.match(src, /mergeCatalogIds\(storedIds, visibleIds, keepHiddenIds\)/, 'every commit merges, never writes the active-only list');
  assert.doesNotMatch(src, /onClick=\{\(\) => commit\(\[\]\)\}/, 'Remove all no longer empties the catalog in one click');
  assert.match(src, /await confirm\(\{\s*title: `Remove all \$\{count\} product/, 'Remove all asks first, naming the count');
  assert.match(src, /inactive — hidden from the catalog/);
  assert.equal((src.match(/<Pagination /g) || []).length, 2, 'both product lists page (§10)');
  assert.match(src, /appImageSrc\(product\.mainImagePath, product\.contentHash \|\| product\.updatedAt, \{ w: 96 \}\)/);
});

/* ── 4. a typed trailing space survives the autosave ─────────────────── */

test('keepTypedName keeps what was typed when the server only trimmed it', () => {
  const { keepTypedName } = loadEsm('renderer/modules/LabelStudio/editorRules.js');
  const row = { id: 't', name: 'Summer', updatedAt: 2 };
  assert.deepEqual(keepTypedName({ name: 'Summer ' }, row), { ...row, name: 'Summer ' });
  assert.equal(keepTypedName({ name: 'Summer' }, row), row);
  assert.equal(keepTypedName({ name: 'Winter ' }, row), row, 'a real difference adopts the server row');
  assert.equal(keepTypedName({ name: '   ' }, { ...row, name: 'Untitled catalog' }).name, 'Untitled catalog');
  for (const file of ['renderer/modules/CatalogStudio/index.jsx', 'renderer/modules/LabelStudio/LabelTemplates.jsx']) {
    assert.match(read(file), /const adopted = keepTypedName\(value, row\);/, `${file} adopts through keepTypedName`);
  }
});

/* ── 5. Inspector edits are undoable ────────────────────────────────── */

test('Inspector edits push one history step per field edit', () => {
  const src = read('renderer/modules/LabelStudio/LabelTemplates.jsx');
  assert.match(src, /if \(inspectorEditKey\.current !== editKey\) \{ history\.push\(draft\.elements\);/);
  assert.match(src, /onChange=\{changeFromInspector\}/);
  assert.match(src, /onFocusCapture=\{onFieldFocus\}/, 'focusing a field starts a new step');
  assert.match(src, /import \{ confirm \} from '\.\.\/\.\.\/components\/ConfirmModal\.jsx';/,
    'template delete uses the app confirm, not window.confirm');
});

/* ── 6. / 7. Generate & Print ────────────────────────────────────────── */

test('Add visible merges into the selection; copies only show for PDF', () => {
  const src = read('renderer/modules/LabelStudio/LabelGenerate.jsx');
  assert.match(src, />Add visible</);
  assert.doesNotMatch(src, /setSelected\(visibleProducts\.map/, 'no longer replaces the selection');
  assert.match(src, />Clear selection</);
  assert.match(src, /\{format === 'pdf' \? <label>Copies per product/);
});

test('image labels are resized to the exact mm × dpi size with density metadata', () => {
  const original = Module._load;
  Module._load = function stub(request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: function BrowserWindow() {} };
    return original.call(this, request, parent, isMain);
  };
  let renderWindow;
  try { renderWindow = require('../main/renderWindow'); } finally { Module._load = original; }
  const { captureTarget } = renderWindow;
  assert.deepEqual(captureTarget({ width: 480, height: 320, dpi: 203 }), { width: 480, height: 320, density: 203 });
  assert.deepEqual(captureTarget({ width: 480, height: 320, zoomFactor: 203 / 96 }), { width: 480, height: 320, density: 203 },
    'client mode passes only the zoom; the density follows from it');
  assert.equal(captureTarget({}), null);
  const ipc = read('main/ipc/labels.js');
  assert.match(ipc, /const dpi = Math\.max\(72, Number\(layout\.dpi\) \|\| 203\);\s*const scale = dpi \/ 25\.4;/,
    'one dpi drives both the pixel size and the zoom');
  assert.match(read('main/renderWindow.js'), /withMetadata\(\{ density: target\.density \}\)/);
});

/* ── Run again ──────────────────────────────────────────────────────── */

test('Run again rebuilds the Generate & Print settings from a recorded run', () => {
  const { rerunFromRun } = loadEsm('renderer/modules/LabelStudio/labelRerun.js');
  const generated = rerunFromRun({
    companyId: 'c', templateId: 't', format: 'png',
    settings: { mode: 'single', pageSize: 'Letter', orientation: 'landscape', marginMm: 5, gapMm: 0, copies: 3, productIds: ['a', 'b'] },
  });
  assert.deepEqual(generated.productIds, ['a', 'b']);
  assert.equal(generated.format, 'png');
  assert.deepEqual(generated.layout, { mode: 'single', pageSize: 'Letter', orientation: 'landscape', marginMm: 5, gapMm: 0, copies: 3 });
  const printed = rerunFromRun({
    companyId: 'c', templateId: 't', format: 'print',
    settings: { layout: { mode: 'sheet', copies: 2 }, printOptions: { deviceName: 'Zebra' }, productIds: ['a'] },
  });
  assert.equal(printed.format, 'pdf');
  assert.equal(printed.printer, 'Zebra');
  assert.equal(printed.layout.copies, 2);
  assert.deepEqual(rerunFromRun({ companyId: 'c', templateId: 't', format: 'pdf', settings: {} }).productIds, [],
    'an older run without recorded products still opens');
  const ipc = read('main/ipc/labels.js');
  assert.equal((ipc.match(/productIds: products\.map\(\(p\) => p\.id\)/g) || []).length, 2, 'generate and print record their products');
  assert.match(ipc, /productIds: \(Array\.isArray\(items\) \? items : \[\]\)\.map/, 'a client-recorded run too');
});

/* ── 8. template builder ─────────────────────────────────────────────── */

test('leaving the template builder with unsaved changes asks first', () => {
  const src = read('renderer/modules/CatalogStudio/TemplateBuilder.jsx');
  assert.match(src, /if \(dirty && !\(await confirm\(/);
  assert.match(src, /onClick=\{leave\}>← Catalog templates/);
  assert.match(src, /<Button onClick=\{leave\} disabled=\{saving\}>Cancel/);
  assert.doesNotMatch(src, /onClick=\{onClose\}/);
});

/* ── catalog print: the full §15 chain ───────────────────────────────── */

test('catalogStudio:print is local-only, validated, in preload and handled in client mode', () => {
  assert.match(read('main/ipc/catalogStudio.js'), /exposeLocal\('catalogStudio:print'/);
  assert.match(read('main/server/validators.js'), /'catalogStudio:print':\s+requireNonEmptyStringFields\('id'\)/);
  assert.match(read('main/preload.js'), /print: \(id\) => invoke\('catalogStudio:print', \{ id \}\)/);
  assert.match(read('main/client/index.js'), /handleLocal\('catalogStudio:print'/);
});

/* ── card fields: price groups and custom fields ─────────────────────── */

test('the card-field list offers price groups and custom fields', () => {
  const { extraFieldRows } = loadEsm('renderer/modules/CatalogStudio/catalogSelection.js');
  const rows = extraFieldRows(
    [{ key: 'vip', label: 'VIP' }, { key: 'vip', label: 'dup' }, { key: '' }],
    [{ customFields: { Material: 'Steel', Color: 'Red' } }, { customFields: { Material: 'Oak' } }, {}],
  );
  assert.deepEqual(rows, [
    { key: 'price.vip', label: 'VIP price' },
    { key: 'custom.Color', label: 'Color' },
    { key: 'custom.Material', label: 'Material' },
  ]);
  const controls = read('renderer/modules/CatalogStudio/DesignControls.jsx');
  assert.match(controls, /extraFieldRows\(priceGroups, products \?\? \[\]\)/);
  assert.match(controls, /onClick=\{\(\) => moveField\(f\.key, -1\)\}/, 'fields reorder');
  assert.match(controls, /onChange=\{\(e\) => patchField\(f\.key, \{ label: e\.target\.value \}\)\}/, 'labels are editable');
});
