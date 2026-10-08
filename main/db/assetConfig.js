/**
 * Fixed Assets A1: categories and settings (docs/ASSETS_AND_BRANCHES_PLAN.md §3.3, §13a).
 *
 * Categories are the owner's defaults to edit; every tax class is "confirm
 * with accountant". A category's defaults are COPIED onto an asset when it is
 * created — changing a category later never moves an existing asset.
 *
 * Owner answers (2026-10-08, §13a) built in here:
 *   - the register starts on 1 Jan 2026 (`registerStartDate`);
 *   - $300 capitalisation threshold, overridable per asset ("Depreciate this item");
 *   - some buildings are owned → Class 1; land recorded, never depreciated;
 *     rented-shop fit-outs are their own category.
 */

const { getDb } = require('./index');
const { parseJson, nextUpdatedAt } = require('./_util');
const { uuid, str, num, int, badRequest, getCallerUserId, audit, isCalendarDate, notFound } = require('./_assetUtil');
const ledger = require('./ledger');
const { TAX_CLASS_KEYS } = require('../util/taxDepreciation');
const { CONVENTIONS } = require('../util/bookDepreciation');
const { normalizePrefix, defaultTagPrefix } = require('../util/assetTagCode');

const BOOK_METHODS = ['straight_line', 'none'];

/**
 * §3.3 built-ins. `acct` names the cost / accumulated pair in the seeded
 * chart (main/db/ledger.js); every category expenses to fa.dep_expense.
 */
const BUILTIN_CATEGORIES = [
  { key: 'land',           name: 'Land',                                         nameKm: 'ដី',                       life: null, salvagePct: 0,  book: 'none',          tax: 'land',       acct: 'land',       vehicle: false },
  { key: 'building',       name: 'Buildings (concrete)',                         nameKm: 'អគារ',                     life: 240,  salvagePct: 0,  book: 'straight_line', tax: '1',          acct: 'building',   vehicle: false },
  { key: 'building_light', name: 'Buildings, other / structures',                nameKm: 'សំណង់ផ្សេងៗ',              life: 120,  salvagePct: 0,  book: 'straight_line', tax: '1b',         acct: 'building',   vehicle: false },
  { key: 'leasehold',      name: 'Shop fit-outs (rented premises)',              nameKm: 'ការតុបតែងហាងជួល',          life: 60,   salvagePct: 0,  book: 'straight_line', tax: '1',          acct: 'building',   vehicle: false },
  { key: 'truck',          name: 'Trucks',                                       nameKm: 'ឡានដឹកទំនិញ',              life: 96,   salvagePct: 10, book: 'straight_line', tax: '3',          acct: 'vehicle',    vehicle: true },
  { key: 'car',            name: 'Cars / vans',                                  nameKm: 'ឡាន',                      life: 72,   salvagePct: 10, book: 'straight_line', tax: '3',          acct: 'vehicle',    vehicle: true },
  { key: 'motorbike',      name: 'Motorbikes',                                   nameKm: 'ម៉ូតូ',                     life: 48,   salvagePct: 5,  book: 'straight_line', tax: '3',          acct: 'vehicle',    vehicle: true },
  { key: 'computer',       name: 'Computers & IT (iMacs, POS, printers, phones)', nameKm: 'កុំព្យូទ័រ និងឧបករណ៍ IT',   life: 36,   salvagePct: 0,  book: 'straight_line', tax: '2',          acct: 'computer',   vehicle: false },
  { key: 'software',       name: 'Software (bought licences)',                   nameKm: 'កម្មវិធី',                  life: 36,   salvagePct: 0,  book: 'straight_line', tax: '2',          acct: 'intangible', vehicle: false },
  { key: 'furniture',      name: 'Office furniture & equipment',                 nameKm: 'គ្រឿងសង្ហារិម',             life: 60,   salvagePct: 0,  book: 'straight_line', tax: '3',          acct: 'furniture',  vehicle: false },
  { key: 'shelving',       name: 'Shop shelving & display fixtures',             nameKm: 'ធ្នើរ និងឧបករណ៍តាំងបង្ហាញ', life: 84,   salvagePct: 0,  book: 'straight_line', tax: '3',          acct: 'furniture',  vehicle: false },
  { key: 'kiln',           name: 'Kilns & production machinery',                 nameKm: 'ឡ និងម៉ាស៊ីនផលិត',          life: 120,  salvagePct: 5,  book: 'straight_line', tax: '4',          acct: 'machinery',  vehicle: false },
  { key: 'plant',          name: 'Forklifts, generators, pumps, tractors',       nameKm: 'ម៉ាស៊ីនធុនធ្ងន់',            life: 96,   salvagePct: 5,  book: 'straight_line', tax: '4',          acct: 'machinery',  vehicle: true },
  { key: 'tools',          name: 'Tools & other equipment',                      nameKm: 'ឧបករណ៍ផ្សេងៗ',             life: 60,   salvagePct: 0,  book: 'straight_line', tax: '4',          acct: 'machinery',  vehicle: false },
  { key: 'intangible',     name: 'Other intangibles',                            nameKm: 'ទ្រព្យអរូបី',                life: 60,   salvagePct: 0,  book: 'straight_line', tax: 'intangible', acct: 'intangible', vehicle: false },
];

