/**
 * The price rule exists twice — `main/util/prices.js` (CommonJS) and
 * `renderer/lib/prices.js` (ESM) — because the two processes cannot share a
 * module. This runs both over the same fixtures and fails if they drift.
 *
 * It exists because price handling DID drift: the overlay tokens formatted a
 * group price while retail printed a bare number, the label designer drew a
 * hardcoded sample for any price, and the phone viewer hardcoded a "$". The
 * mirror is only safe while something checks it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = require('../main/util/prices.js');

/** Load the ESM renderer mirror in a context whose `formatPrice` is the
 *  renderer's own currency helper, so this compares the price RULE and not the
 *  currency table (test/currencies.test.js already pins that one). */
function loadRendererMirror() {
  const root = path.join(__dirname, '..');
  const currencies = fs.readFileSync(path.join(root, 'renderer/lib/currencies.js'), 'utf8');
  const prices = fs.readFileSync(path.join(root, 'renderer/lib/prices.js'), 'utf8');
  const strip = (src) => src
    .replace(/^import[^;]+;$/gm, '')
    .replace(/^export\s+/gm, '');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(`${strip(currencies)}\n${strip(prices)}\nresult = { priceEntry, formatPriceEntry, num };`, context);
  return context.result;
}

const FIXTURES = [
  { label: 'retail with its own currency', product: { priceRetail: 12.5, priceRetailCurrency: 'USD' }, source: 'retail' },
  { label: 'retail without a currency (pre-v0.1.55 row)', product: { priceRetail: 12.5 }, source: 'retail' },
  { label: 'retail missing', product: {}, source: 'retail' },
  { label: 'retail empty string', product: { priceRetail: '' }, source: 'retail' },
  { label: 'wholesale in riel', product: { priceWholesale: 41000, priceWholesaleCurrency: 'KHR' }, source: 'wholesale' },
  { label: 'a group as { amount, currency }', product: { prices: { vip: { amount: 1234.5, currency: 'USD' } } }, source: 'vip' },
  { label: 'a group as a bare number (legacy)', product: { prices: { vip: 99 } }, source: 'vip' },
  { label: 'a group with no currency', product: { prices: { vip: { amount: 5 } } }, source: 'vip' },
  { label: 'a group that is not set', product: { prices: {} }, source: 'vip' },
  { label: 'a group holding nonsense', product: { prices: { vip: 'abc' } }, source: 'vip' },
  { label: 'no product at all', product: null, source: 'retail' },
];

test('the renderer mirror resolves every price shape like the main process', () => {
  const mirror = loadRendererMirror();
  for (const { label, product, source } of FIXTURES) {
    // Compare field by field: the two entries come from different VM realms,
    // so deepStrictEqual would fail on the prototype alone.
    const fromMirror = mirror.priceEntry(product, source);
    const fromMain = main.priceEntry(product, source);
    assert.equal(fromMirror.amount, fromMain.amount, `amount disagrees for ${label}`);
    assert.equal(fromMirror.currency, fromMain.currency, `currency disagrees for ${label}`);
    assert.equal(
      mirror.formatPriceEntry(mirror.priceEntry(product, source), '$'),
      main.formatPriceEntry(main.priceEntry(product, source), '$'),
      `formatPriceEntry disagrees for ${label}`,
    );
  }
});

test('an unset or unreadable price formats as empty, never as NaN', () => {
  const mirror = loadRendererMirror();
  for (const { product, source } of FIXTURES) {
    const out = mirror.formatPriceEntry(mirror.priceEntry(product, source), '$');
    assert.doesNotMatch(String(out), /NaN/, 'a missing price must print nothing at all');
  }
});

test('the two copies are actually two copies', () => {
  const root = path.join(__dirname, '..');
  const esm = fs.readFileSync(path.join(root, 'renderer/lib/prices.js'), 'utf8');
  assert.match(esm, /export function priceEntry/, 'the renderer mirror still exports its own resolver');
  assert.match(
    fs.readFileSync(path.join(root, 'main/util/prices.js'), 'utf8'),
    /module\.exports = \{ num, priceEntry, formatPriceEntry(?:, rowHasAnyPrice)? \}/,
    'the main-process copy is still the canonical one',
  );
});
