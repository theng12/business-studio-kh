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
 *   expected_L    = amount_paid ÷ price_published
 *   implied_price = amount_paid ÷ litres_shown_on_pump
 * Only when the price is in the same currency as the payment.
 */
function cashFigures(fill, price) {
  const out = { expectedLitres: null, impliedPriceMinorPerL: null, publishedMinorPerL: null, priceRatio: null };
  if (!isNum(fill?.amountPaidMinor) || fill.amountPaidMinor <= 0) return out;
  if (price && isNum(price.priceMinorPerL) && price.priceMinorPerL > 0 && price.currency === (fill.currency || 'KHR')) {
    out.publishedMinorPerL = price.priceMinorPerL;
    out.expectedLitres = fill.amountPaidMinor / price.priceMinorPerL;
  }
  if (isNum(fill.litresShownOnPump) && fill.litresShownOnPump > 0) {
    out.impliedPriceMinorPerL = fill.amountPaidMinor / fill.litresShownOnPump;
    if (out.publishedMinorPerL) out.priceRatio = out.impliedPriceMinorPerL / out.publishedMinorPerL;
  }
  return out;
}

/* ─── baselines ─────────────────────────────────────────────────── */

/**
 * The owner's figure until there is data; then (when the asset is set to
 * `learned`) the median of the last N full-to-full intervals within the window
 * that ended before `asOf`.
 */
