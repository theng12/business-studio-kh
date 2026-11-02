/**
 * Fixed Assets — the second review (2026-10-08): runs that lag behind events,
 * late and backdated disposals, reversals, and the smaller rules. Every
 * scenario checks EVERY month-end: depreciation posted through that month =
 * the schedule through it, and the register's NBV = the GL's net fixed-asset
 * balance on that date.
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
  db.initDb(fs.mkdtempSync(path.join(os.tmpdir(), `msk-lag-${counter}-`)));
  const company = require('../main/db/companies').create({ name: `Lag Co ${counter}`, isActive: true });
  const m = {
    config: require('../main/db/assetConfig'), assets: require('../main/db/fixedAssets'), ledger: require('../main/db/ledger'),
    fx: require('../main/db/fxRates'), dep: require('../main/db/assetDepreciation'), disp: require('../main/db/assetDisposals'),
    reports: require('../main/db/assetReports'), book: require('../main/util/bookDepreciation'),
  };
  m.fx.setRate({ companyId: company.id, rateDate: '2025-01-01', khrPerUsd: 4000 });
  m.config.ensureCategories(company.id);
  const C = company.id;
  const cat = (k) => m.config.categoryByKey(C, k).id;
  const runThrough = (p) => { for (const x of m.dep.dueMonths(C, p)) m.dep.runDepreciation(C, x); };
  const glNetAt = (date) => db.getDb().prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS n FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
     WHERE e.company_id = ? AND e.entry_date <= ? AND (a.system_key LIKE 'fa.cost.%' OR a.system_key LIKE 'fa.accum.%' OR a.system_key = 'fa.impairment')`).get(C, date).n;
  /** Every month-end from..to: posted = schedule per asset, register = GL. */
  const monthEnds = (ids, from, to) => {
    for (let p = from; p <= to; p = m.book.addMonths(p, 1)) {
      const end = m.dep.lastDayOf(p);
      for (const id of ids) {
        const a = m.assets.get(id);
        const spec = m.assets.scheduleSpec(a);
        const computed = spec ? m.book.chargedThrough(spec, p) : 0;
        assert.equal(m.assets.postedDepreciation(id, { throughPeriod: p }), computed, `${a.tagCode} posted = schedule at ${end}`);
      }
      assert.equal(m.reports.register(C, { asOf: end }).totals.nbvMinor, glNetAt(end), `register = GL at ${end}`);
    }
  };
  return { C, cat, runThrough, glNetAt, monthEnds, ...m };
}

