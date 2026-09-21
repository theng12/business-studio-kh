const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

let Database = null;
let skipReason = false;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run with ELECTRON_RUN_AS_NODE=1 electron --test";
  } else {
    throw err;
  }
}

function makeBundle(root, schemaVersion) {
  const stageParent = fs.mkdtempSync(path.join(root, 'bundle-stage-'));
  const bundleRoot = path.join(stageParent, 'bundle');
  fs.mkdirSync(path.join(bundleRoot, 'assets'), { recursive: true });
  const imported = new Database(path.join(bundleRoot, 'database.sqlite'));
  imported.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);');
  imported.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run('schema_version', String(schemaVersion));
  imported.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run('fixture', 'imported');
  imported.close();
  fs.writeFileSync(path.join(bundleRoot, 'manifest.json'), JSON.stringify({
    bundleFormatVersion: 1,
    appVersion: 'test',
    createdAt: Date.now(),
    includes: ['database.sqlite', 'assets/'],
  }));
  const bundlePath = path.join(root, 'same-version.iskhbundle');
  execFileSync('/usr/bin/tar', ['-czf', bundlePath, '-C', stageParent, 'bundle']);
  return bundlePath;
}

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function requestStatus(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

test('server blocks HTTP assets and WebSocket upgrades before auth during maintenance', async () => {
  const originalLoad = Module._load;
  const port = await unusedPort();
  let rejectReplacement;
  let markClosed;
  const databaseClosed = new Promise((resolve) => { markClosed = resolve; });
  const fakeDb = { closeDb: markClosed, initDb() {} };
  const fakeQueue = { stop: async () => {}, start() {} };
  let server;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { app: { getVersion: () => 'test', relaunch() {}, exit() {} } };
      if (request === '../db') return fakeDb;
      if (request === '../ai/queueRunner') return fakeQueue;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
    delete require.cache[require.resolve('../main/server')];
    const maintenance = require('../main/util/maintenanceLifecycle');
    server = require('../main/server');
    await server.bootServer({ port, dataDir: os.tmpdir() });

    const replacement = new Promise((_resolve, reject) => { rejectReplacement = reject; });
    const maintenanceRun = maintenance.runTrackedOperation('test:maintenance', () =>
      maintenance.runDataMaintenance({
        label: 'testing maintenance',
        dataDir: os.tmpdir(),
        replace: () => replacement,
      }),
    ).catch((err) => err);
    await databaseClosed;

    assert.equal(await requestStatus(port, '/assets/example.jpg'), 503);
    assert.equal(await requestStatus(port, '/api/events?token=dummy', {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
    }), 503);

    rejectReplacement(new Error('fixture replacement failure'));
    await maintenanceRun;
  } finally {
    rejectReplacement?.(new Error('fixture cleanup'));
    await server?.stopServer?.();
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/server')];
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
  }
});

