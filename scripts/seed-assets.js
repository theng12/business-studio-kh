/**
 * Fixed Assets realistic dataset — `scripts/seed-realistic.js --assets`
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §12 "Testing").
 *
 * A Cambodian ceramics business with 5 branches and ≈300 assets: the fuel
 * vehicles and machines (linked, from Fuel), owned buildings and land, rented
 * shop fit-outs, computers, furniture, a group of 50 display stands, kilns,
 * plant and tools — opening values with known cost and with only a value at
 * the start date, items under the $300 threshold, and ≈21 months of life:
 * purchases, transfers, repairs, improvements, life changes, an impairment, a
 * building revaluation, sales, scrapping, a partial sale, two losses (one found
 * again), monthly depreciation runs, two period closes, and a purchase entered
 * late into a closed month. Every write goes through the app's own modules.
 *
 * Ground truth: the script keeps its OWN model of every asset (pure
 * bookDepreciation inputs, independent of the database) and writes
 * ./assets-truth.json; it then checks the app's register, depreciation report,
 * gain/loss and sub-ledger = GL against it and writes the comparison into the
 * same file. (Stock-take items are A3 and not seeded yet.)
 */

const path = require('node:path');
const fs = require('node:fs');

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedAssets({ repo, root, kt, log, seed = 20261008, start = '2025-01-01' }) {
  const req = (m) => require(path.join(repo, 'main', m));
  const config = req('db/assetConfig');
  const A = req('db/fixedAssets');
  const dep = req('db/assetDepreciation');
  const disp = req('db/assetDisposals');
  const ledger = req('db/ledger');
  const fx = req('db/fxRates');
  const branchesDb = req('db/branches');
  const employees = req('db/employees');
  const fuel = req('db/fuel');
  const identity = req('db/assetIdentity');
  const reports = req('db/assetReports');
  const book = req('util/bookDepreciation');
  const { todayPhnomPenh } = req('db/_assetUtil');

  const rng = mulberry32(seed ^ 0xa55e7);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const chance = (p) => rng() < p;
  const C = kt.id;
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dateIn = (period, lo = 1, hi = 28) => `${period}-${String(ri(lo, hi)).padStart(2, '0')}`;

  config.ensureCategories(C);
  config.updateSettings(C, { registerStartDate: start, tagPrefix: 'KT' });
  const settings = config.getSettings(C);
  const conv = settings.convention;
  const cat = (k) => config.categoryByKey(C, k);
  const startPeriod = book.periodOf(start);
  const lastMonth = book.addMonths(todayPhnomPenh().slice(0, 7), -1);

  // Rates: a house rate, and monthly official (GDT-style) rates.
  fx.setRate({ companyId: C, rateDate: '2015-01-01', khrPerUsd: 4100, source: 'house', sourceNote: 'Seed house rate' });
  for (let p = '2015-01'; p <= lastMonth; p = book.addMonths(p, 1)) {
    fx.setRate({ companyId: C, rateDate: `${p}-01`, khrPerUsd: 4040 + ri(0, 80), source: 'official', sourceNote: 'GDT daily rate (seed)' });
  }

  // Branches and staff.
  const BR = [['PP1', 'Phnom Penh head office', 'ការិយាល័យកណ្តាល', true], ['PP2', 'Toul Kork showroom', 'ទួលគោក'], ['SR1', 'Siem Reap shop', 'សៀមរាប'],
    ['BB1', 'Battambang shop', 'បាត់ដំបង'], ['KS1', 'Kampong Speu kiln yard', 'កំពង់ស្ពឺ']];
  const branches = BR.map(([code, nameEn, nameKm, head]) => branchesDb.create({ companyId: C, code, nameEn, nameKm, isHeadOffice: !!head }));
  let staff = employees.list(C, { status: 'active' });
  if (staff.length < 10) {
    for (let i = 1; i <= 20; i += 1) employees.create({ companyId: C, staffCode: `AS${String(i).padStart(2, '0')}`, nameEn: `Staff ${i}`, isDriver: i <= 8 });
    staff = employees.list(C, { status: 'active' });
  }

  // Fuel vehicles: from --fuel when it ran, else 16 made here; the register drafts them.
  if (!fuel.listAssets(C, { status: 'all' }).length) {
    const types = Object.fromEntries(fuel.listAssetTypes(C).map((t) => [t.builtinKey, t]));
    const defs = [['truck', 5], ['car_van', 3], ['motorbike', 4], ['forklift', 2], ['generator', 1], ['tractor', 1]];
    let n = 0;
    for (const [k, count] of defs) for (let i = 1; i <= count; i += 1) {
      n += 1;
      fuel.createAsset({ companyId: C, typeId: types[k].id, name: `${types[k].name} ${i}`, plateOrSerial: `2A-${1000 + n}`, assignedEmployeeId: pick(staff).id });
    }
  }
  identity.ensureFuelLinked(C);

  // ---- the independent model ----
  const truth = { start, lastMonth, assets: {}, planted: {}, events: [] };
  const model = new Map(); // id → { spec, treatment, categoryKey, costUsd, land, endPeriod, gone, gain }
  const record = (a, m) => { model.set(a.id, m); truth.assets[a.tagCode] = { id: a.id, category: m.categoryKey, treatment: m.treatment }; };

  function modelFor(a) {
    const c = config.getCategory(a.categoryId);
    if (a.accountingTreatment === 'tracked_only') return { treatment: 'tracked_only', categoryKey: c.builtinKey, costUsd: a.costUsdMinor };
    if (a.accountingTreatment === 'not_depreciated') return { treatment: 'not_depreciated', categoryKey: c.builtinKey, land: true, costUsd: a.costUsdMinor, changes: [] };
    // Re-derived here from the asset's INPUTS, not read back from its schedule columns.
    let spec;
    if (a.acquisitionKind === 'opening' && a.costBasis === 'actual') {
      const pos = book.openingPosition({ costMinor: a.costUsdMinor, salvageMinor: a.salvageMinor, lifeMonths: a.usefulLifeMonths, inServiceDate: a.inServiceDate || a.purchaseDate, registerStartDate: start, convention: conv });
      spec = { basisMinor: a.costUsdMinor, salvageMinor: a.salvageMinor, openingAccumMinor: pos.accumMinor, lifeMonths: pos.remainingMonths, startPeriod: startPeriod };
    } else if (a.acquisitionKind === 'opening') {
      spec = { basisMinor: a.costUsdMinor, salvageMinor: a.salvageMinor, openingAccumMinor: 0, lifeMonths: a.usefulLifeMonths, startPeriod };
    } else {
      spec = { basisMinor: a.costUsdMinor, salvageMinor: a.salvageMinor, openingAccumMinor: 0, lifeMonths: a.usefulLifeMonths, startPeriod: a.inServiceDate ? book.firstPeriod(a.inServiceDate, conv) : null };
    }
    return { treatment: 'capitalised', categoryKey: c.builtinKey, spec: { ...spec, changes: [] }, costUsd: a.costUsdMinor };
  }

  const usd = (d) => Math.round(d * 100);
  /** The model's schedule, or "not in service yet" (cost only). */
  const sched = (m, end = null) => {
    if (!m.spec.startPeriod) return { basisMinor: m.spec.basisMinor, accumMinor: 0, impairedMinor: 0, nbvMinor: m.spec.basisMinor, chargedMinor: 0, salvageMinor: m.spec.salvageMinor };
    return book.bookSchedule({ ...m.spec, endPeriod: end });
  };
  let made = 0;
  function add(def) {
    const c = cat(def.cat);
    const salvagePct = c.defaultSalvagePct || 0;
    const a = A.create({
      companyId: C, categoryId: c.id, name: def.name, nameKm: def.nameKm || null, quantity: def.qty || 1,
      branchId: def.branch || pick(branches).id, custodianEmployeeId: chance(0.5) ? pick(staff).id : null,
      acquisitionKind: def.kind, costBasis: def.deemed ? 'deemed' : (def.kind === 'opening' ? 'actual' : null),
      purchaseDate: def.date || null, inServiceDate: def.inService === undefined ? def.date || null : def.inService,
      costMinor: def.cost, costCurrency: def.currency || 'USD', usefulLifeMonths: def.life || c.defaultLifeMonths,
      salvageMinor: def.salvage != null ? def.salvage : (c.bookMethod === 'none' || def.currency === 'KHR' ? null : Math.round((def.cost * salvagePct) / 100)),
      serialNo: def.serial || null, depreciateOverride: def.override ?? null,
    });
    const act = A.activate(a.id).asset;
    record(act, modelFor(act));
    made += 1;
    return act;
  }

  // Opening assets (owned before the start).
  const before = (yLo, yHi) => iso(ri(yLo, yHi), ri(1, 12), ri(1, 28));
  // Fuel drafts: give them an opening cost and activate them.
  for (const d of A.list(C, { attention: 'needs_cost', limit: 500 }).items) {
    const big = d.categoryKey === 'truck' || d.categoryKey === 'plant';
    A.update(d.id, { acquisitionKind: 'opening', costBasis: 'actual', purchaseDate: before(2018, 2024), costMinor: usd(big ? ri(18, 45) * 1000 : ri(900, 12_000)),
      usefulLifeMonths: config.getCategory(d.categoryId).defaultLifeMonths, salvageMinor: usd(big ? 2000 : 100) });
    const act = A.activate(d.id).asset;
    record(act, modelFor(act));
  }
  add({ cat: 'land', name: 'Kampong Speu yard land', kind: 'opening', date: before(2012, 2016), cost: usd(85_000), branch: branches[4].id });
  add({ cat: 'land', name: 'Toul Kork shop plot', kind: 'opening', deemed: true, cost: usd(240_000), branch: branches[1].id });
  const shop = add({ cat: 'building', name: 'Toul Kork shop building', kind: 'opening', deemed: true, cost: usd(160_000), life: 200, branch: branches[1].id });
  add({ cat: 'building', name: 'Kiln shed', kind: 'opening', date: before(2015, 2017), cost: usd(42_000), life: 240, branch: branches[4].id });
  for (let i = 1; i <= 6; i += 1) add({ cat: 'kiln', name: `Kiln ${i}`, kind: 'opening', date: before(2016, 2023), cost: usd(ri(8, 30) * 1000), branch: branches[4].id });
  for (let i = 1; i <= 25; i += 1) add({ cat: 'computer', name: `${pick(['iMac', 'Dell desktop', 'POS terminal', 'Laser printer', 'Laptop'])} ${i}`, kind: 'opening', deemed: chance(0.5), date: before(2021, 2024), cost: usd(ri(300, 2200)), life: ri(18, 36), serial: `SN${10000 + i}` });
  for (let i = 1; i <= 50; i += 1) add({ cat: 'furniture', name: `${pick(['Desk', 'Cabinet', 'Counter', 'Sofa', 'Meeting table'])} ${i}`, kind: 'opening', deemed: chance(0.3), date: before(2019, 2024), cost: usd(ri(150, 1600)) });
  for (let i = 1; i <= 25; i += 1) add({ cat: 'tools', name: `${pick(['Tile cutter', 'Drill set', 'Pallet jack', 'Glaze mixer'])} ${i}`, kind: 'opening', date: before(2020, 2024), cost: usd(ri(120, 900)) });
  const stands = add({ cat: 'shelving', name: '50 display stands', kind: 'opening', date: '2023-04-10', cost: usd(25_000), qty: 50, branch: branches[0].id });
  for (let i = 1; i <= 40; i += 1) add({ cat: 'shelving', name: `Shelf unit ${i}`, kind: 'opening', deemed: chance(0.4), date: before(2020, 2024), cost: usd(ri(200, 1400)) });
  for (let i = 1; i <= 4; i += 1) add({ cat: 'software', name: `Licence ${i}`, kind: 'opening', deemed: true, cost: usd(ri(400, 2500)), life: ri(12, 30) });
  log(`assets: ${made} opening assets (+ fuel vehicles) activated`);

  // ---- 21 months of life, month by month, depreciation posted after each ----
  const live = () => [...model.entries()].filter(([, m]) => !m.gone).map(([id]) => id);
  const planted = truth.planted;
  let latePlanted = false;
  for (let p = startPeriod; p <= lastMonth; p = book.addMonths(p, 1)) {
    const touched = new Set();
    // Purchases.
    for (let i = 0, n = ri(3, 9); i < n; i += 1) {
      const kind = pick(['computer', 'computer', 'furniture', 'shelving', 'tools', 'tools', 'furniture']);
      const cheap = chance(0.25);
      const d = dateIn(p);
      add({ cat: kind, name: `${kind} bought ${p} #${i + 1}`, kind: 'purchase', date: d, inService: chance(0.1) ? null : d, cost: usd(cheap ? ri(40, 290) : ri(320, 3500)), override: cheap && chance(0.2) ? true : null });
    }
    if (p === book.addMonths(startPeriod, 3)) add({ cat: 'leasehold', name: 'Siem Reap shop fit-out', kind: 'purchase', date: dateIn(p), cost: usd(18_000), life: 48, branch: branches[2].id });
    if (p === book.addMonths(startPeriod, 5)) add({ cat: 'truck', name: 'Hino delivery truck', kind: 'purchase', date: dateIn(p, 1, 15), cost: usd(42_000), currency: 'USD' });
    if (p === book.addMonths(startPeriod, 7)) add({ cat: 'plant', name: 'Forklift (riel)', kind: 'purchase', date: dateIn(p), cost: 61_500_000, currency: 'KHR' });

    // In-service dates for things bought and stored.
    for (const id of live()) {
      const a = A.get(id);
      if (a.accountingTreatment === 'capitalised' && !a.depreciationStartPeriod && a.acquisitionKind === 'purchase' && a.purchaseDate < `${p}-01` && chance(0.5)) {
        const d = dateIn(p);
        A.update(id, { inServiceDate: d });
        model.get(id).spec.startPeriod = book.firstPeriod(d, conv);
      }
    }

    // Transfers and status changes.
    for (let i = 0, n = ri(2, 6); i < n; i += 1) {
      const id = pick(live());
      const a = A.get(id);
      const floor = a.acquisitionKind === 'opening' ? start : a.purchaseDate;
      const d = dateIn(p, 16, 28);
      if (d < floor) continue;
      try { A.transfer({ companyId: C, assetIds: [id], toBranchId: pick(branches).id, date: d, reason: 'Moved for the shop' }); touched.add(id); truth.events.push(['transfer', p]); } catch (_) { /* a later move exists */ }
    }
    if (chance(0.6)) {
      const id = pick(live());
      try { A.recordRepair({ id, date: dateIn(p), amountMinor: usd(ri(20, 250)), vendor: 'Local workshop', reason: 'Routine repair' }); } catch (_) { /* ok */ }
    }

    const capitalisedLive = () => live().filter((id) => model.get(id).treatment === 'capitalised' && model.get(id).spec.startPeriod <= p);
    // Improvements (capex) and life changes.
    if (chance(0.3)) {
      const id = pick(capitalisedLive());
      if (id) {
        const a = A.get(id);
        const amount = usd(ri(400, 4000));
        const extra = ri(6, 24);
        const d = dateIn(p);
        if (d >= (a.acquisitionKind === 'opening' ? start : a.purchaseDate)) {
          A.recordCapex({ id, date: d, amountMinor: amount, extendsLifeMonths: extra, reason: 'Upgrade' });
          model.get(id).spec.changes.push({ period: p, addBasisMinor: amount, extendMonths: extra });
          touched.add(id);
          truth.events.push(['capex', p, amount]);
        }
      }
    }
    if (chance(0.15)) {
      const id = pick(capitalisedLive());
      if (id) {
        const n = ri(12, 48);
        A.changeLife({ id, date: dateIn(p), newLifeMonths: n, reason: 'Lasting longer than expected' });
        model.get(id).spec.changes.push({ period: p, lifeMonths: n });
        touched.add(id);
      }
    }
    if (p === book.addMonths(startPeriod, 9)) {
      const id = pick(capitalisedLive().filter((x) => model.get(x).categoryKey === 'kiln'));
      if (id) {
        const pos = book.positionAt(model.get(id).spec, p);
        const amount = Math.round(pos.nbvMinor / 4);
        disp.impair({ id, date: dateIn(p), amountMinor: amount, reason: 'Cracked chamber' });
        model.get(id).spec.changes.push({ period: p, impairMinor: amount });
        touched.add(id);
        planted.impairment = { tag: A.get(id).tagCode, amountMinor: amount };
      }
    }
    if (p === book.addMonths(startPeriod, 12)) {
      const value = usd(185_000);
      disp.revalue({ id: shop.id, date: dateIn(p), newValueMinor: value, reason: 'Valuer\'s report (seed)' });
      model.get(shop.id).spec.changes.push({ period: p, revalueToMinor: value });
      planted.revaluation = { tag: shop.tagCode, newValueMinor: value };
    }
    if (p === book.addMonths(startPeriod, 6)) {
      const d = dateIn(p, 20, 28);
      const m = model.get(stands.id);
      const last = book.lastPeriod(d, conv);
      const s = sched(m, last);
      const share = (v) => Math.round((v * 10) / 50);
      const r = disp.partialDispose({ id: stands.id, date: d, qty: 10, proceedsMinor: usd(3000), buyer: 'Market trader' });
      const salvageNow = book.positionAt(m.spec, book.addMonths(last, 1)).salvageMinor;
      m.spec.changes.push({ period: book.addMonths(last, 1), removeBasisMinor: share(s.basisMinor), removeAccumMinor: share(s.accumMinor), removeImpairMinor: share(s.impairedMinor), salvageMinor: salvageNow - share(salvageNow) });
      planted.partialSale = { tag: stands.tagCode, qty: 10, gainMinor: usd(3000) - (share(s.basisMinor) - share(s.accumMinor) - share(s.impairedMinor)), appGainMinor: r.event.detail.gainMinor };
    }

    // Sales, scrapping, losses.
    for (let i = 0, n = ri(0, 2); i < n; i += 1) {
      const id = pick(live().filter((x) => x !== stands.id && x !== shop.id && !touched.has(x)));
      if (!id) continue;
      const a = A.get(id);
      const d = dateIn(p);
      if (d < (a.acquisitionKind === 'opening' ? start : a.purchaseDate)) continue;
      const kind = chance(0.6) ? 'sale' : 'scrap';
      const m = model.get(id);
      const proceeds = kind === 'sale' ? usd(ri(50, 2000)) : 0;
      const r = disp.dispose({ id, date: d, kind, proceedsMinor: proceeds, buyer: kind === 'sale' ? 'Buyer' : null });
      m.gone = true;
      if (m.spec) {
        m.spec.endPeriod = book.lastPeriod(d, conv);
        m.gain = proceeds - sched(m, m.spec.endPeriod).nbvMinor;
      } else if (m.land) m.gain = proceeds - m.costUsd;
      m.appGain = r.event.detail.gainMinor;
      truth.events.push(['dispose', p, A.get(id).tagCode]);
    }
    if (p === book.addMonths(startPeriod, 8) || p === book.addMonths(startPeriod, 10)) {
      const id = pick(capitalisedLive().filter((x) => model.get(x).categoryKey === 'computer' && !touched.has(x)));
      if (id) {
        const d = dateIn(p, 1, 10);
        disp.markLost({ id, date: d, reason: 'Not found at the count' });
        (planted.lost ||= []).push(A.get(id).tagCode);
        const m = model.get(id);
        m.gone = true;
        m.spec.endPeriod = book.lastPeriod(d, conv);
        m.gain = -sched(m, m.spec.endPeriod).nbvMinor;
      }
    }
    if (p === book.addMonths(startPeriod, 13) && planted.lost) {
      const tag = planted.lost[0];
      const id = truth.assets[tag].id;
      disp.markFound({ id, date: dateIn(p), reason: 'Found in the Siem Reap store' });
      planted.found = tag;
      const m = model.get(id);
      m.gone = false;
      delete m.spec.endPeriod;
      delete m.gain;
    }

    // The month is over: post it (catch-up included), then close the books at the plan's points.
    for (const due of dep.dueMonths(C, p)) dep.runDepreciation(C, due, { kind: 'auto' });
    if (p === book.addMonths(startPeriod, 7)) { ledger.lockPeriod(C, book.addMonths(startPeriod, 5), 'Half year closed (seed)'); planted.closedThrough1 = book.addMonths(startPeriod, 5); }
    if (p === book.addMonths(startPeriod, 13)) { ledger.lockPeriod(C, book.addMonths(startPeriod, 11), 'Year closed (seed)'); planted.closedThrough2 = book.addMonths(startPeriod, 11); }
    if (p === book.addMonths(startPeriod, 14) && !latePlanted) {
      // A purchase from inside the closed year, entered now: it lands in the first open month.
      const d = iso(Number(start.slice(0, 4)), 11, 14);
      const late = add({ cat: 'computer', name: 'Late-entered server', kind: 'purchase', date: d, cost: usd(4800), life: 36 });
      const entry = ledger.getEntry(late.acquisitionEntryId);
      planted.lateEntry = { tag: late.tagCode, purchaseDate: d, postedOn: entry.entryDate, memo: entry.memo };
      latePlanted = true;
    }
  }

  // ---- expected figures, from the model only ----
  const expected = { byCategory: {}, total: { costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 }, chargedMinor: 0, disposalGainMinor: 0 };
  for (const m of model.values()) {
    if (m.treatment === 'tracked_only') continue;
    if (m.spec) {
      const s = sched(m, m.spec.endPeriod && m.spec.endPeriod < lastMonth ? m.spec.endPeriod : lastMonth);
      expected.chargedMinor += s.chargedMinor;
      if (m.gone) { expected.disposalGainMinor += m.gain ?? 0; continue; }
      m.expected = { costMinor: s.basisMinor, accumMinor: s.accumMinor, impairmentMinor: s.impairedMinor, nbvMinor: s.nbvMinor };
      const row = (expected.byCategory[m.categoryKey] ||= { costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 });
      for (const [k, v] of [['costMinor', s.basisMinor], ['accumMinor', s.accumMinor], ['impairmentMinor', s.impairedMinor], ['nbvMinor', s.nbvMinor]]) { row[k] += v; expected.total[k] += v; }
    } else if (m.land) {
      if (m.gone) { expected.disposalGainMinor += m.gain ?? 0; continue; }
      const row = (expected.byCategory[m.categoryKey] ||= { costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 });
      row.costMinor += m.costUsd; row.nbvMinor += m.costUsd; expected.total.costMinor += m.costUsd; expected.total.nbvMinor += m.costUsd;
    }
  }
  if (planted.partialSale) expected.disposalGainMinor += planted.partialSale.gainMinor;
  truth.expected = expected;

  // ---- the app's figures, compared ----
  const asOf = dep.lastDayOf(lastMonth);
  const reg = reports.getReport(C, { kind: 'register', asOf });
  const actualByCat = {};
  const diffs = [];
  for (const r of reg.rows.filter((x) => !x.trackedOnly)) {
    const m = model.get(r.assetId);
    if (m?.expected && (m.expected.costMinor !== r.costMinor || m.expected.accumMinor !== r.accumMinor || m.expected.nbvMinor !== r.nbvMinor)) {
      diffs.push({ asset: r.tagCode, expected: m.expected, actual: { costMinor: r.costMinor, accumMinor: r.accumMinor, impairmentMinor: r.impairmentMinor, nbvMinor: r.nbvMinor } });
    }
    if (m?.expected === undefined && m && !m.gone && m.treatment !== 'tracked_only' && !m.land) diffs.push({ asset: r.tagCode, problem: 'in the register but not expected' });
    const key = config.getCategory(r.categoryId).builtinKey;
    const row = (actualByCat[key] ||= { costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 });
    row.costMinor += r.costMinor; row.accumMinor += r.accumMinor; row.impairmentMinor += r.impairmentMinor; row.nbvMinor += r.nbvMinor;
  }
  const depReport = reports.getReport(C, { kind: 'depreciation', to: asOf });
  const ad = reports.getReport(C, { kind: 'additions_disposals', to: asOf });
  const integrity = dep.checkIntegrity(C);
  for (const k of new Set([...Object.keys(expected.byCategory), ...Object.keys(actualByCat)])) {
    for (const f of ['costMinor', 'accumMinor', 'impairmentMinor', 'nbvMinor']) {
      const e = expected.byCategory[k]?.[f] || 0;
      const a = actualByCat[k]?.[f] || 0;
      if (e !== a) diffs.push({ category: k, field: f, expected: e, actual: a });
    }
  }
  // Depreciation charged since the start (the report also counts opening asset catch-up within disposals).
  if (depReport.totals.totalMinor !== expected.chargedMinor) diffs.push({ field: 'depreciation charged', expected: expected.chargedMinor, actual: depReport.totals.totalMinor });
  if (ad.totals.gainMinor !== expected.disposalGainMinor) diffs.push({ field: 'disposal gain / loss', expected: expected.disposalGainMinor, actual: ad.totals.gainMinor });
  if (!integrity.ok) diffs.push({ field: 'integrity', detail: integrity });
  if (reg.totals.unpostedDepreciationMinor !== 0) diffs.push({ field: 'unposted depreciation at the last month end', actual: reg.totals.unpostedDepreciationMinor });
  const lateRun = planted.lateEntry ? getLateCatchUp(req, C, planted.lateEntry.tag, A) : null;
  if (planted.lateEntry && (!/^Late entry for /.test(planted.lateEntry.memo) || !lateRun)) diffs.push({ field: 'late entry', detail: { ...planted.lateEntry, lateRun } });
  truth.planted.lateEntryCatchUp = lateRun;
  truth.check = {
    ok: diffs.length === 0, diffs, asOf,
    totals: { expected: expected.total, actual: { costMinor: reg.totals.costMinor, accumMinor: reg.totals.accumMinor, impairmentMinor: reg.totals.impairmentMinor, nbvMinor: reg.totals.nbvMinor } },
    counts: { assets: A.list(C, { recordState: 'all', limit: 1 }).total, trackedOnly: reg.totals.trackedOnly, runs: dep.listRuns(C).months.filter((m) => m.status === 'posted').length },
  };
  fs.writeFileSync(path.join(root, 'assets-truth.json'), JSON.stringify(truth, null, 2));
  log(`assets: ${truth.check.counts.assets} assets, ${truth.check.counts.runs} runs; check ${truth.check.ok ? 'OK' : `FAILED (${diffs.length} differences)`}`);
  return truth.check;
}

/** The run that carried the late-entered purchase's catch-up. */
function getLateCatchUp(req, companyId, tag, A) {
  const db = req('db/index').getDb();
  const a = A.getByTag(companyId, tag);
  const r = db.prepare(`SELECT e.period, SUM(l.debit_minor) AS catchUp FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.asset_id = ? AND l.line_role = 'dep_catch_up' GROUP BY e.period ORDER BY e.period LIMIT 1`).get(a.id);
  return r ? { period: r.period, catchUpMinor: r.catchUp } : null;
}

module.exports = { seedAssets };