function resolveBaseline(asset, priorIntervals, asOf, settings = DEFAULT_SETTINGS) {
  const manual = isNum(asset?.baselineRate) && asset.baselineRate > 0 ? asset.baselineRate : null;
  if (asset?.baselineSource === 'learned') {
    const since = asOf - settings.baselineWindowDays * DAY_MS;
    const recent = (priorIntervals || [])
      .filter((iv) => iv.toAt < asOf && iv.toAt >= since && isNum(iv.rate))
      .sort((a, b) => b.toAt - a.toAt)
      .slice(0, settings.baselineSamples);
    if (recent.length >= settings.baselineMinSamples) {
      return { value: median(recent.map((iv) => iv.rate)), source: 'learned', samples: recent.length };
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
function assetRules({ asset, fills, resets = [], priceFor = () => null, settings = DEFAULT_SETTINGS }) {
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
      });
    }
    lastFull = f;
    carried = [];
  }
  for (let i = 0; i < intervals.length; i += 1) {
    const iv = intervals[i];
    const base = resolveBaseline(asset, intervals.slice(0, i), iv.toAt, s);
    iv.baseline = base.value;
    iv.baselineSource = base.source;
    iv.ratio = isNum(iv.rate) && isNum(base.value) && base.value > 0 ? iv.rate / base.value : null;
    if (!isNum(iv.ratio)) continue;
    const severity = iv.ratio > s.a1RedRatio ? 'red' : iv.ratio > s.a1AmberRatio ? 'amber' : null;
    if (!severity) continue;
    const endFill = list.find((x) => (x.rootId || x.id) === iv.toFillId);
    flags.push(flag('A1', severity, `interval:${iv.fromFillId}:${iv.toFillId}`, {
      subjectKind: 'fill', subjectId: iv.toFillId, at: iv.toAt,
      assetId: asset.id, employeeId: endFill?.driverEmployeeId ?? null, stationId: endFill?.stationId ?? null,
      measured: iv.rate, expected: base.value, threshold: base.value * (severity === 'red' ? s.a1RedRatio : s.a1AmberRatio), unit,
      explanation: `High fuel use: ${fmtL(iv.litres)} over ${fmtNum(iv.distance)} ${meterUnit === 'none' ? 'days' : meterUnit} = ${fmtNum(iv.rate, 2)} ${unit}, `
        + `${fmtNum((iv.ratio - 1) * 100, 0)}% above the ${base.source === 'learned' ? 'learned' : 'owner\'s'} baseline of ${fmtNum(base.value, 2)} ${unit}.`,
      details: { litres: iv.litres, distance: iv.distance, fromFillId: iv.fromFillId, toFillId: iv.toFillId, baselineSource: base.source },
    }));
  }

  // Per-fill rules.
  let prevRead = null;
  for (const f of list) {
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
        const baseline = resolveBaseline(asset, intervals.filter((iv) => iv.toAt < f.at), f.at, s).value;
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
      flags.push(flag('A7', 'amber', subject, {
        ...base, unit: null,
        explanation: `Missing evidence: no ${missing.join(', no ')}.`,
        details: { missing },
      }));
    }

    if (f.kind === 'cash_station') {
      const price = priceFor(f.fuelType || asset.fuelType, f.at);
      const cash = cashFigures(f, price);
      if (isNum(cash.priceRatio) && cash.priceRatio > s.c1PriceRatio) {
        const severity = cash.priceRatio > s.c1RedRatio ? 'red' : 'amber';
        flags.push(flag('C1', severity, subject, {
          ...base, measured: cash.impliedPriceMinorPerL, expected: cash.publishedMinorPerL,
          threshold: cash.publishedMinorPerL * s.c1PriceRatio, unit: `${f.currency || 'KHR'}/L`,
          explanation: `Paid above the posted price: ${fmtMoney(f.amountPaidMinor, f.currency)} for ${fmtL(f.litresShownOnPump)} = `
            + `${fmtMoney(cash.impliedPriceMinorPerL, f.currency)}/L, ${fmtNum((cash.priceRatio - 1) * 100, 0)}% above the posted ${fmtMoney(cash.publishedMinorPerL, f.currency)}/L.`,
          details: { expectedLitres: cash.expectedLitres },
        }));
      }
      if (capacity && isNum(cash.expectedLitres) && cash.expectedLitres > capacity) {
        flags.push(flag('C2', 'red', subject, {
          ...base, measured: cash.expectedLitres, expected: capacity, threshold: capacity, unit: 'L',
          explanation: `Paid for more than the tank holds: ${fmtMoney(f.amountPaidMinor, f.currency)} buys ${fmtL(cash.expectedLitres)} at the posted price; the tank holds ${fmtL(capacity)}.`,
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

function inWindow(at, from, to) { return isNum(at) && at > from && at <= to; }

/**
 * T1 between each pair of consecutive dips at one location:
 *   expected_L  = litres(D0) + deliveries + transfers in − tank fills − transfers out
 *   variance_L  = litres(D1) − expected_L           (negative = missing)
 *   tolerance_L = dip_error_L + pct × (tank fills + transfers out)
 *   dip_error_L = litres per cm at D1's level × allowed cm
 */
function tankReconciliation({ location, chart, dips, deliveries = [], fills = [], transfers = [], settings = DEFAULT_SETTINGS }) {
  const s = mergeSettings(settings);
  const flags = [];
  const intervals = [];
  const list = (dips || []).filter((d) => isNum(d.litres)).sort(byTime('takenAt'));
  for (let i = 1; i < list.length; i += 1) {
    const d0 = list[i - 1];
    const d1 = list[i];
    const delivered = deliveries
      .filter((x) => x.locationId === location.id && inWindow(x.deliveredAt, d0.takenAt, d1.takenAt))
      .reduce((sum, x) => sum + (Number(x.litresInvoiced) || 0), 0);
    const fillRows = fills.filter((x) => x.locationId === location.id && inWindow(x.at, d0.takenAt, d1.takenAt));
    const filled = fillRows.reduce((sum, x) => sum + (Number(x.litres) || 0), 0);
    const sent = transfers
      .filter((x) => x.fromLocationId === location.id && inWindow(x.sentAt, d0.takenAt, d1.takenAt))
      .reduce((sum, x) => sum + (Number(x.litresSent) || 0), 0);
    const received = transfers
      .filter((x) => x.toLocationId === location.id && isNum(x.litresReceived) && inWindow(x.receivedAt, d0.takenAt, d1.takenAt))
      .reduce((sum, x) => sum + x.litresReceived, 0);
    const expected = d0.litres + delivered + received - filled - sent;
    const variance = d1.litres - expected;
    const dipError = chart && chart.length >= 2 ? dipErrorLitres(chart, d1.dipCm, s.dipAllowedCm) : 0;
    const tolerance = dipError + (s.tankTolerancePct / 100) * (filled + sent);
    const fillsByAttendant = {};
    for (const f of fillRows) {
      const key = f.attendantEmployeeId || '';
      const g = fillsByAttendant[key] || (fillsByAttendant[key] = { litres: 0, count: 0 });
      g.litres += Number(f.litres) || 0;
      g.count += 1;
    }
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

/**
 * T2: litres actually received by a delivery, from the dips either side:
 *   received_L = litres(dip after) − litres(dip before) + fills/transfers between them
 *   short when received_L < litres_invoiced − tolerance
 *   tolerance  = dip_error_L (at the after level) + pct × litres_invoiced
 */
function shortDeliveries({ location, chart, deliveries = [], dips = [], fills = [], transfers = [], settings = DEFAULT_SETTINGS }) {
  const s = mergeSettings(settings);
  const flags = [];
  const checks = [];
  const dipById = new Map((dips || []).map((d) => [d.id, d]));
  for (const dl of deliveries) {
    if (dl.locationId !== location.id) continue;
    const before = dipById.get(dl.dipBeforeId);
    const after = dipById.get(dl.dipAfterId);
    if (!before || !after || !isNum(before.litres) || !isNum(after.litres) || after.takenAt <= before.takenAt) continue;
    const between = fills
      .filter((f) => f.locationId === location.id && inWindow(f.at, before.takenAt, after.takenAt))
      .reduce((sum, f) => sum + (Number(f.litres) || 0), 0)
      + transfers
        .filter((t) => t.fromLocationId === location.id && inWindow(t.sentAt, before.takenAt, after.takenAt))
        .reduce((sum, t) => sum + (Number(t.litresSent) || 0), 0);
    const received = after.litres - before.litres + between;
    const dipError = chart && chart.length >= 2 ? dipErrorLitres(chart, after.dipCm, s.dipAllowedCm) : 0;
    const tolerance = dipError + (s.tankTolerancePct / 100) * dl.litresInvoiced;
    const shortfall = dl.litresInvoiced - received;
    checks.push({ deliveryId: dl.id, invoiced: dl.litresInvoiced, received: round(received, 2), shortfall: round(shortfall, 2), tolerance: round(tolerance, 2) });
    if (shortfall <= tolerance) continue;
    const severity = shortfall > s.shortDeliveryRedMultiple * tolerance ? 'red' : 'amber';
    flags.push(flag('T2', severity, `delivery:${dl.id}`, {
      subjectKind: 'delivery', subjectId: dl.id, at: dl.deliveredAt, locationId: location.id,
      measured: received, expected: dl.litresInvoiced, threshold: tolerance, unit: 'L',
      explanation: `Short delivery: invoiced ${fmtL(dl.litresInvoiced)}, the dips show ${fmtL(received)} arrived — ${fmtL(shortfall)} short (tolerance ${fmtL(tolerance)}).`,
    }));
  }
  return { flags, checks };
}

/** T3: no dip at a tank for more than N days (counted up to `now`). */
function missedDips({ location, dips = [], now, settings = DEFAULT_SETTINGS }) {
  const s = mergeSettings(settings);
  if (location.kind !== 'tank' || location.status === 'retired') return { flags: [] };
  const last = (dips || []).slice().sort(byTime('takenAt')).pop() || null;
  const since = last ? last.takenAt : location.createdAt;
  if (!isNum(since)) return { flags: [] };
  const days = (now - since) / DAY_MS;
  if (days <= s.missedDipDays) return { flags: [] };
  return {
    flags: [flag('T3', 'amber', `nodip:${location.id}:${last ? last.id : 'none'}`, {
      subjectKind: 'location', subjectId: location.id, at: since, locationId: location.id,
      measured: days, expected: s.missedDipDays, threshold: s.missedDipDays, unit: 'days',
      explanation: last
        ? `${location.name || 'Tank'} has not been dipped for ${fmtNum(days, 1)} days (last dip ${phnomPenhDate(last.takenAt)}); the rule is every ${s.missedDipDays} days.`
        : `${location.name || 'Tank'} has never been dipped (added ${phnomPenhDate(since)}); the rule is every ${s.missedDipDays} days.`,
    })],
  };
}

/* ─── pump flow meter rules: M1, M2 ─────────────────────────────── */

/**
 * M1 — for every fill or transfer with both pump readings:
 *   meter_L = after − before; flag when |typed − meter_L| > max(tol_L, pct × meter_L)
 *   (red if the meter ran backwards).
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
      .map((t) => ({ kind: 'transfer', id: t.id, at: t.sentAt, before: t.pumpMeterBefore, after: t.pumpMeterAfter, typed: t.litresSent, employeeId: t.sentByEmployeeId ?? null, assetId: null })),
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

  const locResets = (resets || []).filter((r) => r.locationId === location.id);
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const cur = events[i];
    let base = prev.after;
    for (const r of locResets.slice().sort(byTime('at'))) {
      if (r.at > prev.at && r.at <= cur.at && isNum(r.newReading)) base = r.newReading;
    }
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
  fmtL,
  fmtMoney,
};
