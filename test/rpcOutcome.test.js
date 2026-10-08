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

  // Event-driven (no timing races under load): the handler signals that it
  // has ENTERED, the client's deadline is aborted only then, and the handler
  // commits only after it is released.
  let committed = 0;
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  server.registerHandler('products:update', async () => {
    entered.resolve();
    await release.promise;
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
  const deadline = new AbortController();
  AbortSignal.timeout = () => deadline.signal;
  try {
    const call = client.rpc('products:update', { id: 'synthetic-product', patch: {} });
    await entered.promise; // the production HTTP dispatcher entered the mutation…
    deadline.abort(new DOMException('synthetic deadline', 'TimeoutError')); // …and only then does the client time out
    await assert.rejects(call, (err) => err?.code === 'RPC_OUTCOME_UNKNOWN' && err?.channel === 'products:update');
    assert.equal(committed, 0, 'the timeout came before the commit');
    release.resolve();
    await completed.promise;
    assert.equal(committed, 1);
  } finally {
    release.resolve();
    AbortSignal.timeout = nativeTimeout;
    await server.stopServer();
    if (previousUsers) require.cache[usersPath] = previousUsers;
    else delete require.cache[usersPath];
  }
});

test('overlay reconciliation bounds hanging HTTP status reads by the remaining budget', async (t) => {
  // Event-driven (review 2, flake fix): no global setTimeout patching and no
  // real-time abort timers. The reconciliation loop runs on an injected clock
  // ({ now, sleep }); every client deadline is an AbortController the SERVER
  // aborts at the moment the scenario calls for (status read received, body
  // half-written…), moving the fake clock by that deadline's length.
  const originalLoad = Module._load;
  const clientPath = require.resolve('../main/client');
  const previousClient = require.cache[clientPath];
  const nativeTimeout = AbortSignal.timeout;
  const nativeSetTimeout = global.setTimeout;
  const nativeFetch = global.fetch;
  const handlers = new Map();
  const timeoutDelays = [];
  let clock = 1_000_000;
  let current = null; // the latest client deadline: { controller, delay }
  let mutationSignal;
  let mode;
  let mutations;
  let statusReads;
  let budgetStarted;
  let committedOperationId;
  const expire = (deadline) => {
    if (!deadline || deadline.controller.signal.aborted) return;
    clock += deadline.delay;
    deadline.controller.abort(new DOMException('synthetic deadline', 'TimeoutError'));
  };
  // The pause between status reads waits for the previous response's socket to
  // close (an event), so the next read never lands on a closing connection.
  // Each scenario gets a server of its own, so no pooled socket from the one
  // before can be reused. The initial-body scenarios expire the client's
  // deadline once the client HAS the response headers (seen by a fetch wrapper).
  let socketClosed = Promise.resolve();
  let expireAfterHeaders = null;
  const handler = async (req, res) => {
    res.setHeader('Connection', 'close');
    socketClosed = new Promise((resolve) => req.socket.once('close', resolve));
    let body = '';
    for await (const chunk of req) body += chunk;
    const { channel, args } = JSON.parse(body);
    const mine = current;
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
        expireAfterHeaders = mine; // The write committed; its response stalls — and the client's deadline passes.
        res.write('{"result":');
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
      res.write('{"result":', () => expire(mine)); // Headers arrive, but the body never finishes.
    } else if (mode === 'rate-limit') {
      res.writeHead(429, { 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'synthetic rate limit' }), () => expire(mine));
    } else {
      expire(mine); // Accept the request and never send response headers.
    }
  };
  let httpServer = null;
  const servers = [];
  const freshServer = async () => {
    httpServer = http.createServer(handler);
    servers.push(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  };
  const headerAwareFetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (expireAfterHeaders) { const d = expireAfterHeaders; expireAfterHeaders = null; expire(d); }
    return response;
  };
  try {
    await freshServer();
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
    global.setTimeout = () => ({ unref() {} }); // Suppress background polling at registration only.
    client.registerClientProxies(() => ({
      clientServerUrl: `http://127.0.0.1:${httpServer.address().port}`,
      clientToken: 'synthetic-token',
    }));
    Module._load = originalLoad;
    global.setTimeout = nativeSetTimeout;
    global.fetch = headerAwareFetch;
    client.setReconcileClockForTests({ now: () => clock, sleep: async (ms) => { clock += ms; await socketClosed; } });
    const stubTimeouts = () => {
      AbortSignal.timeout = (delay) => {
        timeoutDelays.push(delay);
        const controller = new AbortController();
        if (timeoutDelays.length === 1) mutationSignal = controller;
        current = { controller, delay };
        return controller.signal;
      };
    };

    for (const scenario of ['headers', 'pending', 'body', 'rate-limit']) {
      await t.test(scenario, async () => {
        await freshServer();
        mode = scenario;
        mutations = statusReads = 0;
        timeoutDelays.length = 0;
        stubTimeouts();
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
          const lastDelay = timeoutDelays.at(-1);
          if (scenario === 'pending') {
            // The pending read and the pause consumed part of the 30s budget:
            // 30,000 − 5,000 − 250 left for the second read.
            assert.equal(lastDelay, 30_000 - 5_000 - 250);
          } else {
            assert.equal(lastDelay, 30_000);
          }
        } finally {
          AbortSignal.timeout = nativeTimeout;
          httpServer.closeAllConnections();
        }
      });
    }

    for (const scenario of ['direct', 'generic-abort', 'overlay', 'collect', 'read']) {
      await t.test(`initial mutation body timeout: ${scenario}`, async () => {
        await freshServer();
        mode = `initial-body-${scenario}`;
        mutations = statusReads = 0;
        timeoutDelays.length = 0;
        stubTimeouts();
        if (scenario === 'generic-abort') {
          // Some runtimes expose AbortError instead of the signal's timeout
          // reason. Keep the actual HTTP/body abort and normalize only its name.
          global.fetch = async (...args) => {
            const response = await headerAwareFetch(...args);
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
          // 0.1.94: ordinary reads give up after 20s; writes keep 120s.
          assert.equal(timeoutDelays[0], scenario === 'read' ? 20_000 : 120_000);
        } finally {
          AbortSignal.timeout = nativeTimeout;
          global.fetch = headerAwareFetch;
          httpServer.closeAllConnections();
        }
      });
    }
    client.setReconcileClockForTests(null);
  } finally {
    Module._load = originalLoad;
    global.fetch = nativeFetch;
    if (previousClient) require.cache[clientPath] = previousClient;
    else delete require.cache[clientPath];
    for (const srv of servers) {
      srv.closeAllConnections();
      await new Promise((resolve) => srv.close(resolve));
    }
  }
});
