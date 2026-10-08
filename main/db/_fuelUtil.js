/**
 * Small shared helpers for the staff + fuel DB modules (F1).
 */

const crypto = require('node:crypto');
const { getCallerUserId } = require('./_util');

function uuid() { return crypto.randomUUID(); }

function audit(entityType, entityId, action, { before = null, after = null } = {}) {
  try {
    require('./auditLog').log({ entityType, entityId, action, before, after });
  } catch (_) { /* audit must never break the write it records */ }
}

function str(v, max = 500) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

function badRequest(message) {
  const err = new Error(message);
  err.code = 'BAD_REQUEST';
  return err;
}

const FUEL_TYPES = ['diesel', 'gasoline', 'other'];
const CURRENCIES = ['KHR', 'USD'];

function fuelType(v, fallback = 'diesel') {
  if (v == null || v === '') return fallback;
  if (!FUEL_TYPES.includes(v)) throw badRequest('Fuel type must be diesel, gasoline or other');
  return v;
}

function currency(v, fallback = 'KHR') {
  if (v == null || v === '') return fallback;
  if (!CURRENCIES.includes(v)) throw badRequest('Currency must be KHR or USD');
  return v;
}

module.exports = { uuid, audit, str, num, int, badRequest, fuelType, currency, getCallerUserId, FUEL_TYPES, CURRENCIES };
