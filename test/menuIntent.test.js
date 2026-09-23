/**
 * v0.1.72: unit tests for the Bulk actions menu's directional hover intent.
 *
 * `pointsTowardRect` is the pure geometry behind the submenu hover rule: a
 * pointer crossing a neighbouring section trigger on its way to the open
 * submenu must not have that submenu swapped underneath it. The helper is
 * plain ESM (.mjs) with no DOM, so it runs under plain `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/modules/ProductLibrary/menuIntent.mjs');

// A submenu sitting to the right of, and roughly level with, its trigger row.
const SUBMENU = { left: 320, top: 100, right: 620, bottom: 260 };
// A generic square used by the geometry cases.
const RECT = { left: 100, top: 100, right: 200, bottom: 200 };

test('pointsTowardRect is true when the movement heads into the rect', async () => {
  const { pointsTowardRect } = await load();
  // Straight at it from the left, finishing short of the edge.
  assert.equal(pointsTowardRect({ x: 50, y: 150 }, { x: 90, y: 150 }, RECT), true);
  // Straight down a column that overlaps the rect.
  assert.equal(pointsTowardRect({ x: 150, y: 50 }, { x: 150, y: 90 }, RECT), true);
  // Diagonally at the near corner.
  assert.equal(pointsTowardRect({ x: 50, y: 50 }, { x: 80, y: 80 }, RECT), true);
  // Finishing inside the rect counts.
  assert.equal(pointsTowardRect({ x: 50, y: 150 }, { x: 150, y: 150 }, RECT), true);
});

test('pointsTowardRect is false when the movement points away or misses', async () => {
  const { pointsTowardRect } = await load();
  assert.equal(pointsTowardRect({ x: 250, y: 150 }, { x: 300, y: 150 }, RECT), false);
  assert.equal(pointsTowardRect({ x: 50, y: 150 }, { x: 10, y: 150 }, RECT), false);
  // Straight down, but outside the rect's column.
  assert.equal(pointsTowardRect({ x: 50, y: 50 }, { x: 50, y: 90 }, RECT), false);
  // Diagonal down-left, away from it.
  assert.equal(pointsTowardRect({ x: 50, y: 50 }, { x: 20, y: 80 }, RECT), false);
  // Aimed above/below the rect even though the line of travel is slanted.
  assert.equal(pointsTowardRect({ x: 0, y: 0 }, { x: 10, y: 10 }, { left: 10, top: 30, right: 20, bottom: 40 }), false);
  // The rect is behind the direction of travel, not ahead of it.
  assert.equal(pointsTowardRect({ x: 50, y: 150 }, { x: 60, y: 150 }, { left: 0, top: 100, right: 40, bottom: 200 }), false);
});

test('pointsTowardRect returns false for "no clear direction" and bad input', async () => {
  const { pointsTowardRect } = await load();
  // Stationary pointer: the caller routes this to the fallback delay.
  assert.equal(pointsTowardRect({ x: 50, y: 150 }, { x: 50, y: 150 }, RECT), false);
  // Starting inside the rect means leaving it, not heading at it.
  assert.equal(pointsTowardRect({ x: 150, y: 150 }, { x: 250, y: 150 }, RECT), false);
  // Missing / malformed inputs never throw.
  assert.equal(pointsTowardRect(null, { x: 1, y: 1 }, RECT), false);
  assert.equal(pointsTowardRect({ x: 1, y: 1 }, null, RECT), false);
  assert.equal(pointsTowardRect({ x: 1, y: 1 }, { x: 2, y: 2 }, null), false);
  assert.equal(pointsTowardRect({ x: Number.NaN, y: 0 }, { x: 10, y: 0 }, RECT), false);
  // An inverted rect is malformed and must not be treated as a target.
  assert.equal(pointsTowardRect({ x: 0, y: 0 }, { x: 10, y: 0 }, { left: 10, top: 0, right: 5, bottom: 5 }), false);
});

test('the actual menu case: crossing a lower trigger on the way to the submenu', async () => {
  const { pointsTowardRect } = await load();
  // Pointer leaves the open trigger's row heading at the submenu beside it.
  assert.equal(pointsTowardRect({ x: 120, y: 110 }, { x: 300, y: 150 }, SUBMENU), true);
  // The same pointer just moving down the trigger column (choosing a section
  // below) does not point at the submenu, so the fallback delay takes over.
  assert.equal(pointsTowardRect({ x: 120, y: 110 }, { x: 120, y: 200 }, SUBMENU), false);
});
