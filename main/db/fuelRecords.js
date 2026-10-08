/**
 * Fuel F1: the day-to-day records — fills, dips, deliveries, transfers — and
 * the photo index (docs/PEOPLE_AND_FUEL_PLAN.md §3.6, §5.3).
 *
 * Rules that hold for every function here:
 *   - **Never DELETE.** A mistake is voided with a reason; a fill is corrected
 *     by a new revision (`supersedes_id`) that shares the original's root_id.
 *   - **`client_ref` makes uploads idempotent.** A phone that retries the same
 *     record gets the saved row back with `duplicate: true` — never a second row.
 *   - **Times come from the server clock** for phone records; a paper slip
 *     entered on the Mac may carry the slip's own time (never in the future).
 *   - **Litres from a pump flow meter win** over typed litres when the tank
 *     has one (owner decision §7a); the typed figure is kept and a
 *     disagreement becomes flag M1.
 *   - Every write is audited.
 */

const { getDb } = require('./index');
const { uuid, audit, str, num, int, badRequest, currency, getCallerUserId } = require('./_fuelUtil');
const fuel = require('./fuel');
const employees = require('./employees');
const { lookup } = require('../util/tankCalibration');
const { resolvePumpMeterLitres, phnomPenhDate, comparableAmount } = require('../util/fuelAnomalies');

const FILL_KINDS = ['warehouse_tank', 'farm_store', 'cash_station'];
const SOURCES = ['phone', 'mac', 'import'];
const REVIEW_STATUSES = ['new', 'checked', 'needs_review'];
const MAX_LITRES = 100000;
const FUTURE_SLACK_MS = 5 * 60 * 1000;

/** Photo kinds allowed per record type. */
const PHOTO_KINDS = {
  fill: ['meter', 'fill', 'pump_display', 'receipt', 'pump_meter_before', 'pump_meter_after', 'other'],
  dip: ['stick', 'other'],
  delivery: ['invoice', 'stick', 'truck', 'other'],
  transfer: ['containers', 'seals', 'pump_meter_before', 'pump_meter_after', 'received', 'other'],
  asset: ['asset'],
  price: ['notice'],
};

/* ─── shared ──────────────────────────────────────────────────── */

function sourceOf(v) {
  if (v == null) return 'mac';
  if (!SOURCES.includes(v)) throw badRequest('source must be phone, mac or import');
  return v;
}

/**
 * Phone records always use the server clock; Mac/import entries may carry the slip's time.
 *
 * A phone that was offline keeps the record and sends it later (webclient/fuel —
 * the `/f` page). It never sends a clock time — only `queuedForMs`, how long the
 * record waited on the phone, measured by the phone as a difference (so a phone
 * clock that is simply wrong does not matter). The time is then the server's
 * now minus that wait, capped at MAX_PHONE_QUEUE_MS; `recorded_at` still holds
 * the arrival time, so a reviewer can see the gap.
 */
const MAX_PHONE_QUEUE_MS = 48 * 60 * 60 * 1000;
function phoneQueueMs(v) {
  const n = num(v);
  if (n == null || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_PHONE_QUEUE_MS);
}
function recordTime(source, at, queuedForMs = null) {
  const now = Date.now();
  if (source === 'phone') return now - phoneQueueMs(queuedForMs);
  if (at == null) return now;
  const t = num(at);
  if (t == null || t <= 0) throw badRequest('at must be a time in milliseconds');
  if (t > now + FUTURE_SLACK_MS) throw badRequest('That time is in the future');
  return t;
}

function litresValue(v, label = 'Litres') {
  const n = num(v);
  if (n == null) return null;
  if (n <= 0 || n > MAX_LITRES) throw badRequest(`${label} must be more than 0 and less than ${MAX_LITRES.toLocaleString('en-US')}`);
  return n;
}

function readingValue(v, label) {
  const n = num(v);
  if (n == null) return null;
  if (n < 0) throw badRequest(`${label} cannot be negative`);
  return n;
}

/** The last millisecond of a 'YYYY-MM-DD' day in Phnom Penh (UTC+7). */
function endOfDayPP(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) - 7 * 3600e3 - 1;
}

function employeeIn(companyId, id, label, { allowLeft = false, at = null } = {}) {
  if (!id) return null;
  const row = employees.getRow(id);
  if (!row || row.company_id !== companyId) throw badRequest(`${label} is not on this company's staff list`);
  // Someone who has left cannot be put on a NEW record; corrections of old
  // records keep the people they already name, and a paper slip from before
  // (or on) the leaving day can still be entered.
  const workedThen = row.left_on && Number.isFinite(at) && at <= endOfDayPP(row.left_on);
  if (row.status === 'left' && !allowLeft && !workedThen) {
    throw badRequest(`${row.name_en || row.name_km || row.staff_code} has left and cannot be chosen — pick someone on the staff list`);
  }
  return id;
}

/**
 * A hash of what was sent with a client_ref. A retry of the same record hashes
 * the same; the same ref with different content is a conflict, not a retry.
 * Photos count by kind and size (the bytes are resent identically), and
 * `queuedForMs` is left out because it grows while a record waits to be resent.
 */
function payloadHash(input) {
  const skip = new Set(['queuedForMs', 'companyId', 'photos', 'clientRef']);
  const norm = (v) => {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(norm);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  };
  const clean = {};
  for (const k of Object.keys(input || {}).sort()) if (!skip.has(k) && input[k] !== undefined) clean[k] = norm(input[k]);
  clean.photos = (Array.isArray(input?.photos) ? input.photos : []).map((p) => {
    const b = p?.bytes;
    const size = b == null ? 0 : (b.byteLength ?? b.length ?? (typeof b.b64 === 'string' ? b.b64.length : 0));
    return `${p?.kind}:${size}`;
  });
  return require('node:crypto').createHash('sha256').update(JSON.stringify(clean)).digest('hex');
}

/** A saved row for this client_ref: same content → the duplicate; different → a plain conflict. */
function assertSameRetry(row, hash) {
  if (row && row.client_ref_hash && hash && row.client_ref_hash !== hash) {
    const err = new Error('That record reference was already used for a different entry. Start a new entry instead of resending this one.');
    err.code = 'CLIENT_REF_CONFLICT';
    throw err;
  }
}

/**
 * A phone record that waited in the phone's offline queue is placed at
 * "server now − queuedForMs" — but never before what it must follow: the
 * tank's latest dip, the vehicle's latest fill, or this account's own previous
 * record. So a long (or tampered) wait cannot slip a record in behind evidence
 * already saved. Returns the time to store.
 */
function capQueuedTime(at, { source, queuedForMs, companyId, locationIds = [], assetId = null }) {
  if (source !== 'phone' || !(num(queuedForMs) > 0)) return at;
  const db = getDb();
  let floor = 0;
  const bump = (v) => { if (Number.isFinite(v) && v > floor) floor = v; };
  for (const loc of locationIds.filter(Boolean)) {
    bump(db.prepare('SELECT MAX(taken_at) AS t FROM fuel_dips WHERE location_id = ? AND voided_at IS NULL').get(loc).t);
  }
  if (assetId) bump(db.prepare('SELECT MAX(at) AS t FROM fuel_fills WHERE asset_id = ? AND voided_at IS NULL AND superseded_at IS NULL').get(assetId).t);
  const uid = getCallerUserId();
  if (uid) {
    for (const [table, col] of [['fuel_fills', 'at'], ['fuel_dips', 'taken_at'], ['fuel_deliveries', 'delivered_at'], ['fuel_transfers', 'sent_at']]) {
      bump(db.prepare(`SELECT MAX(${col}) AS t FROM ${table} WHERE company_id = ? AND recorded_by_user_id = ? AND voided_at IS NULL`).get(companyId, uid).t);
    }
  }
  return Math.min(Date.now(), Math.max(at, floor + 1));
}

/**
 * How long the phone says the record waited in its offline queue (capped at
 * MAX_PHONE_QUEUE_MS), or null. Stored as reported; the record's `at` may be
 * later than "arrival − wait" when capQueuedTime moved it after the records it
 * must follow — rule Q1 tells the reviewer both.
 */
