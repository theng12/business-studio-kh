/**
 * Fixed Assets A1: one vehicle, one record — the Fuel link (docs/ASSETS_AND_BRANCHES_PLAN.md §3.4).
 *
 * The register owns IDENTITY (name, plate/serial, branch, custodian, status);
 * Fuel owns fuel behaviour (type, fuel type, meter, tank, baseline). A linked
 * vehicle's `fuel_assets.name`, `plate_or_serial`, `assigned_employee_id` and
 * `branch_id` are MIRRORS of the register, written only here, inside the same
 * transaction as the register change. Fuel F1's rules, reports and phone
 * tiles keep reading their own columns, so nothing in F1 changes.
 *
 *   syncToFuel(assetId)          register → fuel, after any register change
 *   mirrorFromFuel(fuelId, ch)   fuel → register, when `fuel:updateAsset` edits
 *                                a linked vehicle's name, plate or driver
 *   ensureFuelLinked(companyId)  one-time per company (marker
 *                                `assets.fuelLinked.<companyId>` in app_state):
 *                                every unlinked fuel vehicle / machine gets a
 *                                DRAFT register entry marked "needs cost". Runs
 *                                on the first assets:* call for a company —
 *                                never at boot for companies that never open Assets.
 *   onFuelAssetCreated(f)        after that, a vehicle created in Fuel gets its
 *                                draft in the same transaction.
 *
 * `home_location` text is never turned into a branch here (§3.1).
 */

const { getDb, getAppState, setAppState } = require('./index');
const { badRequest, str, audit, notFound } = require('./_assetUtil');

/** §3.4: the category a fuel type becomes in the register. */
const FUEL_TYPE_TO_CATEGORY = {
  truck: 'truck', car_van: 'car', motorbike: 'motorbike',
  forklift: 'plant', generator: 'plant', water_pump: 'plant', tractor: 'plant', skid_steer: 'plant',
};

function markerKey(companyId) { return `assets.fuelLinked.${companyId}`; }

function isLinkedCompany(companyId) {
  return !!getAppState(markerKey(companyId));
}

function categoryForFuelAsset(companyId, f) {
  const config = require('./assetConfig');
  const type = getDb().prepare('SELECT builtin_key, meter_unit FROM fuel_asset_types WHERE id = ?').get(f.type_id);
  const key = (type?.builtin_key && FUEL_TYPE_TO_CATEGORY[type.builtin_key]) || ((type?.meter_unit || f.meter_unit) === 'km' ? 'car' : 'plant');
  return config.categoryByKey(companyId, key);
}

/** A draft register entry for one fuel vehicle / machine (raw fuel_assets row). Must run inside the caller's transaction. */
function createDraftFor(f) {
  const fixedAssets = require('./fixedAssets');
  const category = categoryForFuelAsset(f.company_id, f);
  const isVehicle = category?.isVehicle;
  const employee = f.assigned_employee_id
    ? getDb().prepare('SELECT status FROM employees WHERE id = ?').get(f.assigned_employee_id) : null;
  const branch = f.branch_id ? getDb().prepare('SELECT status FROM branches WHERE id = ?').get(f.branch_id) : null;
  return fixedAssets.create({
    companyId: f.company_id, categoryId: category.id, name: f.name,
    plateNo: isVehicle ? f.plate_or_serial : null, serialNo: isVehicle ? null : f.plate_or_serial,
    custodianEmployeeId: employee && employee.status !== 'left' ? f.assigned_employee_id : null,
    branchId: branch && branch.status === 'active' ? f.branch_id : null,
    status: f.status === 'retired' ? 'in_storage' : 'in_use',
    origin: 'fuel', needsCost: true, fuelAssetId: f.id,
    notes: f.home_location ? `Fuel home location: ${f.home_location}` : null,
  });
}

