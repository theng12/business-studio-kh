/**
 * Finance expenses: the native domain (docs/FINANCE_PLAN.md).
 *
 * Money rules this module keeps, so the IPC layer can rely on them:
 *   - Drafts save freely, with no money effect. Only a draft is editable.
 *   - Submit freezes the expense: original amount + currency, the US cents it
 *     is worth, the rate used and the threshold it was measured against. A
 *     submitted expense is never rewritten; a posted one is corrected by a
 *     reversal.
 *   - Strictly above the approval threshold needs the owner's approval
 *     (exactly at the threshold does not) and posts no journal while waiting.
 *   - A posted expense posts ONE balanced journal through the existing ledger:
 *     debit the category's expense account, credit the money account, both
 *     lines carrying the original currency and the same riel figure, so the
 *     entry balances in dollars and in riel.
 *   - Balances are derived from the ledger, never from a running total here.
 *   - Nothing is deleted. A draft is cancelled, a posted expense is reversed,
 *     a retired category/account is restored.
 *
 * The actor is the caller in flight (main/db/_util.getCallerUserId) — never a
 * user id, status, rate or journal id sent by the client.
 */

const { getDb } = require('./index');
const { parseJson } = require('./_util');
const { uuid, str, badRequest, getCallerUserId, audit, todayPhnomPenh, dateOrNull, notFound } = require('./_assetUtil');
const ledger = require('./ledger');
const fxRates = require('./fxRates');
const { usdCentsFromMinor, khrMinorFromMinor, exceedsThreshold, isRate } = require('../util/financeMath');

const STATUSES = ['draft', 'pending', 'posted', 'rejected', 'cancelled', 'reversed'];
const ACCOUNT_KINDS = ['cash', 'bank'];
const CURRENCIES = ['USD', 'KHR'];
const DEFAULT_THRESHOLD_MINOR = 10000;      // $100 — strictly above needs approval

/** The owner's starting categories (docs/FINANCE_PLAN.md §1). Editable, not fixed. */
const CATEGORY_SEEDS = [
  { key: 'rent',              name: 'Rent' },
  { key: 'salaries',          name: 'Salaries' },
  { key: 'fuel',              name: 'Fuel' },
  { key: 'utilities',         name: 'Utilities' },
  { key: 'stock_purchases',   name: 'Stock purchases' },
  { key: 'repairs',           name: 'Repairs' },
  { key: 'transport',         name: 'Transport' },
  { key: 'tax_fees',          name: 'Tax and fees' },
  { key: 'other',             name: 'Other' },
];

/* ── small helpers ───────────────────────────────────────────── */

function requireCompany(companyId) {
  if (!companyId) throw badRequest('Company is required');
  return companyId;
}

function wholeInt(v, label, { min = 0 } = {}) {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw badRequest(`${label} must be a whole number`);
  if (n < min) throw badRequest(`${label} must be ${min} or more`);
  return n;
}

function moneyOrNull(v, label) {
  if (v == null || v === '') return null;
  return wholeInt(v, label, { min: 0 });
}

function currencyOf(v, { required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw badRequest('A currency is required — USD or KHR');
    return null;
  }
  const c = String(v).toUpperCase();
  if (!CURRENCIES.includes(c)) throw badRequest('Currency must be USD or KHR');
  return c;
}

function revisionConflict(row) {
  const err = new Error(`CONFLICT|${JSON.stringify({ kind: 'expense', id: row.id, revision: row.revision })}`);
  err.code = 'CONFLICT';
  err.userFacing = true;
  return err;
}

/* ── the chart: GL accounts for categories and money accounts ── */

function normalBalance(type) { return ['asset', 'expense'].includes(type) ? 'debit' : 'credit'; }

function nextGlCode(companyId, start) {
  const used = new Set(getDb().prepare('SELECT code FROM gl_accounts WHERE company_id = ?').all(companyId).map((r) => String(r.code).toUpperCase()));
  let n = start;
  while (used.has(String(n))) n += 1;
  return String(n);
}

function createGlAccount(companyId, { code, systemKey, type, name }) {
  const id = uuid();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO gl_accounts (id, company_id, code, name_en, type, normal_balance, system_key, is_postable, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, companyId, code, name, type, normalBalance(type), systemKey, now, now);
  return id;
}

function glAccount(id) { return getDb().prepare('SELECT * FROM gl_accounts WHERE id = ?').get(id) || null; }

/* ── settings ────────────────────────────────────────────────── */

function getSettings(companyId) {
  requireCompany(companyId);
  ensureFinance(companyId);
  const row = getDb().prepare('SELECT * FROM finance_settings WHERE company_id = ?').get(companyId);
  return {
    companyId,
    approvalThresholdMinor: row ? row.approval_threshold_minor : DEFAULT_THRESHOLD_MINOR,
    updatedAt: row ? row.updated_at : null,
    updatedByUserId: row ? row.updated_by_user_id ?? null : null,
  };
}

