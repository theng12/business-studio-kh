/**
 * Fixed Assets A2: the tax year — Cambodian classes, in riel
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §4.3, §3.6). NEVER POSTED: this is the
 * worksheet the accountant uses for the return. Every rate and rule is
 * "confirm with an accountant" (main/util/taxDepreciation.js).
 *
 *   Classes 2, 3, 4   one pool per class: opening WDV + additions (cost in riel
 *                     at the official rate on the purchase date) − disposal
 *                     proceeds; × the class rate.
 *   Class 1, 1b,      per asset, straight-line: a full year in the year acquired,
 *   intangible        none in the year disposed; gain / loss on disposal.
 *   Land              no depreciation; gain / loss = proceeds − cost.
 *
 * The first year computed is the register start's year. Its opening pools are
 * what the owner (or, one day, an accountant) enters (`tax_pool_openings`); when
 * nothing is entered the app shows an ESTIMATE built from the purchase history
 * of the assets that were already owned, labelled
 * "estimate — confirm with an accountant" (§13a: there is no accountant yet).
 * Later years open with the year before's closing — or, when that year is
 * filed, with its filed snapshot's closing.
 *
 * Marking a year filed (admin only) freezes a snapshot; the view then shows
 * "changed since filing" per class for anything that moved afterwards.
 */

const { getDb } = require('./index');
const { parseJson } = require('./_util');
const { uuid, str, int, badRequest, getCallerUserId, audit } = require('./_assetUtil');
const config = require('./assetConfig');
const fxRates = require('./fxRates');
const tax = require('../util/taxDepreciation');

const ESTIMATE_LABEL = 'estimate — confirm with an accountant';

function year(d) { return d ? Number(String(d).slice(0, 4)) : null; }

function riel(companyId, amountMinor, currency, date) {
  if (!amountMinor) return 0;
  if (currency === 'KHR') return amountMinor;
  const r = fxRates.taxRateFor(companyId, date, { seed: false });
  return tax.usdCentsToKhr(amountMinor, r.khrPerUsd);
}

