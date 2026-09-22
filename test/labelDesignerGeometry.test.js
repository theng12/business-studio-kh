/**
 * v0.1.64: label designer geometry.
 *
 * This is the half of the designer that users argue about — "why did it snap
 * there?", "why can't I make it 0.5mm wide?", "why did the whole label move when
 * I dragged one corner?" — ported from the original Label Studio KH designer
 * (src/renderer/designer/Canvas.tsx + stores/designerStore.ts). The rules live
 * in renderer/modules/LabelStudio/designerGeometry.js with no React and no DOM,
 * so they can be checked here in plain `node --test`.
 *
 * The module is ESM (the renderer is ESM), so the test loads it through esbuild
 * exactly like test/currencies.test.js does for the renderer mirror.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
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

const el = (over = {}) => ({
  id: over.id || 'e1', type: over.type || 'text', x: 0, y: 0, width: 10, height: 5,
  visible: true, ...over,
});

test('fit scale keeps a label inside the stage and inside sane bounds', () => {
  // 60×40mm label in a 800×600 stage.
  const scale = G.fitScale(800, 600, 60, 40, 64);
  assert.ok(scale > 0.3 && scale < 10);
  // The longest side must fit: 60mm × 4px × scale ≤ 800-64.
  assert.ok(60 * G.PX_PER_MM_BASE * scale <= 800 - 64 + 0.001);
  assert.ok(40 * G.PX_PER_MM_BASE * scale <= 600 - 64 + 0.001);
  // Degenerate inputs must not produce NaN or a zero-scale canvas.
  assert.equal(G.fitScale(0, 0, 60, 40), 1);
  assert.equal(G.fitScale(800, 600, 0, 0), 1);
});

test('points convert to pixels the way print does', () => {
  // At CSS's own 96dpi a point is 1.3333px — that is what `font-size: Npt`
  // means in the printed document, so the designer must agree at 1:1.
  const oneToOne = G.CSS_PX_PER_MM;
  assert.ok(Math.abs(G.ptToPx(10, oneToOne) - 13.333) < 0.01);
  // And it scales linearly with zoom.
  assert.ok(Math.abs(G.ptToPx(10, oneToOne * 2) - 26.666) < 0.02);
});

test('snapping rounds to whole millimetres only when it is on', () => {
  assert.equal(G.snapMm(4.4, true), 4);
  assert.equal(G.snapMm(4.6, true), 5);
  assert.equal(G.snapMm(4.4, false), 4.4);
});

test('a box can never leave the label or collapse', () => {
  const label = { width: 60, height: 40 };
  assert.deepEqual(G.clampBox({ x: -5, y: -5, width: 10, height: 5 }, label.width, label.height), { x: 0, y: 0, width: 10, height: 5 });
  // Pushed off the right/bottom edge: it slides back so it stays whole.
  assert.deepEqual(G.clampBox({ x: 70, y: 50, width: 10, height: 5 }, label.width, label.height), { x: 50, y: 35, width: 10, height: 5 });
  // Zero/negative sizes are lifted to the minimum, not accepted.
  const tiny = G.clampBox({ x: 0, y: 0, width: 0, height: -3 }, label.width, label.height);
  assert.equal(tiny.width, G.MIN_SIZE_MM);
  assert.equal(tiny.height, G.MIN_SIZE_MM);
});

test('union bounds cover every element', () => {
  const box = G.unionBounds([
    el({ id: 'a', x: 2, y: 3, width: 4, height: 4 }),
    el({ id: 'b', x: 10, y: 1, width: 6, height: 2 }),
  ]);
  assert.deepEqual(box, { x: 2, y: 1, width: 14, height: 6 });
  assert.equal(G.unionBounds([]), null);
});

test('paint order sorts by z-index and keeps ties stable', () => {
  const order = G.inPaintOrder([
    el({ id: 'top', zIndex: 5 }), el({ id: 'bottom', zIndex: 1 }), el({ id: 'mid', zIndex: 3 }),
  ]).map((x) => x.id);
  assert.deepEqual(order, ['bottom', 'mid', 'top']);
});

test('marquee selects intersecting elements and ignores hidden ones', () => {
  const elements = [
    el({ id: 'inside', x: 2, y: 2, width: 2, height: 2 }),
    el({ id: 'overlap', x: 5, y: 5, width: 4, height: 4 }),
    el({ id: 'outside', x: 30, y: 30, width: 2, height: 2 }),
    el({ id: 'hidden', x: 2, y: 2, width: 2, height: 2, visible: false }),
  ];
  const hits = G.marqueeHits(elements, { x0: 0, y0: 0, x1: 6, y1: 6 });
  assert.deepEqual(hits.sort(), ['inside', 'overlap']);
  // A backwards drag (bottom-right → top-left) selects the same things.
  assert.deepEqual(G.marqueeHits(elements, { x0: 6, y0: 6, x1: 0, y1: 0 }).sort(), ['inside', 'overlap']);
});

test('smart guides snap an edge to a sibling and report the line', () => {
  const siblings = [el({ id: 's1', x: 20, y: 10, width: 10, height: 5 })];
  // 0.4mm away from the sibling's left edge → snaps exactly onto it.
  const guided = G.smartGuides({ x: 20.4, y: 3, width: 5, height: 5 }, siblings);
  assert.equal(guided.x, 20);
  assert.ok(guided.guides.some((g) => g.axis === 'x' && g.value === 20));
  // Far away → untouched, and no line drawn.
  const free = G.smartGuides({ x: 2, y: 3, width: 5, height: 5 }, siblings);
  assert.equal(free.x, 2);
  assert.deepEqual(free.guides, []);
});

test('smart guides match centres, not just edges', () => {
  const siblings = [el({ id: 's1', x: 10, y: 0, width: 10, height: 5 })]; // centre x = 15
  const guided = G.smartGuides({ x: 12.6, y: 20, width: 5, height: 5 }, siblings); // centre 15.1
  assert.ok(Math.abs(guided.x - 12.5) < 0.001, `expected the centre to line up, got ${guided.x}`);
  assert.ok(guided.guides.some((g) => g.axis === 'x' && g.value === 15));
});

test('a locked-aspect resize keeps the ratio from a corner', () => {
  const box = el({ width: 20, height: 10 }); // ratio 2
  const patch = G.resizeElement(box, 'se', 10, 1, { aspectLocked: true });
  assert.ok(Math.abs(patch.width / patch.height - 2) < 0.0001, `ratio drifted: ${patch.width}/${patch.height}`);
  assert.ok(patch.width > 20, 'dragging the se corner outwards must grow the box');
});

test('shift inverts the aspect lock', () => {
  const box = el({ width: 20, height: 10 });
  const locked = G.resizeElement(box, 'se', 10, 0, { aspectLocked: false, shiftKey: true });
  assert.ok(Math.abs(locked.width / locked.height - 2) < 0.0001, 'shift should have locked this type');
  // dx only: an unlocked corner resize stretches width and leaves height, so the
  // ratio must change. (dx=10,dy=5 would coincidentally keep ratio 2.)
  const unlocked = G.resizeElement(box, 'se', 10, 0, { aspectLocked: true, shiftKey: true });
  assert.equal(unlocked.width, 30);
  assert.equal(unlocked.height, 10);
  assert.ok(Math.abs(unlocked.width / unlocked.height - 2) > 0.01, 'shift should have unlocked this type');
});

test('west and north handles keep the opposite edge still', () => {
  const box = el({ x: 20, y: 20, width: 20, height: 10 });
  const west = G.resizeElement(box, 'w', -5, 0, {});
  assert.equal(west.x, 15, 'the left edge follows the pointer');
  assert.equal(west.width, 25, 'and the right edge stays put');
  const north = G.resizeElement(box, 'n', 0, -3, {});
  assert.equal(north.y, 17);
  assert.equal(north.height, 13);
});

test('a resize cannot collapse a box below the minimum', () => {
  const box = el({ width: 10, height: 10 });
  const patch = G.resizeElement(box, 'se', -100, -100, {});
  assert.equal(patch.width, G.MIN_SIZE_MM);
  assert.equal(patch.height, G.MIN_SIZE_MM);
});

test('scaling a selection keeps relative layout around the anchor', () => {
  const snapshot = [
    { id: 'a', x: 0, y: 0, width: 10, height: 10 },
    { id: 'b', x: 20, y: 0, width: 10, height: 10 },
  ];
  const doubled = G.scaleSelection(snapshot, 2, 1, 'left');
  const a = doubled.find((p) => p.id === 'a').patch;
  const b = doubled.find((p) => p.id === 'b').patch;
  // Left anchor: the left element stays, the right one moves away and doubles.
  assert.equal(a.x, 0);
  assert.equal(a.width, 20);
  assert.equal(b.x, 40);
  assert.equal(b.width, 20);
});

test('align lines the selection up against its own box, or the label', () => {
  const list = [el({ id: 'a', x: 5, y: 5, width: 4, height: 2 }), el({ id: 'b', x: 10, y: 9, width: 6, height: 2 })];
  const left = G.alignPatches(list, 'left');
  assert.deepEqual(left.map((p) => p.patch.x), [5, 5]);
  const bottom = G.alignPatches(list, 'bottom');
  assert.deepEqual(bottom.map((p) => p.patch.y), [9, 9]);
  // Against the label, not the selection.
  const inLabel = G.alignPatches(list, 'center', { widthMm: 60, heightMm: 40 });
  assert.deepEqual(inLabel.map((p) => p.patch.x), [28, 27]);
});

test('spread needs three elements and leaves the extremes alone', () => {
  assert.deepEqual(G.distributePatches([el({ id: 'a' }), el({ id: 'b' })], 'x'), []);
  const patches = G.distributePatches([
    el({ id: 'a', x: 0, width: 2 }), el({ id: 'b', x: 10, width: 2 }), el({ id: 'c', x: 20, width: 2 }),
  ], 'x');
  assert.equal(patches.length, 1, 'only the middle element moves');
  assert.equal(patches[0].id, 'b');
  assert.equal(patches[0].patch.x, 10, 'evenly spaced already — no move needed');
  const moved = G.distributePatches([
    el({ id: 'a', x: 0, width: 2 }), el({ id: 'b', x: 4, width: 2 }), el({ id: 'c', x: 20, width: 2 }),
  ], 'x');
  assert.equal(moved[0].patch.x, 10);
});

test('layer names are derived when a template predates them', () => {
  assert.equal(G.elementLabel({ type: 'text', field: 'name' }), 'Text · name');
  assert.equal(G.elementLabel({ type: 'barcode' }), 'Barcode');
  assert.equal(G.elementLabel({ type: 'qr', name: 'Scan me' }), 'Scan me');
});

test('a stored element list is repaired before the designer can select it', () => {
  const fixed = G.normalizeElements([
    { id: 'keep', type: 'barcode' },
    { type: 'text' },                       // no id
    { id: 'dup', type: 'qr' },
    { id: 'dup', type: 'logo' },            // duplicated id
    null,                                   // junk row
  ], () => 1234);
  assert.equal(fixed.length, 5);
  assert.equal(fixed[0].id, 'keep');
  assert.ok(fixed[1].id, 'a missing id must be filled in');
  assert.notEqual(fixed[3].id, fixed[2].id, 'duplicate ids must be separated');
  assert.equal(new Set(fixed.map((el) => el.id)).size, 5, 'every element needs its own id');
  assert.equal(fixed[1].type, 'text', 'a missing type must not leave an undrawable element');
  assert.equal(fixed[4].type, 'text', 'a junk row becomes a usable element, not a crash');
  // Already-valid lists are left alone (same ids, same order).
  const stable = G.normalizeElements([{ id: 'a', type: 'text' }, { id: 'b', type: 'rect' }]);
  assert.deepEqual(stable.map((el) => el.id), ['a', 'b']);
});
