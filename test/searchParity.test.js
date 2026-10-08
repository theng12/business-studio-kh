/* The phone viewer's product search (webclient/index.html, `search:begin`)
 * is a copy of the desktop rule (main/db/search.js — compileProductSearch /
 * matchProductSearch, used by the Library and ⌘K). They cannot share code (the
 * viewer is a build-free page), so this runs both over the SAME samples and
 * fails the moment they disagree. Add a sample here whenever either side
 * changes. Pure JS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

function desktopMatcher() {
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === './index' && /main\/db\/search\.js$/.test(parent?.filename)) return { getDb: () => null };
    return original.call(this, request, parent, isMain);
  };
  let s;
  try { s = require('../main/db/search'); } finally { Module._load = original; }
  return (p, q) => s.matchProductSearch(s.compileProductSearch(q), { sku: p.sku, name: p.name, color: p.colorFinish, barcode: p.barcode }) !== null;
}

function phoneMatcher() {
  const viewer = fs.readFileSync(path.join(ROOT, 'webclient/index.html'), 'utf8');
  const start = viewer.indexOf('/* search:begin');
  const end = viewer.indexOf('/* search:end */');
  assert.ok(start > 0 && end > start, 'the search block markers are gone');
  const ctx = {};
  vm.runInNewContext(`${viewer.slice(start, end)}
    this.fields = productSearchFields; this.matches = productMatchesSearch;`, ctx);
  return (p, q, brand = '') => ctx.matches(ctx.fields(p, brand), q);
}

const PRODUCTS = [
  { sku: 'AV-M8101', name: 'MACEPRO floor tile', colorFinish: 'Matte Blue', barcode: '8851234567890' },
  { sku: 'AV-M81', name: 'Wall tile', colorFinish: 'Gloss White', barcode: null },
  { sku: 'KH-1', name: 'ក្រ​ឡា ប្រផេះ' },
  { sku: 'KH-2', name: 'ចាន⁠ធំ' },
  { sku: 'SH-1', name: 'co­operative shelf' },
  { sku: 'EP-1', name: 'Épice blanche' },
  { sku: 'ZZ-9', name: 'Contains 885123 in its name', barcode: '999 0001 112223' },
  { sku: 'AB:12#3', name: 'Colon code', barcode: '' },
  { sku: 'X.Y/Z', name: 'Dotted · code', colorFinish: '' },
  { sku: '', name: '', colorFinish: '', barcode: '' },
];

const QUERIES = [
  '', '   ', 'tile', 'blue macepro', 'tile purple', 'avm8101', 'av m81', 'AV-M81', 'av_m8101',
  '8851234567890', '885 1234 567 890', '885123', '8851234567', '9990001112223', '999-0001-112223',
  'ក្រឡា', 'ក្រ‌ឡា', 'ចានធំ', 'ចាន­ធំ', 'cooperative', 'co­op', 'Épice', 'épice',
  'ab123', 'AB:12#3', 'ab 12 3', 'xyz', 'x/y', 'dotted', '·', 'colon code', '%', '_',
  `tile ${'x'.repeat(300)}`, `${'tile '.repeat(60)}`,
];

test('desktop and phone search agree on every sample (no brand)', () => {
  const desktop = desktopMatcher();
  const phone = phoneMatcher();
  const disagreements = [];
  for (const p of PRODUCTS) {
    for (const q of QUERIES) {
      const d = desktop(p, q);
      const m = phone(p, q);
      if (d !== m) disagreements.push(`${JSON.stringify(q)} vs ${p.sku || '(blank)'}: desktop ${d}, phone ${m}`);
    }
  }
  assert.deepEqual(disagreements, []);
});

test('the shared rule itself: barcode exact only, separators ignored, invisible marks ignored', () => {
  const phone = phoneMatcher();
  const desktop = desktopMatcher();
  for (const match of [phone, desktop]) {
    const p = PRODUCTS[0];
    assert.equal(match(p, '8851234567890'), true, 'exact barcode');
    assert.equal(match(p, '885 1234 567 890'), true, 'exact barcode, separators ignored');
    assert.equal(match(p, '885123'), false, 'a barcode fragment is not a match');
    assert.equal(match(p, 'avm8101'), true);
    assert.equal(match(PRODUCTS[7], 'ab123'), true, ': and # are separators');
    assert.equal(match(PRODUCTS[3], 'ចានធំ'), true, 'U+2060 word joiner');
    assert.equal(match(PRODUCTS[4], 'cooperative'), true, 'U+00AD soft hyphen');
    assert.equal(match(p, `tile ${'x'.repeat(300)}`), false, 'capped, but the kept words still all have to match');
  }
});

test('phone-only extra: a word may match the brand name', () => {
  const phone = phoneMatcher();
  assert.equal(phone(PRODUCTS[1], 'acme wall', 'Acme'), true);
  assert.equal(phone(PRODUCTS[1], 'acme wall'), false);
});
