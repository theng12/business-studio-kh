/**
 * v0.1.11: render smoke tests for the main screens.
 *
 * Why this exists: v0.1.8 shipped a fatal bug — Overlay Studio referenced a
 * variable that did not exist, so clicking "+ Barcode" dropped the whole editor
 * into its error boundary. All 190 tests passed, because every one of them
 * covered main-process utilities and nothing ever rendered a component.
 *
 * This is deliberately a SMOKE test, not a unit test. It bundles each screen
 * with esbuild (JSX + module resolution) and renders it once with
 * `react-dom/server`. That catches the cheap-but-fatal class of problem:
 *
 *   - a module that throws while being imported
 *   - a component that throws on first render
 *   - a screen whose expected named export has gone missing or been renamed
 *
 * It does NOT simulate clicks, so it would not have caught the barcode crash on
 * its own (that needs the element to exist in the template). ESLint's `no-undef`
 * is the guard for that specific bug, and it does catch it — see
 * eslint.config.mjs. Between them: the linter covers "this reference cannot
 * work", this covers "this screen cannot start".
 *
 * No DOM and no browser: `react-dom/server` needs neither, which is why this
 * runs in plain Node with the same `node --test` runner as everything else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The seven feature modules the audit flagged as having zero coverage. */
const SCREENS = [
  { label: 'Product Library', entry: 'renderer/modules/ProductLibrary/index.jsx', export: 'ProductLibrary' },
  { label: 'Image Workspace', entry: 'renderer/modules/ImageWorkspace/index.jsx', export: 'ImageWorkspace' },
  { label: 'AI Studio',       entry: 'renderer/modules/AIStudio/index.jsx',       export: 'AIStudio' },
  { label: 'Overlay Studio',  entry: 'renderer/modules/OverlayStudio/index.jsx',  export: 'OverlayStudio' },
  { label: 'Export Center',   entry: 'renderer/modules/ExportCenter/index.jsx',   export: 'ExportCenter' },
  { label: 'Label Studio',    entry: 'renderer/modules/LabelStudio/LabelTemplates.jsx', export: 'LabelTemplates' },
  { label: 'Catalog Studio',  entry: 'renderer/modules/CatalogStudio/index.jsx',  export: 'CatalogTemplates' },
  // Also worth guarding: the shell and the two screens the audit found broken.
  { label: 'Purchase Orders', entry: 'renderer/modules/PurchaseOrders/index.jsx', export: 'PurchaseOrders' },
  { label: 'Suppliers',       entry: 'renderer/modules/Suppliers/index.jsx',      export: 'Suppliers' },
  { label: 'Cost Calculator', entry: 'renderer/modules/CostCalculator/index.jsx', export: 'CostCalculator' },
  { label: 'Dashboard',       entry: 'renderer/modules/Dashboard/index.jsx',      export: 'Dashboard' },
  { label: 'Brands',          entry: 'renderer/modules/Brands/index.jsx',         export: 'Brands' },
  { label: 'History',         entry: 'renderer/modules/History/index.jsx',        export: 'History' },
  { label: 'Settings',        entry: 'renderer/modules/Settings/index.jsx',       export: 'Settings' },
  { label: 'Support',         entry: 'renderer/modules/Support/index.jsx',        export: 'Support' },
  // v0.1.25: these two render in the app but were absent from this list, so a
  // mount-time crash in either would have reached users unnoticed. Companies is
  // a top-level page; Social Grid is the newest module.
  //
  // NOT here: renderer/modules/Categories/index.jsx. It exports CategoriesBody
  // (used by the Settings tab) plus a page wrapper that is deliberately left
  // unrouted — v0.22.14 demoted Categories from the sidebar back to a Settings
  // tab, keeping the wrapper for possible deep-linking. The check below
  // requires every entry here to be imported by App.jsx, so adding it would
  // fail by design.
  { label: 'Companies',       entry: 'renderer/modules/Companies/index.jsx',      export: 'Companies' },
  { label: 'Social Grid',     entry: 'renderer/modules/SocialGrid/index.jsx',     export: 'SocialGrid' },
];

/**
 * Install the minimum browser surface the renderer code touches at import time
 * or during a first render. Anything more would be simulating a whole browser;
 * anything less and modules throw on `window.…` before we learn anything.
 */
function installBrowserStubs() {
  const noop = () => {};
  const storage = { getItem: () => null, setItem: noop, removeItem: noop };
  const apiStub = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });

  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  globalThis.document = {
    addEventListener: noop,
    removeEventListener: noop,
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { style: {}, classList: { add: noop, remove: noop } },
  };
  globalThis.window = {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: storage,
    location: { href: '', origin: 'app://local' },
    innerWidth: 1400,
    innerHeight: 900,
    api: apiStub,
    visualViewport: null,
  };
  globalThis.navigator = globalThis.navigator || { userAgent: 'node', platform: 'darwin' };
}

/** Bundle a renderer entry to CommonJS and evaluate it, returning its exports. */
async function loadScreen(entry) {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));

  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    // CSS is imported for side effects only; there is nothing to load in Node.
    loader: { '.css': 'empty' },
    // React and the store stay external so every screen shares one React
    // instance — bundling React per-screen breaks hooks.
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand'],
    logLevel: 'silent',
  });

  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn(req, mod, mod.exports);
  return mod.exports;
}

installBrowserStubs();

