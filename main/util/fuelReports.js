/**
 * Fuel F1: monthly reports (docs/PEOPLE_AND_FUEL_PLAN.md §4.5) — data, not UI.
 *
 *   Per asset:  distance/hours, litres (tank / farm / cash), money, actual vs
 *               baseline rate, cost per km or hour, fills, open flags, and
 *               excess_L = litres − distance × baseline ÷ 100  (L/h: × baseline)
 *               in litres and riel.
 *   Per driver: the same summed over every asset they used, ranked by excess riel.
 *   Per tank:   each dip-to-dip variance, deliveries vs dips, fills by attendant.
 *
 * Attribution rules (so a reader can check the sums):
 *   - A fill's litres belong to the month of the fill and to its driver.
 *   - The distance between two consecutive meter readings belongs to the month
 *     and the driver of the LATER fill — the person filling up is the one
 *     reporting how far the vehicle went since the last fill.
 *   - Riel per litre for an asset is its own month's average (riel valued ÷
 *     litres valued); `valueRiel` on each fill is computed by the caller from
 *     the cash paid (cash fills) or the tank's latest delivery price / the
 *     published price (tank and farm fills).
 *
 * Pure: the database layer (main/db/fuelReports.js) gathers rows and the
 * per-asset / per-tank rule results and passes them in.
 */

const { monthRange, baselineLitres, consumptionRate, rateUnit } = require('./fuelAnomalies');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function r2(n) { return isNum(n) ? Math.round(n * 100) / 100 : null; }
function sum(arr, fn) { return arr.reduce((t, x) => t + (Number(fn(x)) || 0), 0); }

function employeeName(e) {
  if (!e) return 'No driver recorded';
  return e.nameKm && e.nameEn ? `${e.nameEn} (${e.nameKm})` : (e.nameEn || e.nameKm || e.staffCode || 'Unnamed');
}

/**
 * @param {object} p
 * @param {string} p.month 'YYYY-MM'
 * @param {object[]} p.assets      { id, name, plateOrSerial, typeName, meterUnit, baselineRate }
 * @param {object[]} p.employees   { id, staffCode, nameEn, nameKm }
 * @param {object[]} p.locations   { id, name, kind }
 * @param {object[]} p.fills       active fills (any month; filtered here) with `valueRiel`
 * @param {Map}      p.assetResults assetId → { segments, intervals }
 * @param {Map}      p.tankResults  locationId → { intervals, checks }
 * @param {object[]} p.deliveries  active deliveries
 * @param {object[]} p.transfers   active transfers
 * @param {object[]} p.dips        active dips
 * @param {object[]} p.flags       unresolved flags (any status)
 */
