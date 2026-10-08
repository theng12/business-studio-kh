/**
 * "History is never deleted" (docs/PEOPLE_AND_FUEL_PLAN.md §3): a company
 * that has staff or fuel history cannot be removed. SQLite enforces it too
 * (ON DELETE RESTRICT from those tables), but this check runs first so the
 * owner reads a sentence instead of "FOREIGN KEY constraint failed".
 */

const { getDb } = require('./index');

const HISTORY_TABLES = [
  ['employees', 'staff record'],
  ['fuel_fills', 'fuel fill'],
  ['fuel_dips', 'tank dip'],
  ['fuel_deliveries', 'fuel delivery'],
  ['fuel_transfers', 'fuel transfer'],
  ['fuel_meter_resets', 'meter reset'],
];

function companyHistoryCounts(companyId) {
  const db = getDb();
  const counts = {};
  let total = 0;
  for (const [table] of HISTORY_TABLES) {
    let n;
    try { n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`).get(companyId).n; } catch (_) { n = 0; }
    counts[table] = n;
    total += n;
  }
  return { counts, total };
}

function assertCompanyRemovable(companyId) {
  const { counts, total } = companyHistoryCounts(companyId);
  if (!total) return;
  const parts = HISTORY_TABLES
    .filter(([t]) => counts[t] > 0)
    .map(([t, label]) => `${counts[t].toLocaleString('en-US')} ${label}${counts[t] === 1 ? '' : 's'}`);
  const err = new Error(`This company cannot be deleted: it holds staff and fuel history (${parts.join(', ')}). History is kept for good — staff are marked as left and records are voided, never deleted.`);
  err.code = 'HAS_HISTORY';
  throw err;
}

module.exports = { companyHistoryCounts, assertCompanyRemovable, HISTORY_TABLES };
