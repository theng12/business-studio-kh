/**
 * Fuel F1 over IPC/RPC (docs/PEOPLE_AND_FUEL_PLAN.md §3.6, §4, §5.3, §6).
 *
 * Every data channel is `expose()`d — the phone page (`/f`) and client Macs
 * call them over `/api/rpc` with their token; the server's capability gate
 * decides who may (main/util/capabilities.js: `fuel.record` for the recording
 * and tile-reading channels, `fuel.manage` for everything else). The one
 * local-only channel is `fuel:saveMonthlyWorkbook`, which opens a Save dialog
 * on the Mac you are sitting at.
 *
 * After every saved record the asset's and the tank's rules are recomputed
 * (main/db/fuelFlags.js) and the response carries the record's current flags,
 * so the person entering it sees a problem straight away.
 *
 * The full channel list with arguments lives at the end of
 * docs/PEOPLE_AND_FUEL_PLAN.md ("Fuel API").
 */

const fuel = require('../db/fuel');
const records = require('../db/fuelRecords');
const flagsDb = require('../db/fuelFlags');
const reports = require('../db/fuelReports');
const fuelPhotos = require('../fuelPhotos');
const { buildChartFromDeliveries } = require('../util/tankCalibration');
const { activeCompanyId, inCompany, emitFuelChange, callerCanManage, getCallerUserId } = require('./fuelAccess');
const { phnomPenhMonth } = require('../util/fuelAnomalies');

/** 'YYYY-MM' asked for, or this month in Phnom Penh time. */
function monthOr(month) { return month || phnomPenhMonth(Date.now()); }

/* ─── helpers ─────────────────────────────────────────────────── */

function recompute(assetIds = [], locationIds = []) {
  return flagsDb.recomputeForRecord({ assetIds, locationIds });
}

function recomputeCompanyAssets(companyId) {
  const ids = fuel.listAssets(companyId, { status: 'all' }).map((a) => a.id);
  recompute(ids, []);
}

function fillFlags(rootId) {
  return flagsDb.flagsForFill(rootId).filter((f) => !f.resolved);
}

/**
 * Save a record together with its photos:
 *   1. validate (and spot a client_ref retry) — nothing written yet;
 *   2. resize + hash the photos;
 *   3. write them to temporary names, insert the record + photo rows in one
 *      transaction, then move the files to their final names.
 * A duplicate upload (same client_ref) returns the saved record and writes nothing.
 */
async function saveWithPhotos({ ownerKind, prepare, insert, input, timeOf }) {
  const prep = prepare(input);
  if (prep.duplicate) return { record: prep.duplicate, duplicate: true };
  const uploads = await fuelPhotos.prepareUploads(ownerKind, input.photos);
  const staged = fuelPhotos.stagePhotos({ recordId: prep.values.id, at: timeOf(prep.values), photos: uploads });
  let res;
  try {
    res = insert(prep.values, staged.rows);
  } catch (err) {
    staged.abort();
    throw err;
  }
  const saved = res.fill || res.dip || res.delivery || res.transfer;
  if (res.duplicate) {
    staged.abort();
    return { record: res.duplicate, duplicate: true };
  }
  staged.commit();
  return { record: saved, duplicate: false };
}

/** May the caller see / add to this record? Managers always; recorders only their own. */
function assertOwnRecord(ownerKind, ownerId) {
  if (callerCanManage()) return;
  const uid = getCallerUserId();
  const rec = records.photoOwnerRecord({ ownerKind, ownerId });
  if (!rec || !uid || (rec.u !== uid && rec.r !== uid)) {
    throw new Error('You can only see or add photos on records you entered');
  }
}

function photoOwnerCompany(ownerKind, ownerId) {
  if (ownerKind === 'fill') return records.getActiveFill(ownerId)?.companyId ?? null;
  if (ownerKind === 'dip') return records.getDip(ownerId)?.companyId ?? null;
  if (ownerKind === 'delivery') return records.getDelivery(ownerId)?.companyId ?? null;
  if (ownerKind === 'transfer') return records.getTransfer(ownerId)?.companyId ?? null;
  return null;
}

