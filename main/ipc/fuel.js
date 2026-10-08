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
const { activeCompanyId, inCompany, emitFuelChange, callerCanManage, getCallerUserId, fuelWriteVersion } = require('./fuelAccess');
const { phnomPenhMonth, deliveryEffectiveAt } = require('../util/fuelAnomalies');

/** 'YYYY-MM' asked for, or this month in Phnom Penh time. */
function monthOr(month) { return month || phnomPenhMonth(Date.now()); }

/* ─── helpers ─────────────────────────────────────────────────── */

/**
 * Re-run the rules a change touched. `times` are the record's time(s) (old
 * and new for a correction): only that stretch of history is recomputed, so a
 * save stays fast however many years of records there are. Without `times`
 * the whole history of those assets/tanks is recomputed (configuration edits).
 */
function recompute(assetIds = [], locationIds = [], times = null) {
  const res = flagsDb.recomputeForRecord({ assetIds, locationIds, times });
  overviewCache.clear();
  return res;
}

function recomputeCompanyAssets(companyId) {
  const ids = fuel.listAssets(companyId, { status: 'all' }).map((a) => a.id);
  recompute(ids, []);
}

/**
 * A recorder (pump / driver phone) sees that a record raised a flag and why,
 * but not a manager's review note or the working figures behind it.
 */
function forCaller(flags) {
  if (callerCanManage()) return flags;
  return flags.map(({ details: _d, reviewNote: _n, reviewedByUserId: _u, reviewedAt: _a, ...rest }) => rest);
}

function fillFlags(rootId) {
  return forCaller(flagsDb.flagsForFill(rootId).filter((f) => !f.resolved));
}

/** When a delivery counts for its tank (inside its linked dips — see rules.deliveryEffectiveAt). */
function deliveryTime(d) {
  const dips = new Map();
  for (const id of [d.dipBeforeId, d.dipAfterId]) if (id) { const dip = records.getDip(id); if (dip) dips.set(id, dip); }
  return deliveryEffectiveAt(d, dips);
}

/**
 * Someone without fuel.manage records "now": the phone path. Their `at` is
 * ignored and the source is forced to phone, so the server clock (minus the
 * phone's capped offline wait, never before what the record must follow —
 * main/db/fuelRecords.js capQueuedTime) decides when it happened. Only a
 * manager entering a paper slip on the Mac may give the slip's own time.
 */
function scrubRecordInput(input) {
  if (callerCanManage()) return input;
  const { at: _at, ...rest } = input || {};
  return { ...rest, source: 'phone' };
}

/** A client_ref retry is answered only to whoever saved it (or a manager). */
function assertMayRepeat(record) {
  if (callerCanManage()) return;
  const uid = getCallerUserId();
  if (!uid || record.recordedByUserId !== uid) {
    const err = new Error('That record reference was already used by someone else. Start a new entry.');
    err.code = 'CLIENT_REF_CONFLICT';
    throw err;
  }
}

function previousForReview(f) {
  const { previousFill, previousMeterFill } = records.previousFills(f);
  const since = previousMeterFill ? previousMeterFill.at : null;
  const resetsSince = since == null ? [] : fuel.listResets({ assetId: f.assetId })
    .filter((r) => r.at > since && r.at <= f.at);
  return { previousFill, previousMeterFill, resetsSince };
}

