/**
 * Fuel F1: anomaly rules (docs/PEOPLE_AND_FUEL_PLAN.md §4).
 *
 * Pure functions: rows in, flags out. The database layer (main/db/fuelFlags.js)
 * gathers the rows for one asset or one stock location, calls these, and
 * upserts the result into `fuel_flags` keyed by UNIQUE(rule_key, subject) — so
 * re-running a rule updates the numbers on an existing flag and never touches
 * its review.
 *
 * Every flag carries its formula's numbers (`measured`, `expected`,
 * `threshold`) and a plain-English `explanation`, because one flag is not
 * proof — the owner reads the pattern, and has to be able to check each step.
 *
 * Rules implemented here (all thresholds come from `settings`, defaults in
 * DEFAULT_SETTINGS and editable per company):
 *
 *   T1 tank reconciliation between two dips       red/amber
 *   T2 short delivery                              amber/red
 *   T3 missed dip                                  amber
 *   A1 high fuel use, full-to-full vs baseline     amber/red
 *   A2 meter not moving                            amber
 *   A3 meter going backwards (no reset recorded)   red
 *   A4 impossible jump                             red
 *   A5 more than the tank holds                    red
 *   A6 refilled too soon                           amber
 *   A7 missing evidence                            amber
 *   C1 paid above the posted price                 amber/red
 *   C2 paid for more than the tank holds           red
 *   C5 reviewer's reading of the pump photo ≠ typed red
 *   M1 pump flow meter litres ≠ typed litres       amber (red if the meter ran backwards)
 *   M2 pump meter continuity gap                   red (gap) / amber (overlap)
 *
 * Shapes (camelCase, as the DB mappers return them):
 *   fill     { id, rootId, kind, locationId, stationId, assetId, driverEmployeeId,
 *              attendantEmployeeId, at, litres, typedLitres, pumpMeterBefore,
 *              pumpMeterAfter, meterReading, fullTank, amountPaidMinor, currency,
 *              litresShownOnPump, fuelType, reviewedAmountMinor, reviewedLitres,
 *              photoKinds: string[] }
 *   dip      { id, locationId, takenAt, dipCm, litres }
 *   delivery { id, locationId, deliveredAt, litresInvoiced, dipBeforeId, dipAfterId }
 *   transfer { id, fromLocationId, toLocationId, litresSent, sentAt, litresReceived,
 *              receivedAt, pumpMeterBefore, pumpMeterAfter }
 *   reset    { id, assetId, locationId, at, oldReading, newReading }
 */

const { dipErrorLitres } = require('./tankCalibration');

const DAY_MS = 24 * 60 * 60 * 1000;
// Cambodia is UTC+7 all year (no daylight saving), so a fixed offset is exact.
const PHNOM_PENH_OFFSET_MS = 7 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
  dipAllowedCm: 1,              // T1/T2: a dip may be misread by this many cm
  tankTolerancePct: 0.5,        // T1/T2: plus this % of the litres moved
  missedDipDays: 2,             // T3
  shortDeliveryRedMultiple: 2,  // T2: red when the shortfall is this many tolerances
  a1AmberRatio: 1.2,            // A1
  a1RedRatio: 1.35,             // A1
  baselineSamples: 8,           // learned baseline: median of the last N intervals…
  baselineWindowDays: 120,      // …within this many days
  baselineMinSamples: 3,        // fewer than this → the owner's figure is used
  maxKmPerDayDefault: 600,      // A4 when the asset type sets none
  maxHoursPerDay: 24,           // A4 for hour meters
  tankOverfillRatio: 1.05,      // A5
  refillTooSoonPct: 25,         // A6
  c1PriceRatio: 1.02,           // C1 amber
  c1RedRatio: 1.1,              // C1 red
  c5TolerancePct: 1,            // C5
  meterTolerancePct: 1,         // M1: pump meter vs typed litres…
  meterToleranceL: 0.5,         // …or this many litres, whichever is larger
  meterGapToleranceL: 0.5,      // M2
  photoRetentionMonths: 24,     // owner decision 2026-10-08
  canSizeL: 20,                 // phone: "20 L can × N"
  defaultCurrency: 'KHR',
  transferLossAmberPct: 2,      // F1 transfer loss (§4.4): sent − received over 2 % amber…
  transferLossRedPct: 5,        // …over 5 % red
  queuedNoteMinutes: 15,        // Q1: a phone record that waited longer than this is noted for review
  // Realistic-data review (2026-10-08):
  typedDipErrorMinL: 5,         // T1/T2: a level read without a chart (sight gauge, typed litres) may be off by
  typedDipErrorPct: 1,          //   max(this many litres, this % of the tank's capacity)
  t1GraceMinutes: 120,          // T1: "more fuel than recorded" on a dip this fresh waits for the delivery to be typed in
  a1MinLitres: 20,              // A1: judge fuel use only over at least this many litres (short intervals are merged)
  a1MinDaysNoMeter: 7,          // A1: machines without a meter (L/day) are judged over at least this many days
  usdStreetRatePct: 3,          // C1: a USD payment converted to riel gets this extra allowance (street rate)
  attendantWindowDays: 60,      // P1: compare attendants over this many days
  attendantMinIntervals: 20,    // P1: …with at least this many full-to-full fills on each side
  attendantAmberPct: 2.5,       // P1: amber when an attendant's fills are followed by this much more fuel use…
  attendantRedPct: 5,           // P1: …red at this much
});

/** Allowed range per numeric setting: [min, max]. */
const SETTING_RANGES = {
  dipAllowedCm: [0, 20],
  tankTolerancePct: [0, 20],
  missedDipDays: [1, 60],
  shortDeliveryRedMultiple: [1, 20],
  a1AmberRatio: [1, 5],
  a1RedRatio: [1, 5],
  baselineSamples: [1, 50],
  baselineWindowDays: [7, 730],
  baselineMinSamples: [1, 50],
  maxKmPerDayDefault: [1, 5000],
  maxHoursPerDay: [1, 24],
  tankOverfillRatio: [1, 2],
  refillTooSoonPct: [0, 100],
  c1PriceRatio: [1, 5],
  c1RedRatio: [1, 5],
  c5TolerancePct: [0, 50],
  meterTolerancePct: [0, 50],
  meterToleranceL: [0, 100],
  meterGapToleranceL: [0, 100],
  photoRetentionMonths: [1, 240],
  canSizeL: [1, 1000],
  transferLossAmberPct: [0, 100],
  transferLossRedPct: [0, 100],
  queuedNoteMinutes: [1, 10080],
  typedDipErrorMinL: [0, 1000],
  typedDipErrorPct: [0, 20],
  t1GraceMinutes: [0, 1440],
  a1MinLitres: [0, 1000],
  a1MinDaysNoMeter: [1, 90],
  usdStreetRatePct: [0, 50],
  attendantWindowDays: [14, 365],
  attendantMinIntervals: [3, 500],
  attendantAmberPct: [0, 100],
  attendantRedPct: [0, 100],
};

/** Merge stored settings over the defaults, dropping anything unknown or out of range. */
function mergeSettings(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const [k, v] of Object.entries(stored)) {
      if (k === 'defaultCurrency' && (v === 'KHR' || v === 'USD')) out[k] = v;
      const r = SETTING_RANGES[k];
      if (r && typeof v === 'number' && Number.isFinite(v) && v >= r[0] && v <= r[1]) out[k] = v;
    }
  }
  return out;
}

