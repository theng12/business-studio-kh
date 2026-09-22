/**
 * v0.1.66: paste rules for the bulk edit table.
 *
 * Pure, so the two decisions the owner made are testable without a DOM:
 *
 *   - a paste WIDER than the columns that fit from the focused cell is refused
 *     whole, with the reason (silently dropping columns is how a price lands in
 *     a colour field);
 *   - a paste TALLER than the products left below the focused cell is refused
 *     whole too — no partial paste.
 *
 * Tab-separated text is what every spreadsheet puts on the clipboard, so this
 * parses it with split() and no library.
 */
export const GRID_MAX_ROWS = 200;

/** Clipboard text → rows of cells. Tolerates CRLF and a trailing newline. */
export function parseClipboardTable(text) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!clean) return [];
  return clean.split('\n').map((line) => line.split('\t'));
}

/**
 * Work out what a clipboard paste would write.
 *
 * @returns {{ok: true, cells: Array<{row:number,col:number,key:string,value:string}>}
 *          | {ok: false, reason: string}}
 *
 * A BLANK clipboard cell is skipped rather than written: clearing a field by
 * pasting an empty cell is almost never what someone means, and the cell can be
 * emptied by hand when it is.
 */
export function planPaste({ text, rowIndex, colIndex, columns, rowCount, imageCount = 0 }) {
  if (imageCount > 1) {
    return { ok: false, reason: `The clipboard has ${imageCount} images — paste them one at a time.` };
  }
  const block = parseClipboardTable(text);
  if (!block.length) return { ok: false, reason: 'Nothing to paste.' };
  if (imageCount === 0 && !block.some((row) => row.some((cell) => cell !== ''))) {
    return { ok: false, reason: 'Nothing to paste.' };
  }

  const width = Math.max(...block.map((row) => row.length));
  const room = columns.length - colIndex;
  if (width > room) {
    return {
      ok: false,
      reason: `That paste is ${width} columns wide, and only ${room} fit from here (${columns.slice(colIndex).join(' → ')}). `
        + 'Move to an earlier column, or drop the extra columns.',
    };
  }
  const rowRoom = rowCount - rowIndex;
  if (block.length > rowRoom) {
    return {
      ok: false,
      reason: `That paste has ${block.length} rows, and there ${rowRoom === 1 ? 'is 1 product' : `are ${rowRoom} products`} below this cell.`,
    };
  }

  const cells = [];
  block.forEach((line, r) => {
    line.forEach((value, c) => {
      if (value === '') return;
      cells.push({ row: rowIndex + r, col: colIndex + c, key: columns[colIndex + c], value });
    });
  });
  return { ok: true, cells };
}

/** The focused row's values, tab-separated, for ⌘C. */
export function rowToTsv(columns, valueAt) {
  return columns.map((key) => String(valueAt(key) ?? '')).join('\t');
}
