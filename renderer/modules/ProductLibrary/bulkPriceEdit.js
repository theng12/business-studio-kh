/**
 * 0.1.94: the price part of Bulk "Edit fields" — Set, Increase % or
 * Decrease %, for retail, wholesale or any company price group. Pure, so the
 * arithmetic and the rounding are unit-tested (test/libraryAuditPure.test.js).
 *
 * Prices are READ through priceEntry (renderer/lib/prices.js — the three
 * stored shapes), never off the column or the map. A percentage change leaves
 * a product with no price alone: there is nothing to raise.
 *
 * Rounding after a percentage change (owner's rule for this shop):
 *   USD → nearest 0.05, KHR → nearest 100, anything else → nearest 0.01.
 *
 * A price with NO stored currency (a legacy bare number in the group map, or
 * a column whose currency was never set) keeps having none: it is shown and
 * written without a currency and rounded by the app's default currency rule
 * (DEFAULT_CURRENCY). Stamping 'USD' on it would quietly re-label a riel
 * price as dollars.
 *
 * Clearing a group price ("Set" with a blank value) sends
 * `{ amount: null, currency: null }`, which bulkUpsert's Overwrite treats as
 * "remove this group" — `{ amount: null, currency: 'USD' }` was merged as a
 * currency-only change and left the old amount in place.
 *
 * Each row carries `expectedUpdatedAt` (the product as the change was
 * computed from), so a price edited on another Mac since then is skipped by
 * the server rather than overwritten from a stale value. The modal re-reads
 * the products right before writing, so the token is as fresh as it can be.
 */
import { priceEntry } from '../../lib/prices.js';
import { DEFAULT_CURRENCY } from '../../lib/currencies.js';

export const PRICE_MODES = [
  { value: 'set', label: 'Set' },
  { value: 'increase', label: 'Increase %' },
  { value: 'decrease', label: 'Decrease %' },
];

export function roundPrice(amount, currency) {
  if (!Number.isFinite(amount)) return null;
  const code = String(currency || 'USD').toUpperCase();
  if (code === 'KHR') return Math.round(amount / 100) * 100;
  if (code === 'USD') return Number((Math.round(amount * 20) / 20).toFixed(2));
  return Number((Math.round(amount * 100) / 100).toFixed(2));
}

/** Parse the typed value: a number for set (blank = clear), a percent > 0 otherwise. */
export function parsePriceInput(mode, raw) {
  const text = String(raw ?? '').trim();
  if (mode === 'set') {
    if (text === '') return { ok: true, value: null };
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? { ok: true, value: n } : { ok: false, reason: 'Type a price of 0 or more, or leave it blank to clear it.' };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'Type a percentage greater than 0.' };
  if (mode === 'decrease' && n >= 100) return { ok: false, reason: 'A decrease must be less than 100%.' };
  return { ok: true, value: n };
}

/**
 * The change for one product, or null when it is left alone.
 * Returns `{ before: { amount, currency }, after: { amount, currency } }`.
 */
export function priceChangeFor(product, { source, mode, value }) {
  const entry = priceEntry(product, source);
  // null = unknown; kept unknown (see the header), never guessed as USD.
  const currency = entry.currency || null;
  if (mode === 'set') {
    if (value == null && entry.amount == null) return null;
    if (value != null && entry.amount === value) return null;
    return { before: { amount: entry.amount, currency }, after: { amount: value, currency: value == null ? null : currency } };
  }
  if (entry.amount == null) return null;
  const factor = mode === 'increase' ? 1 + value / 100 : 1 - value / 100;
  const after = roundPrice(Math.max(0, entry.amount * factor), currency || DEFAULT_CURRENCY);
  if (after === entry.amount) return null;
  return { before: { amount: entry.amount, currency }, after: { amount: after, currency } };
}

/**
 * bulkUpsert rows (conflictPolicy 'overwrite', keyed by SKU) for the changed
 * products. Only the one price field is supplied, so nothing else is touched;
 * a group's other keys survive because bulkUpsert merges the prices map per key.
 *
 *   - clear a group → `{ amount: null, currency: null }` (Overwrite deletes it);
 *   - a group with no stored currency → `{ amount }` only (currency untouched);
 *   - every row carries `expectedUpdatedAt` when the product has one.
 */
export function buildPriceRows(products, opts) {
  const rows = [];
  const skipped = [];
  for (const p of products || []) {
    const change = priceChangeFor(p, opts);
    if (!change) { skipped.push(p); continue; }
    const amount = change.after.amount;
    const token = p.updatedAt != null ? { expectedUpdatedAt: p.updatedAt } : {};
    if (opts.source === 'retail') rows.push({ sku: p.sku, priceRetail: amount == null ? '' : amount, ...token });
    else if (opts.source === 'wholesale') rows.push({ sku: p.sku, priceWholesale: amount == null ? '' : amount, ...token });
    else if (amount == null) rows.push({ sku: p.sku, prices: { [opts.source]: { amount: null, currency: null } }, ...token });
    else {
      const entry = change.after.currency ? { amount, currency: change.after.currency } : { amount };
      rows.push({ sku: p.sku, prices: { [opts.source]: entry }, ...token });
    }
  }
  return { rows, skipped };
}