/** Everything the tax view needs about each asset that is in the books. */
function taxAssets(companyId) {
  const settings = config.getSettings(companyId);
  const firstYear = year(settings.registerStartDate);
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM fixed_assets WHERE company_id = ? AND record_state = 'active' AND accounting_treatment IN ('capitalised', 'not_depreciated') AND tax_class IS NOT NULL
  `).all(companyId);
  return rows.map((r) => {
    const events = db.prepare(`SELECT * FROM asset_events WHERE asset_id = ? AND voided_at IS NULL AND reversed_by_event_id IS NULL
        AND kind IN ('capex', 'dispose', 'partial_dispose', 'lost') ORDER BY event_date, created_at`).all(r.id);
    const opening = r.acquisition_kind === 'opening';
    const deemed = opening && r.cost_basis === 'deemed';
    const acquiredYear = opening ? (deemed ? firstYear : year(r.purchase_date || r.in_service_date) || firstYear - 1) : year(r.purchase_date);
    const exits = events.filter((e) => ['dispose', 'partial_dispose', 'lost'].includes(e.kind)).map((e) => ({
      kind: e.kind, date: e.event_date, year: year(e.event_date), qty: e.qty ?? null,
      proceedsKhr: riel(companyId, e.proceeds_minor, e.currency, e.event_date),
      full: e.kind !== 'partial_dispose',
    }));
    const capex = events.filter((e) => e.kind === 'capex').map((e) => ({ date: e.event_date, year: year(e.event_date), costKhr: riel(companyId, e.amount_minor, e.currency, e.event_date) }));
    const fullExit = exits.find((x) => x.full) || null;
    return {
      id: r.id, tagCode: r.tag_code, name: r.name, taxClass: String(r.tax_class), costKhr: r.tax_cost_khr_minor || 0,
      opening, deemed, acquiredYear, openingWdvKhr: r.tax_opening_wdv_khr_minor, lifeMonths: r.useful_life_months,
      fxSource: r.tax_fx_source || '', exits, capex, disposedYear: fullExit ? fullExit.year : null,
    };
  });
}

function storedOpening(companyId, y, classKey) {
  const r = getDb().prepare('SELECT * FROM tax_pool_openings WHERE company_id = ? AND tax_year = ? AND tax_class = ?').get(companyId, y, classKey);
  return r ? {
    openingWdvKhr: r.opening_wdv_khr_minor, sourceNote: r.source_note ?? null, isEstimate: !!r.is_estimate,
    confirmedByAccountant: !!r.confirmed_by_accountant, updatedAt: r.updated_at,
  } : null;
}

/** The first year's opening pools: entered, else the estimate from purchase history. */
function firstYearOpenings(companyId, firstYear, assets) {
  const est = tax.estimatePoolOpenings({
    firstYear,
    assets: assets.filter((a) => a.opening && !a.deemed).map((a) => ({
      taxClass: a.taxClass, costKhr: a.costKhr, purchaseYear: a.acquiredYear,
    })),
  });
  const out = {};
  for (const k of tax.POOLED_CLASSES) {
    const deemedKhr = assets.filter((a) => a.opening && a.deemed && a.taxClass === k).reduce((t, a) => t + a.costKhr, 0);
    const estimate = (est[k]?.openingWdvKhr || 0) + deemedKhr;
    const stored = storedOpening(companyId, firstYear, k);
    out[k] = stored
      ? { openingWdvKhr: stored.openingWdvKhr, source: stored.isEstimate ? 'estimate' : 'entered', label: stored.isEstimate ? ESTIMATE_LABEL : (stored.sourceNote || 'entered'),
        confirmedByAccountant: stored.confirmedByAccountant, estimateKhr: estimate, sourceNote: stored.sourceNote }
      : { openingWdvKhr: estimate, source: 'estimate', label: ESTIMATE_LABEL, confirmedByAccountant: false, estimateKhr: estimate, sourceNote: null, notEntered: true };
  }
  return out;
}

function filedSnapshot(companyId, y) {
  const r = getDb().prepare("SELECT * FROM tax_year_snapshots WHERE company_id = ? AND tax_year = ? AND status = 'filed'").get(companyId, y);
  return r ? { id: r.id, taxYear: r.tax_year, filedAt: r.filed_at, filedByUserId: r.filed_by_user_id ?? null, snapshot: parseJson(r.snapshot_json, null), fxSourceSummary: r.fx_source_summary ?? null } : null;
}

/** Book depreciation per tax class for a calendar year (USD cents and riel, as posted). */
function bookByClass(companyId, y) {
  const rows = getDb().prepare(`
    SELECT a.tax_class AS cls, SUM(l.debit_minor - l.credit_minor) AS usd,
           SUM(CASE WHEN l.debit_minor > 0 THEN l.khr_minor ELSE -l.khr_minor END) AS khr
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN fixed_assets a ON a.id = l.asset_id
     WHERE e.company_id = ? AND l.line_role IN ('dep_expense', 'dep_catch_up') AND substr(e.entry_date, 1, 4) = ?
     GROUP BY a.tax_class
  `).all(companyId, String(y));
  return Object.fromEntries(rows.map((r) => [String(r.cls), { usd: r.usd || 0, khr: r.khr || 0 }]));
}

/** Compute one year (no filed-snapshot comparison). `cache` keeps earlier years. */
function computeYear(companyId, y, cache = new Map()) {
  if (cache.has(y)) return cache.get(y);
  const settings = config.getSettings(companyId);
  const firstYear = year(settings.registerStartDate);
  if (y < firstYear) throw badRequest(`The tax view starts in ${firstYear}, the register start year`);
  const assets = taxAssets(companyId);
  let openings;
  if (y === firstYear) openings = firstYearOpenings(companyId, firstYear, assets);
  else {
    const filedPrev = filedSnapshot(companyId, y - 1);
    const prev = filedPrev?.snapshot || computeYear(companyId, y - 1, cache);
    openings = {};
    for (const k of tax.POOLED_CLASSES) {
      openings[k] = { openingWdvKhr: prev.pools[k]?.closingWdvKhr || 0, source: filedPrev ? 'filed' : 'computed', label: filedPrev ? `${y - 1} as filed` : `${y - 1} closing` };
    }
  }

  const pools = {};
  for (const k of tax.POOLED_CLASSES) {
    const inClass = assets.filter((a) => a.taxClass === k);
    const additions = inClass.filter((a) => !a.opening && a.acquiredYear === y).reduce((t, a) => t + a.costKhr, 0)
      + inClass.reduce((t, a) => t + a.capex.filter((c) => c.year === y).reduce((s, c) => s + c.costKhr, 0), 0);
    const proceeds = inClass.reduce((t, a) => t + a.exits.filter((x) => x.year === y).reduce((s, x) => s + x.proceedsKhr, 0), 0);
    const remaining = inClass.some((a) => a.acquiredYear <= y && (a.disposedYear == null || a.disposedYear > y));
    const row = tax.poolYear({ classKey: k, openingWdvKhr: openings[k].openingWdvKhr, additionsKhr: additions, proceedsKhr: proceeds, assetsRemaining: remaining });
    pools[k] = { ...row, label: tax.taxClass(k).label, openingSource: openings[k].source, openingLabel: openings[k].label,
      confirmedByAccountant: openings[k].confirmedByAccountant ?? null, estimateKhr: openings[k].estimateKhr ?? null, assets: inClass.length };
  }

  const perAsset = [];
  for (const a of assets.filter((x) => !tax.taxClass(x.taxClass).pooled)) {
    const cls = tax.taxClass(a.taxClass);
    if (cls.method === 'none') {
      const exit = a.exits.find((x) => x.year === y && x.full);
      if (exit) perAsset.push({ assetId: a.id, tagCode: a.tagCode, name: a.name, taxClass: cls.key, costKhr: a.costKhr, depreciationKhr: 0, wdvKhr: a.costKhr, proceedsKhr: exit.proceedsKhr, gainLossKhr: exit.proceedsKhr - a.costKhr });
      continue;
    }
    if (a.acquiredYear > y) continue;
    const components = [{ costKhr: a.costKhr, acquiredYear: a.acquiredYear, openingAccumKhr: a.opening && a.openingWdvKhr != null ? a.costKhr - a.openingWdvKhr : 0 }]
      .concat(a.capex.filter((c) => c.year <= y).map((c) => ({ costKhr: c.costKhr, acquiredYear: c.year, openingAccumKhr: 0 })));
    let dep = 0; let wdvStart = 0; let costTotal = 0;
    for (const c of components) {
      const from = Math.max(c.acquiredYear, firstYear);
      const rows = tax.straightLineYears({ classKey: cls.key, costKhr: c.costKhr, lifeMonths: a.lifeMonths, acquiredYear: c.acquiredYear, disposedYear: a.disposedYear, openingAccumKhr: c.openingAccumKhr, fromYear: from, toYear: y });
      const cur = rows.find((r) => r.year === y);
      const prev = rows.find((r) => r.year === y - 1);
      dep += cur ? cur.depreciationKhr : 0;
      wdvStart += prev ? prev.wdvKhr : c.costKhr - c.openingAccumKhr;
      costTotal += c.costKhr;
    }
    if (a.disposedYear != null && a.disposedYear < y) continue;
    const exit = a.exits.find((x) => x.year === y && x.full);
    perAsset.push({
      assetId: a.id, tagCode: a.tagCode, name: a.name, taxClass: cls.key, costKhr: costTotal, depreciationKhr: dep, wdvKhr: wdvStart - dep,
      proceedsKhr: exit ? exit.proceedsKhr : null, gainLossKhr: exit ? exit.proceedsKhr - wdvStart : null,
    });
  }

  const book = bookByClass(companyId, y);
  const classes = [...new Set([...tax.TAX_CLASS_KEYS.filter((k) => k !== 'none'), ...Object.keys(book)])];
  const bookVsTax = classes.map((k) => {
    const taxKhr = tax.POOLED_CLASSES.includes(k) ? pools[k].depreciationKhr : perAsset.filter((r) => r.taxClass === k).reduce((t, r) => t + r.depreciationKhr, 0);
    const b = book[k] || { usd: 0, khr: 0 };
    return { taxClass: k, label: tax.TAX_CLASSES[k]?.label || k, bookUsdMinor: b.usd, bookKhr: b.khr, taxKhr, differenceKhr: taxKhr - b.khr };
  }).filter((r) => r.bookUsdMinor || r.taxKhr);

  const houseRated = assets.filter((a) => /house/.test(a.fxSource)).length;
  const result = {
    year: y, firstYear, confirmWithAccountant: true, pools, perAsset, bookVsTax,
    totals: {
      taxDepreciationKhr: Object.values(pools).reduce((t, p) => t + p.depreciationKhr, 0) + perAsset.reduce((t, r) => t + r.depreciationKhr, 0),
      bookDepreciationKhr: bookVsTax.reduce((t, r) => t + r.bookKhr, 0),
      bookDepreciationUsdMinor: bookVsTax.reduce((t, r) => t + r.bookUsdMinor, 0),
    },
    notes: [
      'Every rate and rule here is to be confirmed with an accountant.',
      ...(y === firstYear && Object.values(pools).some((p) => p.openingSource === 'estimate' && p.openingWdvKhr) ? [`Opening pools for ${firstYear} are an ${ESTIMATE_LABEL}.`] : []),
      ...(houseRated ? [`Official rate missing for ${houseRated} asset${houseRated === 1 ? '' : 's'} — the house rate was used (labelled on each asset).`] : []),
    ],
  };
  cache.set(y, result);
  return result;
}

/** The tax view for a year, with the filed snapshot and "changed since filing" when it was filed. */
function getTaxYear(companyId, y) {
  const n = int(y);
  if (!n || n < 2000 || n > 2200) throw badRequest('Give the tax year, like 2026');
  const current = computeYear(companyId, n);
  const filed = filedSnapshot(companyId, n);
  if (!filed) return { ...current, filed: null, changedSinceFiling: [] };
  const changed = [];
  for (const k of tax.POOLED_CLASSES) {
    const was = filed.snapshot?.pools?.[k];
    const now = current.pools[k];
    if (!was) continue;
    for (const f of ['depreciationKhr', 'closingWdvKhr', 'additionsKhr', 'proceedsKhr']) {
      if ((was[f] || 0) !== (now[f] || 0)) changed.push({ taxClass: k, field: f, filedKhr: was[f] || 0, nowKhr: now[f] || 0, differenceKhr: (now[f] || 0) - (was[f] || 0) });
    }
  }
  const wasSl = (filed.snapshot?.perAsset || []).reduce((t, r) => t + r.depreciationKhr, 0);
  const nowSl = current.perAsset.reduce((t, r) => t + r.depreciationKhr, 0);
  if (wasSl !== nowSl) changed.push({ taxClass: 'per-asset', field: 'depreciationKhr', filedKhr: wasSl, nowKhr: nowSl, differenceKhr: nowSl - wasSl });
  return { ...current, filed: { filedAt: filed.filedAt, filedByUserId: filed.filedByUserId }, filedSnapshot: filed.snapshot, changedSinceFiling: changed };
}

/** Enter (or accept the estimate for) a first-year opening pool. */
function setPoolOpening(companyId, { year: y, taxClass, openingWdvKhrMinor, sourceNote, confirmedByAccountant = false, isEstimate = false } = {}) {
  const firstYear = year(config.getSettings(companyId).registerStartDate);
  if (Number(y) !== firstYear) throw badRequest(`Opening pools are entered for ${firstYear}, the first year the app computes; later years follow from it`);
  if (!tax.POOLED_CLASSES.includes(String(taxClass))) throw badRequest('Opening pools are for classes 2, 3 and 4');
  if (filedSnapshot(companyId, firstYear)) throw badRequest(`${firstYear} is marked filed — un-file it first`);
  const wdv = int(openingWdvKhrMinor);
  if (wdv == null || wdv < 0) throw badRequest('The opening value is whole riel, 0 or more');
  const db = getDb();
  const before = storedOpening(companyId, firstYear, String(taxClass));
  const now = Date.now();
  db.prepare(`
    INSERT INTO tax_pool_openings (id, company_id, tax_year, tax_class, opening_wdv_khr_minor, source_note, is_estimate, confirmed_by_accountant, entered_by_user_id, created_at, updated_at)
    VALUES (@id, @companyId, @year, @cls, @wdv, @note, @est, @conf, @by, @now, @now)
    ON CONFLICT(company_id, tax_year, tax_class) DO UPDATE SET opening_wdv_khr_minor = excluded.opening_wdv_khr_minor, source_note = excluded.source_note,
      is_estimate = excluded.is_estimate, confirmed_by_accountant = excluded.confirmed_by_accountant, entered_by_user_id = excluded.entered_by_user_id, updated_at = excluded.updated_at
  `).run({ id: uuid(), companyId, year: firstYear, cls: String(taxClass), wdv, note: str(sourceNote, 500), est: isEstimate ? 1 : 0, conf: confirmedByAccountant ? 1 : 0, by: getCallerUserId(), now });
  const after = storedOpening(companyId, firstYear, String(taxClass));
  audit('tax_year', `${companyId}:${firstYear}:${taxClass}`, 'pool-opening', { before, after });
  return after;
}

/**
 * Mark a year filed (admin). The first year needs every non-empty opening
 * pool entered or, if it is the estimate, ticked "confirmed by accountant".
 */
function markTaxYearFiled(companyId, y) {
  const n = int(y);
  if (filedSnapshot(companyId, n)) throw badRequest(`${n} is already marked filed`);
  const view = computeYear(companyId, n);
  if (n === view.firstYear) {
    const open = Object.entries(view.pools).filter(([, p]) => p.openingWdvKhr && p.openingSource === 'estimate' && !p.confirmedByAccountant);
    if (open.length) throw badRequest(`The opening pools for class ${open.map(([k]) => k).join(', ')} are an ${ESTIMATE_LABEL} — enter them or tick "confirmed by accountant" first`);
  }
  if (n > view.firstYear && !filedSnapshot(companyId, n - 1)) throw badRequest(`Mark ${n - 1} filed first`);
  const id = uuid();
  getDb().prepare(`INSERT INTO tax_year_snapshots (id, company_id, tax_year, status, snapshot_json, fx_source_summary, filed_by_user_id, filed_at)
    VALUES (?, ?, ?, 'filed', ?, ?, ?, ?)`).run(id, companyId, n, JSON.stringify(view), view.notes.join(' '), getCallerUserId(), Date.now());
  audit('tax_year', `${companyId}:${n}`, 'file', { after: { year: n, taxDepreciationKhr: view.totals.taxDepreciationKhr } });
  return getTaxYear(companyId, n);
}

function unfileTaxYear(companyId, y, reason) {
  const n = int(y);
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to un-file a year');
  const f = filedSnapshot(companyId, n);
  if (!f) throw badRequest(`${n} is not marked filed`);
  if (filedSnapshot(companyId, n + 1)) throw badRequest(`${n + 1} is filed after it — un-file that year first`);
  getDb().prepare("UPDATE tax_year_snapshots SET status = 'unfiled', unfiled_at = ?, unfiled_by_user_id = ?, unfile_reason = ? WHERE id = ?").run(Date.now(), getCallerUserId(), why, f.id);
  audit('tax_year', `${companyId}:${n}`, 'unfile', { after: { year: n, reason: why } });
  return getTaxYear(companyId, n);
}

module.exports = { ESTIMATE_LABEL, getTaxYear, computeYear, setPoolOpening, markTaxYearFiled, unfileTaxYear, taxAssets };
