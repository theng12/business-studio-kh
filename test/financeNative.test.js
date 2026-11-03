/**
 * Finance expenses against a real database (docs/FINANCE_PLAN.md).
 *
 *   1. Schema is additive and idempotent; SCHEMA_VERSION is not bumped.
 *   2. The nine starting categories seed once, each with an expense account.
 *   3. Settings: $100 default, editable, audited with companyId.
 *   4. One active cash box per branch; retire and restore.
 *   5. USD opening + expense: one balanced journal, balances from the ledger.
 *   6. KHR opening + expense: the supplied riel balances both lines exactly.
 *   7. Threshold boundary, frozen rate/threshold, approve/reject idempotence.
 *   8. Only drafts edit; submitted rows are frozen; no delete; reversal.
 *   9. Draft revision conflicts and clientUuid replay.
 *  10. Receipt metadata: path guard, revision bump, draft/pending only.
 *  11. Reports by journal period/branch/category, pending separate, scope filter.
 *  12. A locked month posts into the next open month and the report follows.
 *  13. Company/branch/category/account scope and currency match.
 *  14. Account create is one transaction and retryable by id; kind/currency/opening never change silently.
 *  15. Finance system accounts never mask the seeded Assets chart (ensureChart counts seed keys only).
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
let uuidCounter = 0;

function fixture() {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-finance-${counter}-`));
  db.initDb(dataDir);
  // Idempotent; initDb's boot hook also installs it.
  require('../main/db/financeSchema').ensureFinanceSchema(db.getDb());
  const company = require('../main/db/companies').create({ name: `Finance Co ${counter}`, isActive: true });
  const branch = (code, name) => require('../main/db/branches').create({ companyId: company.id, code, nameEn: name });
  const b1 = branch('PP1', 'Phnom Penh 1');
  const b2 = branch('SR1', 'Siem Reap 1');
  const finance = require('../main/db/finance');
  const ledger = require('../main/db/ledger');
  const fx = require('../main/db/fxRates');
  fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 4100, source: 'house' });
  finance.ensureFinance(company.id);
  return { dataDir, company, b1, b2, finance, ledger, fx };
}

function cats(finance, companyId) {
  const list = finance.listCategories(companyId);
  return { list, rent: list.find((c) => c.key === 'rent'), fuel: list.find((c) => c.key === 'fuel') };
}

function cash(finance, companyId, branch, currency = 'USD', opening = null) {
  return finance.saveAccount(companyId, {
    kind: 'cash', name: `Cash ${branch.code}`, branchId: branch.id, currency,
    ...(opening ? { opening } : {}),
  });
}

function draft(finance, companyId, { branch, category, account, amount, currency = 'USD', date = '2026-03-10', memo = 'Test expense', clientUuid = null }) {
  uuidCounter += 1;
  return finance.saveDraft(companyId, {
    clientUuid: clientUuid || `client-${counter}-${uuidCounter}`,
    branchId: branch.id, categoryId: category.id, accountId: account.id,
    currency, amountMinor: amount, expenseDate: date, memo,
  });
}

function balanceOf(finance, companyId, accountId) {
  return finance.accountBalances(companyId).find((b) => b.accountId === accountId);
}

test('schema is additive and idempotent; SCHEMA_VERSION is not bumped', { skip: skipReason }, () => {
  const { dataDir } = fixture();
  db.closeDb();
  db.initDb(dataDir);
  require('../main/db/financeSchema').ensureFinanceSchema(db.getDb());
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['finance_settings', 'finance_categories', 'finance_accounts', 'finance_expenses']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const triggers = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name);
  for (const t of ['trg_finance_expenses_no_delete', 'trg_finance_expenses_frozen']) assert.ok(triggers.includes(t), `missing trigger ${t}`);
  assert.equal(db.SCHEMA_VERSION, 2);
  assert.equal(db.getAppState('schema_version'), '2');
});

test('the nine starting categories seed once, each with an expense account', { skip: skipReason }, () => {
  const { company, finance } = fixture();
  const list = finance.listCategories(company.id);
  assert.equal(list.length, 9);
  assert.deepEqual(list.map((c) => c.name),
    ['Rent', 'Salaries', 'Fuel', 'Utilities', 'Stock purchases', 'Repairs', 'Transport', 'Tax and fees', 'Other']);
  assert.equal(new Set(list.map((c) => c.glAccountCode)).size, 9, 'each category has its own account');
  for (const c of list) assert.ok(c.glAccountId && c.glAccountCode && c.glAccountName, c.key);
  finance.ensureFinance(company.id);
  assert.equal(finance.listCategories(company.id).length, 9, 'idempotent');
  // A second company gets its own nine.
  const other = require('../main/db/companies').create({ name: 'Other Finance Co', isActive: false });
  finance.ensureFinance(other.id);
  assert.equal(finance.listCategories(other.id).length, 9);
});

test('settings: $100 default, editable, audited with companyId', { skip: skipReason }, () => {
  const { company, finance } = fixture();
  assert.equal(finance.getSettings(company.id).approvalThresholdMinor, 10000);
  assert.equal(finance.updateSettings(company.id, { approvalThresholdMinor: 50000 }).approvalThresholdMinor, 50000);
  assert.equal(finance.getSettings(company.id).approvalThresholdMinor, 50000);
  assert.throws(() => finance.updateSettings(company.id, { approvalThresholdMinor: -1 }), /0 or more/);
  assert.throws(() => finance.updateSettings(company.id, { approvalThresholdMinor: 1.5 }), /whole number/);
  const rows = db.getDb().prepare("SELECT before_json, after_json FROM audit_log WHERE entity_type = 'finance_settings'").all();
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.match(r.before_json, /companyId/);
    assert.match(r.after_json, /companyId/);
  }
});

test('one active cash box per branch; retire and restore', { skip: skipReason }, () => {
  const { company, b1, b2, finance } = fixture();
  const cash1 = cash(finance, company.id, b1);
  assert.equal(cash1.kind, 'cash');
  assert.ok(cash1.glAccountId && cash1.glAccountCode);
  assert.throws(() => cash(finance, company.id, b1), /already has an active cash box/);
  const bank = finance.saveAccount(company.id, { kind: 'bank', name: 'ABA USD', currency: 'USD' });
  assert.equal(bank.branchId, null, 'a bank account may be company-wide');
  cash(finance, company.id, b2);

  finance.saveAccount(company.id, { id: cash1.id, archived: true });
  const replacement = cash(finance, company.id, b1);
  assert.throws(() => finance.saveAccount(company.id, { id: cash1.id, archived: false }), /already has an active cash box/);
  finance.saveAccount(company.id, { id: replacement.id, archived: true });
  assert.equal(finance.saveAccount(company.id, { id: cash1.id, archived: false }).archived, false);
  assert.throws(() => finance.saveAccount(company.id, { kind: 'cash', name: 'No branch', currency: 'USD' }), /branch is required/i);
});

test('account create + opening is one transaction and retryable by id', { skip: skipReason }, () => {
  const { company, b1, finance } = fixture();
  const raw = db.getDb();
  const financeGl = () => raw.prepare("SELECT COUNT(*) AS c FROM gl_accounts WHERE company_id = ? AND system_key LIKE 'fin.acct.%'").get(company.id).c;
  const id = 'acct-retry-1';

  // 10 riel is worth less than one US cent, which the ledger cannot record.
  assert.throws(() => finance.saveAccount(company.id, {
    id, kind: 'bank', name: 'Retry bank', currency: 'KHR', opening: { minor: 10, date: '2026-01-01' },
  }), /worth less than 1 US cent/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM finance_accounts WHERE company_id = ?').get(company.id).c, 0, 'the failed create left no account');
  assert.equal(financeGl(), 0, 'the failed create left no GL account');
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM journal_entries WHERE company_id = ?').get(company.id).c, 0, 'the failed create left no journal');

  // Retrying the same provided id creates exactly one account and one opening journal.
  const created = finance.saveAccount(company.id, {
    id, kind: 'bank', name: 'Retry bank', currency: 'USD', opening: { minor: 50000, date: '2026-01-01' },
  });
  assert.equal(created.id, id);
  const retried = finance.saveAccount(company.id, {
    id, kind: 'bank', name: 'Retry bank', currency: 'USD', opening: { minor: 50000, date: '2026-01-01' },
  });
  assert.equal(retried.openingJournalId, created.openingJournalId, 'same opening is a retry, not a second posting');
  assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE company_id = ? AND source_kind = 'finance_opening'").get(company.id).c, 1);
  assert.equal(balanceOf(finance, company.id, id).nativeMinor, 50000);

  // Identity, currency and a recorded opening are not editable.
  assert.throws(() => finance.saveAccount(company.id, { id, kind: 'cash', branchId: b1.id, name: 'Retry bank', currency: 'USD' }), /cannot change between a cash box and a bank account/);
  assert.throws(() => finance.saveAccount(company.id, { id, currency: 'KHR' }), /cannot change its currency/);
  assert.throws(() => finance.saveAccount(company.id, { id, opening: { minor: 60000, date: '2026-01-01' } }), /already has an opening balance/);
  finance.saveAccount(company.id, { id, opening: { minor: 50000, date: '2026-01-01' } });

  // A caller cannot take over another company's account id.
  const other = require('../main/db/companies').create({ name: 'Other Finance Co', isActive: true });
  assert.throws(() => finance.saveAccount(other.id, { id, kind: 'bank', name: 'Hijack', currency: 'USD' }), /not in this company/);

  // An account created without an opening can receive one later.
  const plain = finance.saveAccount(company.id, { kind: 'bank', name: 'Plain bank', currency: 'USD' });
  assert.equal(plain.openingMinor, 0);
  const opened = finance.saveAccount(company.id, { id: plain.id, opening: { minor: 25000, date: '2026-01-02' } });
  assert.equal(opened.openingMinor, 25000);
  assert.ok(opened.openingJournalId);
  assert.equal(financeGl(), 2, 'one GL account per money account, no orphans');
});

test('USD: dated opening and an expense post one balanced journal; balances derive from it', { skip: skipReason }, () => {
  const { company, b1, finance, ledger } = fixture();
  const { rent } = cats(finance, company.id);
  const account = cash(finance, company.id, b1, 'USD', { minor: 50000, date: '2026-01-01' });
  assert.equal(account.openingMinor, 50000);
  assert.ok(account.openingJournalId);
  assert.equal(balanceOf(finance, company.id, account.id).nativeMinor, 50000);

  const d = draft(finance, company.id, { branch: b1, category: rent, account, amount: 1000 });
  const posted = finance.submitExpense(company.id, d.id);
  assert.equal(posted.status, 'posted');
  assert.equal(posted.usdMinor, 1000);
  assert.equal(posted.khrMinor, 41000);
  assert.equal(posted.fxKhrPerUsd, 4100);
  assert.equal(posted.thresholdMinor, 10000);
  assert.ok(posted.journalEntryId);

  const entry = ledger.getEntry(posted.journalEntryId);
  assert.equal(entry.totalMinor, 1000);
  assert.equal(entry.khrTotal, 41000);
  assert.equal(entry.period, '2026-03');
  const expenseLine = entry.lines.find((l) => l.lineRole === 'expense');
  const moneyLine = entry.lines.find((l) => l.lineRole === 'money');
  assert.equal(expenseLine.accountId, rent.glAccountId);
  assert.equal(expenseLine.debitMinor, 1000);
  assert.equal(expenseLine.khrMinor, 41000);
  assert.equal(expenseLine.txnCurrency, 'USD');
  assert.equal(expenseLine.txnAmountMinor, 1000);
  assert.equal(moneyLine.accountId, account.glAccountId);
  assert.equal(moneyLine.creditMinor, 1000);
  assert.equal(moneyLine.khrMinor, 41000);

  const bal = balanceOf(finance, company.id, account.id);
  assert.equal(bal.nativeMinor, 49000);
  assert.equal(bal.usdMinor, 49000);
  assert.equal(bal.currency, 'USD');
});

test('KHR: the original riel balances both lines exactly; below one cent is refused', { skip: skipReason }, () => {
  const { company, b2, finance, ledger } = fixture();
  const { fuel } = cats(finance, company.id);
  const account = cash(finance, company.id, b2, 'KHR', { minor: 410000, date: '2026-01-01' });
  const bal0 = balanceOf(finance, company.id, account.id);
  assert.equal(bal0.nativeMinor, 410000);
  assert.equal(bal0.usdMinor, 10000);

  const d = draft(finance, company.id, { branch: b2, category: fuel, account, amount: 41000, currency: 'KHR' });
  const posted = finance.submitExpense(company.id, d.id);
  assert.equal(posted.status, 'posted');
  assert.equal(posted.usdMinor, 1000);
  assert.equal(posted.khrMinor, 41000);
  const entry = ledger.getEntry(posted.journalEntryId);
  assert.equal(entry.khrTotal, 41000);
  for (const line of entry.lines) {
    assert.equal(line.khrMinor, 41000);
    assert.equal(line.txnCurrency, 'KHR');
    assert.equal(line.txnAmountMinor, 41000);
  }
  const bal = balanceOf(finance, company.id, account.id);
  assert.equal(bal.nativeMinor, 369000);
  assert.equal(bal.usdMinor, 9000);

  const tiny = draft(finance, company.id, { branch: b2, category: fuel, account, amount: 1, currency: 'KHR' });
  assert.throws(() => finance.submitExpense(company.id, tiny.id), /less than 1 US cent/);
});

test('threshold: exactly $100 posts; above it waits, rejects or approves with frozen values', { skip: skipReason }, () => {
  const { company, b1, finance, ledger, fx } = fixture();
  const { rent } = cats(finance, company.id);
  const account = cash(finance, company.id, b1, 'USD', { minor: 100000, date: '2026-01-01' });

  const atLimit = draft(finance, company.id, { branch: b1, category: rent, account, amount: 10000 });
  assert.equal(finance.submitExpense(company.id, atLimit.id).status, 'posted', 'exactly $100 does not exceed');

  const over = draft(finance, company.id, { branch: b1, category: rent, account, amount: 10001 });
  const pending = finance.submitExpense(company.id, over.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.journalEntryId, null, 'waiting posts no journal');
  assert.equal(pending.usdMinor, 10001);
  assert.equal(pending.thresholdMinor, 10000);
  const journals = db.getDb().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;

  assert.throws(() => finance.rejectExpense(company.id, over.id), /reason is required/);
  const rejected = finance.rejectExpense(company.id, over.id, { reason: 'Not approved this month' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, journals, 'rejection moves no money');
  assert.equal(finance.rejectExpense(company.id, over.id, { reason: 'again' }).status, 'rejected', 'a retry changes nothing');

  const waiting = draft(finance, company.id, { branch: b1, category: rent, account, amount: 20000 });
  const frozen = finance.submitExpense(company.id, waiting.id);
  assert.equal(frozen.status, 'pending');
  // Change both the threshold and the rate for that date after submit.
  finance.updateSettings(company.id, { approvalThresholdMinor: 0 });
  fx.setRate({ companyId: company.id, rateDate: '2026-03-10', khrPerUsd: 5000 });

  const approved = finance.approveExpense(company.id, frozen.id);
  assert.equal(approved.status, 'posted');
  assert.equal(approved.fxKhrPerUsd, 4100, 'the frozen rate is used, not the new one');
  assert.equal(approved.khrMinor, 820000);
  const entry = ledger.getEntry(approved.journalEntryId);
  assert.equal(entry.fxKhrPerUsd, 4100);
  assert.equal(entry.khrTotal, 820000);
  const afterCount = db.getDb().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  assert.equal(finance.approveExpense(company.id, frozen.id).journalEntryId, approved.journalEntryId, 'a retry posts nothing');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, afterCount);
  assert.equal(finance.approveExpense(company.id, atLimit.id).status, 'posted', 'approving a posted expense is a no-op');
});

test('only drafts edit; submitted values are frozen; no delete; a reversal is posted', { skip: skipReason }, () => {
  const { company, b1, finance, ledger } = fixture();
  const { rent } = cats(finance, company.id);
  const account = cash(finance, company.id, b1, 'USD', { minor: 100000, date: '2026-01-01' });
  const d = draft(finance, company.id, { branch: b1, category: rent, account, amount: 5000 });
  const posted = finance.submitExpense(company.id, d.id);

  assert.throws(() => finance.saveDraft(company.id, { id: posted.id, memo: 'changed' }), /only a draft can be edited/);
  const raw = db.getDb();
  assert.throws(() => raw.prepare('UPDATE finance_expenses SET usd_minor = 1 WHERE id = ?').run(posted.id), /frozen/);
  assert.throws(() => raw.prepare('DELETE FROM finance_expenses WHERE id = ?').run(posted.id), /never deleted/);

  assert.equal(balanceOf(finance, company.id, account.id).nativeMinor, 95000);
  const reversed = finance.reverseExpense(company.id, posted.id, { reason: 'Wrong amount', date: '2026-04-02' });
  assert.equal(reversed.status, 'reversed');
  assert.ok(reversed.reversalJournalId);
  const revEntry = ledger.getEntry(reversed.reversalJournalId);
  assert.equal(revEntry.period, '2026-04');
  assert.equal(revEntry.reversesEntryId, posted.journalEntryId);
  assert.equal(revEntry.totalMinor, 5000);
  assert.equal(balanceOf(finance, company.id, account.id).nativeMinor, 100000, 'the reversal cancels it');
  assert.equal(finance.reverseExpense(company.id, posted.id, { reason: 'again' }).reversalJournalId, reversed.reversalJournalId);

  const draft2 = draft(finance, company.id, { branch: b1, category: rent, account, amount: 100 });
  assert.throws(() => finance.reverseExpense(company.id, draft2.id, { reason: 'x' }), /cannot be reversed/);
  assert.equal(finance.cancelExpense(company.id, draft2.id).status, 'cancelled');
  assert.throws(() => finance.submitExpense(company.id, draft2.id), /cannot be submitted again/);
  assert.throws(() => finance.cancelExpense(company.id, posted.id), /cannot be cancelled/);
});

test('draft revision conflicts and clientUuid replay', { skip: skipReason }, () => {
  const { company, b1, finance } = fixture();
  const { rent } = cats(finance, company.id);
  const account = cash(finance, company.id, b1);
  const d = draft(finance, company.id, { branch: b1, category: rent, account, amount: 100, memo: 'first', clientUuid: 'stable-uuid' });
  assert.equal(d.revision, 1);
  const edited = finance.saveDraft(company.id, { id: d.id, memo: 'second', revision: 1 });
  assert.equal(edited.revision, 2);
  assert.equal(edited.memo, 'second');
  assert.throws(() => finance.saveDraft(company.id, { id: d.id, memo: 'stale', revision: 1 }), /CONFLICT/);
  // The same client uuid returns the same row and does not mutate it.
  const replay = finance.saveDraft(company.id, { clientUuid: 'stable-uuid', memo: 'should not apply', amountMinor: 999 });
  assert.equal(replay.id, d.id);
  assert.equal(replay.memo, 'second');
  assert.equal(replay.amountMinor, 100);
  assert.throws(() => finance.saveDraft(company.id, { clientUuid: 'x'.repeat(201) }), /200 characters/);
});

test('receipt metadata: path guard, revision bump, draft or pending only', { skip: skipReason }, () => {
  const { company, b1, finance } = fixture();
  const { rent } = cats(finance, company.id);
  const account = cash(finance, company.id, b1);
  const d = draft(finance, company.id, { branch: b1, category: rent, account, amount: 500 });
  const sha = 'a'.repeat(64);
  const withReceipt = finance.setReceipt(company.id, d.id, {
    relativePath: 'finance/receipts/abc.jpg', mime: 'image/jpeg', sha256: sha, originalName: 'receipt.jpg', size: 1234,
  });
  assert.equal(withReceipt.revision, 2, 'a receipt write bumps the revision');
  assert.equal(withReceipt.receipt.relPath, 'finance/receipts/abc.jpg');
  assert.equal(withReceipt.receipt.mimeType, 'image/jpeg');
  assert.equal(withReceipt.receipt.byteSize, 1234);
  assert.equal(withReceipt.receipt.sha256, sha);
  assert.equal(withReceipt.receipt.originalName, 'receipt.jpg');
  assert.throws(() => finance.setReceipt(company.id, d.id, { relativePath: '/etc/passwd' }), /inside the data folder/);
  assert.throws(() => finance.setReceipt(company.id, d.id, { relativePath: 'a/../../b' }), /inside the data folder/);
  assert.equal(finance.setReceipt(company.id, d.id, null).receipt, null);

  const posted = finance.submitExpense(company.id, d.id);
  assert.throws(() => finance.setReceipt(company.id, posted.id, { relativePath: 'finance/receipts/x.jpg' }), /before the expense is posted/);
});

test('reports: posted by journal period, branch and category; pending separate; scope filter', { skip: skipReason }, () => {
  const { company, b1, b2, finance } = fixture();
  const { rent, fuel } = cats(finance, company.id);
  const a1 = cash(finance, company.id, b1, 'USD', { minor: 1000000, date: '2026-01-01' });
  const a2 = cash(finance, company.id, b2, 'USD', { minor: 1000000, date: '2026-01-01' });
  finance.submitExpense(company.id, draft(finance, company.id, { branch: b1, category: rent, account: a1, amount: 5000, date: '2026-05-04' }).id);
  finance.submitExpense(company.id, draft(finance, company.id, { branch: b2, category: fuel, account: a2, amount: 2000, date: '2026-05-09' }).id);
  finance.submitExpense(company.id, draft(finance, company.id, { branch: b1, category: rent, account: a1, amount: 20000, date: '2026-05-20' }).id); // pending

  const report = finance.reports(company.id, { month: '2026-05' });
  assert.equal(report.posted.total.usdMinor, 7000);
  assert.equal(report.posted.total.count, 2);
  const byBranch = Object.fromEntries(report.posted.byBranch.map((r) => [r.branchId, r.usdMinor]));
  assert.equal(byBranch[b1.id], 5000);
  assert.equal(byBranch[b2.id], 2000);
  const byCategory = Object.fromEntries(report.posted.byCategory.map((r) => [r.categoryId, r.usdMinor]));
  assert.equal(byCategory[rent.id], 5000);
  assert.equal(byCategory[fuel.id], 2000);
  assert.equal(report.pending.total.usdMinor, 20000);
  assert.equal(report.pending.total.count, 1);
  assert.equal(report.rate.khrPerUsd, 4100);
  assert.ok(Array.isArray(report.balances) && report.balances.length >= 2);

  const scoped = finance.reports(company.id, { month: '2026-05', branchIds: [b1.id] });
  assert.equal(scoped.posted.total.usdMinor, 5000);
  assert.equal(scoped.posted.byBranch.length, 1);
  assert.ok(scoped.balances.every((b) => b.branchId === b1.id || b.branchId == null));

  const list = finance.listExpenses(company.id, { month: '2026-05', branchIds: [b1.id] });
  assert.equal(list.total, 2);
  assert.equal(list.page, 1);
  assert.equal(list.pageSize, 50);
  assert.ok(list.rows.every((r) => r.branchId === b1.id));
});

test('reports retain each expense category when ledger accounts are shared or repointed', { skip: skipReason }, () => {
  const { company, b1, finance } = fixture();
  const { rent, fuel } = cats(finance, company.id);
  const account = cash(finance, company.id, b1);
  const posted = finance.submitExpense(company.id, draft(finance, company.id, {
    branch: b1, category: rent, account, amount: 5000, date: '2026-05-04',
  }).id);
  const shared = finance.saveCategory(company.id, { name: 'Shared ledger account', glAccountId: rent.glAccountId });
  const report = finance.reports(company.id, { month: '2026-05' });
  assert.equal(report.posted.total.usdMinor, 5000, 'shared ledger accounts never multiply journal lines');
  assert.equal(report.posted.byCategory.length, 1);
  assert.equal(report.posted.byCategory[0].categoryId, rent.id);
  assert.equal(finance.reports(company.id, { month: '2026-05', categoryIds: [shared.id] }).posted.total.usdMinor, 0);

  finance.reverseExpense(company.id, posted.id, { reason: 'Wrong amount', date: '2026-06-02' });
  finance.saveCategory(company.id, { id: rent.id, glAccountId: fuel.glAccountId });
  for (const [month, total] of [['2026-05', 5000], ['2026-06', -5000]]) {
    const historical = finance.reports(company.id, { month, categoryIds: [rent.id] });
    assert.equal(historical.posted.total.usdMinor, total);
    assert.equal(historical.posted.byCategory[0].categoryId, rent.id);
  }
});

test('a locked month posts into the next open month; the report follows the journal', { skip: skipReason }, () => {
  const { company, b1, finance, ledger } = fixture();
  const { rent } = cats(finance, company.id);
  const account = cash(finance, company.id, b1, 'USD', { minor: 100000, date: '2026-01-01' });
  ledger.lockPeriod(company.id, '2026-03', 'Books closed through March');
  const d = draft(finance, company.id, { branch: b1, category: rent, account, amount: 3000, date: '2026-03-15' });
  const posted = finance.submitExpense(company.id, d.id);
  const entry = ledger.getEntry(posted.journalEntryId);
  assert.equal(entry.period, '2026-04');
  assert.equal(entry.entryDate, '2026-04-01');
  assert.equal(entry.intendedDate, '2026-03-15');
  assert.equal(finance.reports(company.id, { month: '2026-03' }).posted.total.usdMinor, 0);
  assert.equal(finance.reports(company.id, { month: '2026-04' }).posted.total.usdMinor, 3000);
});

test('company, branch, category, account and currency scope are enforced', { skip: skipReason }, () => {
  const { company, b1, b2, finance } = fixture();
  const { rent } = cats(finance, company.id);
  const account = cash(finance, company.id, b1);
  const other = require('../main/db/companies').create({ name: 'Scope Other Co', isActive: false });
  const otherBranch = require('../main/db/branches').create({ companyId: other.id, code: 'X1', nameEn: 'Elsewhere' });
  const otherAccount = finance.saveAccount(other.id, { kind: 'bank', name: 'Other bank', currency: 'USD' });

  assert.throws(() => draft(finance, company.id, { branch: otherBranch, category: rent, account }), /not in this company/);
  assert.throws(() => draft(finance, company.id, { branch: b1, category: rent, account: otherAccount }), /not in this company/);

  const d = draft(finance, company.id, { branch: b1, category: rent, account, amount: 500 });
  assert.throws(() => finance.getExpense(other.id, d.id), /not in this company/);

  // A retired category cannot receive a new expense.
  finance.saveCategory(company.id, { id: rent.id, archived: true });
  assert.throws(() => finance.submitExpense(company.id, d.id), /retired/);
  finance.saveCategory(company.id, { id: rent.id, archived: false });
  assert.equal(finance.submitExpense(company.id, d.id).status, 'posted');

  // Currency must match the chosen account.
  const mismatch = draft(finance, company.id, { branch: b1, category: rent, account, amount: 500, currency: 'KHR' });
  assert.throws(() => finance.submitExpense(company.id, mismatch.id), /must be recorded in USD/);

  // A branch-bound account cannot be used for another branch.
  const b2Cash = cash(finance, company.id, b2);
  assert.throws(() => draft(finance, company.id, { branch: b1, category: rent, account: b2Cash }), /belongs to another branch/);
});

test('Finance system accounts never mask the seeded Assets chart', { skip: skipReason }, () => {
  const { company, ledger } = fixture();
  const raw = db.getDb();
  // Pretend the chart has not seeded yet, and Finance has grown well past the
  // seed count with its own fin.* system accounts.
  raw.prepare("DELETE FROM gl_accounts WHERE company_id = ? AND system_key LIKE 'fa.%'").run(company.id);
  const ins = raw.prepare('INSERT INTO gl_accounts (id, company_id, code, name_en, type, normal_balance, system_key, is_postable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
  for (let i = 0; i < 40; i += 1) ins.run(`fin-test-${i}`, company.id, `96${String(i).padStart(2, '0')}`, `Fin test ${i}`, 'expense', 'debit', `fin.test.${i}`, Date.now(), Date.now());
  ledger.ensureChart(company.id);
  const keys = ledger.listAccounts(company.id).map((a) => a.systemKey);
  assert.ok(keys.includes('fa.cost.land'), 'the Assets chart seeds even with 40+ fin.* accounts present');
});

test('a new category arrives with a stable client id and creates once', { skip: skipReason }, () => {
  const { company, finance } = fixture();
  const clientId = `fc-client-${counter}`;
  const created = finance.saveCategory(company.id, { id: clientId, name: 'Supplies', sort: 12 });
  assert.equal(created.id, clientId, 'the client id becomes the row id');
  assert.equal(created.name, 'Supplies');
  // A lost reply retried with the same id updates, never duplicates.
  const retry = finance.saveCategory(company.id, { id: clientId, name: 'Supplies' });
  assert.equal(retry.id, clientId);
  assert.equal(finance.listCategories(company.id, { includeArchived: true }).filter((c) => c.name === 'Supplies').length, 1);
  // An id owned by another company is refused, not adopted.
  const other = require('../main/db/companies').create({ name: `Other Co ${counter}`, isActive: true });
  assert.throws(() => finance.saveCategory(other.id, { id: clientId, name: 'Hijack' }), /not in this company/);
});