function updateSettings(companyId, patch = {}) {
  requireCompany(companyId);
  if (!('approvalThresholdMinor' in patch)) throw badRequest('There is nothing to change');
  const threshold = wholeInt(patch.approvalThresholdMinor, 'The approval amount', { min: 0 });
  const before = getSettings(companyId);
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO finance_settings (company_id, approval_threshold_minor, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET approval_threshold_minor = excluded.approval_threshold_minor,
      updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id
  `).run(companyId, threshold, now, getCallerUserId());
  const after = getSettings(companyId);
  audit('finance_settings', companyId, 'update', {
    before: { companyId, approvalThresholdMinor: before.approvalThresholdMinor },
    after: { companyId, approvalThresholdMinor: after.approvalThresholdMinor },
  });
  return after;
}

/* ── categories ──────────────────────────────────────────────── */

function rowToCategory(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, key: r.key, name: r.name, nameKm: r.name_km ?? null,
    glAccountId: r.gl_account_id, glAccountCode: r.gl_account_code ?? null, glAccountName: r.gl_account_name ?? null,
    sort: r.sort, archived: !!r.archived_at, archivedAt: r.archived_at ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedByUserId: r.updated_by_user_id ?? null,
  };
}

const CATEGORY_SELECT = `
  SELECT c.*, a.code AS gl_account_code, a.name_en AS gl_account_name
    FROM finance_categories c LEFT JOIN gl_accounts a ON a.id = c.gl_account_id`;

function listCategories(companyId, { includeArchived = false } = {}) {
  requireCompany(companyId);
  ensureFinance(companyId);
  const where = ['c.company_id = @companyId'];
  if (!includeArchived) where.push('c.archived_at IS NULL');
  return getDb().prepare(`${CATEGORY_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.sort, c.name COLLATE NOCASE`)
    .all({ companyId }).map(rowToCategory);
}

function getCategory(companyId, id) {
  if (!id) return null;
  const r = getDb().prepare(`${CATEGORY_SELECT} WHERE c.id = ?`).get(id);
  if (!r) return null;
  if (r.company_id !== companyId) throw badRequest('That category is not in this company');
  return rowToCategory(r);
}

function categoryOrThrow(companyId, id, { allowArchived = false } = {}) {
  const c = getCategory(companyId, id);
  if (!c) throw notFound('Expense category');
  if (c.archived && !allowArchived) throw badRequest(`Category ${c.name} is retired — restore it or pick another one`);
  return c;
}

function uniqueKey(companyId, key) {
  const taken = new Set(getDb().prepare('SELECT key FROM finance_categories WHERE company_id = ?').all(companyId).map((r) => r.key));
  let k = key;
  let n = 2;
  while (taken.has(k)) { k = `${key}_${n}`; n += 1; }
  return k;
}

function slugKey(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'category';
}

/**
 * Create, edit, order, retire or restore one category. Never deletes.
 * `patch.archived` retires (true) or restores (false).
 */
function saveCategory(companyId, patch = {}) {
  requireCompany(companyId);
  ensureFinance(companyId);
  const db = getDb();
  const now = Date.now();
  // The UI sends a stable client id for a NEW category before the row exists
  // (same retry-safe pattern as saveAccount): a missing row means create with
  // that id, so a lost reply never duplicates and never 404s.
  const idRow = patch.id ? db.prepare('SELECT id, company_id FROM finance_categories WHERE id = ?').get(patch.id) : null;
  if (idRow && idRow.company_id !== companyId) throw badRequest('That expense category is not in this company');
  if (idRow) {
    const existing = categoryOrThrow(companyId, patch.id, { allowArchived: true });
    const sets = [];
    const params = { id: existing.id, now, by: getCallerUserId() };
    const changed = { companyId };
    if ('name' in patch) {
      const name = str(patch.name, 120);
      if (!name) throw badRequest('A category name is required');
      sets.push('name = @name'); params.name = name; changed.name = name;
    }
    if ('nameKm' in patch) { sets.push('name_km = @nameKm'); params.nameKm = str(patch.nameKm, 120); changed.nameKm = params.nameKm; }
    if ('sort' in patch) { sets.push('sort = @sort'); params.sort = wholeInt(patch.sort, 'The category order'); changed.sort = params.sort; }
    if ('glAccountId' in patch) {
      const glId = patch.glAccountId;
      const acc = glAccount(glId);
      if (!acc || acc.company_id !== companyId) throw badRequest('That expense account is not in this company');
      if (!acc.is_postable) throw badRequest('That account is a heading, not postable');
      const posted = db.prepare("SELECT 1 FROM finance_expenses WHERE category_id = ? AND status IN ('posted', 'pending') LIMIT 1").get(existing.id);
      if (posted) throw badRequest('Expenses in this category are already recorded — its account cannot be changed');
      sets.push('gl_account_id = @glAccountId'); params.glAccountId = glId; changed.glAccountId = glId;
    }
    if ('archived' in patch) {
      const retired = !!patch.archived;
      sets.push('archived_at = @archivedAt'); params.archivedAt = retired ? now : null; changed.archived = retired;
    }
    if (!sets.length) return existing;
    db.prepare(`UPDATE finance_categories SET ${sets.join(', ')}, updated_at = @now, updated_by_user_id = @by WHERE id = @id`).run(params);
    const after = getCategory(companyId, existing.id);
    audit('finance_category', existing.id, 'update', { before: { companyId, ...existing }, after: { companyId, ...after } });
    return after;
  }

  const name = str(patch.name, 120);
  if (!name) throw badRequest('A category name is required');
  const key = uniqueKey(companyId, str(patch.key, 60) || slugKey(name));
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM finance_categories WHERE company_id = ?').get(companyId).m;
  const glId = patch.glAccountId
    ? (() => { const a = glAccount(patch.glAccountId); if (!a || a.company_id !== companyId) throw badRequest('That expense account is not in this company'); return a.id; })()
    : createGlAccount(companyId, {
      code: nextGlCode(companyId, 6600), systemKey: `fin.cat.${key}`, type: 'expense', name: `Expense — ${name}`,
    });
  const id = patch.id || uuid();
  db.prepare(`
    INSERT INTO finance_categories (id, company_id, key, name, name_km, gl_account_id, sort, archived_at, created_at, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(id, companyId, key, name, str(patch.nameKm, 120), glId,
    'sort' in patch ? wholeInt(patch.sort, 'The category order') : maxSort + 1, now, now, getCallerUserId());
  const created = getCategory(companyId, id);
  audit('finance_category', id, 'create', { after: { companyId, ...created } });
  return created;
}

/* ── money accounts ──────────────────────────────────────────── */

function rowToAccount(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, kind: r.kind, name: r.name, nameKm: r.name_km ?? null,
    branchId: r.branch_id ?? null, branchCode: r.branch_code ?? null, branchName: r.branch_name ?? null,
    currency: r.currency, glAccountId: r.gl_account_id, glAccountCode: r.gl_account_code ?? null, glAccountName: r.gl_account_name ?? null,
    openingMinor: r.opening_minor ?? 0, openingDate: r.opening_date ?? null, openingJournalId: r.opening_journal_id ?? null,
    archived: !!r.archived_at, archivedAt: r.archived_at ?? null, sort: r.sort,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedByUserId: r.updated_by_user_id ?? null,
  };
}

const ACCOUNT_SELECT = `
  SELECT a.*, g.code AS gl_account_code, g.name_en AS gl_account_name,
         b.code AS branch_code, b.name_en AS branch_name
    FROM finance_accounts a
    LEFT JOIN gl_accounts g ON g.id = a.gl_account_id
    LEFT JOIN branches b ON b.id = a.branch_id`;

function listAccounts(companyId, { branchIds = null, includeArchived = false, kind = null } = {}) {
  requireCompany(companyId);
  const where = ['a.company_id = @companyId'];
  const params = { companyId };
  if (!includeArchived) where.push('a.archived_at IS NULL');
  if (kind) { where.push('a.kind = @kind'); params.kind = kind; }
  if (Array.isArray(branchIds) && branchIds.length) {
    where.push(`a.branch_id IN (${branchIds.map((_, i) => `@b${i}`).join(', ')})`);
    branchIds.forEach((b, i) => { params[`b${i}`] = b; });
  } else if (Array.isArray(branchIds) && branchIds.length === 0) {
    return [];
  }
  return getDb().prepare(`${ACCOUNT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.sort, a.name COLLATE NOCASE`)
    .all(params).map(rowToAccount);
}

function getAccount(companyId, id) {
  if (!id) return null;
  const r = getDb().prepare(`${ACCOUNT_SELECT} WHERE a.id = ?`).get(id);
  if (!r) return null;
  if (r.company_id !== companyId) throw badRequest('That money account is not in this company');
  return rowToAccount(r);
}

function accountOrThrow(companyId, id, { allowArchived = false } = {}) {
  const a = getAccount(companyId, id);
  if (!a) throw notFound('Money account');
  if (a.archived && !allowArchived) throw badRequest(`Account ${a.name} is retired — restore it or pick another one`);
  return a;
}

function branchOrThrow(companyId, id) {
  if (!id) throw badRequest('A branch is required');
  const b = require('./branches').get(id);
  if (!b) throw notFound('Branch');
  if (b.companyId !== companyId) throw badRequest('That branch is not in this company');
  if (b.status !== 'active') throw badRequest(`Branch ${b.code} is closed — pick an active branch`);
  return b;
}

/**
 * Create, edit, retire or restore a money account. A cash box belongs to a
 * branch and a branch has one active cash box. A dated opening balance posts
 * a journal against the opening-equity account — it is money that is already
 * in the account, not a running total.
 */
/** Is this the same opening balance already recorded? (a lost-reply retry) */
function openingMatches(existing, opening) {
  if (!opening || opening.minor == null) return false;
  if (Number(opening.minor) !== existing.openingMinor) return false;
  const date = opening.date ? (dateOrNull(opening.date, 'The opening date') || todayPhnomPenh()) : existing.openingDate;
  return date === existing.openingDate;
}

/**
 * Create, edit, retire or restore a money account. A cash box belongs to a
 * branch and a branch has one active cash box. A dated opening balance posts
 * a journal against the opening-equity account — it is money that is already
 * in the account, not a running total.
 *
 * A create may carry the caller's own `id`, so a lost reply can be retried
 * with the same id instead of making a second account. Account row, GL
 * account and opening journal are one transaction: a failed opening creates
 * nothing.
 */
function saveAccount(companyId, patch = {}) {
  requireCompany(companyId);
  ensureFinance(companyId);
  const db = getDb();
  const existingRow = patch.id ? db.prepare('SELECT id, company_id FROM finance_accounts WHERE id = ?').get(patch.id) : null;
  if (existingRow && existingRow.company_id !== companyId) throw badRequest('That money account is not in this company');
  return db.transaction(() => (existingRow
    ? updateAccount(companyId, existingRow.id, patch)
    : createAccount(companyId, patch)))();
}

function updateAccount(companyId, id, patch) {
  const db = getDb();
  const now = Date.now();
  const existing = accountOrThrow(companyId, id, { allowArchived: true });
  if ('kind' in patch && String(patch.kind) !== existing.kind) {
    throw badRequest('An account cannot change between a cash box and a bank account — create a new account instead');
  }
  if ('currency' in patch && currencyOf(patch.currency) !== existing.currency) {
    throw badRequest('An account cannot change its currency — create a new account in the other currency');
  }
  const sets = [];
  const params = { id: existing.id, now, by: getCallerUserId() };
  const changed = { companyId };
  if ('name' in patch) { const n = str(patch.name, 120); if (!n) throw badRequest('An account name is required'); sets.push('name = @name'); params.name = n; changed.name = n; }
  if ('nameKm' in patch) { sets.push('name_km = @nameKm'); params.nameKm = str(patch.nameKm, 120); changed.nameKm = params.nameKm; }
  if ('sort' in patch) { sets.push('sort = @sort'); params.sort = wholeInt(patch.sort, 'The account order'); changed.sort = params.sort; }
  if ('branchId' in patch) {
    const b = patch.branchId ? branchOrThrow(companyId, patch.branchId) : null;
    params.branchId = b ? b.id : null;
  }
  const effBranchId = 'branchId' in patch ? params.branchId : existing.branchId;
  if (existing.kind === 'cash') {
    if (!effBranchId) throw badRequest('A cash box needs a branch');
    const other = db.prepare("SELECT 1 FROM finance_accounts WHERE company_id = ? AND kind = 'cash' AND branch_id = ? AND archived_at IS NULL AND id <> ?")
      .get(companyId, effBranchId, existing.id);
    if (other && ('branchId' in patch || ('archived' in patch && !patch.archived))) {
      throw badRequest('That branch already has an active cash box — retire it first');
    }
  }
  if ('branchId' in patch) { sets.push('branch_id = @branchId'); changed.branchId = params.branchId; }
  if ('archived' in patch) {
    sets.push('archived_at = @archivedAt'); params.archivedAt = patch.archived ? now : null; changed.archived = !!patch.archived;
  }
  if (sets.length) {
    db.prepare(`UPDATE finance_accounts SET ${sets.join(', ')}, updated_at = @now, updated_by_user_id = @by WHERE id = @id`).run(params);
    audit('finance_account', existing.id, 'update', { before: { companyId, ...existing }, after: { companyId, ...getAccount(companyId, existing.id) } });
  }
  if (patch.opening && patch.opening.minor != null) {
    if (existing.openingJournalId) {
      if (!openingMatches(existing, patch.opening)) {
        throw badRequest('This account already has an opening balance — post an expense or a reversal instead');
      }
    } else if (Number(patch.opening.minor) > 0) {
      setOpeningBalance(companyId, existing.id, { minor: patch.opening.minor, date: patch.opening.date });
    }
  }
  return getAccount(companyId, existing.id);
}

function createAccount(companyId, patch) {
  const db = getDb();
  const now = Date.now();
  const kind = String(patch.kind || '');
  if (!ACCOUNT_KINDS.includes(kind)) throw badRequest('An account is a cash box or a bank account');
  const name = str(patch.name, 120);
  if (!name) throw badRequest('An account name is required');
  const currency = currencyOf(patch.currency);
  let branchId = null;
  if (kind === 'cash') {
    branchId = branchOrThrow(companyId, patch.branchId).id;
    const other = db.prepare("SELECT 1 FROM finance_accounts WHERE company_id = ? AND kind = 'cash' AND branch_id = ? AND archived_at IS NULL")
      .get(companyId, branchId);
    if (other) throw badRequest('That branch already has an active cash box — retire it first');
  } else if (patch.branchId) {
    branchId = branchOrThrow(companyId, patch.branchId).id;
  }
  const id = patch.id ? String(patch.id) : uuid();
  const glId = createGlAccount(companyId, {
    code: nextGlCode(companyId, kind === 'cash' ? 1100 : 1200),
    systemKey: `fin.acct.${id}`,
    type: 'asset',
    name: `${kind === 'cash' ? 'Cash box' : 'Bank account'} — ${name}`,
  });
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM finance_accounts WHERE company_id = ?').get(companyId).m;
  db.prepare(`
    INSERT INTO finance_accounts (id, company_id, kind, name, name_km, branch_id, currency, gl_account_id,
      opening_minor, opening_date, opening_journal_id, archived_at, sort, created_at, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?)
  `).run(id, companyId, kind, name, str(patch.nameKm, 120), branchId, currency, glId,
    'sort' in patch ? wholeInt(patch.sort, 'The account order') : maxSort + 1, now, now, getCallerUserId());

  // The opening balance is money already in the account: it posts a journal.
  if (patch.opening && patch.opening.minor != null && Number(patch.opening.minor) > 0) {
    setOpeningBalance(companyId, id, { minor: patch.opening.minor, date: patch.opening.date });
  }
  const after = getAccount(companyId, id);
  audit('finance_account', id, 'create', { after: { companyId, ...after } });
  return after;
}

/** Post an account's dated opening balance against the opening-equity account. */
function setOpeningBalance(companyId, accountId, { minor, date } = {}) {
  const db = getDb();
  const account = accountOrThrow(companyId, accountId, { allowArchived: true });
  if (account.openingJournalId) throw badRequest('This account already has an opening balance — post an expense or a reversal instead');
  const amount = wholeInt(minor, 'The opening balance', { min: 0 });
  if (amount <= 0) throw badRequest('The opening balance must be more than zero');
  const openingDate = dateOrNull(date, 'The opening date') || todayPhnomPenh();
  const house = fxRates.houseRateFor(companyId, openingDate);
  if (!isRate(house.khrPerUsd)) throw badRequest('There is no usable exchange rate for that date — set the company rate first');
  const usdMinor = usdCentsFromMinor(account.currency, amount, house.khrPerUsd);
  if (usdMinor < 1) throw badRequest('The ledger records whole US cents — this opening balance is worth less than 1 US cent');
  const khrMinor = khrMinorFromMinor(account.currency, amount, usdMinor, house.khrPerUsd);
  const entry = ledger.post({
    companyId,
    entryDate: openingDate,
    sourceKind: 'finance_opening',
    sourceId: account.id,
    idempotencyKey: `fin-open:${account.id}`,
    memo: `Opening balance — ${account.name}`,
    fxKhrPerUsd: house.khrPerUsd,
    fxSource: `house ${house.rateDate}${house.fallback ? ` (${house.fallback})` : ''}`,
    lines: [
      { accountId: account.glAccountId, debitMinor: usdMinor, khrMinor, txnCurrency: account.currency, txnAmountMinor: amount, branchId: account.branchId, lineRole: 'money' },
      { accountKey: 'equity.opening', creditMinor: usdMinor, khrMinor, lineRole: 'opening_equity' },
    ],
  });
  db.prepare('UPDATE finance_accounts SET opening_minor = ?, opening_date = ?, opening_journal_id = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?')
    .run(amount, openingDate, entry.id, Date.now(), getCallerUserId(), account.id);
  audit('finance_account', account.id, 'opening_balance', {
    after: { companyId, accountId: account.id, amountMinor: amount, currency: account.currency, usdMinor, date: openingDate, journalEntryId: entry.id },
  });
  return getAccount(companyId, account.id);
}

/* ── expenses ────────────────────────────────────────────────── */

function rowToExpense(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, clientUuid: r.client_uuid, revision: r.revision, status: r.status,
    expenseDate: r.expense_date ?? null,
    branchId: r.branch_id ?? null, branchCode: r.branch_code ?? null, branchName: r.branch_name ?? null,
    categoryId: r.category_id ?? null, categoryKey: r.category_key ?? null, categoryName: r.category_name ?? null,
    accountId: r.account_id ?? null, accountName: r.account_name ?? null, accountKind: r.account_kind ?? null,
    accountCurrency: r.account_currency ?? null,
    currency: r.currency ?? null, amountMinor: r.amount_minor ?? null,
    usdMinor: r.usd_minor ?? null, khrMinor: r.khr_minor ?? null,
    fxKhrPerUsd: r.fx_khr_per_usd ?? null, fxRateDate: r.fx_rate_date ?? null, fxSource: r.fx_source ?? null,
    thresholdMinor: r.threshold_minor ?? null,
    memo: r.memo ?? null,
    receipt: parseJson(r.receipt_json, null),
    journalEntryId: r.journal_entry_id ?? null, journalEntryNo: r.journal_entry_no ?? null,
    reversalJournalId: r.reversal_journal_id ?? null,
    submittedAt: r.submitted_at ?? null, submittedByUserId: r.submitted_by_user_id ?? null,
    approvedAt: r.approved_at ?? null, approvedByUserId: r.approved_by_user_id ?? null,
    rejectedAt: r.rejected_at ?? null, rejectedByUserId: r.rejected_by_user_id ?? null, rejectReason: r.reject_reason ?? null,
    cancelledAt: r.cancelled_at ?? null, cancelledByUserId: r.cancelled_by_user_id ?? null, cancelReason: r.cancel_reason ?? null,
    reversedAt: r.reversed_at ?? null, reversedByUserId: r.reversed_by_user_id ?? null, reverseReason: r.reverse_reason ?? null,
    createdAt: r.created_at, createdByUserId: r.created_by_user_id ?? null,
    updatedAt: r.updated_at, updatedByUserId: r.updated_by_user_id ?? null,
  };
}

const EXPENSE_SELECT = `
  SELECT e.*,
         b.code AS branch_code, b.name_en AS branch_name,
         c.key AS category_key, c.name AS category_name,
         a.name AS account_name, a.kind AS account_kind, a.currency AS account_currency,
         j.entry_no AS journal_entry_no
    FROM finance_expenses e
    LEFT JOIN branches b ON b.id = e.branch_id
    LEFT JOIN finance_categories c ON c.id = e.category_id
    LEFT JOIN finance_accounts a ON a.id = e.account_id
    LEFT JOIN journal_entries j ON j.id = e.journal_entry_id`;

function getExpense(companyId, id) {
  if (!id) return null;
  const r = getDb().prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(id);
  if (!r) return null;
  if (r.company_id !== companyId) throw badRequest('That expense is not in this company');
  return rowToExpense(r);
}

function expenseOrThrow(companyId, id) {
  const e = getExpense(companyId, id);
  if (!e) throw notFound('Expense');
  return e;
}

/**
 * The expense list, with the branch scope the caller is allowed to see.
 * `branchIds` null means every branch; an empty array means none.
 */
function listExpenses(companyId, { branchIds = null, month = null, categoryIds = null, status = null, page = 1, pageSize = 50, search = null } = {}) {
  requireCompany(companyId);
  const where = ['e.company_id = @companyId'];
  const params = { companyId };
  if (Array.isArray(branchIds)) {
    if (!branchIds.length) return { rows: [], total: 0, page: 1, pageSize: Math.min(Math.max(1, Number(pageSize) || 50), 200) };
    where.push(`e.branch_id IN (${branchIds.map((_, i) => `@b${i}`).join(', ')})`);
    branchIds.forEach((b, i) => { params[`b${i}`] = b; });
  }
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(String(month))) throw badRequest('The month must look like 2026-11');
    where.push('e.expense_date LIKE @month'); params.month = `${month}-%`;
  }
  if (Array.isArray(categoryIds)) {
    if (!categoryIds.length) return { rows: [], total: 0, page: 1, pageSize: Math.min(Math.max(1, Number(pageSize) || 50), 200) };
    where.push(`e.category_id IN (${categoryIds.map((_, i) => `@c${i}`).join(', ')})`);
    categoryIds.forEach((c, i) => { params[`c${i}`] = c; });
  }
  if (status) {
    const list = Array.isArray(status) ? status : [status];
    for (const s of list) if (!STATUSES.includes(s)) throw badRequest(`Unknown status ${s}`);
    where.push(`e.status IN (${list.map((_, i) => `@s${i}`).join(', ')})`);
    list.forEach((s, i) => { params[`s${i}`] = s; });
  }
  if (search) { where.push('e.memo LIKE @search'); params.search = `%${String(search).trim()}%`; }
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM finance_expenses e WHERE ${where.join(' AND ')}`).get(params).n;
  const size = Math.min(Math.max(1, Number(pageSize) || 50), 200);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = db.prepare(`${EXPENSE_SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(e.expense_date, e.created_at) DESC, e.created_at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset: (current - 1) * size }).map(rowToExpense);
  return { rows, total, page: current, pageSize: size };
}

