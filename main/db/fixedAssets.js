/**
 * Fixed Assets A1: the register (docs/ASSETS_AND_BRANCHES_PLAN.md §3.4, §3.5, §4, §5.4, §11).
 *
 * One row per thing the business owns. A row is born a DRAFT (from the Add
 * form, an import, the Fuel link or — in A3 — a tagging walk) and becomes
 * ACTIVE when a manager activates it, which posts its acquisition or opening
 * entry. Drafts are never depreciated or posted; a draft is cancelled, never
 * deleted, and its tag code is never reused.
 *
 * Accounting treatment (decided at activation, §11 + §13a):
 *   not_depreciated  the category's book method is "none" (land): posted, never depreciated
 *   capitalised      cost ≥ the threshold ($300), or "Depreciate this item" ticked
 *   tracked_only     below the threshold, or the tick cleared: tag, branch, custodian
 *                    and counts as normal, NEVER posted, never depreciated
 * `depreciate_override` is the tick: NULL = follow the threshold, 1 = depreciate
 * even under it, 0 = expense even over it.
 *
 * What activation posts (§5.4; USD cents, riel on every line):
 *   purchase / gift / self-built   Dr Cost / Cr Asset purchases clearing (2190), dated the purchase date
 *   opening, cost + date known     Dr Cost / Cr Acc. dep. (used up to the start) / Cr Opening equity (the NBV),
 *                                  dated the day before the register start
 *   opening, deemed value          Dr Cost (value at start) / Cr Opening equity
 *
 * The event log is the truth (§3.5): branch, custodian and status of an
 * ACTIVE asset change only through events (transfer, custodian, status), and
 * the row's snapshot columns follow them in the same transaction. Events with
 * no money effect can be voided (reason required); events that posted can
 * only be reversed (a mirror entry in the current open month).
 *
 * Every write is audited.
 */

const { getDb } = require('./index');
const { nextUpdatedAt, prepareOptimisticPatch, parseJson } = require('./_util');
const { uuid, str, int, badRequest, getCallerUserId, audit, todayPhnomPenh, dateOrNull, minorOrNull, notFound } = require('./_assetUtil');
const config = require('./assetConfig');
const ledger = require('./ledger');
const fxRates = require('./fxRates');
const branches = require('./branches');
const book = require('../util/bookDepreciation');
const tax = require('../util/taxDepreciation');
const { formatTagCode, parseTagCode } = require('../util/assetTagCode');

const STATUSES = ['in_use', 'in_storage', 'in_repair', 'disposed', 'lost'];
const SETTABLE_STATUSES = ['in_use', 'in_storage', 'in_repair'];
const RECORD_STATES = ['draft', 'active', 'cancelled'];
const ACQUISITION_KINDS = ['purchase', 'opening', 'gift', 'self_built'];
const COST_BASES = ['actual', 'deemed'];
const CURRENCIES = ['USD', 'KHR'];
const ORIGINS = ['manual', 'import', 'fuel', 'tagging_walk'];
const EVENT_KINDS = ['acquire', 'open', 'activate', 'transfer', 'custodian', 'status', 'repair', 'capex', 'life_change',
  'salvage_change', 'revalue', 'impair', 'dispose', 'partial_dispose', 'lost', 'found', 'note', 'reversal'];
/** Events with no money effect: voidable by a manager with a reason (§3.5). */
const VOIDABLE_KINDS = ['transfer', 'custodian', 'status', 'repair', 'note', 'life_change', 'salvage_change'];
/** Events that posted a journal: reversible only. */
const REVERSIBLE_KINDS = ['acquire', 'open', 'capex', 'dispose', 'partial_dispose', 'impair', 'revalue'];

/* ─── reading ─────────────────────────────────────────────────── */

function rowToAsset(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, tagCode: r.tag_code, tagSeq: r.tag_seq ?? null,
    name: r.name, nameKm: r.name_km ?? null,
    categoryId: r.category_id, categoryName: r.category_name ?? null, categoryKey: r.category_key ?? null,
    isVehicle: !!r.category_is_vehicle,
    quantity: r.quantity, serialNo: r.serial_no ?? null, makeModel: r.make_model ?? null,
    plateNo: r.plate_no ?? null, registrationNo: r.registration_no ?? null,
    insuranceUntil: r.insurance_until ?? null, roadTaxUntil: r.road_tax_until ?? null,
    branchId: r.branch_id ?? null, branchCode: r.branch_code ?? null, branchName: r.branch_name ?? null,
    locationNote: r.location_note ?? null,
    custodianEmployeeId: r.custodian_employee_id ?? null,
    custodianName: r.custodian_name_en || r.custodian_name_km || null, custodianCode: r.custodian_code ?? null,
    status: r.status, recordState: r.record_state, accountingTreatment: r.accounting_treatment ?? null,
    depreciateOverride: r.depreciate_override == null ? null : !!r.depreciate_override,
    needsCost: !!r.needs_cost, origin: r.origin,
    acquisitionKind: r.acquisition_kind, purchaseDate: r.purchase_date ?? null, inServiceDate: r.in_service_date ?? null,
    supplierId: r.supplier_id ?? null, supplierName: r.supplier_name ?? null, purchaseOrderId: r.purchase_order_id ?? null,
    invoiceNo: r.invoice_no ?? null,
    costMinor: r.cost_minor ?? null, costCurrency: r.cost_currency, costFxKhrPerUsd: r.cost_fx_khr_per_usd ?? null,
    costUsdMinor: r.cost_usd_minor ?? null, vatMinor: r.vat_minor ?? null,
    warrantyUntil: r.warranty_until ?? null, warrantyNote: r.warranty_note ?? null,
    costBasis: r.cost_basis ?? null, openingAsOf: r.opening_as_of ?? null, openingAccumMinor: r.opening_accum_minor ?? 0,
    usefulLifeMonths: r.useful_life_months ?? null, scheduleLifeMonths: r.schedule_life_months ?? null,
    salvageMinor: r.salvage_minor ?? null, depreciationStartPeriod: r.depreciation_start_period ?? null,
    accumMinor: r.accum_minor ?? 0, nbvMinor: r.nbv_minor ?? null, lastPostedPeriod: r.last_posted_period ?? null,
    taxClass: r.tax_class ?? null, taxClassReason: r.tax_class_reason ?? null,
    taxCostKhrMinor: r.tax_cost_khr_minor ?? null, taxFxKhrPerUsd: r.tax_fx_khr_per_usd ?? null, taxFxSource: r.tax_fx_source ?? null,
    taxOpeningWdvKhrMinor: r.tax_opening_wdv_khr_minor ?? null,
    fuelAssetId: r.fuel_asset_id ?? null, tagPrintedAt: r.tag_printed_at ?? null,
    mainPhotoId: r.main_photo_id ?? null, photoCount: r.photo_count ?? 0,
    activatedAt: r.activated_at ?? null, activatedByUserId: r.activated_by_user_id ?? null,
    acquisitionEntryId: r.acquisition_entry_id ?? null,
    cancelledAt: r.cancelled_at ?? null, cancelReason: r.cancel_reason ?? null,
    disposedOn: r.disposed_on ?? null, disposalEventId: r.disposal_event_id ?? null,
    notes: r.notes ?? null, createdAt: r.created_at, updatedAt: r.updated_at, updatedByUserId: r.updated_by_user_id ?? null,
  };
}

const SELECT = `
  SELECT a.*, c.name_en AS category_name, c.builtin_key AS category_key, c.is_vehicle AS category_is_vehicle,
         b.code AS branch_code, b.name_en AS branch_name,
         e.name_en AS custodian_name_en, e.name_km AS custodian_name_km, e.staff_code AS custodian_code,
         s.name AS supplier_name,
         (SELECT f.id FROM asset_files f WHERE f.asset_id = a.id AND f.kind = 'photo' AND f.retired_at IS NULL ORDER BY f.position, f.uploaded_at LIMIT 1) AS main_photo_id,
         (SELECT COUNT(*) FROM asset_files f WHERE f.asset_id = a.id AND f.kind = 'photo' AND f.retired_at IS NULL) AS photo_count
    FROM fixed_assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN branches b ON b.id = a.branch_id
    LEFT JOIN employees e ON e.id = a.custodian_employee_id
    LEFT JOIN suppliers s ON s.id = a.supplier_id`;

function get(id) {
  if (!id) return null;
  return rowToAsset(getDb().prepare(`${SELECT} WHERE a.id = ?`).get(id));
}

function getByTag(companyId, code) {
  const r = getDb().prepare(`${SELECT} WHERE a.company_id = ? AND a.tag_code = ?`).get(companyId, code);
  return rowToAsset(r);
}

const ATTENTION = {
  drafts: "a.record_state = 'draft'",
  needs_cost: 'a.needs_cost = 1',
  no_photo: "NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.asset_id = a.id AND f.kind = 'photo' AND f.retired_at IS NULL)",
  tags_not_printed: 'a.tag_printed_at IS NULL',
  warranty_ending: "a.warranty_until IS NOT NULL AND a.warranty_until <= @soon AND a.warranty_until >= @today",
  insurance_due: "a.insurance_until IS NOT NULL AND a.insurance_until <= @soon",
  road_tax_due: "a.road_tax_until IS NOT NULL AND a.road_tax_until <= @soon",
};

/**
 * The register list. Filters: q (tag, name, serial, plate, make/model),
 * branchId ('none' = no branch), categoryId, status, recordState (default:
 * everything but cancelled), custodianEmployeeId, attention (one of
 * ATTENTION's keys), fuelLinked, limit/offset. Also returns the counts the
 * banners need ("16 vehicles and machines came from Fuel…"), and the
 * register screen's totals row for the WHOLE filtered set (not just the page):
 * book cost, accumulated depreciation, impairment and NBV from the posted
 * ledger (so they equal the reports and the GL), plus each item's
 * `bookCostMinor` (its posted cost; null while nothing is posted).
 */
