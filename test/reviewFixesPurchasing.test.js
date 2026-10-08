/**
 * Review fixes 14–17 — Purchase Orders and the Cost Calculator. Pure JS.
 *
 *   14. "Duplicate as draft" copies the PO as SAVED, re-reading the detail
 *       after saveNow() instead of the header captured before it.
 *   15. Close-unreceived: when "received" lands and "closed" fails, the toast
 *       says exactly that and where the PO now stands.
 *   16. "Save as retail price" is only offered to users with products.edit.
 *   17. A shown rate and the label/input next to it always read the same way
 *       round ("1 USD = ? KHR" beside "1 USD = 4,100 KHR").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function loadEsm(rel, stubs = {}) {
  const esbuild = require('esbuild');
  const out = esbuild.transformSync(read(rel), { format: 'cjs', loader: 'js' });
  const mod = { exports: {} };
  const req = (id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`unexpected import ${id}`);
  };
  new Function('module', 'exports', 'require', out.code)(mod, mod.exports, req);
  return mod.exports;
}

const STATUS_LABEL = (s) => ({ draft: 'Draft', ordered: 'Ordered', in_transit: 'In transit', received: 'Received', closed: 'Closed' }[s] || s);

/* ─── 14 ─────────────────────────────────────────────────────────── */