/**
 * Save a draft. Incomplete fields are fine — a draft has no money effect.
 * A create is idempotent on `patch.clientUuid`: the same client uuid returns
 * the same expense instead of making a second one. Only a draft is editable.
 * `patch.revision`, when present, must match the stored revision.
 */
function saveDraft(companyId, patch = {}) {
  requireCompany(companyId);
  ensureFinance(companyId);
  const db = getDb();
  const now = Date.now();
  if (patch.id) {
    const existing = expenseOrThrow(companyId, patch.id);
    if (existing.status !== 'draft') throw badRequest(`This expense is ${existing.status} — only a draft can be edited`);
    if ('revision' in patch && patch.revision != null) {
      if (Number(patch.revision) !== existing.revision) throw revisionConflict(existing);
    }
    const sets = [];
    const params = { id: existing.id, now, by: getCallerUserId() };
    if ('expenseDate' in patch) { const d = dateOrNull(patch.expenseDate, 'The expense date'); sets.push('expense_date = @expenseDate'); params.expenseDate = d; }
    if ('branchId' in patch) {
      const b = patch.branchId ? branchOrThrow(companyId, patch.branchId) : null;
      sets.push('branch_id = @branchId'); params.branchId = b ? b.id : null;
    }
    if ('categoryId' in patch) {
      const c = patch.categoryId ? categoryOrThrow(companyId, patch.categoryId) : null;
      sets.push('category_id = @categoryId'); params.categoryId = c ? c.id : null;
    }
    if ('accountId' in patch) {
      const a = patch.accountId ? accountOrThrow(companyId, patch.accountId) : null;
      sets.push('account_id = @accountId'); params.accountId = a ? a.id : null;
    }
    if ('currency' in patch) { sets.push('currency = @currency'); params.currency = currencyOf(patch.currency, { required: false }); }
    if ('amountMinor' in patch) { sets.push('amount_minor = @amountMinor'); params.amountMinor = moneyOrNull(patch.amountMinor, 'The amount'); }
    if ('memo' in patch) { sets.push('memo = @memo'); params.memo = str(patch.memo, 2000); }
    const effBranchId = 'branchId' in patch ? params.branchId : existing.branchId;
    const effAccountId = 'accountId' in patch ? params.accountId : existing.accountId;
    if (effBranchId && effAccountId) {
      const acc = accountOrThrow(companyId, effAccountId, { allowArchived: true });
      if (acc.branchId && acc.branchId !== effBranchId) {
        throw badRequest('That money account belongs to another branch — pick this branch\'s account or a company-wide bank account');
      }
    }
    if (!sets.length) return existing;
    sets.push('revision = revision + 1');
    db.prepare(`UPDATE finance_expenses SET ${sets.join(', ')}, updated_at = @now, updated_by_user_id = @by WHERE id = @id`).run(params);
    const after = getExpense(companyId, existing.id);
    audit('finance_expense', existing.id, 'update', { before: { companyId, ...existing }, after: { companyId, ...after } });
    return after;
  }

  const clientUuid = patch.clientUuid == null ? '' : String(patch.clientUuid).trim();
  if (!clientUuid) throw badRequest('A client uuid is required so a retry cannot record the expense twice');
  if (clientUuid.length > 200) throw badRequest('A client uuid must be 200 characters or fewer');
  const replay = db.prepare('SELECT id FROM finance_expenses WHERE company_id = ? AND client_uuid = ?').get(companyId, clientUuid);
  if (replay) return getExpense(companyId, replay.id);

  const id = uuid();
  const branchId = patch.branchId ? branchOrThrow(companyId, patch.branchId).id : null;
  const categoryId = patch.categoryId ? categoryOrThrow(companyId, patch.categoryId).id : null;
  const accountId = patch.accountId ? accountOrThrow(companyId, patch.accountId).id : null;
  if (branchId && accountId) {
    const acc = accountOrThrow(companyId, accountId, { allowArchived: true });
    if (acc.branchId && acc.branchId !== branchId) {
      throw badRequest('That money account belongs to another branch — pick this branch\'s account or a company-wide bank account');
    }
  }
  db.prepare(`
    INSERT INTO finance_expenses (id, company_id, client_uuid, revision, status, expense_date, branch_id, category_id,
      account_id, currency, amount_minor, memo, created_at, created_by_user_id, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, clientUuid,
    dateOrNull(patch.expenseDate, 'The expense date'), branchId, categoryId, accountId,
    currencyOf(patch.currency, { required: false }), moneyOrNull(patch.amountMinor, 'The amount'), str(patch.memo, 2000),
    now, getCallerUserId(), now, getCallerUserId());
  const created = getExpense(companyId, id);
  audit('finance_expense', id, 'create', { after: { companyId, ...created } });
  return created;
}

/** Post the journal for an expense: debit the category, credit the money account. */
function postExpenseJournal(companyId, expense, { date, usdMinor, khrMinor, rate, rateDate, fxSource }) {
  // Frozen values post even if the category or account was retired afterwards.
  const category = categoryOrThrow(companyId, expense.categoryId, { allowArchived: true });
  const account = accountOrThrow(companyId, expense.accountId, { allowArchived: true });
  return ledger.post({
    companyId,
    entryDate: date,
    sourceKind: 'finance_expense',
    sourceId: expense.id,
    idempotencyKey: `fin-exp:${expense.id}`,
    memo: expense.memo || `${category.name} — ${account.name}`,
    fxKhrPerUsd: rate,
    fxSource,
    lines: [
      { accountId: category.glAccountId, debitMinor: usdMinor, khrMinor, txnCurrency: expense.currency, txnAmountMinor: expense.amountMinor, branchId: expense.branchId, lineRole: 'expense' },
      { accountId: account.glAccountId, creditMinor: usdMinor, khrMinor, txnCurrency: expense.currency, txnAmountMinor: expense.amountMinor, branchId: expense.branchId, lineRole: 'money' },
    ],
  });
}

/**
 * Submit a draft. The expense is frozen here: amount, currency, the US cents
 * it is worth, the rate and the threshold it was measured against. Above the
 * threshold it waits for the owner (no journal); at or below it posts.
 */
function submitExpense(companyId, id) {
  requireCompany(companyId);
  const db = getDb();
  return db.transaction(() => {
    const expense = expenseOrThrow(companyId, id);
    if (expense.status === 'pending' || expense.status === 'posted') return expense;  // a retry changes nothing
    if (expense.status !== 'draft') throw badRequest(`This expense is ${expense.status} — it cannot be submitted again`);
    if (!expense.expenseDate) throw badRequest('The expense needs a date');
    if (!expense.branchId) throw badRequest('The expense needs a branch');
    branchOrThrow(companyId, expense.branchId);
    if (!expense.categoryId) throw badRequest('The expense needs a category');
    categoryOrThrow(companyId, expense.categoryId);
    if (!expense.accountId) throw badRequest('The expense needs a money account');
    if (!expense.currency) throw badRequest('The expense needs a currency');
    if (expense.amountMinor == null || expense.amountMinor <= 0) throw badRequest('The expense amount must be more than zero');
    const account = accountOrThrow(companyId, expense.accountId);
    if (account.branchId && account.branchId !== expense.branchId) {
      throw badRequest('That money account belongs to another branch — pick this branch\'s account or a company-wide bank account');
    }
    if (account.currency !== expense.currency) {
      throw badRequest(`This account keeps ${account.currency} — the expense must be recorded in ${account.currency}`);
    }
    const house = fxRates.houseRateFor(companyId, expense.expenseDate);
    if (!isRate(house.khrPerUsd)) throw badRequest('There is no usable exchange rate for that date — set the company rate first');
    const usdMinor = usdCentsFromMinor(expense.currency, expense.amountMinor, house.khrPerUsd);
    if (usdMinor < 1) {
      throw badRequest('The ledger records whole US cents — this expense is worth less than 1 US cent, so it cannot be recorded');
    }
    const khrMinor = khrMinorFromMinor(expense.currency, expense.amountMinor, usdMinor, house.khrPerUsd);
    const thresholdMinor = getSettings(companyId).approvalThresholdMinor;
    const now = Date.now();
    const by = getCallerUserId();
    const fxSource = `house ${house.rateDate}${house.fallback ? ` (${house.fallback})` : ''}`;
    const needsApproval = exceedsThreshold(usdMinor, thresholdMinor);

    if (needsApproval) {
      db.prepare(`
        UPDATE finance_expenses SET status = 'pending', usd_minor = @usdMinor, khr_minor = @khrMinor,
          fx_khr_per_usd = @rate, fx_rate_date = @rateDate, fx_source = @fxSource, threshold_minor = @threshold,
          submitted_at = @now, submitted_by_user_id = @by, updated_at = @now, updated_by_user_id = @by,
          revision = revision + 1
        WHERE id = @id AND status = 'draft'
      `).run({ usdMinor, khrMinor, rate: house.khrPerUsd, rateDate: house.rateDate, fxSource, threshold: thresholdMinor, now, by, id: expense.id });
      const after = getExpense(companyId, expense.id);
      audit('finance_expense', expense.id, 'submit', { after: { companyId, status: after.status, usdMinor, thresholdMinor } });
      return after;
    }

    const entry = postExpenseJournal(companyId, { ...expense, currency: expense.currency, amountMinor: expense.amountMinor },
      { date: expense.expenseDate, usdMinor, khrMinor, rate: house.khrPerUsd, rateDate: house.rateDate, fxSource });
    db.prepare(`
      UPDATE finance_expenses SET status = 'posted', usd_minor = @usdMinor, khr_minor = @khrMinor,
        fx_khr_per_usd = @rate, fx_rate_date = @rateDate, fx_source = @fxSource, threshold_minor = @threshold,
        submitted_at = @now, submitted_by_user_id = @by, approved_at = @now, approved_by_user_id = @by,
        journal_entry_id = @entryId, updated_at = @now, updated_by_user_id = @by, revision = revision + 1
      WHERE id = @id AND status = 'draft'
    `).run({ usdMinor, khrMinor, rate: house.khrPerUsd, rateDate: house.rateDate, fxSource, threshold: thresholdMinor, now, by, entryId: entry.id, id: expense.id });
    const after = getExpense(companyId, expense.id);
    audit('finance_expense', expense.id, 'post', { after: { companyId, status: after.status, usdMinor, journalEntryId: entry.id } });
    return after;
  })();
}

/** The owner approves a waiting expense: the frozen amount and rate post, atomically. */
function approveExpense(companyId, id) {
  requireCompany(companyId);
  const db = getDb();
  return db.transaction(() => {
    const expense = expenseOrThrow(companyId, id);
    if (expense.status === 'posted') return expense;      // a retry changes nothing
    if (expense.status !== 'pending') throw badRequest(`An expense that is ${expense.status} is not waiting for approval`);
    if (expense.usdMinor == null || expense.amountMinor == null) throw badRequest('This expense has no frozen amount to post');
    const now = Date.now();
    const by = getCallerUserId();
    const entry = postExpenseJournal(companyId, expense, {
      date: expense.expenseDate, usdMinor: expense.usdMinor, khrMinor: expense.khrMinor,
      rate: expense.fxKhrPerUsd, rateDate: expense.fxRateDate, fxSource: expense.fxSource,
    });
    db.prepare(`
      UPDATE finance_expenses SET status = 'posted', approved_at = @now, approved_by_user_id = @by,
        journal_entry_id = @entryId, updated_at = @now, updated_by_user_id = @by, revision = revision + 1
      WHERE id = @id AND status = 'pending'
    `).run({ now, by, entryId: entry.id, id: expense.id });
    const after = getExpense(companyId, expense.id);
    audit('finance_expense', expense.id, 'approve', { after: { companyId, status: after.status, usdMinor: expense.usdMinor, journalEntryId: entry.id } });
    return after;
  })();
}

/** The owner turns a waiting expense down. No money moves. */
function rejectExpense(companyId, id, { reason } = {}) {
  requireCompany(companyId);
  const expense = expenseOrThrow(companyId, id);
  if (expense.status === 'rejected') return expense;
  if (expense.status !== 'pending') throw badRequest(`An expense that is ${expense.status} is not waiting for approval`);
  const why = str(reason, 1000);
  if (!why) throw badRequest('A reason is required to reject an expense');
  const now = Date.now();
  const by = getCallerUserId();
  getDb().prepare(`
    UPDATE finance_expenses SET status = 'rejected', rejected_at = @now, rejected_by_user_id = @by,
      reject_reason = @reason, updated_at = @now, updated_by_user_id = @by, revision = revision + 1
    WHERE id = @id AND status = 'pending'
  `).run({ now, by, reason: why, id: expense.id });
  const after = getExpense(companyId, expense.id);
  audit('finance_expense', expense.id, 'reject', { before: { companyId, status: 'pending' }, after: { companyId, status: after.status, reason: why } });
  return after;
}

/** A draft is cancelled (never deleted). No money moves. */
function cancelExpense(companyId, id, { reason } = {}) {
  requireCompany(companyId);
  const expense = expenseOrThrow(companyId, id);
  if (expense.status === 'cancelled') return expense;
  if (expense.status !== 'draft') throw badRequest(`An expense that is ${expense.status} cannot be cancelled — reject or reverse it instead`);
  const now = Date.now();
  const by = getCallerUserId();
  getDb().prepare(`
    UPDATE finance_expenses SET status = 'cancelled', cancelled_at = @now, cancelled_by_user_id = @by,
      cancel_reason = @reason, updated_at = @now, updated_by_user_id = @by, revision = revision + 1
    WHERE id = @id AND status = 'draft'
  `).run({ now, by, reason: str(reason, 1000), id: expense.id });
  const after = getExpense(companyId, expense.id);
  audit('finance_expense', expense.id, 'cancel', { before: { companyId, status: 'draft' }, after: { companyId, status: after.status } });
  return after;
}

/** A posted expense is corrected by a reversal — a mirror journal, never an edit. */
function reverseExpense(companyId, id, { reason, date } = {}) {
  requireCompany(companyId);
  const db = getDb();
  const why = str(reason, 1000);
  if (!why) throw badRequest('A reason is required to reverse an expense');
  return db.transaction(() => {
    const expense = expenseOrThrow(companyId, id);
    if (expense.status === 'reversed') return expense;   // a retry changes nothing
    if (expense.status !== 'posted') throw badRequest(`An expense that is ${expense.status} cannot be reversed`);
    if (!expense.journalEntryId) throw badRequest('This expense has no journal to reverse');
    const when = dateOrNull(date, 'The reversal date') || todayPhnomPenh();
    const entry = ledger.reverse(expense.journalEntryId, why, {
      date: when, sourceKind: 'finance_expense', sourceId: expense.id, idempotencyKey: `fin-rev:${expense.id}`,
    });
    const now = Date.now();
    const by = getCallerUserId();
    db.prepare(`
      UPDATE finance_expenses SET status = 'reversed', reversed_at = @now, reversed_by_user_id = @by,
        reverse_reason = @reason, reversal_journal_id = @entryId, updated_at = @now, updated_by_user_id = @by,
        revision = revision + 1
      WHERE id = @id AND status = 'posted'
    `).run({ now, by, reason: why, entryId: entry.id, id: expense.id });
    const after = getExpense(companyId, expense.id);
    audit('finance_expense', expense.id, 'reverse', { before: { companyId, status: 'posted' }, after: { companyId, status: after.status, reason: why, journalEntryId: entry.id } });
    return after;
  })();
}

/**
 * Attach (or clear) the receipt metadata for an expense. The file itself is
 * written by the receipt helper; this only records what it wrote — a relative
 * path inside the data folder, its type, size and checksum. An absolute path
 * or a path that climbs out of the data folder is refused.
 */
function setReceipt(companyId, id, meta) {
  requireCompany(companyId);
  const expense = expenseOrThrow(companyId, id);
  if (!['draft', 'pending'].includes(expense.status)) {
    throw badRequest('A receipt can only be attached before the expense is posted');
  }
  let payload = null;
  if (meta != null) {
    const relPath = str(meta.relPath ?? meta.relativePath, 400);
    if (!relPath) throw badRequest('The receipt needs its path');
    if (relPath.startsWith('/') || relPath.includes('\\') || relPath.split('/').includes('..')) {
      throw badRequest('The receipt path must be inside the data folder');
    }
    const byteSize = moneyOrNull(meta.byteSize ?? meta.size, 'The receipt size');
    const sha256 = str(meta.sha256, 64);
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw badRequest('The receipt checksum must be a SHA-256 hash');
    payload = {
      relPath,
      mimeType: str(meta.mimeType ?? meta.mime, 120),
      byteSize,
      sha256,
      originalName: str(meta.originalName, 200),
      updatedAt: Date.now(),
    };
  }
  getDb().prepare('UPDATE finance_expenses SET receipt_json = ?, revision = revision + 1, updated_at = ?, updated_by_user_id = ? WHERE id = ?')
    .run(payload ? JSON.stringify(payload) : null, Date.now(), getCallerUserId(), expense.id);
  const after = getExpense(companyId, expense.id);
  audit('finance_expense', expense.id, payload ? 'receipt_set' : 'receipt_cleared', {
    after: { companyId, receipt: payload ? { ...payload } : null },
  });
  return after;
}

/* ── balances and reports ────────────────────────────────────── */

/** Recorded balances per GL account, straight from the ledger. */
function glBalances(companyId) {
  const rows = getDb().prepare(`
    SELECT l.account_id AS accountId,
           SUM(l.debit_minor - l.credit_minor) AS usdMinor,
           SUM(CASE WHEN l.txn_currency = 'USD' THEN (CASE WHEN l.debit_minor > 0 THEN l.txn_amount_minor ELSE -l.txn_amount_minor END) ELSE 0 END) AS usdNative,
           SUM(CASE WHEN l.txn_currency = 'KHR' THEN (CASE WHEN l.debit_minor > 0 THEN l.txn_amount_minor ELSE -l.txn_amount_minor END) ELSE 0 END) AS khrNative
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.company_id = ?
     GROUP BY l.account_id
  `).all(companyId);
  const map = new Map();
  for (const r of rows) {
    map.set(r.accountId, { usdMinor: r.usdMinor || 0, usdNative: r.usdNative || 0, khrNative: r.khrNative || 0 });
  }
  return map;
}

/**
 * The recorded balance of each money account: native currency from the
 * ledger's own currency figures, dollars from the same journal lines.
 */
function accountBalances(companyId, { branchIds = null } = {}) {
  requireCompany(companyId);
  const accounts = listAccounts(companyId, { branchIds, includeArchived: true });
  const balances = glBalances(companyId);
  const rate = fxRates.houseRateFor(companyId, todayPhnomPenh());
  return accounts.map((a) => {
    const b = balances.get(a.glAccountId) || { usdMinor: 0, usdNative: 0, khrNative: 0 };
    const nativeMinor = a.currency === 'KHR' ? b.khrNative : b.usdNative;
    return {
      accountId: a.id, name: a.name, kind: a.kind, branchId: a.branchId, branchName: a.branchName,
      currency: a.currency, nativeMinor, usdMinor: b.usdMinor,
      khrPerUsd: rate.khrPerUsd, rateDate: rate.rateDate,
      archived: a.archived,
    };
  });
}

/**
 * The month's figures. Posted money is grouped by the JOURNAL's own period —
 * a late posting into an open month counts in that month — and a reversal
 * counts in the month it was posted in. Waiting expenses are counted apart.
 */
function reports(companyId, { month, branchIds = null, categoryIds = null } = {}) {
  requireCompany(companyId);
  if (!month || !/^\d{4}-\d{2}$/.test(String(month))) throw badRequest('The month must look like 2026-11');
  const db = getDb();
  const inScope = (row) => {
    if (Array.isArray(branchIds) && !branchIds.includes(row.branchId)) return false;
    if (Array.isArray(categoryIds) && !categoryIds.includes(row.categoryId)) return false;
    return true;
  };

  // Posted: the expense lines of every finance_expense journal in the month.
  const lines = db.prepare(`
    SELECT l.branch_id AS branchId, l.account_id AS accountId,
           l.debit_minor AS debitMinor, l.credit_minor AS creditMinor,
           l.khr_minor AS khrMinor, l.txn_amount_minor AS txnAmountMinor,
           l.txn_currency AS txnCurrency, e.id AS entryId, e.entry_no AS entryNo,
           b.name_en AS branchName, c.id AS categoryId, c.name AS categoryName
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      LEFT JOIN branches b ON b.id = l.branch_id
      JOIN finance_expenses x ON x.id = e.source_id AND x.company_id = e.company_id
      LEFT JOIN finance_categories c ON c.id = x.category_id
     WHERE e.company_id = ? AND e.source_kind = 'finance_expense' AND e.period = ? AND l.line_role = 'expense'
  `).all(companyId, month);

  const scoped = lines.filter((l) => (branchIds == null || branchIds.includes(l.branchId))
    && (categoryIds == null || categoryIds.includes(l.categoryId)));

  const posted = { usdMinor: 0, khrMinor: 0, count: 0 };
  const byBranch = new Map();
  const byCategory = new Map();
  const seenEntries = new Set();
  for (const l of scoped) {
    const sign = l.debitMinor > 0 ? 1 : -1;
    const usd = l.debitMinor - l.creditMinor;    // debit for the expense, credit for its reversal
    const khr = sign * l.khrMinor;
    if (!seenEntries.has(l.entryId)) { seenEntries.add(l.entryId); posted.count += 1; }
    posted.usdMinor += usd;
    posted.khrMinor += khr;
    const bk = l.branchId || 'none';
    const b = byBranch.get(bk) || { branchId: l.branchId ?? null, branchName: l.branchName ?? 'No branch', usdMinor: 0, khrMinor: 0, count: 0 };
    b.usdMinor += usd; b.khrMinor += khr;
    byBranch.set(bk, b);
    const ck = l.categoryId || l.accountId;
    const c = byCategory.get(ck) || { categoryId: l.categoryId ?? null, categoryName: l.categoryName ?? 'Uncategorised', usdMinor: 0, khrMinor: 0, count: 0 };
    c.usdMinor += usd; c.khrMinor += khr;
    byCategory.set(ck, c);
  }
  // Counts per group are entries, not lines: one journal per expense.
  for (const l of scoped) {
    const bk = l.branchId || 'none';
    const b = byBranch.get(bk);
    if (b && !b.entryIds) b.entryIds = new Set();
    if (b) b.entryIds.add(l.entryId);
    const ck = l.categoryId || l.accountId;
    const c = byCategory.get(ck);
    if (c && !c.entryIds) c.entryIds = new Set();
    if (c) c.entryIds.add(l.entryId);
  }

  // Waiting: no journal yet, summed from the expense rows themselves.
  const pendingRows = db.prepare(`
    SELECT e.id, e.branch_id AS branchId, e.category_id AS categoryId, e.usd_minor AS usdMinor, e.khr_minor AS khrMinor,
           b.name_en AS branchName, c.name AS categoryName
      FROM finance_expenses e
      LEFT JOIN branches b ON b.id = e.branch_id
      LEFT JOIN finance_categories c ON c.id = e.category_id
     WHERE e.company_id = ? AND e.status = 'pending' AND e.expense_date LIKE ?
  `).all(companyId, `${month}-%`);

  const pending = { usdMinor: 0, khrMinor: 0, count: 0 };
  const pendingBranch = new Map();
  const pendingCategory = new Map();
  for (const r of pendingRows) {
    if (!inScope(r)) continue;
    pending.usdMinor += r.usdMinor || 0;
    pending.khrMinor += r.khrMinor || 0;
    pending.count += 1;
    const bk = r.branchId || 'none';
    const b = pendingBranch.get(bk) || { branchId: r.branchId ?? null, branchName: r.branchName ?? 'No branch', usdMinor: 0, khrMinor: 0, count: 0 };
    b.usdMinor += r.usdMinor || 0; b.khrMinor += r.khrMinor || 0; b.count += 1;
    pendingBranch.set(bk, b);
    const ck = r.categoryId || 'none';
    const c = pendingCategory.get(ck) || { categoryId: r.categoryId ?? null, categoryName: r.categoryName ?? 'Uncategorised', usdMinor: 0, khrMinor: 0, count: 0 };
    c.usdMinor += r.usdMinor || 0; c.khrMinor += r.khrMinor || 0; c.count += 1;
    pendingCategory.set(ck, c);
  }

  const rate = fxRates.houseRateFor(companyId, todayPhnomPenh());
  const balances = accountBalances(companyId, { branchIds });
  return {
    month,
    rate: { khrPerUsd: rate.khrPerUsd, rateDate: rate.rateDate, source: rate.source, fallback: rate.fallback },
    posted: {
      total: { usdMinor: posted.usdMinor, khrMinor: posted.khrMinor, count: posted.count },
      byBranch: [...byBranch.values()].map(({ entryIds, ...g }) => ({ ...g, count: entryIds ? entryIds.size : g.count })),
      byCategory: [...byCategory.values()].map(({ entryIds, ...g }) => ({ ...g, count: entryIds ? entryIds.size : g.count })),
    },
    pending: {
      total: { usdMinor: pending.usdMinor, khrMinor: pending.khrMinor, count: pending.count },
      byBranch: [...pendingBranch.values()],
      byCategory: [...pendingCategory.values()],
    },
    balances,
  };
}

/* ── seeding ─────────────────────────────────────────────────── */

/**
 * The company's starting setup, once: the settings row, the owner's starting
 * categories (each with its own expense account in the chart). Safe to call
 * on every read.
 */
function ensureFinance(companyId) {
  requireCompany(companyId);
  const db = getDb();
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO finance_settings (company_id, approval_threshold_minor, updated_at) VALUES (?, ?, ?)')
    .run(companyId, DEFAULT_THRESHOLD_MINOR, now);
  let seeded = 0;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM finance_categories WHERE company_id = ?').get(companyId).m;
  for (const [i, seed] of CATEGORY_SEEDS.entries()) {
    const existing = db.prepare('SELECT id FROM finance_categories WHERE company_id = ? AND key = ?').get(companyId, seed.key);
    if (existing) continue;
    const glId = createGlAccount(companyId, {
      code: nextGlCode(companyId, 6600), systemKey: `fin.cat.${seed.key}`, type: 'expense', name: `Expense — ${seed.name}`,
    });
    db.prepare(`
      INSERT INTO finance_categories (id, company_id, key, name, gl_account_id, sort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), companyId, seed.key, seed.name, glId, maxSort + i + 1, now, now);
    seeded += 1;
  }
  return { seededCategories: seeded, chartAccounts: db.prepare("SELECT COUNT(*) AS n FROM gl_accounts WHERE company_id = ? AND system_key LIKE 'fin.%'").get(companyId).n };
}

module.exports = {
  STATUSES, ACCOUNT_KINDS, CURRENCIES, DEFAULT_THRESHOLD_MINOR, CATEGORY_SEEDS,
  ensureFinance,
  getSettings, updateSettings,
  listCategories, getCategory, saveCategory,
  listAccounts, getAccount, saveAccount, setOpeningBalance,
  getExpense, listExpenses, saveDraft,
  submitExpense, approveExpense, rejectExpense, cancelExpense, reverseExpense,
  setReceipt,
  reports, accountBalances,
};