/** One-time per company: drafts for every unlinked fuel vehicle. Idempotent. Returns how many were made. */
function ensureFuelLinked(companyId) {
  if (!companyId || isLinkedCompany(companyId)) return 0;
  const db = getDb();
  let made = 0;
  db.transaction(() => {
    const rows = db.prepare(`
      SELECT f.* FROM fuel_assets f WHERE f.company_id = ?
         AND NOT EXISTS (SELECT 1 FROM fixed_assets a WHERE a.fuel_asset_id = f.id)
       ORDER BY f.created_at
    `).all(companyId);
    for (const f of rows) { createDraftFor(f); made += 1; }
    setAppState(markerKey(companyId), String(Date.now()));
  })();
  if (made) audit('fixed_asset', companyId, 'fuel-link', { after: { draftsFromFuel: made } });
  return made;
}

/** Called by fuel.createAsset inside its transaction: once a company uses Assets, a new fuel vehicle gets its draft. */
function onFuelAssetCreated(fuelAssetId) {
  const f = getDb().prepare('SELECT * FROM fuel_assets WHERE id = ?').get(fuelAssetId);
  if (!f || !isLinkedCompany(f.company_id)) return null;
  if (getDb().prepare('SELECT 1 FROM fixed_assets WHERE fuel_asset_id = ?').get(f.id)) return null;
  return createDraftFor(f);
}

function fuelMirror(a) {
  return { name: a.name, plate: a.plate_no || a.serial_no || null, employee: a.custodian_employee_id || null, branch: a.branch_id || null };
}

/**
 * Register → fuel. Writes the four mirror columns of the linked fuel asset when
 * they differ. Call inside the transaction of the register change.
 */
function syncToFuel(assetId) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM fixed_assets WHERE id = ?').get(assetId);
  if (!a || !a.fuel_asset_id) return false;
  const f = db.prepare('SELECT * FROM fuel_assets WHERE id = ?').get(a.fuel_asset_id);
  if (!f) return false;
  const m = fuelMirror(a);
  if (f.name === m.name && (f.plate_or_serial ?? null) === m.plate && (f.assigned_employee_id ?? null) === m.employee && (f.branch_id ?? null) === m.branch) return false;
  db.prepare('UPDATE fuel_assets SET name = ?, plate_or_serial = ?, assigned_employee_id = ?, branch_id = ?, updated_at = ? WHERE id = ?')
    .run(m.name, m.plate, m.employee, m.branch, Math.max(Date.now(), (f.updated_at || 0) + 1), f.id);
  audit('fuel_asset', f.id, 'mirror', {
    before: { name: f.name, plateOrSerial: f.plate_or_serial, assignedEmployeeId: f.assigned_employee_id, branchId: f.branch_id ?? null },
    after: { name: m.name, plateOrSerial: m.plate, assignedEmployeeId: m.employee, branchId: m.branch, fromRegister: a.tag_code },
  });
  return true;
}

/**
 * Fuel → register: `fuel:updateAsset` changed a linked vehicle's name, plate or
 * driver. The register takes the change (a custodian change on an active asset
 * is recorded as a `custodian` event, so its history stays complete).
 * `changed` holds the fuel field names that were written.
 */
