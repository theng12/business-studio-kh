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