test('aborting an HTTP response does not release a running mutation from the drain barrier', async () => {
  const originalLoad = Module._load;
  const port = await unusedPort();
  let markMutationStarted;
  let releaseMutation;
  let markDatabaseClosed;
  let rejectReplacement;
  let maintenanceRun;
  let request;
  let server;
  const mutationStarted = new Promise((resolve) => { markMutationStarted = resolve; });
  const mutationReleased = new Promise((resolve) => { releaseMutation = resolve; });
  const databaseClosed = new Promise((resolve) => { markDatabaseClosed = resolve; });
  try {
    Module._load = function(requestName, parent, isMain) {
      if (requestName === 'electron') return { app: { getVersion: () => 'test', relaunch() {}, exit() {} } };
      if (requestName === '../db') return { closeDb: markDatabaseClosed, initDb() {} };
      if (requestName === '../db/users') {
        return {
          getByToken: () => ({ id: 'user-1', name: 'Fixture', role: 'admin' }),
          touchLastSeen() {},
        };
      }
      if (requestName === '../ai/queueRunner') return { stop: async () => {}, start() {} };
      if (requestName === '../util/permissions') {
        return { isAllowed: () => true, capsForRole: () => [] };
      }
      return originalLoad.call(this, requestName, parent, isMain);
    };
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
    delete require.cache[require.resolve('../main/server')];
    const maintenance = require('../main/util/maintenanceLifecycle');
    server = require('../main/server');
    server.registerHandler('test:mutate', async () => {
      markMutationStarted();
      await mutationReleased;
      return { ok: true };
    });
    await server.bootServer({ port, dataDir: os.tmpdir() });

    request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/rpc',
      headers: {
        Authorization: 'Bearer dummy',
        'Content-Type': 'application/json',
      },
    });
    request.on('error', () => {});
    request.end(JSON.stringify({ channel: 'test:mutate', args: {} }));
    await mutationStarted;
    request.destroy();

    const replacement = new Promise((_resolve, reject) => { rejectReplacement = reject; });
    maintenanceRun = maintenance.runTrackedOperation('test:maintenance', () =>
      maintenance.runDataMaintenance({
        label: 'testing maintenance',
        dataDir: os.tmpdir(),
        replace: () => replacement,
      }),
    ).catch((err) => err);

    let databaseWasClosed = false;
    databaseClosed.then(() => { databaseWasClosed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(databaseWasClosed, false);

    releaseMutation();
    await databaseClosed;
    rejectReplacement(new Error('fixture replacement failure'));
    await maintenanceRun;
  } finally {
    request?.destroy();
    releaseMutation?.();
    rejectReplacement?.(new Error('fixture cleanup'));
    await maintenanceRun;
    await server?.stopServer?.();
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/server')];
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
  }
});

test('local image protocol returns unavailable during maintenance', async () => {
  const originalLoad = Module._load;
  let imageHandler;
  let rejectReplacement;
  let maintenanceRun;
  let markClosed;
  const databaseClosed = new Promise((resolve) => { markClosed = resolve; });
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') {
        return {
          protocol: { handle: (_scheme, handler) => { imageHandler = handler; } },
          net: { fetch: async () => { throw new Error('fixture must not read a file'); } },
        };
      }
      if (request === '../db') return { closeDb: markClosed, initDb() {} };
      if (request === '../ai/queueRunner') return { stop: async () => {}, start() {} };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
    delete require.cache[require.resolve('../main/protocol')];
    const maintenance = require('../main/util/maintenanceLifecycle');
    const { registerImageProtocol } = require('../main/protocol');
    registerImageProtocol(os.tmpdir());

    const replacement = new Promise((_resolve, reject) => { rejectReplacement = reject; });
    maintenanceRun = maintenance.runTrackedOperation('test:maintenance', () =>
      maintenance.runDataMaintenance({
        label: 'testing maintenance',
        dataDir: os.tmpdir(),
        replace: () => replacement,
      }),
    ).catch((err) => err);
    await databaseClosed;

    const response = await imageHandler({ url: 'app-image://local/missing.jpg' });
    assert.equal(response.status, 503);

    rejectReplacement(new Error('fixture replacement failure'));
    await maintenanceRun;
  } finally {
    rejectReplacement?.(new Error('fixture cleanup'));
    await maintenanceRun;
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/protocol')];
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
  }
});

