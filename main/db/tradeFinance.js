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
  lastDayOfMonth, addPeriod,
} = require('../util/tradeMath');

const KINDS = ['OD', 'RC', 'TR', 'Other'];
const FACILITY_CURRENCIES = ['USD', 'KHR'];
const BASES = ['drawn', 'balance'];
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
  if (facility.interestBasis === 'balance') {
    const row = getDb().prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS balance
      FROM tf_ledger_entries WHERE facility_id = ? AND company_id = ?`).get(facility.id, facility.companyId);
    return Math.max(0, row?.balance || 0); // a credit balance uses none of the line
  }
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
  const balanceMinor = facility.interestBasis === 'balance'
    ? (getDb().prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS balance
        FROM tf_ledger_entries WHERE facility_id = ? AND company_id = ?`)
      .get(facility.id, facility.companyId)?.balance || 0)
    : null;
  const movements = getDb().prepare('SELECT COUNT(*) AS n FROM tf_ledger_entries WHERE facility_id = ? AND company_id = ?')
    .get(facility.id, facility.companyId)?.n || 0;
  return {
    ...facility,
    drawnMinor: drawn,
    undrawnMinor: undrawn,
    utilisation: utilisation(drawn, facility.limitMinor),
    commitmentPerPeriodMinor: commitment,
    activeDrawdowns: active?.n || 0,
    movements,
    nextMaturity: active?.next_maturity || null,
    balanceBased: facility.interestBasis === 'balance',
    balanceMinor,
    dailyInterestMinor: facility.interestBasis === 'balance'
      ? interestMinor({ principalMinor: Math.max(0, balanceMinor || 0), ratePct: facility.rate, days: 1, dayCount: facility.dayCount })
      : 0,
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
  // Phase B: a running-balance facility (overdraft) has no drawdowns, no
  // maturity and month-end capitalised interest; a drawn facility bills at
  // repayment. The two shapes are not mixed.
  const interestBilling = interestBasis === 'balance'
    ? 'month_end_capitalised'
    : 'at_repayment';
  if (existing && existing.interestBasis !== interestBasis) {
    const used = getDb().prepare(`SELECT
        (SELECT COUNT(*) FROM tf_drawdowns WHERE facility_id = ?) AS drawdowns,
        (SELECT COUNT(*) FROM tf_ledger_entries WHERE facility_id = ?) AS movements`).get(existing.id, existing.id);
    if (used.drawdowns || used.movements) {
      throw badRequest('This facility already has drawdowns or movements — its interest basis cannot change');
    }
  }
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
    hasMaturity: interestBasis === 'balance' ? 0 : boolOr(input.hasMaturity, existing?.hasMaturity ?? true),
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
  if (facility.interest_basis === 'balance') {
    throw badRequest('This facility runs a balance — record a movement instead of a drawdown');
  }
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
  const fees = feeTotals(companyId, year);
  const feeByBank = Object.fromEntries(fees.byBank.map((r) => [`${r.bankId}|${r.currency}`, r.totalMinor]));
  for (const row of perBankRows) row.feesMinor = feeByBank[`${row.bankId}|${row.currency}`] || 0;

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
    ytdFees: fees.ytd,
    ladder: LADDER_BUCKETS.map((bucket) => ({
      bucket,
      totals: Object.entries(ladder[bucket]).map(([currency, totalMinor]) => ({ currency, totalMinor })),
    })),
    cashflow,
  };
}

/* ── Phase B: overdraft movements ───────────────────────────────────── */

const MOVEMENT_KINDS = ['opening', 'draw', 'repay', 'adjustment'];

function facilityFor(companyId, id, { balanceOnly = false } = {}) {
  const row = facilityRow(companyId, id);
  if (!row) throw notFound('Facility');
  const facility = rowToFacility(row);
  if (balanceOnly && facility.interestBasis !== 'balance') {
    throw badRequest('Movements belong to a running-balance (overdraft) facility');
  }
  return facility;
}

