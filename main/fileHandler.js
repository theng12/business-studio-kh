const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

function readWorkbook(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const sheets = wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    /* Duplicate headers must not collapse into one column. Row objects were
     * keyed by header name, so a second "SKU" column overwrote the first and a
     * file with a stray duplicate SKU lost every SKU value — the preview then
     * read "out of 0 rows" with no explanation. Every final key is forced
     * unique (SKU, SKU (2), …) including the generated `Column N` name for a
     * blank header, which can itself collide with a real header of that name. */
    const rawHeaders = (rows[0] ?? []).map((h) => String(h ?? '').trim());
    const used = new Set();
    const headers = rawHeaders.map((h, index) => {
      const base = h || `Column ${index + 1}`;
      let name = base;
      let n = 1;
      while (used.has(name)) { n += 1; name = `${base} (${n})`; }
      used.add(name);
      return name;
    });
    const body = rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
    /* A title row above the header row is a common export shape and currently
     * dead-ends: the title becomes the only header, so no column is
     * recognized and Preview stays disabled. Flag it (rather than guessing
     * silently) so the map step can tell the user what is wrong. */
    const nonEmpty = (row) => (row ?? []).filter((cell) => String(cell ?? '').trim() !== '').length;
    const looksLikeTitleRow = nonEmpty(rows[0]) <= 1 && nonEmpty(rows[1]) > nonEmpty(rows[0]);
    return { name, headers, rows: body, rowCount: body.length, looksLikeTitleRow };
  });
  return { fileName: path.basename(filePath), sheets };
}

/**
 * Write the sample/import workbook for a company.
 *
 * The columns come from main/util/productWorkbook.js, which the Excel export
 * uses too, so a sample and an export always carry the same columns
 * (AGENTS.md §11: "pre-configured with this org's price groups, custom fields,
 * and the full canonical column set").
 */
function writeProductSampleWorkbook(outputPath, options = {}) {
  const { buildProductSampleWorkbook } = require('./util/productWorkbook');
  fs.writeFileSync(outputPath, buildProductSampleWorkbook({
    priceGroups: Array.isArray(options.priceGroups) ? options.priceGroups : [],
    customFields: Array.isArray(options.customFields) ? options.customFields : [],
  }));
  return outputPath;
}

module.exports = { readWorkbook, writeProductSampleWorkbook };