test('failed database reopen leaves maintenance blocked and the queue stopped', async () => {
  const originalLoad = Module._load;
  const calls = [];
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') {
        return { app: { relaunch: () => calls.push('relaunch'), exit: () => calls.push('exit') } };
      }
      if (request === '../db') {
        return {
          closeDb: () => calls.push('close'),
          initDb: () => { throw new Error('fixture reopen failure'); },
        };
      }
      if (request === '../ai/queueRunner') {
        return {
          stop: async () => calls.push('stop'),
          start: () => calls.push('start'),
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
    const maintenance = require('../main/util/maintenanceLifecycle');

    await assert.rejects(
      maintenance.runTrackedOperation('test:maintenance', () =>
        maintenance.runDataMaintenance({
          label: 'testing maintenance',
          dataDir: '/fixture/data',
          replace: async () => { throw new Error('fixture replacement failure'); },
        }),
      ),
      (err) => err.code === 'MAINTENANCE_RECOVERY_FAILED' && /quit and reopen/i.test(err.message),
    );
    await assert.rejects(
      maintenance.runTrackedOperation('test:after-failed-reopen', async () => true),
      (err) => err.code === 'APP_MAINTENANCE',
    );
    assert.deepEqual(calls.slice(0, 4), ['stop', 'close', 'relaunch']);
    assert.equal(calls.includes('start'), false);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
  }
});

