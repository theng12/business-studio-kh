/**
 * HR1 (verification, 2026-10-08): one shared cache of the five People
 * lookups — staff list, positions, schedules, leave types, HR settings — so
 * moving between the People pages does not fetch them again each time.
 *
 * Pure (no React, no window): `fetcher(key)` does the loading. One entry, for
 * the key in use (company + what the account may see); a different key (a
 * company switch) replaces it. `invalidate()` drops it (an `hr:changed` of a
 * lookup kind, a fuel staff change) and tells the subscribers, which load
 * again. A load that finishes after its entry was dropped or replaced is
 * returned to its caller but never cached, so a stale answer cannot come back.
 */

export function createLookupCache(fetcher) {
  let entry = null; // { key, value, promise }
  const subscribers = new Set();

  function peek(key) {
    return entry && entry.key === key && entry.value ? entry.value : null;
  }

  function get(key) {
    if (entry && entry.key === key) {
      if (entry.value) return Promise.resolve(entry.value);
      if (entry.promise) return entry.promise;
    }
    const mine = { key, value: null, promise: null };
    mine.promise = Promise.resolve().then(() => fetcher(key)).then((value) => {
      if (entry === mine) { mine.value = value; mine.promise = null; }
      return value;
    }, (err) => {
      if (entry === mine) entry = null; // the next look tries again
      throw err;
    });
    entry = mine;
    return mine.promise;
  }

  /** Drop the cached lookups (all, or only when they belong to `companyId`). */
  function invalidate(companyId = null) {
    if (!entry) return;
    if (companyId && !String(entry.key).startsWith(`${companyId}|`)) return;
    entry = null;
    for (const fn of [...subscribers]) { try { fn(); } catch (_) { /* a subscriber's problem */ } }
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { get, peek, invalidate, subscribe };
}

/** The `hr:changed` kinds that change a lookup. */
export const LOOKUP_KINDS = new Set(['staff', 'position', 'schedule', 'leaveType', 'settings']);
