/**
 * Pick & Pack — order import mapping (docs/PICK_AND_PACK_PLAN.md §3.1, §7).
 *
 * The same 3-step wizard shape as the product import: pick file → map columns
 * → review. This file is the pure part (targets, header guessing, row building)
 * so a saved mapping can be proven to reproduce the same rows.
 */

export const ORDER_FIELDS = [
  { key: '__skip__',         label: '— Skip —' },
  { key: 'externalRef',      label: 'Order reference *' },
  { key: 'customerName',     label: 'Customer name' },
  { key: 'customerPhone',    label: 'Phone' },
  { key: 'customerAddress',  label: 'Address' },
  { key: 'value',            label: 'Order value (optional)' },
  { key: 'currency',         label: 'Currency' },
  { key: 'sku',              label: 'Item SKU *' },
  { key: 'lineName',         label: 'Item name (optional)' },
  { key: 'quantity',         label: 'Quantity' },
];

export const ORDER_SOURCES = [
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'chat',        label: 'Chat' },
  { value: 'paper',       label: 'Paper' },
  { value: 'sheet',       label: 'Spreadsheet' },
  { value: 'manual',      label: 'Manual' },
];

const FIELD_KEYS = new Set(ORDER_FIELDS.map((f) => f.key));

export function orderAutoGuess(header) {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return '__skip__';
  if (/^(order\s*(no|number|id|ref|reference)|invoice\s*(no|number)|order\s*#)/.test(h)) return 'externalRef';
  if (h === 'order' || h === 'ref' || h === 'reference' || h === 'order ref' || h === 'invoice') return 'externalRef';
  if (h.includes('phone') || h.includes('mobile') || h === 'tel' || h === 'telephone') return 'customerPhone';
  if (h.includes('address') || h === 'ship to' || h === 'delivery address') return 'customerAddress';
  if (h.includes('currency') || h === 'ccy') return 'currency';
  if (h.includes('customer') || h === 'recipient' || h === 'buyer') return 'customerName';
  if (h === 'name' || h === 'customer name' || h === 'buyer name') return 'customerName';
  if (h === 'value' || h === 'amount' || h === 'total' || h === 'order total' || h === 'order value' || h === 'price') return 'value';
  if (h === 'sku' || h === 'code' || h === 'item code' || h === 'product code' || h === 'item sku') return 'sku';
  if (h === 'qty' || h === 'quantity' || h === 'units') return 'quantity';
  if (h === 'item' || h === 'product' || h === 'item name' || h === 'product name' || h === 'description') return 'lineName';
  return '__skip__';
}

/** A saved mapping only counts for the headers it knows. */
export function applySavedMapping(headers, saved) {
  const out = {};
  for (const header of headers) {
    const target = saved?.[header];
    out[header] = FIELD_KEYS.has(target) ? target : orderAutoGuess(header);
  }
  return out;
}

export function mappingReady(headers, mapping) {
  const targets = headers.map((h) => mapping?.[h]);
  return targets.includes('externalRef') && targets.includes('sku');
}

/** Flat rows the server groups by order reference. Blank cells stay absent. */
export function buildOrderRows(sheet, mapping) {
  if (!sheet) return [];
  const rows = [];
  for (const row of sheet.rows) {
    const out = {};
    for (const header of sheet.headers) {
      const field = mapping?.[header];
      if (!field || field === '__skip__') continue;
      const raw = row[header];
      const blank = raw === '' || raw == null;
      if (blank) continue;
      if (field === 'quantity' || field === 'value') {
        const n = Number(raw);
        if (Number.isFinite(n)) out[field] = n;
      } else {
        out[field] = String(raw).trim();
      }
    }
    if (out.externalRef || out.sku) rows.push(out);
  }
  return rows;
}
