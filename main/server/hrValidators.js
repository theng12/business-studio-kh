/**
 * HR1: argument validators for the `hr:*`, `attendance:*`, `leave:*` and
 * `kiosk:*` channels. Consulted by getValidator() in main/server/validators.js,
 * so the local IPC path and the RPC path both validate (AGENTS.md §15) and
 * test/validatorCoverage.test.js counts them.
 *
 * Bytes: on the RPC path a validator sees the `{ __bin, b64 }` envelope, on the
 * local path an ArrayBuffer / typed array; both are size-checked here before
 * anything is decoded.
 */

const { bytesSize } = require('./fuelValidators');

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function isId(v) { return isString(v) && v.length > 0 && v.length <= 200; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function optNum(v) { return v == null || isNum(v); }
function optStr(v, max = 2000) { return v == null || (isString(v) && v.length <= max); }
function optBool(v) { return v == null || typeof v === 'boolean'; }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function optDate(v) { return v == null || (isString(v) && DATE_RE.test(v)); }
function optMonth(v) { return v == null || (isString(v) && MONTH_RE.test(v)); }
function optHm(v) { return v == null || (isString(v) && HM_RE.test(v)); }

function first(...checks) { for (const c of checks) if (c !== true) return c; return true; }
function obj(fn) { return (a) => (isObject(a) ? fn(a) : 'expected an object argument'); }
function optObj(fn = () => true) { return (a) => (a == null ? true : isObject(a) ? fn(a) : 'expected an object or nothing'); }
function idArg(label) { return (a) => (isId(a) ? true : `${label} must be a non-empty string`); }
/** A batch of staff ids (HR1 review fix L1): up to 500 non-empty strings (none → an empty answer). */
function idList(v) {
  if (!Array.isArray(v)) return 'employeeIds must be a list of staff ids';
  if (v.length > 500) return 'employeeIds must hold at most 500 ids';
  return v.every(isId) ? true : 'each of employeeIds must be a non-empty string';
}
function need(a, name) { return isId(a[name]) ? true : `${name} is required`; }
function numbers(a, names) { for (const n of names) if (!optNum(a[n])) return `${n} must be a number`; return true; }
function strings(a, names, max = 1000) { for (const n of names) if (!optStr(a[n], max)) return `${n} must be text`; return true; }
function bools(a, names) { for (const n of names) if (!optBool(a[n])) return `${n} must be true or false`; return true; }
function dates(a, names) { for (const n of names) if (!optDate(a[n])) return `${n} must be a date like 2026-10-08`; return true; }
function idPatch(label) {
  return obj((a) => first(isId(a.id) ? true : `${label} id must be a non-empty string`, isObject(a.patch) ? true : 'patch must be an object'));
}
function photo(v, { required = false, label = 'photo' } = {}) {
  if (v == null) return required ? `${label} is required` : true;
  const n = bytesSize(v);
  if (n == null) return `${label} must be binary image data`;
  if (n === 0) return `${label} is empty`;
  if (n > MAX_PHOTO_BYTES) return `${label} is too large (max ${MAX_PHOTO_BYTES / 1024 / 1024} MB)`;
  return true;
}
function clientRef(a) {
  return a.clientRef == null || (isString(a.clientRef) && /^[A-Za-z0-9_.:-]{6,100}$/.test(a.clientRef)) ? true : 'clientRef must be 6–100 letters, digits or - _ . :';
}
function token(a) { return isId(a.sessionToken) ? true : 'sessionToken is required'; }
function pin(a) { return isString(a.pin) && /^\d{1,12}$/.test(a.pin) ? true : 'pin must be digits'; }
function halfDay(a) { return a.halfDay == null || a.halfDay === 'am' || a.halfDay === 'pm' ? true : "halfDay must be 'am' or 'pm'"; }
function minutesObj(m) {
  if (m == null) return true;
  if (!isObject(m)) return 'minutes must be { normal, night, restDay, holiday }';
  for (const [k, v] of Object.entries(m)) {
    if (!['normal', 'night', 'restDay', 'holiday'].includes(k)) return `minutes.${k} is not an overtime category`;
    if (v != null && !(Number.isInteger(v) && v >= 0)) return `minutes.${k} must be whole minutes`;
  }
  return true;
}
const MONTH_ARG = optObj((a) => (optMonth(a.month) ? true : 'month must look like 2026-10'));
const LIST_PAGE = (a) => numbers(a, ['limit', 'offset']);

const scheduleFields = (a) => first(
  strings(a, ['name'], 80),
  optHm(a.startTime) && optHm(a.endTime) && optHm(a.nightStart) && optHm(a.nightEnd) ? true : 'times must look like 07:30',
  numbers(a, ['breakMin', 'graceMin']),
  a.workDays == null || (isString(a.workDays) && /^[01]{7}$/.test(a.workDays)) ? true : 'workDays must be 7 digits 0/1, Monday first',
);

const HR_VALIDATORS = {
  /* hr: settings, positions, schedules, holidays */
  'hr:getSettings': () => true,
  'hr:updateSettings': obj(() => true),
  'hr:listPositions': optObj((a) => bools(a, ['includeArchived'])),
  'hr:createPosition': obj((a) => first(strings(a, ['nameEn', 'nameKm', 'department', 'companyId'], 200), numbers(a, ['sort']))),
  'hr:updatePosition': idPatch('position'),
  'hr:listSchedules': optObj((a) => bools(a, ['includeArchived'])),
  'hr:createSchedule': obj((a) => first(isString(a.name) && a.name.trim() ? true : 'name is required', isString(a.startTime) && isString(a.endTime) ? true : 'startTime and endTime are required', scheduleFields(a), strings(a, ['companyId'], 200))),
  'hr:updateSchedule': idPatch('schedule'),
  'hr:assignSchedule': obj((a) => first(need(a, 'employeeId'), need(a, 'scheduleId'), isString(a.effectiveFrom) && DATE_RE.test(a.effectiveFrom) ? true : 'effectiveFrom must be a date like 2026-10-01')),
  'hr:listEmployeeSchedules': (a) => (isObject(a) ? idList(a.employeeIds) : idArg('staff id')(a)),
  'hr:listHolidays': optObj((a) => first(a.year == null || (isString(a.year) && /^\d{4}$/.test(a.year)) || (Number.isInteger(a.year)) ? true : 'year must look like 2026', dates(a, ['from', 'to']), bools(a, ['includeArchived']))),
  'hr:createHoliday': obj((a) => first(isString(a.date) && DATE_RE.test(a.date) ? true : 'date must look like 2026-04-14', strings(a, ['nameEn', 'nameKm', 'sourceNote', 'companyId'], 300), bools(a, ['paid']))),
  'hr:updateHoliday': idPatch('holiday'),

  /* hr: profiles, PINs, documents */
  'hr:getProfile': idArg('staff id'),
  'hr:updateProfile': idPatch('staff'),
  'hr:setStatus': obj((a) => first(need(a, 'id'), a.status === 'active' || a.status === 'suspended' ? true : 'status must be active or suspended', strings(a, ['reason'], 500), dates(a, ['fromDate', 'toDate']))),
  'hr:setPin': obj((a) => first(need(a, 'id'), isString(a.pin) && /^\d{4,8}$/.test(a.pin) ? true : 'pin must be 4 to 8 digits')),
  'hr:clearPin': idArg('staff id'),
  'hr:unlockPin': idArg('staff id'),
  'hr:listDocuments': obj((a) => first(need(a, 'employeeId'), bools(a, ['includeVoided']))),
  'hr:addDocument': obj((a) => first(need(a, 'employeeId'), need(a, 'kind'), strings(a, ['title'], 200), photo(a.bytes, { required: true, label: 'bytes' }))),
  'hr:readDocument': obj((a) => first(need(a, 'id'), bools(a, ['thumb']))),
  'hr:voidDocument': obj((a) => first(need(a, 'id'), need(a, 'reason'))),
  'hr:runJobs': () => true,
  'hr:getMonthWorkbook': MONTH_ARG,
  'hr:saveMonthWorkbook': MONTH_ARG,

  /* attendance: manager / viewer */
  'attendance:day': optObj((a) => dates(a, ['date'])),
  'attendance:monthSummary': optObj((a) => first(optMonth(a.month) ? true : 'month must look like 2026-10', strings(a, ['employeeId'], 200), bools(a, ['withDays']))),
  'attendance:listEvents': optObj((a) => first(strings(a, ['employeeId'], 200), dates(a, ['from', 'to']), bools(a, ['includeVoided']), LIST_PAGE(a))),
  'attendance:getPhoto': obj((a) => first(need(a, 'eventId'), bools(a, ['thumb']))),
  'attendance:addManual': obj((a) => first(need(a, 'employeeId'), a.kind === 'in' || a.kind === 'out' ? true : 'kind must be in or out', isNum(a.at) ? true : 'at must be a time in milliseconds', need(a, 'reason'), dates(a, ['workDate']), strings(a, ['companyId'], 200))),
  'attendance:void': obj((a) => first(need(a, 'id'), need(a, 'reason'))),
  'attendance:listReview': optObj((a) => first(
    a.status == null || ['pending', 'accepted', 'rejected', 'all'].includes(a.status) ? true : 'status must be pending, accepted, rejected or all',
    a.source == null || ['kiosk', 'phone', 'supervisor', 'manual', 'correction'].includes(a.source) ? true : 'source must be kiosk, phone, supervisor, manual or correction',
    strings(a, ['employeeId'], 200), numbers(a, ['from', 'to']), LIST_PAGE(a),
  )),
  'attendance:listAlerts': optObj((a) => first(a.status == null || ['open', 'seen', 'all'].includes(a.status) ? true : 'status must be open, seen or all', numbers(a, ['limit']))),
  'attendance:ackAlert': obj((a) => need(a, 'id')),
  'attendance:review': obj((a) => first(need(a, 'id'), a.decision === 'accept' || a.decision === 'reject' ? true : 'decision must be accept or reject', strings(a, ['reason'], 500))),
  'attendance:listCorrections': optObj((a) => first(strings(a, ['status', 'employeeId'], 200), LIST_PAGE(a))),
  'attendance:requestCorrection': obj((a) => first(need(a, 'employeeId'), isString(a.workDate) && DATE_RE.test(a.workDate) ? true : 'workDate must look like 2026-10-08', optHm(a.inTime) && optHm(a.outTime) ? true : 'times must look like 07:30', need(a, 'reason'))),
  'attendance:decideCorrection': obj((a) => first(need(a, 'id'), a.decision === 'approve' || a.decision === 'reject' ? true : 'decision must be approve or reject', optHm(a.inTime) && optHm(a.outTime) ? true : 'times must look like 07:30', strings(a, ['note'], 500))),
  'attendance:listOvertime': optObj((a) => first(optMonth(a.month) ? true : 'month must look like 2026-10', strings(a, ['employeeId'], 200), bools(a, ['includeVoided']))),
  'attendance:approveOvertime': obj((a) => first(need(a, 'employeeId'), isString(a.workDate) && DATE_RE.test(a.workDate) ? true : 'workDate must look like 2026-10-08', minutesObj(a.minutes), strings(a, ['note'], 500))),
  'attendance:revokeOvertime': obj((a) => first(need(a, 'id'), need(a, 'reason'))),
  'attendance:listLateness': optObj((a) => first(optMonth(a.month) ? true : 'month must look like 2026-10', strings(a, ['employeeId'], 200))),
  'attendance:confirmLateness': obj((a) => first(need(a, 'employeeId'), isString(a.month) && MONTH_RE.test(a.month) ? true : 'month must look like 2026-10', numbers(a, ['lateMinutes', 'earlyLeaveMinutes']), strings(a, ['note'], 500))),

  /* attendance: own (phone) + supervisor */
  'attendance:clockSelf': obj((a) => first(photo(a.photo, { required: true }), clientRef(a), numbers(a, ['queuedForMs']))),
  'attendance:mine': () => true,
  'attendance:requestCorrectionSelf': obj((a) => first(isString(a.workDate) && DATE_RE.test(a.workDate) ? true : 'workDate must look like 2026-10-08', optHm(a.inTime) && optHm(a.outTime) ? true : 'times must look like 07:30', need(a, 'reason'), clientRef(a))),
  'attendance:crew': () => true,
  'attendance:markCrew': obj((a) => first(need(a, 'employeeId'), a.kind == null || a.kind === 'in' || a.kind === 'out' ? true : 'kind must be in or out', photo(a.photo), strings(a, ['note'], 500), clientRef(a), numbers(a, ['queuedForMs']))),

  /* leave */
  'leave:listTypes': optObj((a) => bools(a, ['includeArchived'])),
  'leave:createType': obj((a) => first(need(a, 'code'), strings(a, ['nameEn', 'nameKm', 'accrual', 'note', 'companyId'], 1000), numbers(a, ['accrualDays', 'maxBalance', 'carryOverMax', 'maxDaysPerRequest', 'sort']), bools(a, ['paid', 'tracksBalance', 'needsDocument', 'countCalendarDays']))),
  'leave:updateType': idPatch('leave type'),
  'leave:balances': obj((a) => (a.employeeIds != null ? idList(a.employeeIds) : need(a, 'employeeId'))),
  'leave:ledger': obj((a) => first(need(a, 'employeeId'), strings(a, ['leaveTypeId'], 200), numbers(a, ['limit']))),
  'leave:listRequests': optObj((a) => first(strings(a, ['status', 'employeeId'], 200), dates(a, ['from', 'to']), LIST_PAGE(a))),
  'leave:request': obj((a) => first(need(a, 'employeeId'), need(a, 'leaveTypeId'), isString(a.fromDate) && DATE_RE.test(a.fromDate) ? true : 'fromDate must look like 2026-10-08', dates(a, ['toDate']), halfDay(a), strings(a, ['reason'], 1000))),
  'leave:decide': obj((a) => first(need(a, 'id'), a.decision === 'approve' || a.decision === 'reject' ? true : 'decision must be approve or reject', strings(a, ['note'], 1000), bools(a, ['allowNegative']))),
  'leave:cancel': obj((a) => first(need(a, 'id'), strings(a, ['reason'], 500))),
  'leave:adjust': obj((a) => first(need(a, 'employeeId'), need(a, 'leaveTypeId'), isNum(a.days) ? true : 'days must be a number', dates(a, ['date']), need(a, 'note'))),
  'leave:requestSelf': obj((a) => first(need(a, 'leaveTypeId'), isString(a.fromDate) && DATE_RE.test(a.fromDate) ? true : 'fromDate must look like 2026-10-08', dates(a, ['toDate']), halfDay(a), strings(a, ['reason'], 1000), clientRef(a))),
  'leave:cancelSelf': obj((a) => first(need(a, 'id'), strings(a, ['reason'], 500))),

  /* kiosk */
  'kiosk:tiles': () => true,
  'kiosk:tilePhoto': obj((a) => need(a, 'id')),
  'kiosk:signIn': obj((a) => first(need(a, 'employeeId'), pin(a), bools(a, ['preview']))),
  'kiosk:signOut': obj((a) => token(a)),
  // A photo, or `noPhoto: true` (accepted by the handler only after a manager allowed it on this session).
  'kiosk:clock': obj((a) => first(token(a), bools(a, ['noPhoto']),
    a.noPhoto === true ? (a.photo == null ? true : 'send a photo or noPhoto, not both') : photo(a.photo, { required: true }))),
  'kiosk:me': obj((a) => token(a)),
  'kiosk:requestLeave': obj((a) => first(token(a), need(a, 'leaveTypeId'), isString(a.fromDate) && DATE_RE.test(a.fromDate) ? true : 'fromDate must look like 2026-10-08', dates(a, ['toDate']), halfDay(a), strings(a, ['reason'], 1000))),
  'kiosk:requestCorrection': obj((a) => first(token(a), isString(a.workDate) && DATE_RE.test(a.workDate) ? true : 'workDate must look like 2026-10-08', optHm(a.inTime) && optHm(a.outTime) ? true : 'times must look like 07:30', need(a, 'reason'))),
  'kiosk:verifyManagerPin': obj((a) => first(need(a, 'employeeId'), pin(a), purpose(a), bools(a, ['preview']),
    a.purpose === 'no-photo' ? token(a) : (a.sessionToken == null || isId(a.sessionToken) ? true : 'sessionToken must be text'))),

  /* kioskMode:* — LOCAL channels of the kiosk Mac itself (main/kioskWindow.js):
   * exposeLocal in main/ipc/kioskMode.js, handleLocal in main/client/index.js.
   * Same validators on both paths. */
  'kioskMode:status': () => true,
  'kioskMode:askCamera': () => true,
  'kioskMode:newRecoveryCode': () => true,
  'kioskMode:enable': optObj((a) => bools(a, ['openAtLogin'])),
  'kioskMode:logError': obj((a) => first(isString(a.message) && a.message.length <= 2000 ? true : 'message must be text (at most 2000 characters)', strings(a, ['stack'], 8000))),
  'kioskMode:recover': obj((a) => (isString(a.code) && a.code.length > 0 && a.code.length <= 64 ? true : 'code must be text')),
  'kioskMode:leave': obj((a) => first(need(a, 'employeeId'), pin(a))),
  'kioskMode:quit': obj((a) => first(need(a, 'employeeId'), pin(a))),
};

function purpose(a) {
  return a.purpose == null || ['leave', 'quit', 'no-photo'].includes(a.purpose) ? true : "purpose must be 'leave', 'quit' or 'no-photo'";
}

module.exports = { HR_VALIDATORS };
