/**
 * Fixed Assets A2: reports (docs/ASSETS_AND_BRANCHES_PLAN.md §8.1 Reports).
 * Book figures come from the POSTED ledger (what the books say), so a report
 * and the GL always agree; "not yet posted" depreciation is shown separately.
 *
 *   register            as at a date: cost, accumulated depreciation, impairment, NBV per asset
 *   movements           for a period: opening / additions / disposals / revaluation / closing, per category
 *   depreciation        by month × category × branch
 *   book_vs_tax         per tax class for a year (main/db/assetTax.js)
 *   tax_pools           the pools for a year
 *   additions_disposals what came in and went out, with gain / loss
 *   by_branch           counts and NBV per branch × category, as at a date
 *   attention           fully depreciated but in use; warranty, insurance and road tax due
 * Every report takes `branchId` / `categoryId` filters where they apply.
 */

const { getDb } = require('./index');
const { badRequest, todayPhnomPenh, dateOrNull } = require('./_assetUtil');
const config = require('./assetConfig');
const fixedAssets = require('./fixedAssets');
const assetTax = require('./assetTax');
const { branchAt, lastDayOf } = require('./assetDepreciation');
const book = require('../util/bookDepreciation');

const KINDS = ['register', 'movements', 'depreciation', 'book_vs_tax', 'tax_pools', 'additions_disposals', 'by_branch', 'attention'];

function names(companyId) {
  const db = getDb();
  return {
    category: new Map(db.prepare('SELECT id, name_en FROM asset_categories WHERE company_id = ?').all(companyId).map((r) => [r.id, r.name_en])),
    branch: new Map(db.prepare('SELECT id, code, name_en FROM branches WHERE company_id = ?').all(companyId).map((r) => [r.id, `${r.code} ${r.name_en}`])),
  };
}

/** Ledger balances per asset as at a date: Map(assetId → { cost, accum, impairment }). */
function balancesAt(companyId, asOf) {
  const rows = getDb().prepare(`
    SELECT l.asset_id AS id, l.line_role AS role, SUM(l.debit_minor) AS d, SUM(l.credit_minor) AS c
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.company_id = ? AND e.entry_date <= ? AND l.asset_id IS NOT NULL
       AND l.line_role IN ('cost', 'accum_dep', 'accum_disposal', 'accum_reval', 'impairment')
     GROUP BY l.asset_id, l.line_role
  `).all(companyId, asOf);
  const out = new Map();
  for (const r of rows) {
    const b = out.get(r.id) || { cost: 0, accum: 0, impairment: 0 };
    if (r.role === 'cost') b.cost += r.d - r.c;
    else if (r.role === 'impairment') b.impairment += r.c - r.d;
    else b.accum += r.c - r.d;
    out.set(r.id, b);
  }
  return out;
}

function inScope(a, { branchId, categoryId }, branch) {
  if (categoryId && a.categoryId !== categoryId) return false;
  if (branchId === 'none' && branch) return false;
  if (branchId && branchId !== 'none' && branch !== branchId) return false;
  return true;
}

function allAssets(companyId) {
  return getDb().prepare("SELECT id FROM fixed_assets WHERE company_id = ? AND record_state = 'active' ORDER BY tag_seq, tag_code").all(companyId).map((r) => fixedAssets.get(r.id));
}

/** Acquired on or before `asOf`, and not gone (disposed / lost) by then. */
function heldAt(a, asOf, settings) {
  const acquired = a.acquisitionKind === 'opening' ? settings.registerStartDate : a.purchaseDate;
  if (acquired && acquired > asOf && !(a.acquisitionKind === 'opening' && asOf >= book.dayBefore(settings.registerStartDate))) return false;
  if (a.disposedOn && a.disposedOn <= asOf) return false;
  return true;
}

