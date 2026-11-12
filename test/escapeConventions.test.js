// Owner rule 2026-11-12: Escape always does its contextual job — it closes the
// open dialog, sheet, popover or search, and never silently does nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the shared Modal closes on Escape', () => {
  const ui = read('renderer/components/ui.jsx');
  assert.match(ui, /e\.key === 'Escape' && !e\.defaultPrevented/);
});

test('the search palette closes on Escape from anywhere while open', () => {
  const palette = read('renderer/components/SearchPalette.jsx');
  assert.match(palette, /window\.addEventListener\('keydown', onWindowKey\)/);
  assert.match(palette, /if \(e\.key !== 'Escape'\) return;/);
});

test('the lightbox and the company switcher close on Escape', () => {
  assert.match(read('renderer/components/Lightbox.jsx'), /Escape/);
  assert.match(read('renderer/components/Sidebar.jsx'), /e\.key === 'Escape'/);
});

test('every overlay component has an Escape path', () => {
  // Every overlay in the shared layer carries Escape through Modal; a new
  // hand-rolled overlay must add its own listener.
  const overlays = fs.readdirSync(path.join(__dirname, '..', 'renderer', 'components'))
    .filter((name) => /Modal\.jsx$|Palette\.jsx$|Lightbox\.jsx$/.test(name));
  for (const name of overlays) {
    const source = read(path.join('renderer', 'components', name));
    const usesSharedModal = /from '\.\/ui\.jsx'/.test(source) && /<Modal/.test(source);
    assert.ok(usesSharedModal || /Escape/.test(source), `${name} has no Escape path`);
  }
});
