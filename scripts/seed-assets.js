/**
 * Fixed Assets realistic dataset — `scripts/seed-realistic.js --assets`
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §12 "Testing").
 *
 * A Cambodian ceramics business with 5 branches and ≈300 assets: the fuel
 * vehicles and machines (linked, from Fuel), owned buildings and land, rented
 * shop fit-outs, computers, furniture, a group of 50 display stands, kilns,
 * plant and tools — opening values with known cost and with only a value at
 * the start date, items under the $300 threshold, and ≈21 months of life
 * (start 2025-01-01 by default): purchases, transfers, repairs, improvements,
 * life changes, an impairment, a building revaluation, sales, scrapping, a
 * partial sale, two losses (one found again), monthly runs, two period
 * closes and a purchase entered late into a closed month. Every write goes
 * through the app's own modules, and nothing that goes wrong is swallowed.
 *
 * The last four months are a LAG AND REVERSAL phase: the runs stop while
 * life goes on — a backdated disposal into a closed, posted month (booked as a
 * late disposal), a sale paid in riel, the plan's §5.4 truck sale, land
 * revalued down then up (IAS 16.39), an impairment made and reversed — then
 * the runs catch up, the latest run is reversed and posted again, and the
 * tax view of the first year is checked and filed.
 *
 * Ground truth, kept apart from the app:
 *   - the plan's worked examples (§4.1, §4.2, §5.4) as HAND-COMPUTED cents;
 *   - an independent model of every asset (the pure schedule functions fed
 *     with the script's own inputs, plus its own riel rates for the tax view);
 *   - checked at EVERY month-end: depreciation posted through the month = the
 *     model, and the register's NBV = the GL's net fixed-asset balance;
 *   - and at the end: per asset and per category, depreciation charged,
 *     disposal gain / loss, revaluation P&L / surplus, the late entries, the
 *     tax pools' additions and proceeds, and the integrity check.
 * Everything is written to ./assets-truth.json with `check.ok`.
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

/** The plan's tax classes, written out here (not read from the app's categories). */
const CLASS_OF = {
  land: 'land', building: '1', building_light: '1b', leasehold: '1', truck: '3', car: '3', motorbike: '3',
  computer: '2', software: '2', furniture: '3', shelving: '3', kiln: '4', plant: '4', tools: '4', intangible: 'intangible',
};

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
  const taxv = req('db/assetTax');
  const book = req('util/bookDepreciation');
  const { todayPhnomPenh } = req('db/_assetUtil');
  const dbh = req('db/index').getDb();

  const rng = mulberry32(seed ^ 0xa55e7);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const chance = (p) => rng() < p;
  const C = kt.id;
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dateIn = (period, lo = 1, hi = 28) => `${period}-${String(ri(lo, hi)).padStart(2, '0')}`;
  const usd = (d) => Math.round(d * 100);
  const later = (a, b) => (a > b ? a : b);

  config.ensureCategories(C);
  config.updateSettings(C, { registerStartDate: start, tagPrefix: 'KT' });
  const conv = config.getSettings(C).convention;
  const cat = (k) => config.categoryByKey(C, k);
  const startPeriod = book.periodOf(start);
  const y0 = Number(start.slice(0, 4));
  const today = todayPhnomPenh();
  const lastMonth = book.addMonths(today.slice(0, 7), -1);
  const lagFrom = book.addMonths(lastMonth, -3);
  const HOUSE = 4100;

  // Rates: a constant house rate, and monthly official rates the model keeps its own copy of.
  fx.setRate({ companyId: C, rateDate: '2015-01-01', khrPerUsd: HOUSE, source: 'house', sourceNote: 'Seed house rate' });
  const official = [];
  for (let p = '2015-01'; p <= today.slice(0, 7); p = book.addMonths(p, 1)) {
    const r = 4040 + ri(0, 80);
    fx.setRate({ companyId: C, rateDate: `${p}-01`, khrPerUsd: r, source: 'official', sourceNote: 'GDT daily rate (seed)' });
    official.push([`${p}-01`, r]);
  }
  const officialOn = (date) => { let r = null; for (const [d, v] of official) if (d <= date) r = v; return r; };
  const riel = (cents, date) => Math.round((cents * officialOn(date)) / 100);

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
  const truth = { start, lastMonth, lagFrom, assets: {}, planted: {}, workedExamples: [], events: [] };
  const planted = truth.planted;
  const model = new Map();

  /** A model asset from the script's OWN inputs (`def`), never from the app's schedule columns. */
  function modelFrom(def, a) {
    const key = def.cat;
    const costUsd = def.currency === 'KHR' ? Math.round((def.cost * 100) / HOUSE) : def.cost;
    const salvage = def.salvage;
    const treatment = key === 'land' ? 'not_depreciated'
      : def.override === true ? 'capitalised' : def.override === false ? 'tracked_only' : costUsd >= 30000 ? 'capitalised' : 'tracked_only';
    const m = { id: a.id, tag: a.tagCode, categoryKey: key, treatment, costUsd, land: key === 'land', def, windows: [], purchaseDate: def.kind === 'opening' ? null : def.date,
      opening: def.kind === 'opening', currency: def.currency || 'USD', rawCost: def.cost, lastMove: null };
    if (treatment !== 'capitalised') return m;
    if (def.kind === 'opening' && !def.deemed) {
      const pos = book.openingPosition({ costMinor: costUsd, salvageMinor: salvage, lifeMonths: def.life, inServiceDate: def.inService || def.date, registerStartDate: start, convention: conv });
      m.spec = { basisMinor: costUsd, salvageMinor: salvage, openingAccumMinor: pos.accumMinor, lifeMonths: pos.remainingMonths, startPeriod, changes: [] };
    } else if (def.kind === 'opening') {
      m.spec = { basisMinor: costUsd, salvageMinor: salvage, openingAccumMinor: 0, lifeMonths: def.life, startPeriod, changes: [] };
    } else {
      m.spec = { basisMinor: costUsd, salvageMinor: salvage, openingAccumMinor: 0, lifeMonths: def.life, startPeriod: def.inService ? book.firstPeriod(def.inService, conv) : null, changes: [] };
    }
    return m;
  }

  /** The model's schedule; "not in service yet" has cost only. */
  const sched = (m, end = null) => {
    if (!m.spec.startPeriod) return { basisMinor: m.spec.basisMinor, accumMinor: 0, impairedMinor: 0, nbvMinor: m.spec.basisMinor, chargedMinor: 0, salvageMinor: m.spec.salvageMinor };
    return book.bookSchedule({ ...m.spec, endPeriod: end });
  };
  /** Depreciation the books should show as posted through month `p` (a window holds what was posted before a late fact was known). */
  const expectedPosted = (m, p) => {
    if (!m.spec || !m.spec.startPeriod || p < m.spec.startPeriod) return 0;
    const w = m.windows.find((x) => p >= x.from && p <= x.to);
    const end = w ? w.end : m.spec.endPeriod;
    if (end && end < m.spec.startPeriod) return 0;
    return book.chargedThrough({ ...m.spec, endPeriod: end || null }, p);
  };

  let made = 0;
  function add(def0) {
    const c = cat(def0.cat);
    const def = { ...def0, life: def0.life || c.defaultLifeMonths, inService: def0.inService === undefined ? def0.date || null : def0.inService };
    if (def.salvage == null) {
      const costUsd = def.currency === 'KHR' ? Math.round((def.cost * 100) / HOUSE) : def.cost;
      def.salvage = c.bookMethod === 'none' ? null : Math.round((costUsd * (c.defaultSalvagePct || 0)) / 100);
    }
    const a = A.create({
      companyId: C, categoryId: c.id, name: def.name, quantity: def.qty || 1,
      branchId: def.branch || pick(branches).id, custodianEmployeeId: chance(0.5) ? pick(staff).id : null,
      acquisitionKind: def.kind, costBasis: def.deemed ? 'deemed' : (def.kind === 'opening' ? 'actual' : null),
      purchaseDate: def.date || null, inServiceDate: def.inService,
      costMinor: def.cost, costCurrency: def.currency || 'USD', usefulLifeMonths: def.life,
      salvageMinor: def.salvage, serialNo: def.serial || null, depreciateOverride: def.override ?? null,
    });
    const act = A.activate(a.id).asset;
    const m = modelFrom(def, act);
    model.set(act.id, m);
    truth.assets[act.tagCode] = { id: act.id, category: m.categoryKey, treatment: m.treatment };
    made += 1;
    return act;
  }

  const before = (yLo, yHi) => iso(ri(yLo, yHi), ri(1, 12), ri(1, 28));
  // Fuel drafts: give them an opening cost and activate them.
  for (const d of A.list(C, { attention: 'needs_cost', limit: 500 }).items) {
    const big = d.categoryKey === 'truck' || d.categoryKey === 'plant';
    const def = { cat: d.categoryKey, kind: 'opening', date: before(2018, 2024), cost: usd(big ? ri(18, 45) * 1000 : ri(900, 12_000)), life: config.getCategory(d.categoryId).defaultLifeMonths, salvage: usd(big ? 2000 : 100) };
    def.inService = def.date;
    A.update(d.id, { acquisitionKind: 'opening', costBasis: 'actual', purchaseDate: def.date, costMinor: def.cost, usefulLifeMonths: def.life, salvageMinor: def.salvage });
    const act = A.activate(d.id).asset;
    const m = modelFrom(def, act);
    model.set(act.id, m);
    truth.assets[act.tagCode] = { id: act.id, category: m.categoryKey, treatment: m.treatment };
  }

  // The plan's worked examples (only for the default start, where the hand-computed cents apply).
  const worked = start === '2025-01-01';
  let we41; let we42; let weImac;
  if (worked) {
    we41 = add({ cat: 'truck', name: '§4.1 truck', kind: 'purchase', date: '2025-03-12', cost: 2_400_000, life: 96, salvage: 240_000 });
    we42 = add({ cat: 'truck', name: '§4.2 / §5.4 truck', kind: 'opening', date: '2020-06-01', cost: 3_000_000, life: 120, salvage: 300_000 });
    weImac = add({ cat: 'computer', name: '§4.2 iMac (value at start)', kind: 'opening', deemed: true, cost: 60_000, life: 24, salvage: 5_000 });
  }

  add({ cat: 'land', name: 'Kampong Speu yard land', kind: 'opening', date: before(2012, 2016), cost: usd(85_000), branch: branches[4].id });
  const plot = add({ cat: 'land', name: 'Toul Kork shop plot', kind: 'opening', deemed: true, cost: usd(240_000), branch: branches[1].id });
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

  const live = () => [...model.entries()].filter(([, m]) => !m.gone).map(([id]) => id);
  const floorOf = (m) => later(m.opening ? start : m.purchaseDate, m.lastMove || '0000');
  const disposeModel = (m, d, proceedsUsd, lateFrom = null) => {
    m.gone = true;
    if (m.spec) {
      if (lateFrom) m.windows.push({ from: m.spec.startPeriod || startPeriod, to: book.addMonths(lateFrom, -1), end: null });
      m.spec.endPeriod = book.lastPeriod(d, conv);
      m.gain = proceedsUsd - sched(m, m.spec.endPeriod).nbvMinor;
    } else if (m.land) {
      m.gain = proceedsUsd - (m.revaluedTo ?? m.costUsd);
    }
    m.exit = { date: d, proceedsUsd };
  };
  const special = new Set([stands.id, shop.id, plot.id, ...(worked ? [we41.id, we42.id, weImac.id] : [])]);
  let latePlanted = false;

  for (let p = startPeriod; p <= lastMonth; p = book.addMonths(p, 1)) {
    const touched = new Set();
    const lag = p >= lagFrom;
    // Purchases.
    for (let i = 0, n = ri(3, 9); i < n; i += 1) {
      const kind = pick(['computer', 'computer', 'furniture', 'shelving', 'tools', 'tools', 'furniture']);
      const cheap = chance(0.25);
      const d = dateIn(p);
      const a = add({ cat: kind, name: `${kind} bought ${p} #${i + 1}`, kind: 'purchase', date: d, inService: chance(0.1) ? null : d, cost: usd(cheap ? ri(40, 290) : ri(320, 3500)), override: cheap && chance(0.2) ? true : null });
      touched.add(a.id);
    }
    if (p === book.addMonths(startPeriod, 3)) touched.add(add({ cat: 'leasehold', name: 'Siem Reap shop fit-out', kind: 'purchase', date: dateIn(p), cost: usd(18_000), life: 48, branch: branches[2].id }).id);
    if (p === book.addMonths(startPeriod, 5)) touched.add(add({ cat: 'truck', name: 'Hino delivery truck', kind: 'purchase', date: dateIn(p, 1, 15), cost: usd(42_000) }).id);
    if (p === book.addMonths(startPeriod, 7)) touched.add(add({ cat: 'plant', name: 'Forklift (riel)', kind: 'purchase', date: dateIn(p), cost: 61_500_000, currency: 'KHR' }).id);

    // In-service dates for things bought and stored.
    for (const id of live()) {
      const m = model.get(id);
      if (m.treatment === 'capitalised' && !m.spec.startPeriod && m.purchaseDate < `${p}-01` && chance(0.5)) {
        const d = dateIn(p);
        A.update(id, { inServiceDate: d });
        m.spec.startPeriod = book.firstPeriod(d, conv);
        touched.add(id);
      }
    }

    // Transfers: a date on or after the asset's floor and its last move — chosen, never retried.
    for (let i = 0, n = ri(2, 6); i < n; i += 1) {
      const id = pick(live().filter((x) => !touched.has(x)));
      if (!id) continue;
      const m = model.get(id);
      const d = dateIn(p, 16, 28);
      if (d < floorOf(m)) continue;
      A.transfer({ companyId: C, assetIds: [id], toBranchId: pick(branches).id, date: d, reason: 'Moved for the shop' });
      m.lastMove = d;
      touched.add(id);
      truth.events.push(['transfer', d]);
    }
    if (chance(0.6)) {
      const id = pick(live());
      const m = model.get(id);
      const d = dateIn(p);
      if (d >= floorOf(m)) A.recordRepair({ id, date: d, amountMinor: usd(ri(20, 250)), vendor: 'Local workshop', reason: 'Routine repair' });
    }

    const capitalisedLive = () => live().filter((id) => model.get(id).treatment === 'capitalised' && model.get(id).spec.startPeriod && model.get(id).spec.startPeriod <= p && !touched.has(id));
    // Improvements (capex) and life changes, dated after the asset's floor.
    if (chance(0.3)) {
      const id = pick(capitalisedLive());
      if (id) {
        const m = model.get(id);
        const d = dateIn(p);
        if (d >= floorOf(m)) {
          const amount = usd(ri(400, 4000));
          const extra = ri(6, 24);
          A.recordCapex({ id, date: d, amountMinor: amount, extendsLifeMonths: extra, reason: 'Upgrade' });
          m.spec.changes.push({ period: p, addBasisMinor: amount, extendMonths: extra });
          (m.capex ||= []).push({ date: d, amountUsd: amount });
          touched.add(id);
          truth.events.push(['capex', d, amount]);
        }
      }
    }
    if (chance(0.15)) {
      const id = pick(capitalisedLive());
      if (id) {
        const m = model.get(id);
        const d = dateIn(p);
        if (d >= floorOf(m)) {
          const n = ri(12, 48);
          A.changeLife({ id, date: d, newLifeMonths: n, reason: 'Lasting longer than expected' });
          m.spec.changes.push({ period: p, lifeMonths: n });
          touched.add(id);
        }
      }
    }
    if (p === book.addMonths(startPeriod, 9)) {
      const id = pick(capitalisedLive().filter((x) => model.get(x).categoryKey === 'kiln'));
      if (id) {
        const pos = book.positionAt(model.get(id).spec, p);
        const amount = Math.round(pos.nbvMinor / 4);
        disp.impair({ id, date: later(dateIn(p), floorOf(model.get(id))), amountMinor: amount, reason: 'Cracked chamber' });
        model.get(id).spec.changes.push({ period: p, impairMinor: amount });
        touched.add(id);
        planted.impairment = { tag: A.get(id).tagCode, amountMinor: amount };
      }
    }
    if (p === book.addMonths(startPeriod, 12)) {
      const value = usd(185_000);
      disp.revalue({ id: shop.id, date: later(dateIn(p), floorOf(model.get(shop.id))), newValueMinor: value, reason: 'Valuer\'s report (seed)' });
      model.get(shop.id).spec.changes.push({ period: p, revalueToMinor: value });
      touched.add(shop.id);
      planted.revaluation = { tag: shop.tagCode, newValueMinor: value };
    }
    if (p === book.addMonths(startPeriod, 6)) {
      const d = later(dateIn(p, 20, 28), floorOf(model.get(stands.id)));
      const m = model.get(stands.id);
      const last = book.lastPeriod(d, conv);
      const s = sched(m, last);
      const share = (v) => Math.round((v * 10) / 50);
      const r = disp.partialDispose({ id: stands.id, date: d, qty: 10, proceedsMinor: usd(3000), buyer: 'Market trader' });
      const salvageNow = book.positionAt(m.spec, book.addMonths(last, 1)).salvageMinor;
      m.spec.changes.push({ period: book.addMonths(last, 1), removeBasisMinor: share(s.basisMinor), removeAccumMinor: share(s.accumMinor), removeImpairMinor: share(s.impairedMinor), salvageMinor: salvageNow - share(salvageNow) });
      m.partial = { date: d, proceedsUsd: usd(3000) };
      touched.add(stands.id);
      planted.partialSale = { tag: stands.tagCode, qty: 10, gainMinor: usd(3000) - (share(s.basisMinor) - share(s.accumMinor) - share(s.impairedMinor)), appGainMinor: r.event.detail.gainMinor };
    }

    // Sales and scrapping (not of anything touched this month; none in the last month, whose run
    // is reversed and posted again below — a run cannot be reversed over a disposal it settled).
    for (let i = 0, n = p === lastMonth ? 0 : ri(0, 2); i < n; i += 1) {
      const id = pick(live().filter((x) => !special.has(x) && !touched.has(x)));
      if (!id) continue;
      const m = model.get(id);
      const d = dateIn(p);
      if (d < floorOf(m)) continue;
      const kind = chance(0.6) ? 'sale' : 'scrap';
      const proceeds = kind === 'sale' ? usd(ri(50, 2000)) : 0;
      const r = disp.dispose({ id, date: d, kind, proceedsMinor: proceeds, buyer: kind === 'sale' ? 'Buyer' : null });
      disposeModel(m, d, proceeds);
      m.appGain = r.event.detail.gainMinor;
      touched.add(id);
      truth.events.push(['dispose', d, m.tag]);
    }
    if (p === book.addMonths(startPeriod, 8) || p === book.addMonths(startPeriod, 10)) {
      const id = pick(capitalisedLive().filter((x) => model.get(x).categoryKey === 'computer'));
      if (id) {
        const m = model.get(id);
        const d = dateIn(p, 1, 10);
        if (d >= floorOf(m)) {
          disp.markLost({ id, date: d, reason: 'Not found at the count' });
          (planted.lost ||= []).push(m.tag);
          disposeModel(m, d, 0);
          m.lostAt = d;
          touched.add(id);
        }
      }
    }
    if (p === book.addMonths(startPeriod, 13) && planted.lost) {
      const m = model.get(truth.assets[planted.lost[0]].id);
      const d = dateIn(p);
      disp.markFound({ id: m.id, date: d, reason: 'Found in the Siem Reap store' });
      planted.found = m.tag;
      // Posted while it was lost: the schedule ended at the loss; from the month found, it runs again.
      m.windows.push({ from: book.addMonths(m.spec.endPeriod, 1), to: book.addMonths(p, -1), end: m.spec.endPeriod });
      m.gone = false;
      delete m.spec.endPeriod;
      delete m.gain;
      delete m.exit;
      touched.add(m.id);
    }

    // ---- the lag and reversal phase (the last four months) ----
    if (p === lagFrom) {
      // A disposal backdated into a month that is posted AND closed: booked on the 1st of this month.
      ledger.lockPeriod(C, book.addMonths(lagFrom, -2), 'Closed (seed lag phase)');
      const id = pick(live().filter((x) => !special.has(x) && !touched.has(x) && model.get(x).treatment === 'capitalised' && model.get(x).spec.startPeriod
        && model.get(x).spec.startPeriod <= book.addMonths(lagFrom, -4) && floorOf(model.get(x)) <= `${book.addMonths(lagFrom, -3)}-16`));
      const m = model.get(id);
      const d = dateIn(book.addMonths(lagFrom, -3), 16, 28);
      const r = disp.dispose({ id, date: d, kind: 'sale', proceedsMinor: usd(500) });
      disposeModel(m, d, usd(500), lagFrom);
      planted.lateDisposal = { tag: m.tag, date: d, bookedOn: r.entry.entryDate, memo: r.entry.memo };
      touched.add(id);
    }
    if (p === book.addMonths(lagFrom, 1)) {
      // A sale paid in riel, while the runs are behind.
      const id = pick(live().filter((x) => !special.has(x) && !touched.has(x) && model.get(x).treatment === 'capitalised'));
      const m = model.get(id);
      const d = later(dateIn(p), floorOf(m));
      const khr = 2_050_000;
      disp.dispose({ id, date: d, kind: 'sale', proceedsMinor: khr, currency: 'KHR' });
      disposeModel(m, d, Math.round((khr * 100) / HOUSE));
      m.exit.khr = khr;
      planted.rielSale = { tag: m.tag, proceedsKhr: khr, proceedsUsdMinor: Math.round((khr * 100) / HOUSE) };
      touched.add(id);
      // Land revalued DOWN (no surplus yet: all to P&L) …
      disp.revalue({ id: plot.id, date: dateIn(p), newValueMinor: usd(200_000), reason: 'Market fell (seed)' });
      model.get(plot.id).revaluedTo = usd(200_000);
      // … and an impairment that will be reversed.
      const k = pick(capitalisedLive().filter((x) => model.get(x).categoryKey === 'kiln'));
      const imp = disp.impair({ id: k, date: later(dateIn(p), floorOf(model.get(k))), amountMinor: usd(500), reason: 'Suspected crack (seed)' });
      planted.reversedImpairment = { tag: model.get(k).tag, eventId: imp.event.id };
    }
    if (p === book.addMonths(lagFrom, 2)) {
      // Land back UP: the earlier loss is reversed through P&L first, the rest to the surplus (IAS 16.39).
      disp.revalue({ id: plot.id, date: dateIn(p), newValueMinor: usd(250_000), reason: 'Market recovered (seed)' });
      model.get(plot.id).revaluedTo = usd(250_000);
      // The impairment was a mistake: reversed (a money-event reversal; no run posted on it).
      A.reverseEvent(planted.reversedImpairment.eventId, 'No crack after all (seed)');
    }
    if (worked && p === '2026-08') {
      // §5.4: the 2020 truck sold on 20 Aug 2026 for $9,000 — with the runs behind.
      const r = disp.dispose({ id: we42.id, date: '2026-08-20', kind: 'sale', proceedsMinor: 900_000, buyer: 'Mr Dara' });
      disposeModel(model.get(we42.id), '2026-08-20', 900_000);
      planted.workedSale = { nbvMinor: r.event.detail.nbvMinor, gainMinor: r.event.detail.gainMinor };
    }

    // The month is over: post it (catch-up included) — except during the lag phase.
    if (!lag) {
      for (const due of dep.dueMonths(C, p)) dep.runDepreciation(C, due, { kind: 'auto' });
      if (p === book.addMonths(startPeriod, 7)) { ledger.lockPeriod(C, book.addMonths(startPeriod, 5), 'Half year closed (seed)'); planted.closedThrough1 = book.addMonths(startPeriod, 5); }
      if (p === book.addMonths(startPeriod, 13)) { ledger.lockPeriod(C, book.addMonths(startPeriod, 11), 'Year closed (seed)'); planted.closedThrough2 = book.addMonths(startPeriod, 11); }
      if (p === book.addMonths(startPeriod, 14) && !latePlanted) {
        const late = add({ cat: 'computer', name: 'Late-entered server', kind: 'purchase', date: iso(y0, 11, 14), cost: usd(4800), life: 36 });
        const entry = ledger.getEntry(late.acquisitionEntryId);
        planted.lateEntry = { tag: late.tagCode, purchaseDate: iso(y0, 11, 14), postedOn: entry.entryDate, memo: entry.memo };
        // Posted before it was known: nothing, until the next run catches it up.
        const lm = model.get(late.id);
        lm.windows.push({ from: lm.spec.startPeriod, to: p, end: book.addMonths(lm.spec.startPeriod, -1) });
        latePlanted = true;
      }
    }
  }
  // The runs catch up; then the latest run is reversed and posted again.
  const caught = dep.dueMonths(C);
  for (const due of caught) dep.runDepreciation(C, due, { kind: 'manual' });
  dep.reverseRun(C, lastMonth, 'Checked again (seed)');
  dep.runDepreciation(C, lastMonth, { kind: 'manual' });
  planted.lagCatchUp = { months: caught, rerun: lastMonth };

  // ---- the checks ----
  const diffs = [];
  // 1. The worked examples, in hand-computed cents (§4.1, §4.2, §5.4).
  if (worked) {
    const posted = (id, p) => A.postedDepreciation(id, { throughPeriod: p });
    const we = [
      ['§4.1 truck: $225.00 a month from March 2025 — 10 months in 2025', posted(we41.id, '2025-12'), 225_000],
      ['§4.1 truck: 19 months to September 2026', posted(we41.id, '2026-09'), 427_500],
      ['§4.2 truck: accumulated on 1 Jan 2025 (55 months used)', A.get(we42.id).openingAccumMinor, 1_237_500],
      ['§4.2 truck: $225.00 a month in 2025', posted(we42.id, '2025-12'), 270_000],
      ['§5.4 sale on 20 Aug 2026: NBV', planted.workedSale.nbvMinor, 1_312_500],
      ['§5.4 sale: loss (proceeds $9,000 − NBV $13,125)', planted.workedSale.gainMinor, -412_500],
      ['§5.4 sale: 20 months charged, Jan 2025 – Aug 2026', A.postedDepreciation(we42.id), 450_000],
      ['§5.4 sale: nothing left on the books', Object.values(req('db/ledger').assetLedgerTotals(we42.id)).reduce((t, v) => t + Math.abs(v), 0), 0],
      ['§4.2 iMac (value at start): $550 over 24 months, 12 months in 2025', posted(weImac.id, '2025-12'), 27_500],
      ['§4.2 iMac: 21 months to September 2026', posted(weImac.id, '2026-09'), 48_125],
    ];
    for (const [what, actual, exp] of we) {
      truth.workedExamples.push({ what, expected: exp, actual, ok: actual === exp });
      if (actual !== exp) diffs.push({ field: `worked example: ${what}`, expected: exp, actual });
    }
  }
  // 2. Every month-end: posted = model, register = GL.
  const glNetAt = (date) => dbh.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS n FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.entry_date <= ? AND (a.system_key LIKE 'fa.cost.%' OR a.system_key LIKE 'fa.accum.%' OR a.system_key = 'fa.impairment')`).get(C, date).n;
  let monthEndChecks = 0;
  for (let p = startPeriod; p <= lastMonth; p = book.addMonths(p, 1)) {
    const end = dep.lastDayOf(p);
    for (const m of model.values()) {
      if (!m.spec) continue;
      const e = expectedPosted(m, p);
      const a = A.postedDepreciation(m.id, { throughPeriod: p });
      monthEndChecks += 1;
      if (e !== a) diffs.push({ asset: m.tag, monthEnd: end, field: 'depreciation posted', expected: e, actual: a });
    }
    const regEnd = reports.getReport(C, { kind: 'register', asOf: end }).totals.nbvMinor;
    const gl = glNetAt(end);
    if (regEnd !== gl) diffs.push({ monthEnd: end, field: 'register = GL', expected: gl, actual: regEnd });
  }
  // 3. Today: per asset and per category (the reversed impairment's mirror is dated today).
  const expected = { byCategory: {}, total: { costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 }, chargedMinor: 0, disposalGainMinor: 0 };
  for (const m of model.values()) {
    if (m.treatment === 'tracked_only') continue;
    if (m.exit) expected.disposalGainMinor += m.gain ?? 0;
    if (m.spec) {
      const s = sched(m, m.spec.endPeriod && m.spec.endPeriod < lastMonth ? m.spec.endPeriod : lastMonth);
      expected.chargedMinor += s.chargedMinor;
      if (m.gone) continue;
      m.expected = { costMinor: s.basisMinor, accumMinor: s.accumMinor, impairmentMinor: s.impairedMinor, nbvMinor: s.nbvMinor };
    } else if (m.land) {
      if (m.gone) continue;
      const v = m.revaluedTo ?? m.costUsd;
      m.expected = { costMinor: v, accumMinor: 0, impairmentMinor: 0, nbvMinor: v };
    }
    if (!m.expected) continue;
    const row = (expected.byCategory[m.categoryKey] ||= { costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 });
    for (const k of Object.keys(row)) { row[k] += m.expected[k]; expected.total[k] += m.expected[k]; }
  }
  if (planted.partialSale) expected.disposalGainMinor += planted.partialSale.gainMinor;
  truth.expected = expected;
  const reg = reports.getReport(C, { kind: 'register', asOf: today });
  const actualByCat = {};
  for (const r of reg.rows.filter((x) => !x.trackedOnly)) {
    const m = model.get(r.assetId);
    if (!m || !m.expected) { diffs.push({ asset: r.tagCode, problem: 'in the register but not expected' }); continue; }
    if (m.expected.costMinor !== r.costMinor || m.expected.accumMinor !== r.accumMinor || m.expected.impairmentMinor !== r.impairmentMinor || m.expected.nbvMinor !== r.nbvMinor) {
      diffs.push({ asset: r.tagCode, expected: m.expected, actual: { costMinor: r.costMinor, accumMinor: r.accumMinor, impairmentMinor: r.impairmentMinor, nbvMinor: r.nbvMinor } });
    }
    const key = config.getCategory(r.categoryId).builtinKey;
    const row = (actualByCat[key] ||= { costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 });
    row.costMinor += r.costMinor; row.accumMinor += r.accumMinor; row.impairmentMinor += r.impairmentMinor; row.nbvMinor += r.nbvMinor;
  }
  for (const k of new Set([...Object.keys(expected.byCategory), ...Object.keys(actualByCat)])) {
    for (const f of ['costMinor', 'accumMinor', 'impairmentMinor', 'nbvMinor']) {
      const e = expected.byCategory[k]?.[f] || 0;
      const a = actualByCat[k]?.[f] || 0;
      if (e !== a) diffs.push({ category: k, field: f, expected: e, actual: a });
    }
  }
  const depReport = reports.getReport(C, { kind: 'depreciation', to: today });
  if (depReport.totals.totalMinor !== expected.chargedMinor) diffs.push({ field: 'depreciation charged', expected: expected.chargedMinor, actual: depReport.totals.totalMinor });
  const ad = reports.getReport(C, { kind: 'additions_disposals', to: today });
  if (ad.totals.gainMinor !== expected.disposalGainMinor) diffs.push({ field: 'disposal gain / loss', expected: expected.disposalGainMinor, actual: ad.totals.gainMinor });
  // 4. Revaluation P&L and surplus (IAS 16.39): down $40,000 to P&L, then up $50,000 — $40,000 back through P&L, $10,000 surplus.
  const pl = dbh.prepare("SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS n FROM journal_lines WHERE asset_id = ? AND line_role = 'reval_pl'").get(plot.id).n;
  const surplus = ledger.assetLedgerTotals(plot.id).revaluationSurplusMinor;
  if (pl !== 0 || surplus !== usd(10_000)) diffs.push({ field: 'revaluation P&L / surplus', expected: { pl: 0, surplus: usd(10_000) }, actual: { pl, surplus } });
  // 5. The late entries.
  if (!/^Late entry for /.test(planted.lateEntry?.memo || '')) diffs.push({ field: 'late entry', detail: planted.lateEntry });
  if (planted.lateDisposal.bookedOn !== `${lagFrom}-01` || !/^Late disposal for /.test(planted.lateDisposal.memo)) diffs.push({ field: 'late disposal', detail: planted.lateDisposal });
  // 6. The tax view of the first year: pool additions and proceeds from the script's own riel rates.
  const t = taxv.getTaxYear(C, y0);
  for (const k of ['2', '3', '4']) {
    let additions = 0;
    let proceeds = 0;
    for (const m of model.values()) {
      if (m.treatment === 'tracked_only' || CLASS_OF[m.categoryKey] !== k) continue;
      if (!m.opening && m.purchaseDate && Number(m.purchaseDate.slice(0, 4)) === y0) additions += m.currency === 'KHR' ? m.rawCost : riel(m.costUsd, m.purchaseDate);
      for (const c of m.capex || []) if (Number(c.date.slice(0, 4)) === y0) additions += riel(c.amountUsd, c.date);
      if (m.exit && Number(m.exit.date.slice(0, 4)) === y0) proceeds += m.exit.khr ?? riel(m.exit.proceedsUsd, m.exit.date);
      if (m.partial && Number(m.partial.date.slice(0, 4)) === y0) proceeds += riel(m.partial.proceedsUsd, m.partial.date);
    }
    if (t.pools[k].additionsKhr !== additions) diffs.push({ field: `tax ${y0} class ${k} additions`, expected: additions, actual: t.pools[k].additionsKhr });
    if (t.pools[k].proceedsKhr !== proceeds) diffs.push({ field: `tax ${y0} class ${k} proceeds`, expected: proceeds, actual: t.pools[k].proceedsKhr });
  }
  truth.tax = { year: y0, pools: Object.fromEntries(Object.entries(t.pools).map(([k, p]) => [k, { openingWdvKhr: p.openingWdvKhr, openingLabel: p.openingLabel, additionsKhr: p.additionsKhr, proceedsKhr: p.proceedsKhr, depreciationKhr: p.depreciationKhr, closingWdvKhr: p.closingWdvKhr }])), notes: t.notes };
  if (y0 < Number(today.slice(0, 4))) {
    for (const k of ['2', '3', '4']) taxv.setPoolOpening(C, { year: y0, taxClass: k, openingWdvKhrMinor: t.pools[k].openingWdvKhr, isEstimate: true, confirmedByAccountant: true, sourceNote: 'Seed: the estimate, confirmed' });
    truth.tax.filed = !!taxv.markTaxYearFiled(C, y0).filed;
  }
  // 7. Integrity.
  const integrity = dep.checkIntegrity(C);
  if (!integrity.ok) diffs.push({ field: 'integrity', detail: { unbalanced: integrity.unbalanced.length, assets: integrity.assets, accounts: integrity.accounts, schedule: integrity.schedule, totals: integrity.totals } });

  truth.check = {
    ok: diffs.length === 0, diffs, asOf: today, monthEndChecks,
    totals: { expected: expected.total, actual: { costMinor: reg.totals.costMinor, accumMinor: reg.totals.accumMinor, impairmentMinor: reg.totals.impairmentMinor, nbvMinor: reg.totals.nbvMinor } },
    counts: { assets: A.list(C, { recordState: 'all', limit: 1 }).total, trackedOnly: reg.totals.trackedOnly, runs: dep.listRuns(C).months.filter((m) => m.status === 'posted').length, workedExamples: truth.workedExamples.length },
  };
  fs.writeFileSync(path.join(root, 'assets-truth.json'), JSON.stringify(truth, null, 2));
  log(`assets: ${truth.check.counts.assets} assets, ${truth.check.counts.runs} runs, ${monthEndChecks} month-end checks; check ${truth.check.ok ? 'OK' : `FAILED (${diffs.length} differences)`}`);
  return truth.check;
}

module.exports = { seedAssets };