function queuedMs(source, queuedForMs) {
  const n = source === 'phone' ? phoneQueueMs(queuedForMs) : 0;
  return n > 0 ? n : null;
}

function callerEmployee(companyId) {
  const uid = getCallerUserId();
  return uid ? employees.getByUserId(companyId, uid) : null;
}

function isUniqueClientRef(err) {
  return err && /UNIQUE constraint failed: fuel_\w+\.client_ref/.test(String(err.message));
}

function clientRefValue(v) {
  const s = str(v, 100);
  if (s && !/^[A-Za-z0-9_.:-]{6,100}$/.test(s)) throw badRequest('clientRef must be 6–100 letters, digits or - _ . :');
  return s;
}

/* ─── photo index ─────────────────────────────────────────────── */

function rowToPhoto(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, ownerKind: r.owner_kind, ownerId: r.owner_id, kind: r.kind,
    relPath: r.rel_path, sha256: r.sha256, originalSha256: r.original_sha256 ?? null, bytes: r.bytes ?? null,
    width: r.width ?? null, height: r.height ?? null, uploadedAt: r.uploaded_at, uploadedByUserId: r.uploaded_by_user_id ?? null,
    retired: !!r.retired_at, retiredAt: r.retired_at ?? null, retiredReason: r.retired_reason ?? null,
  };
}

/** Public shape — no file path leaves the server. */
function publicPhoto(p) {
  if (!p) return null;
  const { relPath: _rel, ...rest } = p;
  return rest;
}

function insertPhotoRow(p) {
  getDb().prepare(`
    INSERT INTO fuel_photos (id, company_id, owner_kind, owner_id, kind, rel_path, sha256, original_sha256, bytes, width, height, uploaded_at, uploaded_by_user_id)
    VALUES (@id, @companyId, @ownerKind, @ownerId, @kind, @relPath, @sha256, @originalSha256, @bytes, @width, @height, @uploadedAt, @uploadedByUserId)
  `).run({
    originalSha256: null, bytes: null, width: null, height: null, uploadedAt: Date.now(), uploadedByUserId: getCallerUserId(), ...p,
  });
  return getPhoto(p.id);
}

function getPhoto(id) {
  return rowToPhoto(getDb().prepare('SELECT * FROM fuel_photos WHERE id = ?').get(id));
}

function listPhotos(ownerKind, ownerIds, { includeRetired = true } = {}) {
  const ids = Array.isArray(ownerIds) ? ownerIds : [ownerIds];
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...getDb().prepare(`
      SELECT * FROM fuel_photos WHERE owner_kind = ? AND owner_id IN (${chunk.map(() => '?').join(',')})
      ${includeRetired ? '' : 'AND retired_at IS NULL'} ORDER BY uploaded_at
    `).all(ownerKind, ...chunk).map(rowToPhoto));
  }
  return out;
}

/** The record a photo belongs to, for permission checks: { recordedByUserId, companyId } or null. */
function photoOwnerRecord(photo) {
  const db = getDb();
  if (photo.ownerKind === 'fill') return db.prepare('SELECT recorded_by_user_id AS u FROM fuel_fills WHERE root_id = ? ORDER BY created_at LIMIT 1').get(photo.ownerId) || null;
  if (photo.ownerKind === 'dip') return db.prepare('SELECT recorded_by_user_id AS u FROM fuel_dips WHERE id = ?').get(photo.ownerId) || null;
  if (photo.ownerKind === 'delivery') return db.prepare('SELECT recorded_by_user_id AS u FROM fuel_deliveries WHERE id = ?').get(photo.ownerId) || null;
  if (photo.ownerKind === 'transfer') return db.prepare('SELECT recorded_by_user_id AS u, received_recorded_by_user_id AS r FROM fuel_transfers WHERE id = ?').get(photo.ownerId) || null;
  return null;
}

/* ─── fills ───────────────────────────────────────────────────── */

function rowToFill(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, rootId: r.root_id, supersedesId: r.supersedes_id ?? null,
    superseded: !!r.superseded_at, supersededAt: r.superseded_at ?? null, supersededById: r.superseded_by_id ?? null,
    correctionReason: r.correction_reason ?? null,
    kind: r.kind, locationId: r.location_id ?? null, stationId: r.station_id ?? null, assetId: r.asset_id,
    driverEmployeeId: r.driver_employee_id ?? null, attendantEmployeeId: r.attendant_employee_id ?? null,
    at: r.at, workDate: r.work_date, litres: r.litres, litresSource: r.litres_source, typedLitres: r.typed_litres ?? null,
    cansCount: r.cans_count ?? null, canSizeL: r.can_size_l ?? null,
    pumpMeterBefore: r.pump_meter_before ?? null, pumpMeterAfter: r.pump_meter_after ?? null,
    meterReading: r.meter_reading ?? null, fullTank: !!r.full_tank, fuelType: r.fuel_type ?? null,
    amountPaidMinor: r.amount_paid_minor ?? null, currency: r.currency ?? null, litresShownOnPump: r.litres_shown_on_pump ?? null,
    source: r.source, clientRef: r.client_ref ?? null, recordedByUserId: r.recorded_by_user_id ?? null, recordedAt: r.recorded_at,
    reviewStatus: r.review_status, reviewedByUserId: r.reviewed_by_user_id ?? null, reviewedAt: r.reviewed_at ?? null,
    reviewNote: r.review_note ?? null, reviewedAmountMinor: r.reviewed_amount_minor ?? null, reviewedLitres: r.reviewed_litres ?? null,
    note: r.note ?? null, voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null,
    voidedByUserId: r.voided_by_user_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    queuedForMs: r.queued_for_ms ?? null,
  };
}

function getFillRow(id) {
  return getDb().prepare('SELECT * FROM fuel_fills WHERE id = ?').get(id);
}

function getFill(id) {
  return rowToFill(getFillRow(id));
}

/** The current revision of a fill (by any revision's id or its root id). */
function getActiveFill(idOrRoot) {
  const r = getFillRow(idOrRoot);
  const root = r ? r.root_id : idOrRoot;
  return rowToFill(getDb().prepare('SELECT * FROM fuel_fills WHERE root_id = ? AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1').get(root));
}

function listRevisions(rootId) {
  return getDb().prepare('SELECT * FROM fuel_fills WHERE root_id = ? ORDER BY created_at').all(rootId).map(rowToFill);
}

/**
 * Turn a fill input (new, or an existing fill + correction patch) into the
 * values to store. Throws a plain-English error for anything missing.
 */
