/**
 * v0.1.25 — Social Grid HTML builder.
 *
 * The rendered file is the deliverable, so the markup contract matters: an
 * exact canvas, one cell per product, a placeholder where a photo is missing,
 * and text that cannot break the document.
 *
 * These run in plain `node --test`, which is only possible because
 * main/studioRenderer.js resolves its database dependency lazily — the builder
 * needs `esc` and `embeddedFontCss` from there but has no use for SQLite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPageHtml, scaleForDensity, seriesSlug, fileNameFor } = require('../main/socialGridRenderer');
const { normalizeConfig } = require('../main/util/socialGridModel');

function product(over = {}) {
  return {
    id: over.id || 'p1',
    sku: over.sku || 'SKU-1',
    name: over.name || 'Product One',
    brandId: over.brandId ?? null,
    priceRetail: over.priceRetail ?? 12.5,
    priceWholesale: over.priceWholesale ?? null,
    prices: over.prices ?? {},
    stockQty: over.stockQty === undefined ? null : over.stockQty,
    mainImagePath: over.mainImagePath ?? null,
  };
}

function html(products, configPatch = {}, ctxPatch = {}) {
  const config = normalizeConfig(configPatch);
  return buildPageHtml({
    products,
    brands: ctxPatch.brands || [],
    config,
    pageIndex: ctxPatch.pageIndex || 0,
    pageCount: ctxPatch.pageCount || 1,
    resolveImage: ctxPatch.resolveImage || (() => ''),
  });
}

/**
 * Just the body markup, with the <style> block removed.
 *
 * Counting class names across the WHOLE document is wrong: the stylesheet
 * legitimately contains `.tile--blank{…}` and `.photo--empty{…}`, so a naive
 * `match(/tile--blank/g)` counts the CSS rule as if it were a tile. Class-name
 * assertions are about the markup, so this is what they read.
 */
function markup(document) {
  return document.slice(document.indexOf('</style>'));
}

