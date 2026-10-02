/**
 * v0.49.46: suppliers IPC — Phase 1 of the costing system.
 *
 * Single domain file because Phase 1 only owns the suppliers table.
 * When POs land in v0.49.47 they'll get their own ipc/purchaseOrders.js
 * — splitting now so this file doesn't balloon. Same `expose` pattern
 * the other domains use, so every channel is automatically RPC-
 * available to client Macs once added to PROXIED_CHANNELS.
 */

const suppliers = require('../db/suppliers');

function register({ expose, emitCatalogChange = () => {} }) {
  // Read paths — safe for any authenticated client. The renderer
  // gates the OPERATIONS sidebar entries via util/permissions.js so
  // photographer / viewer users don't see this data even though the
  // IPC itself accepts their calls (defence in depth — the server-side
  // ACL still drops their writes).
  expose('suppliers:list', ({ companyId, filters } = {}) =>
    suppliers.list(companyId, filters || {}));

  expose('suppliers:get', (id) => suppliers.get(id));

  // Mutation paths — server-side ACL in util/permissions.js rejects
  // these from photographer / viewer tokens. The renderer-side gate is
  // belt; this is braces. Each one emits a `catalog:changed` event of kind
  // 'supplier' so the Suppliers / PO screens on other Macs refetch.
  const emitting = (op, fn, idOf) => (args) => {
    const result = fn(args);
    try { emitCatalogChange('supplier', op, idOf(args, result) ?? null); } catch (_) { /* best effort */ }
    return result;
  };
  expose('suppliers:create',    emitting('create',    (input) => suppliers.create(input ?? {}), (_a, r) => r?.id));
  expose('suppliers:update',    emitting('update',    ({ id, patch } = {}) => suppliers.update(id, patch ?? {}), (a) => a?.id));
  expose('suppliers:archive',   emitting('archive',   (id) => suppliers.archive(id), (id) => id));
  expose('suppliers:unarchive', emitting('unarchive', (id) => suppliers.unarchive(id), (id) => id));
  expose('suppliers:remove',    emitting('remove',    (id) => suppliers.remove(id), (id) => id));
}

module.exports = { register };
