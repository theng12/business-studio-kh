/**
 * Trade Finance — banks, credit facilities, drawdowns, repayments and the
 * interest record (docs/TRADE_FINANCE_PLAN.md §3, Phase A).
 *
 * Same shape as the other db/* modules: a rowToX mapper per table, every
 * statement scoped to one company, derived figures computed here rather than
 * stored, and no destructive delete — a facility is archived, a drawdown is
 * cancelled or closed, a repayment and a posting are permanent records.
 *
 * Money arrives as whole minor units from the IPC layer and stays that way.
 * The one place a fraction exists is inside tradeMath, which rounds once.
 */

const { getDb } = require('./index');
const { randomUUID } = require('node:crypto');
const {
  str, badRequest, dateOrNull, todayPhnomPenh, audit, notFound,
} = require('./_assetUtil');
const {
  calendarDaysBetween, daysUntil, accruedMinor, outstandingMinor,
  commitmentPerPeriodMinor, utilisation, ladderBucket, LADDER_BUCKETS, interestMinor,
} = require('../util/tradeMath');

const KINDS = ['OD', 'RC', 'TR', 'Other'];
const FACILITY_CURRENCIES = ['USD', 'KHR'];
const BASES = ['drawn', 'balance'];
const BILLINGS = ['at_repayment', 'month_end_capitalised'];
const COMMITMENT_FREQS = ['monthly', 'quarterly', 'yearly'];
const DRAWDOWN_STATUSES = ['active', 'closed', 'cancelled'];

/* ── validation ─────────────────────────────────────────────────────── */

function oneOf(v, allowed, label, fallback) {
  if ((v == null || v === '') && fallback !== undefined) return fallback;
  const s = String(v ?? '');
  if (!allowed.includes(s)) throw badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  return s;
}

