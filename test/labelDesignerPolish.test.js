/**
 * v0.1.72: the four label-designer polish gaps.
 *
 * The v0.1.64 designer fixed "hard to pick or select, hard to drag and drop";
 * an audit at v0.1.71 found four things still wrong. This file pins the two
 * that live in pure code — rotation-aware geometry and the shift-click toggle —
 * and then statically checks the two that only exist at runtime (Pointer Events
 * for touch/stylus, and Space/middle-button drag-to-pan), because the pure
 * `node --test` suite cannot render a component. The UI crawl exercises the
 * runtime half against a real Electron window.
 *
 * The geometry module is ESM (the renderer is ESM), so it is loaded through
 * esbuild exactly like test/labelDesignerGeometry.test.js does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadGeometry() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/modules/LabelStudio/designerGeometry.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const G = loadGeometry();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CANVAS = read('renderer/modules/LabelStudio/DesignerCanvas.jsx');
const CSS = read('renderer/index.css');

const el = (over = {}) => ({
  id: over.id || 'e1', type: over.type || 'text', x: 0, y: 0, width: 10, height: 5,
  visible: true, ...over,
});

/* ── rotation-aware geometry ─────────────────────────────────────────── */

test('rotatedBounds is a no-op for an unrotated element', () => {
  assert.deepEqual(G.rotatedBounds({ x: 3, y: 4, width: 8, height: 2 }), { x: 3, y: 4, width: 8, height: 2 });
});

test('rotatedBounds is the axis-aligned box after rotating about the centre', () => {
  const near = (actual, expected, tol = 1e-9) => assert.ok(Math.abs(actual - expected) < tol,
    `expected ${expected}, got ${actual}`);
  // 90° swaps the half-extents but keeps the centre (and is exact, not 2.0000000000000004).
  assert.deepEqual(
    G.rotatedBounds({ x: 20, y: 20, width: 4, height: 2, rotation: 90 }),
    { x: 21, y: 19, width: 2, height: 4 },
  );
  // 180° lands back on the original box.
  assert.deepEqual(
    G.rotatedBounds({ x: 20, y: 20, width: 4, height: 2, rotation: 180 }),
    { x: 20, y: 20, width: 4, height: 2 },
  );
  // 45° of a 4×4 box: half-extent = 2·cos45 + 2·sin45 = 2√2.
  const diag = G.rotatedBounds({ x: 10, y: 0, width: 4, height: 4, rotation: 45 });
  const half = 2 * Math.SQRT2;
  near(diag.width, half * 2); near(diag.height, half * 2);
  near(diag.x, 12 - half); near(diag.y, 2 - half);
});

test('marquee hit-testing uses the rotated bounding box', () => {
  const rotated = el({ id: 'rotated', x: 10, y: 0, width: 4, height: 4, rotation: 45 });
  const plain = el({ id: 'plain', x: 10, y: 0, width: 4, height: 4 });
  // A thin strip just left of the raw box: only the rotated element reaches it.
  const strip = { x0: 8.8, y0: 1, x1: 9.6, y1: 2 };
  const hits = G.marqueeHits([rotated, plain], strip);
  assert.deepEqual(hits, ['rotated']);
  // With no rotation the plain element is hit by a strip that overlaps its box.
  assert.deepEqual(G.marqueeHits([plain], { x0: 10.5, y0: 0.5, x1: 11, y1: 1.5 }), ['plain']);
  // A rotated element is still skipped when it is hidden.
  assert.deepEqual(G.marqueeHits([{ ...rotated, visible: false }], strip), []);
});

test('smart guides align against a rotated sibling’s bounding box', () => {
  const sibling = el({ id: 's', x: 20, y: 10, width: 4, height: 4, rotation: 45 });
  // Raw left edge is 20; the on-screen edge is 22 − 2√2 ≈ 19.1716.
  const screenLeft = 22 - 2 * Math.SQRT2;
  const guided = G.smartGuides({ x: 18.9, y: 3, width: 5, height: 5 }, [sibling]);
  assert.ok(Math.abs(guided.x - screenLeft) < 1e-6, `expected ${screenLeft}, got ${guided.x}`);
  assert.notEqual(guided.x, 20, 'the guide must not use the unrotated left edge');
  assert.ok(guided.guides.some((g) => g.axis === 'x' && Math.abs(g.value - screenLeft) < 1e-6));
});

test('resizing a rotated element still uses unrotated maths (deliberate)', () => {
  // The ponytail: note in resizeElement says rotation-aware resize is out of
  // scope, so a rotated box resizes along its own axes, exactly like a flat one.
  const flat = { id: 'a', x: 10, y: 10, width: 20, height: 10 };
  const tilted = { ...flat, rotation: 45 };
  assert.deepEqual(G.resizeElement(tilted, 'se', 10, 0, {}), G.resizeElement(flat, 'se', 10, 0, {}));
  assert.deepEqual(G.resizeElement(tilted, 'se', 10, 0, {}), { width: 30, height: 10 });
});

