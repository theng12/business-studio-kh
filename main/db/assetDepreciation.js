/**
 * Fixed Assets A2: the monthly depreciation run — computed minus posted
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §4.1, §5.5, §7).
 *
 * For each active, capitalised, in-service asset:
 *   due = depreciation charged by its schedule through the period
 *       − depreciation already posted for it (accum_dep lines, opening excluded)
 * The month's own amount goes on `dep_expense` lines; anything beyond it (a
 * late entry, an opening asset caught up, a locked month that had no run) goes
 * on `dep_catch_up` lines with a memo naming the months; a NEGATIVE due (a
 * reversed improvement, a life change) is posted back on `dep_catch_up` lines
 * the other way. One entry per company per month (key `dep:<period>`, then
 * `dep:<period>#2` after a reversal), plus a `depreciation_runs` row.
 *
 * Runs are sequential: the only month that can be posted is the next one due —
 * the month after the latest posted run, after the register start's month, and
 * after the month the books are closed through (a closed month that never had
 * a run is caught up in the first open month). A month that has not ended
 * cannot be posted (preview it instead). Only the LATEST run can be reversed,
 * and only while its month is open; the mirror is dated in that month.
 *
 * The month's line carries the branch the asset was in on the last day of the
 * month (§11).
 */

const { getDb } = require('./index');
const { uuid, str, badRequest, getCallerUserId, audit, todayPhnomPenh, notFound } = require('./_assetUtil');
const ledger = require('./ledger');
const config = require('./assetConfig');
const fixedAssets = require('./fixedAssets');
const book = require('../util/bookDepreciation');

function lastDayOf(period) {
  const next = book.addMonths(period, 1);
  return book.dayBefore(`${next}-01`);
}

function monthLabel(p) { return ledger.humanMonth(p); }

/** The last month that has ended (Phnom Penh time). */
function lastEndedPeriod() { return book.addMonths(todayPhnomPenh().slice(0, 7), -1); }

/** The branch an asset was in on `date` (main/db/fixedAssets.js). */
function branchAt(a, date) { return fixedAssets.branchAt(a, date); }

/** The next month a run may post, or null when nothing has been set up yet. */
function nextDuePeriod(companyId) {
  const settings = config.getSettings(companyId);
  const start = book.periodOf(settings.registerStartDate);
  let next = start;
  const last = fixedAssets.lastDepreciationPeriod(companyId);
  if (last && book.addMonths(last, 1) > next) next = book.addMonths(last, 1);
  const ct = ledger.closedThrough(companyId);
  if (ct && book.addMonths(ct, 1) > next) next = book.addMonths(ct, 1);
  return next;
}

/**
 * Every asset a run looks at: active, capitalised, in service — disposed and
 * lost ones included (review 2): their schedule ends at the disposal, so a
 * run for a month before it still posts that month, and a run after it takes
 * back anything a disposal settled ahead of the runs. For most of them the
 * due is simply 0.
 */
function runnableAssets(companyId) {
  return getDb().prepare(`
    SELECT id FROM fixed_assets WHERE company_id = ? AND record_state = 'active' AND accounting_treatment = 'capitalised'
       AND depreciation_start_period IS NOT NULL
     ORDER BY tag_seq, tag_code
  `).all(companyId).map((r) => fixedAssets.get(r.id));
}

/**
 * What one asset owes for `period`: { due, monthPart, catchUp }.
 * Posted means posted IN or BEFORE that month (review 2): an entry dated
 * later — a disposal, partial disposal or revaluation that settled months
 * ahead of the runs — is not counted, so every month-end equals the schedule;
 * the run for the event's own month takes back what it settled twice.
 */