function rateOr(v, label) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${label} must be a positive number`);
  return n;
}

function wholeMinor(v, label, { min = 0 } = {}) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw badRequest(`${label} must be a whole amount in minor units`);
  return n;
}

function calendarDate(v, label) {
  const d = dateOrNull(v, label);
  if (!d) throw badRequest(`${label} is required`);
  return d;
}

function optionalDate(v, label) { return dateOrNull(v, label); }

function boolOr(v, fallback) {
  return (v == null ? fallback : v) ? 1 : 0;
}

function metaCurrency(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw badRequest('Settlement currency must be a three-letter code like CNY');
  return s;
}

function reference(v) {
  const s = str(v, 80);
  return s || null;
}

/** '' and null mean the same thing (an untouched optional field). */
function sameValue(a, b) {
  if (a == null || a === '') return b == null || b === '';
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

function friendlyReference(err) {
  // SQLite names the columns in a UNIQUE failure, not the index.
  if (/tf_drawdowns\.reference/.test(String(err?.message || ''))) {
    return badRequest('That bank reference is already used by another drawdown in this company');
  }
  return err;
}

/* ── mappers ────────────────────────────────────────────────────────── */

function rowToBank(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, name: r.name, note: r.note,
    archivedAt: r.archived_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToFacility(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, bankId: r.bank_id, bankName: r.bank_name ?? null,
    kind: r.kind, name: r.name, currency: r.currency,
    limitMinor: r.limit_minor, rate: r.rate, dayCount: r.day_count,
    revolving: !!r.revolving, hasMaturity: !!r.has_maturity,
    interestBasis: r.interest_basis, interestBilling: r.interest_billing,
    commitmentRate: r.commitment_rate, commitmentFreq: r.commitment_freq,
    termDays: r.term_days ?? null, active: !!r.active, note: r.note ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToDrawdown(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, facilityId: r.facility_id,
    facilityName: r.facility_name ?? null, facilityKind: r.facility_kind ?? null,
    bankName: r.bank_name ?? null, currency: r.currency ?? null,
    dayCount: r.day_count ?? null, principalMinor: r.principal_minor,
    valueDate: r.value_date, maturityDate: r.maturity_date ?? null,
    rate: r.rate, reference: r.reference ?? null,
    settleCurrency: r.settle_currency ?? null, fxRate: r.fx_rate ?? null,
    purchaseOrderId: r.purchase_order_id ?? null, note: r.note ?? null,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToRepayment(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, drawdownId: r.drawdown_id,
    principalMinor: r.principal_minor, interestMinor: r.interest_minor,
    paidOn: r.paid_on, note: r.note ?? null, createdAt: r.created_at,
  };
}

function rowToPosting(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, facilityId: r.facility_id,
    facilityName: r.facility_name ?? null, currency: r.currency ?? null,
    drawdownId: r.drawdown_id ?? null, drawdownReference: r.drawdown_reference ?? null,
    periodStart: r.period_start, periodEnd: r.period_end,
    basisMinor: r.basis_minor, rate: r.rate, dayCount: r.day_count,
    days: r.days, amountMinor: r.amount_minor, source: r.source,
    note: r.note ?? null, createdAt: r.created_at,
  };
}

/* ── banks ──────────────────────────────────────────────────────────── */

function listBanks(companyId, { includeArchived = false } = {}) {
  if (!companyId) return [];
  const sql = `SELECT * FROM tf_banks WHERE company_id = ?${includeArchived ? '' : ' AND archived_at IS NULL'}
    ORDER BY name COLLATE NOCASE`;
  return getDb().prepare(sql).all(companyId).map(rowToBank);
}

function getBank(companyId, id) {
  return rowToBank(getDb().prepare('SELECT * FROM tf_banks WHERE id = ? AND company_id = ?').get(id, companyId));
}

function createBank(companyId, input = {}, userId = null) {
  const name = str(input.name, 120);
  if (!name) throw badRequest('Enter the bank name');
  const now = Date.now();
  const id = randomUUID();
  getDb().prepare(`INSERT INTO tf_banks (id, company_id, name, note, archived_at, created_at, updated_at, updated_by_user_id)
    VALUES (?,?,?,?,NULL,?,?,?)`).run(id, companyId, name, str(input.note, 500), now, now, userId);
  audit('tf_bank', id, 'create', { after: { companyId, name } });
  return getBank(companyId, id);
}

function updateBank(companyId, id, patch = {}, userId = null) {
  const row = getDb().prepare('SELECT * FROM tf_banks WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!row) throw notFound('Bank');
  const name = patch.name === undefined ? row.name : str(patch.name, 120);
  if (!name) throw badRequest('Enter the bank name');
  const note = patch.note === undefined ? row.note : str(patch.note, 500);
  getDb().prepare('UPDATE tf_banks SET name = ?, note = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ? AND company_id = ?')
    .run(name, note, Date.now(), userId, id, companyId);
  audit('tf_bank', id, 'update', { before: rowToBank(row), after: { name } });
  return getBank(companyId, id);
}

function archiveBank(companyId, id, userId = null) {
  const row = getDb().prepare('SELECT * FROM tf_banks WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!row) throw notFound('Bank');
  const active = getDb().prepare('SELECT COUNT(*) AS n FROM tf_facilities WHERE bank_id = ? AND company_id = ? AND active = 1')
    .get(id, companyId).n;
  if (active) throw badRequest('Retire this bank\'s active facilities first');
  getDb().prepare('UPDATE tf_banks SET archived_at = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ? AND company_id = ?')
    .run(Date.now(), Date.now(), userId, id, companyId);
  audit('tf_bank', id, 'archive', { before: rowToBank(row) });
  return getBank(companyId, id);
}

/* ── facilities ─────────────────────────────────────────────────────── */

function facilityRow(companyId, id) {
  return getDb().prepare(`
    SELECT f.*, b.name AS bank_name
    FROM tf_facilities f JOIN tf_banks b ON b.id = f.bank_id
    WHERE f.id = ? AND f.company_id = ?`).get(id, companyId);
}

/**
 * Drawn amount. A drawn-amount facility sums what its active drawdowns still
 * owe. A running-balance facility has no movement table in Phase A, so it
 * reads 0 and the screen says so instead of inventing a balance.
 */
function drawnMinor(facility) {
  if (facility.interestBasis === 'balance') return 0;
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(CASE WHEN x.outstanding < 0 THEN 0 ELSE x.outstanding END), 0) AS drawn
    FROM (
      SELECT d.principal_minor - COALESCE((
        SELECT SUM(r.principal_minor) FROM tf_repayments r WHERE r.drawdown_id = d.id
      ), 0) AS outstanding
      FROM tf_drawdowns d
      WHERE d.facility_id = ? AND d.company_id = ? AND d.status = 'active'
    ) x`).get(facility.id, facility.companyId);
  return row?.drawn || 0;
}

function enrichFacility(facility) {
  const drawn = drawnMinor(facility);
  const undrawn = Math.max(0, facility.limitMinor - drawn);
  const commitment = commitmentPerPeriodMinor({
    undrawnMinor: undrawn, ratePct: facility.commitmentRate, frequency: facility.commitmentFreq,
  });
  const active = getDb().prepare(`
    SELECT COUNT(*) AS n, MIN(maturity_date) AS next_maturity
    FROM tf_drawdowns WHERE facility_id = ? AND company_id = ? AND status = 'active'`)
    .get(facility.id, facility.companyId);
  return {
    ...facility,
    drawnMinor: drawn,
    undrawnMinor: undrawn,
    utilisation: utilisation(drawn, facility.limitMinor),
    commitmentPerPeriodMinor: commitment,
    activeDrawdowns: active?.n || 0,
    nextMaturity: active?.next_maturity || null,
    balanceBased: facility.interestBasis === 'balance',
  };
}