function normalizeFill(companyId, input, { settings, existing = null, recordAt = null } = {}) {
  const kind = input.kind;
  if (!FILL_KINDS.includes(kind)) throw badRequest('kind must be warehouse_tank, farm_store or cash_station');
  const asset = fuel.getAsset(input.assetId);
  if (!asset || asset.companyId !== companyId) throw badRequest('Pick the vehicle or machine that was filled');
  if (!existing && asset.status !== 'active' && input.source === 'phone') throw badRequest('That vehicle or machine is retired');

  let location = null;
  let stationId = null;
  if (kind === 'cash_station') {
    if (input.stationId) {
      const st = fuel.getStation(input.stationId);
      if (!st || st.companyId !== companyId) throw badRequest('Pick the station');
      stationId = st.id;
    } else if (str(input.stationName)) {
      stationId = fuel.findOrCreateStation(companyId, input.stationName).id;
    } else {
      throw badRequest('Which station? Pick one or type its name');
    }
  } else {
    location = fuel.getLocation(input.locationId);
    if (!location || location.companyId !== companyId) throw badRequest('Pick the tank or farm store the fuel came from');
    const wanted = kind === 'warehouse_tank' ? 'tank' : 'farm_store';
    if (location.kind !== wanted) throw badRequest(kind === 'warehouse_tank' ? 'That is a farm store, not a tank' : 'That is a tank, not a farm store');
  }

  const typed = litresValue(input.litres);
  const cansCount = int(input.cansCount);
  if (cansCount != null && (cansCount <= 0 || cansCount > 1000)) throw badRequest('Number of cans must be from 1 to 1000');
  const canSizeL = cansCount != null ? (litresValue(input.canSizeL, 'Can size') ?? settings.canSizeL) : null;
  const pumpBefore = readingValue(input.pumpMeterBefore, 'Pump meter before');
  const pumpAfter = readingValue(input.pumpMeterAfter, 'Pump meter after');
  if ((pumpBefore == null) !== (pumpAfter == null)) throw badRequest('Enter both pump meter readings (before and after), or neither');
  if (pumpBefore != null && kind === 'cash_station') throw badRequest('Pump meter readings are for your own tank, not a public station');

  let amountPaidMinor = null;
  let cur = null;
  let shownOnPump = null;
  if (kind === 'cash_station') {
    amountPaidMinor = int(input.amountPaidMinor);
    if (amountPaidMinor == null || amountPaidMinor <= 0) throw badRequest('Enter the amount paid');
    cur = currency(input.currency, settings.defaultCurrency);
    shownOnPump = litresValue(input.litresShownOnPump, 'Litres shown on the pump');
  }

  let litres;
  let litresSource = 'typed';
  let typedLitres = typed;
  if (pumpBefore != null) {
    const typedOrCans = typed ?? (cansCount != null ? cansCount * canSizeL : null);
    const m = resolvePumpMeterLitres({ before: pumpBefore, after: pumpAfter, typed: typedOrCans }, settings);
    if (m.backwards) {
      if (typedOrCans == null) throw badRequest('The pump meter "after" reading is lower than "before" — check the readings');
      litres = typedOrCans;
      litresSource = cansCount != null && typed == null ? 'cans' : 'typed';
    } else {
      if (!(m.litres > 0)) throw badRequest('The pump meter readings show no fuel dispensed');
      litres = m.litres;
      litresSource = 'pump_meter';
    }
    typedLitres = typedOrCans;
  } else if (typed != null) {
    litres = typed;
  } else if (cansCount != null) {
    litres = cansCount * canSizeL;
    litresSource = 'cans';
  } else if (shownOnPump != null) {
    litres = shownOnPump;
    litresSource = 'pump_display';
  } else if (kind === 'cash_station') {
    // The price of the day the record is placed at (a queued phone record's computed time).
    // A payment in the other currency is converted at the server's exchange
    // rate, the same way the cash rules compare it (comparableAmount).
    const price = fuel.priceOn(companyId, asset.fuelType, recordAt ?? input.at ?? Date.now());
    const amount = price ? comparableAmount({ amountPaidMinor, currency: cur }, price.currency, fuel.fxKhrPerUsd()) : null;
    if (!price || !Number.isFinite(amount)) throw badRequest('Enter the litres shown on the pump (there is no published price for that day to work it out)');
    litres = Math.round((amount / price.priceMinorPerL) * 1000) / 1000;
    litresSource = 'derived_from_price';
  } else {
    throw badRequest('Enter the litres');
  }
  litres = litresValue(litres);

  const meterReading = readingValue(input.meterReading, 'Meter reading');
  return {
    kind,
    locationId: location?.id ?? null,
    stationId,
    assetId: asset.id,
    driverEmployeeId: employeeIn(companyId, input.driverEmployeeId, 'The driver', { allowLeft: !!existing && input.driverEmployeeId === existing.driverEmployeeId, at: recordAt }),
    attendantEmployeeId: employeeIn(companyId, input.attendantEmployeeId, 'The attendant', { allowLeft: !!existing && input.attendantEmployeeId === existing.attendantEmployeeId, at: recordAt }),
    litres,
    litresSource,
    typedLitres,
    cansCount,
    canSizeL,
    pumpMeterBefore: pumpBefore,
    pumpMeterAfter: pumpAfter,
    meterReading,
    fullTank: input.fullTank ? 1 : 0,
    fuelType: asset.fuelType,
    amountPaidMinor,
    currency: cur,
    litresShownOnPump: shownOnPump,
    note: str(input.note, 1000),
  };
}

const FILL_INSERT = `
  INSERT INTO fuel_fills (id, company_id, root_id, supersedes_id, correction_reason, kind, location_id, station_id, asset_id,
    driver_employee_id, attendant_employee_id, at, work_date, litres, litres_source, typed_litres, cans_count, can_size_l,
    pump_meter_before, pump_meter_after, meter_reading, full_tank, fuel_type, amount_paid_minor, currency, litres_shown_on_pump,
    source, client_ref, recorded_by_user_id, recorded_at, review_status, reviewed_by_user_id, reviewed_at, review_note,
    reviewed_amount_minor, reviewed_litres, note, queued_for_ms, client_ref_hash, created_at, updated_at)
  VALUES (@id, @companyId, @rootId, @supersedesId, @correctionReason, @kind, @locationId, @stationId, @assetId,
    @driverEmployeeId, @attendantEmployeeId, @at, @workDate, @litres, @litresSource, @typedLitres, @cansCount, @canSizeL,
    @pumpMeterBefore, @pumpMeterAfter, @meterReading, @fullTank, @fuelType, @amountPaidMinor, @currency, @litresShownOnPump,
    @source, @clientRef, @recordedByUserId, @recordedAt, @reviewStatus, @reviewedByUserId, @reviewedAt, @reviewNote,
    @reviewedAmountMinor, @reviewedLitres, @note, @queuedForMs, @clientRefHash, @now, @now)
`;

/** Look up an already-saved record by client_ref (idempotent retries). */
function findByClientRef(table, companyId, clientRef) {
  if (!clientRef) return null;
  const row = getDb().prepare(`SELECT * FROM ${table} WHERE client_ref = ?`).get(clientRef);
  if (row && row.company_id !== companyId) throw badRequest('That record reference belongs to another company');
  return row || null;
}

/**
 * Prepare a new fill (validation only — nothing written). Returns
 * `{ duplicate: existingFill }` when the client_ref was already saved,
 * otherwise `{ values }` ready for insertFill(). Split in two so the IPC layer
 * can process photos between the check and the insert.
 */
function prepareFill(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const clientRef = clientRefValue(input.clientRef);
  const hash = clientRef ? payloadHash(input) : null;
  const dup = findByClientRef('fuel_fills', companyId, clientRef);
  if (dup) {
    assertSameRetry(dup, hash);
    return { duplicate: getActiveFill(dup.root_id) || rowToFill(dup) };
  }
  const source = sourceOf(input.source);
  const at = capQueuedTime(recordTime(source, input.at, input.queuedForMs), {
    source, queuedForMs: input.queuedForMs, companyId, locationIds: [input.locationId], assetId: input.assetId,
  });
  const settings = fuel.getSettings(companyId);
  const values = normalizeFill(companyId, { ...input, source, at }, { settings, recordAt: at });
  const me = callerEmployee(companyId);
  if (!values.driverEmployeeId && me?.isDriver && values.kind === 'cash_station') values.driverEmployeeId = me.id;
  if (!values.attendantEmployeeId && me?.isFuelAttendant && values.kind !== 'cash_station') values.attendantEmployeeId = me.id;
  const id = uuid();
  return {
    values: {
      ...values, id, companyId, rootId: id, supersedesId: null, correctionReason: null, at, workDate: phnomPenhDate(at),
      source, clientRef, recordedByUserId: getCallerUserId(), recordedAt: Date.now(), reviewStatus: 'new',
      reviewedByUserId: null, reviewedAt: null, reviewNote: null, reviewedAmountMinor: null, reviewedLitres: null, now: Date.now(),
      queuedForMs: queuedMs(source, input.queuedForMs), clientRefHash: hash,
    },
  };
}

/**
 * Insert a prepared fill plus its photo rows in one transaction. On a
 * concurrent duplicate client_ref, returns `{ duplicate }` instead.
 */
