/**
 * Fixed Assets: the review findings of 2026-10-08, each pinned against a real
 * database (H1, H2, M1–M7, L1–L4, L6). Pure parts (L3) run here too.
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
  db.initDb(fs.mkdtempSync(path.join(os.tmpdir(), `msk-review-${counter}-`)));
  const company = require('../main/db/companies').create({ name: `Review Co ${counter}`, isActive: true });
  const m = {
    config: require('../main/db/assetConfig'), assets: require('../main/db/fixedAssets'), ledger: require('../main/db/ledger'),
    fx: require('../main/db/fxRates'), dep: require('../main/db/assetDepreciation'), fuel: require('../main/db/fuel'),
    identity: require('../main/db/assetIdentity'), importer: require('../main/db/assetImport'), branches: require('../main/db/branches'),
    audit: require('../main/db/auditLog'),
  };
  m.fx.setRate({ companyId: company.id, rateDate: '2025-01-01', khrPerUsd: 4000 });
  m.config.ensureCategories(company.id);
  return { company, C: company.id, cat: (k) => m.config.categoryByKey(company.id, k).id, ...m };
}

const monthEnds = (from, to) => {
  const out = [];
  const book = require('../main/util/bookDepreciation');
  for (let p = from; p <= to; p = book.addMonths(p, 1)) out.push(require('../main/db/assetDepreciation').lastDayOf(p));
  return out;
};
const costAt = (assetId, date) => db.getDb().prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS n FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id WHERE l.asset_id = ? AND l.line_role = 'cost' AND e.entry_date <= ?`).get(assetId, date).n;

test('H1: reverse → correct → re-activate never counts the cost twice at any month-end', { skip: skipReason }, () => {
  const { C, cat, assets, dep, ledger } = fixture();
  // An opening (dated the day before the start) and a purchase, both corrected after months of depreciation.
  const open = assets.activate(assets.create({ companyId: C, categoryId: cat('car'), name: 'Van', acquisitionKind: 'opening', costBasis: 'deemed', costMinor: 500_000, usefulLifeMonths: 24 }).id).asset;
  const buy = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Server', purchaseDate: '2026-02-03', inServiceDate: '2026-02-03', costMinor: 120_000, usefulLifeMonths: 12 }).id).asset;
  for (const p of ['2026-01', '2026-02', '2026-03', '2026-04']) dep.runDepreciation(C, p);
  for (const [a, cost] of [[open, 600_000], [buy, 240_000]]) {
    const ev = assets.listEvents(C, { assetId: a.id }).find((e) => ['open', 'acquire'].includes(e.kind));
    const back = assets.reverseEvent(ev.id, 'Wrong value typed');
    assert.equal(back.entry.entryDate, ledger.getEntry(ev.journalEntryId).entryDate, 'the mirror is dated the original entry date');
    assert.equal(back.asset.recordState, 'draft');
    assets.update(a.id, { costMinor: cost });
    assets.activate(a.id);
  }
  for (const d of monthEnds('2025-12', '2026-09')) {
    assert.equal(costAt(open.id, d), 600_000, `van cost at ${d}`);
    assert.equal(costAt(buy.id, d), d < '2026-02-03' ? 0 : 240_000, `server cost at ${d}`);
  }
  // The depreciation already posted was taken back; the next run catches up on the corrected figures.
  assert.equal(assets.postedDepreciation(open.id), 0);
  dep.runDepreciation(C, '2026-05');
  assert.equal(assets.postedDepreciation(open.id), 5 * 22_500, 'Jan–May at $225 / month: ($6,000 − 10 % salvage) over 24');
  assert.equal(assets.postedDepreciation(buy.id), 4 * 20_000, 'Feb–May at $200 / month');
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('H2: the one-time in-service date is for purchases only, never before the purchase or the start', { skip: skipReason }, () => {
  const { C, cat, assets } = fixture();
  const deemed = assets.activate(assets.create({ companyId: C, categoryId: cat('truck'), name: 'Old truck', acquisitionKind: 'opening', costBasis: 'deemed', costMinor: 1_200_000, usefulLifeMonths: 24 }).id).asset;
  assert.throws(() => assets.update(deemed.id, { inServiceDate: '2020-05-03' }), /through events/);
  const known = assets.activate(assets.create({ companyId: C, categoryId: cat('truck'), name: 'Truck 2', acquisitionKind: 'opening', purchaseDate: '2020-06-01', costMinor: 3_000_000, usefulLifeMonths: 120, salvageMinor: 300_000 }).id).asset;
  assert.throws(() => assets.update(known.id, { inServiceDate: '2020-06-01' }), /through events/);
  assert.equal(assets.get(known.id).depreciationStartPeriod, '2026-01');
  const stored = assets.activate(assets.create({ companyId: C, categoryId: cat('kiln'), name: 'Kiln', purchaseDate: '2026-03-01', costMinor: 1_000_000, usefulLifeMonths: 120 }).id).asset;
  assert.equal(stored.depreciationStartPeriod, null, 'bought, not in use yet');
  assert.throws(() => assets.update(stored.id, { inServiceDate: '2026-02-01' }), /before the purchase date/);
  assert.throws(() => assets.update(stored.id, { inServiceDate: '2099-01-01' }), /future/);
  assert.equal(assets.update(stored.id, { inServiceDate: '2026-04-20' }).depreciationStartPeriod, '2026-05');
  assert.throws(() => assets.update(stored.id, { inServiceDate: '2026-04-25' }), /through events/, 'once only');
});

test('M1: a fully used-up old asset with no salvage opens with no zero line', { skip: skipReason }, () => {
  const { C, cat, assets } = fixture();
  const r = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: '2018 iMac', acquisitionKind: 'opening', purchaseDate: '2018-03-01', costMinor: 150_000, usefulLifeMonths: 36 }).id);
  assert.deepEqual(r.entry.lines.map((l) => [l.accountKey, l.debitMinor, l.creditMinor]), [['fa.cost.computer', 150_000, 0], ['fa.accum.computer', 0, 150_000]]);
  assert.equal(r.asset.nbvMinor, 0);
});

test('M2: an improvement to an asset with no life left must add months', { skip: skipReason }, () => {
  const { C, cat, assets, dep } = fixture();
  const a = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Old PC', acquisitionKind: 'opening', purchaseDate: '2022-01-01', costMinor: 100_000, usefulLifeMonths: 36 }).id).asset;
  assert.equal(a.scheduleLifeMonths, 0);
  assert.throws(() => assets.recordCapex({ id: a.id, date: '2026-06-01', amountMinor: 50_000, reason: 'New board' }), /no months of life left — say how many months/);
  const ok = assets.recordCapex({ id: a.id, date: '2026-06-01', amountMinor: 60_000, extendsLifeMonths: 12, reason: 'New board' });
  assert.equal(assets.getSchedule(a.id).rows.length, 12);
  assert.equal(assets.getSchedule(a.id).rows[0].amountMinor, 5_000);
  assert.ok(ok.entry);
  for (const p of dep.dueMonths(C)) dep.runDepreciation(C, p);
  assert.equal(assets.postedDepreciation(a.id), 4 * 5_000, 'Jun–Sep');
});

test('M3: an archived category never breaks creating a vehicle in Fuel', { skip: skipReason }, () => {
  const { C, cat, config, fuel, identity, assets } = fixture();
  identity.ensureFuelLinked(C);
  config.updateCategory(cat('truck'), { archived: true });
  const truckType = fuel.listAssetTypes(C).find((t) => t.builtinKey === 'truck');
  const f = fuel.createAsset({ companyId: C, typeId: truckType.id, name: 'New truck', plateOrSerial: '3A-9999' });
  assert.ok(f.id);
  const draft = assets.list(C).items.find((x) => x.fuelAssetId === f.id);
  assert.equal(draft.categoryKey, 'truck', 'the Fuel link bypasses the archived check');
  assert.throws(() => assets.create({ companyId: C, categoryId: cat('truck'), name: 'By hand' }), /archived/, 'a person still cannot pick it');
});

test('M4: salvage and riel rate filled in by activation are cleared when it is undone', { skip: skipReason }, () => {
  const { C, cat, assets, fx } = fixture();
  const t = assets.create({ companyId: C, categoryId: cat('truck'), name: 'T', purchaseDate: '2026-03-02', costMinor: 500_000, usefulLifeMonths: 96 });
  const r1 = assets.activate(t.id);
  assert.equal(r1.asset.salvageMinor, 50_000, 'the category\'s 10 %');
  assets.reverseEvent(assets.listEvents(C, { assetId: t.id }).find((e) => e.kind === 'acquire').id, 'typo in cost');
  assert.equal(assets.get(t.id).salvageMinor, null);
  assets.update(t.id, { costMinor: 5_000_000 });
  assert.equal(assets.activate(t.id).asset.salvageMinor, 500_000, 'worked out again from the corrected cost');
  // A typed salvage is kept.
  const typed = assets.create({ companyId: C, categoryId: cat('truck'), name: 'T2', purchaseDate: '2026-03-02', costMinor: 500_000, usefulLifeMonths: 96, salvageMinor: 1_000 });
  assets.activate(typed.id);
  assets.reverseEvent(assets.listEvents(C, { assetId: typed.id }).find((e) => e.kind === 'acquire').id, 'redo');
  assert.equal(assets.get(typed.id).salvageMinor, 1_000);

  fx.setRate({ companyId: C, rateDate: '2026-06-01', khrPerUsd: 4100 });
  const k = assets.create({ companyId: C, categoryId: cat('computer'), name: 'K', purchaseDate: '2026-02-02', costMinor: 8_000_000, costCurrency: 'KHR', usefulLifeMonths: 36 });
  assert.equal(assets.activate(k.id).entry.fxKhrPerUsd, 4000);
  assets.reverseEvent(assets.listEvents(C, { assetId: k.id }).find((e) => e.kind === 'acquire').id, 'wrong date');
  assert.equal(assets.get(k.id).costFxKhrPerUsd, null);
  assets.update(k.id, { purchaseDate: '2026-07-01' });
  assert.equal(assets.activate(k.id).entry.fxKhrPerUsd, 4100, 'the rate on the corrected date');
});

test('M7 / L1 / L2: event dates', { skip: skipReason }, () => {
  const { C, cat, assets, dep, branches } = fixture();
  const b1 = branches.create({ companyId: C, code: 'B1', nameEn: 'One' });
  const b2 = branches.create({ companyId: C, code: 'B2', nameEn: 'Two' });
  const b3 = branches.create({ companyId: C, code: 'B3', nameEn: 'Three' });
  assert.throws(() => assets.create({ companyId: C, categoryId: cat('computer'), name: 'F', purchaseDate: '2099-01-05', costMinor: 1 }), /future/);
  const a = assets.activate(assets.create({ companyId: C, categoryId: cat('furniture'), name: 'Desk', branchId: b1.id, purchaseDate: '2026-02-01', inServiceDate: '2026-02-01', costMinor: 50_000, usefulLifeMonths: 60 }).id).asset;
  assert.throws(() => assets.transfer({ companyId: C, assetIds: [a.id], toBranchId: b2.id, date: '2026-01-15' }), /before 2026-02-01/);
  assets.transfer({ companyId: C, assetIds: [a.id], toBranchId: b2.id, date: '2026-05-10' });
  assert.throws(() => assets.transfer({ companyId: C, assetIds: [a.id], toBranchId: b3.id, date: '2026-05-01' }), /later move is recorded on 2026-05-10/);
  const sok = require('../main/db/employees').create({ companyId: C, staffCode: 'S1', nameEn: 'Sok' });
  assert.throws(() => assets.setCustodian({ id: a.id, employeeId: sok.id, date: '2026-05-01' }), /later move/);
  assets.setStatus({ id: a.id, status: 'in_repair', date: '2026-06-01' });
  assert.throws(() => assets.setStatus({ id: a.id, status: 'in_use', date: '2026-05-30' }), /later status change/);
  const opening = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Old', acquisitionKind: 'opening', costBasis: 'deemed', costMinor: 60_000, usefulLifeMonths: 24 }).id).asset;
  assert.throws(() => assets.addNote({ id: opening.id, date: '2025-11-01', text: 'x' }), /before 2026-01-01 \(the register start\)/);
  for (const p of ['2026-01', '2026-02', '2026-03']) dep.runDepreciation(C, p);
  assert.throws(() => assets.changeLife({ id: a.id, newLifeMonths: 24, date: '2026-03-20', reason: 'x' }), /posted through March 2026 — date this change in April 2026 or later/);
  assert.throws(() => assets.changeSalvage({ id: a.id, newSalvageMinor: 1, date: '2026-02-01', reason: 'x' }), /posted through March 2026/);
  assert.throws(() => assets.recordCapex({ id: a.id, amountMinor: 40_000, date: '2026-03-31', reason: 'x' }), /posted through March 2026/);
  assert.ok(assets.changeLife({ id: a.id, newLifeMonths: 24, date: '2026-04-01', reason: 'ok' }).event);
});

test('L3: import life accepts months or years, nothing else', { skip: skipReason }, () => {
  const { importer, C } = fixture();
  assert.equal(importer.parseMonths('36'), 36);
  assert.equal(importer.parseMonths('36 months'), 36);
  assert.equal(importer.parseMonths('8 years'), 96);
  assert.equal(importer.parseMonths('8 yrs'), 96);
  assert.throws(() => importer.parseMonths('eight'), /36 months/);
  assert.throws(() => importer.parseMonths('1.5'), /whole number/);
  const p = importer.planImport(C, [{ name: 'Forklift', category: 'plant', cost: '9000', purchase_date: '2026-03-01', useful_life_months: '8 years' }, { name: 'X', category: 'plant', useful_life_months: 'ten' }]);
  assert.equal(p.rows[0].values.usefulLifeMonths, 96);
  assert.equal(p.rows[1].action, 'error');
});

test('L4: the first house rate is seeded at the register start, from the server Mac\'s Settings', { skip: skipReason }, () => {
  db.initDb(fs.mkdtempSync(path.join(os.tmpdir(), 'msk-review-l4-')));
  const C = require('../main/db/companies').create({ name: 'Rates', isActive: true }).id;
  const assets = require('../main/db/fixedAssets');
  const config = require('../main/db/assetConfig');
  config.ensureCategories(C);
  assets.activate(assets.create({ companyId: C, categoryId: config.categoryByKey(C, 'computer').id, name: 'Old', acquisitionKind: 'opening', purchaseDate: '2019-05-01', costMinor: 100_000, usefulLifeMonths: 60 }).id);
  const rates = require('../main/db/fxRates').list(C);
  assert.equal(rates.length, 1);
  assert.equal(rates[0].rateDate, '2026-01-01');
  assert.equal(rates[0].sourceNote, 'from Settings');
});

test('M5 / L6: closed-through locks and their limits', { skip: skipReason }, () => {
  const { C, ledger, dep, assets, cat } = fixture();
  assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 120_000, usefulLifeMonths: 12 }).id);
  // Review 2: a month whose depreciation is still to be posted cannot be closed.
  assert.throws(() => ledger.lockPeriod(C, '2026-03', 'Q1'), /Depreciation for January 2026 is not posted yet — post the months up to March 2026 before locking it/);
  for (const p of ['2026-01', '2026-02', '2026-03']) dep.runDepreciation(C, p);
  ledger.lockPeriod(C, '2026-03', 'Q1 closed');
  assert.equal(dep.nextDuePeriod(C), '2026-04');
  assert.match(dep.previewDepreciation(C, '2026-02').reason, /locked/);
  assert.throws(() => dep.reverseRun(C, '2026-03', 'x'), /March 2026 is locked/);
  assert.throws(() => ledger.lockPeriod(C, require('../main/db/_assetUtil').todayPhnomPenh().slice(0, 7)), /has not ended/);
  dep.runDepreciation(C, '2026-04');
  ledger.lockPeriod(C, '2026-04');
  assert.throws(() => dep.reverseRun(C, '2026-04', 'x'), /April 2026 is locked/);
  assert.equal(dep.nextDuePeriod(C), '2026-05');
  // A company with nothing to depreciate can close any ended month.
  const other = require('../main/db/companies').create({ name: 'Empty', isActive: false });
  assert.equal(ledger.lockPeriod(other.id, '2026-06').closedThrough, '2026-06');
});

test('M6: History hides asset and ledger rows from callers without assets.view; Clear keeps them; sensitivity kept when the column exists', { skip: skipReason }, () => {
  const { C, cat, assets, audit, branches } = fixture();
  branches.create({ companyId: C, code: 'PP1', nameEn: 'Phnom Penh' });
  assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Mac', purchaseDate: '2026-02-01', costMinor: 120_000, usefulLifeMonths: 36 }).id);
  const all = audit.listRecent({ limit: 500 }).map((r) => r.entityType);
  assert.ok(all.includes('fixed_asset') && all.includes('journal_entry') && all.includes('branch'));
  const hidden = audit.listRecent({ limit: 500, hideAssets: true }).map((r) => r.entityType);
  for (const t of ['fixed_asset', 'asset_event', 'journal_entry', 'fx_rate', 'gl_account']) assert.ok(!hidden.includes(t), t);
  assert.ok(hidden.includes('branch'), 'branch names stay visible');
  assert.equal(audit.countRecent({ hideAssets: true, q: 'Mac' }), audit.listRecent({ limit: 500, hideAssets: true, q: 'Mac' }).length);
  assert.ok(!audit.listRecent({ limit: 500, hideAssets: true, q: 'Mac' }).some((r) => r.entityType === 'fixed_asset'), 'search does not reach them either');
  const before = db.getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'fixed_asset'").get().n;
  const res = audit.clearOlderThan(0);
  assert.ok(res.kept >= before);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'fixed_asset'").get().n, before, 'History clear keeps asset rows');
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'branch'").get().n, 0, 'other rows are cleared');
  // HR1's audit_log.sensitivity column (added on another branch): the value is kept when it exists.
  db.getDb().exec('ALTER TABLE audit_log ADD COLUMN sensitivity TEXT');
  assets.create({ companyId: C, categoryId: cat('computer'), name: 'Mac 2' });
  assert.equal(db.getDb().prepare("SELECT sensitivity FROM audit_log WHERE entity_type = 'fixed_asset' ORDER BY id DESC LIMIT 1").get().sensitivity, 'finance');
});
