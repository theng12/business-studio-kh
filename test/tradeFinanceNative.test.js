/**
 * Trade Finance against a real database (docs/TRADE_FINANCE_PLAN.md Phase A).
 *
 *   1. The schema is additive and idempotent; SCHEMA_VERSION is not bumped.
 *   2. Outstanding principal follows part-repayments and never goes negative.
 *   3. An over-repayment is refused with a plain reason.
 *   4. Paying interest records one posting for the period since the drawdown.
 *   5. A re-sent clientUuid does not create a second repayment.
 *   6. A bank reference is unique per company when given.
 *   7. Every read and write is scoped to one company.
 *   8. Reports derive drawn, ladder and cash flow from the same records.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-trade-${counter}-`));
  db.initDb(dataDir);
  require('../main/db/tradeFinanceSchema').ensureTradeFinanceSchema(db.getDb());
  const company = require('../main/db/companies').create({ name: `Trade Co ${counter}`, isActive: true });
  const other = require('../main/db/companies').create({ name: `Other Co ${counter}`, isActive: true });
  const trade = require('../main/db/tradeFinance');
  const bank = trade.createBank(company.id, { name: 'ABA' });
  const facility = trade.createFacility(company.id, {
    bankId: bank.id, kind: 'TR', name: 'TR line', currency: 'USD',
    limitMinor: 20_000_000, rate: 7.5, dayCount: 360, hasMaturity: true,
    commitmentRate: 0.5, commitmentFreq: 'monthly',
  });
  return { dataDir, company, other, trade, bank, facility };
}

function drawdown(trade, companyId, facilityId, extra = {}) {
  return trade.createDrawdown(companyId, {
    facilityId, principalMinor: 10_000_000, valueDate: '2026-01-01', maturityDate: '2026-06-30',
    rate: 7.5, reference: 'TR-001', ...extra,
  });
}

test('schema is additive and idempotent', { skip: skipReason }, () => {
  const { dataDir } = fixture();
  require('../main/db/tradeFinanceSchema').ensureTradeFinanceSchema(db.getDb());
  assert.equal(db.getDb().pragma('table_info(tf_facilities)').length > 0, true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('part-repayments lower the outstanding and cannot overpay', { skip: skipReason }, () => {
  const { company, trade, facility } = fixture();
  const d = drawdown(trade, company.id, facility.id);
  assert.equal(d.outstandingMinor, 10_000_000);

  const first = trade.addRepayment(company.id, {
    drawdownId: d.id, principalMinor: 4_000_000, interestMinor: 0,
    paidOn: '2026-02-01', clientUuid: 'repay-1',
  });
  assert.equal(first.drawdown.outstandingMinor, 6_000_000);

  assert.throws(() => trade.addRepayment(company.id, {
    drawdownId: d.id, principalMinor: 7_000_000, interestMinor: 0,
    paidOn: '2026-02-02', clientUuid: 'repay-2',
  }), /more than the outstanding/);

  // A re-sent request is the same repayment, not a second one.
  const again = trade.addRepayment(company.id, {
    drawdownId: d.id, principalMinor: 4_000_000, interestMinor: 0,
    paidOn: '2026-02-01', clientUuid: 'repay-1',
  });
  assert.equal(again.duplicated, true);
  const fresh = trade.getDrawdown(company.id, d.id);
  assert.equal(fresh.repayments.length, 1);
  assert.equal(fresh.outstandingMinor, 6_000_000);
});

test('paying interest records one posting for the period', { skip: skipReason }, () => {
  const { company, trade, facility } = fixture();
  const d = drawdown(trade, company.id, facility.id);
  const result = trade.addRepayment(company.id, {
    drawdownId: d.id, principalMinor: 4_000_000, interestMinor: 20_000,
    paidOn: '2026-02-01', clientUuid: 'repay-interest',
  });
  assert.equal(result.repayment.interestMinor, 20_000);
  const postings = trade.listPostings(company.id, {});
  assert.equal(postings.total, 1);
  assert.equal(postings.rows[0].periodStart, '2026-01-01');
  assert.equal(postings.rows[0].periodEnd, '2026-02-01');
  assert.equal(postings.rows[0].days, 31);
  assert.equal(postings.rows[0].amountMinor, 20_000);

  // Accrual resumes from the posting and integrates the lower balance.
  const preview = trade.accrualPreview(company.id, '2026-03-01');
  assert.equal(preview.length, 1);
  assert.equal(preview[0].from, '2026-02-01');
  assert.equal(preview[0].accruedMinor, 35_000, '28 days on USD 60,000 at 7.5% / 360');
});

test('a bank reference is unique per company', { skip: skipReason }, () => {
  const { company, other, trade, facility } = fixture();
  drawdown(trade, company.id, facility.id, { reference: 'TR-777' });
  assert.throws(() => drawdown(trade, company.id, facility.id, { reference: 'TR-777', valueDate: '2026-02-01' }),
    /already used/);
  // A different company may reuse the same reference.
  const otherBank = trade.createBank(other.id, { name: 'ACLEDA' });
  const otherFacility = trade.createFacility(other.id, {
    bankId: otherBank.id, name: 'Other line', currency: 'USD', limitMinor: 1_000_000, rate: 5,
  });
  assert.doesNotThrow(() => drawdown(trade, other.id, otherFacility.id, { reference: 'TR-777' }));
});

test('every read and write is scoped to one company', { skip: skipReason }, () => {
  const { company, other, trade, facility } = fixture();
  const d = drawdown(trade, company.id, facility.id);
  assert.deepEqual(trade.listFacilities(other.id), []);
  assert.deepEqual(trade.listDrawdowns(other.id).rows, []);
  assert.equal(trade.getDrawdown(other.id, d.id), null);
  assert.throws(() => trade.addRepayment(other.id, {
    drawdownId: d.id, principalMinor: 1, interestMinor: 0, paidOn: '2026-02-01',
  }), /not found/i);
});

test('reports derive drawn, ladder and cash flow from the records', { skip: skipReason }, () => {
  const { company, trade, facility } = fixture();
  const d = drawdown(trade, company.id, facility.id);
  trade.addRepayment(company.id, {
    drawdownId: d.id, principalMinor: 4_000_000, interestMinor: 0,
    paidOn: '2026-02-01', clientUuid: 'repay-report',
  });

  const summary = trade.reportSummary(company.id, '2026-03-01');
  assert.equal(summary.perBank.length, 1);
  assert.equal(summary.perBank[0].drawnMinor, 6_000_000);
  assert.equal(summary.perBank[0].limitMinor, 20_000_000);
  assert.equal(summary.cashflow.length, 1);
  assert.equal(summary.cashflow[0].principalMinor, 6_000_000);
  assert.ok(summary.cashflow[0].interestMinor > 0);
  const bucket = summary.ladder.find((b) => b.bucket === '90+');
  assert.equal(bucket.totals[0].currency, 'USD');
  assert.ok(bucket.totals[0].totalMinor > 6_000_000);
});
