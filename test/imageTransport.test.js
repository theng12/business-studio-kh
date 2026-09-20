const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-transport-test-'));
  try { return await run(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

function loadProtocol(electron) {
  const originalLoad = Module._load;
  const filename = require.resolve('../main/protocol');
  delete require.cache[filename];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../main/protocol'); }
  finally { Module._load = originalLoad; }
}

test('local image protocol rejects a same-prefix sibling while serving allowed roots', async () => {
  await withTempDir(async (dataDir) => {
    const handlers = new Map();
    const electron = {
      protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
      net: {
        fetch: async (fileUrl) => new Response(await fsp.readFile(fileURLToPath(fileUrl))),
      },
    };
    const { registerImageProtocol } = loadProtocol(electron);

    await fsp.mkdir(path.join(dataDir, 'assets'), { recursive: true });
    await fsp.mkdir(path.join(dataDir, 'assets-sibling'), { recursive: true });
    await fsp.mkdir(path.join(dataDir, 'processed'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'assets', 'inside.txt'), 'inside');
    await fsp.writeFile(path.join(dataDir, 'processed', 'processed.txt'), 'processed');
    await fsp.writeFile(path.join(dataDir, 'assets-sibling', 'outside.txt'), 'outside');

    registerImageProtocol(dataDir);
    const handler = handlers.get('app-image');
    const inside = await handler({ url: 'app-image://local/inside.txt' });
    const processed = await handler({ url: 'app-image://local/processed%2Fprocessed.txt' });
    const escaped = await handler({ url: 'app-image://local/..%2Fassets-sibling%2Foutside.txt' });

    assert.equal(inside.status, 200);
    assert.equal(await inside.text(), 'inside');
    assert.equal(processed.status, 200);
    assert.equal(await processed.text(), 'processed');
    assert.equal(escaped.status, 403);
  });
});

test('renderer protocol rejects a same-prefix sibling', async () => {
  await withTempDir(async (parent) => {
    const rendererDir = path.join(parent, 'renderer');
    const siblingDir = path.join(parent, 'renderer-sibling');
    await fsp.mkdir(rendererDir);
    await fsp.mkdir(siblingDir);
    await fsp.writeFile(path.join(rendererDir, 'index.html'), 'inside');
    await fsp.writeFile(path.join(siblingDir, 'outside.html'), 'outside');
    const handlers = new Map();
    const electron = {
      protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
      net: { fetch: async (fileUrl) => new Response(await fsp.readFile(fileURLToPath(fileUrl))) },
    };
    const { registerRendererProtocol } = loadProtocol(electron);
    registerRendererProtocol(rendererDir);

    const handler = handlers.get('app');
    assert.equal((await handler({ url: 'app://local/index.html' })).status, 200);
    assert.equal((await handler({ url: 'app://local/..%2Frenderer-sibling%2Foutside.html' })).status, 403);
  });
});

test('client image protocol preserves version identity upstream and forbids outer response caching', async () => {
  const handlers = new Map();
  const upstreamCalls = [];
  const globalCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (...args) => {
    globalCalls.push(args);
    return new Response('global');
  };
  try {
    let connection = { base: 'http://server-a.test', auth: 'Bearer token-a' };
    const electron = {
      protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
      net: {
        fetch: async (url, options) => {
          upstreamCalls.push({ url, options });
          return new Response('fresh', { headers: { 'Content-Type': 'image/png' } });
        },
      },
    };
    const { registerClientImageProtocol } = loadProtocol(electron);
    registerClientImageProtocol(() => ({
      baseUrl: () => connection.base,
      authHeader: () => connection.auth,
    }));

    const handler = handlers.get('app-image');
    const first = await handler({ url: 'app-image://local/products%2Fone.png?v=hash-1' });
    connection = { base: 'http://server-b.test', auth: 'Bearer token-b' };
    const second = await handler({ url: 'app-image://local/products%2Fone.png?v=hash-1' });

    assert.equal(globalCalls.length, 0, 'Electron net.fetch should own HTTP caching');
    assert.deepEqual(upstreamCalls.map((call) => {
      const parsed = new URL(call.url);
      return { origin: parsed.origin, path: parsed.pathname, version: parsed.searchParams.get('v') };
    }), [
      { origin: 'http://server-a.test', path: '/assets/products/one.png', version: 'hash-1' },
      { origin: 'http://server-b.test', path: '/assets/products/one.png', version: 'hash-1' },
    ]);
    const authKeys = upstreamCalls.map((call) => new URL(call.url).searchParams.get('_auth'));
    assert.ok(authKeys.every((key) => /^[a-f0-9]{16}$/.test(key)));
    assert.notEqual(authKeys[0], authKeys[1]);
    assert.deepEqual(upstreamCalls.map((call) => call.options.headers.Authorization), [
      'Bearer token-a', 'Bearer token-b',
    ]);
    assert.deepEqual(upstreamCalls.map((call) => call.options.cache), ['no-cache', 'no-cache']);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(second.headers.get('cache-control'), 'no-store');
  } finally {
    global.fetch = originalFetch;
  }
});

function loadClientHarness({ rpcResult, assetResponse, imageResponse }) {
  const handlers = new Map();
  const sendHandlers = new Map();
  const electron = {
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => sendHandlers.set(channel, handler),
    },
    app: { getVersion: () => '0.1.32' },
    BrowserWindow: {
      getAllWindows: () => [],
      getFocusedWindow: () => null,
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    shell: { openPath: async () => '' },
    net: { fetch: imageResponse || (async () => new Response('image')) },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }), createEmpty: () => ({}) },
  };
  class FakeWebSocket extends EventEmitter {}
  FakeWebSocket.OPEN = 1;
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const clientFilename = require.resolve('../main/client');
  delete require.cache[clientFilename];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'ws') return FakeWebSocket;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/assets/')) return assetResponse?.(url, options) || new Response(null, { status: 404 });
    const request = options.body ? JSON.parse(options.body) : {};
    const result = await rpcResult(request.channel, request.args);
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  global.setTimeout = () => ({ unref() {} });
  const client = require('../main/client');
  client.registerClientProxies(() => ({
    clientServerUrl: 'http://server.test',
    clientToken: 'token',
  }));
  global.setTimeout = originalSetTimeout;

  return {
    handlers,
    sendHandlers,
    restore() {
      Module._load = originalLoad;
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
      delete require.cache[clientFilename];
    },
  };
}