function insertFill(values, photoRows = []) {
  const db = getDb();
  try {
    db.transaction(() => {
      db.prepare(FILL_INSERT).run(values);
      for (const p of photoRows) insertPhotoRow({ ...p, companyId: values.companyId, ownerKind: 'fill', ownerId: values.rootId });
    })();
  } catch (err) {
    if (isUniqueClientRef(err)) {
      const dup = findByClientRef('fuel_fills', values.companyId, values.clientRef);
      return { duplicate: getActiveFill(dup.root_id) };
    }
    throw err;
  }
  const fill = getFill(values.id);
  audit('fuel_fill', values.rootId, 'create', { after: { ...fill, photos: photoRows.map((p) => ({ kind: p.kind, sha256: p.sha256 })) } });
  return { fill };
}

/** Convenience for callers with no photos (Mac paper slips, tests). */
function createFill(input = {}) {
  const prep = prepareFill(input);
  if (prep.duplicate) return { fill: prep.duplicate, duplicate: true };
  const res = insertFill(prep.values);
  return res.duplicate ? { fill: res.duplicate, duplicate: true } : { fill: res.fill, duplicate: false };
}

/**
 * A correction is a new revision: the current one is marked superseded, the
 * new row carries `supersedes_id` and the reason. Photos follow (they hang off
 * the root id). The reviewer making a correction has checked it.
 */
function correctFill(id, patch = {}, reason) {
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required for a correction');
  const current = getActiveFill(id);
  if (!current) throw badRequest('Fill not found');
  if (current.voided) throw badRequest('That fill is void; record a new one instead');
  const settings = fuel.getSettings(current.companyId);
  // `litres` on input means "what was typed"; the stored litres may have come
  // from the pump meter, the cans or the price, so re-derive from the inputs.
  const merged = { ...current, ...patch };
  if (!('litres' in patch)) merged.litres = current.typedLitres;
  const at = 'at' in patch ? recordTime('mac', patch.at) : current.at;
  const values = normalizeFill(current.companyId, { ...merged, at, source: current.source }, { settings, existing: current, recordAt: at });
  const newId = uuid();
  const now = Date.now();
  const by = getCallerUserId();
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE fuel_fills SET superseded_at = ?, superseded_by_id = ?, updated_at = ? WHERE id = ?').run(now, newId, now, current.id);
    db.prepare(FILL_INSERT).run({
      ...values, id: newId, companyId: current.companyId, rootId: current.rootId, supersedesId: current.id, correctionReason: why,
      at, workDate: phnomPenhDate(at), source: current.source, clientRef: null, recordedByUserId: current.recordedByUserId,
      recordedAt: current.recordedAt, reviewStatus: 'checked', reviewedByUserId: by, reviewedAt: now,
      reviewNote: str(patch.reviewNote, 1000) ?? current.reviewNote, reviewedAmountMinor: current.reviewedAmountMinor,
      reviewedLitres: current.reviewedLitres, now, queuedForMs: current.queuedForMs, clientRefHash: null,
    });
  })();
  const next = getFill(newId);
  const diff = require('./auditLog').diffPatch(current, values);
  audit('fuel_fill', current.rootId, 'correct', { before: { revision: current.id, ...(diff?.before || {}) }, after: { revision: newId, reason: why, ...(diff?.after || {}) } });
  return next;
}

/**
 * Review a fill: Checked / Needs review, with the reviewer's own reading of
 * the pump-display photo (feeds rule C5).
 */
function reviewFill(id, { status, note = null, reviewedAmountMinor, reviewedLitres } = {}) {
  if (!REVIEW_STATUSES.includes(status) || status === 'new') throw badRequest('status must be checked or needs_review');
  const current = getActiveFill(id);
  if (!current) throw badRequest('Fill not found');
  if (current.voided) throw badRequest('That fill is void');
  const amt = reviewedAmountMinor === undefined ? current.reviewedAmountMinor : int(reviewedAmountMinor);
  const lit = reviewedLitres === undefined ? current.reviewedLitres : num(reviewedLitres);
  getDb().prepare(`UPDATE fuel_fills SET review_status = ?, review_note = ?, reviewed_by_user_id = ?, reviewed_at = ?,
    reviewed_amount_minor = ?, reviewed_litres = ?, updated_at = ? WHERE id = ?`)
    .run(status, str(note, 1000), getCallerUserId(), Date.now(), amt, lit, Date.now(), current.id);
  audit('fuel_fill', current.rootId, 'review', {
    before: { reviewStatus: current.reviewStatus, reviewedAmountMinor: current.reviewedAmountMinor, reviewedLitres: current.reviewedLitres },
    after: { reviewStatus: status, note: str(note, 1000), reviewedAmountMinor: amt, reviewedLitres: lit },
  });
  return getFill(current.id);
}

/* ─── dips ────────────────────────────────────────────────────── */

function rowToDip(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, locationId: r.location_id, takenAt: r.taken_at, workDate: r.work_date,
    dipCm: r.dip_cm ?? null, litres: r.litres, litresSource: r.litres_source, outOfChart: !!r.out_of_chart,
    takenByEmployeeId: r.taken_by_employee_id ?? null, witnessEmployeeId: r.witness_employee_id ?? null,
    recordedByUserId: r.recorded_by_user_id ?? null, source: r.source, clientRef: r.client_ref ?? null, note: r.note ?? null,
    createdAt: r.created_at, voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null,
    queuedForMs: r.queued_for_ms ?? null,
  };
}

function getDip(id) { return rowToDip(getDb().prepare('SELECT * FROM fuel_dips WHERE id = ?').get(id)); }

function prepareDip(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const clientRef = clientRefValue(input.clientRef);
  const hash = clientRef ? payloadHash(input) : null;
  const dup = findByClientRef('fuel_dips', companyId, clientRef);
  if (dup) {
    assertSameRetry(dup, hash);
    return { duplicate: rowToDip(dup) };
  }
  const loc = fuel.getLocation(input.locationId);
  if (!loc || loc.companyId !== companyId) throw badRequest('Pick the tank that was dipped');
  const source = sourceOf(input.source);
  const takenAt = capQueuedTime(recordTime(source, input.at, input.queuedForMs), {
    source, queuedForMs: input.queuedForMs, companyId, locationIds: [loc.id],
  });
  const chart = fuel.getChart(loc.id);
  const dipCm = readingValue(input.dipCm, 'Dip');
  let litres;
  let litresSource;
  let outOfChart = 0;
  if (chart.length >= 2) {
    if (dipCm == null) throw badRequest('Enter the dip in cm');
    const r = lookup(chart, dipCm);
    litres = r.litres;
    litresSource = 'chart';
    outOfChart = r.outOfRange ? 1 : 0;
  } else {
    litres = num(input.litres);
    if (litres == null || litres < 0) throw badRequest('This tank has no dip chart yet — enter the litres');
    litresSource = 'typed';
  }
  const me = callerEmployee(companyId);
  const id = uuid();
  return {
    values: {
      id, companyId, locationId: loc.id, takenAt, workDate: phnomPenhDate(takenAt), dipCm, litres, litresSource, outOfChart,
      takenBy: employeeIn(companyId, input.takenByEmployeeId, 'The person dipping', { at: takenAt }) ?? (me?.id ?? null),
      witness: employeeIn(companyId, input.witnessEmployeeId, 'The witness', { at: takenAt }),
      by: getCallerUserId(), source, clientRef, note: str(input.note, 1000), now: Date.now(),
      queuedForMs: queuedMs(source, input.queuedForMs), clientRefHash: hash,
    },
  };
}

