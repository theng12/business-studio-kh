/**
 * Fixed Assets A1: import from Excel / CSV (docs/ASSETS_AND_BRANCHES_PLAN.md §8.1;
 * AGENTS.md §11 — pick file → map columns → review results).
 *
 * The screen reads the file on the Mac it runs on (`files:pickWorkbook` /
 * `files:parseWorkbook`, now open to assets.manage too), maps each column to
 * one of IMPORT_COLUMNS (auto-guessed from the header through `aliases`), and
 * sends the mapped rows here:
 *
 *   assets:importPlan   dry run — what each row would do, with its warnings
 *   assets:importApply  the same plan, carried out
 *
 * Rules:
 *   - Upsert by TAG CODE. A row with a tag that exists updates that asset; a
 *     valid tag that does not exist yet creates the asset with it; a blank tag
 *     matches an existing asset by name + serial number, else creates one with
 *     a newly allocated tag.
 *   - Only filled cells change anything — a missing or empty cell never blanks
 *     a field.
 *   - Imported assets are DRAFTS; activating (which posts) stays a deliberate
 *     step on the Mac.
 *   - On an ACTIVE asset, money and basis fields (cost, dates, life, salvage,
 *     category, the depreciate tick) are refused (those change through events);
 *     branch, custodian and status changes are recorded as transfer /
 *     custodian / status events with the reason "Import".
 *   - `fuel_vehicle` (a plate) links the asset to that unlinked Fuel vehicle.
 */

const XLSX = require('xlsx');
const { getDb } = require('./index');
const { badRequest, audit, todayPhnomPenh } = require('./_assetUtil');
const fixedAssets = require('./fixedAssets');
const config = require('./assetConfig');
const branchesDb = require('./branches');
const { parseTagCode } = require('../util/assetTagCode');

const MAX_ROWS = 5000;