test('registered client overlay bridges handle an empty result and report missing required artwork', async () => {
  const externalFilename = require.resolve('../main/util/externalOverlay');
  const oldExternal = require.cache[externalFilename];
  require.cache[externalFilename] = {
    id: externalFilename,
    filename: externalFilename,
    loaded: true,
    exports: {
      validateExternalRequest: () => {},
      applyTemplateToFiles: async ({ resolveAsset, outputFolder }) => {
        try {
          await resolveAsset('watermarks/required.png');
          return { done: 1, failed: [], total: 1, outputFolder };
        } catch (err) {
          return { done: 0, failed: [{ src: 'input.jpg', error: err.message }], total: 1, outputFolder };
        }
      },
    },
  };
  const harness = loadClientHarness({
    rpcResult: async (channel) => channel === 'templates:get'
      ? { id: 'template-1', name: 'Required artwork' }
      : { done: [], outputs: [] },
  });
  try {
    await withTempDir(async (dir) => {
      const empty = await harness.handlers.get('templates:applyToProduct')({}, {
        templateId: 'template-1',
        productId: 'product-1',
        destination: { kind: 'saveToFolder', folder: dir },
      });
      assert.deepEqual(empty.outputs, []);
      assert.equal(empty.outputFolder, path.resolve(dir));

      const external = await harness.handlers.get('templates:applyToExternal')({}, {
        templateId: 'template-1',
        inputPaths: [path.join(dir, 'input.jpg')],
        outputFolder: dir,
      });
      assert.equal(external.done, 0);
      assert.equal(external.failed.length, 1);
      assert.match(external.failed[0].error, /required\.png.*404|404.*required\.png/i);
    });
  } finally {
    harness.restore();
    if (oldExternal) require.cache[externalFilename] = oldExternal;
    else delete require.cache[externalFilename];
  }
});