/** Check a settings patch; throws with the first problem. Returns the clean patch. */
function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object');
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'defaultCurrency') {
      if (v !== 'KHR' && v !== 'USD') throw new Error('defaultCurrency must be KHR or USD');
      clean[k] = v;
      continue;
    }
    const r = SETTING_RANGES[k];
    if (!r) throw new Error(`Unknown fuel setting: ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r[0] || v > r[1]) {
      throw new Error(`${k} must be a number from ${r[0]} to ${r[1]}`);
    }
    clean[k] = v;
  }
  return clean;
}

/* ─── small helpers ─────────────────────────────────────────────── */

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function round(n, d = 2) { const f = 10 ** d; return Math.round(n * f) / f; }

/** 'YYYY-MM-DD' in Asia/Phnom_Penh. */
function phnomPenhDate(at) {
  return new Date(Number(at) + PHNOM_PENH_OFFSET_MS).toISOString().slice(0, 10);
}
function phnomPenhMonth(at) { return phnomPenhDate(at).slice(0, 7); }

/** [startMs, endMs) of a 'YYYY-MM' month in Phnom Penh time. */
function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) throw new Error('month must look like 2026-10');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error('month must look like 2026-10');
  const start = Date.UTC(y, mo - 1, 1) - PHNOM_PENH_OFFSET_MS;
  const end = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - PHNOM_PENH_OFFSET_MS;
  return { start, end };
}

function fmtNum(n, d = 1) {
  if (!isNum(n)) return '—';
  return Number(round(n, d)).toLocaleString('en-US', { maximumFractionDigits: d });
}
function fmtL(n) { return `${fmtNum(n, 1)} L`; }
function fmtMoney(minor, currency) {
  if (!isNum(minor)) return '—';
  if (currency === 'USD') return `$${(minor / 100).toFixed(2)}`;
  return `${Math.round(minor).toLocaleString('en-US')} ${currency || 'KHR'}`;
}

function median(values) {
  const v = values.filter(isNum).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function byTime(key) {
  return (a, b) => (a[key] - b[key]) || String(a.id).localeCompare(String(b.id));
}

function flag(ruleKey, severity, subject, fields) {
  return {
    ruleKey,
    severity,
    subject,
    subjectKind: fields.subjectKind,
    subjectId: fields.subjectId,
    at: fields.at,
    period: phnomPenhMonth(fields.at),
    measured: isNum(fields.measured) ? round(fields.measured, 4) : null,
    expected: isNum(fields.expected) ? round(fields.expected, 4) : null,
    threshold: isNum(fields.threshold) ? round(fields.threshold, 4) : null,
    unit: fields.unit || null,
    explanation: fields.explanation,
    refs: {
      assetId: fields.assetId ?? null,
      locationId: fields.locationId ?? null,
      employeeId: fields.employeeId ?? null,
      stationId: fields.stationId ?? null,
    },
    details: fields.details || null,
  };
}

/* ─── meters and resets ─────────────────────────────────────────── */

/**
 * Distance between two meter readings, walking through any meter resets
 * recorded between them (a replaced odometer is not "going backwards").
 * Returns { distance, lastBase, resetCount } where `lastBase` is the reading
 * the later one is compared with (the last reset's new reading, if any).
 */
function meterDistance(fromReading, fromAt, toReading, toAt, resets) {
  let base = fromReading;
  let distance = 0;
  let resetCount = 0;
  for (const r of (resets || []).slice().sort(byTime('at'))) {
    if (r.at > fromAt && r.at <= toAt && isNum(r.oldReading) && isNum(r.newReading)) {
      distance += r.oldReading - base;
      base = r.newReading;
      resetCount += 1;
    }
  }
  distance += toReading - base;
  return { distance, lastBase: base, resetCount };
}

/**
 * Litres from a pump flow meter (owner decision §7a). `typed` is what the
 * person also typed, if anything. Returns { litres, source, meterLitres,
 * disagreement } — the stored litres are the meter's, and a disagreement over
 * tolerance becomes flag M1.
 */
function resolvePumpMeterLitres({ before, after, typed }, settings = DEFAULT_SETTINGS) {
  if (!isNum(before) || !isNum(after)) {
    return { litres: isNum(typed) ? typed : null, source: 'typed', meterLitres: null, disagreement: false };
  }
  const meterLitres = round(after - before, 3);
  if (meterLitres < 0) {
    return { litres: isNum(typed) ? typed : null, source: 'typed', meterLitres, disagreement: true, backwards: true };
  }
  const tol = Math.max(settings.meterToleranceL, (settings.meterTolerancePct / 100) * meterLitres);
  const disagreement = isNum(typed) && Math.abs(typed - meterLitres) > tol;
  return { litres: meterLitres, source: 'pump_meter', meterLitres, disagreement, tolerance: tol };
}

/* ─── cash maths (§4.3) ─────────────────────────────────────────── */

/**
 * The amount paid, in the published price's currency (minor units). A USD
 * payment against a KHR price (or the other way round) is converted at the
 * server's exchange rate (riel per US dollar); null when it cannot be compared.
 */
function comparableAmount(fill, priceCurrency, fxKhrPerUsd) {
  const cur = fill.currency || 'KHR';
  if (cur === priceCurrency) return fill.amountPaidMinor;
  if (!isNum(fxKhrPerUsd) || fxKhrPerUsd <= 0) return null;
  if (cur === 'USD' && priceCurrency === 'KHR') return (fill.amountPaidMinor / 100) * fxKhrPerUsd;
  if (cur === 'KHR' && priceCurrency === 'USD') return (fill.amountPaidMinor / fxKhrPerUsd) * 100;
  return null;
}

/**
 *   expected_L    = amount_paid ÷ price_published
 *   implied_price = amount_paid ÷ litres_shown_on_pump
 * in the published price's currency (converted at `fxKhrPerUsd` when the
 * payment was in the other one). `comparable: false` when there is no price,
 * or no exchange rate to compare with.
 */
function cashFigures(fill, price, fxKhrPerUsd = null) {
  const out = { expectedLitres: null, impliedPriceMinorPerL: null, publishedMinorPerL: null, priceRatio: null, comparable: false, currency: null, amount: null };
  if (!isNum(fill?.amountPaidMinor) || fill.amountPaidMinor <= 0) return out;
  if (!price || !isNum(price.priceMinorPerL) || price.priceMinorPerL <= 0) return out;
  const amount = comparableAmount(fill, price.currency, fxKhrPerUsd);
  if (!isNum(amount)) return out;
  out.comparable = true;
  out.currency = price.currency;
  out.amount = amount;
  out.publishedMinorPerL = price.priceMinorPerL;
  out.expectedLitres = amount / price.priceMinorPerL;
  if (isNum(fill.litresShownOnPump) && fill.litresShownOnPump > 0) {
    out.impliedPriceMinorPerL = amount / fill.litresShownOnPump;
    out.priceRatio = out.impliedPriceMinorPerL / out.publishedMinorPerL;
  }
  return out;
}

/* ─── baselines ─────────────────────────────────────────────────── */

/**
 * The owner's figure until there is data; then (when the asset is set to
 * `learned`) the median of the last N full-to-full intervals within the window
 * that ended before `asOf`.
 */
function resolveBaseline(asset, priorIntervals, asOf, settings = DEFAULT_SETTINGS, upto = null) {
  const manual = isNum(asset?.baselineRate) && asset.baselineRate > 0 ? asset.baselineRate : null;
  if (asset?.baselineSource === 'learned') {
    // Intervals are in time order: walk back from `upto` (exclusive) and stop
    // at the window edge or once N samples are in — O(N), not O(history).
    const list = priorIntervals || [];
    const since = asOf - settings.baselineWindowDays * DAY_MS;
    const rates = [];
    for (let i = Math.min(upto ?? list.length, list.length) - 1; i >= 0 && rates.length < settings.baselineSamples; i -= 1) {
      const iv = list[i];
      if (iv.toAt >= asOf) continue;
      if (iv.toAt < since) break;
      if (isNum(iv.rate)) rates.push(iv.rate);
    }
    if (rates.length >= settings.baselineMinSamples) {
      return { value: median(rates), source: 'learned', samples: rates.length };
    }
  }
  return { value: manual, source: manual == null ? null : 'manual', samples: 0 };
}

function rateUnit(meterUnit) {
  if (meterUnit === 'km') return 'L/100 km';
  if (meterUnit === 'hours') return 'L/h';
  return 'L/day';
}

/** Litres per distance unit: 100 × L ÷ km, L ÷ h, or L ÷ days. */
function consumptionRate(litres, distance, meterUnit) {
  if (!isNum(litres) || !isNum(distance) || distance <= 0) return null;
  return meterUnit === 'km' ? (100 * litres) / distance : litres / distance;
}

/** Litres the asset "should" have used over `distance` at `baseline`. */
function baselineLitres(distance, baseline, meterUnit) {
  if (!isNum(distance) || !isNum(baseline)) return null;
  return meterUnit === 'km' ? (distance * baseline) / 100 : distance * baseline;
}

/* ─── asset rules: A1–A7, C1, C2, C5 ────────────────────────────── */

/**
 * @param {object} p
 * @param {object} p.asset   { id, name, meterUnit, tankCapacityL, baselineRate, baselineSource, fuelType, maxPerDay }
 * @param {object[]} p.fills active fills of this asset (voided/superseded already removed)
 * @param {object[]} p.resets meter resets of this asset (active)
 * @param {function} p.priceFor (fuelType, at) → { priceMinorPerL, currency } | null
 * @returns {{ flags, segments, intervals }}
 */
function assetRules({ asset, fills, resets = [], priceFor = () => null, settings = DEFAULT_SETTINGS, fxKhrPerUsd = null }) {
  const s = mergeSettings(settings);
  const flags = [];
  const segments = [];
  const intervals = [];
  const list = (fills || []).slice().sort(byTime('at'));
  const meterUnit = asset.meterUnit || 'none';
  const hasMeter = meterUnit === 'km' || meterUnit === 'hours';
  const capacity = isNum(asset.tankCapacityL) && asset.tankCapacityL > 0 ? asset.tankCapacityL : null;
  const unit = rateUnit(meterUnit);
  const refs = (f) => ({ assetId: asset.id, employeeId: f.driverEmployeeId ?? null, locationId: f.locationId ?? null, stationId: f.stationId ?? null });

  // Segments between consecutive fills that both have a meter reading.
  let prev = null;
  for (const f of list) {
    if (!hasMeter || !isNum(f.meterReading)) continue;
    if (prev) {
      const { distance, lastBase, resetCount } = meterDistance(prev.meterReading, prev.at, f.meterReading, f.at, resets);
      const lastLeg = f.meterReading - lastBase;
      const days = (f.at - prev.at) / DAY_MS;
      segments.push({
        fromFillId: prev.rootId || prev.id, toFillId: f.rootId || f.id, fromAt: prev.at, toAt: f.at,
        distance: lastLeg < 0 ? null : distance, days, resetCount, toDriverEmployeeId: f.driverEmployeeId ?? null,
      });
      const subject = `fill:${f.rootId || f.id}`;
      if (lastLeg < 0) {
        flags.push(flag('A3', 'red', subject, {
          subjectKind: 'fill', subjectId: f.rootId || f.id, at: f.at, ...refs(f),
          measured: f.meterReading, expected: lastBase, unit: meterUnit,
          explanation: `Meter went backwards: ${fmtNum(f.meterReading)} ${meterUnit} after ${fmtNum(lastBase)} ${meterUnit}, with no meter reset recorded.`,
        }));
      } else if (lastLeg === 0 && f.litres > 0) {
        flags.push(flag('A2', 'amber', subject, {
          subjectKind: 'fill', subjectId: f.rootId || f.id, at: f.at, ...refs(f),
          measured: f.meterReading, expected: lastBase, unit: meterUnit,
          explanation: `Meter did not move (${fmtNum(f.meterReading)} ${meterUnit}) but ${fmtL(f.litres)} were added.`,
        }));
      } else {
        const perDay = meterUnit === 'hours' ? s.maxHoursPerDay : (isNum(asset.maxPerDay) && asset.maxPerDay > 0 ? asset.maxPerDay : s.maxKmPerDayDefault);
        const allowedDays = Math.max(days, 1);
        const maxJump = perDay * allowedDays;
        if (distance > maxJump) {
          flags.push(flag('A4', 'red', subject, {
            subjectKind: 'fill', subjectId: f.rootId || f.id, at: f.at, ...refs(f),
            measured: distance, expected: maxJump, threshold: maxJump, unit: meterUnit,
            explanation: `Impossible jump: ${fmtNum(distance)} ${meterUnit} in ${fmtNum(days, 1)} day(s); at most ${fmtNum(perDay, 0)} ${meterUnit} a day is possible (${fmtNum(maxJump, 0)}).`,
          }));
        }
      }
    }
    prev = f;
  }

  // Full-to-full intervals (A1). Litres = every fill after the earlier full
  // fill up to and including the later one.
  let lastFull = null;
  let carried = [];
  for (const f of list) {
    if (lastFull) carried.push(f);
    if (!f.fullTank) continue;
    if (lastFull) {
      const litres = carried.reduce((sum, x) => sum + (isNum(x.litres) ? x.litres : 0), 0);
      let distance = null;
      if (hasMeter && isNum(lastFull.meterReading) && isNum(f.meterReading)) {
        const d = meterDistance(lastFull.meterReading, lastFull.at, f.meterReading, f.at, resets);
        if (f.meterReading - d.lastBase >= 0) distance = d.distance;
      } else if (!hasMeter) {
        distance = (f.at - lastFull.at) / DAY_MS;
      }
      const litresByDriver = {};
      for (const x of carried) {
        const key = x.driverEmployeeId || '';
        litresByDriver[key] = (litresByDriver[key] || 0) + (isNum(x.litres) ? x.litres : 0);
      }
      const rate = consumptionRate(litres, distance, meterUnit);
      intervals.push({
        fromFillId: lastFull.rootId || lastFull.id, toFillId: f.rootId || f.id,
        fromAt: lastFull.at, toAt: f.at, litres, distance, rate, unit, litresByDriver,
        startsWithCash: lastFull.kind === 'cash_station', endsWithCash: f.kind === 'cash_station',
        toKind: f.kind, toAttendantEmployeeId: f.attendantEmployeeId ?? null, toDriverEmployeeId: f.driverEmployeeId ?? null,
      });
    }
    lastFull = f;
    carried = [];
  }
  const byRoot = new Map(list.map((x) => [x.rootId || x.id, x]));
  for (let i = 0; i < intervals.length; i += 1) {
    const iv = intervals[i];
    const base = resolveBaseline(asset, intervals, iv.toAt, s, i);
    iv.baseline = base.value;
    iv.baselineSource = base.source;
    iv.ratio = isNum(iv.rate) && isNum(base.value) && base.value > 0 ? iv.rate / base.value : null;
  }
  // A1 is judged over runs of consecutive intervals merged until they hold at
  // least `a1MinLitres` — or half the tank, if smaller — (a 3 L top-up on a
  // truck says nothing about fuel use) and, for a
  // machine without a meter (L/day), at least `a1MinDaysNoMeter` days (idle
  // days decide a short interval's rate). A gap in the readings ends a run.
  let run = null;
  for (const iv of intervals) {
    if (!isNum(iv.distance) || iv.distance <= 0 || !isNum(iv.baseline) || iv.baseline <= 0) { run = null; continue; }
    run = run
      ? { ...run, toFillId: iv.toFillId, toAt: iv.toAt, litres: run.litres + iv.litres, distance: run.distance + iv.distance, baseline: iv.baseline, baselineSource: iv.baselineSource, parts: run.parts + 1 }
      : { fromFillId: iv.fromFillId, toFillId: iv.toFillId, fromAt: iv.fromAt, toAt: iv.toAt, litres: iv.litres, distance: iv.distance, baseline: iv.baseline, baselineSource: iv.baselineSource, parts: 1 };
    // A small tank (a motorbike's 4 L) never holds 20 L: half a tank is enough there.
    if (run.litres < Math.min(s.a1MinLitres, capacity ? capacity / 2 : s.a1MinLitres)) continue;
    if (meterUnit === 'none' && run.distance < s.a1MinDaysNoMeter) continue;
    const r = run;
    run = null;
    const rate = consumptionRate(r.litres, r.distance, meterUnit);
    const ratio = rate / r.baseline;
    const severity = ratio > s.a1RedRatio ? 'red' : ratio > s.a1AmberRatio ? 'amber' : null;
    if (!severity) continue;
    const endFill = byRoot.get(r.toFillId);
    flags.push(flag('A1', severity, `interval:${r.fromFillId}:${r.toFillId}`, {
      subjectKind: 'fill', subjectId: r.toFillId, at: r.toAt,
      assetId: asset.id, employeeId: endFill?.driverEmployeeId ?? null, stationId: endFill?.stationId ?? null,
      measured: rate, expected: r.baseline, threshold: r.baseline * (severity === 'red' ? s.a1RedRatio : s.a1AmberRatio), unit,
      explanation: `High fuel use: ${fmtL(r.litres)} over ${fmtNum(r.distance)} ${meterUnit === 'none' ? 'days' : meterUnit}`
        + `${r.parts > 1 ? ` (${r.parts} fills taken together)` : ''} = ${fmtNum(rate, 2)} ${unit}, `
        + `${fmtNum((ratio - 1) * 100, 0)}% above the ${r.baselineSource === 'learned' ? 'learned' : 'owner\'s'} baseline of ${fmtNum(r.baseline, 2)} ${unit}.`,
      details: { litres: r.litres, distance: r.distance, fromFillId: r.fromFillId, toFillId: r.toFillId, baselineSource: r.baselineSource, intervals: r.parts },
    }));
  }

  // Per-fill rules. `ivDone` counts the intervals that ended before this fill
  // (a moving pointer, so A6's baseline lookup stays O(1) per fill).
  let prevRead = null;
  let ivDone = 0;
  for (const f of list) {
    while (ivDone < intervals.length && intervals[ivDone].toAt < f.at) ivDone += 1;
    const subject = `fill:${f.rootId || f.id}`;
    const base = { subjectKind: 'fill', subjectId: f.rootId || f.id, at: f.at, ...refs(f) };

    if (capacity && isNum(f.litres) && f.litres > capacity * s.tankOverfillRatio) {
      flags.push(flag('A5', 'red', subject, {
        ...base, measured: f.litres, expected: capacity, threshold: capacity * s.tankOverfillRatio, unit: 'L',
        explanation: `More than the tank holds: ${fmtL(f.litres)} recorded, the tank holds ${fmtL(capacity)}.`,
      }));
    }

    if (hasMeter && isNum(f.meterReading)) {
      if (prevRead && capacity) {
        const baseline = resolveBaseline(asset, intervals, f.at, s, ivDone).value;
        const d = meterDistance(prevRead.meterReading, prevRead.at, f.meterReading, f.at, resets);
        const distance = f.meterReading - d.lastBase >= 0 ? d.distance : null;
        if (isNum(baseline) && baseline > 0 && isNum(distance)) {
          const range = meterUnit === 'km' ? (capacity / baseline) * 100 : capacity / baseline;
          const minDistance = (s.refillTooSoonPct / 100) * range;
          if (distance < minDistance && f.litres > 0) {
            flags.push(flag('A6', 'amber', subject, {
              ...base, measured: distance, expected: range, threshold: minDistance, unit: meterUnit,
              explanation: `Refilled too soon: ${fmtNum(distance)} ${meterUnit} since the last fill; a full tank lasts about ${fmtNum(range, 0)} ${meterUnit}, so under ${fmtNum(minDistance, 0)} is unusual.`,
            }));
          }
        }
      }
      prevRead = f;
    }

    const kinds = new Set(f.photoKinds || []);
    const missing = [];
    if (hasMeter && !isNum(f.meterReading)) missing.push('meter reading');
    if (hasMeter && !kinds.has('meter')) missing.push('meter photo');
    if (f.kind === 'cash_station' && !kinds.has('pump_display')) missing.push('pump display photo');
    if (missing.length) {
      // A paper slip typed in on the Mac (the driver has no phone) cannot carry
      // a meter or pump photo; with the slip / receipt photographed it is only
      // noted. Amber when there is no photo at all, a phone entry skipped the
      // photos, or the meter reading itself is missing.
      const paperSlip = f.source !== 'phone' && kinds.size > 0 && !missing.includes('meter reading');
      flags.push(flag('A7', paperSlip ? 'info' : 'amber', subject, {
        ...base, unit: null,
        explanation: paperSlip
          ? `Paper slip entered on the Mac: no ${missing.join(', no ')} (the slip is photographed).`
          : `Missing evidence: no ${missing.join(', no ')}${kinds.size === 0 ? ' — no photo at all' : ''}.`,
        details: { missing, paperSlip },
      }));
    }

    const q1 = queuedNote('fill', f.rootId || f.id, f, s);
    if (q1) flags.push(flag('Q1', 'info', subject, { ...base, ...q1 }));

    if (f.kind === 'cash_station') {
      const price = priceFor(f.fuelType || asset.fuelType, f.at);
      const cash = cashFigures(f, price, fxKhrPerUsd);
      const paid = fmtMoney(f.amountPaidMinor, f.currency);
      const converted = cash.comparable && cash.currency !== (f.currency || 'KHR') ? ` (${fmtMoney(cash.amount, cash.currency)} at ${fmtNum(fxKhrPerUsd, 0)} KHR/USD)` : '';
      if (!cash.comparable) {
        flags.push(flag('C0', 'info', subject, {
          ...base, unit: null,
          explanation: price
            ? `No price to compare: ${paid} was paid in ${f.currency || 'KHR'}, the published price is in ${price.currency}, and there is no exchange rate set.`
            : `No published ${f.fuelType || asset.fuelType || 'fuel'} price for ${phnomPenhDate(f.at)}, so the cash checks (C1, C2) could not run. Enter the price under Fuel prices.`,
        }));
      }
      // A USD payment compared at the office rate gets an allowance for the
      // street rate the station used (usdStreetRatePct).
      const allow = converted ? 1 + s.usdStreetRatePct / 100 : 1;
      if (isNum(cash.priceRatio) && cash.priceRatio > s.c1PriceRatio * allow) {
        const severity = cash.priceRatio > s.c1RedRatio * allow ? 'red' : 'amber';
        flags.push(flag('C1', severity, subject, {
          ...base, measured: cash.impliedPriceMinorPerL, expected: cash.publishedMinorPerL,
          threshold: cash.publishedMinorPerL * s.c1PriceRatio * allow, unit: `${cash.currency}/L`,
          explanation: `Paid above the posted price: ${paid}${converted} for ${fmtL(f.litresShownOnPump)} = `
            + `${fmtMoney(cash.impliedPriceMinorPerL, cash.currency)}/L, ${fmtNum((cash.priceRatio - 1) * 100, 0)}% above the posted ${fmtMoney(cash.publishedMinorPerL, cash.currency)}/L.`,
          details: { expectedLitres: cash.expectedLitres },
        }));
      }
      if (capacity && isNum(cash.expectedLitres) && cash.expectedLitres > capacity) {
        flags.push(flag('C2', 'red', subject, {
          ...base, measured: cash.expectedLitres, expected: capacity, threshold: capacity, unit: 'L',
          explanation: `Paid for more than the tank holds: ${paid}${converted} buys ${fmtL(cash.expectedLitres)} at the posted price; the tank holds ${fmtL(capacity)}.`,
        }));
      }
      const c5 = reviewerMismatch(f, s);
      if (c5) flags.push(flag('C5', 'red', subject, { ...base, ...c5 }));
    }
  }

  return { flags, segments, intervals };
}

/**
 * C5: the reviewer read the pump-display photo and typed what it shows.
 * Returns flag fields when it disagrees with the driver's figures, else null.
 */
function reviewerMismatch(fill, settings = DEFAULT_SETTINGS) {
  const s = mergeSettings(settings);
  const tol = s.c5TolerancePct / 100;
  const parts = [];
  let measured = null;
  let expected = null;
  if (isNum(fill.reviewedAmountMinor) && isNum(fill.amountPaidMinor)
    && Math.abs(fill.reviewedAmountMinor - fill.amountPaidMinor) > tol * Math.max(fill.amountPaidMinor, 1)) {
    parts.push(`the photo shows ${fmtMoney(fill.reviewedAmountMinor, fill.currency)}, ${fmtMoney(fill.amountPaidMinor, fill.currency)} was typed`);
    measured = fill.reviewedAmountMinor;
    expected = fill.amountPaidMinor;
  }
  const typedLitres = isNum(fill.litresShownOnPump) ? fill.litresShownOnPump : null;
  if (isNum(fill.reviewedLitres) && typedLitres != null
    && Math.abs(fill.reviewedLitres - typedLitres) > tol * Math.max(typedLitres, 0.01)) {
    parts.push(`the photo shows ${fmtL(fill.reviewedLitres)}, ${fmtL(typedLitres)} was typed`);
    if (measured == null) { measured = fill.reviewedLitres; expected = typedLitres; }
  }
  if (!parts.length) return null;
  return { measured, expected, unit: null, explanation: `Pump display photo disagrees with the typed figures: ${parts.join('; ')}.` };
}

/* ─── tank rules: T1, T2, T3 ────────────────────────────────────── */

/**
 * When a delivery counts for the tank. It is usually recorded on the phone
 * AFTER the "after" dip (that is the natural order: dip, unload, dip, then
 * type it in), so its clock time can be later than the dip that already shows
 * the fuel. When it is linked to its dips, it is placed inside them:
 *   min(delivered_at, dip_after − 1 ms), and after dip_before.
 */
function deliveryEffectiveAt(dl, dipById) {
  let at = dl.deliveredAt;
  const after = dl.dipAfterId ? dipById.get(dl.dipAfterId) : null;
  const before = dl.dipBeforeId ? dipById.get(dl.dipBeforeId) : null;
  if (after && isNum(after.takenAt) && at >= after.takenAt) at = after.takenAt - 1;
  if (before && isNum(before.takenAt) && at <= before.takenAt) at = before.takenAt + 1;
  return at;
}

/**
 * How far one level reading may be off, in litres.
 *   with a chart:    litres per cm at that level × allowed cm
 *   without (a sight gauge, or litres typed): max(typedDipErrorMinL, typedDipErrorPct × capacity)
 */
function dipReadError(dip, chart, location, s) {
  if (dip && dip.litresSource !== 'typed' && chart && chart.length >= 2 && isNum(dip.dipCm)) {
    return dipErrorLitres(chart, dip.dipCm, s.dipAllowedCm);
  }
  const cap = isNum(location?.capacityL) ? location.capacityL : 0;
  return Math.max(s.typedDipErrorMinL, (s.typedDipErrorPct / 100) * cap);
}

/**
 * T1 between each pair of consecutive dips at one location:
 *   expected_L  = litres(D0) + deliveries + transfers in − tank fills − transfers out
 *   variance_L  = litres(D1) − expected_L           (negative = missing)
 *   tolerance_L = read_error(D0) + read_error(D1) + pct × (tank fills + transfers out)
 *   read_error  = see dipReadError — BOTH dips can be misread, so both count.
 * A "more fuel than recorded" result on a dip younger than t1GraceMinutes is
 * held back: the delivery that explains it is usually typed in just after the
 * dip that already shows it.
 * One sorted sweep: every movement is bucketed into its dip-to-dip interval
 * once (O(n log n)), not re-filtered per interval.
 */
function tankReconciliation({ location, chart, dips, deliveries = [], fills = [], transfers = [], settings = DEFAULT_SETTINGS, now = null }) {
  const s = mergeSettings(settings);
  const flags = [];
  const intervals = [];
  const list = (dips || []).filter((d) => isNum(d.litres)).sort(byTime('takenAt'));
  if (list.length < 2) return { flags, intervals };
  const dipById = new Map((dips || []).map((d) => [d.id, d]));
  const events = [];
  for (const x of deliveries) if (x.locationId === location.id) events.push({ at: deliveryEffectiveAt(x, dipById), kind: 'delivered', litres: Number(x.litresInvoiced) || 0 });
  for (const x of fills) if (x.locationId === location.id) events.push({ at: x.at, kind: 'filled', litres: Number(x.litres) || 0, attendant: x.attendantEmployeeId || '' });
  for (const x of transfers) {
    if (x.fromLocationId === location.id) events.push({ at: x.sentAt, kind: 'sent', litres: Number(x.litresSent) || 0 });
    if (x.toLocationId === location.id && isNum(x.litresReceived) && isNum(x.receivedAt)) events.push({ at: x.receivedAt, kind: 'received', litres: x.litresReceived });
  }
  events.sort((a, b) => a.at - b.at);
  let p = 0;
  while (p < events.length && events[p].at <= list[0].takenAt) p += 1;
  for (let i = 1; i < list.length; i += 1) {
    const d0 = list[i - 1];
    const d1 = list[i];
    const sums = { delivered: 0, filled: 0, sent: 0, received: 0 };
    const fillsByAttendant = {};
    while (p < events.length && events[p].at <= d1.takenAt) {
      const e = events[p];
      sums[e.kind] += e.litres;
      if (e.kind === 'filled') {
        const g = fillsByAttendant[e.attendant] || (fillsByAttendant[e.attendant] = { litres: 0, count: 0 });
        g.litres += e.litres;
        g.count += 1;
      }
      p += 1;
    }
    const { delivered, filled, sent, received } = sums;
    const expected = d0.litres + delivered + received - filled - sent;
    const variance = d1.litres - expected;
    const dipError = dipReadError(d0, chart, location, s) + dipReadError(d1, chart, location, s);
    const tolerance = dipError + (s.tankTolerancePct / 100) * (filled + sent);
    const iv = {
      fromDipId: d0.id, toDipId: d1.id, fromAt: d0.takenAt, toAt: d1.takenAt,
      startLitres: d0.litres, delivered, received, filled, sent,
      expected: round(expected, 2), measured: d1.litres, variance: round(variance, 2),
      tolerance: round(tolerance, 2), dipError: round(dipError, 2), fillsByAttendant,
    };
    intervals.push(iv);
    let severity = null;
    if (variance < -tolerance) severity = 'red';
    else if (variance > tolerance) severity = 'amber';
    if (!severity) continue;
    if (severity === 'amber' && isNum(now) && now - d1.takenAt < s.t1GraceMinutes * 60000) continue;
    const missing = variance < 0;
    flags.push(flag('T1', severity, `dips:${d0.id}:${d1.id}`, {
      subjectKind: 'dip', subjectId: d1.id, at: d1.takenAt, locationId: location.id,
      measured: d1.litres, expected, threshold: tolerance, unit: 'L',
      explanation: `${location.name || 'Tank'}: expected ${fmtL(expected)} (${fmtL(d0.litres)} + ${fmtL(delivered)} delivered`
        + `${received ? ` + ${fmtL(received)} received` : ''} − ${fmtL(filled)} filled − ${fmtL(sent)} sent), measured ${fmtL(d1.litres)}: `
        + `${fmtL(Math.abs(variance))} ${missing ? 'unaccounted for' : 'more than recorded (usually an entry not recorded)'} — tolerance ${fmtL(tolerance)}.`,
      details: iv,
    }));
  }
  return { flags, intervals };
}

/** Sorted draws (fills + transfers out) with a running total, for O(log n) "litres drawn between two times". */
function drawIndex(location, fills, transfers) {
  const draws = [];
  for (const f of fills) if (f.locationId === location.id && isNum(f.at)) draws.push([f.at, Number(f.litres) || 0]);
  for (const t of transfers) if (t.fromLocationId === location.id && isNum(t.sentAt)) draws.push([t.sentAt, Number(t.litresSent) || 0]);
  draws.sort((a, b) => a[0] - b[0]);
  const times = draws.map((d) => d[0]);
  const cum = [0];
  for (const d of draws) cum.push(cum[cum.length - 1] + d[1]);
  // count of draws with time <= t
  const upto = (t) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return { between: (from, to) => cum[upto(to)] - cum[upto(from)] };
}

/**
 * T2: litres actually received by a delivery, from the dips either side:
 *   received_L = litres(dip after) − litres(dip before) + fills/transfers between them
 *   short when received_L < litres_invoiced − tolerance
 *   tolerance  = read_error(dip before) + read_error(dip after) + pct × litres_invoiced
 */
function shortDeliveries({ location, chart, deliveries = [], dips = [], fills = [], transfers = [], settings = DEFAULT_SETTINGS }) {
  const s = mergeSettings(settings);
  const flags = [];
  const checks = [];
  const dipById = new Map((dips || []).map((d) => [d.id, d]));
  const index = drawIndex(location, fills, transfers);
  for (const dl of deliveries) {
    if (dl.locationId !== location.id) continue;
    const before = dipById.get(dl.dipBeforeId);
    const after = dipById.get(dl.dipAfterId);
    if (!before || !after || !isNum(before.litres) || !isNum(after.litres) || after.takenAt <= before.takenAt) continue;
    const between = index.between(before.takenAt, after.takenAt);
    const received = after.litres - before.litres + between;
    const dipError = dipReadError(before, chart, location, s) + dipReadError(after, chart, location, s);
    const tolerance = dipError + (s.tankTolerancePct / 100) * dl.litresInvoiced;
    const shortfall = dl.litresInvoiced - received;
    checks.push({ deliveryId: dl.id, invoiced: dl.litresInvoiced, received: round(received, 2), drawnBetween: round(between, 2), shortfall: round(shortfall, 2), tolerance: round(tolerance, 2) });
    if (shortfall <= tolerance) continue;
    const severity = shortfall > s.shortDeliveryRedMultiple * tolerance ? 'red' : 'amber';
    flags.push(flag('T2', severity, `delivery:${dl.id}`, {
      subjectKind: 'delivery', subjectId: dl.id, at: deliveryEffectiveAt(dl, dipById), locationId: location.id,
      measured: received, expected: dl.litresInvoiced, threshold: tolerance, unit: 'L',
      explanation: `Short delivery: invoiced ${fmtL(dl.litresInvoiced)}, the dips show ${fmtL(received)} arrived — ${fmtL(shortfall)} short (tolerance ${fmtL(tolerance)}).`,
    }));
  }
  return { flags, checks };
}

/**
 * T3: every stretch without a dip longer than N days — between two dips, and
 * from the last dip to `now`. Days are counted as calendar days in Phnom Penh
 * (a dip on Saturday and the next on Monday is 2 days, whatever the hours),
 * so "dip at least every 2 days" means what it says. Subject = location + the dip the gap starts at,
 * so the open gap and the same gap once the next dip arrives are ONE flag: it
 * stays (with its review) instead of vanishing when the tank is dipped again.
 */
function missedDips({ location, dips = [], now, settings = DEFAULT_SETTINGS }) {
  const s = mergeSettings(settings);
  if (location.kind !== 'tank') return { flags: [] };
  const calDays = (from, to) => Math.round((Date.parse(phnomPenhDate(to)) - Date.parse(phnomPenhDate(from))) / DAY_MS);
  const tooLong = (from, to) => calDays(from, to) > s.missedDipDays;
  const list = (dips || []).filter((d) => isNum(d.takenAt)).sort(byTime('takenAt'));
  const flags = [];
  const name = location.name || 'Tank';
  const add = (startId, from, to, open) => {
    const days = calDays(from, to);
    flags.push(flag('T3', 'amber', `nodip:${location.id}:${startId}`, {
      subjectKind: 'location', subjectId: location.id, at: from, locationId: location.id,
      measured: days, expected: s.missedDipDays, threshold: s.missedDipDays, unit: 'days',
      explanation: open
        ? (startId === 'none'
          ? `${name} has never been dipped (added ${phnomPenhDate(from)}); the rule is every ${s.missedDipDays} days.`
          : `${name} has not been dipped for ${fmtNum(days, 1)} days (last dip ${phnomPenhDate(from)}); the rule is every ${s.missedDipDays} days.`)
        : `${name} went ${fmtNum(days, 1)} days without a dip, ${phnomPenhDate(from)} to ${phnomPenhDate(to)}; the rule is every ${s.missedDipDays} days.`,
      details: { from, to: open ? null : to, open },
    }));
  };
  if (!list.length) {
    if (isNum(location.createdAt) && isNum(now) && tooLong(location.createdAt, now) && location.status !== 'retired') add('none', location.createdAt, now, true);
    return { flags };
  }
  if (isNum(location.createdAt) && tooLong(location.createdAt, list[0].takenAt)) add('none', location.createdAt, list[0].takenAt, false);
  for (let i = 1; i < list.length; i += 1) {
    if (tooLong(list[i - 1].takenAt, list[i].takenAt)) add(list[i - 1].id, list[i - 1].takenAt, list[i].takenAt, false);
  }
  const last = list[list.length - 1];
  if (location.status !== 'retired' && isNum(now) && tooLong(last.takenAt, now)) add(last.id, last.takenAt, now, true);
  return { flags };
}

/**
 * F1 transfer loss (§4.4): litres sent − litres received at the farm.
 *   loss_pct = (sent − received) ÷ sent;  > 2 % amber, > 5 % red (settings)
 */
function transferLoss({ location, transfers = [], settings = DEFAULT_SETTINGS, nameOf = () => null }) {
  const s = mergeSettings(settings);
  const flags = [];
  for (const t of transfers) {
    if (t.fromLocationId !== location.id || !isNum(t.litresReceived) || !(t.litresSent > 0)) continue;
    const loss = t.litresSent - t.litresReceived;
    const pct = (loss / t.litresSent) * 100;
    if (pct <= s.transferLossAmberPct) continue;
    const severity = pct > s.transferLossRedPct ? 'red' : 'amber';
    // The fuel passes through the carrier's hands before the receiver counts
    // it, so both are named; the flag is filed under the carrier when known.
    const carrier = t.carriedByEmployeeId ? (nameOf(t.carriedByEmployeeId) || 'the carrier') : null;
    const receiver = t.receivedByEmployeeId ? (nameOf(t.receivedByEmployeeId) || 'the receiver') : null;
    const who = [carrier && `carried by ${carrier}`, receiver && `received by ${receiver}`].filter(Boolean).join(', ');
    flags.push(flag('F1', severity, `transfer:${t.id}`, {
      subjectKind: 'transfer', subjectId: t.id, at: t.sentAt, locationId: location.id,
      employeeId: t.carriedByEmployeeId ?? t.receivedByEmployeeId ?? null,
      measured: t.litresReceived, expected: t.litresSent, threshold: t.litresSent * (1 - s.transferLossAmberPct / 100), unit: 'L',
      explanation: `Transfer loss: ${fmtL(t.litresSent)} sent, ${fmtL(t.litresReceived)} received — ${fmtL(loss)} (${fmtNum(pct, 1)}%) lost on the way (allowed ${s.transferLossAmberPct}%)${who ? `; ${who}` : ''}.`,
      details: { carrierEmployeeId: t.carriedByEmployeeId ?? null, receiverEmployeeId: t.receivedByEmployeeId ?? null, senderEmployeeId: t.sentByEmployeeId ?? null },
    }));
  }
  return { flags };
}

/**
 * Q1 (info): a phone record that waited in the phone's offline queue for
 * longer than `queuedNoteMinutes` before it reached the server. Not a
 * problem on its own — the reviewer sees when it was really sent.
 */
function queuedNote(kind, id, rec, settings = DEFAULT_SETTINGS) {
  const ms = rec?.queuedForMs;
  if (!isNum(ms) || ms <= settings.queuedNoteMinutes * 60000) return null;
  const span = (x) => (x >= 3600000 ? `${fmtNum(x / 3600000, 1)} h` : `${fmtNum(x / 60000, 0)} min`);
  const arrived = rec.recordedAt ?? rec.createdAt;
  const at = rec.at ?? rec.takenAt ?? rec.deliveredAt ?? rec.sentAt;
  const placedLater = isNum(arrived) && isNum(at) && arrived - at < ms - 60000;
  return {
    measured: round(ms / 60000, 1), expected: settings.queuedNoteMinutes, threshold: settings.queuedNoteMinutes, unit: 'min',
    explanation: `The phone says this was entered ${span(ms)} before it reached the office (it was offline).`
      + (placedLater
        ? ` It is placed ${span(Math.max(0, arrived - at))} before arrival instead — a record is never put before the tank's latest dip, the vehicle's latest fill or this phone's previous record.`
        : ''),
  };
}

