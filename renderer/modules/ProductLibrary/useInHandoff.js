/**
 * 0.1.95: the Library's "Use in ▾" hand-off, free of React so
 * test/leftovers.test.js can run it.
 *
 * A selection is a Set, which has no order the user can see. The products go
 * to the next screen in the order the Library is showing them (its current
 * sort), and anything ticked that the current filter hides follows after, in
 * the order it was ticked.
 */
export function orderedSelectionIds(selectedIds, orderedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(orderedIds) ? orderedIds : []) {
    if (selected.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  for (const id of selected) {
    if (typeof id === 'string' && id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/**
 * The config patch that adds `ids` to an existing catalog project.
 *
 *  - A hand-picked catalog (`selectionMode: 'explicit'`, or one with a saved
 *    list) gets the new ids appended after its own, without duplicates; the
 *    saved order and any inactive ids it keeps are left alone.
 *  - A catalog of "all active products" already prints every active product,
 *    so there is nothing to add — `{ patch: null, allActive: true }` — and the
 *    caller says so rather than silently narrowing it to this selection.
 */
export function catalogAddPatch(config, ids) {
  const c = config || {};
  const stored = Array.isArray(c.productIds) ? c.productIds.filter((id) => typeof id === 'string' && id) : [];
  const explicit = c.selectionMode === 'explicit' || stored.length > 0;
  if (!explicit) return { patch: null, added: 0, allActive: true };
  const have = new Set(stored);
  const extra = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && id && !have.has(id)) { have.add(id); extra.push(id); }
  }
  if (!extra.length) return { patch: null, added: 0, allActive: false };
  return { patch: { selectionMode: 'explicit', productIds: [...stored, ...extra] }, added: extra.length, allActive: false };
}

/**
 * Add `ids` to catalog project `projectId` through `api` ({ get, update,
 * isConflict }). The patch is computed from the project as it is now and sent
 * with its revision; if the project changed elsewhere meanwhile (a CONFLICT),
 * it is re-read and the patch recomputed once — appending to the newer list
 * loses nothing. A second conflict, or any other error, is thrown.
 * Resolves `{ project, added, allActive }`.
 */
export async function addProductsToCatalog(api, projectId, ids) {
  for (let attempt = 0; ; attempt += 1) {
    const project = await api.get(projectId);
    const { patch, added, allActive } = catalogAddPatch(project?.config, ids);
    if (!patch) return { project, added: 0, allActive };
    try {
      await api.update(project.id, { config: patch, expectedUpdatedAt: project.updatedAt });
      return { project, added, allActive };
    } catch (e) {
      if (attempt >= 1 || !api.isConflict(e)) throw e;
    }
  }
}
