/**
 * Fixed Assets A1 + A2 — the screens' view model. Pure functions only (no
 * React, no window.api), so test/assetsUiModel.test.js checks the wording, the
 * forms, which actions an asset offers, the schedule and run states, the
 * import mapping and the report tables without a browser.
 *
 * Conventions from the backend (docs/ASSETS_AND_BRANCHES_PLAN.md §14):
 *   - dates are 'YYYY-MM-DD' and periods 'YYYY-MM', in Phnom Penh;
 *   - every book figure is US cents; tax figures are riel; an asset's own
 *     cost is in its `costCurrency` (USD cents or whole riel);
 *   - riel shown next to a book figure is at the HOUSE rate, for display only.
 */

import { ppDateKey, ppMonthKey, monthLabel, parseNumber } from '../Fuel/fuelModel.js';
import { formatPrice } from '../../lib/currencies.js';

export { ppDateKey, ppMonthKey, monthLabel };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pad = (n) => String(n).padStart(2, '0');

/* ─── dates ───────────────────────────────────────────────────────────── */

export const todayKey = (now = Date.now()) => ppDateKey(now);
export const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
export const isPeriod = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));

/** "12 Mar 2026" for '2026-03-12' (a calendar day — never shifted by the Mac's zone). */
export function fmtYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '—';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Mar 2026" for '2026-03' (short, for table cells). */
export function fmtPeriodShort(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return '—';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
    .toLocaleDateString(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' });
}

export const fmtPeriod = (p) => (isPeriod(p) ? monthLabel(p) : '—');

/** The period `n` months after `period` (negative = before). */
export function addMonths(period, n) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** The last month that has ENDED (Phnom Penh): October 8 → September. */
export const lastEndedPeriod = (now = Date.now()) => addMonths(ppMonthKey(now), -1);

/* ─── money ───────────────────────────────────────────────────────────── */

/** "$1,234.56" from US cents; negative keeps its sign ("−$12.00"). */
export function fmtUsd(minor) {
  if (!isNum(minor)) return '—';
  const s = formatPrice(Math.abs(minor) / 100, 'USD');
  return minor < 0 ? `−${s}` : s;
}

/** "៛1,250,000" from whole riel; negative keeps its sign. */
export function fmtKhr(riel) {
  if (!isNum(riel)) return '—';
  const s = formatPrice(Math.abs(Math.round(riel)), 'KHR');
  return riel < 0 ? `−${s}` : s;
}

/** An asset's own cost, in its own currency (cents or riel). */
export function fmtMoneyIn(minor, currency = 'USD') {
  return currency === 'KHR' ? fmtKhr(minor) : fmtUsd(minor);
}

/** Riel for a US-cent figure at a display rate (house), or null. */
export function rielOf(usdMinor, khrPerUsd) {
  if (!isNum(usdMinor) || !isNum(khrPerUsd) || khrPerUsd <= 0) return null;
  return Math.round((usdMinor * khrPerUsd) / 100);
}

/** "≈ ៛4,920,000" under a dollar figure, or '' when there is no rate. */
export function rielHint(usdMinor, khrPerUsd) {
  const r = rielOf(usdMinor, khrPerUsd);
  return r == null ? '' : `≈ ${fmtKhr(r)}`;
}

/**
 * A typed amount → minor units. Blank → `{ minor: null }`; not a number or
 * negative → `{ error }`. USD keeps two decimals (cents), riel is whole.
 */
export function parseMoney(text, currency = 'USD', { label = 'Amount', allowZero = true, allowNegative = false } = {}) {
  const n = parseNumber(text);
  if (n === null) return { minor: null };
  if (Number.isNaN(n)) return { error: `${label}: type a number like ${currency === 'KHR' ? '1,250,000' : '1,250.00'}` };
  if (!allowNegative && n < 0) return { error: `${label} cannot be negative` };
  if (!allowZero && n === 0) return { error: `${label} must be more than zero` };
  const minor = currency === 'KHR' ? Math.round(n) : Math.round(n * 100);
  return { minor };
}

/** Minor units → the text a money field starts with ('' for none). */
export function minorToInput(minor, currency = 'USD') {
  if (!isNum(minor)) return '';
  return currency === 'KHR' ? String(Math.round(minor)) : (minor / 100).toFixed(2);
}

/** A whole number of months (or anything) in a range; blank → null. */
export function parseWhole(text, { label = 'Value', min = 0, max = 1200 } = {}) {
  const n = parseNumber(text);
  if (n === null) return { value: null };
  if (Number.isNaN(n) || !Number.isInteger(n)) return { error: `${label}: type a whole number` };
  if (n < min || n > max) return { error: `${label} must be ${min}–${max}` };
  return { value: n };
}

/** "8 years" / "3 years 6 months" / "9 months" for a number of months. */
export function fmtLife(months) {
  if (!isNum(months) || months <= 0) return '—';
  const y = Math.floor(months / 12);
  const m = months % 12;
  const ys = y ? `${y} year${y === 1 ? '' : 's'}` : '';
  const ms = m ? `${m} month${m === 1 ? '' : 's'}` : '';
  return [ys, ms].filter(Boolean).join(' ');
}

/* ─── labels ──────────────────────────────────────────────────────────── */

export const STATUSES = [
  { value: 'in_use', label: 'In use', tone: 'emerald' },
  { value: 'in_storage', label: 'In storage', tone: 'slate' },
  { value: 'in_repair', label: 'In repair', tone: 'amber' },
  { value: 'disposed', label: 'Disposed', tone: 'slate' },
  { value: 'lost', label: 'Lost', tone: 'rose' },
];
/** The three a person can set; disposed / lost come only from those events. */
export const SETTABLE_STATUSES = STATUSES.slice(0, 3);
export const statusOf = (s) => STATUSES.find((x) => x.value === s) || { value: s, label: s || '—', tone: 'slate' };

export const RECORD_STATES = [
  { value: 'draft', label: 'Draft', tone: 'amber' },
  { value: 'active', label: 'Active', tone: 'emerald' },
  { value: 'cancelled', label: 'Cancelled', tone: 'slate' },
];
export const recordStateOf = (s) => RECORD_STATES.find((x) => x.value === s) || { value: s, label: s || '—', tone: 'slate' };

export const TREATMENTS = {
  capitalised: { label: 'Depreciated', short: 'Depreciated', tone: 'slate' },
  tracked_only: { label: 'Tracked, not capitalised', short: 'Tracked only', tone: 'blue' },
  not_depreciated: { label: 'Not depreciated', short: 'Not depreciated', tone: 'slate' },
};
export const treatmentLabel = (t) => TREATMENTS[t]?.label || '—';

export const ACQUISITION_KINDS = [
  { value: 'purchase', label: 'New purchase', hint: 'Bought on or after the register start, at full cost.' },
  { value: 'opening', label: 'Already owned', hint: 'Owned before the register start — enters at its value on that date.' },
  { value: 'gift', label: 'Gift', hint: 'Received free; enter what it is worth.' },
  { value: 'self_built', label: 'Built ourselves', hint: 'Made by the business; enter what it cost to build.' },
];
export const acquisitionLabel = (k) => ACQUISITION_KINDS.find((x) => x.value === k)?.label || k || '—';

export const DISPOSAL_KINDS = [
  { value: 'sale', label: 'Sold' },
  { value: 'scrap', label: 'Scrapped' },
  { value: 'donation', label: 'Given away' },
];

export const FILE_KINDS = [
  { value: 'photo', label: 'Photo' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'warranty', label: 'Warranty' },
  { value: 'registration', label: 'Registration card' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'other', label: 'Other document' },
];
export const fileKindLabel = (k) => FILE_KINDS.find((x) => x.value === k)?.label || k || 'File';

export const TAX_CLASSES = [
  { value: '1', label: 'Class 1 — buildings (5 % straight-line)' },
  { value: '1b', label: 'Class 1b — other buildings (10 % straight-line)' },
  { value: '2', label: 'Class 2 — computers & software (50 % pool)' },
  { value: '3', label: 'Class 3 — vehicles & furniture (25 % pool)' },
  { value: '4', label: 'Class 4 — other tangible (20 % pool)' },
  { value: 'intangible', label: 'Intangible (straight-line over its life)' },
  { value: 'land', label: 'Land (never depreciated)' },
  { value: 'none', label: 'None' },
];
export const taxClassLabel = (c) => TAX_CLASSES.find((x) => x.value === String(c))?.label || (c ? `Class ${c}` : '—');

export const BOOK_METHODS = [
  { value: 'straight_line', label: 'Straight-line' },
  { value: 'none', label: 'Not depreciated' },
];

export const CONVENTIONS = [
  { value: 'mid_month', label: 'Mid-month', hint: 'In use by the 15th: that month counts. Disposed by the 15th: that month does not.' },
  { value: 'full_month', label: 'Full month', hint: 'The month it goes into use counts; the month it is disposed of does not.' },
];

export const ATTENTION = [
  { value: 'needs_cost', label: 'Needs a cost' },
  { value: 'drafts', label: 'Drafts' },
  { value: 'no_photo', label: 'No photo' },
  { value: 'tags_not_printed', label: 'Tag not printed' },
  { value: 'warranty_ending', label: 'Warranty ending' },
  { value: 'insurance_due', label: 'Insurance due' },
  { value: 'road_tax_due', label: 'Road tax due' },
];

export const EVENT_LABELS = {
  acquire: 'Added to the books', open: 'Opening value', activate: 'Activated', transfer: 'Moved', custodian: 'Custodian changed',
  status: 'Status changed', repair: 'Repair', capex: 'Improvement', life_change: 'Life changed', salvage_change: 'Salvage changed',
  revalue: 'Revalued', impair: 'Impaired', dispose: 'Disposed of', partial_dispose: 'Part disposed of', lost: 'Written off as lost',
  found: 'Found again', note: 'Note', reversal: 'Reversal',
};
export const eventLabel = (k) => EVENT_LABELS[k] || k || 'Event';

/** Events that can be voided (no money): the server still checks "only the latest". */
export const VOIDABLE_EVENTS = new Set(['transfer', 'custodian', 'status', 'repair', 'note', 'life_change', 'salvage_change']);
/** Events that posted and can be reversed with a mirror entry. */
export const REVERSIBLE_EVENTS = new Set(['acquire', 'open', 'capex', 'dispose', 'partial_dispose', 'impair', 'revalue']);

export const LINE_ROLES = {
  cost: 'Cost', accum_dep: 'Accumulated depreciation', dep_expense: 'Depreciation', dep_catch_up: 'Depreciation catch-up',
  gain: 'Gain', loss: 'Loss', clearing: 'Clearing', equity: 'Opening equity', impairment: 'Impairment', revaluation: 'Revaluation',
  accum_disposal: 'Accumulated depreciation (disposal)', accum_reval: 'Accumulated depreciation (revaluation)',
};
export const lineRoleLabel = (r) => LINE_ROLES[r] || r || '';

export const SOURCE_KINDS = {
  asset_acquire: 'Purchase', asset_open: 'Opening value', asset_depreciation: 'Monthly depreciation', asset_dispose: 'Disposal',
  asset_lost: 'Write-off', asset_found: 'Found again', asset_revalue: 'Revaluation', asset_impair: 'Impairment', asset_capex: 'Improvement',
  reversal: 'Reversal',
};
export const sourceKindLabel = (k) => SOURCE_KINDS[k] || k || '';

/** A category as "Trucks" (+ Khmer when there is one). */
export function categoryName(c) {
  if (!c) return '—';
  return c.nameKm ? `${c.nameEn} · ${c.nameKm}` : c.nameEn;
}
export const branchLabel = (b) => (b ? `${b.code} · ${b.nameEn}` : 'No branch');
export function staffLabel(e) {
  if (!e) return '—';
  const name = e.nameEn || e.nameKm || e.staffCode || 'Unnamed';
  return e.staffCode ? `${name} · ${e.staffCode}` : name;
}
export function assetTitle(a) {
  if (!a) return '';
  return a.tagCode ? `${a.tagCode} · ${a.name}` : a.name;
}

export function indexById(list) {
  const m = new Map();
  for (const x of Array.isArray(list) ? list : []) if (x?.id) m.set(x.id, x);
  return m;
}

/** An account for a journal line: by id or by system key → "1520 Vehicles". */
export function accountLabel(ref, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const a = list.find((x) => x.id === ref) || list.find((x) => x.systemKey === ref);
  return a ? `${a.code} ${a.nameEn}` : String(ref || '—');
}

/* ─── the register's filters ──────────────────────────────────────────── */

export const EMPTY_FILTERS = Object.freeze({ q: '', branchId: '', categoryId: '', status: '', custodianEmployeeId: '', attention: '', recordState: '' });

export function filtersActive(f) {
  return Object.keys(EMPTY_FILTERS).some((k) => f && f[k]);
}

/** Filters + page → `assets:list` arguments (only the filters that are set). */
export function listArgs(f = EMPTY_FILTERS, page = 0, pageSize = 50) {
  const out = { limit: pageSize, offset: page * pageSize };
  if (f.q && f.q.trim()) out.q = f.q.trim();
  for (const k of ['branchId', 'categoryId', 'status', 'custodianEmployeeId', 'attention', 'recordState']) if (f[k]) out[k] = f[k];
  return out;
}

/* ─── "Depreciate this item" (§13a) ───────────────────────────────────── */

export const DEPRECIATE_CHOICES = [
  { value: 'auto', label: 'Decide by the threshold' },
  { value: 'yes', label: 'Yes — depreciate it' },
  { value: 'no', label: 'No — track it only' },
];
export const depreciateChoice = (override) => (override === true ? 'yes' : override === false ? 'no' : 'auto');
export const depreciateValue = (choice) => (choice === 'yes' ? true : choice === 'no' ? false : null);

/**
 * The tick in plain words. `override` is the asset's `depreciateOverride`
 * (true / false / null), `costUsdMinor` its cost in cents (may be unknown),
 * `thresholdMinor` the setting ($300 = 30000), `bookMethod` its category's.
 */
export function depreciateExplain({ override = null, costUsdMinor = null, thresholdMinor = 30000, bookMethod = 'straight_line' } = {}) {
  const limit = fmtUsd(thresholdMinor);
  if (bookMethod === 'none') return 'This category is never depreciated (land). It is recorded at cost and stays at that value.';
  if (override === true) return `Depreciated whatever it cost — you ticked "depreciate it", so it goes on the books even if it is under ${limit}.`;
  if (override === false) return `Kept on the register but not on the books — never depreciated, even if it cost ${limit} or more. Its purchase is an expense.`;
  if (!isNum(costUsdMinor)) return `Decided when it is activated: ${limit} or more is depreciated; under ${limit} is tracked only (tag, branch and counts, no depreciation).`;
  return costUsdMinor >= thresholdMinor
    ? `Depreciated: it cost ${fmtUsd(costUsdMinor)}, which is ${limit} or more.`
    : `Tracked only: it cost ${fmtUsd(costUsdMinor)}, under ${limit}. It keeps its tag and is counted, but is not depreciated.`;
}

/* ─── the asset form (details tab) ────────────────────────────────────── */

/** Fields an ACTIVE asset can still change by editing (the rest are events). */
export const IDENTITY_FIELDS = ['name', 'nameKm', 'serialNo', 'makeModel', 'plateNo', 'registrationNo', 'insuranceUntil', 'roadTaxUntil',
  'locationNote', 'warrantyUntil', 'warrantyNote', 'invoiceNo', 'notes'];
/** Fields a DRAFT can change (it has posted nothing yet). */
export const DRAFT_FIELDS = [...IDENTITY_FIELDS, 'categoryId', 'quantity', 'acquisitionKind', 'purchaseDate', 'inServiceDate', 'supplierId',
  'cost', 'costCurrency', 'costFxKhrPerUsd', 'vat', 'costBasis', 'usefulLifeMonths', 'salvage', 'depreciate', 'taxClass', 'taxClassReason',
  'branchId', 'custodianEmployeeId', 'status'];
const DATE_FIELDS = new Set(['insuranceUntil', 'roadTaxUntil', 'warrantyUntil', 'purchaseDate', 'inServiceDate']);

/** "Value at the start date" applies only to an asset already owned at the start (an opening). */
export const isDeemed = (acquisitionKind, costBasis) => acquisitionKind === 'opening' && costBasis === 'deemed';

/**
 * Changing "How" on a draft: leaving "Already owned" also leaves "value at the
 * start date" — a purchase always has an actual cost. Returns the form keys to set.
 */
export function acquisitionChange(form, kind) {
  const out = { acquisitionKind: kind };
  if (kind !== 'opening' && form?.costBasis === 'deemed') out.costBasis = 'actual';
  return out;
}

/** May this field be edited on this asset right now? */
export function canEditField(asset, key) {
  if (!asset || asset.recordState === 'cancelled') return false;
  if (asset.recordState === 'draft') return DRAFT_FIELDS.includes(key);
  if (key === 'inServiceDate') return !asset.inServiceDate && !asset.depreciationStartPeriod && asset.acquisitionKind !== 'opening';
  return IDENTITY_FIELDS.includes(key);
}

/** An asset → the text values its form shows. */
export function assetToForm(a = {}) {
  const cur = a.costCurrency || 'USD';
  const txt = (v) => (v == null ? '' : String(v));
  return {
    name: txt(a.name), nameKm: txt(a.nameKm), serialNo: txt(a.serialNo), makeModel: txt(a.makeModel), plateNo: txt(a.plateNo),
    registrationNo: txt(a.registrationNo), insuranceUntil: txt(a.insuranceUntil), roadTaxUntil: txt(a.roadTaxUntil),
    locationNote: txt(a.locationNote), warrantyUntil: txt(a.warrantyUntil), warrantyNote: txt(a.warrantyNote), invoiceNo: txt(a.invoiceNo),
    notes: txt(a.notes), categoryId: txt(a.categoryId), quantity: txt(a.quantity ?? 1), acquisitionKind: a.acquisitionKind || 'purchase',
    purchaseDate: txt(a.purchaseDate), inServiceDate: txt(a.inServiceDate), supplierId: txt(a.supplierId),
    cost: minorToInput(a.costMinor, cur), costCurrency: cur, costFxKhrPerUsd: txt(a.costFxKhrPerUsd), vat: minorToInput(a.vatMinor, cur),
    costBasis: a.costBasis || 'actual', usefulLifeMonths: txt(a.usefulLifeMonths), salvage: minorToInput(a.salvageMinor, 'USD'),
    depreciate: depreciateChoice(a.depreciateOverride), taxClass: txt(a.taxClass), taxClassReason: txt(a.taxClassReason),
    branchId: txt(a.branchId), custodianEmployeeId: txt(a.custodianEmployeeId), status: a.status || 'in_use',
  };
}

/**
 * The changed form keys → an `assets:update` patch, checked. Only keys this
 * asset may still edit are sent (canEditField). Returns `{ patch, errors }`;
 * `errors` is keyed by form field.
 */
export function formPatch(form, keys, asset) {
  const patch = {};
  const errors = {};
  const cur = form.costCurrency || 'USD';
  for (const key of keys) {
    if (!canEditField(asset, key)) continue;
    const v = form[key];
    if (key === 'name') {
      if (!String(v).trim()) errors.name = 'A name is required';
      else patch.name = String(v).trim();
    } else if (key === 'cost' || key === 'vat') {
      const r = parseMoney(v, cur, { label: key === 'cost' ? 'Cost' : 'VAT' });
      if (r.error) errors[key] = r.error; else patch[key === 'cost' ? 'costMinor' : 'vatMinor'] = r.minor;
    } else if (key === 'costCurrency') {
      patch.costCurrency = v;
      // The amount was typed for the other currency: send it again in this one.
      const r = parseMoney(form.cost, v, { label: 'Cost' });
      if (!r.error && r.minor != null) patch.costMinor = r.minor;
    } else if (key === 'salvage') {
      const r = parseMoney(v, 'USD', { label: 'Salvage' });
      if (r.error) errors.salvage = r.error; else patch.salvageMinor = r.minor;
    } else if (key === 'usefulLifeMonths') {
      const r = parseWhole(v, { label: 'Useful life', min: 1, max: 1200 });
      if (r.error) errors.usefulLifeMonths = r.error; else patch.usefulLifeMonths = r.value;
    } else if (key === 'quantity') {
      const r = parseWhole(v, { label: 'Quantity', min: 1, max: 100000 });
      if (r.error || r.value == null) errors.quantity = r.error || 'Quantity is required'; else patch.quantity = r.value;
    } else if (key === 'costFxKhrPerUsd') {
      const r = parseWhole(v, { label: 'Rate', min: 100, max: 100000 });
      if (r.error) errors.costFxKhrPerUsd = r.error; else patch.costFxKhrPerUsd = r.value;
    } else if (key === 'depreciate') {
      patch.depreciateOverride = depreciateValue(v);
    } else if (DATE_FIELDS.has(key)) {
      if (v && !isYmd(v)) errors[key] = 'Pick a date'; else patch[key] = v || null;
    } else {
      patch[key] = typeof v === 'string' ? (v.trim() || null) : v;
    }
  }
  return { patch, errors };
}

/* ─── a new asset ─────────────────────────────────────────────────────── */

export function newAssetForm({ kind = 'purchase', category = null } = {}) {
  return {
    kind, categoryId: category?.id || '', name: '', nameKm: '', branchId: '', custodianEmployeeId: '', locationNote: '',
    quantity: '1', split: 'separate', serialNo: '', makeModel: '', plateNo: '',
    purchaseDate: '', inServiceDate: '', supplierId: '', invoiceNo: '', cost: '', costCurrency: 'USD', vat: '',
    knowsCost: 'yes', usefulLifeMonths: category?.defaultLifeMonths ? String(category.defaultLifeMonths) : '',
    salvage: '', depreciate: 'auto', warrantyUntil: '', notes: '',
  };
}

/**
 * The cost field's words on "+ New asset": with N separate items the amount
 * is the cost of EACH (and the total is shown); a group asset takes the cost
 * of the whole lot. `{ label, hint }`.
 */
export function costWording(form) {
  const deemed = form?.kind === 'opening' && form?.knowsCost === 'no';
  const qty = parseWhole(form?.quantity, { min: 1, max: 100000 }).value || 1;
  const base = deemed ? 'Value at the start date' : 'Cost';
  const cur = deemed ? 'USD' : (form?.costCurrency || 'USD');
  if (qty <= 1) return { label: base, hint: deemed ? 'Your best estimate is fine.' : 'Net of VAT you can reclaim. Can be added later.' };
  if (form?.split === 'group') return { label: `${base} of the whole lot`, hint: `All ${qty} together, as one asset.` };
  const each = parseMoney(form?.cost, cur).minor;
  const fmt = (m) => fmtMoneyIn(m, cur);
  return { label: `${base} of each`, hint: each != null ? `${qty} × ${fmt(each)} = ${fmt(each * qty)}` : `Each of the ${qty} gets this amount.` };
}

/** Most separate assets one "Add" creates (each gets its own tag). */
export const MAX_SPLIT = 50;

/**
 * Check a new-asset form → `{ errors, inputs }`: `inputs` is one or more
 * `assets:create` payloads (N separate items, or one group asset).
 */
export function validateNewAsset(form, { category = null, today = todayKey() } = {}) {
  const errors = {};
  if (!form.categoryId) errors.categoryId = 'Pick a category';
  if (!String(form.name || '').trim()) errors.name = 'A name is required';
  const q = parseWhole(form.quantity, { label: 'Quantity', min: 1, max: 100000 });
  if (q.error || q.value == null) errors.quantity = q.error || 'Quantity is required';
  const qty = q.value || 1;
  if (qty > 1 && form.split === 'separate' && qty > MAX_SPLIT) errors.quantity = `Up to ${MAX_SPLIT} separate items at a time — or make it one group asset`;
  const opening = form.kind === 'opening';
  const deemed = opening && form.knowsCost === 'no';
  const cur = deemed ? 'USD' : (form.costCurrency || 'USD');
  const cost = parseMoney(form.cost, cur, { label: deemed ? 'Value at the start date' : 'Cost' });
  if (cost.error) errors.cost = cost.error;
  const vat = parseMoney(form.vat, cur, { label: 'VAT' });
  if (vat.error) errors.vat = vat.error;
  const salvage = parseMoney(form.salvage, 'USD', { label: 'Salvage' });
  if (salvage.error) errors.salvage = salvage.error;
  const life = parseWhole(form.usefulLifeMonths, { label: deemed ? 'Remaining life' : 'Useful life', min: 1, max: 1200 });
  if (life.error) errors.usefulLifeMonths = life.error;
  if (deemed && cost.minor == null && !errors.cost) errors.cost = 'Type its value on the start date (an estimate is fine)';
  if (deemed && life.value == null && !errors.usefulLifeMonths && category?.bookMethod !== 'none') errors.usefulLifeMonths = 'How many more months will it be used?';
  for (const k of ['purchaseDate', 'inServiceDate', 'warrantyUntil']) if (form[k] && !isYmd(form[k])) errors[k] = 'Pick a date';
  for (const k of ['purchaseDate', 'inServiceDate']) if (form[k] && form[k] > today) errors[k] = 'This date is in the future';
  if (form.purchaseDate && form.inServiceDate && form.inServiceDate < form.purchaseDate) errors.inServiceDate = 'It cannot go into use before it was bought';
  if (opening && form.knowsCost === 'yes' && cost.minor != null && !form.purchaseDate) errors.purchaseDate = 'When was it bought? (needed to work out what is already used up)';
  if (Object.keys(errors).length) return { errors, inputs: [] };

  const base = {
    categoryId: form.categoryId, name: form.name.trim(), acquisitionKind: form.kind,
    costBasis: deemed ? 'deemed' : 'actual', depreciateOverride: depreciateValue(form.depreciate),
  };
  const opt = (k, v) => { if (v != null && v !== '') base[k] = v; };
  opt('nameKm', form.nameKm.trim()); opt('branchId', form.branchId); opt('custodianEmployeeId', form.custodianEmployeeId);
  opt('locationNote', form.locationNote.trim()); opt('serialNo', form.serialNo.trim()); opt('makeModel', form.makeModel.trim());
  opt('plateNo', form.plateNo.trim()); opt('purchaseDate', deemed ? '' : form.purchaseDate); opt('inServiceDate', deemed ? '' : form.inServiceDate);
  opt('supplierId', opening ? '' : form.supplierId); opt('invoiceNo', opening ? '' : form.invoiceNo.trim());
  opt('costMinor', cost.minor); if (cost.minor != null) base.costCurrency = cur;
  opt('vatMinor', deemed ? null : vat.minor); opt('salvageMinor', salvage.minor); opt('usefulLifeMonths', life.value);
  opt('warrantyUntil', form.warrantyUntil); opt('notes', form.notes.trim());
  if (qty > 1 && form.split === 'group') return { errors, inputs: [{ ...base, quantity: qty }] };
  return { errors, inputs: Array.from({ length: qty }, () => ({ ...base })) };
}

/* ─── what an asset offers ────────────────────────────────────────────── */

const REVALUE_KEYS = new Set(['land', 'building', 'building_light']);
const HELD = new Set(['in_use', 'in_storage', 'in_repair']);

/**
 * The action buttons for an asset — only what this account may do and the
 * asset's state allows, so a button never leads to a refusal it could have
 * known about. `{ key, label, danger? }[]` in display order.
 */
export function assetActions(a, { canManage = false } = {}) {
  if (!a || !canManage) return [];
  if (a.recordState === 'cancelled') return [];
  if (a.recordState === 'draft') {
    return [
      { key: 'activate', label: 'Activate…', primary: true },
      { key: 'cancelDraft', label: 'Cancel draft…', danger: true },
    ];
  }
  if (a.status === 'lost') return [{ key: 'markFound', label: 'Mark found…', primary: true }, { key: 'note', label: 'Add note…' }];
  if (!HELD.has(a.status)) return [{ key: 'note', label: 'Add note…' }];
  const books = a.accountingTreatment === 'capitalised';
  const onBooks = books || a.accountingTreatment === 'not_depreciated';
  const out = [
    { key: 'transfer', label: 'Transfer…' },
    { key: 'custodian', label: 'Change custodian…' },
    { key: 'status', label: 'Change status…' },
    { key: 'repair', label: 'Record repair…' },
  ];
  if (onBooks) out.push({ key: 'capex', label: 'Improvement…' });
  if (books) out.push({ key: 'life', label: 'Change life or salvage…' });
  if (onBooks) out.push({ key: 'impair', label: 'Impair…' });
  if (onBooks && REVALUE_KEYS.has(a.categoryKey)) out.push({ key: 'revalue', label: 'Revalue…' });
  out.push({ key: 'note', label: 'Add note…' });
  out.push({ key: 'dispose', label: 'Dispose…', danger: true });
  if (a.quantity > 1) out.push({ key: 'partialDispose', label: 'Dispose of part…', danger: true });
  out.push({ key: 'markLost', label: 'Mark lost…', danger: true });
  return out;
}

/** Can this event be voided / reversed from the timeline (the server has the last word)? */
export function eventActions(e, { canManage = false } = {}) {
  if (!canManage || !e || e.voided || e.reversedByEventId || e.kind === 'reversal') return [];
  const out = [];
  if (VOIDABLE_EVENTS.has(e.kind)) out.push({ key: 'void', label: 'Void…' });
  // Offered whether or not it posted: a tracked-only activation or disposal posts nothing but can
  // still be undone. The server decides (latest only, nothing posted after it).
  if (REVERSIBLE_EVENTS.has(e.kind)) out.push({ key: 'reverse', label: 'Reverse…' });
  return out;
}

/** One line of the timeline. `maps` = { branches, staff } (Maps by id). */
export function eventSummary(e, maps = {}) {
  const b = (id) => (id ? (maps.branches?.get(id) ? branchLabel(maps.branches.get(id)) : 'another branch') : 'no branch');
  const s = (id) => (id ? staffLabel(maps.staff?.get(id)) : 'nobody');
  const amount = isNum(e.amountUsdMinor) ? fmtUsd(e.amountUsdMinor) : isNum(e.amountMinor) ? fmtMoneyIn(e.amountMinor, e.currency || 'USD') : '';
  const d = e.detail || {};
  switch (e.kind) {
    case 'transfer': {
      const parts = [];
      if (e.fromBranchId !== e.toBranchId) parts.push(`${b(e.fromBranchId)} → ${b(e.toBranchId)}`);
      if (e.fromEmployeeId !== e.toEmployeeId) parts.push(`custodian ${s(e.fromEmployeeId)} → ${s(e.toEmployeeId)}`);
      return parts.join('; ') || 'Moved';
    }
    case 'custodian': return `${s(e.fromEmployeeId)} → ${s(e.toEmployeeId)}`;
    case 'status': return `${statusOf(e.fromStatus).label} → ${statusOf(e.toStatus).label}`;
    case 'repair': return [amount, e.vendor].filter(Boolean).join(' · ') || 'No cost recorded';
    case 'capex': return [amount, e.extendsLifeMonths ? `+${fmtLife(e.extendsLifeMonths)} of life` : ''].filter(Boolean).join(' · ');
    case 'life_change': return `${fmtLife(e.newLifeMonths)} left from ${fmtPeriod(e.effectivePeriod)}`;
    case 'salvage_change': return `Salvage ${fmtUsd(e.newSalvageMinor)} from ${fmtPeriod(e.effectivePeriod)}`;
    case 'acquire': return `${amount}${d.treatment ? ` · ${treatmentLabel(d.treatment)}` : ''}`;
    case 'open': return `${amount}${isNum(d.openingAccumMinor) && d.openingAccumMinor ? ` · ${fmtUsd(d.openingAccumMinor)} already used up` : ''}${d.deemed ? ' · value at start date' : ''}`;
    case 'dispose': case 'partial_dispose': {
      const g = isNum(d.gainMinor) ? (d.gainMinor >= 0 ? `gain ${fmtUsd(d.gainMinor)}` : `loss ${fmtUsd(-d.gainMinor)}`) : '';
      const qty = e.kind === 'partial_dispose' && e.qty ? `${e.qty} of ${d.quantityBefore || '?'}` : '';
      const kind = DISPOSAL_KINDS.find((k) => k.value === d.kind)?.label || '';
      return [kind, qty, isNum(e.amountUsdMinor) && e.amountUsdMinor ? `for ${fmtUsd(e.amountUsdMinor)}` : '', g, e.buyer ? `to ${e.buyer}` : ''].filter(Boolean).join(' · ');
    }
    case 'lost': return isNum(d.nbvMinor) ? `${fmtUsd(d.nbvMinor)} written off` : 'Written off';
    case 'note': return e.reason || '';
    case 'found': return 'The write-off is reversed; depreciation catches up in the next run';
    case 'reversal': {
      const of = e.reversesEventId && maps.events?.get(e.reversesEventId);
      return of ? `Reverses “${eventLabel(of.kind)}” of ${fmtYmd(of.eventDate)}` : 'Reverses an earlier event';
    }
    case 'impair': return amount;
    case 'revalue': return [isNum(d.newValueMinor) ? `to ${fmtUsd(d.newValueMinor)}` : amount, isNum(d.surplusMinor) && d.surplusMinor ? `surplus ${fmtUsd(d.surplusMinor)}` : '', isNum(d.lossMinor) && d.lossMinor ? `loss ${fmtUsd(d.lossMinor)}` : ''].filter(Boolean).join(' · ');
    default: return amount;
  }
}

/* ─── the book schedule ───────────────────────────────────────────────── */

/**
 * Schedule rows with a state per month: `posted` (fully), `part` (some
 * posted), `due` (ended, nothing posted yet — the next run catches it up) or
 * `future`. `lastEnded` is the last month that has ended.
 */
export function scheduleView(schedule, lastEnded = lastEndedPeriod()) {
  const rows = Array.isArray(schedule?.rows) ? schedule.rows : [];
  let postedTotal = 0;
  let dueTotal = 0;
  const out = rows.map((r) => {
    const posted = isNum(r.postedMinor) ? r.postedMinor : 0;
    postedTotal += posted;
    let state;
    if (posted >= r.amountMinor && r.amountMinor > 0) state = 'posted';
    else if (posted > 0) state = 'part';
    else if (r.period <= lastEnded) state = 'due';
    else state = 'future';
    if (state === 'due' || state === 'part') dueTotal += r.amountMinor - posted;
    return { ...r, posted, state, opening: r.accumMinor - r.amountMinor, openingNbv: r.nbvMinor + r.amountMinor };
  });
  return { rows: out, postedTotal, dueTotal };
}

export const SCHEDULE_STATE = {
  posted: { label: 'Posted', tone: 'emerald' },
  part: { label: 'Part posted', tone: 'amber' },
  due: { label: 'Not posted yet', tone: 'amber' },
  future: { label: 'Planned', tone: 'slate' },
};

/* ─── depreciation runs ───────────────────────────────────────────────── */

export const RUN_STATUS = {
  posted: { label: 'Posted', tone: 'emerald' },
  due: { label: 'Due', tone: 'amber' },
  locked: { label: 'Closed', tone: 'slate' },
  open: { label: 'Not ended', tone: 'slate' },
};
export const runStatusOf = (s) => RUN_STATUS[s] || { label: s || '—', tone: 'slate' };

/** `assets:listRuns` → rows newest first, with the due months counted. */
export function runsView(res) {
  const months = Array.isArray(res?.months) ? res.months.slice() : [];
  months.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  const due = months.filter((m) => m.status === 'due').map((m) => m.period).sort();
  const latestPosted = months.find((m) => m.status === 'posted' && m.run);
  return { rows: months, due, nextDue: res?.nextDuePeriod || null, lastEnded: res?.lastEndedPeriod || null, latestPostedPeriod: latestPosted?.period || null };
}

/**
 * Words for the catch-up: why months from the register start are posted one
 * by one, and how a late asset catches up. `start` is 'YYYY-MM-DD'.
 */
export function catchUpExplanation({ start, due = [], lastEnded = null } = {}) {
  const startText = start ? fmtYmd(start) : 'the register start';
  const lines = [
    `The register starts on ${startText}. Every month from then is posted on its own, oldest first, dated its last day.`,
    'Each run posts what the schedules say should be charged up to that month, minus what is already posted. So an asset entered late — or a month that was closed without a run — is caught up in the next run, on separate "catch-up" lines.',
  ];
  if (due.length === 1) lines.push(`${fmtPeriod(due[0])} is due. Preview it, then post it.`);
  else if (due.length > 1) lines.push(`${due.length} months are due (${fmtPeriod(due[0])} to ${fmtPeriod(due[due.length - 1])}). Post them in order — each one is checked again before it posts.`);
  else if (lastEnded) lines.push(`Everything up to ${fmtPeriod(lastEnded)} is posted.`);
  return lines;
}

/* ─── tax year ────────────────────────────────────────────────────────── */

export const POOL_CLASSES = ['2', '3', '4'];
export const OPENING_SOURCE = {
  entered: { label: 'Entered', tone: 'blue' },
  estimate: { label: 'Estimate', tone: 'amber' },
  computed: { label: 'From last year', tone: 'slate' },
  filed: { label: 'From the filed year', tone: 'emerald' },
};

/** The three pools as rows (missing classes are skipped). */
export function poolRows(year) {
  const pools = year?.pools || {};
  return POOL_CLASSES.filter((k) => pools[k]).map((k) => ({ taxClass: k, ...pools[k], source: OPENING_SOURCE[pools[k].openingSource] || { label: pools[k].openingSource || '—', tone: 'slate' } }));
}

/** Does the year still have an estimated opening nobody confirmed? */
export function hasUnconfirmedEstimate(year) {
  return poolRows(year).some((p) => p.openingSource === 'estimate' && !p.confirmedByAccountant && (p.openingWdvKhr || 0) !== 0);
}

/**
 * Has this (calendar) tax year ended in Phnom Penh? A year can be marked
 * filed only after its last day (review LOW 5).
 */
export const taxYearEnded = (year, now = Date.now()) => Number(year) < Number(todayKey(now).slice(0, 4));

/** Years a tax view can show: from the register's first year to this year. */
export function taxYears(startDate, now = Date.now()) {
  const first = Number(String(startDate || '').slice(0, 4)) || Number(todayKey(now).slice(0, 4));
  const last = Math.max(first, Number(todayKey(now).slice(0, 4)));
  const out = [];
  for (let y = last; y >= first; y -= 1) out.push(y);
  return out;
}

/* ─── import (§11: pick → map → review) ───────────────────────────────── */

const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[\s_\-./()]+/g, ' ').trim();