function locationQueuedNotes({ location, dips = [], deliveries = [], transfers = [], settings = DEFAULT_SETTINGS }) {
  const s = mergeSettings(settings);
  const flags = [];
  const add = (kind, rec, at) => {
    const q = queuedNote(kind, rec.id, rec, s);
    if (q) flags.push(flag('Q1', 'info', `${kind}:${rec.id}`, { subjectKind: kind, subjectId: rec.id, at, locationId: location.id, ...q }));
  };
  for (const d of dips) if (d.locationId === location.id) add('dip', d, d.takenAt);
  for (const d of deliveries) if (d.locationId === location.id) add('delivery', d, d.deliveredAt);
  for (const t of transfers) if (t.fromLocationId === location.id) add('transfer', t, t.sentAt);
  return { flags };
}

/* ─── attendant comparison: P1 ──────────────────────────────────── */

/**
 * P1 — an attendant who short-fills keeps the tank's books balanced (the
 * vehicle simply gets less than is written down), so T1 cannot see it. What
 * shows is that the vehicles he fills come back sooner: their full-to-full
 * fuel use, for intervals CLOSED by his fills, runs above the same vehicles'
 * use when other attendants fill them.
 *
 * For each month M (window = the `attendantWindowDays` days to M's end, or
 * to `now` for the current month):
 *   ratio_i   = interval rate ÷ the vehicle's baseline, for full-to-full
 *               intervals of vehicles with a meter, closed by a tank/farm fill
 *   rel_i     = ratio_i ÷ median ratio of that vehicle in the window (so a
 *               wrong baseline cancels out; only vehicles filled by ≥ 2
 *               attendants in the window count)
 *   diff(A)   = median rel of A's intervals ÷ median rel of everyone else's − 1
 *   flag when diff > attendantAmberPct (amber) / attendantRedPct (red), with at
 *   least attendantMinIntervals intervals on each side.
 * Subject = attendant + month; one flag per attendant per month.
 *
 * @param {object[]} intervals { toAt, ratio, attendantId, assetId }
 */
