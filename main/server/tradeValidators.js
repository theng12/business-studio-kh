/**
 * Trade Finance argument shapes (docs/TRADE_FINANCE_PLAN.md §3).
 *
 * Same contract as financeValidators.js: `channel → (args) => true | string`.
 * The DB layer still owns the real rules (a repayment cannot exceed the
 * outstanding principal, a reference must be unique); this file only refuses
 * an obviously malformed shape before it reaches the database.
 */

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const text = (v, max = 500) => v == null || (typeof v === 'string' && v.length <= max);
const whole = (v) => Number.isSafeInteger(v) && v >= 0;
const positiveWhole = (v) => Number.isSafeInteger(v) && v > 0;
const number = (v) => typeof v === 'number' && Number.isFinite(v);
const rate = (v) => v == null || (number(v) && v >= 0);
const dateOrBlank = (v) => v == null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
const noArgs = (a) => a == null || (object(a) && Object.keys(a).length === 0) || 'expected no argument';

function shape(keys, check = () => true, optional = false) {
  return (a) => {
    if (optional && a == null) return true;
    if (!object(a)) return 'expected an object argument';
    const extra = Object.keys(a).find((k) => !keys.includes(k));
    if (extra) return `${extra} is not accepted`;
    return check(a);
  };
}

const KINDS = ['OD', 'RC', 'TR', 'Other'];
const CURRENCIES = ['USD', 'KHR'];
const BASES = ['drawn', 'balance'];
const BILLINGS = ['at_repayment', 'month_end_capitalised'];
const FREQS = ['monthly', 'quarterly', 'yearly'];
const STATUSES = ['active', 'closed', 'cancelled'];

const FACILITY_KEYS = ['bankId', 'kind', 'name', 'currency', 'limitMinor', 'rate', 'dayCount',
  'revolving', 'hasMaturity', 'interestBasis', 'interestBilling', 'commitmentRate',
  'commitmentFreq', 'termDays', 'note', 'rateEffectiveDate', 'rateNote'];
const DRAWDOWN_KEYS = ['clientUuid', 'facilityId', 'principalMinor', 'valueDate', 'maturityDate',
  'rate', 'reference', 'settleCurrency', 'fxRate', 'purchaseOrderId', 'note'];

function facilityFields(a, { requireFacility = false } = {}) {
  if (a.bankId != null && !id(a.bankId)) return 'bankId must be an id';
  if (requireFacility && !id(a.bankId)) return 'bankId is required';
  if (!text(a.name, 120)) return 'name must be text';
  if (requireFacility && !(typeof a.name === 'string' && a.name.trim())) return 'name is required';
  if (a.kind != null && !KINDS.includes(a.kind)) return 'kind must be OD, RC, TR or Other';
  if (a.currency != null && !CURRENCIES.includes(a.currency)) return 'currency must be USD or KHR';
  if (a.limitMinor != null && !whole(a.limitMinor)) return 'limitMinor must be a whole amount';
  if (!rate(a.rate)) return 'rate must be a non-negative number';
  if (a.dayCount != null && ![360, 365].includes(a.dayCount)) return 'dayCount must be 360 or 365';
  if (a.revolving != null && typeof a.revolving !== 'boolean') return 'revolving must be true or false';
  if (a.hasMaturity != null && typeof a.hasMaturity !== 'boolean') return 'hasMaturity must be true or false';
  if (a.interestBasis != null && !BASES.includes(a.interestBasis)) return 'unknown interest basis';
  if (a.interestBilling != null && !BILLINGS.includes(a.interestBilling)) return 'unknown interest billing';
  if (!rate(a.commitmentRate)) return 'commitmentRate must be a non-negative number';
  if (a.commitmentFreq != null && !FREQS.includes(a.commitmentFreq)) return 'unknown commitment frequency';
  if (a.termDays != null && (!Number.isSafeInteger(a.termDays) || a.termDays <= 0)) return 'termDays must be a whole number of days';
  if (!text(a.note)) return 'note must be text';
  if (!dateOrBlank(a.rateEffectiveDate)) return 'rateEffectiveDate must look like 2026-03-12';
  return true;
}

