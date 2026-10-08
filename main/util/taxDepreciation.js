/**
 * Fixed Assets A0: tax depreciation — the Cambodian classes, in riel
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §4.3). Pure: no database, no clock.
 *
 * EVERY RATE AND RULE HERE: CONFIRM WITH ACCOUNTANT. They come from published
 * summaries of the 2023 Law on Taxation and Prakas 578 (see the plan's
 * Sources), not from the law text. The tax view built on this is never
 * posted; it is the worksheet the accountant uses for the return.
 *
 *   Class 1   buildings and structures   straight-line, per asset   5 %
 *   Class 1b  other (non-concrete) bldgs straight-line, per asset   10 % (one adviser; confirm)
 *   Class 2   computers, IT, software    declining balance, pooled  50 %
 *   Class 3   vehicles, office furniture declining balance, pooled  25 %
 *   Class 4   all other tangible         declining balance, pooled  20 %
 *   intangible                           straight-line over life, else 10 %
 *   land / none                          not depreciated
 *
 * Amounts are whole riel. Rates are held in basis points so the arithmetic
 * stays in integers; a percentage is rounded half-up to the riel.
 */

const TAX_CLASSES = {
  1:          { key: '1',          method: 'straight_line',     pooled: false, rateBp: 500,  label: 'Class 1 — buildings (5 % straight-line)' },
  '1b':       { key: '1b',         method: 'straight_line',     pooled: false, rateBp: 1000, label: 'Class 1 — other buildings (10 % straight-line; confirm)' },
  2:          { key: '2',          method: 'declining_balance', pooled: true,  rateBp: 5000, label: 'Class 2 — computers & software (50 % pool)' },
  3:          { key: '3',          method: 'declining_balance', pooled: true,  rateBp: 2500, label: 'Class 3 — vehicles & furniture (25 % pool)' },
  4:          { key: '4',          method: 'declining_balance', pooled: true,  rateBp: 2000, label: 'Class 4 — other tangible (20 % pool)' },
  intangible: { key: 'intangible', method: 'straight_line',     pooled: false, rateBp: 1000, label: 'Intangible (over its life, else 10 %)' },
  land:       { key: 'land',       method: 'none',              pooled: false, rateBp: 0,    label: 'Land (not depreciated)' },
  none:       { key: 'none',       method: 'none',              pooled: false, rateBp: 0,    label: 'Not depreciated for tax' },
};
const TAX_CLASS_KEYS = Object.keys(TAX_CLASSES);
const POOLED_CLASSES = TAX_CLASS_KEYS.filter((k) => TAX_CLASSES[k].pooled);

function taxClass(key) {
  const c = TAX_CLASSES[String(key)];
  if (!c) throw new Error(`Unknown tax class ${key}`);
  return c;
}