function insertDip(values, photoRows = []) {
  const db = getDb();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO fuel_dips (id, company_id, location_id, taken_at, work_date, dip_cm, litres, litres_source, out_of_chart,
          taken_by_employee_id, witness_employee_id, recorded_by_user_id, source, client_ref, note, queued_for_ms, client_ref_hash, created_at)
        VALUES (@id, @companyId, @locationId, @takenAt, @workDate, @dipCm, @litres, @litresSource, @outOfChart,
          @takenBy, @witness, @by, @source, @clientRef, @note, @queuedForMs, @clientRefHash, @now)
      `).run(values);
      for (const p of photoRows) insertPhotoRow({ ...p, companyId: values.companyId, ownerKind: 'dip', ownerId: values.id });
    })();
  } catch (err) {
    if (isUniqueClientRef(err)) return { duplicate: rowToDip(findByClientRef('fuel_dips', values.companyId, values.clientRef)) };
    throw err;
  }
  const dip = getDip(values.id);
  audit('fuel_dip', dip.id, 'create', { after: dip });
  return { dip };
}

function createDip(input = {}) {
  const prep = prepareDip(input);
  if (prep.duplicate) return { dip: prep.duplicate, duplicate: true };
  const res = insertDip(prep.values);
  return res.duplicate ? { dip: res.duplicate, duplicate: true } : { dip: res.dip, duplicate: false };
}

/* ─── deliveries ──────────────────────────────────────────────── */

function rowToDelivery(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, locationId: r.location_id, supplier: r.supplier ?? null, invoiceNo: r.invoice_no ?? null,
    deliveredAt: r.delivered_at, workDate: r.work_date, litresInvoiced: r.litres_invoiced,
    priceMinorPerL: r.price_minor_per_l ?? null, amountMinor: r.amount_minor ?? null, currency: r.currency,
    dipBeforeId: r.dip_before_id ?? null, dipAfterId: r.dip_after_id ?? null,
    receivedByEmployeeId: r.received_by_employee_id ?? null, recordedByUserId: r.recorded_by_user_id ?? null,
    source: r.source, clientRef: r.client_ref ?? null, note: r.note ?? null, createdAt: r.created_at,
    voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null,
    queuedForMs: r.queued_for_ms ?? null,
  };
}

function getDelivery(id) { return rowToDelivery(getDb().prepare('SELECT * FROM fuel_deliveries WHERE id = ?').get(id)); }

function checkDeliveryDips(locationId, beforeId, afterId) {
  const before = beforeId ? getDip(beforeId) : null;
  const after = afterId ? getDip(afterId) : null;
  if (beforeId && (!before || before.locationId !== locationId || before.voided)) throw badRequest('The "before" dip is not a dip of this tank');
  if (afterId && (!after || after.locationId !== locationId || after.voided)) throw badRequest('The "after" dip is not a dip of this tank');
  if (before && after && after.takenAt <= before.takenAt) throw badRequest('The "after" dip must be later than the "before" dip');
  return { before: before?.id ?? null, after: after?.id ?? null };
}

function prepareDelivery(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const clientRef = clientRefValue(input.clientRef);
  const hash = clientRef ? payloadHash(input) : null;
  const dup = findByClientRef('fuel_deliveries', companyId, clientRef);
  if (dup) {
    assertSameRetry(dup, hash);
    return { duplicate: rowToDelivery(dup) };
  }
  const loc = fuel.getLocation(input.locationId);
  if (!loc || loc.companyId !== companyId) throw badRequest('Pick the tank the delivery went into');
  const litresInvoiced = litresValue(input.litresInvoiced, 'Invoiced litres');
  if (litresInvoiced == null) throw badRequest('Enter the litres on the invoice');
  const price = int(input.priceMinorPerL);
  if (price != null && price <= 0) throw badRequest('Price per litre must be more than 0');
  const amount = int(input.amountMinor);
  if (amount != null && amount < 0) throw badRequest('Amount cannot be negative');
  const source = sourceOf(input.source);
  const at = capQueuedTime(recordTime(source, input.at, input.queuedForMs), {
    source, queuedForMs: input.queuedForMs, companyId, locationIds: input.dipAfterId ? [] : [loc.id],
  });
  const dips = checkDeliveryDips(loc.id, input.dipBeforeId, input.dipAfterId);
  const me = callerEmployee(companyId);
  return {
    values: {
      id: uuid(), companyId, locationId: loc.id, supplier: str(input.supplier, 120), invoiceNo: str(input.invoiceNo, 60),
      at, workDate: phnomPenhDate(at), litresInvoiced, price, amount, currency: currency(input.currency),
      dipBefore: dips.before, dipAfter: dips.after,
      receivedBy: employeeIn(companyId, input.receivedByEmployeeId, 'The person receiving', { at }) ?? (me?.id ?? null),
      by: getCallerUserId(), source, clientRef, note: str(input.note, 1000), now: Date.now(),
      queuedForMs: queuedMs(source, input.queuedForMs), clientRefHash: hash,
    },
  };
}

function insertDelivery(values, photoRows = []) {
  const db = getDb();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO fuel_deliveries (id, company_id, location_id, supplier, invoice_no, delivered_at, work_date, litres_invoiced,
          price_minor_per_l, amount_minor, currency, dip_before_id, dip_after_id, received_by_employee_id, recorded_by_user_id,
          source, client_ref, note, queued_for_ms, client_ref_hash, created_at)
        VALUES (@id, @companyId, @locationId, @supplier, @invoiceNo, @at, @workDate, @litresInvoiced,
          @price, @amount, @currency, @dipBefore, @dipAfter, @receivedBy, @by, @source, @clientRef, @note, @queuedForMs, @clientRefHash, @now)
      `).run(values);
      for (const p of photoRows) insertPhotoRow({ ...p, companyId: values.companyId, ownerKind: 'delivery', ownerId: values.id });
    })();
  } catch (err) {
    if (isUniqueClientRef(err)) return { duplicate: rowToDelivery(findByClientRef('fuel_deliveries', values.companyId, values.clientRef)) };
    throw err;
  }
  const delivery = getDelivery(values.id);
  audit('fuel_delivery', delivery.id, 'create', { after: delivery });
  return { delivery };
}

function createDelivery(input = {}) {
  const prep = prepareDelivery(input);
  if (prep.duplicate) return { delivery: prep.duplicate, duplicate: true };
  const res = insertDelivery(prep.values);
  return res.duplicate ? { delivery: res.duplicate, duplicate: true } : { delivery: res.delivery, duplicate: false };
}

/**
 * Link the dips taken before/after a delivery. A field that is not passed
 * keeps its current link; pass null to clear one.
 */
function setDeliveryDips(id, { dipBeforeId, dipAfterId } = {}) {
  const d = getDelivery(id);
  if (!d) throw badRequest('Delivery not found');
  if (d.voided) throw badRequest('That delivery is void');
  const before = dipBeforeId === undefined ? d.dipBeforeId : dipBeforeId;
  const after = dipAfterId === undefined ? d.dipAfterId : dipAfterId;
  const dips = checkDeliveryDips(d.locationId, before, after);
  getDb().prepare('UPDATE fuel_deliveries SET dip_before_id = ?, dip_after_id = ? WHERE id = ?').run(dips.before, dips.after, id);
  audit('fuel_delivery', id, 'link-dips', { before: { dipBeforeId: d.dipBeforeId, dipAfterId: d.dipAfterId }, after: { dipBeforeId: dips.before, dipAfterId: dips.after } });
  return getDelivery(id);
}

/* ─── transfers (tank → farm store) ───────────────────────────── */

function rowToTransfer(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, fromLocationId: r.from_location_id, toLocationId: r.to_location_id ?? null,
    litresSent: r.litres_sent, typedLitres: r.typed_litres ?? null, containers: r.containers ?? null, containerNote: r.container_note ?? null,
    pumpMeterBefore: r.pump_meter_before ?? null, pumpMeterAfter: r.pump_meter_after ?? null,
    sentAt: r.sent_at, workDate: r.work_date, sentByEmployeeId: r.sent_by_employee_id ?? null,
    litresReceived: r.litres_received ?? null, receivedAt: r.received_at ?? null, receivedByEmployeeId: r.received_by_employee_id ?? null,
    receivedNote: r.received_note ?? null, received: r.litres_received != null,
    carriedByEmployeeId: r.carried_by_employee_id ?? null,
    recordedByUserId: r.recorded_by_user_id ?? null, receivedRecordedByUserId: r.received_recorded_by_user_id ?? null,
    source: r.source, clientRef: r.client_ref ?? null, note: r.note ?? null, createdAt: r.created_at,
    voided: !!r.voided_at, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null,
    queuedForMs: r.queued_for_ms ?? null,
  };
}

