/**
 * Fuel F1: argument validators for the `staff:*` and `fuel:*` channels.
 *
 * Kept in their own file so the fuel feature does not crowd
 * main/server/validators.js; `getValidator()` there consults this map too, so
 * both the local IPC path and the RPC path validate (AGENTS.md §15), and
 * test/validatorCoverage.test.js counts them.
 *
 * Bytes: on the RPC path a validator sees the serialized `{ __bin, b64 }`
 * envelope; on the local path an ArrayBuffer / typed array. Both are checked
 * against MAX_PHOTO_BYTES here, before any decoding — a 100 MB request body is
 * refused by the server before this, but one photo should never be near that.
 */

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_PHOTOS = 6;

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function isNonEmpty(v) { return isString(v) && v.length > 0 && v.length <= 200; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function optNum(v) { return v == null || isNum(v); }
function optStr(v, max = 2000) { return v == null || (isString(v) && v.length <= max); }
function optBool(v) { return v == null || typeof v === 'boolean'; }

function bytesSize(v) {
  if (v == null) return null;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (isObject(v) && v.__bin === true && isString(v.b64)) return Math.floor((v.b64.length * 3) / 4);
  return null;
}

function checkBytes(v, label = 'bytes') {
  const n = bytesSize(v);
  if (n == null) return `${label} must be binary image data`;
  if (n === 0) return `${label} is empty`;
  if (n > MAX_PHOTO_BYTES) return `${label} is too large (max ${MAX_PHOTO_BYTES / 1024 / 1024} MB per photo)`;
  return true;
}

function checkPhotos(list) {
  if (list == null) return true;
  if (!Array.isArray(list)) return 'photos must be a list';
  if (list.length > MAX_PHOTOS) return `at most ${MAX_PHOTOS} photos per record`;
  for (const p of list) {
    if (!isObject(p) || !isNonEmpty(p.kind)) return 'each photo needs a kind';
    const b = checkBytes(p.bytes, 'photo');
    if (b !== true) return b;
  }
  return true;
}

function obj(fn) {
  return (a) => (isObject(a) ? fn(a) : 'expected an object argument');
}
function optObj(fn = () => true) {
  return (a) => (a == null ? true : isObject(a) ? fn(a) : 'expected an object or nothing');
}
function idArg(label) {
  return (a) => (isNonEmpty(a) ? true : `${label} must be a non-empty string`);
}
function idPatch(label) {
  return obj((a) => {
    if (!isNonEmpty(a.id)) return `${label} id must be a non-empty string`;
    if (!isObject(a.patch)) return 'patch must be an object';
    return true;
  });
}
function first(...checks) {
  for (const c of checks) if (c !== true) return c;
  return true;
}
function numbers(a, names) {
  for (const n of names) if (!optNum(a[n])) return `${n} must be a number`;
  return true;
}
function strings(a, names, max) {
  for (const n of names) if (!optStr(a[n], max)) return `${n} must be text`;
  return true;
}
function clientRef(a) {
  return a.clientRef == null || (isString(a.clientRef) && /^[A-Za-z0-9_.:-]{6,100}$/.test(a.clientRef))
    ? true : 'clientRef must be 6–100 letters, digits or - _ . :';
}
function source(a) {
  return a.source == null || ['phone', 'mac', 'import'].includes(a.source) ? true : 'source must be phone, mac or import';
}
// month is optional (absent = this month in Phnom Penh time).
const MONTH = optObj((a) => (a.month == null || (isString(a.month) && /^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)) ? true : 'month must look like 2026-10'));
const LIST_FILTERS = optObj((a) => first(numbers(a, ['from', 'to', 'limit', 'offset']), strings(a, ['assetId', 'locationId', 'stationId', 'driverEmployeeId', 'employeeId', 'status', 'severity', 'ruleKey', 'period', 'kind', 'reviewStatus', 'subject', 'q'], 200)));

