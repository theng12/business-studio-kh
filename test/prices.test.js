/**
 * Price reading/formatting shared by the catalog + social renderers.
 *
 * The regression this guards: v0.1.55 changed a named price group's stored
 * value from a bare number to `{ amount, currency }`, but the renderers still
 * read the map as a scalar. `Number({ amount: 88 })` is NaN, so a catalog with
 * a custom price group would have printed "$NaN" — and because the old code
 * was `prices[group] ?? priceRetail`, the fallback never fired (the object is
 * truthy). Both renderers now go through these helpers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { priceEntry, formatPriceEntry } = require('../main/util/prices');
const { resolvePrice, resolvePriceEntry } = require('../main/util/socialGridModel');

const product = {
  priceRetail: 12.5,
  priceRetailCurrency: 'USD',
  priceWholesale: 40000,
  priceWholesaleCurrency: 'KHR',
  prices: {
    export: { amount: 88, currency: 'CNY' },
    legacy: 5,
  },
};

test('priceEntry reads the real columns with their own currency', () => {
  assert.deepEqual(priceEntry(product, 'retail'), { amount: 12.5, currency: 'USD' });
  assert.deepEqual(priceEntry(product, 'wholesale'), { amount: 40000, currency: 'KHR' });
});

test('priceEntry reads a named group stored as { amount, currency }', () => {
  assert.deepEqual(priceEntry(product, 'export'), { amount: 88, currency: 'CNY' });
});

test('priceEntry still reads a legacy bare-number group', () => {
  assert.deepEqual(priceEntry(product, 'legacy'), { amount: 5, currency: null });
});

test('priceEntry returns a null amount for a missing or blank price', () => {
  assert.deepEqual(priceEntry(product, 'nope'), { amount: null, currency: null });
  assert.deepEqual(priceEntry({ prices: { x: { amount: '' } } }, 'x'), { amount: null, currency: null });
  assert.deepEqual(priceEntry(null, 'retail'), { amount: null, currency: null });
});

test('formatPriceEntry uses the product currency, and never prints NaN', () => {
  assert.equal(formatPriceEntry(priceEntry(product, 'export')), '¥88.00');
  assert.equal(formatPriceEntry(priceEntry(product, 'wholesale')), '៛40,000');
  assert.equal(formatPriceEntry(priceEntry(product, 'retail')), '$12.50');
  // The value that used to become "$NaN".
  assert.ok(!formatPriceEntry(priceEntry(product, 'export')).includes('NaN'));
});

test('formatPriceEntry falls back to the caller symbol for a pre-currency row', () => {
  assert.equal(formatPriceEntry(priceEntry(product, 'legacy'), '£'), '£5');
  // No amount → empty, not a lone symbol.
  assert.equal(formatPriceEntry(priceEntry(product, 'missing'), '$'), '');
});

test('social grid resolvePrice agrees with priceEntry (object shape included)', () => {
  assert.equal(resolvePrice(product, { priceSource: 'retail' }), 12.5);
  assert.equal(resolvePrice(product, { priceSource: 'wholesale' }), 40000);
  assert.equal(resolvePrice(product, { priceSource: 'export' }), 88);
  assert.equal(resolvePrice(product, { priceSource: 'legacy' }), 5);
  assert.equal(resolvePrice(product, { priceSource: 'nope' }), null);
  assert.deepEqual(resolvePriceEntry(product, { priceSource: 'export' }), { amount: 88, currency: 'CNY' });
});