test('Duplicate as draft reads the saved detail after saveNow(), not the pre-save header or lines', () => {
  const src = read('renderer/modules/PurchaseOrders/PODetail.jsx');
  const fn = src.slice(src.indexOf('async function duplicateAsDraft()'), src.indexOf('function exportCsv()'));
  const save = fn.indexOf('await saveNow()');
  const reread = fn.indexOf('source = detailRef.current');
  assert.ok(save > 0 && reread > save, 'the detail is re-read after the save');
  const afterSave = fn.slice(reread);
  assert.doesNotMatch(afterSave, /(?<![.\w])header\./, 'no field is read from the header captured before the save');
  assert.doesNotMatch(afterSave, /(?<![.\w])detail\./, 'no line or cost is read from the detail captured before the save');
  assert.match(afterSave, /for \(const l of source\.lines/);
  assert.match(afterSave, /for \(const c of source\.components/);
  assert.match(afterSave, /exchangeRateToUsd: saved\.exchangeRateToUsd/);
});

/* ─── 15 ─────────────────────────────────────────────────────────── */

test('close-unreceived: a failed close after a successful receive says exactly what happened', () => {
  const { partialStatusChangeText } = loadEsm('renderer/modules/PurchaseOrders/statusSteps.js');
  assert.equal(
    partialStatusChangeText(['received', 'closed'], 1, new Error('Database is locked'), STATUS_LABEL),
    'Marked received, but closing failed: Database is locked. The PO is now Received.',
  );
  // A trailing full stop in the reason is not doubled.
  assert.equal(
    partialStatusChangeText(['received', 'closed'], 1, new Error('Forbidden.'), STATUS_LABEL),
    'Marked received, but closing failed: Forbidden. The PO is now Received.',
  );

  const src = read('renderer/modules/PurchaseOrders/PODetail.jsx');
  const fn = src.slice(src.indexOf('async function runStatusChange('), src.indexOf('async function saveChildEdit('));
  assert.match(fn, /done \+= 1;/, 'each landed step is counted');
  assert.match(fn, /if \(done > 0 && done < steps\.length\) \{\s*[\s\S]*?partialStatusChangeText\(steps, done, err, STATUS_LABEL\)/);
  // The partial case is handled before the generic/conflict toasts and shows the PO as it is now.
  assert.ok(fn.indexOf('partialStatusChangeText') < fn.indexOf('parseConflictError(err)'));
  assert.match(fn.slice(fn.indexOf('partialStatusChangeText')), /getDetail\(poId\)[\s\S]*?applySnapshot\(fresh\)/);
});

/* ─── 16 ─────────────────────────────────────────────────────────── */

test('Cost Calculator offers "Save as retail price" only with products.edit', () => {
  const caps = loadEsm('renderer/lib/capabilities.js');
  let state = {};
  const useAppStore = (sel) => sel(state);
  const { useCostingCaps } = loadEsm('renderer/modules/PurchaseOrders/costingCaps.js', {
    '../../store/index.js': { useAppStore },
    '../../lib/capabilities.js': caps,
  });
  state = { appMode: 'standalone' };
  assert.equal(useCostingCaps().canEditProducts, true, 'the host Mac has every capability');
  state = { appMode: 'client', clientConnection: { user: { caps: ['costing.view', 'costing.manage'] } } };
  assert.equal(useCostingCaps().canEditProducts, false, 'costing rights alone do not allow a product price write');
  state = { appMode: 'client', clientConnection: { user: { caps: ['costing.view', 'products.edit'] } } };
  assert.equal(useCostingCaps().canEditProducts, true);

  const src = read('renderer/modules/CostCalculator/index.jsx');
  assert.match(src, /const \{ canEditProducts \} = useCostingCaps\(\);/);
  assert.match(src, /\{selectedProduct && canEditProducts \? \(\s*<div className="setting-control-row costcalc__save">/);
  assert.match(src, /savingRetail \|\| !canEditProducts\) return;/, 'the handler refuses too');
});

/* ─── 17 ─────────────────────────────────────────────────────────── */

test('a shown exchange rate always reads in the direction its field label asks for', () => {
  const fx = loadEsm('renderer/modules/PurchaseOrders/fxRate.js');
  const currencies = ['CNY', 'THB', 'VND', 'KHR', 'EUR', 'JPY', 'KRW', 'INR', 'IDR', 'MYR', 'SGD', 'LAK'];
  const rates = [0, 1 / 25000, 1 / 4100, 0.0005, 0.005, 0.0099, 0.012, 0.14, 1.08];
  for (const c of currencies) {
    const labelPerUsd = /\(1 USD = \? /.test(fx.fxLabel(c));
    assert.equal(labelPerUsd, fx.quotesPerUsd(c), `${c}: the input box follows the label`);
    for (const r of rates) {
      const shown = fx.formatFx(c, r);
      const shownPerUsd = shown.startsWith('1 USD = ');
      assert.equal(shownPerUsd, labelPerUsd, `${c} @ ${r}: "${shown}" vs "${fx.fxLabel(c)}"`);
      assert.doesNotMatch(shown, /= 0 /, `${c} @ ${r}: a tiny rate never prints as 0`);
    }
  }
  assert.equal(fx.formatFx('THB', 0.005), `1 THB = ${(0.005).toLocaleString()} USD`);
  assert.equal(fx.formatFx('LAK', 1 / 21000), `1 LAK = ${(1 / 21000).toLocaleString(undefined, { maximumSignificantDigits: 4 })} USD`);
  assert.equal(fx.formatFx('KHR', 1 / 4100), `1 USD = ${(4100).toLocaleString()} KHR`);
  assert.equal(fx.formatFx('KHR', 0), '1 USD = ? KHR');
  assert.equal(fx.formatFx('CNY', ''), '1 CNY = ? USD');
});

/* ─── 33 (C3, C4) ─────────────────────────────────────────────────── */

test('LineModal saves once: Save, Save & add next and Enter share one in-flight guard', () => {
  const src = read('renderer/modules/PurchaseOrders/PODetail.jsx');
  const modal = src.slice(src.indexOf('function LineModal('));
  const submit = modal.slice(modal.indexOf('async function submit('), modal.indexOf('async function submitOnce('));
  assert.match(submit, /if \(!canSubmit \|\| savingRef\.current\) return;\s*savingRef\.current = true;/, 'claimed synchronously, before any await');
  assert.match(submit, /finally \{ savingRef\.current = false; setSaving\(false\); \}/);
  assert.match(modal, /await onSave\(payload, \{ next \}\);/, 'held until the save finishes');
  assert.match(modal, /onClick=\{\(\) => submit\(true\)\} disabled=\{!canSubmit \|\| saving\}/);
  assert.match(modal, /form="po-line-form" variant="primary" disabled=\{!canSubmit \|\| saving\}/);
  assert.match(modal, /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); submit\(false\); \}\}/, 'Enter goes through the same guard');
});

test('the currency-change confirm shows the current rate the readable way round', () => {
  const src = read('renderer/modules/PurchaseOrders/PODetail.jsx');
  const fn = src.slice(src.indexOf('async function changeCurrency('), src.indexOf('async function changeStatus('));
  assert.match(fn, /The current rate \(\$\{formatFx\(prev, before\.exchangeRateToUsd\)\}\) is discarded\./);
  assert.doesNotMatch(fn, /1 \$\{prev\} = \$\{Number\(before\.exchangeRateToUsd\)/);
  // The "enter a rate" error asks in the same direction as the rate box.
  assert.match(fn, /quotesPerUsd\(next\)\s*\?\s*`Currency not changed — enter how many \$\{next\} one US dollar buys/);
});
