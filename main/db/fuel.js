/**
 * Fuel F1: configuration — asset types, vehicles & machines, tanks / farm
 * stores with their dip charts, stations, published prices, thresholds and
 * meter resets (docs/PEOPLE_AND_FUEL_PLAN.md §3.6). The day-to-day records
 * (fills, dips, deliveries, transfers) are in ./fuelRecords.js.
 *
 * Every write is audited. Nothing here deletes a row: assets, tanks and types
 * are retired/archived; a price or a meter reset is voided with a reason.
 */

const { getDb } = require('./index');
const { nextUpdatedAt, prepareOptimisticPatch, parseJson } = require('./_util');
const { uuid, audit, str, num, int, badRequest, fuelType, currency, getCallerUserId } = require('./_fuelUtil');
const { normalizeChart, lookup } = require('../util/tankCalibration');
const { mergeSettings, sanitizeSettingsPatch, phnomPenhDate } = require('../util/fuelAnomalies');

const METER_UNITS = ['km', 'hours', 'none'];
const LOCATION_KINDS = ['tank', 'farm_store'];

/* ─── asset types ─────────────────────────────────────────────── */

const BUILTIN_TYPES = [
  { key: 'truck',      name: 'Truck',       nameKm: 'ឡានដឹកទំនិញ', meterUnit: 'km',    fuel: 'diesel',   maxPerDay: 600 },
  { key: 'car_van',    name: 'Car / van',   nameKm: 'ឡាន',        meterUnit: 'km',    fuel: 'gasoline', maxPerDay: 600 },
  { key: 'motorbike',  name: 'Motorbike',   nameKm: 'ម៉ូតូ',       meterUnit: 'km',    fuel: 'gasoline', maxPerDay: 250 },
  { key: 'forklift',   name: 'Forklift',    nameKm: 'ហ្វកលីហ្វ',   meterUnit: 'hours', fuel: 'diesel',   maxPerDay: 24 },
  { key: 'generator',  name: 'Generator',   nameKm: 'ម៉ាស៊ីនភ្លើង', meterUnit: 'hours', fuel: 'diesel',   maxPerDay: 24 },
  { key: 'water_pump', name: 'Water pump',  nameKm: 'ម៉ាស៊ីនបូមទឹក', meterUnit: 'hours', fuel: 'diesel',   maxPerDay: 24 },
  { key: 'tractor',    name: 'Tractor',     nameKm: 'ត្រាក់ទ័រ',    meterUnit: 'hours', fuel: 'diesel',   maxPerDay: 24 },
  { key: 'skid_steer', name: 'Skid-steer',  nameKm: 'ម៉ាស៊ីនឈូស',  meterUnit: 'hours', fuel: 'diesel',   maxPerDay: 24 },
];

