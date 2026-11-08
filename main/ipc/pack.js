/**
 * Pick & Pack over IPC/RPC (docs/PICK_AND_PACK_PLAN.md §3, §4, §7).
 *
 * Two capability groups, both opt-in (main/util/capabilities.js):
 *   - pack.work      the pack screen: queue, scan, photo, seal.
 *   - orders.manage  import, quick add, edit open orders, view every order.
 *
 * Every data channel is `expose()`d so the `/pack` phone page and client Macs
 * reach it over /api/rpc. The pack-facing reads NEVER include a price or the
 * optional order value; only `orders:*` (orders.manage) sees those.
 *
 * Photos are written to <dataDir>/pack/... (main/packPhotos.js) and read back
 * only through `pack:getPhoto`, which checks the caller's company first.
 */

const pack = require('../db/pack');
const { saveParcelPhoto, readParcelPhoto } = require('../packPhotos');
const { activeCompanyId, emitPackChange, getCallerUserId } = require('./packAccess');

function register({ expose }) {
  /* ─── pack screen ─────────────────────────────────────────────── */

  expose('pack:list', (args = {}) => {
    const companyId = activeCompanyId();
    const tab = ['pack', 'packed', 'problems'].includes(args?.tab) ? args.tab : 'pack';
    return pack.packList(companyId, tab);
  });

  expose('pack:get', (orderId) => {
    const companyId = activeCompanyId();
    return pack.getOrder(companyId, orderId, { forPacking: true });
  });

  expose('pack:scan', ({ orderId, code } = {}) => {
    const companyId = activeCompanyId();
    const result = pack.scan(companyId, orderId, code, getCallerUserId());
    if (result.matched) emitPackChange('order', 'scan', orderId, companyId);
    return result;
  });

  expose('pack:confirmLine', ({ orderId, lineId, delta } = {}) => {
    const companyId = activeCompanyId();
    const result = pack.confirmLine(companyId, orderId, lineId, delta == null ? 1 : delta, getCallerUserId());
    emitPackChange('order', 'confirm', orderId, companyId);
    return result;
  });

  expose('pack:addPhoto', async ({ orderId, kind, bytes } = {}) => {
    const companyId = activeCompanyId();
    const stored = await saveParcelPhoto(orderId, kind, bytes);
    const row = pack.addPhotoRow(companyId, orderId, { kind, ...stored }, getCallerUserId());
    emitPackChange('order', 'photo', orderId, companyId);
    return row;
  });

  expose('pack:getPhoto', async ({ photoId, thumb } = {}) => {
    const companyId = activeCompanyId();
    const row = pack.getPhoto(companyId, photoId);
    return readParcelPhoto(row.relPath, { thumb: !!thumb, expectedSha256: row.sha256 });
  });

  expose('pack:seal', (orderId) => {
    const companyId = activeCompanyId();
    const result = pack.seal(companyId, orderId, getCallerUserId());
    emitPackChange('order', 'seal', orderId, companyId);
    return result;
  });

  expose('pack:getSettings', () => pack.getSettings(activeCompanyId()));

  expose('pack:updateSettings', (patch = {}) => {
    const companyId = activeCompanyId();
    const result = pack.updateSettings(companyId, patch, getCallerUserId());
    emitPackChange('settings', 'update', null, companyId);
    return result;
  });

  /* ─── orders (orders.manage) ──────────────────────────────────── */

  expose('orders:list', (args = {}) => pack.listOrders(activeCompanyId(args?.companyId), args || {}));

  expose('orders:get', (id) => pack.getOrder(activeCompanyId(), id));

  expose('orders:update', ({ id, patch } = {}) => {
    const companyId = activeCompanyId();
    const result = pack.updateOrder(companyId, id, patch || {}, getCallerUserId());
    emitPackChange('order', 'update', id, companyId);
    return result;
  });

  expose('orders:remove', (id) => {
    const companyId = activeCompanyId();
    const result = pack.removeOrder(companyId, id);
    emitPackChange('order', 'remove', id, companyId);
    return result;
  });

  expose('orders:import', (args = {}) => {
    const companyId = activeCompanyId(args.companyId);
    const result = pack.importOrders(companyId, args.source, args.rows, {
      dryRun: !!args.dryRun,
      userId: getCallerUserId(),
    });
    if (!args.dryRun) emitPackChange('order', 'import', null, companyId);
    return result;
  });

  expose('orders:quickAdd', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const result = pack.quickAdd(companyId, input, getCallerUserId());
    emitPackChange('order', 'create', result.order.id, companyId);
    return result;
  });

  expose('orders:getMapping', ({ companyId: requested, source } = {}) =>
    pack.getMapping(activeCompanyId(requested), source));

  expose('orders:saveMapping', ({ companyId: requested, source, mapping } = {}) =>
    pack.saveMapping(activeCompanyId(requested), source, mapping));

  expose('orders:lookupProduct', ({ companyId: requested, code } = {}) =>
    pack.lookupProduct(activeCompanyId(requested), code));
}

module.exports = { register };