function getTransfer(id) { return rowToTransfer(getDb().prepare('SELECT * FROM fuel_transfers WHERE id = ?').get(id)); }

function prepareTransfer(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const clientRef = clientRefValue(input.clientRef);
  const hash = clientRef ? payloadHash(input) : null;
  const dup = findByClientRef('fuel_transfers', companyId, clientRef);
  if (dup) {
    assertSameRetry(dup, hash);
    return { duplicate: rowToTransfer(dup) };
  }
  const from = fuel.getLocation(input.fromLocationId);
  if (!from || from.companyId !== companyId) throw badRequest('Pick the tank the fuel was sent from');
  let to = null;
  if (input.toLocationId) {
    to = fuel.getLocation(input.toLocationId);
    if (!to || to.companyId !== companyId) throw badRequest('Pick the farm store it was sent to');
    if (to.id === from.id) throw badRequest('Sent from and sent to cannot be the same place');
  }
  const settings = fuel.getSettings(companyId);
  const typed = litresValue(input.litresSent, 'Litres sent');
  const pumpBefore = readingValue(input.pumpMeterBefore, 'Pump meter before');
  const pumpAfter = readingValue(input.pumpMeterAfter, 'Pump meter after');
  if ((pumpBefore == null) !== (pumpAfter == null)) throw badRequest('Enter both pump meter readings (before and after), or neither');
  let litres = typed;
  if (pumpBefore != null) {
    const m = resolvePumpMeterLitres({ before: pumpBefore, after: pumpAfter, typed }, settings);
    if (!m.backwards && m.litres > 0) litres = m.litres;
  }
  litres = litresValue(litres, 'Litres sent');
  if (litres == null) throw badRequest('Enter the litres sent');
  const containers = int(input.containers);
  if (containers != null && (containers < 0 || containers > 1000)) throw badRequest('Containers must be from 0 to 1000');
  const source = sourceOf(input.source);
  const at = capQueuedTime(recordTime(source, input.at, input.queuedForMs), {
    source, queuedForMs: input.queuedForMs, companyId, locationIds: [from.id],
  });
  const me = callerEmployee(companyId);
  return {
    values: {
      id: uuid(), companyId, from: from.id, to: to?.id ?? null, litres, typed, containers, containerNote: str(input.containerNote, 500),
      pumpBefore, pumpAfter, at, workDate: phnomPenhDate(at),
      sentBy: employeeIn(companyId, input.sentByEmployeeId, 'The sender', { at }) ?? (me?.id ?? null),
      carriedBy: employeeIn(companyId, input.carriedByEmployeeId, 'The person carrying it', { at }),
      by: getCallerUserId(), source, clientRef, note: str(input.note, 1000), now: Date.now(),
      queuedForMs: queuedMs(source, input.queuedForMs), clientRefHash: hash,
    },
  };
}

