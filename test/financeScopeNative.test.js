const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let skip = false;
try { new (require('better-sqlite3'))(':memory:').close(); }
catch (error) {
  if (error.code === 'ERR_DLOPEN_FAILED') skip = 'Run npm run test:native with Electron Node';
  else throw error;
}

function fixture(t) {
  const serverPath = require.resolve('../main/server');
  const originalServer = require.cache[serverPath];
  let caller = null;
  require.cache[serverPath] = { id: serverPath, filename: serverPath, loaded: true, exports: { getCurrentUserId: () => caller } };
  const db = require('../main/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-finance-scope-'));
  t.after(() => {
    caller = null;
    db.closeDb();
    if (originalServer) require.cache[serverPath] = originalServer;
    else delete require.cache[serverPath];
    const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'finance-tests');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dir, path.join(trash, path.basename(dir)));
  });
  db.initDb(dir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: 'Scope company' });
  const other = companies.create({ name: 'Other company' });
  const role = require('../main/db/roles').create({ name: 'Branch supervisor', permissions: ['finance.record', 'assets.view', 'history.view'] });
  const user = require('../main/db/users').create({ name: 'Supervisor', role: role.key });
  const employee = require('../main/db/employees').create({ companyId: company.id, staffCode: 'SUP', nameEn: 'Supervisor', userId: user.id });
  const branches = require('../main/db/branches');
  const own = branches.create({ companyId: company.id, code: 'OWN', nameEn: 'Own', managerEmployeeId: employee.id });
  const unassigned = branches.create({ companyId: company.id, code: 'OTHER', nameEn: 'Other' });
  return { db, company, other, user, employee, own, unassigned, setCaller: value => { caller = value; } };
}

test('Real Finance scope uses manager assignment, active employee and caller company', { skip }, t => {
  const f = fixture(t);
  const access = require('../main/ipc/financeAccess');
  f.setCaller(f.user.id);
  assert.deepEqual(access.branchScope(f.company.id, { write: true }), [f.own.id]);
  assert.throws(() => access.requireBranch(f.company.id, f.unassigned.id, { write: true }), /outside/);
  assert.throws(() => access.requireOwner(), /Only the owner/);
  f.db.getDb().prepare('UPDATE employees SET branch_id = ? WHERE id = ?').run(f.unassigned.id, f.employee.id);
  assert.deepEqual(access.branchScope(f.company.id), [f.own.id], 'being assigned to a branch does not make someone its supervisor');
  f.db.getDb().prepare("UPDATE employees SET status = 'suspended' WHERE id = ?").run(f.employee.id);
  assert.throws(() => access.branchScope(f.company.id), /does not supervise/);
  f.setCaller(null);
  assert.equal(access.branchScope(f.company.id), null);
  assert.throws(() => access.branchScope(f.other.id), /different company/);
});

test('Real Finance handlers keep supervised expenses and money account choices scoped', { skip }, t => {
  const f = fixture(t);
  const finance = require('../main/db/finance');
  finance.ensureFinance(f.company.id);
  const date = require('../main/db/_assetUtil').todayPhnomPenh();
  const cash = finance.saveAccount(f.company.id, { name: 'Own cash', kind: 'cash', branchId: f.own.id, currency: 'USD', opening: { minor: 50000, date } });
  const otherCash = finance.saveAccount(f.company.id, { name: 'Other cash', kind: 'cash', branchId: f.unassigned.id, currency: 'USD' });
  const bank = finance.saveAccount(f.company.id, { name: 'Shared bank', kind: 'bank', currency: 'USD' });
  const handlers = {};
  require('../main/ipc/finance').register({ expose: (channel, handler) => { handlers[channel] = handler; } });
  f.setCaller(f.user.id);
  const context = handlers['finance:context']();
  assert.deepEqual(context.accounts.map(a => a.id).sort(), [cash.id, bank.id].sort());
  assert.ok(context.accounts.every(a => !Object.hasOwn(a, 'balanceMinor') && !Object.hasOwn(a, 'glAccountId')));
  const input = { id: 'scope-stable-creation', branchId: f.own.id, accountId: cash.id,
    categoryId: context.categories[0].id, expenseDate: date, currency: 'USD', amountMinor: 1000 };
  assert.throws(() => handlers['finance:saveDraft']({ ...input, accountId: otherCash.id }), /outside/);
  const draft = handlers['finance:saveDraft'](input);
  assert.equal(handlers['finance:saveDraft'](input).id, draft.id, 'lost reply returns the existing draft');
  assert.equal(handlers['finance:submit']({ id: draft.id }).status, 'posted');
  assert.throws(() => handlers['finance:approve']({ id: draft.id }), /Only the owner/);
  f.setCaller(null);
  assert.equal(handlers['finance:accounts']().find(a => a.id === cash.id).balanceMinor, 49000);
  assert.equal(handlers['finance:submit']({ id: draft.id }).journalEntryId, finance.getExpense(f.company.id, draft.id).journalEntryId);
});

