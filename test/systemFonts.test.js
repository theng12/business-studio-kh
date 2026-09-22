/**
 * The pure half of the Overlay Studio font picker.
 *
 * `window.queryLocalFonts()` cannot be exercised under `node --test`, so the
 * normalisation it depends on is a standalone function here and tested
 * directly: case-insensitive de-duplication, blank rejection and sorting. A
 * raw macOS font list is full of duplicates — every face of a family reports
 * the same `family` — so without this the dropdown would repeat each name a
 * dozen times.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadSystemFonts() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/lib/systemFonts.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test('dedupeFamilies collapses the repeated faces of one family', () => {
  const { dedupeFamilies } = loadSystemFonts();
  const raw = [
    { family: 'Helvetica Neue', style: 'Regular' },
    { family: 'Helvetica Neue', style: 'Bold' },
    { family: 'Helvetica Neue', style: 'Italic' },
    { family: 'Arial', style: 'Regular' },
  ];
  assert.deepEqual(dedupeFamilies(raw), ['Arial', 'Helvetica Neue']);
});

test('dedupeFamilies is case-insensitive and keeps the first spelling', () => {
  const { dedupeFamilies } = loadSystemFonts();
  assert.deepEqual(dedupeFamilies(['Arial', 'arial', 'ARIAL']), ['Arial']);
});

test('dedupeFamilies drops blanks and non-strings, and sorts', () => {
  const { dedupeFamilies } = loadSystemFonts();
  assert.deepEqual(
    dedupeFamilies(['Zapfino', '  ', null, undefined, { family: '   ' }, { nope: 1 }, 'Arial']),
    ['Arial', 'Zapfino'],
  );
  assert.deepEqual(dedupeFamilies(null), []);
  assert.deepEqual(dedupeFamilies('Arial'), []);
});

test('dedupeFamilies accepts bare strings as well as API objects', () => {
  const { dedupeFamilies } = loadSystemFonts();
  assert.deepEqual(dedupeFamilies(['Menlo', { family: 'Georgia' }]), ['Georgia', 'Menlo']);
});

test('listSystemFonts returns null when the API is unavailable (no crash)', async () => {
  const { listSystemFonts, resetSystemFontCache } = loadSystemFonts();
  resetSystemFontCache();
  // node has no `window`, which is exactly the "older Electron / refused" case.
  assert.equal(await listSystemFonts(), null);
});

test('the fallback list is non-empty and usable', () => {
  const { fallbackFamilies } = loadSystemFonts();
  const list = fallbackFamilies();
  assert.ok(list.length > 0);
  assert.ok(list.includes('Arial'));
  // A fresh array each call, so a caller cannot mutate the module constant.
  list.push('nope');
  assert.ok(!fallbackFamilies().includes('nope'));
});
