/**
 * Fixed Assets A0: the double-entry accounting core (docs/ASSETS_AND_BRANCHES_PLAN.md §5).
 * No screens until Finance; the asset register posts through `post()`.
 *
 * Posting rules (§5.2) — one helper, `post(entry)`:
 *   1. It always balances: debits = credits in US cents, or it throws. Every
 *      line also carries its riel figure at the entry's rate; the riel
 *      rounding difference goes to the largest line (main/util/ledgerMath.js).
 *   2. Posted means permanent: SQLite triggers refuse UPDATE / DELETE on lines
 *      and DELETE on entries (main/db/ledgerSchema.js).
 *   3. Locked months are refused: an entry dated in a locked month is posted on
 *      the first day of the first open month after it, with the memo
 *      "Late entry for 14 Mar 2027 (March 2027 is locked)". The intended date
 *      is kept on the entry (`intended_date`) and on the source event.
 *   4. Idempotent: (company, idempotency_key) is UNIQUE — a retried call
 *      returns the entry already posted (`duplicate: true`) and posts nothing.
 *   5. Reversal, not delete: `reverse(entryId, reason)` posts the mirror entry
 *      in the current open month and links the two.
 *
 * Months are locked / unlocked by an admin only (CHANNEL_RULES: ADMIN_ONLY).
 * Nothing here locks a month by itself.
 */

const { getDb } = require('./index');
const { parseJson } = require('./_util');
const { uuid, str, badRequest, getCallerUserId, audit, todayPhnomPenh, dateOrNull, notFound } = require('./_assetUtil');
const { prepareLines, linesBalance, mirrorLines } = require('../util/ledgerMath');
const { addMonths, assertPeriod } = require('../util/bookDepreciation');

const ACCOUNT_TYPES = ['asset', 'contra_asset', 'liability', 'equity', 'income', 'expense'];
const SOURCE_KINDS = ['asset_acquire', 'asset_open', 'asset_depreciation', 'asset_dispose', 'asset_lost', 'asset_found',
  'asset_revalue', 'asset_impair', 'asset_capex', 'reversal'];
// accum_disposal / accum_reval (A2): accumulated depreciation taken off on a
// disposal or eliminated on a revaluation — kept apart from accum_dep so
// "depreciation charged to date" stays a plain SUM of accum_dep.
// reval_pl: the profit-and-loss side of a revaluation (IAS 16.39 / 16.40), kept
// apart so a later increase knows how much earlier loss it reverses first.
const LINE_ROLES = ['cost', 'accum_dep', 'accum_disposal', 'accum_reval', 'dep_expense', 'dep_catch_up', 'gain', 'loss', 'clearing', 'equity', 'impairment', 'revaluation', 'reval_pl'];

