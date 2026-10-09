import { classifyError, t } from './kioskLogic.js';

// Identity belongs to the render, not just the effect that fetched the records.
export function kioskContext(sessionToken, employee) {
  return sessionToken && employee?.id && employee?.companyId
    ? JSON.stringify([sessionToken, employee.id, employee.companyId]) : null;
}

export function currentKioskData(data, context) {
  return context && data?.context === context ? data : null;
}

export function kioskMoney(minor, currency) {
  if (!Number.isSafeInteger(minor) || minor < 0 || !['USD', 'KHR'].includes(currency)) return '—';
  // Format integer parts directly: even very large safe cent amounts retain cents.
  const whole = currency === 'USD' ? Math.floor(minor / 100) : minor;
  const amount = whole.toLocaleString('en-US');
  return `${currency} ${amount}${currency === 'USD' ? `.${String(minor % 100).padStart(2, '0')}` : ''}`;
}

export function kioskLoanTotal(loan) {
  const { principalMinor, interestMinor } = loan;
  const total = principalMinor + interestMinor;
  return [principalMinor, interestMinor, total].every(n => Number.isSafeInteger(n) && n >= 0) ? total : null;
}

export function kioskPage(items, page = 1, size = 50) {
  const perPage = [25, 50, 100, 200].includes(size) ? size : 50;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.max(1, Math.min(pages, Number.isSafeInteger(page) ? page : 1));
  const start = (current - 1) * perPage;
  return { items: items.slice(start, start + perPage), page: current, pages,
    from: total ? start + 1 : 0, to: Math.min(total, start + perPage), total };
}

export function kioskPayrollError(err, lang, saving = false) {
  const kind = classifyError(err).kind;
  if (kind === 'sessionEnded') return t(lang, 'err_session');
  if (kind === 'offline') return t(lang, 'payroll_offline');
  const msg = String(err?.message ?? err ?? '');
  if (/ENOSPC|disk.*full/i.test(msg)) return t(lang, 'payroll_disk_full');
  if (/EACCES|EPERM/i.test(msg)) return t(lang, 'payroll_save_permission');
  if (/permission|unauthorized|forbidden|access denied/i.test(msg)) return t(lang, 'payroll_permission');
  if (/not found|superseded|no longer|not approved/i.test(msg)) return t(lang, 'payroll_unavailable');
  if (/company.*changed|company.*match|another company/i.test(msg)) return t(lang, 'err_session');
  // Never echo IPC wrappers, SQL, names, salary amounts or local paths.
  return t(lang, saving ? 'payroll_save_failed' : 'payroll_load_failed');
}
