/**
 * Fuel F1: the monthly fuel workbook (per asset, per driver, tanks, fills,
 * flags) — the same SheetJS (`xlsx`) path the product import/sample sheets use
 * (main/fileHandler.js, AGENTS.md §11). Returns the .xlsx bytes so the one
 * builder serves the Mac (saved through a dialog), a client Mac (bytes come
 * back over RPC) and the phone alike.
 */

const XLSX = require('xlsx');
const { phnomPenhDate } = require('./fuelAnomalies');
const { employeeName } = require('./fuelReports');

function money(map) {
  return Object.entries(map || {}).map(([c, v]) => (c === 'USD' ? `$${(v / 100).toFixed(2)}` : `${v} ${c}`)).join(' + ');
}

/**
 * @param {object} report   buildMonthlyReport() result
 * @param {object} extra    { fills, flags, assets, employees, locations, stations, companyName }
 * @returns {{ filename: string, bytes: Buffer }}
 */
function buildFuelWorkbook(report, extra = {}) {
  const wb = XLSX.utils.book_new();
  const assetById = new Map((extra.assets || []).map((a) => [a.id, a]));
  const empById = new Map((extra.employees || []).map((e) => [e.id, e]));
  const locById = new Map((extra.locations || []).map((l) => [l.id, l]));
  const stationById = new Map((extra.stations || []).map((s) => [s.id, s]));

  const assetsSheet = [[
    'Asset', 'Plate / serial', 'Type', 'Meter', 'Distance / hours', 'Litres', 'Tank L', 'Farm L', 'Cash L',
    'Fills', 'Cash paid', 'Value (KHR)', 'Actual rate', 'Baseline', 'Rate unit', 'Cost per km/h (KHR)',
    'Expected L', 'Excess L', 'Excess KHR', 'Open flags', 'Red flags', 'Cash above posted price (KHR)', 'Suspected loss (KHR)',
  ]];
  for (const a of report.assets) {
    assetsSheet.push([
      a.name, a.plateOrSerial ?? '', a.typeName ?? '', a.meterUnit, a.distance ?? '', a.litres,
      a.litresByKind.warehouse_tank, a.litresByKind.farm_store, a.litresByKind.cash_station,
      a.fills, money(a.cashPaid), a.valueRiel, a.actualRate ?? '', a.baseline ?? '', a.rateUnit,
      a.costPerUnitRiel ?? '', a.expectedLitres ?? '', a.excessLitres ?? '', a.excessRiel ?? '', a.openFlags, a.redFlags,
      a.cashOverpaidRiel ?? 0, a.suspectedLossRiel ?? 0,
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(assetsSheet), 'Per asset');

  const driversSheet = [['Driver', 'Staff code', 'Litres', 'Km', 'Hours', 'Fills', 'Cash paid', 'Excess L', 'Excess KHR', 'Open flags', 'Assets used',
    'Cash above posted price (KHR)', 'Suspected loss (KHR)']];
  for (const d of report.drivers) {
    driversSheet.push([
      d.name, d.staffCode ?? '', d.litres, d.distanceKm, d.hours, d.fills, money(d.cashPaid),
      d.excessLitres ?? '', d.excessRiel ?? '', d.openFlags, d.assets.map((x) => x.name).join(', '),
      d.cashOverpaidRiel ?? 0, d.suspectedLossRiel ?? 0,
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(driversSheet), 'Per driver');

  const tanksSheet = [['Tank', 'From dip', 'To dip', 'Start L', 'Delivered L', 'Received L', 'Filled L', 'Sent L', 'Expected L', 'Measured L', 'Variance L', 'Tolerance L']];
  for (const t of report.tanks) {
    for (const iv of t.intervals) {
      tanksSheet.push([
        t.name, phnomPenhDate(iv.fromAt), phnomPenhDate(iv.toAt), iv.startLitres, iv.delivered, iv.received,
        iv.filled, iv.sent, iv.expected, iv.measured, iv.variance, iv.tolerance,
      ]);
    }
    for (const dl of t.deliveries) {
      tanksSheet.push([t.name, `Delivery ${phnomPenhDate(dl.deliveredAt)}`, dl.supplier ?? '', '', dl.invoiced, '', '', '', '', dl.measured ?? '', dl.shortfall == null ? '' : -dl.shortfall, '']);
    }
    for (const g of t.fillsByAttendant) {
      tanksSheet.push([t.name, 'Fills by attendant', g.name, '', '', '', g.litres, '', '', '', '', '']);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tanksSheet), 'Tanks');

  const fillsSheet = [['Date', 'Asset', 'Driver', 'Kind', 'Tank / station', 'Litres', 'Litres from', 'Meter reading', 'Full tank',
    'Amount paid', 'Currency', 'Litres on pump', 'Review', 'Source']];
  for (const f of extra.fills || []) {
    fillsSheet.push([
      phnomPenhDate(f.at), assetById.get(f.assetId)?.name ?? '', employeeName(empById.get(f.driverEmployeeId)), f.kind,
      locById.get(f.locationId)?.name ?? stationById.get(f.stationId)?.name ?? '', f.litres, f.litresSource ?? '',
      f.meterReading ?? '', f.fullTank ? 'yes' : 'no', f.amountPaidMinor ?? '', f.currency ?? '', f.litresShownOnPump ?? '',
      f.reviewStatus, f.source,
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fillsSheet), 'Fills');

  const flagsSheet = [['Rule', 'Severity', 'Status', 'Date', 'Explanation', 'Measured', 'Expected', 'Threshold', 'Unit', 'Review note']];
  for (const fl of extra.flags || []) {
    flagsSheet.push([fl.ruleKey, fl.severity, `${fl.status}${fl.resolved ? ' (no longer firing)' : ''}`, phnomPenhDate(fl.at), fl.explanation, fl.measured ?? '', fl.expected ?? '', fl.threshold ?? '', fl.unit ?? '', fl.reviewNote ?? '']);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(flagsSheet), 'Flags');

  const notes = [
    ['About this workbook', ''],
    ['Month', report.month],
    ['Excess litres', 'Over full-to-full intervals closed this month: litres − distance × baseline ÷ 100 (L/100 km), or − hours × baseline (L/h). Positive = more fuel than the vehicle should have used.'],
    ['Excess KHR', 'Excess litres × the asset’s average riel per litre this month.'],
    ['Cash above posted price', 'Cash paid − litres shown on the pump × the posted price, on fills over the C1 threshold.'],
    ['Suspected loss', 'Riel of the fuel used beyond normal variation (above expected × the amber allowance, +20 % by default) + cash above posted price. Drivers and assets are ranked by it.'],
    ['Distance', 'Between consecutive meter readings, counted in the month (and for the driver) of the later fill.'],
    ['Tank variance', 'Dip − (previous dip + deliveries + received − fills − sent). Negative = missing.'],
    ['One flag is not proof', 'The monthly pattern is the evidence. Every flag shows its formula and numbers.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'Notes');

  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const slug = String(extra.companyName || 'company').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'company';
  return { filename: `fuel-${slug}-${report.month}.xlsx`, bytes };
}

module.exports = { buildFuelWorkbook };
