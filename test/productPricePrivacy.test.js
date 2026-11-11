/**
 * Pick & Pack Phase 0 (docs/PICK_AND_PACK_PLAN.md §7): a packer role sees no
 * prices. `products:list` / `products:get` are baseline reads, so the server
 * strips their price fields for a price-blind role only
 * (main/server/index.js -> main/util/productPrices.js). These are the two
 * pure pieces; no DB needed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { canSeePrices } = require('../main/util/capabilities');
const { stripProductPrices, PRICE_FIELDS } = require('../main/util/productPrices');

const caps = (...keys) => new Set(keys);

test('canSeePrices — the packer role (pack.work alone) is price-blind', () => {
  assert.equal(canSeePrices(caps('pack.work')), false);
  assert.equal(canSeePrices(caps('pack.work', 'fuel.record')), false, 'other operational caps do not grant prices');
  assert.equal(canSeePrices(['pack.work']), false, 'capsForRole returns an array');
});

test('canSeePrices — every other role keeps prices', () => {
  assert.equal(canSeePrices(caps()), true, 'no pack.work');
  assert.equal(canSeePrices(caps('*')), true, 'admin superuser');
  assert.equal(canSeePrices(caps('products.edit')), true);
  assert.equal(canSeePrices(caps('pack.work', 'orders.manage')), true, 'order managers see order values');
  assert.equal(canSeePrices(caps('pack.work', 'costing.view')), true);
  assert.equal(canSeePrices(caps('pack.work', 'images.add')), true, 'photographer-style give prices today; unchanged');
});

test('stripProductPrices — products:list loses only price fields, and does not mutate the rows', () => {
  const row = { id: 'p1', sku: 'A', name: 'Thing', priceRetail: 12.5, priceWholesale: 9, prices: { vip: 8 } };
  const out = stripProductPrices('products:list', [row]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 'p1', sku: 'A', name: 'Thing' });
  for (const field of PRICE_FIELDS) assert.equal(field in out[0], false, field);
  assert.equal(row.priceRetail, 12.5, 'the caller row is untouched');
});

test('stripProductPrices — products:get loses the same fields; other channels are untouched', () => {
  const row = { id: 'p1', priceRetail: 5, priceRetailCurrency: 'USD', prices: null };
  assert.deepEqual(stripProductPrices('products:get', row), { id: 'p1' });
  assert.equal(stripProductPrices(null, row), row);
  assert.equal(stripProductPrices('products:list', null), null);
  const other = { priceRetail: 5 };
  assert.equal(stripProductPrices('dashboard:stats', other), other);
});