const IMPORT_COLUMNS = [
  { key: 'tag_code', label: 'Tag code', aliases: ['tag', 'tag no', 'tag number', 'asset tag', 'asset code', 'code'], accepts: 'A tag like CK-04270. Blank = give it a new tag. An existing tag updates that asset.' },
  { key: 'name', label: 'Name', aliases: ['asset', 'asset name', 'item', 'description', 'name en'], accepts: 'Short name. Required for a new asset.' },
  { key: 'name_km', label: 'Name (Khmer)', aliases: ['khmer name', 'name km', 'ឈ្មោះ'], accepts: 'Khmer name (optional).' },
  { key: 'category', label: 'Category', aliases: ['type', 'asset type', 'group', 'class'], accepts: 'A category name from the Categories sheet. Required for a new asset.' },
  { key: 'branch', label: 'Branch', aliases: ['location', 'site', 'shop', 'branch code'], accepts: 'Branch code or name from the Branches sheet.' },
  { key: 'location_note', label: 'Location note', aliases: ['where', 'room', 'position'], accepts: 'Free text, e.g. showroom wall B.' },
  { key: 'custodian', label: 'Custodian (staff code)', aliases: ['custodian', 'staff', 'staff code', 'user', 'driver', 'responsible'], accepts: 'The staff code of the person responsible.' },
  { key: 'status', label: 'Status', aliases: ['state', 'condition'], accepts: 'in use, in storage or in repair.' },
  { key: 'serial_no', label: 'Serial number', aliases: ['serial', 'sn', 's/n', 'serial number'], accepts: 'Maker\'s serial number.' },
  { key: 'make_model', label: 'Make / model', aliases: ['make', 'model', 'brand', 'make model'], accepts: 'e.g. Isuzu NPR, Apple iMac 24".' },
  { key: 'plate_no', label: 'Plate number', aliases: ['plate', 'licence plate', 'license plate', 'registration plate'], accepts: 'Vehicles only.' },
  { key: 'supplier', label: 'Supplier', aliases: ['vendor', 'bought from', 'seller'], accepts: 'A supplier name already in Operations → Suppliers.' },
  { key: 'purchase_date', label: 'Purchase date', aliases: ['bought', 'date bought', 'purchased', 'buy date', 'acquisition date'], accepts: 'YYYY-MM-DD, or day/month/year.' },
  { key: 'in_service_date', label: 'In-service date', aliases: ['in service', 'in use from', 'start date', 'first used'], accepts: 'When it was first used (defaults to the purchase date for old assets).' },
  { key: 'cost', label: 'Cost', aliases: ['price', 'purchase price', 'amount', 'cost usd'], accepts: 'What it cost, in dollars (or riel with cost_currency KHR). Without VAT if VAT was reclaimed.' },
  { key: 'cost_currency', label: 'Cost currency', aliases: ['currency', 'ccy'], accepts: 'USD (default) or KHR.' },
  { key: 'value_at_start', label: 'Value at start date', aliases: ['opening value', 'deemed cost', 'value now', 'current value'], accepts: 'For old things whose cost is unknown: its value on the register start date, in the cost currency.' },
  { key: 'remaining_life_months', label: 'Months of life left', aliases: ['remaining life', 'life left', 'remaining months'], accepts: 'With value_at_start: how many more months it will be used.' },
  { key: 'useful_life_months', label: 'Useful life (months)', aliases: ['life', 'useful life', 'life months'], accepts: 'Total life in months (defaults to the category\'s).' },
  { key: 'salvage', label: 'Salvage value', aliases: ['residual', 'residual value', 'scrap value'], accepts: 'What it will be worth at the end, in US dollars (defaults to the category\'s %).' },
  { key: 'depreciate', label: 'Depreciate this item', aliases: ['capitalise', 'capitalize', 'depreciate item'], accepts: 'yes / no to override the $300 rule; blank follows it.' },
  { key: 'warranty_until', label: 'Warranty until', aliases: ['warranty', 'warranty end'], accepts: 'YYYY-MM-DD.' },
  { key: 'insurance_until', label: 'Insurance until', aliases: ['insurance', 'insurance end'], accepts: 'YYYY-MM-DD (vehicles).' },
  { key: 'road_tax_until', label: 'Road tax until', aliases: ['road tax', 'tax sticker'], accepts: 'YYYY-MM-DD (vehicles).' },
  { key: 'notes', label: 'Notes', aliases: ['note', 'comment', 'comments', 'remarks'], accepts: 'Anything else.' },
  { key: 'fuel_vehicle', label: 'Fuel vehicle (plate)', aliases: ['fuel plate', 'fuel link'], accepts: 'The plate of a vehicle already in Fuel, to link the two.' },
];
const COLUMN_KEYS = new Set(IMPORT_COLUMNS.map((c) => c.key));

/** Fields that only a draft may take from an import (on an active asset they change through events). */
const MONEY_FIELDS = ['category', 'purchase_date', 'in_service_date', 'cost', 'cost_currency', 'value_at_start',
  'remaining_life_months', 'useful_life_months', 'salvage', 'depreciate', 'supplier'];

/* ─── cell parsing ────────────────────────────────────────────── */

function cell(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  return s ? s : null;
}

/** 'YYYY-MM-DD', day/month/year (Cambodian order), or an Excel serial number. */
function parseDate(v) {
  if (v == null) return null;
  if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(String(v))) {
    const serial = Number(v);
    if (serial > 20000 && serial < 80000) return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y; let mo; let d;
  if (m) { [, y, mo, d] = m; } else {
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (!m) throw badRequest(`"${s}" is not a date — use YYYY-MM-DD or day/month/year`);
    [, d, mo, y] = m;
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) throw badRequest(`"${s}" is not a real date`);
  return iso;
}

/** "1,500,000", "$24,000.50", "24000" → minor units of the currency (cents for USD, riel for KHR). */
function parseMoney(v, currency) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[\s,$៛]|USD|KHR|riel/gi, ''));
  if (!Number.isFinite(n) || n < 0) throw badRequest(`"${v}" is not an amount`);
  return currency === 'KHR' ? Math.round(n) : Math.round(n * 100);
}

