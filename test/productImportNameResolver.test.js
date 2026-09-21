/**
 * Regression for the product-import name→id resolver.
 *
 * Why this exists: ImportModal resolved Brand / Category columns with a
 * `find() -> create()` against the store arrays captured at the start of the
 * preview build. Those arrays do not change when createBrand() /
 * createCategory() refresh the store mid-run, so a file whose Brand column
 * repeated one name issued one create IPC per ROW. On a large import (or a
 * client Mac) that is thousands of redundant round trips and reads as a hang.
 *
 * The actual component reproduction is `createNameIdResolver` called once per
 * buildRows with a stale `existing` array; these cases pin the one-create-per-
 * distinct-name contract that fix depends on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const { createNameIdResolver } = (() => {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/lib/nameIdResolver.js')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-nameid-'));
  const file = path.join(dir, 'nameIdResolver.cjs');
  fs.writeFileSync(file, out.outputFiles[0].text);
  return require(file);
})();

test('creates each distinct name once even when the source lookup array stays stale', async () => {
  let creates = 0;
  let stale = [];
  const resolve = createNameIdResolver(stale, async (name) => {
    creates += 1;
    const item = { id: `id-${creates}`, name };
    // Simulate the store refresh that the component's captured array never sees.
    stale = [...stale, item];
    return item;
  });

  const ids = [];
  for (const name of ['Atlas', 'atlas', '  Atlas ', 'Lux']) ids.push(await resolve(name));

  assert.equal(creates, 2, 'one create per distinct name, not per row');
  assert.deepEqual(ids, ['id-1', 'id-1', 'id-1', 'id-2']);
});

test('seeds from existing lookups case-insensitively and never recreates a known name', async () => {
  let creates = 0;
  const resolve = createNameIdResolver(
    [{ id: 'b-9', name: 'Atlas' }],
    async () => { creates += 1; return { id: 'new' }; },
  );

  assert.equal(await resolve('atlas'), 'b-9');
  assert.equal(await resolve('ATLAS'), 'b-9');
  assert.equal(creates, 0);
});

test('blank names resolve to null without creating anything', async () => {
  let creates = 0;
  const resolve = createNameIdResolver([], async () => { creates += 1; return { id: 'x' }; });

  assert.equal(await resolve(''), null);
  assert.equal(await resolve('   '), null);
  assert.equal(await resolve(null), null);
  assert.equal(creates, 0);
});
