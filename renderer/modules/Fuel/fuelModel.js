/**
 * Fuel F1 — the screens' view model. Pure functions only (no React, no
 * window.api), so test/fuelUiModel.test.js can check the wording, the review
 * queue, the form rules and the unit conversions without a browser.
 *
 * Conventions that come from the backend (docs/PEOPLE_AND_FUEL_PLAN.md §9):
 *   - times are epoch ms; a record's day and month are in Phnom Penh time
 *     (UTC+7 all year, no daylight saving), whichever Mac shows them;
 *   - money is whole numbers in the smallest unit: riel, or US cents;
 *   - litres and meter readings are plain numbers.
 */

import { formatDate, formatDateTime, toMillis } from '../../lib/format.js';
import { formatPrice } from '../../lib/currencies.js';

export const FUEL_TZ = 'Asia/Phnom_Penh';
const PP_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ─── dates (Phnom Penh) ──────────────────────────────────────────────── */

export const fmtWhen = (ts) => formatDateTime(ts, { timeZone: FUEL_TZ });
export const fmtDay = (ts) => formatDate(ts, { timeZone: FUEL_TZ });

/** 'YYYY-MM-DD' of a moment, in Phnom Penh. */
export function ppDateKey(ms = Date.now()) {
  const d = new Date(toMillis(ms) + PP_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM' of a moment, in Phnom Penh. */
export function ppMonthKey(ms = Date.now()) {
  return ppDateKey(ms).slice(0, 7);
}

/** Start (inclusive) and end (exclusive) of a 'YYYY-MM' month, in Phnom Penh, as epoch ms. */
export function monthRange(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return null;
  return { from: Date.UTC(y, mo, 1) - PP_OFFSET_MS, to: Date.UTC(y, mo + 1, 1) - PP_OFFSET_MS };
}

/** "October 2026" for '2026-10'. */
export function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return String(key || '');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
    .toLocaleDateString(undefined, { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** The last `n` months, newest first, as `{ value, label }`. */
export function recentMonths(n = 24, now = Date.now()) {
  const [y, m] = ppMonthKey(now).split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    out.push({ value, label: monthLabel(value) });
  }
  return out;
}

/** Value for an `<input type="datetime-local">` showing a moment in Phnom Penh time. */
export function ppInputValue(ms = Date.now()) {
  const d = new Date(toMillis(ms) + PP_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Parse a datetime-local value typed as Phnom Penh time → epoch ms (null when not a time). */
export function parsePpInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - PP_OFFSET_MS;
  return Number.isFinite(ms) ? ms : null;
}

/* ─── numbers and money ───────────────────────────────────────────────── */

/** A typed number → number, or null when blank, or NaN when not a number. Accepts "1,234.5". */
export function parseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v).trim().replace(/,/g, '');
  if (!s) return null;
  if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return NaN;
  return Number(s);
}

export function fmtNumber(n, digits = 0) {
  if (!isNum(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtLitres(n, digits = 1) {
  return isNum(n) ? `${fmtNumber(n, digits)} L` : '—';
}

const WHOLE = new Set(['KHR', 'VND', 'IDR', 'JPY', 'KRW']);

/** Smallest unit → major unit (riel stays riel, cents → dollars). */
export function fromMinor(minor, currency = 'KHR') {
  if (!isNum(minor)) return null;
  return WHOLE.has(currency) ? minor : minor / 100;
}

/** Major unit → smallest unit, rounded to a whole number. */
export function toMinor(major, currency = 'KHR') {
  if (!isNum(major)) return null;
  return Math.round(WHOLE.has(currency) ? major : major * 100);
}

/** "៛15,000" / "$12.50" from a minor-unit amount. */
export function fmtMoney(minor, currency = 'KHR') {
  if (!isNum(minor)) return '—';
  return formatPrice(fromMinor(minor, currency), currency);
}

/** Riel, no decimals ("៛ 1,250,000"); negative keeps its sign. */
export function fmtRiel(n) {
  if (!isNum(n)) return '—';
  const s = formatPrice(Math.abs(Math.round(n)), 'KHR');
  return n < 0 ? `−${s}` : s;
}

/* ─── labels ──────────────────────────────────────────────────────────── */

export const FILL_KINDS = [
  { value: 'warehouse_tank', label: 'Warehouse tank', short: 'Tank' },
  { value: 'farm_store', label: 'Farm store', short: 'Farm' },
  { value: 'cash_station', label: 'Cash at a station', short: 'Cash' },
];
export const fillKindLabel = (k) => FILL_KINDS.find((x) => x.value === k)?.label || k || '—';

export const REVIEW_STATUSES = [
  { value: 'new', label: 'New', tone: 'blue' },
  { value: 'needs_review', label: 'Needs review', tone: 'amber' },
  { value: 'checked', label: 'Checked', tone: 'emerald' },
];
export const reviewStatusOf = (s) => REVIEW_STATUSES.find((x) => x.value === s) || { value: s, label: s || '—', tone: 'slate' };

export const FUEL_TYPES = [
  { value: 'diesel', label: 'Diesel' },
  { value: 'gasoline', label: 'Gasoline' },
  { value: 'other', label: 'Other' },
];
export const fuelTypeLabel = (t) => FUEL_TYPES.find((x) => x.value === t)?.label || t || '—';

export const METER_UNITS = [
  { value: 'km', label: 'Kilometres (odometer)' },
  { value: 'hours', label: 'Hours (hour meter)' },
  { value: 'none', label: 'No meter' },
];
export function rateUnit(meterUnit) {
  if (meterUnit === 'km') return 'L/100 km';
  if (meterUnit === 'hours') return 'L/h';
  return 'L/day';
}
export function meterWord(meterUnit) {
  if (meterUnit === 'km') return 'Odometer (km)';
  if (meterUnit === 'hours') return 'Hour meter';
  return 'Meter';
}

export const PHOTO_KINDS = {
  fill: ['meter', 'fill', 'pump_display', 'receipt', 'pump_meter_before', 'pump_meter_after', 'other'],
  dip: ['stick', 'other'],
  delivery: ['invoice', 'stick', 'truck', 'other'],
  transfer: ['containers', 'seals', 'pump_meter_before', 'pump_meter_after', 'received', 'other'],
};
const PHOTO_KIND_LABELS = {
  meter: 'Odometer / hour meter', fill: 'Fuel going in', pump_display: 'Pump display', receipt: 'Receipt',
  pump_meter_before: 'Pump meter before', pump_meter_after: 'Pump meter after', other: 'Other',
  stick: 'Dip stick', invoice: 'Invoice', truck: 'Delivery truck', containers: 'Containers', seals: 'Seals',
  received: 'Received at the farm',
};
export const photoKindLabel = (k) => PHOTO_KIND_LABELS[k] || k || 'Photo';

/** Which photo kind a new fill photo defaults to, for the form's kind. */
export function defaultPhotoKind(fillKind, existing = []) {
  const have = new Set(existing.map((p) => p.kind));
  const order = fillKind === 'cash_station' ? ['pump_display', 'meter', 'receipt', 'fill'] : ['meter', 'fill', 'pump_meter_before', 'pump_meter_after'];
  return order.find((k) => !have.has(k)) || 'other';
}

export const RULES = {
  T1: 'Tank does not add up',
  T2: 'Short delivery',
  T3: 'Missed dip',
  A1: 'High fuel use',
  A2: 'Meter not moving',
  A3: 'Meter went backwards',
  A4: 'Impossible meter jump',
  A5: 'More than the tank holds',
  A6: 'Refilled too soon',
  A7: 'Missing evidence',
  C0: 'No price to compare',
  C1: 'Paid above the posted price',
  C2: 'Paid for more than the tank holds',
  C5: 'Pump photo disagrees',
  M1: 'Pump meter disagrees',
  M2: 'Pump meter gap',
  F1: 'Lost on the way to the farm',
  Q1: 'Reached the office late',
};
export const ruleTitle = (k) => RULES[k] || k;

export const SEVERITIES = [
  { value: 'red', label: 'Red', tone: 'rose' },
  { value: 'amber', label: 'Amber', tone: 'amber' },
  { value: 'info', label: 'Info', tone: 'slate' },
];
export const severityOf = (s) => SEVERITIES.find((x) => x.value === s) || SEVERITIES[2];

/** The three review answers on a flag (§4: one flag is not proof — the note says why). */
export const FLAG_ACTIONS = [
  { status: 'dismissed', label: 'Checked — OK', needsNote: true, hint: 'Nothing wrong — say what you checked.' },
  { status: 'confirmed', label: 'Theft confirmed', needsNote: false, hint: 'Fuel really went missing. Add what happened.' },
  { status: 'explained', label: 'Error corrected', needsNote: true, hint: 'A typing or recording mistake that has been fixed.' },
];
export const FLAG_STATUS_LABEL = { open: 'Open', dismissed: 'Checked — OK', confirmed: 'Theft confirmed', explained: 'Error corrected' };

/** A review answer is valid when the note rule is met. Returns an error sentence or null. */
export function flagReviewError(status, note) {
  const action = FLAG_ACTIONS.find((a) => a.status === status);
  if (!action) return 'Pick an answer';
  if (action.needsNote && !String(note || '').trim()) return 'Add a short note — what did you check?';
  return null;
}

/* ─── names and lookups ───────────────────────────────────────────────── */

export function indexById(list) {
  const m = new Map();
  for (const x of Array.isArray(list) ? list : []) if (x && x.id) m.set(x.id, x);
  return m;
}

/** "Sokha (សុខា)" / "Sokha" / "សុខា" / the staff code. */
export function staffName(e) {
  if (!e) return '—';
  if (e.nameEn && e.nameKm) return `${e.nameEn} (${e.nameKm})`;
  return e.nameEn || e.nameKm || e.staffCode || 'Unnamed';
}

export function assetLabel(a) {
  if (!a) return '—';
  return a.plateOrSerial ? `${a.name} · ${a.plateOrSerial}` : a.name;
}

/* ─── flags: plain-English headline ───────────────────────────────────── */

/** How far `measured` is above `expected`, as a whole percent (null when unknown). */
export function percentOver(measured, expected) {
  if (!isNum(measured) || !isNum(expected) || expected <= 0) return null;
  return Math.round((measured / expected - 1) * 100);
}

/**
 * One sentence that says what the flag means, e.g. "Truck 3A used 35% more
 * than normal". The backend's `explanation` (with the formula and numbers) is
 * shown under it.
 */
export function flagHeadline(flag, lk = {}) {
  if (!flag) return '';
  const asset = flag.assetId ? lk.assets?.get(flag.assetId) : null;
  const loc = flag.locationId ? lk.locations?.get(flag.locationId) : null;
  const station = flag.stationId ? lk.stations?.get(flag.stationId) : null;
  const a = asset ? asset.name : 'A vehicle or machine';
  const t = loc ? loc.name : 'A tank';
  const pct = percentOver(flag.measured, flag.expected);
  const at = station ? ` at ${station.name}` : '';
  switch (flag.ruleKey) {
    case 'A1': return pct != null ? `${a} used ${pct}% more than normal` : `${a} used more fuel than normal`;
    case 'A2': return `${a}: the meter did not move, but fuel was added`;
    case 'A3': return `${a}: the meter went backwards`;
    case 'A4': return `${a}: the meter jumped further than is possible`;
    case 'A5': return `${a}: more fuel recorded than the tank holds`;
    case 'A6': return `${a} was refilled too soon`;
    case 'A7': return `${a}: a photo or reading is missing`;
    case 'C0': return `${a}: a cash fill could not be checked against a posted price`;
    case 'C1': return pct != null ? `${a}: paid ${pct}% above the posted price${at}` : `${a}: paid above the posted price${at}`;
    case 'C2': return `${a}: paid for more fuel than the tank holds${at}`;
    case 'C5': return `${a}: the pump photo does not match what was typed${at}`;
    case 'T1': {
      if (!isNum(flag.measured) || !isNum(flag.expected)) return `${t} does not add up`;
      const v = flag.measured - flag.expected;
      return v < 0 ? `${t}: ${fmtLitres(-v, 0)} unaccounted for` : `${t}: ${fmtLitres(v, 0)} more than recorded`;
    }
    case 'T2': {
      const short = isNum(flag.expected) && isNum(flag.measured) ? flag.expected - flag.measured : null;
      return short != null ? `${t}: delivery ${fmtLitres(short, 0)} short` : `${t}: delivery short`;
    }
    case 'T3': return isNum(flag.measured) ? `${t} has not been dipped for ${Math.floor(flag.measured)} days` : `${t} has not been dipped`;
    case 'M1': return `${t}: pump meter and typed litres disagree`;
    case 'M2': {
      const gap = isNum(flag.measured) && isNum(flag.expected) ? flag.measured - flag.expected : null;
      if (gap == null) return `${t}: pump meter readings do not follow on`;
      return gap > 0 ? `${t}: ${fmtLitres(gap, 1)} left the pump with no record` : `${t}: pump meter readings overlap`;
    }
    case 'F1': {
      const lost = isNum(flag.expected) && isNum(flag.measured) ? flag.expected - flag.measured : null;
      return lost != null ? `${t}: ${fmtLitres(lost, 1)} lost on the way to the farm` : `${t}: fuel lost on the way to the farm`;
    }
    case 'Q1': return `${t}: a phone entry reached the office late (the phone was offline)`;
    default: return flag.explanation || ruleTitle(flag.ruleKey);
  }
}

const SEV_ORDER = { red: 0, amber: 1, info: 2 };

/** Red first, then amber, then info; newest first within a severity. */
export function sortFlags(flags) {
  return (Array.isArray(flags) ? flags.slice() : []).sort((x, y) =>
    (SEV_ORDER[x.severity] ?? 3) - (SEV_ORDER[y.severity] ?? 3)
    || (toMillis(y.at ?? y.lastSeenAt) || 0) - (toMillis(x.at ?? x.lastSeenAt) || 0));
}

/* ─── fills: review queue ─────────────────────────────────────────────── */

/**
 * Fills waiting for a reviewer, OLDEST first (L6) — the order the queue is
 * worked through, so nothing waits forever behind newer fills. Checked, void
 * and superseded fills and duplicates (the same fill in two answers) are
 * dropped. A red flag is shown on the fill, not used to jump the queue.
 */
export function buildReviewQueue(items) {
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(items) ? items : []) {
    if (!f || seen.has(f.id) || f.voided || f.superseded || f.reviewStatus === 'checked') continue;
    seen.add(f.id);
    out.push(f);
  }
  return out.sort((a, b) => ((a.at || 0) - (b.at || 0)) || ((a.createdAt || 0) - (b.createdAt || 0)));
}

/** Where the litres figure came from, in words. */
export function litresSourceLabel(src) {
  switch (src) {
    case 'pump_meter': return 'from the pump meter';
    case 'cans': return 'cans × can size';
    case 'pump_display': return 'shown on the pump';
    case 'derived_from_price': return 'worked out from the price';
    case 'typed': return 'typed';
    default: return src || '';
  }
}

/**
 * The typed meter reading against the vehicle's previous one (from
 * `fuel:getFill`'s previousMeterFill / resetsSince): how far it went, or that
 * it went backwards. A meter reset in between counts both stretches.
 * Returns null when either reading is missing.
 */
export function meterSincePrevious(fill, previousMeterFill, resetsSince = []) {
  if (!isNum(fill?.meterReading) || !isNum(previousMeterFill?.meterReading)) return null;
  const resets = (Array.isArray(resetsSince) ? resetsSince : []).filter((r) => !r.voided && isNum(r.oldReading) && isNum(r.newReading));
  const last = resets.length ? resets.reduce((a, b) => (b.at > a.at ? b : a)) : null;
  const distance = last
    ? (last.oldReading - previousMeterFill.meterReading) + (fill.meterReading - last.newReading)
    : fill.meterReading - previousMeterFill.meterReading;
  return { distance, backwards: distance < 0, reset: !!last };
}

/* ─── fills: the paper-slip form ──────────────────────────────────────── */

export function emptyFillForm(now = Date.now(), defaults = {}) {
  return {
    kind: defaults.kind || 'warehouse_tank',
    assetId: '', locationId: '', stationId: '', stationName: '',
    driverEmployeeId: '', attendantEmployeeId: '',
    at: ppInputValue(now),
    litres: '', cansCount: '', pumpMeterBefore: '', pumpMeterAfter: '',
    meterReading: '', fullTank: true,
    amountPaid: '', currency: defaults.currency || 'KHR', litresShownOnPump: '',
    note: '',
  };
}

function positiveField(errors, form, key, label, { allowZero = false } = {}) {
  const n = parseNumber(form[key]);
  if (n == null) return null;
  if (Number.isNaN(n)) { errors[key] = `${label} must be a number`; return null; }
  if (allowZero ? n < 0 : n <= 0) { errors[key] = `${label} must be more than 0`; return null; }
  return n;
}

/**
 * Check the "+ Add fill-up" form and build the `fuel:recordFill` input.
 * `ctx` = { location, asset, now }. Returns `{ errors, payload }`; payload is
 * null while there are errors. The server checks everything again — this is
 * so the form can point at the field before anything is sent.
 */
export function validateFillForm(form, ctx = {}) {
  const errors = {};
  const now = ctx.now ?? Date.now();
  const cash = form.kind === 'cash_station';
  if (!FILL_KINDS.some((k) => k.value === form.kind)) errors.kind = 'Pick where the fuel came from';
  if (!form.assetId) errors.assetId = 'Pick the vehicle or machine';
  if (cash) {
    if (!form.stationId && !String(form.stationName || '').trim()) errors.stationId = 'Pick the station or type its name';
  } else if (!form.locationId) {
    errors.locationId = form.kind === 'farm_store' ? 'Pick the farm store' : 'Pick the tank';
  }
  // `ctx.timeIsNow`: the user may not give a time (no fuel.manage) — the
  // server records the moment it is saved, so none is checked or sent.
  const at = ctx.timeIsNow ? null : parsePpInput(form.at);
  if (!ctx.timeIsNow) {
    if (at == null) errors.at = 'Enter the date and time on the slip';
    else if (at > now + 60_000) errors.at = 'The time cannot be in the future';
  }

  const litres = positiveField(errors, form, 'litres', 'Litres');
  const cans = positiveField(errors, form, 'cansCount', 'Number of cans');
  if (cans != null && !Number.isInteger(cans)) errors.cansCount = 'Number of cans must be a whole number';
  const meter = positiveField(errors, form, 'meterReading', 'Meter reading', { allowZero: true });

  let pumpBefore = null;
  let pumpAfter = null;
  if (!cash && ctx.location?.hasFlowMeter) {
    pumpBefore = positiveField(errors, form, 'pumpMeterBefore', 'Pump meter before', { allowZero: true });
    pumpAfter = positiveField(errors, form, 'pumpMeterAfter', 'Pump meter after', { allowZero: true });
    const b = parseNumber(form.pumpMeterBefore);
    const a = parseNumber(form.pumpMeterAfter);
    if ((b == null) !== (a == null) && !errors.pumpMeterBefore && !errors.pumpMeterAfter) {
      errors[b == null ? 'pumpMeterBefore' : 'pumpMeterAfter'] = 'Enter both pump meter readings, or neither';
    } else if (pumpBefore != null && pumpAfter != null && pumpAfter <= pumpBefore && litres == null) {
      errors.pumpMeterAfter = '"After" must be higher than "before"';
    }
  }

  let amountPaidMinor = null;
  let shown = null;
  const currency = form.currency === 'USD' ? 'USD' : 'KHR';
  if (cash) {
    const paid = positiveField(errors, form, 'amountPaid', 'Amount paid');
    if (paid == null && !errors.amountPaid) errors.amountPaid = 'Enter the amount paid';
    if (paid != null) amountPaidMinor = toMinor(paid, currency);
    shown = positiveField(errors, form, 'litresShownOnPump', 'Litres shown on the pump');
  } else if (litres == null && cans == null && (pumpBefore == null || pumpAfter == null) && !errors.litres && !errors.cansCount) {
    errors.litres = ctx.location?.hasFlowMeter ? 'Enter the litres, or both pump meter readings' : 'Enter the litres';
  }
  if (ctx.asset?.tankCapacityL && litres != null && litres > ctx.asset.tankCapacityL * 1.5 && !errors.litres) {
    errors.litres = `That is far more than the ${fmtLitres(ctx.asset.tankCapacityL, 0)} tank holds — check the slip`;
  }

  if (Object.keys(errors).length) return { errors, payload: null };
  const payload = {
    kind: form.kind,
    assetId: form.assetId,
    source: 'mac',
    fullTank: !!form.fullTank,
  };
  if (at != null) payload.at = at;
  if (cash) {
    if (form.stationId) payload.stationId = form.stationId;
    else payload.stationName = String(form.stationName).trim();
    payload.amountPaidMinor = amountPaidMinor;
    payload.currency = currency;
    if (shown != null) payload.litresShownOnPump = shown;
  } else {
    payload.locationId = form.locationId;
    if (pumpBefore != null && pumpAfter != null) { payload.pumpMeterBefore = pumpBefore; payload.pumpMeterAfter = pumpAfter; }
  }
  if (litres != null) payload.litres = litres;
  if (cans != null) payload.cansCount = cans;
  if (meter != null) payload.meterReading = meter;
  if (form.driverEmployeeId) payload.driverEmployeeId = form.driverEmployeeId;
  if (form.attendantEmployeeId) payload.attendantEmployeeId = form.attendantEmployeeId;
  if (String(form.note || '').trim()) payload.note = String(form.note).trim();
  return { errors: {}, payload };
}

/* ─── fills: corrections (a new revision with a reason) ───────────────── */

const numStr = (v) => (isNum(v) ? String(v) : '');

/** The fields a reviewer may correct, as form strings. */
export function fillToCorrectionForm(fill) {
  const cur = fill?.currency === 'USD' ? 'USD' : 'KHR';
  return {
    assetId: fill?.assetId || '',
    driverEmployeeId: fill?.driverEmployeeId || '',
    attendantEmployeeId: fill?.attendantEmployeeId || '',
    at: fill?.at ? ppInputValue(fill.at) : '',
    litres: numStr(fill?.typedLitres),
    meterReading: numStr(fill?.meterReading),
    fullTank: !!fill?.fullTank,
    pumpMeterBefore: numStr(fill?.pumpMeterBefore),
    pumpMeterAfter: numStr(fill?.pumpMeterAfter),
    amountPaid: isNum(fill?.amountPaidMinor) ? String(fromMinor(fill.amountPaidMinor, cur)) : '',
    litresShownOnPump: numStr(fill?.litresShownOnPump),
    note: fill?.note || '',
  };
}

/**
 * Only what changed, as a `fuel:correctFill` patch. Returns `{ errors, patch }`;
 * an empty patch means nothing changed.
 */
export function diffFillCorrection(fill, form) {
  const errors = {};
  const patch = {};
  const before = fillToCorrectionForm(fill);
  for (const key of ['assetId', 'driverEmployeeId', 'attendantEmployeeId']) {
    if ((form[key] || '') !== before[key]) {
      if (key === 'assetId' && !form[key]) errors.assetId = 'Pick the vehicle or machine';
      else patch[key] = form[key] || null;
    }
  }
  if (form.at !== before.at) {
    const at = parsePpInput(form.at);
    if (at == null) errors.at = 'Enter the date and time';
    else if (at > Date.now() + 60_000) errors.at = 'The time cannot be in the future';
    else patch.at = at;
  }
  for (const [key, label] of [['litres', 'Litres'], ['meterReading', 'Meter reading'], ['pumpMeterBefore', 'Pump meter before'],
    ['pumpMeterAfter', 'Pump meter after'], ['litresShownOnPump', 'Litres shown on the pump']]) {
    if (String(form[key] ?? '').trim() === before[key]) continue;
    const n = parseNumber(form[key]);
    if (Number.isNaN(n)) { errors[key] = `${label} must be a number`; continue; }
    if (n != null && n < 0) { errors[key] = `${label} cannot be negative`; continue; }
    patch[key] = n;
  }
  if (String(form.amountPaid ?? '').trim() !== before.amountPaid) {
    const n = parseNumber(form.amountPaid);
    const cur = fill?.currency === 'USD' ? 'USD' : 'KHR';
    if (n == null || Number.isNaN(n) || n <= 0) errors.amountPaid = 'Enter the amount paid';
    else patch.amountPaidMinor = toMinor(n, cur);
  }
  if (!!form.fullTank !== before.fullTank) patch.fullTank = !!form.fullTank;
  if ((form.note || '') !== before.note) patch.note = form.note || null;
  return { errors, patch };
}

/* ─── tanks: dip chart and reconciliation ─────────────────────────────── */

/**
 * Parse a pasted dip chart: one "cm litres" pair per line, separated by spaces,
 * a tab (from Excel) or a comma/semicolon. A header line is skipped.
 */
export function parseChartText(text) {
  const points = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw) return;
    const parts = raw.split(/[\t;]+|\s*,\s*|\s+/).filter(Boolean);
    const cm = parseNumber(parts[0]);
    const l = parseNumber(parts[1]);
    if (parts.length < 2 || cm == null || l == null || Number.isNaN(cm) || Number.isNaN(l)) {
      if (i === 0 && Number.isNaN(cm)) return; // header row
      errors.push(`Line ${i + 1}: needs two numbers, cm and litres`);
      return;
    }
    points.push({ dipCm: cm, litres: l });
  });
  return { points, errors };
}

/** Same rules as the server's normalizeChart; returns an error sentence or null. */
export function chartError(points) {
  const list = (Array.isArray(points) ? points : []).filter((p) => p && (p.dipCm !== '' || p.litres !== ''));
  const clean = [];
  for (const p of list) {
    const cm = parseNumber(p.dipCm);
    const l = parseNumber(p.litres);
    if (cm == null || l == null || Number.isNaN(cm) || Number.isNaN(l)) return 'Every row needs a number of cm and a number of litres';
    if (cm < 0 || l < 0) return 'Chart values cannot be negative';
    clean.push({ dipCm: cm, litres: l });
  }
  if (clean.length < 2) return 'A dip chart needs at least two rows';
  clean.sort((a, b) => a.dipCm - b.dipCm);
  let up = 0;
  let down = 0;
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i].dipCm === clean[i - 1].dipCm) return `${clean[i].dipCm} cm is in the chart twice`;
    if (clean[i].litres > clean[i - 1].litres) up += 1;
    if (clean[i].litres < clean[i - 1].litres) down += 1;
  }
  if (up && down) return 'Litres must only go up (or only go down) as the cm rise';
  if (!up && !down) return 'The litres cannot be the same on every row';
  return null;
}