function listFacilities(companyId, { includeArchived = false } = {}) {
  if (!companyId) return [];
  const sql = `
    SELECT f.*, b.name AS bank_name
    FROM tf_facilities f JOIN tf_banks b ON b.id = f.bank_id
    WHERE f.company_id = ?${includeArchived ? '' : ' AND f.active = 1'}
    ORDER BY b.name COLLATE NOCASE, f.name COLLATE NOCASE`;
  return getDb().prepare(sql).all(companyId).map(rowToFacility).map(enrichFacility);
}

function getFacility(companyId, id) {
  const row = facilityRow(companyId, id);
  if (!row) return null;
  const facility = enrichFacility(rowToFacility(row));
  facility.rateHistory = getDb().prepare(`
    SELECT * FROM tf_rate_history WHERE facility_id = ? AND company_id = ?
    ORDER BY effective_date DESC, created_at DESC LIMIT 24`).all(id, companyId).map((r) => ({
    id: r.id, rate: r.rate, effectiveDate: r.effective_date, note: r.note ?? null, createdAt: r.created_at,
  }));
  return facility;
}

function facilityInput(companyId, input, existing = null) {
  const bankId = input.bankId ?? existing?.bankId;
  const bank = bankId ? getDb().prepare('SELECT * FROM tf_banks WHERE id = ? AND company_id = ?').get(bankId, companyId) : null;
  if (!bank || bank.archived_at) throw badRequest('Choose an active bank');
  const name = str(input.name ?? existing?.name, 120);
  if (!name) throw badRequest('Enter the facility name');
  const currency = oneOf(input.currency ?? existing?.currency, FACILITY_CURRENCIES, 'Currency', 'USD');
  const dayCount = Number(input.dayCount ?? existing?.dayCount ?? 360);
  if (dayCount !== 360 && dayCount !== 365) throw badRequest('Day count must be 360 or 365');
  const interestBasis = oneOf(input.interestBasis ?? existing?.interestBasis, BASES, 'Interest basis', 'drawn');
  const interestBilling = oneOf(input.interestBilling ?? existing?.interestBilling, BILLINGS, 'Interest billing', 'at_repayment');
  const commitmentFreq = oneOf(input.commitmentFreq ?? existing?.commitmentFreq, COMMITMENT_FREQS, 'Commitment frequency', 'monthly');
  const termDays = input.termDays === undefined ? existing?.termDays ?? null : input.termDays;
  if (termDays != null && (!Number.isSafeInteger(Number(termDays)) || Number(termDays) <= 0)) {
    throw badRequest('Term days must be a whole number of days');
  }
  return {
    bankId,
    kind: oneOf(input.kind ?? existing?.kind, KINDS, 'Facility kind', 'RC'),
    name,
    currency,
    limitMinor: wholeMinor(input.limitMinor ?? existing?.limitMinor ?? 0, 'Limit', { min: 0 }),
    rate: rateOr(input.rate ?? existing?.rate ?? 0, 'Interest rate'),
    dayCount,
    revolving: boolOr(input.revolving, existing?.revolving ?? true),
    hasMaturity: boolOr(input.hasMaturity, existing?.hasMaturity ?? true),
    interestBasis,
    interestBilling,
    commitmentRate: rateOr(input.commitmentRate ?? existing?.commitmentRate ?? 0, 'Commitment rate'),
    commitmentFreq,
    termDays: termDays == null ? null : Number(termDays),
    note: input.note === undefined ? existing?.note ?? null : str(input.note, 500),
  };
}

function createFacility(companyId, input = {}, userId = null) {
  const f = facilityInput(companyId, input);
  const now = Date.now();
  const id = randomUUID();
  getDb().prepare(`INSERT INTO tf_facilities
    (id, company_id, bank_id, kind, name, currency, limit_minor, rate, day_count,
     revolving, has_maturity, interest_basis, interest_billing, commitment_rate,
     commitment_freq, term_days, active, note, created_at, updated_at, updated_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(
    id, companyId, f.bankId, f.kind, f.name, f.currency, f.limitMinor, f.rate, f.dayCount,
    f.revolving, f.hasMaturity, f.interestBasis, f.interestBilling, f.commitmentRate,
    f.commitmentFreq, f.termDays, f.note, now, now, userId,
  );
  getDb().prepare(`INSERT INTO tf_rate_history (id, company_id, facility_id, rate, effective_date, note, created_at, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), companyId, id, f.rate,
    optionalDate(input.rateEffectiveDate, 'Rate effective date') || todayPhnomPenh(), 'Opening rate', now, userId);
  audit('tf_facility', id, 'create', { after: { companyId, name: f.name, limitMinor: f.limitMinor, rate: f.rate } });
  return getFacility(companyId, id);
}

