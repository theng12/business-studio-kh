/**
 * Pure helpers for the Cost Calculator — kept out of the component so
 * `test/opsAuditPure.test.js` can run them under plain `npm test`.
 *
 * Landed cost is always USD. A stored price in another currency is compared
 * only through a rate: riel through the house rate (Settings → General,
 * 0.1.95), anything else through a rate the viewer typed. Without one the
 * margin says why it is missing instead of printing a wrong percentage.
 */

/** Positive rate for `currency` from the `{ KHR: '4100' }` map, else null. */
export function ratePerUsd(currency, ratesPerUsd) {
  const n = Number(ratesPerUsd?.[currency]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A price entry's amount in USD, or null when there is no rate for it. */
export function priceToUsd(entry, ratesPerUsd) {
  if (!entry || entry.amount == null) return null;
  const cur = entry.currency || 'USD'; // pre-v0.1.55 rows carry no currency: USD
  if (cur === 'USD') return Number(entry.amount);
  const rate = ratePerUsd(cur, ratesPerUsd);
  return rate ? Number(entry.amount) / rate : null;
}

/** `{ text, tone }` margin of a stored price over a USD landed cost. */
export function marginAgainst(entry, cost, ratesPerUsd = {}) {
  if (!entry || entry.amount == null || entry.amount <= 0) return { text: '—', tone: null };
  const usd = priceToUsd(entry, ratesPerUsd);
  if (usd == null) return { text: `— (price in ${entry.currency}: add a rate)`, tone: null };
  if (!(cost > 0)) return { text: '—', tone: null };
  const pct = ((usd - cost) / usd) * 100;
  return { text: `${pct.toFixed(1)}%`, tone: pct >= 0 ? 'emerald' : 'rose' };
}

const WHOLE = new Set(['KHR', 'VND', 'IDR', 'JPY', 'KRW']);

/**
 * The retail price to save: in the product's own retail currency when the
 * viewer has a rate for it (whole units for riel and the like), else USD.
 */
export function retailInCurrency(usd, currency, ratesPerUsd) {
  const cur = currency || 'USD';
  const rate = cur === 'USD' ? null : ratePerUsd(cur, ratesPerUsd);
  if (!rate) return { amount: Math.round(usd * 100) / 100, currency: 'USD' };
  const raw = usd * rate;
  return { amount: WHOLE.has(cur) ? Math.round(raw) : Math.round(raw * 100) / 100, currency: cur };
}
