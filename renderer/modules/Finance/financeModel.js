/**
 * Finance — pure helpers for the desktop screens (no React, no IPC).
 *
 * Money is the part that has to be exact. Every amount is parsed from an
 * EXACT STRING into whole minor units — US cents for USD, whole riel for
 * KHR — so no float ever decides what a cent is. The ledger keeps whole US
 * cents (main/util/financeMath.js), and the helpers here mirror it:
 *
 *   parseAmount('12.50', 'USD')  → 1250 cents
 *   parseAmount('1250', 'KHR')   → 1250 riel
 *
 * The screen never guesses a rate: `usdMinorFor` uses the rate the server
 * froze, and a missing rate returns null rather than a made-up number.
 */

import { formatPrice } from '../../lib/currencies.js';

export const USD = 'USD';
export const KHR = 'KHR';

/** The receipt cap the server enforces (main/financeReceipts.js MAX_RECEIPT_BYTES). */
export const RECEIPT_MAX_BYTES = 15 * 1024 * 1024;
export const RECEIPT_MAX_LABEL = '15 MB';

export const EXPENSE_STATUSES = ['draft', 'pending', 'posted', 'rejected', 'cancelled', 'reversed'];

const STATUS_LABEL = {
  draft: 'Draft',
  pending: 'Awaiting approval',
  posted: 'Recorded',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  reversed: 'Reversed',
};

const STATUS_TONE = {
  draft: 'slate',
  pending: 'amber',
  posted: 'emerald',
  rejected: 'rose',
  cancelled: 'slate',
  reversed: 'rose',
};

export function statusLabel(status) {
  return STATUS_LABEL[status] || 'Unknown';
}

export function statusTone(status) {
  return STATUS_TONE[status] || 'slate';
}

/** Only a draft can be edited; everything else is frozen by the server. */
export function isEditable(status) {
  return status === 'draft';
}

/* ── money ──────────────────────────────────────────────────────────── */

function decimalsFor(currency) {
  return currency === KHR ? 0 : 2;
}

/**
 * Parse a typed amount into whole minor units.
 * Returns `{ ok: true, minor }` or `{ ok: false, error }` with a message the
 * screen can show under the field.
 */
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
      error: currency === KHR
        ? 'Riel amounts are whole numbers.'
        : 'The ledger keeps cents — two decimals at most.',
    };
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const minor = Number(whole || 0) * 10 ** decimals + Number(padded || 0);
  if (!Number.isSafeInteger(minor)) return { ok: false, error: 'That amount is too large.' };
  return { ok: true, minor };
}

/** Whole minor units back into the text the amount field shows. */
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

/**
 * What the amount is worth in whole US cents, at the rate the server used
 * (main/util/financeMath.js usdCentsFromMinor). No rate → null, never a guess.
 */
export function usdMinorFor(amountMinor, currency, khrPerUsd) {
  if (amountMinor == null) return null;
  if (currency === USD) return Number(amountMinor);
  const rate = Number(khrPerUsd);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((Number(amountMinor) * 100) / rate);
}

/**
 * The smallest riel amount the ledger can record: below it the expense is
 * worth less than one US cent and the server refuses to record it.
 */
export function minKhrMinorForCent(khrPerUsd) {
  const rate = Number(khrPerUsd);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.ceil(rate / 200);
}

/** Strictly above the threshold needs the owner's approval — exactly it does not. */
export function exceedsThreshold(usdMinor, thresholdMinor) {
  if (usdMinor == null || thresholdMinor == null) return false;
  return Number(usdMinor) > Number(thresholdMinor);
}

/** An amount as the house formatter shows it ("$12.50", "៛1,250"). */
export function formatMinor(minor, currency) {
  if (minor == null || minor === '') return '';
  const n = Number(minor);
  if (!Number.isFinite(n)) return '';
  return formatPrice(n / 10 ** decimalsFor(currency), currency);
}

export function formatUsdMinor(minor) {
  return formatMinor(minor, USD);
}

/* ── accounts ───────────────────────────────────────────────────────── */

/**
 * A money account may pay for an expense in a branch when it belongs to that
 * branch, or when it is a company-wide bank account (no branch) — a cash box
 * always belongs to its own branch.
 */
export function accountAllowedForBranch(account, branchId) {
  if (!account) return false;
  if (account.branchId) return account.branchId === branchId;
  return account.kind === 'bank';
}

/** The accounts an expense in this branch can be paid from. */
export function accountsForBranch(accounts, branchId) {
  return (accounts || []).filter((a) => accountAllowedForBranch(a, branchId));
}

/* ── misc ───────────────────────────────────────────────────────────── */

/** The server's optimistic-locking conflict. */
export function isConflict(err) {
  return String(err?.message ?? err ?? '').startsWith('CONFLICT|');
}

/** The server's message, without the internal prefix. */
export function errText(err) {
  const msg = String(err?.message ?? err ?? 'Something failed');
  if (msg.startsWith('CONFLICT|')) {
    return 'Someone else changed this while it was open. Close it and open it again to see their change.';
  }
  return msg;
}

/** A stable client id, so a lost reply never creates a second record. */
export function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `fc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