test('lag: a partial disposal with the runs behind — every month-end equals the schedule', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, runThrough, monthEnds } = fixture();
  const g = assets.activate(assets.create({ companyId: C, categoryId: cat('furniture'), name: 'Stands', quantity: 10, purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 1_200_000, usefulLifeMonths: 120, salvageMinor: 0 }).id).asset;
  runThrough('2026-02');
  const r = disp.partialDispose({ id: g.id, date: '2026-05-20', qty: 2, proceedsMinor: 100_000 });
  assert.equal(r.event.detail.depreciationDueMinor, 3 * 10_000, 'Mar–May settled ahead of the runs');
  runThrough('2026-08');
  monthEnds([g.id], '2026-01', '2026-08');
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('lag: a revaluation with the runs behind — every month-end equals the schedule', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, runThrough, monthEnds } = fixture();
  const b = assets.activate(assets.create({ companyId: C, categoryId: cat('building'), name: 'Shop', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 12_000_000, usefulLifeMonths: 240, salvageMinor: 0 }).id).asset;
  runThrough('2026-02');
  disp.revalue({ id: b.id, date: '2026-06-10', newValueMinor: 15_000_000, reason: 'Valuer' });
  runThrough('2026-09');
  monthEnds([b.id], '2026-01', '2026-09');
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('lag: a full disposal with the runs behind — runs before it still post, the one after takes back the overlap', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, runThrough, monthEnds, ledger } = fixture();
  const pc = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 360_000, usefulLifeMonths: 36, salvageMinor: 0 }).id).asset;
  const keep = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Keep', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 120_000, usefulLifeMonths: 12, salvageMinor: 0 }).id).asset;
  runThrough('2026-02');
  disp.dispose({ id: pc.id, date: '2026-06-20', kind: 'sale', proceedsMinor: 250_000 });
  runThrough('2026-09');
  monthEnds([pc.id, keep.id], '2026-01', '2026-09');
  assert.deepEqual(ledger.assetLedgerTotals(pc.id), { costMinor: 0, accumDepMinor: 0, impairmentMinor: 0, revaluationSurplusMinor: 0 });
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('lag: undo an activation and re-activate it corrected with the runs behind (H1)', { skip: skipReason }, () => {
  const { C, cat, assets, dep, runThrough, monthEnds } = fixture();
  const a = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'Server', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 120_000, usefulLifeMonths: 12, salvageMinor: 0 }).id).asset;
  runThrough('2026-02');
  const ev = assets.listEvents(C, { assetId: a.id }).find((e) => e.kind === 'acquire');
  const back = assets.reverseEvent(ev.id, 'Wrong cost');
  assert.equal(back.entry.entryDate, '2026-01-05');
  const undo = db.getDb().prepare("SELECT entry_date FROM journal_entries WHERE idempotency_key LIKE ?").get(`asset:${a.id}:undo-dep:%`);
  assert.equal(undo.entry_date, '2026-03-01', 'the take-back is dated the first unposted month');
  assets.update(a.id, { costMinor: 240_000 });
  assets.activate(a.id);
  runThrough('2026-09');
  // Jan and Feb were posted on the old cost (closed facts); from March every month-end is the corrected schedule.
  monthEnds([a.id], '2026-03', '2026-09');
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('late and backdated disposals are booked after the last posted / closed month (MEDIUM 3); register = GL every month-end', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, runThrough, monthEnds, ledger } = fixture();
  const pc = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 360_000, usefulLifeMonths: 36, salvageMinor: 0 }).id).asset;
  const pc2 = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC2', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 360_000, usefulLifeMonths: 36, salvageMinor: 0 }).id).asset;
  runThrough('2026-06');
  const r = disp.dispose({ id: pc.id, date: '2026-03-10', kind: 'scrap' });
  assert.equal(r.entry.entryDate, '2026-07-01');
  assert.match(r.entry.memo, /^Late disposal for 2026-03-10 \(June 2026 already posted\)/);
  assert.deepEqual(r.entry.lines.slice(0, 2).map((l) => [l.lineRole, l.debitMinor, l.creditMinor]), [['accum_dep', 40_000, 0], ['dep_catch_up', 0, 40_000]], 'Mar–Jun taken back');
  assert.equal(r.event.detail.nbvMinor, 360_000 - 2 * 10_000);
  ledger.lockPeriod(C, '2026-06', 'H1 closed');
  const w = disp.markLost({ id: pc2.id, date: '2026-05-25', reason: 'Not found', stocktakeResultId: 'count-1' });
  assert.equal(w.entry.entryDate, '2026-07-01');
  assert.match(w.entry.memo, /^Late write-off for 2026-05-25/);
  assert.equal(w.event.stocktakeResultId, 'count-1', 'the count result is kept on the event');
  runThrough('2026-09');
  // Mar–Jun were posted before the disposals were known (closed facts): register = GL there;
  // from the month the late entries are booked in, every month-end is the schedule.
  monthEnds([], '2026-01', '2026-06');
  monthEnds([pc.id, pc2.id], '2026-07', '2026-09');
  assert.equal(dep.checkIntegrity(C).ok, true);
});

test('HIGH 1: a run cannot be reversed while it would leave a balance on a gone asset; the integrity check compares posted with the schedule', { skip: skipReason }, () => {
  const { C, cat, assets, dep, disp, runThrough } = fixture();
  const pc = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 360_000, usefulLifeMonths: 36, salvageMinor: 0 }).id).asset;
  runThrough('2026-08');
  disp.dispose({ id: pc.id, date: '2026-09-20', kind: 'sale', proceedsMinor: 200_000 });
  assert.throws(() => dep.reverseRun(C, '2026-08', 'wrong'), new RegExp(`Undo the disposal of ${pc.tagCode} first`));
  const ev = assets.listEvents(C, { assetId: pc.id }).find((e) => e.kind === 'dispose');
  assets.reverseEvent(ev.id, 'Sale fell through');
  assert.ok(dep.reverseRun(C, '2026-08', 'wrong').run);
  dep.runDepreciation(C, '2026-08');
  const ac = assets.listEvents(C, { assetId: pc.id }).find((e) => e.kind === 'acquire');
  assets.reverseEvent(ac.id, 'Not ours');
  assert.throws(() => dep.reverseRun(C, '2026-08', 'redo'), new RegExp(`return to draft of ${pc.tagCode}`));
  // The integrity check: posted through the last run = the schedule; a late activation is "due at the next run", not an error.
  const fresh = fixture();
  const x = fresh.assets.activate(fresh.assets.create({ companyId: fresh.C, categoryId: fresh.cat('computer'), name: 'X', purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 120_000, usefulLifeMonths: 12, salvageMinor: 0 }).id).asset;
  fresh.runThrough('2026-03');
  const late = fresh.assets.activate(fresh.assets.create({ companyId: fresh.C, categoryId: fresh.cat('computer'), name: 'Late', purchaseDate: '2026-01-10', inServiceDate: '2026-01-10', costMinor: 120_000, usefulLifeMonths: 12, salvageMinor: 0 }).id).asset;
  const chk = fresh.dep.checkIntegrity(fresh.C);
  assert.equal(chk.ok, true);
  assert.deepEqual(chk.pendingAtNextRun.map((p) => p.assetId), [late.id]);
  assert.deepEqual(chk.schedule, []);
  // Tamper: a posted line no run explains is reported.
  fresh.ledger.post({ companyId: fresh.C, entryDate: '2026-03-15', sourceKind: 'asset_depreciation', idempotencyKey: 'stray', fxKhrPerUsd: 4000,
    lines: [{ accountKey: 'fa.dep_expense', debitMinor: 100, lineRole: 'dep_expense', assetId: x.id }, { accountKey: 'fa.accum.computer', creditMinor: 100, lineRole: 'accum_dep', assetId: x.id }] });
  const bad = fresh.dep.checkIntegrity(fresh.C);
  assert.equal(bad.ok, false);
  assert.equal(bad.schedule[0].tagCode, x.tagCode);
});

