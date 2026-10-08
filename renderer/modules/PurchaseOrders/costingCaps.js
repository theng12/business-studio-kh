/**
 * Which costing actions the current user may take, for the Purchase Orders,
 * Suppliers and Dashboard screens.
 *
 * Same rule as `useUserCaps()` in renderer/components/Sidebar.jsx — the host
 * Mac (standalone / server) has every capability; a client Mac has the caps
 * its account was given — answered through the shared `hasCap`. It is not
 * imported from Sidebar.jsx because that module pulls in the whole sidebar
 * and `zustand/react/shallow`, which the screen tests
 * (test/operationsFreshness.test.js) cannot load; selecting the caps array
 * directly needs no shallow compare, since the store keeps the same array
 * until the connection changes.
 *
 * The server refuses these writes anyway (main/util/capabilities.js maps
 * `pos:*` / `suppliers:*` writes to costing.manage). Hiding the controls is
 * what keeps a view-only user from meeting "Forbidden: role … cannot use
 * pos:create" after filling in a form.
 */
import { useAppStore } from '../../store/index.js';
import { hasCap } from '../../lib/capabilities.js';

const ALL_CAPS = ['*'];

export function useCostingCaps() {
  const appMode = useAppStore((s) => s.appMode);
  const clientCaps = useAppStore((s) => s.clientConnection?.user?.caps);
  const caps = appMode === 'client' ? (clientCaps || ALL_CAPS) : ALL_CAPS;
  return {
    canView: hasCap(caps, 'costing.view'),
    canManage: hasCap(caps, 'costing.manage'),
    // Writing a product's price (Cost Calculator's "Save as retail price")
    // is products:update on the server, i.e. products.edit — not costing.
    canEditProducts: hasCap(caps, 'products.edit'),
  };
}
