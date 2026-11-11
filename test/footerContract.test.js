const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const sidebar = read('renderer/components/Sidebar.jsx');
const settings = read('renderer/modules/Settings/index.jsx');
const css = read('renderer/index.css');

test('footer combines version and news with update controls after support', () => {
  const footer = sidebar.slice(sidebar.indexOf('<div className="sidebar__footer">'), sidebar.indexOf('</aside>'));
  assert.ok(footer.indexOf('Support this app') < footer.indexOf('sidebar__update-group'));
  assert.match(footer, /className="sidebar__version-pill"[^]*?onClick=\{openWhatsNew\}/);
  assert.match(footer, /aria-label="Check for updates"/);
  assert.match(footer, /disabled=\{update\.state === 'checking'\}/);
  assert.match(footer, /update\.state === 'available'[^]*?aria-label=\{`Update to \$\{update\.version\}`\}/);
  assert.match(footer, /role="status" aria-live="polite"/);
  assert.doesNotMatch(footer, /className="sidebar__version"/);
  assert.doesNotMatch(footer, /<span>What's new<\/span>/);
});

test('update states use the shared contract and Settings holds connection details', () => {
  for (const text of ['Not checked', 'Checking…', 'Checked just now · up to date', 'is available', 'Check failed:', '. Try again.']) assert.ok(sidebar.includes(text));
  assert.match(sidebar, /window\.api\.updates\.check\(\)/);
  assert.match(sidebar, /window\.api\.updates\.openUpdater\(\)/);
  assert.match(settings, /import \{ ConnectionStatus \} from/);
  assert.match(settings, /<ConnectionStatus \/>/);
  assert.match(css, /--sidebar-width:\s*248px/);
});