function register(companyId, { asOf = null, branchId = null, categoryId = null } = {}) {
  const date = dateOrNull(asOf, 'As at') || todayPhnomPenh();
  const settings = config.getSettings(companyId);
  const bal = balancesAt(companyId, date);
  const n = names(companyId);
  const rows = [];
  for (const a of allAssets(companyId)) {
    const tracked = a.accountingTreatment === 'tracked_only';
    const b = bal.get(a.id) || { cost: 0, accum: 0, impairment: 0 };
    // Review 2 (MEDIUM 3): an asset on the books is held exactly while the
    // ledger carries it (its acquisition and disposal ENTRY dates), so the
    // register always equals the GL; tracked-only items follow their dates.
    if (tracked ? !heldAt(a, date, settings) : (b.cost === 0 && b.accum === 0 && b.impairment === 0)) continue;
    const branch = branchAt(a, date);
    if (!inScope(a, { branchId, categoryId }, branch)) continue;
    let unposted = 0;
    const spec = fixedAssets.scheduleSpec(a);
    if (spec) {
      const p = date.slice(0, 7) >= spec.startPeriod ? book.chargedThrough(spec, date === lastDayOf(date.slice(0, 7)) ? date.slice(0, 7) : book.addMonths(date.slice(0, 7), -1)) : 0;
      unposted = p - fixedAssets.postedDepreciation(a.id, { throughPeriod: date.slice(0, 7) });
    }
    rows.push({
      assetId: a.id, tagCode: a.tagCode, name: a.name, categoryId: a.categoryId, categoryName: n.category.get(a.categoryId) || '',
      branchId: branch || null, branchName: branch ? n.branch.get(branch) || '' : '', custodianName: a.custodianName, status: a.status,
      treatment: a.accountingTreatment, inServiceDate: a.inServiceDate, purchaseDate: a.purchaseDate,
      costMinor: tracked ? (a.costUsdMinor || 0) : b.cost, accumMinor: tracked ? 0 : b.accum, impairmentMinor: tracked ? 0 : b.impairment,
      nbvMinor: tracked ? null : b.cost - b.accum - b.impairment, unpostedDepreciationMinor: unposted, trackedOnly: tracked,
    });
  }
  const books = rows.filter((r) => !r.trackedOnly);
  return {
    kind: 'register', asOf: date, rows,
    totals: {
      assets: rows.length, trackedOnly: rows.length - books.length,
      costMinor: books.reduce((t, r) => t + r.costMinor, 0), accumMinor: books.reduce((t, r) => t + r.accumMinor, 0),
      impairmentMinor: books.reduce((t, r) => t + r.impairmentMinor, 0), nbvMinor: books.reduce((t, r) => t + r.nbvMinor, 0),
      unpostedDepreciationMinor: books.reduce((t, r) => t + r.unpostedDepreciationMinor, 0),
    },
  };
}

const SOURCE_BUCKET = {
  asset_open: 'opening', asset_acquire: 'additions', asset_capex: 'additions', asset_dispose: 'disposals', asset_lost: 'disposals',
  asset_found: 'disposals', asset_revalue: 'revaluation', asset_impair: 'impairment', asset_depreciation: 'charge',
};

