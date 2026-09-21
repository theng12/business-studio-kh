/**
 * Per-run "resolve a human name to an id, creating it only once" helper.
 *
 * ImportModal resolves its Brand and Category columns by name while building
 * the preview rows. The store's `brands` / `categories` arrays are captured for
 * the render that called buildRows, and they are NOT updated when
 * createBrand()/createCategory() refresh the store mid-run. A naive
 * `find() -> create()` therefore re-read the *stale* array on every row and
 * issued one create IPC per ROW — a 2,000-row price list whose Brand column
 * repeated one name made ~2,000 redundant create calls, each followed by a
 * brands + dashboard refresh. On a client Mac that is minutes of round trips
 * and looks like a hang.
 *
 * This resolver seeds from the current lookups, memoises each id it creates,
 * and matches case-insensitively to mirror the DB's own getByName rule. It is
 * deliberately per-run (created inside buildRows) so a changed company or a
 * reopened modal never reuses another context's cache.
 */
export function createNameIdResolver(existing, createOne) {
  const cache = new Map();
  for (const item of existing ?? []) {
    const key = String(item?.name ?? '').trim().toLowerCase();
    if (key) cache.set(key, item.id);
  }

  return async function resolveId(rawName) {
    const trimmed = String(rawName ?? '').trim();
    if (!trimmed) return null;
    const key = trimmed.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const created = await createOne(trimmed);
    const id = created?.id ?? null;
    if (id) cache.set(key, id);
    return id;
  };
}
