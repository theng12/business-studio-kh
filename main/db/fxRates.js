/**
 * Fixed Assets A0: exchange rates, riel per US dollar (docs/ASSETS_AND_BRANCHES_PLAN.md §3.2).
 *
 *   house     the business's own rate. Book entries use it. The first time an
 *             entry needs one and none exists, it is seeded from this Mac's
 *             Settings rate (`exchangeRateKhrPerUsd`), noted "from Settings".
 *   official  a dated official rate (e.g. the GDT daily rate). The tax view
 *             uses it; when one is missing it falls back to the house rate and
 *             says so.
 *
 * The rate on a date is the latest non-void rate on or before that date for
 * that source. Every journal entry stores the rate it used, so changing or
 * voiding a rate here never moves a posted figure. A wrong rate is voided
 * (with a reason) — never deleted; entering a new rate for a date that
 * already has one voids the old one in the same transaction.
 */

const { getDb } = require('./index');
const { uuid, str, num, badRequest, getCallerUserId, audit, dateOrNull, notFound } = require('./_assetUtil');

const SOURCES = ['house', 'official'];
const MIN_RATE = 100;
const MAX_RATE = 100000;

function rowToRate(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, rateDate: r.rate_date, khrPerUsd: r.khr_per_usd, source: r.source,
    sourceNote: r.source_note ?? null, fileId: r.file_id ?? null, createdByUserId: r.created_by_user_id ?? null,
    createdAt: r.created_at, voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null,
  };
}

function source(v) {
  const s = v ?? 'house';
  if (!SOURCES.includes(s)) throw badRequest('source must be house or official');
  return s;
}

function list(companyId, { source: src = null, includeVoided = false, from = null, to = null, limit = 500 } = {}) {
  if (!companyId) return [];
  const where = ['company_id = @companyId'];
  if (src) { source(src); where.push('source = @src'); }
  if (!includeVoided) where.push('voided_at IS NULL');
  if (from) where.push('rate_date >= @from');
  if (to) where.push('rate_date <= @to');
  return getDb().prepare(`SELECT * FROM fx_rates WHERE ${where.join(' AND ')} ORDER BY rate_date DESC, created_at DESC LIMIT @limit`)
    .all({ companyId, src, from, to, limit: Math.min(Math.max(1, Number(limit) || 500), 5000) }).map(rowToRate);
}

function get(id) { return rowToRate(getDb().prepare('SELECT * FROM fx_rates WHERE id = ?').get(id)); }

/** The latest non-void rate on or before `date` for a source, or null. */
function rateOn(companyId, date, src = 'house') {
  const d = dateOrNull(date, 'date');
  if (!companyId || !d) return null;
  const r = getDb().prepare(`
    SELECT * FROM fx_rates WHERE company_id = ? AND source = ? AND voided_at IS NULL AND rate_date <= ?
     ORDER BY rate_date DESC, created_at DESC LIMIT 1
  `).get(companyId, source(src), d);
  return r ? { ...rowToRate(r), exact: r.rate_date === d } : null;
}

/** This Mac's Settings rate (config.json), 4,100 outside the app. */
function settingsRate() {
  try { return require('./fuel').fxKhrPerUsd(); } catch (_) { return 4100; }
}

/**
 * The house rate for a book entry dated `date`: { khrPerUsd, rateDate, fallback }.
 * The house rate is per COMPANY (here, in fx_rates), not per Mac. When the
 * company has none yet, one is seeded from the Settings rate of the Mac that
 * runs the data (the server Mac) — dated the register start date, never an old
 * purchase date — and noted "from Settings". A date before the earliest house
 * rate gets the earliest one, flagged `fallback: 'earliest'`.
 */
function houseRateFor(companyId, date, { seed = true } = {}) {
  const exact = rateOn(companyId, date, 'house');
  if (exact) return { khrPerUsd: exact.khrPerUsd, rateDate: exact.rateDate, source: 'house', fallback: null, rateId: exact.id };
  const db = getDb();
  const earliest = db.prepare(`SELECT * FROM fx_rates WHERE company_id = ? AND source = 'house' AND voided_at IS NULL ORDER BY rate_date, created_at LIMIT 1`).get(companyId);
  if (earliest) return { khrPerUsd: earliest.khr_per_usd, rateDate: earliest.rate_date, source: 'house', fallback: 'earliest', rateId: earliest.id };
  // A preview must not write: it reads the Settings rate the real post would seed.
  if (!seed) return { khrPerUsd: settingsRate(), rateDate: date, source: 'house', fallback: 'settings', rateId: null };
  let seedDate = date;
  try { seedDate = require('./assetConfig').getSettings(companyId).registerStartDate || date; } catch (_) { /* no settings yet */ }
  const seeded = setRate({ companyId, rateDate: seedDate, khrPerUsd: settingsRate(), source: 'house', sourceNote: 'from Settings' });
  return { khrPerUsd: seeded.khrPerUsd, rateDate: seeded.rateDate, source: 'house', fallback: seedDate <= date ? 'seeded' : 'earliest', rateId: seeded.id };
}

/** The rate the tax view uses on a date: official, else house (labelled). */
function taxRateFor(companyId, date, { seed = true } = {}) {
  const off = rateOn(companyId, date, 'official');
  if (off) return { khrPerUsd: off.khrPerUsd, rateDate: off.rateDate, source: 'official', fallback: null, rateId: off.id };
  const house = houseRateFor(companyId, date, { seed });
  return { ...house, fallback: 'house' };
}

function setRate(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const rateDate = dateOrNull(input.rateDate, 'Rate date');
  if (!rateDate) throw badRequest('Rate date is required');
  const rate = num(input.khrPerUsd);
  if (rate == null || rate < MIN_RATE || rate > MAX_RATE) throw badRequest(`Riel per dollar must be between ${MIN_RATE} and ${MAX_RATE}`);
  const src = source(input.source);
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  let replaced = null;
  db.transaction(() => {
    const old = db.prepare('SELECT * FROM fx_rates WHERE company_id = ? AND rate_date = ? AND source = ? AND voided_at IS NULL').get(companyId, rateDate, src);
    if (old) {
      db.prepare('UPDATE fx_rates SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(now, 'Replaced by a new rate for the same date', getCallerUserId(), old.id);
      replaced = rowToRate(old);
    }
    db.prepare(`
      INSERT INTO fx_rates (id, company_id, rate_date, khr_per_usd, source, source_note, file_id, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, companyId, rateDate, rate, src, str(input.sourceNote, 500), str(input.fileId, 60), getCallerUserId(), now);
  })();
  const created = get(id);
  if (replaced) audit('fx_rate', replaced.id, 'void', { before: replaced, after: { voided: true, replacedBy: id } });
  audit('fx_rate', id, 'create', { after: created });
  return created;
}

function voidRate(id, reason) {
  const existing = get(id);
  if (!existing) throw notFound('Rate');
  if (existing.voided) return existing;
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to void a rate');
  getDb().prepare('UPDATE fx_rates SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(Date.now(), why, getCallerUserId(), id);
  audit('fx_rate', id, 'void', { before: existing, after: { voided: true, voidReason: why } });
  return get(id);
}

module.exports = { SOURCES, list, get, rateOn, houseRateFor, taxRateFor, setRate, voidRate, settingsRate };