/** Roll-forward per category for [from, to]. */
function movements(companyId, { from, to, branchId = null, categoryId = null } = {}) {
  const f = dateOrNull(from, 'From');
  const t = dateOrNull(to, 'To') || todayPhnomPenh();
  if (!f) throw badRequest('Give the start date (from)');
  const n = names(companyId);
  const lines = getDb().prepare(`
    SELECT l.asset_id, l.line_role, l.debit_minor, l.credit_minor, e.entry_date, e.source_kind, COALESCE(o.source_kind, '') AS orig_kind, a.category_id, l.branch_id
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      JOIN fixed_assets a ON a.id = l.asset_id
      LEFT JOIN journal_entries o ON o.id = e.reverses_entry_id
     WHERE e.company_id = ? AND e.entry_date <= ? AND l.line_role IN ('cost', 'accum_dep', 'accum_disposal', 'accum_reval', 'impairment')
  `).all(companyId, t);
  const cats = new Map();
  const blank = () => ({ cost: { opening: 0, additions: 0, disposals: 0, revaluation: 0, closing: 0 }, accum: { opening: 0, charge: 0, disposals: 0, revaluation: 0, closing: 0 }, impairment: { opening: 0, charge: 0, disposals: 0, revaluation: 0, closing: 0 } });
  for (const l of lines) {
    if (categoryId && l.category_id !== categoryId) continue;
    if (branchId && (branchId === 'none' ? l.branch_id : l.branch_id !== branchId)) continue;
    const c = cats.get(l.category_id) || blank();
    cats.set(l.category_id, c);
    const kind = l.source_kind === 'reversal' ? l.orig_kind : l.source_kind;
    const bucket = SOURCE_BUCKET[kind] || 'additions';
    const before = l.entry_date < f;
    if (l.line_role === 'cost') {
      const v = l.debit_minor - l.credit_minor;
      if (before) c.cost.opening += v; else c.cost[bucket === 'opening' ? 'additions' : (bucket in c.cost ? bucket : 'additions')] += v;
      c.cost.closing += v;
    } else if (l.line_role === 'impairment') {
      const v = l.credit_minor - l.debit_minor;
      // Impairment eliminated by a revaluation is a revaluation movement, not a disposal (review 2).
      if (before) c.impairment.opening += v; else c.impairment[bucket === 'impairment' ? 'charge' : bucket === 'revaluation' ? 'revaluation' : 'disposals'] += v;
      c.impairment.closing += v;
    } else {
      const v = l.credit_minor - l.debit_minor;
      const key = l.line_role === 'accum_reval' ? 'revaluation' : l.line_role === 'accum_disposal' ? 'disposals' : 'charge';
      if (before) c.accum.opening += v; else c.accum[bucket === 'opening' ? 'opening' : key] += v;
      c.accum.closing += v;
    }
  }
  const rows = [...cats.entries()].map(([id, c]) => ({
    categoryId: id, categoryName: n.category.get(id) || '', ...c,
    nbvOpeningMinor: c.cost.opening - c.accum.opening - c.impairment.opening,
    nbvClosingMinor: c.cost.closing - c.accum.closing - c.impairment.closing,
  }));
  const sum = (path) => rows.reduce((tt, r) => tt + path(r), 0);
  return {
    kind: 'movements', from: f, to: t, rows,
    totals: {
      costOpening: sum((r) => r.cost.opening), costAdditions: sum((r) => r.cost.additions), costDisposals: sum((r) => r.cost.disposals),
      costRevaluation: sum((r) => r.cost.revaluation), costClosing: sum((r) => r.cost.closing),
      accumOpening: sum((r) => r.accum.opening), accumCharge: sum((r) => r.accum.charge), accumDisposals: sum((r) => r.accum.disposals),
      accumRevaluation: sum((r) => r.accum.revaluation), accumClosing: sum((r) => r.accum.closing),
      nbvOpening: sum((r) => r.nbvOpeningMinor), nbvClosing: sum((r) => r.nbvClosingMinor),
    },
  };
}

