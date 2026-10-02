/**
 * The pure halves of the PO / landed-cost fixes — no database needed, so these
 * run under plain `npm test`. The database behaviour is in test/poCost.test.js
 * (native).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const landedCost = require('../main/util/landedCost');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function loadEsm(rel) {
  const esbuild = require('esbuild');
  const out = esbuild.transformSync(read(rel), { format: 'cjs', loader: 'js' });
  const mod = { exports: {} };
  new Function('module', 'exports', out.code)(mod, mod.exports);
  return mod.exports;
}

test('a discount lowers landed cost whatever sign it was stored with', () => {
  const lines = [{ id: 'a', qty: 10, unitPriceUsd: 10 }];
  for (const amountUsd of [20, -20]) {
    const r = landedCost.calculateLanded({ lines, components: [{ id: 'd', kind: 'discount', amountUsd, allocationBasis: 'by_value' }] });
    assert.equal(r.perLine[0].landedUnitCostUsd, 8, `stored ${amountUsd}`);
    assert.equal(r.header.totalComponentsUsd, -20);
  }
  const freight = landedCost.calculateLanded({ lines, components: [{ id: 'f', kind: 'freight', amountUsd: 20 }] });
  assert.equal(freight.perLine[0].landedUnitCostUsd, 12, 'other kinds are unchanged');
  assert.equal(landedCost.signedComponentAmount('discount', 5), -5);
  assert.equal(landedCost.signedComponentAmount('discount', -5), -5);
  assert.equal(landedCost.signedComponentAmount('freight', 5), 5);
});

test('the next PO number follows the existing pattern', () => {
  const { suggestNextPoNumber: next } = loadEsm('renderer/modules/PurchaseOrders/poNumber.js');
  assert.equal(next(['PO-2026-007', 'PO-2026-003']), 'PO-2026-008', 'zero padding kept');
  assert.equal(next(['PO-2025-120', 'PO-2026-003']), 'PO-2026-004', 'the newest year wins, not the biggest tail');
  assert.equal(next(['PO-9', 'PO-10']), 'PO-11', 'natural order');
  assert.equal(next(['A12B', null, '']), 'A13B', 'a suffix is kept');
  assert.equal(next(['PO-099', 'PO-100']), 'PO-101');
  assert.equal(next(['PO-1', 'po-2', 'PO-2']), 'PO-3', 'a taken number is skipped');
  assert.equal(next(['no digits', null]), null, 'nothing to follow → no suggestion');
  assert.equal(next([]), null);
});

test('PO screens hide write controls from a view-only user and say when filters hide everything', () => {
  const list = read('renderer/modules/PurchaseOrders/index.jsx');
  const detail = read('renderer/modules/PurchaseOrders/PODetail.jsx');
  const suppliers = read('renderer/modules/Suppliers/index.jsx');
  for (const [name, src] of [['PurchaseOrders', list], ['PODetail', detail], ['Suppliers', suppliers]]) {
    assert.match(src, /useCostingCaps\(\)/, `${name} must read the costing caps`);
  }
  assert.match(list, /actions=\{canManage \?/, 'New purchase order is gated');
  for (const label of ['Add line', 'Add cost', 'Record payment']) {
    assert.ok(new RegExp(`\\{canManage \\? <Button[^\\n]*>${label}</Button> : null\\}`).test(detail), `${label} is gated`);
  }
  assert.match(list, /No purchase orders match these filters/);
  assert.match(list, /Clear filters/);
  // A non-USD supplier must not inherit the USD supplier's rate of 1.
  assert.match(list, /setExchangeRateToUsd\(nextCurrency === 'USD' \? 1 : ''\)/);
});

test('PO and supplier writes announce themselves to other Macs', () => {
  const emitted = [];
  const handlers = new Map();
  const expose = (channel, handler) => handlers.set(channel, handler);
  const emitCatalogChange = (...args) => emitted.push(args);
  // The handlers call through the DB module object at call time, so stubbing
  // the two functions keeps this test free of SQLite.
  const po = require('../main/db/purchaseOrders');
  const sup = require('../main/db/suppliers');
  const saved = [[po, 'setStatus', po.setStatus], [sup, 'archive', sup.archive]];
  po.setStatus = (id) => ({ id });
  sup.archive = () => true;
  try {
    require('../main/ipc/purchaseOrders').register({ expose, emitCatalogChange });
    require('../main/ipc/suppliers').register({ expose, emitCatalogChange });
    handlers.get('pos:setStatus')({ id: 'po-1', status: 'closed' });
    handlers.get('suppliers:archive')('sup-1');
  } finally {
    for (const [mod, key, fn] of saved) mod[key] = fn;
  }
  assert.deepEqual(emitted[0].slice(0, 3), ['purchaseOrder', 'setStatus', 'po-1']);
  assert.deepEqual(emitted[0][3], { poId: 'po-1' });
  assert.deepEqual(emitted[1], ['supplier', 'archive', 'sup-1']);
});
