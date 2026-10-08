/**
 * Fuel F1: the thin staff list over IPC/RPC (docs/PEOPLE_AND_FUEL_PLAN.md §3.1).
 *
 * All `expose()`d: they act on the shared data, and the phone page needs the
 * driver / attendant tiles. Capabilities (main/util/capabilities.js):
 *   staff:list / staff:get / staff:getPhoto   fuel.record, fuel.manage, hr.view or hr.manage
 *   staff:me                                   the same, or attendance.self / attendance.supervise
 *   staff:create / update / markLeft / reactivate / setPhoto   fuel.manage or hr.manage
 * HR1: what comes back depends on the caller (main/ipc/hrAccess.js): hr.manage
 * the full record, hr.view / fuel.manage the directory (no ID / NSSF / bank /
 * date of birth / address), a recorder the tile. The HR profile fields
 * themselves are edited through hr:updateProfile (hr.manage).
 */

const employees = require('../db/employees');
const fuelPhotos = require('../fuelPhotos');
const { activeCompanyId, inCompany, emitFuelChange, getCallerUserId } = require('./fuelAccess');
const { tile, forLevel, staffLevel } = require('./hrAccess');

function register({ expose }) {
  expose('staff:list', (filters = {}) => {
    const companyId = activeCompanyId(filters?.companyId);
    const level = staffLevel();
    if (level !== 'tile') return employees.list(companyId, filters || {}).map((e) => forLevel(e, level));
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
    return forLevel(e);
  });

  expose('staff:create', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const created = employees.create({ ...input, companyId });
    emitFuelChange('staff', 'create', created.id, companyId);
    return forLevel(created);
  });

  expose('staff:update', ({ id, patch } = {}) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const next = employees.update(id, patch || {});
    emitFuelChange('staff', 'update', id, e.companyId);
    return forLevel(next);
  });

  expose('staff:markLeft', ({ id, leftOn = null, reason = null } = {}) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const next = employees.markLeft(id, { leftOn, reason });
    emitFuelChange('staff', 'update', id, e.companyId);
    return forLevel(next);
  });

  expose('staff:reactivate', (id) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const next = employees.reactivate(id);
    emitFuelChange('staff', 'update', id, e.companyId);
    return forLevel(next);
  });

  expose('staff:setPhoto', async ({ id, bytes } = {}) => {
    const e = inCompany(employees.get(id), 'Staff member');
    const saved = await fuelPhotos.saveStaffPhoto(id, bytes);
    const next = employees.setPhoto(id, saved);
    emitFuelChange('staff', 'update', id, e.companyId);
    return forLevel(next);
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