/** Depreciation charged by month × category × branch (posted). */
function depreciation(companyId, { from = null, to = null, branchId = null, categoryId = null } = {}) {
  const n = names(companyId);
  const rows = getDb().prepare(`
    SELECT e.period, a.category_id, l.branch_id, SUM(CASE WHEN l.line_role = 'dep_expense' THEN l.debit_minor - l.credit_minor ELSE 0 END) AS month_minor,
           SUM(CASE WHEN l.line_role = 'dep_catch_up' THEN l.debit_minor - l.credit_minor ELSE 0 END) AS catch_up_minor
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN fixed_assets a ON a.id = l.asset_id
     WHERE e.company_id = @c AND l.line_role IN ('dep_expense', 'dep_catch_up')
       AND (@from IS NULL OR e.entry_date >= @from) AND (@to IS NULL OR e.entry_date <= @to)
     GROUP BY e.period, a.category_id, l.branch_id ORDER BY e.period
  `).all({ c: companyId, from: dateOrNull(from, 'From'), to: dateOrNull(to, 'To') })
    .filter((r) => (!categoryId || r.category_id === categoryId) && (!branchId || (branchId === 'none' ? !r.branch_id : r.branch_id === branchId)))
    .map((r) => ({ period: r.period, categoryId: r.category_id, categoryName: n.category.get(r.category_id) || '', branchId: r.branch_id || null,
      branchName: r.branch_id ? n.branch.get(r.branch_id) || '' : '', monthMinor: r.month_minor, catchUpMinor: r.catch_up_minor, totalMinor: r.month_minor + r.catch_up_minor }));
  return { kind: 'depreciation', rows, totals: { totalMinor: rows.reduce((t, r) => t + r.totalMinor, 0), catchUpMinor: rows.reduce((t, r) => t + r.catchUpMinor, 0) } };
}

function additionsDisposals(companyId, { from = null, to = null, branchId = null, categoryId = null } = {}) {
  const n = names(companyId);
  const rows = getDb().prepare(`
    SELECT ev.*, a.tag_code, a.name, a.category_id, a.branch_id AS current_branch FROM asset_events ev JOIN fixed_assets a ON a.id = ev.asset_id
     WHERE ev.company_id = @c AND ev.voided_at IS NULL AND ev.reversed_by_event_id IS NULL
       AND ev.kind IN ('acquire', 'open', 'capex', 'dispose', 'partial_dispose', 'lost')
       AND (@from IS NULL OR ev.event_date >= @from) AND (@to IS NULL OR ev.event_date <= @to)
     ORDER BY ev.event_date, ev.created_at
  `).all({ c: companyId, from: dateOrNull(from, 'From'), to: dateOrNull(to, 'To') })
    .filter((r) => (!categoryId || r.category_id === categoryId) && (!branchId || r.current_branch === branchId))
    .map((r) => {
      const d = r.detail_json ? JSON.parse(r.detail_json) : {};
      const out = ['dispose', 'partial_dispose', 'lost'].includes(r.kind);
      return {
        eventId: r.id, date: r.event_date, kind: r.kind, assetId: r.asset_id, tagCode: r.tag_code, name: r.name, categoryName: n.category.get(r.category_id) || '',
        direction: out ? 'out' : 'in', amountUsdMinor: out ? null : r.amount_usd_minor, proceedsUsdMinor: out ? r.amount_usd_minor || 0 : null,
        nbvMinor: out ? (d.nbvMinor ?? d.nbvShareMinor ?? null) : null, gainMinor: out ? (d.gainMinor ?? null) : null, qty: r.qty ?? null, treatment: d.treatment ?? null,
      };
    });
  return {
    kind: 'additions_disposals', rows,
    totals: {
      additionsMinor: rows.filter((r) => r.direction === 'in').reduce((t, r) => t + (r.amountUsdMinor || 0), 0),
      proceedsMinor: rows.filter((r) => r.direction === 'out').reduce((t, r) => t + (r.proceedsUsdMinor || 0), 0),
      gainMinor: rows.filter((r) => r.direction === 'out').reduce((t, r) => t + (r.gainMinor || 0), 0),
    },
  };
}

function byBranch(companyId, { asOf = null, categoryId = null } = {}) {
  const reg = register(companyId, { asOf, categoryId });
  const map = new Map();
  for (const r of reg.rows) {
    const k = `${r.branchId || 'none'}|${r.categoryId}`;
    const m = map.get(k) || { branchId: r.branchId, branchName: r.branchName || 'No branch', categoryId: r.categoryId, categoryName: r.categoryName, assets: 0, trackedOnly: 0, costMinor: 0, nbvMinor: 0 };
    m.assets += 1;
    if (r.trackedOnly) m.trackedOnly += 1; else { m.costMinor += r.costMinor; m.nbvMinor += r.nbvMinor; }
    map.set(k, m);
  }
  return { kind: 'by_branch', asOf: reg.asOf, rows: [...map.values()], totals: reg.totals };
}

