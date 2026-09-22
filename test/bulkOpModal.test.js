/**
 * v0.1.16: tests for the shared pieces behind the Product Library bulk modals —
 * `BulkOpModal` (Convert / Compress / Resize) and `useBulkPreview` (Auto-crop /
 * Enhance).
 *
 * Why this exists: those modals were refactored onto shared code, and both
 * shared pieces now own things that used to be copy-pasted per modal —
 * remembered-picks storage, the per-open `running` reset and the error-toast
 * wrapper in the shell; the sample load, the debounce and the blob-URL
 * lifecycle in the hook. The screen smoke test renders each *screen* with its
 * modals closed, so it returns `null` before the form body ever runs and would
 * not notice a broken render-prop.
 *
 * What is covered here (all without a DOM — `react-dom/server` needs none):
 *   - the shell reads remembered picks, and falls back to defaults when the
 *     blob is missing, corrupt, or written by an older schema version;
 *   - each real modal renders its own chrome and fields while OPEN, which
 *     exercises its `children` render function;
 *   - the conditional fields still respond to a remembered non-default state
 *     (Convert hides Quality for PNG; Resize shows the background picker only
 *     for exact + contain);
 *   - the preview hook returns its documented initial shape when mounted;
 *   - each modal still delegates to the shared piece, so the duplicated code
 *     cannot silently come back, and the hook keeps depending on the first
 *     product id rather than on the (re-created) array.
 *
 * Not covered: clicking Run, and any effect-driven behaviour. `react-dom/server`
 * runs no effects and dispatches no events, and the repo has no DOM
 * implementation. Those paths are verified against the real app instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

/** Keyed by entry path so each bundle is built at most once. */
const bundleCache = new Map();

/** localStorage backing store, mutated per test to seed "remembered picks". */
let storage = {};

function installBrowserStubs() {
  const noop = () => {};
  const localStorageStub = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const apiStub = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });

  globalThis.localStorage = localStorageStub;
  globalThis.sessionStorage = localStorageStub;
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
    localStorage: localStorageStub,
    location: { href: '', origin: 'app://local' },
    innerWidth: 1400,
    innerHeight: 900,
    api: apiStub,
    visualViewport: null,
  };
  globalThis.navigator = globalThis.navigator || { userAgent: 'node', platform: 'darwin' };
}

async function loadRenderer(entry) {
  if (bundleCache.has(entry)) return bundleCache.get(entry);

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
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand'],
    logLevel: 'silent',
  });

  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn(req, mod, mod.exports);
  bundleCache.set(entry, mod.exports);
  return mod.exports;
}

function render(Component, props) {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  return renderToString(React.createElement(Component, props));
}

installBrowserStubs();

/* ── the shell's remembered-picks behaviour ─────────────────────────────── */

const SHELL_KEY = 'Library.testShell';
const SHELL_DEFAULTS = { quality: 85, scope: 'main' };

async function renderShell({ seed } = {}) {
  storage = {};
  if (seed !== undefined) storage[SHELL_KEY] = seed;

  const { BulkOpModal } = await loadRenderer('renderer/modules/ProductLibrary/BulkOpModal.jsx');

  let captured = null;
  const html = render(BulkOpModal, {
    open: true,
    productIds: ['a', 'b'],
    onClose: () => {},
    storageKey: SHELL_KEY,
    defaults: SHELL_DEFAULTS,
    schemaVersion: 2,
    titlePrefix: 'Shell',
    actionVerb: 'Shell',
    description: 'Shell body copy.',
    children: (api) => { captured = api; return null; },
  });

  return { html, captured };
}

test('bulk op shell — defaults when nothing is remembered', async () => {
  const { html, captured } = await renderShell();

  assert.deepEqual(captured.state, SHELL_DEFAULTS);
  assert.equal(captured.running, false);
  assert.equal(typeof captured.set, 'function');
  assert.equal(typeof captured.patch, 'function');

  // Chrome: pluralised title, pluralised primary button, reset affordance.
  assert.match(html, /Shell · 2 products/);
  assert.match(html, /Shell 2/);
  assert.match(html, /Reset to defaults/);
});

