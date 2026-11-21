/**
 * Trade Finance over IPC/RPC (docs/TRADE_FINANCE_PLAN.md §3, Phase A).
 *
 * Every data channel is `expose()`d, so a client Mac reaches it over
 * `api/rpc` exactly like the local window; the capability gate decides who
 * may (main/util/capabilities.js):
 *   trade.view    read the register, drawdowns, interest record and reports
 *   trade.manage  everything that writes
 * Both are opt-in: the module stays invisible until an owner grants one.
 *
 * The company is always the caller's ACTIVE company, resolved here — a
 * companyId sent by a renderer is never trusted. Writes broadcast
 * `trade:changed` so other screens and Macs refetch.
 */

const trade = require('../db/tradeFinance');
const { callerCaps, activeCompanyId, getCallerUserId } = require('./fuelAccess');
const { userError } = require('../util/userError');
const { todayPhnomPenh } = require('../db/_assetUtil');

function permissions() {
  const caps = callerCaps();
  const owner = caps === null || caps.has('*');
  return {
    canView: owner || caps.has('trade.view') || caps.has('trade.manage'),
    canManage: owner || caps.has('trade.manage'),
  };
}

function denied(message = 'You do not have permission to use Trade Finance') {
  const err = userError(message, 'FORBIDDEN');
  err.userFacing = true;
  return err;
}

function companyForView() {
  if (!permissions().canView) throw denied();
  return activeCompanyId();
}

function companyForManage() {
  if (!permissions().canManage) throw denied('Only an owner or a role with Trade Finance management can change these records');
  return activeCompanyId();
}

function emitTradeChange(kind, op, id, companyId) {
  try {
    require('../events').broadcast('trade:changed', {
      kind, op, id: id ?? null, companyId, originUserId: getCallerUserId(),
    });
  } catch (_) { /* best effort */ }
}

