/**
 * The label designer's "Product field" list.
 *
 * Split out of LabelTemplates.jsx (v0.1.79) so the rule is testable without a
 * DOM — and because it was wrong for two releases: the server renderer has
 * always resolved a `price.<group>` field, so a company's own price group
 * could be printed on a label from the API and could not be chosen in the UI.
 * The overlay had the same gap with its tokens.
 */

/** Fields every product has. Order is the order the dropdown shows. */
export const BASE_FIELDS = [
  ['name', 'Product name'], ['sku', 'SKU'], ['barcode', 'Barcode'], ['secondaryCode', 'Secondary code'],
  ['description', 'Description'], ['colorFinish', 'Color / Finish'], ['variant', 'Variant'],
  ['unit', 'Unit'], ['priceRetail', 'Retail price'], ['priceWholesale', 'Wholesale price'],
  ['expiryDate', 'Expiry date'], ['countryOfOrigin', 'Country of origin'],
];

/**
 * `[[value, label], …]` for the dropdown: the base fields, then one entry per
 * company price group as `price.<key>` — the exact key `productValue` in
 * main/studioRenderer.js resolves.
 */
export function fieldOptions(priceGroups = []) {
  const seen = new Set(BASE_FIELDS.map(([value]) => value));
  const groups = [];
  for (const group of Array.isArray(priceGroups) ? priceGroups : []) {
    const key = String(group?.key ?? '').trim();
    const label = String(group?.label ?? '').trim();
    const value = `price.${key}`;
    if (!key || !label || seen.has(value)) continue;
    seen.add(value);
    groups.push([value, `${label} price`]);
  }
  return [...BASE_FIELDS, ...groups];
}
