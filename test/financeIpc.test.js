const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ owner = false, viewAll = owner, scope = ['north'] } = {}) {
  const handlers = {};
  const writes = [];
  const rows = new Map([
    ['own', { id: 'own', companyId: 'company', branchId: 'north', status: 'draft', revision: 2,
      thresholdMinor: 10000, receipt: { relPath: 'finance/receipts/private.jpg', sha256: 'checksum', originalName: 'receipt.jpg', byteSize: 50 } }],
    ['other', { id: 'other', companyId: 'company', branchId: 'south', status: 'draft', revision: 1 }],
  ]);
  const deny = (message) => Object.assign(new Error(message || 'denied'), { userFacing: true });
  const domain = {
    ensureFinance() {},
    getExpense: (company, id) => rows.get(id) || null,
    listExpenses: (company, opts) => ({ rows: [...rows.values()].filter(r => opts.branchIds === null || opts.branchIds.includes(r.branchId)), total: 1 }),
    listAccounts: () => [{ id: 'cash', companyId: 'company', branchId: 'north', glAccountId: 'private', openingMinor: 50000, balance: { nativeMinor: 50000 } }],
    accountBalances: () => [{ accountId: 'cash', nativeMinor: 35000, usdMinor: 35000 }],
    listCategories: () => [], getSettings: () => ({ approvalThresholdMinor: 10000 }),
    saveDraft: (company, input) => { writes.push(input); return { ...rows.get(input.id), ...input, id: input.id || 'created', companyId: company }; },
    setReceipt: (company, id, metadata) => { writes.push(metadata); return { ...rows.get(id), receipt: metadata }; },
    approveExpense: (company, id) => { writes.push('approve'); return rows.get(id); },
  };
  let finishPhoto;
  const dependencies = {
    '../db/finance': domain,
    '../db/branches': { list: () => [{ id: 'north' }, { id: 'south' }] },
    '../db': { getDb: () => ({ prepare: () => ({ get: (company, id) => id === 'lost-reply' ? { id: 'own' } : null }) }) },
    './fuelAccess': { activeCompanyId: (requested) => { if (requested && requested !== 'company') throw deny('different company'); return 'company'; } },
    './financeAccess': {
      denied: deny, permissions: () => ({ canRecord: true, canViewAll: viewAll, canManage: owner, canApprove: owner }),
      supervisedBranches: () => scope,
      requireOwner: () => { if (!owner) throw deny('owner only'); },
      branchScope: (company, { write = false } = {}) => {
        if (owner || (!write && viewAll)) return null;
        if (!scope.length) throw deny('does not supervise a branch');
        return scope;
      },
      requireBranch: (company, id) => { if (!owner && !scope.includes(id)) throw deny('outside branch'); },
      emitFinanceChange() {},
    },
    '../util/userError': { userError: deny },
    // finance:context carries the shared rate for display hints.
    '../db/fxRates': { sharedRate: () => ({ khrPerUsd: 4100, rateDate: '2026-11-04' }) },
    '../db/_assetUtil': { audit: (kind, id, op, data) => { writes.push({ audit: true, kind, id, op, data }); } },
    '../financeReceipts': {
      storeReceipt: () => new Promise(resolve => { finishPhoto = resolve; }),
      readReceipt: metadata => metadata,
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/ipc/finance.js'), 'utf8'), {
    module, exports: module.exports, require: name => {
      if (!dependencies[name]) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  module.exports.register({ expose: (channel, handler) => { handlers[channel] = handler; } });
  return { handlers, rows, writes, finishPhoto: metadata => finishPhoto(metadata) };
}

test('Finance handlers enforce row scope and owner authority before any domain write', () => {
  const { handlers, writes } = fixture();
  assert.throws(() => handlers['finance:get']('other'), /outside/);
  assert.throws(() => handlers['finance:getReceipt']({ expenseId: 'other' }), /outside/);
  assert.throws(() => handlers['finance:saveDraft']({ id: 'own', branchId: 'south', revision: 2 }), /outside/);
  assert.throws(() => handlers['finance:approve']({ id: 'own' }), /owner/);
  assert.throws(() => handlers['finance:saveAccount']({ name: 'cash' }), /owner/);
  assert.throws(() => handlers['finance:accounts'](), /permission/);
  assert.equal(writes.length, 0);
});

test('Finance read adapters remove private receipt paths and account financial details', () => {
  const { handlers } = fixture();
  const expense = handlers['finance:get']('own');
  assert.equal(expense.approvalThresholdMinor, 10000);
  assert.equal(expense.receipt.originalName, 'receipt.jpg');
  assert.equal(expense.receipt.relPath, undefined);
  assert.equal(expense.receipt.sha256, undefined);
  const context = handlers['finance:context']();
  assert.equal(context.branches.length, 1);
  assert.equal(context.accounts[0].glAccountId, undefined);
  assert.equal(context.accounts[0].openingMinor, undefined);
  assert.equal(context.accounts[0].balance, undefined);
});

test('A company viewer with recording capability but no managed branch can open Finance', () => {
  const { handlers } = fixture({ viewAll: true, scope: [] });
  const context = handlers['finance:context']();
  assert.equal(context.permissions.canViewAll, true);
  assert.equal(context.recordBranchIds.length, 0);
  assert.equal(context.branches.length, 2);
  assert.throws(() => handlers['finance:saveDraft']({ id: 'new', branchId: 'north' }), /does not supervise/);
});

test('Money account reads include ledger balances rather than missing row fields', () => {
  const { handlers } = fixture({ owner: true });
  const rows = handlers['finance:accounts']();
  assert.equal(rows[0].balanceMinor, 35000);
  assert.equal(rows[0].balanceUsdMinor, 35000);
  assert.equal(rows[0].openingMinor, 50000);
});

test('A lost creation reply reuses its draft; edits require optimistic revision', () => {
  const { handlers, writes } = fixture();
  assert.equal(handlers['finance:saveDraft']({ id: 'lost-reply' }).id, 'own');
  assert.equal(writes.length, 0);
  assert.throws(() => handlers['finance:saveDraft']({ id: 'own', memo: 'overwrite' }), /Reload/);
  handlers['finance:saveDraft']({ id: 'own', revision: 2, memo: 'safe' });
  assert.equal(writes[0].revision, 2);
  handlers['finance:saveDraft']({ id: 'stable-new-id', branchId: 'north' });
  assert.equal(writes[1].clientUuid, 'stable-new-id');
  assert.equal(writes[1].id, undefined);
});

test('Receipt upload rechecks draft state after asynchronous image decoding', async () => {
  const { handlers, rows, writes, finishPhoto } = fixture();
  const upload = handlers['finance:setReceipt']({ expenseId: 'own', bytes: new Uint8Array([1]) });
  rows.get('own').status = 'posted';
  finishPhoto({ relativePath: 'finance/receipts/new.jpg', sha256: 'hash' });
  await assert.rejects(upload, /Only a draft/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, 'receipt_unattached');
  assert.equal(writes[0].data.after.receipt.relativePath, 'finance/receipts/new.jpg');
});

test('Receipt upload persists checksum and original name without exposing the private path', async () => {
  const { handlers, writes, finishPhoto } = fixture();
  const upload = handlers['finance:setReceipt']({ expenseId: 'own', bytes: new Uint8Array([1]) });
  finishPhoto({ relativePath: 'finance/receipts/new.jpg', sha256: 'hash', mime: 'image/jpeg', size: 20, originalName: 'photo.jpg' });
  const saved = await upload;
  assert.equal(writes[0].sha256, 'hash');
  assert.equal(writes[0].originalName, 'photo.jpg');
  assert.equal(saved.receipt.relPath, undefined);
  assert.equal(saved.receipt.originalName, 'photo.jpg');
});
