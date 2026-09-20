const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

const {
  isLikelyMutationChannel,
  isTimeoutError,
  mutationOutcomeUnknown,
} = require('../main/util/rpcOutcome');

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

test('timed-out mutations are marked unknown while reads retain normal timeout handling', () => {
  assert.equal(isLikelyMutationChannel('products:list'), false);
  assert.equal(isLikelyMutationChannel('purchaseOrders:get'), false);
  assert.equal(isLikelyMutationChannel('products:update'), true);
  assert.equal(isLikelyMutationChannel('purchaseOrders:addLine'), true);
  assert.equal(isTimeoutError(Object.assign(new Error('deadline'), { name: 'TimeoutError' })), true);
  assert.equal(isTimeoutError(new Error('fetch failed')), false);

  const err = mutationOutcomeUnknown('products:update', new Error('deadline'));
  assert.equal(err.code, 'RPC_OUTCOME_UNKNOWN');
  assert.equal(err.channel, 'products:update');
  assert.match(err.message, /may still have completed/);
  assert.match(err.message, /refresh the current data before retrying/);
});

test('overlay operation IDs are validated and outcome reads keep overlay capability gating', () => {
  const { getValidator } = require('../main/server/validators');
  const { channelCapability } = require('../main/util/capabilities');
  const operationId = '11111111-1111-4111-8111-111111111111';
  const base = {
    operationId,
    templateId: 'template-1',
    destination: { kind: 'append' },
  };

  assert.equal(getValidator('templates:applyBulk')({ ...base, productIds: ['product-1'] }), true);
  assert.equal(getValidator('templates:applyByFilter')({ ...base, filters: {} }), true);
  assert.equal(getValidator('templates:getApplyOutcome')({ operationId }), true);
  assert.match(getValidator('templates:applyBulk')({ ...base, operationId: 'short', productIds: ['product-1'] }), /UUID/);
  assert.match(getValidator('templates:getApplyOutcome')({ operationId: `${operationId}-extra` }), /UUID/);
  assert.equal(channelCapability('templates:getApplyOutcome'), 'overlay.use');
});

test('the production RPC client reports unknown while a delayed HTTP mutation commits once', async () => {
  const usersPath = require.resolve('../main/db/users');
  const previousUsers = require.cache[usersPath];
  require.cache[usersPath] = {
    id: usersPath,
    filename: usersPath,
    loaded: true,
    exports: {
      getByToken: (token) => token === 'synthetic-token'
        ? { id: 'synthetic-admin', name: 'Synthetic Admin', role: 'admin' }
        : null,
      touchLastSeen: () => {},
    },
  };

  const originalLoad = Module._load;
  class QuietWebSocket {
    on() {}
  }
  function testLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcMain: { handle: () => {}, on: () => {} },
        app: { getVersion: () => '0.0.0-test' },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    if (request === 'ws') return QuietWebSocket;
    return originalLoad.call(this, request, parent, isMain);
  }
  Module._load = testLoad;

  let server;
  let client;
  try {
    server = require('../main/server');
    client = require('../main/client');
  } finally {
    Module._load = originalLoad;
  }

  let committed = 0;
  let entered = false;
  const completed = deferred();
  server.registerHandler('products:update', async () => {
    entered = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    committed += 1;
    completed.resolve();
    return { committed: true };
  });

  const port = await freePort();
  await server.bootServer({ port, dataDir: '/unused-test-data' });
  const nativeSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => delay >= 500
    ? { unref() {} }
    : nativeSetTimeout(callback, delay, ...args);
  Module._load = testLoad;
  try {
    client.registerClientProxies(() => ({
      clientServerUrl: `http://127.0.0.1:${port}`,
      clientToken: 'synthetic-token',
    }));
  } finally {
    global.setTimeout = nativeSetTimeout;
    Module._load = originalLoad;
  }

  const nativeTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => nativeTimeout(50);
  try {
    await assert.rejects(
      client.rpc('products:update', { id: 'synthetic-product', patch: {} }),
      (err) => err?.code === 'RPC_OUTCOME_UNKNOWN' && err?.channel === 'products:update',
    );
    assert.equal(entered, true, 'the production HTTP dispatcher should enter the mutation before timeout');
    await Promise.race([
      completed.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('delayed mutation did not finish within 1 second')), 1000)),
    ]);
    assert.equal(committed, 1);
  } finally {
    AbortSignal.timeout = nativeTimeout;
    await server.stopServer();
    if (previousUsers) require.cache[usersPath] = previousUsers;
    else delete require.cache[usersPath];
  }
});

