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

test('catalog project card actions stay inside narrow grid cards', () => {
  assert.match(css, /\.catalog-project-card__meta\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.catalog-project-card__meta > div:last-child\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)[^}]*width:\s*100%/s);
  assert.match(css, /\.catalog-project-card__meta > div:last-child > button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
});

test('catalog studio exposes templates, projects, return navigation, and explicit product panels', () => {
  assert.match(sidebarSource, /id: 'catalogtemplates', name: 'Catalog Templates'/);
  assert.match(sidebarSource, /id: 'catalogprojects', name: 'Catalog Projects'/);
  assert.match(catalogSource, /← Catalog projects/);
  assert.match(catalogSource, />Product Library</);
  assert.match(catalogSource, />Included in catalog</);
  assert.match(catalogSource, /selectionMode: 'explicit'/);
});
