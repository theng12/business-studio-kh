import { formatMinor } from './loansModel.js';

const INTEGER_FIELDS = new Set(['originalPrincipalMinor', 'currentPrincipalMinor', 'unpaidInterestMinor', 'installmentMinor', 'interestFreeMonths']);
const DECIMAL_FIELDS = new Set(['ratePercent', 'maxDeductionPercent']);
const BOOLEAN_FIELDS = new Set(['deductViaPayroll']);
const blank = (value) => value == null || (typeof value === 'string' && !value.trim());

const norm = (value) => String(value ?? '').toLowerCase().normalize('NFKC').replace(/[\s_\-./()]+/g, ' ').trim();

export function guessMapping(headers, columns) {
  const used = new Set();
  return Object.fromEntries((Array.isArray(headers) ? headers : []).map((header) => {
    const normalized = norm(header);
    const column = (columns || []).find((item) => !used.has(item.key)
      && [item.key, item.label, ...(item.aliases || [])].some((alias) => norm(alias) === normalized));
    if (column) used.add(column.key);
    return [header, column?.key || ''];
  }));
}

export function hasUniqueTargets(mapping) {
  const targets = Object.values(mapping || {}).filter(Boolean);
  return new Set(targets).size === targets.length;
}

function normalizeValue(key, value) {
  if (typeof value !== 'string') {
    if (BOOLEAN_FIELDS.has(key) && (value === 0 || value === 1)) return Boolean(value);
    return value;
  }
  const text = value.trim();
  if (!text) return '';
  if (BOOLEAN_FIELDS.has(key)) {
    if (/^(true|1)$/i.test(text)) return true;
    if (/^(false|0)$/i.test(text)) return false;
    return text;
  }
  if (INTEGER_FIELDS.has(key)) {
    if (!/^[+-]?\d+$/.test(text)) return text;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : text;
  }
  if (DECIMAL_FIELDS.has(key)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return text;
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  return text;
}

export function buildImportRows(sheetRows, mapping) {
  if (!hasUniqueTargets(mapping)) return [];
  const output = [];
  (Array.isArray(sheetRows) ? sheetRows : []).forEach((source, index) => {
    const row = {};
    for (const [header, key] of Object.entries(mapping || {})) {
      if (!key) continue;
      const raw = source?.[header];
      if (blank(raw)) continue;
      row[key] = normalizeValue(key, raw);
    }
    if (Object.keys(row).length) output.push({ ...row, rowNo: index + 2 });
  });
  return output;
}

export function sampleValues(rows, headers) {
  return Object.fromEntries((headers || []).map((header) => {
    const row = (rows || []).find((item) => !blank(item?.[header]));
    return [header, row ? String(row[header]) : ''];
  }));
}

export function formatImportCell(value, key, currency) {
  const raw = String(value ?? '');
  const text = typeof value === 'string' ? value.trim() : value;
  if (!['originalPrincipalMinor', 'currentPrincipalMinor', 'unpaidInterestMinor', 'installmentMinor'].includes(key)
    || (typeof text === 'string' && !/^\d+$/.test(text)) || !Number.isSafeInteger(Number(text)) || Number(text) < 0 || !['USD', 'KHR'].includes(currency)) return raw;
  return `${raw} · ${formatMinor(Number(text), currency)}`;
}

export const isImportCompanyCurrent = (requestCompanyId, activeCompanyId) => Boolean(requestCompanyId) && requestCompanyId === activeCompanyId;

export function makeImportOperation(companyId, rows, operationId) {
  const snapshot = (rows || []).map((row) => Object.freeze({ ...row }));
  Object.freeze(snapshot);
  return Object.freeze({ companyId, operationId, rows: snapshot });
}

export const retryImportOperation = (operation) => operation;

export function importApplyOutcome(result) {
  if (result?.applied === true) return 'applied';
  if (result?.applied === false) return 'rejected';
  return 'unknown';
}
