const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run this test with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron";
  } else {
    throw err;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function rpc(port, token, channel, args) {
  const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Connection: 'close',
    },
    body: JSON.stringify({ channel, args }),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(check, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('the bulk overlay UI reports reconciled run totals instead of empty result arrays', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../renderer/modules/ProductLibrary/BulkOverlayRunModal.jsx'),
    'utf8',
  );
  assert.match(source, /res\?\.reconciled/);
  assert.match(source, /summary\?\.productsCount/);
  assert.match(source, /Product data refreshed/);
});

test('client reconciliation stays limited to bulk operations with durable run receipts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/client/index.js'), 'utf8');
  assert.match(
    source,
    /const tracked = channel === 'templates:applyBulk' \|\| channel === 'templates:applyByFilter'/,
  );
  assert.match(source, /if \(!tracked \|\| err\?\.code !== 'RPC_OUTCOME_UNKNOWN'\) throw err/);
});

test('a timed-out bulk overlay reconciles pending to succeeded without a second append', { skip: skipReason }, async () => {
  const originalLoad = Module._load;
  const ipcHandlers = new Map();
  class QuietWebSocket { on() {} }
  function testLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler), on: () => {} },
        app: { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    if (request === 'ws') return QuietWebSocket;
    return originalLoad.call(this, request, parent, isMain);
  }

  Module._load = testLoad;
  const db = require('../main/db');
  const companies = require('../main/db/companies');
  const users = require('../main/db/users');
  const products = require('../main/db/products');
  const productImages = require('../main/db/productImages');
  const imageTemplates = require('../main/db/imageTemplates');
  const templateRenderer = require('../main/templateRenderer');
  const templates = require('../main/ipc/templates');
  const server = require('../main/server');
  const client = require('../main/client');
  const sharp = require('sharp');
  Module._load = originalLoad;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-overlay-outcome-'));
  const originalCompose = templateRenderer.compose;
  const nativeAbortTimeout = AbortSignal.timeout;
  const nativeSetTimeout = global.setTimeout;
  const nativeFetch = global.fetch;
  const enteredCompose = deferred();
  const releaseCompose = deferred();
  let renderGate = { entered: enteredCompose, release: releaseCompose };
  let timeoutGate = enteredCompose;
  let shortTimeoutArmed = true;
  let composeCalls = 0;

  try {
    db.initDb(dataDir);
    const companyA = companies.create({ name: 'Synthetic Company A' });
    const companyB = companies.create({ name: 'Synthetic Company B', isActive: false });
    const userA = users.create({ name: 'Synthetic Admin A', role: 'admin' });
    const userB = users.create({ name: 'Synthetic Admin B', role: 'admin' });
    users.setActiveCompany(userA.id, companyA.id);
    users.setActiveCompany(userB.id, companyB.id);

    const product = products.create({ companyId: companyA.id, sku: 'SYN-OVERLAY-1', name: 'Synthetic product' });
    const source = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#336699' },
    }).png().toBuffer();
    await productImages.addFromBytes(product.id, source, '.png', { originalFilepath: 'synthetic.png' });
    const template = imageTemplates.create({
      name: 'Synthetic overlay',
      canvasWidth: 32,
      canvasHeight: 32,
      elements: [],
      inset: { enabled: true, scale: 0.75, fillMode: 'color', fillColor: '#FFFFFF' },
    });

    templateRenderer.compose = async (input) => {
      composeCalls += 1;
      renderGate.entered.resolve();
      await renderGate.release.promise;
      return originalCompose(input);
    };

    templates.register({
      expose(channel, handler) { server.registerHandler(channel, handler); },
      exposeLocal() {},
      emitCatalogChange() {},
    });

    const port = await freePort();
    Module._load = testLoad;
    await server.bootServer({ port, dataDir });

    global.setTimeout = (callback, delay, ...args) => delay >= 500
      ? { unref() {} }
      : nativeSetTimeout(callback, delay, ...args);
    client.registerClientProxies(() => ({
      clientServerUrl: `http://127.0.0.1:${port}`,
      clientToken: userA.token,
    }));
    global.setTimeout = nativeSetTimeout;

    AbortSignal.timeout = (delay) => {
      if (!shortTimeoutArmed) return nativeAbortTimeout(Math.min(delay, 5000));
      shortTimeoutArmed = false;
      const controller = new AbortController();
      timeoutGate.promise.then(() => {
        nativeSetTimeout(() => controller.abort(new DOMException('test deadline', 'TimeoutError')), 10);
      });
      return controller.signal;
    };

    const operationId = '11111111-1111-4111-8111-111111111111';
    await assert.rejects(
      client.rpc('templates:applyBulk', {
        operationId,
        templateId: template.id,
        productIds: [product.id],
        destination: { kind: 'append' },
      }),
      (err) => err?.code === 'RPC_OUTCOME_UNKNOWN' && err?.channel === 'templates:applyBulk',
    );

    const pending = await rpc(port, userA.token, 'templates:getApplyOutcome', { operationId });
    const samePending = await rpc(port, userA.token, 'templates:applyBulk', {
      operationId,
      templateId: template.id,
      productIds: [product.id],
      destination: { kind: 'append' },
    });
    const conflictingPending = await rpc(port, userA.token, 'templates:applyBulk', {
      operationId,
      templateId: template.id,
      productIds: [product.id],
      destination: { kind: 'appendAsMain' },
    });
    releaseCompose.resolve();
    await waitFor(
      () => productImages.listByProduct(product.id).length === 2,
      'the delayed production overlay did not append within 1 second',
    );
    const succeeded = await rpc(port, userA.token, 'templates:getApplyOutcome', { operationId });
    delete require.cache[require.resolve('../main/ipc/templates')];
    require('../main/ipc/templates').register({
      expose(channel, handler) { server.registerHandler(channel, handler); },
      exposeLocal() {},
      emitCatalogChange() {},
    });
    const succeededAfterRestart = await rpc(port, userA.token, 'templates:getApplyOutcome', { operationId });
    const otherCompany = await rpc(port, userB.token, 'templates:getApplyOutcome', { operationId });
    const completedReplay = await rpc(port, userA.token, 'templates:applyBulk', {
      operationId,
      templateId: template.id,
      productIds: [product.id],
      destination: { kind: 'append' },
    });

    const filterOperationId = '22222222-2222-4222-8222-222222222222';
    const filtered = await rpc(port, userA.token, 'templates:applyByFilter', {
      operationId: filterOperationId,
      templateId: template.id,
      filters: { search: product.sku },
      destination: { kind: 'append' },
    });
    const filteredOutcome = await rpc(port, userA.token, 'templates:getApplyOutcome', {
      operationId: filterOperationId,
    });

    assert.equal(productImages.listByProduct(product.id).length, 2);
    assert.equal(composeCalls, 2);
    assert.deepEqual(pending, {
      status: 200,
      body: { result: { operationId, status: 'pending' } },
    });
    assert.deepEqual(samePending, pending);
    assert.equal(succeeded.status, 200);
    assert.equal(succeeded.body.result.operationId, operationId);
    assert.equal(succeeded.body.result.status, 'succeeded');
    assert.equal(succeeded.body.result.summary.imagesCount, 1);
    assert.deepEqual(succeededAfterRestart, succeeded);
    assert.equal(conflictingPending.status, 500);
    assert.match(conflictingPending.body.error, /different overlay request/);
    assert.equal(completedReplay.status, 500);
    assert.match(completedReplay.body.error, /already completed/);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.result.operationId, filterOperationId);
    assert.equal(filteredOutcome.status, 200);
    assert.equal(filteredOutcome.body.result.status, 'succeeded');
    assert.deepEqual(otherCompany, {
      status: 200,
      body: { result: { operationId, status: 'lost' } },
    });

    const filterEntered = deferred();
    const filterRelease = deferred();
    renderGate = { entered: filterEntered, release: filterRelease };
    timeoutGate = filterEntered;
    shortTimeoutArmed = true;
    let restartWindow = true;
    global.fetch = async (url, options) => {
      const request = JSON.parse(options?.body || '{}');
      if (restartWindow && request.channel === 'templates:getApplyOutcome') {
        restartWindow = false;
        throw new TypeError('synthetic server restart window');
      }
      return nativeFetch(url, options);
    };
    filterEntered.promise.then(() => nativeSetTimeout(() => filterRelease.resolve(), 40));
    const applyByFilterBridge = ipcHandlers.get('templates:applyByFilter');
    const reconciled = await applyByFilterBridge(null, {
      templateId: template.id,
      filters: { search: product.sku },
      destination: { kind: 'append' },
      scope: 'main',
    });
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.summary.productsCount, 1);
    assert.equal(reconciled.summary.imagesCount, 1);
    assert.equal(restartWindow, false);

    const collectEntered = deferred();
    const collectRelease = deferred();
    renderGate = { entered: collectEntered, release: collectRelease };
    timeoutGate = collectEntered;
    shortTimeoutArmed = true;
    collectEntered.promise.then(() => nativeSetTimeout(() => collectRelease.resolve(), 40));
    const outputFolder = path.join(dataDir, 'client-output');
    const applyBulkBridge = ipcHandlers.get('templates:applyBulk');
    await assert.rejects(
      applyBulkBridge(null, {
        templateId: template.id,
        productIds: [product.id],
        destination: { kind: 'saveToFolder', folder: outputFolder },
        scope: 'main',
      }),
      /No files were saved on this Mac.*run the export again/i,
    );
    assert.equal(fs.existsSync(outputFolder), false);
    assert.equal(composeCalls, 4);
  } finally {
    releaseCompose.resolve();
    templateRenderer.compose = originalCompose;
    AbortSignal.timeout = nativeAbortTimeout;
    global.setTimeout = nativeSetTimeout;
    global.fetch = nativeFetch;
    try { await server.stopServer(); } catch (_) {}
    try { db.getDb().close(); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
    Module._load = originalLoad;
  }
});
