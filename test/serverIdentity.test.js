const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

const users = [
  { id: 'viewer', name: 'Viewer', role: 'viewer', token: 'viewer-token', activeCompanyId: 'company-viewer' },
  { id: 'admin-a', name: 'Admin A', role: 'admin', token: 'admin-a-token', activeCompanyId: 'company-a' },
  { id: 'admin-b', name: 'Admin B', role: 'admin', token: 'admin-b-token', activeCompanyId: 'company-b' },
];

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const usersStub = {
  list: () => users.map((user) => ({ ...user })),
  get: (id) => users.find((user) => user.id === id) || null,
  getByToken: (token) => users.find((user) => user.token === token) || null,
  touchLastSeen: () => {},
  create: ({ name, role }) => ({ id: 'created', name, role, token: 'created-token' }),
  update: (id, patch) => ({ ...usersStub.get(id), ...patch }),
  remove: () => true,
  regenerateToken: (id) => ({ ...usersStub.get(id), token: 'regenerated-token' }),
  ensureOwner: () => null,
  setActiveCompany: () => {},
};

stubModule('../main/db/index.js', {
  getAppState: (key) => key === 'active_company_id' ? 'company-local' : null,
  setAppState: () => {},
  getDb: () => { throw new Error('test database is not initialized'); },
});
stubModule('../main/db/users.js', usersStub);
stubModule('../main/db/products.js', { get: () => null });

const server = require('../main/server');
const companies = require('../main/db/companies');
const { getCallerUserId } = require('../main/db/_util');
const events = require('../main/events');
const emitted = [];
events.init({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => emitted.push({ channel, payload }) },
  }),
});

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { ipcMain: { handle: () => {} } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let emitCatalogChange;
try {
  ({ emitCatalogChange } = require('../main/ipc/helpers'));
} finally {
  Module._load = originalLoad;
}

const userHandlers = new Map();
require('../main/ipc/users').register({
  expose(channel, handler) {
    userHandlers.set(channel, handler);
    server.registerHandler(channel, handler);
  },
  exposeLocal() {},
});

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

test('credential-bearing user reads require user management while attribution stays redacted', async () => {
  const { channelCapability } = require('../main/util/capabilities');
  const { allowedByCaps, legacyIsAllowed } = require('../main/util/permissions');

  assert.equal(channelCapability('users:list'), 'users.manage');
  assert.equal(channelCapability('users:listForAttribution'), 'baseline');
  assert.equal(allowedByCaps(new Set(), 'users:list'), false);
  assert.equal(allowedByCaps(new Set(['users.manage']), 'users:list'), true);
  assert.equal(legacyIsAllowed('viewer', 'users:list'), false);
  assert.equal(legacyIsAllowed('admin', 'users:list'), true);

  const localUsers = userHandlers.get('users:list')();
  assert.equal(localUsers.find((user) => user.id === 'admin-b').token, 'admin-b-token');

  const port = await freePort();
  await server.bootServer({ port, dataDir: '/unused-test-data' });
  try {
    const denied = await rpc(port, 'viewer-token', 'users:list');
    assert.deepEqual(denied, {
      status: 403,
      body: { error: 'Forbidden: role "viewer" cannot use users:list' },
    });

    const attribution = await rpc(port, 'viewer-token', 'users:listForAttribution');
    assert.equal(attribution.status, 200);
    assert.deepEqual(attribution.body.result[0], { id: 'viewer', name: 'Viewer', role: 'viewer' });
    assert.equal(JSON.stringify(attribution.body).includes('viewer-token'), false);
    assert.equal(JSON.stringify(attribution.body).includes('admin-a-token'), false);

    const managed = await rpc(port, 'admin-a-token', 'users:list');
    assert.equal(managed.status, 200);
    assert.equal(managed.body.result.find((user) => user.id === 'admin-b').token, 'admin-b-token');

    const regenerated = await rpc(port, 'admin-a-token', 'users:regenerateToken', 'viewer');
    assert.equal(regenerated.status, 200);
    assert.equal(regenerated.body.result.token, 'regenerated-token');
  } finally {
    await server.stopServer();
  }
});

test('overlapping RPCs and a local call retain independent actor, company, and event context', async () => {
  emitted.length = 0;
  const gates = new Map([
    ['a', { entered: deferred(), release: deferred() }],
    ['b', { entered: deferred(), release: deferred() }],
  ]);

  const snapshot = () => ({ actorId: getCallerUserId(), companyId: companies.getActiveId() });
  const handler = async ({ key, fail = false }) => {
    const before = snapshot();
    const gate = gates.get(key);
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    const after = snapshot();
    emitCatalogChange('probe', fail ? 'error' : 'success', key);
    if (fail) throw new Error(JSON.stringify({ before, after }));
    return { before, after };
  };
  server.registerHandler('test:callerContext', handler);

  const port = await freePort();
  await server.bootServer({ port, dataDir: '/unused-test-data' });
  try {
    const requestA = rpc(port, 'admin-a-token', 'test:callerContext', { key: 'a' });
    await gates.get('a').entered.promise;
    const requestB = rpc(port, 'admin-b-token', 'test:callerContext', { key: 'b', fail: true });
    await gates.get('b').entered.promise;

    const local = await handler({ key: 'local' });
    assert.deepEqual(local, {
      before: { actorId: null, companyId: 'company-local' },
      after: { actorId: null, companyId: 'company-local' },
    });

    gates.get('b').release.resolve();
    const responseB = await requestB;
    assert.equal(responseB.status, 500);
    assert.deepEqual(JSON.parse(responseB.body.error), {
      before: { actorId: 'admin-b', companyId: 'company-b' },
      after: { actorId: 'admin-b', companyId: 'company-b' },
    });

    gates.get('a').release.resolve();
    const responseA = await requestA;
    assert.deepEqual(responseA, {
      status: 200,
      body: {
        result: {
          before: { actorId: 'admin-a', companyId: 'company-a' },
          after: { actorId: 'admin-a', companyId: 'company-a' },
        },
      },
    });

    assert.deepEqual(
      emitted.map(({ payload }) => payload.originUserId),
      [null, 'admin-b', 'admin-a'],
    );
    assert.deepEqual(snapshot(), { actorId: null, companyId: 'company-local' });
  } finally {
    gates.get('a').release.resolve();
    gates.get('b').release.resolve();
    await server.stopServer();
  }
});
