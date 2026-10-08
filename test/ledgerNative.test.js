/**
 * Fixed Assets A0: the accounting core against a real database
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §5).
 *
 *   1. Schema additive + idempotent; SCHEMA_VERSION stays 2.
 *   2. The §5.3 chart is seeded per company, once.
 *   3. ledger.post balances (USD + riel), numbers entries per year, and is idempotent.
 *   4. Posted means permanent — SQLite triggers refuse edits and deletes.
 *   5. A locked month sends the entry to the first open month, with the memo.
 *   6. Reversal, not delete: mirror entry, linked both ways, once.
 *   7. Exchange rates: house seeded from Settings, replace, void, official → house fallback.
 *   8. A company with journals cannot be deleted.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-ledger-${counter}-`));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: `Ledger Co ${counter}`, isActive: true });
  return { dataDir, company, ledger: require('../main/db/ledger'), fx: require('../main/db/fxRates') };
}

function opening(ledger, companyId, key = 'k1', date = '2026-03-14') {
  return ledger.post({
    companyId, entryDate: date, sourceKind: 'asset_open', sourceId: 'a1', idempotencyKey: key, fxKhrPerUsd: 4050, memo: 'Opening value',
    lines: [
      { accountKey: 'fa.cost.vehicle', debitMinor: 3_000_000, lineRole: 'cost' },
      { accountKey: 'fa.accum.vehicle', creditMinor: 1_777_500, lineRole: 'accum_dep' },
      { accountKey: 'equity.opening', creditMinor: 1_222_500, lineRole: 'equity' },
    ],
  });
}

test('schema is additive and idempotent; SCHEMA_VERSION stays 2', { skip: skipReason }, () => {
  const { dataDir } = fixture();
  db.closeDb();
  db.initDb(dataDir);
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['gl_accounts', 'accounting_periods', 'journal_entries', 'journal_lines', 'ledger_settings', 'branches', 'fx_rates',
    'asset_categories', 'asset_settings', 'fixed_assets', 'asset_files', 'asset_events', 'asset_tag_batches', 'asset_tag_aliases']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const triggers = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name);
  for (const t of ['trg_journal_lines_no_update', 'trg_journal_lines_no_delete', 'trg_journal_lines_closed_entry', 'trg_journal_entries_no_delete', 'trg_journal_entries_only_reversal_link']) {
    assert.ok(triggers.includes(t), `missing trigger ${t}`);
  }
  for (const [table, col] of [['employees', 'branch_id'], ['fuel_stock_locations', 'branch_id'], ['fuel_assets', 'branch_id'], ['users', 'default_branch_id']]) {
    assert.ok(db.getDb().prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col), `${table}.${col}`);
  }
  assert.equal(db.SCHEMA_VERSION, 2);
  assert.equal(db.getAppState('schema_version'), '2');
});

test('the §5.3 chart is seeded once per company', { skip: skipReason }, () => {
  const { company, ledger } = fixture();
  const a = ledger.listAccounts(company.id);
  assert.equal(a.length, ledger.SEED_ACCOUNTS.length);
  ledger.ensureChart(company.id);
  assert.equal(ledger.listAccounts(company.id).length, ledger.SEED_ACCOUNTS.length, 'idempotent');
  const byKey = Object.fromEntries(a.map((x) => [x.systemKey, x]));
  assert.equal(byKey['fa.clearing.purchase'].code, '2190');
  assert.equal(byKey['fa.clearing.purchase'].normalBalance, 'credit');
  assert.equal(byKey['fa.cost.land'].code, '1500');
  assert.equal(byKey['fa.dep_expense'].type, 'expense');
  const other = require('../main/db/companies').create({ name: 'Other', isActive: false });
  assert.equal(ledger.listAccounts(other.id).length, ledger.SEED_ACCOUNTS.length, 'per company');
  // The accountant renumbers: posting by system_key still works.
  ledger.updateAccount(byKey['fa.cost.vehicle'].id, { code: '1620', nameEn: 'Motor vehicles' });
  assert.throws(() => ledger.updateAccount(byKey['fa.cost.land'].id, { code: '1620' }), /already used/);
  assert.throws(() => ledger.updateAccount(byKey['fa.cost.land'].id, { archived: true }), /cannot be archived/);
  const e = opening(ledger, company.id);
  assert.equal(e.lines[0].accountCode, '1620');
});

test('post: balanced in USD and riel, numbered per year, idempotent', { skip: skipReason }, () => {
  const { company, ledger } = fixture();
  const e = opening(ledger, company.id);
  assert.equal(e.entryNo, 'JE-2026-000001');
  assert.equal(e.period, '2026-03');
  assert.equal(e.totalMinor, 3_000_000);
  assert.equal(e.khrTotal, 121_500_000);
  assert.deepEqual(e.lines.map((l) => l.khrMinor), [121_500_000, 71_988_750, 49_511_250]);
  assert.equal(e.duplicate, false);
  const again = opening(ledger, company.id);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, e.id);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 1, 'a retry posts nothing');
  const e2 = opening(ledger, company.id, 'k2');
  assert.equal(e2.entryNo, 'JE-2026-000002');
  const e3 = opening(ledger, company.id, 'k3', '2027-01-05');
  assert.equal(e3.entryNo, 'JE-2027-000001', 'numbering restarts each year');
  // The same key in another company is a different entry.
  const other = require('../main/db/companies').create({ name: 'Other', isActive: false });
  assert.equal(opening(ledger, other.id).duplicate, false);

  const before = db.getDb().prepare('SELECT COUNT(*) AS n FROM journal_lines').get().n;
  assert.throws(() => ledger.post({ companyId: company.id, entryDate: '2026-03-01', sourceKind: 'asset_acquire', idempotencyKey: 'bad', fxKhrPerUsd: 4100,
    lines: [{ accountKey: 'fa.cost.vehicle', debitMinor: 100 }, { accountKey: 'fa.clearing.purchase', creditMinor: 99 }] }), /does not balance/);
  assert.throws(() => ledger.post({ companyId: company.id, entryDate: '2026-03-01', sourceKind: 'nonsense', idempotencyKey: 'bad2',
    lines: [] }), /Unknown source kind/);
  assert.throws(() => ledger.post({ companyId: company.id, entryDate: '2026-03-01', sourceKind: 'asset_acquire', idempotencyKey: 'bad3', fxKhrPerUsd: 4100,
    lines: [{ accountId: ledger.accountByKey(other.id, 'fa.cost.vehicle').id, debitMinor: 100 }, { accountKey: 'fa.clearing.purchase', creditMinor: 100 }] }), /not in this company/);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM journal_lines').get().n, before, 'a refused entry writes nothing');
  assert.deepEqual(ledger.checkIntegrity(company.id).unbalanced, []);
  const audit = db.getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'journal_entry' AND action = 'post'").get().n;
  assert.equal(audit, 4);
});

test('posted means permanent: SQLite refuses edits, deletes and extra lines', { skip: skipReason }, () => {
  const { company, ledger } = fixture();
  const e = opening(ledger, company.id);
  const raw = db.getDb();
  assert.throws(() => raw.prepare('UPDATE journal_lines SET debit_minor = 1 WHERE entry_id = ?').run(e.id), /permanent/);
  assert.throws(() => raw.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(e.id), /permanent/);
  assert.throws(() => raw.prepare('DELETE FROM journal_entries WHERE id = ?').run(e.id), /permanent/);
  assert.throws(() => raw.prepare("UPDATE journal_entries SET memo = 'changed' WHERE id = ?").run(e.id), /permanent/);
  assert.throws(() => raw.prepare('UPDATE journal_entries SET total_minor = 1 WHERE id = ?').run(e.id), /permanent/);
  assert.throws(() => raw.prepare(`INSERT INTO journal_lines (id, entry_id, company_id, line_no, account_id, debit_minor, credit_minor, khr_minor)
    VALUES ('x', ?, ?, 9, ?, 5, 0, 1)`).run(e.id, company.id, e.lines[0].accountId), /cannot gain lines/);
  assert.throws(() => raw.prepare(`INSERT INTO journal_lines (id, entry_id, company_id, line_no, account_id, debit_minor, credit_minor, khr_minor)
    VALUES ('y', ?, ?, 9, ?, 5, 5, 1)`).run(e.id, company.id, e.lines[0].accountId));
  assert.equal(ledger.getEntry(e.id).lines.length, 3);
});

test('a locked month: the entry lands on the first day of the first open month, with the memo', { skip: skipReason }, () => {
  const { company, ledger } = fixture();
  ledger.lockPeriod(company.id, '2026-03', 'March closed');
  ledger.lockPeriod(company.id, '2026-04');
  assert.equal(ledger.isLocked(company.id, '2026-03'), true);
  const e = opening(ledger, company.id, 'late', '2026-03-14');
  assert.equal(e.entryDate, '2026-05-01');
  assert.equal(e.period, '2026-05');
  assert.equal(e.intendedDate, '2026-03-14');
  assert.match(e.memo, /^Late entry for 14 Mar 2026 \(March 2026 is locked\)/);
  const periods = ledger.listPeriods(company.id);
  assert.deepEqual(periods.map((p) => [p.period, p.status, p.entryCount]), [['2026-05', 'open', 1], ['2026-04', 'locked', 0], ['2026-03', 'locked', 0]]);
  ledger.unlockPeriod(company.id, '2026-03', 'Correction');
  assert.equal(opening(ledger, company.id, 'ontime', '2026-03-20').entryDate, '2026-03-20');
  const actions = db.getDb().prepare("SELECT action FROM audit_log WHERE entity_type = 'ledger_period' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(actions, ['lock', 'lock', 'unlock']);
});

test('reverse: the mirror entry in the open month, linked both ways, only once', { skip: skipReason }, () => {
  const { company, ledger } = fixture();
  const e = opening(ledger, company.id);
  ledger.lockPeriod(company.id, '2026-06');
  const r = ledger.reverse(e.id, 'Typed the wrong cost', { date: '2026-06-10' });
  assert.equal(r.entryDate, '2026-07-01', 'a locked current month moves the reversal on too');
  assert.equal(r.reversesEntryId, e.id);
  assert.equal(r.fxKhrPerUsd, 4050, 'the original rate');
  assert.deepEqual(r.lines.map((l) => [l.debitMinor, l.creditMinor, l.khrMinor]), e.lines.map((l) => [l.creditMinor, l.debitMinor, l.khrMinor]));
  assert.equal(ledger.getEntry(e.id).reversedByEntryId, r.id);
  assert.match(r.memo, /Reversal of JE-2026-000001: Typed the wrong cost/);
  assert.throws(() => ledger.reverse(e.id, 'again'), /already been reversed/);
  assert.throws(() => ledger.reverse(r.id, 'undo the undo'), /itself a reversal/);
  assert.throws(() => ledger.reverse(e.id, ''), /reason/);
  // The link can be set once only.
  assert.throws(() => db.getDb().prepare('UPDATE journal_entries SET reversed_by_entry_id = ? WHERE id = ?').run(e.id, e.id), /permanent/);
  // Net effect on every account is zero.
  const net = db.getDb().prepare('SELECT account_id, SUM(debit_minor - credit_minor) AS n FROM journal_lines GROUP BY account_id').all();
  assert.ok(net.every((x) => x.n === 0));
});

test('exchange rates: house seeded from Settings once, replace, void, official falls back to house', { skip: skipReason }, () => {
  const { company, ledger, fx } = fixture();
  assert.equal(fx.rateOn(company.id, '2026-03-01'), null);
  const e = ledger.post({ companyId: company.id, entryDate: '2026-03-01', sourceKind: 'asset_acquire', idempotencyKey: 'p1',
    lines: [{ accountKey: 'fa.cost.vehicle', debitMinor: 10_000 }, { accountKey: 'fa.clearing.purchase', creditMinor: 10_000 }] });
  assert.equal(e.fxKhrPerUsd, 4100, 'seeded from Settings (4,100 outside the app)');
  assert.match(e.fxSource, /house 2026-03-01 \(seeded\)/);
  const seeded = fx.list(company.id)[0];
  assert.equal(seeded.sourceNote, 'from Settings');
  // A later house rate is used from its date; an earlier date falls back to the earliest one.
  fx.setRate({ companyId: company.id, rateDate: '2026-05-01', khrPerUsd: 4080, source: 'house' });
  assert.equal(fx.houseRateFor(company.id, '2026-06-15').khrPerUsd, 4080);
  assert.equal(fx.houseRateFor(company.id, '2026-04-30').khrPerUsd, 4100);
  assert.equal(fx.houseRateFor(company.id, '2025-12-31').fallback, 'earliest');
  // Same date again replaces (voids) the old one.
  fx.setRate({ companyId: company.id, rateDate: '2026-05-01', khrPerUsd: 4090 });
  assert.equal(fx.rateOn(company.id, '2026-05-02').khrPerUsd, 4090);
  assert.equal(fx.list(company.id, { includeVoided: true }).filter((r) => r.voided).length, 1);
  // Official missing → house, labelled.
  const t = fx.taxRateFor(company.id, '2026-06-01');
  assert.equal(t.source, 'house');
  assert.equal(t.fallback, 'house');
  fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 4050, source: 'official', sourceNote: 'GDT daily rate' });
  assert.deepEqual([fx.taxRateFor(company.id, '2026-06-01').source, fx.taxRateFor(company.id, '2026-06-01').khrPerUsd], ['official', 4050]);
  const off = fx.list(company.id, { source: 'official' })[0];
  fx.voidRate(off.id, 'Wrong date');
  assert.equal(fx.taxRateFor(company.id, '2026-06-01').source, 'house');
  assert.throws(() => fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 5 }), /between/);
  assert.throws(() => fx.voidRate(seeded.id, ''), /reason/);
  // A posted entry keeps the rate it used.
  assert.equal(ledger.getEntry(e.id).fxKhrPerUsd, 4100);
});

test('a company with journal entries cannot be deleted (in words, and by SQLite)', { skip: skipReason }, () => {
  const { company, ledger } = fixture();
  const history = require('../main/db/fuelHistory');
  const companies = require('../main/db/companies');
  ledger.ensureChart(company.id);
  const bare = companies.create({ name: 'Config only', isActive: false });
  require('../main/db/assetConfig').ensureCategories(bare.id);
  history.assertCompanyRemovable(bare.id);
  companies.remove(bare.id);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM gl_accounts WHERE company_id = ?').get(bare.id).n, 0, 'configuration cascades');
  opening(ledger, company.id);
  assert.throws(() => history.assertCompanyRemovable(company.id), /1 journal posting/);
  assert.throws(() => db.getDb().prepare('DELETE FROM companies WHERE id = ?').run(company.id));
});