function insertTransfer(values, photoRows = []) {
  const db = getDb();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO fuel_transfers (id, company_id, from_location_id, to_location_id, litres_sent, typed_litres, containers, container_note,
          pump_meter_before, pump_meter_after, sent_at, work_date, sent_by_employee_id, carried_by_employee_id, recorded_by_user_id, source, client_ref, note,
          queued_for_ms, client_ref_hash, created_at)
        VALUES (@id, @companyId, @from, @to, @litres, @typed, @containers, @containerNote,
          @pumpBefore, @pumpAfter, @at, @workDate, @sentBy, @carriedBy, @by, @source, @clientRef, @note, @queuedForMs, @clientRefHash, @now)
      `).run(values);
      for (const p of photoRows) insertPhotoRow({ ...p, companyId: values.companyId, ownerKind: 'transfer', ownerId: values.id });
    })();
  } catch (err) {
    if (isUniqueClientRef(err)) return { duplicate: rowToTransfer(findByClientRef('fuel_transfers', values.companyId, values.clientRef)) };
    throw err;
  }
  const transfer = getTransfer(values.id);
  audit('fuel_transfer', transfer.id, 'create', { after: transfer });
  return { transfer };
}

function createTransfer(input = {}) {
  const prep = prepareTransfer(input);
  if (prep.duplicate) return { transfer: prep.duplicate, duplicate: true };
  const res = insertTransfer(prep.values);
  return res.duplicate ? { transfer: res.duplicate, duplicate: true } : { transfer: res.transfer, duplicate: false };
}

/**
 * Record what arrived at the farm. A repeat of an already-received transfer
 * returns it unchanged. `forbidSelf` (set for callers without fuel.manage):
 * the account that recorded the send, or the person who sent it, cannot also
 * confirm the receipt — the two ends must be two people. `photoRows` are
 * inserted in the same transaction as the receipt.
 */
/**
 * A receipt for a transfer that already has one. The SAME caller sending the
 * same litres again (a phone resending after a lost answer) gets the saved
 * receipt back as a duplicate; anyone else, or other litres, is told plainly —
 * "already saved" would hide that two people disagree about what arrived.
 */
function repeatedReceipt(t, input) {
  const sameCaller = (t.receivedRecordedByUserId ?? null) === (getCallerUserId() ?? null);
  const litres = num(input.litresReceived);
  if (sameCaller && litres != null && Math.abs(litres - t.litresReceived) < 1e-9) return { transfer: t, duplicate: true };
  const err = badRequest('Someone else already recorded this delivery as received');
  err.code = 'ALREADY_RECEIVED';
  throw err;
}

function receiveTransfer(id, input = {}, { forbidSelf = false, photoRows = [] } = {}) {
  const t = getTransfer(id);
  if (!t) throw badRequest('Transfer not found');
  if (t.voided) throw badRequest('That transfer is void');
  if (t.received) return repeatedReceipt(t, input);
  if (forbidSelf) {
    const uid = getCallerUserId();
    const meNow = callerEmployee(t.companyId);
    const receiver = input.receivedByEmployeeId || meNow?.id || null;
    if ((uid && t.recordedByUserId === uid) || (receiver && t.sentByEmployeeId && receiver === t.sentByEmployeeId)) {
      throw badRequest('The person who sent this fuel cannot also confirm it arrived — the farm side has to receive it');
    }
  }
  const litres = num(input.litresReceived);
  if (litres == null || litres < 0 || litres > MAX_LITRES) throw badRequest('Enter the litres received');
  const source = sourceOf(input.source);
  // A phone's queued receipt cannot land before the send it answers.
  const at = source === 'phone' ? Math.max(recordTime(source, input.at, input.queuedForMs), t.sentAt) : recordTime(source, input.at);
  if (at < t.sentAt) throw badRequest('Received cannot be earlier than sent');
  const me = callerEmployee(t.companyId);
  const receiver = employeeIn(t.companyId, input.receivedByEmployeeId, 'The receiver', { at }) ?? (me?.id ?? null);
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    changes = db.prepare(`
      UPDATE fuel_transfers SET litres_received = ?, received_at = ?, received_by_employee_id = ?, received_note = ?, received_recorded_by_user_id = ?
       WHERE id = ? AND litres_received IS NULL
    `).run(litres, at, receiver, str(input.note, 1000), getCallerUserId(), id).changes;
    if (changes) for (const p of photoRows) insertPhotoRow({ ...p, companyId: t.companyId, ownerKind: 'transfer', ownerId: id });
  })();
  if (changes === 0) return repeatedReceipt(getTransfer(id), input);
  const next = getTransfer(id);
  audit('fuel_transfer', id, 'receive', { after: { litresReceived: litres, receivedAt: at, receivedByEmployeeId: next.receivedByEmployeeId } });
  return { transfer: next, duplicate: false };
}

/* ─── void ────────────────────────────────────────────────────── */

/** The time(s) a record counts at, for recomputing just that stretch of history. */
function recordTimes(kind, row) {
  if (kind === 'fill') return [row.at];
  if (kind === 'dip') return [row.taken_at];
  if (kind === 'transfer') return [row.sent_at, row.received_at].filter((t) => t != null);
  if (kind === 'meterReset') return [row.at];
  if (kind === 'delivery') {
    const dips = new Map();
    for (const id of [row.dip_before_id, row.dip_after_id]) if (id) { const d = getDip(id); if (d) dips.set(id, d); }
    const { deliveryEffectiveAt } = require('../util/fuelAnomalies');
    return [row.delivered_at, deliveryEffectiveAt({ deliveredAt: row.delivered_at, dipBeforeId: row.dip_before_id, dipAfterId: row.dip_after_id }, dips)];
  }
  return [];
}

const VOIDABLE = {
  fill: { table: 'fuel_fills', entity: 'fuel_fill' },
  dip: { table: 'fuel_dips', entity: 'fuel_dip' },
  delivery: { table: 'fuel_deliveries', entity: 'fuel_delivery' },
  transfer: { table: 'fuel_transfers', entity: 'fuel_transfer' },
  meterReset: { table: 'fuel_meter_resets', entity: 'fuel_meter_reset' },
};

/** The row a void would act on (a fill resolves to its current revision). */
function voidTarget(kind, id) {
  const spec = VOIDABLE[kind];
  if (!spec) throw badRequest('kind must be fill, dip, delivery, transfer or meterReset');
  if (kind === 'fill') {
    const f = getActiveFill(id);
    return f ? { spec, row: getFillRow(f.id) } : null;
  }
  const row = getDb().prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id);
  return row ? { spec, row } : null;
}

/**
 * Void a record with a reason. Nothing is deleted; the row stays (and shows
 * as void) so the history is complete. `{ ownOnly }` is the recorder's own
 * "I made a mistake" path: only their own record, still `new`, within 24 h.
 */
function voidRecord(kind, id, reason, { ownOnly = false } = {}) {
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to void a record');
  const target = voidTarget(kind, id);
  if (!target) throw badRequest('Record not found');
  const { spec, row } = target;
  if (row.voided_at) return { voided: true, already: true, kind, id: row.id, companyId: row.company_id };
  if (ownOnly) {
    const uid = getCallerUserId();
    const recordedAt = row.recorded_at ?? row.created_at;
    if (!uid || row.recorded_by_user_id !== uid) throw badRequest('You can only void a record you entered yourself');
    if (kind === 'fill' && row.review_status !== 'new') throw badRequest('This fill has been reviewed; ask a manager to void it');
    if (Date.now() - recordedAt > 24 * 60 * 60 * 1000) throw badRequest('Records older than 24 hours can only be voided by a manager');
  }
  getDb().prepare(`UPDATE ${spec.table} SET voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?`)
    .run(Date.now(), why, getCallerUserId(), row.id);
  audit(spec.entity, kind === 'fill' ? row.root_id : row.id, 'void', { before: { voided: false }, after: { voided: true, reason: why, revision: row.id } });
  return {
    voided: true, already: false, kind, id: row.id, companyId: row.company_id, assetId: row.asset_id ?? null,
    locationIds: [row.location_id, row.from_location_id, row.to_location_id].filter(Boolean),
    times: recordTimes(kind, row),
  };
}

/* ─── lists ───────────────────────────────────────────────────── */

function clampLimit(v, def = 50) {
  const n = int(v);
  return n == null ? def : Math.max(1, Math.min(500, n));
}

/**
 * The asset's fill before this one (by time, current revisions, not void) —
 * and the last one before it that has a meter reading, with any meter reset
 * in between — so the reviewer sees the previous reading beside the typed one.
 */
function previousFills(fill) {
  if (!fill?.assetId) return { previousFill: null, previousMeterFill: null };
  const db = getDb();
  const base = `SELECT * FROM fuel_fills WHERE asset_id = @assetId AND root_id <> @rootId AND voided_at IS NULL AND superseded_at IS NULL
    AND (at < @at OR (at = @at AND created_at < @createdAt))`;
  const params = { assetId: fill.assetId, rootId: fill.rootId, at: fill.at, createdAt: fill.createdAt };
  const previousFill = rowToFill(db.prepare(`${base} ORDER BY at DESC, created_at DESC LIMIT 1`).get(params));
  const previousMeterFill = rowToFill(db.prepare(`${base} AND meter_reading IS NOT NULL ORDER BY at DESC, created_at DESC LIMIT 1`).get(params));
  return { previousFill, previousMeterFill };
}

function listFills(companyId, f = {}) {
  if (!companyId) return { items: [], total: 0 };
  const where = ['company_id = @companyId'];
  const p = { companyId };
  if (!f.includeSuperseded) where.push('superseded_at IS NULL');
  if (!f.includeVoided) where.push('voided_at IS NULL');
  if (num(f.from) != null) { where.push('at >= @from'); p.from = num(f.from); }
  if (num(f.to) != null) { where.push('at < @to'); p.to = num(f.to); }
  for (const [key, col] of [['assetId', 'asset_id'], ['driverEmployeeId', 'driver_employee_id'], ['locationId', 'location_id'], ['stationId', 'station_id'], ['attendantEmployeeId', 'attendant_employee_id']]) {
    if (f[key]) { where.push(`${col} = @${key}`); p[key] = f[key]; }
  }
  if (f.kind && FILL_KINDS.includes(f.kind)) { where.push('kind = @kind'); p.kind = f.kind; }
  if (f.reviewStatus && REVIEW_STATUSES.includes(f.reviewStatus)) { where.push('review_status = @reviewStatus'); p.reviewStatus = f.reviewStatus; }
  // 'waiting' = not yet checked (new or needs review): the Mac's review queue.
  if (f.reviewStatus === 'waiting') where.push("review_status IN ('new', 'needs_review')");
  const sql = `FROM fuel_fills WHERE ${where.join(' AND ')}`;
  const total = getDb().prepare(`SELECT COUNT(*) AS n ${sql}`).get(p).n;
  // Newest first by default; the review queue asks for the oldest first so
  // nothing waits forever behind a busy week (`total` is always the true count).
  const order = f.order === 'oldest' ? 'at ASC, created_at ASC' : 'at DESC, created_at DESC';
  const rows = getDb().prepare(`SELECT * ${sql} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
    .all({ ...p, limit: clampLimit(f.limit), offset: Math.max(0, int(f.offset) ?? 0) }).map(rowToFill);
  const photos = listPhotos('fill', [...new Set(rows.map((r) => r.rootId))]);
  const flagCounts = new Map();
  if (rows.length) {
    const subj = rows.map((r) => `fill:${r.rootId}`);
    for (let i = 0; i < subj.length; i += 500) {
      const chunk = subj.slice(i, i + 500);
      for (const r of getDb().prepare(`SELECT subject, COUNT(*) AS n, MAX(severity = 'red') AS red FROM fuel_flags
        WHERE subject IN (${chunk.map(() => '?').join(',')}) AND resolved_at IS NULL AND status = 'open' GROUP BY subject`).all(...chunk)) {
        flagCounts.set(r.subject, { open: r.n, red: !!r.red });
      }
    }
  }
  const items = rows.map((r) => ({
    ...r,
    photos: photos.filter((ph) => ph.ownerId === r.rootId).map(publicPhoto),
    openFlags: flagCounts.get(`fill:${r.rootId}`)?.open ?? 0,
    hasRedFlag: flagCounts.get(`fill:${r.rootId}`)?.red ?? false,
  }));
  return { items, total };
}