function int(v, label) {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a whole number`);
  return n;
}

/** round(amount × bp / 10000), half away from zero, exact (BigInt). */
function applyBp(amount, bp) {
  const a = BigInt(int(amount, 'amount'));
  const b = BigInt(int(bp, 'rate'));
  const num = a * b;
  const q = num / 10000n;
  const r = num % 10000n;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= 10000n) return Number(num < 0n ? q - 1n : q + 1n);
  return Number(q);
}

/** US cents → riel at a riel-per-dollar rate, rounded to the riel. */
function usdCentsToKhr(cents, khrPerUsd) {
  const rate = Number(khrPerUsd);
  if (!(rate > 0)) throw new Error('An exchange rate above 0 is needed');
  return Math.round((int(cents, 'amount') * rate) / 100);
}

/**
 * One pooled class for one tax year (Classes 2–4):
 *   base = opening WDV + additions − disposal proceeds
 *   base < 0                         → taxable gain = −base; depreciation 0; closing 0
 *   no assets left in the class      → tax loss = base; closing 0
 *   otherwise                        → depreciation = round(base × rate); closing = base − depreciation
 */
function poolYear({ classKey, openingWdvKhr = 0, additionsKhr = 0, proceedsKhr = 0, assetsRemaining = true }) {
  const c = taxClass(classKey);
  if (!c.pooled) throw new Error(`Class ${classKey} is not a pooled class`);
  const opening = int(openingWdvKhr, 'opening');
  const additions = int(additionsKhr, 'additions');
  const proceeds = int(proceedsKhr, 'proceeds');
  const base = opening + additions - proceeds;
  const out = { classKey: c.key, rateBp: c.rateBp, openingWdvKhr: opening, additionsKhr: additions, proceedsKhr: proceeds, baseKhr: base, depreciationKhr: 0, gainKhr: 0, lossKhr: 0, closingWdvKhr: 0 };
  if (base < 0) { out.gainKhr = -base; return out; }
  if (!assetsRemaining) { out.lossKhr = base; return out; }
  out.depreciationKhr = applyBp(base, c.rateBp);
  out.closingWdvKhr = base - out.depreciationKhr;
  return out;
}

/** The yearly straight-line charge for one Class 1 / 1b / intangible asset. */
function annualCharge({ classKey, costKhr, lifeMonths = null }) {
  const c = taxClass(classKey);
  const cost = int(costKhr, 'cost');
  if (c.method !== 'straight_line') return 0;
  // Intangibles: over their useful life when there is one, else 10 % a year.
  if (c.key === 'intangible' && lifeMonths && Number(lifeMonths) > 0) return Math.round((cost * 12) / Number(lifeMonths));
  return applyBp(cost, c.rateBp);
}

/**
 * A straight-line asset's tax depreciation year by year: a full year in the
 * year acquired, none in the year disposed (as one adviser's summary reports;
 * confirm), until the cost is used up. Returns rows from `fromYear` to `toYear`.
 */
function straightLineYears({ classKey, costKhr, lifeMonths = null, acquiredYear, disposedYear = null, openingAccumKhr = 0, fromYear = null, toYear }) {
  const cost = int(costKhr, 'cost');
  const charge = annualCharge({ classKey, costKhr: cost, lifeMonths });
  const start = fromYear ?? acquiredYear;
  let accum = int(openingAccumKhr, 'opening accumulated');
  const rows = [];
  for (let y = start; y <= toYear; y += 1) {
    let dep = 0;
    if (y >= acquiredYear && (disposedYear == null || y < disposedYear)) dep = Math.max(0, Math.min(charge, cost - accum));
    accum += dep;
    rows.push({ year: y, depreciationKhr: dep, accumKhr: accum, wdvKhr: cost - accum });
  }
  return rows;
}

/** Gain (positive) or loss (negative) when a Class 1 / intangible asset is sold: proceeds − tax WDV. */
function straightLineDisposal({ costKhr, accumKhr, proceedsKhr }) {
  return int(proceedsKhr, 'proceeds') - (int(costKhr, 'cost') - int(accumKhr, 'accumulated'));
}

/**
 * Opening pool balances worked out from purchase history — the ESTIMATE the
 * app offers when no accountant can give the last return's figures (§13a:
 * there is no accountant yet). Each pooled asset's riel cost is run through
 * its class from its purchase year up to the year before `firstYear`.
 *
 *   assets: [{ taxClass, costKhr, purchaseYear, disposalYear?, proceedsKhr? }]
 *
 * Returns { [classKey]: { openingWdvKhr, estimate: true, years: [poolYear…] } }
 * for every pooled class (zero when it has no assets).
 */
function estimatePoolOpenings({ assets = [], firstYear }) {
  const out = {};
  for (const key of POOLED_CLASSES) {
    const mine = assets.filter((a) => String(a.taxClass) === key && Number(a.purchaseYear) < firstYear);
    const years = [];
    let wdv = 0;
    if (mine.length) {
      const from = Math.min(...mine.map((a) => Number(a.purchaseYear)));
      for (let y = from; y < firstYear; y += 1) {
        const additions = mine.filter((a) => Number(a.purchaseYear) === y).reduce((t, a) => t + int(a.costKhr, 'cost'), 0);
        const proceeds = mine.filter((a) => a.disposalYear != null && Number(a.disposalYear) === y).reduce((t, a) => t + int(a.proceedsKhr, 'proceeds'), 0);
        const remaining = mine.some((a) => Number(a.purchaseYear) <= y && (a.disposalYear == null || Number(a.disposalYear) > y));
        const row = poolYear({ classKey: key, openingWdvKhr: wdv, additionsKhr: additions, proceedsKhr: proceeds, assetsRemaining: remaining });
        years.push({ year: y, ...row });
        wdv = row.closingWdvKhr;
      }
    }
    out[key] = { classKey: key, openingWdvKhr: wdv, estimate: true, years };
  }
  return out;
}

module.exports = {
  TAX_CLASSES, TAX_CLASS_KEYS, POOLED_CLASSES,
  taxClass, applyBp, usdCentsToKhr, poolYear, annualCharge, straightLineYears, straightLineDisposal, estimatePoolOpenings,
};
