const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the app reads dated, plain-text release notes from the single Markdown changelog', async () => {
  const { parseChangelog } = await import('../renderer/lib/changelog.js');
  const root = path.join(__dirname, '..');
  const markdown = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const entries = parseChangelog(markdown);
  assert.equal(entries[0].version, require('../package.json').version);
  assert.equal(entries.at(-1).version, '0.1.100');
  assert.equal(new Set(entries.map((entry) => entry.version)).size, entries.length);
  assert.ok(entries.every((entry) => entry.items.length && entry.items.every((item) => item.trim())));
  assert.deepEqual(parseChangelog(markdown.replaceAll('\n', '\r\n')), entries);
});

test('release parsing keeps bullets as text and refuses a broken heading or empty release', async () => {
  const { parseChangelog } = await import('../renderer/lib/changelog.js');
  assert.deepEqual(parseChangelog('# Notes\n\n## 1.2.3 — 2026-11-02\n\n- Keep <tags> & apostrophes as text.\n'), [
    { version: '1.2.3', date: '2026-11-02', items: ['Keep <tags> & apostrophes as text.'] },
  ]);
  assert.throws(() => parseChangelog('## broken\n- A change'), /Invalid release heading/);
  assert.throws(() => parseChangelog('## 1.2.3 — 2026-11-02\n'), /has no notes/);
});
