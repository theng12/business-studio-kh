/**
 * Home grid geometry — pure, so it is tested without a DOM.
 *
 * Columns: 3 below 760 px of room, 4 below 1200, 5 above (the window's
 * minimum is 1100 wide, so 4 is the usual case at 1280 × 800). The row count
 * is then made as even as possible — 7 tiles are 4 + 3, not 5 + 2 — and the
 * tiles are squares sized to fit BOTH the width and the height, so 8–10 tiles
 * fit a 1280 × 800 window without scrolling. Below MIN_TILE the grid scrolls
 * rather than shrinking tiles past legibility.
 */
export const TILE_GAP = 16;
export const MIN_TILE = 150;
export const MAX_TILE = 260;

export function maxColumnsFor(width) {
  if (width < 760) return 3;
  if (width < 1200) return 4;
  return 5;
}

export function gridLayout({ width, height, count, gap = TILE_GAP }) {
  const n = Math.max(1, count | 0);
  const maxCols = maxColumnsFor(width);
  const rows = Math.ceil(n / maxCols);
  const cols = Math.min(maxCols, Math.ceil(n / rows));
  const byWidth = (width - (cols - 1) * gap) / cols;
  const byHeight = height > 0 ? (height - (rows - 1) * gap) / rows : MAX_TILE;
  const size = Math.floor(Math.max(MIN_TILE, Math.min(MAX_TILE, byWidth, byHeight)));
  return { cols, rows, size };
}

/** The tile index an arrow key moves to; the same index at an edge. */
export function moveFocus(index, key, { cols, count }) {
  const last = count - 1;
  switch (key) {
    case 'ArrowRight': return Math.min(last, index + 1);
    case 'ArrowLeft': return Math.max(0, index - 1);
    case 'ArrowDown': return index + cols <= last ? index + cols : index;
    case 'ArrowUp': return index - cols >= 0 ? index - cols : index;
    case 'Home': return 0;
    case 'End': return last;
    default: return index;
  }
}
