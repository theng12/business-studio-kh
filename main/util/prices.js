/**
 * Price reading/formatting shared by the catalog + social renderers.
 *
 * A product price lives in one of two places:
 *   - `priceRetail` / `priceWholesale` columns, each with its own
 *     `priceRetailCurrency` / `priceWholesaleCurrency` code, or
 *   - `prices[groupKey]`, a named group written by the product form as
 *     `{ amount, currency }`.
 *
 * Legacy rows may hold a bare number for a group (the map predates v0.1.55),
 * so every reader must tolerate both shapes. Before this helper the renderers
 * read the map as a scalar, which turned a `{ amount, currency }` value into
 * `NaN` — i.e. "$NaN" printed on a catalog.
 */

const { formatPrice } = require('./currencies');

function num(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * `{ amount, currency }` for a price source on a product.
 * `source`: 'retail' | 'wholesale' | a company price-group key.
 * `currency` is null when the row predates per-field currencies.
 */
function priceEntry(product, source) {
  const src = String(source || 'retail');
  if (src === 'retail') {
    return { amount: num(product?.priceRetail), currency: product?.priceRetailCurrency || null };
  }
  if (src === 'wholesale') {
    return { amount: num(product?.priceWholesale), currency: product?.priceWholesaleCurrency || null };
  }
  const raw = product?.prices?.[src];
  if (raw && typeof raw === 'object') return { amount: num(raw.amount), currency: raw.currency || null };
  return { amount: num(raw), currency: null };
}

/**
 * Format an entry, falling back to the caller's symbol (e.g. a catalog's
 * `currencySymbol` setting) when the product has no currency code — which can
 * only happen for rows written before v0.1.55.
 */
function formatPriceEntry(entry, fallbackSymbol = '$') {
  if (!entry || entry.amount == null) return '';
  if (entry.currency) return formatPrice(entry.amount, entry.currency);
  const n = entry.amount;
  return `${fallbackSymbol ?? ''}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

module.exports = { num, priceEntry, formatPriceEntry };
