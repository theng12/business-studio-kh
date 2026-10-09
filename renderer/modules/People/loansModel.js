const CURRENCY_SCALE = Object.freeze({ USD: 2, KHR: 0 });

export function previousMonth(calendarDate) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(String(calendarDate));
  if (!match) throw new Error('Choose a valid calendar month');
  const year = Number(match[1]), month = Number(match[2]);
  return `${String(month === 1 ? year - 1 : year).padStart(4, '0')}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}`;
}

export function loanDialogIsCurrent(dialog, companyId) {
  return Boolean(dialog && companyId && dialog.companyId === companyId
    && (!dialog.loan || dialog.loan.companyId === companyId));
}

export function parseMinorInput(value, currency) {
  const scale = CURRENCY_SCALE[currency];
  if (scale == null) throw new Error('Choose USD or KHR');
  const text = String(value ?? '').trim();
  const pattern = scale ? new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${scale}})?$`) : /^(?:0|[1-9]\d*)$/;
  if (!pattern.test(text)) throw new Error(`Enter a valid ${currency} amount`);
  const [whole, fraction = ''] = text.split('.');
  const minor = Number(whole) * (10 ** scale) + Number((fraction + '0'.repeat(scale)).slice(0, scale) || 0);
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Amount is too large');
  return minor;
}

export function formatMinor(amountMinor, currency) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || CURRENCY_SCALE[currency] == null) throw new Error('Invalid money amount');
  const scale = CURRENCY_SCALE[currency];
  const base = 10 ** scale;
  const whole = Math.floor(amountMinor / base).toLocaleString('en-US');
  const fraction = scale ? `.${String(amountMinor % base).padStart(scale, '0')}` : '';
  const amount = `${whole}${fraction}`;
  return currency === 'USD' ? `$${amount}` : `៛${amount}`;
}

export function filterLoans(loans, { status = 'all', search = '' } = {}, staff = new Map()) {
  const query = String(search).trim().toLocaleLowerCase();
  return (loans || []).filter((loan) => {
    if (status !== 'all' && loan.status !== status) return false;
    if (!query) return true;
    const person = staff.get(loan.employeeId) || {};
    return [loan.loanNo, loan.status, loan.purpose, person.nameEn, person.nameKm, person.staffCode]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query));
  });
}

export function totalsByCurrency(loans) {
  const totals = { USD: { principalMinor: 0, interestMinor: 0, totalMinor: 0 }, KHR: { principalMinor: 0, interestMinor: 0, totalMinor: 0 } };
  for (const loan of loans || []) {
    const total = totals[loan.currency];
    if (!total) continue;
    total.principalMinor += loan.principalMinor || 0;
    total.interestMinor += loan.interestMinor || 0;
    total.totalMinor += (loan.principalMinor || 0) + (loan.interestMinor || 0);
  }
  return totals;
}

export function endOfMonth(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!match) throw new Error('Choose a valid month');
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

export function makeOperation(method, companyId, operationId, payload) {
  return { method, companyId, operationId: operationId || null, payload, args: { ...payload, ...(operationId ? { operationId } : {}), companyId } };
}

export function pendingAfterFailure(command, error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error || '');
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '');
  if (message.startsWith('Bad request: ')
    || message === 'You do not have permission to access payroll or loans'
    || message === 'Only an admin may perform this financial action'
    || message === 'Company policy requires admin approval') return null;
  return command;
}

export function requestIsCurrent({ requestId, currentRequestId, companyId, activeCompanyId }) {
  return requestId === currentRequestId && companyId === activeCompanyId;
}
