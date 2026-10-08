/**
 * Fuel F1: monthly reports (docs/PEOPLE_AND_FUEL_PLAN.md §4.5) — data, not UI.
 *
 *   Per asset:  distance/hours, litres (tank / farm / cash), money, actual vs
 *               baseline rate, cost per km or hour, fills, open flags, and
 *               excess_L = Σ over full-to-full intervals CLOSED in the month of
 *                          (interval litres − interval distance × baseline ÷ 100)
 *                          (L/h: × baseline; L/day machines: days × baseline)
 *               in litres and riel; cash paid above the posted price (riel);
 *               suspected loss = riel of the litres ABOVE expected × the A1
 *               amber ratio (normal variation and a slightly-off baseline add
 *               nothing) + cash overpaid.
 *   Per driver: the same summed over every asset they used, ranked by
 *               suspected loss (riel).
 *   Per tank:   each dip-to-dip variance, deliveries vs dips, fills by attendant.
 *   Flags:      every flag of the month whatever its status (open, reviewed,
 *               resolved), with counts per status.
 *
 * Attribution rules (so a reader can check the sums):
 *   - A fill's litres, cash and overpayment belong to the month of the fill and
 *     to its driver.
 *   - The distance between two consecutive meter readings belongs to the month
 *     and the driver of the LATER fill (shown, not used for excess).
 *   - An interval's excess belongs to the month of its closing fill, shared by
 *     the drivers in proportion to the litres each put in during it. A
 *     vehicle's first fill, or an interval still open at month end, adds none.
 *   - Riel per litre for an asset is its own month's average (riel valued ÷
 *     litres valued); `valueRiel` and `overpaidRiel` on each fill are computed
 *     by the caller (main/db/fuelReports.js).
 *
 * Pure: the database layer (main/db/fuelReports.js) gathers rows and the
 * per-asset / per-tank rule results and passes them in.
 */

