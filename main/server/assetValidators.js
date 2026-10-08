/**
 * Fixed Assets & Branches A0/A1: argument validators for the `assets:*`,
 * `branches:*`, `fx:*` and `ledger:*` channels (AGENTS.md §15).
 *
 * Kept in their own file like main/server/fuelValidators.js; validators.js
 * merges this map into its own, so both the local IPC path and the RPC path
 * validate, and test/validatorCoverage.test.js counts them.
 *
 * Shapes only — the DB modules check meaning (dates are real, ids belong to
 * the company, amounts are whole minor units) and answer in words.
 */

const { bytesSize } = require('./fuelValidators');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function isId(v) { return isString(v) && v.length > 0 && v.length <= 200; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function optStr(v, max = 2000) { return v == null || (isString(v) && v.length <= max); }
function optBool(v) { return v == null || typeof v === 'boolean'; }
/** A number, or text that reads as one (amounts may arrive from a form field). */
function optNumLike(v) { return v == null || v === '' || isNum(v) || (isString(v) && v.length <= 40 && Number.isFinite(Number(v))); }
function optDate(v) { return v == null || v === '' || (isString(v) && /^\d{4}-\d{2}-\d{2}$/.test(v)); }
function optPeriod(v) { return v == null || (isString(v) && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)); }

function obj(fn) { return (a) => (isObject(a) ? fn(a) : 'expected an object argument'); }
function optObj(fn = () => true) { return (a) => (a == null ? true : isObject(a) ? fn(a) : 'expected an object or nothing'); }
function idArg(label) { return (a) => (isId(a) ? true : `${label} must be a non-empty string`); }
function first(...checks) { for (const c of checks) if (c !== true) return c; return true; }
function strings(a, names, max) { for (const n of names) if (!optStr(a[n], max)) return `${n} must be text`; return true; }
function ids(a, names) { for (const n of names) if (a[n] != null && !isId(a[n])) return `${n} must be an id`; return true; }
function nums(a, names) { for (const n of names) if (!optNumLike(a[n])) return `${n} must be a number`; return true; }
function dates(a, names) { for (const n of names) if (!optDate(a[n])) return `${n} must look like 2026-03-12`; return true; }
function bools(a, names) { for (const n of names) if (!optBool(a[n])) return `${n} must be true or false`; return true; }
function req(a, name, label = name) { return isId(a[name]) ? true : `${label} is required`; }
function reason(a) { return isString(a.reason) && a.reason.trim().length > 0 && a.reason.length <= 1000 ? true : 'reason is required'; }
function idPatch(label) {
  return obj((a) => first(isId(a.id) ? true : `${label} id must be a non-empty string`, isObject(a.patch) ? true : 'patch must be an object'));
}

const ASSET_TEXT = ['name', 'nameKm', 'serialNo', 'makeModel', 'plateNo', 'registrationNo', 'locationNote', 'invoiceNo',
  'warrantyNote', 'notes', 'tagCode', 'taxClass', 'taxClassReason', 'purchaseOrderId', 'costBasis', 'acquisitionKind',
  'costCurrency', 'status'];
const ASSET_IDS = ['categoryId', 'branchId', 'custodianEmployeeId', 'supplierId'];
const ASSET_NUMS = ['quantity', 'costMinor', 'costFxKhrPerUsd', 'vatMinor', 'usefulLifeMonths', 'salvageMinor'];
const ASSET_DATES = ['purchaseDate', 'inServiceDate', 'warrantyUntil', 'insuranceUntil', 'roadTaxUntil'];

function assetFields(a) {
  return first(
    strings(a, ASSET_TEXT, 4000), ids(a, ASSET_IDS), nums(a, ASSET_NUMS), dates(a, ASSET_DATES),
    a.depreciateOverride == null || typeof a.depreciateOverride === 'boolean' ? true : 'depreciateOverride must be true, false or empty',
  );
}

function checkBytes(v) {
  const n = bytesSize(v);
  if (n == null) return 'bytes must be binary file data';
  if (n === 0) return 'the file is empty';
  if (n > MAX_FILE_BYTES) return `the file is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`;
  return true;
}

const EVENT_BASE = (a) => first(req(a, 'id', 'id'), dates(a, ['date']));

const LIST = optObj((a) => first(
  strings(a, ['q', 'branchId', 'categoryId', 'status', 'recordState', 'custodianEmployeeId', 'attention'], 200),
  nums(a, ['limit', 'offset']), bools(a, ['fuelLinked']),
));

