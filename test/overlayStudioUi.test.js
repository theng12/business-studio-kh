/**
 * Overlay Studio follows the house UI pattern (docs/UI_GUIDE.md): the shared
 * SaveStatus first in the page header, `backTo` for the way back, no emoji in
 * the UI, shared cards, and design tokens in its `.ovl-*` CSS.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '../renderer/modules/OverlayStudio');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

test('the editor uses the shared SaveStatus as the first header action, with backTo', () => {
  const src = read('TemplateEditor.jsx');
  assert.match(src, /import \{ SaveStatus \} from '\.\.\/\.\.\/components\/SaveStatus\.jsx'/);
  assert.doesNotMatch(src, /function SaveStatus\(/, 'private SaveStatus copy is back');
  assert.doesNotMatch(src, /function formatAgo\(/, 'private time formatter is back');
  const actions = src.slice(src.indexOf('actions={('));
  assert.ok(actions.indexOf('<SaveStatus') < actions.indexOf('<Button'), 'SaveStatus is not the first action');
  assert.match(src, /backTo=\{back\}/);
  assert.match(src, /const back = \{ label: 'All templates', onClick: onClose \}/);
});

test('no emoji in Overlay Studio UI', () => {
  // Pictographs (U+1F300–U+1FAFF) and the dingbat emoji the old controls used.
  const emoji = /[\u{1F300}-\u{1FAFF}]|\u{2764}|\u{2B50}/u;
  for (const f of fs.readdirSync(DIR).filter((n) => /\.jsx?$/.test(n))) {
    assert.doesNotMatch(read(f), emoji, `${f} contains emoji`);
  }
});

test('template cards are the shared .card, actions primary → danger', () => {
  const src = read('TemplateList.jsx');
  assert.match(src, /className="card-grid card-grid--compact"/);
  assert.match(src, /<div className="card">/);
  const actions = src.slice(src.indexOf('className="card__actions"'));
  assert.ok(actions.indexOf('variant="primary"') < actions.indexOf('variant="danger"'));
});

test('.ovl-* CSS uses tokens: no indigo, no sub-11px text, no off-scale radii', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/index.css'), 'utf8');
  const bad = [];
  let depth = 0;
  let selector = '';
  css.split('\n').forEach((line, i) => {
    if (depth === 0 && line.includes('{')) selector = line;
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth <= 0 || !selector.includes('.ovl')) return;
    if (/#6366f1|#4f46e5/i.test(line)) bad.push(`${i + 1}: indigo — ${line.trim()}`);
    const fs = line.match(/font-size:\s*([\d.]+)px/);
    if (fs && Number(fs[1]) < 11) bad.push(`${i + 1}: ${fs[1]}px text — ${line.trim()}`);
    const r = line.match(/border-radius:\s*(\d+)px/);
    if (r && [7, 9, 11, 12, 13, 15, 16, 17].includes(Number(r[1]))) bad.push(`${i + 1}: ${r[1]}px radius — ${line.trim()}`);
  });
  assert.deepEqual(bad, []);
});