/**
 * Guess which column each header is: by key, label or alias (case and
 * punctuation ignored). Each column is used once — the first header wins.
 * Returns `{ header: key | '' }`.
 */
export function guessMapping(headers, columns) {
  const used = new Set();
  const out = {};
  for (const h of Array.isArray(headers) ? headers : []) {
    const n = norm(h);
    const col = (columns || []).find((c) => !used.has(c.key) && [c.key, c.label, ...(c.aliases || [])].some((x) => norm(x) === n));
    out[h] = col ? col.key : '';
    if (col) used.add(col.key);
  }
  return out;
}

/**
 * Sheet rows + mapping → `[{ key: text, sourceRow }]` (blank cells left out; a
 * row with nothing is dropped). `sourceRow` is the row's number as read
 * (header = 1), so the review's row numbers still match the sheet after rows
 * are dropped.
 */
export function buildImportRows(rows, mapping) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const o = {};
    for (const [header, key] of Object.entries(mapping || {})) {
      if (!key) continue;
      const v = r?.[header];
      const s = v == null ? '' : String(v).trim();
      if (s) o[key] = s;
    }
    if (Object.keys(o).length) out.push({ ...o, sourceRow: i + 2 });
  }
  return out;
}

/** Turn years into months (× 12) in these columns of built import rows; a cell that is not a number is left as typed. */
export function convertYearsToMonths(rows, keys) {
  const set = new Set(keys || []);
  if (!set.size) return rows;
  return (rows || []).map((r) => {
    const o = { ...r };
    for (const k of set) {
      const n = parseNumber(o[k]);
      if (o[k] != null && n != null && !Number.isNaN(n)) o[k] = String(Math.round(n * 12));
    }
    return o;
  });
}

