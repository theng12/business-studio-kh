/**
 * Pick & Pack argument validators (main/server/validators.js merges these).
 *
 * Same contract as every other validator file: `(args) => true | "reason"`.
 * The RPC dispatcher and the local `expose()` path both use them, so a bad
 * argument gives the same "Bad request: …" on a phone and on the Mac.
 */

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function nonEmpty(v) { return isString(v) && v.trim().length > 0; }
function orderId(a) { return nonEmpty(a) ? true : 'order id must be a non-empty string'; }

const PACK_VALIDATORS = {
  'pack:list': (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'pack:get': orderId,
  'pack:scan': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!nonEmpty(a.orderId)) return 'orderId must be a non-empty string';
    if (!nonEmpty(a.code)) return 'code must be a non-empty string';
    return true;
  },
  'pack:confirmLine': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!nonEmpty(a.orderId)) return 'orderId must be a non-empty string';
    if (!nonEmpty(a.lineId)) return 'lineId must be a non-empty string';
    if (a.delta !== undefined && (typeof a.delta !== 'number' || !Number.isFinite(a.delta))) return 'delta must be a number';
    return true;
  },
  'pack:addPhoto': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!nonEmpty(a.orderId)) return 'orderId must be a non-empty string';
    if (a.kind !== 'contents' && a.kind !== 'sealed') return 'kind must be contents or sealed';
    if (a.bytes == null) return 'missing required field: bytes';
    return true;
  },
  'pack:getPhoto': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!nonEmpty(a.photoId)) return 'photoId must be a non-empty string';
    if (a.thumb !== undefined && typeof a.thumb !== 'boolean') return 'thumb must be a boolean';
    return true;
  },
  'pack:seal': orderId,
  'pack:getSettings': () => true,
  'pack:updateSettings': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    const v = a.photoRequiredAboveMinor;
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return 'photoRequiredAboveMinor must be zero or more, or null';
    }
    if (a.currency !== undefined && a.currency !== null && !isString(a.currency)) return 'currency must be a string or null';
    return true;
  },

  'orders:list': (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'orders:get': orderId,
  'orders:update': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!nonEmpty(a.id)) return 'id must be a non-empty string';
    if (!isObject(a.patch)) return 'patch must be an object';
    if (a.patch.lines !== undefined) {
      if (!Array.isArray(a.patch.lines)) return 'patch.lines must be a list';
      for (const line of a.patch.lines) {
        if (!isObject(line) || !nonEmpty(line.id)) return 'each line needs an id';
        if (line.quantity !== undefined && (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity))) return 'line quantity must be a number';
      }
    }
    return true;
  },
  'orders:remove': orderId,
  'orders:import': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!nonEmpty(a.source)) return 'source is required';
    if (!Array.isArray(a.rows)) return 'rows must be a list';
    if (a.rows.length > 5000) return 'too many rows in one import (max 5000)';
    for (const row of a.rows) if (!isObject(row)) return 'each row must be an object';
    if (a.dryRun !== undefined && typeof a.dryRun !== 'boolean') return 'dryRun must be a boolean';
    return true;
  },
  'orders:quickAdd': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!Array.isArray(a.lines) || a.lines.length === 0) return 'lines must be a non-empty list';
    if (a.lines.length > 500) return 'too many items on one order (max 500)';
    for (const line of a.lines) {
      if (!isObject(line)) return 'each line must be an object';
      if (line.quantity !== undefined && (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity))) return 'line quantity must be a number';
    }
    return true;
  },
  'orders:getMapping': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    return nonEmpty(a.source) ? true : 'source is required';
  },
  'orders:saveMapping': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!nonEmpty(a.source)) return 'source is required';
    if (!isObject(a.mapping)) return 'mapping must be an object';
    return true;
  },
  'orders:lookupProduct': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    return nonEmpty(a.code) ? true : 'code must be a non-empty string';
  },
};

module.exports = { PACK_VALIDATORS };
