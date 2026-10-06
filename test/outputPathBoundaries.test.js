const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharp = require('sharp');
const { getValidator } = require('../main/server/validators');

// Real source/IO; only the DB and Electron services are replaced.
function load(file, stubs = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => Object.hasOwn(stubs, id) ? stubs[id] : localRequire(id),
    module, exports: module.exports, Buffer, process, console,
  }, { filename });
  return module.exports;
}
async function fixture(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-output-boundary-'));
  try { await run(root); } finally { await fsp.rm(root, { recursive: true, force: true }); }
}
function runner(dataDir) {
  return load('main/exportRunner.js', {
    './db': { getDataDir: () => dataDir },
    './db/products': { get: () => ({ id: 'p', sku: 'SKU' }), setProcessStatus() {} },
    './db/productImages': { listByProduct: () => [{ filepath: 'product.png' }] },
    './db/brands': { get: () => null },
  });
}
const profile = { format: 'png', namingPattern: '{SKU}-{INDEX}', outputSubfolder: 'nested/photos' };

test('shared artwork rejects absolute, traversal and symlink escapes, including draft/print/catalog', async () => {
  await fixture(async (root) => {
    const dataDir = path.join(root, 'data');
    await fsp.mkdir(path.join(dataDir, 'assets'), { recursive: true });
    const outside = path.join(root, 'outside.png');
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } }).png().toFile(outside);
    await fsp.symlink(outside, path.join(dataDir, 'assets', 'escape.png'));
    const studio = load('main/studioRenderer.js', { './db': { getDataDir: () => dataDir } });
    for (const rel of [outside, '../../outside.png', '..\\..\\outside.png', 'escape.png', 'C:\\outside.png']) {
      assert.throws(() => studio.assetDataUri(rel), /artwork|image|path|root/i, rel);
      for (const preview of [false, true]) {
        await assert.rejects(studio.labelsDocument({ template: { elements: [{ type: 'image', src: rel }] }, products: [{}], preview }), /artwork|image|path|root/i);
        assert.throws(() => studio.buildCatalogHtml({ project: { config: {} }, products: [{ mainImagePath: rel }] }, { preview }), /artwork|image|path|root/i);
      }
    }
    assert.equal(studio.assetDataUri('missing.png'), '');
  });
});

test('artwork accepts supported imported roots and detects content instead of trusting the extension', async () => {
  await fixture(async (dataDir) => {
    const studio = load('main/studioRenderer.js', { './db': { getDataDir: () => dataDir } });
    for (const rel of ['assets/labels/art.png', 'processed/art.png', 'ai-gallery/art.png']) {
      const abs = path.join(dataDir, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toFile(abs);
      const reference = rel.startsWith('assets/') ? rel.slice(7) : rel;
      assert.match(studio.assetDataUri(reference), /^data:image\/png;base64,/);
      assert.match(studio.assetDataUri(rel), /^data:image\/png;base64,/);
    }
    await fsp.writeFile(path.join(dataDir, 'assets', 'fake.png'), 'NOT_MEDIA_SENTINEL');
    assert.throws(() => studio.assetDataUri('fake.png'), /image|media/i);
    const html = await studio.labelsDocument({ template: { elements: [{ type: 'image', src: 'labels/art.png' }] }, products: [{}], preview: true });
    assert.match(html, /app-image:\/\/local\/labels%2Fart.png/);
  });
});

test('profile persistence and RPC validators reject unsafe subfolders before writes', () => {
  let writes = 0;
  const db = { prepare: () => ({ get: () => ({ id: 'profile', name: 'Profile' }), run: () => { writes++; } }) };
  const profiles = load('main/db/exportProfiles.js', { './index': { getDb: () => db } });
  const invalid = ['../outside', '/outside', 'nested/../outside', 'C:\\outside', '\\outside', 'nested\\..\\outside', 1, 'bad\0name'];
  for (const outputSubfolder of invalid) {
    assert.throws(() => profiles.create({ companyId: 'c', name: 'Profile', outputSubfolder }), /subfolder|relative|path/i);
    assert.throws(() => profiles.update('profile', { outputSubfolder }), /subfolder|relative|path/i);
    assert.notEqual(getValidator('exports:createProfile')({ outputSubfolder }), true);
    assert.notEqual(getValidator('exports:updateProfile')({ id: 'profile', patch: { outputSubfolder } }), true);
  }
  assert.equal(writes, 0);
  assert.equal(getValidator('exports:createProfile')({ outputSubfolder: 'nested/photos' }), true);
  assert.notEqual(getValidator('labels:previewDraft')({ template: { elements: [{ type: 'image', src: '../outside.png' }] } }), true);
});

test('expected paths, collisions and runtime reject stored unsafe subfolders and escaping symlinks', async () => {
  await fixture(async (root) => {
    const outputRoot = path.join(root, 'out');
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outputRoot); await fsp.mkdir(outside);
    await fsp.symlink(outside, path.join(outputRoot, 'link'));
    const exporter = runner(root);
    for (const outputSubfolder of ['../../outside', '/outside', 'C:\\outside', '..\\outside']) {
      const bad = { ...profile, outputSubfolder };
      assert.throws(() => exporter.expectedOutputs({ profile: bad, productIds: ['p'] }), /subfolder|relative|path/i);
      await assert.rejects(exporter.runExport({ profile: bad, productIds: ['p'], outputRoot }), /subfolder|relative|path/i);
    }
    const bad = { ...profile, outputSubfolder: 'link/nested' };
    assert.throws(() => exporter.previewCollisions({ profile: bad, productIds: ['p'], outputRoot }), /root|escape/i);
    await assert.rejects(exporter.runExport({ profile: bad, productIds: ['p'], outputRoot }), /root|escape/i);
    assert.deepEqual(await fsp.readdir(outside), []);
  });
});

