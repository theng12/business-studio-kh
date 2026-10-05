const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
function layout() {
  const built = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../renderer/modules/CatalogStudio/previewLayout.js')], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const mod = { exports: {} }; new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports); return mod.exports;
}
test('preview paper geometry respects orientation and zero margins', () => {
  const { catalogPaper } = layout();
  assert.deepEqual(catalogPaper({ pageSize: 'A4', marginMm: 0 }), { width: 210, height: 297, margin: 0 });
  assert.deepEqual(catalogPaper({ pageSize: 'Letter', orientation: 'landscape', marginMm: 10 }), { width: 279.4, height: 215.9, margin: 10 });
});
test('preview packs whole rows and keeps a group title with its next row', () => {
  const { packCatalogRows } = layout();
  const rows = [{ height: 50 }, { height: 20, heading: true }, { height: 40 }, { height: 30 }];
  assert.deepEqual(packCatalogRows(rows, 100, 5), [[rows[0]], [rows[1], rows[2], rows[3]]]);
});
test('preview preserves an oversized row instead of hiding it or looping', () => {
  const { packCatalogRows } = layout(); const rows = [{ height: 160 }, { height: 20 }];
  assert.deepEqual(packCatalogRows(rows, 100, 5), [[rows[0]], [rows[1]]]);
});