/** §5.3 — the seeded chart. The accountant may renumber or rename; the app posts by system_key. */
const SEED_ACCOUNTS = [
  { code: '1190', key: 'fa.clearing.sale',     type: 'asset',        name: 'Asset sale proceeds receivable (clearing)' },
  { code: '1500', key: 'fa.cost.land',         type: 'asset',        name: 'Land' },
  { code: '1510', key: 'fa.cost.building',     type: 'asset',        name: 'Buildings' },
  { code: '1511', key: 'fa.accum.building',    type: 'contra_asset', name: 'Acc. dep. buildings' },
  { code: '1520', key: 'fa.cost.vehicle',      type: 'asset',        name: 'Vehicles' },
  { code: '1521', key: 'fa.accum.vehicle',     type: 'contra_asset', name: 'Acc. dep. vehicles' },
  { code: '1530', key: 'fa.cost.computer',     type: 'asset',        name: 'Computers & IT' },
  { code: '1531', key: 'fa.accum.computer',    type: 'contra_asset', name: 'Acc. dep. computers & IT' },
  { code: '1540', key: 'fa.cost.furniture',    type: 'asset',        name: 'Furniture, fixtures & shelving' },
  { code: '1541', key: 'fa.accum.furniture',   type: 'contra_asset', name: 'Acc. dep. furniture, fixtures & shelving' },
  { code: '1550', key: 'fa.cost.machinery',    type: 'asset',        name: 'Machinery, kilns & plant' },
  { code: '1551', key: 'fa.accum.machinery',   type: 'contra_asset', name: 'Acc. dep. machinery, kilns & plant' },
  { code: '1560', key: 'fa.cost.intangible',   type: 'asset',        name: 'Intangible assets' },
  { code: '1561', key: 'fa.accum.intangible',  type: 'contra_asset', name: 'Acc. amortisation' },
  { code: '1590', key: 'fa.impairment',        type: 'contra_asset', name: 'Accumulated impairment' },
  { code: '2190', key: 'fa.clearing.purchase', type: 'liability',    name: 'Asset purchases payable (clearing)' },
  { code: '3100', key: 'equity.opening',       type: 'equity',       name: 'Opening balance equity' },
  { code: '3300', key: 'equity.revaluation',   type: 'equity',       name: 'Revaluation surplus' },
  { code: '4900', key: 'fa.gain',              type: 'income',       name: 'Gain on disposal of assets' },
  { code: '6500', key: 'fa.dep_expense',       type: 'expense',      name: 'Depreciation & amortisation expense' },
  { code: '6510', key: 'fa.impairment_loss',   type: 'expense',      name: 'Impairment loss' },
  { code: '6520', key: 'fa.loss',              type: 'expense',      name: 'Loss on disposal / assets written off' },
];

function normalBalance(type) { return ['asset', 'expense'].includes(type) ? 'debit' : 'credit'; }

/* ─── accounts ───────────────────────────────────────────────── */

