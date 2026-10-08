/**
 * Exchange-rate display + entry for purchase orders.
 *
 * Every PO stores ONE number: `exchangeRateToUsd` — how many US dollars one
 * unit of the PO currency is worth. That reads naturally for CNY (0.14) but
 * not for riel or dong: 1 KHR = 0.000244 USD printed as "@ 0.0000" with
 * `toFixed(4)`, and nobody quotes riel that way. For those currencies the
 * screens show and accept the rate the other way round — "1 USD = 4,100 KHR"
 * — and convert to the same stored `exchangeRateToUsd` (1 / 4100).
 */
/** Currencies quoted as "1 USD = N <cur>" (one unit is worth under a cent). */
export const PER_USD_CURRENCIES = new Set(['KHR', 'VND', 'IDR', 'KRW', 'JPY']);

const EXAMPLE_RATE = {
  CNY: '0.14', THB: '0.028', EUR: '1.08', MYR: '0.21', SGD: '0.74', INR: '0.012',
  KHR: '4100', VND: '25000', IDR: '16000', KRW: '1350', JPY: '150',
};

const code = (c) => String(c || '').toUpperCase();

/** True when this currency's rate is typed and shown as "1 USD = N <cur>". */
export function quotesPerUsd(currency) {
  return PER_USD_CURRENCIES.has(code(currency));
}

/** The field label for a rate of this currency. */
export function fxLabel(currency) {
  const c = code(currency) || '?';
  return quotesPerUsd(c) ? `Exchange rate (1 USD = ? ${c})` : `Exchange rate (1 ${c} = ? USD)`;
}

/** An example for the placeholder, in the direction the field asks for. */
export function fxPlaceholder(currency) {
  const c = code(currency);
  if (c === 'USD') return '1';
  return EXAMPLE_RATE[c] ? `e.g. ${EXAMPLE_RATE[c]}` : '';
}

function trim(n, maxDecimals) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
}

/**
 * A stored rate as people read it. Under one cent per unit (or a per-USD
 * currency) it is inverted: "1 USD = 4,100 KHR". Otherwise "1 CNY = 0.14 USD".
 */
export function formatFx(currency, rateToUsd) {
  const c = code(currency) || '?';
  if (c === 'USD') return 'USD';
  const r = Number(rateToUsd);
  if (!(r > 0)) return `1 ${c} = ? USD`;
  if (r < 0.01 || quotesPerUsd(c)) return `1 USD = ${trim(1 / r, 2)} ${c}`;
  return `1 ${c} = ${trim(r, 6)} USD`;
}

/** "4100" for a stored 1/4100 — the per-USD figure for the input box. */
export function perUsdText(rateToUsd) {
  const r = Number(rateToUsd);
  if (!(r > 0)) return '';
  return String(Number((1 / r).toFixed(4)));
}

/** Parse what was typed into a stored rate-to-USD; '' when it is not a positive number. */
export function parseRateInput(currency, text) {
  const raw = String(text ?? '').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || n <= 0) return '';
  return quotesPerUsd(currency) ? 1 / n : n;
}