const { monthRange, baselineLitres, consumptionRate, rateUnit, mergeSettings } = require('./fuelAnomalies');

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
  assetResults = new Map(), tankResults = new Map(), deliveries = [], transfers = [], dips = [], flags = [], settings = null,
}) {
  const s = mergeSettings(settings);
  // "Suspected" excess counts only fuel beyond normal variation: per interval,
  // litres above expected × the A1 amber ratio (default +20 %). A vehicle that
  // simply runs a few % over its owner-set figure adds nothing; one that runs
  // far over adds the part above the allowance.
  const allowance = s.a1AmberRatio;
  const { start, end } = monthRange(month);
  const inMonth = (at) => isNum(at) && at >= start && at < end;
  const empById = new Map(employees.map((e) => [e.id, e]));
  const monthFills = fills.filter((f) => inMonth(f.at));
  const monthFlags = flags.filter((f) => f.period === month);

  /* ── per asset ── */
  // Excess is measured only over COMPLETE full-to-full intervals closed in the
  // month (assigned by the closing fill): litres between two full tanks against
  // the distance between them. A vehicle's first fill (no distance before it)
  // or fills of an interval still open at month end no longer count as excess.
  const isOpen = (fl) => fl.status === 'open' && !fl.resolved;
  const assetRows = [];
  const perAssetDriver = new Map(); // assetId → { byDriver: Map(driverKey → {...}), … }
  for (const a of assets) {
    const af = monthFills.filter((f) => f.assetId === a.id);
    const res = assetResults.get(a.id) || { segments: [], intervals: [] };
    const segs = (res.segments || []).filter((sg) => inMonth(sg.toAt) && isNum(sg.distance));
    const ivs = (res.intervals || []).filter((iv) => inMonth(iv.toAt) && isNum(iv.distance) && iv.distance > 0);
    const openA = monthFlags.filter((fl) => fl.assetId === a.id && isOpen(fl));
    if (!af.length && !segs.length && !ivs.length && !openA.length) continue;

    const hasMeter = a.meterUnit === 'km' || a.meterUnit === 'hours';
    const ownBaseline = isNum(a.baselineRate) && a.baselineRate > 0 ? a.baselineRate : null;
    const baseOf = (iv) => (isNum(iv.baseline) && iv.baseline > 0 ? iv.baseline : ownBaseline);
    const litres = sum(af, (f) => f.litres);
    const distance = hasMeter ? sum(segs, (sg) => sg.distance) : null;
    const lastIv = ivs.length ? ivs[ivs.length - 1] : null;
    const baseline = lastIv ? baseOf(lastIv) : ownBaseline;
    const baselineSource = isNum(lastIv?.baseline) ? lastIv.baselineSource : (baseline != null ? 'manual' : null);
    const judged = ivs.filter((iv) => isNum(baseOf(iv)));
    const ivLitres = sum(judged, (iv) => iv.litres);
    const ivDistance = sum(ivs, (iv) => iv.distance);
    const expectedL = judged.length ? sum(judged, (iv) => baselineLitres(iv.distance, baseOf(iv), a.meterUnit)) : null;
    const excessLitres = isNum(expectedL) ? ivLitres - expectedL : null;
    const valued = af.filter((f) => isNum(f.valueRiel));
    const valueRiel = sum(valued, (f) => f.valueRiel);
    const litresValued = sum(valued, (f) => f.litres);
    const rielPerL = litresValued > 0 ? valueRiel / litresValued : null;
    const excessRiel = isNum(excessLitres) && isNum(rielPerL) ? Math.round(excessLitres * rielPerL) : null;
    const suspectOf = (iv) => Math.max(0, iv.litres - baselineLitres(iv.distance, baseOf(iv), a.meterUnit) * allowance);
    const suspectLitres = sum(judged, suspectOf);
    const suspectRiel = isNum(rielPerL) ? Math.round(suspectLitres * rielPerL) : 0;
    const cashOverpaidRiel = Math.round(sum(af, (f) => f.overpaidRiel));
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
      intervals: ivs.length,
      cashPaid,
      valueRiel: Math.round(valueRiel),
      actualRate: r2(consumptionRate(ivLitres, sum(judged, (iv) => iv.distance), a.meterUnit) ?? consumptionRate(sum(ivs, (iv) => iv.litres), ivDistance, a.meterUnit)),
      baseline: r2(baseline),
      baselineSource,
      costPerUnitRiel: hasMeter && distance > 0 && valueRiel > 0 ? r2(valueRiel / distance) : null,
      expectedLitres: r2(expectedL),
      excessLitres: r2(excessLitres),
      excessRiel,
      suspectedExcessLitres: r2(suspectLitres),
      cashOverpaidRiel,
      suspectedLossRiel: suspectRiel + cashOverpaidRiel,
      openFlags: openA.length,
      redFlags: openA.filter((fl) => fl.severity === 'red').length,
      rielPerLitre: r2(rielPerL),
    });

    // Driver split for this asset: litres, cash and overpayment by the fill's
    // driver; distance by the later fill's driver; an interval's excess shared
    // by the drivers in proportion to the litres they put in during it.
    const byDriver = new Map();
    const bucket = (k) => {
      if (!byDriver.has(k)) byDriver.set(k, { litres: 0, distance: 0, fills: 0, cash: {}, overpaid: 0, excessL: 0, suspectL: 0, judged: false });
      return byDriver.get(k);
    };
    for (const f of af) {
      const b = bucket(f.driverEmployeeId || '');
      b.litres += Number(f.litres) || 0;
      b.fills += 1;
      b.overpaid += Number(f.overpaidRiel) || 0;
      if (f.kind === 'cash_station' && isNum(f.amountPaidMinor)) b.cash[f.currency || 'KHR'] = (b.cash[f.currency || 'KHR'] || 0) + f.amountPaidMinor;
    }
    if (hasMeter) for (const sg of segs) bucket(sg.toDriverEmployeeId || '').distance += sg.distance;
    for (const iv of judged) {
      const ivExcess = iv.litres - baselineLitres(iv.distance, baseOf(iv), a.meterUnit);
      const ivSuspect = suspectOf(iv);
      const shares = Object.entries(iv.litresByDriver || {});
      const total = shares.reduce((t, [, l]) => t + l, 0);
      for (const [k, l] of shares) {
        const b = bucket(k);
        b.excessL += total > 0 ? ivExcess * (l / total) : 0;
        b.suspectL += total > 0 ? ivSuspect * (l / total) : 0;
        b.judged = true;
      }
    }
    perAssetDriver.set(a.id, { byDriver, rielPerL, meterUnit: a.meterUnit, name: a.name });
  }

  /* ── per driver ── */
  const drivers = new Map();
  for (const [assetId, info] of perAssetDriver) {
    for (const [key, b] of info.byDriver) {
      if (!drivers.has(key)) {
        drivers.set(key, { employeeId: key || null, name: employeeName(empById.get(key)), staffCode: empById.get(key)?.staffCode ?? null,
          litres: 0, distanceKm: 0, hours: 0, fills: 0, cashPaid: {}, excessLitres: 0, excessRiel: 0, suspectL: 0, suspectRiel: 0, cashOverpaidRiel: 0, excessKnown: false, assets: [] });
      }
      const d = drivers.get(key);
      d.litres += b.litres;
      d.fills += b.fills;
      d.cashOverpaidRiel += b.overpaid;
      if (info.meterUnit === 'km') d.distanceKm += b.distance;
      if (info.meterUnit === 'hours') d.hours += b.distance;
      for (const [c, v] of Object.entries(b.cash)) d.cashPaid[c] = (d.cashPaid[c] || 0) + v;
      if (b.judged) {
        d.excessLitres += b.excessL;
        d.suspectL += b.suspectL;
        d.excessKnown = true;
        if (isNum(info.rielPerL)) {
          d.excessRiel += b.excessL * info.rielPerL;
          d.suspectRiel += b.suspectL * info.rielPerL;
        }
      }
      d.assets.push({ assetId, name: info.name, litres: r2(b.litres), distance: r2(b.distance), excessLitres: b.judged ? r2(b.excessL) : null });
    }
  }
  // Ranked by "suspected loss": fuel used beyond normal variation (valued in
  // riel) plus cash paid above the posted price — two different ways money
  // goes missing. Excess litres / riel (against the plain baseline) stay shown.
  const driverRows = [...drivers.values()].map(({ suspectL, suspectRiel, ...d }) => {
    const excessRiel = d.excessKnown ? Math.round(d.excessRiel) : null;
    const cashOverpaidRiel = Math.round(d.cashOverpaidRiel);
    return {
      ...d,
      suspectedExcessLitres: r2(suspectL),
      litres: r2(d.litres),
      distanceKm: r2(d.distanceKm),
      hours: r2(d.hours),
      excessLitres: d.excessKnown ? r2(d.excessLitres) : null,
      excessRiel,
      cashOverpaidRiel,
      suspectedLossRiel: Math.round(suspectRiel) + cashOverpaidRiel,
      openFlags: monthFlags.filter((fl) => isOpen(fl) && d.employeeId && (fl.employeeId || '') === d.employeeId).length,
    };
  }).map(({ excessKnown: _k, ...rest }) => rest)
    .sort((x, y) => y.suspectedLossRiel - x.suspectedLossRiel || (y.excessRiel ?? -Infinity) - (x.excessRiel ?? -Infinity) || x.name.localeCompare(y.name));

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
      openFlags: monthFlags.filter((fl) => fl.locationId === loc.id && isOpen(fl)).length,
    });
  }

  /* ── flags summary ── */
  // Every flag of the month counts here, whatever its status — a missed-dip
  // gap that has since been closed by a dip, or a reviewed flag, is still part
  // of the month's record. `open` = still open and still firing.
  const flagCounts = {};
  for (const fl of monthFlags) {
    const k = fl.ruleKey;
    flagCounts[k] = flagCounts[k] || { ruleKey: k, open: 0, explained: 0, confirmed: 0, dismissed: 0, resolved: 0, red: 0, amber: 0, info: 0, total: 0 };
    const c = flagCounts[k];
    c.total += 1;
    if (isOpen(fl)) c.open += 1;
    if (fl.status !== 'open' && c[fl.status] != null) c[fl.status] += 1;
    if (fl.resolved) c.resolved += 1;
    if (c[fl.severity] != null) c[fl.severity] += 1;
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
      openFlags: monthFlags.filter(isOpen).length,
      cashOverpaidRiel: Math.round(sum(monthFills, (f) => f.overpaidRiel)),
    },
    assets: assetRows.sort((x, y) => y.suspectedLossRiel - x.suspectedLossRiel || (y.excessRiel ?? -Infinity) - (x.excessRiel ?? -Infinity) || x.name.localeCompare(y.name)),
    flagList: monthFlags.map((fl) => ({
      id: fl.id, ruleKey: fl.ruleKey, severity: fl.severity, status: fl.status, resolved: !!fl.resolved, at: fl.at,
      assetId: fl.assetId ?? null, locationId: fl.locationId ?? null, employeeId: fl.employeeId ?? null, explanation: fl.explanation,
    })),
    drivers: driverRows,
    tanks: tankRows,
    flags: Object.values(flagCounts).sort((a, b) => a.ruleKey.localeCompare(b.ruleKey)),
  };
}

module.exports = { buildMonthlyReport, employeeName };
