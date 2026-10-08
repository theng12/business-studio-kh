/**
 * Fixed Assets A0/A1 against a real database, a real data folder and the
 * real RPC server (docs/ASSETS_AND_BRANCHES_PLAN.md §3–§5, §9, §11, §13a).
 *
 *   1. Categories and settings seed per company with the owner's answers.
 *   2. Branches: unique code, one head office, close only when empty.
 *   3. Tags: allocated with a Damm check digit; claimed codes validated; never reused.
 *   4. Activation posts the §5.4 entries — purchase, opening with known cost
 *      (the plan's worked example to the cent), deemed opening, land, riel —
 *      and the $300 threshold with the per-asset tick.
 *   5. Active assets change through events: transfer (bulk), custodian, status,
 *      repair, capex (posted, reversible), life and salvage (prospective).
 *   6. Reversing an acquisition returns the asset to draft; it re-activates.
 *   7. The Fuel link: one-time drafts for existing vehicles, identity mirrored
 *      both ways, F1 untouched.
 *   8. Photos and documents are evidence under fixed-assets/, never assets/.
 *   9. Import: plan → apply, upsert by tag, never blanks a field.
 *  10. Company and supplier deletion guards; audit rows.
 *  11. /api/rpc with role tokens: view vs manage vs count vs editor vs admin.
 *
 * RUNNING THIS. Real SQLite + files: `npm run test:native` (listed there explicitly).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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
function fixture({ start = null } = {}) {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-assets-${counter}-`));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: `Chea Kim ${counter}`, isActive: true });
  const m = mods();
  if (start) m.config.updateSettings(company.id, { registerStartDate: start });
  return { dataDir, company, ...m };
}

function mods() {
  return {
    companies: require('../main/db/companies'),
    config: require('../main/db/assetConfig'),
    assets: require('../main/db/fixedAssets'),
    branches: require('../main/db/branches'),
    ledger: require('../main/db/ledger'),
    fx: require('../main/db/fxRates'),
    identity: require('../main/db/assetIdentity'),
    fileIndex: require('../main/db/assetFileIndex'),
    files: require('../main/assetFiles'),
    importer: require('../main/db/assetImport'),
    employees: require('../main/db/employees'),
    fuel: require('../main/db/fuel'),
    history: require('../main/db/fuelHistory'),
    suppliers: require('../main/db/suppliers'),
    tag: require('../main/util/assetTagCode'),
  };
}

const cat = (config, companyId, key) => config.categoryByKey(companyId, key);
const linesOf = (e) => e.lines.map((l) => [l.accountKey, l.debitMinor, l.creditMinor, l.lineRole]);

async function jpeg() {
  const sharp = require('sharp');
  return sharp({ create: { width: 1700, height: 900, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
}

test('categories and settings: the owner\'s answers, seeded once per company', { skip: skipReason }, () => {
  const { company, config, ledger } = fixture();
  const s = config.getSettings(company.id);
  assert.equal(s.registerStartDate, '2026-01-01', '§13a: 1 Jan 2026');
  assert.equal(s.capitalizationThresholdMinor, 30000, '§13a: $300');
  assert.equal(s.convention, 'mid_month');
  assert.equal(s.tagPrefix, 'CK', 'from "Chea Kim"');
  const cats = config.listCategories(company.id);
  assert.equal(cats.length, config.BUILTIN_CATEGORIES.length);
  config.ensureCategories(company.id);
  assert.equal(config.listCategories(company.id).length, cats.length, 'idempotent');
  const by = Object.fromEntries(cats.map((c) => [c.builtinKey, c]));
  assert.equal(by.building.taxClass, '1');
  assert.equal(by.land.bookMethod, 'none');
  assert.equal(by.land.taxClass, 'land');
  assert.equal(by.land.glAccumAccountId, null);
  assert.equal(by.leasehold.nameEn, 'Shop fit-outs (rented premises)');
  assert.equal(by.truck.taxClass, '3');
  assert.equal(by.computer.taxClass, '2');
  assert.equal(by.shelving.taxClass, '3');
  assert.equal(by.furniture.taxClass, '3');
  assert.equal(by.kiln.taxClass, '4');
  assert.ok(by.truck.isVehicle && by.plant.isVehicle && !by.computer.isVehicle);
  const acct = Object.fromEntries(ledger.listAccounts(company.id).map((a) => [a.id, a.systemKey]));
  assert.equal(acct[by.truck.glCostAccountId], 'fa.cost.vehicle');
  assert.equal(acct[by.truck.glAccumAccountId], 'fa.accum.vehicle');
  assert.equal(acct[by.kiln.glExpenseAccountId], 'fa.dep_expense');
  assert.throws(() => config.updateSettings(company.id, { registerStartDate: '2026-01-15' }), /first of a month/);
  config.updateSettings(company.id, { tagPrefix: 'ckt', capitalizationThresholdMinor: 50000 });
  assert.equal(config.getSettings(company.id).tagPrefix, 'CKT');
  const custom = config.createCategory({ companyId: company.id, nameEn: 'Solar panels', defaultLifeMonths: 120, taxClass: '4' });
  assert.equal(custom.isBuiltin, false);
  assert.equal(acct[custom.glCostAccountId], 'fa.cost.machinery');
});

test('branches: code unique per company, one head office, closed only when empty', { skip: skipReason }, () => {
  const { company, branches, assets, config } = fixture();
  const pp = branches.create({ companyId: company.id, code: 'pp1', nameEn: 'Phnom Penh', isHeadOffice: true });
  assert.equal(pp.code, 'PP1');
  assert.throws(() => branches.create({ companyId: company.id, code: 'PP1', nameEn: 'Again' }), /already used/);
  const sr = branches.create({ companyId: company.id, code: 'SR1', nameEn: 'Siem Reap', isHeadOffice: true });
  assert.equal(branches.get(pp.id).isHeadOffice, false, 'at most one head office');
  assert.equal(sr.isHeadOffice, true);
  const a = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'computer').id, name: 'iMac', branchId: sr.id });
  assert.throws(() => branches.close(sr.id, 'Lease ended'), /still has 1 asset/);
  assets.update(a.id, { branchId: pp.id });
  const closed = branches.close(sr.id, 'Lease ended');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.isHeadOffice, false);
  assert.throws(() => assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'computer').id, name: 'x', branchId: sr.id }), /closed/);
  assert.deepEqual(branches.list(company.id).map((b) => b.code), ['PP1']);
  assert.equal(branches.update(sr.id, { status: 'active' }).status, 'active', 'reopen');
  assert.throws(() => branches.update(sr.id, { status: 'closed' }), /Close a branch/);
  const actions = db.getDb().prepare("SELECT action FROM audit_log WHERE entity_type = 'branch' AND entity_id = ? ORDER BY id").all(sr.id).map((r) => r.action);
  assert.deepEqual(actions, ['create', 'close', 'update']);
});

test('tags: Damm-checked, claimed codes validated, retired codes never reused', { skip: skipReason }, () => {
  const { company, assets, config, tag } = fixture();
  const comp = cat(config, company.id, 'computer').id;
  const a1 = assets.create({ companyId: company.id, categoryId: comp, name: 'Laptop' });
  assert.equal(a1.tagCode, 'CK-00013');
  assert.ok(tag.parseTagCode(a1.tagCode).ok);
  const a2 = assets.create({ companyId: company.id, categoryId: comp, name: 'Printer' });
  assert.equal(a2.tagSeq, 2);
  const claimed = assets.create({ companyId: company.id, categoryId: comp, name: 'Pre-printed', tagCode: 'ck-04270' });
  assert.equal(claimed.tagCode, 'CK-04270');
  assert.equal(assets.create({ companyId: company.id, categoryId: comp, name: 'Next' }).tagSeq, 428, 'allocation continues after the highest');
  assert.throws(() => assets.create({ companyId: company.id, categoryId: comp, name: 'Bad', tagCode: 'CK-04273' }), /check digit/);
  assert.throws(() => assets.create({ companyId: company.id, categoryId: comp, name: 'Dup', tagCode: 'CK-04270' }), /already on another asset/);
  const retagged = assets.update(a1.id, { retag: true, retagReason: 'Sticker peeled off' });
  assert.notEqual(retagged.tagCode, 'CK-00013');
  assert.throws(() => assets.create({ companyId: company.id, categoryId: comp, name: 'Reuse', tagCode: 'CK-00013' }), /retired/);
  assert.throws(() => assets.update(a2.id, { retag: true }), /why/);
  // A cancelled draft keeps its code; the code is not handed out again.
  const c = assets.cancelDraft(a2.id, 'Duplicate entry');
  assert.equal(c.recordState, 'cancelled');
  assert.ok(assets.create({ companyId: company.id, categoryId: comp, name: 'After' }).tagSeq > 428);
  assert.throws(() => assets.update(a2.id, { name: 'x' }), /cancelled/);
  // A category's own prefix.
  const veh = config.updateCategory(cat(config, company.id, 'truck').id, { tagPrefix: 'vh' });
  assert.match(assets.create({ companyId: company.id, categoryId: veh.id, name: 'Truck' }).tagCode, /^VH-/);
});

test('activation, purchase: Dr Vehicles / Cr purchases clearing; $225 a month from March', { skip: skipReason }, () => {
  const { company, assets, config, ledger } = fixture();
  const truck = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'truck').id, name: 'Isuzu truck',
    purchaseDate: '2026-03-12', inServiceDate: '2026-03-12', costMinor: 2_400_000, usefulLifeMonths: 96, salvageMinor: 240_000 });
  assert.equal(truck.recordState, 'draft');
  const preview = assets.previewActivation(truck.id);
  assert.equal(preview.treatment, 'capitalised');
  assert.equal(preview.entryDate, '2026-03-12');
  const { asset, entry } = assets.activate(truck.id);
  assert.equal(asset.recordState, 'active');
  assert.equal(asset.depreciationStartPeriod, '2026-03');
  assert.equal(asset.nbvMinor, 2_400_000);
  assert.deepEqual(linesOf(entry), [['fa.cost.vehicle', 2_400_000, 0, 'cost'], ['fa.clearing.purchase', 0, 2_400_000, 'clearing']]);
  assert.equal(entry.sourceKind, 'asset_acquire');
  assert.ok(entry.lines.every((l) => l.assetId === truck.id));
  const sched = assets.getSchedule(truck.id, 'book');
  assert.equal(sched.rows.length, 96);
  assert.ok(sched.rows.every((r) => r.amountMinor === 22_500 && r.postedMinor === 0));
  assert.equal(sched.rows.filter((r) => r.period.startsWith('2026')).reduce((t, r) => t + r.amountMinor, 0), 225_000, '10 months in 2026');
  const t = assets.getSchedule(truck.id, 'tax');
  assert.equal(t.pooled, true);
  assert.equal(t.taxClass, '3');
  assert.equal(asset.taxCostKhrMinor, 2_400_000 * 41, 'riel at the (house) rate, 4,100');
  assert.match(asset.taxFxSource, /\(house\)/, 'no official rate yet: labelled');
  assert.throws(() => assets.activate(truck.id), /already active/);
  const ev = assets.listEvents(company.id, { assetId: truck.id });
  assert.deepEqual(ev.map((e) => e.kind), ['acquire']);
  assert.equal(ev[0].journalEntryId, entry.id);
  assert.deepEqual(ledger.assetLedgerTotals(truck.id), { costMinor: 2_400_000, accumDepMinor: 0, impairmentMinor: 0, revaluationSurplusMinor: 0 });
  // Bought before the register start → it is an opening asset, not a purchase.
  const old = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'truck').id, name: 'Old', purchaseDate: '2025-06-01', costMinor: 100_000, usefulLifeMonths: 60 });
  assert.throws(() => assets.activate(old.id), /Already owned/);
  const noCost = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'truck').id, name: 'No cost' });
  assert.throws(() => assets.activate(noCost.id), /Add the cost/);
});

test('§4.2 worked example through the tables: known-cost opening on 1 Jan 2027', { skip: skipReason }, () => {
  const { company, assets, config, ledger } = fixture({ start: '2027-01-01' });
  const t = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'truck').id, name: '2020 truck', acquisitionKind: 'opening',
    purchaseDate: '2020-06-01', costMinor: 3_000_000, usefulLifeMonths: 120, salvageMinor: 300_000 });
  const { asset, entry } = assets.activate(t.id);
  assert.equal(entry.entryDate, '2026-12-31', 'the day before the register start');
  assert.equal(entry.sourceKind, 'asset_open');
  assert.deepEqual(linesOf(entry), [
    ['fa.cost.vehicle', 3_000_000, 0, 'cost'], ['fa.accum.vehicle', 0, 1_777_500, 'accum_dep'], ['equity.opening', 0, 1_222_500, 'equity'],
  ]);
  assert.equal(asset.openingAccumMinor, 1_777_500);
  assert.equal(asset.nbvMinor, 1_222_500);
  assert.equal(asset.scheduleLifeMonths, 41);
  assert.equal(asset.costBasis, 'actual');
  const s = assets.getSchedule(t.id, 'book');
  assert.equal(s.startPeriod, '2027-01');
  assert.equal(s.rows.length, 41);
  assert.ok(s.rows.every((r) => r.amountMinor === 22_500));
  // The start date is now fixed.
  assert.throws(() => config.updateSettings(company.id, { registerStartDate: '2026-01-01' }), /can no longer change/);
  assert.deepEqual(ledger.assetLedgerTotals(t.id), { costMinor: 3_000_000, accumDepMinor: 1_777_500, impairmentMinor: 0, revaluationSurplusMinor: 0 });
  // An "old" asset that came into use after the start is refused as an opening.
  assert.throws(() => assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'truck').id, name: 'Late', acquisitionKind: 'opening', purchaseDate: '2027-02-01', costMinor: 100, usefulLifeMonths: 10 }), /cannot be in the future/);
});

test('deemed opening (iMac $600, 24 months left), land, and a purchase paid in riel', { skip: skipReason }, () => {
  const { company, assets, config, fx } = fixture();
  const imac = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'computer').id, name: 'iMac 2022', acquisitionKind: 'opening',
    costBasis: 'deemed', costMinor: 60_000, usefulLifeMonths: 24, salvageMinor: 5_000 });
  const a = assets.activate(imac.id);
  assert.deepEqual(linesOf(a.entry), [['fa.cost.computer', 60_000, 0, 'cost'], ['equity.opening', 0, 60_000, 'equity']]);
  assert.equal(a.asset.costBasis, 'deemed');
  const rows = assets.getSchedule(imac.id, 'book').rows;
  assert.equal(rows.length, 24);
  assert.ok(rows.every((r) => r.amountMinor === 2291 || r.amountMinor === 2292));
  assert.equal(rows[0].period, '2026-01');

  const land = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'land').id, name: 'Shop plot', purchaseDate: '2026-02-01', costMinor: 5_000_000 });
  const l = assets.activate(land.id);
  assert.equal(l.asset.accountingTreatment, 'not_depreciated');
  assert.deepEqual(linesOf(l.entry), [['fa.cost.land', 5_000_000, 0, 'cost'], ['fa.clearing.purchase', 0, 5_000_000, 'clearing']]);
  assert.equal(assets.getSchedule(land.id, 'book').rows.length, 0);
  assert.match(assets.getSchedule(land.id, 'book').note, /land/);

  // A preview never writes (no rate is seeded by looking).
  const khrDraft = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'kiln').id, name: 'Preview only', purchaseDate: '2026-04-20', costMinor: 4_100_000, costCurrency: 'KHR' });
  const ratesBefore = fx.list(company.id, { includeVoided: true }).length;
  assert.equal(assets.previewActivation(khrDraft.id).costUsdMinor, 100_000);
  assert.equal(fx.list(company.id, { includeVoided: true }).length, ratesBefore);
  // Riel: 4,100,000 ៛ at 4,100 = $1,000; the cost line keeps the real riel paid.
  fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 4100 });
  const kiln = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'kiln').id, name: 'Kiln', purchaseDate: '2026-04-20',
    inServiceDate: '2026-05-10', costMinor: 4_100_000, costCurrency: 'KHR' });
  const k = assets.activate(kiln.id);
  assert.equal(k.asset.costUsdMinor, 100_000);
  assert.equal(k.entry.lines[0].khrMinor, 4_100_000);
  assert.equal(k.entry.lines[0].txnCurrency, 'KHR');
  assert.equal(k.asset.salvageMinor, 5_000, 'the category\'s 5 %');
  assert.equal(k.asset.depreciationStartPeriod, '2026-05');
  assert.equal(k.asset.taxCostKhrMinor, 4_100_000, 'paid in riel: the riel itself');
});

test('§13a threshold: $300 by default, the "Depreciate this item" tick overrides it either way', { skip: skipReason }, () => {
  const { company, assets, config } = fixture();
  const furn = cat(config, company.id, 'furniture').id;
  const mk = (name, cost, override) => assets.create({ companyId: company.id, categoryId: furn, name, purchaseDate: '2026-02-03', inServiceDate: '2026-02-03', costMinor: cost, depreciateOverride: override });
  const chair = assets.activate(mk('Chair', 25_000, null).id);
  assert.equal(chair.asset.accountingTreatment, 'tracked_only');
  assert.equal(chair.entry, null, 'never posted');
  assert.equal(assets.getSchedule(chair.asset.id, 'book').rows.length, 0);
  assert.equal(chair.asset.taxCostKhrMinor, null, 'not in the tax figures');
  const ticked = assets.activate(mk('Good chair', 25_000, true).id);
  assert.equal(ticked.asset.accountingTreatment, 'capitalised');
  assert.ok(ticked.entry);
  const desk = assets.activate(mk('Desk', 50_000, false).id);
  assert.equal(desk.asset.accountingTreatment, 'tracked_only');
  assert.equal(assets.activate(mk('Shelf', 30_000, null).id).asset.accountingTreatment, 'capitalised', 'exactly $300 is capitalised');
  assert.throws(() => assets.recordCapex({ id: chair.asset.id, amountMinor: 50_000, reason: 'x', date: '2026-05-01' }), /tracked, not capitalised/);
});

test('active assets change through events; voids restore; capex posts and reverses', { skip: skipReason }, () => {
  const { company, assets, config, branches, employees, ledger, fx } = fixture();
  fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 4100 });
  const pp = branches.create({ companyId: company.id, code: 'PP1', nameEn: 'Phnom Penh' });
  const sr = branches.create({ companyId: company.id, code: 'SR1', nameEn: 'Siem Reap' });
  const sok = employees.create({ companyId: company.id, staffCode: 'S1', nameEn: 'Sok' });
  const dara = employees.create({ companyId: company.id, staffCode: 'S2', nameEn: 'Dara' });
  const comp = cat(config, company.id, 'computer').id;
  const mk = (name) => assets.activate(assets.create({ companyId: company.id, categoryId: comp, name, branchId: pp.id, custodianEmployeeId: sok.id,
    purchaseDate: '2026-02-01', inServiceDate: '2026-02-01', costMinor: 120_000, usefulLifeMonths: 12 }).id).asset;
  const a = mk('POS 1');
  const b = mk('POS 2');
  assert.throws(() => assets.update(a.id, { branchId: sr.id }), /Transfer/);
  assert.throws(() => assets.update(a.id, { costMinor: 1 }), /through events/);
  assert.equal(assets.update(a.id, { serialNo: 'SN-1', notes: 'Front desk' }).serialNo, 'SN-1', 'paperwork stays editable');
  assert.equal(assets.update(a.id, { name: 'POS 1', costMinor: 120_000, branchId: pp.id, usefulLifeMonths: 12 }).name, 'POS 1', 'a whole-form save with unchanged money passes');

  // Bulk transfer: one event per asset, one batch.
  const tr = assets.transfer({ companyId: company.id, assetIds: [a.id, b.id], toBranchId: sr.id, toEmployeeId: dara.id, date: '2026-06-01', reason: 'New shop' });
  assert.equal(tr.moved.length, 2);
  assert.equal(assets.get(a.id).branchId, sr.id);
  assert.equal(assets.get(a.id).custodianEmployeeId, dara.id);
  const events = assets.listEvents(company.id, { batchId: tr.batchId });
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.fromBranchId === pp.id && e.toBranchId === sr.id));
  assert.equal(assets.transfer({ companyId: company.id, assetIds: [a.id], toBranchId: sr.id, date: '2026-06-02' }).unchanged.length, 1);
  assert.throws(() => assets.transfer({ companyId: company.id, assetIds: [a.id], date: '2026-06-02' }), /Choose the branch/);
  assert.throws(() => assets.transfer({ companyId: company.id, assetIds: [a.id], toBranchId: sr.id, date: '2099-01-01' }), /future/);

  // Void the transfer of b → back in Phnom Penh with Sok.
  const bEvent = events.find((e) => e.assetId === b.id);
  assets.voidEvent(bEvent.id, 'Wrong POS moved');
  assert.equal(assets.get(b.id).branchId, pp.id);
  assert.equal(assets.get(b.id).custodianEmployeeId, sok.id);
  assert.throws(() => assets.voidEvent(bEvent.id + 'x', 'r'), /not found/);

  // A later custodian change blocks voiding the earlier transfer.
  const cust = assets.setCustodian({ id: a.id, employeeId: sok.id, date: '2026-06-05', reason: 'Back to Sok' });
  assert.ok(cust.eventId);
  assert.throws(() => assets.voidEvent(events.find((e) => e.assetId === a.id).id, 'r'), /later change/);
  const st = assets.setStatus({ id: a.id, status: 'in_repair', date: '2026-06-06', reason: 'Screen' });
  assert.equal(st.asset.status, 'in_repair');
  assets.voidEvent(st.eventId, 'Was fine');
  assert.equal(assets.get(a.id).status, 'in_use');
  assert.throws(() => assets.setStatus({ id: a.id, status: 'disposed' }), /Status must be one of: in_use, in_storage, in_repair/);

  // Repair: history only. Capex below the threshold is refused; above it posts.
  const rep = assets.recordRepair({ id: a.id, date: '2026-06-07', amountMinor: 4_500, vendor: 'Phone shop', reason: 'New screen' });
  assert.equal(rep.event.journalEntryId, null);
  assert.throws(() => assets.voidEvent(rep.event.id, ''), /reason/);
  assert.throws(() => assets.recordCapex({ id: a.id, date: '2026-06-08', amountMinor: 29_999, reason: 'RAM' }), /repair/);
  const cap = assets.recordCapex({ id: a.id, date: '2026-07-01', amountMinor: 60_000, extendsLifeMonths: 6, reason: 'New board' });
  assert.deepEqual(linesOf(cap.entry), [['fa.cost.computer', 60_000, 0, 'cost'], ['fa.clearing.purchase', 0, 60_000, 'clearing']]);
  assert.equal(cap.asset.nbvMinor, 180_000);
  // Schedule: $100 × 5 (Feb–Jun), then NBV $1,200 at July over 7 + 6 = 13 months.
  const s = assets.getSchedule(a.id, 'book');
  assert.deepEqual(s.rows.slice(0, 5).map((r) => r.amountMinor), [10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(s.rows.length, 5 + 13);
  assert.equal(s.rows.slice(5).reduce((t, r) => t + r.amountMinor, 0), 130_000);
  assert.throws(() => assets.voidEvent(cap.event.id, 'r'), /reverse it instead/);
  const rev = assets.reverseEvent(cap.event.id, 'Board was under warranty');
  assert.equal(rev.entry.reversesEntryId, cap.entry.id);
  assert.equal(rev.asset.nbvMinor, 120_000);
  assert.equal(assets.getSchedule(a.id, 'book').rows.length, 12, 'a reversed capex no longer counts');
  assert.throws(() => assets.reverseEvent(cap.event.id, 'again'), /already been undone/);

  // Life and salvage changes are prospective, need a reason, and void cleanly before anything posts.
  assert.throws(() => assets.changeLife({ id: b.id, newLifeMonths: 24, date: '2026-08-01' }), /reason/);
  const lc = assets.changeLife({ id: b.id, newLifeMonths: 24, date: '2026-08-01', reason: 'Lasting longer' });
  const sb = assets.getSchedule(b.id, 'book');
  assert.deepEqual(sb.rows.slice(0, 6).map((r) => r.amountMinor), [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(sb.rows.length, 6 + 24);
  assets.voidEvent(lc.event.id, 'Changed my mind');
  assert.equal(assets.getSchedule(b.id, 'book').rows.length, 12);
  const sc = assets.changeSalvage({ id: b.id, newSalvageMinor: 30_000, date: '2026-08-01', reason: 'Resale value' });
  assert.equal(assets.getSchedule(b.id, 'book').endNbvMinor, 30_000);
  assert.ok(sc.event);
  assets.addNote({ id: b.id, text: 'Sticker on the back' });
  assert.deepEqual(ledger.checkIntegrity(company.id).unbalanced, []);
});

test('reversing an acquisition sends the asset back to draft; it activates again with a fresh entry', { skip: skipReason }, () => {
  const { company, assets, config, ledger } = fixture();
  const a = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'truck').id, name: 'Truck', purchaseDate: '2026-03-01', inServiceDate: '2026-03-01', costMinor: 2_400_000, usefulLifeMonths: 96 });
  const first = assets.activate(a.id);
  const acq = assets.listEvents(company.id, { assetId: a.id }).find((e) => e.kind === 'acquire');
  const cap = assets.recordCapex({ id: a.id, date: '2026-04-01', amountMinor: 100_000, reason: 'Body' });
  assert.throws(() => assets.reverseEvent(acq.id, 'Wrong cost'), /reverse those first/);
  assets.reverseEvent(cap.event.id, 'Undo');
  const back = assets.reverseEvent(acq.id, 'Typed 24,000 instead of 42,000');
  assert.equal(back.asset.recordState, 'draft');
  assert.equal(back.asset.nbvMinor, null);
  assert.equal(back.entry.reversesEntryId, first.entry.id);
  assets.update(a.id, { costMinor: 4_200_000 });
  const again = assets.activate(a.id);
  assert.notEqual(again.entry.id, first.entry.id);
  assert.equal(again.entry.totalMinor, 4_200_000);
  assert.deepEqual(ledger.assetLedgerTotals(a.id), { costMinor: 4_200_000, accumDepMinor: 0, impairmentMinor: 0, revaluationSurplusMinor: 0 });
});

test('the Fuel link: one-time drafts for existing vehicles, identity mirrored both ways', { skip: skipReason }, () => {
  const { company, assets, fuel, identity, employees, branches } = fixture();
  const driver = employees.create({ companyId: company.id, staffCode: 'D1', nameEn: 'Sok', isDriver: true });
  const other = employees.create({ companyId: company.id, staffCode: 'D2', nameEn: 'Dara', isDriver: true });
  const types = Object.fromEntries(fuel.listAssetTypes(company.id).map((t) => [t.builtinKey, t]));
  const truck = fuel.createAsset({ companyId: company.id, typeId: types.truck.id, name: 'Truck 1', plateOrSerial: '3A-1234', assignedEmployeeId: driver.id, homeLocation: 'Farm' });
  const fork = fuel.createAsset({ companyId: company.id, typeId: types.forklift.id, name: 'Forklift', plateOrSerial: 'FL-77' });
  const retired = fuel.createAsset({ companyId: company.id, typeId: types.motorbike.id, name: 'Old moto' });
  fuel.updateAsset(retired.id, { status: 'retired' });
  assert.equal(assets.list(company.id).total, 0, 'nothing happens before Assets is opened');

  assert.equal(identity.ensureFuelLinked(company.id), 3);
  assert.equal(identity.ensureFuelLinked(company.id), 0, 'one-time');
  const list = assets.list(company.id);
  assert.equal(list.counts.fromFuelNeedsCost, 3);
  const regTruck = list.items.find((x) => x.fuelAssetId === truck.id);
  assert.equal(regTruck.categoryKey, 'truck');
  assert.equal(regTruck.plateNo, '3A-1234');
  assert.equal(regTruck.custodianEmployeeId, driver.id);
  assert.equal(regTruck.needsCost, true);
  assert.equal(regTruck.origin, 'fuel');
  assert.match(regTruck.notes, /Fuel home location: Farm/);
  assert.equal(regTruck.branchId, null, 'home_location is never turned into a branch');
  const regFork = list.items.find((x) => x.fuelAssetId === fork.id);
  assert.equal(regFork.categoryKey, 'plant');
  assert.equal(list.items.find((x) => x.fuelAssetId === retired.id).status, 'in_storage');

  // After the link, a new fuel vehicle gets its draft in the same transaction.
  const car = fuel.createAsset({ companyId: company.id, typeId: types.car_van.id, name: 'Van' });
  assert.equal(assets.list(company.id).items.find((x) => x.fuelAssetId === car.id).categoryKey, 'car');

  // Register → fuel.
  const pp = branches.create({ companyId: company.id, code: 'PP1', nameEn: 'Phnom Penh' });
  assets.update(regTruck.id, { name: 'Isuzu 1', plateNo: '3A-9999', branchId: pp.id });
  const f1 = fuel.getAsset(truck.id);
  assert.deepEqual([f1.name, f1.plateOrSerial], ['Isuzu 1', '3A-9999']);
  assert.equal(db.getDb().prepare('SELECT branch_id FROM fuel_assets WHERE id = ?').get(truck.id).branch_id, pp.id);

  // Fuel → register; a driver change on an ACTIVE asset is a custodian event.
  assets.update(regTruck.id, { purchaseDate: '2026-02-01', inServiceDate: '2026-02-01', costMinor: 2_000_000, usefulLifeMonths: 96 });
  assets.activate(regTruck.id);
  fuel.updateAsset(truck.id, { plateOrSerial: '3B-0001', assignedEmployeeId: other.id });
  const after = assets.get(regTruck.id);
  assert.equal(after.plateNo, '3B-0001');
  assert.equal(after.custodianEmployeeId, other.id);
  assert.equal(assets.listEvents(company.id, { assetId: regTruck.id, kind: 'custodian' })[0].reason, 'Driver changed in Fuel');
  // A transfer in the register moves the fuel driver too.
  assets.setCustodian({ id: regTruck.id, employeeId: driver.id, reason: 'Back' });
  assert.equal(fuel.getAsset(truck.id).assignedEmployeeId, driver.id);
  // F1 keeps working on its own columns.
  assert.equal(fuel.listAssets(company.id, { status: 'all' }).length, 4);

  // Link / unlink by hand.
  assert.throws(() => identity.link(regFork.id, truck.id), /already linked/);
  identity.unlink(regFork.id, 'Wrong machine');
  assert.equal(assets.get(regFork.id).fuelAssetId, null);
  identity.link(regFork.id, fork.id);
  assert.equal(fuel.getAsset(fork.id).name, 'Forklift');
  // Cancelling a fuel draft lets the vehicle go.
  const moto = assets.list(company.id).items.find((x) => x.fuelAssetId === retired.id);
  assets.cancelDraft(moto.id, 'Scrapped years ago');
  assert.equal(assets.get(moto.id).fuelAssetId, null);
});

test('photos and documents are evidence under fixed-assets/, never assets/', { skip: skipReason }, async () => {
  const { dataDir, company, assets, config, files, fileIndex } = fixture();
  const a = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'computer').id, name: 'iMac' });
  const add = async (kind, bytes) => {
    const prepared = await files.prepareFile(kind, bytes);
    const staged = files.stageFile({ assetId: a.id, kind, prepared });
    let f;
    db.getDb().transaction(() => { f = fileIndex.insert({ companyId: company.id, assetId: a.id, row: staged.row }); })();
    staged.commit();
    return f;
  };
  const p1 = await add('photo', await jpeg());
  const p2 = await add('photo', await jpeg());
  assert.match(p1.relPath, /^fixed-assets\/files\/\d{4}-\d{2}\/.+-photo\.jpg$/);
  assert.ok(fs.existsSync(path.join(dataDir, p1.relPath)));
  assert.ok(!fs.existsSync(path.join(dataDir, 'assets')) || !fs.readdirSync(path.join(dataDir, 'assets')).length, 'nothing written under assets/');
  assert.equal(p1.width, 1600, 'resized to fit 1600 px');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const inv = await add('invoice', pdf);
  assert.equal(inv.mime, 'application/pdf');
  assert.equal(fs.readFileSync(path.join(dataDir, inv.relPath)).toString(), pdf.toString(), 'a PDF is kept byte for byte');
  await assert.rejects(files.prepareFile('photo', pdf), /not a PDF/);
  await assert.rejects(files.prepareFile('selfie', pdf), /File kind/);
  const read = await files.readFile(p1.relPath, { expectedSha256: p1.sha256 });
  assert.equal(read.intact, true);
  const thumb = await files.readFile(p1.relPath, { thumb: true });
  assert.ok(thumb.bytes.length < read.bytes.length);
  assert.equal(assets.get(a.id).mainPhotoId, p1.id);
  fileIndex.reorderPhotos(a.id, [p2.id, p1.id]);
  assert.equal(assets.get(a.id).mainPhotoId, p2.id);
  assert.throws(() => fileIndex.reorderPhotos(a.id, [p2.id]), /each of the asset's photos once/);
  fileIndex.retire(p2.id, 'Blurry');
  assert.equal(assets.get(a.id).mainPhotoId, p1.id);
  assert.ok(fs.existsSync(path.join(dataDir, p2.relPath)), 'a retired file keeps its bytes');
  assert.equal(fileIndex.list(a.id).length, 2);
  assert.equal(fileIndex.list(a.id, { includeRetired: true }).length, 3);
  assert.equal(fileIndex.publicFile(p1).relPath, undefined, 'screens never see the disk path');
  assert.throws(() => files.absPath('fuel/x.jpg'), /outside the fixed-assets folder/);
});

test('import: plan → apply, upsert by tag, only filled cells, active money refused', { skip: skipReason }, () => {
  const { company, assets, config, branches, employees, importer, fuel, suppliers } = fixture();
  const pp = branches.create({ companyId: company.id, code: 'PP1', nameEn: 'Phnom Penh' });
  const sr = branches.create({ companyId: company.id, code: 'SR1', nameEn: 'Siem Reap' });
  employees.create({ companyId: company.id, staffCode: 'S1', nameEn: 'Sok' });
  suppliers.create({ companyId: company.id, name: 'Lucky Motors' });
  const types = Object.fromEntries(fuel.listAssetTypes(company.id).map((t) => [t.builtinKey, t]));
  fuel.createAsset({ companyId: company.id, typeId: types.truck.id, name: 'Fuel truck', plateOrSerial: '2B 5555' }, { skipRegister: true });
  const existing = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'furniture').id, name: 'Desk', serialNo: 'D-1', notes: 'Keep me', branchId: pp.id });
  const active = assets.activate(assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'computer').id, name: 'Server', branchId: pp.id,
    purchaseDate: '2026-02-01', inServiceDate: '2026-02-01', costMinor: 200_000, usefulLifeMonths: 36 }).id).asset;
  const rows = [
    { name: 'Isuzu', category: 'Trucks', branch: 'pp1', custodian: 's1', purchase_date: '01/06/2020', cost: '30,000', useful_life_months: '120', salvage: '3000', plate_no: '2B-5555', fuel_vehicle: '2B5555', supplier: 'lucky motors' },
    { tag_code: 'CK-04270', name: 'Pre-tagged shelf', category: 'Shop shelving & display fixtures', value_at_start: '450', remaining_life_months: '36' },
    { tag_code: existing.tagCode, location_note: 'Back office', notes: '' },
    { name: 'Desk', serial_no: 'D-1', make_model: 'IKEA' },
    { tag_code: active.tagCode, cost: '99', branch: 'SR1', status: 'in repair' },
    { tag_code: 'CK-04273', name: 'Bad check digit', category: 'Trucks' },
    { tag_code: 'CK-04270', name: 'Twice', category: 'Trucks' },
    { name: 'No category' },
    { name: 'Wrong branch', category: 'Trucks', branch: 'XX9' },
    { name: 'Dated', category: 'Trucks', purchase_date: '31/02/2026' },
    {},
  ];
  const plan = importer.planImport(company.id, rows);
  assert.deepEqual(plan.rows.map((r) => r.action), ['create', 'create', 'update', 'update', 'update', 'error', 'error', 'error', 'error', 'error', 'skip']);
  assert.equal(plan.rows[0].values.acquisitionKind, 'opening', 'bought before the start → opening');
  assert.equal(plan.rows[0].values.costMinor, 3_000_000);
  assert.equal(plan.rows[0].values.purchaseDate, '2020-06-01', 'day/month/year');
  assert.equal(plan.rows[1].values.costBasis, 'deemed');
  assert.match(plan.rows[4].warnings.join(' '), /Cost not changed: .* is active/);
  assert.deepEqual(plan.rows[4].events.map((e) => e.kind), ['transfer', 'status']);
  assert.match(plan.rows[5].errors[0], /check digit/);
  assert.match(plan.rows[6].errors[0], /appears twice/);
  assert.match(plan.rows[9].errors[0], /not a real date/);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM fixed_assets').get().n, 2, 'a plan writes nothing');

  const res = importer.applyImport(company.id, rows);
  assert.deepEqual([res.created, res.updated, res.failed, res.skipped], [2, 3, 5, 1]);
  const isuzu = assets.get(res.rows[0].assetId);
  assert.equal(isuzu.recordState, 'draft', 'imports are drafts');
  assert.equal(isuzu.origin, 'import');
  assert.equal(isuzu.branchId, pp.id);
  assert.ok(isuzu.fuelAssetId, 'linked to the Fuel truck by plate');
  assert.equal(isuzu.supplierName, 'Lucky Motors');
  assert.equal(assets.getByTag(company.id, 'CK-04270').name, 'Pre-tagged shelf');
  const desk = assets.get(existing.id);
  assert.equal(desk.locationNote, 'Back office');
  assert.equal(desk.notes, 'Keep me', 'an empty cell never blanks a field');
  assert.equal(desk.makeModel, 'IKEA', 'matched by name + serial');
  const server = assets.get(active.id);
  assert.equal(server.costMinor, 200_000);
  assert.equal(server.branchId, sr.id);
  assert.equal(server.status, 'in_repair');
  assert.deepEqual(assets.listEvents(company.id, { assetId: active.id }).map((e) => e.kind).sort(), ['acquire', 'status', 'transfer']);
  // The imported opening activates with the §4.2 figures for a 1 Jan 2026 start: 67 months used.
  const act = assets.activate(isuzu.id);
  assert.equal(act.asset.openingAccumMinor, 1_507_500);
  assert.equal(act.asset.scheduleLifeMonths, 53);

  const sample = importer.sampleWorkbook(company.id);
  const XLSX = require('xlsx');
  const wb = XLSX.read(sample.bytes);
  assert.deepEqual(wb.SheetNames, ['Assets', 'Instructions', 'Categories', 'Branches']);
  const header = XLSX.utils.sheet_to_json(wb.Sheets.Assets, { header: 1 })[0];
  assert.deepEqual(header, importer.IMPORT_COLUMNS.map((c) => c.key));
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.Branches, { header: 1 }).length, 3);
});

test('guards: company and supplier deletion, audit for every write', { skip: skipReason }, () => {
  const { company, assets, config, history, suppliers, companies } = fixture();
  const sup = suppliers.create({ companyId: company.id, name: 'Shelf maker' });
  const a = assets.create({ companyId: company.id, categoryId: cat(config, company.id, 'shelving').id, name: 'Shelf', supplierId: sup.id });
  assert.throws(() => suppliers.remove(sup.id), /fixed asset record/);
  assert.throws(() => history.assertCompanyRemovable(company.id), /1 fixed asset/);
  assert.throws(() => companies.remove(company.id));
  assets.update(a.id, { name: 'Wall shelf' });
  const actions = db.getDb().prepare("SELECT action FROM audit_log WHERE entity_type = 'fixed_asset' AND entity_id = ? ORDER BY id").all(a.id).map((r) => r.action);
  assert.deepEqual(actions, ['create', 'update']);
  const types = db.getDb().prepare('SELECT DISTINCT entity_type FROM audit_log').all().map((r) => r.entity_type);
  assert.ok(types.includes('fixed_asset'));
});

/* ─── the real RPC server, with role tokens ─────────────────────── */

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('/api/rpc: assets.view reads, assets.manage writes, assets.count sees photos only, the Editor is refused', { skip: skipReason }, async (t) => {
  const { company, config, fuel } = fixture();
  const users = require('../main/db/users');
  const roles = require('../main/db/roles');
  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getVersion: () => '0.0.0-assets' }, ipcMain: { handle() {}, on() {} } },
  };
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const helpers = require('../main/ipc/helpers');
  require('../main/ipc/assets').register(helpers);
  require('../main/ipc/branches').register(helpers);
  require('../main/ipc/ledger').register(helpers);
  require('../main/ipc/fuel').register(helpers);
  require('../main/ipc/audit').register(helpers);
  const server = require('../main/server');
  const port = await freePort();
  await server.bootServer({ port, dataDir: db.getDataDir(), wsHeartbeatMs: 60000 });
  t.after(() => server.stopServer());

  const role = (name, permissions) => users.create({ name, role: roles.create({ name, permissions }).key });
  const viewer = role('Asset viewer', ['assets.view']);
  const manager = role('Asset manager', ['assets.manage']);
  const counter = role('Counter', ['assets.count']);
  const editor = users.create({ name: 'Editor', role: 'editor' });
  const admin = users.create({ name: 'Admin', role: 'admin' });
  const types = Object.fromEntries(fuel.listAssetTypes(company.id).map((x) => [x.builtinKey, x]));
  fuel.createAsset({ companyId: company.id, typeId: types.truck.id, name: 'Truck from Fuel', plateOrSerial: '3A-1' });

  const call = async (token, channel, args) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args }),
    });
    const body = await res.json();
    return { status: res.status, body };
  };
  const ok = async (token, channel, args) => {
    const r = await call(token, channel, args);
    assert.equal(r.status, 200, `${channel}: ${r.status} ${r.body.error}`);
    return r.body.result;
  };
  const forbidden = async (token, channel, args) => {
    const r = await call(token, channel, args);
    assert.equal(r.status, 403, `${channel} should be refused, got ${r.status}`);
  };

  // The manager: categories, create, activate, add a photo and an invoice.
  const cats = await ok(manager.token, 'assets:listCategories', {});
  const truckCat = cats.find((c) => c.builtinKey === 'truck');
  const firstList = await ok(manager.token, 'assets:list', {});
  assert.equal(firstList.counts.fromFuelNeedsCost, 1, 'the first assets:* call links Fuel');
  const created = await ok(manager.token, 'assets:create', { categoryId: truckCat.id, name: 'Hino', purchaseDate: '2026-03-12', inServiceDate: '2026-03-12', costMinor: 2_400_000, usefulLifeMonths: 96, salvageMinor: 240_000, origin: 'fuel', needsCost: true });
  assert.equal(created.origin, 'manual', 'internal fields are stripped');
  const act = await ok(manager.token, 'assets:activate', created.id);
  assert.equal(act.entry.totalMinor, 2_400_000);
  const enc = (buf) => ({ __bin: true, b64: Buffer.from(buf).toString('base64') });
  const photo = await ok(manager.token, 'assets:addFile', { assetId: created.id, kind: 'photo', bytes: enc(await jpeg()) });
  const pdf = await ok(manager.token, 'assets:addFile', { assetId: created.id, kind: 'invoice', bytes: enc(Buffer.from('%PDF-1.4\n%%EOF')) });
  assert.equal(photo.relPath, undefined);
  const bad = await call(manager.token, 'assets:addFile', { assetId: created.id, kind: 'selfie', bytes: enc(Buffer.from('x')) });
  assert.match(bad.body.error, /Bad request: kind must be/);

  // The viewer reads everything, with values, and writes nothing.
  const got = await ok(viewer.token, 'assets:get', created.id);
  assert.equal(got.costUsdMinor, 2_400_000);
  assert.equal(got.files.length, 2);
  assert.equal((await ok(viewer.token, 'assets:getSchedule', { id: created.id, basis: 'book' })).rows[0].amountMinor, 22_500);
  assert.equal((await ok(viewer.token, 'ledger:entriesForAsset', created.id)).length, 1);
  assert.ok((await ok(viewer.token, 'assets:getFile', { fileId: pdf.id })).bytes);
  for (const [ch, args] of [['assets:create', { categoryId: truckCat.id, name: 'x' }], ['assets:update', { id: created.id, patch: { name: 'x' } }],
    ['assets:activate', created.id], ['assets:transfer', { assetIds: [created.id], toBranchId: 'b' }], ['assets:importApply', { rows: [] }], ['assets:addFile', { assetId: created.id, kind: 'photo', bytes: enc(Buffer.from('x')) }],
    ['assets:updateSettings', { tagPrefix: 'ZZ' }], ['ledger:updateAccount', { id: 'x', patch: {} }], ['fx:setRate', { rateDate: '2026-01-01', khrPerUsd: 4100 }]]) {
    await forbidden(viewer.token, ch, args);
  }

  // The counter: photos only; no register, no values, no documents.
  const ph = await ok(counter.token, 'assets:getFile', { fileId: photo.id, thumb: true });
  assert.ok(ph.bytes);
  const doc = await call(counter.token, 'assets:getFile', { fileId: pdf.id });
  assert.equal(doc.status, 500);
  assert.match(doc.body.error, /only see asset photos/);
  const VALID = { 'assets:list': {}, 'assets:get': created.id, 'ledger:listAccounts': {}, 'assets:create': { categoryId: truckCat.id, name: 'x' }, 'assets:getFile': { fileId: photo.id } };
  for (const ch of ['assets:list', 'assets:get', 'ledger:listAccounts', 'assets:create']) await forbidden(counter.token, ch, VALID[ch]);

  // The Editor preset has none of the asset capabilities; branch names are baseline.
  for (const ch of ['assets:list', 'assets:get', 'assets:getFile', 'ledger:listAccounts', 'assets:create']) await forbidden(editor.token, ch, VALID[ch]);
  assert.deepEqual(await ok(editor.token, 'branches:list', {}), []);
  await forbidden(editor.token, 'branches:create', { code: 'PP1', nameEn: 'Phnom Penh' });
  await forbidden(manager.token, 'branches:create', { code: 'PP1', nameEn: 'Phnom Penh' });
  assert.ok((await ok(viewer.token, 'fx:rateOn', { date: '2026-03-12' })).rate);

  // Admin only: locking a month; making Fuel vehicles needs fuel.manage too.
  await forbidden(manager.token, 'ledger:lockPeriod', { period: '2026-03' });
  assert.deepEqual(await ok(admin.token, 'ledger:lockPeriod', { period: '2026-03' }), { period: '2026-03', status: 'locked', closedThrough: '2026-03' });
  const fuelTry = await call(manager.token, 'assets:createFuelAsset', { id: created.id, typeId: types.truck.id });
  assert.match(fuelTry.body.error, /Manage fuel/);
  assert.ok((await ok(admin.token, 'assets:createFuelAsset', { id: created.id, typeId: types.truck.id })).fuelAsset.id);
  // A category with posted assets: tax class is the admin's.
  const upd = await call(manager.token, 'assets:updateCategory', { id: truckCat.id, patch: { taxClass: '4' } });
  assert.match(upd.body.error, /only an admin/);
  assert.equal((await ok(admin.token, 'assets:updateCategory', { id: truckCat.id, patch: { taxClass: '4' } })).taxClass, '4');
  assert.equal(config.getCategory(truckCat.id).taxClass, '4');

  // A2: the viewer previews and reads; posting is the manager's; filing a tax year is the admin's.
  assert.equal((await ok(viewer.token, 'assets:previewDepreciation', { period: '2026-03' })).period, '2026-03');
  assert.ok((await ok(viewer.token, 'assets:listRuns', {})).months.length);
  assert.ok((await ok(viewer.token, 'assets:getTaxYear', { year: 2026 })).pools['3']);
  assert.ok((await ok(viewer.token, 'assets:getReport', { kind: 'register' })).rows.length);
  assert.ok((await ok(viewer.token, 'assets:getWorkbook', { year: 2026 })).bytes);
  await forbidden(viewer.token, 'assets:runDepreciation', { period: '2026-04' });
  await forbidden(manager.token, 'assets:markTaxYearFiled', { year: 2026 });
  const posted = await ok(manager.token, 'assets:runDepreciation', { period: (await ok(manager.token, 'assets:listRuns', {})).nextDuePeriod });
  assert.ok(posted.run);

  // History (review M6): a History reader without assets.view never sees asset or ledger rows.
  const historyOnly = role('History reader', ['history.view']);
  const historyAndAssets = role('History + assets', ['history.view', 'assets.view']);
  const auditTypes = async (token) => (await ok(token, 'audit:listRecent', { limit: 500 })).map((r) => r.entityType);
  const blind = await auditTypes(historyOnly.token);
  for (const t of ['fixed_asset', 'journal_entry', 'asset_event', 'depreciation_run']) assert.ok(!blind.includes(t), t);
  assert.equal(await ok(historyOnly.token, 'audit:countForEntity', { entityType: 'fixed_asset', entityId: created.id }), 0);
  const sees = await auditTypes(historyAndAssets.token);
  assert.ok(sees.includes('fixed_asset') && sees.includes('journal_entry'));
});
