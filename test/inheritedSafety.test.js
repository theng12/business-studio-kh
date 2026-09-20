const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-inherited-safety-'));
  try { return await run(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

function loadWithStubs(modulePath, stubs) {
  const resolved = require.resolve(modulePath);
  const originalLoad = Module._load;
  delete require.cache[resolved];
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(modulePath); }
  finally { Module._load = originalLoad; }
}

test('Social Grid list/create stay in the active company', () => {
  const calls = [];
  const handlers = new Map();
  const socialGrid = loadWithStubs('../main/ipc/socialGrid', {
    sharp: () => ({}),
    '../db/socialGridPresets': {
      list: (companyId) => { calls.push(['list', companyId]); return [{ companyId }]; },
      create: (input) => { calls.push(['create', input.companyId]); return { ...input, id: 'preset-1' }; },
    },
    '../db/products': { list: () => [] },
    '../db/brands': { list: () => [] },
    '../db/companies': { getActiveId: () => 'company-A' },
    '../socialGridRenderer': { buildPageHtml: () => '', seriesSlug: () => '', fileNameFor: () => '' },
    '../studioRenderer': { assetDataUri: () => null },
    '../renderWindow': { withWindow: async () => null },
    '../events': { broadcast: () => {} },
    '../util/socialGridModel': {
      normalizeConfig: (value) => value || {}, selectProducts: () => [],
      paginate: () => [], summarize: () => ({}),
    },
  });

  socialGrid.register({
    expose: (name, handler) => handlers.set(name, handler),
    exposeLocal: (name, handler) => handlers.set(name, handler),
    emitCatalogChange: () => {},
    assertEntityInActiveCompany: (row) => row,
  });

  assert.deepEqual(handlers.get('socialGrid:list')({ companyId: 'company-B' }), []);
  assert.throws(
    () => handlers.get('socialGrid:create')({ companyId: 'company-B', name: 'Wrong tenant' }),
    /cross-company/i,
  );
  assert.deepEqual(handlers.get('socialGrid:list')({ companyId: 'company-A' }), [{ companyId: 'company-A' }]);
  assert.equal(handlers.get('socialGrid:create')({ companyId: 'company-A', name: 'Allowed' }).companyId, 'company-A');
  assert.deepEqual(calls, [['list', 'company-A'], ['create', 'company-A']]);
});

test('standalone image IPC authorizes drag paths, preserves copy collisions, and reports import failures', async () => {
  await withTempDir(async (root) => {
    const dataDir = path.join(root, 'data');
    const allowedRel = 'products/acme/item-001.png';
    const allowedAbs = path.join(dataDir, 'assets', allowedRel);
    await fsp.mkdir(path.dirname(allowedAbs), { recursive: true });
    await fsp.writeFile(allowedAbs, 'image');
    await fsp.writeFile(path.join(root, 'config.json'), 'secret');

    const invokeHandlers = new Map();
    const sendHandlers = new Map();
    const dragged = [];
    const sharpChain = {
      rotate() { return this; }, resize() { return this; }, png() { return this; },
      async toBuffer() { return Buffer.from('icon'); },
    };
    const productImages = {
      listByProduct: () => [{ filepath: allowedRel }],
      addFromSource: async () => { throw new Error('decoder rejected file'); },
    };
    const images = loadWithStubs('../main/ipc/images', {
      electron: {
        ipcMain: { on: (name, handler) => sendHandlers.set(name, handler) },
        dialog: {},
        net: {
          fetch: async (url) => new Response(`bytes:${decodeURIComponent(String(url).replace('app-image://local/', ''))}`),
        },
        shell: { openPath: async () => '' },
        nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }), createEmpty: () => ({}) },
      },
      sharp: () => sharpChain,
      '../db/products': {
        list: () => [{ id: 'product-1', sku: 'SKU', imageCount: 0 }],
        recomputeProcessStatus: () => {},
      },
      '../db/productImages': productImages,
      '../db': { getDataDir: () => dataDir },
      '../imageManager': {
        MAX_IMAGES_PER_PRODUCT: 50,
        scanImagesRecursive: () => [path.join(root, 'SKU.png')],
        groupAndSortMatches: () => ({
          groups: new Map([['sku', [{ sourcePath: path.join(root, 'SKU.png') }]]]),
          unmatched: [],
        }),
      },
      '../db/auditLog': { log: () => {} },
      '../events': { broadcast: () => {} },
    });

    images.register({
      expose: (name, handler) => invokeHandlers.set(name, handler),
      exposeLocal: (name, handler) => invokeHandlers.set(name, handler),
      emitCatalogChange: () => {}, assertProductInActiveCompany: () => {},
      SAFE_WATERMARK_EXTS: new Set(['.png']),
    });

    const prep = await invokeHandlers.get('images:prepareDrag')({
      productId: 'product-1', filepaths: [allowedRel, '../../config.json'],
    });
    assert.deepEqual(prep.files, [fs.realpathSync(allowedAbs)]);
    assert.match(prep.failed[0].error, /not attached|outside|not allowed/i);

    const startDrag = sendHandlers.get('images:startDragOut');
    await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, null);
    await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, { preparedPaths: 'not-an-array' });
    await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, { preparedPaths: ['/etc/hosts'] });
    assert.deepEqual(dragged, [], 'an arbitrary renderer path must not start a drag');
    await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, { preparedPaths: prep.files });
    assert.deepEqual(dragged, [[fs.realpathSync(allowedAbs)]]);

    const outputDir = path.join(root, 'copies');
    await fsp.mkdir(outputDir);
    await fsp.writeFile(path.join(outputDir, 'SKU-001.png'), 'existing');
    const copyArgs = {
      productId: 'product-1', filepaths: [allowedRel], targetFolder: outputDir, sku: 'SKU',
    };
    const [copyA, copyB] = await Promise.all([
      invokeHandlers.get('images:copyImagesToFolder')(copyArgs),
      invokeHandlers.get('images:copyImagesToFolder')(copyArgs),
    ]);
    assert.equal(copyA.copied + copyB.copied, 2);
    assert.equal(await fsp.readFile(path.join(outputDir, 'SKU-001.png'), 'utf8'), 'existing');
    assert.equal(await fsp.readFile(path.join(outputDir, 'SKU-001 (1).png'), 'utf8'), `bytes:${allowedRel}`);
    assert.equal(await fsp.readFile(path.join(outputDir, 'SKU-001 (2).png'), 'utf8'), `bytes:${allowedRel}`);

    const companiesFilename = require.resolve('../main/db/companies');
    const oldCompanies = require.cache[companiesFilename];
    require.cache[companiesFilename] = {
      id: companiesFilename, filename: companiesFilename, loaded: true,
      exports: { getActiveId: () => 'company-A' },
    };
    try {
      const result = await invokeHandlers.get('images:autoMatchBySku')({ companyId: 'company-A', folderPath: root });
      assert.equal(result.imagesSkippedDup, 0);
      assert.equal(result.imagesFailed, 1);
      assert.deepEqual(result.failures, [{ filepath: 'SKU.png', sku: 'SKU', error: 'decoder rejected file' }]);
    } finally {
      if (oldCompanies) require.cache[companiesFilename] = oldCompanies;
      else delete require.cache[companiesFilename];
    }
  });
});