test('Assets ledger reads exclude Finance accounts, journals and shared-equity totals', { skip }, t => {
  const f = fixture(t);
  const finance = require('../main/db/finance');
  const ledger = require('../main/db/ledger');
  finance.ensureFinance(f.company.id);
  const date = require('../main/db/_assetUtil').todayPhnomPenh();
  const cash = finance.saveAccount(f.company.id, { name: 'Private cash', kind: 'cash', branchId: f.own.id, currency: 'USD', opening: { minor: 50000, date } });
  const handlers = {};
  require('../main/ipc/ledger').register({ expose: (channel, handler) => { handlers[channel] = handler; } });
  f.setCaller(f.user.id);
  const scoped = handlers['ledger:listAccounts']();
  assert.ok(scoped.every(a => !a.systemKey?.startsWith('fin.')));
  assert.equal(scoped.find(a => a.systemKey === 'equity.opening').balanceMinor, 0, 'shared equity must not reveal Finance openings');
  assert.deepEqual(handlers['ledger:listPeriods'](), []);
  assert.equal(handlers['ledger:checkIntegrity']().checked, 0);
  assert.throws(() => handlers['ledger:getEntry'](cash.openingJournalId), /Finance/);
  assert.throws(() => handlers['ledger:updateAccount']({ id: cash.glAccountId, patch: { nameEn: 'Changed' } }), /owner/);
  f.setCaller(null);
  assert.equal(handlers['ledger:getEntry'](cash.openingJournalId).totalMinor, 50000);
  assert.ok(handlers['ledger:listAccounts']().some(a => a.id === cash.glAccountId));
  handlers['ledger:updateAccount']({ id: cash.glAccountId, patch: { nameEn: 'Owner cash account' } });
  const audit = require('../main/db/auditLog');
  assert.equal(audit.listForEntity('gl_account', cash.glAccountId)[0].sensitivity, 'accounting');
  assert.deepEqual(audit.listForEntity('gl_account', cash.glAccountId, 200, { hide: { accounting: true } }), []);
  assert.equal(ledger.checkIntegrity(f.company.id).checked, 1);
});

test('legacy Assets rate channels cannot bypass shared-rate owner authority', { skip }, t => {
  const f = fixture(t);
  const fx = require('../main/db/fxRates');
  const date = require('../main/db/_assetUtil').todayPhnomPenh();
  const current = fx.setRate({ companyId: f.company.id, rateDate: date, khrPerUsd: 4700 });
  const handlers = {};
  require('../main/ipc/ledger').register({ expose: (channel, handler) => { handlers[channel] = handler; } });
  const role = require('../main/db/roles').create({ name: 'Asset rate editor', permissions: ['assets.manage'] });
  const user = require('../main/db/users').create({ name: 'Asset editor', role: role.key });
  f.setCaller(user.id);
  for (const source of [undefined, 'house']) {
    assert.throws(() => handlers['fx:setRate']({ rateDate: date, khrPerUsd: 9000, source }), /owner/);
  }
  assert.throws(() => handlers['fx:voidRate']({ id: current.id, reason: 'Remove' }), /owner/);
  assert.equal(fx.sharedRate(f.company.id).khrPerUsd, 4700);
  const official = handlers['fx:setRate']({ rateDate: date, khrPerUsd: 4200, source: 'official' });
  assert.equal(handlers['fx:voidRate']({ id: official.id, reason: 'Wrong tax rate' }).voided, true);
  f.setCaller(null);
  assert.throws(() => handlers['fx:voidRate']({ id: current.id, reason: 'Remove' }), /replacement/);
  handlers['fx:setShared']({ khrPerUsd: 4800 });
  assert.equal(fx.sharedRate(f.company.id).khrPerUsd, 4800);
});

test('Finance History is private, company scoped and retained when ordinary history is cleared', { skip }, t => {
  const f = fixture(t);
  const audit = require('../main/db/auditLog');
  require('../main/db/_assetUtil').audit('finance_expense', 'first', 'submit', { after: { companyId: f.company.id, amountMinor: 12000 } });
  require('../main/db/_assetUtil').audit('finance_expense', 'second', 'submit', { after: { companyId: f.other.id, amountMinor: 99000 } });
  assert.equal(audit.listForEntity('finance_expense', 'first')[0].sensitivity, 'accounting');
  assert.equal(audit.listRecent({ hide: { accounting: true } }).some(row => row.entityType === 'finance_expense'), false);
  const own = audit.listRecent({ entityType: 'finance_expense', hide: { accountingCompanyId: f.company.id } });
  assert.deepEqual(own.map(row => row.entityId), ['first']);
  f.setCaller(f.user.id);
  const handlers = {};
  require('../main/ipc/audit').register({ expose: (channel, handler) => { handlers[channel] = handler; } });
  assert.deepEqual(handlers['audit:listForEntity']({ entityType: 'finance_expense', entityId: 'first' }), []);
  assert.equal(handlers['audit:listRecent']({}).some(row => row.entityType === 'finance_expense'), false, 'Assets access cannot expose expense history');
  f.setCaller(null);
  assert.deepEqual(handlers['audit:listRecent']({ entityType: 'finance_expense' }).map(row => row.entityId), ['first']);
  audit.clearOlderThan(0);
  assert.equal(audit.countRecent({ entityType: 'finance_expense' }), 2);
});