function updateFacility(companyId, id, patch = {}, userId = null) {
  const row = facilityRow(companyId, id);
  if (!row) throw notFound('Facility');
  const before = rowToFacility(row);
  const f = facilityInput(companyId, patch, before);
  const now = Date.now();
  getDb().prepare(`UPDATE tf_facilities SET
      bank_id = ?, kind = ?, name = ?, currency = ?, limit_minor = ?, rate = ?, day_count = ?,
      revolving = ?, has_maturity = ?, interest_basis = ?, interest_billing = ?,
      commitment_rate = ?, commitment_freq = ?, term_days = ?, note = ?, updated_at = ?, updated_by_user_id = ?
    WHERE id = ? AND company_id = ?`).run(
    f.bankId, f.kind, f.name, f.currency, f.limitMinor, f.rate, f.dayCount,
    f.revolving, f.hasMaturity, f.interestBasis, f.interestBilling,
    f.commitmentRate, f.commitmentFreq, f.termDays, f.note, now, userId, id, companyId,
  );
  if (f.rate !== before.rate) {
    getDb().prepare(`INSERT INTO tf_rate_history (id, company_id, facility_id, rate, effective_date, note, created_at, created_by_user_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), companyId, id, f.rate,
      optionalDate(patch.rateEffectiveDate, 'Rate effective date') || todayPhnomPenh(), str(patch.rateNote, 200), now, userId);
  }
  audit('tf_facility', id, 'update', { before, after: { rate: f.rate, limitMinor: f.limitMinor, name: f.name } });
  return getFacility(companyId, id);
}

function setFacilityActive(companyId, id, active, userId = null) {
  const row = facilityRow(companyId, id);
  if (!row) throw notFound('Facility');
  if (!active) {
    const open = getDb().prepare(`SELECT COUNT(*) AS n FROM tf_drawdowns
      WHERE facility_id = ? AND company_id = ? AND status = 'active'`).get(id, companyId).n;
    if (open) throw badRequest('Close this facility\'s active drawdowns first');
  }
  getDb().prepare('UPDATE tf_facilities SET active = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ? AND company_id = ?')
    .run(active ? 1 : 0, Date.now(), userId, id, companyId);
  audit('tf_facility', id, active ? 'restore' : 'archive', { before: rowToFacility(row) });
  return getFacility(companyId, id);
}

/* ── drawdowns ──────────────────────────────────────────────────────── */

const DRAWDOWN_SELECT = `
  SELECT d.*, f.name AS facility_name, f.kind AS facility_kind, f.currency AS currency,
         f.day_count AS day_count, f.has_maturity AS has_maturity, b.name AS bank_name
  FROM tf_drawdowns d
  JOIN tf_facilities f ON f.id = d.facility_id
  JOIN tf_banks b ON b.id = f.bank_id`;

function repaymentsFor(drawdownId) {
  return getDb().prepare('SELECT * FROM tf_repayments WHERE drawdown_id = ? ORDER BY paid_on, created_at')
    .all(drawdownId).map(rowToRepayment);
}

function lastPostingEnd(companyId, drawdownId) {
  return getDb().prepare(`SELECT MAX(period_end) AS end FROM tf_interest_postings
    WHERE company_id = ? AND drawdown_id = ?`).get(companyId, drawdownId)?.end || null;
}

function enrichDrawdown(row, asOf = todayPhnomPenh()) {
  const d = rowToDrawdown(row);
  const repayments = repaymentsFor(d.id);
  const outstanding = outstandingMinor({ principalMinor: d.principalMinor, repayments });
  const chargedTo = lastPostingEnd(d.companyId, d.id);
  const from = chargedTo && chargedTo > d.valueDate ? chargedTo : d.valueDate;
  const accrued = accruedMinor({
    principalMinor: d.principalMinor, ratePct: d.rate, dayCount: d.dayCount,
    fromISO: from, toISO: asOf, repayments,
  });
  const daysTo = d.maturityDate ? daysUntil(d.maturityDate, asOf) : null;
  const toMaturity = d.maturityDate && daysTo != null && daysTo > 0
    ? interestMinor({
      principalMinor: outstanding, ratePct: d.rate, days: daysTo, dayCount: d.dayCount,
    })
    : 0;
  return {
    ...d,
    repayments,
    repaidMinor: d.principalMinor - outstanding,
    outstandingMinor: outstanding,
    accruedMinor: accrued,
    accruedFrom: from,
    interestToMaturityMinor: toMaturity,
    daysToMaturity: daysTo,
    fullyRepaid: outstanding === 0,
  };
}

function listDrawdowns(companyId, filters = {}) {
  if (!companyId) return { rows: [], total: 0 };
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(filters.pageSize) || 50));
  const where = ['d.company_id = ?'];
  const params = [companyId];
  if (filters.facilityId) { where.push('d.facility_id = ?'); params.push(filters.facilityId); }
  const status = filters.status || 'active';
  if (status !== 'all') { where.push('d.status = ?'); params.push(status); }
  const q = str(filters.q, 80);
  if (q) {
    const term = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(d.reference LIKE ? ESCAPE '\\' COLLATE NOCASE OR d.note LIKE ? ESCAPE '\\' COLLATE NOCASE)");
    params.push(term, term);
  }
  const clause = where.join(' AND ');
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM tf_drawdowns d WHERE ${clause}`).get(...params).n;
  const rows = getDb().prepare(`${DRAWDOWN_SELECT} WHERE ${clause}
    ORDER BY (d.maturity_date IS NULL), d.maturity_date, d.created_at DESC
    LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize).map((r) => enrichDrawdown(r));
  return { rows, total, page, pageSize };
}

function getDrawdown(companyId, id) {
  const row = getDb().prepare(`${DRAWDOWN_SELECT} WHERE d.id = ? AND d.company_id = ?`).get(id, companyId);
  return row ? enrichDrawdown(row) : null;
}

function drawdownInput(companyId, input, existing = null) {
  const facilityId = input.facilityId ?? existing?.facilityId;
  const facility = getDb().prepare(`SELECT * FROM tf_facilities WHERE id = ? AND company_id = ? AND active = 1`)
    .get(facilityId, companyId);
  if (!facility) throw badRequest('Choose an active facility');
  const principalMinor = wholeMinor(input.principalMinor ?? existing?.principalMinor, 'Principal', { min: 1 });
  const valueDate = calendarDate(input.valueDate ?? existing?.valueDate, 'Value date');
  const maturityDate = optionalDate(input.maturityDate === undefined ? existing?.maturityDate : input.maturityDate, 'Maturity date');
  if (facility.has_maturity && !maturityDate) throw badRequest('This facility has a maturity — enter the maturity date');
  if (maturityDate && calendarDaysBetween(valueDate, maturityDate) <= 0) {
    throw badRequest('Maturity must be after the value date');
  }
  const ref = input.reference === undefined ? existing?.reference ?? null : reference(input.reference);
  const settleCurrency = input.settleCurrency === undefined ? existing?.settleCurrency ?? null : metaCurrency(input.settleCurrency);
  const fxRate = input.fxRate === undefined ? existing?.fxRate ?? null : (input.fxRate === '' || input.fxRate == null ? null : Number(input.fxRate));
  if (fxRate != null && (!Number.isFinite(fxRate) || fxRate <= 0)) throw badRequest('The FX rate must be a positive number');
  if (settleCurrency && settleCurrency !== facility.currency && fxRate == null) {
    throw badRequest('Enter the FX rate used for this settlement');
  }
  let purchaseOrderId = input.purchaseOrderId === undefined ? existing?.purchaseOrderId ?? null : (input.purchaseOrderId || null);
  if (purchaseOrderId) {
    const po = getDb().prepare('SELECT id FROM purchase_orders WHERE id = ? AND company_id = ?').get(purchaseOrderId, companyId);
    if (!po) throw badRequest('That purchase order is not in this company');
  }
  return {
    facilityId,
    principalMinor,
    valueDate,
    maturityDate,
    rate: rateOr(input.rate ?? existing?.rate ?? facility.rate, 'Interest rate'),
    reference: ref,
    settleCurrency,
    fxRate,
    purchaseOrderId,
    note: input.note === undefined ? existing?.note ?? null : str(input.note, 500),
  };
}

function createDrawdown(companyId, input = {}, userId = null) {
  const clientUuid = str(input.clientUuid, 80);
  if (clientUuid) {
    const existing = getDb().prepare('SELECT id FROM tf_drawdowns WHERE company_id = ? AND client_uuid = ?')
      .get(companyId, clientUuid);
    if (existing) return getDrawdown(companyId, existing.id);
  }
  const d = drawdownInput(companyId, input);
  const now = Date.now();
  const id = randomUUID();
  try {
    getDb().prepare(`INSERT INTO tf_drawdowns
      (id, company_id, client_uuid, facility_id, principal_minor, value_date, maturity_date,
       rate, reference, settle_currency, fx_rate, purchase_order_id, note, status,
       created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`).run(
      id, companyId, clientUuid, d.facilityId, d.principalMinor, d.valueDate, d.maturityDate,
      d.rate, d.reference, d.settleCurrency, d.fxRate, d.purchaseOrderId, d.note,
      now, now, userId, userId,
    );
  } catch (err) {
    throw friendlyReference(err);
  }
  audit('tf_drawdown', id, 'create', { after: { companyId, facilityId: d.facilityId, principalMinor: d.principalMinor, valueDate: d.valueDate } });
  return getDrawdown(companyId, id);
}

function updateDrawdown(companyId, id, patch = {}, userId = null) {
  const row = getDb().prepare(`${DRAWDOWN_SELECT} WHERE d.id = ? AND d.company_id = ?`).get(id, companyId);
  if (!row) throw notFound('Drawdown');
  const before = rowToDrawdown(row);
  const repayments = getDb().prepare('SELECT COUNT(*) AS n FROM tf_repayments WHERE drawdown_id = ?').get(id).n;
  const MONEY_FIELDS = ['facilityId', 'principalMinor', 'valueDate', 'maturityDate', 'rate', 'reference', 'settleCurrency', 'fxRate', 'purchaseOrderId'];
  const touched = MONEY_FIELDS.filter((k) => patch[k] !== undefined && !sameValue(patch[k], before[k]));
  if (!touched.length) {
    // Note-only edit (a form re-sends unchanged money fields): the facility
    // may have been retired since, so nothing here needs re-validating.
    const note = patch.note === undefined ? before.note : str(patch.note, 500);
    getDb().prepare('UPDATE tf_drawdowns SET note = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ? AND company_id = ?')
      .run(note, Date.now(), userId, id, companyId);
    return getDrawdown(companyId, id);
  }
  if (repayments) throw badRequest('This drawdown has repayments — only the note can change now');
  const d = drawdownInput(companyId, patch, before);
  try {
    getDb().prepare(`UPDATE tf_drawdowns SET
        facility_id = ?, principal_minor = ?, value_date = ?, maturity_date = ?, rate = ?,
        reference = ?, settle_currency = ?, fx_rate = ?, purchase_order_id = ?, note = ?,
        updated_at = ?, updated_by_user_id = ?
      WHERE id = ? AND company_id = ?`).run(
      d.facilityId, d.principalMinor, d.valueDate, d.maturityDate, d.rate,
      d.reference, d.settleCurrency, d.fxRate, d.purchaseOrderId, d.note,
      Date.now(), userId, id, companyId,
    );
  } catch (err) {
    throw friendlyReference(err);
  }
  audit('tf_drawdown', id, 'update', { before, after: { principalMinor: d.principalMinor, rate: d.rate } });
  return getDrawdown(companyId, id);
}

function setDrawdownStatus(companyId, id, status, userId = null) {
  oneOf(status, DRAWDOWN_STATUSES, 'Status');
  const row = getDb().prepare(`${DRAWDOWN_SELECT} WHERE d.id = ? AND d.company_id = ?`).get(id, companyId);
  if (!row) throw notFound('Drawdown');
  if (status === 'cancelled') {
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM tf_repayments WHERE drawdown_id = ?').get(id).n;
    if (n) throw badRequest('This drawdown has repayments — close it instead of cancelling');
  }
  getDb().prepare('UPDATE tf_drawdowns SET status = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ? AND company_id = ?')
    .run(status, Date.now(), userId, id, companyId);
  audit('tf_drawdown', id, status === 'cancelled' ? 'cancel' : 'close', { before: rowToDrawdown(row) });
  return getDrawdown(companyId, id);
}

/* ── repayments + the interest posting they carry ───────────────────── */

function addRepayment(companyId, input = {}, userId = null) {
  const clientUuid = str(input.clientUuid, 80);
  if (clientUuid) {
    const existing = getDb().prepare('SELECT * FROM tf_repayments WHERE company_id = ? AND client_uuid = ?')
      .get(companyId, clientUuid);
    if (existing) return { repayment: rowToRepayment(existing), duplicated: true, drawdown: getDrawdown(companyId, existing.drawdown_id) };
  }
  const row = getDb().prepare(`${DRAWDOWN_SELECT} WHERE d.id = ? AND d.company_id = ?`).get(input.drawdownId, companyId);
  if (!row) throw notFound('Drawdown');
  if (row.status !== 'active') throw badRequest('Only an active drawdown can take a repayment');
  const principalMinor = wholeMinor(input.principalMinor ?? 0, 'Principal', { min: 0 });
  const interestMinor = wholeMinor(input.interestMinor ?? 0, 'Interest', { min: 0 });
  if (principalMinor + interestMinor <= 0) throw badRequest('Enter a principal or interest amount');
  const paidOn = calendarDate(input.paidOn, 'Payment date');
  if (calendarDaysBetween(row.value_date, paidOn) < 0) throw badRequest('A repayment cannot be dated before the drawdown');
  const repayments = repaymentsFor(row.id);
  const outstanding = outstandingMinor({ principalMinor: row.principal_minor, repayments });
  if (principalMinor > outstanding) throw badRequest('The principal repayment is more than the outstanding amount');

  const now = Date.now();
  const id = randomUUID();
  const db = getDb();
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO tf_repayments
      (id, company_id, client_uuid, drawdown_id, principal_minor, interest_minor, paid_on, note, created_at, created_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, companyId, clientUuid, row.id, principalMinor, interestMinor, paidOn, str(input.note, 500), now, userId,
    );
    if (interestMinor > 0) {
      const lastEnd = lastPostingEnd(companyId, row.id);
      const periodStart = lastEnd && lastEnd > row.value_date ? lastEnd : row.value_date;
      if (calendarDaysBetween(periodStart, paidOn) < 0) {
        throw badRequest(`Interest cannot be dated before the last charge (${periodStart})`);
      }
      const days = calendarDaysBetween(periodStart, paidOn);
      try {
        db.prepare(`INSERT INTO tf_interest_postings
          (id, company_id, facility_id, drawdown_id, period_start, period_end, basis_minor, rate, day_count,
           days, amount_minor, source, note, created_at, created_by_user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'charged',?,?,?)`).run(
          randomUUID(), companyId, row.facility_id, row.id, periodStart, paidOn,
          Math.max(0, outstanding), row.rate, row.day_count, Math.max(0, days),
          interestMinor, str(input.note, 200), now, userId,
        );
      } catch (err) {
        // The same period was already charged; the repayment still records the money.
        if (!String(err?.message || '').includes('UNIQUE')) throw err;
      }
    }
    return id;
  });
  insert();
  audit('tf_repayment', id, 'create', { after: { companyId, drawdownId: row.id, principalMinor, interestMinor, paidOn } });
  return { repayment: rowToRepayment(db.prepare('SELECT * FROM tf_repayments WHERE id = ?').get(id)), duplicated: false, drawdown: getDrawdown(companyId, row.id) };
}

/* ── interest record ────────────────────────────────────────────────── */

function listPostings(companyId, filters = {}) {
  if (!companyId) return { rows: [], total: 0 };
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(filters.pageSize) || 50));
  const where = ['p.company_id = ?'];
  const params = [companyId];
  if (filters.facilityId) { where.push('p.facility_id = ?'); params.push(filters.facilityId); }
  if (filters.drawdownId) { where.push('p.drawdown_id = ?'); params.push(filters.drawdownId); }
  const clause = where.join(' AND ');
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM tf_interest_postings p WHERE ${clause}`).get(...params).n;
  const rows = getDb().prepare(`
    SELECT p.*, f.name AS facility_name, f.currency AS currency, d.reference AS drawdown_reference
    FROM tf_interest_postings p
    JOIN tf_facilities f ON f.id = p.facility_id
    LEFT JOIN tf_drawdowns d ON d.id = p.drawdown_id
    WHERE ${clause}
    ORDER BY p.period_end DESC, p.created_at DESC
    LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize).map(rowToPosting);
  return { rows, total, page, pageSize };
}

/** What has accrued since the last posting, for every active drawdown. */
function accrualPreview(companyId, asOf = todayPhnomPenh()) {
  const rows = getDb().prepare(`${DRAWDOWN_SELECT}
    WHERE d.company_id = ? AND d.status = 'active'`).all(companyId).map(rowToDrawdown);
  const out = [];
  for (const d of rows) {
    const repayments = repaymentsFor(d.id);
    const outstanding = outstandingMinor({ principalMinor: d.principalMinor, repayments });
    if (outstanding <= 0) continue;
    const lastEnd = lastPostingEnd(companyId, d.id);
    const from = lastEnd && lastEnd > d.valueDate ? lastEnd : d.valueDate;
    const days = Math.max(0, calendarDaysBetween(from, asOf) || 0);
    out.push({
      drawdownId: d.id, reference: d.reference, facilityId: d.facilityId,
      facilityName: d.facilityName, currency: d.currency,
      valueDate: d.valueDate, maturityDate: d.maturityDate,
      outstandingMinor: outstanding, rate: d.rate, dayCount: d.dayCount,
      from, to: asOf, days,
      accruedMinor: accruedMinor({
        principalMinor: d.principalMinor, ratePct: d.rate, dayCount: d.dayCount,
        fromISO: from, toISO: asOf, repayments,
      }),
    });
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/* ── reports ────────────────────────────────────────────────────────── */

function reportSummary(companyId, asOf = todayPhnomPenh()) {
  const facilities = listFacilities(companyId);
  const perBank = {};
  for (const f of facilities) {
    const key = `${f.bankId}|${f.currency}`;
    const r = (perBank[key] ||= {
      bankId: f.bankId, bank: f.bankName, currency: f.currency,
      facilities: 0, limitMinor: 0, drawnMinor: 0, rateWeighted: 0,
    });
    r.facilities += 1;
    r.limitMinor += f.limitMinor;
    r.drawnMinor += f.drawnMinor;
    r.rateWeighted += f.rate * f.drawnMinor;
  }
  const perBankRows = Object.values(perBank).map((r) => ({
    bankId: r.bankId, bank: r.bank, currency: r.currency, facilities: r.facilities,
    limitMinor: r.limitMinor, drawnMinor: r.drawnMinor,
    undrawnMinor: Math.max(0, r.limitMinor - r.drawnMinor),
    utilisation: utilisation(r.drawnMinor, r.limitMinor),
    avgRate: r.drawnMinor ? r.rateWeighted / r.drawnMinor : 0,
  })).sort((a, b) => (a.bank < b.bank ? -1 : a.bank > b.bank ? 1 : 0));

  const year = String(asOf).slice(0, 4);
  const ytd = getDb().prepare(`
    SELECT f.currency AS currency, COALESCE(SUM(p.amount_minor), 0) AS totalMinor
    FROM tf_interest_postings p JOIN tf_facilities f ON f.id = p.facility_id
    WHERE p.company_id = ? AND substr(p.period_end, 1, 4) = ?
    GROUP BY f.currency ORDER BY f.currency`).all(companyId, year);

  const active = getDb().prepare(`${DRAWDOWN_SELECT}
    WHERE d.company_id = ? AND d.status = 'active'`).all(companyId).map(rowToDrawdown);
  const cashflow = [];
  const ladder = Object.fromEntries(LADDER_BUCKETS.map((b) => [b, {}]));
  for (const d of active) {
    const repayments = repaymentsFor(d.id);
    const outstanding = outstandingMinor({ principalMinor: d.principalMinor, repayments });
    if (outstanding <= 0) continue;
    const daysTo = d.maturityDate ? daysUntil(d.maturityDate, asOf) : null;
    const rate = d.rate;
    const dc = d.dayCount;
    const interest = d.maturityDate && daysTo != null && daysTo > 0
      ? interestMinor({ principalMinor: outstanding, ratePct: rate, days: daysTo, dayCount: dc })
      : 0;
    const total = outstanding + interest;
    if (d.maturityDate) {
      const bucket = ladderBucket(daysTo);
      ladder[bucket][d.currency] = (ladder[bucket][d.currency] || 0) + total;
      cashflow.push({
        drawdownId: d.id, reference: d.reference, facility: d.facilityName,
        bank: d.bankName, currency: d.currency, maturityDate: d.maturityDate,
        daysTo, principalMinor: outstanding, interestMinor: interest, totalMinor: total,
      });
    } else {
      ladder['90+'][d.currency] = (ladder['90+'][d.currency] || 0) + outstanding;
    }
  }
  cashflow.sort((a, b) => (a.maturityDate < b.maturityDate ? -1 : a.maturityDate > b.maturityDate ? 1 : 0));

  return {
    asOf,
    perBank: perBankRows,
    ytd,
    ladder: LADDER_BUCKETS.map((bucket) => ({
      bucket,
      totals: Object.entries(ladder[bucket]).map(([currency, totalMinor]) => ({ currency, totalMinor })),
    })),
    cashflow,
  };
}

module.exports = {
  KINDS, FACILITY_CURRENCIES, DRAWDOWN_STATUSES,
  listBanks, getBank, createBank, updateBank, archiveBank,
  listFacilities, getFacility, createFacility, updateFacility, setFacilityActive,
  listDrawdowns, getDrawdown, createDrawdown, updateDrawdown, setDrawdownStatus,
  addRepayment, listPostings, accrualPreview, reportSummary,
};
