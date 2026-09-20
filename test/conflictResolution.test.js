const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

async function loadConflictModule() {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const out = await esbuild.build({
    stdin: { contents: "import * as conflict from './renderer/components/ConflictModal.jsx'; export { conflict };", resolveDir: ROOT, sourcefile: 'conflict-test-entry.jsx', loader: 'jsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/client', 'zustand'], logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => {
    if (id === 'react') return { useEffect() {}, useRef: () => ({ current: null }), useState: () => [null, () => {}], useMemo: (fn) => fn(), useCallback: (fn) => fn };
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'fragment' };
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    if (id === 'zustand') return { create: () => (selector) => selector({ attributionUsers: {} }) };
    return req(id);
  }, mod, mod.exports);
  return mod.exports.conflict;
}

for (const choice of ['cancel', 'refresh', 'overwrite']) {
  test(`conflict recovery supports ${choice} without taking another branch`, async () => {
    const conflict = await loadConflictModule();
    assert.equal(typeof conflict.resolveSaveConflict, 'function');
    let refreshes = 0;
    let overwrites = 0;
    const result = await conflict.resolveSaveConflict(
      new Error('wrapped: CONFLICT|{"kind":"catalogProject","id":"one","updatedAt":2}'),
      {
        choose: async () => choice,
        refresh: async () => { refreshes += 1; return { id: 'one', name: 'Remote', updatedAt: 2 }; },
        overwrite: async () => { overwrites += 1; return { id: 'one', name: 'Local', updatedAt: 3 }; },
      },
    );
    assert.equal(result.choice, choice);
    assert.equal(result.row?.name, choice === 'refresh' ? 'Remote' : choice === 'overwrite' ? 'Local' : undefined);
    assert.equal(refreshes, choice === 'refresh' ? 1 : 0);
    assert.equal(overwrites, choice === 'overwrite' ? 1 : 0);
  });
}

test('conflict recovery rethrows ordinary save failures', async () => {
  const conflict = await loadConflictModule();
  assert.equal(typeof conflict.resolveSaveConflict, 'function');
  const error = new Error('network down');
  await assert.rejects(conflict.resolveSaveConflict(error, {
    choose: async () => 'cancel', refresh: async () => null, overwrite: async () => null,
  }), error);
});
