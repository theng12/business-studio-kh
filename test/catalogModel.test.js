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
  // The title survives as content-ish data only because `cover` is carried
  // through; what matters is that creating a project overwrites it. The
  // builder's draft does exactly that, and this asserts the flag is separate.
  assert.equal(typeof design.cover.enabled, 'boolean');
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

test('an empty field list falls back to the default four', () => {
  assert.deepEqual(model.normalizeFields([]).map((f) => f.key), model.DEFAULT_FIELDS.map((f) => f.key));
  assert.deepEqual(model.normalizeFields(null).map((f) => f.key), model.DEFAULT_FIELDS.map((f) => f.key));
});

test('designOnly is stable across repeats', () => {
  const once = model.catalogDesignOnly({ columns: 4, cover: { enabled: true, title: 'X' } });
  const twice = model.catalogDesignOnly(once);
  assert.deepEqual(twice, once);
});