function register({ expose }) {
  /* context: the small list the screens need before anything else */
  expose('trade:context', () => {
    const companyId = companyForView();
    return {
      companyId,
      permissions: permissions(),
      today: todayPhnomPenh(),
      banks: trade.listBanks(companyId),
      facilities: trade.listFacilities(companyId),
    };
  });

  /* banks */
  expose('trade:banks:create', (input = {}) => {
    const companyId = companyForManage();
    const row = trade.createBank(companyId, input, getCallerUserId());
    emitTradeChange('bank', 'create', row.id, companyId);
    return row;
  });
  expose('trade:banks:update', ({ id, patch } = {}) => {
    const companyId = companyForManage();
    const row = trade.updateBank(companyId, id, patch || {}, getCallerUserId());
    emitTradeChange('bank', 'update', id, companyId);
    return row;
  });
  expose('trade:banks:archive', ({ id } = {}) => {
    const companyId = companyForManage();
    const row = trade.archiveBank(companyId, id, getCallerUserId());
    emitTradeChange('bank', 'archive', id, companyId);
    return row;
  });

  /* facilities */
  expose('trade:facilities:list', (opts = {}) => trade.listFacilities(companyForView(), opts || {}));
  expose('trade:facilities:get', ({ id } = {}) => trade.getFacility(companyForView(), id));
  expose('trade:facilities:create', (input = {}) => {
    const companyId = companyForManage();
    const row = trade.createFacility(companyId, input, getCallerUserId());
    emitTradeChange('facility', 'create', row.id, companyId);
    return row;
  });
  expose('trade:facilities:update', ({ id, patch } = {}) => {
    const companyId = companyForManage();
    const row = trade.updateFacility(companyId, id, patch || {}, getCallerUserId());
    emitTradeChange('facility', 'update', id, companyId);
    return row;
  });
  expose('trade:facilities:setActive', ({ id, active } = {}) => {
    const companyId = companyForManage();
    const row = trade.setFacilityActive(companyId, id, !!active, getCallerUserId());
    emitTradeChange('facility', active ? 'restore' : 'archive', id, companyId);
    return row;
  });

  /* drawdowns */
  expose('trade:drawdowns:list', (filters = {}) => trade.listDrawdowns(companyForView(), filters || {}));
  expose('trade:drawdowns:get', ({ id } = {}) => trade.getDrawdown(companyForView(), id));
  expose('trade:drawdowns:create', (input = {}) => {
    const companyId = companyForManage();
    const row = trade.createDrawdown(companyId, input, getCallerUserId());
    emitTradeChange('drawdown', 'create', row.id, companyId);
    return row;
  });
  expose('trade:drawdowns:update', ({ id, patch } = {}) => {
    const companyId = companyForManage();
    const row = trade.updateDrawdown(companyId, id, patch || {}, getCallerUserId());
    emitTradeChange('drawdown', 'update', id, companyId);
    return row;
  });
  expose('trade:drawdowns:setStatus', ({ id, status } = {}) => {
    const companyId = companyForManage();
    const row = trade.setDrawdownStatus(companyId, id, status, getCallerUserId());
    emitTradeChange('drawdown', 'status', id, companyId);
    return row;
  });

  /* repayments */
  expose('trade:repayments:add', (input = {}) => {
    const companyId = companyForManage();
    const result = trade.addRepayment(companyId, input, getCallerUserId());
    emitTradeChange('repayment', 'create', result.repayment?.id, companyId);
    return result;
  });

  /* interest record */
  expose('trade:interest:list', (filters = {}) => trade.listPostings(companyForView(), filters || {}));
  expose('trade:interest:preview', () => trade.accrualPreview(companyForView()));

  /* Phase B: overdraft movements, month-end, reconciliation, fees */
  expose('trade:movements:list', ({ facilityId } = {}) => trade.listMovements(companyForView(), facilityId));
  expose('trade:movements:add', (input = {}) => {
    const companyId = companyForManage();
    const rows = trade.addMovement(companyId, input, getCallerUserId());
    emitTradeChange('movement', 'create', input?.facilityId, companyId);
    return rows;
  });
  expose('trade:capitalisation:preview', () => trade.capitalisationDue(companyForView()));
  expose('trade:capitalisation:run', () => {
    const companyId = companyForManage();
    const rows = trade.runCapitalisation(companyId);
    emitTradeChange('capitalisation', 'run', null, companyId);
    return rows;
  });
  expose('trade:reconciliation:list', () => trade.listReconciliations(companyForView()));
  expose('trade:reconciliation:add', (input = {}) => {
    const companyId = companyForManage();
    const rows = trade.addReconciliation(companyId, input, getCallerUserId());
    emitTradeChange('reconciliation', 'create', input?.facilityId, companyId);
    return rows;
  });
  expose('trade:fees:list', (filters = {}) => trade.listFees(companyForView(), filters || {}));
  expose('trade:fees:add', (input = {}) => {
    const companyId = companyForManage();
    const row = trade.addFee(companyId, input, getCallerUserId());
    emitTradeChange('fee', 'create', row.id, companyId);
    return row;
  });
  expose('trade:recurring:list', () => trade.listRecurring(companyForView()));
  expose('trade:recurring:add', (input = {}) => {
    const companyId = companyForManage();
    const rows = trade.addRecurring(companyId, input, getCallerUserId());
    emitTradeChange('recurring', 'create', null, companyId);
    return rows;
  });
  expose('trade:recurring:update', ({ id, patch } = {}) => {
    const companyId = companyForManage();
    const rows = trade.updateRecurring(companyId, id, patch || {}, getCallerUserId());
    emitTradeChange('recurring', 'update', id, companyId);
    return rows;
  });
  expose('trade:recurring:postDue', () => {
    const companyId = companyForManage();
    const rows = trade.postDueRecurring(companyId);
    emitTradeChange('recurring', 'post', null, companyId);
    return rows;
  });

  /* Phase C: reminders and the auto-post switch */
  expose('trade:reminders:due', () => ({ asOf: todayPhnomPenh(), reminders: trade.dueReminders(companyForView()) }));
  expose('trade:reminders:rules', () => trade.listReminderRules(companyForView()));
  expose('trade:reminders:rules:save', (input = {}) => {
    const companyId = companyForManage();
    const row = trade.saveReminderRule(companyId, input, getCallerUserId());
    emitTradeChange('reminder_rule', 'save', row.id, companyId);
    return row;
  });
  expose('trade:reminders:snooze', ({ id, until } = {}) => {
    const companyId = companyForManage();
    const row = trade.snoozeDrawdown(companyId, id, until || null, getCallerUserId());
    emitTradeChange('drawdown', 'snooze', id, companyId);
    return row;
  });
  expose('trade:reminders:log', ({ limit } = {}) => trade.listReminderLog(companyForView(), limit));
  expose('trade:settings:get', () => trade.getSettings(companyForView()));
  expose('trade:settings:save', (patch = {}) => {
    const companyId = companyForManage();
    const row = trade.saveSettings(companyId, patch || {}, getCallerUserId());
    emitTradeChange('settings', 'update', null, companyId);
    return row;
  });

  /* reports */
  expose('trade:reports:summary', () => trade.reportSummary(companyForView()));
}

module.exports = { register };
