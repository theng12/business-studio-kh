/**
 * The catalog product manager's selection rules, free of React so
 * test/labelCatalog.test.js can run them.
 *
 * `config.productIds` is the catalog's whole hand-made list. Only ACTIVE
 * products print (main/studioRenderer.js buildCatalogHtml skips inactive
 * ones), so the manager shows and edits the active part — but an edit must not
 * throw the rest away. Every edit used to write back the active-only list, so
 * one click anywhere silently dropped every product that happened to be
 * inactive that day, and reactivating it no longer brought it back.
 */

/** Sort the way buildCatalogHtml does for `sortBy: 'sku' | 'name'`. */
export function compareForSort(sortBy) {
  return (a, b) => String((sortBy === 'name' ? a?.name : a?.sku) ?? '')
    .localeCompare(String((sortBy === 'name' ? b?.name : b?.sku) ?? ''), undefined, { numeric: true });
}

/**
 * `{ storedIds, includedIds, hiddenIds }` for a config:
 *  - storedIds: the list as saved (empty when the catalog means "all active"),
 *  - includedIds: the active products the catalog prints, in catalog order,
 *  - hiddenIds: saved ids that are not active (inactive or since deleted),
 *    in their saved positions.
 */
export function catalogIdLists(config, products) {
  const c = config || {};
  const list = Array.isArray(products) ? products : [];
  const active = list.filter((p) => p && p.status !== 'inactive');
  const activeIds = new Set(active.map((p) => p.id));
  const explicit = c.selectionMode === 'explicit' || (Array.isArray(c.productIds) && c.productIds.length > 0);
  const storedIds = explicit && Array.isArray(c.productIds) ? c.productIds : [];
  const includedIds = explicit ? storedIds.filter((id) => activeIds.has(id)) : active.map((p) => p.id);
  const hiddenIds = storedIds.filter((id) => !activeIds.has(id));
  return { storedIds, includedIds, hiddenIds };
}

/**
 * The list to save when the visible (active) order becomes `nextVisible`.
 * Hidden ids keep their saved slots; visible slots are refilled, in order, from
 * `nextVisible`, and anything left over is appended.
 */
export function mergeCatalogIds(storedIds, nextVisible, hiddenIds) {
  const hidden = new Set(hiddenIds || []);
  const seen = new Set();
  const queue = [];
  for (const id of nextVisible || []) {
    if (hidden.has(id) || seen.has(id)) continue;
    seen.add(id); queue.push(id);
  }
  const out = [];
  for (const id of storedIds || []) {
    if (hidden.has(id)) out.push(id);
    else if (queue.length) out.push(queue.shift());
  }
  return [...out, ...queue];
}

/** `ids` with `id` moved to the start ('top') or the end ('bottom'). */
export function moveToEdge(ids, id, edge) {
  if (!ids.includes(id)) return ids;
  const rest = ids.filter((x) => x !== id);
  return edge === 'top' ? [id, ...rest] : [...rest, id];
}

/** `ids` reordered the way the catalog currently sorts them. */
export function idsInSortOrder(ids, productsById, sortBy) {
  const cmp = compareForSort(sortBy);
  return [...ids].sort((a, b) => cmp(productsById.get(a), productsById.get(b)));
}

/**
 * The extra card-field rows this company can print: one per price group
 * (`price.<key>`) and one per custom field its products use (`custom.<key>`).
 * The renderer has always resolved both; the builder just never offered them.
 * There is no custom-field registry, so the keys are read off the products.
 */
export function extraFieldRows(priceGroups = [], products = []) {
  const rows = [];
  const seen = new Set();
  for (const g of Array.isArray(priceGroups) ? priceGroups : []) {
    const key = String(g?.key ?? '').trim();
    if (!key || seen.has(`price.${key}`)) continue;
    seen.add(`price.${key}`);
    rows.push({ key: `price.${key}`, label: `${String(g?.label || key).trim()} price` });
  }
  const custom = new Set();
  for (const p of Array.isArray(products) ? products : []) {
    const fields = p?.customFields;
    if (!fields || typeof fields !== 'object') continue;
    for (const k of Object.keys(fields)) if (String(k).trim()) custom.add(k);
  }
  for (const k of [...custom].sort((a, b) => a.localeCompare(b))) rows.push({ key: `custom.${k}`, label: k });
  return rows;
}