for (const finish of ['consume', 'cancel', 'cancel-pending', 'error']) {
  test(`local image response body holds maintenance until ${finish}`, async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-protocol-drain-'));
    await fsp.mkdir(path.join(root, 'assets'));
    await fsp.writeFile(path.join(root, 'assets', 'image.jpg'), 'fixture');
    const originalLoad = Module._load;
    let imageHandler;
    let source;
    let databaseClosed = false;
    let maintenanceRun;
    let response;
    let releaseCancellation;
    const cancellation = new Promise((resolve) => { releaseCancellation = resolve; });
    try {
      Module._load = function(request, parent, isMain) {
        if (request === 'electron') return {
          protocol: { handle: (_scheme, handler) => { imageHandler = handler; } },
          net: { fetch: async () => new Response(new ReadableStream({
            start(controller) { source = controller; },
            cancel: () => finish === 'cancel-pending' ? cancellation : undefined,
          })) },
          app: { relaunch() {}, exit() {} },
        };
        if (request === '../db') return { closeDb() { databaseClosed = true; }, initDb() {} };
        if (request === '../ai/queueRunner') return { stop: async () => {}, start() {} };
        return originalLoad.call(this, request, parent, isMain);
      };
      delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
      delete require.cache[require.resolve('../main/protocol')];
      const maintenance = require('../main/util/maintenanceLifecycle');
      require('../main/protocol').registerImageProtocol(root);
      response = await imageHandler({ url: 'app-image://local/image.jpg' });
      const reader = finish === 'cancel-pending' ? response.body.getReader() : null;
      const pendingRead = reader?.read();
      maintenanceRun = maintenance.runDataMaintenance({
        label: 'fixture drain', dataDir: root, replace: async () => ({ success: true }),
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(databaseClosed, false, 'fetch headers must not release the operation');
      if (finish === 'cancel-pending') {
        const cancelling = reader.cancel();
        await pendingRead;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(databaseClosed, false, 'source cancellation must finish before releasing the operation');
        releaseCancellation();
        await cancelling;
      } else if (finish === 'cancel') {
        await response.body.cancel();
      } else if (finish === 'error') {
        source.error(new Error('fixture body error'));
        await assert.rejects(response.text(), /fixture body error/);
      } else {
        source.enqueue(new TextEncoder().encode('late bytes'));
        source.close();
        assert.equal(await response.text(), 'late bytes');
      }
      await maintenanceRun;
      assert.equal(databaseClosed, true);
    } finally {
      releaseCancellation();
      if (response && !response.bodyUsed) await response.body.cancel().catch(() => {});
      await maintenanceRun;
      Module._load = originalLoad;
      delete require.cache[require.resolve('../main/protocol')];
      delete require.cache[require.resolve('../main/util/maintenanceLifecycle')];
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
}

test('AI queue stop waits for the active generation to finish', async () => {
  const originalLoad = Module._load;
  let releaseGeneration;
  let markGenerationStarted;
  const generationStarted = new Promise((resolve) => { markGenerationStarted = resolve; });
  const generationReleased = new Promise((resolve) => { releaseGeneration = resolve; });
  const task = {
    id: 'task-1', status: 'queued', provider: 'openai', companyId: 'co-1',
    model: 'openai:gpt-image-1', prompt: 'a product shot', progress: 0,
    sourceImagePath: null, options: {}, attempts: 0,
  };
  const fakeTasks = {
    listPendingForRunner: () => [task],
    update(id, patch) { Object.assign(task, patch); },
    get: () => task,
  };
  try {
    Module._load = function(request, parent, isMain) {
      if (request === '../db/aiTasks') return fakeTasks;
      if (request === '../db/aiGallery') return { create: () => ({ id: 'g-1' }) };
      if (request === '../db/products') return {};
      if (request === '../db/productImages') return {};
      if (request === '../db') return { getDataDir: () => '/tmp' };
      if (request === '../events') return { broadcast() {} };
      if (request === './models') {
        return { byKey: () => ({ modelId: 'gpt-image-1', supportsSource: false }) };
      }
      if (request === './providers/openai') {
        return {
          generate: async () => {
            markGenerationStarted();
            await generationReleased;
            return { outputUrls: [] };
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/ai/queueRunner')];
    const queueRunner = require('../main/ai/queueRunner');
    queueRunner.start({ getConfig: () => ({ openaiApiKey: 'dummy', openaiConcurrency: 3 }) });
    await generationStarted;

    let stopped = false;
    const stopping = Promise.resolve(queueRunner.stop()).then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, 'stop() must wait while a generation is in flight');

    releaseGeneration();
    await stopping;
    assert.equal(stopped, true);
  } finally {
    releaseGeneration?.();
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/ai/queueRunner')];
  }
});

test('in-place bundle import prevents writes through the old WAL connection', { skip: skipReason }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-import-lifecycle-'));
  const dataDir = path.join(root, 'live-data');
  const configPath = path.join(root, 'config.json');
  const calls = [];
  const originalLoad = Module._load;
  let oldDb;
  try {
    const dbApi = require('../main/db');
    dbApi.initDb(dataDir);
    oldDb = dbApi.getDb();
    oldDb.pragma('wal_autocheckpoint = 0');
    dbApi.setAppState('fixture', 'live-pending-wal');
    assert.equal(fs.existsSync(path.join(dataDir, 'database.sqlite-wal')), true);
    const bundlePath = makeBundle(root, dbApi.SCHEMA_VERSION);

    const fakeElectron = {
      app: {
        getVersion: () => 'test',
        relaunch: () => calls.push('relaunch'),
        exit: () => calls.push('exit'),
      },
      dialog: {},
    };
    const fakeConfig = {
      loadConfig: () => ({ dataDir }),
      configPath: () => configPath,
      updateConfig: () => ({}),
    };
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return fakeElectron;
      if (request === '../events') return { broadcast() {} };
      if (request === '../config' || request === './config') return fakeConfig;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/serverBundle')];
    delete require.cache[require.resolve('../main/ipc/serverBundle')];
    const { register } = require('../main/ipc/serverBundle');
    const handlers = {};
    register({ exposeLocal: (channel, handler) => { handlers[channel] = handler; } });

    await handlers['servers:importBundle']({ bundlePath, targetDataDir: dataDir });

    assert.throws(
      () => oldDb.prepare("INSERT INTO app_state (key, value) VALUES ('late-write', 'unsafe')").run(),
      /closed|not open|maintenance/i,
    );
    const live = new Database(path.join(dataDir, 'database.sqlite'), { readonly: true });
    try {
      assert.equal(live.prepare("SELECT value FROM app_state WHERE key = 'fixture'").get().value, 'imported');
    } finally {
      live.close();
    }
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/ipc/serverBundle')];
    delete require.cache[require.resolve('../main/serverBundle')];
    try { oldDb?.close(); } catch (_) {}
    await fsp.rm(root, { recursive: true, force: true });
  }
});
