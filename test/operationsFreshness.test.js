const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('cost calculator invalidates old company/product cost responses and protects manual edits', () => {
  const source = read('renderer/modules/CostCalculator/index.jsx');
  assert.match(source, /productRequestRef/);
  assert.match(source, /costRequestRef/);
  assert.match(source, /request !== productRequestRef\.current/);
  assert.match(source, /request !== costRequestRef\.current \|\| companyRequest !== productRequestRef\.current/);
  assert.match(source, /manualCostEditRef\.current/);
  assert.match(source, /setProductId\(''\)/);
});

test('supplier and purchase-order list effects guard rows, errors, loading, and companion responses', () => {
  const suppliers = read('renderer/modules/Suppliers/index.jsx');
  const purchaseOrders = read('renderer/modules/PurchaseOrders/index.jsx');
  for (const source of [suppliers, purchaseOrders]) {
    assert.match(source, /listRequestRef/);
    assert.match(source, /request !== listRequestRef\.current/);
    assert.match(source, /request === listRequestRef\.current/);
    assert.match(source, /setRefreshTick/);
  }
  assert.match(suppliers, /spendRequestRef/);
  assert.match(suppliers, /supplierSpendRollup/);
  assert.match(purchaseOrders, /supplierRequestRef/);
  assert.match(purchaseOrders, /suppliers\.list/);
});