test('valid nested exports keep expected paths and collision modes', async () => {
  await fixture(async (root) => {
    const dataDir = path.join(root, 'data');
    await fsp.mkdir(path.join(dataDir, 'assets'), { recursive: true });
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toFile(path.join(dataDir, 'assets', 'product.png'));
    const exporter = runner(dataDir);
    const outputRoot = path.join(root, 'out');
    const args = { profile, productIds: ['p'], outputRoot };
    assert.equal(exporter.expectedOutputs(args).entries[0].rel, 'nested/photos/SKU-001.png');
    assert.equal((await exporter.runExport(args)).exported, 1);
    const first = await fsp.readFile(path.join(outputRoot, 'nested/photos/SKU-001.png'));
    assert.equal(exporter.previewCollisions(args).collisionCount, 1);
    assert.equal((await exporter.runExport({ ...args, onExisting: 'keepBoth' })).exported, 1);
    assert.equal((await exporter.runExport({ ...args, onExisting: 'skip' })).skippedExisting, 1);
    assert.equal((await exporter.runExport({ ...args, onExisting: 'replace' })).replaced, 1);
    assert.deepEqual(await fsp.readFile(path.join(outputRoot, 'nested/photos/SKU-001.png')), first);
    await fsp.symlink(path.join(root, 'sentinel.png'), path.join(outputRoot, 'nested/photos/SKU-002.png'));
    await fsp.writeFile(path.join(root, 'sentinel.png'), 'UNCHANGED');
    const evil = { ...profile, namingPattern: '{SKU}', outputSubfolder: 'nested/photos' };
    await fsp.symlink(path.join(root, 'sentinel.png'), path.join(outputRoot, 'nested/photos/SKU.png'));
    await assert.rejects(exporter.runExport({ ...args, profile: evil, onExisting: 'replace' }), /root|escape/i);
    assert.equal(await fsp.readFile(path.join(root, 'sentinel.png'), 'utf8'), 'UNCHANGED');
  });
});

test('actual runForClient route refuses an unsafe stored subfolder in its temporary root', async () => {
  await fixture(async (root) => {
    const exporter = runner(root);
    const handlers = new Map();
    const ipc = load('main/ipc/exports.js', {
      'node:os': { tmpdir: () => root },
      '../db/companies': {}, '../db/brands': {},
      '../db/exportProfiles': { get: () => ({ ...profile, id: 'profile', outputSubfolder: '../outside' }) },
      '../db/exportRuns': { record: () => assert.fail('failed export must not record success') },
      '../exportRunner': exporter, '../events': { broadcast() {} }, './helpers': { emitCatalogChange() {} },
    });
    ipc.register({ expose: (name, fn) => handlers.set(name, fn), exposeLocal() {}, assertEntityInActiveCompany: (row) => row, assertProductInActiveCompany() {} });
    await assert.rejects(handlers.get('exports:runForClient')({ profileId: 'profile', productIds: ['p'] }), /subfolder|relative|path/i);
  });
});

