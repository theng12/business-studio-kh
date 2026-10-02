/**
 * v0.15.3: tiny "Edited <when> [by <who>]" chip.
 *
 * Used in the Library side panel, brand panel, etc. Resolves the user
 * name through the store's `attributionUsers` map so the chip is the
 * user's display name, not their UUID. If `updatedByUserId` is null
 * (server admin / standalone), we just show the relative time.
 *
 * Re-renders on a 60s timer so "5 min ago" graduates to "6 min ago"
 * without the parent component needing to know.
 */
import { useSyncExternalStore } from 'react';
import { useAppStore } from '../store/index.js';
import { formatDateTime, timeAgo } from '../lib/format.js';

/* One minute ticker shared by every chip on screen. Each chip used to start
 * its own 60s interval, so a 200-row Library page ran 200 timers firing out
 * of step. Now there is one interval while at least one chip is mounted and
 * none otherwise, and every chip updates in the same render pass. */
const minuteListeners = new Set();
let minuteTick = 0;
let minuteTimer = null;

function subscribeMinute(listener) {
  minuteListeners.add(listener);
  if (!minuteTimer) {
    minuteTimer = setInterval(() => {
      minuteTick += 1;
      for (const fn of minuteListeners) fn();
    }, 60_000);
  }
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}

const getMinuteTick = () => minuteTick;

function useMinuteTick() {
  return useSyncExternalStore(subscribeMinute, getMinuteTick);
}

export function Attribution({ updatedAt, updatedByUserId, prefix = 'Edited' }) {
  const attributionUsers = useAppStore((s) => s.attributionUsers);
  // Re-render once a minute so the relative time stays fresh.
  useMinuteTick();

  if (!updatedAt) return null;
  const name = updatedByUserId ? (attributionUsers?.[updatedByUserId] ?? null) : null;

  return (
    <div className="attribution" title={formatDateTime(updatedAt)}>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.1" />
        <path d="M6 3.2v3l1.8 1.1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
      <span>{prefix} {timeAgo(updatedAt)}</span>
      {name ? <span className="attribution__by">by <strong>{name}</strong></span> : null}
    </div>
  );
}

/**
 * v0.22.5: very compact attribution used in list rows. No icon, no
 * "Edited" prefix — just `<time> · <name>` (or just `<time>` if no
 * user). The full timestamp is in the tooltip. Designed to fit in a
 * table cell or a one-line grid card footer where the regular
 * Attribution component would be too tall.
 *
 * Shares the one minute ticker above so a Library page open in the
 * background keeps "5 min ago" honest as the minute hand turns.
 */
export function CompactAttribution({ updatedAt, updatedByUserId }) {
  const attributionUsers = useAppStore((s) => s.attributionUsers);
  useMinuteTick();

  if (!updatedAt) return null;
  const name = updatedByUserId ? (attributionUsers?.[updatedByUserId] ?? null) : null;
  const when = timeAgo(updatedAt);
  const tip = name
    ? `Edited ${when} by ${name} (${formatDateTime(updatedAt)})`
    : `Edited ${formatDateTime(updatedAt)}`;
  return (
    <span className="attribution--compact" title={tip}>
      <span className="attribution--compact__when">{when}</span>
      {name ? <span className="attribution--compact__by"> · {name}</span> : null}
    </span>
  );
}
