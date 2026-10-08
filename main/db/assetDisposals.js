/**
 * Fixed Assets A2: assets leaving the register, and value changes
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §4.1, §5.4, §11).
 *
 *   dispose         sale, scrap or donation. The entry first posts the depreciation
 *                   still due up to the disposal (by the §4.1 convention — or takes
 *                   back what was posted beyond it), then: Dr Acc. dep. + Dr Sale
 *                   clearing 1190 (proceeds) [+ Dr Acc. impairment] / Cr Cost /
 *                   Cr Gain 4900 or Dr Loss 6520.
 *   partialDispose  a group asset: qty ÷ quantity of cost, accumulated depreciation
 *                   and impairment leave; gain / loss on that share; the rest
 *                   depreciates on from the next month.
 *   markLost        write-off: as a disposal with no proceeds (Dr Loss).
 *   markFound       reverses the write-off, dated the day it was found (a closed
 *                   month moves it to the first open month); the next run
 *                   catches up the depreciation missed meanwhile.
 *   impair          Dr Impairment loss 6510 / Cr Accumulated impairment 1590;
 *                   the schedule re-runs from that month on the lower value.
 *   revalue         land and buildings only ("use with your accountant").
 *                   Elimination method (IAS 16.35(b)): accumulated depreciation
 *                   and impairment are eliminated against cost, then cost moves
 *                   to the new value — up: first reverses this asset's earlier
 *                   revaluation losses through P&L (IAS 16.39), the rest Cr
 *                   Revaluation surplus 3300; down: against this asset's surplus
 *                   first, then Dr Impairment loss 6510 (IAS 16.40).
 *
 * Every entry carries the asset and its branch on each line. A linked Fuel
 * vehicle is retired in Fuel in the same transaction when it is disposed of
 * or lost (and made active again when it is found / the disposal is reversed).
 * Dates follow the event rules (not in the future, not before the asset was
 * acquired); a schedule change (partial disposal, impairment, revaluation)
 * must fall after the last month posted.
 */

const { getDb } = require('./index');
const { uuid, str, badRequest, audit, todayPhnomPenh, minorOrNull, notFound } = require('./_assetUtil');
const ledger = require('./ledger');
const config = require('./assetConfig');
const fixedAssets = require('./fixedAssets');
const book = require('../util/bookDepreciation');

const DISPOSAL_KINDS = ['sale', 'scrap', 'donation'];
const REVALUE_KEYS = ['land', 'building', 'building_light'];

function categoryOf(a) {
  const c = config.getCategory(a.categoryId);
  if (!c) throw badRequest('The asset has no category');
  return c;
}

/**
 * Lines that bring the asset's posted depreciation to what its schedule says
 * through `lastPeriod` (null = nothing depreciates yet). Returns { lines, due }.
 */
function settleLines(a, category, lastPeriod, dims) {
  const spec = fixedAssets.scheduleSpec(a);
  if (!spec) return { lines: [], due: 0 };
  const computed = lastPeriod && lastPeriod >= spec.startPeriod ? book.chargedThrough({ ...spec, endPeriod: lastPeriod }, lastPeriod) : 0;
  const due = computed - fixedAssets.postedDepreciation(a.id);
  if (!due) return { lines: [], due: 0 };
  if (due < 0) {
    return {
      due,
      lines: [{ accountId: category.glAccumAccountId, debitMinor: -due, lineRole: 'accum_dep', ...dims },
        { accountId: category.glExpenseAccountId, creditMinor: -due, lineRole: 'dep_catch_up', memo: `${a.tagCode} depreciation posted beyond ${lastPeriod || 'the disposal'} taken back`, ...dims }],
    };
  }
  // The last month's own amount is that month's charge; anything more is catch-up (review 2, LOW).
  const monthPart = Math.min(due, lastPeriod ? book.amountFor({ ...spec, endPeriod: lastPeriod }, lastPeriod) : 0);
  const lines = [];
  if (monthPart > 0) lines.push({ accountId: category.glExpenseAccountId, debitMinor: monthPart, lineRole: 'dep_expense', memo: `${a.tagCode} depreciation ${lastPeriod}`, ...dims });
  if (due - monthPart > 0) lines.push({ accountId: category.glExpenseAccountId, debitMinor: due - monthPart, lineRole: 'dep_catch_up', memo: `${a.tagCode} catch-up to ${lastPeriod}`, ...dims });
  lines.push({ accountId: category.glAccumAccountId, creditMinor: due, lineRole: 'accum_dep', ...dims });
  return { due, lines };
}