const MONTH_KEYS = /months?$/;
/**
 * Columns whose header talks about years but that are matched to a field in
 * months ("Life (years)" → useful_life_months): `[{ header, key }]`, so the
 * map step can warn before 8 becomes 8 months.
 */
export function yearsIntoMonths(mapping) {
  return Object.entries(mapping || {})
    .filter(([header, key]) => key && MONTH_KEYS.test(key) && /\b(years?|yrs?)\b/i.test(String(header)))
    .map(([header, key]) => ({ header, key }));
}

/** The first non-empty value of each header, to show beside the mapping. */
export function sampleValues(rows, headers) {
  const out = {};
  for (const h of headers || []) {
    const r = (rows || []).find((x) => x && String(x[h] ?? '').trim());
    out[h] = r ? String(r[h]).trim() : '';
  }
  return out;
}

export const IMPORT_ACTION = {
  create: { label: 'New', tone: 'emerald' },
  update: { label: 'Update', tone: 'blue' },
  skip: { label: 'No change', tone: 'slate' },
  error: { label: 'Error', tone: 'rose' },
};

/* ─── reports ─────────────────────────────────────────────────────────── */

/**
 * The eight reports (§8.1). `params`: which pickers it needs — 'asOf' (a
 * date), 'range' (from / to), 'year', or none. `branch` / `category`: which
 * filters it takes.
 */
