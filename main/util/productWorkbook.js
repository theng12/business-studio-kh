/**
 * Product workbook: ONE column definition for both the import sample and the
 * Excel export (owner, 2026-10-11: "it must use the same columns as the import
 * sample … either way it must match").
 *
 * Before this module the sample's header list lived in main/fileHandler.js and
 * the only export was a CSV with a different column order and no logistics,
 * stock or custom-field columns, so an exported file could not be edited and
 * imported back cleanly. Both workbooks are now built from `productColumns()`,
 * so they cannot drift apart; `test/productWorkbook.test.js` also checks that
 * every header maps back through the importer's `autoGuess`.
 *
 * Pure apart from SheetJS: no DB, no fs, no Electron — the same bytes are
 * built on a standalone Mac and on the server for a client Mac.
 */

const XLSX = require('xlsx');
const { priceEntry } = require('./prices');

function blankIfNull(v) {
  return v == null ? '' : v;
}

function numberCell(v) {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

/**
 * The canonical column list for a company.
 *
 * @param {object} [opts]
 * @param {{key: string, label: string}[]} [opts.priceGroups] company price groups
 * @param {string[]} [opts.customFields] custom field keys, e.g. 'custom.origin'
 * @returns {{header: string, width: number, note: string, sample: any,
 *            get: (p: object, ctx: object) => any}[]}
 */
function productColumns({ priceGroups = [], customFields = [] } = {}) {
  const groups = (Array.isArray(priceGroups) ? priceGroups : []).filter((g) => g && g.key && g.label);
  const customKeys = (Array.isArray(customFields) ? customFields : []).filter((k) => typeof k === 'string' && k);

  /* Retail and wholesale keep their long-standing headers so files from an
   * older sample still map onto them; a custom group is labelled with the name
   * the user gave it. Every currency column sits next to its price column,
   * because the app stores a currency per price field. */
  const priceColumns = [
    { header: 'Retail price', source: 'retail', sample: 12.5, currency: 'Retail currency' },
    { header: 'Wholesale price', source: 'wholesale', sample: 9.2, currency: 'Wholesale currency' },
    ...groups.map((g) => ({
      header: `${g.label} price`, source: g.key, sample: 4.75, currency: `${g.label} currency`, group: g,
    })),
  ];
  const currencyNote = 'Currency code for the price beside it: USD, CNY, KHR, THB, VND, EUR, JPY, KRW, INR, IDR, MYR or SGD. Defaults to USD.';

  const col = (header, width, note, sample, get) => ({ header, width, note, sample, get });
  return [
    col('SKU', 16, 'Required. Unique per company.', 'SAMPLE-001 — delete this row', (p) => p.sku || ''),
    col('Brand', 16, 'Optional. Matches an existing brand by name (case-insensitive). Unknown brand names are ignored.', 'Demo brand',
      (p, ctx) => (p.brandId && ctx.brandsById.get(p.brandId)?.name) || ''),
    col('Barcode', 16, 'Optional. EAN, UPC, or other.', '', (p) => p.barcode || ''),
    col('Secondary code', 16, 'Optional. Supplier code or alt SKU.', '', (p) => p.secondaryCode || ''),
    col('Name', 32, 'Product name.', 'Sample tile', (p) => p.name || ''),
    col('Category', 16, 'Top-level grouping. Created automatically if it doesn\'t exist.', 'Tiles',
      (p, ctx) => (p.categoryId && ctx.categoriesById.get(p.categoryId)?.name) || ''),
    col('Subcategory', 16, 'Optional second level. Free text.', 'Wall', (p) => p.subcategory || ''),
    col('Color/Finish', 16, 'e.g. Matte White.', 'Matte white', (p) => p.colorFinish || ''),
    col('Description', 40, 'Short product description.', 'A short product description.', (p) => p.description || ''),
    col('Unit', 10, 'e.g. sqm, piece, box.', 'sqm', (p) => p.unit || ''),
    col('Variant', 16, 'e.g. size, material.', '60 × 60 cm', (p) => p.variant || ''),
    ...priceColumns.flatMap((pc) => [
      col(pc.header, 12,
        pc.group
          ? `Numeric. Your “${pc.group.label}” price group (Settings → General → Price groups). Blank leaves it alone.`
          : 'Numeric. Optional.',
        pc.sample, (p) => numberCell(priceEntry(p, pc.source).amount)),
      col(pc.currency, 10, currencyNote, 'USD', (p) => {
        const entry = priceEntry(p, pc.source);
        return entry.amount == null ? '' : (entry.currency || '');
      }),
    ]),
    col('Tags', 24, 'Comma-separated tags.', 'matte, ceramic, indoor', (p) => (Array.isArray(p.tags) ? p.tags.join(', ') : '')),
    col('Status', 10, 'active / inactive / draft. Defaults to active.', 'active', (p) => p.status || ''),
    // v0.49.49: logistics & sourcing — the carton + weight data off a supplier's
    // packing list. These prefill Purchase Order lines and feed landed cost.
    col('Supplier SKU', 16, 'Optional. The supplier / factory item code. Prefills onto Purchase Order lines.', 'FAC-TILE-6060', (p) => p.supplierSku || ''),
    col('HS code', 12, 'Optional. Customs tariff code (e.g. 6907.21).', '6907.21', (p) => p.hsCode || ''),
    col('Units per carton', 12, 'Optional, numeric. How many pieces ship in one carton. Used for container fill % + volume-based cost allocation.', 4, (p) => numberCell(p.cartonQty)),
    col('Carton width (cm)', 12, 'Optional, numeric. Outer carton width. Width × height × length = carton volume (CBM).', 62, (p) => numberCell(p.cartonWCm)),
    col('Carton height (cm)', 12, 'Optional, numeric. Outer carton height.', 12, (p) => numberCell(p.cartonHCm)),
    col('Carton length (cm)', 12, 'Optional, numeric. Outer carton length / depth. (Order of W/H/L does not change the volume.)', 62, (p) => numberCell(p.cartonDCm)),
    col('Weight per unit (kg)', 12, 'Optional, numeric. Gross weight of ONE piece (not the carton). Used only for weight-based cost allocation.', 8.5, (p) => numberCell(p.weightPerUnitKg)),
    // v0.1.25: units on hand. Blank = never counted (distinct from 0).
    col('Stock on hand', 12, 'Optional, numeric. Merge leaves the existing count alone when the cell is blank.', 24, (p) => numberCell(p.stockQty)),
    // Custom fields the company already uses, as their stored keys.
    ...customKeys.map((key) => {
      const name = key.replace(/^custom\./, '');
      return col(key, 16, `Custom field “${name}”. Free text, stored per product.`, '',
        (p) => blankIfNull(p.customFields?.[name]));
    }),
  ];
}

const INSTRUCTION_FOOTER = [
  ['', ''],
  ['How updates work', 'Rows are matched by SKU. New SKUs are inserted; existing SKUs are updated. Blank cells leave the current data alone (choose Overwrite on the preview screen to make blanks clear the field instead).'],
  ['Logistics & cost', 'The Supplier SKU / HS / carton / weight columns prefill Purchase Order line items and drive the landed-cost calculator. Default supplier is set per-product in the app (not importable here).'],
  ['Images', 'Not imported via this sheet. Use Auto-match images… in the Library or attach images per product.'],
];

/**
 * SheetJS Community Edition does not write frozen panes, so the header row is
 * frozen by editing the sheet XML inside the finished .xlsx (a zip). Only the
 * first sheet is touched; if its XML is not in the expected shape the workbook
 * is returned unfrozen rather than broken.
 */
function freezeHeaderRow(buf) {
  const CFB = XLSX.CFB;
  const zip = CFB.read(buf, { type: 'buffer' });
  const entry = CFB.find(zip, '/xl/worksheets/sheet1.xml');
  if (!entry || !entry.content) return buf;
  const xml = Buffer.from(entry.content).toString('utf8');
  const pane = '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>';
  const next = xml.replace(/<sheetView workbookViewId="0"\s*\/>/, pane);
  if (next === xml) return buf;
  entry.content = Buffer.from(next, 'utf8');
  return CFB.write(zip, { fileType: 'zip', type: 'buffer', compression: true });
}

function buildWorkbook(columns, dataRows) {
  const sheet = XLSX.utils.aoa_to_sheet([columns.map((c) => c.header), ...dataRows]);
  sheet['!cols'] = columns.map((c) => ({ wch: c.width }));
  const instructions = [['Column', 'Notes'], ...columns.map((c) => [c.header, c.note]), ...INSTRUCTION_FOOTER];
  const notes = XLSX.utils.aoa_to_sheet(instructions);
  notes['!cols'] = [{ wch: 24 }, { wch: 100 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Products');
  XLSX.utils.book_append_sheet(wb, notes, 'Instructions');
  return freezeHeaderRow(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

/** The import sample: the canonical columns plus one example row. */
function buildProductSampleWorkbook({ priceGroups = [], customFields = [] } = {}) {
  const columns = productColumns({ priceGroups, customFields });
  return buildWorkbook(columns, [columns.map((c) => c.sample)]);
}

/**
 * The export: the same columns, one row per product, in the order given.
 *
 * @param {object} args
 * @param {object[]} args.products rows from products.list / products.get (camelCase)
 * @param {Map} [args.brandsById] id → { name }
 * @param {Map} [args.categoriesById] id → { name }
 */
function buildProductExportWorkbook({ products = [], brandsById = new Map(), categoriesById = new Map(), priceGroups = [], customFields = [] } = {}) {
  const columns = productColumns({ priceGroups, customFields });
  const ctx = { brandsById, categoriesById };
  return buildWorkbook(columns, products.map((p) => columns.map((c) => c.get(p, ctx))));
}

module.exports = { productColumns, buildProductSampleWorkbook, buildProductExportWorkbook, freezeHeaderRow };