function attendantComparison({ intervals = [], now, settings = DEFAULT_SETTINGS, nameOf = () => null }) {
  const s = mergeSettings(settings);
  const rows = intervals.filter((iv) => isNum(iv.ratio) && iv.ratio > 0 && iv.attendantId && iv.assetId && isNum(iv.toAt) && iv.toAt <= now)
    .sort((a, b) => a.toAt - b.toAt);
  const flags = [];
  if (!rows.length) return { flags, windows: [] };
  const windows = [];
  const firstMonth = phnomPenhMonth(rows[0].toAt);
  const lastMonth = phnomPenhMonth(now);
  const span = s.attendantWindowDays * DAY_MS;
  for (let m = firstMonth; m <= lastMonth; m = nextMonth(m)) {
    const end = Math.min(monthRange(m).end - 1, now);
    const inWin = rows.filter((r) => r.toAt > end - span && r.toAt <= end);
    const byAsset = new Map();
    for (const r of inWin) {
      if (!byAsset.has(r.assetId)) byAsset.set(r.assetId, []);
      byAsset.get(r.assetId).push(r);
    }
    const rel = [];
    for (const list of byAsset.values()) {
      if (new Set(list.map((r) => r.attendantId)).size < 2) continue;
      const med = median(list.map((r) => r.ratio));
      for (const r of list) rel.push({ attendantId: r.attendantId, rel: r.ratio / med });
    }
    const attendants = [...new Set(rel.map((r) => r.attendantId))];
    const summary = [];
    for (const a of attendants) {
      const mine = rel.filter((r) => r.attendantId === a).map((r) => r.rel);
      const others = rel.filter((r) => r.attendantId !== a).map((r) => r.rel);
      const row = { attendantId: a, n: mine.length, nOthers: others.length, median: median(mine), othersMedian: median(others) };
      row.diffPct = isNum(row.median) && isNum(row.othersMedian) ? (row.median / row.othersMedian - 1) * 100 : null;
      summary.push(row);
      if (mine.length < s.attendantMinIntervals || others.length < s.attendantMinIntervals || !isNum(row.diffPct)) continue;
      if (row.diffPct <= s.attendantAmberPct) continue;
      const severity = row.diffPct > s.attendantRedPct ? 'red' : 'amber';
      const who = nameOf(a) || 'This attendant';
      flags.push(flag('P1', severity, `attendant:${a}:${m}`, {
        subjectKind: 'employee', subjectId: a, at: end, employeeId: a,
        measured: row.median, expected: row.othersMedian, threshold: row.othersMedian * (1 + s.attendantAmberPct / 100), unit: '× normal',
        explanation: `${who}: in the ${s.attendantWindowDays} days to ${phnomPenhDate(end)}, vehicles filled by ${who} used ${fmtNum(row.diffPct, 1)}% more fuel `
          + `per km or hour before their next full fill than the same vehicles filled by the other attendants (${mine.length} fills vs ${others.length}). `
          + 'A pattern like this is what short-filling looks like (less fuel goes in than is written down); check his fills against the pump meter.',
        details: { window: { from: end - span, to: end }, n: mine.length, nOthers: others.length, medianRel: round(row.median, 4), othersMedianRel: round(row.othersMedian, 4), diffPct: round(row.diffPct, 2) },
      }));
    }
    windows.push({ month: m, end, attendants: summary });
  }
  return { flags, windows };
}

