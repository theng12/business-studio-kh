const test = require('node:test');
const assert = require('node:assert/strict');
const { labelsDocument, buildCatalogHtml, barcodeUri } = require('../main/studioRenderer');

test('label document binds shared product fields and uses physical dimensions', async () => {
  const html = await labelsDocument({
    template: { widthMm: 50, heightMm: 25, backgroundColor: '#fff', elements: [
      { id: 'sku', type: 'text', field: 'sku', x: 2, y: 2, width: 20, height: 5 },
    ] },
    products: [{ id: 'p1', sku: 'KH-001' }], layout: { mode: 'single' },
  });
  assert.match(html, /width:50mm;height:25mm/);
  assert.match(html, /KH-001/);
});

test('barcode renderer produces an embeddable PNG', async () => {
  const uri = await barcodeUri('ABC-123', 'code128', true);
  assert.match(uri, /^data:image\/png;base64,/);
});

test('catalog renderer filters explicit product selections', () => {
  const html = buildCatalogHtml({
    project: { name: 'Spring', config: { productIds: ['a'], cover: { enabled: false } } },
    products: [{ id: 'a', sku: 'A', name: 'Included' }, { id: 'b', sku: 'B', name: 'Excluded' }],
  });
  assert.match(html, /Included/);
  assert.doesNotMatch(html, /Excluded/);
});

test('catalog renderer treats an explicit empty selection as an empty project', () => {
  const html = buildCatalogHtml({
    project: { name: 'Empty', config: { selectionMode: 'explicit', productIds: [], cover: { enabled: false } } },
    products: [{ id: 'a', sku: 'A', name: 'Should not appear' }],
  });
  assert.doesNotMatch(html, /Should not appear/);
  assert.match(html, /No products have been added/);
});

test('catalog renderer preserves manual product order', () => {
  const html = buildCatalogHtml({
    project: { name: 'Ordered', config: { selectionMode: 'explicit', productIds: ['b', 'a'], sortBy: 'manual', cover: { enabled: false } } },
    products: [{ id: 'a', sku: 'A', name: 'First source row' }, { id: 'b', sku: 'B', name: 'Second source row' }],
  });
  assert.ok(html.indexOf('Second source row') < html.indexOf('First source row'));
});


const catalog = (config) => buildCatalogHtml({
  project: { name: 'Example', config: { selectionMode: 'all', cover: { enabled: false }, ...config } },
  products: [{ id: 'a', sku: 'SKU-1', name: 'Product name', brandId: 'b' }],
  brands: [{ id: 'b', name: 'Brand name' }],
}, { preview: true });

test('catalog output preserves zero gap and margin and deliberately empty fields', () => {
  const html = catalog({ gapMm: 0, marginMm: 0, fields: [], showBrand: false });
  assert.match(html, /@page\{[^}]*margin:0mm/);
  assert.match(html, /gap:0mm/);
  assert.doesNotMatch(html, />SKU-1<|Product name|Brand name/);
  assert.match(html, /photo placeholder/);
  assert.doesNotMatch(html, /<div class="card-body">/);
});

test('compact list suppresses photos and brands and applies field alignment and type size', () => {
  const html = catalog({ layoutMode: 'list', showImages: false, showBrand: false, cardPaddingMm: 0,
    fontSizePt: 9.5, boldFontSizePt: 14, fields: [{ key: 'name', align: 'right', bold: true }] });
  assert.match(html, /class="grid list"/);
  assert.match(html, /\.grid\.list \.card-body\{flex:1;display:flex/);
  assert.doesNotMatch(html, /<img|class="photo|Brand name/);
  assert.match(html, /font-size:9.5pt/);
  assert.match(html, /font-size:14pt/);
  assert.match(html, /class="field bold" style="text-align:right"/);
  assert.match(html, /Product name/);
  assert.match(html, /\.card-body\{padding:0mm/);
});

test('fixed photo height and cover fit reach both preview and print HTML', () => {
  for (const preview of [true, false]) {
    const html = buildCatalogHtml({ project: { name: 'Example', config: { selectionMode: 'all', imageHeightMm: 35, imageFit: 'cover' } }, products: [{ id: 'a' }] }, { preview });
    assert.match(html, /height:35mm/);
    assert.match(html, /object-fit:cover/);
  }
});

test('legacy catalogs without a sort setting retain SKU order', () => {
  const html = buildCatalogHtml({ project: { name: 'Legacy', config: { cover: { enabled: false } } },
    products: [{ id: 'b', sku: 'B', name: 'B second' }, { id: 'a', sku: 'A', name: 'A first' }] });
  assert.ok(html.indexOf('A first') < html.indexOf('B second'));
});
