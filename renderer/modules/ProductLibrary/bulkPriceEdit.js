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
 */
import { priceEntry } from '../../lib/prices.js';

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
  const currency = entry.currency || 'USD';
  if (mode === 'set') {
    if (value == null && entry.amount == null) return null;
    if (value != null && entry.amount === value) return null;
    return { before: { amount: entry.amount, currency }, after: { amount: value, currency } };
  }
  if (entry.amount == null) return null;
  const factor = mode === 'increase' ? 1 + value / 100 : 1 - value / 100;
  const after = roundPrice(Math.max(0, entry.amount * factor), currency);
  if (after === entry.amount) return null;
  return { before: { amount: entry.amount, currency }, after: { amount: after, currency } };
}

/**
 * bulkUpsert rows (conflictPolicy 'overwrite', keyed by SKU) for the changed
 * products. Only the one price field is supplied, so nothing else is touched;
 * a group's other keys survive because bulkUpsert merges the prices map per key.
 */
export function buildPriceRows(products, opts) {
  const rows = [];
  const skipped = [];
  for (const p of products || []) {
    const change = priceChangeFor(p, opts);
    if (!change) { skipped.push(p); continue; }
    const amount = change.after.amount;
    if (opts.source === 'retail') rows.push({ sku: p.sku, priceRetail: amount == null ? '' : amount });
    else if (opts.source === 'wholesale') rows.push({ sku: p.sku, priceWholesale: amount == null ? '' : amount });
    else rows.push({ sku: p.sku, prices: { [opts.source]: { amount, currency: change.after.currency } } });
  }
  return { rows, skipped };
}
