/**
 * v0.1.71 — the bulk table's save-row builder, extracted so the two rules the
 * customer cares about are unit-testable without a DOM:
 *
 *   1. **SKU is always sent.** It is the row's matching key even when its
 *      column is hidden, so hiding is visual only. `buildSaveRows` reads SKU
 *      straight off the product/edit map and never from the visible column
 *      list — it has no notion of visibility at all.
 *   2. **An edit in a hidden column is still sent.** Edits are keyed by
 *      `row:columnKey`, so hiding a column is a display concern; the save
 *      iterates the edits, not the visible columns.
 *
 * The behaviour is copied verbatim from BulkTableModal (v0.1.66) — this is a
 * move, not a rewrite, so the save path is unchanged.
 */

/** Scalar product fields the bulk table treats as numbers. */
export const NUMERIC_PRODUCT_KEYS = [
  'priceRetail', 'priceWholesale', 'stockQty',
  'cartonWCm', 'cartonHCm', 'cartonDCm', 'weightPerUnitKg',
];

/** The value a product carries for one column key, as the cell shows it. */
export function productValue(product, key) {
  if (!product) return '';
  if (key.startsWith('price:')) {
    return product.prices?.[key.slice('price:'.length)]?.amount ?? '';
  }
  if (key.startsWith('priceCurrency:')) {
    return product.prices?.[key.slice('priceCurrency:'.length)]?.currency ?? 'USD';
  }
  if (key.startsWith('custom:')) {
    return product.customFields?.[key.slice('custom:'.length)] ?? '';
  }
  if (key === 'tags') {
    return Array.isArray(product.tags) ? product.tags.join(', ') : '';
  }
  return product[key] ?? '';
}

export function numericOrProblem(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return { value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { problem: `“${trimmed}” is not a number` };
  return { value: n };
}

/**
 * Turn the edited cells into one bulkUpsert row per changed product.
 * Only the touched cells are included (plus `sku`, which keys the row), so
 * with conflictPolicy 'overwrite' an emptied cell clears its field and an
 * untouched field is never sent at all.
 *
 * @param {Array<object>} rows   the products on screen, in row order
 * @param {Record<string,string>} edits  `"<rowIndex>:<columnKey>" -> value`
 */
export function buildSaveRows(rows, edits) {
  const cellValue = (row, key) => {
    const edited = edits[`${row}:${key}`];
    if (edited !== undefined) return edited;
    return productValue(rows[row], key);
  };

  const byRow = new Map();
  for (const key of Object.keys(edits)) {
    const sep = key.indexOf(':');
    const row = Number(key.slice(0, sep));
    const col = key.slice(sep + 1);
    if (!Number.isInteger(row) || row < 0 || row >= rows.length) continue;
    if (!byRow.has(row)) byRow.set(row, new Set());
    byRow.get(row).add(col);
  }

  const saveRows = [];
  const meta = [];
  const problems = [];

  for (const [row, touched] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const product = rows[row];
    const rowNo = row + 1;
    // ALWAYS read the SKU, whether or not its column is on screen: it is the
    // key bulkUpsert matches on, so a rename/clear must still travel.
    const sku = String(cellValue(row, 'sku') ?? '').trim();
    if (!sku) problems.push({ rowNo, reason: 'SKU is empty' });

    const out = { sku };
    const prices = {};
    const customFields = {};
    let problemsForRow = 0;

    for (const key of touched) {
      const raw = cellValue(row, key);
      if (key === 'sku' || key === 'image') continue;

      if (key.startsWith('price:') || key.startsWith('priceCurrency:')) {
        const group = key.startsWith('price:') ? key.slice('price:'.length) : key.slice('priceCurrency:'.length);
        const entry = prices[group] ?? {};
        if (key.startsWith('price:')) {
          const parsed = numericOrProblem(raw);
          if (parsed.problem) { problems.push({ rowNo, reason: `${parsed.problem} in the ${group} price` }); problemsForRow += 1; }
          else entry.amount = parsed.value;
        } else {
          entry.currency = String(raw ?? '').trim() || undefined;
        }
        prices[group] = entry;
        continue;
      }

      if (key.startsWith('custom:')) {
        customFields[key.slice('custom:'.length)] = String(raw ?? '').trim() === '' ? null : String(raw);
        continue;
      }

      if (NUMERIC_PRODUCT_KEYS.includes(key)) {
        const parsed = numericOrProblem(raw);
        if (parsed.problem) { problems.push({ rowNo, reason: `${parsed.problem} in ${key}` }); problemsForRow += 1; }
        else out[key] = parsed.value;
        continue;
      }

      const value = String(raw ?? '');
      switch (key) {
        case 'tags':
          out.tags = value.split(',').map((t) => t.trim()).filter(Boolean);
          break;
        case 'brandId':
        case 'categoryId':
          out[key] = value || null;
          break;
        case 'status':
          out.status = value || 'active';
          break;
        case 'priceRetailCurrency':
        case 'priceWholesaleCurrency':
          out[key] = value.trim() || 'USD';
          break;
        default:
          out[key] = value === '' ? null : value;
      }
    }

    if (problemsForRow === 0) {
      if (Object.keys(prices).length > 0) out.prices = prices;
      if (Object.keys(customFields).length > 0) out.customFields = customFields;
      saveRows.push(out);
      meta.push({
        id: product.id, rowNo, sku, originalSku: product.sku,
        skuEdited: sku !== product.sku,
        // A rename with no other touched cell leaves bulkUpsert with no diff
        // to report, so the success message has to count it itself.
        onlySku: touched.size === 1 && touched.has('sku'),
      });
    }
  }
  return { saveRows, meta, problems };
}