const FUEL_VALIDATORS = {
  /* staff */
  'staff:list': optObj((a) => strings(a, ['status', 'role', 'q', 'companyId'], 200)),
  'staff:get': idArg('staff id'),
  'staff:me': () => true,
  'staff:create': obj((a) => first(
    isNonEmpty(a.staffCode) ? true : 'staffCode is required',
    strings(a, ['nameEn', 'nameKm', 'phone', 'position', 'notes', 'userId', 'companyId'], 2000),
    optBool(a.isDriver) && optBool(a.isFuelAttendant) ? true : 'isDriver / isFuelAttendant must be true or false',
  )),
  'staff:update': idPatch('staff'),
  'staff:markLeft': obj((a) => first(isNonEmpty(a.id) ? true : 'id is required', strings(a, ['leftOn', 'reason'], 500))),
  'staff:reactivate': idArg('staff id'),
  'staff:setPhoto': obj((a) => first(isNonEmpty(a.id) ? true : 'id is required', checkBytes(a.bytes))),
  'staff:getPhoto': obj((a) => first(isNonEmpty(a.id) ? true : 'id is required', optBool(a.thumb) ? true : 'thumb must be true or false')),

  /* thresholds */
  'fuel:getSettings': () => true,
  'fuel:updateSettings': obj(() => true),

  /* asset types + assets */
  'fuel:listAssetTypes': optObj((a) => (optBool(a.includeArchived) ? true : 'includeArchived must be true or false')),
  'fuel:createAssetType': obj((a) => first(isNonEmpty(a.name) ? true : 'name is required', numbers(a, ['maxPerDay']))),
  'fuel:updateAssetType': idPatch('asset type'),
  'fuel:listAssets': optObj((a) => strings(a, ['status', 'q'], 200)),
  'fuel:getAsset': idArg('asset id'),
  'fuel:createAsset': obj((a) => first(
    isNonEmpty(a.typeId) ? true : 'typeId is required',
    isNonEmpty(a.name) ? true : 'name is required',
    numbers(a, ['tankCapacityL', 'baselineRate']),
  )),
  'fuel:updateAsset': idPatch('asset'),
  'fuel:setAssetPhoto': obj((a) => first(isNonEmpty(a.id) ? true : 'id is required', checkBytes(a.bytes))),

  /* locations + charts */
  'fuel:listLocations': optObj((a) => strings(a, ['status'], 20)),
  'fuel:getLocation': idArg('tank id'),
  'fuel:createLocation': obj((a) => first(isNonEmpty(a.name) ? true : 'name is required', numbers(a, ['capacityL']), optBool(a.hasFlowMeter) ? true : 'hasFlowMeter must be true or false')),
  'fuel:updateLocation': idPatch('tank'),
  'fuel:getChart': idArg('tank id'),
  'fuel:setChart': obj((a) => {
    if (!isNonEmpty(a.locationId)) return 'locationId is required';
    if (!Array.isArray(a.points) || a.points.length < 2 || a.points.length > 2000) return 'points must be a list of 2 to 2000 { dipCm, litres }';
    for (const p of a.points) if (!isObject(p) || !isNum(p.dipCm) || !isNum(p.litres)) return 'each point needs numbers dipCm and litres';
    return true;
  }),
  'fuel:getDipLitres': obj((a) => first(isNonEmpty(a.locationId) ? true : 'locationId is required', isNum(a.dipCm) ? true : 'dipCm must be a number')),
  'fuel:getChartSuggestion': obj((a) => first(
    isNonEmpty(a.locationId) ? true : 'locationId is required',
    numbers(a, ['stepCm']),
    a.anchor == null || (isObject(a.anchor) && isNum(a.anchor.dipCm) && isNum(a.anchor.litres)) ? true : 'anchor must be { dipCm, litres }',
  )),

  /* stations + prices + resets */
  'fuel:listStations': optObj((a) => (optBool(a.includeArchived) ? true : 'includeArchived must be true or false')),
  'fuel:createStation': obj((a) => first(isNonEmpty(a.name) ? true : 'name is required', strings(a, ['area'], 200))),
  'fuel:updateStation': idPatch('station'),
  'fuel:listPrices': optObj((a) => first(strings(a, ['fuelType'], 20), optBool(a.includeVoided) ? true : 'includeVoided must be true or false')),
  'fuel:setPrice': obj((a) => first(
    isNonEmpty(a.fuelType) ? true : 'fuelType is required',
    Number.isInteger(a.priceMinorPerL) && a.priceMinorPerL > 0 ? true : 'priceMinorPerL must be a whole number more than 0',
    isString(a.effectiveFrom) ? true : 'effectiveFrom is required',
    strings(a, ['currency', 'sourceNote', 'photoId'], 500),
  )),
  'fuel:voidPrice': obj((a) => first(isNonEmpty(a.id) ? true : 'id is required', isNonEmpty(a.reason) ? true : 'reason is required')),
  'fuel:listMeterResets': optObj((a) => strings(a, ['assetId', 'locationId'], 200)),
  'fuel:recordMeterReset': obj((a) => first(
    isNum(a.oldReading) && isNum(a.newReading) ? true : 'oldReading and newReading must be numbers',
    isNonEmpty(a.reason) ? true : 'reason is required',
    numbers(a, ['at']), strings(a, ['assetId', 'locationId'], 200),
  )),

  /* records */
  'fuel:recordFill': obj((a) => first(
    ['warehouse_tank', 'farm_store', 'cash_station'].includes(a.kind) ? true : 'kind must be warehouse_tank, farm_store or cash_station',
    isNonEmpty(a.assetId) ? true : 'assetId is required',
    numbers(a, ['at', 'queuedForMs', 'litres', 'cansCount', 'canSizeL', 'pumpMeterBefore', 'pumpMeterAfter', 'meterReading', 'amountPaidMinor', 'litresShownOnPump']),
    strings(a, ['locationId', 'stationId', 'stationName', 'driverEmployeeId', 'attendantEmployeeId', 'currency', 'note', 'companyId'], 1000),
    optBool(a.fullTank) ? true : 'fullTank must be true or false',
    clientRef(a), source(a), checkPhotos(a.photos),
  )),
  'fuel:recordDip': obj((a) => first(
    isNonEmpty(a.locationId) ? true : 'locationId is required',
    numbers(a, ['at', 'queuedForMs', 'dipCm', 'litres']),
    strings(a, ['takenByEmployeeId', 'witnessEmployeeId', 'note', 'companyId'], 1000),
    clientRef(a), source(a), checkPhotos(a.photos),
  )),
  'fuel:recordDelivery': obj((a) => first(
    isNonEmpty(a.locationId) ? true : 'locationId is required',
    isNum(a.litresInvoiced) ? true : 'litresInvoiced must be a number',
    numbers(a, ['at', 'queuedForMs', 'priceMinorPerL', 'amountMinor']),
    strings(a, ['supplier', 'invoiceNo', 'currency', 'dipBeforeId', 'dipAfterId', 'receivedByEmployeeId', 'note', 'companyId'], 1000),
    clientRef(a), source(a), checkPhotos(a.photos),
  )),
  'fuel:setDeliveryDips': obj((a) => first(isNonEmpty(a.id) ? true : 'id is required', strings(a, ['dipBeforeId', 'dipAfterId'], 200))),
  'fuel:recordTransfer': obj((a) => first(
    isNonEmpty(a.fromLocationId) ? true : 'fromLocationId is required',
    numbers(a, ['at', 'queuedForMs', 'litresSent', 'containers', 'pumpMeterBefore', 'pumpMeterAfter']),
    strings(a, ['toLocationId', 'containerNote', 'sentByEmployeeId', 'note', 'companyId'], 1000),
    clientRef(a), source(a), checkPhotos(a.photos),
  )),
  'fuel:receiveTransfer': obj((a) => first(
    isNonEmpty(a.id) ? true : 'id is required',
    isNum(a.litresReceived) ? true : 'litresReceived must be a number',
    numbers(a, ['at', 'queuedForMs']), strings(a, ['receivedByEmployeeId', 'note'], 1000), source(a), checkPhotos(a.photos),
  )),
  'fuel:addPhoto': obj((a) => first(
    ['fill', 'dip', 'delivery', 'transfer'].includes(a.ownerKind) ? true : 'ownerKind must be fill, dip, delivery or transfer',
    isNonEmpty(a.ownerId) ? true : 'ownerId is required',
    isNonEmpty(a.kind) ? true : 'kind is required',
    checkBytes(a.bytes),
  )),
  'fuel:getPhoto': obj((a) => first(isNonEmpty(a.photoId) ? true : 'photoId is required', optBool(a.thumb) ? true : 'thumb must be true or false')),

  /* lists */
  'fuel:listFills': LIST_FILTERS,
  'fuel:getFill': idArg('fill id'),
  'fuel:listDips': LIST_FILTERS,
  'fuel:listDeliveries': LIST_FILTERS,
  'fuel:listTransfers': LIST_FILTERS,
  'fuel:listPendingTransfers': optObj((a) => strings(a, ['locationId'], 200)),
  'fuel:listMyRecent': optObj((a) => numbers(a, ['days'])),

  /* review / correct / void */
  'fuel:reviewFill': obj((a) => first(
    isNonEmpty(a.id) ? true : 'id is required',
    ['checked', 'needs_review'].includes(a.status) ? true : 'status must be checked or needs_review',
    numbers(a, ['reviewedAmountMinor', 'reviewedLitres']), strings(a, ['note'], 1000),
  )),
  'fuel:correctFill': obj((a) => first(
    isNonEmpty(a.id) ? true : 'id is required',
    isObject(a.patch) ? true : 'patch must be an object',
    isNonEmpty(a.reason) ? true : 'reason is required',
  )),
  'fuel:voidRecord': obj((a) => first(
    ['fill', 'dip', 'delivery', 'transfer', 'meterReset'].includes(a.kind) ? true : 'kind must be fill, dip, delivery, transfer or meterReset',
    isNonEmpty(a.id) ? true : 'id is required',
    isNonEmpty(a.reason) ? true : 'reason is required',
  )),
  'fuel:voidMyRecord': obj((a) => first(
    ['fill', 'dip', 'delivery', 'transfer'].includes(a.kind) ? true : 'kind must be fill, dip, delivery or transfer',
    isNonEmpty(a.id) ? true : 'id is required',
    isNonEmpty(a.reason) ? true : 'reason is required',
  )),

  /* flags + reports */
  'fuel:listFlags': optObj((a) => first(LIST_FILTERS(a), optBool(a.includeResolved) ? true : 'includeResolved must be true or false')),
  'fuel:reviewFlag': obj((a) => first(
    isNonEmpty(a.id) ? true : 'id is required',
    ['open', 'explained', 'confirmed', 'dismissed'].includes(a.status) ? true : 'status must be open, explained, confirmed or dismissed',
    strings(a, ['note'], 1000),
  )),
  'fuel:recomputeFlags': () => true,
  'fuel:getOverview': () => true,
  'fuel:getMonthlyReport': MONTH,
  'fuel:getMonthlyWorkbook': MONTH,
  'fuel:saveMonthlyWorkbook': MONTH,
  'fuel:sweepPhotoRetention': () => true,
};

module.exports = { FUEL_VALIDATORS, MAX_PHOTO_BYTES, MAX_PHOTOS, bytesSize };
