/**
 * The phone viewer carries its own copy of the currency table and the price
 * rule — it is a single self-contained HTML file with no imports, so it cannot
 * share `main/util/currencies.js` or `main/util/prices.js`.
 *
 * That copy is exactly how the app got a phone screen that printed "$12.50"
 * for a product priced in riel and never showed a VIP price at all. This test
 * reads the table out of `webclient/index.html` and compares it with the
 * main-process catalogue, so the next drift fails here instead of in his hand.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'webclient/index.html'), 'utf8');
const { CURRENCIES } = require('../main/util/currencies.js');
const main = require('../main/util/prices.js');

/** Pull the viewer's price helpers into a sandbox, with just enough context. */
function loadViewerHelpers() {
  const start = source.indexOf('  var CURRENCY_SYMBOLS = {');
  const end = source.indexOf('  function escapeHtml(s) {', start);
  assert.ok(start > 0 && end > start, 'the viewer still defines its price helpers');
  const context = { state: { companies: [], companyId: null }, isFinite, Number, String };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nresult = { CURRENCY_SYMBOLS, WHOLE_NUMBER_CURRENCIES, priceEntryFor, formatDevicePrice, priceGroupsForDevice, state };`,
    context,
  );
  return context.result;
}

test('the viewer currency table matches the main-process catalogue', () => {
  const viewer = loadViewerHelpers();
  const expected = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.symbol]));
  assert.deepEqual(
    { ...viewer.CURRENCY_SYMBOLS },
    expected,
    'every code the app offers, with the same symbol — no more, no fewer',
  );
  /* The whole-number set is not exported by the main module, so compare the
     BEHAVIOUR instead: for each code, a whole amount must format with no
     decimals in both copies (or in neither). */
  for (const { code } of CURRENCIES) {
    const mainText = main.formatPriceEntry({ amount: 1000, currency: code }, '$');
    const viewerText = viewer.formatDevicePrice({ amount: 1000, currency: code });
    assert.equal(
      /\.[0-9]/.test(viewerText), /\.00/.test(mainText),
      `${code} disagrees about decimal places: main "${mainText}" vs viewer "${viewerText}"`,
    );
  }
});

test('the viewer resolves every price shape like the main process', () => {
  const viewer = loadViewerHelpers();
  const fixtures = [
    { product: { priceRetail: 12.5, priceRetailCurrency: 'USD' }, source: 'retail' },
    { product: { priceRetail: 41000, priceRetailCurrency: 'KHR' }, source: 'retail' },
    { product: { priceRetail: 12.5 }, source: 'retail' },
    { product: { priceWholesale: 8, priceWholesaleCurrency: 'THB' }, source: 'wholesale' },
    { product: { prices: { vip: { amount: 99.5, currency: 'USD' } } }, source: 'vip' },
    { product: { prices: { vip: 42 } }, source: 'vip' },
    { product: { prices: {} }, source: 'vip' },
    { product: {}, source: 'retail' },
    { product: { priceRetail: 'abc' }, source: 'retail' },
  ];
  for (const { product, source: src } of fixtures) {
    const fromViewer = viewer.priceEntryFor(product, src);
    const fromMain = main.priceEntry(product, src);
    assert.equal(fromViewer.amount, fromMain.amount, `amount for ${src}`);
    assert.equal(fromViewer.currency, fromMain.currency, `currency for ${src}`);
  }
});

test('the viewer formats a price the way the rest of the app does', () => {
  const viewer = loadViewerHelpers();
  const cases = [
    [{ amount: 1234.5, currency: 'USD' }, '$1,234.50'],
    [{ amount: 41000, currency: 'KHR' }, '៛41,000'],
    [{ amount: 8, currency: 'THB' }, '฿8.00'],
    [{ amount: 12.5, currency: null }, '$12.5'],
    [{ amount: null, currency: 'USD' }, ''],
    [null, ''],
  ];
  for (const [entry, expected] of cases) {
    assert.equal(viewer.formatDevicePrice(entry), expected, `formatting ${JSON.stringify(entry)}`);
  }
  // The whole-number currencies must not grow decimals, and the others must.
  assert.doesNotMatch(viewer.formatDevicePrice({ amount: 1000, currency: 'VND' }), /\./);
  assert.match(viewer.formatDevicePrice({ amount: 1000, currency: 'EUR' }), /\.00$/);
});

test('the viewer reads the active company’s price groups', () => {
  const viewer = loadViewerHelpers();
  assert.deepEqual([...viewer.priceGroupsForDevice()], [], 'no company loaded: no groups, no crash');
  const withCompany = loadViewerHelpers();
  withCompany.state.companies = [{ id: 'c1', priceGroups: [{ key: 'vip', label: 'VIP' }] }];
  withCompany.state.companyId = 'c1';
  assert.deepEqual([...withCompany.priceGroupsForDevice()], [{ key: 'vip', label: 'VIP' }]);
});