function list(companyId, filters = {}) {
  if (!companyId) return { items: [], total: 0, counts: {}, totals: emptyListTotals() };
  const f = filters || {};
  const where = ['a.company_id = @companyId'];
  const today = todayPhnomPenh();
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86400000).toISOString().slice(0, 10);
  const params = { companyId, today, soon };
  if (f.q && String(f.q).trim()) {
    where.push('(a.tag_code LIKE @q OR a.name LIKE @q OR a.name_km LIKE @q OR a.serial_no LIKE @q OR a.plate_no LIKE @q OR a.make_model LIKE @q)');
    params.q = `%${String(f.q).trim()}%`;
  }
  if (f.branchId === 'none') where.push('a.branch_id IS NULL');
  else if (f.branchId) { where.push('a.branch_id = @branchId'); params.branchId = f.branchId; }
  if (f.categoryId) { where.push('a.category_id = @categoryId'); params.categoryId = f.categoryId; }
  if (f.status && STATUSES.includes(f.status)) { where.push('a.status = @status'); params.status = f.status; }
  if (f.recordState && RECORD_STATES.includes(f.recordState)) { where.push('a.record_state = @recordState'); params.recordState = f.recordState; }
  else if (f.recordState !== 'all') where.push("a.record_state <> 'cancelled'");
  if (f.custodianEmployeeId) { where.push('a.custodian_employee_id = @custodian'); params.custodian = f.custodianEmployeeId; }
  if (f.attention && ATTENTION[f.attention]) where.push(ATTENTION[f.attention]);
  if (f.fuelLinked === true) where.push('a.fuel_asset_id IS NOT NULL');
  if (f.fuelLinked === false) where.push('a.fuel_asset_id IS NULL');
  const limit = Math.min(Math.max(1, Number(f.limit) || 50), 500);
  const offset = Math.max(0, Number(f.offset) || 0);
  const db = getDb();
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM fixed_assets a WHERE ${whereSql}`).get(params).n;
  const items = db.prepare(`${SELECT} WHERE ${whereSql} ORDER BY a.tag_seq IS NULL, a.tag_seq, a.tag_code LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }).map(rowToAsset);
  // Posted figures: the page's own book cost, then the whole filtered set's totals.
  const LEDGER_SUMS = `
    SUM(CASE WHEN l.line_role = 'cost' THEN l.debit_minor - l.credit_minor ELSE 0 END) AS cost,
    SUM(CASE WHEN l.line_role IN ('accum_dep', 'accum_disposal', 'accum_reval') THEN l.credit_minor - l.debit_minor ELSE 0 END) AS accum,
    SUM(CASE WHEN l.line_role = 'impairment' THEN l.credit_minor - l.debit_minor ELSE 0 END) AS impairment`;
  const LEDGER_ROLES = "l.line_role IN ('cost', 'accum_dep', 'accum_disposal', 'accum_reval', 'impairment')";
  if (items.length) {
    const ph = items.map((_, i) => `@id${i}`).join(', ');
    const byId = new Map(db.prepare(`SELECT l.asset_id AS id, ${LEDGER_SUMS} FROM journal_lines l WHERE ${LEDGER_ROLES} AND l.asset_id IN (${ph}) GROUP BY l.asset_id`)
      .all(Object.fromEntries(items.map((it, i) => [`id${i}`, it.id]))).map((r) => [r.id, r]));
    for (const it of items) it.bookCostMinor = byId.has(it.id) ? byId.get(it.id).cost : null;
  }
  const led = db.prepare(`SELECT ${LEDGER_SUMS} FROM journal_lines l JOIN fixed_assets a ON a.id = l.asset_id WHERE ${LEDGER_ROLES} AND ${whereSql}`).get(params);
  const held = db.prepare(`
    SELECT SUM(a.record_state = 'active' AND a.status NOT IN ('disposed', 'lost') AND a.accounting_treatment IN ('capitalised', 'not_depreciated')) AS books,
           SUM(a.record_state = 'active' AND a.status NOT IN ('disposed', 'lost') AND a.accounting_treatment = 'tracked_only') AS tracked,
           SUM(CASE WHEN a.record_state = 'active' AND a.status NOT IN ('disposed', 'lost') AND a.accounting_treatment = 'tracked_only' THEN COALESCE(a.cost_usd_minor, 0) ELSE 0 END) AS tracked_cost,
           SUM(a.record_state = 'draft') AS drafts
      FROM fixed_assets a WHERE ${whereSql}
  `).get(params);
  const totals = {
    assets: total, onBooks: held.books || 0, trackedOnly: held.tracked || 0, trackedCostMinor: held.tracked_cost || 0, drafts: held.drafts || 0,
    costMinor: led.cost || 0, accumMinor: led.accum || 0, impairmentMinor: led.impairment || 0,
    nbvMinor: (led.cost || 0) - (led.accum || 0) - (led.impairment || 0),
  };
  const c = db.prepare(`
    SELECT SUM(record_state = 'draft') AS drafts, SUM(record_state = 'active') AS active, SUM(record_state = 'cancelled') AS cancelled,
           SUM(needs_cost = 1 AND record_state = 'draft') AS needs_cost, SUM(origin = 'fuel' AND needs_cost = 1 AND record_state = 'draft') AS from_fuel_needs_cost
      FROM fixed_assets WHERE company_id = ?
  `).get(companyId);
  return {
    items, total, limit, offset,
    counts: { drafts: c.drafts || 0, active: c.active || 0, cancelled: c.cancelled || 0, needsCost: c.needs_cost || 0, fromFuelNeedsCost: c.from_fuel_needs_cost || 0 },
    totals,
  };
}

function emptyListTotals() {
  return { assets: 0, onBooks: 0, trackedOnly: 0, trackedCostMinor: 0, drafts: 0, costMinor: 0, accumMinor: 0, impairmentMinor: 0, nbvMinor: 0 };
}

/* ─── validation helpers ──────────────────────────────────────── */

function checkEmployee(companyId, employeeId, { allowLeft = false } = {}) {
  if (!employeeId) return null;
  const e = getDb().prepare('SELECT company_id, status FROM employees WHERE id = ?').get(employeeId);
  if (!e || e.company_id !== companyId) throw badRequest('That staff member is not in this company');
  if (!allowLeft && e.status === 'left') throw badRequest('That staff member has left — pick someone who still works here');
  return employeeId;
}

function checkSupplier(companyId, supplierId) {
  if (!supplierId) return null;
  const s = getDb().prepare('SELECT company_id FROM suppliers WHERE id = ?').get(supplierId);
  if (!s || s.company_id !== companyId) throw badRequest('That supplier is not in this company');
  return supplierId;
}

function checkCategory(companyId, categoryId, { allowArchived = false } = {}) {
  const c = config.getCategory(categoryId);
  if (!c || c.companyId !== companyId) throw badRequest('Pick a category');
  if (c.archived && !allowArchived) throw badRequest(`Category ${c.nameEn} is archived`);
  return c;
}

/** A date that has already happened (purchase and in-service dates, L2). */
function pastDateOrNull(v, label) {
  const d = dateOrNull(v, label);
  if (d && d > todayPhnomPenh()) throw badRequest(`${label} cannot be in the future`);
  return d;
}

function oneOf(v, list, label, fallback) {
  if (v == null || v === '') return fallback;
  if (!list.includes(v)) throw badRequest(`${label} must be one of: ${list.join(', ')}`);
  return v;
}

function lifeOrNull(v) {
  if (v == null || v === '') return null;
  const n = int(v);
  if (n == null || n < 1 || n > 1200) throw badRequest('Useful life must be 1–1200 months');
  return n;
}

function quantity(v) {
  if (v == null || v === '') return 1;
  const n = int(v);
  if (n == null || n < 1 || n > 100000) throw badRequest('Quantity is a whole number from 1');
  return n;
}

function override(v) {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  return null;
}

function taxClassOrNull(v) {
  if (v == null || v === '') return null;
  if (!tax.TAX_CLASS_KEYS.includes(String(v))) throw badRequest(`Tax class must be one of ${tax.TAX_CLASS_KEYS.join(', ')}`);
  return String(v);
}

/* ─── tag codes ───────────────────────────────────────────────── */

function tagUsed(companyId, code, exceptAssetId = null) {
  const db = getDb();
  const asset = db.prepare('SELECT id FROM fixed_assets WHERE company_id = ? AND tag_code = ?').get(companyId, code);
  if (asset && asset.id !== exceptAssetId) return 'asset';
  if (db.prepare('SELECT 1 FROM asset_tag_aliases WHERE company_id = ? AND tag_code = ?').get(companyId, code)) return 'retired';
  return null;
}

function nextTagSeq(companyId) {
  const r = getDb().prepare(`
    SELECT MAX(m) AS m FROM (
      SELECT MAX(tag_seq) AS m FROM fixed_assets WHERE company_id = @c
      UNION ALL SELECT MAX(last_seq) FROM asset_tag_batches WHERE company_id = @c
      UNION ALL SELECT MAX(tag_seq) FROM asset_tag_aliases WHERE company_id = @c)
  `).get({ c: companyId });
  return (r?.m || 0) + 1;
}

/** A fresh code: the category's own prefix, else the company's. Never a code used or retired before. */
function allocateTag(companyId, category = null) {
  const settings = config.getSettings(companyId);
  const prefix = category?.tagPrefix || settings.tagPrefix;
  let seq = nextTagSeq(companyId);
  for (let i = 0; i < 1000; i += 1, seq += 1) {
    const code = formatTagCode(prefix, seq);
    if (!tagUsed(companyId, code)) return { code, seq };
  }
  throw badRequest('Could not allocate a free tag code');
}

/** A code the user typed (an import, a pre-printed tag): valid Damm, and free. */
function claimTag(companyId, raw, exceptAssetId = null) {
  const p = parseTagCode(raw, { defaultPrefix: config.getSettings(companyId).tagPrefix });
  if (!p.ok) {
    throw badRequest(p.reason === 'check'
      ? `${raw} is not a valid tag code — its check digit does not match (a digit may be mistyped)`
      : `${raw} is not a tag code like ${formatTagCode(config.getSettings(companyId).tagPrefix, 1)}`);
  }
  const used = tagUsed(companyId, p.code, exceptAssetId);
  if (used === 'asset') throw badRequest(`Tag ${p.code} is already on another asset`);
  if (used === 'retired') throw badRequest(`Tag ${p.code} was retired from an asset and cannot be used again`);
  return { code: p.code, seq: p.seq };
}

/* ─── create / update / cancel ───────────────────────────────── */

/**
 * Create a DRAFT. Category defaults (life, tax class) are copied now; salvage
 * from the category's % is worked out at activation when no amount was given.
 * `input.origin` / `input.fuelAssetId` / `input.needsCost` are internal (the
 * Fuel link and import set them; the IPC handler strips them).
 */