function proceedsInUsd(a, amountMinor, currency, date, fx) {
  const amount = minorOrNull(amountMinor, 'Proceeds') || 0;
  const cur = currency === 'KHR' ? 'KHR' : 'USD';
  const { usd, rate } = fixedAssets.amountInUsd(a.companyId, amount, cur, date, fx);
  return { amount, currency: cur, usd: usd || 0, rate };
}

function retireFuel(a, retire) {
  if (!a.fuelAssetId) return false;
  const f = getDb().prepare('SELECT status FROM fuel_assets WHERE id = ?').get(a.fuelAssetId);
  if (!f) return false;
  const want = retire ? 'retired' : 'active';
  if (f.status === want) return false;
  getDb().prepare('UPDATE fuel_assets SET status = ?, updated_at = ? WHERE id = ?').run(want, Date.now(), a.fuelAssetId);
  audit('fuel_asset', a.fuelAssetId, retire ? 'retire' : 'reactivate', { after: { status: want, fromRegister: a.tagCode } });
  return true;
}

/**
 * Work out a full disposal or write-off without writing it (the screen shows it
 * before Confirm). `kind` 'lost' is the write-off.
 */
function planDisposal({ id, date, kind = 'sale', proceedsMinor = 0, currency = 'USD', fxKhrPerUsd = null }) {
  const a = fixedAssets.liveAsset(id, { activeOnly: true });
  const lost = kind === 'lost';
  if (!lost && !DISPOSAL_KINDS.includes(kind)) throw badRequest('Disposal must be a sale, scrap or donation');
  const d = fixedAssets.eventDateFor(a, date);
  fixedAssets.assertNoLaterMove(a, d);
  const settings = config.getSettings(a.companyId);
  const lastPeriod = book.lastPeriod(d, settings.convention);
  const p = lost || kind !== 'sale' ? { amount: 0, currency: 'USD', usd: 0, rate: null } : proceedsInUsd(a, proceedsMinor, currency, d, fxKhrPerUsd);
  // Review 2 (MEDIUM 3): a disposal dated in a month already posted (or closed)
  // is booked on the first day after the last posted / closed month, with a
  // memo naming its real date — the same rule as assertAfterPosted. The
  // event keeps the real date; the settle line takes back what was posted beyond it.
  const lateAfter = [fixedAssets.lastDepreciationPeriod(a.companyId), ledger.closedThrough(a.companyId)].filter((x) => x && x >= d.slice(0, 7)).sort().pop() || null;
  const entryDate = lateAfter ? `${book.addMonths(lateAfter, 1)}-01` : d;
  if (a.accountingTreatment === 'tracked_only') {
    return { asset: a, date: d, kind, lastPeriod, proceeds: p, entry: null, nbvMinor: null, gainMinor: null };
  }
  const category = categoryOf(a);
  const dims = { assetId: a.id, branchId: fixedAssets.branchAt(a, d) };
  const settle = settleLines(a, category, lastPeriod, dims);
  const t = ledger.assetLedgerTotals(a.id);
  const accum = t.accumDepMinor + settle.due;
  const nbv = t.costMinor - accum - t.impairmentMinor;
  const gain = p.usd - nbv;
  const lines = [...settle.lines];
  if (accum > 0) lines.push({ accountId: category.glAccumAccountId, debitMinor: accum, lineRole: 'accum_disposal', ...dims });
  if (accum < 0) lines.push({ accountId: category.glAccumAccountId, creditMinor: -accum, lineRole: 'accum_disposal', ...dims });
  if (t.impairmentMinor > 0) lines.push({ accountKey: 'fa.impairment', debitMinor: t.impairmentMinor, lineRole: 'impairment', ...dims });
  if (p.usd > 0) lines.push({ accountKey: 'fa.clearing.sale', debitMinor: p.usd, lineRole: 'clearing', txnCurrency: p.currency, txnAmountMinor: p.amount, ...(p.currency === 'KHR' ? { khrMinor: p.amount } : {}), ...dims });
  if (t.costMinor > 0) lines.push({ accountId: category.glCostAccountId, creditMinor: t.costMinor, lineRole: 'cost', ...dims });
  if (gain > 0) lines.push({ accountKey: 'fa.gain', creditMinor: gain, lineRole: 'gain', ...dims });
  if (gain < 0) lines.push({ accountKey: 'fa.loss', debitMinor: -gain, lineRole: 'loss', ...dims });
  const label = lost ? 'Written off (lost)' : kind === 'sale' ? 'Sold' : kind === 'scrap' ? 'Scrapped' : 'Donated';
  return {
    asset: a, date: d, kind, lastPeriod, proceeds: p, nbvMinor: nbv, gainMinor: gain, depreciationDueMinor: settle.due, entryDate,
    entry: lines.length >= 2 ? {
      companyId: a.companyId, entryDate, sourceKind: lost ? 'asset_lost' : 'asset_dispose', sourceId: a.id,
      memo: `${lateAfter ? `Late ${lost ? 'write-off' : 'disposal'} for ${d} (${ledger.humanMonth(lateAfter)} already posted) — ` : ''}${label}: ${a.tagCode} ${a.name}`,
      fxKhrPerUsd: p.currency === 'KHR' ? p.rate : undefined, lines,
    } : null,
  };
}