/* ─── settings ───────────────────────────────────────────────── */

const DEFAULT_SETTINGS = {
  registerStartDate: '2026-01-01',          // §13a: the owner chose 1 Jan 2026
  tagPrefix: null,                          // null → 2–4 letters from the company name
  capitalizationThresholdMinor: 30000,      // $300 (§13a), overridable per asset
  capitalizationThresholdCurrency: 'USD',
  convention: 'mid_month',
  autoPostDepreciation: true,               // A2's background run
  taxYearEndMonth: 12,
  photoCapPerAsset: 20,
  scanPhotoRetentionMonths: 24,
};

function companyName(companyId) {
  try { return require('./companies').get(companyId)?.name || ''; } catch (_) { return ''; }
}

function storedSettings(companyId) {
  const row = companyId ? getDb().prepare('SELECT settings_json FROM asset_settings WHERE company_id = ?').get(companyId) : null;
  return parseJson(row?.settings_json, {});
}

function getSettings(companyId) {
  const s = { ...DEFAULT_SETTINGS, ...storedSettings(companyId) };
  s.tagPrefix = s.tagPrefix || defaultTagPrefix(companyName(companyId));
  return s;
}

/** Anything posted from the register start (an opening or a purchase)? Then the start date is fixed. */
function hasPostedAssetEntries(companyId) {
  return !!getDb().prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND source_kind IN ('asset_open', 'asset_acquire') LIMIT 1").get(companyId);
}

function sanitizeSettingsPatch(companyId, patch = {}) {
  const out = {};
  if ('registerStartDate' in patch) {
    const d = String(patch.registerStartDate || '');
    if (!isCalendarDate(d) || !d.endsWith('-01')) throw badRequest('The register start date must be the first of a month, like 2026-01-01');
    if (d !== getSettings(companyId).registerStartDate && hasPostedAssetEntries(companyId)) {
      throw badRequest('Opening values and purchases are already posted from the current start date, so it can no longer change');
    }
    out.registerStartDate = d;
  }
  if ('tagPrefix' in patch) out.tagPrefix = patch.tagPrefix ? normalizePrefix(patch.tagPrefix) : null;
  if ('capitalizationThresholdMinor' in patch) {
    const n = int(patch.capitalizationThresholdMinor);
    if (n == null || n < 0) throw badRequest('The threshold is a whole number of US cents, 0 or more');
    out.capitalizationThresholdMinor = n;
  }
  if ('capitalizationThresholdCurrency' in patch) {
    if (patch.capitalizationThresholdCurrency !== 'USD') throw badRequest('The threshold is kept in USD');
    out.capitalizationThresholdCurrency = 'USD';
  }
  if ('convention' in patch) {
    if (!CONVENTIONS.includes(patch.convention)) throw badRequest('convention must be mid_month or full_month');
    if (patch.convention !== getSettings(companyId).convention && hasPostedAssetEntries(companyId)) {
      throw badRequest('Assets are already posted with the current convention, so it can no longer change');
    }
    out.convention = patch.convention;
  }
  if ('autoPostDepreciation' in patch) out.autoPostDepreciation = !!patch.autoPostDepreciation;
  if ('taxYearEndMonth' in patch) {
    const m = int(patch.taxYearEndMonth);
    if (m == null || m < 1 || m > 12) throw badRequest('Tax year end month is 1–12');
    out.taxYearEndMonth = m;
  }
  if ('photoCapPerAsset' in patch) {
    const n = int(patch.photoCapPerAsset);
    if (n == null || n < 1 || n > 50) throw badRequest('Photos per asset must be 1–50');
    out.photoCapPerAsset = n;
  }
  if ('scanPhotoRetentionMonths' in patch) {
    const n = int(patch.scanPhotoRetentionMonths);
    if (n == null || n < 6 || n > 120) throw badRequest('Scan photo retention must be 6–120 months');
    out.scanPhotoRetentionMonths = n;
  }
  return out;
}

function updateSettings(companyId, patch) {
  if (!companyId) throw badRequest('Company is required');
  const clean = sanitizeSettingsPatch(companyId, patch || {});
  const before = getSettings(companyId);
  const next = { ...storedSettings(companyId), ...clean };
  getDb().prepare(`
    INSERT INTO asset_settings (company_id, settings_json, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id
  `).run(companyId, JSON.stringify(next), Date.now(), getCallerUserId());
  const diff = require('./auditLog').diffPatch(before, clean);
  if (diff) audit('asset_settings', companyId, 'update', diff);
  return getSettings(companyId);
}

