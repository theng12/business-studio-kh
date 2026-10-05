const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.css'), 'utf8');
const catalogSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'modules', 'CatalogStudio', 'index.jsx'), 'utf8');
const sidebarSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'components', 'Sidebar.jsx'), 'utf8');

test('label template card actions stay inside narrow grid cards', () => {
  assert.match(css, /\.studio-card--template \.studio-card__body\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.studio-card--template \.studio-card__actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)[^}]*width:\s*100%/s);
  assert.match(css, /\.studio-card--template \.studio-card__actions > button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
});

/* UI pass 2026-10: catalog cards moved onto the shared `.card` (docs/UI_GUIDE.md).
 * The guarantee is the same — actions never push outside a narrow card — but it
 * now comes from `.card__actions` wrapping its ROW, not a private 3-column grid. */
test('catalog project card actions stay inside narrow grid cards', () => {
  assert.match(css, /\.card__actions\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.btn\s*\{[^}]*white-space:\s*nowrap/s, 'button labels never wrap inside a squeezed card');
  assert.match(catalogSource, /<article className="card catalog-card">/);
  assert.match(catalogSource, /<div className="card__actions">\s*<Button variant="primary" size="sm" onClick=\{onOpen\}>Open<\/Button>/);
  assert.match(catalogSource, /<Button variant="danger" size="sm" onClick=\{onDelete\}>Delete<\/Button>/);
});

test('catalog studio exposes templates, projects, return navigation, and explicit product panels', () => {
  assert.match(sidebarSource, /id: 'catalogtemplates', name: 'Catalog Templates'/);
  assert.match(sidebarSource, /id: 'catalogprojects', name: 'Catalog Projects'/);
  assert.match(catalogSource, /backTo=\{\{ label: 'Catalog projects', onClick: leaveEditor \}\}/);
  const products = fs.readFileSync(path.join(__dirname, '../renderer/modules/CatalogStudio/ProductManager.jsx'), 'utf8');
  assert.match(catalogSource, /<ProductManager/);
  assert.match(products, />Product Library</);
  assert.match(products, />Included in catalog</);
  assert.match(catalogSource, /selectionMode: 'explicit'/);
});