function mirrorFromFuel(fuelAssetId, changed = {}) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM fixed_assets WHERE fuel_asset_id = ?').get(fuelAssetId);
  if (!a) return false;
  const sets = [];
  const params = { id: a.id, now: Date.now() };
  if ('name' in changed && changed.name && changed.name !== a.name) { sets.push('name = @name'); params.name = changed.name; }
  if ('plateOrSerial' in changed) {
    const col = a.plate_no != null || a.serial_no == null ? 'plate_no' : 'serial_no';
    if ((changed.plateOrSerial ?? null) !== (a[col] ?? null)) { sets.push(`${col} = @plate`); params.plate = changed.plateOrSerial ?? null; }
  }
  let custodianEvent = null;
  if ('assignedEmployeeId' in changed && (changed.assignedEmployeeId ?? null) !== (a.custodian_employee_id ?? null)) {
    sets.push('custodian_employee_id = @emp');
    params.emp = changed.assignedEmployeeId ?? null;
    if (a.record_state === 'active') custodianEvent = { from: a.custodian_employee_id ?? null, to: params.emp };
  }
  if (!sets.length) return false;
  db.prepare(`UPDATE fixed_assets SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  if (custodianEvent) {
    require('./fixedAssets').insertEvent({
      companyId: a.company_id, assetId: a.id, kind: 'custodian', eventDate: require('./_assetUtil').todayPhnomPenh(),
      reason: 'Driver changed in Fuel', fromEmployeeId: custodianEvent.from, toEmployeeId: custodianEvent.to,
    });
  }
  audit('fixed_asset', a.id, 'mirror', { after: { fromFuel: fuelAssetId, ...changed } });
  return true;
}

/** Link an existing fuel vehicle to a register entry. The register's identity wins and is written to Fuel. */
function link(assetId, fuelAssetId) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM fixed_assets WHERE id = ?').get(assetId);
  if (!a) throw notFound('Asset');
  if (a.record_state === 'cancelled') throw badRequest('A cancelled draft cannot be linked');
  if (a.fuel_asset_id === fuelAssetId) return false;
  if (a.fuel_asset_id) throw badRequest(`${a.tag_code} is already linked to a fuel vehicle — unlink it first`);
  const f = db.prepare('SELECT * FROM fuel_assets WHERE id = ?').get(fuelAssetId);
  if (!f || f.company_id !== a.company_id) throw badRequest('That fuel vehicle is not in this company');
  const other = db.prepare('SELECT tag_code FROM fixed_assets WHERE fuel_asset_id = ?').get(fuelAssetId);
  if (other) throw badRequest(`That fuel vehicle is already linked to ${other.tag_code}`);
  db.transaction(() => {
    db.prepare('UPDATE fixed_assets SET fuel_asset_id = ?, updated_at = ? WHERE id = ?').run(fuelAssetId, Date.now(), assetId);
    syncToFuel(assetId);
  })();
  audit('fixed_asset', assetId, 'fuel-link', { after: { fuelAssetId } });
  return true;
}

function unlink(assetId, reason) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM fixed_assets WHERE id = ?').get(assetId);
  if (!a) throw notFound('Asset');
  if (!a.fuel_asset_id) return false;
  const why = str(reason, 500);
  if (!why) throw badRequest('Say why the fuel vehicle is unlinked');
  db.prepare('UPDATE fixed_assets SET fuel_asset_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), assetId);
  audit('fixed_asset', assetId, 'fuel-unlink', { before: { fuelAssetId: a.fuel_asset_id }, after: { fuelAssetId: null, reason: why } });
  return true;
}

/**
 * "Track fuel for this" (§3.4): create the fuel_assets row for a register entry
 * and link it, in one transaction. Fuel settings (type, fuel, meter, tank,
 * baseline) are Fuel's; identity comes from the register.
 */
function createFuelAssetFor(assetId, input = {}) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM fixed_assets WHERE id = ?').get(assetId);
  if (!a) throw notFound('Asset');
  if (a.fuel_asset_id) throw badRequest(`${a.tag_code} already has fuel tracking`);
  if (a.record_state === 'cancelled') throw badRequest('A cancelled draft cannot track fuel');
  const fuel = require('./fuel');
  let created;
  db.transaction(() => {
    created = fuel.createAsset({
      ...input, companyId: a.company_id, name: a.name, plateOrSerial: a.plate_no || a.serial_no || null,
      assignedEmployeeId: a.custodian_employee_id || null,
    }, { skipRegister: true });
    db.prepare('UPDATE fixed_assets SET fuel_asset_id = ?, updated_at = ? WHERE id = ?').run(created.id, Date.now(), assetId);
    syncToFuel(assetId);
  })();
  audit('fixed_asset', assetId, 'fuel-link', { after: { fuelAssetId: created.id, created: true } });
  return fuel.getAsset(created.id);
}

module.exports = { FUEL_TYPE_TO_CATEGORY, ensureFuelLinked, onFuelAssetCreated, syncToFuel, mirrorFromFuel, link, unlink, createFuelAssetFor, isLinkedCompany };