test('bulk op shell — a single product is not pluralised', async () => {
  const { BulkOpModal } = await loadRenderer('renderer/modules/ProductLibrary/BulkOpModal.jsx');
  const html = render(BulkOpModal, {
    open: true,
    productIds: ['only'],
    storageKey: SHELL_KEY,
    defaults: SHELL_DEFAULTS,
    schemaVersion: 2,
    titlePrefix: 'Shell',
    actionVerb: 'Shell',
    description: 'Shell body copy.',
    children: () => null,
  });
  assert.match(html, /Shell · 1 product/);
  assert.match(html, /Shell 1/);
  assert.doesNotMatch(html, /1 products/);
});

test('bulk op shell — remembered picks override the defaults', async () => {
  const { captured } = await renderShell({
    seed: JSON.stringify({ v: 2, s: { quality: 60 } }),
  });
  // Spread over defaults, so a field added later still gets its default.
  assert.deepEqual(captured.state, { quality: 60, scope: 'main' });
});

test('bulk op shell — an older schema version is discarded, not migrated', async () => {
  const { captured } = await renderShell({
    seed: JSON.stringify({ v: 1, s: { quality: 60 } }),
  });
  assert.deepEqual(captured.state, SHELL_DEFAULTS);
});

test('bulk op shell — a corrupt blob falls back to defaults instead of throwing', async () => {
  const { captured } = await renderShell({ seed: '{not json' });
  assert.deepEqual(captured.state, SHELL_DEFAULTS);
});

test('bulk op shell — an unset storage key renders nothing at all', async () => {
  const { BulkOpModal } = await loadRenderer('renderer/modules/ProductLibrary/BulkOpModal.jsx');

  let childRan = false;
  const html = render(BulkOpModal, {
    open: false,
    productIds: ['a'],
    storageKey: SHELL_KEY,
    defaults: SHELL_DEFAULTS,
    titlePrefix: 'Shell',
    actionVerb: 'Shell',
    description: 'Shell body copy.',
    children: () => { childRan = true; return null; },
  });

  assert.equal(html, '');
  assert.equal(childRan, false, 'a closed modal must not render its form body');
});

/* ── the three real modals, rendered open ───────────────────────────────── */

test('bulk op shell — renders the backup reminder into every op modal', () => {
  // Observable only with effects, so it is asserted on the source rather than
  // on rendered output: BackupReminder stays `null` until its own effect has
  // fetched the last-backup timestamp, and server rendering runs no effects.
  const src = fs.readFileSync(path.join(ROOT, 'renderer/modules/ProductLibrary/BulkOpModal.jsx'), 'utf8');
  assert.match(src, /backupReminder = true/);
  assert.match(src, /<BackupReminder \/>/);
});

const MODALS = [
  {
    label: 'Convert',
    entry: 'renderer/modules/ProductLibrary/BulkConvertModal.jsx',
    export: 'BulkConvertModal',
    storageKey: 'Library.bulkConvert',
    expect: ['Convert format · 2 products', 'Convert 2', 'Target format', 'JPEG (.jpg)', 'aria-label="Quality value"', 'Main image of each product'],
  },
  {
    label: 'Compress',
    entry: 'renderer/modules/ProductLibrary/BulkCompressModal.jsx',
    export: 'BulkCompressModal',
    storageKey: 'Library.bulkCompress',
    expect: ['Compress · 2 products', 'Compress 2', 'aria-label="Quality value"', 'Catalog default (85)', 'Main image of each product'],
  },
  {
    label: 'Resize',
    entry: 'renderer/modules/ProductLibrary/BulkResizeModal.jsx',
    export: 'BulkResizeModal',
    storageKey: 'Library.bulkResize',
    expect: ['Resize · 2 products', 'Resize 2', 'Mode', 'Max long edge (preserve aspect, never upscale)', 'Max long edge (px)', 'Main image of each product'],
  },
];

