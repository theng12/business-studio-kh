/**
 * Currency catalogue: formatting, fallbacks, and main↔renderer parity.
 *
 * The list is deliberately duplicated (`main/util/currencies.js` is CommonJS,
 * `renderer/lib/currencies.js` is ESM), so the parity case is the guard that
 * keeps the picker and the formatter from disagreeing about what symbols exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mainCurrencies = require('../main/util/currencies');
const { formatPrice, normalizeCurrency, symbolFor, isCurrency, CURRENCIES } = mainCurrencies;

const ROOT = path.join(__dirname, '..');

function loadRendererCurrencies() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/lib/currencies.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test('renderer currency list matches the main-process list exactly', () => {
  const renderer = loadRendererCurrencies();
  assert.deepEqual(renderer.CURRENCIES, CURRENCIES, 'the two currency lists have drifted apart');
  assert.equal(renderer.DEFAULT_CURRENCY, mainCurrencies.DEFAULT_CURRENCY);
});

test('the catalogue includes the three the owner asked for', () => {
  const byCode = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.symbol]));
  assert.equal(byCode.USD, '$');
  assert.equal(byCode.CNY, '¥');   // RMB
  assert.equal(byCode.KHR, '៛');
});

test('formatPrice prefixes the right symbol', () => {
  assert.equal(formatPrice(1234.5, 'USD'), '$1,234.50');
  assert.equal(formatPrice(88, 'CNY'), '¥88.00');
  assert.equal(formatPrice(50000, 'KHR'), '៛50,000');
});

test('whole-number currencies drop the decimals, decimal ones keep two', () => {
  assert.equal(formatPrice(1234, 'KHR'), '៛1,234');
  assert.equal(formatPrice(1234.5, 'KHR'), '៛1,235'); // rounded, never ".50"
  assert.equal(formatPrice(10, 'USD'), '$10.00');
});

test('blank or unusable amounts format to an empty string, not "NaN"', () => {
  assert.equal(formatPrice(null, 'USD'), '');
  assert.equal(formatPrice('', 'USD'), '');
  assert.equal(formatPrice('abc', 'USD'), '');
});

test('an unknown or missing code falls back to USD', () => {
  assert.equal(normalizeCurrency('xyz'), 'USD');
  assert.equal(normalizeCurrency(null), 'USD');
  assert.equal(normalizeCurrency('khr'), 'KHR'); // case-insensitive
  assert.equal(symbolFor('nope'), '$');
  assert.equal(isCurrency('KHR'), true);
  assert.equal(isCurrency('nope'), false);
});
