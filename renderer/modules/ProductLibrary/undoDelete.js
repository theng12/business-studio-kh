/**
 * 0.1.94: "Undo" on the delete toasts.
 *
 * A product or photo delete holds the item in the recycle bin
 * (main/deletedItems.js) and `deleted:restore` puts it back.
 *
 * The delete calls return the id of the bin entry they created
 * (`products:remove` → `deletedEntryId`, `products:bulkRemove` →
 * `deletedEntryIds`, `images:removeFromProduct` with `withEntry: true` →
 * `deletedEntryId`), and Undo restores EXACTLY those entries. It used to look
 * them up as "the newest N entries for that product", which restored the wrong
 * photo whenever another removal for the same product (on this Mac or another)
 * landed in between.
 *
 * When a delete did not report an entry id (an older server, or the hold
 * failed), there is nothing safe to restore by guessing, so the toast carries
 * no Undo — `entryIdsFrom` returns [] and the caller leaves the action off.
 *
 * Restored photos come back at the END of the product's photos (the bin's own
 * rule — their old slots belong to other photos by now).
 */

/** The bin entry ids a delete call reported, de-duplicated, strings only. */
export function entryIdsFrom(...results) {
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v && !out.includes(v)) out.push(v); };
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    add(r.deletedEntryId);
    if (Array.isArray(r.deletedEntryIds)) r.deletedEntryIds.forEach(add);
  }
  return out;
}

async function restoreAll(entryIds) {
  let restored = 0;
  const errors = [];
  for (const id of entryIds) {
    try {
      await window.api.deleted.restore(id);
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

async function undoEntries({ entryIds, noun, addToast, onRestored }) {
  try {
    const ids = Array.isArray(entryIds) ? entryIds : [];
    const result = await restoreAll(ids);
    report(addToast, result, noun, ids.length);
    if (result.restored > 0) onRestored?.();
  } catch (err) {
    addToast(err?.message || String(err), 'error');
  }
}

export function undoProductDeletes({ entryIds, addToast, onRestored }) {
  return undoEntries({ entryIds, noun: 'product', addToast, onRestored });
}

export function undoImageDeletes({ entryIds, addToast, onRestored }) {
  return undoEntries({ entryIds, noun: 'photo', addToast, onRestored });
}