/** Overview's "excess riel this month" costs a full monthly report: cached until the next fuel write. */
const overviewCache = new Map();

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
  if (prep.duplicate) {
    assertMayRepeat(prep.duplicate);
    return { record: prep.duplicate, duplicate: true };
  }
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
    assertMayRepeat(res.duplicate);
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
  expose('fuel:updateSettings', async (patch = {}) => {
    const companyId = activeCompanyId();
    const next = fuel.updateSettings(companyId, patch);
    await flagsDb.recomputeAllAsync({ companyId });
    overviewCache.clear();
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
    let next;
    try {
      // Photo row and the asset's pointer to it in one transaction; the file
      // takes its final name only after both are committed.
      require('../db/index').getDb().transaction(() => {
        records.insertPhotoRow({ ...staged.rows[0], companyId: asset.companyId, ownerKind: 'asset', ownerId: id });
        next = fuel.setAssetPhoto(id, staged.rows[0].id);
      })();
    } catch (err) {
      staged.abort();
      throw err;
    }
    staged.commit();
    // The photo replaced is kept (its row and file stay; it is simply no longer the tile).
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
    // The litres between the two dip levels = what arrived − what was drawn
    // between the dips. When the dips' litres were measured without a chart
    // (a gauge, typed) that is simply after − before; otherwise the invoice
    // minus the draws is the best figure there is (a short delivery skews it),
    // so the result is labelled an estimate.
    const deliveries = records.activeDeliveriesForLocation(locationId).filter((d) => d.dipBeforeId && d.dipAfterId);
    const fills = records.activeFillsForLocation(locationId);
    const transfers = records.activeTransfersForLocation(locationId);
    const drawn = (from, to) => fills.filter((f) => f.at > from && f.at <= to).reduce((t, f) => t + f.litres, 0)
      + transfers.filter((t) => t.fromLocationId === locationId && t.sentAt > from && t.sentAt <= to).reduce((t, x) => t + x.litresSent, 0);
    const observations = [];
    let fromInvoices = 0;
    for (const d of deliveries) {
      const b = records.getDip(d.dipBeforeId);
      const a = records.getDip(d.dipAfterId);
      if (!b || !a || b.voided || a.voided || b.dipCm == null || a.dipCm == null) continue;
      const measured = b.litresSource === 'typed' && a.litresSource === 'typed';
      const between = measured ? a.litres - b.litres : d.litresInvoiced - drawn(b.takenAt, a.takenAt);
      if (!measured) fromInvoices += 1;
      if (between > 0) observations.push({ dipBeforeCm: b.dipCm, dipAfterCm: a.dipCm, litresAdded: between });
    }
    const built = buildChartFromDeliveries(observations, { anchor: anchor || undefined, stepCm });
    return {
      ...built,
      estimate: true,
      basedOnInvoices: fromInvoices,
      note: fromInvoices
        ? `Estimate from ${observations.length} dipped deliveries (${fromInvoices} worked out from the invoice minus fuel drawn between the dips). Check it against a real dip before saving.`
        : `Estimate from ${observations.length} dipped deliveries. Check it against a real dip before saving.`,
    };
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
    recompute([r.assetId], [r.locationId], [r.at]);
    emitFuelChange('meterReset', 'create', r.id, companyId);
    return r;
  });

  /* ─── records (phone + Mac) ─── */
  expose('fuel:recordFill', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'fill', input: { ...scrubRecordInput(input), companyId },
      prepare: records.prepareFill, insert: records.insertFill, timeOf: (v) => v.at,
    });
    if (!duplicate) {
      recompute([record.assetId], [record.locationId], [record.at]);
      emitFuelChange('fill', 'create', record.rootId, companyId);
    }
    return { fill: records.getFill(record.id), duplicate, flags: fillFlags(record.rootId) };
  });

  expose('fuel:recordDip', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'dip', input: { ...scrubRecordInput(input), companyId },
      prepare: records.prepareDip, insert: records.insertDip, timeOf: (v) => v.takenAt,
    });
    if (!duplicate) {
      recompute([], [record.locationId], [record.takenAt]);
      emitFuelChange('dip', 'create', record.id, companyId);
    }
    // Only the flags about THIS dip (the reconciliation it closes), not the tank's whole list.
    return { dip: record, duplicate, flags: forCaller(flagsDb.flagsForDip(record.id)) };
  });

  expose('fuel:recordDelivery', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'delivery', input: { ...scrubRecordInput(input), companyId },
      prepare: records.prepareDelivery, insert: records.insertDelivery, timeOf: (v) => v.at,
    });
    if (!duplicate) {
      recompute([], [record.locationId], [deliveryTime(record)]);
      emitFuelChange('delivery', 'create', record.id, companyId);
    }
    return { delivery: record, duplicate };
  });

  expose('fuel:setDeliveryDips', ({ id, dipBeforeId, dipAfterId } = {}) => {
    const d = inCompany(records.getDelivery(id), 'Delivery');
    const next = records.setDeliveryDips(id, { dipBeforeId, dipAfterId });
    recompute([], [d.locationId], [deliveryTime(d), deliveryTime(next)]);
    emitFuelChange('delivery', 'update', id, d.companyId);
    return next;
  });

  expose('fuel:recordTransfer', async (input = {}) => {
    const companyId = activeCompanyId(input.companyId);
    const { record, duplicate } = await saveWithPhotos({
      ownerKind: 'transfer', input: { ...scrubRecordInput(input), companyId },
      prepare: records.prepareTransfer, insert: records.insertTransfer, timeOf: (v) => v.at,
    });
    if (!duplicate) {
      recompute([], [record.fromLocationId, record.toLocationId], [record.sentAt]);
      emitFuelChange('transfer', 'create', record.id, companyId);
    }
    return { transfer: record, duplicate };
  });

  expose('fuel:receiveTransfer', async ({ id, photos, ...rest } = {}) => {
    const t = inCompany(records.getTransfer(id), 'Transfer');
    const uploads = await fuelPhotos.prepareUploads('transfer', photos);
    // Photos are written to temporary names first; the receipt and their rows
    // go in one transaction; the files take their final names only after it.
    const staged = fuelPhotos.stagePhotos({ recordId: id, at: Date.now(), photos: uploads });
    let res;
    try {
      res = records.receiveTransfer(id, scrubRecordInput(rest), { forbidSelf: !callerCanManage(), photoRows: staged.rows });
    } catch (err) {
      staged.abort();
      throw err;
    }
    if (res.duplicate) staged.abort();
    else staged.commit();
    if (!res.duplicate) {
      recompute([], [t.fromLocationId, t.toLocationId], [t.sentAt, res.transfer.receivedAt]);
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
    const have = records.listPhotos(ownerKind, rootId, { includeRetired: false }).length;
    if (have >= fuelPhotos.MAX_PHOTOS_PER_RECORD_TOTAL) {
      throw new Error(`This record already has ${have} photos — the most one record can hold is ${fuelPhotos.MAX_PHOTOS_PER_RECORD_TOTAL}`);
    }
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
      recompute([f.assetId], [f.locationId], [f.at]);
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
      // The previous fill of this vehicle, and the previous meter reading
      // with any reset since, for the reviewer (fuel.manage only, like getFill).
      ...previousForReview(f),
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
    recompute([f.assetId], [], [f.at]);
    emitFuelChange('fill', 'update', f.rootId, f.companyId);
    return { fill: next, flags: fillFlags(f.rootId) };
  });
  expose('fuel:correctFill', ({ id, patch, reason } = {}) => {
    const f = inCompany(records.getActiveFill(id), 'Fill');
    const next = records.correctFill(id, patch || {}, reason);
    recompute([f.assetId, next.assetId], [f.locationId, next.locationId], [f.at, next.at]);
    emitFuelChange('fill', 'update', f.rootId, f.companyId);
    return { fill: next, flags: fillFlags(f.rootId) };
  });

  function afterVoid(res) {
    if (!res.already) {
      recompute([res.assetId], res.locationIds, res.times);
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
  expose('fuel:recomputeFlags', async () => {
    const res = await flagsDb.recomputeAllAsync({ companyId: activeCompanyId() });
    overviewCache.clear();
    return res;
  });
  expose('fuel:getOverview', () => {
    const companyId = activeCompanyId();
    const ov = flagsDb.overview(companyId);
    const month = monthOr(null);
    const key = `${companyId}|${month}|${fuelWriteVersion()}`;
    if (!overviewCache.has(key)) {
      let excessRiel = null;
      try { excessRiel = reports.monthlyReport(companyId, month).totals.excessRiel; } catch (_) { /* report is optional on the tile */ }
      overviewCache.clear();
      overviewCache.set(key, excessRiel);
    }
    return { ...ov, month, excessRiel: overviewCache.get(key) };
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