function previewDisposal(args) {
  const p = planDisposal(args);
  return {
    assetId: p.asset.id, date: p.date, kind: p.kind, lastPeriod: p.lastPeriod, proceedsUsdMinor: p.proceeds.usd,
    nbvMinor: p.nbvMinor, gainMinor: p.gainMinor, depreciationDueMinor: p.depreciationDueMinor ?? 0, posts: !!p.entry, entryDate: p.entryDate ?? p.date,
    lines: p.entry ? p.entry.lines.map((l) => ({ account: l.accountKey || l.accountId, debitMinor: l.debitMinor || 0, creditMinor: l.creditMinor || 0, lineRole: l.lineRole })) : [],
  };
}

function recordDisposal(args, eventKind) {
  const why = str(args.reason, 1000);
  if (eventKind === 'lost' && !why) throw badRequest('Say how it was found missing');
  const db = getDb();
  const eventId = uuid();
  let plan;
  let entry = null;
  db.transaction(() => {
    plan = planDisposal({ ...args, kind: eventKind === 'lost' ? 'lost' : (args.kind || 'sale') });
    const a = plan.asset;
    if (plan.entry) entry = ledger.post({ ...plan.entry, idempotencyKey: `evt:${eventId}` });
    const fuelRetired = retireFuel(a, true);
    fixedAssets.insertEvent({
      id: eventId, companyId: a.companyId, assetId: a.id, kind: eventKind === 'lost' ? 'lost' : 'dispose', eventDate: plan.date,
      reason: why, fromStatus: a.status, toStatus: eventKind === 'lost' ? 'lost' : 'disposed',
      proceedsMinor: plan.proceeds.amount, currency: plan.proceeds.currency, fxKhrPerUsd: plan.proceeds.rate || entry?.fxKhrPerUsd || null,
      amountUsdMinor: plan.proceeds.usd, buyer: str(args.buyer, 200), journalEntryId: entry ? entry.id : null,
      stocktakeResultId: args.stocktakeResultId || null,
      detail: { kind: plan.kind, lastPeriod: plan.lastPeriod, nbvMinor: plan.nbvMinor, gainMinor: plan.gainMinor, depreciationDueMinor: plan.depreciationDueMinor ?? 0, fuelRetired },
    });
    fixedAssets.touch(a.id, ['status = @s', 'disposed_on = @d', 'disposal_event_id = @e', 'accum_minor = 0', 'nbv_minor = 0'],
      { s: eventKind === 'lost' ? 'lost' : 'disposed', d: plan.date, e: eventId });
    require('./assetDepreciation').refreshSnapshot(a.id);
  })();
  audit('asset_event', eventId, eventKind === 'lost' ? 'lost' : 'dispose', { after: {
    assetId: plan.asset.id, date: plan.date, kind: plan.kind, proceedsUsdMinor: plan.proceeds.usd, nbvMinor: plan.nbvMinor, gainMinor: plan.gainMinor, entryNo: entry?.entryNo ?? null,
  } });
  return { asset: fixedAssets.get(plan.asset.id), event: fixedAssets.getEvent(eventId), entry };
}

function dispose(args = {}) { return recordDisposal(args, 'dispose'); }
function markLost(args = {}) { return recordDisposal(args, 'lost'); }

