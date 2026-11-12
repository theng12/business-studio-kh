// Owner rule 2026-11-13: window.confirm / alert / prompt are silent no-ops in
// the packaged webview. Every in-app confirm or warning is an in-app dialog or
// toast; the native browser APIs must not be called from UI code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const CALL = /window\.(confirm|alert|prompt)\s*\(/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(jsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

function liveCalls(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => {
      const at = line.search(CALL);
      if (at === -1) return false;
      // Ignore prose in comments: a leading //, *, or {/* marker before the call.
      const before = line.slice(0, at);
      return !/(\/\/|\*|\/\*)\s*$/.test(before.trimEnd()) && !/^\s*(\*|\/\/|\{\/\*)/.test(line);
    });
}

test('no UI file calls window.confirm, alert or prompt', () => {
  const offenders = walk(RENDERER)
    .map((file) => ({ file, calls: liveCalls(file) }))
    .filter(({ calls }) => calls.length)
    .map(({ file, calls }) => `${path.relative(RENDERER, file)}:${calls.map((c) => c.index).join(',')}`);
  assert.deepEqual(offenders, [], `native dialogs in UI code: ${offenders.join(' | ')}`);
});

test('the overwrite crop confirm uses the in-app dialog', () => {
  const source = fs.readFileSync(path.join(RENDERER, 'modules', 'ImageWorkspace', 'index.jsx'), 'utf8');
  assert.match(source, /await confirm\(\{/);
  assert.doesNotMatch(source, /window\.confirm\(/);
});

test('lightbox failures surface as error toasts', () => {
  const source = fs.readFileSync(path.join(RENDERER, 'components', 'Lightbox.jsx'), 'utf8');
  assert.match(source, /Flip failed: \$\{err\.message\}`, 'error'\)/);
  assert.match(source, /Spin export failed: \$\{err\.message\}`, 'error'\)/);
});
