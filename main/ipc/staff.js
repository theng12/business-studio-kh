/**
 * Fuel F1: the thin staff list over IPC/RPC (docs/PEOPLE_AND_FUEL_PLAN.md §3.1).
 *
 * All `expose()`d: they act on the shared data, and the phone page needs the
 * driver / attendant tiles. Capabilities (main/util/capabilities.js):
 *   staff:list / staff:get / staff:getPhoto / staff:me   fuel.record or fuel.manage
 *   staff:create / update / markLeft / reactivate / setPhoto   fuel.manage
 * HR1 will move the edits under hr.manage.
 */

const employees = require('../db/employees');
const fuelPhotos = require('../fuelPhotos');
const { activeCompanyId, inCompany, emitFuelChange, callerCanManage, getCallerUserId } = require('./fuelAccess');

/** What a recorder (pump / driver phone) needs for a tile — no phone number, notes or account link. */
function tile(e) {
  return {
    id: e.id, companyId: e.companyId, staffCode: e.staffCode, nameEn: e.nameEn, nameKm: e.nameKm,
    hasPhoto: e.hasPhoto, photoSha256: e.photoSha256, position: e.position, isDriver: e.isDriver,
    isFuelAttendant: e.isFuelAttendant, status: e.status,
  };
}

function register({ expose }) {
  expose('staff:list', (filters = {}) => {
    const companyId = activeCompanyId(filters?.companyId);
    if (callerCanManage()) return employees.list(companyId, filters || {});
    return employees.list(companyId, { ...(filters || {}), status: 'active', searchPhone: false }).map(tile);
  });

  /**
   * The staff member linked to the calling account (`userId`), as a tile, or
   * null. The phone page (`/f`) uses it to pre-select "my" vehicle and to know
   * whether this phone belongs to a driver or a pump attendant. Local calls (no
   * caller) get null.
   */
  expose('staff:me', () => {
    const companyId = activeCompanyId();
    const uid = getCallerUserId();
    const me = uid ? employees.getByUserId(companyId, uid) : null;
    return me && me.status === 'active' ? tile(me) : null;
  });

  expose('staff:get', (id) => {
    const e = inCompany(employees.get(id), 'Staff member');
    return callerCanManage() ? e : tile(e);
  });

  expose('staff:create', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const created = employees.create({ ...input, companyId });
    emitFuelChange('staff', 'create', created.id, companyId);
    return created;
  });

  expose('staff:update', ({ id, patch } = {}) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const next = employees.update(id, patch || {});
    emitFuelChange('staff', 'update', id, e.companyId);
    return next;
  });

  expose('staff:markLeft', ({ id, leftOn = null, reason = null } = {}) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const next = employees.markLeft(id, { leftOn, reason });
    emitFuelChange('staff', 'update', id, e.companyId);
    return next;
  });

  expose('staff:reactivate', (id) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const next = employees.reactivate(id);
    emitFuelChange('staff', 'update', id, e.companyId);
    return next;
  });

  expose('staff:setPhoto', async ({ id, bytes } = {}) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const saved = await fuelPhotos.saveStaffPhoto(id, bytes);
    const next = employees.setPhoto(id, saved);
    emitFuelChange('staff', 'update', id, e.companyId);
    return next;
  });

  /** The staff photo as bytes (or a 320 px thumbnail). Null when there is none. */
  expose('staff:getPhoto', async ({ id, thumb = false } = {}) => {
    inCompany(employees.get(id), 'Staff member');
    const row = employees.getRow(id);
    if (!row.photo_path) return null;
    const out = await fuelPhotos.readPhotoFile(row.photo_path, { thumb: thumb === true, expectedSha256: row.photo_sha256 });
    return { bytes: out.bytes, mime: out.mime, sha256: row.photo_sha256, intact: out.intact };
  });
}

module.exports = { register };