/** Found again: the write-off is reversed in the current open month; status goes back. */
function markFound({ id, date, reason } = {}) {
  const a = fixedAssets.get(id);
  if (!a) throw notFound('Asset');
  if (a.status !== 'lost') throw badRequest(`${a.tagCode} is not written off as lost`);
  const lostEvent = fixedAssets.getEvent(a.disposalEventId);
  if (!lostEvent || lostEvent.kind !== 'lost') throw badRequest('The write-off for this asset was not found');
  const d = fixedAssets.eventDate(date);
  if (d < lostEvent.eventDate) throw badRequest(`It was written off on ${lostEvent.eventDate} — it cannot be found before that`);
  const why = str(reason, 1000) || 'Found again';
  const db = getDb();
  const eventId = uuid();
  let rev = null;
  db.transaction(() => {
    // Dated the day it was found (a closed month moves it to the first open one), so the books
    // show the asset back from that day — not from whenever the finding was typed in.
    if (lostEvent.journalEntryId) rev = ledger.reverse(lostEvent.journalEntryId, why, { sourceKind: 'reversal', sourceId: eventId, date: d });
    fixedAssets.insertEvent({
      id: eventId, companyId: a.companyId, assetId: a.id, kind: 'found', eventDate: d, reason: why, fromStatus: 'lost',
      toStatus: lostEvent.fromStatus || 'in_use', journalEntryId: rev ? rev.id : null, reversesEventId: lostEvent.id,
      stocktakeResultId: null,
    });
    db.prepare('UPDATE asset_events SET reversed_by_event_id = ? WHERE id = ?').run(eventId, lostEvent.id);
    fixedAssets.touch(a.id, ['status = @s', 'disposed_on = NULL', 'disposal_event_id = NULL'], { s: lostEvent.fromStatus || 'in_use' });
    if (lostEvent.detail?.fuelRetired) retireFuel(a, false);
    require('./assetDepreciation').refreshSnapshot(a.id);
  })();
  audit('asset_event', eventId, 'found', { after: { assetId: a.id, date: d, entryNo: rev?.entryNo ?? null } });
  return { asset: fixedAssets.get(a.id), event: fixedAssets.getEvent(eventId), entry: rev };
}