test('a dangling output symlink cannot create a file outside the chosen root', async () => {
  await fixture(async (root) => {
    const dataDir = path.join(root, 'data');
    const out = path.join(root, 'out');
    await fsp.mkdir(path.join(dataDir, 'assets'), { recursive: true }); await fsp.mkdir(out);
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toFile(path.join(dataDir, 'assets', 'product.png'));
    const outside = path.join(root, 'not-created.png');
    await fsp.symlink(outside, path.join(out, 'SKU-001.png'));
    await assert.rejects(runner(dataDir).runExport({ profile: { ...profile, outputSubfolder: '' }, productIds: ['p'], outputRoot: out, onExisting: 'replace' }), /root|symlink|escape/i);
    assert.equal(fs.existsSync(outside), false);
  });
});

test('registered label draft and Social Grid export share the artwork read guard', async () => {
  await fixture(async (root) => {
    const dataDir = path.join(root, 'data');
    await fsp.mkdir(path.join(dataDir, 'assets'), { recursive: true });
    const outside = path.join(root, 'outside.png');
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } }).png().toFile(outside);
    await fsp.symlink(outside, path.join(dataDir, 'assets', 'escape.png'));
    const studio = load('main/studioRenderer.js', { './db': { getDataDir: () => dataDir } });
    const handlers = new Map();
    const register = { expose: (name, fn) => handlers.set(name, fn), exposeLocal() {}, emitCatalogChange() {}, assertEntityInActiveCompany: (row) => row };
    load('main/ipc/labels.js', {
      '../studioRenderer': studio, '../db/labelTemplates': {}, '../db/labelRuns': {},
      '../db/products': { list: () => [], get: () => null }, '../db/brands': {}, '../db/companies': { getActiveId: () => 'company' },
      '../renderWindow': {}, '../events': {}, '../imageManager': {},
    }).register(register);
    await assert.rejects(handlers.get('labels:previewDraft')({ template: { elements: [{ type: 'image', src: 'escape.png' }] } }), /root|escape/i);
    load('main/ipc/socialGrid.js', {
      '../studioRenderer': studio, '../db/socialGridPresets': {},
      '../db/products': { list: () => [{ id: 'p', sku: 'SKU', mainImagePath: 'escape.png' }] },
      '../db/brands': { list: () => [] }, '../db/companies': { getActiveId: () => 'company' },
      '../renderWindow': { withWindow: () => assert.fail('unsafe artwork must fail before capture') }, '../events': { broadcast() {} },
    }).register(register);
    await assert.rejects(handlers.get('socialGrid:exportBytes')({ config: {} }), /root|escape/i);
  });
});

test('JPEG, WebP and AVIF artwork embed their actual MIME type', async () => {
  await fixture(async (dataDir) => {
    await fsp.mkdir(path.join(dataDir, 'assets'));
    const studio = load('main/studioRenderer.js', { './db': { getDataDir: () => dataDir } });
    for (const [format, mime] of [['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['avif', 'image/avif']]) {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })[format]().toBuffer();
      await fsp.writeFile(path.join(dataDir, 'assets', `${format}.png`), bytes);
      assert.ok(studio.assetDataUri(`${format}.png`).startsWith(`data:${mime};base64,`));
    }
  });
});

test('imported SVG brand logos keep compact label previews and correctly typed full artwork', async () => {
  await fixture(async (dataDir) => {
    const rel = 'brands/acme/logo.svg';
    const abs = path.join(dataDir, 'assets', rel);
    const svg = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- an imported vector logo with a declaration longer than the preview header -->\n<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, svg);
    const studio = load('main/studioRenderer.js', { './db': { getDataDir: () => dataDir } });
    const args = {
      template: { widthMm: 50, heightMm: 25, elements: [{ type: 'logo', x: 0, y: 0, width: 10, height: 10 }] },
      products: [{ id: 'p', brandId: 'brand', sku: 'SKU' }],
      brands: [{ id: 'brand', icon: rel, updatedAt: 123 }],
    };
    const preview = await studio.labelsDocument({ ...args, preview: true });
    assert.match(preview, /<img src="app-image:\/\/local\/brands%2Facme%2Flogo\.svg\?v=123"/);
    const full = await studio.labelsDocument(args);
    const expected = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    assert.ok(full.includes(`<img src="${expected}"`));
    assert.equal(studio.assetDataUri(rel), expected);
    // A .svg name and an SVG embedded inside HTML do not make an SVG image.
    await fsp.writeFile(abs, '<!doctype html><html><body><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>');
    await assert.rejects(studio.labelsDocument({ ...args, preview: true }), /image|media/i);
    await assert.rejects(studio.labelsDocument(args), /image|media/i);
    assert.throws(() => studio.assetDataUri(rel), /image|media/i);
  });
});
