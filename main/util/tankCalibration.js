/**
 * Fuel F1: the stick-to-litres chart for a tank (docs/PEOPLE_AND_FUEL_PLAN.md §3.6, §4.1).
 *
 * A chart is a list of `{ dipCm, litres }` points. Between two points the litres
 * are interpolated on a straight line. The chart may rise with the dip (a stick
 * measuring fuel depth) or fall with it (an "ullage" stick measuring the gap
 * from the top) — both are real, so the only shape rule is that it must move in
 * one direction.
 *
 * Pure: no database, no Electron. Tested under plain `npm test`
 * (test/fuelCalibration.test.js).
 */

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Sort, de-duplicate and check a chart. Throws a plain-English error the owner
 * can act on; returns the cleaned `[{ dipCm, litres }]`.
 */
function normalizeChart(points) {
  if (!Array.isArray(points)) throw new Error('The dip chart must be a list of points');
  const clean = [];
  for (const p of points) {
    const dipCm = Number(p?.dipCm);
    const litres = Number(p?.litres);
    if (!isNum(dipCm) || !isNum(litres)) throw new Error('Every chart point needs a number of cm and a number of litres');
    if (dipCm < 0 || litres < 0) throw new Error('Chart values cannot be negative');
    clean.push({ dipCm, litres });
  }
  clean.sort((a, b) => a.dipCm - b.dipCm);
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i].dipCm === clean[i - 1].dipCm) {
      throw new Error(`The dip chart has ${clean[i].dipCm} cm twice`);
    }
  }
  if (clean.length < 2) throw new Error('A dip chart needs at least two points');
  let rising = 0;
  let falling = 0;
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i].litres > clean[i - 1].litres) rising += 1;
    if (clean[i].litres < clean[i - 1].litres) falling += 1;
  }
  if (rising && falling) {
    throw new Error('The litres in a dip chart must only go up, or only go down, as the cm rise');
  }
  if (!rising && !falling) throw new Error('A dip chart cannot have the same litres at every point');
  return clean;
}

/** Index of the segment [i, i+1] used for `dipCm` (clamped to the ends). */
function segmentIndex(chart, dipCm) {
  if (dipCm <= chart[0].dipCm) return 0;
  for (let i = 0; i < chart.length - 1; i += 1) {
    if (dipCm <= chart[i + 1].dipCm) return i;
  }
  return chart.length - 2;
}

/**
 * Litres for a dip reading. Outside the chart the end segment is extended
 * (never below 0 L) and `outOfRange` is set so the screen can say so.
 */
function lookup(chart, dipCm) {
  if (!Array.isArray(chart) || chart.length < 2 || !isNum(dipCm)) return { litres: null, outOfRange: true };
  const i = segmentIndex(chart, dipCm);
  const a = chart[i];
  const b = chart[i + 1];
  const t = (dipCm - a.dipCm) / (b.dipCm - a.dipCm);
  const litres = Math.max(0, a.litres + t * (b.litres - a.litres));
  const outOfRange = dipCm < chart[0].dipCm || dipCm > chart[chart.length - 1].dipCm;
  return { litres: round2(litres), outOfRange };
}

function litresAt(chart, dipCm) {
  return lookup(chart, dipCm).litres;
}

/** Absolute litres per cm of the segment `dipCm` falls in — "how much one cm is worth here". */
function litresPerCmAt(chart, dipCm) {
  if (!Array.isArray(chart) || chart.length < 2 || !isNum(dipCm)) return null;
  const i = segmentIndex(chart, dipCm);
  const a = chart[i];
  const b = chart[i + 1];
  return Math.abs((b.litres - a.litres) / (b.dipCm - a.dipCm));
}

/**
 * The reading error of one dip in litres: litres per cm at that level × the
 * allowed misreading in cm (default 1 cm — §4.1).
 */
function dipErrorLitres(chart, dipCm, allowedCm = 1) {
  const perCm = litresPerCmAt(chart, dipCm);
  return perCm == null ? 0 : perCm * Math.max(0, Number(allowedCm) || 0);
}

/**
 * Build a chart from deliveries when the tank maker's chart is missing (§7a:
 * "a dip chart can be entered or built from deliveries").
 *
 * Each observation is one delivery dipped before and after:
 * `{ dipBeforeCm, dipAfterCm, litresAdded }`. That gives the litres per cm over
 * the band between the two readings. The bands are averaged per 1 cm step,
 * gaps take the nearest known slope, and the result is integrated from an
 * anchor point whose litres are known (default: 0 cm = 0 L, an empty tank on a
 * depth stick). The more deliveries, the better it gets — the screen should say
 * it is an estimate.
 */
function buildChartFromDeliveries(observations, { anchor = { dipCm: 0, litres: 0 }, stepCm = 5 } = {}) {
  const usable = (Array.isArray(observations) ? observations : [])
    .map((o) => ({ a: Number(o?.dipBeforeCm), b: Number(o?.dipAfterCm), l: Number(o?.litresAdded) }))
    .filter((o) => isNum(o.a) && isNum(o.b) && isNum(o.l) && o.l > 0 && o.a !== o.b);
  if (usable.length === 0) throw new Error('At least one delivery dipped before and after is needed to build a chart');
  const anchorCm = Number(anchor?.dipCm) || 0;
  const anchorL = Number(anchor?.litres) || 0;

  let lo = anchorCm;
  let hi = anchorCm;
  for (const o of usable) {
    lo = Math.min(lo, o.a, o.b);
    hi = Math.max(hi, o.a, o.b);
  }
  lo = Math.floor(lo);
  hi = Math.ceil(hi);

  // Signed litres per cm per 1-cm bucket [c, c+1).
  const sums = new Map();
  for (const o of usable) {
    const slope = o.l / (o.b - o.a); // signed: an ullage stick falls as fuel is added
    const from = Math.min(o.a, o.b);
    const to = Math.max(o.a, o.b);
    for (let c = Math.floor(from); c < Math.ceil(to); c += 1) {
      const s = sums.get(c) || { total: 0, n: 0 };
      s.total += slope;
      s.n += 1;
      sums.set(c, s);
    }
  }
  const known = [...sums.keys()].sort((x, y) => x - y);
  const slopeAt = (c) => {
    if (sums.has(c)) return sums.get(c).total / sums.get(c).n;
    let best = known[0];
    for (const k of known) if (Math.abs(k - c) < Math.abs(best - c)) best = k;
    return sums.get(best).total / sums.get(best).n;
  };
  // Litres at every whole cm, integrated outwards from the anchor.
  const litresByCm = new Map([[Math.round(anchorCm), anchorL]]);
  for (let c = Math.round(anchorCm); c < hi; c += 1) litresByCm.set(c + 1, litresByCm.get(c) + slopeAt(c));
  for (let c = Math.round(anchorCm); c > lo; c -= 1) litresByCm.set(c - 1, litresByCm.get(c) - slopeAt(c - 1));

  const step = Math.max(1, Math.round(Number(stepCm) || 5));
  const points = [];
  for (let c = lo; c <= hi; c += 1) {
    if ((c - lo) % step === 0 || c === hi) points.push({ dipCm: c, litres: round2(Math.max(0, litresByCm.get(c))) });
  }
  return { points, observations: usable.length, coveredFromCm: lo, coveredToCm: hi };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  normalizeChart,
  lookup,
  litresAt,
  litresPerCmAt,
  dipErrorLitres,
  buildChartFromDeliveries,
};
