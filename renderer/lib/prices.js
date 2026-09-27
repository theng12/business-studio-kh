/**
 * Renderer mirror of `main/util/prices.js`.
 *
 * Main is CommonJS and the renderer is ESM, so neither can require the other —
 * the same split `renderer/lib/currencies.js` already lives with. The rule
 * itself must not fork, so `test/priceMirror.test.js` runs both copies over the
 * same fixtures and fails if they disagree.
 *
 * A product price lives in one of three places:
 *   - `priceRetail` / `priceWholesale` columns, each with its own currency, or
 *   - `prices[groupKey]` as `{ amount, currency }` for a company price group, or
 *   - `prices[groupKey]` as a bare number (rows written before v0.1.55).
 *
 * Reading the map as a scalar is what printed "$NaN" on a catalog once; the
 * middle shape is why every reader has to go through here.
 */
import { formatPrice } from './currencies.js';

function num(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `{ amount, currency }` for a price source: 'retail' | 'wholesale' | a group key. */
export function priceEntry(product, source) {
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

/** Format an entry, falling back to the caller's symbol when the row has no currency. */
export function formatPriceEntry(entry, fallbackSymbol = '$') {
  if (!entry || entry.amount == null) return '';
  if (entry.currency) return formatPrice(entry.amount, entry.currency);
  const n = entry.amount;
  return `${fallbackSymbol ?? ''}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export { num };