test('auto-match results surface import failures with the real filename and message', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../renderer/modules/ProductLibrary/AutoMatchModal.jsx'),
    'utf8',
  );
  assert.match(source, /stats\.imagesFailed/);
  assert.match(source, /Failed imports/);
  assert.match(source, /failure\.filepath.*failure\.error/);
});

test('exclusive output naming has no suffix ceiling and is race-safe', async () => {
  const { writeUniqueFile } = require('../main/util/exclusiveFile');
  await withTempDir(async (dir) => {
    await fsp.writeFile(path.join(dir, 'export.png'), 'old');
    for (let n = 2; n <= 1001; n += 1) {
      await fsp.writeFile(path.join(dir, `export-${n}.png`), 'old');
    }
    const afterCeiling = await writeUniqueFile(dir, 'export.png', Buffer.from('new'));
    assert.equal(path.basename(afterCeiling), 'export-1002.png');
    assert.equal(await fsp.readFile(path.join(dir, 'export-1001.png'), 'utf8'), 'old');

    const raced = await Promise.all(Array.from({ length: 5 }, (_, i) => (
      writeUniqueFile(dir, 'race.png', Buffer.from(`body-${i}`))
    )));
    assert.equal(new Set(raced).size, 5);
    assert.deepEqual(
      (await Promise.all(raced.map((file) => fsp.readFile(file, 'utf8')))).sort(),
      ['body-0', 'body-1', 'body-2', 'body-3', 'body-4'],
    );
  });
});
