/**
 * v0.49.47 — Purchase Orders IPC.
 *
 * One domain file owns POs + lines + components + product cost cache
 * reads. Same `expose` pattern as the rest of main/ipc/* so every
 * channel is automatically client-mode-RPC-able once added to
 * PROXIED_CHANNELS in main/client/index.js.
 */

const purchaseOrders = require('../db/purchaseOrders');
const landedCost = require('../util/landedCost');

/**
 * Every PO write announces itself as a `catalog:changed` event of kind
 * 'purchaseOrder' so another Mac looking at the same PO list / detail /
 * Suppliers spend refetches. `poId` rides along so a detail screen can tell
 * whether the change is its own PO. The store's dispatcher ignores kinds it
 * does not route (renderer/store/catalogEvents.js); the PO, Supplier,
 * Dashboard and Cost Calculator screens subscribe themselves.
 */
function register({ expose, emitCatalogChange = () => {} }) {
  const emitPo = (op, poId) => {
    try { emitCatalogChange('purchaseOrder', op, poId ?? null, { poId: poId ?? null }); } catch (_) { /* best effort */ }
  };
  // Write wrapper: run the DB call, then emit with the PO it touched. The
  // channel stays a literal expose('…') so test/validatorCoverage.test.js
  // and test/clientReachability.test.js still see it.
  const emitting = (op, fn, poIdOf) => (args) => {
    const result = fn(args);
    emitPo(op, poIdOf(args, result));
    return result;
  };
  const detailPoId = (_args, result) => result?.header?.id ?? null;

  // Reads
  expose('pos:list',                 ({ companyId, filters } = {}) => purchaseOrders.list(companyId, filters || {}));
  expose('pos:get',                  (id) => purchaseOrders.get(id));
  expose('pos:getDetail',            (id) => purchaseOrders.getDetail(id));
  expose('pos:listForSupplier',      (supplierId) => purchaseOrders.listPosForSupplier(supplierId));
  expose('pos:listForProduct',       (productId) => purchaseOrders.listPosForProduct(productId));
  expose('pos:getProductCost',       (productId) => purchaseOrders.getProductCost(productId));
  // v0.49.48: bulk reads for the Library Cost column + Suppliers spend chip.
  expose('pos:listProductCosts',     (companyId) => purchaseOrders.listProductCosts(companyId));
  expose('pos:supplierSpendRollup',  (companyId) => purchaseOrders.supplierSpendRollup(companyId));

  // Header CRUD
  expose('pos:create',    emitting('create',    (input) => purchaseOrders.create(input ?? {}), (_a, r) => r?.id));
  expose('pos:update',    emitting('update',    ({ id, patch } = {}) => purchaseOrders.update(id, patch ?? {}), (a) => a?.id));
  expose('pos:setStatus', emitting('setStatus', ({ id, status, expectedUpdatedAt } = {}) => purchaseOrders.setStatus(id, status, null, expectedUpdatedAt), (a) => a?.id));
  expose('pos:remove',    emitting('remove',    (id) => purchaseOrders.remove(id), (id) => id));

  // Lines + components
  expose('pos:addLine',         emitting('update', ({ poId, input } = {}) => purchaseOrders.addLine(poId, input ?? {}), (a) => a?.poId));
  expose('pos:updateLine',      emitting('update', ({ lineId, patch } = {}) => purchaseOrders.updateLine(lineId, patch ?? {}), detailPoId));
  expose('pos:removeLine',      emitting('update', (lineId) => purchaseOrders.removeLine(lineId), detailPoId));
  expose('pos:addComponent',    emitting('update', ({ poId, input } = {}) => purchaseOrders.addComponent(poId, input ?? {}), (a) => a?.poId));
  expose('pos:updateComponent', emitting('update', ({ componentId, patch } = {}) => purchaseOrders.updateComponent(componentId, patch ?? {}), detailPoId));
  expose('pos:removeComponent', emitting('update', (componentId) => purchaseOrders.removeComponent(componentId), detailPoId));

  // v0.49.50: TT / payment ledger.
  expose('pos:listPayments',         (poId) => purchaseOrders.listPayments(poId));
  expose('pos:addPayment',    emitting('update', ({ poId, input } = {}) => purchaseOrders.addPayment(poId, input ?? {}), (a) => a?.poId));
  expose('pos:updatePayment', emitting('update', ({ paymentId, patch } = {}) => purchaseOrders.updatePayment(paymentId, patch ?? {}), detailPoId));
  expose('pos:removePayment', emitting('update', (paymentId) => purchaseOrders.removePayment(paymentId), detailPoId));

  // v0.49.47: pricing helpers exposed so the Cost Calculator + Library
  // can compute suggested retail without a backend round-trip per
  // keystroke. Pure math; no DB access; safe to call from any role.
  expose('costing:suggestedRetail',  ({ landedCostUsd, targetMarginPct } = {}) =>
    landedCost.suggestedRetail(landedCostUsd, targetMarginPct));
  expose('costing:realizedMargin',   ({ landedCostUsd, retailUsd } = {}) =>
    landedCost.realizedMargin(landedCostUsd, retailUsd));
  expose('costing:containerFillPct', ({ containerType, totalVolumeCbm } = {}) =>
    landedCost.containerFillPct(containerType, totalVolumeCbm));
}

module.exports = { register };