function parseMonths(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  if (!Number.isInteger(n) || n < 1 || n > 1200) throw badRequest(`"${v}" is not a number of months (1–1200)`);
  return n;
}

function parseStatus(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map = { in_use: 'in_use', use: 'in_use', using: 'in_use', active: 'in_use', in_storage: 'in_storage', storage: 'in_storage', stored: 'in_storage', idle: 'in_storage', in_repair: 'in_repair', repair: 'in_repair', broken: 'in_repair' };
  if (!map[s]) throw badRequest(`Status "${v}" — use in use, in storage or in repair`);
  return map[s];
}

function parseYesNo(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'x', 'ok'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  throw badRequest(`"${v}" — use yes or no`);
}

/* ─── lookups ─────────────────────────────────────────────────── */

function lookups(companyId) {
  const db = getDb();
  const lc = (s) => String(s ?? '').trim().toLowerCase();
  const cats = config.listCategories(companyId);
  const catBy = new Map();
  for (const c of cats) for (const k of [c.nameEn, c.nameKm, c.builtinKey]) if (k) catBy.set(lc(k), c);
  const branchBy = new Map();
  for (const b of branchesDb.list(companyId, { status: 'active' })) for (const k of [b.code, b.nameEn, b.nameKm]) if (k) branchBy.set(lc(k), b);
  const staffBy = new Map();
  for (const e of db.prepare("SELECT id, staff_code, name_en, status FROM employees WHERE company_id = ?").all(companyId)) staffBy.set(lc(e.staff_code), e);
  const supplierBy = new Map();
  for (const s of db.prepare('SELECT id, name FROM suppliers WHERE company_id = ?').all(companyId)) supplierBy.set(lc(s.name), s);
  const fuelBy = new Map();
  for (const f of db.prepare(`SELECT f.id, f.plate_or_serial, (SELECT a.id FROM fixed_assets a WHERE a.fuel_asset_id = f.id) AS linked FROM fuel_assets f WHERE f.company_id = ? AND f.plate_or_serial IS NOT NULL`).all(companyId)) {
    fuelBy.set(lc(f.plate_or_serial).replace(/\s+/g, ''), f);
  }
  return { lc, catBy, branchBy, staffBy, supplierBy, fuelBy };
}

/* ─── planning ────────────────────────────────────────────────── */

/**
 * Work out one row: { rowNo, action, assetId, tagCode, values, events, link, warnings, errors }.
 * `seenTags` catches a tag used twice in one file.
 */