test('the document is exactly the configured canvas size', () => {
  const out = html([product()], { width: 1080, height: 1080 });
  assert.match(out, /html,body\{width:1080px;height:1080px/);
  // Property ORDER is not the contract here (v0.1.81 added position:relative
  // for the overlay layer) — the size is.
  assert.match(out, /\.post\{[^}]*width:1080px;height:1080px/);
});

test('a portrait canvas keeps its own height rather than being forced square', () => {
  const out = html([product()], { width: 1080, height: 1350 });
  assert.match(out, /html,body\{width:1080px;height:1350px/);
});

test('the grid declares the configured number of columns and rows', () => {
  const out = html([product()], { columns: 4, rows: 2 });
  assert.match(out, /grid-template-columns:repeat\(4,/);
  assert.match(out, /grid-template-rows:repeat\(2,/);
});

test('one tile is emitted per product', () => {
  const products = [product({ id: 'a' }), product({ id: 'b' }), product({ id: 'c' })];
  const out = markup(html(products, { columns: 3, rows: 1 }));
  assert.equal((out.match(/<article class="tile">/g) || []).length, 3);
  assert.equal((out.match(/tile--blank/g) || []).length, 0);
});

test('the final page is padded with blank cells so tiles keep the same size', () => {
  // 2 products in a 3x3 grid: the remaining 7 cells must exist, or the two
  // real tiles would stretch to fill the image and look nothing like page 1.
  const out = markup(html([product({ id: 'a' }), product({ id: 'b' })], { columns: 3, rows: 3 }));
  assert.equal((out.match(/<article class="tile">/g) || []).length, 2);
  assert.equal((out.match(/<article class="tile tile--blank">/g) || []).length, 7);
});

test('a missing photo renders a placeholder, not a broken image tag', () => {
  const out = markup(html([product({ mainImagePath: null })]));
  assert.match(out, /class="photo photo--empty"/);
  assert.doesNotMatch(out, /<img/);
});

test('a product photo is inlined as a data URI from the resolver', () => {
  const out = markup(html([product({ mainImagePath: 'brand/p1.jpg' })], {}, {
    resolveImage: (p) => (p ? 'data:image/jpeg;base64,AAAA' : ''),
  }));
  assert.match(out, /<img src="data:image\/jpeg;base64,AAAA"/);
  assert.doesNotMatch(out, /photo--empty/);
});

test('tile text is escaped so a product name cannot inject markup', () => {
  const nasty = product({ name: '<img src=x onerror="alert(1)">', sku: 'A&B"<C>' });
  const out = markup(html([nasty], { showName: true, showSku: true }));
  // The dangerous characters are escaped, so the payload is inert TEXT. (The
  // substring "onerror=" is still present — safely — which is why the check is
  // for an unescaped tag, not for the word.)
  assert.doesNotMatch(out, /<img src=x/);
  assert.match(out, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(out, /A&amp;B&quot;&lt;C&gt;/);
});

test('the chosen price level is the one printed', () => {
  const p = product({ priceRetail: 100, priceWholesale: 60 });
  assert.match(html([p], { showPrice: true, priceSource: 'wholesale' }), /\$60/);
  assert.match(html([p], { showPrice: true, priceSource: 'retail' }), /\$100/);
});

test('a tile with no price at the chosen level simply omits the price line', () => {
  const p = product({ priceRetail: 100, priceWholesale: null });
  const out = html([p], { showPrice: true, priceSource: 'wholesale' });
  assert.doesNotMatch(out, /class="price"/, 'no misleading fallback price is printed');
});

test('tile contents follow the show/hide switches', () => {
  const p = product({ stockQty: 3, name: 'Widget', sku: 'W-1' });
  const bare = html([p], { showName: false, showPrice: false, showStock: false, showSku: false, showPhoto: false });
  assert.doesNotMatch(bare, /class="name"/);
  assert.doesNotMatch(bare, /class="price"/);
  assert.doesNotMatch(bare, /class="meta"/, 'with nothing to show, no meta block is emitted at all');

  const full = html([p], { showName: true, showPrice: true, showStock: true, showSku: true });
  assert.match(full, /class="name"/);
  assert.match(full, /class="sku"/);
  assert.match(full, /Only 3 left/);
});

test('an out-of-stock note is styled differently from a low-stock note', () => {
  assert.match(html([product({ stockQty: 0 })], { showStock: true }), /stock stock--out/);
  assert.match(html([product({ stockQty: 2 })], { showStock: true, lowStockAt: 5 }), /class="stock"/);
});

test('an uncounted product prints no stock note', () => {
  const out = html([product({ stockQty: null })], { showStock: true });
  assert.doesNotMatch(out, /class="stock/);
});

test('the photo fit switch changes object-fit', () => {
  assert.match(html([product()], { photoFit: 'contain' }), /object-fit:contain/);
  assert.match(html([product()], { photoFit: 'cover' }), /object-fit:cover/);
});

test('a multi-page series gets a page marker and a single image does not', () => {
  const one = html([product()], {}, { pageCount: 1 });
  assert.doesNotMatch(one, /class="pager"/);
  const many = html([product()], {}, { pageCount: 5, pageIndex: 2 });
  assert.match(many, /3 \/ 5/, 'the marker is 1-based for a human reader');
});

test('titles and footer render when set and vanish when blank', () => {
  const withText = html([product()], { title: 'New arrivals', subtitle: 'Spring', footer: 'shop.example.com' });
  assert.match(withText, /<h1>New arrivals<\/h1>/);
  assert.match(withText, /<p>Spring<\/p>/);
  assert.match(withText, /shop\.example\.com/);
  const without = html([product()], { title: '', subtitle: '', footer: '' });
  assert.doesNotMatch(without, /<header>/);
  assert.doesNotMatch(without, /<footer>/);
});

test('text sizes shrink as the grid gets denser', () => {
  assert.ok(scaleForDensity(normalizeConfig({ columns: 5 })) < scaleForDensity(normalizeConfig({ columns: 2 })));
  // Clamped at both ends so a 1-column or 8-column grid cannot produce absurd type.
  assert.ok(scaleForDensity(normalizeConfig({ columns: 1 })) <= 1.6);
  assert.ok(scaleForDensity(normalizeConfig({ columns: 8 })) >= 0.55);
});

test('seriesSlug produces a safe base filename', () => {
  assert.equal(seriesSlug([product()], normalizeConfig({ title: 'Nike — Spring 2026!' })), 'nike-spring-2026');
  // Falls back to the first product's name when there is no title, then to a
  // constant — never an empty string, which would produce a file called ".png".
  assert.equal(seriesSlug([product({ name: 'Blue Trainer' })], normalizeConfig({ title: '' })), 'blue-trainer');
  assert.equal(seriesSlug([], normalizeConfig({ title: '' })), 'social-grid');
  assert.equal(seriesSlug([product({ name: '···' })], normalizeConfig({ title: '' })), 'social-grid');
});

test('a single image is named plainly', () => {
  assert.equal(fileNameFor('nike', 0, 1, 'png'), 'nike.png');
});

test('a series is numbered and zero-padded so it sorts in reading order', () => {
  // 12 pages: two digits, so page 2 must be "02" or Finder lists it after 10.
  assert.equal(fileNameFor('nike', 0, 12, 'png'), 'nike-01.png');
  assert.equal(fileNameFor('nike', 1, 12, 'png'), 'nike-02.png');
  assert.equal(fileNameFor('nike', 9, 12, 'jpg'), 'nike-10.jpg');
  assert.equal(fileNameFor('nike', 11, 12, 'png'), 'nike-12.png');
  // Three digits when there are 100+ images.
  assert.equal(fileNameFor('nike', 0, 120, 'png'), 'nike-001.png');
});

test('a numbered series sorts correctly as plain strings', () => {
  const names = Array.from({ length: 12 }, (_, i) => fileNameFor('nike', i, 12, 'png'));
  assert.deepEqual([...names].sort(), names, 'lexical order must match page order');
});