/** Sell or scrap part of a group asset (quantity > 1). */
function partialDispose({ id, date, qty, kind = 'sale', proceedsMinor = 0, currency = 'USD', fxKhrPerUsd = null, buyer, reason } = {}) {
  const a = fixedAssets.liveAsset(id, { activeOnly: true });
  const n = Number(qty);
  if (!(a.quantity > 1)) throw badRequest(`${a.tagCode} is a single item — dispose of it instead`);
  if (!Number.isInteger(n) || n < 1 || n >= a.quantity) throw badRequest(`Quantity must be 1 to ${a.quantity - 1} (all ${a.quantity} is a full disposal)`);
  if (!DISPOSAL_KINDS.includes(kind)) throw badRequest('Disposal must be a sale, scrap or donation');
  const d = fixedAssets.eventDateFor(a, date);
  fixedAssets.assertAfterPosted(a, d);
  const settings = config.getSettings(a.companyId);
  const lastPeriod = book.lastPeriod(d, settings.convention);
  const p = kind === 'sale' ? proceedsInUsd(a, proceedsMinor, currency, d, fxKhrPerUsd) : { amount: 0, currency: 'USD', usd: 0, rate: null };
  const db = getDb();
  const eventId = uuid();
  let entry = null;
  let detail;
  db.transaction(() => {
    const share = (v) => Math.round((v * n) / a.quantity);
    if (a.accountingTreatment !== 'tracked_only') {
      const category = categoryOf(a);
      const dims = { assetId: a.id, branchId: fixedAssets.branchAt(a, d) };
      const settle = settleLines(a, category, lastPeriod, dims);
      const t = ledger.assetLedgerTotals(a.id);
      const accum = t.accumDepMinor + settle.due;
      const costShare = share(t.costMinor);
      const accumShare = share(accum);
      const impairShare = share(t.impairmentMinor);
      const nbvShare = costShare - accumShare - impairShare;
      const gain = p.usd - nbvShare;
      const lines = [...settle.lines];
      if (accumShare > 0) lines.push({ accountId: category.glAccumAccountId, debitMinor: accumShare, lineRole: 'accum_disposal', ...dims });
      if (impairShare > 0) lines.push({ accountKey: 'fa.impairment', debitMinor: impairShare, lineRole: 'impairment', ...dims });
      if (p.usd > 0) lines.push({ accountKey: 'fa.clearing.sale', debitMinor: p.usd, lineRole: 'clearing', txnCurrency: p.currency, txnAmountMinor: p.amount, ...(p.currency === 'KHR' ? { khrMinor: p.amount } : {}), ...dims });
      if (costShare > 0) lines.push({ accountId: category.glCostAccountId, creditMinor: costShare, lineRole: 'cost', ...dims });
      if (gain > 0) lines.push({ accountKey: 'fa.gain', creditMinor: gain, lineRole: 'gain', ...dims });
      if (gain < 0) lines.push({ accountKey: 'fa.loss', debitMinor: -gain, lineRole: 'loss', ...dims });
      if (lines.length >= 2) {
        entry = ledger.post({ companyId: a.companyId, entryDate: d, sourceKind: 'asset_dispose', sourceId: a.id, idempotencyKey: `evt:${eventId}`,
          memo: `Part ${kind === 'sale' ? 'sold' : 'disposed of'}: ${n} of ${a.quantity} × ${a.tagCode} ${a.name}`, fxKhrPerUsd: p.currency === 'KHR' ? p.rate : undefined, lines });
      }
      const spec = fixedAssets.scheduleSpec(a);
      const salvageNow = spec ? book.positionAt(spec, book.addMonths(lastPeriod, 1)).salvageMinor : (a.salvageMinor || 0);
      detail = { kind, qty: n, quantityBefore: a.quantity, lastPeriod, costShareMinor: costShare, accumShareMinor: accumShare, impairShareMinor: impairShare,
        nbvShareMinor: nbvShare, gainMinor: gain, salvageAfterMinor: salvageNow - share(salvageNow), depreciationDueMinor: settle.due };
    } else {
      detail = { kind, qty: n, quantityBefore: a.quantity };
    }
    fixedAssets.insertEvent({
      id: eventId, companyId: a.companyId, assetId: a.id, kind: 'partial_dispose', eventDate: d, effectivePeriod: book.addMonths(lastPeriod, 1),
      reason: str(reason, 1000), qty: n, proceedsMinor: p.amount, currency: p.currency, fxKhrPerUsd: p.rate || entry?.fxKhrPerUsd || null,
      amountUsdMinor: p.usd, buyer: str(buyer, 200), journalEntryId: entry ? entry.id : null, detail,
    });
    fixedAssets.touch(a.id, ['quantity = @q'], { q: a.quantity - n });
    require('./assetDepreciation').refreshSnapshot(a.id);
  })();
  audit('asset_event', eventId, 'partial_dispose', { after: { assetId: a.id, date: d, qty: n, ...detail, entryNo: entry?.entryNo ?? null } });
  return { asset: fixedAssets.get(a.id), event: fixedAssets.getEvent(eventId), entry };
}

/** An impairment: the value falls by `amountMinor` (US cents) from that month. */
function impair({ id, date, amountMinor, reason } = {}) {
  const a = fixedAssets.liveAsset(id, { activeOnly: true });
  fixedAssets.assertDepreciating(a);
  const why = str(reason, 1000);
  if (!why) throw badRequest('Say why the value fell');
  const amount = minorOrNull(amountMinor, 'Amount');
  if (!amount) throw badRequest('Enter the amount of the impairment');
  const d = fixedAssets.eventDateFor(a, date);
  fixedAssets.assertAfterPosted(a, d);
  const spec = fixedAssets.scheduleSpec(a);
  const nbv = spec ? book.positionAt(spec, d.slice(0, 7)).nbvMinor : ledger.assetLedgerTotals(a.id).costMinor - ledger.assetLedgerTotals(a.id).impairmentMinor;
  if (amount > nbv) throw badRequest(`The impairment cannot be more than the book value (${(nbv / 100).toFixed(2)} USD)`);
  const db = getDb();
  const eventId = uuid();
  let entry;
  db.transaction(() => {
    const dims = { assetId: a.id, branchId: fixedAssets.branchAt(a, d) };
    entry = ledger.post({ companyId: a.companyId, entryDate: d, sourceKind: 'asset_impair', sourceId: a.id, idempotencyKey: `evt:${eventId}`,
      memo: `Impairment: ${a.tagCode} ${a.name} — ${why}`,
      lines: [{ accountKey: 'fa.impairment_loss', debitMinor: amount, lineRole: 'loss', ...dims }, { accountKey: 'fa.impairment', creditMinor: amount, lineRole: 'impairment', ...dims }] });
    fixedAssets.insertEvent({ id: eventId, companyId: a.companyId, assetId: a.id, kind: 'impair', eventDate: d, reason: why, amountMinor: amount, currency: 'USD', amountUsdMinor: amount, journalEntryId: entry.id });
    require('./assetDepreciation').refreshSnapshot(a.id);
  })();
  audit('asset_event', eventId, 'impair', { after: { assetId: a.id, date: d, amountMinor: amount, entryNo: entry.entryNo } });
  return { asset: fixedAssets.get(a.id), event: fixedAssets.getEvent(eventId), entry };
}