const ASSET_VALIDATORS = {
  /* settings + categories */
  'assets:getSettings': () => true,
  'assets:updateSettings': obj((a) => first(
    dates(a, ['registerStartDate']), strings(a, ['tagPrefix', 'convention', 'capitalizationThresholdCurrency'], 40),
    nums(a, ['capitalizationThresholdMinor', 'taxYearEndMonth', 'photoCapPerAsset', 'scanPhotoRetentionMonths']), bools(a, ['autoPostDepreciation']),
  )),
  'assets:listCategories': optObj((a) => bools(a, ['includeArchived'])),
  'assets:createCategory': obj((a) => first(
    isString(a.nameEn) && a.nameEn.trim() ? true : 'nameEn is required',
    strings(a, ['nameKm', 'tagPrefix', 'bookMethod', 'taxClass'], 200), ids(a, ['glCostAccountId', 'glAccumAccountId', 'glExpenseAccountId']),
    nums(a, ['defaultLifeMonths', 'defaultSalvagePct']), bools(a, ['isVehicle']),
  )),
  'assets:updateCategory': idPatch('category'),

  /* register */
  'assets:list': LIST,
  'assets:get': idArg('asset id'),
  'assets:create': obj((a) => first(req(a, 'categoryId', 'categoryId'), isString(a.name) && a.name.trim() ? true : 'name is required', assetFields(a))),
  'assets:update': obj((a) => first(
    isId(a.id) ? true : 'asset id must be a non-empty string',
    isObject(a.patch) ? true : 'patch must be an object',
    isObject(a.patch) ? assetFields(a.patch) : true,
    isObject(a.patch) ? first(bools(a.patch, ['retag']), strings(a.patch, ['retagReason'], 500), nums(a.patch, ['expectedUpdatedAt'])) : true,
  )),
  'assets:previewActivation': idArg('asset id'),
  'assets:activate': idArg('asset id'),
  'assets:cancelDraft': obj((a) => first(req(a, 'id'), reason(a))),

  /* files */
  'assets:addFile': obj((a) => first(
    req(a, 'assetId'),
    ['photo', 'invoice', 'warranty', 'registration', 'insurance', 'other'].includes(a.kind) ? true : 'kind must be photo, invoice, warranty, registration, insurance or other',
    checkBytes(a.bytes), strings(a, ['originalName'], 200),
  )),
  'assets:getFile': obj((a) => first(req(a, 'fileId'), bools(a, ['thumb']))),
  'assets:reorderFiles': obj((a) => first(
    req(a, 'assetId'),
    Array.isArray(a.fileIds) && a.fileIds.length <= 100 && a.fileIds.every(isId) ? true : 'fileIds must be a list of file ids',
  )),
  'assets:retireFile': obj((a) => first(req(a, 'fileId'), reason(a))),

  /* events */
  'assets:transfer': obj((a) => first(
    Array.isArray(a.assetIds) && a.assetIds.length > 0 && a.assetIds.length <= 1000 && a.assetIds.every(isId) ? true : 'assetIds must be a list of 1–1000 asset ids',
    a.toBranchId === undefined || isId(a.toBranchId) ? true : 'toBranchId must be an id',
    a.toEmployeeId === undefined || a.toEmployeeId === null || isId(a.toEmployeeId) ? true : 'toEmployeeId must be an id or null',
    dates(a, ['date']), strings(a, ['reason'], 1000),
  )),
  'assets:setCustodian': obj((a) => first(EVENT_BASE(a), a.employeeId == null || isId(a.employeeId) ? true : 'employeeId must be an id or null', strings(a, ['reason'], 1000))),
  'assets:setStatus': obj((a) => first(EVENT_BASE(a), ['in_use', 'in_storage', 'in_repair'].includes(a.status) ? true : 'status must be in_use, in_storage or in_repair', strings(a, ['reason'], 1000))),
  'assets:recordRepair': obj((a) => first(EVENT_BASE(a), reason(a), nums(a, ['amountMinor']), strings(a, ['currency', 'vendor'], 200), ids(a, ['supplierId']),
    a.documentFileIds == null || (Array.isArray(a.documentFileIds) && a.documentFileIds.every(isId)) ? true : 'documentFileIds must be a list of ids')),
  'assets:recordCapex': obj((a) => first(EVENT_BASE(a), reason(a), nums(a, ['amountMinor', 'fxKhrPerUsd', 'extendsLifeMonths']), strings(a, ['currency'], 10), ids(a, ['supplierId']),
    a.documentFileIds == null || (Array.isArray(a.documentFileIds) && a.documentFileIds.every(isId)) ? true : 'documentFileIds must be a list of ids')),
  'assets:changeLife': obj((a) => first(EVENT_BASE(a), reason(a), optNumLike(a.newLifeMonths) && a.newLifeMonths != null ? true : 'newLifeMonths is required')),
  'assets:changeSalvage': obj((a) => first(EVENT_BASE(a), reason(a), optNumLike(a.newSalvageMinor) && a.newSalvageMinor != null ? true : 'newSalvageMinor is required')),
  'assets:addNote': obj((a) => first(EVENT_BASE(a), isString(a.text) && a.text.trim() && a.text.length <= 2000 ? true : 'text is required')),
  'assets:voidEvent': obj((a) => first(req(a, 'id'), reason(a))),
  'assets:reverseEvent': obj((a) => first(req(a, 'id'), reason(a))),
  'assets:listEvents': optObj((a) => first(ids(a, ['assetId', 'batchId']), strings(a, ['kind'], 40), nums(a, ['limit', 'offset']), bools(a, ['includeVoided']))),
  'assets:getSchedule': obj((a) => first(req(a, 'id'), a.basis == null || a.basis === 'book' || a.basis === 'tax' ? true : 'basis must be book or tax')),

  /* Fuel link */
  'assets:linkFuelAsset': obj((a) => first(req(a, 'id'), req(a, 'fuelAssetId'))),
  'assets:unlinkFuelAsset': obj((a) => first(req(a, 'id'), reason(a))),
  'assets:createFuelAsset': obj((a) => first(req(a, 'id'), req(a, 'typeId'), strings(a, ['fuelType', 'meterUnit', 'notes', 'homeLocation'], 2000), nums(a, ['tankCapacityL', 'baselineRate']))),

  /* import */
  'assets:importColumns': () => true,
  'assets:importPlan': obj((a) => (Array.isArray(a.rows) && a.rows.length <= MAX_IMPORT_ROWS && a.rows.every(isObject) ? true : `rows must be a list of up to ${MAX_IMPORT_ROWS} row objects`)),
  'assets:importApply': obj((a) => (Array.isArray(a.rows) && a.rows.length <= MAX_IMPORT_ROWS && a.rows.every(isObject) ? true : `rows must be a list of up to ${MAX_IMPORT_ROWS} row objects`)),
  'assets:getImportSample': () => true,
  'assets:saveImportSample': () => true,

  /* branches */
  'branches:list': optObj((a) => strings(a, ['status'], 20)),
  'branches:get': idArg('branch id'),
  'branches:create': obj((a) => first(
    isString(a.code) && a.code.trim() ? true : 'code is required',
    isString(a.nameEn) && a.nameEn.trim() ? true : 'nameEn is required',
    strings(a, ['nameKm', 'address', 'phone', 'notes'], 2000), ids(a, ['managerEmployeeId']), bools(a, ['isHeadOffice']), nums(a, ['sort']),
  )),
  'branches:update': idPatch('branch'),
  'branches:close': obj((a) => first(req(a, 'id'), reason(a))),
  'branches:suggestFromFuel': () => true,

  /* exchange rates */
  'fx:list': optObj((a) => first(strings(a, ['source'], 20), dates(a, ['from', 'to']), bools(a, ['includeVoided']), nums(a, ['limit']))),
  'fx:rateOn': obj((a) => first(isString(a.date) && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? true : 'date must look like 2026-03-12', strings(a, ['source'], 20))),
  'fx:setRate': obj((a) => first(
    isString(a.rateDate) && /^\d{4}-\d{2}-\d{2}$/.test(a.rateDate) ? true : 'rateDate must look like 2026-03-12',
    isNum(a.khrPerUsd) ? true : 'khrPerUsd must be a number', strings(a, ['source', 'sourceNote', 'fileId'], 500),
  )),
  'fx:voidRate': obj((a) => first(req(a, 'id'), reason(a))),

  /* ledger */
  'ledger:listAccounts': optObj((a) => bools(a, ['includeArchived'])),
  'ledger:updateAccount': idPatch('account'),
  'ledger:getEntry': idArg('entry id'),
  'ledger:entriesForAsset': idArg('asset id'),
  'ledger:listPeriods': () => true,
  'ledger:checkIntegrity': () => true,
  'ledger:lockPeriod': obj((a) => first(optPeriod(a.period) && a.period != null ? true : 'period must look like 2026-03', strings(a, ['note'], 500))),
  'ledger:unlockPeriod': obj((a) => first(optPeriod(a.period) && a.period != null ? true : 'period must look like 2026-03', strings(a, ['note'], 500))),
};

module.exports = { ASSET_VALIDATORS, MAX_FILE_BYTES, MAX_IMPORT_ROWS };
