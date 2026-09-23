/**
 * v0.1.64: the Label designer must stay usable.
 *
 * The complaint was not "a number is wrong" — it was "hard to pick or select
 * elements, hard to drag and drop around", and the cause was structural: the
 * element's mousedown handler did not stop propagation, so the canvas handler
 * ran afterwards and cleared the selection in the same tick. Nothing in the
 * unit suite could see that: the DB, the IPC and the renderer were all fine.
 *
 * So this scans the real sources for the things that make the editor work, and
 * for the specific shape of that bug. Static on purpose — it has to keep
 * running under plain `npm test`, and the UI crawl covers the runtime half.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MODULE = read('renderer/modules/LabelStudio/LabelTemplates.jsx');
const CANVAS = read('renderer/modules/LabelStudio/DesignerCanvas.jsx');
const LAYERS = read('renderer/modules/LabelStudio/DesignerLayers.jsx');
const GEOMETRY = read('renderer/modules/LabelStudio/designerGeometry.js');
const HISTORY = read('renderer/modules/LabelStudio/useDesignerHistory.js');
const IPC = read('main/ipc/labels.js');
const PRELOAD = read('main/preload.js');
const VALIDATORS = read('main/server/validators.js');

test('the canvas is a real designer, not a bare draggable box', () => {
  for (const [what, needle] of [
    ['fit-to-view zoom', 'fitScale'],
    ['marquee selection', 'marqueeHits'],
    ['smart guides', 'smartGuides'],
    ['resize handles', 'ld-handle'],
    ['multi-select bounding box', 'scaleSelection'],
    ['rimless drop from the palette', 'application/x-mskh-label-element'],
    ['⌘/Ctrl + wheel zoom', 'ctrlKey'],
    ['undo/redo', 'useDesignerHistory'],
  ]) {
    assert.ok(CANVAS.includes(needle) || MODULE.includes(needle), `${what} is missing (looked for ${needle})`);
  }
});

test('selecting an element cannot be undone by the canvas underneath', () => {
  // THE BUG. The element's handler must stop propagation before the canvas's
  // own mousedown runs, or the click selects and deselects in one tick and the
  // inspector never appears.
  const move = CANVAS.slice(CANVAS.indexOf('const startMove'), CANVAS.indexOf('const startResize'));
  assert.match(move, /e\.stopPropagation\(\)/,
    'startMove must stop propagation — without it the canvas clears the selection');
  assert.match(CANVAS, /onPointerDown=\{\(e\) => onPointerDown\(e, element\)\}/,
    'element boxes must be the things that start a move');
});

test('a drag pushes ONE history entry, not one per pointermove', () => {
  // `commit()` is called on pointerup; anything else would make undo useless.
  const commitLines = CANVAS.split('\n').filter((line) => line.includes('commit()'));
  assert.ok(commitLines.length >= 3, `expected a commit at the end of every gesture, found ${commitLines.length}`);
  assert.ok(!commitLines.some((line) => line.includes('onMove')),
    'commit() must not run inside a pointermove handler — that would push one history entry per pixel');
  // One commit per gesture: move, single resize, selection resize.
  const onUpCount = (CANVAS.match(/const onUp = \(\) => \{/g) || []).length;
  assert.equal(commitLines.length, onUpCount, 'every gesture needs exactly one commit');
  assert.match(HISTORY, /export function useDesignerHistory/);
});

test('element drawing mirrors what the printer does', () => {
  // pt-based type (the printer writes font-size: Npt) and real bwip-js
  // barcodes — the two reasons the old preview "looked off".
  assert.match(CANVAS, /ptToPx\(/, 'font sizes must be converted from points, like the print renderer');
  assert.match(CANVAS, /labels\.barcodePreview\(/, 'barcodes must be real bwip-js images, not a fake bar string');
  assert.match(CANVAS, /appImageSrc\(/, 'product and logo art should be shown through app-image://');
  assert.ok(!/designer-barcode/.test(CANVAS), 'the fake "|||| |||" barcode placeholder must be gone');
});

test('there is an exact preview of the real print render', () => {
  assert.match(CANVAS, /previewDraft/, 'the canvas must be able to show the real print document');
  assert.ok(IPC.includes("expose('labels:previewDraft'"), 'labels:previewDraft is not registered');
  assert.ok(PRELOAD.includes("'labels:previewDraft'"), 'preload does not expose previewDraft');
  assert.ok(PRELOAD.includes('previewDraft:'), 'window.api.labels.previewDraft is missing');
  assert.ok(VALIDATORS.includes("'labels:previewDraft'"), 'labels:previewDraft has no validator');
});

test('the layer list can select, hide, lock and reorder', () => {
  assert.match(LAYERS, /export function DesignerLayers/);
  for (const kind of ['hide', 'lock', 'reorder', 'rename']) {
    assert.ok(LAYERS.includes(`kind: '${kind}'`), `the layers panel cannot ${kind}`);
  }
  assert.match(MODULE, /<DesignerLayers/, 'the editor never renders the layer list');
});

test('the editor wires the whole toolset', () => {
  for (const [what, needle] of [
    ['alignment', 'alignSelection'],
    ['spread/distribute', 'distributeSelection'],
    ['keyboard nudging', 'ArrowLeft'],
    ['copy/paste-free duplicate', "toLowerCase() === 'd'"],
    ['delete', "e.key === 'Delete'"],
    ['select all', "toLowerCase() === 'a'"],
  ]) {
    assert.ok(MODULE.includes(needle), `${what} is missing (looked for ${needle})`);
  }
});

test('the geometry module keeps its promises (no DOM, no React)', () => {
  assert.ok(!/\bwindow\.|\bdocument\./.test(GEOMETRY), 'designerGeometry must stay pure');
  assert.ok(!/from 'react'/.test(GEOMETRY), 'designerGeometry must stay pure');
  for (const fn of ['fitScale', 'snapMm', 'clampBox', 'unionBounds', 'marqueeHits', 'smartGuides',
    'resizeElement', 'scaleSelection', 'alignPatches', 'distributePatches']) {
    assert.ok(GEOMETRY.includes(`function ${fn}`) || GEOMETRY.includes(`export function ${fn}`), `${fn} is missing`);
  }
});
