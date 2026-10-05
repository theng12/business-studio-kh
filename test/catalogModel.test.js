/**
 * v0.1.63: the catalog design/selection split the template builder is built on.
 *
 * The customer's report was "we can't build a template for the catalog too — it
 * doesn't have a builder at all". The part that can silently break the feature
 * once it exists is the split: a template must keep the LOOK and drop every way
 * of choosing products, or creating a catalog from it would drag in the
 * products the template happened to be designed against.
 *
 * Also pins the main↔renderer parity of the card-field list (main is CommonJS,
 * the renderer mirror is ESM), the same way test/currencies.test.js does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const model = require('../main/util/catalogModel');

const ROOT = path.join(__dirname, '..');

function loadRendererCatalogDesign() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/lib/catalogDesign.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test('renderer card-field list matches the main-process list exactly', () => {
  const renderer = loadRendererCatalogDesign();
  assert.deepEqual(renderer.CATALOG_FIELD_KEYS, model.CATALOG_FIELD_KEYS,
    'the two card-field lists have drifted apart');
});

test('renderer design defaults match the main-process defaults', () => {
  const renderer = loadRendererCatalogDesign();
  assert.deepEqual(renderer.CATALOG_DESIGN_DEFAULTS.fields, model.DESIGN_DEFAULTS.fields,
    'the default card fields have drifted apart — a blank template would print different rows than a blank project');
  for (const key of Object.keys(renderer.CATALOG_DESIGN_DEFAULTS)) {
    assert.deepEqual(renderer.CATALOG_DESIGN_DEFAULTS[key], model.DESIGN_DEFAULTS[key],
      `DESIGN_DEFAULTS.${key} differs between main and the renderer mirror`);
  }
});

test('a blank template draft is a complete design, not an empty one', () => {
  const renderer = loadRendererCatalogDesign();
  const blank = renderer.blankCatalogDesign();
  assert.deepEqual(blank.fields.map((f) => f.key), model.DEFAULT_FIELDS.map((f) => f.key),
    'a new template would start with no card fields');
  assert.equal(blank.columns, model.DESIGN_DEFAULTS.columns);
  // And it must be a copy: editing one draft must not change the next.
  blank.fields[0].label = 'mutated';
  assert.notEqual(renderer.blankCatalogDesign().fields[0].label, 'mutated');
});

test('designOnly keeps the look and drops every way of choosing products', () => {
  const design = model.catalogDesignOnly({
    pageSize: 'Letter', orientation: 'landscape', columns: 5, gapMm: 3, marginMm: 18,
    groupBy: 'brand', sortBy: 'name', theme: 'retail',
    primaryColor: '#7c2d12', accentColor: '#f97316',
    priceGroup: 'wholesale', currencySymbol: '៛', coverEnabled: false,
    selectionMode: 'all', productIds: ['p1'], brandIds: ['b1'], categoryIds: ['c1'],
  });
  assert.equal(design.pageSize, 'Letter');
  assert.equal(design.columns, 5);
  assert.equal(design.theme, 'retail');
  assert.equal(design.priceGroup, 'wholesale');
  assert.equal(design.currencySymbol, '៛');
  assert.equal(design.coverEnabled, false);
  assert.equal(design.cover.enabled, false, 'the renderer reads cover.enabled, so both shapes must agree');
  for (const key of model.CATALOG_SELECTION_KEYS) {
    assert.deepEqual(design[key], model.SELECTION_DEFAULTS[key], `designOnly kept "${key}"`);
  }
});

test('applyDesign puts a selection under a saved look', () => {
  const design = model.catalogDesignOnly({ columns: 2, theme: 'minimal', sortBy: 'sku' });
  const config = model.applyCatalogDesign(design, { selectionMode: 'explicit', productIds: ['p9'] });
  assert.equal(config.columns, 2);
  assert.equal(config.theme, 'minimal');
  assert.equal(config.sortBy, 'sku');
  assert.deepEqual(config.productIds, ['p9']);
  assert.deepEqual(config.brandIds, [], 'no brand filter leaks in from the template');
});

test('cover text is per catalog: a template keeps enabled, not the title', () => {
  const design = model.catalogDesignOnly({ cover: { enabled: true, title: 'Summer 2026', subtitle: 'Wholesale' } });
  assert.equal(design.coverEnabled, true);
  assert.deepEqual(design.cover, { enabled: true });
  assert.equal(model.normalizeCatalogConfig({ cover: { title: 'Summer' } }).cover.title, 'Summer');
});

test('clamping protects the renderer from unusable stored values', () => {
  const c = model.normalizeCatalogConfig({ columns: 99, gapMm: -4, marginMm: 900, pageSize: 'A3', orientation: 'sideways', theme: 'neon', sortBy: 'vibes', groupBy: 'colour' });
  assert.equal(c.columns, 5);
  assert.equal(c.gapMm, 0);
  assert.equal(c.marginMm, 60);
  assert.equal(c.pageSize, 'A4');
  assert.equal(c.orientation, 'portrait');
  assert.equal(c.theme, 'modern');
  assert.equal(c.sortBy, 'manual');
  assert.equal(c.groupBy, 'none');
});

test('card fields keep known keys, custom fields and named price groups', () => {
  const fields = model.normalizeFields([
    { key: 'sku' },
    { key: 'sku', label: 'duplicate' },          // dropped
    { key: 'nope' },                              // dropped
    { key: 'custom.size', label: 'Size' },        // kept
    { key: 'price.export', label: 'Export' },     // kept
    { key: 'description', visible: false },
  ]);
  assert.deepEqual(fields.map((f) => f.key), ['sku', 'custom.size', 'price.export', 'description']);
  assert.equal(fields[0].label, 'sku', 'a field with no label falls back to its key');
  assert.equal(fields[3].visible, false);
});

test('an explicit empty field list remains photo-only; missing or invalid lists get defaults', () => {
  assert.deepEqual(model.normalizeFields([]), []);
  assert.deepEqual(model.normalizeFields([{ key: 'unknown' }]).map((f) => f.key), model.DEFAULT_FIELDS.map((f) => f.key));
  assert.deepEqual(model.normalizeFields(null).map((f) => f.key), model.DEFAULT_FIELDS.map((f) => f.key));
});

test('designOnly is stable across repeats', () => {
  const once = model.catalogDesignOnly({ columns: 4, cover: { enabled: true, title: 'X' } });
  const twice = model.catalogDesignOnly(once);
  assert.deepEqual(twice, once);
});


test('print controls normalize bounds and keep intentional zero/false values', () => {
  const c = model.normalizeCatalogConfig({ layoutMode: 'list', showImages: false, imageHeightMm: 2,
    imageFit: 'cover', cardPaddingMm: 0, fontSizePt: 8.5, boldFontSizePt: 50, showBrand: false,
    headerText: 'x'.repeat(250), footerText: 42, pageNumbers: true,
    fields: [{ key: 'name', align: 'center' }, { key: 'sku', align: 'right' }, { key: 'price', align: 'oops' }] });
  assert.equal(c.layoutMode, 'list');
  assert.equal(c.showImages, false);
  assert.equal(c.imageHeightMm, 10);
  assert.equal(c.imageFit, 'cover');
  assert.equal(c.cardPaddingMm, 0);
  assert.equal(c.fontSizePt, 8.5);
  assert.equal(c.boldFontSizePt, 32);
  assert.equal(c.showBrand, false);
  assert.equal(c.headerText.length, 200);
  assert.equal(c.footerText, '');
  assert.equal(c.pageNumbers, true);
  assert.deepEqual(c.fields.map(f => f.align), ['center', 'right', 'left']);
  assert.equal(model.normalizeCatalogConfig({ imageHeightMm: 0 }).imageHeightMm, 0);
  const fallback = model.normalizeCatalogConfig({ layoutMode: 'bad', imageFit: 'bad', fontSizePt: 'bad', imageHeightMm: 'bad' });
  assert.equal(fallback.layoutMode, 'cards');
  assert.equal(fallback.imageFit, 'contain');
  assert.equal(fallback.fontSizePt, 8.5);
  assert.equal(fallback.imageHeightMm, 0);
});

test('PDF page templates escape text, omit implicit browser headers and reserve space at zero margin', () => {
  const plain = model.catalogPdfOptions({ marginMm: 0 });
  assert.equal(plain.displayHeaderFooter, false);
  assert.deepEqual(plain.margins, { top: 0, bottom: 0, left: 0, right: 0 });
  const c = model.catalogPdfOptions({ pageSize: 'Letter', orientation: 'landscape', marginMm: 0,
    headerText: '<script>unsafe</script>', footerText: 'A & B', pageNumbers: true });
  assert.equal(c.pageSize, 'Letter');
  assert.equal(c.orientation, 'landscape');
  assert.equal(c.displayHeaderFooter, true);
  assert.match(c.headerTemplate, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(c.headerTemplate, /<script>/);
  assert.match(c.footerTemplate, /A &amp; B/);
  assert.match(c.footerTemplate, /class="pageNumber"/);
  assert.match(c.footerTemplate, /class="totalPages"/);
  assert.ok(c.margins.top >= 8 / 25.4);
  assert.ok(c.margins.bottom >= 8 / 25.4);
  assert.match(model.catalogPdfOptions({ headerText: 'Only header' }).footerTemplate, /<div[^>]*><\/div>/);
});