export const REPORTS = [
  { kind: 'register', label: 'Register as at a date', params: 'asOf', branch: true, category: true, hint: 'Every asset held on that date with its posted cost, depreciation and book value.' },
  { kind: 'movements', label: 'Movements', params: 'range', branch: true, category: true, hint: 'Opening, additions, disposals and closing per category — cost and depreciation.' },
  { kind: 'depreciation', label: 'Depreciation by month', params: 'range', branch: true, category: true, hint: 'What was charged each month, by category and branch (posted).' },
  { kind: 'book_vs_tax', label: 'Book versus tax', params: 'year', branch: false, category: false, hint: 'Book depreciation against tax depreciation per class — the add-back worksheet. An estimate until an accountant confirms it.' },
  { kind: 'tax_pools', label: 'Tax pools', params: 'year', branch: false, category: false, hint: 'The Class 2–4 pools for the year, in riel. An estimate until an accountant confirms it.' },
  { kind: 'additions_disposals', label: 'Additions and disposals', params: 'range', branch: true, category: true, hint: 'What came in and what went out, with gain or loss.' },
  { kind: 'by_branch', label: 'By branch', params: 'asOf', branch: false, category: true, hint: 'How many assets each branch holds and their book value.' },
  { kind: 'attention', label: 'Needs attention', params: 'none', branch: false, category: false, hint: 'Fully depreciated but still in use; warranty, insurance and road tax due in the next 60 days.' },
];
export const reportDef = (kind) => REPORTS.find((r) => r.kind === kind) || REPORTS[0];

