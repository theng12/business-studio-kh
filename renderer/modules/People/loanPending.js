import { makeOperation } from './loansModel.js';

const METHODS = ['create', 'approve', 'voidDraft', 'changeRate', 'accrue', 'repay', 'postpone', 'reverseEntry', 'writeOff'];
const key = (companyId) => `Loans.pendingOperation.v1:${encodeURIComponent(companyId)}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const storage = () => {
  if (!window.localStorage) throw new Error('Local storage is unavailable');
  return window.localStorage;
};

// One unresolved command OR opening batch per company. No credentials, result
// history or staff lookup data; localStorage survives renderer/window restarts.
export function readLoanPending(companyId) {
  try {
    const raw = storage().getItem(key(companyId));
    if (raw == null) return null;
    if (raw.length > 2_000_000) throw new Error('Retry request is too large');
    const record = JSON.parse(raw), operation = record?.operation;
    if (!operation || operation.companyId !== companyId || typeof operation.operationId !== 'string' || !operation.operationId) throw new Error('Invalid retry request');
    if (record.kind === 'command') {
      if (!METHODS.includes(operation.method) || !operation.payload || !same(operation.args, makeOperation(operation.method, companyId, operation.operationId, operation.payload).args)) throw new Error('Invalid loan command');
    } else if (record.kind !== 'import' || !Array.isArray(operation.rows) || !operation.rows.length || operation.rows.length > 500) throw new Error('Invalid opening import');
    return record;
  } catch {
    // Do not expose corrupt storage contents (possibly belonging to another company).
    throw new Error('Cannot read the loan retry request. Financial actions are blocked until local storage is available.');
  }
}

export function retainLoanPending(kind, operation) {
  const existing = readLoanPending(operation.companyId);
  const record = { kind, operation };
  if (existing && !same(existing, record)) throw new Error('Retry the pending financial request with its original payload before starting another.');
  const raw = JSON.stringify(record);
  if (raw.length > 2_000_000) throw new Error('Cannot retain the loan retry request: request is too large.');
  try { storage().setItem(key(operation.companyId), raw); }
  catch { throw new Error('Cannot retain the loan retry request. No financial request was sent; check local storage and retry.'); }
}

export function clearLoanPending(kind, operation) {
  const existing = readLoanPending(operation.companyId);
  if (!existing || !same(existing, { kind, operation })) return false;
  try { storage().removeItem(key(operation.companyId)); }
  catch { throw new Error('Cannot clear the loan retry request. Retry the same request once local storage is available.'); }
  return true;
}
