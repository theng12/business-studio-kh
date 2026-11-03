/**
 * Fuel F1: gather one company's rows for a month and build the §4.5 reports
 * (the arithmetic is in main/util/fuelReports.js, unit-tested on its own), plus
 * the Excel workbook built from the same report.
 */

const { getDb } = require('./index');
const fuel = require('./fuel');
const employees = require('./employees');
const records = require('./fuelRecords');
const flagsDb = require('./fuelFlags');
const { buildMonthlyReport } = require('../util/fuelReports');
const { buildFuelWorkbook } = require('../util/fuelWorkbook');
const { monthRange, cashFigures, comparableAmount } = require('../util/fuelAnomalies');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Riel value of a fill: what was paid (cash; USD converted at the server's
 * exchange rate), or litres × the tank's latest KHR delivery price at that
 * time, or × the published KHR price.
 */
function valuer(companyId) {
  const priceFor = fuel.priceLookup(companyId);
  const fx = fuel.fxKhrPerUsd(companyId);
  const deliveryPrice = getDb().prepare(`
    SELECT price_minor_per_l FROM fuel_deliveries
     WHERE location_id = ? AND voided_at IS NULL AND currency = 'KHR' AND price_minor_per_l IS NOT NULL AND delivered_at <= ?
     ORDER BY delivered_at DESC LIMIT 1
  `);
  return (f) => {
    if (f.kind === 'cash_station') {
      if (!isNum(f.amountPaidMinor)) return null;
      const khr = comparableAmount(f, 'KHR', fx);
      return isNum(khr) ? khr : null;
    }
    const dp = f.locationId ? deliveryPrice.get(f.locationId, f.at)?.price_minor_per_l : null;
    if (isNum(dp)) return f.litres * dp;
    const pub = priceFor(f.fuelType, f.at);
    return pub && pub.currency === 'KHR' ? f.litres * pub.priceMinorPerL : null;
  };
}

/**
 * Riel paid above the posted price on a cash fill (rule C1's numbers):
 *   (amount paid − litres shown on the pump × posted price), only when the
 *   implied price is over the C1 threshold (a USD payment gets the street-rate
 *   allowance). 0 when it cannot be worked out (no litres shown, no price).
 */
function overpayment(companyId, settings) {
  const priceFor = fuel.priceLookup(companyId);
  const fx = fuel.fxKhrPerUsd(companyId);
  return (f) => {
    if (f.kind !== 'cash_station' || !isNum(f.litresShownOnPump)) return 0;
    const price = priceFor(f.fuelType, f.at);
    const cash = cashFigures(f, price, fx);
    if (!cash.comparable || !isNum(cash.priceRatio)) return 0;
    const allow = cash.currency !== (f.currency || 'KHR') ? 1 + settings.usdStreetRatePct / 100 : 1;
    if (cash.priceRatio <= settings.c1PriceRatio * allow) return 0;
    const over = cash.amount - f.litresShownOnPump * cash.publishedMinorPerL;
    const riel = cash.currency === 'USD' ? (over / 100) * fx : over;
    return riel > 0 ? Math.round(riel) : 0;
  };
}

function gather(companyId, month) {
  if (!companyId) throw new Error('Company is required');
  const { start, end } = monthRange(month);
  const db = getDb();
  const settings = fuel.getSettings(companyId);
  const assets = fuel.listAssets(companyId, { status: 'all' });
  const locations = fuel.listLocations(companyId, { status: 'all' });
  const assetResults = new Map();
  for (const a of assets) {
    const out = flagsDb.computeAsset(a, settings);
    assetResults.set(a.id, { segments: out.segments, intervals: out.intervals });
  }
  const tankResults = new Map();
  for (const loc of locations) {
    const out = flagsDb.computeLocation(loc, settings, Math.min(Date.now(), end));
    tankResults.set(loc.id, { intervals: out.intervals, checks: out.checks });
  }
  const value = valuer(companyId);
  const overpaid = overpayment(companyId, settings);
  const fills = db.prepare(`SELECT * FROM fuel_fills WHERE company_id = ? AND voided_at IS NULL AND superseded_at IS NULL AND at >= ? AND at < ? ORDER BY at`)
    .all(companyId, start, end).map(records.rowToFill).map((f) => ({ ...f, valueRiel: value(f), overpaidRiel: overpaid(f) }));
  const deliveries = records.listDeliveries(companyId, { from: start, to: end, limit: 500 }).items;
  const transfers = db.prepare(`SELECT * FROM fuel_transfers WHERE company_id = ? AND voided_at IS NULL AND ((sent_at >= ? AND sent_at < ?) OR (received_at >= ? AND received_at < ?))`)
    .all(companyId, start, end, start, end).map((r) => records.getTransfer(r.id));
  const dips = db.prepare(`SELECT id FROM fuel_dips WHERE company_id = ? AND voided_at IS NULL AND taken_at < ?`).all(companyId, end).map((r) => records.getDip(r.id));
  // Every flag of the month, whatever its status — a missed-dip gap that a
  // later dip closed, or a reviewed flag, is still part of the month's record.
  const flags = db.prepare(`SELECT * FROM fuel_flags WHERE company_id = ? AND period = ? ORDER BY at`)
    .all(companyId, month).map(flagsDb.rowToFlag);
  const staff = employees.list(companyId);
  const report = buildMonthlyReport({ month, assets, employees: staff, locations, fills, assetResults, tankResults, deliveries, transfers, dips, flags, settings });
  return { report, fills, flags, assets, staff, locations };
}

function monthlyReport(companyId, month) {
  return gather(companyId, month).report;
}

function monthlyWorkbook(companyId, month) {
  const g = gather(companyId, month);
  const company = getDb().prepare('SELECT name FROM companies WHERE id = ?').get(companyId);
  return buildFuelWorkbook(g.report, {
    fills: g.fills, flags: g.flags, assets: g.assets, employees: g.staff, locations: g.locations,
    stations: fuel.listStations(companyId, { includeArchived: true }), companyName: company?.name,
  });
}

module.exports = { monthlyReport, monthlyWorkbook, valuer };
