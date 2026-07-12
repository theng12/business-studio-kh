const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.css'), 'utf8');

test('label template card actions stay inside narrow grid cards', () => {
  assert.match(css, /\.studio-card--template \.studio-card__body\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.studio-card--template \.studio-card__actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)[^}]*width:\s*100%/s);
  assert.match(css, /\.studio-card--template \.studio-card__actions > button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
});