/** Default arguments for a report: this year to date, as at today. */
export function defaultReportArgs(now = Date.now()) {
  const today = todayKey(now);
  return { asOf: today, from: `${today.slice(0, 4)}-01-01`, to: today, year: Number(today.slice(0, 4)), branchId: '', categoryId: '' };
}

/** The `assets:getReport` arguments for a kind and the pickers' values. */
export function reportArgs(kind, v) {
  const def = reportDef(kind);
  const out = { kind };
  if (def.params === 'asOf' && v.asOf) out.asOf = v.asOf;
  if (def.params === 'range') { if (v.from) out.from = v.from; if (v.to) out.to = v.to; }
  if (def.params === 'year') out.year = Number(v.year);
  if (def.branch && v.branchId) out.branchId = v.branchId;
  if (def.category && v.categoryId) out.categoryId = v.categoryId;
  return out;
}

export const ATTENTION_REASONS = {
  fully_depreciated: 'Fully depreciated, still in use', warranty: 'Warranty ends', insurance: 'Insurance due', road_tax: 'Road tax due',
};

const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });

/**
 * A report → `{ columns, rows, totals }` for one table. Column `type`:
 * text | usd | khr | ymd | period | int. `get` reads a nested value. A row
 * with `assetId` opens that asset when clicked.
 */
