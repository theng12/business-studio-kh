/**
 * Fixed Assets A2 against a real database (docs/ASSETS_AND_BRANCHES_PLAN.md §4,
 * §5.4–5.5, §7, §8): monthly runs (computed − posted, catch-up, order,
 * reversal), disposals with gain / loss, partial disposals, lost / found,
 * impairment, revaluation, the tax year, reports, the workbook, the
 * background pass and the sub-ledger = GL check.
 *
 * Register start 1 Jan 2026 (§13a); "today" is the real date, so every month
 * used here has ended.
 *
 * RUNNING THIS. Real SQLite: `npm run test:native` (listed there explicitly).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
} catch (err) {
  if (err && (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err.message)))) {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

let counter = 0;
function fixture() {
  counter += 1;
  db.initDb(fs.mkdtempSync(path.join(os.tmpdir(), `msk-dep-${counter}-`)));
  const company = require('../main/db/companies').create({ name: `Dep Co ${counter}`, isActive: true });
  const m = {
    config: require('../main/db/assetConfig'), assets: require('../main/db/fixedAssets'), ledger: require('../main/db/ledger'),
    fx: require('../main/db/fxRates'), dep: require('../main/db/assetDepreciation'), disp: require('../main/db/assetDisposals'),
    taxv: require('../main/db/assetTax'), reports: require('../main/db/assetReports'), fuel: require('../main/db/fuel'),
  };
  m.fx.setRate({ companyId: company.id, rateDate: '2025-01-01', khrPerUsd: 4000 });
  m.config.ensureCategories(company.id);
  const C = company.id;
  const cat = (k) => m.config.categoryByKey(C, k).id;
  const runThrough = (p) => { for (const x of m.dep.dueMonths(C, p)) m.dep.runDepreciation(C, x); };
  const oldTruck = () => m.assets.activate(m.assets.create({ companyId: C, categoryId: cat('truck'), name: '2020 truck', acquisitionKind: 'opening',
    purchaseDate: '2020-06-01', costMinor: 3_000_000, usefulLifeMonths: 120, salvageMinor: 300_000 }).id).asset;
  return { company, C, cat, runThrough, oldTruck, ...m };
}

const lines = (e) => e.lines.map((l) => [l.accountKey, l.lineRole, l.debitMinor, l.creditMinor]);

test('runs: computed − posted, catch-up from the start, in order, idempotent, reversible (latest only)', { skip: skipReason }, () => {
  const { C, cat, assets, dep, ledger, oldTruck } = fixture();
  const truck = oldTruck(); // $225 / month from Jan 2026, 1,507,500 already used
  assert.equal(truck.openingAccumMinor, 1_507_500);
  const late = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Late iMac', purchaseDate: '2026-02-10', inServiceDate: '2026-02-10', costMinor: 360_000, usefulLifeMonths: 36 }).id).asset;
  assert.equal(dep.nextDuePeriod(C), '2026-01');
  assert.match(dep.previewDepreciation(C, '2026-03').reason, /Post January 2026 first/);
  assert.throws(() => dep.runDepreciation(C, '2026-03'), /Post January 2026 first/);
  const jan = dep.runDepreciation(C, '2026-01');
  assert.equal(jan.totalMinor, 22_500);
  assert.equal(jan.entry.entryDate, '2026-01-31');
  assert.equal(jan.entry.idempotencyKey, 'dep:2026-01');
  assert.throws(() => dep.runDepreciation(C, '2026-01'), /already posted/);
  assert.throws(() => dep.runDepreciation(C, require('../main/db/_assetUtil').todayPhnomPenh().slice(0, 7)), /has not ended|first/);
  const feb = dep.runDepreciation(C, '2026-02');
  assert.equal(feb.totalMinor, 22_500 + 10_000);
  // A purchase entered late (in April, dated February) is caught up.
  const lateEntry = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Forgotten printer', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 120_000, usefulLifeMonths: 12 }).id).asset;
  const mar = dep.runDepreciation(C, '2026-03');
  assert.equal(mar.monthMinor, 22_500 + 10_000 + 10_000);
  assert.equal(mar.catchUpMinor, 20_000, 'Jan + Feb for the printer');
  const catchLine = mar.entry.lines.find((l) => l.lineRole === 'dep_catch_up');
  assert.match(catchLine.memo, /catch-up January 2026–February 2026/);
  // Reversal: only the latest; then re-run with #2.
  assert.throws(() => dep.reverseRun(C, '2026-02', 'x'), /Only the latest run/);
  const rev = dep.reverseRun(C, '2026-03', 'Printer price wrong');
  assert.equal(rev.entry.entryDate, '2026-03-31');
  assert.equal(dep.nextDuePeriod(C), '2026-03');
  const again = dep.runDepreciation(C, '2026-03');
  assert.equal(again.entry.idempotencyKey, 'dep:2026-03#2');
  assert.equal(again.totalMinor, mar.totalMinor);
  // Snapshots follow the ledger; sub-ledger = GL.
  assert.equal(assets.get(truck.id).accumMinor, 1_507_500 + 3 * 22_500);
  assert.equal(assets.get(late.id).lastPostedPeriod, '2026-03');
  assert.equal(assets.get(lateEntry.id).nbvMinor, 120_000 - 30_000);
  const chk = dep.checkIntegrity(C);
  assert.equal(chk.ok, true, JSON.stringify(chk));
  const months = dep.listRuns(C).months;
  assert.equal(months.find((m) => m.period === '2026-03').status, 'posted');
  assert.equal(months.find((m) => m.period === '2026-04').status, 'due');
  assert.equal(ledger.checkIntegrity(C).unbalanced.length, 0);
});

test('disposal (§5.4): depreciation to the disposal, then cost and accumulated off, gain or loss', { skip: skipReason }, () => {
  const { C, assets, dep, disp, runThrough, oldTruck, fuel } = fixture();
  const truck = oldTruck();
  const type = fuel.listAssetTypes(C).find((t) => t.builtinKey === 'truck');
  const f = fuel.createAsset({ companyId: C, typeId: type.id, name: 'Linked' }, { skipRegister: true });
  require('../main/db/assetIdentity').link(truck.id, f.id);
  runThrough('2026-05');
  const preview = disp.previewDisposal({ id: truck.id, date: '2026-08-20', proceedsMinor: 900_000 });
  assert.equal(preview.depreciationDueMinor, 3 * 22_500, 'Jun–Aug: August counts (after the 15th)');
  assert.equal(preview.nbvMinor, 1_312_500);
  assert.equal(preview.gainMinor, -412_500);
  const r = disp.dispose({ id: truck.id, date: '2026-08-20', kind: 'sale', proceedsMinor: 900_000, buyer: 'Mr Dara' });
  assert.deepEqual(lines(r.entry), [
    ['fa.dep_expense', 'dep_expense', 67_500, 0], ['fa.accum.vehicle', 'accum_dep', 0, 67_500],
    ['fa.accum.vehicle', 'accum_disposal', 1_687_500, 0], ['fa.clearing.sale', 'clearing', 900_000, 0],
    ['fa.cost.vehicle', 'cost', 0, 3_000_000], ['fa.loss', 'loss', 412_500, 0],
  ]);
  assert.equal(r.asset.status, 'disposed');
  assert.equal(fuel.getAsset(f.id).status, 'retired', 'the Fuel vehicle is retired in the same transaction');
  runThrough('2026-09');
  assert.equal(assets.postedDepreciation(truck.id), 8 * 22_500, 'the later runs post nothing for it');
  assert.equal(dep.checkIntegrity(C).ok, true);
  // Reversing the sale brings it back (and the Fuel vehicle).
  const ev = assets.listEvents(C, { assetId: truck.id }).find((e) => e.kind === 'dispose');
  const back = assets.reverseEvent(ev.id, 'Sale fell through');
  assert.equal(back.asset.status, 'in_use');
  assert.equal(fuel.getAsset(f.id).status, 'active');
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('disposal dated in a month already posted takes the extra depreciation back; scrap is a loss of the NBV', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, runThrough } = fixture();
  const pc = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', purchaseDate: '2026-01-02', inServiceDate: '2026-01-02', costMinor: 120_000, usefulLifeMonths: 12 }).id).asset;
  runThrough('2026-09');
  const r = disp.dispose({ id: pc.id, date: '2026-07-10', kind: 'scrap' });
  assert.deepEqual(lines(r.entry).slice(0, 2), [['fa.accum.computer', 'accum_dep', 30_000, 0], ['fa.dep_expense', 'dep_catch_up', 0, 30_000]], 'Jul–Sep taken back (July does not count)');
  assert.equal(r.event.detail.nbvMinor, 60_000);
  assert.equal(r.event.detail.gainMinor, -60_000);
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('partial disposal of a group asset; lost and found; impairment', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, runThrough } = fixture();
  const stands = assets.activate(assets.create({ companyId: C, categoryId: cat('shelving'), name: '10 display stands', quantity: 10,
    purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 600_000, usefulLifeMonths: 60 }).id).asset;
  runThrough('2026-03');
  assert.throws(() => disp.partialDispose({ id: stands.id, date: '2026-03-20', qty: 4, proceedsMinor: 200_000 }), /posted through March 2026/);
  assert.throws(() => disp.partialDispose({ id: stands.id, date: '2026-04-20', qty: 10 }), /full disposal/);
  const p = disp.partialDispose({ id: stands.id, date: '2026-04-20', qty: 4, proceedsMinor: 200_000 });
  // April counts: 4 × $100 charged; 40 % of cost 240,000 and accum 16,000 leave; NBV share 224,000 → loss 24,000.
  assert.equal(p.event.detail.accumShareMinor, 16_000);
  assert.equal(p.event.detail.costShareMinor, 240_000);
  assert.equal(p.event.detail.gainMinor, -24_000);
  assert.equal(p.asset.quantity, 6);
  runThrough('2026-06');
  // From May: NBV 360,000 − 24,000 = 336,000 over 56 months = 6,000.
  assert.equal(assets.postedDepreciation(stands.id), 4 * 10_000 + 2 * 6_000);
  assert.equal(dep.checkIntegrity(C).ok, true);

  const mac = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'MacBook', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 240_000, usefulLifeMonths: 24 }).id).asset;
  runThrough('2026-06'); // nothing new is due for the stands; the Mac was entered late
  const lost = disp.markLost({ id: mac.id, date: '2026-07-10', reason: 'Not found at the count' });
  assert.equal(lost.asset.status, 'lost');
  assert.equal(lines(lost.entry).find((l) => l[1] === 'loss')[2], 240_000 - 6 * 10_000);
  runThrough('2026-08');
  assert.equal(assets.postedDepreciation(mac.id), 6 * 10_000);
  const found = disp.markFound({ id: mac.id, reason: 'Was in the car' });
  assert.equal(found.asset.status, 'in_use');
  runThrough('2026-09');
  assert.equal(assets.postedDepreciation(mac.id), 9 * 10_000, 'the missed months are caught up');
  assert.equal(dep.checkIntegrity(C).ok, true);

  assert.throws(() => disp.impair({ id: mac.id, date: '2026-10-01', amountMinor: 999_999, reason: 'x' }), /more than the book value/);
  const imp = disp.impair({ id: mac.id, date: '2026-10-01', amountMinor: 50_000, reason: 'Cracked screen' });
  assert.deepEqual(lines(imp.entry), [['fa.impairment_loss', 'loss', 50_000, 0], ['fa.impairment', 'impairment', 0, 50_000]]);
  assert.equal(imp.asset.nbvMinor, 240_000 - 90_000 - 50_000);
  // 100,000 left over 15 months from October.
  const s = assets.getSchedule(mac.id).rows.filter((r) => r.period >= '2026-10');
  assert.equal(s.reduce((t, r) => t + r.amountMinor, 0), 100_000);
  assert.equal(s.length, 15);
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('revaluation: land and buildings only, up to the surplus, down against it first', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, ledger } = fixture();
  const land = assets.activate(assets.create({ companyId: C, categoryId: cat('land'), name: 'Plot', purchaseDate: '2026-02-01', costMinor: 5_000_000 }).id).asset;
  const pc = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', purchaseDate: '2026-02-01', costMinor: 50_000, usefulLifeMonths: 12 }).id).asset;
  assert.throws(() => disp.revalue({ id: pc.id, date: '2026-05-01', newValueMinor: 1, reason: 'x' }), /Only land and buildings/);
  const up = disp.revalue({ id: land.id, date: '2026-05-01', newValueMinor: 6_000_000, reason: 'Valuer report' });
  assert.deepEqual(lines(up.entry), [['fa.cost.land', 'cost', 1_000_000, 0], ['equity.revaluation', 'revaluation', 0, 1_000_000]]);
  const down = disp.revalue({ id: land.id, date: '2026-06-01', newValueMinor: 4_500_000, reason: 'Market fell' });
  assert.deepEqual(lines(down.entry), [['fa.cost.land', 'cost', 0, 1_500_000], ['equity.revaluation', 'revaluation', 1_000_000, 0], ['fa.impairment_loss', 'loss', 500_000, 0]]);
  assert.equal(ledger.assetLedgerTotals(land.id).costMinor, 4_500_000);
  // A building: accumulated depreciation is eliminated, then the cost moves.
  const shop = assets.activate(assets.create({ companyId: C, categoryId: cat('building'), name: 'Shop', acquisitionKind: 'opening', costBasis: 'deemed', costMinor: 10_000_000, usefulLifeMonths: 200 }).id).asset;
  for (const p of dep.dueMonths(C, '2026-06')) dep.runDepreciation(C, p);
  const rv = disp.revalue({ id: shop.id, date: '2026-07-01', newValueMinor: 12_000_000, reason: 'Valuer' });
  assert.deepEqual(lines(rv.entry), [['fa.accum.building', 'accum_reval', 300_000, 0], ['fa.cost.building', 'cost', 2_000_000, 0], ['equity.revaluation', 'revaluation', 0, 2_300_000]]);
  // From July: $120,000 over the 194 months left.
  assert.equal(assets.getSchedule(shop.id).rows.filter((r) => r.period >= '2026-07').reduce((t, r) => t + r.amountMinor, 0), 12_000_000);
  for (const p of dep.dueMonths(C)) dep.runDepreciation(C, p);
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('the tax year: pools in riel with an estimated opening, per-asset Class 1, filing and "changed since filing"', { skip: skipReason }, () => {
  const { C, cat, assets, disp, taxv, fx, oldTruck, runThrough } = fixture();
  fx.setRate({ companyId: C, rateDate: '2020-01-01', khrPerUsd: 4050, source: 'official' });
  oldTruck(); // 2020, $30,000 → 121,500,000 ៛ into the estimate
  const truck = assets.activate(assets.create({ companyId: C, categoryId: cat('truck'), name: 'New truck', purchaseDate: '2026-03-12', inServiceDate: '2026-03-12', costMinor: 2_400_000, usefulLifeMonths: 96 }).id).asset;
  assets.activate(assets.create({ companyId: C, categoryId: cat('building'), name: 'Shop', purchaseDate: '2026-02-01', inServiceDate: '2026-02-01', costMinor: 10_000_000, usefulLifeMonths: 240 }).id);
  runThrough('2026-09');
  const t = taxv.getTaxYear(C, 2026);
  const p3 = t.pools['3'];
  assert.equal(p3.openingSource, 'estimate');
  assert.equal(p3.openingLabel, 'estimate — confirm with an accountant');
  // 121.5M through 2020–2025 at 25 %: × 0.75^6, rounded each year.
  let est = 121_500_000;
  for (let y = 2020; y <= 2025; y += 1) est -= Math.round(est * 0.25);
  assert.equal(p3.openingWdvKhr, est);
  assert.equal(p3.additionsKhr, 2_400_000 * 40.5);
  assert.equal(p3.depreciationKhr, Math.round((est + 97_200_000) * 0.25));
  const shop = t.perAsset.find((r) => r.name === 'Shop');
  assert.equal(shop.depreciationKhr, 20_250_000, '5 % of 405,000,000 ៛, a full year in the year bought');
  assert.ok(t.notes.some((n) => /estimate — confirm with an accountant/.test(n)));
  const bvt = t.bookVsTax.find((r) => r.taxClass === '3');
  assert.ok(bvt.bookUsdMinor > 0 && bvt.taxKhr === p3.depreciationKhr);
  assert.equal(bvt.differenceKhr, bvt.taxKhr - bvt.bookKhr);

  assert.throws(() => taxv.markTaxYearFiled(C, 2026), /estimate — confirm with an accountant/);
  assert.throws(() => taxv.setPoolOpening(C, { year: 2027, taxClass: '3', openingWdvKhrMinor: 1 }), /entered for 2026/);
  taxv.setPoolOpening(C, { year: 2026, taxClass: '3', openingWdvKhrMinor: 40_000_000, sourceNote: 'From the 2025 return' });
  assert.equal(taxv.getTaxYear(C, 2026).pools['3'].openingWdvKhr, 40_000_000);
  const filed = taxv.markTaxYearFiled(C, 2026);
  assert.ok(filed.filed);
  assert.deepEqual(filed.changedSinceFiling, []);
  // A fact changes after filing: the snapshot stays, the difference shows.
  disp.dispose({ id: truck.id, date: '2026-09-25', proceedsMinor: 2_000_000 });
  const after = taxv.getTaxYear(C, 2026);
  assert.ok(after.changedSinceFiling.some((c) => c.taxClass === '3' && c.field === 'proceedsKhr' && c.differenceKhr === 2_000_000 * 40.5));
  assert.equal(after.filedSnapshot.pools['3'].proceedsKhr, 0);
  assert.throws(() => taxv.setPoolOpening(C, { year: 2026, taxClass: '3', openingWdvKhrMinor: 1 }), /filed/);
  taxv.unfileTaxYear(C, 2026, 'Correction');
  assert.equal(taxv.getTaxYear(C, 2026).filed, null);
  // 2027 opens with 2026's closing.
  assert.equal(taxv.getTaxYear(C, 2027).pools['3'].openingWdvKhr, taxv.getTaxYear(C, 2026).pools['3'].closingWdvKhr);
});

test('reports agree with the ledger; the workbook has its seven sheets; the background pass posts what is due', { skip: skipReason }, async () => {
  const { C, cat, assets, dep, disp, reports, oldTruck } = fixture();
  oldTruck();
  const pc = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', purchaseDate: '2026-02-01', inServiceDate: '2026-02-01', costMinor: 120_000, usefulLifeMonths: 12 }).id).asset;
  assets.activate(assets.create({ companyId: C, categoryId: cat('furniture'), name: 'Chair', purchaseDate: '2026-02-01', costMinor: 10_000 }).id);
  const sched = await require('../main/assetScheduler').runOnce();
  assert.equal(sched.posted.length, dep.listRuns(C).months.filter((m) => m.status === 'posted').length);
  assert.deepEqual(dep.dueMonths(C), []);
  disp.dispose({ id: pc.id, date: '2026-06-20', proceedsMinor: 50_000 });
  const reg = reports.getReport(C, { kind: 'register', asOf: '2026-09-30' });
  const chk = dep.checkIntegrity(C);
  assert.equal(chk.ok, true);
  assert.equal(reg.totals.nbvMinor, chk.totals.glNetMinor);
  assert.equal(reg.totals.trackedOnly, 1);
  const mv = reports.getReport(C, { kind: 'movements', from: '2026-01-01', to: '2026-09-30' });
  assert.equal(mv.totals.costOpening + mv.totals.costAdditions + mv.totals.costDisposals + mv.totals.costRevaluation, mv.totals.costClosing);
  assert.equal(mv.totals.costOpening, 3_000_000);
  assert.equal(mv.totals.costAdditions, 120_000);
  assert.equal(mv.totals.costDisposals, -120_000);
  assert.equal(mv.totals.nbvClosing, reg.totals.nbvMinor);
  const depRep = reports.getReport(C, { kind: 'depreciation', from: '2026-01-01', to: '2026-12-31' });
  assert.equal(depRep.totals.totalMinor, mv.totals.accumCharge);
  const ad = reports.getReport(C, { kind: 'additions_disposals', from: '2026-01-01' });
  assert.equal(ad.rows.filter((r) => r.direction === 'out').length, 1);
  assert.equal(ad.totals.gainMinor, 50_000 - (120_000 - 5 * 10_000));
  assert.ok(reports.getReport(C, { kind: 'by_branch', asOf: '2026-09-30' }).rows.length >= 2);
  assert.throws(() => reports.getReport(C, { kind: 'nope' }), /Report must be/);
  const wb = reports.getWorkbook(C, { year: 2026 });
  const XLSX = require('xlsx');
  assert.deepEqual(XLSX.read(wb.bytes).SheetNames, ['Register', 'Movements', 'Book schedule', 'Tax pools', 'Book vs tax', 'Additions & disposals', 'Notes']);
});
