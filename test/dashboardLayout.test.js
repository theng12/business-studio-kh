/**
 * 0.1.89 shipped a Dashboard whose "Needs attention" / "Operations" cards were
 * squeezed until their chips were cut off under the next card (owner's
 * screenshot, 2026-10-02): the page is a height-bounded scroll box laid out as
 * a column flexbox, and those cards had min-height: 0, so they SHRANK whenever
 * the dashboard was taller than the window. Sections must keep their natural
 * height and let the page scroll.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.css'), 'utf8');

test('dashboard sections never shrink below their content', () => {
  assert.match(css, /\.page--dashboard\s*>\s*\*\s*\{\s*flex-shrink:\s*0;\s*\}/);
});