/* ── shift-click toggle (shared by canvas and Layers) ───────────────── */

test('toggleSelected adds, removes, and keeps selection order', () => {
  assert.deepEqual(G.toggleSelected([], 'a'), ['a']);
  assert.deepEqual(G.toggleSelected(undefined, 'a'), ['a']);
  assert.deepEqual(G.toggleSelected(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(G.toggleSelected(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(G.toggleSelected(['a'], 'a'), []);
});

test('the canvas and the Layers list share the same toggle', () => {
  const layers = read('renderer/modules/LabelStudio/DesignerLayers.jsx');
  assert.match(layers, /toggleSelected\(selectedIds, el\.id\)/,
    'the Layers panel must use the shared toggle so the two cannot disagree');
  const move = CANVAS.slice(CANVAS.indexOf('const startMove'), CANVAS.indexOf('const startResize'));
  assert.match(move, /toggleSelected\(selectedIds, element\.id\)/,
    'shift-click on the canvas must toggle, not only add');
  assert.ok(move.indexOf('toggleSelected') < move.indexOf('const movers'),
    'a shift-click that deselects must return before the drag is seeded');
  assert.match(move, /elements\.filter\(\(el\) => moveIds\.includes\(el\.id\)/,
    'movers must come from the selection the click produced, not the old one');
  assert.match(move, /else if \(wasSelected && selectedIds\.length > 1\)/,
    'a plain click on a selected member must keep the group drag');
});

/* ── runtime halves (static, since there is no DOM here) ─────────────── */

test('every drag gesture is a Pointer Event, not a mouse event', () => {
  assert.match(CANVAS, /onPointerDown=\{onCanvasPointerDown\}/, 'the marquee must start on pointerdown');
  assert.match(CANVAS, /onPointerDown=\{\(e\) => onPointerDown\(e, element\)\}/, 'elements must start a move on pointerdown');
  assert.match(CANVAS, /onPointerDown=\{\(e\) => onResize\(e, element, dir\)\}/, 'resize handles must use pointerdown');
  assert.match(CANVAS, /onPointerDown=\{\(e\) => startSelectionResize\(e, dir\)\}/, 'the selection box handles must use pointerdown');
  assert.ok(CANVAS.includes("addEventListener('pointermove'"), 'drags must listen for pointermove on window');
  assert.ok(CANVAS.includes("addEventListener('pointerup'"), 'drags must end on pointerup');
  assert.ok(!CANVAS.includes("addEventListener('mousemove'"), 'no drag may still listen for mousemove');
  assert.ok(!CANVAS.includes('onMouseDown='), 'no gesture may still start on mousedown');
  assert.match(CANVAS, /setPointerCapture/, 'touch/stylus drags need pointer capture to survive leaving the box');
});

test('Space / middle-button drag pans the stage without moving or marqueeing', () => {
  assert.match(CANVAS, /onPointerDown=\{onStagePointerDown\}/, 'the stage needs its own pointerdown for pan');
  assert.match(CANVAS, /scrollLeft = startLeft - \(ev\.clientX - startX\)/, 'pan must set scrollLeft');
  assert.match(CANVAS, /scrollTop = startTop - \(ev\.clientY - startY\)/, 'pan must set scrollTop');
  // A pan is never also a select/move/marquee.
  assert.match(CANVAS, /const isPanGesture = useCallback\(\(e\) => e\.button === 1 \|\| spaceRef\.current/);
  const guards = CANVAS.match(/if \(isPanGesture\(e\)\) return;/g) || [];
  assert.ok(guards.length >= 4, `every gesture starter must bail on a pan (found ${guards.length})`);
  assert.match(CANVAS, /isPanGesture\(e\)\) return;[^\n]*does not marquee/,
    'a pan must not start a marquee');
  // The hand tool is armed by Space and disarmed on release/blur.
  assert.match(CANVAS, /e\.key !== ' ' && e\.code !== 'Space'/);
  assert.match(CANVAS, /isField\(e\.target\)/, 'Space in a text field must not become a pan');
  assert.match(CANVAS, /window\.addEventListener\('blur', release\)/);
});

test('the pan cursor and touch-action live in the label-designer CSS block', () => {
  assert.match(CSS, /\.ld-stage\.is-pan-ready[^{]*\{[^}]*cursor: grab/);
  assert.match(CSS, /\.ld-stage\.is-panning[^{]*\{[^}]*cursor: grabbing/);
  assert.match(CSS, /\.ld-canvas \{[^}]*touch-action: none/);
  assert.match(CSS, /\.ld-el, \.ld-handle \{ touch-action: none; \}/);
});