function attention(companyId) {
  const today = todayPhnomPenh();
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (const a of allAssets(companyId)) {
    if (a.status === 'disposed' || a.status === 'lost') continue;
    const spec = fixedAssets.scheduleSpec(a);
    if (spec) {
      const s = book.bookSchedule(spec);
      if (s.fullyDepreciatedAt && s.fullyDepreciatedAt <= today.slice(0, 7) && ['in_use', 'in_repair', 'in_storage'].includes(a.status)) {
        rows.push({ assetId: a.id, tagCode: a.tagCode, name: a.name, reason: 'fully_depreciated', date: s.fullyDepreciatedAt, nbvMinor: s.nbvMinor });
      }
    }
    for (const [field, reason] of [['warrantyUntil', 'warranty'], ['insuranceUntil', 'insurance'], ['roadTaxUntil', 'road_tax']]) {
      if (a[field] && a[field] <= soon) rows.push({ assetId: a.id, tagCode: a.tagCode, name: a.name, reason, date: a[field], overdue: a[field] < today });
    }
  }
  return { kind: 'attention', rows };
}

function getReport(companyId, args = {}) {
  const kind = args.kind;
  if (!KINDS.includes(kind)) throw badRequest(`Report must be one of: ${KINDS.join(', ')}`);
  if (kind === 'register') return register(companyId, args);
  if (kind === 'movements') return movements(companyId, args);
  if (kind === 'depreciation') return depreciation(companyId, args);
  if (kind === 'additions_disposals') return additionsDisposals(companyId, args);
  if (kind === 'by_branch') return byBranch(companyId, args);
  if (kind === 'attention') return attention(companyId);
  const y = Number(args.year) || Number(todayPhnomPenh().slice(0, 4));
  const t = assetTax.getTaxYear(companyId, y);
  if (kind === 'book_vs_tax') return { kind, year: y, rows: t.bookVsTax, totals: t.totals, notes: t.notes };
  return { kind: 'tax_pools', year: y, pools: t.pools, perAsset: t.perAsset, notes: t.notes, filed: t.filed, changedSinceFiling: t.changedSinceFiling };
}

/** The Excel workbook (§8.1): Register, Movements, Book schedule, Tax pools, Book vs tax, Additions & disposals, Notes. */
function getWorkbook(companyId, { year = null, asOf = null } = {}) {
  const y = Number(year) || Number(todayPhnomPenh().slice(0, 4));
  const date = dateOrNull(asOf, 'As at') || (y < Number(todayPhnomPenh().slice(0, 4)) ? `${y}-12-31` : todayPhnomPenh());
  const settings = config.getSettings(companyId);
  const firstYear = Number(settings.registerStartDate.slice(0, 4));
  const from = `${Math.max(y, firstYear)}-01-01`;
  const companyName = require('./companies').get(companyId)?.name || '';
  let tax;
  try { tax = assetTax.getTaxYear(companyId, Math.max(y, firstYear)); } catch (_) { tax = null; }
  const { buildAssetWorkbook } = require('../util/assetWorkbook');
  return buildAssetWorkbook({
    companyName, year: y, asOf: date,
    register: register(companyId, { asOf: date }),
    movements: movements(companyId, { from: from > date ? date : from, to: date }),
    depreciation: depreciation(companyId, { from, to: date }),
    additions: additionsDisposals(companyId, { from, to: date }),
    tax,
  });
}

module.exports = { KINDS, getReport, getWorkbook, register, movements, depreciation, additionsDisposals, byBranch, attention, balancesAt };