test('real external compositor reports a configured artwork fetch failure per file', async () => {
  const sharp = require('sharp');
  const { applyTemplateToFiles } = require('../main/util/externalOverlay');
  await withTempDir(async (dir) => {
    const input = path.join(dir, 'input.png');
    const output = path.join(dir, 'output');
    await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#ffffff' },
    }).png().toFile(input);
    const template = {
      name: 'Required artwork',
      elements: [{
        id: 'required-image', type: 'image', source: 'asset:watermarks/required.png',
        x: 0.5, y: 0.5, width: 0.5, height: 0.5,
      }],
    };

    const failed = await applyTemplateToFiles({
      template,
      inputPaths: [input],
      outputFolder: output,
      resolveAsset: async () => { throw new Error('server returned 404'); },
    });
    assert.equal(failed.done, 0);
    assert.deepEqual(failed.failed, [{ src: input, error: 'server returned 404' }]);
    assert.deepEqual(await fsp.readdir(output), []);

    const optional = await applyTemplateToFiles({
      template: {
        name: 'Optional brand',
        elements: [{ id: 'brand', type: 'image', source: 'brand-icon' }],
      },
      inputPaths: [input],
      outputFolder: output,
      resolveAsset: async () => { throw new Error('should not resolve unset optional artwork'); },
    });
    assert.equal(optional.done, 1);
    assert.deepEqual(optional.failed, []);

    const second = await applyTemplateToFiles({
      template: {
        name: 'Optional brand',
        elements: [{ id: 'brand', type: 'image', source: 'brand-icon' }],
      },
      inputPaths: [input],
      outputFolder: output,
      resolveAsset: async () => null,
    });
    assert.equal(second.done, 1);
    assert.deepEqual((await fsp.readdir(output)).sort(), [
      'input-Optional-brand-2.png', 'input-Optional-brand.png',
    ]);
  });
});

test('registered RPC bridge rejects a transfer that exceeds the encoded request limit before fetch', async () => {
  let rpcCalls = 0;
  const harness = loadClientHarness({
    rpcResult: async () => { rpcCalls += 1; return { ok: true }; },
  });
  const originalByteLength = Buffer.byteLength;
  try {
    Buffer.byteLength = () => 100 * 1024 * 1024 + 1;
    await assert.rejects(
      harness.handlers.get('images:importFromBytes')({}, {
        productId: 'p1', bytes: Buffer.from('tiny'), ext: '.jpg',
      }),
      /100 MiB.*75 MiB|75 MiB.*100 MiB/i,
    );
    assert.equal(rpcCalls, 0);
  } finally {
    Buffer.byteLength = originalByteLength;
    harness.restore();
  }
});

test('registered client copy bridge bounds overlap and preserves names, bytes, and ordered failures', async () => {
  await withTempDir(async (dir) => {
    let active = 0;
    let maxActive = 0;
    const imageResponse = async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      const rel = decodeURIComponent(String(url).replace('app-image://local/', ''));
      if (rel === 'three.png') return new Response('no', { status: 503 });
      return new Response(`bytes:${rel}`);
    };
    const harness = loadClientHarness({ rpcResult: async () => ({}), imageResponse });
    try {
      await fsp.writeFile(path.join(dir, 'SKU-001.png'), 'existing');
      const result = await harness.handlers.get('images:copyImagesToFolder')({}, {
        productId: 'p1',
        filepaths: ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'],
        targetFolder: dir,
        sku: 'SKU',
      });

      assert.equal(result.copied, 4);
      assert.deepEqual(result.failures, [{ filename: 'three.png', error: 'fetch returned 503' }]);
      assert.ok(maxActive > 1, `expected overlap, saw ${maxActive}`);
      assert.ok(maxActive <= 3, `expected at most 3 in flight, saw ${maxActive}`);
      assert.equal(await fsp.readFile(path.join(dir, 'SKU-001.png'), 'utf8'), 'existing');
      assert.equal(await fsp.readFile(path.join(dir, 'SKU-001 (1).png'), 'utf8'), 'bytes:one.png');
      assert.equal(await fsp.readFile(path.join(dir, 'SKU-002.png'), 'utf8'), 'bytes:two.png');
      assert.equal(await fsp.readFile(path.join(dir, 'SKU-004.png'), 'utf8'), 'bytes:four.png');
      assert.equal(await fsp.readFile(path.join(dir, 'SKU-005.png'), 'utf8'), 'bytes:five.png');

      const raceArgs = {
        productId: 'p1', filepaths: ['one.png'], targetFolder: dir, sku: 'RACE',
      };
      const [raceA, raceB] = await Promise.all([
        harness.handlers.get('images:copyImagesToFolder')({}, raceArgs),
        harness.handlers.get('images:copyImagesToFolder')({}, raceArgs),
      ]);
      assert.equal(raceA.copied + raceB.copied, 2);
      assert.equal(await fsp.readFile(path.join(dir, 'RACE-001.png'), 'utf8'), 'bytes:one.png');
      assert.equal(await fsp.readFile(path.join(dir, 'RACE-001 (1).png'), 'utf8'), 'bytes:one.png');
    } finally {
      harness.restore();
    }
  });
});

