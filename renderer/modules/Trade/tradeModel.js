/**
 * Trade Finance — pure helpers for the four screens (docs/TRADE_FINANCE_PLAN.md).
 *
 * Money is parsed from an exact string into whole minor units, the same rule
 * the Finance screens use: US cents for USD, whole riel for KHR. The server
 * stores and returns only integers; nothing here feeds a float back to it.
 */

import { formatPrice } from '../../lib/currencies.js';

export const USD = 'USD';
export const KHR = 'KHR';

export const KINDS = [
  { value: 'RC', label: 'RC — revolving credit' },
  { value: 'TR', label: 'TR — trust receipt' },
  { value: 'OD', label: 'OD — overdraft' },
  { value: 'Other', label: 'Other' },
];

export const DAY_COUNTS = [360, 365];
export const COMMITMENT_FREQS = ['monthly', 'quarterly', 'yearly'];
const COMMITMENT_PERIOD_UNIT = { monthly: 'month', quarterly: 'quarter', yearly: 'year' };
export const STATUSES = ['active', 'closed', 'cancelled'];

function decimalsFor(currency) {
  return currency === KHR ? 0 : 2;
}

/** A typed amount → `{ ok, minor }` or `{ ok: false, error }`. */
export function parseAmount(text, currency) {
  const raw = String(text ?? '').trim().replace(/[,\s]/g, '');
  if (!raw) return { ok: false, error: 'Enter the amount.' };
  if (!/^\d*(\.\d*)?$/.test(raw)) return { ok: false, error: 'Use numbers only, like 12.50' };
  const [whole = '', frac = ''] = raw.split('.');
  if (!whole && !frac) return { ok: false, error: 'Enter the amount.' };
  const decimals = decimalsFor(currency);
  if (frac.length > decimals) {
    return {
      ok: false,
      error: currency === KHR ? 'Riel amounts are whole numbers.' : 'Two decimals at most.',
    };
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const minor = Number(whole || 0) * 10 ** decimals + Number(padded || 0);
  if (!Number.isSafeInteger(minor)) return { ok: false, error: 'That amount is too large.' };
  return { ok: true, minor };
}

/** Whole minor units back into the text an amount field shows. */
export function minorToInput(minor, currency) {
  if (minor == null) return '';
  const n = Number(minor);
  if (!Number.isSafeInteger(n)) return '';
  const decimals = decimalsFor(currency);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (decimals === 0) return `${sign}${abs}`;
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "៛1,250" / "$12.50" — the house currency formatting. */
export function formatMinor(minor, currency) {
  if (minor == null || minor === '') return '—';
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  return formatPrice(n / 10 ** decimalsFor(currency), currency);
}

export function formatUsdMinor(minor) {
  return formatMinor(minor, USD);
}

/** 0.625 → "63%" (the utilisation meter's label). */
export function formatPercent(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

/** "$112.50 / quarter" / "$71.88 / month" / "Waived" — commitment fee with its period. */
export function formatCommitmentFee(minor, currency, frequency) {
  if (!minor) return 'Waived';
  const amount = formatMinor(minor, currency);
  const unit = COMMITMENT_PERIOD_UNIT[frequency];
  return unit ? `${amount} / ${unit}` : amount;
}

/** 7.5 → "7.5%" */
export function formatRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '—';
  return `${Number(n.toFixed(4))}%`;
}

/** "in 3 days" / "today" / "5 days overdue" / "no maturity". */
export function daysLabel(days) {
  if (days == null) return 'No maturity';
  if (days === 0) return 'Due today';
  if (days > 0) return `In ${days} day${days === 1 ? '' : 's'}`;
  return `${-days} day${days === -1 ? '' : 's'} overdue`;
}

export function statusTone(status) {
  return status === 'active' ? 'emerald' : status === 'cancelled' ? 'rose' : 'slate';
}

export function statusLabel(status) {
  return status === 'active' ? 'Active' : status === 'closed' ? 'Closed' : status === 'cancelled' ? 'Cancelled' : status;
}

export function errText(err) {
  return String(err?.message ?? err ?? 'Something failed');
}

export function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `tf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
