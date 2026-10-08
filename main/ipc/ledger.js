/**
 * Fixed Assets A0: exchange rates and the accounting core over IPC/RPC
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §3.2, §5, §9). No accounting screens yet —
 * these serve the asset pages ("journal lines for this asset") and Settings →
 * Assets (official rates). Finance adds the rest.
 *
 *   fx:list, fx:rateOn            baseline reads (a rate is not sensitive)
 *   fx:setRate, fx:voidRate       assets.manage or system.manage
 *   ledger:* reads                assets.view or assets.manage
 *   ledger:updateAccount          assets.manage (the accountant renumbers / renames)
 *   ledger:lockPeriod / unlock    ADMIN ONLY
 */

const fxRates = require('../db/fxRates');
const ledger = require('../db/ledger');
const { activeCompanyId, inCompany, emitAssetChange } = require('./assetAccess');

function register({ expose }) {
  /* ─── exchange rates ─── */
  expose('fx:list', (opts = {}) => fxRates.list(activeCompanyId(), opts || {}));
  /** The rate on a date (read-only: never seeds one), plus this Mac's Settings rate for display. */
  expose('fx:rateOn', ({ date, source = 'house' } = {}) => ({
    rate: fxRates.rateOn(activeCompanyId(), date, source),
    settingsKhrPerUsd: fxRates.settingsRate(),
  }));
  expose('fx:setRate', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const r = fxRates.setRate({ ...input, companyId });
    emitAssetChange('fx', 'create', r.id, companyId);
    return r;
  });
  expose('fx:voidRate', ({ id, reason } = {}) => {
    inCompany(fxRates.get(id), 'Rate');
    const r = fxRates.voidRate(id, reason);
    emitAssetChange('fx', 'void', id, r.companyId);
    return r;
  });

  /* ─── ledger (read-only for now, §5) ─── */
  expose('ledger:listAccounts', (opts = {}) => ledger.listAccounts(activeCompanyId(), opts || {}));
  expose('ledger:updateAccount', ({ id, patch } = {}) => {
    inCompany(ledger.getAccount(id), 'Account');
    const a = ledger.updateAccount(id, patch || {});
    emitAssetChange('account', 'update', id, a.companyId);
    return a;
  });
  expose('ledger:getEntry', (id) => inCompany(ledger.getEntry(id), 'Journal entry'));
  expose('ledger:entriesForAsset', (assetId) => {
    inCompany(require('../db/fixedAssets').get(assetId), 'Asset');
    return ledger.entriesForAsset(assetId);
  });
  expose('ledger:listPeriods', () => ledger.listPeriods(activeCompanyId()));
  expose('ledger:checkIntegrity', () => ledger.checkIntegrity(activeCompanyId()));
  expose('ledger:lockPeriod', ({ period, note } = {}) => {
    const companyId = activeCompanyId();
    const r = ledger.lockPeriod(companyId, period, note);
    emitAssetChange('period', 'lock', period, companyId);
    return r;
  });
  expose('ledger:unlockPeriod', ({ period, note } = {}) => {
    const companyId = activeCompanyId();
    const r = ledger.unlockPeriod(companyId, period, note);
    emitAssetChange('period', 'unlock', period, companyId);
    return r;
  });
}

module.exports = { register };