/* ─── categories ─────────────────────────────────────────────── */

function rowToCategory(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, builtinKey: r.builtin_key ?? null, isBuiltin: !!r.builtin_key,
    nameEn: r.name_en, nameKm: r.name_km ?? null, tagPrefix: r.tag_prefix ?? null,
    defaultLifeMonths: r.default_life_months ?? null, defaultSalvagePct: r.default_salvage_pct ?? 0,
    bookMethod: r.book_method, taxClass: r.tax_class,
    glCostAccountId: r.gl_cost_account_id ?? null, glAccumAccountId: r.gl_accum_account_id ?? null, glExpenseAccountId: r.gl_expense_account_id ?? null,
    isVehicle: !!r.is_vehicle, sort: r.sort, archived: !!r.archived_at,
    assetCount: r.asset_count ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Idempotent: the chart and the built-in categories exist for this company. */
function ensureCategories(companyId) {
  if (!companyId) return;
  const db = getDb();
  const have = db.prepare('SELECT COUNT(*) AS n FROM asset_categories WHERE company_id = ? AND builtin_key IS NOT NULL').get(companyId).n;
  if (have >= BUILTIN_CATEGORIES.length) return;
  ledger.ensureChart(companyId);
  const acct = (key) => db.prepare('SELECT id FROM gl_accounts WHERE company_id = ? AND system_key = ?').get(companyId, key)?.id ?? null;
  const expense = acct('fa.dep_expense');
  const now = Date.now();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO asset_categories (id, company_id, builtin_key, name_en, name_km, default_life_months, default_salvage_pct,
      book_method, tax_class, gl_cost_account_id, gl_accum_account_id, gl_expense_account_id, is_vehicle, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    BUILTIN_CATEGORIES.forEach((c, i) => ins.run(uuid(), companyId, c.key, c.name, c.nameKm, c.life, c.salvagePct, c.book, c.tax,
      acct(`fa.cost.${c.acct}`), c.book === 'none' ? null : acct(`fa.accum.${c.acct}`), c.book === 'none' ? null : expense,
      c.vehicle ? 1 : 0, i, now, now));
  })();
}

const CATEGORY_SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM fixed_assets a WHERE a.category_id = c.id AND a.record_state <> 'cancelled') AS asset_count
    FROM asset_categories c`;

function listCategories(companyId, { includeArchived = false } = {}) {
  if (!companyId) return [];
  ensureCategories(companyId);
  return getDb().prepare(`${CATEGORY_SELECT} WHERE c.company_id = ? ${includeArchived ? '' : 'AND c.archived_at IS NULL'} ORDER BY c.sort, c.name_en`)
    .all(companyId).map(rowToCategory);
}

function getCategory(id) {
  if (!id) return null;
  return rowToCategory(getDb().prepare(`${CATEGORY_SELECT} WHERE c.id = ?`).get(id));
}

function categoryByKey(companyId, key) {
  ensureCategories(companyId);
  return rowToCategory(getDb().prepare(`${CATEGORY_SELECT} WHERE c.company_id = ? AND c.builtin_key = ?`).get(companyId, key));
}

function account(companyId, id, label) {
  if (id == null || id === '') return null;
  const a = ledger.getAccount(id);
  if (!a || a.companyId !== companyId) throw badRequest(`${label}: that account is not in this company's chart`);
  if (a.archived) throw badRequest(`${label}: account ${a.code} is archived`);
  return a.id;
}

function lifeMonths(v) {
  if (v == null || v === '') return null;
  const n = int(v);
  if (n == null || n < 1 || n > 1200) throw badRequest('Useful life must be 1–1200 months');
  return n;
}

function salvagePct(v) {
  const n = num(v);
  if (n == null) return 0;
  if (n < 0 || n > 100) throw badRequest('Salvage is 0–100 % of cost');
  return n;
}

function taxClassOf(v) {
  const s = String(v ?? '');
  if (!TAX_CLASS_KEYS.includes(s)) throw badRequest(`Tax class must be one of ${TAX_CLASS_KEYS.join(', ')}`);
  return s;
}

function bookMethod(v) {
  const s = v ?? 'straight_line';
  if (!BOOK_METHODS.includes(s)) throw badRequest('Book method must be straight_line or none');
  return s;
}