test('overlay reconciliation bounds hanging HTTP status reads by the remaining budget', async (t) => {
  const originalLoad = Module._load;
  const clientPath = require.resolve('../main/client');
  const previousClient = require.cache[clientPath];
  const nativeTimeout = AbortSignal.timeout;
  const nativeSetTimeout = global.setTimeout;
  const nativeNow = Date.now;
  const nativeFetch = global.fetch;
  const handlers = new Map();
  const timeoutDelays = [];
  let clock = nativeNow();
  let abortTimer;
  let mutationSignal;
  let mode;
  let mutations;
  let statusReads;
  let budgetStarted;
  let committedOperationId;
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Connection', 'close');
    let body = '';
    for await (const chunk of req) body += chunk;
    const { channel, args } = JSON.parse(body);
    if (mode?.startsWith('initial-body')) {
      if (channel === 'templates:getApplyOutcome') {
        statusReads += 1;
        assert.equal(args.operationId, committedOperationId);
        res.end(JSON.stringify({ result: {
          operationId: committedOperationId, status: 'succeeded',
          summary: { productsCount: 1, imagesCount: 1, skippedCount: 0 },
        } }));
      } else {
        if (channel !== 'products:list') mutations += 1;
        committedOperationId = args.operationId;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"result":'); // The write committed; only its response stalls.
      }
      return;
    }
    if (channel === 'templates:applyBulk') {
      mutations += 1;
      mutationSignal.abort(new DOMException('synthetic mutation deadline', 'TimeoutError'));
      return;
    }
    assert.equal(channel, 'templates:getApplyOutcome');
    statusReads += 1;
    if (statusReads === 1) budgetStarted = clock;
    if (mode === 'pending' && statusReads === 1) {
      clock += 5000; // Time already spent discovering the operation is pending.
      res.end(JSON.stringify({ result: { status: 'pending' } }));
    } else if (mode === 'body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"result":'); // Headers arrive, but the body never finishes.
    } else if (mode === 'rate-limit') {
      res.writeHead(429, { 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'synthetic rate limit' }));
    }
    // Otherwise accept the request and never send response headers.
  });
  try {
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return {
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
        app: { getVersion: () => '0.0.0-test' },
        BrowserWindow: { getAllWindows: () => [] },
      };
      if (request === 'ws') return class { on() {} };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[clientPath];
    const client = require('../main/client');
    global.setTimeout = () => ({ unref() {} }); // Suppress background polling at registration.
    client.registerClientProxies(() => ({
      clientServerUrl: `http://127.0.0.1:${httpServer.address().port}`,
      clientToken: 'synthetic-token',
    }));
    Module._load = originalLoad;
    global.setTimeout = nativeSetTimeout;

    for (const scenario of ['headers', 'pending', 'body', 'rate-limit']) {
      await t.test(scenario, async () => {
        mode = scenario;
        mutations = statusReads = 0;
        timeoutDelays.length = 0;
        Date.now = () => clock;
        AbortSignal.timeout = (delay) => {
          clearTimeout(abortTimer);
          timeoutDelays.push(delay);
          const controller = new AbortController();
          if (timeoutDelays.length === 1) mutationSignal = controller;
          else abortTimer = nativeSetTimeout(() => {
            clock += delay;
            controller.abort(new DOMException('synthetic status deadline', 'TimeoutError'));
          }, 30);
          return controller.signal;
        };
        global.setTimeout = (callback, delay, ...args) => {
          clock += delay;
          return nativeSetTimeout(callback, 1, ...args);
        };
        try {
          await assert.rejects(handlers.get('templates:applyBulk')(null, {
            templateId: 'synthetic-template', productIds: ['synthetic-product'],
            destination: { kind: 'append' },
          }), (err) => {
            assert.match(err.message, /could not.*confirm.*overlay result/i);
            assert.equal(err.cause?.code, 'RPC_OUTCOME_UNKNOWN');
            assert.equal(err.cause?.channel, 'templates:applyBulk');
            return true;
          });
          assert.equal(timeoutDelays[0], 120_000, 'mutation default must stay unchanged');
          assert.equal(mutations, 1, 'the unknown mutation must never be replayed');
          assert.equal(statusReads, scenario === 'pending' ? 2 : 1);
          assert.ok(clock - budgetStarted <= 30_000,
            `status discovery exceeded 30s: ${clock - budgetStarted}ms; RPC timeouts ${timeoutDelays}`);
          assert.equal(timeoutDelays.at(-1), scenario === 'pending' ? 24_750 : 30_000);
        } finally {
          clearTimeout(abortTimer);
          AbortSignal.timeout = nativeTimeout;
          Date.now = nativeNow;
          global.setTimeout = nativeSetTimeout;
          httpServer.closeAllConnections();
        }
      });
    }

    for (const scenario of ['direct', 'generic-abort', 'overlay', 'collect', 'read']) {
      await t.test(`initial mutation body timeout: ${scenario}`, async () => {
        mode = `initial-body-${scenario}`;
        mutations = statusReads = 0;
        timeoutDelays.length = 0;
        AbortSignal.timeout = (delay) => {
          timeoutDelays.push(delay);
          return nativeTimeout(80);
        };
        if (scenario === 'generic-abort') {
          // Some runtimes expose AbortError instead of the signal's timeout
          // reason. Keep the actual HTTP/body abort and normalize only its name.
          global.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            const read = response.text.bind(response);
            response.text = async () => {
              try { return await read(); }
              catch (err) {
                throw Object.assign(new Error('The operation was aborted', { cause: err }), { name: 'AbortError' });
              }
            };
            return response;
          };
        }
        try {
          if (scenario === 'direct' || scenario === 'generic-abort') {
            await assert.rejects(client.rpc('products:update', { id: 'synthetic-product', patch: {} }), (err) => {
              assert.equal(err.code, 'RPC_OUTCOME_UNKNOWN');
              assert.equal(err.channel, 'products:update');
              assert.equal(err.cause?.name, scenario === 'generic-abort' ? 'AbortError' : 'TimeoutError');
              return true;
            });
          } else if (scenario === 'read') {
            await assert.rejects(client.rpc('products:list', {}), (err) => {
              assert.notEqual(err.code, 'RPC_OUTCOME_UNKNOWN');
              assert.equal(err.cause?.name, 'TimeoutError');
              return true;
            });
          } else {
            const result = handlers.get('templates:applyBulk')(null, {
              templateId: 'synthetic-template', productIds: ['synthetic-product'],
              destination: scenario === 'collect'
                ? { kind: 'saveToFolder', folder: '/unused-synthetic-output' }
                : { kind: 'append' },
            });
            if (scenario === 'collect') {
              await assert.rejects(result, /No files were saved on this Mac/);
            } else {
              const reconciled = await result;
              assert.equal(reconciled?.reconciled, true);
              assert.equal(reconciled.operationId, committedOperationId);
              assert.equal(reconciled.summary.imagesCount, 1);
            }
            assert.match(committedOperationId, /^[0-9a-f-]{36}$/);
            assert.equal(statusReads, 1);
            assert.ok(timeoutDelays[1] > 0 && timeoutDelays[1] <= 30_000);
          }
          assert.equal(mutations, scenario === 'read' ? 0 : 1, 'no automatic write replay');
          assert.equal(timeoutDelays[0], 120_000);
        } finally {
          AbortSignal.timeout = nativeTimeout;
          global.fetch = nativeFetch;
        }
      });
    }
  } finally {
    Module._load = originalLoad;
    if (previousClient) require.cache[clientPath] = previousClient;
    else delete require.cache[clientPath];
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
