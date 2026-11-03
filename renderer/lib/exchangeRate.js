/**
 * 0.1.95: the house exchange rate — riel per US dollar, "1 USD = 4,100 KHR".
 *
 * The ACTIVE rate is the company's DB rate (fx:getShared / fx:setShared,
 * mirrored in the store as `houseKhrPerUsd`). This module keeps the pure
 * helpers around it: `validRate` guards input, `comparableUsd` sorts prices,
 * and `houseRateFrom` reads a legacy config object — a seed/migration source
 * now, never a live screen value. Used by the Cost Calculator (KHR prices
 * against the USD landed cost) and by the Library's price-column sort.
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
 *
 * With no house rate (still loading, or the load failed) a KHR price cannot be
 * compared at all: it returns null and sorts last. Falling back to 4,100 here
 * would order prices by a rate the app does not have.
 */
export function comparableUsd(entry, khrPerUsd) {
  if (!entry || entry.amount == null || entry.amount === '') return null;
  const amount = Number(entry.amount);
  if (!Number.isFinite(amount)) return null;
  const cur = String(entry.currency || 'USD').toUpperCase();
  if (cur === 'KHR') {
    const rate = validRate(khrPerUsd);
    return rate == null ? null : amount / rate;
  }
  return amount;
}

/**
 * One-time move of the Cost Calculator's old per-Mac KHR rate (localStorage
 * `costcalc.ratesPerUsd`) out of use. Since Finance §5 the riel rate is the
 * COMPANY's rate (Settings → General), so the scratch figure is dropped, not
 * written anywhere: a client Mac must never overwrite the company's rate.
 * Returns the local map without KHR and the dropped value, so the caller can
 * say what changed.
 */
export function migrateLocalKhrRate(localRates, houseRate) {
  const rest = { ...(localRates && typeof localRates === 'object' ? localRates : {}) };
  const local = validRate(rest.KHR);
  delete rest.KHR;
  const current = validRate(houseRate);
  return { dropped: local != null && local !== current ? local : null, rest };
}

/** "4,100" — the rate as the Settings field and hints show it. */
export function formatRate(rate) {
  const n = validRate(rate);
  return n == null ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