function rowToMovement(r) {
  return {
    id: r.id, companyId: r.company_id, facilityId: r.facility_id, entryDate: r.entry_date,
    kind: r.kind, amountMinor: r.amount_minor, note: r.note ?? null, createdAt: r.created_at,
  };
}

function listMovements(companyId, facilityId) {
  facilityFor(companyId, facilityId, { balanceOnly: true });
  const rows = getDb().prepare(`SELECT * FROM tf_ledger_entries
    WHERE facility_id = ? AND company_id = ? ORDER BY entry_date, created_at`).all(facilityId, companyId).map(rowToMovement);
  let balance = 0;
  return rows.map((m) => { balance += m.amountMinor; return { ...m, balanceMinor: balance }; });
}

function addMovement(companyId, input = {}, userId = null) {
  const facility = facilityFor(companyId, input.facilityId, { balanceOnly: true });
  const clientUuid = str(input.clientUuid, 80);
  if (clientUuid) {
    const existing = getDb().prepare('SELECT 1 FROM tf_ledger_entries WHERE company_id = ? AND client_uuid = ?')
      .get(companyId, clientUuid);
    if (existing) return listMovements(companyId, facility.id);
  }
  const kind = oneOf(input.kind, MOVEMENT_KINDS, 'Movement kind');
  const entryDate = calendarDate(input.entryDate, 'Date');
  const raw = Number(input.amountMinor);
  if (!Number.isSafeInteger(raw) || raw === 0) throw badRequest('Enter a whole amount that is not zero');
  let signed = raw;
  if (kind === 'opening' || kind === 'draw') {
    if (raw < 0) throw badRequest(`A ${kind === 'opening' ? 'opening' : 'draw'} amount is positive`);
    signed = Math.abs(raw);
  } else if (kind === 'repay') {
    signed = -Math.abs(raw);
  }
  const id = randomUUID();
  getDb().prepare(`INSERT INTO tf_ledger_entries
    (id, company_id, client_uuid, facility_id, entry_date, kind, amount_minor, note, created_at, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, companyId, clientUuid, facility.id, entryDate, kind, signed, str(input.note, 500), Date.now(), userId);
  audit('tf_movement', id, 'create', { after: { companyId, facilityId: facility.id, kind, amountMinor: signed, entryDate } });
  return listMovements(companyId, facility.id);
}

/* ── Phase B: month-end capitalisation ──────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0');
const monthStart = (y, m) => `${y}-${pad2(m)}-01`;
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`;

/**
 * Entries as they count for accrual. Capitalised interest starts earning the
 * day after it is posted, so a month's own capitalisation never inflates the
 * month it belongs to — ours for January then equals what we charged.
 */
function ledgerEntries(facilityId) {
  return getDb().prepare(`SELECT
      CASE WHEN kind = 'interest_capitalised' THEN date(entry_date, '+1 day') ELSE entry_date END AS entry_date,
      amount_minor
    FROM tf_ledger_entries WHERE facility_id = ? ORDER BY entry_date, created_at`).all(facilityId);
}

/**
 * Interest for one completed month, integrated on the daily balance and
 * rounded once. `extra` lets a dry run feed in earlier un-written
 * capitalisations so a multi-month preview compounds exactly like the run.
 */
function monthInterest(facility, y, m, extra = []) {
  const start = monthStart(y, m);
  const end = monthEnd(y, m);
  const dim = lastDayOfMonth(y, m);
  const entries = ledgerEntries(facility.id).concat(extra)
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0));
  let idx = 0;
  let balance = 0;
  while (idx < entries.length && entries[idx].entry_date < start) balance += entries[idx++].amount_minor;
  let sum = 0;
  for (let d = 1; d <= dim; d++) {
    const day = `${y}-${pad2(m)}-${pad2(d)}`;
    while (idx < entries.length && entries[idx].entry_date <= day) balance += entries[idx++].amount_minor;
    if (balance > 0) sum += balance;
  }
  return {
    periodStart: start,
    periodEnd: end,
    days: dim,
    basisMinor: Math.round(sum / dim),
    amountMinor: interestMinor({ principalMinor: sum, ratePct: facility.rate, days: 1, dayCount: facility.dayCount }),
  };
}