function create(input = {}, { allowArchivedCategory = false } = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  config.ensureCategories(companyId);
  // The Fuel link creates drafts for Fuel's vehicles whatever the category's state — it must never break Fuel.
  const category = checkCategory(companyId, input.categoryId, { allowArchived: allowArchivedCategory });
  const name = str(input.name, 160);
  if (!name) throw badRequest('Give the asset a name');
  const tag = input.tagCode ? claimTag(companyId, input.tagCode) : allocateTag(companyId, category);
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const costCurrency = oneOf(input.costCurrency, CURRENCIES, 'Currency', 'USD');
  db.prepare(`
    INSERT INTO fixed_assets (id, company_id, tag_code, tag_seq, name, name_km, category_id, quantity, serial_no, make_model,
      plate_no, registration_no, insurance_until, road_tax_until, branch_id, location_note, custodian_employee_id, status,
      record_state, depreciate_override, needs_cost, origin, acquisition_kind, purchase_date, in_service_date, supplier_id,
      purchase_order_id, invoice_no, cost_minor, cost_currency, cost_fx_khr_per_usd, vat_minor, warranty_until, warranty_note,
      cost_basis, useful_life_months, salvage_minor, tax_class, tax_class_reason, fuel_asset_id, notes,
      created_at, updated_at, updated_by_user_id)
    VALUES (@id, @companyId, @tagCode, @tagSeq, @name, @nameKm, @categoryId, @quantity, @serialNo, @makeModel,
      @plateNo, @registrationNo, @insuranceUntil, @roadTaxUntil, @branchId, @locationNote, @custodian, @status,
      'draft', @override, @needsCost, @origin, @kind, @purchaseDate, @inServiceDate, @supplierId,
      @poId, @invoiceNo, @costMinor, @costCurrency, @costFx, @vatMinor, @warrantyUntil, @warrantyNote,
      @costBasis, @life, @salvage, @taxClass, @taxClassReason, @fuelAssetId, @notes,
      @now, @now, @by)
  `).run({
    id, companyId, tagCode: tag.code, tagSeq: tag.seq, name, nameKm: str(input.nameKm, 160), categoryId: category.id,
    quantity: quantity(input.quantity), serialNo: str(input.serialNo, 120), makeModel: str(input.makeModel, 160),
    plateNo: str(input.plateNo, 40), registrationNo: str(input.registrationNo, 80),
    insuranceUntil: dateOrNull(input.insuranceUntil, 'Insurance until'), roadTaxUntil: dateOrNull(input.roadTaxUntil, 'Road tax until'),
    branchId: branches.assertAssignable(companyId, input.branchId), locationNote: str(input.locationNote, 200),
    custodian: checkEmployee(companyId, input.custodianEmployeeId),
    status: oneOf(input.status, SETTABLE_STATUSES, 'Status', 'in_use'),
    override: override(input.depreciateOverride), needsCost: input.needsCost ? 1 : 0,
    origin: oneOf(input.origin, ORIGINS, 'Origin', 'manual'),
    kind: oneOf(input.acquisitionKind, ACQUISITION_KINDS, 'Acquisition', 'purchase'),
    purchaseDate: pastDateOrNull(input.purchaseDate, 'Purchase date'), inServiceDate: pastDateOrNull(input.inServiceDate, 'In-service date'),
    supplierId: checkSupplier(companyId, input.supplierId), poId: str(input.purchaseOrderId, 60), invoiceNo: str(input.invoiceNo, 80),
    costMinor: minorOrNull(input.costMinor, 'Cost'), costCurrency,
    costFx: input.costFxKhrPerUsd == null || input.costFxKhrPerUsd === '' ? null : positiveRate(input.costFxKhrPerUsd),
    vatMinor: minorOrNull(input.vatMinor, 'VAT'),
    warrantyUntil: dateOrNull(input.warrantyUntil, 'Warranty until'), warrantyNote: str(input.warrantyNote, 500),
    costBasis: oneOf(input.costBasis, COST_BASES, 'Cost basis', input.acquisitionKind === 'opening' ? 'actual' : null),
    life: lifeOrNull(input.usefulLifeMonths) ?? category.defaultLifeMonths ?? null,
    salvage: minorOrNull(input.salvageMinor, 'Salvage'),
    taxClass: taxClassOrNull(input.taxClass), taxClassReason: str(input.taxClassReason, 500),
    fuelAssetId: input.fuelAssetId || null, notes: str(input.notes, 4000),
    now, by: getCallerUserId(),
  });
  const created = get(id);
  audit('fixed_asset', id, 'create', { after: created });
  return created;
}

function positiveRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 100 || n > 100000) throw badRequest('Riel per dollar must be between 100 and 100000');
  return n;
}

/** Fields anyone with assets.manage may edit on a draft or an active asset. */
const ALWAYS = {
  name: ['name', (v) => { const s = str(v, 160); if (!s) throw badRequest('The name cannot be empty'); return s; }],
  nameKm: ['name_km', (v) => str(v, 160)],
  serialNo: ['serial_no', (v) => str(v, 120)],
  makeModel: ['make_model', (v) => str(v, 160)],
  plateNo: ['plate_no', (v) => str(v, 40)],
  registrationNo: ['registration_no', (v) => str(v, 80)],
  insuranceUntil: ['insurance_until', (v) => dateOrNull(v, 'Insurance until')],
  roadTaxUntil: ['road_tax_until', (v) => dateOrNull(v, 'Road tax until')],
  locationNote: ['location_note', (v) => str(v, 200)],
  warrantyUntil: ['warranty_until', (v) => dateOrNull(v, 'Warranty until')],
  warrantyNote: ['warranty_note', (v) => str(v, 500)],
  invoiceNo: ['invoice_no', (v) => str(v, 80)],
  notes: ['notes', (v) => str(v, 4000)],
};

/** Money / basis fields: a draft's to edit freely; on an active asset they change through events. */
function draftOnly(a) {
  const c = a.companyId;
  return {
    categoryId: ['category_id', (v) => checkCategory(c, v).id],
    quantity: ['quantity', (v) => quantity(v)],
    acquisitionKind: ['acquisition_kind', (v) => oneOf(v, ACQUISITION_KINDS, 'Acquisition', 'purchase')],
    purchaseDate: ['purchase_date', (v) => pastDateOrNull(v, 'Purchase date')],
    inServiceDate: ['in_service_date', (v) => pastDateOrNull(v, 'In-service date')],
    supplierId: ['supplier_id', (v) => checkSupplier(c, v)],
    purchaseOrderId: ['purchase_order_id', (v) => str(v, 60)],
    costMinor: ['cost_minor', (v) => minorOrNull(v, 'Cost')],
    costCurrency: ['cost_currency', (v) => oneOf(v, CURRENCIES, 'Currency', 'USD')],
    costFxKhrPerUsd: ['cost_fx_khr_per_usd', (v) => (v == null || v === '' ? null : positiveRate(v))],
    vatMinor: ['vat_minor', (v) => minorOrNull(v, 'VAT')],
    costBasis: ['cost_basis', (v) => oneOf(v, COST_BASES, 'Cost basis', null)],
    usefulLifeMonths: ['useful_life_months', (v) => lifeOrNull(v)],
    salvageMinor: ['salvage_minor', (v) => minorOrNull(v, 'Salvage')],
    depreciateOverride: ['depreciate_override', (v) => override(v)],
    taxClass: ['tax_class', (v) => taxClassOrNull(v)],
    taxClassReason: ['tax_class_reason', (v) => str(v, 500)],
    // Where and who: direct on a draft (nothing to keep history of yet); events once active.
    branchId: ['branch_id', (v) => branches.assertAssignable(c, v)],
    custodianEmployeeId: ['custodian_employee_id', (v) => checkEmployee(c, v)],
    status: ['status', (v) => oneOf(v, SETTABLE_STATUSES, 'Status', 'in_use')],
  };
}

const EVENT_FIELDS = { branchId: 'Transfer', custodianEmployeeId: 'Change custodian', status: 'Set status' };

/**
 * Edit an asset. Drafts: everything. Active: identity and paperwork fields
 * only — money goes through events (capex, life or salvage change), and
 * branch / custodian / status through their events. One exception: the
 * in-service date of an active asset that has none yet ("bought, not in use
 * yet", §11) can be set once.
 *
 * `{ retag: true, retagReason }` replaces a damaged tag: a new code is
 * allocated and the old one is kept (and refused for reuse).
 */