/**
 * Revalue land or a building to `newValueMinor` (US cents) from that month.
 * Use with your accountant: the plan keeps it for land and buildings only.
 */
function revalue({ id, date, newValueMinor, reason } = {}) {
  const a = fixedAssets.liveAsset(id, { activeOnly: true });
  const category = categoryOf(a);
  if (!REVALUE_KEYS.includes(category.builtinKey) && !['land', '1', '1b'].includes(String(a.taxClass))) {
    throw badRequest('Only land and buildings can be revalued — use an impairment for other assets');
  }
  if (a.accountingTreatment === 'tracked_only') throw badRequest(`${a.tagCode} is tracked, not capitalised`);
  const why = str(reason, 1000);
  if (!why) throw badRequest('Say where the new value comes from (for example: valuer\'s report)');
  const value = minorOrNull(newValueMinor, 'New value');
  if (value == null) throw badRequest('Enter the new value');
  const d = fixedAssets.eventDateFor(a, date);
  fixedAssets.assertAfterPosted(a, d);
  const period = d.slice(0, 7);
  const db = getDb();
  const eventId = uuid();
  let entry = null;
  let detail;
  db.transaction(() => {
    const dims = { assetId: a.id, branchId: fixedAssets.branchAt(a, d) };
    const settle = settleLines(a, category, book.addMonths(period, -1), dims);
    const t = ledger.assetLedgerTotals(a.id);
    const accum = t.accumDepMinor + settle.due;
    const nbv = t.costMinor - accum - t.impairmentMinor;
    const diff = value - nbv;
    const lines = [...settle.lines];
    if (accum > 0) lines.push({ accountId: category.glAccumAccountId, debitMinor: accum, lineRole: 'accum_reval', ...dims });
    if (t.impairmentMinor > 0) lines.push({ accountKey: 'fa.impairment', debitMinor: t.impairmentMinor, lineRole: 'impairment', ...dims });
    const costNet = value - t.costMinor;
    if (costNet > 0) lines.push({ accountId: category.glCostAccountId, debitMinor: costNet, lineRole: 'cost', ...dims });
    if (costNet < 0) lines.push({ accountId: category.glCostAccountId, creditMinor: -costNet, lineRole: 'cost', ...dims });
    // IAS 16.39 / 16.40 (review 2): an increase first reverses this asset's
    // earlier revaluation losses through profit and loss, the rest goes to the
    // surplus; a decrease first uses this asset's surplus, the rest is a loss.
    const plLoss = Math.max(0, getDb().prepare(`SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS n FROM journal_lines WHERE asset_id = ? AND line_role = 'reval_pl'`).get(a.id).n);
    let toSurplus = 0;
    let toLoss = 0;
    if (diff > 0) {
      const reversal = Math.min(diff, plLoss);
      toLoss = -reversal;
      toSurplus = diff - reversal;
      if (reversal) lines.push({ accountKey: 'fa.impairment_loss', creditMinor: reversal, lineRole: 'reval_pl', memo: 'Reverses earlier revaluation losses (IAS 16.39)', ...dims });
      if (toSurplus) lines.push({ accountKey: 'equity.revaluation', creditMinor: toSurplus, lineRole: 'revaluation', ...dims });
    } else if (diff < 0) {
      const surplus = Math.max(0, t.revaluationSurplusMinor);
      toSurplus = -Math.min(surplus, -diff);
      toLoss = -diff + toSurplus;
      if (toSurplus) lines.push({ accountKey: 'equity.revaluation', debitMinor: -toSurplus, lineRole: 'revaluation', memo: 'Against the surplus first (IAS 16.40)', ...dims });
      if (toLoss) lines.push({ accountKey: 'fa.impairment_loss', debitMinor: toLoss, lineRole: 'reval_pl', ...dims });
    }
    if (lines.length >= 2) {
      entry = ledger.post({ companyId: a.companyId, entryDate: d, sourceKind: 'asset_revalue', sourceId: a.id, idempotencyKey: `evt:${eventId}`,
        memo: `Revaluation: ${a.tagCode} ${a.name} to ${(value / 100).toFixed(2)} USD — ${why}`, lines });
    }
    detail = { previousNbvMinor: nbv, eliminatedAccumMinor: accum, eliminatedImpairmentMinor: t.impairmentMinor, surplusMinor: toSurplus, lossMinor: toLoss, method: 'elimination' };
    fixedAssets.insertEvent({ id: eventId, companyId: a.companyId, assetId: a.id, kind: 'revalue', eventDate: d, reason: why, amountMinor: value, currency: 'USD',
      amountUsdMinor: value, journalEntryId: entry ? entry.id : null, detail });
    require('./assetDepreciation').refreshSnapshot(a.id);
  })();
  audit('asset_event', eventId, 'revalue', { after: { assetId: a.id, date: d, newValueMinor: value, ...detail, entryNo: entry?.entryNo ?? null } });
  return { asset: fixedAssets.get(a.id), event: fixedAssets.getEvent(eventId), entry };
}