function capitalisationFacilities(companyId) {
  return getDb().prepare(`SELECT * FROM tf_facilities
    WHERE company_id = ? AND active = 1 AND interest_basis = 'balance'
      AND interest_billing = 'month_end_capitalised'`).all(companyId).map(rowToFacility);
}

function capitalisationDue(companyId, asOf = todayPhnomPenh()) {
  const [ay, am] = String(asOf).split('-').map(Number);
  const rows = [];
  for (const facility of capitalisationFacilities(companyId)) {
    const first = getDb().prepare('SELECT MIN(entry_date) AS first FROM tf_ledger_entries WHERE facility_id = ?')
      .get(facility.id)?.first;
    if (!first) continue;
    let [y, m] = first.split('-').map(Number);
    const simulated = [];
    while (y < ay || (y === ay && m < am)) {
      const periodStart = monthStart(y, m);
      const periodEnd = monthEnd(y, m);
      const posted = getDb().prepare(`SELECT 1 FROM tf_interest_postings
        WHERE facility_id = ? AND period_start = ? AND period_end = ? AND source = 'charged' AND drawdown_id IS NULL`)
        .get(facility.id, periodStart, periodEnd);
      if (!posted) {
        const figure = monthInterest(facility, y, m, simulated);
        rows.push({
          facilityId: facility.id, facilityName: facility.name, currency: facility.currency,
          period: periodStart.slice(0, 7), periodStart, periodEnd, days: figure.days,
          basisMinor: figure.basisMinor, amountMinor: figure.amountMinor, rate: facility.rate,
          dayCount: facility.dayCount,
        });
        if (figure.amountMinor > 0) simulated.push({ entry_date: periodEnd, amount_minor: figure.amountMinor });
      }
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  return rows;
}

/**
 * Post every completed month that is not yet charged. Each month is computed
 * AFTER the previous month's capitalisation is written, so a multi-month
 * catch-up compounds exactly like a monthly run. The posting's unique index
 * makes a re-run harmless.
 */
function runCapitalisation(companyId, asOf = todayPhnomPenh()) {
  const [ay, am] = String(asOf).split('-').map(Number);
  const db = getDb();
  const posted = [];
  for (const facility of capitalisationFacilities(companyId)) {
    const first = db.prepare('SELECT MIN(entry_date) AS first FROM tf_ledger_entries WHERE facility_id = ?')
      .get(facility.id)?.first;
    if (!first) continue;
    let [y, m] = first.split('-').map(Number);
    while (y < ay || (y === ay && m < am)) {
      const periodStart = monthStart(y, m);
      const periodEnd = monthEnd(y, m);
      const exists = db.prepare(`SELECT 1 FROM tf_interest_postings
        WHERE facility_id = ? AND period_start = ? AND period_end = ? AND source = 'charged' AND drawdown_id IS NULL`)
        .get(facility.id, periodStart, periodEnd);
      if (!exists) {
        const figure = monthInterest(facility, y, m);
        try {
          db.transaction(() => {
            if (figure.amountMinor > 0) {
              db.prepare(`INSERT INTO tf_ledger_entries
                (id, company_id, client_uuid, facility_id, entry_date, kind, amount_minor, note, created_at, created_by_user_id)
                VALUES (?,?,?,?,?,'interest_capitalised',?,?,?,NULL)`).run(
                randomUUID(), companyId, null, facility.id, periodEnd, figure.amountMinor,
                `Interest capitalised for ${periodStart.slice(0, 7)}`, Date.now(),
              );
            }
            db.prepare(`INSERT INTO tf_interest_postings
              (id, company_id, facility_id, drawdown_id, period_start, period_end, basis_minor, rate, day_count,
               days, amount_minor, source, note, created_at, created_by_user_id)
              VALUES (?,?,?,NULL,?,?,?,?,?,?,?,'charged',?,?,NULL)`).run(
              randomUUID(), companyId, facility.id, periodStart, periodEnd,
              figure.basisMinor, facility.rate, facility.dayCount, figure.days, figure.amountMinor,
              'Month-end capitalisation', Date.now(),
            );
          })();
        } catch (err) {
          // Another run posted this month while we computed it. Its own row is
          // the truth; leave the balance alone instead of charging twice.
          if (!/UNIQUE/.test(String(err?.message || ''))) throw err;
          m += 1;
          if (m > 12) { m = 1; y += 1; }
          continue;
        }
        posted.push({
          facilityId: facility.id, facilityName: facility.name, currency: facility.currency,
          period: periodStart.slice(0, 7), periodStart, periodEnd, days: figure.days,
          basisMinor: figure.basisMinor, amountMinor: figure.amountMinor,
        });
      }
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  return posted;
}

/* ── Phase B: bank-actual reconciliation ────────────────────────────── */

function eachDay(startISO, endISO, fn) {
  let t = Date.parse(`${startISO}T00:00:00Z`);
  const end = Date.parse(`${endISO}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(end) || t > end) return 0;
  let days = 0;
  for (; t <= end; t += 86_400_000) { fn(new Date(t).toISOString().slice(0, 10)); days += 1; }
  return days;
}

function integrateLedger(facility, startISO, endISO) {
  const entries = ledgerEntries(facility.id);
  let idx = 0;
  let balance = 0;
  let sum = 0;
  while (idx < entries.length && entries[idx].entry_date < startISO) balance += entries[idx++].amount_minor;
  const days = eachDay(startISO, endISO, (day) => {
    while (idx < entries.length && entries[idx].entry_date <= day) balance += entries[idx++].amount_minor;
    if (balance > 0) sum += balance;
  });
  return {
    amountMinor: interestMinor({ principalMinor: sum, ratePct: facility.rate, days: 1, dayCount: facility.dayCount }),
    days, basisMinor: days ? Math.round(sum / days) : 0,
  };
}

function integrateDrawdown(drawdown, facility, startISO, endISO) {
  const repayments = repaymentsFor(drawdown.id);
  let idx = 0;
  let repaid = 0;
  let sum = 0;
  const days = eachDay(startISO, endISO, (day) => {
    while (idx < repayments.length && repayments[idx].paidOn <= day) repaid += repayments[idx++].principalMinor;
    const outstanding = drawdown.principalMinor - repaid;
    if (day >= drawdown.valueDate && outstanding > 0) sum += outstanding;
  });
  return {
    amountMinor: interestMinor({ principalMinor: sum, ratePct: drawdown.rate, days: 1, dayCount: facility.dayCount }),
    days, basisMinor: days ? Math.round(sum / days) : 0,
  };
}

function computeOurs(companyId, { facilityId, drawdownId, periodStart, periodEnd }) {
  const facility = facilityFor(companyId, facilityId);
  if (facility.interestBasis === 'balance') return { ...integrateLedger(facility, periodStart, periodEnd), method: 'balance' };
  if (drawdownId) {
    const row = getDb().prepare(`${DRAWDOWN_SELECT} WHERE d.id = ? AND d.company_id = ?`).get(drawdownId, companyId);
    if (!row) throw notFound('Drawdown');
    return { ...integrateDrawdown(rowToDrawdown(row), facility, periodStart, periodEnd), method: 'drawdown' };
  }
  let amountMinor = 0;
  let basisMinor = 0;
  let days = 0;
  for (const row of getDb().prepare(`${DRAWDOWN_SELECT} WHERE d.facility_id = ? AND d.company_id = ?`).all(facilityId, companyId)) {
    const r = integrateDrawdown(rowToDrawdown(row), facility, periodStart, periodEnd);
    amountMinor += r.amountMinor;
    basisMinor += r.basisMinor;
    days = r.days;
  }
  return { amountMinor, days, basisMinor, method: 'facility' };
}

function varianceStatus(actual, ours) {
  if (!actual && !ours) return 'match';
  const denom = Math.abs(ours) || Math.abs(actual) || 1;
  const variance = Math.abs(actual - ours) / denom;
  return variance <= 0.01 ? 'match' : variance <= 0.05 ? 'minor' : 'review';
}

function listReconciliations(companyId) {
  const rows = getDb().prepare(`
    SELECT p.*, f.name AS facility_name, f.currency AS currency, d.reference AS drawdown_reference
    FROM tf_interest_postings p
    JOIN tf_facilities f ON f.id = p.facility_id
    LEFT JOIN tf_drawdowns d ON d.id = p.drawdown_id
    WHERE p.company_id = ? AND p.source = 'bank_actual'
    ORDER BY p.period_end DESC, p.created_at DESC`).all(companyId);
  return rows.map((r) => {
    const ours = computeOurs(companyId, {
      facilityId: r.facility_id, drawdownId: r.drawdown_id, periodStart: r.period_start, periodEnd: r.period_end,
    });
    return {
      id: r.id, facilityId: r.facility_id, facilityName: r.facility_name, currency: r.currency,
      drawdownId: r.drawdown_id ?? null, drawdownReference: r.drawdown_reference ?? null,
      periodStart: r.period_start, periodEnd: r.period_end, days: r.days,
      bankMinor: r.amount_minor, oursMinor: ours.amountMinor,
      varianceMinor: r.amount_minor - ours.amountMinor,
      status: varianceStatus(r.amount_minor, ours.amountMinor), note: r.note ?? null,
    };
  });
}

function addReconciliation(companyId, input = {}, userId = null) {
  const facility = facilityFor(companyId, input.facilityId);
  const drawdownId = input.drawdownId || null;
  if (facility.interestBasis === 'balance' && drawdownId) throw badRequest('A running-balance facility has no drawdown');
  if (drawdownId) {
    const row = getDb().prepare('SELECT 1 FROM tf_drawdowns WHERE id = ? AND company_id = ?').get(drawdownId, companyId);
    if (!row) throw notFound('Drawdown');
  }
  const periodStart = calendarDate(input.periodStart, 'Period start');
  const periodEnd = calendarDate(input.periodEnd, 'Period end');
  if (calendarDaysBetween(periodStart, periodEnd) < 0) throw badRequest('The period must end on or after it starts');
  const amountMinor = wholeMinor(input.amountMinor, 'The bank\'s interest', { min: 0 });
  const ours = computeOurs(companyId, { facilityId: facility.id, drawdownId, periodStart, periodEnd });
  const id = randomUUID();
  try {
    getDb().prepare(`INSERT INTO tf_interest_postings
      (id, company_id, facility_id, drawdown_id, period_start, period_end, basis_minor, rate, day_count,
       days, amount_minor, source, note, created_at, created_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'bank_actual',?,?,?)`).run(
      id, companyId, facility.id, drawdownId, periodStart, periodEnd, ours.basisMinor,
      facility.rate, facility.dayCount, ours.days, amountMinor, str(input.note, 500), Date.now(), userId,
    );
  } catch (err) {
    if (/UNIQUE/.test(String(err?.message || ''))) throw badRequest('That period is already recorded for this facility');
    throw err;
  }
  audit('tf_reconciliation', id, 'create', { after: { companyId, facilityId: facility.id, periodStart, periodEnd, amountMinor } });
  return listReconciliations(companyId);
}

/* ── Phase B: fees and recurring fees ───────────────────────────────── */

function rowToFee(r) {
  return {
    id: r.id, companyId: r.company_id, facilityId: r.facility_id, facilityName: r.facility_name ?? null,
    drawdownId: r.drawdown_id, kind: r.kind, amountMinor: r.amount_minor, currency: r.currency,
    feeDate: r.fee_date, note: r.note ?? null, createdAt: r.created_at,
  };
}

function listFees(companyId, { limit = 500 } = {}) {
  return getDb().prepare(`
    SELECT fee.*, f.name AS facility_name
    FROM tf_fees fee LEFT JOIN tf_facilities f ON f.id = fee.facility_id
    WHERE fee.company_id = ? ORDER BY fee.fee_date DESC, fee.created_at DESC LIMIT ?`)
    .all(companyId, Math.min(2000, Math.max(1, Number(limit) || 500))).map(rowToFee);
}

function addFee(companyId, input = {}, userId = null) {
  const clientUuid = str(input.clientUuid, 80);
  if (clientUuid) {
    const existing = getDb().prepare('SELECT * FROM tf_fees WHERE company_id = ? AND client_uuid = ?').get(companyId, clientUuid);
    if (existing) return rowToFee(existing);
  }
  const facilityIdInput = input.facilityId || null;
  let facility = facilityIdInput ? facilityFor(companyId, facilityIdInput) : null;
  let drawdownId = input.drawdownId || null;
  if (drawdownId) {
    const row = getDb().prepare(`${DRAWDOWN_SELECT} WHERE d.id = ? AND d.company_id = ?`).get(drawdownId, companyId);
    if (!row) throw notFound('Drawdown');
    if (facility && row.facility_id !== facility.id) throw badRequest('That drawdown is not on this facility');
    if (!facility) facility = facilityFor(companyId, row.facility_id);
  }
  const kind = str(input.kind, 80);
  if (!kind) throw badRequest('Name the fee');
  const amountMinor = wholeMinor(input.amountMinor, 'Fee amount', { min: 0 });
  const currency = metaCurrency(input.currency) || facility?.currency || 'USD';
  const feeDate = calendarDate(input.feeDate, 'Fee date');
  const id = randomUUID();
  getDb().prepare(`INSERT INTO tf_fees
    (id, company_id, client_uuid, facility_id, drawdown_id, kind, amount_minor, currency, fee_date, note, created_at, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, companyId, clientUuid, facility?.id || null, drawdownId, kind, amountMinor, currency, feeDate,
    str(input.note, 500), Date.now(), userId,
  );
  audit('tf_fee', id, 'create', { after: { companyId, kind, amountMinor, currency, feeDate } });
  return rowToFee(getDb().prepare('SELECT * FROM tf_fees WHERE id = ?').get(id));
}

function rowToRecurring(r) {
  return {
    id: r.id, companyId: r.company_id, facilityId: r.facility_id, facilityName: r.facility_name ?? null,
    kind: r.kind, amountMinor: r.amount_minor, currency: r.currency, frequency: r.frequency,
    nextDate: r.next_date, enabled: !!r.enabled, note: r.note ?? null,
  };
}

function listRecurring(companyId) {
  return getDb().prepare(`
    SELECT rf.*, f.name AS facility_name
    FROM tf_recurring_fees rf LEFT JOIN tf_facilities f ON f.id = rf.facility_id
    WHERE rf.company_id = ? ORDER BY rf.next_date`).all(companyId).map(rowToRecurring);
}

function addRecurring(companyId, input = {}, userId = null) {
  const facilityId = input.facilityId || null;
  const facility = facilityId ? facilityFor(companyId, facilityId) : null;
  const kind = str(input.kind, 80);
  if (!kind) throw badRequest('Name the fee');
  const amountMinor = wholeMinor(input.amountMinor, 'Fee amount', { min: 0 });
  const currency = metaCurrency(input.currency) || facility?.currency || 'USD';
  const frequency = oneOf(input.frequency, COMMITMENT_FREQS, 'Frequency', 'monthly');
  const nextDate = calendarDate(input.nextDate, 'Next date');
  const now = Date.now();
  const id = randomUUID();
  getDb().prepare(`INSERT INTO tf_recurring_fees
    (id, company_id, facility_id, kind, amount_minor, currency, frequency, next_date, enabled, note, created_at, updated_at, updated_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, companyId, facilityId, kind, amountMinor, currency, frequency, nextDate,
    input.enabled === false ? 0 : 1, str(input.note, 500), now, now, userId,
  );
  return listRecurring(companyId);
}

function updateRecurring(companyId, id, patch = {}, userId = null) {
  const row = getDb().prepare('SELECT * FROM tf_recurring_fees WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!row) throw notFound('Recurring fee');
  const data = {
    kind: patch.kind === undefined ? row.kind : str(patch.kind, 80),
    amount_minor: patch.amountMinor === undefined ? row.amount_minor : wholeMinor(patch.amountMinor, 'Fee amount', { min: 0 }),
    currency: patch.currency === undefined ? row.currency : (metaCurrency(patch.currency) || row.currency),
    frequency: patch.frequency === undefined ? row.frequency : oneOf(patch.frequency, COMMITMENT_FREQS, 'Frequency'),
    next_date: patch.nextDate === undefined ? row.next_date : calendarDate(patch.nextDate, 'Next date'),
    enabled: patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0),
    note: patch.note === undefined ? row.note : str(patch.note, 500),
  };
  getDb().prepare(`UPDATE tf_recurring_fees SET kind = ?, amount_minor = ?, currency = ?, frequency = ?,
      next_date = ?, enabled = ?, note = ?, updated_at = ?, updated_by_user_id = ?
    WHERE id = ? AND company_id = ?`).run(
    data.kind, data.amount_minor, data.currency, data.frequency, data.next_date, data.enabled,
    data.note, Date.now(), userId, id, companyId,
  );
  return listRecurring(companyId);
}

/** Post every fee that is due, catching up missed periods. */
function postDueRecurring(companyId, asOf = todayPhnomPenh(), { dryRun = false } = {}) {
  const due = getDb().prepare(`SELECT * FROM tf_recurring_fees
    WHERE company_id = ? AND enabled = 1 AND next_date <= ? ORDER BY next_date`).all(companyId, asOf);
  const posted = [];
  for (const rf of due) {
    let next = rf.next_date;
    let guard = 0;
    while (next <= asOf && guard++ < 120) {
      const clientUuid = `rec-${rf.id}-${next}`;
      posted.push({ recurringId: rf.id, kind: rf.kind, amountMinor: rf.amount_minor, currency: rf.currency, feeDate: next });
      if (!dryRun) {
        try {
          getDb().prepare(`INSERT INTO tf_fees
            (id, company_id, client_uuid, facility_id, drawdown_id, kind, amount_minor, currency, fee_date, note, created_at, created_by_user_id)
            VALUES (?,?,?,?,NULL,?,?,?,?,?,?,NULL)`).run(
            randomUUID(), companyId, clientUuid, rf.facility_id, rf.kind, rf.amount_minor, rf.currency, next,
            `Auto · ${rf.note || rf.kind}`, Date.now(),
          );
        } catch (err) {
          if (!/UNIQUE/.test(String(err?.message || ''))) throw err; // already posted for that period
        }
      }
      next = addPeriod(next, rf.frequency);
    }
    if (!dryRun) getDb().prepare('UPDATE tf_recurring_fees SET next_date = ?, updated_at = ? WHERE id = ? AND company_id = ?')
      .run(next, Date.now(), rf.id, companyId);
  }
  return posted;
}

/* ── reporting helper included in reportSummary below ───────────────── */

function feeTotals(companyId, year) {
  const ytd = getDb().prepare(`SELECT currency, COALESCE(SUM(amount_minor), 0) AS totalMinor
    FROM tf_fees WHERE company_id = ? AND substr(fee_date, 1, 4) = ? GROUP BY currency ORDER BY currency`)
    .all(companyId, String(year));
  const byBank = getDb().prepare(`
    SELECT f.bank_id AS bankId, f.currency AS currency, COALESCE(SUM(fee.amount_minor), 0) AS totalMinor
    FROM tf_fees fee JOIN tf_facilities f ON f.id = fee.facility_id
    WHERE fee.company_id = ? GROUP BY f.bank_id, f.currency`).all(companyId);
  return { ytd, byBank };
}

module.exports = {
  KINDS, FACILITY_CURRENCIES, DRAWDOWN_STATUSES, MOVEMENT_KINDS,
  listBanks, getBank, createBank, updateBank, archiveBank,
  listFacilities, getFacility, createFacility, updateFacility, setFacilityActive,
  listDrawdowns, getDrawdown, createDrawdown, updateDrawdown, setDrawdownStatus,
  addRepayment, listPostings, accrualPreview, reportSummary,
  listMovements, addMovement,
  capitalisationDue, runCapitalisation,
  computeOurs, listReconciliations, addReconciliation,
  listFees, addFee, listRecurring, addRecurring, updateRecurring, postDueRecurring,
};