function update(id, rawPatch = {}) {
  const existing = get(id);
  if (!existing) throw notFound('Asset');
  if (existing.recordState === 'cancelled') throw badRequest('This draft was cancelled — it cannot be edited');
  const patch = prepareOptimisticPatch(existing, rawPatch, 'fixed_asset');
  const isDraft = existing.recordState === 'draft';
  const map = { ...ALWAYS };
  const drafts = draftOnly(existing);
  for (const [k, def] of Object.entries(drafts)) {
    if (!(k in patch)) continue;
    if (isDraft) { map[k] = def; continue; }
    // A whole-form save repeats unchanged values: only a real change is refused.
    const current = k === 'depreciateOverride' ? existing.depreciateOverride : existing[k];
    if ((patch[k] ?? null) === (current ?? null) || (patch[k] === '' && current == null)) continue;
    // §11 "bought, not in use yet": a purchase activated without an in-service
    // date may be given one, once. Never an opening (its basis is fixed at the start).
    if (k === 'inServiceDate' && !existing.inServiceDate && !existing.depreciationStartPeriod
      && ['purchase', 'gift', 'self_built'].includes(existing.acquisitionKind)) {
      map[k] = def;
      continue;
    }
    if (EVENT_FIELDS[k]) throw badRequest(`This asset is active — use "${EVENT_FIELDS[k]}" so the change is kept in its history`);
    throw badRequest('This asset is active — its cost, dates, life and salvage change through events (improvement, life or salvage change)');
  }
  const sets = [];
  const params = { id };
  const changed = {};
  for (const [k, [col, conv]] of Object.entries(map)) {
    if (!(k in patch)) continue;
    const v = conv(patch[k]);
    sets.push(`${col} = @${k}`);
    params[k] = v;
    changed[k] = k === 'depreciateOverride' ? (v == null ? null : !!v) : v;
  }
  let retag = null;
  if (patch.retag) {
    const why = str(patch.retagReason, 500);
    if (!why) throw badRequest('Say why the tag is replaced (for example: damaged)');
    retag = { why, ...allocateTag(existing.companyId, config.getCategory(existing.categoryId)) };
    sets.push('tag_code = @newTag', 'tag_seq = @newSeq', 'tag_printed_at = NULL');
    params.newTag = retag.code;
    params.newSeq = retag.seq;
    changed.tagCode = retag.code;
  }
  if (!sets.length) return existing;
  // Activating an in-service date on an active asset: its schedule starts now.
  if (!isDraft && 'inServiceDate' in changed && changed.inServiceDate) {
    const settings = config.getSettings(existing.companyId);
    if (existing.purchaseDate && changed.inServiceDate < existing.purchaseDate) throw badRequest('The in-service date cannot be before the purchase date');
    if (changed.inServiceDate < settings.registerStartDate) throw badRequest(`The in-service date cannot be before the register start (${settings.registerStartDate})`);
    if (existing.accountingTreatment === 'capitalised') {
      sets.push('depreciation_start_period = @startPeriod');
      params.startPeriod = book.firstPeriod(changed.inServiceDate, settings.convention);
    }
  }
  params.updatedAt = nextUpdatedAt(existing.updatedAt);
  params.by = getCallerUserId();
  const db = getDb();
  db.transaction(() => {
    if (retag) {
      db.prepare(`INSERT INTO asset_tag_aliases (id, company_id, tag_code, tag_seq, asset_id, reason, retired_by_user_id, retired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid(), existing.companyId, existing.tagCode, existing.tagSeq, id, retag.why, getCallerUserId(), Date.now());
      insertEvent({ companyId: existing.companyId, assetId: id, kind: 'note', eventDate: todayPhnomPenh(), reason: `Tag replaced: ${existing.tagCode} → ${retag.code} (${retag.why})` });
    }
    db.prepare(`UPDATE fixed_assets SET ${sets.join(', ')}, updated_at = @updatedAt, updated_by_user_id = @by WHERE id = @id`).run(params);
    require('./assetIdentity').syncToFuel(id);
  })();
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('fixed_asset', id, retag ? 'retag' : 'update', diff);
  return get(id);
}

function cancelDraft(id, reason) {
  const existing = get(id);
  if (!existing) throw notFound('Asset');
  if (existing.recordState !== 'draft') throw badRequest('Only a draft can be cancelled — an active asset is disposed of or written off');
  const why = str(reason, 500);
  if (!why) throw badRequest('Say why the draft is cancelled');
  const db = getDb();
  db.transaction(() => {
    // A cancelled draft lets go of its Fuel vehicle, so that vehicle can be linked again.
    db.prepare(`UPDATE fixed_assets SET record_state = 'cancelled', cancelled_at = ?, cancel_reason = ?, fuel_asset_id = NULL,
      updated_at = ?, updated_by_user_id = ? WHERE id = ?`).run(Date.now(), why, nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
    insertEvent({ companyId: existing.companyId, assetId: id, kind: 'note', eventDate: todayPhnomPenh(), reason: `Draft cancelled: ${why}`,
      detail: { fuelAssetId: existing.fuelAssetId } });
  })();
  audit('fixed_asset', id, 'cancel', { before: { recordState: 'draft', fuelAssetId: existing.fuelAssetId }, after: { recordState: 'cancelled', cancelReason: why } });
  return get(id);
}

/* ─── activation: the acquisition / opening entry ─────────────── */

/** USD cents of an asset's cost, and the rate used when it was in riel. */
function costInUsd(a, rateDate, seed = true) {
  if (a.costCurrency === 'KHR') {
    const rate = a.costFxKhrPerUsd || fxRates.houseRateFor(a.companyId, rateDate, { seed }).khrPerUsd;
    return { usd: Math.round((a.costMinor * 100) / rate), rate };
  }
  return { usd: a.costMinor, rate: a.costFxKhrPerUsd || null };
}

function treatmentFor(a, category, costUsd, settings) {
  if (category.bookMethod === 'none') return 'not_depreciated';
  if (a.depreciateOverride === true) return 'capitalised';
  if (a.depreciateOverride === false) return 'tracked_only';
  return costUsd >= settings.capitalizationThresholdMinor ? 'capitalised' : 'tracked_only';
}

/**
 * Work out everything activation will write, without writing it. Used by
 * activate() and returned by `assets:previewActivation` so the screen can show
 * the entry before Confirm. Throws a plain sentence for anything missing.
 */
function planActivation(id, { dryRun = false } = {}) {
  const a = get(id);
  if (!a) throw notFound('Asset');
  if (a.recordState !== 'draft') throw badRequest(a.recordState === 'active' ? 'This asset is already active' : 'This draft was cancelled');
  const settings = config.getSettings(a.companyId);
  const category = config.getCategory(a.categoryId);
  if (!category) throw badRequest('The asset has no category');
  if (a.costMinor == null) {
    throw badRequest(a.acquisitionKind === 'opening' && a.costBasis === 'deemed'
      ? 'Add the value at the register start date first'
      : 'Add the cost first (or, for something already owned, its value at the start date)');
  }
  const regStart = settings.registerStartDate;
  const openingDate = book.dayBefore(regStart);
  const opening = a.acquisitionKind === 'opening';
  const deemed = opening && a.costBasis === 'deemed';
  let entryDate;
  let inService = a.inServiceDate;
  if (opening) {
    entryDate = openingDate;
    if (!deemed) {
      inService = a.inServiceDate || a.purchaseDate;
      if (!inService) throw badRequest('Add the purchase (or in-service) date — or enter its value at the start date instead');
      if (inService >= regStart) throw badRequest(`It came into use on or after the register start (${regStart}) — record it as a new purchase`);
    }
  } else {
    if (!a.purchaseDate) throw badRequest('Add the purchase date first');
    if (a.purchaseDate > todayPhnomPenh()) throw badRequest('The purchase date cannot be in the future');
    if (a.inServiceDate && a.inServiceDate > todayPhnomPenh()) throw badRequest('The in-service date cannot be in the future');
    if (a.purchaseDate < regStart) throw badRequest(`Bought before the register start (${regStart}) — enter it as "Already owned", at its opening value`);
    if (a.inServiceDate && a.inServiceDate < a.purchaseDate) throw badRequest('The in-service date cannot be before the purchase date');
    entryDate = a.purchaseDate;
  }
  const costDate = opening ? (deemed ? openingDate : (a.purchaseDate || inService)) : a.purchaseDate;
  const { usd: costUsd, rate: costRate } = costInUsd(a, costDate, !dryRun);
  const treatment = treatmentFor(a, category, costUsd, settings);
  const depreciates = treatment === 'capitalised';
  const life = a.usefulLifeMonths;
  if (depreciates && !life) throw badRequest(deemed ? 'Add the months of life left' : 'Add the useful life in months');
  const salvage = a.salvageMinor != null ? a.salvageMinor : Math.round((costUsd * (category.defaultSalvagePct || 0)) / 100);
  if (depreciates && salvage > costUsd) throw badRequest('Salvage cannot be more than the cost');

  let openingAccum = 0;
  let scheduleLife = depreciates ? life : null;
  let startPeriod = null;
  if (depreciates) {
    if (opening && !deemed) {
      const pos = book.openingPosition({ costMinor: costUsd, salvageMinor: salvage, lifeMonths: life, inServiceDate: inService, registerStartDate: regStart, convention: settings.convention });
      openingAccum = pos.accumMinor;
      scheduleLife = pos.remainingMonths;
      startPeriod = pos.depreciationStartPeriod;
    } else if (deemed) {
      startPeriod = book.periodOf(regStart);
    } else if (inService) {
      startPeriod = book.firstPeriod(inService, settings.convention);
    }
  }

  // Tax: the riel cost at the official rate on the purchase date (house when missing, labelled).
  let taxInfo = { taxClass: a.taxClass || category.taxClass, costKhr: null, fx: null, fxSource: null, openingWdvKhr: null };
  if (treatment !== 'tracked_only') {
    const tRate = fxRates.taxRateFor(a.companyId, costDate, { seed: !dryRun });
    const costKhr = a.costCurrency === 'KHR' ? a.costMinor : tax.usdCentsToKhr(costUsd, tRate.khrPerUsd);
    taxInfo = { ...taxInfo, costKhr, fx: a.costCurrency === 'KHR' ? null : tRate.khrPerUsd, fxSource: a.costCurrency === 'KHR' ? 'paid in riel' : `${tRate.source} ${tRate.rateDate}${tRate.fallback ? ` (${tRate.fallback})` : ''}` };
    const cls = tax.taxClass(taxInfo.taxClass);
    if (opening && cls.method === 'straight_line' && !cls.pooled) {
      const acquiredYear = Number((deemed ? regStart : costDate).slice(0, 4));
      const firstYear = Number(regStart.slice(0, 4));
      const rows = acquiredYear < firstYear
        ? tax.straightLineYears({ classKey: cls.key, costKhr, lifeMonths: life, acquiredYear, toYear: firstYear - 1 })
        : [];
      taxInfo.openingWdvKhr = rows.length ? rows[rows.length - 1].wdvKhr : costKhr;
    }
  }

  // The entry (§5.4). Nothing is posted for tracked-only items.
  let entry = null;
  if (treatment !== 'tracked_only' && costUsd > 0) {
    const accounts = { cost: category.glCostAccountId, accum: category.glAccumAccountId };
    if (!accounts.cost) throw badRequest(`Category ${category.nameEn} has no cost account — map one in Settings → Assets`);
    const dims = { assetId: a.id, branchId: a.branchId };
    const lines = [{ accountId: accounts.cost, debitMinor: costUsd, lineRole: 'cost', txnCurrency: a.costCurrency, txnAmountMinor: a.costMinor, ...dims }];
    if (opening) {
      if (openingAccum > 0) {
        if (!accounts.accum) throw badRequest(`Category ${category.nameEn} has no accumulated depreciation account`);
        lines.push({ accountId: accounts.accum, creditMinor: openingAccum, lineRole: 'accum_dep', ...dims });
      }
      lines.push({ accountKey: 'equity.opening', creditMinor: costUsd - openingAccum, lineRole: 'equity', ...dims });
    } else {
      lines.push({ accountKey: 'fa.clearing.purchase', creditMinor: costUsd, lineRole: 'clearing', ...dims });
    }
    // A cost paid in riel keeps its real riel figure on the cost line (the clearing line takes any rounding).
    if (a.costCurrency === 'KHR' && !opening) lines[0].khrMinor = a.costMinor;
    // A fully used-up old asset with no salvage has no opening equity: zero lines are left out.
    for (let i = lines.length - 1; i >= 0; i -= 1) if (!(lines[i].debitMinor || lines[i].creditMinor)) lines.splice(i, 1);
    entry = {
      companyId: a.companyId, entryDate,
      sourceKind: opening ? 'asset_open' : 'asset_acquire', sourceId: a.id,
      memo: `${opening ? 'Opening value' : 'Purchase'}: ${a.tagCode} ${a.name}${deemed ? ' (value at start date)' : ''}`,
      fxKhrPerUsd: a.costCurrency === 'KHR' && !opening ? costRate : undefined,
      fxSource: a.costCurrency === 'KHR' && !opening ? 'purchase rate' : undefined,
      lines,
    };
  }
  return {
    asset: a, category, settings, treatment, opening, deemed, entryDate,
    costUsdMinor: costUsd, costFxKhrPerUsd: costRate, salvageMinor: depreciates ? salvage : (a.salvageMinor ?? null),
    openingAccumMinor: openingAccum, scheduleLifeMonths: scheduleLife, depreciationStartPeriod: startPeriod,
    nbvMinor: costUsd - openingAccum, tax: taxInfo, entry,
  };
}

/** A public preview of planActivation (no ids of internals beyond the entry lines). */
function previewActivation(id) {
  const p = planActivation(id, { dryRun: true });
  return {
    id: p.asset.id, treatment: p.treatment, acquisitionKind: p.asset.acquisitionKind, deemed: p.deemed,
    entryDate: p.entryDate, costUsdMinor: p.costUsdMinor, salvageMinor: p.salvageMinor,
    openingAccumMinor: p.openingAccumMinor, nbvMinor: p.nbvMinor, scheduleLifeMonths: p.scheduleLifeMonths,
    depreciationStartPeriod: p.depreciationStartPeriod, taxClass: p.tax.taxClass, taxCostKhrMinor: p.tax.costKhr,
    taxFxSource: p.tax.fxSource, posts: !!p.entry,
    lines: p.entry ? p.entry.lines.map((l) => ({ account: l.accountKey || l.accountId, debitMinor: l.debitMinor || 0, creditMinor: l.creditMinor || 0, lineRole: l.lineRole })) : [],
  };
}

function activationCount(assetId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM asset_events WHERE asset_id = ? AND kind IN ('acquire', 'open')").get(assetId).n;
}

/** Activate a draft: post its entry, freeze its basis, record the acquire / open event. */
function activate(id) {
  const db = getDb();
  let posted = null;
  db.transaction(() => {
    const p = planActivation(id);
    const a = p.asset;
    const eventId = uuid();
    if (p.entry) {
      posted = ledger.post({ ...p.entry, idempotencyKey: `asset:${a.id}:activate:${activationCount(a.id) + 1}` });
    }
    db.prepare(`
      UPDATE fixed_assets SET record_state = 'active', accounting_treatment = @treatment, needs_cost = 0,
        cost_usd_minor = @costUsd, cost_fx_khr_per_usd = COALESCE(@costFx, cost_fx_khr_per_usd), salvage_minor = @salvage,
        salvage_defaulted = @salvageDefaulted, cost_fx_defaulted = @costFxDefaulted,
        cost_basis = @costBasis, opening_as_of = @openingAsOf, opening_accum_minor = @openingAccum,
        schedule_life_months = @scheduleLife, depreciation_start_period = @startPeriod,
        accum_minor = @openingAccum, nbv_minor = @nbv,
        tax_class = @taxClass, tax_cost_khr_minor = @taxCost, tax_fx_khr_per_usd = @taxFx, tax_fx_source = @taxFxSource,
        tax_opening_wdv_khr_minor = @taxOpening,
        acquisition_entry_id = @entryId, activated_at = @now, activated_by_user_id = @by, updated_at = @updatedAt, updated_by_user_id = @by
      WHERE id = @id
    `).run({
      id: a.id, treatment: p.treatment, costUsd: p.costUsdMinor, costFx: p.costFxKhrPerUsd, salvage: p.salvageMinor,
      // Remember which figures activation filled in, so undoing it clears them again (review M4).
      salvageDefaulted: a.salvageMinor == null && p.salvageMinor != null ? 1 : 0,
      costFxDefaulted: a.costCurrency === 'KHR' && a.costFxKhrPerUsd == null && p.costFxKhrPerUsd != null ? 1 : 0,
      costBasis: p.opening ? (p.deemed ? 'deemed' : 'actual') : 'actual',
      openingAsOf: p.opening ? p.settings.registerStartDate : null, openingAccum: p.openingAccumMinor,
      scheduleLife: p.scheduleLifeMonths, startPeriod: p.depreciationStartPeriod, nbv: p.nbvMinor,
      taxClass: p.tax.taxClass, taxCost: p.tax.costKhr, taxFx: p.tax.fx, taxFxSource: p.tax.fxSource, taxOpening: p.tax.openingWdvKhr,
      entryId: posted ? posted.id : null, now: Date.now(), by: getCallerUserId(), updatedAt: nextUpdatedAt(a.updatedAt),
    });
    insertEvent({
      id: eventId, companyId: a.companyId, assetId: a.id, kind: p.opening ? 'open' : 'acquire', eventDate: p.entryDate,
      amountMinor: a.costMinor, currency: a.costCurrency, fxKhrPerUsd: posted?.fxKhrPerUsd ?? p.costFxKhrPerUsd, amountUsdMinor: p.costUsdMinor,
      supplierId: a.supplierId, journalEntryId: posted ? posted.id : null, toBranchId: a.branchId, toEmployeeId: a.custodianEmployeeId,
      toStatus: a.status,
      detail: { treatment: p.treatment, deemed: p.deemed, openingAccumMinor: p.openingAccumMinor, nbvMinor: p.nbvMinor, salvageMinor: p.salvageMinor },
    });
    require('./assetIdentity').syncToFuel(a.id);
  })();
  const after = get(id);
  audit('fixed_asset', id, 'activate', { after: {
    recordState: 'active', accountingTreatment: after.accountingTreatment, costUsdMinor: after.costUsdMinor,
    openingAccumMinor: after.openingAccumMinor, nbvMinor: after.nbvMinor, entryNo: posted?.entryNo ?? null,
  } });
  return { asset: after, entry: posted };
}

/* ─── events ──────────────────────────────────────────────────── */

function insertEvent(e) {
  const id = e.id || uuid();
  getDb().prepare(`
    INSERT INTO asset_events (id, company_id, asset_id, batch_id, event_date, effective_period, kind,
      from_branch_id, to_branch_id, from_employee_id, to_employee_id, from_status, to_status,
      amount_minor, currency, fx_khr_per_usd, amount_usd_minor, proceeds_minor, buyer, qty, new_life_months, new_salvage_minor,
      extends_life_months, vendor, supplier_id, reason, detail_json, document_file_ids, journal_entry_id, reverses_event_id, stocktake_result_id,
      recorded_by_user_id, created_at, operation_key)
    VALUES (@id, @companyId, @assetId, @batchId, @eventDate, @effectivePeriod, @kind,
      @fromBranchId, @toBranchId, @fromEmployeeId, @toEmployeeId, @fromStatus, @toStatus,
      @amountMinor, @currency, @fx, @amountUsdMinor, @proceedsMinor, @buyer, @qty, @newLifeMonths, @newSalvageMinor,
      @extendsLifeMonths, @vendor, @supplierId, @reason, @detail, @documentFileIds, @journalEntryId, @reversesEventId, @stocktakeResultId,
      @by, @now, @operationKey)
  `).run({
    id, companyId: e.companyId, assetId: e.assetId, batchId: e.batchId ?? null, eventDate: e.eventDate,
    effectivePeriod: e.effectivePeriod ?? e.eventDate.slice(0, 7), kind: e.kind,
    fromBranchId: e.fromBranchId ?? null, toBranchId: e.toBranchId ?? null, fromEmployeeId: e.fromEmployeeId ?? null, toEmployeeId: e.toEmployeeId ?? null,
    fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null,
    amountMinor: e.amountMinor ?? null, currency: e.currency ?? null, fx: e.fxKhrPerUsd ?? null, amountUsdMinor: e.amountUsdMinor ?? null,
    proceedsMinor: e.proceedsMinor ?? null, buyer: e.buyer ?? null, qty: e.qty ?? null,
    newLifeMonths: e.newLifeMonths ?? null, newSalvageMinor: e.newSalvageMinor ?? null, extendsLifeMonths: e.extendsLifeMonths ?? null,
    vendor: e.vendor ?? null, supplierId: e.supplierId ?? null, reason: e.reason ?? null,
    detail: e.detail ? JSON.stringify(e.detail) : null,
    documentFileIds: e.documentFileIds && e.documentFileIds.length ? JSON.stringify(e.documentFileIds) : null,
    journalEntryId: e.journalEntryId ?? null, reversesEventId: e.reversesEventId ?? null, stocktakeResultId: e.stocktakeResultId ?? null,
    by: getCallerUserId(), now: Date.now(), operationKey: operationKeyOf(e.operationKey),
  });
  return id;
}

/** A client's operation key: 8–100 letters, digits, `-`, `_`, `:`; blank = none. */
function operationKeyOf(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^[A-Za-z0-9:_-]{8,100}$/.test(s)) throw badRequest('operationKey must be 8–100 letters, digits, "-", "_" or ":"');
  return s;
}

/**
 * Idempotency for the money events a person can double-click (review LOW 6):
 * when an event with this `operationKey` already exists in the asset's
 * company, return what the first call returned (`replayed: true`) instead of
 * posting again. The same key on another asset or another kind of action is
 * refused. Null when there is no key or it is new.
 */
function replayOperation(assetId, kind, operationKey) {
  const key = operationKeyOf(operationKey);
  if (!key) return null;
  const a = get(assetId);
  if (!a) return null;
  const r = getDb().prepare('SELECT id FROM asset_events WHERE company_id = ? AND operation_key = ?').get(a.companyId, key);
  if (!r) return null;
  const e = getEvent(r.id);
  if (e.assetId !== assetId || e.kind !== kind) throw badRequest('That operation key was already used for another action — try again');
  return { asset: get(assetId), event: e, entry: e.journalEntryId ? ledger.getEntry(e.journalEntryId) : null, replayed: true };
}

function rowToEvent(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, assetId: r.asset_id, tagCode: r.tag_code ?? undefined, assetName: r.asset_name ?? undefined,
    batchId: r.batch_id ?? null, eventDate: r.event_date, effectivePeriod: r.effective_period ?? null, kind: r.kind,
    fromBranchId: r.from_branch_id ?? null, toBranchId: r.to_branch_id ?? null,
    fromEmployeeId: r.from_employee_id ?? null, toEmployeeId: r.to_employee_id ?? null,
    fromStatus: r.from_status ?? null, toStatus: r.to_status ?? null,
    amountMinor: r.amount_minor ?? null, currency: r.currency ?? null, fxKhrPerUsd: r.fx_khr_per_usd ?? null, amountUsdMinor: r.amount_usd_minor ?? null,
    proceedsMinor: r.proceeds_minor ?? null, buyer: r.buyer ?? null, qty: r.qty ?? null,
    newLifeMonths: r.new_life_months ?? null, newSalvageMinor: r.new_salvage_minor ?? null, extendsLifeMonths: r.extends_life_months ?? null,
    vendor: r.vendor ?? null, supplierId: r.supplier_id ?? null, reason: r.reason ?? null, detail: parseJson(r.detail_json, null),
    documentFileIds: parseJson(r.document_file_ids, []), journalEntryId: r.journal_entry_id ?? null,
    reversesEventId: r.reverses_event_id ?? null, reversedByEventId: r.reversed_by_event_id ?? null, stocktakeResultId: r.stocktake_result_id ?? null,
    recordedByUserId: r.recorded_by_user_id ?? null, createdAt: r.created_at,
    voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null,
  };
}

function getEvent(id) {
  return rowToEvent(getDb().prepare('SELECT * FROM asset_events WHERE id = ?').get(id));
}

function listEvents(companyId, { assetId = null, batchId = null, kind = null, includeVoided = true, limit = 200, offset = 0 } = {}) {
  if (!companyId) return [];
  const where = ['e.company_id = @companyId'];
  if (assetId) where.push('e.asset_id = @assetId');
  if (batchId) where.push('e.batch_id = @batchId');
  if (kind) where.push('e.kind = @kind');
  if (!includeVoided) where.push('e.voided_at IS NULL');
  return getDb().prepare(`
    SELECT e.*, a.tag_code, a.name AS asset_name FROM asset_events e JOIN fixed_assets a ON a.id = e.asset_id
     WHERE ${where.join(' AND ')} ORDER BY e.event_date DESC, e.created_at DESC LIMIT @limit OFFSET @offset
  `).all({ companyId, assetId, batchId, kind, limit: Math.min(Math.max(1, Number(limit) || 200), 1000), offset: Math.max(0, Number(offset) || 0) })
    .map(rowToEvent);
}

function eventDate(v) {
  const d = dateOrNull(v, 'Date') || todayPhnomPenh();
  if (d > todayPhnomPenh()) throw badRequest('The date cannot be in the future');
  return d;
}

/** The earliest date anything can happen to an asset: its purchase date, or the register start for an opening asset. */
function acquisitionFloor(a) {
  if (a.acquisitionKind === 'opening') return a.recordState === 'active' ? config.getSettings(a.companyId).registerStartDate : null;
  return a.purchaseDate || null;
}

const EVENT_GROUPS = { move: ['transfer', 'custodian'], status: ['status'] };

/**
 * An event's date for this asset (review M7 / L1): not in the future, not before
 * the asset was acquired (or the register start), and — for moves and status
 * changes — not before the latest live one of that kind, so the asset's
 * current branch / custodian / status is always the latest event's.
 */
function eventDateFor(a, v, group = null) {
  const d = eventDate(v);
  const floor = acquisitionFloor(a);
  if (floor && d < floor) {
    throw badRequest(`The date cannot be before ${floor} (${a.acquisitionKind === 'opening' ? 'the register start' : 'the purchase date'})`);
  }
  if (group) {
    const kinds = EVENT_GROUPS[group];
    const last = getDb().prepare(`SELECT MAX(event_date) AS d FROM asset_events WHERE asset_id = ? AND voided_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')})`).get(a.id, ...kinds).d;
    if (last && d < last) throw badRequest(`A later ${group === 'status' ? 'status change' : 'move'} is recorded on ${last} — date this one on or after it`);
  }
  return d;
}

/**
 * The branch an asset was in on `date` (§11: lines carry the branch of their
 * date): the latest live transfer on or before it, else the "from" branch of
 * the first transfer after it, else its current branch.
 */
function branchAt(a, date) {
  const db = getDb();
  const before = db.prepare(`SELECT to_branch_id FROM asset_events WHERE asset_id = ? AND kind = 'transfer' AND voided_at IS NULL AND event_date <= ?
     ORDER BY event_date DESC, created_at DESC LIMIT 1`).get(a.id, date);
  if (before) return before.to_branch_id;
  const after = db.prepare(`SELECT from_branch_id FROM asset_events WHERE asset_id = ? AND kind = 'transfer' AND voided_at IS NULL AND event_date > ?
     ORDER BY event_date, created_at LIMIT 1`).get(a.id, date);
  if (after) return after.from_branch_id;
  return a.branchId;
}

/** Refuse leaving the register before a move recorded later (review 2, LOW). */
function assertNoLaterMove(a, d) {
  const later = getDb().prepare(`SELECT MAX(event_date) AS d FROM asset_events WHERE asset_id = ? AND voided_at IS NULL AND kind IN ('transfer', 'custodian', 'status') AND event_date > ?`).get(a.id, d).d;
  if (later) throw badRequest(`${a.tagCode} has a move or status change recorded on ${later} — it cannot leave the register before that`);
}

/**
 * The latest month the company's depreciation has been posted for (runs not
 * reversed), or null. Changes to an asset's schedule (capex, life, salvage,
 * impairment…) must take effect after it, so a posted month is never restated.
 */
function lastDepreciationPeriod(companyId) {
  const r = getDb().prepare(`
    SELECT MAX(period) AS p FROM depreciation_runs WHERE company_id = ? AND status = 'posted'
  `).get(companyId);
  return r?.p || null;
}

function assertAfterPosted(a, d) {
  const last = lastDepreciationPeriod(a.companyId);
  if (last && d.slice(0, 7) <= last) {
    const next = book.addMonths(last, 1);
    throw badRequest(`Depreciation is already posted through ${ledger.humanMonth(last)} — date this change in ${ledger.humanMonth(next)} or later`);
  }
}

/** An asset that can still have things happen to it. */
function liveAsset(id, { activeOnly = false } = {}) {
  const a = get(id);
  if (!a) throw notFound('Asset');
  if (a.recordState === 'cancelled') throw badRequest(`${a.tagCode} is a cancelled draft`);
  if (a.status === 'disposed' || a.status === 'lost') throw badRequest(`${a.tagCode} has been ${a.status === 'lost' ? 'written off as lost' : 'disposed of'}`);
  if (activeOnly && a.recordState !== 'active') throw badRequest(`${a.tagCode} is still a draft — activate it first`);
  return a;
}

function touch(id, sets, params) {
  getDb().prepare(`UPDATE fixed_assets SET ${sets.join(', ')}, updated_at = @updatedAt, updated_by_user_id = @by WHERE id = @id`)
    .run({ ...params, id, updatedAt: Date.now(), by: getCallerUserId() });
}

/**
 * Move one or many assets to a branch and/or a custodian (§8.1 Transfers):
 * one event per asset, sharing a batch id. `toEmployeeId: null` clears the
 * custodian; leaving it out keeps each asset's own.
 */
function transfer({ companyId, assetIds, toBranchId, toEmployeeId, date, reason } = {}) {
  if (!Array.isArray(assetIds) || !assetIds.length) throw badRequest('Pick the assets to move');
  if (assetIds.length > 1000) throw badRequest('At most 1,000 assets in one transfer');
  const moveBranch = toBranchId !== undefined;
  const moveCustodian = toEmployeeId !== undefined;
  if (!moveBranch && !moveCustodian) throw badRequest('Choose the branch and/or the person they go to');
  const d = eventDate(date);
  const why = str(reason, 500);
  const branchId = moveBranch ? branches.assertAssignable(companyId, toBranchId) : undefined;
  if (moveBranch && !branchId) throw badRequest('Choose the branch they go to');
  const employeeId = moveCustodian ? checkEmployee(companyId, toEmployeeId) : undefined;
  const batchId = uuid();
  const db = getDb();
  const out = { batchId, moved: [], unchanged: [] };
  db.transaction(() => {
    for (const id of new Set(assetIds)) {
      const a = liveAsset(id);
      if (a.companyId !== companyId) throw badRequest('That asset belongs to a different company');
      eventDateFor(a, d, 'move');
      const nb = moveBranch ? branchId : a.branchId;
      const ne = moveCustodian ? employeeId : a.custodianEmployeeId;
      if (nb === a.branchId && ne === a.custodianEmployeeId) { out.unchanged.push(a.id); continue; }
      const eventId = insertEvent({
        companyId, assetId: a.id, batchId, kind: 'transfer', eventDate: d, reason: why,
        fromBranchId: a.branchId, toBranchId: nb, fromEmployeeId: a.custodianEmployeeId, toEmployeeId: ne,
      });
      touch(a.id, ['branch_id = @b', 'custodian_employee_id = @e'], { b: nb, e: ne });
      require('./assetIdentity').syncToFuel(a.id);
      out.moved.push({ assetId: a.id, eventId });
    }
  })();
  for (const m of out.moved) audit('asset_event', m.eventId, 'transfer', { after: { assetId: m.assetId, batchId, toBranchId: branchId ?? null, toEmployeeId: employeeId ?? null, date: d, reason: why } });
  return out;
}

function setCustodian({ id, employeeId = null, date, reason } = {}) {
  const a = liveAsset(id);
  const ne = checkEmployee(a.companyId, employeeId);
  if (ne === a.custodianEmployeeId) return { asset: a, eventId: null };
  const d = eventDateFor(a, date, 'move');
  let eventId;
  getDb().transaction(() => {
    eventId = insertEvent({ companyId: a.companyId, assetId: id, kind: 'custodian', eventDate: d, reason: str(reason, 500), fromEmployeeId: a.custodianEmployeeId, toEmployeeId: ne });
    touch(id, ['custodian_employee_id = @e'], { e: ne });
    require('./assetIdentity').syncToFuel(id);
  })();
  audit('asset_event', eventId, 'custodian', { after: { assetId: id, from: a.custodianEmployeeId, to: ne, date: d } });
  return { asset: get(id), eventId };
}

function setStatus({ id, status, date, reason } = {}) {
  const a = liveAsset(id);
  const s = oneOf(status, SETTABLE_STATUSES, 'Status', null);
  if (!s) throw badRequest('Choose in use, in storage or in repair');
  if (s === a.status) return { asset: a, eventId: null };
  const d = eventDateFor(a, date, 'status');
  let eventId;
  getDb().transaction(() => {
    eventId = insertEvent({ companyId: a.companyId, assetId: id, kind: 'status', eventDate: d, reason: str(reason, 500), fromStatus: a.status, toStatus: s });
    touch(id, ['status = @s'], { s });
  })();
  audit('asset_event', eventId, 'status', { after: { assetId: id, from: a.status, to: s, date: d } });
  return { asset: get(id), eventId };
}

function amountInUsd(companyId, amountMinor, currency, date, fx) {
  if (amountMinor == null) return { usd: null, rate: null };
  if (currency === 'KHR') {
    const rate = fx ? positiveRate(fx) : fxRates.houseRateFor(companyId, date).khrPerUsd;
    return { usd: Math.round((amountMinor * 100) / rate), rate };
  }
  return { usd: amountMinor, rate: null };
}

/** A repair: history only, with optional cost, vendor and documents — no journal (Finance records the expense, §11). */
function recordRepair({ id, date, amountMinor, currency, vendor, supplierId, reason, documentFileIds } = {}) {
  const a = liveAsset(id);
  const why = str(reason, 1000);
  if (!why) throw badRequest('Say what was repaired');
  const d = eventDateFor(a, date);
  const cur = oneOf(currency, CURRENCIES, 'Currency', 'USD');
  const amount = minorOrNull(amountMinor, 'Repair cost');
  const fileIds = checkFileIds(id, documentFileIds);
  const eventId = insertEvent({
    companyId: a.companyId, assetId: id, kind: 'repair', eventDate: d, reason: why, amountMinor: amount, currency: amount == null ? null : cur,
    vendor: str(vendor, 200), supplierId: checkSupplier(a.companyId, supplierId), documentFileIds: fileIds,
  });
  audit('asset_event', eventId, 'repair', { after: { assetId: id, date: d, amountMinor: amount, currency: cur, reason: why } });
  return { asset: a, event: getEvent(eventId) };
}

function checkFileIds(assetId, ids) {
  if (ids == null) return [];
  if (!Array.isArray(ids) || ids.length > 20) throw badRequest('documentFileIds must be a list of up to 20 file ids');
  for (const fid of ids) {
    const f = getDb().prepare('SELECT asset_id FROM asset_files WHERE id = ?').get(fid);
    if (!f || f.asset_id !== assetId) throw badRequest('A document is not one of this asset\'s files');
  }
  return ids;
}

function assertDepreciating(a) {
  if (a.recordState !== 'active') throw badRequest(`${a.tagCode} is still a draft — activate it first`);
  if (a.accountingTreatment === 'tracked_only') throw badRequest(`${a.tagCode} is tracked, not capitalised — it has no book value to change`);
}

/**
 * An improvement (§11 Capex versus repair): at or above the threshold and
 * improving or extending life. Posts Dr Cost / Cr Purchases clearing; the
 * schedule re-runs from that month with the extra cost (and months).
 */
function recordCapex({ id, date, amountMinor, currency, fxKhrPerUsd, extendsLifeMonths, supplierId, reason, documentFileIds, operationKey } = {}) {
  const again = replayOperation(id, 'capex', operationKey);
  if (again) return again;
  const a = liveAsset(id, { activeOnly: true });
  assertDepreciating(a);
  const why = str(reason, 1000);
  if (!why) throw badRequest('Say what the improvement was');
  const d = eventDateFor(a, date);
  assertAfterPosted(a, d);
  const cur = oneOf(currency, CURRENCIES, 'Currency', 'USD');
  const amount = minorOrNull(amountMinor, 'Amount');
  if (!amount) throw badRequest('Enter the amount of the improvement');
  const { usd, rate } = amountInUsd(a.companyId, amount, cur, d, fxKhrPerUsd);
  const settings = config.getSettings(a.companyId);
  if (usd < settings.capitalizationThresholdMinor) {
    throw badRequest(`Below the ${(settings.capitalizationThresholdMinor / 100).toLocaleString('en-US')} USD threshold this is a repair — use "Record repair"`);
  }
  const extra = extendsLifeMonths == null || extendsLifeMonths === '' ? null : int(extendsLifeMonths);
  if (extra != null && (extra < 0 || extra > 1200)) throw badRequest('Extra months must be 0–1200');
  // Review M2: an improvement to an asset with no life left must say how long it adds, or it would never depreciate.
  const spec = scheduleSpec(a);
  if (spec && (extra == null || extra < 1) && book.positionAt(spec, d.slice(0, 7)).remainingMonths === 0) {
    throw badRequest(`${a.tagCode} has no months of life left — say how many months the improvement adds`);
  }
  const category = config.getCategory(a.categoryId);
  const fileIds = checkFileIds(id, documentFileIds);
  const eventId = uuid();
  let entry;
  getDb().transaction(() => {
    const branchOn = branchAt(a, d);
    const lines = [
      { accountId: category.glCostAccountId, debitMinor: usd, lineRole: 'cost', txnCurrency: cur, txnAmountMinor: amount, assetId: a.id, branchId: branchOn },
      { accountKey: 'fa.clearing.purchase', creditMinor: usd, lineRole: 'clearing', assetId: a.id, branchId: branchOn },
    ];
    if (cur === 'KHR') lines[0].khrMinor = amount;
    entry = ledger.post({
      companyId: a.companyId, entryDate: d, sourceKind: 'asset_capex', sourceId: eventId, idempotencyKey: `evt:${eventId}`,
      memo: `Improvement: ${a.tagCode} ${a.name} — ${why}`, fxKhrPerUsd: rate || undefined, fxSource: rate ? 'given rate' : undefined, lines,
    });
    insertEvent({
      id: eventId, companyId: a.companyId, assetId: id, kind: 'capex', eventDate: d, reason: why, amountMinor: amount, currency: cur,
      fxKhrPerUsd: entry.fxKhrPerUsd, amountUsdMinor: usd, extendsLifeMonths: extra, supplierId: checkSupplier(a.companyId, supplierId),
      journalEntryId: entry.id, documentFileIds: fileIds, operationKey,
    });
    require('./assetDepreciation').refreshSnapshot(id);
  })();
  audit('asset_event', eventId, 'capex', { after: { assetId: id, date: d, amountUsdMinor: usd, extendsLifeMonths: extra, entryNo: entry.entryNo } });
  return { asset: get(id), event: getEvent(eventId), entry };
}

/** Change of useful life — prospective from that month: `newLifeMonths` is the months LEFT from then (§4.1). */
function changeLife({ id, date, newLifeMonths, reason } = {}) {
  const a = liveAsset(id, { activeOnly: true });
  assertDepreciating(a);
  if (a.accountingTreatment !== 'capitalised') throw badRequest(`${a.tagCode} is not depreciated`);
  const why = str(reason, 1000);
  if (!why) throw badRequest('A reason is required — it is shown on the schedule');
  const n = int(newLifeMonths);
  if (n == null || n < 1 || n > 1200) throw badRequest('Months left must be 1–1200');
  const d = eventDateFor(a, date);
  assertAfterPosted(a, d);
  const eventId = insertEvent({ companyId: a.companyId, assetId: id, kind: 'life_change', eventDate: d, reason: why, newLifeMonths: n });
  audit('asset_event', eventId, 'life_change', { after: { assetId: id, date: d, newLifeMonths: n, reason: why } });
  return { asset: get(id), event: getEvent(eventId) };
}

/** Change of salvage — prospective from that month (§4.1). US cents. */
function changeSalvage({ id, date, newSalvageMinor, reason } = {}) {
  const a = liveAsset(id, { activeOnly: true });
  assertDepreciating(a);
  if (a.accountingTreatment !== 'capitalised') throw badRequest(`${a.tagCode} is not depreciated`);
  const why = str(reason, 1000);
  if (!why) throw badRequest('A reason is required — it is shown on the schedule');
  const s = minorOrNull(newSalvageMinor, 'Salvage');
  if (s == null) throw badRequest('Enter the new salvage value');
  const d = eventDateFor(a, date);
  assertAfterPosted(a, d);
  const eventId = insertEvent({ companyId: a.companyId, assetId: id, kind: 'salvage_change', eventDate: d, reason: why, newSalvageMinor: s });
  audit('asset_event', eventId, 'salvage_change', { after: { assetId: id, date: d, newSalvageMinor: s, reason: why } });
  return { asset: get(id), event: getEvent(eventId) };
}

function addNote({ id, date, text } = {}) {
  const a = get(id);
  if (!a) throw notFound('Asset');
  const t = str(text, 2000);
  if (!t) throw badRequest('Write the note');
  const eventId = insertEvent({ companyId: a.companyId, assetId: id, kind: 'note', eventDate: eventDateFor(a, date), reason: t });
  audit('asset_event', eventId, 'note', { after: { assetId: id, text: t } });
  return { asset: a, event: getEvent(eventId) };
}

const SNAPSHOT_FIELD = { transfer: ['branch_id', 'custodian_employee_id'], custodian: ['custodian_employee_id'], status: ['status'] };

/**
 * Void an event with no money effect (reason required). A transfer, custodian
 * or status event can be voided only while it is the latest one of its kind
 * for the asset; the asset goes back to what it was before it. A life or
 * salvage change can be voided only before any depreciation was posted from
 * its month.
 */
function voidEvent(id, reason) {
  const e = getEvent(id);
  if (!e) throw notFound('Event');
  if (e.voided) return e;
  if (!VOIDABLE_KINDS.includes(e.kind)) {
    throw badRequest(REVERSIBLE_KINDS.includes(e.kind) ? 'This event posted to the books — reverse it instead' : 'This event cannot be voided');
  }
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to void an event');
  const a = get(e.assetId);
  const lastRun = lastDepreciationPeriod(e.companyId);
  if (['life_change', 'salvage_change'].includes(e.kind) && lastRun && lastRun >= e.effectivePeriod) {
    throw badRequest('Depreciation has already been posted with this change — make a new change instead');
  }
  const db = getDb();
  db.transaction(() => {
    if (SNAPSHOT_FIELD[e.kind]) {
      const later = db.prepare(`
        SELECT 1 FROM asset_events WHERE asset_id = ? AND voided_at IS NULL AND id <> ? AND kind IN ('transfer', 'custodian', 'status', 'acquire', 'open')
           AND (event_date > ? OR (event_date = ? AND created_at > ?))
           AND (${e.kind === 'status' ? "kind = 'status'" : "kind IN ('transfer', 'custodian')"}) LIMIT 1
      `).get(e.assetId, e.id, e.eventDate, e.eventDate, e.createdAt);
      if (later) throw badRequest('A later change exists for this asset — void that one first');
      if (e.kind === 'status') touch(e.assetId, ['status = @s'], { s: e.fromStatus });
      if (e.kind === 'custodian') touch(e.assetId, ['custodian_employee_id = @e'], { e: e.fromEmployeeId });
      if (e.kind === 'transfer') touch(e.assetId, ['branch_id = @b', 'custodian_employee_id = @e'], { b: e.fromBranchId, e: e.fromEmployeeId });
      require('./assetIdentity').syncToFuel(e.assetId);
    }
    db.prepare('UPDATE asset_events SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?').run(Date.now(), why, getCallerUserId(), id);
  })();
  audit('asset_event', id, 'void', { before: { kind: e.kind, assetId: e.assetId }, after: { voided: true, voidReason: why } });
  return { event: getEvent(id), asset: get(a.id) };
}

/**
 * Depreciation actually charged for an asset to date (US cents): its
 * `accum_dep` lines on every entry except its opening (and a reversal of the
 * opening). Runs, disposal / write-off months, run reversals and the
 * adjustment below all count. `throughPeriod` limits it to entries posted in
 * or before that month.
 */
const POSTED_DEP_SQL = `
  SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) AS n
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    LEFT JOIN journal_entries o ON o.id = e.reverses_entry_id
   WHERE l.asset_id = @assetId AND l.line_role = 'accum_dep'
     AND e.source_kind <> 'asset_open' AND COALESCE(o.source_kind, '') <> 'asset_open'`;

function postedDepreciation(assetId, { throughPeriod = null } = {}) {
  const sql = throughPeriod ? `${POSTED_DEP_SQL} AND e.period <= @through` : POSTED_DEP_SQL;
  return getDb().prepare(sql).get({ assetId, through: throughPeriod }).n;
}

/**
 * Reverse an event that posted (§3.5). A capex reversal posts the mirror entry
 * in the current open month. Reversing an acquisition or opening sends the
 * asset back to DRAFT so its figures can be corrected and activated again;
 * its mirror is dated the ORIGINAL entry date (review H1), so a corrected
 * re-activation on the same date never leaves the cost counted twice at any
 * month-end (a locked month still redirects it, like the re-activation).
 * Depreciation already posted for it is taken back by one adjustment entry
 * dated the first day after the last posted month; that month's run catches
 * up from the start.
 */
function reverseEvent(id, reason) {
  const e = getEvent(id);
  if (!e) throw notFound('Event');
  if (e.kind === 'lost') throw badRequest('A write-off is undone with "Found again"');
  if (!REVERSIBLE_KINDS.includes(e.kind)) throw badRequest(VOIDABLE_KINDS.includes(e.kind) ? 'This event did not post anything — void it instead' : 'This event cannot be reversed');
  if (e.voided || e.reversedByEventId) throw badRequest('This event has already been undone');
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to reverse an event');
  if (['dispose', 'partial_dispose', 'impair', 'revalue'].includes(e.kind)) return require('./assetDisposals').reverseMoneyEvent(e, why);
  const a = get(e.assetId);
  const db = getDb();
  const revEventId = uuid();
  let rev = null;
  db.transaction(() => {
    if (e.kind === 'acquire' || e.kind === 'open') {
      const others = db.prepare(`
        SELECT 1 FROM journal_lines l JOIN journal_entries j ON j.id = l.entry_id
         WHERE l.asset_id = ? AND j.reversed_by_entry_id IS NULL AND j.reverses_entry_id IS NULL AND j.id IS NOT ?
           AND j.source_kind NOT IN ('asset_depreciation', 'reversal') LIMIT 1
      `).get(e.assetId, e.journalEntryId);
      if (others) throw badRequest('Other entries are posted for this asset (a disposal, impairment or revaluation) — reverse those first');
      const laterLive = db.prepare(`SELECT 1 FROM asset_events WHERE asset_id = ? AND kind IN ('capex', 'life_change', 'salvage_change', 'impair', 'revalue', 'partial_dispose', 'dispose', 'lost') AND voided_at IS NULL AND reversed_by_event_id IS NULL LIMIT 1`).get(e.assetId);
      if (laterLive) throw badRequest('Undo the later events (improvements, life or salvage changes, disposals) first');
    }
    const acquisition = e.kind === 'acquire' || e.kind === 'open';
    if (e.journalEntryId) {
      const orig = acquisition ? ledger.getEntry(e.journalEntryId) : null;
      rev = ledger.reverse(e.journalEntryId, why, { sourceKind: 'reversal', sourceId: revEventId, date: orig ? (orig.intendedDate || orig.entryDate) : null });
    }
    if (acquisition) {
      const charged = postedDepreciation(e.assetId);
      if (charged !== 0) {
        const category = config.getCategory(a.categoryId);
        const n = db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE company_id = ? AND idempotency_key LIKE ?").get(a.companyId, `asset:${a.id}:undo-dep:%`).n;
        const dims = { assetId: a.id, branchId: a.branchId };
        ledger.post({
          // Dated the first day after the last posted month (review 2): the next run —
          // that month's — catches up on the corrected figures, so every month-end
          // from then on equals the schedule.
          companyId: a.companyId, entryDate: lastDepreciationPeriod(a.companyId) ? `${book.addMonths(lastDepreciationPeriod(a.companyId), 1)}-01` : todayPhnomPenh(), sourceKind: 'reversal', sourceId: revEventId,
          idempotencyKey: `asset:${a.id}:undo-dep:${n + 1}`,
          memo: `Depreciation taken back: ${a.tagCode} ${a.name} returned to draft (${why})`,
          lines: charged > 0
            ? [{ accountId: category.glAccumAccountId, debitMinor: charged, lineRole: 'accum_dep', ...dims }, { accountId: category.glExpenseAccountId, creditMinor: charged, lineRole: 'dep_catch_up', ...dims }]
            : [{ accountId: category.glExpenseAccountId, debitMinor: -charged, lineRole: 'dep_catch_up', ...dims }, { accountId: category.glAccumAccountId, creditMinor: -charged, lineRole: 'accum_dep', ...dims }],
        });
      }
    }
    insertEvent({
      id: revEventId, companyId: e.companyId, assetId: e.assetId, kind: 'reversal', eventDate: todayPhnomPenh(), reason: why,
      amountMinor: e.amountMinor, currency: e.currency, amountUsdMinor: e.amountUsdMinor, journalEntryId: rev ? rev.id : null, reversesEventId: e.id,
    });
    db.prepare('UPDATE asset_events SET reversed_by_event_id = ? WHERE id = ?').run(revEventId, e.id);
    if (e.kind === 'capex') {
      require('./assetDepreciation').refreshSnapshot(e.assetId);
    } else {
      // Back to a draft, figures kept for correction; the basis is worked out again at the next activation.
      touch(e.assetId, [
        "record_state = 'draft'", 'accounting_treatment = NULL', 'opening_as_of = NULL', 'opening_accum_minor = 0',
        'schedule_life_months = NULL', 'depreciation_start_period = NULL', 'accum_minor = 0', 'nbv_minor = NULL',
        'acquisition_entry_id = NULL', 'activated_at = NULL', 'activated_by_user_id = NULL', 'cost_usd_minor = NULL',
        'tax_cost_khr_minor = NULL', 'tax_fx_khr_per_usd = NULL', 'tax_fx_source = NULL', 'tax_opening_wdv_khr_minor = NULL',
        'last_posted_period = NULL',
        // Review M4: figures activation filled in are cleared again, so the next activation works them out afresh.
        'salvage_minor = CASE WHEN salvage_defaulted = 1 THEN NULL ELSE salvage_minor END', 'salvage_defaulted = 0',
        'cost_fx_khr_per_usd = CASE WHEN cost_fx_defaulted = 1 THEN NULL ELSE cost_fx_khr_per_usd END', 'cost_fx_defaulted = 0',
      ], {});
    }
  })();
  audit('asset_event', revEventId, 'reverse', { after: { assetId: e.assetId, reverses: e.id, kind: e.kind, entryNo: rev?.entryNo ?? null, reason: why } });
  return { asset: get(a.id), event: getEvent(revEventId), entry: rev };
}

/* ─── schedules ───────────────────────────────────────────────── */

/** The inputs of an active asset's book schedule (bookDepreciation.bookSchedule). */
function scheduleSpec(a, { endPeriod = null } = {}) {
  if (a.accountingTreatment !== 'capitalised' || !a.depreciationStartPeriod) return null;
  const events = getDb().prepare(`
    SELECT * FROM asset_events WHERE asset_id = ? AND voided_at IS NULL AND reversed_by_event_id IS NULL
       AND kind IN ('capex', 'life_change', 'salvage_change', 'impair', 'revalue', 'partial_dispose', 'dispose', 'lost')
     ORDER BY event_date, created_at
  `).all(a.id).map(rowToEvent);
  const changes = [];
  let end = endPeriod;
  for (const e of events) {
    const period = e.effectivePeriod || e.eventDate.slice(0, 7);
    const d = e.detail || {};
    if (e.kind === 'capex') changes.push({ period, addBasisMinor: e.amountUsdMinor || 0, extendMonths: e.extendsLifeMonths || 0 });
    else if (e.kind === 'life_change') changes.push({ period, lifeMonths: e.newLifeMonths });
    else if (e.kind === 'salvage_change') changes.push({ period, salvageMinor: e.newSalvageMinor });
    else if (e.kind === 'impair') changes.push({ period, impairMinor: e.amountUsdMinor || 0 });
    else if (e.kind === 'revalue') changes.push({ period, revalueToMinor: e.amountUsdMinor || 0 });
    else if (e.kind === 'partial_dispose') {
      changes.push({ period, removeBasisMinor: d.costShareMinor || 0, removeAccumMinor: d.accumShareMinor || 0, removeImpairMinor: d.impairShareMinor || 0, salvageMinor: d.salvageAfterMinor });
    } else if (e.kind === 'dispose' || e.kind === 'lost') {
      // The last month that depreciates (the §4.1 convention, worked out when it was recorded).
      const last = d.lastPeriod || book.lastPeriod(e.eventDate, config.getSettings(a.companyId).convention);
      if (!end || last < end) end = last;
    }
  }
  return {
    basisMinor: a.costUsdMinor || 0, salvageMinor: a.salvageMinor || 0, openingAccumMinor: a.openingAccumMinor || 0,
    lifeMonths: a.scheduleLifeMonths || 0, startPeriod: a.depreciationStartPeriod, endPeriod: end, changes,
  };
}

/** Depreciation actually posted for this asset, by period (A2's runs and disposals). */
function postedByPeriod(assetId) {
  const rows = getDb().prepare(`
    SELECT e.period, SUM(l.credit_minor - l.debit_minor) AS amount
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      LEFT JOIN journal_entries o ON o.id = e.reverses_entry_id
     WHERE l.asset_id = ? AND l.line_role = 'accum_dep'
       AND e.source_kind <> 'asset_open' AND COALESCE(o.source_kind, '') <> 'asset_open'
     GROUP BY e.period
  `).all(assetId);
  return new Map(rows.map((r) => [r.period, r.amount]));
}

/**
 * The asset page's Schedule tab. basis 'book': monthly, worked out by the
 * pure module, with what has actually been posted per month alongside.
 * basis 'tax': yearly in riel for straight-line classes; pooled classes say so
 * (the pool view is the tax-year report, A2).
 */
function getSchedule(id, basis = 'book') {
  const a = get(id);
  if (!a) throw notFound('Asset');
  if (basis === 'tax') {
    if (!a.taxClass || a.accountingTreatment === 'tracked_only' || a.recordState !== 'active') {
      return { basis, taxClass: a.taxClass, rows: [], note: a.accountingTreatment === 'tracked_only' ? 'Tracked, not capitalised — not in the tax figures' : 'Not active yet' };
    }
    const cls = tax.taxClass(a.taxClass);
    const base = { basis, taxClass: cls.key, method: cls.method, pooled: cls.pooled, rateBp: cls.rateBp, label: cls.label, costKhrMinor: a.taxCostKhrMinor, fxSource: a.taxFxSource, confirmWithAccountant: true };
    if (cls.method === 'none') return { ...base, rows: [], note: 'Not depreciated for tax' };
    if (cls.pooled) return { ...base, rows: [], note: `Pooled: the cost joins the Class ${cls.key} pool in the year bought; the pool is worked out per year, not per asset` };
    const settings = config.getSettings(a.companyId);
    const firstYear = Number(settings.registerStartDate.slice(0, 4));
    const acquiredYear = Number((a.costBasis === 'deemed' ? settings.registerStartDate : (a.purchaseDate || a.inServiceDate || settings.registerStartDate)).slice(0, 4));
    const fromYear = Math.max(acquiredYear, firstYear);
    const opening = a.acquisitionKind === 'opening' && a.taxOpeningWdvKhrMinor != null ? (a.taxCostKhrMinor - a.taxOpeningWdvKhrMinor) : 0;
    const rows = tax.straightLineYears({ classKey: cls.key, costKhr: a.taxCostKhrMinor || 0, lifeMonths: a.usefulLifeMonths, acquiredYear, openingAccumKhr: opening, fromYear, toYear: fromYear + 60 })
      .filter((r, i, all) => r.depreciationKhr > 0 || i === 0 || all[i - 1].depreciationKhr > 0);
    return { ...base, rows };
  }
  const spec = scheduleSpec(a);
  if (!spec) {
    const note = a.recordState !== 'active' ? 'Not active yet'
      : a.accountingTreatment === 'tracked_only' ? 'Tracked, not capitalised — never depreciated'
        : a.accountingTreatment === 'not_depreciated' ? 'Not depreciated (land)'
          : 'No in-service date yet — depreciation starts when it is put in use';
    return { basis: 'book', rows: [], note, treatment: a.accountingTreatment };
  }
  const s = book.bookSchedule(spec);
  const posted = postedByPeriod(a.id);
  return {
    basis: 'book', treatment: a.accountingTreatment, startPeriod: spec.startPeriod, lifeMonths: spec.lifeMonths,
    basisMinor: s.basisMinor, salvageMinor: spec.salvageMinor, openingAccumMinor: s.openingAccumMinor,
    endAccumMinor: s.accumMinor, endNbvMinor: s.nbvMinor, fullyDepreciatedAt: s.fullyDepreciatedAt,
    changes: spec.changes,
    rows: s.rows.map((r) => ({ ...r, postedMinor: posted.get(r.period) ?? 0 })),
  };
}

module.exports = {
  STATUSES, SETTABLE_STATUSES, RECORD_STATES, ACQUISITION_KINDS, EVENT_KINDS, VOIDABLE_KINDS, REVERSIBLE_KINDS, ATTENTION, CURRENCIES,
  get, getByTag, list, create, update, cancelDraft,
  allocateTag, claimTag, tagUsed,
  planActivation, previewActivation, activate,
  insertEvent, getEvent, listEvents, replayOperation, operationKeyOf, transfer, setCustodian, setStatus, recordRepair, recordCapex, changeLife, changeSalvage, addNote,
  voidEvent, reverseEvent, scheduleSpec, getSchedule, rowToAsset, checkEmployee,
  postedDepreciation, lastDepreciationPeriod, assertAfterPosted, eventDateFor, eventDate, branchAt, assertNoLaterMove, liveAsset, touch, pastDateOrNull, assertDepreciating, amountInUsd,
};
