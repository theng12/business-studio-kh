const finance = require('../db/finance');
const branches = require('../db/branches');
const { getDb } = require('../db');
const { activeCompanyId } = require('./fuelAccess');
const { denied, permissions, requireOwner, supervisedBranches, branchScope, requireBranch, emitFinanceChange } = require('./financeAccess');
const { userError } = require('../util/userError');

function publicExpense(row) {
  if (!row) return null;
  return {
    ...row,
    approvalThresholdMinor: row.thresholdMinor,
    receipt: row.receipt ? {
      mimeType: row.receipt.mimeType, byteSize: row.receipt.byteSize,
      width: row.receipt.width, height: row.receipt.height,
      originalName: row.receipt.originalName, updatedAt: row.receipt.updatedAt,
    } : null,
  };
}

function publicAccount(row, balances = false) {
  const result = {
    id: row.id, companyId: row.companyId, name: row.name, kind: row.kind,
    branchId: row.branchId, branchCode: row.branchCode, branchName: row.branchName,
    currency: row.currency, archivedAt: row.archivedAt, updatedAt: row.updatedAt,
  };
  if (balances) Object.assign(result, {
    openingMinor: row.openingMinor, openingDate: row.openingDate,
    balanceMinor: row.balance?.nativeMinor ?? null, balanceUsdMinor: row.balance?.usdMinor ?? null,
  });
  return result;
}

function publicCategory(row) {
  return { id: row.id, name: row.name, sort: row.sort, archivedAt: row.archivedAt };
}

function company(requested) {
  const id = activeCompanyId(requested);
  branchScope(id);
  finance.ensureFinance(id);
  return id;
}

function expense(companyId, id, write = false) {
  const row = finance.getExpense(companyId, id);
  if (!row || row.companyId !== companyId) throw userError('Expense not found', 'NOT_FOUND');
  const scope = branchScope(companyId, { write });
  if (scope !== null && !scope.includes(row.branchId)) throw denied('That expense is outside the branches you supervise');
  return row;
}

function viewAll() {
  if (!permissions().canViewAll) throw denied('You do not have permission to view company Finance reports');
}

function changed(row, op, companyId, kind = 'expense') {
  emitFinanceChange(kind, op, row?.id, companyId);
  return kind === 'expense' ? publicExpense(row) : row;
}