for (const { label, entry, export: exportName } of SCREENS) {
  test(`screen smoke — ${label} imports and renders`, async () => {
    const mod = await loadScreen(entry);

    assert.ok(
      typeof mod[exportName] === 'function',
      `${entry} should export a "${exportName}" component; found: ${Object.keys(mod).join(', ') || '(none)'}`,
    );

    const React = require('react');
    const { renderToString } = require('react-dom/server');

    let html;
    assert.doesNotThrow(() => {
      html = renderToString(React.createElement(mod[exportName]));
    }, `${label} threw while rendering`);

    // A screen that renders literally nothing is almost certainly broken — an
    // early return that shouldn't fire, or the error boundary swallowing it.
    assert.ok(
      typeof html === 'string' && html.length > 0,
      `${label} rendered an empty string`,
    );
  });
}

test('screen smoke — every screen is reachable from the app shell', async () => {
  // If a module renders but is not wired into App.jsx's PAGES map, the user can
  // never reach it. This is the wiring half of "does the screen work".
  const fs = require('node:fs');
  const app = fs.readFileSync(path.join(ROOT, 'renderer/App.jsx'), 'utf8');

  for (const { label, entry } of SCREENS) {
    const referenced = app.includes(`modules/${entry.split('modules/')[1]}`)
      || app.includes(`./modules/${path.relative('renderer', entry).replace(/\.jsx$/, '.jsx')}`);
    assert.ok(referenced, `${label} (${entry}) is not imported anywhere in App.jsx`);
  }
});

/**
 * The canvas element renderer, one case per element type.
 *
 * This is the test that would have caught the v0.1.8 barcode crash. That bug
 * lived in the barcode branch of `ElementContent`, which only runs once a
 * barcode element exists — so a screen-level render (a freshly opened editor has
 * no elements) walks straight past it. Rendering each type explicitly does not.
 */
const ELEMENT_CASES = [
  {
    type: 'text',
    element: {
      id: 't1', type: 'text', x: 0.5, y: 0.5, anchor: 'c',
      content: '{sku}', align: 'left',
      font: { family: 'Inter, sans-serif', size: 48, weight: 'bold', color: '#111111' },
      bg: { color: '#FFFFFF', opacity: 0.9, padding: 12, radius: 6 },
    },
  },
  {
    type: 'barcode',
    element: {
      id: 'b1', type: 'barcode', x: 0.5, y: 0.5, anchor: 'c',
      width: 0.28, height: 0.07, content: '{sku}', format: 'code128', showText: true,
      bg: { color: '#FFFFFF', opacity: 1, padding: 12, radius: 6 },
    },
  },
  {
    type: 'image — brand icon',
    element: {
      id: 'i1', type: 'image', x: 0.5, y: 0.5, anchor: 'c',
      width: 0.3, height: 0.15, source: 'brand-icon', opacity: 1,
    },
  },
  {
    type: 'image — imported asset',
    element: {
      id: 'i2', type: 'image', x: 0.5, y: 0.5, anchor: 'c',
      width: 0.3, height: 0.15, source: 'asset:watermarks/logo.png', opacity: 0.5,
    },
  },
  {
    type: 'image — product photo',
    element: {
      id: 'i3', type: 'image', x: 0.5, y: 0.5, anchor: 'c',
      width: 0.3, height: 0.15, source: 'product-image:0', opacity: 1,
    },
  },
];

for (const { type, element } of ELEMENT_CASES) {
  test(`canvas element renders — ${type}`, async () => {
    const canvas = await loadScreen('renderer/modules/OverlayStudio/EditorCanvas.jsx');
    assert.equal(typeof canvas.ElementContent, 'function', 'EditorCanvas should export ElementContent');

    const React = require('react');
    const { renderToString } = require('react-dom/server');

    // A resolved product context, so the branches that use it take the real path
    // rather than short-circuiting on missing data.
    const productContext = {
      sku: 'DEMO-001', name: 'Khmer Ceramic Bowl', brand: 'gc',
      brandIcon: 'Demo-Company/_brand-icons/brand.jpg',
      productImages: [{ filepath: 'Demo-Company/_unassigned/DEMO-001/DEMO-001-001.jpg' }],
    };
    const box = { left: 10, top: 10, width: 120, height: 40 };

    let html;
    assert.doesNotThrow(() => {
      html = renderToString(
        React.createElement(canvas.ElementContent, {
          element, box, productContext, canvasW: 682, filledContent: null,
        }),
      );
    }, `ElementContent threw for a ${type} element`);
    assert.ok(html.length > 0, `ElementContent rendered nothing for a ${type} element`);
  });

  test(`canvas placeholder renders — ${type}`, async () => {
    // v0.1.23: the design view shows a labelled box instead of the element's real
    // pixels, so this asserts BOTH that it renders and that it describes the
    // element rather than drawing it. A placeholder that quietly fell through to
    // the real renderer would still produce HTML, which is why the kind label is
    // checked and not just a non-empty string.
    const canvas = await loadScreen('renderer/modules/OverlayStudio/EditorCanvas.jsx');

    const React = require('react');
    const { renderToString } = require('react-dom/server');

    const productContext = {
      sku: 'DEMO-001', name: 'Khmer Ceramic Bowl', brand: 'gc',
      brandIcon: 'Demo-Company/_brand-icons/brand.jpg',
      productImages: [{ filepath: 'Demo-Company/_unassigned/DEMO-001/DEMO-001-001.jpg' }],
    };
    const box = { left: 10, top: 10, width: 120, height: 40 };

    const html = renderToString(
      React.createElement(canvas.ElementContent, {
        element, box, productContext, canvasW: 682, canvasH: 682, filledContent: null, placeholders: true,
      }),
    );

    assert.ok(html.includes('ovl-element__placeholder'), `no placeholder box for a ${type} element`);
    assert.ok(html.includes('ovl-element__placeholder-size'), `placeholder for a ${type} element shows no size`);
    assert.ok(!html.includes('<img'), `placeholder for a ${type} element must not render an image`);
  });
}
