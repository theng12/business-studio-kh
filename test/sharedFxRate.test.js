/**
 * Finance §5: one shared exchange rate per company, and the renderer never
 * fabricates one.
 *
 *   1. The store reads fx:getShared; a failed read clears the rate instead of
 *      leaving a stale number or falling back to 4,100.
 *   2. Saving goes through fx:setShared and the shared 100–100,000 band.
 *   3. The wiring that carries the rate between Macs is present: expose (not
 *      exposeLocal) handlers, the client proxy, the preload surface, and the
 *      refetch hooks (assets:changed kind `fx`, company switch, reconnect).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Bundle one renderer ES module to CJS (React/zustand stubbed; nothing renders). */
function loadEsm(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react/jsx-runtime', 'zustand'],
  });
  const mod = { exports: {} };
  const fakeReact = new Proxy({}, { get: () => () => {} });
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(
    (id) => (id === 'react' || id === 'react/jsx-runtime' || id === 'zustand' ? fakeReact : require(id)), mod, mod.exports,
  );
  return mod.exports;
}

function sliceHarness(api) {
  global.window = { api };
  let state = {};
  const set = (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const slice = loadEsm('renderer/store/app.js').createAppSlice(set, () => state);
  state = { ...slice };
  return { getState: () => state, setState: (patch) => set(patch) };
}

test('shared rate: a failed load clears the rate — never a stale or fabricated number', async () => {
  const h = sliceHarness({ fx: { getShared: async () => ({ khrPerUsd: 4230, rateDate: '2026-11-03', source: 'house' }) } });
  await h.getState().refreshHouseRate();
  assert.equal(h.getState().houseKhrPerUsd, 4230);
  assert.equal(h.getState().houseRateError, '');
  assert.equal(h.getState().houseRateLoading, false);

  global.window.api.fx.getShared = async () => { throw new Error('server unreachable'); };
  await h.getState().refreshHouseRate();
  assert.equal(h.getState().houseKhrPerUsd, null, 'the previous value must not survive a failed refetch');
  assert.notEqual(h.getState().houseKhrPerUsd, 4100, 'no made-up default');
  assert.equal(h.getState().houseRateError, 'server unreachable');
  assert.equal(h.getState().houseRateLoading, false);
});

test('shared rate: company switch clears the previous rate while loading and ignores stale replies', async () => {
  const replies = [];
  const h = sliceHarness({ fx: { getShared: () => new Promise(resolve => replies.push(resolve)) } });
  h.setState({ activeCompanyId: 'first', houseKhrPerUsd: 4100 });
  const first = h.getState().refreshHouseRate();
  h.setState({ activeCompanyId: 'second' });
  const second = h.getState().refreshHouseRate();
  assert.equal(h.getState().houseKhrPerUsd, null);
  assert.equal(h.getState().houseRateLoading, true);
  replies[1]({ khrPerUsd: 4200 });
  await second;
  replies[0]({ khrPerUsd: 4300 });
  await first;
  assert.equal(h.getState().houseKhrPerUsd, 4200);
  assert.equal(h.getState().houseRateLoading, false);
});

test('shared rate: saving goes through fx:setShared inside the 100–100,000 band', async () => {
  const sent = [];
  const h = sliceHarness({ fx: {
    getShared: async () => ({ khrPerUsd: 4230, rateDate: '2026-11-03', source: 'house' }),
    setShared: async (n) => { sent.push(n); return { khrPerUsd: n, rateDate: '2026-11-03', source: 'house' }; },
  } });
  assert.equal(await h.getState().setHouseExchangeRate('4,230'), 4230);
  assert.deepEqual(sent, [4230]);
  assert.equal(h.getState().houseKhrPerUsd, 4230);

  await assert.rejects(() => h.getState().setHouseExchangeRate(99), /between 100 and 100000/);
  await assert.rejects(() => h.getState().setHouseExchangeRate(100001), /between 100 and 100000/);
  await assert.rejects(() => h.getState().setHouseExchangeRate('abc'), /number above 0/);
  assert.deepEqual(sent, [4230], 'an invalid value is refused before any write');
});

test('a failed save releases a superseded refresh loading state', async () => {
  let reply;
  const h = sliceHarness({ fx: {
    getShared: () => new Promise(resolve => { reply = resolve; }),
    setShared: async () => { throw new Error('save refused'); },
  } });
  const refreshing = h.getState().refreshHouseRate();
  await assert.rejects(() => h.getState().setHouseExchangeRate(4200), /save refused/);
  reply({ khrPerUsd: 4100 });
  await refreshing;
  assert.equal(h.getState().houseRateLoading, false);
  assert.equal(h.getState().houseRateError, 'save refused');
});

test('shared rate wiring: expose handlers, client proxy, preload and refetch hooks', () => {
  const ledger = read('main/ipc/ledger.js');
  assert.match(ledger, /expose\('fx:getShared'/);
  assert.match(ledger, /expose\('fx:setShared'/);
  assert.doesNotMatch(ledger, /exposeLocal\('fx:/, 'both must be reachable from a remote client');

  // A connecting Mac talks to the server's data, never its own.
  assert.match(read('main/client/index.js'), /'fx:getShared','fx:setShared'/);
  const preload = read('main/preload.js');
  assert.match(preload, /getShared:\s*\(\)\s*=> invoke\('fx:getShared'\)/);
  assert.match(preload, /setShared:\s*\(khrPerUsd\)\s*=> invoke\('fx:setShared', \{ khrPerUsd \}\)/);

  // Every Mac refetches on a rate change, a company switch and a reconnect.
  const boot = read('renderer/store/bootstrap.js');
  assert.match(boot, /evt\?\.kind !== 'fx'/);
  assert.match(boot, /void get\(\)\.refreshHouseRate\(\)/);
  assert.match(read('renderer/store/companies.js'), /void get\(\)\.refreshHouseRate\(\)/);

  // The renderer no longer writes or mirrors the per-Mac config value.
  const app = read('renderer/store/app.js');
  assert.match(app, /fx\.getShared\(\)/);
  assert.match(app, /fx\.setShared\(rate\)/);
  assert.doesNotMatch(app, /settings\.setOne\('exchangeRateKhrPerUsd'/);
  assert.doesNotMatch(boot, /houseKhrPerUsd: houseRateFrom\(settings\)/);

  // fuel takes the caller's company and reads the DB rate (docs/FINANCE_PLAN.md §5).
  assert.match(read('main/db/fuel.js'), /function fxKhrPerUsd\(companyId, date = null\)/);
  assert.match(read('main/db/fxRates.js'), /function sharedRate\(companyId/);
  assert.doesNotMatch(read('main/db/fxRates.js'), /require\('\.\/fuel'\)/, 'the seed source is config, not a fuel round-trip');
});