function register({ expose, exposeLocal }) {
  /* ─── thresholds ─── */
  expose('fuel:getSettings', () => fuel.getSettings(activeCompanyId()));
  expose('fuel:updateSettings', (patch = {}) => {
    const companyId = activeCompanyId();
    const next = fuel.updateSettings(companyId, patch);
    flagsDb.recomputeAll({ companyId });
    emitFuelChange('settings', 'update', companyId, companyId);
    return next;
  });

  /* ─── asset types ─── */
  expose('fuel:listAssetTypes', (opts = {}) => fuel.listAssetTypes(activeCompanyId(), opts || {}));
  expose('fuel:createAssetType', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const t = fuel.createAssetType({ ...input, companyId });
    emitFuelChange('assetType', 'create', t.id, companyId);
    return t;
  });
  expose('fuel:updateAssetType', ({ id, patch } = {}) => {
    inCompany(fuel.getAssetType(id), 'Asset type');
    const t = fuel.updateAssetType(id, patch || {});
    emitFuelChange('assetType', 'update', id, t.companyId);
    return t;
  });

  /* ─── vehicles & machines ─── */
  expose('fuel:listAssets', (opts = {}) => fuel.listAssets(activeCompanyId(), opts || {}));
  expose('fuel:getAsset', (id) => inCompany(fuel.getAsset(id), 'Vehicle or machine'));
  expose('fuel:createAsset', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const a = fuel.createAsset({ ...input, companyId });
    emitFuelChange('asset', 'create', a.id, companyId);
    return a;
  });
  expose('fuel:updateAsset', ({ id, patch } = {}) => {
    inCompany(fuel.getAsset(id), 'Vehicle or machine');
    const a = fuel.updateAsset(id, patch || {});
    recompute([id]);
    emitFuelChange('asset', 'update', id, a.companyId);
    return a;
  });
  expose('fuel:setAssetPhoto', async ({ id, bytes } = {}) => {
    const asset = inCompany(fuel.getAsset(id), 'Vehicle or machine');
    const [prepared] = await fuelPhotos.prepareUploads('asset', [{ kind: 'asset', bytes }]);
    const staged = fuelPhotos.stagePhotos({ recordId: id, at: Date.now(), photos: [prepared] });
    try {
      records.insertPhotoRow({ ...staged.rows[0], companyId: asset.companyId, ownerKind: 'asset', ownerId: id });
    } catch (err) {
      staged.abort();
      throw err;
    }
    staged.commit();
    const next = fuel.setAssetPhoto(id, staged.rows[0].id);
    emitFuelChange('asset', 'update', id, asset.companyId);
    return next;
  });

  /* ─── tanks / farm stores and their dip charts ─── */
  expose('fuel:listLocations', (opts = {}) => fuel.listLocations(activeCompanyId(), opts || {}));
  expose('fuel:getLocation', (id) => {
    const loc = inCompany(fuel.getLocation(id), 'Tank or store');
    return { ...loc, chart: fuel.getChart(id) };
  });
  expose('fuel:createLocation', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const loc = fuel.createLocation({ ...input, companyId });
    emitFuelChange('location', 'create', loc.id, companyId);
    return loc;
  });
  expose('fuel:updateLocation', ({ id, patch } = {}) => {
    inCompany(fuel.getLocation(id), 'Tank or store');
    const loc = fuel.updateLocation(id, patch || {});
    recompute([], [id]);
    emitFuelChange('location', 'update', id, loc.companyId);
    return loc;
  });
  expose('fuel:getChart', (locationId) => {
    inCompany(fuel.getLocation(locationId), 'Tank or store');
    return fuel.getChart(locationId);
  });
  expose('fuel:setChart', ({ locationId, points } = {}) => {
    const loc = inCompany(fuel.getLocation(locationId), 'Tank or store');
    const chart = fuel.setChart(locationId, points);
    recompute([], [locationId]);
    emitFuelChange('location', 'update', locationId, loc.companyId);
    return chart;
  });
  expose('fuel:getDipLitres', ({ locationId, dipCm } = {}) => {
    inCompany(fuel.getLocation(locationId), 'Tank or store');
    return fuel.dipToLitres(locationId, dipCm);
  });
  /** A suggested chart built from this tank's deliveries that were dipped before and after (§7a). */
  expose('fuel:getChartSuggestion', ({ locationId, anchor, stepCm } = {}) => {
    inCompany(fuel.getLocation(locationId), 'Tank or store');
    const deliveries = records.activeDeliveriesForLocation(locationId).filter((d) => d.dipBeforeId && d.dipAfterId);
    const observations = [];
    for (const d of deliveries) {
      const b = records.getDip(d.dipBeforeId);
      const a = records.getDip(d.dipAfterId);
      if (b && a && !b.voided && !a.voided && b.dipCm != null && a.dipCm != null) {
        observations.push({ dipBeforeCm: b.dipCm, dipAfterCm: a.dipCm, litresAdded: d.litresInvoiced });
      }
    }
    return buildChartFromDeliveries(observations, { anchor: anchor || undefined, stepCm });
  });

  /* ─── stations ─── */
  expose('fuel:listStations', (opts = {}) => fuel.listStations(activeCompanyId(), opts || {}));
  expose('fuel:createStation', ({ name, area = null } = {}) => {
    const companyId = activeCompanyId();
    const st = fuel.findOrCreateStation(companyId, name, area);
    emitFuelChange('station', 'create', st.id, companyId);
    return st;
  });
  expose('fuel:updateStation', ({ id, patch } = {}) => {
    inCompany(fuel.getStation(id), 'Station');
    const st = fuel.updateStation(id, patch || {});
    emitFuelChange('station', 'update', id, st.companyId);
    return st;
  });

  /* ─── published prices ─── */
  expose('fuel:listPrices', (opts = {}) => fuel.listPrices(activeCompanyId(), opts || {}));
  expose('fuel:setPrice', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const p = fuel.setPrice({ ...input, companyId });
    recomputeCompanyAssets(companyId);
    emitFuelChange('price', 'create', p.id, companyId);
    return p;
  });
  expose('fuel:voidPrice', ({ id, reason } = {}) => {
    const p = inCompany(fuel.getPrice(id), 'Price');
    const next = fuel.voidPrice(id, reason);
    recomputeCompanyAssets(p.companyId);
    emitFuelChange('price', 'void', id, p.companyId);
    return next;
  });

  /* ─── meter resets ─── */
  expose('fuel:listMeterResets', ({ assetId = null, locationId = null, includeVoided = false } = {}) => {
    if (assetId) inCompany(fuel.getAsset(assetId), 'Vehicle or machine');
    if (locationId) inCompany(fuel.getLocation(locationId), 'Tank or store');
    return fuel.listResets({ assetId, locationId, includeVoided });
  });
  expose('fuel:recordMeterReset', (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const r = fuel.recordReset({ ...input, companyId });
    recompute([r.assetId], [r.locationId]);
    emitFuelChange('meterReset', 'create', r.id, companyId);
    return r;
  });

  /* ─── records (phone + Mac) ─── */
  expose('fuel:recordFill', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'fill', input: { ...input, companyId },
      prepare: records.prepareFill, insert: records.insertFill, timeOf: (v) => v.at,
    });
    if (!duplicate) {
      recompute([record.assetId], [record.locationId]);
      emitFuelChange('fill', 'create', record.rootId, companyId);
    }
    return { fill: records.getFill(record.id), duplicate, flags: fillFlags(record.rootId) };
  });

  expose('fuel:recordDip', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'dip', input: { ...input, companyId },
      prepare: records.prepareDip, insert: records.insertDip, timeOf: (v) => v.takenAt,
    });
    if (!duplicate) {
      recompute([], [record.locationId]);
      emitFuelChange('dip', 'create', record.id, companyId);
    }
    return { dip: record, duplicate, flags: flagsDb.listFlags(companyId, { locationId: record.locationId, limit: 20 }).items };
  });

  expose('fuel:recordDelivery', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'delivery', input: { ...input, companyId },
      prepare: records.prepareDelivery, insert: records.insertDelivery, timeOf: (v) => v.at,
    });
    if (!duplicate) {
      recompute([], [record.locationId]);
      emitFuelChange('delivery', 'create', record.id, companyId);
    }
    return { delivery: record, duplicate };
  });

  expose('fuel:setDeliveryDips', ({ id, dipBeforeId, dipAfterId } = {}) => {
    const d = inCompany(records.getDelivery(id), 'Delivery');
    const next = records.setDeliveryDips(id, { dipBeforeId, dipAfterId });
    recompute([], [d.locationId]);
    emitFuelChange('delivery', 'update', id, d.companyId);
    return next;
  });

  expose('fuel:recordTransfer', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'transfer', input: { ...input, companyId },
      prepare: records.prepareTransfer, insert: records.insertTransfer, timeOf: (v) => v.at,
    });
    if (!duplicate) {
      recompute([], [record.fromLocationId, record.toLocationId]);
      emitFuelChange('transfer', 'create', record.id, companyId);
    }
    return { transfer: record, duplicate };
  });

  expose('fuel:receiveTransfer', async ({ id, photos, ...rest } = {}) => {
    const t = inCompany(records.getTransfer(id), 'Transfer');
    const uploads = await fuelPhotos.prepareUploads('transfer', photos);
    const res = records.receiveTransfer(id, rest);
    if (!res.duplicate && uploads.length) {
      const staged = fuelPhotos.stagePhotos({ recordId: id, at: res.transfer.receivedAt, photos: uploads });
      try {
        for (const row of staged.rows) records.insertPhotoRow({ ...row, companyId: t.companyId, ownerKind: 'transfer', ownerId: id });
      } catch (err) {
        staged.abort();
        throw err;
      }
      staged.commit();
    }
    if (!res.duplicate) {
      recompute([], [t.fromLocationId, t.toLocationId]);
      emitFuelChange('transfer', 'update', id, t.companyId);
    }
    return res;
  });

  /** Add a photo to a record after the fact (a paper slip's receipt, a reviewer's extra picture). */
  expose('fuel:addPhoto', async ({ ownerKind, ownerId, kind, bytes } = {}) => {
    if (!['fill', 'dip', 'delivery', 'transfer'].includes(ownerKind)) throw new Error('ownerKind must be fill, dip, delivery or transfer');
    const companyId = photoOwnerCompany(ownerKind, ownerId);
    if (!companyId) throw new Error('Record not found');
    activeCompanyId(companyId);
    const rootId = ownerKind === 'fill' ? records.getActiveFill(ownerId).rootId : ownerId;
    assertOwnRecord(ownerKind, rootId);
    const uploads = await fuelPhotos.prepareUploads(ownerKind, [{ kind, bytes }]);
    const staged = fuelPhotos.stagePhotos({ recordId: rootId, at: Date.now(), photos: uploads });
    let photo;
    try {
      photo = records.insertPhotoRow({ ...staged.rows[0], companyId, ownerKind, ownerId: rootId });
    } catch (err) {
      staged.abort();
      throw err;
    }
    staged.commit();
    require('../db/auditLog').log({ entityType: `fuel_${ownerKind}`, entityId: rootId, action: 'photo:add', after: { kind, sha256: photo.sha256 } });
    if (ownerKind === 'fill') {
      const f = records.getActiveFill(rootId);
      recompute([f.assetId], [f.locationId]);
    }
    emitFuelChange(ownerKind, 'update', rootId, companyId);
    return records.publicPhoto(photo);
  });

  /** A photo's bytes (or a 320 px thumbnail). Managers: any; recorders: asset photos and their own records'. */
  expose('fuel:getPhoto', async ({ photoId, thumb = false } = {}) => {
    const photo = records.getPhoto(photoId);
    if (!photo) throw new Error('Photo not found');
    activeCompanyId(photo.companyId);
    if (photo.ownerKind !== 'asset') assertOwnRecord(photo.ownerKind, photo.ownerId);
    if (photo.retired) {
      const err = new Error('This photo is past its keep-for period and is in Recently deleted');
      err.code = 'PHOTO_RETIRED';
      throw err;
    }
    const out = await fuelPhotos.readPhotoFile(photo.relPath, { thumb: thumb === true, expectedSha256: photo.sha256 });
    return { bytes: out.bytes, mime: out.mime, sha256: photo.sha256, intact: out.intact, kind: photo.kind, uploadedAt: photo.uploadedAt };
  });

  /* ─── lists ─── */
  expose('fuel:listFills', (filters = {}) => records.listFills(activeCompanyId(), filters || {}));
  expose('fuel:getFill', (id) => {
    const f = inCompany(records.getActiveFill(id), 'Fill');
    return {
      ...f,
      photos: records.listPhotos('fill', f.rootId).map(records.publicPhoto),
      revisions: records.listRevisions(f.rootId),
      flags: flagsDb.flagsForFill(f.rootId),
    };
  });
  expose('fuel:listDips', (filters = {}) => records.listDips(activeCompanyId(), filters || {}));
  expose('fuel:listDeliveries', (filters = {}) => records.listDeliveries(activeCompanyId(), filters || {}));
  expose('fuel:listTransfers', (filters = {}) => records.listTransfers(activeCompanyId(), filters || {}));
  /** Transfers sent to a farm store and not yet received — the farm phone's "arriving" list. */
  expose('fuel:listPendingTransfers', ({ locationId = null } = {}) => {
    const companyId = activeCompanyId();
    return records.listTransfers(companyId, { pendingOnly: true, locationId, limit: 100 }).items;
  });
  expose('fuel:listMyRecent', ({ days = 7 } = {}) => records.listMine(activeCompanyId(), getCallerUserId(), { days }));

  /* ─── review / correct / void ─── */
  expose('fuel:reviewFill', ({ id, ...review } = {}) => {
    const f = inCompany(records.getActiveFill(id), 'Fill');
    const next = records.reviewFill(id, review);
    recompute([f.assetId], []);
    emitFuelChange('fill', 'update', f.rootId, f.companyId);
    return { fill: next, flags: fillFlags(f.rootId) };
  });
  expose('fuel:correctFill', ({ id, patch, reason } = {}) => {
    const f = inCompany(records.getActiveFill(id), 'Fill');
    const next = records.correctFill(id, patch || {}, reason);
    recompute([f.assetId, next.assetId], [f.locationId, next.locationId]);
    emitFuelChange('fill', 'update', f.rootId, f.companyId);
    return { fill: next, flags: fillFlags(f.rootId) };
  });

  function afterVoid(res) {
    if (!res.already) {
      recompute([res.assetId], res.locationIds);
      emitFuelChange(res.kind, 'void', res.id, res.companyId);
    }
    return res;
  }
  function voidTargetCompany(kind, id) {
    const t = records.voidTarget(kind, id);
    if (!t) throw new Error('Record not found');
    activeCompanyId(t.row.company_id);
  }
  expose('fuel:voidRecord', ({ kind, id, reason } = {}) => {
    voidTargetCompany(kind, id);
    return afterVoid(records.voidRecord(kind, id, reason));
  });
  /** The recorder's own "I made a mistake": their record, still unreviewed, within 24 hours. */
  expose('fuel:voidMyRecord', ({ kind, id, reason } = {}) => {
    if (kind === 'meterReset') throw new Error('Meter resets are voided by a manager');
    voidTargetCompany(kind, id);
    return afterVoid(records.voidRecord(kind, id, reason, { ownOnly: true }));
  });

  /* ─── flags ─── */
  expose('fuel:listFlags', (filters = {}) => flagsDb.listFlags(activeCompanyId(), filters || {}));
  expose('fuel:reviewFlag', ({ id, status, note } = {}) => {
    const f = inCompany(flagsDb.getFlag(id), 'Flag');
    const next = flagsDb.reviewFlag(id, { status, note });
    emitFuelChange('flag', 'update', id, f.companyId);
    return next;
  });
  expose('fuel:recomputeFlags', () => flagsDb.recomputeAll({ companyId: activeCompanyId() }));
  expose('fuel:getOverview', () => {
    const companyId = activeCompanyId();
    const ov = flagsDb.overview(companyId);
    const month = monthOr(null);
    let excessRiel = null;
    try { excessRiel = reports.monthlyReport(companyId, month).totals.excessRiel; } catch (_) { /* report is optional on the tile */ }
    return { ...ov, month, excessRiel };
  });

  /* ─── reports ─── */
  expose('fuel:getMonthlyReport', ({ month } = {}) => reports.monthlyReport(activeCompanyId(), monthOr(month)));
  expose('fuel:getMonthlyWorkbook', ({ month } = {}) => reports.monthlyWorkbook(activeCompanyId(), monthOr(month)));
  expose('fuel:sweepPhotoRetention', () => fuelPhotos.sweepRetention({ companyId: activeCompanyId() }));

  /** Save the monthly workbook through a dialog on THIS Mac (client mode has its own copy). */
  exposeLocal('fuel:saveMonthlyWorkbook', async ({ month } = {}) => {
    const { dialog } = require('electron');
    const { filename, bytes } = reports.monthlyWorkbook(activeCompanyId(), monthOr(month));
    const res = await dialog.showSaveDialog({
      title: 'Save fuel workbook',
      defaultPath: filename,
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    require('node:fs').writeFileSync(res.filePath, bytes);
    return res.filePath;
  });
}

module.exports = { register };
