/**
 * R3.1 — rendered check for the import "rows skipped for no SKU" message.
 *
 * The data path (sourceRowCount vs rowsConsidered) is covered by the
 * component harness; this asserts the user actually SEES the explanation when
 * rows were dropped, and does not see it otherwise. Renders the real
 * ImportPreview with react-dom/server — no DOM needed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let cached = null;

function installBrowserStubs() {
  const noop = () => {};
  const store = {};
  const localStorageStub = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const apiStub = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });
  globalThis.localStorage = localStorageStub;
  globalThis.sessionStorage = localStorageStub;
  globalThis.document = {
    addEventListener: noop, removeEventListener: noop,
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }),
    querySelector: () => null, querySelectorAll: () => [],
    body: { style: {}, classList: { add: noop, remove: noop } },
  };
  globalThis.window = {
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: localStorageStub, location: { href: '', origin: 'app://local' },
    innerWidth: 1400, innerHeight: 900, api: apiStub, visualViewport: null,
  };
  globalThis.navigator = globalThis.navigator || { userAgent: 'node', platform: 'darwin' };
}

async function loadPreview() {
  if (cached) return cached;
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/modules/ProductLibrary/ImportModal.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand', '@imgly/background-removal'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(req, mod, mod.exports);
  cached = mod.exports;
  return cached;
}

function renderPreview(preview, conflictPolicy = 'merge') {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { ImportPreview } = cached;
  return renderToStaticMarkup(React.createElement(ImportPreview, {
    preview, conflictPolicy, onChangePolicy: () => {}, busy: false,
  }));
}

installBrowserStubs();

test('import preview explains rows skipped for an empty SKU', async () => {
  await loadPreview();
  const html = renderPreview({
    changes: [{ rowIndex: 0, sku: 'A-1', action: 'insert' }],
    rowsConsidered: 1,
    sourceRowCount: 3,
  });
  assert.match(html, /2 of 3 rows had no SKU/);
  assert.match(html, /were skipped/);
});

test('import preview does not show the skipped-row warning when nothing was dropped', async () => {
  await loadPreview();
  const html = renderPreview({
    changes: [
      { rowIndex: 0, sku: 'A-1', action: 'insert' },
      { rowIndex: 1, sku: 'A-2', action: 'insert' },
    ],
    rowsConsidered: 2,
    sourceRowCount: 2,
  });
  assert.doesNotMatch(html, /had no SKU/);
});

const conflictPreview = {
  changes: [
    { rowIndex: 0, sku: 'SKU-1', action: 'update', diffs: [{ field: 'name', oldValue: 'Old', newValue: 'New' }] },
    {
      rowIndex: 1,
      sku: 'SKU-1',
      action: 'update',
      diffs: [{ field: 'name', oldValue: 'New', newValue: null }],
    },
  ],
  rowsConsidered: 2,
  sourceRowCount: 2,
};

test('import preview describes the selected conflict policy so the options give visible feedback', async () => {
  await loadPreview();
  assert.match(renderPreview(conflictPreview, 'merge'), /Merge:<\/strong> Existing products keep any value your file leaves blank/);
  assert.match(renderPreview(conflictPreview, 'skip'), /Skip existing:<\/strong> Existing products are left exactly as they are/);
  assert.match(renderPreview(conflictPreview, 'overwrite'), /Overwrite:<\/strong> Every mapped column is written to existing products/);
});

test('overwrite preview warns how many existing values it will clear; merge does not', async () => {
  await loadPreview();
  const overwrite = renderPreview(conflictPreview, 'overwrite');
  assert.match(overwrite, /will clear <strong>1<\/strong> existing value to blank/);
  const merge = renderPreview(conflictPreview, 'merge');
  assert.doesNotMatch(merge, /will clear/);
});

test('title-row hint appears for any single-value first row, and stays conditional', async () => {
  await loadPreview();
  const { shouldSuggestTitleRow } = cached;
  assert.equal(
    shouldSuggestTitleRow({ looksLikeTitleRow: true, headers: ['Product catalogue 2026'] }),
    true,
    'an unrecognized single header is a title-row candidate',
  );
  assert.equal(
    shouldSuggestTitleRow({ looksLikeTitleRow: true, headers: ['Code'] }),
    true,
    'a recognized-looking single header is still flagged — hiding it would import the real header row as data',
  );
  assert.equal(
    shouldSuggestTitleRow({ looksLikeTitleRow: true, headers: ['SKU', 'Column 2'] }),
    true,
    'ambiguous single-value first rows are surfaced conditionally, not hidden',
  );
  assert.equal(
    shouldSuggestTitleRow({ looksLikeTitleRow: false, headers: ['SKU', 'Name'] }),
    false,
  );
});
