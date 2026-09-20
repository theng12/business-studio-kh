const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const users = new Map([
  ['admin', { id: 'admin', name: 'Admin', role: 'admin', token: 'admin-token' }],
  ['editor', { id: 'editor', name: 'Editor', role: 'editor', token: 'editor-token' }],
]);
const usersStub = {
  list: () => [...users.values()].map((u) => ({ ...u })),
  get: (id) => users.get(id) ? { ...users.get(id) } : null,
  getByToken: (token) => [...users.values()].find((u) => u.token === token) || null,
  touchLastSeen: () => {},
  update: (id, patch) => {
    const user = users.get(id);
    if (!user) throw new Error('User not found');
    Object.assign(user, patch);
    return { ...user };
  },
  regenerateToken: (id) => {
    const user = users.get(id);
    if (!user) throw new Error('User not found');
    user.token = `${id}-new-token`;
    return { ...user };
  },
  remove: (id) => users.delete(id),
};

const usersModule = require.resolve('../main/db/users.js');
require.cache[usersModule] = { id: usersModule, filename: usersModule, loaded: true, exports: usersStub };

const server = require('../main/server');
const events = require('../main/events');
const userHandlers = new Map();
require('../main/ipc/users').register({
  expose(channel, handler) {
    userHandlers.set(channel, handler);
    server.registerHandler(channel, handler);
  },
  exposeLocal() {},
});

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function rpc(port, token, channel, args) {
  const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  });
  return { status: response.status, body: await response.json() };
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=${token}`);
  const hello = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket greeting timed out')), 1500);
    ws.once('error', reject);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.channel !== 'server:hello') return;
      clearTimeout(timer);
      resolve(frame);
    });
  });
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  return { ws, hello, closed };
}

test('user changes evict WebSockets and server stop closes sockets for a clean restart', async () => {
  const port = await freePort();
  await server.stopServer();
  await server.bootServer({ port, dataDir: '/unused-test-data' });
  const sockets = [];
  try {
    const roleSocket = connect(port, 'editor-token');
    sockets.push(roleSocket);
    assert.equal((await roleSocket.hello).channel, 'server:hello');
    const downgraded = await rpc(port, 'admin-token', 'users:update', {
      id: 'editor', patch: { role: 'viewer' },
    });
    assert.equal(downgraded.status, 200);
    assert.equal((await roleSocket.closed).code, 4001);

    const rotatedSocket = connect(port, 'editor-token');
    sockets.push(rotatedSocket);
    await rotatedSocket.hello;
    const rotated = await rpc(port, 'admin-token', 'users:regenerateToken', 'editor');
    assert.equal(rotated.status, 200);
    assert.equal((await rotatedSocket.closed).code, 4001);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/whoami`, {
      headers: { Authorization: 'Bearer editor-token' },
    })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/whoami`, {
      headers: { Authorization: 'Bearer editor-new-token' },
    })).status, 200);

    const removedSocket = connect(port, 'editor-new-token');
    sockets.push(removedSocket);
    await removedSocket.hello;
    const removed = await rpc(port, 'admin-token', 'users:remove', 'editor');
    assert.equal(removed.status, 200);
    assert.equal((await removedSocket.closed).code, 4001);

    const adminSocket = connect(port, 'admin-token');
    sockets.push(adminSocket);
    await adminSocket.hello;
    await server.stopServer();
    await adminSocket.closed;
    assert.equal(events.getWsClientCount(), 0);

    await server.bootServer({ port, dataDir: '/unused-test-data' });
    const afterRestart = await fetch(`http://127.0.0.1:${port}/api/whoami`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(afterRestart.status, 200);
  } finally {
    for (const entry of sockets) {
      try { entry.ws.terminate(); } catch (_) {}
    }
    await server.stopServer();
  }
});