function rowToType(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, builtinKey: r.builtin_key ?? null, isBuiltin: !!r.builtin_key,
    name: r.name, nameKm: r.name_km ?? null, meterUnit: r.meter_unit, defaultFuel: r.default_fuel,
    maxPerDay: r.max_per_day ?? null, sort: r.sort, archived: !!r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Idempotent: the eight built-in types exist for every company that uses fuel. */
function ensureBuiltinTypes(companyId) {
  if (!companyId) return;
  const db = getDb();
  const now = Date.now();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO fuel_asset_types (id, company_id, builtin_key, name, name_km, meter_unit, default_fuel, max_per_day, sort, created_at, updated_at)
    VALUES (@id, @companyId, @key, @name, @nameKm, @meterUnit, @fuel, @maxPerDay, @sort, @now, @now)
  `);
  db.transaction(() => {
    BUILTIN_TYPES.forEach((t, i) => ins.run({ ...t, id: uuid(), companyId, sort: i, now }));
  })();
}

function listAssetTypes(companyId, { includeArchived = false } = {}) {
  if (!companyId) return [];
  ensureBuiltinTypes(companyId);
  return getDb().prepare(`SELECT * FROM fuel_asset_types WHERE company_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY sort, name`)
    .all(companyId).map(rowToType);
}

function getAssetType(id) {
  return rowToType(getDb().prepare('SELECT * FROM fuel_asset_types WHERE id = ?').get(id));
}

function meterUnit(v, fallback) {
  if (v == null || v === '') return fallback;
  if (!METER_UNITS.includes(v)) throw badRequest('Meter must be km, hours or none');
  return v;
}

function createAssetType(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  ensureBuiltinTypes(companyId);
  const name = str(input.name, 80);
  if (!name) throw badRequest('Type name is required');
  const id = uuid();
  const now = Date.now();
  const maxSort = getDb().prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM fuel_asset_types WHERE company_id = ?').get(companyId).m;
  getDb().prepare(`
    INSERT INTO fuel_asset_types (id, company_id, builtin_key, name, name_km, meter_unit, default_fuel, max_per_day, sort, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, name, str(input.nameKm, 80), meterUnit(input.meterUnit, 'km'), fuelType(input.defaultFuel),
    num(input.maxPerDay), maxSort + 1, now, now);
  const created = getAssetType(id);
  audit('fuel_asset_type', id, 'create', { after: created });
  return created;
}

function updateAssetType(id, patch = {}) {
  const existing = getAssetType(id);
  if (!existing) throw badRequest('Asset type not found');
  const map = {
    name: ['name', (v) => { const s = str(v, 80); if (!s) throw badRequest('Type name cannot be empty'); return s; }],
    nameKm: ['name_km', (v) => str(v, 80)],
    meterUnit: ['meter_unit', (v) => meterUnit(v, existing.meterUnit)],
    defaultFuel: ['default_fuel', (v) => fuelType(v)],
    maxPerDay: ['max_per_day', (v) => num(v)],
    archived: ['archived_at', (v) => (v ? Date.now() : null)],
  };
  const sets = [];
  const params = { id, updatedAt: nextUpdatedAt(existing.updatedAt) };
  for (const [k, [col, conv]] of Object.entries(map)) {
    if (!(k in patch)) continue;
    sets.push(`${col} = @${k}`);
    params[k] = conv(patch[k]);
  }
  if (!sets.length) return existing;
  getDb().prepare(`UPDATE fuel_asset_types SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, patch);
  if (diff) audit('fuel_asset_type', id, 'update', diff);
  return getAssetType(id);
}

/* ─── assets (vehicles & machines) ────────────────────────────── */

function rowToAsset(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, typeId: r.type_id, typeName: r.type_name ?? null,
    typeMaxPerDay: r.type_max_per_day ?? null,
    name: r.name, plateOrSerial: r.plate_or_serial ?? null, photoId: r.photo_id ?? null,
    fuelType: r.fuel_type, meterUnit: r.meter_unit, tankCapacityL: r.tank_capacity_l ?? null,
    baselineRate: r.baseline_rate ?? null, baselineSource: r.baseline_source,
    assignedEmployeeId: r.assigned_employee_id ?? null, homeLocation: r.home_location ?? null,
    status: r.status, notes: r.notes ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    updatedByUserId: r.updated_by_user_id ?? null,
  };
}

const ASSET_SELECT = `
  SELECT a.*, t.name AS type_name, t.max_per_day AS type_max_per_day
    FROM fuel_assets a LEFT JOIN fuel_asset_types t ON t.id = a.type_id`;

function listAssets(companyId, { status = 'active', q = null } = {}) {
  if (!companyId) return [];
  const where = ['a.company_id = @companyId'];
  const params = { companyId };
  if (status === 'active' || status === 'retired') { where.push('a.status = @status'); params.status = status; }
  if (q && String(q).trim()) { where.push('(a.name LIKE @q OR a.plate_or_serial LIKE @q)'); params.q = `%${String(q).trim()}%`; }
  return getDb().prepare(`${ASSET_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.name COLLATE NOCASE`).all(params).map(rowToAsset);
}

function getAsset(id) {
  if (!id) return null;
  return rowToAsset(getDb().prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(id));
}

function checkEmployee(companyId, employeeId) {
  if (!employeeId) return null;
  const e = getDb().prepare('SELECT company_id FROM employees WHERE id = ?').get(employeeId);
  if (!e || e.company_id !== companyId) throw badRequest('That staff member is not in this company');
  return employeeId;
}

function positive(v, label) {
  const n = num(v);
  if (n == null) return null;
  if (n <= 0) throw badRequest(`${label} must be more than 0`);
  return n;
}

function createAsset(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  ensureBuiltinTypes(companyId);
  const type = getAssetType(input.typeId);
  if (!type || type.companyId !== companyId) throw badRequest('Pick a vehicle or machine type');
  const name = str(input.name, 120);
  if (!name) throw badRequest('Name is required');
  const id = uuid();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO fuel_assets (id, company_id, type_id, name, plate_or_serial, fuel_type, meter_unit, tank_capacity_l,
      baseline_rate, baseline_source, assigned_employee_id, home_location, status, notes, created_at, updated_at, updated_by_user_id)
    VALUES (@id, @companyId, @typeId, @name, @plate, @fuelType, @meterUnit, @capacity, @baseline, @baselineSource,
      @employee, @home, 'active', @notes, @now, @now, @by)
  `).run({
    id, companyId, typeId: type.id, name,
    plate: str(input.plateOrSerial, 60),
    fuelType: fuelType(input.fuelType, type.defaultFuel),
    meterUnit: meterUnit(input.meterUnit, type.meterUnit),
    capacity: positive(input.tankCapacityL, 'Tank capacity'),
    baseline: positive(input.baselineRate, 'Baseline'),
    baselineSource: input.baselineSource === 'learned' ? 'learned' : 'manual',
    employee: checkEmployee(companyId, input.assignedEmployeeId),
    home: str(input.homeLocation, 120),
    notes: str(input.notes, 2000),
    now, by: getCallerUserId(),
  });
  const created = getAsset(id);
  audit('fuel_asset', id, 'create', { after: created });
  return created;
}

function updateAsset(id, rawPatch = {}) {
  const existing = getAsset(id);
  if (!existing) throw badRequest('Vehicle or machine not found');
  const patch = prepareOptimisticPatch(existing, rawPatch, 'fuel_asset');
  const map = {
    typeId: ['type_id', (v) => { const t = getAssetType(v); if (!t || t.companyId !== existing.companyId) throw badRequest('Pick a vehicle or machine type'); return t.id; }],
    name: ['name', (v) => { const s = str(v, 120); if (!s) throw badRequest('Name cannot be empty'); return s; }],
    plateOrSerial: ['plate_or_serial', (v) => str(v, 60)],
    fuelType: ['fuel_type', (v) => fuelType(v)],
    meterUnit: ['meter_unit', (v) => meterUnit(v, existing.meterUnit)],
    tankCapacityL: ['tank_capacity_l', (v) => positive(v, 'Tank capacity')],
    baselineRate: ['baseline_rate', (v) => positive(v, 'Baseline')],
    baselineSource: ['baseline_source', (v) => (v === 'learned' ? 'learned' : 'manual')],
    assignedEmployeeId: ['assigned_employee_id', (v) => checkEmployee(existing.companyId, v)],
    homeLocation: ['home_location', (v) => str(v, 120)],
    status: ['status', (v) => { if (v !== 'active' && v !== 'retired') throw badRequest('Status must be active or retired'); return v; }],
    notes: ['notes', (v) => str(v, 2000)],
  };
  const sets = [];
  const params = { id };
  const changed = {};
  for (const [k, [col, conv]] of Object.entries(map)) {
    if (!(k in patch)) continue;
    const value = conv(patch[k]);
    sets.push(`${col} = @${k}`);
    params[k] = value;
    changed[k] = value;
  }
  if (!sets.length) return existing;
  params.updatedAt = nextUpdatedAt(existing.updatedAt);
  params.by = getCallerUserId();
  getDb().prepare(`UPDATE fuel_assets SET ${sets.join(', ')}, updated_at = @updatedAt, updated_by_user_id = @by WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('fuel_asset', id, 'update', diff);
  return getAsset(id);
}

function setAssetPhoto(id, photoId) {
  const existing = getAsset(id);
  if (!existing) throw badRequest('Vehicle or machine not found');
  getDb().prepare('UPDATE fuel_assets SET photo_id = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?')
    .run(photoId, nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
  audit('fuel_asset', id, 'photo', { before: { photoId: existing.photoId }, after: { photoId } });
  return getAsset(id);
}

/* ─── stock locations (owner-named tanks and farm stores) ─────── */

function rowToLocation(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, name: r.name, kind: r.kind, fuelType: r.fuel_type,
    capacityL: r.capacity_l ?? null, hasFlowMeter: !!r.has_flow_meter, status: r.status, notes: r.notes ?? null,
    hasChart: !!r.chart_points, chartPoints: r.chart_points ?? 0,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedByUserId: r.updated_by_user_id ?? null,
  };
}

const LOCATION_SELECT = `
  SELECT l.*, (SELECT COUNT(*) FROM fuel_tank_calibration c WHERE c.location_id = l.id) AS chart_points
    FROM fuel_stock_locations l`;

function listLocations(companyId, { status = 'active' } = {}) {
  if (!companyId) return [];
  const where = ['l.company_id = @companyId'];
  if (status === 'active' || status === 'retired') where.push('l.status = @status');
  return getDb().prepare(`${LOCATION_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.name`).all({ companyId, status }).map(rowToLocation);
}

function getLocation(id) {
  if (!id) return null;
  return rowToLocation(getDb().prepare(`${LOCATION_SELECT} WHERE l.id = ?`).get(id));
}

function locationKind(v, fallback = 'tank') {
  if (v == null || v === '') return fallback;
  if (!LOCATION_KINDS.includes(v)) throw badRequest('Kind must be tank or farm_store');
  return v;
}

function assertLocationNameFree(companyId, name, exceptId = null) {
  const clash = getDb().prepare('SELECT id FROM fuel_stock_locations WHERE company_id = ? AND name = ? AND id IS NOT ?').get(companyId, name, exceptId);
  if (clash) throw badRequest(`There is already a tank or store called ${name}`);
}

function createLocation(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const name = str(input.name, 80);
  if (!name) throw badRequest('Give the tank or store a name');
  assertLocationNameFree(companyId, name);
  const id = uuid();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO fuel_stock_locations (id, company_id, name, kind, fuel_type, capacity_l, has_flow_meter, status, notes, created_at, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(id, companyId, name, locationKind(input.kind), fuelType(input.fuelType), positive(input.capacityL, 'Capacity'),
    input.hasFlowMeter ? 1 : 0, str(input.notes, 2000), now, now, getCallerUserId());
  const created = getLocation(id);
  audit('fuel_location', id, 'create', { after: created });
  return created;
}

function updateLocation(id, rawPatch = {}) {
  const existing = getLocation(id);
  if (!existing) throw badRequest('Tank or store not found');
  const patch = prepareOptimisticPatch(existing, rawPatch, 'fuel_location');
  const map = {
    name: ['name', (v) => { const s = str(v, 80); if (!s) throw badRequest('Name cannot be empty'); assertLocationNameFree(existing.companyId, s, id); return s; }],
    kind: ['kind', (v) => locationKind(v)],
    fuelType: ['fuel_type', (v) => fuelType(v)],
    capacityL: ['capacity_l', (v) => positive(v, 'Capacity')],
    hasFlowMeter: ['has_flow_meter', (v) => (v ? 1 : 0)],
    status: ['status', (v) => { if (v !== 'active' && v !== 'retired') throw badRequest('Status must be active or retired'); return v; }],
    notes: ['notes', (v) => str(v, 2000)],
  };
  const sets = [];
  const params = { id };
  const changed = {};
  for (const [k, [col, conv]] of Object.entries(map)) {
    if (!(k in patch)) continue;
    const value = conv(patch[k]);
    sets.push(`${col} = @${k}`);
    params[k] = value;
    changed[k] = k === 'hasFlowMeter' ? !!value : value;
  }
  if (!sets.length) return existing;
  params.updatedAt = nextUpdatedAt(existing.updatedAt);
  params.by = getCallerUserId();
  getDb().prepare(`UPDATE fuel_stock_locations SET ${sets.join(', ')}, updated_at = @updatedAt, updated_by_user_id = @by WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('fuel_location', id, 'update', diff);
  return getLocation(id);
}

/* ─── dip charts ──────────────────────────────────────────────── */

function getChart(locationId) {
  return getDb().prepare('SELECT dip_cm, litres FROM fuel_tank_calibration WHERE location_id = ? ORDER BY dip_cm')
    .all(locationId).map((r) => ({ dipCm: r.dip_cm, litres: r.litres }));
}

/**
 * Replace a tank's dip chart. Dips already saved keep the litres they were
 * saved with (that is the evidence of the day); the chart only affects new
 * dips. The old chart is kept in the audit log.
 */
function setChart(locationId, points) {
  const loc = getLocation(locationId);
  if (!loc) throw badRequest('Tank or store not found');
  const clean = normalizeChart(points);
  const before = getChart(locationId);
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM fuel_tank_calibration WHERE location_id = ?').run(locationId);
    const ins = db.prepare('INSERT INTO fuel_tank_calibration (id, company_id, location_id, dip_cm, litres) VALUES (?, ?, ?, ?, ?)');
    for (const p of clean) ins.run(uuid(), loc.companyId, locationId, p.dipCm, p.litres);
  })();
  audit('fuel_location', locationId, 'chart', { before: { chart: before }, after: { chart: clean } });
  return getChart(locationId);
}

function dipToLitres(locationId, dipCm) {
  const chart = getChart(locationId);
  if (chart.length < 2) return { litres: null, outOfRange: true, hasChart: false };
  return { ...lookup(chart, Number(dipCm)), hasChart: true };
}

/* ─── stations ────────────────────────────────────────────────── */

function rowToStation(r) {
  if (!r) return null;
  return { id: r.id, companyId: r.company_id, name: r.name, area: r.area ?? null, archived: !!r.archived_at, lastUsedAt: r.last_used_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at };
}

/** Stations, most recently used first (the phone's "recent list"). */
function listStations(companyId, { includeArchived = false } = {}) {
  if (!companyId) return [];
  return getDb().prepare(`
    SELECT s.*, (SELECT MAX(f.at) FROM fuel_fills f WHERE f.station_id = s.id) AS last_used_at
      FROM fuel_stations s WHERE s.company_id = ? ${includeArchived ? '' : 'AND s.archived_at IS NULL'}
     ORDER BY last_used_at IS NULL, last_used_at DESC, s.name
  `).all(companyId).map(rowToStation);
}

function getStation(id) {
  if (!id) return null;
  return rowToStation(getDb().prepare('SELECT * FROM fuel_stations WHERE id = ?').get(id));
}

function findOrCreateStation(companyId, name, area = null) {
  const clean = str(name, 120);
  if (!clean) throw badRequest('Station name is required');
  const existing = getDb().prepare('SELECT * FROM fuel_stations WHERE company_id = ? AND name = ?').get(companyId, clean);
  if (existing) return rowToStation(existing);
  const id = uuid();
  const now = Date.now();
  getDb().prepare('INSERT INTO fuel_stations (id, company_id, name, area, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, companyId, clean, str(area, 120), now, now);
  const created = getStation(id);
  audit('fuel_station', id, 'create', { after: created });
  return created;
}

function updateStation(id, patch = {}) {
  const existing = getStation(id);
  if (!existing) throw badRequest('Station not found');
  const sets = [];
  const params = { id, updatedAt: nextUpdatedAt(existing.updatedAt) };
  if ('name' in patch) {
    const n = str(patch.name, 120);
    if (!n) throw badRequest('Station name cannot be empty');
    const clash = getDb().prepare('SELECT id FROM fuel_stations WHERE company_id = ? AND name = ? AND id <> ?').get(existing.companyId, n, id);
    if (clash) throw badRequest(`There is already a station called ${n}`);
    sets.push('name = @name'); params.name = n;
  }
  if ('area' in patch) { sets.push('area = @area'); params.area = str(patch.area, 120); }
  if ('archived' in patch) { sets.push('archived_at = @archivedAt'); params.archivedAt = patch.archived ? Date.now() : null; }
  if (!sets.length) return existing;
  getDb().prepare(`UPDATE fuel_stations SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`).run(params);
  const diff = require('./auditLog').diffPatch(existing, patch);
  if (diff) audit('fuel_station', id, 'update', diff);
  return getStation(id);
}

/* ─── published prices ────────────────────────────────────────── */

function rowToPrice(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, fuelType: r.fuel_type, priceMinorPerL: r.price_minor_per_l, currency: r.currency,
    effectiveFrom: r.effective_from, effectiveTo: r.effective_to ?? null, sourceNote: r.source_note ?? null,
    photoId: r.photo_id ?? null, createdByUserId: r.created_by_user_id ?? null, createdAt: r.created_at,
    voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null,
  };
}

function listPrices(companyId, { fuelType: ft = null, includeVoided = false } = {}) {
  if (!companyId) return [];
  const where = ['company_id = @companyId'];
  if (ft) where.push('fuel_type = @ft');
  if (!includeVoided) where.push('voided_at IS NULL');
  return getDb().prepare(`SELECT * FROM fuel_prices WHERE ${where.join(' AND ')} ORDER BY fuel_type, effective_from DESC, created_at DESC`)
    .all({ companyId, ft }).map(rowToPrice);
}

function getPrice(id) {
  return rowToPrice(getDb().prepare('SELECT * FROM fuel_prices WHERE id = ?').get(id));
}

/** The published price for a fuel type on the date of `at` (latest period starting on or before it). */
function priceOn(companyId, ft, at) {
  const date = phnomPenhDate(at);
  const r = getDb().prepare(`
    SELECT * FROM fuel_prices
     WHERE company_id = ? AND fuel_type = ? AND voided_at IS NULL
       AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC, created_at DESC LIMIT 1
  `).get(companyId, ft, date, date);
  return rowToPrice(r);
}

/** A price-lookup function for the rules, cached per (type, date). */
function priceLookup(companyId) {
  const cache = new Map();
  return (ft, at) => {
    if (!ft) return null;
    const key = `${ft}|${phnomPenhDate(at)}`;
    if (!cache.has(key)) cache.set(key, priceOn(companyId, ft, at));
    return cache.get(key);
  };
}

/**
 * Enter the government's published price from a date. The previous open
 * period for that fuel type is closed the day before, so periods never
 * overlap. A mistake is voided, never edited.
 */
function setPrice(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const ft = fuelType(input.fuelType);
  const price = int(input.priceMinorPerL);
  if (price == null || price <= 0) throw badRequest('Price per litre must be a whole number more than 0 (riel, or US cents)');
  const from = String(input.effectiveFrom || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw badRequest('Effective from must be a date like 2026-10-08');
  const cur = currency(input.currency);
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.transaction(() => {
    const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    db.prepare(`
      UPDATE fuel_prices SET effective_to = ?
       WHERE company_id = ? AND fuel_type = ? AND voided_at IS NULL AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?)
    `).run(dayBefore, companyId, ft, from, from);
    const next = db.prepare(`
      SELECT MIN(effective_from) AS d FROM fuel_prices WHERE company_id = ? AND fuel_type = ? AND voided_at IS NULL AND effective_from > ?
    `).get(companyId, ft, from).d;
    const to = next ? new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : null;
    db.prepare(`
      INSERT INTO fuel_prices (id, company_id, fuel_type, price_minor_per_l, currency, effective_from, effective_to, source_note, photo_id, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, companyId, ft, price, cur, from, to, str(input.sourceNote, 500), str(input.photoId, 60), getCallerUserId(), now);
  })();
  const created = getPrice(id);
  audit('fuel_price', id, 'create', { after: created });
  return created;
}

function voidPrice(id, reason) {
  const existing = getPrice(id);
  if (!existing) throw badRequest('Price not found');
  if (existing.voided) return existing;
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to void a price');
  getDb().prepare('UPDATE fuel_prices SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?')
    .run(Date.now(), why, getCallerUserId(), id);
  audit('fuel_price', id, 'void', { before: existing, after: { voided: true, voidReason: why } });
  return getPrice(id);
}

/* ─── thresholds ──────────────────────────────────────────────── */

function getSettings(companyId) {
  const row = companyId ? getDb().prepare('SELECT settings_json FROM fuel_settings WHERE company_id = ?').get(companyId) : null;
  return mergeSettings(parseJson(row?.settings_json, {}));
}

function updateSettings(companyId, patch) {
  if (!companyId) throw badRequest('Company is required');
  const clean = sanitizeSettingsPatch(patch);
  const row = getDb().prepare('SELECT settings_json FROM fuel_settings WHERE company_id = ?').get(companyId);
  const stored = parseJson(row?.settings_json, {});
  const before = getSettings(companyId);
  const next = { ...stored, ...clean };
  getDb().prepare(`
    INSERT INTO fuel_settings (company_id, settings_json, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id
  `).run(companyId, JSON.stringify(next), Date.now(), getCallerUserId());
  const after = getSettings(companyId);
  const diff = require('./auditLog').diffPatch(before, clean);
  if (diff) audit('fuel_settings', companyId, 'update', diff);
  return after;
}

/* ─── meter resets ────────────────────────────────────────────── */

function rowToReset(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, assetId: r.asset_id ?? null, locationId: r.location_id ?? null, at: r.at,
    oldReading: r.old_reading, newReading: r.new_reading, reason: r.reason, recordedByUserId: r.recorded_by_user_id ?? null,
    createdAt: r.created_at, voided: !!r.voided_at, voidReason: r.void_reason ?? null,
  };
}

function listResets({ assetId = null, locationId = null, includeVoided = false } = {}) {
  const where = [];
  if (assetId) where.push('asset_id = @assetId');
  if (locationId) where.push('location_id = @locationId');
  if (!where.length) return [];
  if (!includeVoided) where.push('voided_at IS NULL');
  return getDb().prepare(`SELECT * FROM fuel_meter_resets WHERE ${where.join(' AND ')} ORDER BY at`).all({ assetId, locationId }).map(rowToReset);
}

/** A replaced or rolled-over odometer / hour meter / pump meter — so it is not read as "going backwards". */
function recordReset(input = {}) {
  const companyId = input.companyId;
  const asset = input.assetId ? getAsset(input.assetId) : null;
  const loc = input.locationId ? getLocation(input.locationId) : null;
  if (!asset && !loc) throw badRequest('Pick the vehicle/machine or the pump the meter belongs to');
  if ((asset && asset.companyId !== companyId) || (loc && loc.companyId !== companyId)) throw badRequest('That belongs to a different company');
  const oldReading = num(input.oldReading);
  const newReading = num(input.newReading);
  if (oldReading == null || newReading == null) throw badRequest('Old and new readings are required');
  const reason = str(input.reason, 500);
  if (!reason) throw badRequest('A reason is required (for example: odometer replaced)');
  const at = num(input.at) ?? Date.now();
  const id = uuid();
  getDb().prepare(`
    INSERT INTO fuel_meter_resets (id, company_id, asset_id, location_id, at, old_reading, new_reading, reason, recorded_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, asset?.id ?? null, loc?.id ?? null, at, oldReading, newReading, reason, getCallerUserId(), Date.now());
  const created = rowToReset(getDb().prepare('SELECT * FROM fuel_meter_resets WHERE id = ?').get(id));
  audit('fuel_meter_reset', id, 'create', { after: created });
  return created;
}

function getReset(id) {
  return rowToReset(getDb().prepare('SELECT * FROM fuel_meter_resets WHERE id = ?').get(id));
}

module.exports = {
  BUILTIN_TYPES,
  METER_UNITS,
  ensureBuiltinTypes,
  listAssetTypes, getAssetType, createAssetType, updateAssetType,
  listAssets, getAsset, createAsset, updateAsset, setAssetPhoto,
  listLocations, getLocation, createLocation, updateLocation,
  getChart, setChart, dipToLitres,
  listStations, getStation, findOrCreateStation, updateStation,
  listPrices, getPrice, priceOn, priceLookup, setPrice, voidPrice,
  getSettings, updateSettings,
  listResets, getReset, recordReset,
};