function rowToAccount(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, code: r.code, nameEn: r.name_en, nameKm: r.name_km ?? null, type: r.type,
    normalBalance: r.normal_balance, parentId: r.parent_id ?? null, systemKey: r.system_key ?? null,
    isPostable: !!r.is_postable, archived: !!r.archived_at,
    balanceMinor: r.balance_minor ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Idempotent: the §5.3 accounts exist for this company. */
function ensureChart(companyId) {
  if (!companyId) return;
  const db = getDb();
  const now = Date.now();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO gl_accounts (id, company_id, code, name_en, type, normal_balance, system_key, is_postable, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const have = db.prepare('SELECT COUNT(*) AS n FROM gl_accounts WHERE company_id = ? AND system_key IS NOT NULL').get(companyId).n;
  if (have >= SEED_ACCOUNTS.length) return;
  db.transaction(() => {
    for (const a of SEED_ACCOUNTS) ins.run(uuid(), companyId, a.code, a.name, a.type, normalBalance(a.type), a.key, now, now);
  })();
}

function listAccounts(companyId, { includeArchived = true } = {}) {
  if (!companyId) return [];
  ensureChart(companyId);
  return getDb().prepare(`
    SELECT a.*, (SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) FROM journal_lines l WHERE l.account_id = a.id) AS balance_minor
      FROM gl_accounts a WHERE a.company_id = ? ${includeArchived ? '' : 'AND a.archived_at IS NULL'}
     ORDER BY a.code COLLATE NOCASE
  `).all(companyId).map(rowToAccount);
}

function getAccount(id) { return rowToAccount(getDb().prepare('SELECT * FROM gl_accounts WHERE id = ?').get(id)); }

function accountByKey(companyId, key) {
  ensureChart(companyId);
  const r = getDb().prepare('SELECT * FROM gl_accounts WHERE company_id = ? AND system_key = ?').get(companyId, key);
  if (!r) throw badRequest(`The account for ${key} is missing from this company's chart`);
  return rowToAccount(r);
}

/** Rename or renumber (the accountant's call). System accounts cannot be archived. */
function updateAccount(id, patch = {}) {
  const existing = getAccount(id);
  if (!existing) throw notFound('Account');
  const sets = [];
  const params = { id, now: Date.now(), by: getCallerUserId() };
  const changed = {};
  if ('code' in patch) {
    const c = str(patch.code, 20);
    if (!c) throw badRequest('An account code cannot be empty');
    const clash = getDb().prepare('SELECT id FROM gl_accounts WHERE company_id = ? AND code = ? AND id <> ?').get(existing.companyId, c, id);
    if (clash) throw badRequest(`Account code ${c} is already used`);
    sets.push('code = @code'); params.code = c; changed.code = c;
  }
  if ('nameEn' in patch) {
    const n = str(patch.nameEn, 120);
    if (!n) throw badRequest('An account name cannot be empty');
    sets.push('name_en = @nameEn'); params.nameEn = n; changed.nameEn = n;
  }
  if ('nameKm' in patch) { sets.push('name_km = @nameKm'); params.nameKm = str(patch.nameKm, 120); changed.nameKm = params.nameKm; }
  if ('archived' in patch) {
    if (patch.archived && existing.systemKey) throw badRequest('The app posts to this account — it cannot be archived (rename or renumber it instead)');
    sets.push('archived_at = @archivedAt'); params.archivedAt = patch.archived ? Date.now() : null; changed.archived = !!patch.archived;
  }
  if (!sets.length) return existing;
  getDb().prepare(`UPDATE gl_accounts SET ${sets.join(', ')}, updated_at = @now, updated_by_user_id = @by WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('gl_account', id, 'update', diff);
  return getAccount(id);
}

/* ─── periods ────────────────────────────────────────────────── */

/**
 * §5.2 rule 3, as decided at review (2026-10-08): a lock means the books are
 * CLOSED THROUGH that month. The company's "closed through" month is its latest
 * locked month; every month at or before it is locked, whether or not it has
 * its own row. Only the latest locked month can be unlocked (admin), which
 * moves "closed through" back to the previous month that was itself locked.
 */
function closedThrough(companyId) {
  const r = getDb().prepare("SELECT MAX(period) AS p FROM accounting_periods WHERE company_id = ? AND status = 'locked'").get(companyId);
  return r?.p || null;
}

function isLocked(companyId, period) {
  const ct = closedThrough(companyId);
  return !!ct && period <= ct;
}

/** The first day of the first open month after `period` (always after "closed through"). */
function firstOpenDateAfter(companyId, period) {
  const ct = closedThrough(companyId);
  const p = addMonths(ct && ct >= period ? ct : period, 1);
  if (isLocked(companyId, p)) throw badRequest(`${humanMonth(p)} is locked — there is no open month to post into`);
  return `${p}-01`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function humanDate(d) { return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(0, 4)}`; }
function humanMonth(p) { return `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`; }

function writePeriod(companyId, period, status, note) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO accounting_periods (id, company_id, period, status, locked_by_user_id, locked_at, lock_note, updated_at)
    VALUES (@id, @companyId, @period, @status, @by, @lockedAt, @note, @now)
    ON CONFLICT(company_id, period) DO UPDATE SET status = excluded.status, locked_by_user_id = excluded.locked_by_user_id,
      locked_at = excluded.locked_at, lock_note = excluded.lock_note, updated_at = excluded.updated_at
  `).run({ id: uuid(), companyId, period, status, by: getCallerUserId(), lockedAt: status === 'locked' ? now : null, note: str(note, 500), now });
}

/** Close the books through `period` (a month that has ended). Locking an already-closed month is a no-op. */
function lockPeriod(companyId, period, note) {
  if (!companyId) throw badRequest('Company is required');
  assertPeriod(period);
  if (period >= todayPhnomPenh().slice(0, 7)) throw badRequest(`${humanMonth(period)} has not ended yet — it cannot be locked`);
  const before = closedThrough(companyId);
  if (before && period <= before) return { period, status: 'locked', closedThrough: before };
  // Review 2: never close a month whose depreciation is still to be posted.
  const due = require('./assetDepreciation').dueThrough(companyId, period);
  if (due) throw badRequest(`Depreciation for ${humanMonth(due)} is not posted yet — post the months up to ${humanMonth(period)} before locking it`);
  writePeriod(companyId, period, 'locked', note);
  audit('ledger_period', `${companyId}:${period}`, 'lock', { before: { closedThrough: before }, after: { closedThrough: period, note: str(note, 500) } });
  return { period, status: 'locked', closedThrough: period };
}

/** Reopen the LATEST locked month only (admin). */
function unlockPeriod(companyId, period, note) {
  if (!companyId) throw badRequest('Company is required');
  assertPeriod(period);
  const before = closedThrough(companyId);
  if (!before || period > before) return { period, status: 'open', closedThrough: before };
  if (period !== before) throw badRequest(`The books are closed through ${humanMonth(before)} — unlock that month first`);
  writePeriod(companyId, period, 'open', note);
  const after = closedThrough(companyId);
  audit('ledger_period', `${companyId}:${period}`, 'unlock', { before: { closedThrough: before }, after: { closedThrough: after, note: str(note, 500) } });
  return { period, status: 'open', closedThrough: after };
}

/** Months with entries or a lock, newest first: { period, status, entryCount, totalMinor, lockedAt, lockNote }. */
function listPeriods(companyId) {
  if (!companyId) return [];
  const db = getDb();
  const byPeriod = new Map();
  for (const r of db.prepare('SELECT period, COUNT(*) AS n, SUM(total_minor) AS t FROM journal_entries WHERE company_id = ? GROUP BY period').all(companyId)) {
    byPeriod.set(r.period, { period: r.period, status: 'open', entryCount: r.n, totalMinor: r.t, lockedAt: null, lockNote: null });
  }
  for (const r of db.prepare("SELECT * FROM accounting_periods WHERE company_id = ? AND status = 'locked'").all(companyId)) {
    const row = byPeriod.get(r.period) || { period: r.period, entryCount: 0, totalMinor: 0 };
    byPeriod.set(r.period, { ...row, lockedAt: r.locked_at ?? null, lockedByUserId: r.locked_by_user_id ?? null, lockNote: r.lock_note ?? null });
  }
  const ct = closedThrough(companyId);
  return [...byPeriod.values()]
    .map((r) => ({ lockedAt: null, lockNote: null, ...r, status: ct && r.period <= ct ? 'locked' : 'open' }))
    .sort((a, b) => (a.period < b.period ? 1 : -1));
}

/* ─── entries ────────────────────────────────────────────────── */

function rowToEntry(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, entryNo: r.entry_no, entryDate: r.entry_date, period: r.period,
    intendedDate: r.intended_date ?? null, sourceKind: r.source_kind, sourceId: r.source_id ?? null,
    idempotencyKey: r.idempotency_key, memo: r.memo ?? null, baseCurrency: r.base_currency,
    fxKhrPerUsd: r.fx_khr_per_usd, fxSource: r.fx_source ?? null, status: r.status,
    totalMinor: r.total_minor, khrTotal: r.khr_total, lineCount: r.line_count,
    reversesEntryId: r.reverses_entry_id ?? null, reversedByEntryId: r.reversed_by_entry_id ?? null,
    createdByUserId: r.created_by_user_id ?? null, createdAt: r.created_at,
  };
}

function rowToLine(r) {
  return {
    id: r.id, entryId: r.entry_id, lineNo: r.line_no, accountId: r.account_id,
    accountCode: r.account_code ?? undefined, accountName: r.account_name ?? undefined, accountKey: r.account_key ?? undefined,
    debitMinor: r.debit_minor, creditMinor: r.credit_minor, txnCurrency: r.txn_currency ?? null, txnAmountMinor: r.txn_amount_minor ?? null,
    khrMinor: r.khr_minor, branchId: r.branch_id ?? null, assetId: r.asset_id ?? null, employeeId: r.employee_id ?? null,
    lineRole: r.line_role ?? null, memo: r.memo ?? null,
  };
}

function linesFor(entryId) {
  return getDb().prepare(`
    SELECT l.*, a.code AS account_code, a.name_en AS account_name, a.system_key AS account_key
      FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no
  `).all(entryId).map(rowToLine);
}

function getEntry(id) {
  const e = rowToEntry(getDb().prepare('SELECT * FROM journal_entries WHERE id = ?').get(id));
  return e ? { ...e, lines: linesFor(id) } : null;
}

function nextEntryNo(companyId, year) {
  const prefix = (parseJson(getDb().prepare('SELECT settings_json FROM ledger_settings WHERE company_id = ?').get(companyId)?.settings_json, {}).entryPrefix) || 'JE';
  const stem = `${prefix}-${year}-`;
  const r = getDb().prepare(`
    SELECT MAX(CAST(substr(entry_no, ?) AS INTEGER)) AS n FROM journal_entries WHERE company_id = ? AND entry_no LIKE ?
  `).get(stem.length + 1, companyId, `${stem}%`);
  return `${stem}${String((r?.n || 0) + 1).padStart(6, '0')}`;
}

function resolveAccount(companyId, line) {
  const acc = line.accountKey ? accountByKey(companyId, line.accountKey) : getAccount(line.accountId);
  if (!acc || acc.companyId !== companyId) throw badRequest('A line names an account that is not in this company');
  if (acc.archived) throw badRequest(`Account ${acc.code} ${acc.nameEn} is archived — re-map the category to an open account`);
  if (!acc.isPostable) throw badRequest(`Account ${acc.code} ${acc.nameEn} is a heading, not postable`);
  return acc.id;
}

/**
 * Post one balanced entry.
 *   { companyId, entryDate, sourceKind, sourceId?, idempotencyKey, memo?,
 *     fxKhrPerUsd?, fxSource?, reversesEntryId?,
 *     lines: [{ accountId | accountKey, debitMinor | creditMinor, khrMinor?, txnCurrency?,
 *               txnAmountMinor?, branchId?, assetId?, employeeId?, lineRole?, memo? }] }
 * Returns the posted entry with its lines (`duplicate: true` when the key was
 * already posted — nothing new is written then). Safe inside a caller's
 * transaction (better-sqlite3 nests it as a savepoint).
 */
function post(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const key = str(input.idempotencyKey, 200);
  if (!key) throw badRequest('An idempotency key is required');
  if (!SOURCE_KINDS.includes(input.sourceKind)) throw badRequest(`Unknown source kind ${input.sourceKind}`);
  const intended = dateOrNull(input.entryDate, 'Entry date');
  if (!intended) throw badRequest('Entry date is required');
  const db = getDb();
  const result = db.transaction(() => {
    ensureChart(companyId);
    const existing = db.prepare('SELECT id FROM journal_entries WHERE company_id = ? AND idempotency_key = ?').get(companyId, key);
    if (existing) return { id: existing.id, duplicate: true };

    let entryDate = intended;
    let memo = str(input.memo, 1000);
    const intendedPeriod = intended.slice(0, 7);
    if (isLocked(companyId, intendedPeriod)) {
      entryDate = firstOpenDateAfter(companyId, intendedPeriod);
      memo = `Late entry for ${humanDate(intended)} (${humanMonth(intendedPeriod)} is locked)${memo ? ` — ${memo}` : ''}`;
    }
    let rate = Number(input.fxKhrPerUsd);
    let fxSource = str(input.fxSource, 60);
    if (!(rate > 0)) {
      const h = require('./fxRates').houseRateFor(companyId, intended);
      rate = h.khrPerUsd;
      fxSource = `house ${h.rateDate}${h.fallback ? ` (${h.fallback})` : ''}`;
    }
    const resolved = (input.lines || []).map((l) => {
      if (l.lineRole != null && !LINE_ROLES.includes(l.lineRole)) throw badRequest(`Unknown line role ${l.lineRole}`);
      return { ...l, accountId: resolveAccount(companyId, l) };
    });
    const { lines, totalMinor, khrTotal } = prepareLines(resolved, rate);
    if (input.reversesEntryId) {
      const orig = db.prepare('SELECT company_id FROM journal_entries WHERE id = ?').get(input.reversesEntryId);
      if (!orig || orig.company_id !== companyId) throw badRequest('The entry being reversed is not in this company');
    }

    const id = uuid();
    const now = Date.now();
    db.prepare(`
      INSERT INTO journal_entries (id, company_id, entry_no, entry_date, period, intended_date, source_kind, source_id,
        idempotency_key, memo, base_currency, fx_khr_per_usd, fx_source, status, line_count, total_minor, khr_total,
        reverses_entry_id, created_by_user_id, created_at)
      VALUES (@id, @companyId, @entryNo, @entryDate, @period, @intended, @sourceKind, @sourceId, @key, @memo, 'USD',
        @rate, @fxSource, 'posted', @lineCount, @total, @khrTotal, @reverses, @by, @now)
    `).run({
      id, companyId, entryNo: nextEntryNo(companyId, entryDate.slice(0, 4)), entryDate, period: entryDate.slice(0, 7),
      intended: intended === entryDate ? null : intended, sourceKind: input.sourceKind, sourceId: str(input.sourceId, 80),
      key, memo, rate, fxSource, lineCount: lines.length, total: totalMinor, khrTotal,
      reverses: input.reversesEntryId || null, by: getCallerUserId(), now,
    });
    const ins = db.prepare(`
      INSERT INTO journal_lines (id, entry_id, company_id, line_no, account_id, debit_minor, credit_minor, txn_currency,
        txn_amount_minor, khr_minor, branch_id, asset_id, employee_id, line_role, memo)
      VALUES (@id, @entryId, @companyId, @lineNo, @accountId, @debit, @credit, @txnCurrency, @txnAmount, @khr,
        @branchId, @assetId, @employeeId, @lineRole, @memo)
    `);
    lines.forEach((l, i) => ins.run({
      id: uuid(), entryId: id, companyId, lineNo: i + 1, accountId: l.accountId, debit: l.debitMinor, credit: l.creditMinor,
      txnCurrency: l.txnCurrency || null, txnAmount: l.txnAmountMinor ?? null, khr: l.khrMinor,
      branchId: l.branchId || null, assetId: l.assetId || null, employeeId: l.employeeId || null,
      lineRole: l.lineRole || null, memo: str(l.memo, 500),
    }));
    return { id, duplicate: false };
  })();
  const entry = getEntry(result.id);
  if (!result.duplicate) {
    audit('journal_entry', entry.id, 'post', { after: {
      entryNo: entry.entryNo, entryDate: entry.entryDate, intendedDate: entry.intendedDate, sourceKind: entry.sourceKind,
      sourceId: entry.sourceId, totalMinor: entry.totalMinor, khrTotal: entry.khrTotal, fxKhrPerUsd: entry.fxKhrPerUsd, memo: entry.memo,
    } });
  }
  return { ...entry, duplicate: result.duplicate };
}

/**
 * Post the mirror of an entry in the current open month (today, Phnom Penh;
 * the first open month after it when this month is locked) and link the two.
 * Lines keep their riel figures and the original's rate, so the reversal
 * cancels the original exactly in both currencies. Never deletes anything.
 */
function reverse(entryId, reason, { date = null, sourceKind = 'reversal', sourceId = null, idempotencyKey = null } = {}) {
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to reverse an entry');
  const db = getDb();
  return db.transaction(() => {
    const orig = getEntry(entryId);
    if (!orig) throw notFound('Journal entry');
    if (orig.reversedByEntryId) throw badRequest(`Entry ${orig.entryNo} has already been reversed`);
    if (orig.reversesEntryId) throw badRequest(`Entry ${orig.entryNo} is itself a reversal — post the original again instead`);
    const rev = post({
      companyId: orig.companyId,
      entryDate: date || todayPhnomPenh(),
      sourceKind,
      sourceId: sourceId || orig.id,
      idempotencyKey: idempotencyKey || `rev:${orig.id}`,
      memo: `Reversal of ${orig.entryNo}: ${why}`,
      fxKhrPerUsd: orig.fxKhrPerUsd,
      fxSource: orig.fxSource,
      reversesEntryId: orig.id,
      lines: mirrorLines(orig.lines).map((l) => ({
        accountId: l.accountId, debitMinor: l.debitMinor, creditMinor: l.creditMinor, khrMinor: l.khrMinor,
        txnCurrency: l.txnCurrency, txnAmountMinor: l.txnAmountMinor, branchId: l.branchId, assetId: l.assetId,
        employeeId: l.employeeId, lineRole: l.lineRole, memo: l.memo,
      })),
    });
    if (!rev.duplicate) db.prepare('UPDATE journal_entries SET reversed_by_entry_id = ? WHERE id = ?').run(rev.id, orig.id);
    return getEntry(rev.id);
  })();
}

/** Every entry with a line for this asset (all their lines), oldest first. */
function entriesForAsset(assetId) {
  const ids = getDb().prepare(`
    SELECT DISTINCT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE l.asset_id = ? ORDER BY e.entry_date, e.created_at
  `).all(assetId).map((r) => r.id);
  return ids.map(getEntry);
}

/**
 * The per-asset sub-ledger as plain sums by line role (signed so that cost
 * and accumulated depreciation read as positive balances).
 */
function assetLedgerTotals(assetId, { throughDate = null } = {}) {
  const rows = throughDate
    ? getDb().prepare(`
      SELECT l.line_role, SUM(l.debit_minor) AS d, SUM(l.credit_minor) AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.asset_id = ? AND e.entry_date <= ? GROUP BY l.line_role`).all(assetId, throughDate)
    : getDb().prepare(`
      SELECT line_role, SUM(debit_minor) AS d, SUM(credit_minor) AS c FROM journal_lines WHERE asset_id = ? GROUP BY line_role
    `).all(assetId);
  const by = Object.fromEntries(rows.map((r) => [r.line_role, { d: r.d || 0, c: r.c || 0 }]));
  const dr = (k) => (by[k] ? by[k].d - by[k].c : 0);
  const cr = (k) => (by[k] ? by[k].c - by[k].d : 0);
  return {
    costMinor: dr('cost'),
    accumDepMinor: cr('accum_dep') + cr('accum_disposal') + cr('accum_reval'),
    impairmentMinor: cr('impairment'),
    revaluationSurplusMinor: cr('revaluation'),
  };
}

/** §7 integrity pass: entries whose lines do not balance in USD or riel, or are missing lines. */
function checkIntegrity(companyId) {
  const db = getDb();
  const bad = [];
  const entries = db.prepare('SELECT id, entry_no, line_count FROM journal_entries WHERE company_id = ?').all(companyId);
  for (const e of entries) {
    const lines = db.prepare('SELECT debit_minor AS debitMinor, credit_minor AS creditMinor, khr_minor AS khrMinor FROM journal_lines WHERE entry_id = ?').all(e.id);
    const b = linesBalance(lines);
    if (!b.usd || !b.khr || lines.length !== e.line_count) bad.push({ id: e.id, entryNo: e.entry_no, ...b, lines: lines.length });
  }
  return { checked: entries.length, unbalanced: bad };
}

module.exports = {
  ACCOUNT_TYPES, SOURCE_KINDS, LINE_ROLES, SEED_ACCOUNTS,
  ensureChart, listAccounts, getAccount, accountByKey, updateAccount,
  isLocked, closedThrough, firstOpenDateAfter, lockPeriod, unlockPeriod, listPeriods, humanMonth,
  post, reverse, getEntry, entriesForAsset, assetLedgerTotals, checkIntegrity,
};