function dueFor(a, period, postedDep = null) {
  const spec = fixedAssets.scheduleSpec(a);
  if (!spec || period < spec.startPeriod) return { due: 0, monthPart: 0, catchUp: 0, computed: 0, posted: 0 };
  const computed = book.chargedThrough(spec, period);
  const posted = postedDep == null ? fixedAssets.postedDepreciation(a.id, { throughPeriod: period }) : postedDep;
  const due = computed - posted;
  const current = book.amountFor(spec, period);
  const monthPart = Math.min(Math.max(due, 0), current);
  return { due, monthPart, catchUp: due - monthPart, computed, posted };
}

/** The lines (and per-asset rows) a run for `period` would post now. */
function buildRun(companyId, period) {
  const assets = runnableAssets(companyId);
  const lastPosted = fixedAssets.lastDepreciationPeriod(companyId);
  const catchFrom = lastPosted ? book.addMonths(lastPosted, 1) : book.periodOf(config.getSettings(companyId).registerStartDate);
  const monthEnd = lastDayOf(period);
  const rows = [];
  const lines = [];
  for (const a of assets) {
    const d = dueFor(a, period);
    if (!d.due) continue;
    const category = config.getCategory(a.categoryId);
    const branchId = branchAt(a, monthEnd);
    const dims = { assetId: a.id, branchId };
    if (d.monthPart > 0) lines.push({ accountId: category.glExpenseAccountId, debitMinor: d.monthPart, lineRole: 'dep_expense', memo: `${a.tagCode} ${monthLabel(period)}`, ...dims });
    if (d.catchUp > 0) {
      const from = catchFrom < period ? catchFrom : a.depreciationStartPeriod;
      lines.push({ accountId: category.glExpenseAccountId, debitMinor: d.catchUp, lineRole: 'dep_catch_up', memo: `${a.tagCode} catch-up ${monthLabel(from)}–${monthLabel(book.addMonths(period, -1))}`, ...dims });
    }
    if (d.catchUp < 0) lines.push({ accountId: category.glExpenseAccountId, creditMinor: -d.catchUp, lineRole: 'dep_catch_up', memo: `${a.tagCode} correction (less than posted)`, ...dims });
    if (d.due > 0) lines.push({ accountId: category.glAccumAccountId, creditMinor: d.due, lineRole: 'accum_dep', ...dims });
    else lines.push({ accountId: category.glAccumAccountId, debitMinor: -d.due, lineRole: 'accum_dep', ...dims });
    rows.push({
      assetId: a.id, tagCode: a.tagCode, name: a.name, categoryId: a.categoryId, categoryName: a.categoryName, branchId,
      monthMinor: d.monthPart, catchUpMinor: d.catchUp, dueMinor: d.due, computedMinor: d.computed, postedBeforeMinor: d.posted,
    });
  }
  return { rows, lines, catchFrom };
}

function summarize(rows) {
  const byCategory = {};
  const byBranch = {};
  for (const r of rows) {
    const c = (byCategory[r.categoryId] ||= { categoryId: r.categoryId, categoryName: r.categoryName, dueMinor: 0, assets: 0 });
    c.dueMinor += r.dueMinor; c.assets += 1;
    const k = r.branchId || 'none';
    const b = (byBranch[k] ||= { branchId: r.branchId || null, dueMinor: 0, assets: 0 });
    b.dueMinor += r.dueMinor; b.assets += 1;
  }
  return {
    totalMinor: rows.reduce((t, r) => t + r.dueMinor, 0),
    monthMinor: rows.reduce((t, r) => t + r.monthMinor, 0),
    catchUpMinor: rows.reduce((t, r) => t + r.catchUpMinor, 0),
    byCategory: Object.values(byCategory), byBranch: Object.values(byBranch),
  };
}

/** Why `period` cannot be posted now, or null. */
function cannotPostReason(companyId, period) {
  const settings = config.getSettings(companyId);
  const start = book.periodOf(settings.registerStartDate);
  if (period < start) return `${monthLabel(period)} is before the register start (${settings.registerStartDate})`;
  if (ledger.isLocked(companyId, period)) return `${monthLabel(period)} is locked`;
  if (period > lastEndedPeriod()) return `${monthLabel(period)} has not ended yet — preview it, post it after the month ends`;
  const posted = getDb().prepare("SELECT 1 FROM depreciation_runs WHERE company_id = ? AND period = ? AND status = 'posted'").get(companyId, period);
  if (posted) return `${monthLabel(period)} is already posted`;
  const next = nextDuePeriod(companyId);
  if (period !== next) return `Post ${monthLabel(next)} first — months are posted in order`;
  return null;
}

