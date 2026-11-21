/**
 * Trade Finance Phase C — reminders against a real database
 * (docs/TRADE_FINANCE_PLAN.md §3, §5).
 *
 *   1. A company with no rules gets the four defaults, seeded once.
 *   2. A repayment-maturity reminder picks the most urgent crossed lead time.
 *   3. The overdue rule fires, and only once a day.
 *   4. A pre-due rule is logged once, ever.
 *   5. A snoozed drawdown is shown but never logged.
 *   6. A facility's own rules replace the global set for it.
 *   7. Auto-post is off unless a company switches it on.
 *   8. Reminders are scoped to one company.
 *
 * RUNNING THIS. Real SQLite: `npm run test:native`.
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

function fixture(maturityDate = '2026-06-30') {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-trade-rem-${counter}-`));
  db.initDb(dataDir);
  require('../main/db/tradeFinanceSchema').ensureTradeFinanceSchema(db.getDb());
  const company = require('../main/db/companies').create({ name: `Rem Co ${counter}`, isActive: true });
  const other = require('../main/db/companies').create({ name: `Other Rem Co ${counter}`, isActive: true });
  const trade = require('../main/db/tradeFinance');
  const bank = trade.createBank(company.id, { name: 'ABA' });
  const facility = trade.createFacility(company.id, {
    bankId: bank.id, kind: 'TR', name: 'TR line', currency: 'USD', limitMinor: 20_000_000, rate: 7.5,
  });
  const d = trade.createDrawdown(company.id, {
    facilityId: facility.id, principalMinor: 10_000_000, valueDate: '2026-01-01',
    maturityDate, rate: 7.5, reference: 'TR-100',
  });
  return { dataDir, company, other, trade, bank, facility, drawdown: d };
}

test('a company with no rules gets four defaults, seeded once', { skip: skipReason }, () => {
  const { company, trade, dataDir } = fixture();
  const rules = trade.ensureReminderRules(company.id);
  assert.deepEqual(rules.map((r) => r.leadDays), [7, 3, 1, 0]);
  assert.equal(rules.every((r) => r.facilityId === null), true, 'all global');
  assert.equal(trade.ensureReminderRules(company.id).length, 4, 'a second pass does not duplicate');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the most urgent crossed lead fires, then overdue once a day', { skip: skipReason }, () => {
  const { company, trade, dataDir } = fixture();
  const at3 = trade.dueReminders(company.id, '2026-06-27');
  assert.equal(at3.length, 1);
  assert.equal(at3[0].daysTo, 3);
  assert.equal(at3[0].ruleLabel, 'Three days before maturity');
  assert.equal(at3[0].daily, false);

  const overdue = trade.dueReminders(company.id, '2026-07-02');
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].daily, true);
  assert.equal(overdue[0].daysTo, -2);

  assert.equal(trade.recordReminders(company.id, '2026-07-02').length, 1, 'logged the first time');
  assert.equal(trade.recordReminders(company.id, '2026-07-02').length, 0, 'not twice in a day');
  assert.equal(trade.recordReminders(company.id, '2026-07-03').length, 1, 'again the next day');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a pre-due reminder is logged once, ever', { skip: skipReason }, () => {
  const { company, trade, dataDir } = fixture();
  assert.equal(trade.recordReminders(company.id, '2026-06-27').length, 1, 'three days out logs once');
  assert.equal(trade.recordReminders(company.id, '2026-06-28').length, 0, 'two days out is the same three-day rule');
  assert.equal(trade.recordReminders(company.id, '2026-06-29').length, 1, 'one day out is its own rule, logged once');
  assert.equal(trade.recordReminders(company.id, '2026-06-29').length, 0, 'and not again');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a snoozed drawdown shows but is never logged', { skip: skipReason }, () => {
  const { company, trade, drawdown, dataDir } = fixture();
  trade.snoozeDrawdown(company.id, drawdown.id, '2026-07-10');
  const due = trade.dueReminders(company.id, '2026-06-27');
  assert.equal(due.length, 1);
  assert.equal(due[0].snoozed, true);
  assert.equal(due[0].snoozedUntil, '2026-07-10');
  assert.equal(trade.recordReminders(company.id, '2026-06-27').length, 0, 'a snoozed reminder is not surfaced');
  // Waking it brings the reminder back.
  trade.snoozeDrawdown(company.id, drawdown.id, null);
  assert.equal(trade.dueReminders(company.id, '2026-06-27')[0].snoozed, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a facility's own rules replace the global set for it", { skip: skipReason }, () => {
  const { company, trade, facility, dataDir } = fixture();
  trade.saveReminderRule(company.id, { facilityId: facility.id, leadDays: 10, label: 'Ten days — call the bank' });
  const at8 = trade.dueReminders(company.id, '2026-06-22');
  assert.equal(at8.length, 1);
  assert.equal(at8[0].ruleLabel, 'Ten days — call the bank');
  assert.equal(at8[0].daysTo, 8);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('auto-post is off unless switched on', { skip: skipReason }, () => {
  const { company, trade, dataDir } = fixture();
  assert.equal(trade.getSettings(company.id).autoPost, false);
  trade.saveSettings(company.id, { autoPost: true });
  assert.equal(trade.getSettings(company.id).autoPost, true);
  trade.saveSettings(company.id, { autoPost: false });
  assert.equal(trade.getSettings(company.id).autoPost, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('reminders are scoped to one company', { skip: skipReason }, () => {
  const { company, other, trade, dataDir } = fixture();
  assert.equal(trade.dueReminders(company.id, '2026-06-27').length, 1);
  assert.equal(trade.dueReminders(other.id, '2026-06-27').length, 0, 'no facilities, nothing due');
  assert.deepEqual(trade.listReminderLog(other.id), [], 'the other company logged nothing');
  assert.equal(trade.listReminderRules(other.id).length, 4, 'its own defaults, not a share of ours');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
