/**
 * 0.1.95: the house exchange rate — riel per US dollar, "1 USD = 4,100 KHR".
 *
 * Stored in config.json as `exchangeRateKhrPerUsd` (Settings → General; the
 * main process validates it positive) and mirrored in the store as
 * `houseKhrPerUsd`. Used by the Cost Calculator (KHR prices against the USD
 * landed cost) and by the Library's price-column sort. Pure, for the tests.
 */

export const DEFAULT_KHR_PER_USD = 4100;

/** A usable rate as a number, else null. Same rule as main/config.js. */
export function validRate(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(typeof value === 'string' ? value.replace(/[,\s]/g, '') : value);
  return Number.isFinite(n) && n > 0 && n <= 1e9 ? n : null;
}

/** The house rate from a settings object, falling back to the default. */
export function houseRateFrom(cfg) {
  return validRate(cfg?.exchangeRateKhrPerUsd) ?? DEFAULT_KHR_PER_USD;
}

/**
 * A price entry's amount expressed in USD so prices in different currencies
 * can be compared — for SORTING only, never for display. USD (and rows with no
 * currency, which predate v0.1.55 and are USD) pass through; KHR divides by
 * the house rate. Another currency has no house rate, so its raw amount is
 * used, as before.
 */
export function comparableUsd(entry, khrPerUsd) {
  if (!entry || entry.amount == null || entry.amount === '') return null;
  const amount = Number(entry.amount);
  if (!Number.isFinite(amount)) return null;
  const cur = String(entry.currency || 'USD').toUpperCase();
  if (cur === 'KHR') {
    const rate = validRate(khrPerUsd) ?? DEFAULT_KHR_PER_USD;
    return amount / rate;
  }
  return amount;
}

/**
 * One-time move of the Cost Calculator's old per-Mac KHR rate (localStorage
 * `costcalc.ratesPerUsd`) into the house rate. Adopted only when the house
 * rate is still the untouched default, so a rate already set in Settings is
 * never overwritten by an older scratch figure. Returns the rate to write (or
 * null) and the local map without KHR, which is no longer kept there.
 */
export function migrateLocalKhrRate(localRates, houseRate) {
  const rest = { ...(localRates && typeof localRates === 'object' ? localRates : {}) };
  const local = validRate(rest.KHR);
  delete rest.KHR;
  const write = local != null && (validRate(houseRate) ?? DEFAULT_KHR_PER_USD) === DEFAULT_KHR_PER_USD && local !== DEFAULT_KHR_PER_USD
    ? local
    : null;
  return { write, rest };
}

/** "4,100" — the rate as the Settings field and hints show it. */
export function formatRate(rate) {
  const n = validRate(rate);
  return n == null ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
