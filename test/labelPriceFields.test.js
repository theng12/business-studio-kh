/**
 * "Can I print our VIP price on a label?" — for two releases the answer was no,
 * because the designer's Product-field dropdown listed only retail and
 * wholesale while the renderer resolved any `price.<group>` field. Same gap the
 * overlay tokens had, found in the same audit.
 *
 * The other half of the rule is what the CANVAS draws: it used to look the
 * field up as a flat key on the sample product, so every group price previewed
 * as the hardcoded "9.99" while the printed label showed the real number. Both
 * halves are checked here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const GROUPS = [{ key: 'vip', label: 'VIP' }, { key: 'dealer', label: 'Dealer' }];

test('a company price group is offered as a label field', async () => {
  const { fieldOptions, BASE_FIELDS } = await load('renderer/modules/LabelStudio/labelFields.js');

  const plain = fieldOptions([]);
  assert.deepEqual(plain, [...BASE_FIELDS], 'with no groups the list is exactly the base fields');

  const withGroups = fieldOptions(GROUPS);
  const values = withGroups.map(([value]) => value);
  assert.deepEqual(values.slice(0, BASE_FIELDS.length), BASE_FIELDS.map(([v]) => v),
    'the base fields keep their order — the dropdown is familiar');
  assert.deepEqual(values.slice(BASE_FIELDS.length), ['price.vip', 'price.dealer']);
  assert.deepEqual(withGroups.slice(BASE_FIELDS.length).map(([, label]) => label), ['VIP price', 'Dealer price']);

  // The key shape is the contract with main/studioRenderer.js `productValue`,
  // which slices 'price.'.length off and hands the rest to priceEntry().
  for (const [value] of withGroups.slice(BASE_FIELDS.length)) {
    assert.match(value, /^price\.[A-Za-z0-9._-]+$/);
  }
});

test('a half-written or duplicate group cannot break the dropdown', async () => {
  const { fieldOptions, BASE_FIELDS } = await load('renderer/modules/LabelStudio/labelFields.js');
  const messy = fieldOptions([
    { key: 'vip', label: 'VIP' }, { key: 'vip', label: 'VIP again' },
    { key: '', label: 'No key' }, { key: 'nolebel' }, null, 'nonsense',
  ]);
  assert.equal(messy.length, BASE_FIELDS.length + 1, 'only the one complete, unique group is added');
  assert.deepEqual(messy[messy.length - 1], ['price.vip', 'VIP price']);
});

test('the designer canvas resolves a group price from the sample product', () => {
  const canvas = fs.readFileSync(path.join(ROOT, 'renderer/modules/LabelStudio/DesignerCanvas.jsx'), 'utf8');
  // The bug: `sample?.[field]` — a flat lookup that is always undefined for
  // "price.vip", so the canvas fell through to its hardcoded sample price.
  assert.match(canvas, /labelPriceSource\(field\)/, 'the canvas special-cases price fields (retail, wholesale, groups)');
  // Since 2026-10-02 every label price (retail, wholesale, a group) is the bare
  // amount, the currency being the element's prefix/suffix — see
  // labelPriceAmount in main/studioRenderer.js and test/labelCatalog.test.js.
  assert.match(canvas, /labelPriceAmount\(priceEntry\(sample, priceSource\)\)/,
    'and resolves them through the shared mirror, the way the renderer does');
  assert.match(canvas, /from '\.\.\/\.\.\/lib\/prices\.js'/, 'using the mirrored price rule');
});
