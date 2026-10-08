/**
 * Open the Purchase Orders list with a status filter applied — the
 * Dashboard's Operations chips ("3 open", "1 in transit", "$… owed").
 *
 * Same shape as the store's pendingPoId / pendingPoSupplierId: a transient
 * `pendingPoStatus` the PO module reads in an effect and clears. It is set
 * AFTER the navigation succeeds, so a navigation refused by an editor that
 * could not save leaves nothing behind to fire later.
 *
 * Status values: any PO status, plus 'open' (draft/ordered/in transit) and
 * 'owed' (committed and not fully paid) — main/db/purchaseOrders.js list().
 */
import { useAppStore } from '../../store/index.js';

export async function openPurchaseOrdersWithStatus(status) {
  const ok = await useAppStore.getState().setActiveModule('purchaseorders');
  if (ok) useAppStore.setState({ pendingPoStatus: status });
  return ok;
}

export function clearPendingPoStatus() {
  useAppStore.setState({ pendingPoStatus: null });
}