/**
 * Undo the asset's latest money event of these kinds (dispose, partial
 * disposal, impairment, revaluation): the mirror entry in the current open
 * month, the asset back as it was. A write-off is undone with markFound.
 */
function reverseMoneyEvent(e, why) {
  const a = fixedAssets.get(e.assetId);
  const later = getDb().prepare(`
    SELECT 1 FROM asset_events WHERE asset_id = ? AND id <> ? AND voided_at IS NULL AND reversed_by_event_id IS NULL
       AND kind IN ('capex', 'impair', 'revalue', 'partial_dispose', 'dispose', 'lost', 'life_change', 'salvage_change')
       AND (event_date > ? OR (event_date = ? AND created_at > ?)) LIMIT 1
  `).get(e.assetId, e.id, e.eventDate, e.eventDate, e.createdAt);
  if (later) throw badRequest('A later change is recorded for this asset — undo that one first');
  const db = getDb();
  const revEventId = uuid();
  let rev = null;
  db.transaction(() => {
    if (e.journalEntryId) rev = ledger.reverse(e.journalEntryId, why, { sourceKind: 'reversal', sourceId: revEventId });
    fixedAssets.insertEvent({ id: revEventId, companyId: e.companyId, assetId: e.assetId, kind: 'reversal', eventDate: todayPhnomPenh(), reason: why,
      amountMinor: e.amountMinor, currency: e.currency, amountUsdMinor: e.amountUsdMinor, journalEntryId: rev ? rev.id : null, reversesEventId: e.id });
    db.prepare('UPDATE asset_events SET reversed_by_event_id = ? WHERE id = ?').run(revEventId, e.id);
    if (e.kind === 'dispose') {
      fixedAssets.touch(e.assetId, ['status = @s', 'disposed_on = NULL', 'disposal_event_id = NULL'], { s: e.fromStatus || 'in_use' });
      if (e.detail?.fuelRetired) retireFuel(a, false);
    }
    if (e.kind === 'partial_dispose') fixedAssets.touch(e.assetId, ['quantity = quantity + @q'], { q: e.qty || 0 });
    require('./assetDepreciation').refreshSnapshot(e.assetId);
  })();
  audit('asset_event', revEventId, 'reverse', { after: { assetId: e.assetId, reverses: e.id, kind: e.kind, entryNo: rev?.entryNo ?? null, reason: why } });
  return { asset: fixedAssets.get(e.assetId), event: fixedAssets.getEvent(revEventId), entry: rev };
}

module.exports = { DISPOSAL_KINDS, planDisposal, previewDisposal, dispose, markLost, markFound, partialDispose, impair, revalue, reverseMoneyEvent, settleLines };