function planRow(companyId, raw, rowNo, L, settings, seenTags) {
  const out = { rowNo, action: 'skip', assetId: null, tagCode: null, values: {}, events: [], link: null, warnings: [], errors: [] };
  const row = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (!COLUMN_KEYS.has(k)) continue;
    const c = cell(v);
    if (c != null) row[k] = c;
  }
  if (!Object.keys(row).length) { out.warnings.push('Empty row'); return out; }
  const fail = (msg) => { out.errors.push(msg); out.action = 'error'; return out; };
  const tryField = (label, fn) => {
    try { return fn(); } catch (err) { out.errors.push(`${label}: ${err.message}`); return undefined; }
  };

  // Which asset?
  let existing = null;
  if (row.tag_code != null) {
    const p = parseTagCode(row.tag_code, { defaultPrefix: settings.tagPrefix });
    if (!p.ok) return fail(`Tag code "${row.tag_code}" is not valid${p.reason === 'check' ? ' (its check digit does not match)' : ''}`);
    if (seenTags.has(p.code)) return fail(`Tag ${p.code} appears twice in this file`);
    seenTags.add(p.code);
    out.tagCode = p.code;
    existing = fixedAssets.getByTag(companyId, p.code);
    if (!existing && fixedAssets.tagUsed(companyId, p.code) === 'retired') return fail(`Tag ${p.code} was retired and cannot be used again`);
  } else if (row.name != null && row.serial_no != null) {
    const matches = getDb().prepare(`SELECT id FROM fixed_assets WHERE company_id = ? AND record_state <> 'cancelled' AND name = ? COLLATE NOCASE AND serial_no = ? COLLATE NOCASE`).all(companyId, String(row.name), String(row.serial_no));
    if (matches.length === 1) existing = fixedAssets.get(matches[0].id);
    else if (matches.length > 1) out.warnings.push('Several assets have this name and serial — a new one will be created; add the tag code to update one');
  }
  if (existing && existing.recordState === 'cancelled') return fail(`${existing.tagCode} is a cancelled draft`);
  const active = existing?.recordState === 'active';
  out.action = existing ? 'update' : 'create';
  out.assetId = existing?.id ?? null;
  if (existing) out.tagCode = existing.tagCode;
  if (!existing && row.name == null) return fail('A new asset needs a name');
  if (!existing && row.category == null) return fail('A new asset needs a category');

  const v = out.values;
  const currency = row.cost_currency != null ? tryField('Cost currency', () => {
    const c = String(row.cost_currency).trim().toUpperCase().replace('$', 'USD').replace('៛', 'KHR');
    if (!['USD', 'KHR'].includes(c)) throw badRequest('use USD or KHR');
    return c;
  }) : (existing?.costCurrency || 'USD');

  for (const k of MONEY_FIELDS) {
    if (active && row[k] != null) {
      out.warnings.push(`${IMPORT_COLUMNS.find((c) => c.key === k).label} not changed: ${existing.tagCode} is active — use its events instead`);
      delete row[k];
    }
  }

  if (row.name != null) v.name = String(row.name).slice(0, 160);
  for (const [col, key, max] of [['name_km', 'nameKm', 160], ['location_note', 'locationNote', 200], ['serial_no', 'serialNo', 120],
    ['make_model', 'makeModel', 160], ['plate_no', 'plateNo', 40], ['notes', 'notes', 4000]]) {
    if (row[col] != null) v[key] = String(row[col]).slice(0, max);
  }
  if (row.category != null) {
    const c = L.catBy.get(L.lc(row.category));
    if (!c) out.errors.push(`Category "${row.category}" is not one of this company's categories`);
    else v.categoryId = c.id;
  }
  if (row.supplier != null) {
    const s = L.supplierBy.get(L.lc(row.supplier));
    if (!s) out.warnings.push(`Supplier "${row.supplier}" not found — left blank`);
    else v.supplierId = s.id;
  }
  for (const [col, key] of [['purchase_date', 'purchaseDate'], ['in_service_date', 'inServiceDate'], ['warranty_until', 'warrantyUntil'],
    ['insurance_until', 'insuranceUntil'], ['road_tax_until', 'roadTaxUntil']]) {
    if (row[col] != null) { const d = tryField(col, () => parseDate(row[col])); if (d) v[key] = d; }
  }
  if (row.cost_currency != null && currency) v.costCurrency = currency;
  if (row.value_at_start != null) {
    const m = tryField('Value at start date', () => parseMoney(row.value_at_start, currency));
    if (m != null) { v.costMinor = m; v.acquisitionKind = 'opening'; v.costBasis = 'deemed'; v.costCurrency = currency; }
    if (row.cost != null) out.warnings.push('Both cost and value at start were given — the value at start is used');
    if (row.remaining_life_months != null) { const n = tryField('Months of life left', () => parseMonths(row.remaining_life_months)); if (n) v.usefulLifeMonths = n; }
  } else if (row.cost != null) {
    const m = tryField('Cost', () => parseMoney(row.cost, currency));
    if (m != null) { v.costMinor = m; v.costCurrency = currency; }
  }
  if (row.useful_life_months != null && v.costBasis !== 'deemed') { const n = tryField('Useful life', () => parseMonths(row.useful_life_months)); if (n) v.usefulLifeMonths = n; }
  // Salvage is a book figure, kept in US dollars whatever the cost currency.
  if (row.salvage != null) { const m = tryField('Salvage', () => parseMoney(row.salvage, 'USD')); if (m != null) v.salvageMinor = m; }
  if (row.depreciate != null) { const b = tryField('Depreciate this item', () => parseYesNo(row.depreciate)); if (b != null) v.depreciateOverride = b; }
  // Opening vs purchase, from the dates, when the row says nothing else.
  if (v.costBasis !== 'deemed' && v.purchaseDate && !active) {
    v.acquisitionKind = v.purchaseDate < settings.registerStartDate ? 'opening' : 'purchase';
    if (v.acquisitionKind === 'opening') v.costBasis = 'actual';
  }

  // Where and who.
  let branchId;
  let custodianId;
  let status;
  if (row.branch != null) {
    const b = L.branchBy.get(L.lc(row.branch));
    if (!b) out.errors.push(`Branch "${row.branch}" is not an open branch of this company`);
    else branchId = b.id;
  }
  if (row.custodian != null) {
    const e = L.staffBy.get(L.lc(row.custodian));
    if (!e) out.errors.push(`Staff code "${row.custodian}" not found`);
    else if (e.status === 'left') out.errors.push(`Staff ${row.custodian} has left`);
    else custodianId = e.id;
  }
  if (row.status != null) status = tryField('Status', () => parseStatus(row.status));
  if (active) {
    if ((branchId && branchId !== existing.branchId) || (custodianId && custodianId !== existing.custodianEmployeeId)) {
      out.events.push({ kind: 'transfer', toBranchId: branchId, toEmployeeId: custodianId });
    }
    if (status && status !== existing.status) out.events.push({ kind: 'status', status });
  } else {
    if (branchId) v.branchId = branchId;
    if (custodianId) v.custodianEmployeeId = custodianId;
    if (status) v.status = status;
  }

  if (row.fuel_vehicle != null) {
    const f = L.fuelBy.get(L.lc(row.fuel_vehicle).replace(/\s+/g, ''));
    if (!f) out.warnings.push(`No Fuel vehicle with plate "${row.fuel_vehicle}"`);
    else if (f.linked && f.linked !== existing?.id) out.warnings.push(`Fuel vehicle ${row.fuel_vehicle} is already linked to another asset`);
    else if (!existing?.fuelAssetId) out.link = f.id;
  }

  // An update that changes nothing is a skip.
  if (existing) {
    for (const [k, val] of Object.entries(v)) if (existing[k] === val) delete v[k];
    if (!Object.keys(v).length && !out.events.length && !out.link) out.action = 'skip';
  }
  if (out.errors.length) out.action = 'error';
  return out;
}