function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/* ─── pump flow meter rules: M1, M2 ─────────────────────────────── */

/**
 * M1 — for every fill or transfer with both pump readings:
 *   meter_L = after − before; flag when |typed − meter_L| > max(tol_L, pct × meter_L)
 *   (red if the meter ran backwards). "Typed" is what the person typed — for a
 *   transfer that is `typedLitres` (litres_sent already holds the meter figure).
 * M2 — continuity: the before-reading of each dispense should equal the
 *   after-reading of the previous one at that pump; a positive gap is fuel that
 *   left the pump with no record (red), a negative one is an overlap/typo (amber).
 *   A pump meter reset recorded in between restarts the chain.
 */
function meterRules({ location, fills = [], transfers = [], resets = [], settings = DEFAULT_SETTINGS }) {
  const s = mergeSettings(settings);
  const flags = [];
  const events = [
    ...fills.filter((f) => f.locationId === location.id && isNum(f.pumpMeterBefore) && isNum(f.pumpMeterAfter))
      .map((f) => ({ kind: 'fill', id: f.rootId || f.id, at: f.at, before: f.pumpMeterBefore, after: f.pumpMeterAfter, typed: f.typedLitres, employeeId: f.attendantEmployeeId ?? null, assetId: f.assetId ?? null })),
    ...transfers.filter((t) => t.fromLocationId === location.id && isNum(t.pumpMeterBefore) && isNum(t.pumpMeterAfter))
      .map((t) => ({ kind: 'transfer', id: t.id, at: t.sentAt, before: t.pumpMeterBefore, after: t.pumpMeterAfter, typed: t.typedLitres, employeeId: t.sentByEmployeeId ?? null, assetId: null })),
  ].sort(byTime('at'));

  for (const e of events) {
    const subject = `${e.kind}:${e.id}`;
    const base = { subjectKind: e.kind, subjectId: e.id, at: e.at, locationId: location.id, employeeId: e.employeeId, assetId: e.assetId };
    const meter = e.after - e.before;
    if (meter < 0) {
      flags.push(flag('M1', 'red', subject, {
        ...base, measured: meter, expected: 0, unit: 'L',
        explanation: `Pump meter ran backwards: ${fmtNum(e.before, 2)} before, ${fmtNum(e.after, 2)} after.`,
      }));
      continue;
    }
    if (isNum(e.typed)) {
      const tol = Math.max(s.meterToleranceL, (s.meterTolerancePct / 100) * meter);
      if (Math.abs(e.typed - meter) > tol) {
        flags.push(flag('M1', 'amber', subject, {
          ...base, measured: meter, expected: e.typed, threshold: tol, unit: 'L',
          explanation: `Pump meter says ${fmtL(meter)} (${fmtNum(e.before, 2)} → ${fmtNum(e.after, 2)}), but ${fmtL(e.typed)} was typed — the meter figure is used.`,
        }));
      }
    }
  }

  const locResets = (resets || []).filter((r) => r.locationId === location.id && isNum(r.newReading)).sort(byTime('at'));
  let r = 0;
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const cur = events[i];
    let base = prev.after;
    while (r < locResets.length && locResets[r].at <= prev.at) r += 1;
    for (let k = r; k < locResets.length && locResets[k].at <= cur.at; k += 1) base = locResets[k].newReading;
    const gap = cur.before - base;
    if (Math.abs(gap) <= s.meterGapToleranceL) continue;
    const severity = gap > 0 ? 'red' : 'amber';
    flags.push(flag('M2', severity, `gap:${prev.kind}:${prev.id}:${cur.kind}:${cur.id}`, {
      subjectKind: cur.kind, subjectId: cur.id, at: cur.at, locationId: location.id, employeeId: cur.employeeId,
      measured: cur.before, expected: base, threshold: s.meterGapToleranceL, unit: 'L',
      explanation: gap > 0
        ? `${location.name || 'Pump'}: the meter read ${fmtNum(base, 2)} after the previous record and ${fmtNum(cur.before, 2)} before this one — ${fmtL(gap)} left the pump with no record.`
        : `${location.name || 'Pump'}: this record starts at ${fmtNum(cur.before, 2)}, below the previous record's ${fmtNum(base, 2)} — the readings overlap by ${fmtL(-gap)}.`,
      details: { gapLitres: round(gap, 3), previous: { kind: prev.kind, id: prev.id } },
    }));
  }
  return { flags };
}

module.exports = {
  DAY_MS,
  DEFAULT_SETTINGS,
  SETTING_RANGES,
  mergeSettings,
  sanitizeSettingsPatch,
  phnomPenhDate,
  phnomPenhMonth,
  monthRange,
  median,
  meterDistance,
  resolvePumpMeterLitres,
  cashFigures,
  resolveBaseline,
  consumptionRate,
  baselineLitres,
  rateUnit,
  assetRules,
  reviewerMismatch,
  tankReconciliation,
  shortDeliveries,
  missedDips,
  meterRules,
  transferLoss,
  attendantComparison,
  dipReadError,
  queuedNote,
  locationQueuedNotes,
  deliveryEffectiveAt,
  comparableAmount,
  fmtL,
  fmtMoney,
};
