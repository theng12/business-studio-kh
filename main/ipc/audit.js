/**
 * v0.22.6: audit:* IPC handlers — read-only feed for the
 * History modal in the side panel.
 *
 * Only two channels for now:
 *   - audit:listForEntity({ entityType, entityId, limit }) — newest
 *     first, includes image events when entityType === 'product'.
 *   - audit:countForEntity({ entityType, entityId }) — total count
 *     for the "showing N of M" footer.
 *
 * Both are exposed (callable by clients) so the History modal works
 * the same in client mode. No write endpoints — the audit log is
 * append-only via the per-table modules; an "edit history" feature
 * would defeat the purpose of an audit trail.
 */

const auditLog = require('../db/auditLog');
const { callerCaps } = require('./fuelAccess');

/**
 * Which History rows the caller may not see (main/db/auditLog.js hideClauses).
 * The server Mac's own window (no caller) and admins see everything.
 *   fuel_*            needs fuel.manage                      (Fuel F1)
 *   employee          needs fuel.manage, hr.view or hr.manage (F1 + HR1)
 *   sensitivity 'hr'  needs hr.view or hr.manage              (HR1, §6)
 *   'hr_private'      needs hr.manage (staff documents)
 *   'payroll'         needs payroll.manage (HR2 — until then admin only)
 * history.view alone (an Editor on another Mac) never reads who filled what,
 * staff details, attendance or leave through the History page.
 */
function hideSpec() {
  const caps = callerCaps();
  if (caps === null || caps.has('*')) return null;
  const any = (...k) => k.some((x) => caps.has(x));
  const hide = {
    fuel: !any('fuel.manage'),
    employee: !any('fuel.manage', 'hr.view', 'hr.manage'),
    hr: !any('hr.view', 'hr.manage'),
    hrPrivate: !any('hr.manage'),
    payroll: !any('payroll.manage'),
  };
  return Object.values(hide).some(Boolean) ? hide : null;
}

/** May the caller see this entity type at all (the per-entity History modal)? */
function entityHidden(entityType, hide) {
  if (!hide) return false;
  if (hide.fuel && typeof entityType === 'string' && entityType.startsWith('fuel_')) return true;
  if (hide.employee && entityType === 'employee') return true;
  return false;
}

function register({ expose }) {
  expose('audit:listForEntity', ({ entityType, entityId, limit } = {}) => {
    if (!entityType || !entityId) return [];
    const hide = hideSpec();
    if (entityHidden(entityType, hide)) return [];
    return auditLog.listForEntity(entityType, entityId, Number(limit) || 200, { hide });
  });

  expose('audit:countForEntity', ({ entityType, entityId } = {}) => {
    if (!entityType || !entityId) return 0;
    const hide = hideSpec();
    if (entityHidden(entityType, hide)) return 0;
    return auditLog.countForEntity(entityType, entityId, { hide });
  });

  /**
   * v0.26.31: global feed — every audit_log row across all entities,
   * across all users (server admin, client #1, client #2…), newest
   * first. Backing the dedicated History sidebar page added in the
   * same release. Filters by entityType + userId; renderer paginates.
   * Same read-only contract as the per-entity channels.
   */
  // v0.1.89: + since / until (epoch ms) and q (text) for the History filters.
  expose('audit:listRecent', ({ limit, offset, entityType, userId, since, until, q } = {}) => {
    return auditLog.listRecent({ limit, offset, entityType, userId, since, until, q, hide: hideSpec() });
  });
  expose('audit:countRecent', ({ entityType, userId, since, until, q } = {}) => {
    return auditLog.countRecent({ entityType, userId, since, until, q, hide: hideSpec() });
  });

  // v0.33.0: history retention. stats() backs the "X events · oldest N
  // days ago" line; clearHistory deletes rows older than `days` (or ALL
  // when days <= 0). Runs server-side, so a client clearing history clears
  // the shared log for everyone — same as any other write. HR1: staff, fuel,
  // HR and payroll rows are never cleared (returned as `kept`).
  expose('audit:historyStats', () => auditLog.stats());
  expose('audit:clearHistory', ({ days } = {}) => auditLog.clearOlderThan(days));
}

module.exports = { register };