test('LOW: the background pass leaves a month reversed by hand alone; previewing a write-off; moves after a disposal; lines carry the branch of their date; movements', { skip: skipReason }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T00:00:00Z') });
  const { C, cat, assets, dep, disp, reports, runThrough } = fixture();
  const branches = require('../main/db/branches');
  const b1 = branches.create({ companyId: C, code: 'B1', nameEn: 'One' });
  const b2 = branches.create({ companyId: C, code: 'B2', nameEn: 'Two' });
  const pc = assets.activate(assets.create({ companyId: C, categoryId: cat('computer'), name: 'PC', branchId: b1.id, purchaseDate: '2026-01-05', inServiceDate: '2026-01-05', costMinor: 360_000, usefulLifeMonths: 36, salvageMinor: 0 }).id).asset;
  runThrough('2026-03');
  dep.reverseRun(C, '2026-03', 'Check it');
  const out = await require('../main/assetScheduler').runOnce();
  assert.deepEqual(out.posted, []);
  assert.deepEqual(out.skipped, [{ companyId: C, period: '2026-03', reason: 'reversed by hand' }]);
  dep.runDepreciation(C, '2026-03');
  assert.ok((await require('../main/assetScheduler').runOnce()).posted.length > 0, 'posted by hand again: the pass carries on');

  assert.equal(require('../main/server/validators').getValidator('assets:previewDisposal')({ id: pc.id, kind: 'lost' }), true);
  assert.equal(disp.previewDisposal({ id: pc.id, kind: 'lost', date: '2026-09-30' }).proceedsUsdMinor, 0);

  assets.transfer({ companyId: C, assetIds: [pc.id], toBranchId: b2.id, date: '2026-09-15' });
  assert.throws(() => disp.dispose({ id: pc.id, date: '2026-09-10', kind: 'scrap' }), /move or status change recorded on 2026-09-15/);
  const cap = assets.recordCapex({ id: pc.id, date: '2026-10-01', amountMinor: 50_000, extendsLifeMonths: 6, reason: 'RAM' });
  assert.ok(cap.entry.lines.every((l) => l.branchId === b2.id));
  const imp = disp.impair({ id: pc.id, date: '2026-10-02', amountMinor: 10_000, reason: 'Dent' });
  assert.ok(imp.entry.lines.every((l) => l.branchId === b2.id));

  // Impairment taken out by a revaluation is a revaluation movement, not a disposal.
  const land = assets.activate(assets.create({ companyId: C, categoryId: cat('land'), name: 'Plot', purchaseDate: '2026-01-05', costMinor: 1_000_000 }).id).asset;
  disp.impair({ id: land.id, date: '2026-10-03', amountMinor: 100_000, reason: 'Flooding' });
  disp.revalue({ id: land.id, date: '2026-10-04', newValueMinor: 1_000_000, reason: 'Valuer' });
  const mv = reports.movements(C, { from: '2026-10-01', to: '2026-10-31', categoryId: cat('land') });
  assert.equal(mv.rows[0].impairment.revaluation, -100_000);
  assert.equal(mv.rows[0].impairment.disposals, 0);
});
