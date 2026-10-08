/**
 * 0.1.94: "Undo" on the delete toasts.
 *
 * A product or photo delete holds the item in the recycle bin
 * (main/deletedItems.js) and `deleted:restore` puts it back. The delete calls
 * do not return the bin entry's id, so Undo looks it up: the bin lists newest
 * first, and the entries just made are the newest ones for that product.
 *
 *   - products: one entry per deleted product id (kind 'product').
 *   - photos:   the newest N 'image' entries of that product. Labels are not
 *               used to match: removing several photos renumbers the survivors
 *               between deletes, so two held photos can carry the same
 *               filename label.
 *
 * Restored photos come back at the END of the product's photos (the bin's own
 * rule — their old slots belong to other photos by now).
 *
 * `pickProductEntries` / `pickImageEntries` are pure, for tests.
 */

export function pickProductEntries(items, productIds) {
  const wanted = new Set(productIds || []);
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (item?.kind !== 'product' || !wanted.has(item.productId) || seen.has(item.productId)) continue;
    seen.add(item.productId);
    out.push(item);
  }
  return out;
}

export function pickImageEntries(items, productId, count) {
  return (items || []).filter((item) => item?.kind === 'image' && item.productId === productId).slice(0, Math.max(0, count));
}

async function restoreAll(entries) {
  let restored = 0;
  const errors = [];
  for (const entry of entries) {
    try {
      await window.api.deleted.restore(entry.id);
      restored += 1;
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }
  return { restored, errors };
}

function report(addToast, { restored, errors }, noun, expected) {
  if (restored === 0 && errors.length === 0) {
    addToast(`Couldn't find the deleted ${noun} — look in Settings → Recently deleted.`, 'error');
  } else if (errors.length === 0) {
    addToast(`Restored ${restored} ${noun}${restored === 1 ? '' : 's'}.`, 'success');
  } else {
    addToast(`Restored ${restored} of ${expected} — ${errors[0]}`, 'error');
  }
}

export async function undoProductDeletes({ companyId, productIds, addToast, onRestored }) {
  try {
    const listing = await window.api.deleted.list(companyId);
    const entries = pickProductEntries(listing?.items, productIds);
    const result = await restoreAll(entries);
    report(addToast, result, 'product', productIds.length);
    if (result.restored > 0) onRestored?.();
  } catch (err) {
    addToast(err?.message || String(err), 'error');
  }
}

export async function undoImageDeletes({ companyId, productId, count, addToast, onRestored }) {
  try {
    const listing = await window.api.deleted.list(companyId);
    const entries = pickImageEntries(listing?.items, productId, count);
    const result = await restoreAll(entries);
    report(addToast, result, 'photo', count);
    if (result.restored > 0) onRestored?.();
  } catch (err) {
    addToast(err?.message || String(err), 'error');
  }
}
