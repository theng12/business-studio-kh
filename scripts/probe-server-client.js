// Disposable integration probe: real SQLite, IPC validators, HTTP, WS, image IO.
// Run: ELECTRON_RUN_AS_NODE=1 electron scripts/probe-server-client.js
// All records, credentials, files and app paths live in a new temporary directory.
// Electron UI APIs are stubbed; networking, validators, SQLite and image IO are real.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const req = Module.createRequire(path.join(ROOT, 'package.json'));
const timeout = setTimeout(() => { console.error('FAIL: smoke timed out'); process.exit(1); }, 20000);
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mskh-real-rpc-'));
  let db;
  try {
    let localHandlers = new Map();
    const incoming = [];
    const electron = {
      app: { getVersion: () => req('./package.json').version, getPath: () => temp, getAppPath: () => ROOT, isPackaged: false },
      ipcMain: { handle: (channel, handler) => localHandlers.set(channel, handler), on() {} },
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => incoming.push({ channel, payload }) } }] },
      dialog: {}, shell: {}, protocol: {},
    };
    const sockets = [];
    const WebSocket = req('ws');
    class TrackedWebSocket extends WebSocket {
      constructor(...args) { super(...args); sockets.push(this); }
    }
    const original = Module._load;
    Module._load = function(id, ...rest) {
      if (id === 'electron') return electron;
      if (id === 'ws' && rest[0]?.filename === path.join(ROOT, 'main/client/index.js')) return TrackedWebSocket;
      return original.call(this, id, ...rest);
    };
    const database = req('./main/db');
    database.initDb(path.join(temp, 'data'));
    db = database.getDb();
    const users = req('./main/db/users');
    const admin = users.create({ name: 'Synthetic Admin', role: 'admin' });
    const viewer = users.create({ name: 'Synthetic Viewer', role: 'viewer' });
    req('./main/ipc').registerIpc();
    const server = req('./main/server');
    // Reserve a real ephemeral port then use the existing public server API.
    const net = require('node:net');
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    await server.bootServer({ port, dataDir: path.join(temp, 'data') });
    const base = `http://127.0.0.1:${port}`;
    localHandlers = new Map();
    const client = req('./main/client');
    client.registerClientProxies(() => ({ mode: 'client', clientServerUrl: `${base}/m`, clientToken: admin.token, dataDir: path.join(temp, 'client-data') }));
    const invoke = (channel, args) => localHandlers.get(channel)({}, args);
    const waitFor = async predicate => {
      for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
      throw new Error('Expected client event did not arrive');
    };
    await waitFor(() => incoming.some(e => e.channel === 'server:hello'));
    assert.equal(client.baseUrl(), base);
    const company = await invoke('companies:create', { name: 'Synthetic Company' });
    await invoke('companies:setActive', company.id);
    const product = await invoke('products:create', { companyId: company.id, sku: 'PROBE-001', name: 'Probe Product' });
    await invoke('products:update', { id: product.id, patch: { name: 'Updated over HTTP' } });
    assert.equal((await invoke('products:get', product.id)).name, 'Updated over HTTP');
    assert.equal((await invoke('products:get', product.id)).updatedByUserId, admin.id);
    await waitFor(() => incoming.some(e => e.channel === 'catalog:changed' && e.payload?.id === product.id));
    const pixels = await req('sharp')({ create: { width: 24, height: 24, channels: 3, background: '#cc3322' } }).png().toBuffer();
    const source = path.join(temp, 'sample.png');
    await fs.writeFile(source, pixels);
    await invoke('images:importForProduct', { productId: product.id, sourcePath: source });
    const images = await invoke('images:listByProduct', product.id);
    assert.equal(images.length, 1);
    const response = await fetch(`${base}/assets/${images[0].filepath}`, { headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    const denied = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${viewer.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'users:list' }) });
    assert.equal(denied.status, 403);
    const greetingCount = incoming.filter(e => e.channel === 'server:hello').length;
    sockets[0].terminate();
    req('./main/db/products').update(product.id, { name: 'Edited while socket disconnected' });
    await waitFor(() => incoming.filter(e => e.channel === 'server:hello').length > greetingCount);
    assert.equal((await invoke('products:get', product.id)).name, 'Edited while socket disconnected');
    const attribution = await invoke('users:listForAttribution');
    assert.ok(attribution.every(user => !('token' in user)));
    console.log(JSON.stringify({ pass: true, version: electron.app.getVersion(), checks: ['real SQLite CRUD over actual client RPC', 'active company and write attribution over RPC', 'real WebSocket greeting, catalog event forwarding and automatic reconnect', 'client /m URL normalization', 'client source-file upload to server and asset download', 'viewer token gate and redacted attribution'] }));
  } finally {
    db?.close();
    await fs.rm(temp, { recursive: true, force: true });
    clearTimeout(timeout);
  }
})().then(() => process.exit(0), err => { console.error(err.stack); process.exit(1); });
