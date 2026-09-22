/**
 * Currency catalogue (renderer mirror).
 *
 * Kept byte-for-byte in sync with `main/util/currencies.js` — main is CommonJS
 * and the renderer is ESM, so the list is duplicated rather than imported.
 * `test/currencies.test.js` compares the two and fails on any drift.
 *
 * Formatting rule: prefix the symbol, 0 decimals for currencies that are
 * conventionally whole-number (KHR, VND, IDR, JPY, KRW), 2 otherwise.
 */

export const CURRENCIES = [
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

export const DEFAULT_CURRENCY = 'USD';
const WHOLE_NUMBER = new Set(['KHR', 'VND', 'IDR', 'JPY', 'KRW']);
const CODES = new Set(CURRENCIES.map((c) => c.code));

export function isCurrency(code) {
  return CODES.has(String(code ?? '').toUpperCase());
}

export function normalizeCurrency(code) {
  const c = String(code ?? '').toUpperCase();
  return CODES.has(c) ? c : DEFAULT_CURRENCY;
}

export function symbolFor(code) {
  const row = CURRENCIES.find((c) => c.code === normalizeCurrency(code));
  return row ? row.symbol : '';
}

export function formatPrice(amount, code) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const cur = normalizeCurrency(code);
  const decimals = WHOLE_NUMBER.has(cur) ? 0 : 2;
  const num = n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${symbolFor(cur)}${num}`;
}
