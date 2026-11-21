/**
 * Trade Finance wiring (docs/TRADE_FINANCE_PLAN.md Phase A).
 *
 * The module is opt-in and spread over the registry, routes, navigation,
 * capabilities, preload, IPC and validators. These pin the joins that fail
 * silently when one side is forgotten — the same class of bug that made a
 * sidebar click do nothing when a page was missing from the allow-list.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function load(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const reg = load('renderer/lib/modules.js');
const PAGE_IDS = ['tradefacilities', 'tradedrawdowns', 'tradeinterest', 'tradereminders', 'tradereports'];

test('Trade Finance is one opt-in module with five built pages', () => {
  const mod = reg.APP_MODULES.find((m) => m.id === 'trade');
  assert.ok(mod, 'the trade module exists');
  assert.equal(mod.name, 'Trade Finance');
  assert.equal(mod.icon, 'bank');
  assert.equal(typeof mod.badge?.load, 'function', 'the tile badge counts due reminders');
  assert.deepEqual(reg.allPages().filter((p) => p.moduleId === 'trade').map((p) => p.id), PAGE_IDS);
  for (const page of reg.allPages().filter((p) => p.moduleId === 'trade')) {
    assert.deepEqual(page.caps, ['trade.view', 'trade.manage'], `${page.id} is gated on the trade caps`);
  }
});

test('every trade page is routed, allowed and crawled', () => {
  const pages = strip(read('renderer/App.jsx')).match(/const PAGES\s*=\s*\{([\s\S]*?)\n\};/)[1];
  const routed = [...pages.matchAll(/^\s*([a-z0-9]+):/gm)].map((m) => m[1]);
  const allow = strip(read('renderer/store/navigation.js')).match(/const MODULES\s*=\s*\[([\s\S]*?)\]/)[1];
  const allowed = [...allow.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
  const crawl = read('scripts/probe-ui-crawl.js');
  for (const id of PAGE_IDS) {
    assert.ok(routed.includes(id), `${id} is in PAGES`);
    assert.ok(allowed.includes(id), `${id} is in the MODULES allow-list`);
    assert.match(crawl, new RegExp(`\\['${id}',`), `${id} is in the UI crawl`);
  }
});

test('the caps are opt-in and resolve reads to view, writes to manage', () => {
  const caps = read('main/util/capabilities.js');
  assert.match(caps, /key: 'trade\.view'/);
  assert.match(caps, /key: 'trade\.manage'/);
  assert.match(caps, /OPT_IN_CAPABILITIES = new Set\(\[[^\]]*'trade\.view', 'trade\.manage'/);
  assert.match(caps, /\[\/\^trade:\(context\|facilities:\(list\|get\)\|drawdowns:\(list\|get\)\|interest:\(list\|preview\)\|reports:summary\|movements:list\|capitalisation:preview\|reconciliation:list\|fees:list\|recurring:list\|reminders:\(due\|rules\|log\)\|settings:get\)\$\/, 'trade\.view'\]/);
  assert.match(caps, /\[\/\^trade:\/, +'trade\.manage'\]/);
});

test('every exposed trade channel has a validator', () => {
  const ipc = read('main/ipc/trade.js');
  const channels = [...ipc.matchAll(/expose\('(trade:[^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length >= 15, `expected the whole surface, found ${channels.length}`);
  const { getValidator } = require('../main/server/validators');
  for (const channel of channels) {
    assert.equal(typeof getValidator(channel), 'function', `${channel} has a validator`);
  }
});

test('preload exposes the same surface the screens use', () => {
  const preload = read('main/preload.js');
  for (const call of [
    "invoke('trade:context')", "invoke('trade:facilities:list'", "invoke('trade:drawdowns:list'",
    "invoke('trade:repayments:add'", "invoke('trade:interest:preview')", "invoke('trade:reports:summary')",
    "invoke('trade:reminders:due')", "invoke('trade:reminders:rules:save', input)", "invoke('trade:reminders:snooze', { id, until })",
    "'trade:changed'",
  ]) {
    assert.ok(preload.includes(call), `preload has ${call}`);
  }
  for (const file of ['FacilitiesPage.jsx', 'DrawdownsPage.jsx', 'InterestPage.jsx', 'RemindersPage.jsx', 'ReportsPage.jsx']) {
    const src = read(`renderer/modules/Trade/${file}`);
    assert.ok(src.includes('export function Trade'), `${file} exports a screen`);
  }
});

test('the schema is additive and the DB is registered', () => {
  const schema = read('main/db/tradeFinanceSchema.js');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS tf_facilities/);
  assert.doesNotMatch(schema, /\bDROP TABLE\b/i, 'no destructive schema step');
  assert.match(read('main/db/index.js'), /ensureTradeFinanceSchema\(db\)/);
  assert.match(read('main/ipc.js'), /tradeDomain\.register\(helpers\)/);
});