/** The preview: the same computation without posting. Any month from the register start. */
function previewDepreciation(companyId, period) {
  book.assertPeriod(period);
  const { rows } = buildRun(companyId, period);
  return { period, canPost: !cannotPostReason(companyId, period), reason: cannotPostReason(companyId, period), nextDuePeriod: nextDuePeriod(companyId), rows, ...summarize(rows) };
}

function rowToRun(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, period: r.period, status: r.status, kind: r.kind, attempt: r.attempt,
    journalEntryId: r.journal_entry_id ?? null, assetCount: r.asset_count, totalMinor: r.total_minor, catchUpMinor: r.catch_up_minor,
    runByUserId: r.run_by_user_id ?? null, runAt: r.run_at, reversedByEntryId: r.reversed_by_entry_id ?? null,
    reversedAt: r.reversed_at ?? null, reverseReason: r.reverse_reason ?? null,
  };
}

/** Post the depreciation for `period` (the next month due). */
function runDepreciation(companyId, period, { kind = 'manual' } = {}) {
  book.assertPeriod(period);
  const why = cannotPostReason(companyId, period);
  if (why) throw badRequest(why);
  const db = getDb();
  let runId;
  let entry = null;
  let summary;
  db.transaction(() => {
    const { rows, lines } = buildRun(companyId, period);
    summary = summarize(rows);
    const attempt = db.prepare('SELECT COUNT(*) AS n FROM depreciation_runs WHERE company_id = ? AND period = ?').get(companyId, period).n + 1;
    if (lines.length) {
      entry = ledger.post({
        companyId, entryDate: lastDayOf(period), sourceKind: 'asset_depreciation', sourceId: period,
        idempotencyKey: attempt === 1 ? `dep:${period}` : `dep:${period}#${attempt}`,
        memo: `Depreciation ${monthLabel(period)}${summary.catchUpMinor ? ' (with catch-up)' : ''}`, lines,
      });
    }
    runId = uuid();
    db.prepare(`
      INSERT INTO depreciation_runs (id, company_id, period, status, kind, attempt, journal_entry_id, asset_count, total_minor, catch_up_minor, run_by_user_id, run_at)
      VALUES (?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, companyId, period, kind === 'auto' ? 'auto' : 'manual', attempt, entry ? entry.id : null, rows.length, summary.totalMinor, summary.catchUpMinor, getCallerUserId(), Date.now());
    for (const r of rows) refreshSnapshot(r.assetId);
  })();
  audit('depreciation_run', runId, 'post', { after: { period, kind, entryNo: entry?.entryNo ?? null, totalMinor: summary.totalMinor, catchUpMinor: summary.catchUpMinor } });
  return { run: getRun(runId), entry, ...summary };
}

function getRun(id) { return rowToRun(getDb().prepare('SELECT * FROM depreciation_runs WHERE id = ?').get(id)); }

/** Reverse the LATEST posted run (its month must be open); the mirror is dated in that month. */
function reverseRun(companyId, period, reason) {
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to reverse a run');
  const run = rowToRun(getDb().prepare("SELECT * FROM depreciation_runs WHERE company_id = ? AND period = ? AND status = 'posted'").get(companyId, period));
  if (!run) throw notFound('Posted run');
  const last = fixedAssets.lastDepreciationPeriod(companyId);
  if (last !== period) throw badRequest(`Only the latest run (${monthLabel(last)}) can be reversed`);
  if (ledger.isLocked(companyId, period)) throw badRequest(`${monthLabel(period)} is locked — its run cannot be reversed`);
  // Review 2 (HIGH 1): an asset that has left the register (or gone back to
  // draft) since this run would keep a balance for good — undo that first.
  if (run.journalEntryId) {
    const gone = getDb().prepare(`
      SELECT DISTINCT a.tag_code, a.status, a.record_state FROM journal_lines l JOIN fixed_assets a ON a.id = l.asset_id
       WHERE l.entry_id = ? AND (a.status IN ('disposed', 'lost') OR a.record_state <> 'active') ORDER BY a.tag_code
    `).all(run.journalEntryId);
    if (gone.length) {
      const g = gone[0];
      const what = g.record_state !== 'active' ? `the return to draft of ${g.tag_code} (activate it again)`
        : g.status === 'lost' ? `the write-off of ${g.tag_code} ("Found again")` : `the disposal of ${g.tag_code}`;
      throw badRequest(`Undo ${what} first — reversing this run would leave a balance on it${gone.length > 1 ? ` (and ${gone.length - 1} more)` : ''}`);
    }
  }
  const db = getDb();
  let rev = null;
  db.transaction(() => {
    if (run.journalEntryId) rev = ledger.reverse(run.journalEntryId, why, { date: lastDayOf(period), sourceKind: 'reversal', sourceId: run.id });
    db.prepare(`UPDATE depreciation_runs SET status = 'reversed', reversed_by_entry_id = ?, reversed_at = ?, reversed_by_user_id = ?, reverse_reason = ? WHERE id = ?`)
      .run(rev ? rev.id : null, Date.now(), getCallerUserId(), why, run.id);
    if (run.journalEntryId) {
      const ids = db.prepare('SELECT DISTINCT asset_id FROM journal_lines WHERE entry_id = ? AND asset_id IS NOT NULL').all(run.journalEntryId).map((r) => r.asset_id);
      for (const id of ids) refreshSnapshot(id);
    }
  })();
  audit('depreciation_run', run.id, 'reverse', { after: { period, reason: why, entryNo: rev?.entryNo ?? null } });
  return { run: getRun(run.id), entry: rev };
}

/**
 * Months from the register start to the last ended month, newest first:
 * { period, status ('posted'|'due'|'locked'|'future'), run, locked }.
 */
function listRuns(companyId) {
  const settings = config.getSettings(companyId);
  const start = book.periodOf(settings.registerStartDate);
  const runs = getDb().prepare('SELECT * FROM depreciation_runs WHERE company_id = ? ORDER BY period, attempt').all(companyId).map(rowToRun);
  const end = book.addMonths(todayPhnomPenh().slice(0, 7), 0);
  const out = [];
  const next = nextDuePeriod(companyId);
  for (let p = start; p <= end && out.length < 600; p = book.addMonths(p, 1)) {
    const mine = runs.filter((r) => r.period === p);
    const posted = mine.find((r) => r.status === 'posted') || null;
    const locked = ledger.isLocked(companyId, p);
    let status = 'due';
    if (posted) status = 'posted';
    else if (p > lastEndedPeriod()) status = 'open';
    else if (locked) status = 'locked';
    out.push({ period: p, status, locked, isNext: p === next, run: posted, history: mine });
  }
  return { nextDuePeriod: next, lastEndedPeriod: lastEndedPeriod(), months: out.reverse() };
}

/** Every month still due up to `through` (default: last ended), oldest first. */
function dueMonths(companyId, through = null) {
  const limit = through && through < lastEndedPeriod() ? through : lastEndedPeriod();
  const out = [];
  for (let p = nextDuePeriod(companyId); p <= limit && out.length < 600; p = book.addMonths(p, 1)) out.push(p);
  return out;
}

/**
 * Is depreciation still to be posted for `period` or earlier? (a month with
 * depreciating assets and no run). Used to refuse closing such a month.
 */
function dueThrough(companyId, period) {
  const next = nextDuePeriod(companyId);
  if (next > period) return null;
  const any = getDb().prepare(`SELECT 1 FROM fixed_assets WHERE company_id = ? AND record_state = 'active' AND accounting_treatment = 'capitalised'
      AND depreciation_start_period IS NOT NULL AND depreciation_start_period <= ? LIMIT 1`).get(companyId, period);
  return any ? next : null;
}

/** The latest run row for a month was reversed (by hand) and not posted again. */
function reversedByHand(companyId, period) {
  const r = getDb().prepare('SELECT status FROM depreciation_runs WHERE company_id = ? AND period = ? ORDER BY attempt DESC LIMIT 1').get(companyId, period);
  return r?.status === 'reversed';
}

/* ─── snapshots and integrity (§7) ────────────────────────────── */

/**
 * Rebuild an asset's list columns from the ledger: accumulated depreciation,
 * NBV and the last month posted. Cost-tracked-only items have no ledger and
 * keep their cost as the NBV.
 */
function refreshSnapshot(assetId) {
  const a = fixedAssets.get(assetId);
  if (!a || a.recordState !== 'active') return;
  if (a.accountingTreatment === 'tracked_only') return;
  const t = ledger.assetLedgerTotals(assetId);
  const last = getDb().prepare(`
    SELECT MAX(e.period) AS p FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.asset_id = ? AND e.source_kind = 'asset_depreciation' AND e.reversed_by_entry_id IS NULL
  `).get(assetId).p;
  getDb().prepare('UPDATE fixed_assets SET accum_minor = ?, nbv_minor = ?, last_posted_period = ? WHERE id = ?')
    .run(t.accumDepMinor, t.costMinor - t.accumDepMinor - t.impairmentMinor, last || null, assetId);
}

/**
 * The integrity pass: every entry balances (USD + riel); every asset's
 * snapshot equals its ledger; every fixed-asset account's GL balance equals
 * the sum of its asset-tagged lines (sub-ledger = GL), per account and in total.
 */
function checkIntegrity(companyId) {
  const db = getDb();
  const entries = ledger.checkIntegrity(companyId);
  const assets = [];
  const lastRunEarly = fixedAssets.lastDepreciationPeriod(companyId);
  for (const r of db.prepare("SELECT id FROM fixed_assets WHERE company_id = ? AND record_state = 'active' AND accounting_treatment <> 'tracked_only'").all(companyId)) {
    const a = fixedAssets.get(r.id);
    const t = ledger.assetLedgerTotals(a.id);
    const nbv = t.costMinor - t.accumDepMinor - t.impairmentMinor;
    if (a.status === 'disposed' || a.status === 'lost') {
      // While the runs are behind its disposal, the runs still to come take back
      // what the disposal settled ahead of them; after that, nothing may be left.
      const spec = fixedAssets.scheduleSpec(a);
      const runsBehind = spec && spec.endPeriod && (!lastRunEarly || spec.endPeriod > lastRunEarly);
      if (!runsBehind && (t.costMinor !== 0 || t.accumDepMinor !== 0 || t.impairmentMinor !== 0)) assets.push({ assetId: a.id, tagCode: a.tagCode, problem: 'gone from the register but still has a balance', ...t });
      if (a.accumMinor !== t.accumDepMinor || a.nbvMinor !== nbv) assets.push({ assetId: a.id, tagCode: a.tagCode, problem: 'snapshot differs from the ledger', snapshotAccum: a.accumMinor, snapshotNbv: a.nbvMinor, ledgerAccum: t.accumDepMinor, ledgerNbv: nbv });
      continue;
    }
    if (a.accumMinor !== t.accumDepMinor || a.nbvMinor !== nbv) {
      assets.push({ assetId: a.id, tagCode: a.tagCode, problem: 'snapshot differs from the ledger', snapshotAccum: a.accumMinor, snapshotNbv: a.nbvMinor, ledgerAccum: t.accumDepMinor, ledgerNbv: nbv });
    }
  }
  // Review 2 (HIGH 1): posted depreciation = the schedule, per asset. A live
  // asset compares through the last run month; one that changed after that run
  // (activated late, found again, given an in-service date…) is only "due at the
  // next run". A gone asset must have posted exactly its schedule to the end.
  const lastRun = fixedAssets.lastDepreciationPeriod(companyId);
  const lastRunAt = lastRun ? db.prepare("SELECT MAX(run_at) AS t FROM depreciation_runs WHERE company_id = ? AND status = 'posted'").get(companyId).t : null;
  const schedule = [];
  const pending = [];
  if (lastRun) {
    for (const a of runnableAssets(companyId)) {
      const spec = fixedAssets.scheduleSpec(a);
      if (!spec) continue;
      const gone = a.status === 'disposed' || a.status === 'lost';
      const through = gone && spec.endPeriod && spec.endPeriod > lastRun ? spec.endPeriod : lastRun;
      const computed = book.chargedThrough(spec, through);
      const posted = gone ? fixedAssets.postedDepreciation(a.id) : fixedAssets.postedDepreciation(a.id, { throughPeriod: lastRun });
      if (computed === posted) continue;
      const changedAt = Math.max(a.activatedAt || 0, db.prepare('SELECT MAX(created_at) AS t FROM asset_events WHERE asset_id = ?').get(a.id).t || 0);
      const row = { assetId: a.id, tagCode: a.tagCode, throughPeriod: through, computedMinor: computed, postedMinor: posted };
      if (!gone && changedAt > lastRunAt) pending.push(row);
      else schedule.push({ ...row, problem: 'posted depreciation differs from the schedule' });
    }
  }
  const accountKeys = ['fa.cost.%', 'fa.accum.%', 'fa.impairment'];
  const accounts = db.prepare(`
    SELECT a.id, a.code, a.name_en, a.system_key,
           COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS gl,
           COALESCE(SUM(CASE WHEN l.asset_id IS NOT NULL THEN l.debit_minor - l.credit_minor ELSE 0 END), 0) AS sub
      FROM gl_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
     WHERE a.company_id = ? AND (a.system_key LIKE ? OR a.system_key LIKE ? OR a.system_key = ?
       OR a.id IN (SELECT gl_cost_account_id FROM asset_categories WHERE company_id = ?)
       OR a.id IN (SELECT gl_accum_account_id FROM asset_categories WHERE company_id = ?))
     GROUP BY a.id ORDER BY a.code
  `).all(companyId, ...accountKeys, companyId, companyId);
  const accountProblems = accounts.filter((x) => x.gl !== x.sub).map((x) => ({ accountId: x.id, code: x.code, name: x.name_en, glMinor: x.gl, subledgerMinor: x.sub }));
  // Total: the register's NBV (from snapshots) = the GL's net fixed-asset balance.
  // Gone assets are 0 here unless the runs are still behind their disposal (then both sides carry it).
  const registerNbv = db.prepare(`SELECT COALESCE(SUM(nbv_minor), 0) AS n FROM fixed_assets WHERE company_id = ? AND record_state = 'active'
      AND accounting_treatment <> 'tracked_only'`).get(companyId).n;
  const glNet = accounts.reduce((t, x) => t + x.gl, 0);
  return {
    checked: entries.checked, unbalanced: entries.unbalanced, assets, accounts: accountProblems, schedule, pendingAtNextRun: pending, lastRun,
    totals: { registerNbvMinor: registerNbv, glNetMinor: glNet, matches: registerNbv === glNet },
    ok: !entries.unbalanced.length && !assets.length && !accountProblems.length && !schedule.length && registerNbv === glNet,
  };
}

module.exports = {
  lastDayOf, lastEndedPeriod, branchAt, nextDuePeriod, dueFor, buildRun, previewDepreciation, runDepreciation, reverseRun,
  listRuns, dueMonths, getRun, refreshSnapshot, checkIntegrity, cannotPostReason, dueThrough, reversedByHand,
};
