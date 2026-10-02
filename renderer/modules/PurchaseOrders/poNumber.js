/**
 * Suggest the next PO number from the company's existing ones, keeping their
 * pattern: the highest number (compared naturally, so PO-2026-003 beats
 * PO-2025-120 and PO-10 beats PO-9) has its LAST run of digits bumped by one,
 * zero padding kept — "PO-2026-007" → "PO-2026-008". A suggestion that is
 * already taken keeps counting up. Returns null when no existing number ends
 * in digits, so the field stays empty rather than inventing a scheme.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function suggestNextPoNumber(numbers) {
  const list = (Array.isArray(numbers) ? numbers : [])
    .map((n) => String(n ?? '').trim())
    .filter((n) => /\d/.test(n));
  if (list.length === 0) return null;
  const top = [...list].sort(collator.compare).at(-1);
  const m = top.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return null;
  const [, prefix, digits, suffix] = m;
  const taken = new Set(list.map((n) => n.toLowerCase()));
  let n = Number(digits);
  for (let i = 0; i < 10000; i += 1) {
    n += 1;
    const candidate = `${prefix}${String(n).padStart(digits.length, '0')}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}