export function reportTable(rep) {
  if (!rep) return { columns: [], rows: [], totals: null };
  const t = rep.totals || {};
  switch (rep.kind) {
    case 'register':
      return {
        columns: [col('tagCode', 'Tag'), col('name', 'Name'), col('categoryName', 'Category'), col('branchName', 'Branch'), col('custodianName', 'Custodian'),
          col('status', 'Status', 'status'), col('inService', 'In use since', 'ymd', { get: (r) => r.inServiceDate || r.purchaseDate }),
          col('costMinor', 'Cost', 'usd'), col('accumMinor', 'Depreciation', 'usd'), col('impairmentMinor', 'Impairment', 'usd'),
          col('nbvMinor', 'Book value', 'usd'), col('unpostedDepreciationMinor', 'Not yet posted', 'usd')],
        rows: rep.rows || [],
        totals: { tagCode: `${t.assets || 0} assets`, name: t.trackedOnly ? `${t.trackedOnly} tracked only (not in the totals)` : '', costMinor: t.costMinor, accumMinor: t.accumMinor, impairmentMinor: t.impairmentMinor, nbvMinor: t.nbvMinor, unpostedDepreciationMinor: t.unpostedDepreciationMinor },
      };
    case 'movements':
      return {
        columns: [col('categoryName', 'Category'), col('costOpening', 'Cost at start', 'usd', { get: (r) => r.cost?.opening }),
          col('costAdditions', 'Additions', 'usd', { get: (r) => r.cost?.additions }), col('costDisposals', 'Disposals', 'usd', { get: (r) => r.cost?.disposals }),
          col('costRevaluation', 'Revaluation', 'usd', { get: (r) => r.cost?.revaluation }), col('costClosing', 'Cost at end', 'usd', { get: (r) => r.cost?.closing }),
          col('accumOpening', 'Depr. at start', 'usd', { get: (r) => r.accum?.opening }), col('accumCharge', 'Charged', 'usd', { get: (r) => r.accum?.charge }),
          col('accumDisposals', 'Depr. disposed', 'usd', { get: (r) => (r.accum?.disposals || 0) + (r.accum?.revaluation || 0) }),
          col('accumClosing', 'Depr. at end', 'usd', { get: (r) => r.accum?.closing }),
          col('nbvOpeningMinor', 'Book value at start', 'usd'), col('nbvClosingMinor', 'Book value at end', 'usd')],
        rows: rep.rows || [],
        totals: { categoryName: 'Total', costOpening: t.costOpening, costAdditions: t.costAdditions, costDisposals: t.costDisposals, costRevaluation: t.costRevaluation,
          costClosing: t.costClosing, accumOpening: t.accumOpening, accumCharge: t.accumCharge, accumDisposals: (t.accumDisposals || 0) + (t.accumRevaluation || 0),
          accumClosing: t.accumClosing, nbvOpeningMinor: t.nbvOpening, nbvClosingMinor: t.nbvClosing },
      };
    case 'depreciation':
      return {
        columns: [col('period', 'Month', 'period'), col('categoryName', 'Category'), col('branchName', 'Branch', 'text', { get: (r) => r.branchName || 'No branch' }),
          col('monthMinor', 'This month', 'usd'), col('catchUpMinor', 'Catch-up', 'usd'), col('totalMinor', 'Total', 'usd')],
        rows: rep.rows || [],
        totals: { period: 'Total', catchUpMinor: t.catchUpMinor, totalMinor: t.totalMinor, monthMinor: (t.totalMinor || 0) - (t.catchUpMinor || 0) },
      };
    case 'book_vs_tax':
      return {
        columns: [col('label', 'Class', 'text', { get: (r) => r.label || taxClassLabel(r.taxClass) }), col('bookUsdMinor', 'Book (USD)', 'usd'),
          col('bookKhr', 'Book (riel)', 'khr'), col('taxKhr', 'Tax (riel)', 'khr'), col('differenceKhr', 'Tax − book (riel)', 'khr')],
        rows: rep.rows || [],
        totals: { label: 'Total', bookUsdMinor: t.bookDepreciationUsdMinor, bookKhr: t.bookDepreciationKhr, taxKhr: t.taxDepreciationKhr,
          differenceKhr: isNum(t.taxDepreciationKhr) && isNum(t.bookDepreciationKhr) ? t.taxDepreciationKhr - t.bookDepreciationKhr : null },
      };
    case 'tax_pools':
      return {
        columns: [col('label', 'Pool'), col('openingWdvKhr', 'Opening', 'khr'), col('source', 'Opening from', 'text', { get: (r) => r.source?.label }),
          col('additionsKhr', 'Additions', 'khr'), col('proceedsKhr', 'Proceeds', 'khr'), col('baseKhr', 'Base', 'khr'),
          col('depreciationKhr', 'Depreciation', 'khr'), col('gainKhr', 'Gain', 'khr'), col('lossKhr', 'Loss', 'khr'), col('closingWdvKhr', 'Closing', 'khr')],
        rows: poolRows(rep),
        totals: null,
      };
    case 'additions_disposals':
      return {
        columns: [col('date', 'Date', 'ymd'), col('kind', 'What', 'text', { get: (r) => eventLabel(r.kind) }), col('tagCode', 'Tag'), col('name', 'Name'),
          col('categoryName', 'Category'), col('amountUsdMinor', 'Added', 'usd'), col('proceedsUsdMinor', 'Proceeds', 'usd'), col('nbvMinor', 'Book value out', 'usd'),
          col('gainMinor', 'Gain / loss', 'usd')],
        rows: rep.rows || [],
        totals: { date: 'Total', amountUsdMinor: t.additionsMinor, proceedsUsdMinor: t.proceedsMinor, gainMinor: t.gainMinor },
      };
    case 'by_branch': {
      const rows = rep.rows || [];
      return {
        columns: [col('branchName', 'Branch'), col('categoryName', 'Category'), col('assets', 'Assets', 'int'), col('trackedOnly', 'Tracked only', 'int'),
          col('costMinor', 'Cost', 'usd'), col('nbvMinor', 'Book value', 'usd')],
        rows,
        totals: { branchName: 'Total', assets: rows.reduce((s, r) => s + (r.assets || 0), 0), trackedOnly: rows.reduce((s, r) => s + (r.trackedOnly || 0), 0),
          costMinor: rows.reduce((s, r) => s + (r.costMinor || 0), 0), nbvMinor: rows.reduce((s, r) => s + (r.nbvMinor || 0), 0) },
      };
    }
    case 'attention':
      return {
        columns: [col('tagCode', 'Tag'), col('name', 'Name'), col('reason', 'Why', 'text', { get: (r) => ATTENTION_REASONS[r.reason] || r.reason }),
          col('date', 'When', 'text', { get: (r) => (isPeriod(r.date) ? fmtPeriod(r.date) : fmtYmd(r.date)) }),
          col('overdue', 'Overdue', 'text', { get: (r) => (r.overdue ? 'Overdue' : '') }), col('nbvMinor', 'Book value', 'usd')],
        rows: rep.rows || [],
        totals: null,
      };
    default:
      return { columns: [], rows: [], totals: null };
  }
}

