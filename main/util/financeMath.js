/**
 * Finance expenses: the money arithmetic, pure.
 *
 * Two currencies reach the ledger: USD (whole cents) and KHR (whole riel).
 * The ledger's base is US cents on every line, so an original amount is
 * converted once, at submit, using the company's house rate for that date;
 * the result is frozen on the expense. Both journal lines carry the same
 * riel figure, so a riel expense balances exactly instead of gaining or
 * losing a riel to rounding.
 */

const CURRENCIES = ['USD', 'KHR'];

/** A whole, non-negative amount of minor units (cents or riel). */
function isWholeMinor(v) { return Number.isSafeInteger(v) && v >= 0; }

/** A usable riel-per-dollar rate. */
function isRate(v) { return Number.isFinite(Number(v)) && Number(v) > 0; }

/** The original amount in an account's currency, as US cents. */
function usdCentsFromMinor(currency, amountMinor, khrPerUsd) {
  if (currency === 'USD') return amountMinor;
  if (currency === 'KHR') return Math.round((amountMinor * 100) / Number(khrPerUsd));
  throw new Error(`Unknown currency ${currency}`);
}

/** The riel figure both journal lines carry for an original amount. */
function khrMinorFromMinor(currency, amountMinor, usdMinor, khrPerUsd) {
  if (currency === 'KHR') return amountMinor;
  if (currency === 'USD') return Math.round((usdMinor * Number(khrPerUsd)) / 100);
  throw new Error(`Unknown currency ${currency}`);
}

/** Strictly above the threshold needs the owner's approval (exactly at it does not). */
function exceedsThreshold(usdMinor, thresholdMinor) { return usdMinor > thresholdMinor; }

module.exports = { CURRENCIES, isWholeMinor, isRate, usdCentsFromMinor, khrMinorFromMinor, exceedsThreshold };
