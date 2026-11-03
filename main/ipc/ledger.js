/**
 * Fixed Assets A0: exchange rates and the accounting core over IPC/RPC
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §3.2, §5, §9). No accounting screens yet —
 * these serve the asset pages ("journal lines for this asset") and Settings →
 * Assets (official rates). Finance adds the rest.
 *
 *   fx:list, fx:rateOn            baseline reads (a rate is not sensitive)
 *   fx:getShared                  baseline read of the company's shared rate
 *   fx:setShared                  owner only (handler check; the RPC gate also
 *                                 marks it ADMIN_ONLY)
 *   fx:setRate, fx:voidRate       assets.manage or system.manage
 *   ledger:* reads                assets.view or assets.manage
 *   ledger:updateAccount          assets.manage (the accountant renumbers / renames)
 *   ledger:lockPeriod / unlock    ADMIN ONLY
 */

const fxRates = require('../db/fxRates');
const ledger = require('../db/ledger');
const { activeCompanyId, inCompany, emitAssetChange } = require('./assetAccess');
const { callerCaps } = require('./fuelAccess');
const financeAccess = require('./financeAccess');
const { userError } = require('../util/userError');
const { todayPhnomPenh } = require('../db/_assetUtil');

function register({ expose }) {
  /* ─── exchange rates ─── */
  expose('fx:list', (opts = {}) => fxRates.list(activeCompanyId(), opts || {}));
  /** The rate on a date (read-only: never seeds one), plus the company's
   *  shared rate for display. The per-Mac legacy value is no longer served
   *  here — it is a seed source only, never an active figure. */
  expose('fx:rateOn', ({ date, source = 'house' } = {}) => ({
    rate: fxRates.rateOn(activeCompanyId(), date, source),
    settingsKhrPerUsd: fxRates.sharedRate(activeCompanyId())?.khrPerUsd ?? null,
  }));
  /** The active company's shared rate; the first read seeds it once from this
   *  data-owning Mac's legacy Settings value (clients reach this via RPC). */
  expose('fx:getShared', () => fxRates.sharedRate(activeCompanyId()));
  /** Owner / admin only (the RPC gate marks the channel ADMIN_ONLY; this check
   *  is the local half of it). A re-set is dated today and voids today's
   *  previous row; older rows stay, so no historical figure is repriced. */
  expose('fx:setShared', ({ khrPerUsd } = {}) => {
    const caps = callerCaps();
    if (caps !== null && !caps.has('*')) {
      throw userError('Only the owner can change the company exchange rate', 'FORBIDDEN');
    }
    const companyId = activeCompanyId();
    const r = fxRates.setRate({ companyId, rateDate: todayPhnomPenh(), khrPerUsd, source: 'house', sourceNote: 'Company shared rate' });
    emitAssetChange('fx', 'create', r.id, companyId);
    financeAccess.emitFinanceChange('fx', 'set', null, companyId); // Finance rate hints refresh too
    return r;
  });
  expose('fx:setRate', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    if ((input.source ?? 'house') === 'house') financeAccess.requireOwner();
    const r = fxRates.setRate({ ...input, companyId });
    emitAssetChange('fx', 'create', r.id, companyId);
    financeAccess.emitFinanceChange('fx', 'set', null, companyId);
    return r;
  });
  expose('fx:voidRate', ({ id, reason } = {}) => {
    const rate = inCompany(fxRates.get(id), 'Rate');
    if (rate.source === 'house') {
      financeAccess.requireOwner();
      if (fxRates.sharedRate(rate.companyId, { seed: false })?.id === rate.id) {
        throw userError('Set a replacement company rate before voiding the rate in use');
      }
    }
    const r = fxRates.voidRate(id, reason);
    emitAssetChange('fx', 'void', id, r.companyId);
    return r;
  });

  /* ─── ledger (read-only for now, §5) ─── */
  expose('ledger:listAccounts', (opts = {}) => ledger.listAccounts(activeCompanyId(), {
    ...opts, excludeFinance: !financeAccess.permissions().canViewAll,
  }));
  expose('ledger:updateAccount', ({ id, patch } = {}) => {
    const account = inCompany(ledger.getAccount(id), 'Account');
    if (account.systemKey?.startsWith('fin.')) financeAccess.requireOwner();
    const a = ledger.updateAccount(id, patch || {});
    emitAssetChange('account', 'update', id, a.companyId);
    return a;
  });
  expose('ledger:getEntry', (id) => {
    const entry = inCompany(ledger.getEntry(id), 'Journal entry');
    if (entry.sourceKind?.startsWith('finance_') && !financeAccess.permissions().canViewAll) {
      throw financeAccess.denied('You do not have permission to view company Finance journals');
    }
    return entry;
  });
  expose('ledger:entriesForAsset', (assetId) => {
    inCompany(require('../db/fixedAssets').get(assetId), 'Asset');
    return ledger.entriesForAsset(assetId);
  });
  expose('ledger:listPeriods', () => ledger.listPeriods(activeCompanyId(), { excludeFinance: !financeAccess.permissions().canViewAll }));
  expose('ledger:checkIntegrity', () => ledger.checkIntegrity(activeCompanyId(), { excludeFinance: !financeAccess.permissions().canViewAll }));
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