for (const mod of MODALS) {
  test(`bulk modal — ${mod.label} renders its fields while open`, async () => {
    storage = {};
    const bundle = await loadRenderer(mod.entry);

    assert.equal(typeof bundle[mod.export], 'function', `${mod.entry} should export ${mod.export}`);

    const html = render(bundle[mod.export], {
      open: true,
      productIds: ['a', 'b'],
      onClose: () => {},
      onDone: () => {},
    });

    for (const needle of mod.expect) {
      assert.ok(html.includes(needle), `${mod.label} modal should render "${needle}"`);
    }
  });

  test(`bulk modal — ${mod.label} persists under its own key via the shared shell`, () => {
    const src = fs.readFileSync(path.join(ROOT, mod.entry), 'utf8');
    assert.match(src, /from '\.\/BulkOpModal\.jsx'/, `${mod.label} should use the shared shell`);
    assert.match(src, new RegExp(`'${mod.storageKey.replace('.', '\\.')}'`), `${mod.label} should name its storage key`);
    assert.doesNotMatch(
      src,
      /loadPersistedFormState|savePersistedFormState|clearPersistedFormState/,
      `${mod.label} should not re-implement remembered-picks storage`,
    );
    assert.doesNotMatch(src, /<Modal[\s>]/, `${mod.label} should not hand-roll modal chrome`);
  });
}

test('bulk modal — remembered state still drives the conditional fields', async () => {
  // Convert: the Quality slider is hidden for PNG because PNG is lossless.
  storage = { 'Library.bulkConvert': JSON.stringify({ v: 1, s: { targetFormat: 'png' } }) };
  const convert = await loadRenderer('renderer/modules/ProductLibrary/BulkConvertModal.jsx');
  const pngHtml = render(convert.BulkConvertModal, { open: true, productIds: ['a'], onClose: () => {} });
  assert.ok(pngHtml.includes('PNG (.png)'), 'PNG should be selectable');
  assert.ok(!pngHtml.includes('aria-label="Quality value"'), 'Quality must be hidden for PNG');
  assert.ok(!pngHtml.includes('type="range"'), 'no slider should render for PNG');

  // …and shown for JPEG.
  storage = { 'Library.bulkConvert': JSON.stringify({ v: 1, s: { targetFormat: 'jpeg' } }) };
  const jpegHtml = render(convert.BulkConvertModal, { open: true, productIds: ['a'], onClose: () => {} });
  // v0.1.58: the quality control is now the shared SliderField (label + typeable
  // value box + range), not a bare range with "Quality: 85" in its label.
  assert.ok(jpegHtml.includes('aria-label="Quality value"'), 'Quality should be shown for JPEG');
  assert.ok(jpegHtml.includes('type="range"'), 'the quality slider should render for JPEG');

  // Resize: the background picker only exists for exact + contain.
  storage = { 'Library.bulkResize': JSON.stringify({ v: 1, s: { resizeMode: 'exact', fit: 'contain' } }) };
  const resize = await loadRenderer('renderer/modules/ProductLibrary/BulkResizeModal.jsx');
  const containHtml = render(resize.BulkResizeModal, { open: true, productIds: ['a'], onClose: () => {} });
  assert.ok(containHtml.includes('Background colour'), 'contain fit needs the background picker');
  assert.ok(containHtml.includes('Set background to #FFFFFF'), 'contain fit needs the swatches');

  // Same modal, cover fit: no padding is produced, so the picker is hidden.
  storage = { 'Library.bulkResize': JSON.stringify({ v: 1, s: { resizeMode: 'exact', fit: 'cover' } }) };
  const coverHtml = render(resize.BulkResizeModal, { open: true, productIds: ['a'], onClose: () => {} });
  assert.ok(!coverHtml.includes('Background colour'), 'cover fit must not show the background picker');

  // Long-edge mode: width/height are irrelevant and must not render.
  storage = { 'Library.bulkResize': JSON.stringify({ v: 1, s: { resizeMode: 'longEdge' } }) };
  const longEdgeHtml = render(resize.BulkResizeModal, { open: true, productIds: ['a'], onClose: () => {} });
  assert.ok(longEdgeHtml.includes('Max long edge (px)'), 'long-edge mode needs its single input');
  assert.ok(!longEdgeHtml.includes('Fit mode'), 'long-edge mode must not show fit mode');
});

/* ── useBulkPreview — shared by Auto-crop and Enhance ───────────────────── */

