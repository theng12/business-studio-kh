const { bytesSize } = require('./fuelValidators');

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const text = (v, max) => v == null || (typeof v === 'string' && v.length <= max);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const date = (v) => v == null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
const noArgs = (a) => a == null || (object(a) && Object.keys(a).length === 0) || 'expected no argument';

function shape(keys, check = () => true, optional = false) {
  return (a) => {
    if (optional && a == null) return true;
    if (!object(a)) return 'expected an object argument';
    const extra = Object.keys(a).find(k => !keys.includes(k));
    if (extra) return `${extra} is not accepted`;
    return check(a);
  };
}

function fields(a, { ids = [], texts = [], dates = [], numbers = [] } = {}) {
  for (const key of ids) if (a[key] != null && a[key] !== '' && !id(a[key])) return `${key} must be an id`;
  for (const key of texts) if (!text(a[key], key === 'memo' ? 2000 : 200)) return `${key} must be text`;
  for (const key of dates) if (!date(a[key])) return `${key} must look like 2026-03-12`;
  for (const key of numbers) if (a[key] != null && !integer(a[key])) return `${key} must be a non-negative whole number`;
  return true;
}

const byId = shape(['id'], a => id(a.id) || 'id is required');
const withReason = shape(['id', 'reason'], a => id(a.id)
  ? (typeof a.reason === 'string' && a.reason.trim().length > 0 && a.reason.length <= 1000) || 'reason is required'
  : 'id is required');
const options = shape(['includeArchived'], a => a.includeArchived == null || typeof a.includeArchived === 'boolean' || 'includeArchived must be true or false', true);

const FINANCE_VALIDATORS = {
  'finance:context': noArgs,
  'finance:get': a => id(a) || 'expense id is required',
  'finance:list': shape(['month', 'branchId', 'categoryId', 'status', 'q', 'page', 'pageSize'], a => {
    const basic = fields(a, { ids: ['branchId', 'categoryId'], texts: ['status', 'q'] });
    if (basic !== true) return basic;
    if (a.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)) return 'month must look like 2026-03';
    if (a.status && !['draft', 'pending', 'posted', 'rejected', 'cancelled', 'reversed'].includes(a.status)) return 'unknown expense status';
    if (a.page != null && (!integer(a.page) || a.page < 1)) return 'page must be a positive whole number';
    return a.pageSize == null || [25, 50, 100, 200].includes(a.pageSize) || 'pageSize must be 25, 50, 100 or 200';
  }, true),
  'finance:saveDraft': shape(['id', 'companyId', 'branchId', 'accountId', 'categoryId', 'expenseDate', 'amountMinor', 'currency', 'memo', 'revision'], a => {
    const basic = fields(a, { ids: ['id', 'companyId', 'branchId', 'accountId', 'categoryId'], texts: ['memo'], dates: ['expenseDate'], numbers: ['amountMinor', 'revision'] });
    if (basic !== true) return basic;
    if (!id(a.id)) return 'a stable draft id is required';
    return a.currency == null || a.currency === '' || ['USD', 'KHR'].includes(a.currency) || 'currency must be USD or KHR';
  }),
  'finance:submit': byId,
  'finance:approve': byId,
  'finance:reject': withReason,
  'finance:cancel': withReason,
  'finance:reverse': withReason,
  'finance:accounts': options,
  'finance:saveAccount': shape(['id', 'companyId', 'name', 'kind', 'branchId', 'currency', 'openingMinor', 'openingDate', 'archivedAt'], a => {
    const basic = fields(a, { ids: ['id', 'companyId', 'branchId'], texts: ['name', 'archivedAt'], dates: ['openingDate'], numbers: ['openingMinor'] });
    if (basic !== true) return basic;
    if (a.openingDate != null && a.openingMinor == null) return 'openingMinor is required with openingDate';
    if (a.openingMinor > 0 && !a.openingDate) return 'openingDate is required with an opening balance';
    if (a.kind != null && !['cash', 'bank'].includes(a.kind)) return 'kind must be cash or bank';
    return a.currency == null || ['USD', 'KHR'].includes(a.currency) || 'currency must be USD or KHR';
  }),
  'finance:saveCategory': shape(['id', 'companyId', 'name', 'sort', 'archivedAt'], a => fields(a, {
    ids: ['id', 'companyId'], texts: ['name', 'archivedAt'], numbers: ['sort'],
  })),
  'finance:updateSettings': shape(['approvalThresholdMinor'], a => integer(a.approvalThresholdMinor) || 'approvalThresholdMinor must be a non-negative whole number of US cents'),
  'finance:reports': shape(['month'], a => typeof a.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(a.month) || 'month must look like 2026-03'),
  'finance:setReceipt': shape(['expenseId', 'bytes', 'originalName'], a => {
    if (!id(a.expenseId)) return 'expenseId is required';
    if (!text(a.originalName, 200)) return 'originalName must be text';
    const size = bytesSize(a.bytes);
    if (size == null || size <= 0) return 'bytes must contain an image';
    return size <= 15 * 1024 * 1024 || 'Receipt photo is too large (max 15 MB)';
  }),
  'finance:getReceipt': shape(['expenseId'], a => id(a.expenseId) || 'expenseId is required'),
  'finance:removeReceipt': shape(['expenseId'], a => id(a.expenseId) || 'expenseId is required'),
  'fx:getShared': noArgs,
  'fx:setShared': shape(['khrPerUsd'], a => typeof a.khrPerUsd === 'number' && Number.isFinite(a.khrPerUsd)
    && a.khrPerUsd >= 100 && a.khrPerUsd <= 100000 || 'Riel per dollar must be between 100 and 100000'),
};

module.exports = { FINANCE_VALIDATORS };
