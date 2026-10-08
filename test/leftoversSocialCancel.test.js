/* 0.1.95 audit leftovers, item 1: Social Grid export Cancel.
 * The real handlers run against stubbed data and a stubbed render window; the
 * render of the first image asks for a cancel, and the export must stop after
 * that image, keep it, and say it was cancelled. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadSocialGrid({ onRender, marks, events }) {
  const filename = path.join(ROOT, 'main/ipc/socialGrid.js');
  const req = createRequire(filename);
  const module = { exports: {} };
  const products = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`, sku: `SKU-${i}`, name: `Product ${i}`, status: 'active', priceRetail: i + 1,
  }));
  const stubs = {
    '../db/socialGridPresets': { get: (id) => ({ id }), markExported: (id) => marks.push(id) },
    '../db/socialGridTemplates': {},
    '../db/products': { list: () => products },
    '../db/brands': { list: () => [] },
    '../db/companies': { getActiveId: () => 'company' },
    '../studioRenderer': { assetDataUri: () => '' },
    '../renderWindow': { withWindow: async (html, options, task) => { await onRender(); return task({ webContents: { capturePage: async () => ({ toPNG: () => PNG }) } }); } },
    '../events': { broadcast: (channel, payload) => events.push({ channel, payload }) },
  };
  const source = fs.readFileSync(filename, 'utf8');
  new Function('require', 'module', 'exports', source)((id) => (Object.hasOwn(stubs, id) ? stubs[id] : req(id)), module, module.exports);
  const handlers = new Map();
  module.exports.register({
    expose: (name, fn) => handlers.set(name, fn),
    exposeLocal: (name, fn) => handlers.set(name, fn),
    emitCatalogChange() {},
    assertEntityInActiveCompany: (row) => row,
  });
  return { handlers, mod: module.exports };
}

let PNG;
test.before(async () => {
  PNG = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } }).png().toBuffer();
});

// One product per image: six products → a series of six.
const CONFIG = { width: 200, height: 200, columns: 1, rows: 1, padding: 0, gap: 0 };

test('socialGrid:export stops after the image in progress and reports what it wrote', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-social-cancel-'));
  const marks = [];
  const events = [];
  const runId = 'social-123-abcd';
  let renders = 0;
  let handlers;
  ({ handlers } = loadSocialGrid({
    marks, events,
    onRender: async () => { renders += 1; if (renders === 2) assert.deepEqual(await handlers.get('socialGrid:cancelExport')({ runId }), { ok: true }); },
  }));
  try {
    const res = await handlers.get('socialGrid:export')({ config: CONFIG, outputFolder: dir, presetId: 'preset-1', runId });
    assert.equal(res.cancelled, true);
    assert.equal(res.written, 2, 'the image being rendered when Cancel arrived is finished and kept');
    assert.equal(res.pageCount, 6);
    assert.equal((await fsp.readdir(dir)).length, 2);
    assert.deepEqual(marks, [], 'a cancelled run does not move "last exported"');
    assert.ok(events.some((e) => e.payload?.id === runId && e.payload.cancellable === true));
    assert.ok(events.some((e) => e.payload?.id === runId && e.payload.complete === true));
    // The run left the registry: a late Cancel is a harmless no-op.
    assert.deepEqual(await handlers.get('socialGrid:cancelExport')({ runId }), { ok: false });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an uncancelled export writes the whole series and marks the preset', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-social-full-'));
  const marks = [];
  const { handlers } = loadSocialGrid({ marks, events: [], onRender: async () => {} });
  try {
    const res = await handlers.get('socialGrid:export')({ config: CONFIG, outputFolder: dir, presetId: 'preset-1', runId: 'social-9-z' });
    assert.equal(res.cancelled, false);
    assert.equal(res.written, 6);
    assert.deepEqual(marks, ['preset-1']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('socialGrid:exportBytes (the client path) is cancellable by the same run id', async () => {
  const events = [];
  const runId = 'social-77-client';
  let renders = 0;
  let handlers;
  ({ handlers } = loadSocialGrid({
    marks: [], events,
    onRender: async () => { renders += 1; if (renders === 3) await handlers.get('socialGrid:cancelExport')({ runId }); },
  }));
  const res = await handlers.get('socialGrid:exportBytes')({ config: CONFIG, runId });
  assert.equal(res.cancelled, true);
  assert.equal(res.files.length, 3);
  assert.equal(res.pageCount, 6, 'the planned size travels so the client names the partial set as the series');
  // A named client run reports per-image progress (it reaches the client over the WebSocket).
  assert.ok(events.filter((e) => e.payload?.id === runId && e.payload.done != null).length >= 3);
  // An unnamed (older client) call is not registered and still works.
  const legacy = await handlers.get('socialGrid:exportBytes')({ config: CONFIG });
  assert.equal(legacy.cancelled, false);
  assert.equal(legacy.files.length, 6);
});

test('a Cancel that arrives before the run starts stops it before the first image', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-social-early-'));
  const marks = [];
  let renders = 0;
  const { handlers } = loadSocialGrid({ marks, events: [], onRender: async () => { renders += 1; } });
  try {
    // Pressed while the renderer was still flushing the post / the RPC was in flight.
    assert.deepEqual(await handlers.get('socialGrid:cancelExport')({ runId: 'social-1-early' }), { ok: true, early: true });
    const res = await handlers.get('socialGrid:export')({ config: CONFIG, outputFolder: dir, presetId: 'preset-1', runId: 'social-1-early' });
    assert.equal(res.cancelled, true);
    assert.equal(res.written, 0);
    assert.equal(renders, 0, 'nothing was rendered');
    assert.deepEqual(await fsp.readdir(dir), []);
    assert.deepEqual(marks, []);
    // Same for the client path (the client's Cancel is proxied to the server).
    await handlers.get('socialGrid:cancelExport')({ runId: 'social-2-early' });
    const bytes = await handlers.get('socialGrid:exportBytes')({ config: CONFIG, runId: 'social-2-early' });
    assert.equal(bytes.cancelled, true);
    assert.equal(bytes.files.length, 0);
    // The early cancel is used up: the same id runs normally next time.
    const again = await handlers.get('socialGrid:exportBytes')({ config: CONFIG, runId: 'social-2-early' });
    assert.equal(again.cancelled, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an early cancel expires after a minute, and the memory is bounded', () => {
  const { mod } = loadSocialGrid({ marks: [], events: [], onRender: async () => {} });
  const t0 = 1_000_000;
  mod.cancelExport('social-old-1', t0);
  assert.equal(mod.startExport('social-old-1', t0 + 61_000).cancelled, false, 'expired');
  mod.cancelExport('social-new-1', t0);
  assert.equal(mod.startExport('social-new-1', t0 + 59_000).cancelled, true);
  // 300 stray cancels never grow the map past its cap; the newest still works.
  for (let i = 0; i < 300; i += 1) mod.cancelExport(`social-flood-${i}`, t0);
  assert.equal(mod.startExport('social-flood-299', t0 + 1).cancelled, true);
  assert.equal(mod.startExport('social-flood-0', t0 + 1).cancelled, false, 'oldest evicted');
});

test('cancel ignores ids that are not social run ids', async () => {
  const { mod } = loadSocialGrid({ marks: [], events: [], onRender: async () => {} });
  assert.equal(mod.isSocialRunId('social-1-a'), true);
  assert.equal(mod.isSocialRunId('export-1'), false);
  assert.equal(mod.isSocialRunId('social-../../x'), false);
  assert.deepEqual(mod.cancelExport('nope'), { ok: false });
});

test('wiring: channel exposed + validated + proxied, client writes the partial set, UI has Cancel', () => {
  assert.match(read('main/ipc/socialGrid.js'), /expose\('socialGrid:cancelExport'/);
  assert.match(read('main/server/validators.js'), /'socialGrid:cancelExport':\s+requireNonEmptyStringFields\('runId'\)/);
  assert.match(read('main/preload.js'), /cancelExport: \(runId\) => invoke\('socialGrid:cancelExport', \{ runId \}\)/);
  const client = read('main/client/index.js');
  assert.ok(client.includes("'socialGrid:cancelExport',"), 'proxied: the render runs on the server');
  assert.match(client, /rpc\('socialGrid:exportBytes', \{ config, runId \}\)/);
  assert.match(client, /if \(presetId && !cancelled\) await rpc\('socialGrid:markExported'/);
  // A dropped socket cannot leave this Mac's progress row open.
  assert.match(client, /finally \{\s*if \(namedRun\) require\('\.\.\/events'\)\.broadcast\('progress:event', \{ id: runId, complete: true \}\)/);
  const ui = read('renderer/modules/SocialGrid/index.jsx');
  assert.match(ui, /onCancel=\{cancelExport\}/);
  assert.match(ui, /window\.api\.socialGrid\.cancelExport\(runId\)/);
  // A Cancel during the pre-export flush never starts the export.
  assert.match(ui, /if \(dirty\.current\) await flushPending\(\);\s*if \(cancelRequested\.current\)/);
  assert.match(read('renderer/components/GenerationExperience.jsx'), /onCancel \? \(/);
});

test('the result toast is honest about a cancel', () => {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    stdin: { contents: "export { socialExportMessage } from './renderer/modules/SocialGrid/index.jsx';", resolveDir: ROOT, loader: 'js' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'zustand', 'zustand/*'],
  });
  const mod = { exports: {} };
  const fake = new Proxy(function fake() {}, { get: () => fake, apply: () => fake });
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => (/^(react|zustand)/.test(id) ? fake : require(id)), mod, mod.exports);
  const { socialExportMessage } = mod.exports;
  assert.deepEqual(socialExportMessage({ cancelled: true, written: 2, pageCount: 6 }, '/out'), { text: 'Export cancelled — 2 images written to /out', kind: 'info' });
  assert.deepEqual(socialExportMessage({ cancelled: true, written: 0 }, '/out'), { text: 'Export cancelled — no images written', kind: 'info' });
  assert.deepEqual(socialExportMessage({ cancelled: false, written: 1, pageCount: 1 }, '/out'), { text: 'Saved 1 image to /out', kind: 'success' });
});