const PREVIEW_MODALS = [
  {
    label: 'Auto crop',
    entry: 'renderer/modules/ProductLibrary/AutoCropRunModal.jsx',
    export: 'AutoCropRunModal',
    requestChannel: 'reframePreview',
  },
  {
    label: 'Enhance',
    entry: 'renderer/modules/ProductLibrary/AutoEnhanceRunModal.jsx',
    export: 'AutoEnhanceRunModal',
    requestChannel: 'autoEnhancePreview',
  },
];

test('useBulkPreview — returns its documented initial shape', async () => {
  // Exercises the hook through React's own dispatcher, so a rules-of-hooks
  // violation or a first-render crash fails here. Effects do not run under
  // server rendering, so `sample` is still null — which is exactly the state
  // the modals render "No sample image" for.
  const { useBulkPreview } = await loadRenderer('renderer/modules/ProductLibrary/useBulkPreview.js');
  assert.equal(typeof useBulkPreview, 'function', 'useBulkPreview.js should export useBulkPreview');

  const React = require('react');
  const { renderToString } = require('react-dom/server');

  let seen = null;
  function Probe() {
    seen = useBulkPreview({
      open: true,
      productIds: ['p1'],
      skipPreview: false,
      requestPreview: async () => null,
      addToast: () => {},
    });
    return null;
  }

  assert.doesNotThrow(() => renderToString(React.createElement(Probe)));
  assert.ok(seen, 'the hook should have returned a value');
  assert.deepEqual(Object.keys(seen).sort(), ['afterUrl', 'beforeUrl', 'previewBusy', 'sample']);
  assert.equal(seen.sample, null);
  assert.equal(seen.beforeUrl, null);
  assert.equal(seen.afterUrl, null);
  assert.equal(seen.previewBusy, false);
});

for (const mod of PREVIEW_MODALS) {
  test(`bulk modal — ${mod.label} renders its preview while open`, async () => {
    const bundle = await loadRenderer(mod.entry);
    assert.equal(typeof bundle[mod.export], 'function', `${mod.entry} should export ${mod.export}`);

    const html = render(bundle[mod.export], {
      open: true,
      productIds: ['a', 'b'],
      onClose: () => {},
      onDone: () => {},
    });

    // No sample yet (effects don't run), so both panes show their empty text —
    // but the before/after figures only exist if the hook is wired in.
    assert.match(html, /before/i);
    assert.match(html, /after/i);
    assert.ok(html.includes('No sample image'), `${mod.label} should render its preview panes`);
  });

  test(`bulk modal — ${mod.label} uses the shared preview hook`, () => {
    const src = fs.readFileSync(path.join(ROOT, mod.entry), 'utf8');

    assert.match(src, /from '\.\/useBulkPreview\.js'/, `${mod.label} should use the shared preview hook`);
    // The duplicated plumbing must not come back.
    assert.doesNotMatch(src, /renderPreview/, `${mod.label} should not hand-roll the preview renderer`);
    assert.doesNotMatch(src, /afterUrlRef|debounceRef/, `${mod.label} should not own the blob-URL refs`);
    assert.doesNotMatch(src, /appImageSrc/, `${mod.label} should not build the before-URL itself`);
    assert.doesNotMatch(src, /URL\.createObjectURL|URL\.revokeObjectURL/, `${mod.label} should not manage blob URLs`);
    // It still asks for its own preview pixels.
    assert.ok(src.includes(mod.requestChannel), `${mod.label} should call images.${mod.requestChannel}`);
  });
}

test('useBulkPreview — keys the sample load on the first id, not the array', () => {
  // The Product Library passes `productIds={Array.from(selectedIds)}`, a NEW
  // array on every parent render. Depending on that array re-ran the load
  // effect on every re-render, clearing the sample and blinking the preview
  // back to "Rendering…". The effect only reads productIds[0], so that string
  // is the correct dependency and this pins it.
  const src = fs.readFileSync(path.join(ROOT, 'renderer/modules/ProductLibrary/useBulkPreview.js'), 'utf8');
  assert.match(src, /\[open, firstId\]/, 'the sample-load effect must depend on firstId');
  assert.doesNotMatch(src, /\[open, productIds\]/, 'depending on the productIds array restarts the load every render');
  assert.match(src, /const firstId = /, 'firstId should be derived once per render');
});
