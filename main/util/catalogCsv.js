/**
 * v0.36.0: catalog feed / CSV builder.
 *
 * Turns the product list into a downloadable CSV in one of three column
 * layouts: a comprehensive "generic" sheet, a Shopify product-import sheet,
 * and a Google Shopping feed. Pure function (no DB, no fs) so it's trivially
 * testable and works the same in standalone / server / client mode.
 *
 * Image columns carry the MAIN image's FILENAME (not a URL) — the images
 * live locally, not on a public host, so a marketplace import either matches
 * by filename or the user fills in URLs after hosting. This is the safe,
 * connector-free version of e-commerce integration.
 */

const { priceEntry } = require('./prices');

/** RFC-4180 cell: quote if it contains a comma, quote, or newline. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  // CRLF line endings — the most broadly compatible for Excel/Sheets.
  return lines.join('\r\n') + '\r\n';
}

/** Shopify "handle": lowercase, alnum-hyphenated. */
function handle(sku) {
  return String(sku || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function mainImageName(p) {
  return p.mainImagePath ? String(p.mainImagePath).split('/').pop() : '';
}

/**
 * @param {object} args
 * @param {object[]} args.products  rows from products.list (camelCase keys)
 * @param {Map} args.brandsById     id → { name }
 * @param {Map} args.categoriesById id → { name }
 * @param {{key: string, label: string}[]} [args.priceGroups] the company's own
 *        price groups; the generic sheet carries a column per group (v0.1.79)
 * @param {'generic'|'shopify'|'google'} [args.format='generic']
 * @returns {string} CSV text
 */
function buildCatalogCsv({ products = [], brandsById = new Map(), categoriesById = new Map(), priceGroups = [], format = 'generic' } = {}) {
  const brand = (p) => (p.brandId && brandsById.get(p.brandId)?.name) || '';
  const cat = (p) => (p.categoryId && categoriesById.get(p.categoryId)?.name) || '';
  const tags = (p) => (Array.isArray(p.tags) ? p.tags.join(', ') : '');

  if (format === 'shopify') {
    const headers = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
      'Variant SKU', 'Variant Price', 'Variant Barcode', 'Image Src', 'Status'];
    return toCsv(headers, products.map((p) => [
      handle(p.sku), p.name || '', p.description || '', brand(p), cat(p), tags(p), 'TRUE',
      p.sku || '', p.priceRetail != null ? p.priceRetail : '', p.barcode || '',
      mainImageName(p), p.status === 'inactive' ? 'draft' : 'active',
    ]));
  }

  if (format === 'google') {
    // Google Shopping product feed (CSV). image_link/link want URLs the
    // user supplies after hosting; we seed image_link with the filename.
    const headers = ['id', 'title', 'description', 'brand', 'gtin', 'condition',
      'availability', 'price', 'image_link', 'product_type'];
    return toCsv(headers, products.map((p) => [
      p.sku || '', p.name || '', p.description || '', brand(p), p.barcode || '',
      // v0.1.79: the feed said USD for every product, including riel and baht
      // ones. Google wants the price in the currency it is actually sold in.
      'new', 'in stock', googlePrice(p),
      mainImageName(p), cat(p),
    ]));
  }

  /* generic — a comprehensive, human-readable catalog sheet.
   *
   * v0.1.79: it carries the company's own price groups too. The Excel sample
   * and export have always had a column per group (main/fileHandler.js); this
   * sheet silently dropped them, so "download the catalog" and "export to
   * Excel" disagreed about which prices exist. Each group column holds the
   * bare amount, with its currency in the column beside it — the same shape
   * the Excel path uses. */
  const groups = Array.isArray(priceGroups) ? priceGroups.filter((g) => g?.key && g?.label) : [];
  const headers = ['SKU', 'Name', 'Brand', 'Category', 'Subcategory', 'Color/Finish', 'Variant',
    'Unit', 'Barcode', 'Secondary code', 'Retail price', 'Retail currency',
    'Wholesale price', 'Wholesale currency',
    ...groups.flatMap((g) => [`${g.label} price`, `${g.label} currency`]),
    'Status', 'Tags', 'Description', 'Image count', 'Main image'];
  return toCsv(headers, products.map((p) => [
    p.sku || '', p.name || '', brand(p), cat(p), p.subcategory || '', p.colorFinish || '',
    p.variant || '', p.unit || '', p.barcode || '', p.secondaryCode || '',
    amountCell(priceEntry(p, 'retail')), priceEntry(p, 'retail').currency || '',
    amountCell(priceEntry(p, 'wholesale')), priceEntry(p, 'wholesale').currency || '',
    ...groups.flatMap((g) => {
      const entry = priceEntry(p, g.key);
      return [amountCell(entry), entry.currency || ''];
    }),
    p.status || '', (Array.isArray(p.tags) ? p.tags.join('; ') : ''), p.description || '',
    p.imageCount ?? 0, mainImageName(p),
  ]));
}

/** '' for a price the product does not have — never "null" or "NaN". */
function amountCell(entry) {
  return entry && entry.amount != null ? entry.amount : '';
}

/** Google's `price` column: amount plus the currency it is sold in. */
function googlePrice(p) {
  const entry = priceEntry(p, 'retail');
  if (entry.amount == null) return '';
  return `${entry.amount} ${entry.currency || 'USD'}`;
}

module.exports = { buildCatalogCsv, csvCell };
