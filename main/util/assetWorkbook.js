/**
 * Fixed Assets A2: the asset workbook (docs/ASSETS_AND_BRANCHES_PLAN.md §8.1) —
 * Register, Movements, Book schedule, Tax pools, Book vs tax, Additions &
 * disposals, Notes. Same SheetJS path as the fuel workbook; returns the .xlsx
 * bytes so one builder serves the Mac (Save dialog), a client Mac (bytes over
 * RPC) and anything else. Money is written in dollars (2 dp) and whole riel.
 */

const XLSX = require('xlsx');

const usd = (m) => (m == null ? '' : Math.round(m) / 100);

function buildAssetWorkbook({ companyName = '', year, asOf, register, movements, depreciation, additions, tax }) {
  const wb = XLSX.utils.book_new();
  const add = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);

  add([
    ['Tag', 'Name', 'Category', 'Branch', 'Custodian', 'Status', 'Treatment', 'Purchase date', 'In service', 'Cost (USD)', 'Acc. depreciation (USD)', 'Impairment (USD)', 'NBV (USD)', 'Not yet posted (USD)'],
    ...register.rows.map((r) => [r.tagCode, r.name, r.categoryName, r.branchName, r.custodianName || '', r.status, r.trackedOnly ? 'Tracked, not capitalised' : r.treatment,
      r.purchaseDate || '', r.inServiceDate || '', usd(r.costMinor), r.trackedOnly ? '' : usd(r.accumMinor), r.trackedOnly ? '' : usd(r.impairmentMinor),
      r.trackedOnly ? '' : usd(r.nbvMinor), r.trackedOnly ? '' : usd(r.unpostedDepreciationMinor)]),
    [],
    ['Total (capitalised)', '', '', '', '', '', '', '', '', usd(register.totals.costMinor), usd(register.totals.accumMinor), usd(register.totals.impairmentMinor), usd(register.totals.nbvMinor), usd(register.totals.unpostedDepreciationMinor)],
  ], 'Register');

  add([
    ['Category', 'Cost opening', 'Additions', 'Disposals', 'Revaluation', 'Cost closing', 'Acc. dep. opening', 'Charge', 'On disposals', 'On revaluation', 'Acc. dep. closing', 'NBV opening', 'NBV closing'],
    ...movements.rows.map((r) => [r.categoryName, usd(r.cost.opening), usd(r.cost.additions), usd(r.cost.disposals), usd(r.cost.revaluation), usd(r.cost.closing),
      usd(r.accum.opening), usd(r.accum.charge), usd(r.accum.disposals), usd(r.accum.revaluation), usd(r.accum.closing), usd(r.nbvOpeningMinor), usd(r.nbvClosingMinor)]),
    [],
    ['Total', usd(movements.totals.costOpening), usd(movements.totals.costAdditions), usd(movements.totals.costDisposals), usd(movements.totals.costRevaluation), usd(movements.totals.costClosing),
      usd(movements.totals.accumOpening), usd(movements.totals.accumCharge), usd(movements.totals.accumDisposals), usd(movements.totals.accumRevaluation), usd(movements.totals.accumClosing),
      usd(movements.totals.nbvOpening), usd(movements.totals.nbvClosing)],
  ], 'Movements');

  add([
    ['Month', 'Category', 'Branch', 'Month charge (USD)', 'Catch-up (USD)', 'Total (USD)'],
    ...depreciation.rows.map((r) => [r.period, r.categoryName, r.branchName || 'No branch', usd(r.monthMinor), usd(r.catchUpMinor), usd(r.totalMinor)]),
  ], 'Book schedule');

  const pools = tax ? Object.values(tax.pools) : [];
  add([
    ['Class', 'Opening WDV (KHR)', 'Opening from', 'Additions (KHR)', 'Proceeds (KHR)', 'Base (KHR)', 'Rate', 'Depreciation (KHR)', 'Gain (KHR)', 'Loss (KHR)', 'Closing WDV (KHR)'],
    ...pools.map((p) => [p.label, p.openingWdvKhr, p.openingLabel || '', p.additionsKhr, p.proceedsKhr, p.baseKhr, `${p.rateBp / 100} %`, p.depreciationKhr, p.gainKhr, p.lossKhr, p.closingWdvKhr]),
    [],
    ['Per asset (Class 1 / intangible / land)', 'Tag', 'Name', 'Cost (KHR)', 'Depreciation (KHR)', 'WDV (KHR)', 'Proceeds (KHR)', 'Gain / loss (KHR)'],
    ...(tax ? tax.perAsset : []).map((r) => [r.taxClass, r.tagCode, r.name, r.costKhr, r.depreciationKhr, r.wdvKhr, r.proceedsKhr ?? '', r.gainLossKhr ?? '']),
  ], 'Tax pools');

  add([
    ['Class', 'Book depreciation (USD)', 'Book depreciation (KHR)', 'Tax depreciation (KHR)', 'Difference (KHR)'],
    ...(tax ? tax.bookVsTax : []).map((r) => [r.label, usd(r.bookUsdMinor), r.bookKhr, r.taxKhr, r.differenceKhr]),
  ], 'Book vs tax');

  add([
    ['Date', 'In / out', 'Kind', 'Tag', 'Name', 'Category', 'Cost (USD)', 'Proceeds (USD)', 'NBV (USD)', 'Gain / loss (USD)', 'Qty'],
    ...additions.rows.map((r) => [r.date, r.direction, r.kind, r.tagCode, r.name, r.categoryName, usd(r.amountUsdMinor), usd(r.proceedsUsdMinor), usd(r.nbvMinor), usd(r.gainMinor), r.qty ?? '']),
  ], 'Additions & disposals');

  add([
    [`${companyName} — fixed assets ${year}, as at ${asOf}`],
    ['Book figures are from the posted ledger, in US dollars; riel at each entry\'s own rate.'],
    ['"Not yet posted" is depreciation the schedule says is due that the monthly run has not posted yet.'],
    ['The tax sheets are a worksheet for the accountant, never posted. Every rate and rule: confirm with an accountant.'],
    ...(tax ? tax.notes.map((n) => [n]) : [['No tax year computed.']]),
  ], 'Notes');

  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safe = String(companyName || 'company').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'company';
  return { filename: `fixed-assets-${safe}-${year}.xlsx`, bytes };
}

module.exports = { buildAssetWorkbook };
