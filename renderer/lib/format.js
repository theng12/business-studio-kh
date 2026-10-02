/**
 * One place for showing times and dates to the user.
 *
 * Before this file, eleven screens each carried their own `relativeTime` /
 * `fmtAgo` / `formatDate`, and they disagreed ("2 hr ago", "2h ago",
 * "2 hours ago"; `toLocaleString()` with seconds on one screen, without on
 * the next). New code imports from here; the old copies get migrated by the
 * page packages that own them (see docs/UI_GUIDE.md).
 *
 * Every function accepts a millisecond timestamp, a numeric string, an ISO
 * string or a Date, and never throws: a missing or unparseable value comes
 * back as '' (timeAgo) or '—' (formatDate / formatDateTime), so a caller can
 * drop the result straight into JSX.
 *
 * Dates use the user's locale with fixed options, so every screen shows the
 * same shape ("2 Oct 2026" / "Oct 2, 2026", depending on the Mac's region).
 */

const DATE_OPTS = { year: 'numeric', month: 'short', day: 'numeric' };
const TIME_OPTS = { hour: '2-digit', minute: '2-digit' };

/** Parse anything date-like into epoch ms, or NaN. */
export function toMillis(ts) {
  if (ts === null || ts === undefined || ts === '') return NaN;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  const s = String(ts).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return new Date(s).getTime();
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "just now" · "5 min ago" · "2 h ago" · "yesterday" · then a date.
 *
 * Under a minute (and anything in the future, i.e. a clock skew between two
 * Macs) is "just now". Under 24 hours is minutes or hours. After that it is
 * "yesterday" when the calendar day is yesterday, otherwise formatDate().
 * `now` is injectable so tests (and a ticking component) can pin the clock.
 */
export function timeAgo(ts, now = Date.now()) {
  const ms = toMillis(ts);
  if (!Number.isFinite(ms)) return '';
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 1) return 'yesterday';
  return formatDate(ms);
}

/** A calendar date in the house style, e.g. "2 Oct 2026". */
export function formatDate(ts) {
  const ms = toMillis(ts);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleDateString(undefined, DATE_OPTS);
}

/** Date and time to the minute, e.g. "2 Oct 2026, 14:05". */
export function formatDateTime(ts) {
  const ms = toMillis(ts);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, { ...DATE_OPTS, ...TIME_OPTS });
}
