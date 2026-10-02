/**
 * Currency catalogue: the codes the app offers, each with the symbol shown
 * beside a price.
 *
 * Deliberately MIRRORED as plain data in `renderer/lib/currencies.js` (main is
 * CommonJS, the renderer is ESM, and neither can require the other).
 * `test/currencies.test.js` fails if the two lists drift apart.
 *
 * Formatting rule: prefix the symbol, and use 0 decimals for currencies that
 * are conventionally whole-number (KHR, VND, IDR, JPY, KRW) and 2 otherwise.
 */

const CURRENCIES = [
  { code: 'USD', symbol: '$',  label: 'US dollar' },
  { code: 'CNY', symbol: '¥',  label: 'Chinese yuan (RMB)' },
  { code: 'KHR', symbol: '៛',  label: 'Cambodian riel' },
  { code: 'THB', symbol: '฿',  label: 'Thai baht' },
  { code: 'VND', symbol: '₫',  label: 'Vietnamese dong' },
  { code: 'EUR', symbol: '€',  label: 'Euro' },
  { code: 'JPY', symbol: '¥',  label: 'Japanese yen' },
  { code: 'KRW', symbol: '₩',  label: 'South Korean won' },
  { code: 'INR', symbol: '₹',  label: 'Indian rupee' },
  { code: 'IDR', symbol: 'Rp', label: 'Indonesian rupiah' },
  { code: 'MYR', symbol: 'RM', label: 'Malaysian ringgit' },
  { code: 'SGD', symbol: 'S$', label: 'Singapore dollar' },
];

const DEFAULT_CURRENCY = 'USD';
const WHOLE_NUMBER = new Set(['KHR', 'VND', 'IDR', 'JPY', 'KRW']);
const CODES = new Set(CURRENCIES.map((c) => c.code));

function isCurrency(code) {
  return CODES.has(String(code ?? '').toUpperCase());
}

/** Unknown/blank codes fall back to USD so a price always renders. */
function normalizeCurrency(code) {
  const c = String(code ?? '').toUpperCase();
  return CODES.has(c) ? c : DEFAULT_CURRENCY;
}

function symbolFor(code) {
  const row = CURRENCIES.find((c) => c.code === normalizeCurrency(code));
  return row ? row.symbol : '';
}

/** The bare amount in the currency's own style: `1,234.50` for USD,
 *  `41,000` for KHR (whole-number currencies have no decimals). No symbol. */
function formatAmount(amount, code) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const decimals = WHOLE_NUMBER.has(normalizeCurrency(code)) ? 0 : 2;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** `formatPrice(1234.5, 'USD')` → `$1,234.50`; blank/invalid amount → ''. */
function formatPrice(amount, code) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const cur = normalizeCurrency(code);
  const decimals = WHOLE_NUMBER.has(cur) ? 0 : 2;
  const num = n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${symbolFor(cur)}${num}`;
}

module.exports = { CURRENCIES, DEFAULT_CURRENCY, isCurrency, normalizeCurrency, symbolFor, formatAmount, formatPrice };