/** A cell's value for a column (nested `get` or the key). */
export const cellValue = (column, row) => (column.get ? column.get(row) : row?.[column.key]);

/** A cell as text, by column type. */
export function cellText(column, value) {
  if (value == null || value === '') return '';
  switch (column.type) {
    case 'usd': return fmtUsd(value);
    case 'khr': return fmtKhr(value);
    case 'ymd': return fmtYmd(value);
    case 'period': return fmtPeriod(value);
    case 'int': return isNum(value) ? value.toLocaleString('en-US') : String(value);
    case 'status': return statusOf(value).label;
    default: return String(value);
  }
}

/* ─── errors ──────────────────────────────────────────────────────────── */

/** The server's sentence without the IPC wrapper ("Error invoking remote method …: Error: …"). */
export function errText(err) {
  const msg = String(err?.message || err || 'Something failed');
  const m = /Error invoking remote method '[^']+': (?:\w*Error: )?([\s\S]*)$/.exec(msg);
  return (m ? m[1] : msg).trim();
}

/* ─── register rows ───────────────────────────────────────────────────── */

const GONE = new Set(['disposed', 'lost']);

/**
 * The register's Cost cell: the posted book cost for an asset on the books;
 * the typed cost (in its currency) for a draft; the cost for a tracked-only
 * item. `note` says why it is not a book figure.
 */
