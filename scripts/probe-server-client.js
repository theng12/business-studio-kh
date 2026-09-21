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
    const postRpc = async (channel, args) => {
      const response = await fetch(`${base}/api/rpc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args }),
      });
      return { response, body: await response.json() };
    };
    const assertDraftConcurrency = async ({ label, createChannel, getChannel, updateChannel, markExportedChannel, input, kind }) => {
      const created = await invoke(createChannel, input);
      const snapshotA = await invoke(getChannel, { id: created.id });
      const snapshotB = await invoke(getChannel, { id: created.id });
      assert.notEqual(snapshotA, snapshotB, `${label}: snapshots must be independent responses`);
      assert.equal(snapshotA.updatedAt, snapshotB.updatedAt, `${label}: snapshots should start at one revision`);

      const winner = await invoke(updateChannel, {
        id: created.id,
        patch: { name: `${label} winner`, expectedUpdatedAt: snapshotA.updatedAt },
      });
      let staleError;
      try {
        await invoke(updateChannel, {
          id: created.id,
          patch: { name: `${label} stale`, expectedUpdatedAt: snapshotB.updatedAt },
        });
      } catch (error) {
        staleError = error;
      }
      assert.ok(staleError, `${label}: stale write must be rejected`);
      assert.ok(staleError.message.startsWith('CONFLICT|'), `${label}: stale write should return a conflict payload`);
      assert.deepEqual(JSON.parse(staleError.message.slice('CONFLICT|'.length)), {
        kind,
        id: created.id,
        name: winner.name,
        updatedAt: winner.updatedAt,
      });
      assert.deepEqual(await invoke(getChannel, { id: created.id }), winner, `${label}: stale write changed the persisted winner`);

      const sequentialName = `${label} sequential`;
      const sequential = await invoke(updateChannel, {
        id: created.id,
        patch: { name: sequentialName, expectedUpdatedAt: winner.updatedAt },
      });
      assert.equal(sequential.name, sequentialName, `${label}: sequential token response lost the requested name`);
      assert.ok(sequential.updatedAt > winner.updatedAt, `${label}: sequential token write must advance updatedAt`);

      const overwriteName = `${label} explicit overwrite`;
      const overwritten = await invoke(updateChannel, {
        id: created.id,
        patch: { name: overwriteName },
      });
      assert.equal(overwritten.name, overwriteName, `${label}: omitted-token response lost the requested name`);
      assert.ok(overwritten.updatedAt > sequential.updatedAt, `${label}: omitted token overwrite must advance updatedAt`);

      const finalRead = await invoke(getChannel, { id: created.id });
      assert.deepEqual(finalRead, overwritten, `${label}: final read does not match the omitted-token write`);
      const malformed = await postRpc(updateChannel, {
        id: created.id,
        patch: { name: `${label} malformed`, expectedUpdatedAt: 'not-a-number' },
      });
      assert.equal(malformed.response.status, 400, `${label}: malformed token must fail validation before the handler`);
      assert.equal(malformed.body.error, 'Bad request: expectedUpdatedAt must be a finite number');
      assert.deepEqual(await invoke(getChannel, { id: created.id }), finalRead, `${label}: malformed token changed the row`);

      if (markExportedChannel) {
        const beforeExport = await invoke(getChannel, { id: created.id });
        const exported = await postRpc(markExportedChannel, { id: created.id });
        assert.equal(exported.response.status, 200, `${label}: markExported RPC failed`);
        const afterExport = await invoke(getChannel, { id: created.id });
        assert.ok(afterExport.updatedAt > beforeExport.updatedAt, `${label}: markExported must advance updatedAt`);
      }
    };
    const assertWorkspaceConcurrency = async ({ productId, imageId }) => {
      const readImage = async () => {
        const rows = await invoke('images:listByProduct', productId);
        return rows.find((row) => row.id === imageId);
      };
      const snapshotA = await readImage();
      const snapshotB = await readImage();
      assert.ok(snapshotA && snapshotB, 'workspace image fixture was not returned over RPC');
      assert.notEqual(snapshotA, snapshotB, 'workspace snapshots must be independent responses');
      assert.equal(snapshotA.workspaceRevision, 0, 'workspace fixture must start at revision zero');
      assert.equal(snapshotA.workspaceRevision, snapshotB.workspaceRevision, 'workspace snapshots must start at one revision');

      const winnerRows = await invoke('workspace:saveSettings', {
        productId,
        imageId,
        expectedContentHash: snapshotA.contentHash,
        expectedWorkspaceRevision: snapshotA.workspaceRevision,
        settings: { ...snapshotA.workspaceSettings, removeBackground: false, brightness: 15 },
      });
      const winner = winnerRows.find((row) => row.id === imageId);
      assert.equal(winner.workspaceSettings.brightness, 15, 'workspace winner response lost its settings');
      assert.equal(winner.workspaceRevision, snapshotA.workspaceRevision + 1, 'workspace save did not acknowledge the next revision');

      let staleError;
      try {
        await invoke('workspace:saveSettings', {
          productId,
          imageId,
          expectedContentHash: snapshotB.contentHash,
          expectedWorkspaceRevision: snapshotB.workspaceRevision,
          settings: { ...snapshotB.workspaceSettings, removeBackground: false, brightness: 90 },
        });
      } catch (error) {
        staleError = error;
      }
      assert.ok(staleError, 'stale workspace save must be rejected');
      assert.ok(staleError.message.startsWith('CONFLICT|'), 'stale workspace save should return a conflict payload');
      const persistedWinner = await readImage();
      assert.equal(persistedWinner.workspaceSettings.brightness, 15, 'stale workspace save changed the persisted winner');
      assert.equal(persistedWinner.workspaceRevision, winner.workspaceRevision, 'stale workspace save advanced the revision');

      const sequentialRows = await invoke('workspace:saveSettings', {
        productId,
        imageId,
        expectedContentHash: winner.contentHash,
        expectedWorkspaceRevision: winner.workspaceRevision,
        settings: { ...winner.workspaceSettings, removeBackground: false, brightness: 30 },
      });
      const sequential = sequentialRows.find((row) => row.id === imageId);
      assert.equal(sequential.workspaceSettings.brightness, 30, 'sequential workspace ACK lost the requested settings');
      assert.equal(sequential.workspaceRevision, winner.workspaceRevision + 1, 'sequential workspace ACK did not advance the revision');

      const overwrittenRows = await invoke('workspace:saveSettings', {
        productId,
        imageId,
        expectedContentHash: sequential.contentHash,
        settings: { ...sequential.workspaceSettings, removeBackground: false, brightness: 45 },
      });
      const overwritten = overwrittenRows.find((row) => row.id === imageId);
      assert.equal(overwritten.workspaceSettings.brightness, 45, 'explicit workspace overwrite lost the requested settings');
      assert.equal(overwritten.workspaceRevision, sequential.workspaceRevision + 1, 'explicit workspace overwrite did not advance the revision');

      const malformed = await postRpc('workspace:saveSettings', {
        productId,
        imageId,
        expectedContentHash: overwritten.contentHash,
        expectedWorkspaceRevision: 'not-a-number',
        settings: { ...overwritten.workspaceSettings, removeBackground: false, brightness: 60 },
      });
      assert.equal(malformed.response.status, 400, 'malformed workspace revision must fail RPC validation');
      assert.equal(malformed.body.error, 'Bad request: expectedWorkspaceRevision must be a non-negative safe integer');
      const afterMalformed = await readImage();
      assert.equal(afterMalformed.workspaceSettings.brightness, 45, 'malformed workspace revision changed the row');
      assert.equal(afterMalformed.workspaceRevision, overwritten.workspaceRevision, 'malformed workspace revision advanced the row');

      const processedRows = await invoke('workspace:processImage', {
        productId,
        imageId,
        expectedContentHash: afterMalformed.contentHash,
        expectedWorkspaceRevision: afterMalformed.workspaceRevision,
        settings: { ...afterMalformed.workspaceSettings, canvasWidth: 64, canvasHeight: 64, removeBackground: false, brightness: 55 },
      });
      assert.ok(processedRows.processedRelativePath, 'workspace process response lost processedRelativePath');
      const processed = processedRows.images.find((row) => row.id === imageId);
      assert.equal(processed.workspaceSettings.brightness, 55, 'workspace process response lost its settings');
      assert.equal(processed.workspaceRevision, afterMalformed.workspaceRevision + 1, 'workspace process did not acknowledge the next revision');
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
    await assertWorkspaceConcurrency({ productId: product.id, imageId: images[0].id });
    await assertDraftConcurrency({
      label: 'catalog project', kind: 'catalogProject', createChannel: 'catalogStudio:create', getChannel: 'catalogStudio:get',
      updateChannel: 'catalogStudio:update', markExportedChannel: 'catalogStudio:markExported',
      input: { companyId: company.id, name: 'RPC Catalog Draft' },
    });
    await assertDraftConcurrency({
      label: 'social preset', kind: 'socialGridPreset', createChannel: 'socialGrid:create', getChannel: 'socialGrid:get',
      updateChannel: 'socialGrid:update', markExportedChannel: 'socialGrid:markExported',
      input: { companyId: company.id, name: 'RPC Social Draft' },
    });
    await assertDraftConcurrency({
      label: 'label template', kind: 'labelTemplate', createChannel: 'labels:createTemplate', getChannel: 'labels:getTemplate',
      updateChannel: 'labels:updateTemplate', input: { companyId: company.id, name: 'RPC Label Draft' },
    });
    const greetingCount = incoming.filter(e => e.channel === 'server:hello').length;
    sockets[0].terminate();
    req('./main/db/products').update(product.id, { name: 'Edited while socket disconnected' });
    await waitFor(() => incoming.filter(e => e.channel === 'server:hello').length > greetingCount);
    assert.equal((await invoke('products:get', product.id)).name, 'Edited while socket disconnected');
    const attribution = await invoke('users:listForAttribution');
    assert.ok(attribution.every(user => !('token' in user)));
    console.log(JSON.stringify({ pass: true, version: electron.app.getVersion(), checks: ['real SQLite CRUD over actual client RPC', 'active company and write attribution over RPC', 'real WebSocket greeting, catalog event forwarding and automatic reconnect', 'client /m URL normalization', 'client source-file upload to server and asset download', 'viewer token gate and redacted attribution', 'workspace two-snapshot conflict, persisted winner, sequential revision ACKs, explicit overwrite and malformed revision rejection over RPC', 'workspace processImage revision ACK with removeBackground=false', 'catalog/social/label two-snapshot conflicts, persisted winners, sequential tokens, omission overwrites and malformed-token pre-write rejection', 'catalog/social markExported revision advancement'] }));
  } finally {
    db?.close();
    await fs.rm(temp, { recursive: true, force: true });
    clearTimeout(timeout);
  }
})().then(() => process.exit(0), err => { console.error(err.stack); process.exit(1); });