function planImport(companyId, rows) {
  if (!companyId) throw badRequest('Company is required');
  if (!Array.isArray(rows)) throw badRequest('rows must be a list');
  if (rows.length > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS.toLocaleString('en-US')} rows in one import`);
  config.ensureCategories(companyId);
  const settings = config.getSettings(companyId);
  const L = lookups(companyId);
  const seen = new Set();
  const plan = rows.map((r, i) => planRow(companyId, r, i + 2, L, settings, seen)); // row 1 is the header
  const count = (a) => plan.filter((p) => p.action === a).length;
  return { rows: plan, summary: { total: plan.length, create: count('create'), update: count('update'), skip: count('skip'), error: count('error'), warnings: plan.reduce((t, p) => t + p.warnings.length, 0) } };
}

/** Carry out the plan. Rows with errors are skipped; each row is its own savepoint, so one failure never half-writes a row. */
function applyImport(companyId, rows) {
  const { rows: plan } = planImport(companyId, rows);
  const db = getDb();
  const result = { created: 0, updated: 0, skipped: 0, failed: 0, rows: [] };
  const identity = require('./assetIdentity');
  db.transaction(() => {
    for (const p of plan) {
      if (p.action === 'skip' || p.action === 'error') {
        result[p.action === 'skip' ? 'skipped' : 'failed'] += 1;
        result.rows.push({ rowNo: p.rowNo, action: p.action, tagCode: p.tagCode, errors: p.errors, warnings: p.warnings });
        continue;
      }
      try {
        const done = db.transaction(() => {
          let asset;
          if (p.action === 'create') {
            asset = fixedAssets.create({ companyId, ...p.values, tagCode: p.tagCode || undefined, origin: 'import' });
          } else {
            asset = Object.keys(p.values).length ? fixedAssets.update(p.assetId, p.values) : fixedAssets.get(p.assetId);
            for (const e of p.events) {
              if (e.kind === 'transfer') {
                fixedAssets.transfer({ companyId, assetIds: [asset.id], date: todayPhnomPenh(), reason: 'Import',
                  ...(e.toBranchId ? { toBranchId: e.toBranchId } : {}), ...(e.toEmployeeId ? { toEmployeeId: e.toEmployeeId } : {}) });
              }
              if (e.kind === 'status') fixedAssets.setStatus({ id: asset.id, status: e.status, reason: 'Import' });
            }
          }
          if (p.link) identity.link(asset.id, p.link);
          return fixedAssets.get(asset.id);
        })();
        result[p.action === 'create' ? 'created' : 'updated'] += 1;
        result.rows.push({ rowNo: p.rowNo, action: p.action, assetId: done.id, tagCode: done.tagCode, warnings: p.warnings, errors: [] });
      } catch (err) {
        result.failed += 1;
        result.rows.push({ rowNo: p.rowNo, action: 'error', tagCode: p.tagCode, errors: [err.message], warnings: p.warnings });
      }
    }
  })();
  audit('fixed_asset', companyId, 'import', { after: { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed } });
  return result;
}

/**
 * "Download sample": the full column set, an Instructions sheet (one row per
 * column), and this company's categories and branches.
 */
function sampleWorkbook(companyId) {
  config.ensureCategories(companyId);
  const settings = config.getSettings(companyId);
  const wb = XLSX.utils.book_new();
  const example = {
    tag_code: '', name: 'Isuzu truck', name_km: 'ឡានដឹកទំនិញ', category: 'Trucks', branch: '', location_note: '', custodian: '',
    status: 'in use', serial_no: '', make_model: 'Isuzu NPR', plate_no: '3A-1234', supplier: '', purchase_date: '2020-06-01',
    in_service_date: '2020-06-01', cost: 30000, cost_currency: 'USD', value_at_start: '', remaining_life_months: '',
    useful_life_months: 120, salvage: 3000, depreciate: '', warranty_until: '', insurance_until: '', road_tax_until: '', notes: '', fuel_vehicle: '',
  };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([IMPORT_COLUMNS.map((c) => c.key), IMPORT_COLUMNS.map((c) => example[c.key] ?? '')]), 'Assets');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Column', 'What it is', 'Accepts'],
    ...IMPORT_COLUMNS.map((c) => [c.key, c.label, c.accepts]),
    [],
    ['Register start date', settings.registerStartDate, 'Bought before this date = an old asset (opening value). On or after = a new purchase.'],
    ['Capitalisation threshold', `$${(settings.capitalizationThresholdMinor / 100).toFixed(2)}`, 'Cheaper items are tracked, not depreciated, unless "depreciate" says yes.'],
    ['Updates', '', 'Only filled cells change an existing asset; an empty cell never clears anything. Imported assets are drafts until activated.'],
  ]), 'Instructions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Category', 'Khmer', 'Default life (months)', 'Default salvage %', 'Tax class (confirm with accountant)'],
    ...config.listCategories(companyId).map((c) => [c.nameEn, c.nameKm ?? '', c.defaultLifeMonths ?? '—', c.defaultSalvagePct, c.taxClass]),
  ]), 'Categories');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Branch code', 'Name', 'Khmer'],
    ...branchesDb.list(companyId, { status: 'active' }).map((b) => [b.code, b.nameEn, b.nameKm ?? '']),
  ]), 'Branches');
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { filename: 'fixed-assets-import-sample.xlsx', bytes };
}

function importColumns() {
  return IMPORT_COLUMNS.map((c) => ({ ...c, aliases: [...c.aliases], draftOnly: MONEY_FIELDS.includes(c.key) }));
}

module.exports = { IMPORT_COLUMNS, MAX_ROWS, planImport, applyImport, sampleWorkbook, importColumns, parseDate, parseMoney };