/** Chart rows (strings or numbers) → sorted numeric points for `fuel:setChart`. */
export function chartPoints(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ dipCm: parseNumber(r.dipCm), litres: parseNumber(r.litres) }))
    .filter((p) => isNum(p.dipCm) && isNum(p.litres))
    .sort((a, b) => a.dipCm - b.dipCm);
}

/** One dip-to-dip interval's verdict, by the T1 rule. */
export function intervalVerdict(iv) {
  if (!iv || !isNum(iv.variance) || !isNum(iv.tolerance)) return 'unknown';
  if (iv.variance < -iv.tolerance) return 'red';
  if (iv.variance > iv.tolerance) return 'amber';
  return 'ok';
}

/** How old the last dip is, and whether it is past the "dip every N days" rule. */
export function dipAge(lastDip, missedDipDays = 2, now = Date.now()) {
  if (!lastDip || !isNum(lastDip.takenAt)) return { days: null, stale: true, never: true };
  const days = Math.max(0, (now - lastDip.takenAt) / DAY_MS);
  return { days: Math.floor(days), stale: days > missedDipDays, never: false };
}

/* ─── reports ─────────────────────────────────────────────────────────── */

/** Drivers ranked by excess riel, biggest first; unknown excess last. */
export function rankDrivers(drivers) {
  return (Array.isArray(drivers) ? drivers.slice() : []).sort((a, b) => {
    const ax = isNum(a.excessRiel) ? a.excessRiel : -Infinity;
    const bx = isNum(b.excessRiel) ? b.excessRiel : -Infinity;
    return bx - ax || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/* ─── settings → Fuel ─────────────────────────────────────────────────── */

/**
 * The thresholds the owner may change, with plain labels. `kind: 'pctOver'`
 * shows a ratio (1.2) as "% over" (20); `range` is the server's
 * SETTING_RANGES in stored units (test/fuelUiModel.test.js keeps both in step).
 */
export const FUEL_SETTING_GROUPS = [
  {
    title: 'Tanks and dips',
    fields: [
      { key: 'missedDipDays', label: 'Dip each tank at least every', unit: 'days', def: 2, range: [1, 60], step: 1 },
      { key: 'dipAllowedCm', label: 'A dip may be misread by up to', unit: 'cm', def: 1, range: [0, 20], step: 0.5 },
      { key: 'tankTolerancePct', label: 'Also allow this share of the litres moved', unit: '%', def: 0.5, range: [0, 20], step: 0.1 },
      { key: 'shortDeliveryRedMultiple', label: 'A short delivery turns red at this many times the allowance', unit: '×', def: 2, range: [1, 20], step: 0.5 },
      { key: 'transferLossAmberPct', label: 'Amber when a transfer to the farm loses more than', unit: '%', def: 2, range: [0, 100], step: 0.5 },
      { key: 'transferLossRedPct', label: 'Red when it loses more than', unit: '%', def: 5, range: [0, 100], step: 0.5 },
    ],
  },
  {
    title: 'Fuel use per vehicle',
    fields: [
      { key: 'a1AmberRatio', kind: 'pctOver', label: 'Amber when a vehicle uses more than normal by', unit: '%', def: 1.2, range: [1, 5], step: 1 },
      { key: 'a1RedRatio', kind: 'pctOver', label: 'Red when it uses more than normal by', unit: '%', def: 1.35, range: [1, 5], step: 1 },
      { key: 'baselineSamples', label: '"Normal" is the median of the last', unit: 'full-to-full fills', def: 8, range: [1, 50], step: 1 },
      { key: 'baselineWindowDays', label: '…within the last', unit: 'days', def: 120, range: [7, 730], step: 1 },
      { key: 'baselineMinSamples', label: 'Use your own figure until there are at least', unit: 'fills', def: 3, range: [1, 50], step: 1 },
      { key: 'maxKmPerDayDefault', label: 'Most km a vehicle can drive in a day (when its type sets none)', unit: 'km', def: 600, range: [1, 5000], step: 10 },
      { key: 'maxHoursPerDay', label: 'Most hours a machine can run in a day', unit: 'hours', def: 24, range: [1, 24], step: 1 },
      { key: 'tankOverfillRatio', kind: 'pctOver', label: 'A fill may exceed the tank size by', unit: '%', def: 1.05, range: [1, 2], step: 1 },
      { key: 'refillTooSoonPct', label: '"Refilled too soon" below this share of a full tank\'s range', unit: '%', def: 25, range: [0, 100], step: 1 },
    ],
  },
  {
    title: 'Cash purchases at stations',
    fields: [
      { key: 'c1PriceRatio', kind: 'pctOver', label: 'Amber when paid above the posted price by', unit: '%', def: 1.02, range: [1, 5], step: 1 },
      { key: 'c1RedRatio', kind: 'pctOver', label: 'Red when paid above the posted price by', unit: '%', def: 1.1, range: [1, 5], step: 1 },
      { key: 'c5TolerancePct', label: 'Pump photo may differ from the typed figures by', unit: '%', def: 1, range: [0, 50], step: 0.5 },
    ],
  },
  {
    title: 'Pump flow meter',
    fields: [
      { key: 'meterTolerancePct', label: 'Pump meter may differ from typed litres by', unit: '%', def: 1, range: [0, 50], step: 0.5 },
      { key: 'meterToleranceL', label: '…or by this many litres, whichever is larger', unit: 'L', def: 0.5, range: [0, 100], step: 0.5 },
      { key: 'meterGapToleranceL', label: 'Gap allowed between one record\'s "after" and the next "before"', unit: 'L', def: 0.5, range: [0, 100], step: 0.5 },
    ],
  },
  {
    title: 'Photos and entry',
    fields: [
      { key: 'photoRetentionMonths', label: 'Keep fuel photos for', unit: 'months', def: 24, range: [1, 240], step: 1 },
      { key: 'canSizeL', label: 'Size of one can', unit: 'L', def: 20, range: [1, 1000], step: 1 },
      { key: 'queuedNoteMinutes', label: 'Note a phone entry that waited offline longer than', unit: 'minutes', def: 15, range: [1, 10080], step: 1 },
    ],
  },
];
export const FUEL_SETTING_FIELDS = FUEL_SETTING_GROUPS.flatMap((g) => g.fields);

/** Stored value → what the field shows (ratios as "% over"). */
export function settingToDisplay(field, value) {
  if (!isNum(value)) return '';
  if (field.kind === 'pctOver') return String(Math.round((value - 1) * 1000) / 10);
  return String(value);
}

/** What was typed → `{ value }` in stored units, or `{ error }`. */
export function displayToSetting(field, text) {
  const n = parseNumber(text);
  if (n == null || Number.isNaN(n)) return { error: 'Enter a number' };
  const value = field.kind === 'pctOver' ? Math.round((1 + n / 100) * 10000) / 10000 : n;
  const [min, max] = field.range;
  if (value < min || value > max) {
    const lo = settingToDisplay(field, min);
    const hi = settingToDisplay(field, max);
    return { error: `Use ${lo} to ${hi}` };
  }
  return { value };
}

/* ─── photos ──────────────────────────────────────────────────────────── */

/** Bytes as they arrive over IPC (Uint8Array, ArrayBuffer, a serialized Buffer) → Uint8Array. */
export function toUint8(bytes) {
  if (!bytes) return null;
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.type === 'Buffer' && Array.isArray(bytes.data)) return Uint8Array.from(bytes.data);
  return null;
}

export const MAX_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** Why a picked file cannot be added, or null. */
export function photoFileError(file, count) {
  if (count >= MAX_PHOTOS) return `At most ${MAX_PHOTOS} photos per record`;
  if (!file || !/^image\//.test(file.type || '')) return 'That file is not a picture';
  if (file.size > MAX_PHOTO_BYTES) return 'That photo is larger than 15 MB';
  return null;
}

/* ─── simple record forms ─────────────────────────────────────────────── */

export function validateAssetForm(form) {
  const errors = {};
  if (!String(form.name || '').trim()) errors.name = 'Give it a name, e.g. Truck 3A';
  if (!form.typeId) errors.typeId = 'Pick a type';
  for (const [key, label] of [['tankCapacityL', 'Tank size'], ['baselineRate', 'Normal use']]) {
    const n = parseNumber(form[key]);
    if (n != null && (Number.isNaN(n) || n <= 0)) errors[key] = `${label} must be a number more than 0`;
  }
  return errors;
}

export function validateStaffForm(form) {
  const errors = {};
  if (!String(form.staffCode || '').trim()) errors.staffCode = 'Give each person a short code, e.g. D01';
  if (!String(form.nameEn || '').trim() && !String(form.nameKm || '').trim()) errors.nameEn = 'Enter a name in English or Khmer';
  return errors;
}

/**
 * The message to show for a failed call. The server's sentences are already
 * plain; the one exception is the optimistic-save conflict, which arrives as
 * `CONFLICT|{json}`.
 */
export function errText(err) {
  const msg = String(err?.message ?? err ?? 'Something failed');
  if (msg.startsWith('CONFLICT|')) return 'Someone else changed this while it was open. Close it and open it again to see their change.';
  return msg;
}

/* ─── photo cache (L9) ────────────────────────────────────────────────── */

export const PHOTO_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const PHOTO_CACHE_MAX_ENTRIES = 600;

/**
 * Least-recently-used cache of loaded photos, capped by bytes (and entries).
 * `load(key, fetcher)` shares one load per key; the fetcher resolves to
 * `{ url, size, … }` or null. Evicted values go to `release` (the hook revokes
 * the blob URL). A photo still loading, and the one just loaded, are never
 * evicted — a component waiting on it would get a dead URL.
 */
export function createPhotoCache({ maxBytes = PHOTO_CACHE_MAX_BYTES, maxEntries = PHOTO_CACHE_MAX_ENTRIES, release = () => {} } = {}) {
  const entries = new Map(); // key → { promise, size, done }
  let bytes = 0;
  function evict(keep) {
    for (const [key, e] of [...entries]) {
      if (bytes <= maxBytes && entries.size <= maxEntries) break;
      if (key === keep || !e.done) continue;
      entries.delete(key);
      bytes -= e.size;
      e.promise.then((v) => { if (v) release(v); }).catch(() => {});
    }
  }
  function get(key) {
    const e = entries.get(key);
    if (!e) return null;
    entries.delete(key); // the most recently used goes last
    entries.set(key, e);
    return e.promise;
  }
  function load(key, fetcher) {
    const hit = get(key);
    if (hit) return hit;
    const e = { promise: null, size: 0, done: false };
    e.promise = Promise.resolve().then(fetcher).then((v) => {
      e.done = true;
      if (entries.get(key) === e) {
        e.size = (v && v.size) || 0;
        bytes += e.size;
        evict(key);
      }
      return v;
    });
    e.promise.catch(() => { if (entries.get(key) === e) entries.delete(key); });
    entries.set(key, e);
    return e.promise;
  }
  return { get, load, has: (key) => entries.has(key), get bytes() { return bytes; }, get size() { return entries.size; } };
}