function createCategory(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  ensureCategories(companyId);
  const nameEn = str(input.nameEn, 120);
  if (!nameEn) throw badRequest('A category name is required');
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM asset_categories WHERE company_id = ?').get(companyId).m;
  const method = bookMethod(input.bookMethod);
  db.prepare(`
    INSERT INTO asset_categories (id, company_id, builtin_key, name_en, name_km, tag_prefix, default_life_months, default_salvage_pct,
      book_method, tax_class, gl_cost_account_id, gl_accum_account_id, gl_expense_account_id, is_vehicle, sort, created_at, updated_at, updated_by_user_id)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, nameEn, str(input.nameKm, 120), input.tagPrefix ? normalizePrefix(input.tagPrefix) : null,
    method === 'none' ? null : lifeMonths(input.defaultLifeMonths), salvagePct(input.defaultSalvagePct), method,
    taxClassOf(input.taxClass ?? '4'),
    account(companyId, input.glCostAccountId, 'Cost account') ?? ledger.accountByKey(companyId, 'fa.cost.machinery').id,
    method === 'none' ? null : (account(companyId, input.glAccumAccountId, 'Accumulated depreciation account') ?? ledger.accountByKey(companyId, 'fa.accum.machinery').id),
    method === 'none' ? null : (account(companyId, input.glExpenseAccountId, 'Expense account') ?? ledger.accountByKey(companyId, 'fa.dep_expense').id),
    input.isVehicle ? 1 : 0, maxSort + 1, now, now, getCallerUserId());
  const created = getCategory(id);
  audit('asset_category', id, 'create', { after: created });
  return created;
}

/** Has anything in this category been posted to the journal? (then tax class / accounts are admin-only) */
function categoryHasPostings(categoryId) {
  return !!getDb().prepare(`
    SELECT 1 FROM journal_lines l JOIN fixed_assets a ON a.id = l.asset_id WHERE a.category_id = ? LIMIT 1
  `).get(categoryId);
}

const GUARDED_FIELDS = ['taxClass', 'glCostAccountId', 'glAccumAccountId', 'glExpenseAccountId', 'bookMethod'];

/**
 * Edit a category. Affects NEW assets only (defaults are copied at creation).
 * `opts.allowPostedChanges` is the admin's right to change the tax class or the
 * account mapping once assets in the category have posted (§9).
 */
function updateCategory(id, patch = {}, { allowPostedChanges = false } = {}) {
  const existing = getCategory(id);
  if (!existing) throw notFound('Category');
  const touchesGuarded = GUARDED_FIELDS.some((k) => k in patch && patch[k] !== existing[k]);
  if (touchesGuarded && !allowPostedChanges && categoryHasPostings(id)) {
    const err = badRequest('Assets in this category have already been posted — only an admin can change its tax class, book method or accounts');
    err.code = 'ADMIN_ONLY';
    throw err;
  }
  const c = existing.companyId;
  const map = {
    nameEn: ['name_en', (v) => { const s = str(v, 120); if (!s) throw badRequest('A category name cannot be empty'); return s; }],
    nameKm: ['name_km', (v) => str(v, 120)],
    tagPrefix: ['tag_prefix', (v) => (v ? normalizePrefix(v) : null)],
    defaultLifeMonths: ['default_life_months', (v) => lifeMonths(v)],
    defaultSalvagePct: ['default_salvage_pct', (v) => salvagePct(v)],
    bookMethod: ['book_method', (v) => bookMethod(v)],
    taxClass: ['tax_class', (v) => taxClassOf(v)],
    glCostAccountId: ['gl_cost_account_id', (v) => { const a = account(c, v, 'Cost account'); if (!a) throw badRequest('A cost account is required'); return a; }],
    glAccumAccountId: ['gl_accum_account_id', (v) => account(c, v, 'Accumulated depreciation account')],
    glExpenseAccountId: ['gl_expense_account_id', (v) => account(c, v, 'Expense account')],
    isVehicle: ['is_vehicle', (v) => (v ? 1 : 0)],
    sort: ['sort', (v) => int(v) ?? 0],
    archived: ['archived_at', (v) => (v ? Date.now() : null)],
  };
  const sets = [];
  const params = { id };
  const changed = {};
  for (const [k, [col, conv]] of Object.entries(map)) {
    if (!(k in patch)) continue;
    const v = conv(patch[k]);
    sets.push(`${col} = @${k}`);
    params[k] = v;
    changed[k] = ['isVehicle', 'archived'].includes(k) ? !!patch[k] : v;
  }
  if (!sets.length) return existing;
  params.updatedAt = nextUpdatedAt(existing.updatedAt);
  params.by = getCallerUserId();
  getDb().prepare(`UPDATE asset_categories SET ${sets.join(', ')}, updated_at = @updatedAt, updated_by_user_id = @by WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('asset_category', id, 'update', diff);
  return getCategory(id);
}

module.exports = {
  BUILTIN_CATEGORIES, DEFAULT_SETTINGS, GUARDED_FIELDS,
  getSettings, updateSettings, hasPostedAssetEntries,
  ensureCategories, listCategories, getCategory, categoryByKey, createCategory, updateCategory, categoryHasPostings,
};
