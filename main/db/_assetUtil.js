/**
 * Small shared helpers for the fixed-asset, branch and ledger DB modules
 * (docs/ASSETS_AND_BRANCHES_PLAN.md). Most come from the fuel helpers; the
 * audit wrapper tags rows about asset values and the books (auditLog's
 * ASSET_ENTITY_TYPES) `sensitivity: 'finance'`, so History hides them from
 * callers without assets.view (§7) and Clear keeps them. Branch rows stay
 * 'normal' — branch names are not sensitive.
 */

const { uuid, str, num, int, badRequest, isCalendarDate, getCallerUserId } = require('./_fuelUtil');

function audit(entityType, entityId, action, { before = null, after = null } = {}) {
  try {
    const auditLog = require('./auditLog');
    let expenseHistory = auditLog.isFinanceEntityType(entityType) || after?.sourceKind?.startsWith('finance_');
    let companyId;
    if (entityType === 'gl_account') {
      const account = require('./index').getDb().prepare('SELECT company_id, system_key FROM gl_accounts WHERE id = ?').get(entityId);
      if (account?.system_key?.startsWith('fin.')) {
        expenseHistory = true;
        companyId = account.company_id;
      }
    }
    const sensitivity = expenseHistory ? 'accounting' : auditLog.isAssetEntityType(entityType) ? 'finance' : 'normal';
    if (expenseHistory && entityType === 'journal_entry') {
      companyId = require('./index').getDb().prepare('SELECT company_id FROM journal_entries WHERE id = ?').get(entityId)?.company_id;
    }
    if (companyId) after = { ...after, companyId };
    auditLog.log({ entityType, entityId, action, before, after, sensitivity });
  } catch (_) { /* audit must never break the write it records */ }
}

/** 'YYYY-MM-DD' today in Phnom Penh (UTC+7, no daylight saving). */
function todayPhnomPenh(now = Date.now()) {
  return new Date(Number(now) + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function dateOrNull(v, label) {
  if (v == null || v === '') return null;
  if (!isCalendarDate(v)) throw badRequest(`${label} must be a real date like 2026-03-12`);
  return String(v);
}

/** A whole number ≥ 0 of minor units, or null. */
function minorOrNull(v, label) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw badRequest(`${label} must be a whole amount, not negative (US cents or riel)`);
  return n;
}

function notFound(kind) {
  const err = new Error(`${kind} not found`);
  err.code = 'NOT_FOUND';
  return err;
}

module.exports = { uuid, str, num, int, badRequest, isCalendarDate, getCallerUserId, audit, todayPhnomPenh, dateOrNull, minorOrNull, notFound };