function buildMonthlyReport({
  month, assets = [], employees = [], locations = [], fills = [],
  assetResults = new Map(), tankResults = new Map(), deliveries = [], transfers = [], dips = [], flags = [],
}) {
  const { start, end } = monthRange(month);
  const inMonth = (at) => isNum(at) && at >= start && at < end;
  const empById = new Map(employees.map((e) => [e.id, e]));
  const monthFills = fills.filter((f) => inMonth(f.at));
  const monthFlags = flags.filter((f) => f.period === month);

  /* ── per asset ── */
  const assetRows = [];
  const perAssetDriver = new Map(); // assetId → Map(driverKey → { litres, distance, fills, cash })
  for (const a of assets) {
    const af = monthFills.filter((f) => f.assetId === a.id);
    const res = assetResults.get(a.id) || { segments: [], intervals: [] };
    const segs = (res.segments || []).filter((sg) => inMonth(sg.toAt) && isNum(sg.distance));
    const ivs = (res.intervals || []).filter((iv) => inMonth(iv.toAt) && isNum(iv.distance) && iv.distance > 0);
    const openA = monthFlags.filter((fl) => fl.assetId === a.id && fl.status === 'open');
    if (!af.length && !segs.length && !openA.length) continue;

    const hasMeter = a.meterUnit === 'km' || a.meterUnit === 'hours';
    const litres = sum(af, (f) => f.litres);
    const distance = hasMeter ? sum(segs, (sg) => sg.distance) : null;
    const lastIv = ivs.length ? ivs[ivs.length - 1] : null;
    const baseline = isNum(lastIv?.baseline) ? lastIv.baseline : (isNum(a.baselineRate) && a.baselineRate > 0 ? a.baselineRate : null);
    const baselineSource = isNum(lastIv?.baseline) ? lastIv.baselineSource : (baseline != null ? 'manual' : null);
    const ivLitres = sum(ivs, (iv) => iv.litres);
    const ivDistance = sum(ivs, (iv) => iv.distance);
    const valued = af.filter((f) => isNum(f.valueRiel));
    const valueRiel = sum(valued, (f) => f.valueRiel);
    const litresValued = sum(valued, (f) => f.litres);
    const rielPerL = litresValued > 0 ? valueRiel / litresValued : null;
    const expectedL = hasMeter && distance > 0 ? baselineLitres(distance, baseline, a.meterUnit) : null;
    const excessLitres = isNum(expectedL) ? litres - expectedL : null;
    const cashPaid = {};
    for (const f of af) {
      if (f.kind === 'cash_station' && isNum(f.amountPaidMinor)) {
        cashPaid[f.currency || 'KHR'] = (cashPaid[f.currency || 'KHR'] || 0) + f.amountPaidMinor;
      }
    }
    assetRows.push({
      assetId: a.id,
      name: a.name,
      plateOrSerial: a.plateOrSerial ?? null,
      typeName: a.typeName ?? null,
      meterUnit: a.meterUnit,
      rateUnit: rateUnit(a.meterUnit),
      distance: r2(distance),
      litres: r2(litres),
      litresByKind: {
        warehouse_tank: r2(sum(af.filter((f) => f.kind === 'warehouse_tank'), (f) => f.litres)),
        farm_store: r2(sum(af.filter((f) => f.kind === 'farm_store'), (f) => f.litres)),
        cash_station: r2(sum(af.filter((f) => f.kind === 'cash_station'), (f) => f.litres)),
      },
      fills: af.length,
      cashPaid,
      valueRiel: Math.round(valueRiel),
      actualRate: r2(consumptionRate(ivLitres, ivDistance, a.meterUnit)),
      baseline: r2(baseline),
      baselineSource,
      costPerUnitRiel: hasMeter && distance > 0 && valueRiel > 0 ? r2(valueRiel / distance) : null,
      expectedLitres: r2(expectedL),
      excessLitres: r2(excessLitres),
      excessRiel: isNum(excessLitres) && isNum(rielPerL) ? Math.round(excessLitres * rielPerL) : null,
      openFlags: openA.length,
      redFlags: openA.filter((fl) => fl.severity === 'red').length,
      rielPerLitre: r2(rielPerL),
    });

    // Driver split for this asset.
    const byDriver = new Map();
    const bucket = (k) => {
      if (!byDriver.has(k)) byDriver.set(k, { litres: 0, distance: 0, fills: 0, cash: {} });
      return byDriver.get(k);
    };
    for (const f of af) {
      const b = bucket(f.driverEmployeeId || '');
      b.litres += Number(f.litres) || 0;
      b.fills += 1;
      if (f.kind === 'cash_station' && isNum(f.amountPaidMinor)) b.cash[f.currency || 'KHR'] = (b.cash[f.currency || 'KHR'] || 0) + f.amountPaidMinor;
    }
    if (hasMeter) for (const sg of segs) bucket(sg.toDriverEmployeeId || '').distance += sg.distance;
    perAssetDriver.set(a.id, { byDriver, baseline, rielPerL, meterUnit: a.meterUnit, name: a.name });
  }

  /* ── per driver ── */
  const drivers = new Map();
  for (const [assetId, info] of perAssetDriver) {
    for (const [key, b] of info.byDriver) {
      if (!drivers.has(key)) {
        drivers.set(key, { employeeId: key || null, name: employeeName(empById.get(key)), staffCode: empById.get(key)?.staffCode ?? null,
          litres: 0, distanceKm: 0, hours: 0, fills: 0, cashPaid: {}, excessLitres: 0, excessRiel: 0, excessKnown: false, assets: [] });
      }
      const d = drivers.get(key);
      d.litres += b.litres;
      d.fills += b.fills;
      if (info.meterUnit === 'km') d.distanceKm += b.distance;
      if (info.meterUnit === 'hours') d.hours += b.distance;
      for (const [c, v] of Object.entries(b.cash)) d.cashPaid[c] = (d.cashPaid[c] || 0) + v;
      const expected = b.distance > 0 ? baselineLitres(b.distance, info.baseline, info.meterUnit) : null;
      let excessL = null;
      if (isNum(expected)) {
        excessL = b.litres - expected;
        d.excessLitres += excessL;
        d.excessKnown = true;
        if (isNum(info.rielPerL)) d.excessRiel += excessL * info.rielPerL;
      }
      d.assets.push({ assetId, name: info.name, litres: r2(b.litres), distance: r2(b.distance), excessLitres: r2(excessL) });
    }
  }
  const driverRows = [...drivers.values()].map((d) => ({
    ...d,
    litres: r2(d.litres),
    distanceKm: r2(d.distanceKm),
    hours: r2(d.hours),
    excessLitres: d.excessKnown ? r2(d.excessLitres) : null,
    excessRiel: d.excessKnown ? Math.round(d.excessRiel) : null,
    openFlags: monthFlags.filter((fl) => fl.status === 'open' && (fl.employeeId || '') === (d.employeeId || '') && d.employeeId).length,
  })).map(({ excessKnown: _k, ...rest }) => rest)
    .sort((x, y) => (y.excessRiel ?? -Infinity) - (x.excessRiel ?? -Infinity) || x.name.localeCompare(y.name));

  /* ── per tank ── */
  const tankRows = [];
  for (const loc of locations) {
    const res = tankResults.get(loc.id) || { intervals: [], checks: [] };
    const ivs = (res.intervals || []).filter((iv) => inMonth(iv.toAt));
    const locFills = monthFills.filter((f) => f.locationId === loc.id);
    const locDeliveries = deliveries.filter((d) => d.locationId === loc.id && inMonth(d.deliveredAt));
    const sent = transfers.filter((t) => t.fromLocationId === loc.id && inMonth(t.sentAt));
    const recv = transfers.filter((t) => t.toLocationId === loc.id && isNum(t.litresReceived) && inMonth(t.receivedAt));
    if (!ivs.length && !locFills.length && !locDeliveries.length && !sent.length && !recv.length) continue;
    const byAttendant = new Map();
    for (const f of locFills) {
      const k = f.attendantEmployeeId || '';
      const g = byAttendant.get(k) || { employeeId: k || null, name: k ? employeeName(empById.get(k)) : 'No attendant recorded', litres: 0, fills: 0 };
      g.litres += Number(f.litres) || 0;
      g.fills += 1;
      byAttendant.set(k, g);
    }
    const checkById = new Map((res.checks || []).map((c) => [c.deliveryId, c]));
    const locDips = dips.filter((d) => d.locationId === loc.id).sort((a, b) => a.takenAt - b.takenAt);
    const lastDip = locDips.filter((d) => d.takenAt < end).pop() || null;
    tankRows.push({
      locationId: loc.id,
      name: loc.name,
      kind: loc.kind,
      delivered: r2(sum(locDeliveries, (d) => d.litresInvoiced)),
      filled: r2(sum(locFills, (f) => f.litres)),
      sent: r2(sum(sent, (t) => t.litresSent)),
      received: r2(sum(recv, (t) => t.litresReceived)),
      varianceTotal: r2(sum(ivs, (iv) => iv.variance)),
      intervals: ivs,
      deliveries: locDeliveries.map((d) => ({
        deliveryId: d.id, deliveredAt: d.deliveredAt, supplier: d.supplier ?? null, invoiced: d.litresInvoiced,
        measured: checkById.get(d.id)?.received ?? null, shortfall: checkById.get(d.id)?.shortfall ?? null,
      })),
      fillsByAttendant: [...byAttendant.values()].map((g) => ({ ...g, litres: r2(g.litres) })).sort((a, b) => b.litres - a.litres),
      lastDip: lastDip ? { dipId: lastDip.id, takenAt: lastDip.takenAt, dipCm: lastDip.dipCm, litres: lastDip.litres } : null,
      openFlags: monthFlags.filter((fl) => fl.locationId === loc.id && fl.status === 'open').length,
    });
  }

  /* ── flags summary ── */
  const flagCounts = {};
  for (const fl of monthFlags) {
    const k = fl.ruleKey;
    flagCounts[k] = flagCounts[k] || { ruleKey: k, open: 0, red: 0, amber: 0, info: 0, total: 0 };
    flagCounts[k].total += 1;
    if (fl.status === 'open') flagCounts[k].open += 1;
    if (flagCounts[k][fl.severity] != null) flagCounts[k][fl.severity] += 1;
  }

  const totalExcessRiel = assetRows.reduce((t, a) => t + (isNum(a.excessRiel) ? a.excessRiel : 0), 0);
  return {
    month,
    range: { start, end },
    totals: {
      fills: monthFills.length,
      litres: r2(sum(monthFills, (f) => f.litres)),
      valueRiel: Math.round(sum(monthFills, (f) => (isNum(f.valueRiel) ? f.valueRiel : 0))),
      excessRiel: Math.round(totalExcessRiel),
      openFlags: monthFlags.filter((f) => f.status === 'open').length,
    },
    assets: assetRows.sort((x, y) => (y.excessRiel ?? -Infinity) - (x.excessRiel ?? -Infinity) || x.name.localeCompare(y.name)),
    drivers: driverRows,
    tanks: tankRows,
    flags: Object.values(flagCounts).sort((a, b) => a.ruleKey.localeCompare(b.ruleKey)),
  };
}

module.exports = { buildMonthlyReport, employeeName };
