const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function loadClientHarness() {
  const timers = [];
  const sent = [];
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const clientFilename = require.resolve('../main/client');
  const whoami = deferred();

  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      FakeWebSocket.instance = this;
    }
  }

  const electron = {
    ipcMain: { handle() {}, on() {} },
    app: { getVersion: () => 'test' },
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }],
      getFocusedWindow: () => null,
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => '' },
    net: { fetch: async () => new Response('image') },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }), createEmpty: () => ({}) },
  };

  delete require.cache[clientFilename];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'ws') return FakeWebSocket;
    if (request === '../imageManager') return { scanImagesRecursive: () => [], groupAndSortMatches: () => ({ groups: new Map(), unmatched: [] }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  global.fetch = (url) => {
    if (String(url).endsWith('/api/ping')) return Promise.resolve({ ok: true, json: async () => ({ version: 'test' }) });
    if (String(url).endsWith('/api/whoami')) return whoami.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  };
  global.setTimeout = (callback) => {
    timers.push(callback);
    return { unref() {} };
  };
  global.clearTimeout = () => {};

  const client = require('../main/client');
  client.registerClientProxies(() => ({ clientServerUrl: 'http://server.test', clientToken: 'synthetic-token' }));

  return {
    client,
    sent,
    timers,
    whoami,
    socket: FakeWebSocket.instance,
    restore() {
      Module._load = originalLoad;
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      delete require.cache[clientFilename];
    },
  };
}

test('server hello keeps the current role when an earlier whoami request finishes later', async () => {
  const harness = loadClientHarness();
  try {
    const firstPoll = harness.timers.shift();
    await firstPoll();

    harness.socket.emit('message', Buffer.from(JSON.stringify({
      channel: 'server:hello',
      payload: { user: { id: 'user-1', name: 'Current viewer', role: 'viewer', caps: [] } },
    })));
    harness.whoami.resolve({ ok: true, json: async () => ({ user: { id: 'user-1', name: 'Stale editor', role: 'editor', caps: ['products.edit'] } }) });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(setImmediate);

    assert.deepEqual(harness.client.getConnectionState().user, {
      id: 'user-1', name: 'Current viewer', role: 'viewer', caps: [],
    });
    assert.deepEqual(harness.sent.at(-1), {
      channel: 'server:hello',
      payload: { user: { id: 'user-1', name: 'Current viewer', role: 'viewer', caps: [] } },
    });
  } finally {
    harness.restore();
  }
});