function drawdownFields(a, { requireCore = false } = {}) {
  if (!text(a.clientUuid, 80)) return 'clientUuid must be text';
  if (a.facilityId != null && !id(a.facilityId)) return 'facilityId must be an id';
  if (requireCore && !id(a.facilityId)) return 'facilityId is required';
  if (a.principalMinor != null && !positiveWhole(a.principalMinor)) return 'principalMinor must be a positive whole amount';
  if (requireCore && !positiveWhole(a.principalMinor)) return 'principalMinor is required';
  if (!dateOrBlank(a.valueDate)) return 'valueDate must look like 2026-03-12';
  if (requireCore && !a.valueDate) return 'valueDate is required';
  if (!dateOrBlank(a.maturityDate)) return 'maturityDate must look like 2026-03-12';
  if (!rate(a.rate)) return 'rate must be a non-negative number';
  if (!text(a.reference, 80)) return 'reference must be text';
  if (a.settleCurrency != null && a.settleCurrency !== '' && !/^[A-Za-z]{3}$/.test(a.settleCurrency)) return 'settleCurrency must be a three-letter code';
  if (a.fxRate != null && !(number(a.fxRate) && a.fxRate > 0)) return 'fxRate must be a positive number';
  if (a.purchaseOrderId != null && a.purchaseOrderId !== '' && !id(a.purchaseOrderId)) return 'purchaseOrderId must be an id';
  if (!text(a.note)) return 'note must be text';
  return true;
}

