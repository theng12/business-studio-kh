/**
 * Regression for the product-import workbook reader.
 *
 * Two real-world spreadsheet shapes produced a dead-end or silent data loss
 * before this:
 *   - a duplicate column header (e.g. a stray second "SKU") collapsed the two
 *     columns into one key, so the later empty column blanked every SKU value
 *     and the preview read "out of 0 rows";
 *   - a title row above the header row became the only header, so no column
 *     was recognized and Preview stayed disabled with no explanation.
 *
 * These are pure parser checks — no DB, so they run under plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { readWorkbook } = require('../main/fileHandler');

function writeBook(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-workbook-'));
  const file = path.join(dir, 'book.xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(wb, file);
  return { file, dir };
}

function withBook(rows, fn) {
  const { file, dir } = writeBook(rows);
  try { return fn(readWorkbook(file).sheets[0]); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('readWorkbook keeps a duplicate header column distinct so its values survive', () => {
  withBook([
    ['SKU', 'Name', 'SKU', 'Price'],
    ['A-1', 'Widget', '', 10],
    ['A-2', 'Gadget', '', 20],
  ], (sheet) => {
    assert.deepEqual(sheet.headers, ['SKU', 'Name', 'SKU (2)', 'Price']);
    assert.equal(sheet.rows[0].SKU, 'A-1', 'the first SKU column must not be blanked by the duplicate');
    assert.equal(sheet.rows[1].SKU, 'A-2');
    assert.equal(sheet.rows[0]['SKU (2)'], '');
    assert.equal(sheet.rowCount, 2);
  });
});

test('readWorkbook disambiguates repeated empty headers instead of collapsing them', () => {
  withBook([
    ['SKU', '', '', 'Price'],
    ['A-1', '', '', 10],
  ], (sheet) => {
    assert.equal(new Set(sheet.headers).size, sheet.headers.length, 'headers must be unique keys');
    assert.equal(sheet.rows[0].SKU, 'A-1');
    assert.equal(sheet.rows[0].Price, 10);
  });
});

test('readWorkbook flags a title row above the header row', () => {
  withBook([
    ['Product catalogue 2026'],
    ['SKU', 'Name', 'Price'],
    ['A-1', 'Widget', 10],
  ], (sheet) => {
    assert.equal(sheet.looksLikeTitleRow, true);
  });
});

test('readWorkbook does not flag a normal header row', () => {
  withBook([
    ['SKU', 'Name', 'Price'],
    ['A-1', 'Widget', 10],
  ], (sheet) => {
    assert.equal(sheet.looksLikeTitleRow, false);
    assert.deepEqual(sheet.headers, ['SKU', 'Name', 'Price']);
    assert.equal(sheet.rowCount, 1);
  });
});

test('readWorkbook does not flag a single-column sheet whose header sits in row 1', () => {
  withBook([
    ['SKU'],
    ['A-1'],
    ['A-2'],
  ], (sheet) => {
    assert.equal(sheet.looksLikeTitleRow, false);
  });
});