test('registered client drag-out uses only paths issued by prepareDrag', async () => {
  await withTempDir(async (dir) => {
    const harness = loadClientHarness({
      rpcResult: async (channel) => channel === 'images:listByProduct' ? [{ filepath: 'one.png' }] : {},
      imageResponse: async () => new Response('downloaded image'),
    });
    const dragged = [];
    let prep;
    try {
      prep = await harness.handlers.get('images:prepareDrag')({}, {
        productId: 'p1', filepaths: ['one.png', 'watermarks/not-this-product.png'],
      });
      assert.deepEqual(prep.failed, [{
        filepath: 'watermarks/not-this-product.png',
        error: 'image is not attached to this product',
      }]);
      const startDrag = harness.sendHandlers.get('images:startDragOut');
      await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, null);
      await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, { preparedPaths: 'not-an-array' });
      await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, { preparedPaths: ['/etc/hosts'] });
      assert.deepEqual(dragged, []);
      await startDrag({ sender: { startDrag: ({ files }) => dragged.push(files) } }, { preparedPaths: prep.files });
      assert.deepEqual(dragged, [prep.files]);
    } finally {
      harness.restore();
      if (prep?.tmpDir) await fsp.rm(prep.tmpDir, { recursive: true, force: true });
    }
  });
});

test('registered client auto-match reports upload failures separately from duplicates', async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(path.join(dir, 'SKU.png'), 'image');
    const harness = loadClientHarness({
      rpcResult: async (channel) => {
        if (channel === 'products:list') return [{ id: 'p1', sku: 'SKU', imageCount: 0 }];
        if (channel === 'images:importFromBytes') throw new Error('server unavailable');
        return {};
      },
    });
    try {
      const result = await harness.handlers.get('images:autoMatchBySku')({}, {
        companyId: 'company-A', folderPath: dir,
      });
      assert.equal(result.imagesSkippedDup, 0);
      assert.equal(result.imagesFailed, 1);
      assert.equal(result.failures[0].filepath, 'SKU.png');
      assert.equal(result.failures[0].sku, 'SKU');
      assert.match(result.failures[0].error, /server|connect|unavailable/i);
    } finally {
      harness.restore();
    }
  });
});

test('registered client keepBoth export does not overwrite after suffix 999', async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(path.join(dir, 'export.png'), 'old');
    for (let n = 2; n <= 999; n += 1) {
      await fsp.writeFile(path.join(dir, `export-${n}.png`), 'old');
    }
    const harness = loadClientHarness({
      rpcResult: async (channel) => channel === 'exports:runForClient'
        ? { files: [{ relPath: 'export.png', bytes: Buffer.from('new') }], skipped: 0, skips: [] }
        : {},
    });
    try {
      const result = await harness.handlers.get('exports:run')({}, {
        profileId: 'profile-1', productIds: [], outputRoot: dir, onExisting: 'keepBoth',
      });
      assert.equal(result.exported, 1);
      assert.equal(await fsp.readFile(path.join(dir, 'export-999.png'), 'utf8'), 'old');
      assert.equal(await fsp.readFile(path.join(dir, 'export-1000.png'), 'utf8'), 'new');
    } finally {
      harness.restore();
    }
  });
});