const TRADE_VALIDATORS = {
  'trade:context': noArgs,

  'trade:banks:create': shape(['name', 'note'], (a) => {
    if (!(typeof a.name === 'string' && a.name.trim())) return 'name is required';
    return text(a.note) || 'note must be text';
  }),
  'trade:banks:update': shape(['id', 'patch'], (a) => {
    if (!id(a.id)) return 'id is required';
    return shape(['name', 'note'], (p) => {
      if (p.name != null && !(typeof p.name === 'string' && p.name.trim())) return 'name must be text';
      return text(p.note) || 'note must be text';
    })(a.patch);
  }),
  'trade:banks:archive': shape(['id'], (a) => id(a.id) || 'id is required'),

  'trade:facilities:list': shape(['includeArchived'], (a) =>
    a.includeArchived == null || typeof a.includeArchived === 'boolean' || 'includeArchived must be true or false', true),
  'trade:facilities:get': shape(['id'], (a) => id(a.id) || 'id is required'),
  'trade:facilities:create': shape(FACILITY_KEYS, (a) => facilityFields(a, { requireFacility: true })),
  'trade:facilities:update': shape(['id', 'patch'], (a) => {
    if (!id(a.id)) return 'id is required';
    return shape(FACILITY_KEYS, (p) => facilityFields(p))(a.patch);
  }),
  'trade:facilities:setActive': shape(['id', 'active'], (a) => {
    if (!id(a.id)) return 'id is required';
    return typeof a.active === 'boolean' || 'active must be true or false';
  }),

  'trade:drawdowns:list': shape(['facilityId', 'status', 'q', 'page', 'pageSize'], (a) => {
    if (a.facilityId != null && a.facilityId !== '' && !id(a.facilityId)) return 'facilityId must be an id';
    if (a.status != null && a.status !== '' && a.status !== 'all' && !STATUSES.includes(a.status)) return 'unknown drawdown status';
    if (!text(a.q, 80)) return 'q must be text';
    if (a.page != null && (!Number.isSafeInteger(a.page) || a.page < 1)) return 'page must be a positive whole number';
    if (a.pageSize != null && ![25, 50, 100, 200].includes(a.pageSize)) return 'pageSize must be 25, 50, 100 or 200';
    return true;
  }, true),
  'trade:drawdowns:get': shape(['id'], (a) => id(a.id) || 'id is required'),
  'trade:drawdowns:create': shape(DRAWDOWN_KEYS, (a) => drawdownFields(a, { requireCore: true })),
  'trade:drawdowns:update': shape(['id', 'patch'], (a) => {
    if (!id(a.id)) return 'id is required';
    return shape(DRAWDOWN_KEYS, (p) => drawdownFields(p))(a.patch);
  }),
  'trade:drawdowns:setStatus': shape(['id', 'status'], (a) => {
    if (!id(a.id)) return 'id is required';
    return STATUSES.includes(a.status) || 'status must be active, closed or cancelled';
  }),

  'trade:repayments:add': shape(['clientUuid', 'drawdownId', 'principalMinor', 'interestMinor', 'paidOn', 'note'], (a) => {
    if (!text(a.clientUuid, 80)) return 'clientUuid must be text';
    if (!id(a.drawdownId)) return 'drawdownId is required';
    if (a.principalMinor != null && !whole(a.principalMinor)) return 'principalMinor must be a whole amount';
    if (a.interestMinor != null && !whole(a.interestMinor)) return 'interestMinor must be a whole amount';
    if (!whole(a.principalMinor || 0) || !whole(a.interestMinor || 0)) return 'principalMinor and interestMinor must be whole amounts';
    if (!dateOrBlank(a.paidOn) || !a.paidOn) return 'paidOn must look like 2026-03-12';
    return text(a.note) || 'note must be text';
  }),

  'trade:interest:list': shape(['facilityId', 'drawdownId', 'page', 'pageSize'], (a) => {
    if (a.facilityId != null && a.facilityId !== '' && !id(a.facilityId)) return 'facilityId must be an id';
    if (a.drawdownId != null && a.drawdownId !== '' && !id(a.drawdownId)) return 'drawdownId must be an id';
    if (a.page != null && (!Number.isSafeInteger(a.page) || a.page < 1)) return 'page must be a positive whole number';
    if (a.pageSize != null && ![25, 50, 100, 200].includes(a.pageSize)) return 'pageSize must be 25, 50, 100 or 200';
    return true;
  }, true),
  'trade:interest:preview': noArgs,
  'trade:reports:summary': noArgs,

  /* Phase B */
  'trade:movements:list': shape(['facilityId'], (a) => id(a.facilityId) || 'facilityId is required'),
  'trade:movements:add': shape(['clientUuid', 'facilityId', 'entryDate', 'kind', 'amountMinor', 'note'], (a) => {
    if (!text(a.clientUuid, 80)) return 'clientUuid must be text';
    if (!id(a.facilityId)) return 'facilityId is required';
    if (!dateOrBlank(a.entryDate) || !a.entryDate) return 'entryDate must look like 2026-03-12';
    if (!['opening', 'draw', 'repay', 'adjustment'].includes(a.kind)) return 'unknown movement kind';
    if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor === 0) return 'amountMinor must be a whole amount that is not zero';
    return text(a.note) || 'note must be text';
  }),
  'trade:capitalisation:preview': noArgs,
  'trade:capitalisation:run': noArgs,
  'trade:reconciliation:list': noArgs,
  'trade:reconciliation:add': shape(['facilityId', 'drawdownId', 'periodStart', 'periodEnd', 'amountMinor', 'note'], (a) => {
    if (!id(a.facilityId)) return 'facilityId is required';
    if (a.drawdownId != null && a.drawdownId !== '' && !id(a.drawdownId)) return 'drawdownId must be an id';
    if (!dateOrBlank(a.periodStart) || !a.periodStart) return 'periodStart must look like 2026-03-12';
    if (!dateOrBlank(a.periodEnd) || !a.periodEnd) return 'periodEnd must look like 2026-03-12';
    if (!whole(a.amountMinor)) return 'amountMinor must be a whole non-negative amount';
    return text(a.note) || 'note must be text';
  }),
  'trade:fees:list': shape(['limit'], (a) => a.limit == null || (Number.isSafeInteger(a.limit) && a.limit > 0) || 'limit must be a positive whole number', true),
  'trade:fees:add': shape(['clientUuid', 'facilityId', 'drawdownId', 'kind', 'amountMinor', 'currency', 'feeDate', 'note'], (a) => {
    if (!text(a.clientUuid, 80)) return 'clientUuid must be text';
    if (a.facilityId != null && a.facilityId !== '' && !id(a.facilityId)) return 'facilityId must be an id';
    if (a.drawdownId != null && a.drawdownId !== '' && !id(a.drawdownId)) return 'drawdownId must be an id';
    if (!(typeof a.kind === 'string' && a.kind.trim())) return 'kind is required';
    if (!whole(a.amountMinor)) return 'amountMinor must be a whole non-negative amount';
    if (a.currency != null && a.currency !== '' && !/^[A-Za-z]{3}$/.test(a.currency)) return 'currency must be a three-letter code';
    if (!dateOrBlank(a.feeDate) || !a.feeDate) return 'feeDate must look like 2026-03-12';
    return text(a.note) || 'note must be text';
  }),
  'trade:recurring:list': noArgs,
  'trade:recurring:add': shape(['facilityId', 'kind', 'amountMinor', 'currency', 'frequency', 'nextDate', 'enabled', 'note'], (a) => {
    if (a.facilityId != null && a.facilityId !== '' && !id(a.facilityId)) return 'facilityId must be an id';
    if (!(typeof a.kind === 'string' && a.kind.trim())) return 'kind is required';
    if (!whole(a.amountMinor)) return 'amountMinor must be a whole non-negative amount';
    if (a.currency != null && a.currency !== '' && !/^[A-Za-z]{3}$/.test(a.currency)) return 'currency must be a three-letter code';
    if (a.frequency != null && !FREQS.includes(a.frequency)) return 'unknown frequency';
    if (!dateOrBlank(a.nextDate) || !a.nextDate) return 'nextDate must look like 2026-03-12';
    if (a.enabled != null && typeof a.enabled !== 'boolean') return 'enabled must be true or false';
    return text(a.note) || 'note must be text';
  }),
  'trade:recurring:update': shape(['id', 'patch'], (a) => {
    if (!id(a.id)) return 'id is required';
    return shape(['kind', 'amountMinor', 'currency', 'frequency', 'nextDate', 'enabled', 'note'], (p) => {
      if (p.kind != null && !(typeof p.kind === 'string' && p.kind.trim())) return 'kind must be text';
      if (p.amountMinor != null && !whole(p.amountMinor)) return 'amountMinor must be a whole non-negative amount';
      if (p.currency != null && !/^[A-Za-z]{3}$/.test(p.currency)) return 'currency must be a three-letter code';
      if (p.frequency != null && !FREQS.includes(p.frequency)) return 'unknown frequency';
      if (!dateOrBlank(p.nextDate)) return 'nextDate must look like 2026-03-12';
      if (p.enabled != null && typeof p.enabled !== 'boolean') return 'enabled must be true or false';
      return text(p.note) || 'note must be text';
    })(a.patch);
  }),
  'trade:recurring:postDue': noArgs,

  /* Phase C */
  'trade:reminders:due': noArgs,
  'trade:reminders:rules': noArgs,
  'trade:reminders:rules:save': shape(['id', 'facilityId', 'leadDays', 'label', 'enabled'], (a) => {
    if (a.id != null && !id(a.id)) return 'id must be an id';
    if (a.facilityId != null && a.facilityId !== '' && !id(a.facilityId)) return 'facilityId must be an id';
    if (!Number.isSafeInteger(a.leadDays) || a.leadDays < 0 || a.leadDays > 365) return 'leadDays must be a whole number from 0 to 365';
    if (!text(a.label, 120)) return 'label must be text';
    if (a.enabled != null && typeof a.enabled !== 'boolean') return 'enabled must be true or false';
    return true;
  }),
  'trade:reminders:snooze': shape(['id', 'until'], (a) => {
    if (!id(a.id)) return 'id is required';
    return dateOrBlank(a.until) || 'until must look like 2026-03-12';
  }),
  'trade:reminders:log': shape(['limit'], (a) => a.limit == null || (Number.isSafeInteger(a.limit) && a.limit > 0) || 'limit must be a positive whole number', true),
  'trade:settings:get': noArgs,
  'trade:settings:save': shape(['autoPost'], (a) =>
    a.autoPost == null || typeof a.autoPost === 'boolean' || 'autoPost must be true or false', true),
};

module.exports = { TRADE_VALIDATORS };
