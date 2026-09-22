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
 * Build the sample/import workbook for a company.
 *
 * v0.1.65: this used to be a hard-coded header list, which made the workbook
 * useless the moment a company had a price group of its own: Settings → General
 * → Price groups would happily create "Export", no column existed to import it,
 * and the user had nothing to type the number into. AGENTS.md section 11 asks
 * for the sample to be pre-configured with "this org's price groups, custom
 * fields, and the full canonical column set" — this is that.
 *
 * Every currency column sits next to its price column, because the app stores a
 * currency per price field (products.price_retail_currency and friends), and a
 * sheet that can only carry the number forces everyone into one currency.
 */
function writeProductSampleWorkbook(outputPath, options = {}) {
  const priceGroups = Array.isArray(options.priceGroups) ? options.priceGroups : [];
  const customFields = Array.isArray(options.customFields) ? options.customFields : [];

  /* One price column per group. Retail and wholesale keep their long-standing
   * headers so files exported from an older sample still map onto them; a
   * custom group is labelled with the name the user gave it. */
  const priceColumns = [
    { header: 'Retail price', field: 'priceRetail', value: 12.5, currency: 'Retail currency', currencyValue: 'USD' },
    { header: 'Wholesale price', field: 'priceWholesale', value: 9.2, currency: 'Wholesale currency', currencyValue: 'USD' },
    ...priceGroups.map((g) => ({
      header: `${g.label} price`,
      field: `price.${g.key}`,
      value: 4.75,
      currency: `${g.label} currency`,
      currencyValue: 'USD',
      group: g,
    })),
  ];

  const headers = [
    'SKU', 'Brand', 'Barcode', 'Secondary code',
    'Name', 'Category', 'Subcategory', 'Color/Finish',
    'Description', 'Unit', 'Variant',
  ].concat(
    // price + its currency, group by group
    priceColumns.flatMap((p) => [p.header, p.currency]),
  ).concat([
    'Tags', 'Status',
    // v0.49.49: logistics & sourcing — the carton + weight data off a
    // supplier's packing list. These prefill Purchase Order lines and
    // feed the landed-cost volume / weight allocation.
    'Supplier SKU', 'HS code', 'Units per carton',
    'Carton width (cm)', 'Carton height (cm)', 'Carton length (cm)',
    'Weight per unit (kg)',
    // v0.1.25: units on hand, so a stock column is importable too.
    'Stock on hand',
    // Custom fields the company already uses, as their stored keys.
    ...customFields,
  ]);

  const sampleRows = [{
    SKU: 'SAMPLE-001 — delete this row',
    Brand: 'Demo brand',
    Barcode: '',
    'Secondary code': '',
    Name: 'Sample tile',
    Category: 'Tiles',
    Subcategory: 'Wall',
    'Color/Finish': 'Matte white',
    Description: 'A short product description.',
    Unit: 'sqm',
    Variant: '60 × 60 cm',
    Tags: 'matte, ceramic, indoor',
    Status: 'active',
    'Supplier SKU': 'FAC-TILE-6060',
    'HS code': '6907.21',
    'Units per carton': 4,
    'Carton width (cm)': 62,
    'Carton height (cm)': 12,
    'Carton length (cm)': 62,
    'Weight per unit (kg)': 8.5,
    'Stock on hand': 24,
  }];
  for (const column of priceColumns) {
    sampleRows[0][column.header] = column.value;
    sampleRows[0][column.currency] = column.currencyValue;
  }
  for (const key of customFields) sampleRows[0][key] = '';

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(sampleRows, { header: headers }),
    'Products',
  );

  const instructions = [
    ['Column', 'Notes'],
    ['SKU', 'Required. Unique per company.'],
    ['Brand', 'Optional. Matches an existing brand by name (case-insensitive). Unknown brand names are ignored.'],
    ['Barcode', 'Optional. EAN, UPC, or other.'],
    ['Secondary code', 'Optional. Supplier code or alt SKU.'],
    ['Name', 'Product name.'],
    ['Category', 'Top-level grouping. Created automatically if it doesn\'t exist.'],
    ['Subcategory', 'Optional second level. Free text.'],
    ['Color/Finish', 'e.g. Matte White.'],
    ['Description', 'Short product description.'],
    ['Unit', 'e.g. sqm, piece, box.'],
    ['Variant', 'e.g. size, material.'],
    ['Tags', 'Comma-separated tags.'],
    ['Status', 'active / inactive / draft. Defaults to active.'],
    ['Stock on hand', 'Optional, numeric. Merge leaves the existing count alone when the cell is blank.'],
    ['Supplier SKU', 'Optional. The supplier / factory item code. Prefills onto Purchase Order lines.'],
    ['HS code', 'Optional. Customs tariff code (e.g. 6907.21).'],
    ['Units per carton', 'Optional, numeric. How many pieces ship in one carton. Used for container fill % + volume-based cost allocation.'],
    ['Carton width (cm)', 'Optional, numeric. Outer carton width. Width × height × length = carton volume (CBM).'],
    ['Carton height (cm)', 'Optional, numeric. Outer carton height.'],
    ['Carton length (cm)', 'Optional, numeric. Outer carton length / depth. (Order of W/H/L does not change the volume.)'],
    ['Weight per unit (kg)', 'Optional, numeric. Gross weight of ONE piece (not the carton). Used only for weight-based cost allocation.'],
  ];

  for (const column of priceColumns) {
    instructions.push([
      column.header,
      column.group
        ? `Numeric. Your “${column.group.label}” price group (Settings → General → Price groups). Blank leaves it alone.`
        : 'Numeric. Optional.',
    ]);
    instructions.push([
      column.currency,
      'Currency code for the price beside it: USD, CNY, KHR, THB, VND, EUR, JPY, KRW, INR, IDR, MYR or SGD. Defaults to USD.',
    ]);
  }
  for (const key of customFields) {
    instructions.push([key, `Custom field “${key.replace(/^custom\./, '')}”. Free text, stored per product.`]);
  }

  instructions.push(
    ['', ''],
    ['How updates work', 'Rows are matched by SKU. New SKUs are inserted; existing SKUs are updated. Blank cells leave the current data alone (choose Overwrite on the preview screen to make blanks clear the field instead).'],
    ['Logistics & cost', 'The Supplier SKU / HS / carton / weight columns prefill Purchase Order line items and drive the landed-cost calculator. Default supplier is set per-product in the app (not importable here).'],
    ['Images', 'Not imported via this sheet. Use Auto-match images… in the Library or attach images per product.'],
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(instructions),
    'Instructions',
  );

  XLSX.writeFile(wb, outputPath);
  return outputPath;
}

module.exports = { readWorkbook, writeProductSampleWorkbook };