export function rowCost(a) {
  if (!a) return { minor: null, currency: 'USD', note: '' };
  if (a.recordState === 'draft') return { minor: a.costMinor ?? null, currency: a.costCurrency || 'USD', note: a.costMinor == null ? 'needs a cost' : 'not posted yet', muted: true };
  if (a.recordState === 'cancelled') return { minor: null, currency: 'USD', note: 'cancelled', muted: true };
  if (a.accountingTreatment === 'tracked_only') return { minor: a.costUsdMinor ?? null, currency: 'USD', note: 'tracked only', muted: true };
  if (GONE.has(a.status)) return { minor: a.costUsdMinor ?? null, currency: 'USD', note: a.status === 'lost' ? 'written off' : 'disposed of', muted: true };
  return { minor: a.bookCostMinor ?? a.costUsdMinor ?? null, currency: 'USD', note: '' };
}

/** The register's book value cell: null when the item has none (draft, tracked, gone). */
export function rowNbv(a) {
  if (!a || a.recordState !== 'active' || a.accountingTreatment === 'tracked_only' || GONE.has(a.status)) return null;
  return isNum(a.nbvMinor) ? a.nbvMinor : null;
}

/** The register's banner: "1 vehicle or machine came from Fuel." / "16 vehicles and machines came from Fuel." */
export function fromFuelTitle(n) {
  return n === 1 ? '1 vehicle or machine came from Fuel.' : `${n} vehicles and machines came from Fuel.`;
}

/** The totals row's words: "303 assets · 241 on the books · 34 tracked only". */
export function totalsCaption(t) {
  if (!t) return '';
  const parts = [`${t.assets || 0} asset${t.assets === 1 ? '' : 's'}`];
  if (t.onBooks) parts.push(`${t.onBooks} on the books`);
  if (t.trackedOnly) parts.push(`${t.trackedOnly} tracked only`);
  if (t.drafts) parts.push(`${t.drafts} draft${t.drafts === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** One prospective change on a book schedule, in words (getSchedule's `changes`). */
export function scheduleChangeText(c) {
  if (!c) return '';
  const from = `from ${fmtPeriod(c.period)}`;
  if (isNum(c.addBasisMinor) && c.addBasisMinor) return `Improvement +${fmtUsd(c.addBasisMinor)}${c.extendMonths ? `, +${fmtLife(c.extendMonths)} of life` : ''} ${from}`;
  if (isNum(c.lifeMonths)) return `Life changed to ${fmtLife(c.lifeMonths)} left ${from}`;
  if (isNum(c.impairMinor) && c.impairMinor) return `Impaired by ${fmtUsd(c.impairMinor)} ${from}`;
  if (isNum(c.revalueToMinor)) return `Revalued to ${fmtUsd(c.revalueToMinor)} ${from}`;
  if (isNum(c.removeBasisMinor) && c.removeBasisMinor) return `Part disposed of (${fmtUsd(c.removeBasisMinor)} of cost) ${from}`;
  if (isNum(c.salvageMinor)) return `Salvage changed to ${fmtUsd(c.salvageMinor)} ${from}`;
  return `Changed ${from}`;
}
