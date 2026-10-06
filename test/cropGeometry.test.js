const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
async function load(file, overrides = {}) {
  const out = await require('esbuild').build({ entryPoints: [path.join(root, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent' });
  const mod = { exports: {} }, req = createRequire(path.join(root, 'package.json'));
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((name) => overrides[name] || req(name), mod, mod.exports);
  return mod.exports;
}

test('source-space crop ratio survives letterboxing, custom ratios, edge drags and resizes', async () => {
  const g = await load('renderer/modules/ImageWorkspace/cropGeometry.js');
  assert.equal(g.parseAspectRatio('custom-3:2'), 1.5);
  for (const [W, H] of [[4000, 2000], [2000, 4000]]) {
    const bounds = g.containedImageBounds(W, H, 400, 400);
    assert.equal(bounds.width / bounds.height, W / H);
    assert.deepEqual([bounds.left, bounds.top], W > H ? [0, 100] : [100, 0]);
    for (const ratio of [1, 4 / 3]) {
      const aspect = g.rectAspectFromOutput(ratio, W, H);
      const check = (rect) => {
        assert.ok(Math.abs(rect.width * W / (rect.height * H) - ratio) < 1e-10);
        assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1 + 1e-10 && rect.y + rect.height <= 1 + 1e-10);
      };
      const rect = g.buildDragRect({ x: 0.8, y: 0.1 }, { x: 1, y: 0.9 }, aspect);
      check(rect);
      for (const handle of ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']) check(g.resize(rect, handle, { x: 1, y: 1 }, aspect));
      check(g.reshapeCropRect({ x: 0.1, y: 0.2, width: 0.7, height: 0.8 }, ratio, W, H));
    }
  }
});

test('keyboard crop creation, pixel steps and resizing preserve source bounds and output ratio', async () => {
  const g = await load('renderer/modules/ImageWorkspace/cropGeometry.js');
  for (const [W, H] of [[4000, 2000], [2000, 4000]]) {
    for (const ratio of [null, 1, 4 / 3, 9 / 16]) {
      let rect = g.keyboardCropRect(null, { key: 'Enter' }, W, H, ratio);
      assert.ok(rect.width > 0 && rect.height > 0);
      rect = { x: 0.35, y: 0.35, width: rect.width / 4, height: rect.height / 4 };
      const moved = g.keyboardCropRect(rect, { key: 'ArrowRight', shiftKey: true }, W, H, ratio);
      assert.ok(Math.abs((moved.x - rect.x) * W - 10) < 1e-9);
      const up = g.keyboardCropRect(rect, { key: 'ArrowUp' }, W, H, ratio);
      assert.ok(Math.abs((rect.y - up.y) * H - 1) < 1e-9);
      const wider = g.keyboardCropRect(rect, { key: 'ArrowRight', altKey: true }, W, H, ratio);
      assert.ok(Math.abs((wider.width - rect.width) * W - 1) < 1e-9);
      const taller = g.keyboardCropRect(rect, { key: 'ArrowDown', altKey: true }, W, H, ratio);
      assert.ok(Math.abs((taller.height - rect.height) * H - 1) < 1e-9);
      for (const altKey of [false, true]) {
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          for (let i = 0; i < 500; i++) rect = g.keyboardCropRect(rect, { key, shiftKey: true, altKey }, W, H, ratio);
          assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0);
          assert.ok(rect.x + rect.width <= 1 + 1e-10 && rect.y + rect.height <= 1 + 1e-10);
          if (ratio) assert.ok(Math.abs(rect.width * W / (rect.height * H) - ratio) < 1e-9);
        }
      }
      assert.equal(g.keyboardCropRect(rect, { key: 'Enter' }, W, H, ratio), rect, 'Enter must not replace an existing crop');
      assert.equal(g.keyboardCropRect(rect, { key: 'a' }, W, H, ratio), rect);
    }
  }
});

test('processing recipe reflects effective processing settings, with draft crop and preview toggles excluded', async () => {
  const { processingRecipe } = await load('renderer/modules/ImageWorkspace/processingRecipe.js');
  const { defaultSettings } = await load('renderer/lib/workspaceSettings.js');
  const defaults = defaultSettings();
  assert.equal(processingRecipe(defaults), '2000 × 2000 px · PNG · 85% fill · Remove background · White canvas · No watermark');
  const settings = { ...defaults, canvasWidth: 20, canvasHeight: 9000, productFillPct: 200, removeBackground: false,
    rotation: -90, backgroundColor: '#123456', shadow: true, brightness: 8, contrast: -20, autoAdjust: true,
    tone: { exposure: -50 }, detail: { sharpen: 17, denoise: 120 },
    sourceCropRect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, cropStraighten: 9,
    watermark: { enabled: true, relativePath: null } };
  assert.equal(processingRecipe(settings), '64 × 8192 px · PNG · 100% fill · Keep background · #123456 canvas · Rotate 270° · Auto-adjust · Brightness +8 · Contrast -20 · Exposure -0.5 stop · Sharpen 17 · Noise reduction 100 · Watermark needs a logo');
  const recipe = processingRecipe({ ...settings, removeBackground: true, cropRect: { x: 0, y: 0, width: 0.7, height: 1 }, watermark: { enabled: true, relativePath: 'logo.png', corner: 'tl', opacity: 0.6 } });
  assert.match(recipe, /Shadow · Canvas crop/);
  assert.match(recipe, /Watermark top left 60%$/);
  assert.doesNotMatch(recipe, /Straighten|Source crop/);
});

test('actual CanvasView excludes letterboxing and processed image from crop pointer geometry', async () => {
  let cursor = 0, dirty = false, pending = [], hooks = [];
  const listeners = new Map();
  const oldWindow = global.window, oldObserver = global.ResizeObserver, oldDocument = global.document;
  global.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  global.document = { querySelector: () => null };
  global.ResizeObserver = class { observe() {} disconnect() {} };
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ||= { value: initial }; return [hooks[i].value, (v) => { const next = typeof v === 'function' ? v(hooks[i].value) : v; if (next !== hooks[i].value) { hooks[i].value = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, old = hooks[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) pending.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; }); },
  };
  const jsx = (type, props) => {
    if (props?.ref) {
      const style = props.style || {};
      props.ref.current = { clientWidth: 400, clientHeight: 400, getBoundingClientRect: () => ({ left: 10 + (style.left || 0), top: 20 + (style.top || 0), width: style.width || 400, height: style.height || 400 }) };
    }
    return { type, props: props || {} };
  };
  const find = (node, fn) => { if (!node || typeof node !== 'object') return null; if (fn(node)) return node; return Object.values(node).flatMap((v) => Array.isArray(v) ? v : [v]).map((v) => find(v, fn)).find(Boolean) || null; };
  try {
    const { CanvasView } = await load('renderer/modules/ImageWorkspace/CanvasView.jsx', { react: React, 'react/jsx-runtime': { jsx, jsxs: jsx } });
    let selected;
    let props = { image: { id: 'raw', filepath: 'raw.png', processedFilepath: 'wrong.png' }, settings: { canvasWidth: 2000, canvasHeight: 2000, cropAspectRatio: '1:1' }, zoom: 1, cropMode: true, cropPreview: { url: 'blob:raw-rotated-preview', outW: 4000, outH: 2000 }, onCropChange: (rect) => { selected = rect; }, onDividerChange() {} };
    let output;
    const render = () => { for (let n = 0; n < 8; n++) { cursor = 0; dirty = false; pending = []; output = CanvasView(props); pending.forEach((fn) => fn()); if (!dirty) return; } assert.fail('Canvas did not settle'); };
    render();
    const img = find(output, (n) => n.type === 'img');
    assert.equal(img.props.src, 'blob:raw-rotated-preview');
    assert.equal(find(output, (n) => n.props?.children === 'Apply crop').props.disabled, true, 'Apply waits for the actual reference image load');
    img.props.onLoad();
    render();
    const overlay = find(output, (n) => n.props?.className === 'ws-crop');
    assert.deepEqual(overlay.props.style, { inset: 'auto', left: 0, top: 100, width: 400, height: 200 });
    overlay.props.onMouseDown({ clientX: 110, clientY: 145, preventDefault() {}, target: {} });
    render();
    listeners.get('mousemove')({ clientX: 210, clientY: 245 });
    assert.deepEqual(selected, { x: 0.25, y: 0.125, width: 0.25, height: 0.5 });
    assert.equal(selected.width * 4000, selected.height * 2000, 'pointer selection saves square source pixels');
    listeners.get('mouseup')();
    render();
    const keys = (key, extra = {}) => ({ key, target: {}, preventDefault() {}, stopPropagation() {}, ...extra });
    find(output, (n) => n.props?.className === 'ws-crop').props.onKeyDown(keys('Enter'));
    assert.deepEqual(selected, { x: 0.25, y: 0, width: 0.5, height: 1 }, 'keyboard creation uses actual source aspect');
    props = { ...props, settings: { ...props.settings, sourceCropRect: selected } };
    render();
    find(output, (n) => n.props?.className === 'ws-crop').props.onKeyDown(keys('ArrowRight', { shiftKey: true }));
    assert.equal(selected.x, 0.2525);
    const previous = selected;
    global.document.querySelector = () => ({});
    find(output, (n) => n.props?.className === 'ws-crop').props.onKeyDown(keys('ArrowRight'));
    assert.equal(selected, previous, 'modal dialogs block keyboard crop edits');
    global.document.querySelector = () => null;
    props = { ...props, cropPreview: null };
    render();
    assert.equal(find(output, (n) => n.props?.className === 'ws-crop'), null, 'loading preview cannot retain old crop geometry');
    assert.equal(find(output, (n) => n.props?.children === 'Apply crop').props.disabled, true);
    props = { ...props, cropMode: false, viewMode: 'beforeAfter', divider: 50 };
    render();
    const divider = find(output, (n) => n.type === 'input' && n.props?.['aria-label'] === 'Before / after divider');
    assert.equal(divider.props.type, 'range');
    assert.equal(divider.props['aria-valuetext'], '50% raw, 50% processed');
    for (const label of ['Zoom in', 'Zoom out']) assert.ok(find(output, (n) => n.type === 'button' && n.props?.['aria-label'] === label));
  } finally {
    hooks.forEach((hook) => hook?.cleanup?.());
    global.window = oldWindow; global.ResizeObserver = oldObserver; global.document = oldDocument;
  }
});
