/**
 * Fuel phone page (`/f`): the pure helpers in webclient/fuel/logic.js —
 * words in both languages, client_ref, litres from cans / pump meter / dip
 * chart, the keypad, money. Plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../webclient/fuel/logic.js');
const calib = require('../main/util/tankCalibration');

const ROOT = path.join(__dirname, '..');

test('every word exists in Khmer AND English, and neither is empty', () => {
  const km = Object.keys(L.STRINGS.km).sort();
  const en = Object.keys(L.STRINGS.en).sort();
  assert.deepEqual(km, en, 'the two tables must have the same keys');
  for (const k of km) {
    assert.ok(L.STRINGS.km[k].trim(), `km.${k} is empty`);
    assert.ok(L.STRINGS.en[k].trim(), `en.${k} is empty`);
    // The same {placeholders} in both, so a value is never lost in one language.
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    assert.equal(ph(L.STRINGS.km[k]), ph(L.STRINGS.en[k]), `placeholders differ for ${k}`);
  }
});

test('Khmer text really is Khmer (not English pasted twice)', () => {
  const khmer = /[ក-៿]/;
  const notKhmer = ['lang_other']; // the toggle names the OTHER language
  for (const [k, v] of Object.entries(L.STRINGS.km)) {
    if (notKhmer.includes(k)) continue;
    assert.match(v, khmer, `km.${k} has no Khmer letters: ${v}`);
  }
  assert.equal(L.STRINGS.km.lang_other, 'English');
  assert.match(L.STRINGS.en.lang_other, khmer);
});

test('every word the screens ask for is in the tables', () => {
  const app = fs.readFileSync(path.join(ROOT, 'webclient/fuel/app.js'), 'utf8');
  const used = new Set();
  for (const m of app.matchAll(/\btr\('([a-z_]+)'/g)) used.add(m[1]);
  // Keys named in step/flow definitions (title: 'pick_tank', unit: 'unit_l', …).
  for (const m of app.matchAll(/\b(?:title|unit|intro|empty|none|other|label|kindLabel):\s*'([a-z_]+)'/g)) used.add(m[1]);
  for (const m of app.matchAll(/\['(field_[a-z_]+|litres_[a-z]+)'/g)) used.add(m[1]);
  for (const m of app.matchAll(/'((?:home|photo|reading|unit|kind)_[a-z_]+)'/g)) used.add(m[1]);
  assert.ok(used.size > 60, `expected the screens to use many words, saw ${used.size}`);
  for (const k of used) assert.ok(k in L.STRINGS.km && k in L.STRINGS.en, `missing word: ${k}`);
});

test('t(): Khmer by default, English on request, placeholders filled', () => {
  assert.equal(L.pickLang(null), 'km');
  assert.equal(L.pickLang('xx'), 'km');
  assert.equal(L.pickLang('en'), 'en');
  assert.equal(L.t('en', 'waiting_n', { n: 3 }), '3 waiting to send');
  assert.match(L.t('km', 'waiting_n', { n: 3 }), /^3 /);
  assert.equal(L.t('en', 'no_such_key'), 'no_such_key');
});

test('client_ref: valid for the server, unique, made without crypto.randomUUID', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const ref = L.makeClientRef('a1b2c3d4');
    assert.ok(L.isValidClientRef(ref), ref);
    assert.match(ref, /^[A-Za-z0-9_.:-]{6,100}$/); // main/server/fuelValidators.js clientRef()
    assert.ok(ref.startsWith('f:a1b2c3d4:'));
    seen.add(ref);
  }
  assert.equal(seen.size, 500);
  assert.match(L.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(L.makeClientRef('we!rd id', 'x-1'), 'f:werdid:x-1');
  assert.equal(L.isValidClientRef('short'), false);
  assert.equal(L.isValidClientRef('has space here'), false);
  const app = fs.readFileSync(path.join(ROOT, 'webclient/fuel/app.js'), 'utf8');
  const logic = fs.readFileSync(path.join(ROOT, 'webclient/fuel/logic.js'), 'utf8');
  assert.doesNotMatch(app + logic, /randomUUID\(/, 'randomUUID needs a secure context; the page runs over plain HTTP');
});

test('litres from 20 L cans and from the pump flow meter', () => {
  assert.equal(L.litresFromCans(3, 20), 60);
  assert.equal(L.litresFromCans(1, 18.9), 18.9);
  assert.equal(L.litresFromCans(0, 20), null);
  assert.equal(L.litresFromCans(2.5, 20), null);
  assert.equal(L.litresFromCans(2, 0), null);
  assert.deepEqual(L.litresFromMeter(1200.5, 1260.75), { litres: 60.25, backwards: false });
  assert.deepEqual(L.litresFromMeter(100, 90), { litres: null, backwards: true });
  assert.deepEqual(L.litresFromMeter(null, 90), { litres: null, backwards: false });
  // The server's own rule gives the same litres.
  const { resolvePumpMeterLitres } = require('../main/util/fuelAnomalies');
  assert.equal(resolvePumpMeterLitres({ before: 1200.5, after: 1260.75 }).litres, L.litresFromMeter(1200.5, 1260.75).litres);
});

test('dip chart lookup mirrors main/util/tankCalibration.js exactly', () => {
  const ULLAGE = [
    { dipCm: 0, litres: 3500 }, { dipCm: 95, litres: 2156 }, { dipCm: 100, litres: 2046 },
    { dipCm: 120, litres: 1850 }, { dipCm: 200, litres: 0 },
  ];
  const DEPTH = [{ dipCm: 10, litres: 100 }, { dipCm: 50, litres: 900 }, { dipCm: 150, litres: 4000 }];
  for (const chart of [ULLAGE, DEPTH]) {
    const shuffled = chart.slice().reverse();
    for (const cm of [-5, 0, 3, 10, 47.5, 95, 98, 100, 119.9, 150, 199, 200, 250]) {
      assert.deepEqual(L.chartLitres(shuffled, cm), calib.lookup(calib.normalizeChart(chart), cm), `cm=${cm}`);
    }
  }
  assert.deepEqual(L.chartLitres([], 10), { litres: null, outOfRange: true });
  assert.deepEqual(L.chartLitres(ULLAGE, null), { litres: null, outOfRange: true });
});

test('keypad: digits, one decimal point, decimals limit, backspace, no leading zeros', () => {
  const press = (keys, opts) => keys.reduce((s, k) => L.keypadPress(s, k, opts), '');
  assert.equal(press(['1', '2', '.', '5', '7', '9']), '12.57');
  assert.equal(press(['.', '5']), '0.5');
  assert.equal(press(['0', '0', '7']), '7');
  assert.equal(press(['1', '.', '.', '2']), '1.2');
  assert.equal(press(['5', '0', '0', '0', '.'], { decimals: 0 }), '5000');
  assert.equal(press(['1', '2', 'back']), '1');
  assert.equal(press(['1', '2', 'clear']), '');
  assert.equal(press(['9', '9', '9', '9', '9', '9', '9', '9', '9', '9', '9', '9']), '9999999999');
  assert.equal(L.parseKeypad(''), null);
  assert.equal(L.parseKeypad('.'), null);
  assert.equal(L.parseKeypad('0.5'), 0.5);
  assert.equal(L.formatTyping('1234567.5'), '1,234,567.5');
  assert.equal(L.formatTyping('12.'), '12.');
  assert.equal(L.formatTyping(''), '0');
});

test('money: riel are whole, dollars are cents', () => {
  assert.equal(L.toMinor(120000, 'KHR'), 120000);
  assert.equal(L.toMinor(29.99, 'USD'), 2999);
  assert.equal(L.formatMoney(120000, 'KHR'), '120,000 ៛');
  assert.equal(L.formatMoney(2999, 'USD'), '$29.99');
  assert.equal(L.formatNumber(1234.5, 2), '1,234.5');
  assert.equal(L.formatNumber(60, 2), '60');
});

test('photos shrink to 1600 px on the long side, never grow', () => {
  assert.deepEqual(L.fitWithin(4032, 3024, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(L.fitWithin(3024, 4032, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(L.fitWithin(800, 600, 1600), { width: 800, height: 600 });
  assert.deepEqual(L.fitWithin(0, 600, 1600), { width: 0, height: 0 });
});

test('who may use the page, and the pairing token in the fragment', () => {
  assert.equal(L.canRecordFuel(['fuel.record']), true);
  assert.equal(L.canRecordFuel(['fuel.manage', 'products.view']), true);
  assert.equal(L.canRecordFuel(['*']), true);
  assert.equal(L.canRecordFuel(['products.view']), false);
  assert.equal(L.canRecordFuel(null), false);
  assert.equal(L.tokenFromHash('#t=abc%2Bdef'), 'abc+def');
  assert.equal(L.tokenFromHash('#x=1&t=tok'), 'tok');
  assert.equal(L.tokenFromHash('#t=%E0%A4%A'), null, 'a malformed fragment is ignored');
  assert.equal(L.tokenFromHash(''), null);
});