function simpleList(table, mapper, timeCol, companyId, f = {}, extraWhere = []) {
  if (!companyId) return { items: [], total: 0 };
  const where = ['company_id = @companyId', ...extraWhere.map(([sql]) => sql)];
  const p = { companyId };
  for (const [, key, value] of extraWhere) p[key] = value;
  if (!f.includeVoided) where.push('voided_at IS NULL');
  if (num(f.from) != null) { where.push(`${timeCol} >= @from`); p.from = num(f.from); }
  if (num(f.to) != null) { where.push(`${timeCol} < @to`); p.to = num(f.to); }
  const sql = `FROM ${table} WHERE ${where.join(' AND ')}`;
  const total = getDb().prepare(`SELECT COUNT(*) AS n ${sql}`).get(p).n;
  const items = getDb().prepare(`SELECT * ${sql} ORDER BY ${timeCol} DESC, created_at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...p, limit: clampLimit(f.limit), offset: Math.max(0, int(f.offset) ?? 0) }).map(mapper);
  return { items, total };
}

function withPhotos(ownerKind, result) {
  const photos = listPhotos(ownerKind, result.items.map((x) => x.id));
  return { ...result, items: result.items.map((x) => ({ ...x, photos: photos.filter((p) => p.ownerId === x.id).map(publicPhoto) })) };
}

function listDips(companyId, f = {}) {
  const extra = f.locationId ? [['location_id = @locationId', 'locationId', f.locationId]] : [];
  return withPhotos('dip', simpleList('fuel_dips', rowToDip, 'taken_at', companyId, f, extra));
}

function listDeliveries(companyId, f = {}) {
  const extra = f.locationId ? [['location_id = @locationId', 'locationId', f.locationId]] : [];
  return withPhotos('delivery', simpleList('fuel_deliveries', rowToDelivery, 'delivered_at', companyId, f, extra));
}

function listTransfers(companyId, f = {}) {
  const extra = [];
  if (f.locationId) extra.push(['(from_location_id = @locationId OR to_location_id = @locationId)', 'locationId', f.locationId]);
  if (f.pendingOnly) extra.push(['litres_received IS NULL AND 1 = @one', 'one', 1]);
  return withPhotos('transfer', simpleList('fuel_transfers', rowToTransfer, 'sent_at', companyId, f, extra));
}

/** What the caller entered recently — the phone's "my entries" list. */
function listMine(companyId, userId, { days = 7 } = {}) {
  if (!companyId || !userId) return { fills: [], dips: [], deliveries: [], transfers: [] };
  const since = Date.now() - Math.max(1, Math.min(60, int(days) ?? 7)) * 24 * 60 * 60 * 1000;
  const db = getDb();
  const fills = db.prepare(`SELECT * FROM fuel_fills WHERE company_id = ? AND recorded_by_user_id = ? AND recorded_at >= ? AND superseded_at IS NULL ORDER BY recorded_at DESC LIMIT 200`)
    .all(companyId, userId, since).map(rowToFill);
  const dips = db.prepare(`SELECT * FROM fuel_dips WHERE company_id = ? AND recorded_by_user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200`)
    .all(companyId, userId, since).map(rowToDip);
  const deliveries = db.prepare(`SELECT * FROM fuel_deliveries WHERE company_id = ? AND recorded_by_user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200`)
    .all(companyId, userId, since).map(rowToDelivery);
  const transfers = db.prepare(`SELECT * FROM fuel_transfers WHERE company_id = ? AND (recorded_by_user_id = ? OR received_recorded_by_user_id = ?) AND created_at >= ? ORDER BY created_at DESC LIMIT 200`)
    .all(companyId, userId, userId, since).map(rowToTransfer);
  return { fills, dips, deliveries, transfers };
}

/* ─── rows for the rules ──────────────────────────────────────── */

/*
 * Rows for the rules. Each loader takes an optional time window
 * `{ from, to }` (inclusive, epoch ms) so a save can recompute only the
 * stretch of history it touched (main/db/fuelFlags.js); without one they
 * return the whole history (the full pass, reports).
 */
const ALL_TIME = { from: -8.64e15, to: 8.64e15 };
function win(range) { return { from: range?.from ?? ALL_TIME.from, to: range?.to ?? ALL_TIME.to }; }

/** Active fills of an asset (not void, not superseded) with their photo kinds. */
function activeFillsForAsset(assetId, range) {
  const { from, to } = win(range);
  const rows = getDb().prepare(`SELECT * FROM fuel_fills WHERE asset_id = ? AND voided_at IS NULL AND superseded_at IS NULL
    AND at >= ? AND at <= ? ORDER BY at, created_at`).all(assetId, from, to).map(rowToFill);
  return attachPhotoKinds(rows);
}

function attachPhotoKinds(fills) {
  if (!fills.length) return fills;
  const kinds = new Map();
  for (const p of listPhotos('fill', [...new Set(fills.map((f) => f.rootId))])) {
    if (!kinds.has(p.ownerId)) kinds.set(p.ownerId, new Set());
    kinds.get(p.ownerId).add(p.kind);
  }
  return fills.map((f) => ({ ...f, photoKinds: [...(kinds.get(f.rootId) || [])] }));
}

function activeFillsForLocation(locationId, range) {
  const { from, to } = win(range);
  return getDb().prepare(`SELECT * FROM fuel_fills WHERE location_id = ? AND voided_at IS NULL AND superseded_at IS NULL
    AND at >= ? AND at <= ? ORDER BY at, created_at`).all(locationId, from, to).map(rowToFill);
}

function activeDipsForLocation(locationId, range) {
  const { from, to } = win(range);
  return getDb().prepare(`SELECT * FROM fuel_dips WHERE location_id = ? AND voided_at IS NULL AND taken_at >= ? AND taken_at <= ?
    ORDER BY taken_at, created_at`).all(locationId, from, to).map(rowToDip);
}

/** Deliveries in the window, plus any linked to a dip in it (a delivery may be recorded after its "after" dip). */
function activeDeliveriesForLocation(locationId, range, dipIds = []) {
  const { from, to } = win(range);
  const ids = dipIds.slice(0, 400);
  const linked = ids.length ? ` OR dip_before_id IN (${ids.map(() => '?').join(',')}) OR dip_after_id IN (${ids.map(() => '?').join(',')})` : '';
  return getDb().prepare(`SELECT * FROM fuel_deliveries WHERE location_id = ? AND voided_at IS NULL
    AND ((delivered_at >= ? AND delivered_at <= ?)${linked}) ORDER BY delivered_at`).all(locationId, from, to, ...ids, ...ids).map(rowToDelivery);
}

/** Transfers sent from, or received at, the location within the window. */
function activeTransfersForLocation(locationId, range) {
  const { from, to } = win(range);
  return getDb().prepare(`SELECT * FROM fuel_transfers WHERE voided_at IS NULL AND (
      (from_location_id = ? AND sent_at >= ? AND sent_at <= ?)
      OR (to_location_id = ? AND received_at >= ? AND received_at <= ?))
    ORDER BY sent_at`).all(locationId, from, to, locationId, from, to).map(rowToTransfer);
}

/** The last pump-meter reading before `before` at a location (M2 continuity across a window edge). */
function lastPumpEventBefore(locationId, before) {
  const db = getDb();
  const f = db.prepare(`SELECT * FROM fuel_fills WHERE location_id = ? AND voided_at IS NULL AND superseded_at IS NULL
    AND pump_meter_after IS NOT NULL AND at < ? ORDER BY at DESC LIMIT 1`).get(locationId, before);
  const t = db.prepare(`SELECT * FROM fuel_transfers WHERE from_location_id = ? AND voided_at IS NULL
    AND pump_meter_after IS NOT NULL AND sent_at < ? ORDER BY sent_at DESC LIMIT 1`).get(locationId, before);
  if (f && (!t || f.at >= t.sent_at)) return { fill: rowToFill(f) };
  if (t) return { transfer: rowToTransfer(t) };
  return null;
}

module.exports = {
  previousFills,
  FILL_KINDS, SOURCES, REVIEW_STATUSES, PHOTO_KINDS, MAX_LITRES,
  rowToFill, getFill, getActiveFill, listRevisions, prepareFill, insertFill, createFill, correctFill, reviewFill,
  getDip, prepareDip, insertDip, createDip,
  getDelivery, prepareDelivery, insertDelivery, createDelivery, setDeliveryDips,
  getTransfer, prepareTransfer, insertTransfer, createTransfer, receiveTransfer,
  voidRecord, voidTarget,
  listFills, listDips, listDeliveries, listTransfers, listMine,
  insertPhotoRow, getPhoto, listPhotos, publicPhoto, photoOwnerRecord,
  activeFillsForAsset, activeFillsForLocation, activeDipsForLocation, activeDeliveriesForLocation, activeTransfersForLocation, attachPhotoKinds,
  lastPumpEventBefore, payloadHash,
};
