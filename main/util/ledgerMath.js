/**
 * Fixed Assets A0: the arithmetic of one journal entry
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §5.2 rule 1). Pure.
 *
 *   - Every line is a debit OR a credit: whole US cents, ≥ 0, exactly one > 0.
 *   - Debits equal credits in US cents, or the entry is refused.
 *   - Each line also carries its riel figure, round(cents × rate / 100) unless
 *     the line brings its own (an amount that really was paid in riel). The
 *     rounding difference between the riel debits and credits is put on the
 *     largest line, so the riel side balances too.
 */

function isWhole(v) { return Number.isSafeInteger(v) && v >= 0; }

function usdCentsToKhr(cents, rate) {
  return Math.round((cents * rate) / 100);
}

/**
 * Validate and complete the lines of one entry. Returns new line objects with
 * `debitMinor`, `creditMinor` and `khrMinor` filled in, in the given order,
 * plus the totals. Throws a plain sentence on anything that does not balance.
 */
function prepareLines(lines, khrPerUsd) {
  const rate = Number(khrPerUsd);
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('The entry needs a riel-per-dollar rate above 0');
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal entry needs at least two lines');
  const out = lines.map((l, i) => {
    const debit = Number(l.debitMinor ?? 0);
    const credit = Number(l.creditMinor ?? 0);
    if (!isWhole(debit) || !isWhole(credit)) throw new Error(`Line ${i + 1}: amounts must be whole cents, not negative`);
    if ((debit > 0) === (credit > 0)) throw new Error(`Line ${i + 1}: a line is either a debit or a credit, and not zero`);
    if (!l.accountId) throw new Error(`Line ${i + 1}: no account`);
    const usd = debit || credit;
    const khr = l.khrMinor != null ? Number(l.khrMinor) : usdCentsToKhr(usd, rate);
    if (!isWhole(khr)) throw new Error(`Line ${i + 1}: the riel figure must be a whole number, not negative`);
    return { ...l, debitMinor: debit, creditMinor: credit, khrMinor: khr, _fixedKhr: l.khrMinor != null };
  });
  const debits = out.reduce((t, l) => t + l.debitMinor, 0);
  const credits = out.reduce((t, l) => t + l.creditMinor, 0);
  if (debits !== credits) throw new Error(`The entry does not balance: debits ${debits} ≠ credits ${credits} (US cents)`);
  if (debits <= 0) throw new Error('The entry has no amount');

  const khrDebits = out.reduce((t, l) => t + (l.debitMinor ? l.khrMinor : 0), 0);
  const khrCredits = out.reduce((t, l) => t + (l.creditMinor ? l.khrMinor : 0), 0);
  const diff = khrDebits - khrCredits;
  if (diff !== 0) {
    // The largest line (by US amount; the first one on a tie) absorbs it —
    // never a line whose riel figure was given (a real riel amount).
    let big = -1;
    for (let i = 0; i < out.length; i += 1) {
      if (out[i]._fixedKhr) continue;
      if (big < 0 || (out[i].debitMinor || out[i].creditMinor) > (out[big].debitMinor || out[big].creditMinor)) big = i;
    }
    if (big < 0) throw new Error('The riel figures given do not balance');
    const line = out[big];
    line.khrMinor = line.debitMinor ? line.khrMinor - diff : line.khrMinor + diff;
    if (line.khrMinor < 0) throw new Error('The riel figures cannot be balanced on this entry');
  }
  const khrTotal = out.reduce((t, l) => t + (l.debitMinor ? l.khrMinor : 0), 0);
  for (const l of out) delete l._fixedKhr;
  return { lines: out, totalMinor: debits, khrTotal };
}

/** Do these stored lines balance in both currencies? (the integrity pass, §7) */
function linesBalance(lines) {
  let d = 0; let c = 0; let kd = 0; let kc = 0;
  for (const l of lines) {
    d += Number(l.debitMinor || 0);
    c += Number(l.creditMinor || 0);
    if (Number(l.debitMinor || 0) > 0) kd += Number(l.khrMinor || 0);
    else kc += Number(l.khrMinor || 0);
  }
  return { usd: d === c, khr: kd === kc, debitMinor: d, creditMinor: c, khrDebit: kd, khrCredit: kc };
}

/** The mirror of a set of lines (a reversal): debits become credits. */
function mirrorLines(lines) {
  return lines.map((l) => ({ ...l, debitMinor: Number(l.creditMinor || 0), creditMinor: Number(l.debitMinor || 0) }));
}

module.exports = { prepareLines, linesBalance, mirrorLines, usdCentsToKhr };