function register({ expose }) {
  expose('finance:context', () => {
    const companyId = company();
    const allowed = permissions();
    const scope = branchScope(companyId);
    const recordBranchIds = allowed.canManage ? null : allowed.canRecord ? supervisedBranches(companyId) : [];
    return {
      companyId, permissions: allowed, recordBranchIds,
      branches: branches.list(companyId, { status: null })
        .filter(b => scope === null || scope.includes(b.id))
        .map(b => ({ id: b.id, code: b.code, nameEn: b.nameEn, status: b.status })),
      categories: finance.listCategories(companyId, { includeArchived: true }).map(publicCategory),
      accounts: finance.listAccounts(companyId, { includeArchived: true })
        .filter(a => scope === null || scope.includes(a.branchId) || (a.kind === 'bank' && !a.branchId))
        .map(a => publicAccount(a)),
      settings: finance.getSettings(companyId),
      // The shared rate, for display hints only (the server still decides).
      // The phone reads context directly and has no separate fx call.
      rate: require('../db/fxRates').sharedRate(companyId),
    };
  });
  expose('finance:list', (opts = {}) => {
    const companyId = company();
    let branchIds = branchScope(companyId);
    if (opts.branchId) {
      requireBranch(companyId, opts.branchId);
      branchIds = [opts.branchId];
    }
    const result = finance.listExpenses(companyId, {
      branchIds, month: opts.month, categoryIds: opts.categoryId ? [opts.categoryId] : null,
      status: opts.status, search: opts.q, page: opts.page, pageSize: opts.pageSize,
    });
    return { ...result, rows: result.rows.map(publicExpense) };
  });
  expose('finance:get', (id) => publicExpense(expense(company(), id)));
  expose('finance:saveDraft', (input) => {
    const companyId = company(input.companyId);
    const scope = branchScope(companyId, { write: true });
    let existing = finance.getExpense(companyId, input.id);
    if (!existing) {
      const replay = getDb().prepare('SELECT id FROM finance_expenses WHERE company_id = ? AND client_uuid = ?').get(companyId, input.id);
      if (replay) {
        existing = expense(companyId, replay.id, true);
        // A lost creation reply must return its existing draft, never create another.
        if (input.revision == null) return publicExpense(existing);
      }
    }
    if (existing) {
      expense(companyId, existing.id, true);
      if (input.revision == null) throw userError('Reload this expense before saving again');
    }
    const branchId = input.branchId === undefined ? existing?.branchId : input.branchId;
    if (branchId) requireBranch(companyId, branchId, { write: true });
    else if (scope !== null) throw denied('Choose a branch you supervise before saving an expense');
    const accountId = input.accountId === undefined ? existing?.accountId : input.accountId;
    if (accountId && scope !== null) {
      const account = finance.getAccount(companyId, accountId);
      if (!account || (account.branchId ? !scope.includes(account.branchId) : account.kind !== 'bank')) {
        throw denied('That money account is outside the branches you supervise');
      }
    }
    const patch = { ...input };
    delete patch.companyId;
    if (existing) patch.id = existing.id;
    else { delete patch.id; patch.clientUuid = input.id; }
    return changed(finance.saveDraft(companyId, patch), 'save', companyId);
  });
  expose('finance:submit', ({ id }) => {
    const companyId = company();
    expense(companyId, id, true);
    return changed(finance.submitExpense(companyId, id), 'submit', companyId);
  });
  expose('finance:approve', ({ id }) => {
    requireOwner();
    const companyId = company();
    expense(companyId, id);
    return changed(finance.approveExpense(companyId, id), 'approve', companyId);
  });
  expose('finance:reject', ({ id, reason }) => {
    requireOwner();
    const companyId = company();
    expense(companyId, id);
    return changed(finance.rejectExpense(companyId, id, { reason }), 'reject', companyId);
  });
  expose('finance:cancel', ({ id, reason }) => {
    const companyId = company();
    expense(companyId, id, true);
    return changed(finance.cancelExpense(companyId, id, { reason }), 'cancel', companyId);
  });
  expose('finance:reverse', ({ id, reason }) => {
    requireOwner();
    const companyId = company();
    expense(companyId, id);
    return changed(finance.reverseExpense(companyId, id, { reason }), 'reverse', companyId);
  });
  expose('finance:accounts', (opts = {}) => {
    viewAll();
    const companyId = company();
    const balances = new Map(finance.accountBalances(companyId).map(b => [b.accountId, b]));
    return finance.listAccounts(companyId, opts).map(a => {
      const balance = balances.get(a.id);
      return publicAccount({ ...a, balance }, true);
    });
  });
  expose('finance:saveAccount', (input) => {
    requireOwner();
    const companyId = company(input.companyId);
    const patch = { ...input };
    delete patch.companyId;
    delete patch.openingMinor;
    delete patch.openingDate;
    delete patch.archivedAt;
    if (Object.hasOwn(input, 'archivedAt')) patch.archived = input.archivedAt != null;
    if (input.openingMinor != null || input.openingDate != null) patch.opening = { minor: input.openingMinor, date: input.openingDate };
    const row = finance.saveAccount(companyId, patch);
    emitFinanceChange('account', 'save', row.id, companyId);
    const balance = finance.accountBalances(companyId).find(b => b.accountId === row.id);
    return publicAccount({ ...row, balance }, true);
  });
  expose('finance:saveCategory', (input) => {
    requireOwner();
    const companyId = company(input.companyId);
    const patch = { ...input };
    delete patch.companyId;
    delete patch.archivedAt;
    if (Object.hasOwn(input, 'archivedAt')) patch.archived = input.archivedAt != null;
    const row = finance.saveCategory(companyId, patch);
    emitFinanceChange('category', 'save', row.id, companyId);
    return publicCategory(row);
  });
  expose('finance:updateSettings', (input) => {
    requireOwner();
    const companyId = company();
    const result = finance.updateSettings(companyId, input);
    emitFinanceChange('settings', 'save', null, companyId);
    return result;
  });
  expose('finance:reports', ({ month }) => {
    viewAll();
    const result = finance.reports(company(), { month });
    return {
      month: result.month, rate: result.rate,
      byBranch: result.posted.byBranch.map(r => ({ branchId: r.branchId, name: r.branchName, totalUsdMinor: r.usdMinor })),
      byCategory: result.posted.byCategory.map(r => ({ categoryId: r.categoryId, name: r.categoryName, totalUsdMinor: r.usdMinor })),
      pending: { count: result.pending.total.count, totalUsdMinor: result.pending.total.usdMinor },
      accounts: result.balances.map(a => ({ id: a.accountId, name: a.name, currency: a.currency, balanceMinor: a.nativeMinor, balanceUsdMinor: a.usdMinor })),
    };
  });
  expose('finance:setReceipt', async ({ expenseId, bytes, originalName }) => {
    const companyId = company();
    const before = expense(companyId, expenseId, true);
    if (before.status !== 'draft') throw userError('Only a draft expense can change its receipt');
    const stored = await require('../financeReceipts').storeReceipt({ companyId, expenseId, bytes, originalName });
    try {
      // Decode is asynchronous: check company, permission and state again before attaching.
      activeCompanyId(companyId);
      const current = expense(companyId, expenseId, true);
      if (current.status !== 'draft') throw userError('Only a draft expense can change its receipt');
      if (current.revision !== before.revision) throw userError('This expense changed while the receipt was uploading — reload and try again');
      const result = finance.setReceipt(companyId, expenseId, {
        relPath: stored.relativePath, mimeType: stored.mime, byteSize: stored.size,
        sha256: stored.sha256, originalName: stored.originalName,
      });
      return changed(result, 'receipt', companyId);
    } catch (error) {
      // Preserve the photo and a private recovery reference when attachment loses a race.
      require('../db/_assetUtil').audit('finance_expense', expenseId, 'receipt_unattached', {
        after: { companyId, receipt: stored, reason: error.message },
      });
      throw error;
    }
  });
  expose('finance:getReceipt', ({ expenseId }) => {
    const row = expense(company(), expenseId);
    if (!row.receipt) throw userError('This expense has no receipt');
    return require('../financeReceipts').readReceipt({
      relativePath: row.receipt.relPath, sha256: row.receipt.sha256, originalName: row.receipt.originalName,
    });
  });
  expose('finance:removeReceipt', ({ expenseId }) => {
    const companyId = company();
    const row = expense(companyId, expenseId, true);
    if (row.status !== 'draft') throw userError('Only a draft expense can change its receipt');
    return changed(finance.setReceipt(companyId, expenseId, null), 'receipt', companyId);
  });
}

module.exports = { register };
