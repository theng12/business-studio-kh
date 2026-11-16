/**
 * Trade Finance Phase B against a real database: overdraft movements, month-end
 * capitalisation, bank-actual reconciliation, fees and recurring fees.
 *
 *   1. A running-balance facility takes movements, refuses drawdowns, and its
 *      balance is the sum of the ledger.
 *   2. Capitalisation posts each completed month once, compounds a catch-up,
 *      and a re-run posts nothing.
 *   3. Ours for a capitalised month equals what we charged, so the bank's own
 *      figure reconciles to 'match' rather than drifting.
 *   4. Fees are idempotent on clientUuid; recurring fees catch up every missed
 *      period once and advance their next date.
 *   5. Every read is scoped to one company.
 *
 * RUNNING THIS: `npm run test:native`.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-tradeb-${counter}-`));
  db.initDb(dataDir);
  require('../main/db/tradeFinanceSchema').ensureTradeFinanceSchema(db.getDb());
  const company = require('../main/db/companies').create({ name: `Overdraft Co ${counter}`, isActive: true });
  const other = require('../main/db/companies').create({ name: `Other Overdraft ${counter}`, isActive: true });
  const trade = require('../main/db/tradeFinance');
  const bank = trade.createBank(company.id, { name: 'ACLEDA' });
  const facility = trade.createFacility(company.id, {
    bankId: bank.id, kind: 'OD', name: 'Working OD', currency: 'USD',
    limitMinor: 20_000_000, rate: 12, dayCount: 360, interestBasis: 'balance',
  });
  trade.addMovement(company.id, { facilityId: facility.id, entryDate: '2026-01-01', kind: 'opening', amountMinor: 10_000_000 });
  return { dataDir, company, other, trade, bank, facility };
}

test('a running-balance facility takes movements and refuses drawdowns', { skip: skipReason }, () => {
  const { company, trade, facility, dataDir } = fixture();
  assert.equal(facility.hasMaturity, false);
  assert.equal(facility.interestBilling, 'month_end_capitalised');

  trade.addMovement(company.id, { facilityId: facility.id, entryDate: '2026-01-10', kind: 'draw', amountMinor: 2_000_000 });
  trade.addMovement(company.id, { facilityId: facility.id, entryDate: '2026-01-20', kind: 'repay', amountMinor: 3_000_000 });
  trade.addMovement(company.id, { facilityId: facility.id, entryDate: '2026-01-25', kind: 'adjustment', amountMinor: -500_000 });
  const rows = trade.listMovements(company.id, facility.id);
  assert.deepEqual(rows.map((m) => m.amountMinor), [10_000_000, 2_000_000, -3_000_000, -500_000]);
  assert.deepEqual(rows.map((m) => m.balanceMinor), [10_000_000, 12_000_000, 9_000_000, 8_500_000]);
  assert.equal(trade.getFacility(company.id, facility.id).balanceMinor, 8_500_000);

  assert.throws(() => trade.createDrawdown(company.id, {
    facilityId: facility.id, principalMinor: 1_000_000, valueDate: '2026-02-01', rate: 12,
  }), /record a movement instead of a drawdown/);

  assert.throws(() => trade.updateFacility(company.id, facility.id, { interestBasis: 'drawn' }), /cannot change/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('capitalisation posts each completed month once and compounds a catch-up', { skip: skipReason }, () => {
  const { company, trade, facility, dataDir } = fixture();
  const due = trade.capitalisationDue(company.id, '2026-03-15');
  assert.deepEqual(due.map((r) => r.period), ['2026-01', '2026-02']);
  assert.equal(due[0].amountMinor, 103_333);
  assert.equal(due[1].amountMinor, 94_298);

  const posted = trade.runCapitalisation(company.id, '2026-03-15');
  assert.equal(posted.length, 2);
  assert.equal(trade.getFacility(company.id, facility.id).balanceMinor, 10_197_631);
  assert.deepEqual(trade.runCapitalisation(company.id, '2026-03-15'), []);

  // A second writer cannot add a second capitalisation for the same month,
  // which is what keeps a concurrent run from moving the balance twice.
  assert.throws(() => db.getDb().prepare(`INSERT INTO tf_ledger_entries
    (id, company_id, client_uuid, facility_id, entry_date, kind, amount_minor, note, created_at, created_by_user_id)
    VALUES ('dup', ?, NULL, ?, '2026-01-31', 'interest_capitalised', 1, NULL, 0, NULL)`).run(company.id, facility.id), /UNIQUE/);

  // The posted rows belong to the Interest page's recorded table.
  const recorded = trade.listPostings(company.id, { page: 1, pageSize: 50 });
  assert.equal(recorded.total, 2);
  assert.equal(recorded.rows.every((p) => p.drawdownId == null), true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the bank\'s figure is compared with ours over the same days', { skip: skipReason }, () => {
  const { company, trade, facility, dataDir } = fixture();
  trade.runCapitalisation(company.id, '2026-03-15');

  const rows = trade.addReconciliation(company.id, {
    facilityId: facility.id, periodStart: '2026-01-01', periodEnd: '2026-01-31', amountMinor: 103_333,
  });
  assert.equal(rows[0].oursMinor, 103_333);
  assert.equal(rows[0].varianceMinor, 0);
  assert.equal(rows[0].status, 'match');

  const after = trade.addReconciliation(company.id, {
    facilityId: facility.id, periodStart: '2026-02-01', periodEnd: '2026-02-28', amountMinor: 97_000,
  });
  assert.equal(after[0].oursMinor, 94_298);
  assert.equal(after[0].status, 'minor');

  assert.throws(() => trade.addReconciliation(company.id, {
    facilityId: facility.id, periodStart: '2026-01-01', periodEnd: '2026-01-31', amountMinor: 1,
  }), /already recorded/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('fees are idempotent and recurring fees catch up once per period', { skip: skipReason }, () => {
  const { company, trade, facility, dataDir } = fixture();
  const one = trade.addFee(company.id, {
    clientUuid: 'fee-1', facilityId: facility.id, kind: 'TT fee', amountMinor: 100_000,
    currency: 'USD', feeDate: '2026-01-05',
  });
  const again = trade.addFee(company.id, {
    clientUuid: 'fee-1', facilityId: facility.id, kind: 'TT fee', amountMinor: 100_000,
    currency: 'USD', feeDate: '2026-01-05',
  });
  assert.equal(one.id, again.id);
  assert.equal(trade.listFees(company.id).length, 1);

  trade.addRecurring(company.id, {
    facilityId: facility.id, kind: 'Commitment fee', amountMinor: 50_000,
    currency: 'USD', frequency: 'monthly', nextDate: '2026-01-15',
  });
  const posted = trade.postDueRecurring(company.id, '2026-03-15');
  assert.deepEqual(posted.map((p) => p.feeDate), ['2026-01-15', '2026-02-15', '2026-03-15']);
  assert.equal(trade.postDueRecurring(company.id, '2026-03-15').length, 0);
  assert.equal(trade.listRecurring(company.id)[0].nextDate, '2026-04-15');
  assert.equal(trade.listFees(company.id).length, 4);

  const summary = trade.reportSummary(company.id, '2026-03-15');
  assert.deepEqual(summary.ytdFees, [{ currency: 'USD', totalMinor: 250_000 }]);
  assert.equal(summary.perBank.length, 1);
  assert.equal(summary.perBank[0].feesMinor, 250_000);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('another company sees none of it', { skip: skipReason }, () => {
  const { company, other, trade, facility, dataDir } = fixture();
  trade.addFee(company.id, { facilityId: facility.id, kind: 'Handling', amountMinor: 1_000, feeDate: '2026-01-05' });
  trade.addReconciliation(company.id, {
    facilityId: facility.id, periodStart: '2026-01-01', periodEnd: '2026-01-31', amountMinor: 103_333,
  });
  assert.equal(trade.listFees(other.id).length, 0);
  assert.equal(trade.listReconciliations(other.id).length, 0);
  assert.throws(() => trade.listMovements(other.id, facility.id), /Facility/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
