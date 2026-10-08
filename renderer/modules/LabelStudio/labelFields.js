import { formatAmount } from '../../lib/currencies.js';
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

/**
 * The price source a label field names — mirror of `priceSourceFor` in
 * main/studioRenderer.js. `priceRetail` → retail, `priceWholesale` →
 * wholesale, `price.<key>` → that group; anything else → null.
 */
export function labelPriceSource(field) {
  if (field === 'priceRetail') return 'retail';
  if (field === 'priceWholesale') return 'wholesale';
  if (typeof field === 'string' && field.startsWith('price.')) return field.slice(6);
  return null;
}

/**
 * A label price as the printer draws it: the BARE amount, two decimals,
 * en-US grouping ("1,234.50"); the currency is the element's own prefix or
 * suffix (owner's decision, 2026-10-02). Mirror of `labelPriceAmount` in
 * main/studioRenderer.js — test/labelCatalog.test.js runs both over the same
 * products. `entry` is what `priceEntry()` returns.
 */
export function labelPriceAmount(entry) {
  if (!entry || entry.amount == null) return '';
  return formatAmount(entry.amount, entry.currency);
}

/**
 * Line height for a label text box when the template does not set one.
 * Khmer stacks subscript consonants and vowel signs below the baseline (and
 * vowels above the line), so at the Latin default of 1.15 the second line of
 * a two-line Khmer name ran into the first. Text with any Khmer gets 1.45.
 * Mirrored in main/studioRenderer.js (`labelLineHeight`) so the designer and
 * the printed label agree; test/studiosAudit.test.js pins the two together.
 */
export const KHMER_RE = /[\u1780-\u17FF\u19E0-\u19FF]/;
export function labelLineHeight(element, text) {
  const explicit = Number(element?.lineHeight);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return KHMER_RE.test(String(text ?? '')) ? 1.45 : 1.15;
}
