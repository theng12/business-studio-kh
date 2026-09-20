#!/usr/bin/env node
/*
 * Disposable packaged-app smoke probe. It only accepts a built .app, seeds
 * synthetic data through the compiled DB
 * modules, then boots real server/client BrowserWindows with isolated profiles.
 *
 * Run: node scripts/probe-packaged-client-server.js --app /absolute/Media\ Studio\ KH.app
 * Optional: --expected-version 0.1.35 --artifacts /absolute/probe-artifacts
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

if (process.argv[2] === '--seed-internal') {
  runSeed(process.argv.slice(3)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
  return;
}

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'Media Studio KH.app';
const DEFAULT_TIMEOUT_MS = 45_000;

function usage() {
  return [
    'Usage: node scripts/probe-packaged-client-server.js --app /absolute/path.app',
    '       [--expected-version X.Y.Z] [--artifacts /absolute/output-dir]',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { app: null, expectedVersion: null, artifacts: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--app') out.app = value;
    else if (flag === '--expected-version') out.expectedVersion = value;
    else if (flag === '--artifacts') out.artifacts = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!out.app) throw new Error('--app is required');
  for (const [name, value] of Object.entries({ app: out.app, artifacts: out.artifacts })) {
    if (value && !path.isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  return out;
}

function redact(value, secrets) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/("(?:adminToken|clientToken|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
}

const WebSocket = require('ws');

async function waitFor(predicate, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function requestJson({ port, pathname }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: pathname,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed?.error || `HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.once('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`DevTools request timed out: ${pathname}`)));
    req.end();
  });
}

function captureChild(child, secrets) {
  let output = '';
  const append = (chunk) => {
    output = `${output}${redact(chunk, secrets)}`.slice(-12_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}

function launchApp({ executable, userData, cacheDir, debugPort, getSecrets }) {
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    `--disk-cache-dir=${cacheDir}`,
    `--remote-debugging-port=${debugPort}`,
  ], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const getOutput = captureChild(child, getSecrets());
  return { child, getOutput };
}

async function debugTarget(debugPort, processInfo, role) {
  try {
    return await waitFor(async () => {
      try {
        const targets = await requestJson({ port: debugPort, pathname: '/json/list' });
        return targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? null;
      } catch (_) { return null; }
    }, `${role} DevTools page`);
  } catch (err) {
    throw new Error(`${err.message}\n${processInfo.getOutput()}`, { cause: err });
  }
}

function cdp(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => {
      socket.terminate();
      finish(reject, new Error(`DevTools command timed out: ${method}`));
    }, 5_000);
    socket.once('error', (err) => finish(reject, err));
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw);
        if (message.id !== 1) return;
        socket.close();
        if (message.error) finish(reject, new Error(message.error.message));
        else finish(resolve, message.result);
      } catch (err) { socket.close(); finish(reject, err); }
    });
  });
}

async function evaluate(target, script) {
  const wrapped = await waitFor(async () => {
    try {
      const response = await cdp(target, 'Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'renderer evaluation failed');
      return { value: response.result?.value };
    } catch (err) {
      if (err.message === 'Execution context was destroyed.') return null;
      throw err;
    }
  }, 'stable renderer evaluation', 30_000);
  return wrapped.value;
}

async function quitApp(target) {
  try { await cdp(target, 'Browser.close'); } catch (_) {}
}

function childExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(child, timeoutMs = 10_000) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timeout); resolve(true); };
    const timeout = setTimeout(() => {
      child.removeListener('exit', done);
      resolve(childExited(child));
    }, timeoutMs);
    child.once('exit', done);
  });
}

async function stopChild(processInfo) {
  const { child } = processInfo;
  if (childExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

async function seedWithPackagedElectron({ executable, archive, dataDir, mode, name }) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [__filename, '--seed-internal', archive, dataDir, mode, name], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const json = out.split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
      if (code !== 0) return reject(new Error(`packaged seed failed (${code}): ${redact(Buffer.concat(stderr).toString('utf8').trim(), [])}`));
      try { resolve(JSON.parse(json)); } catch (err) { reject(new Error(`packaged seed returned invalid JSON: ${redact(out, [])}\n${err.message}`)); }
    });
  });
  return result;
}

function rendererReadyScript() {
  return `new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const check = async () => {
      try {
        const sidebar = document.querySelector('.sidebar');
        const version = await window.api?.app?.getVersion?.();
        const config = await window.api?.settings?.getAll?.();
        if (sidebar && version && config?.mode) {
          resolve({ version, mode: config.mode, dataDir: config.dataDir, sidebarText: sidebar.innerText, visible: getComputedStyle(sidebar).display !== 'none' });
          return;
        }
        if (Date.now() > deadline) throw new Error('renderer API/sidebar not ready');
        setTimeout(check, 100);
      } catch (err) { reject(err); }
    };
    check();
  })`;
}

async function runSeed([archive, dataDir, mode, replacementName]) {
  if (!archive || !dataDir || !mode) throw new Error('seed requires archive, dataDir, and mode');
  const mainDir = path.join(archive, 'dist-electron', 'main');
  const database = require(path.join(mainDir, 'db'));
  database.initDb(dataDir);
  try {
    const users = require(path.join(mainDir, 'db', 'users'));
    const companies = require(path.join(mainDir, 'db', 'companies'));
    const products = require(path.join(mainDir, 'db', 'products'));
    const productImages = require(path.join(mainDir, 'db', 'productImages'));
    const { productAssetDir, productImageBasename } = require(path.join(mainDir, 'util', 'assetPath'));
    let admin = users.getByName('Synthetic Admin');
    if (!admin) admin = users.create({ name: 'Synthetic Admin', role: 'admin' });
    let viewer = users.getByName('Synthetic Viewer');
    if (!viewer) viewer = users.create({ name: 'Synthetic Viewer', role: 'viewer' });
    let company = companies.getByName('Synthetic Company');
    if (!company) company = companies.create({ name: 'Synthetic Company', color: '#2457a6' });
    companies.setActive(company.id);
    let product = products.getBySku(company.id, 'PACKAGED-PROBE-001');
    if (!product) product = products.create({ companyId: company.id, sku: 'PACKAGED-PROBE-001', name: 'Synthetic Product' });
    if (replacementName) product = products.update(product.id, { name: replacementName });
    if (!productImages.listByProduct(product.id).length) {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH7sAAAAASUVORK5CYII=',
        'base64',
      );
      const dir = productAssetDir(company, null, product);
      const filename = `${productImageBasename(product, 0)}.png`;
      const filepath = path.posix.join(dir, filename);
      fs.mkdirSync(path.join(dataDir, 'assets', dir), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'assets', filepath), png);
      productImages.addRow(product.id, {
        filepath,
        filename,
        originalFilepath: 'synthetic.png',
        contentHash: createHash('sha1').update(png).digest('hex'),
        orderIndex: 0,
      });
    }
    const image = productImages.listByProduct(product.id)[0];
    process.stdout.write(JSON.stringify({ companyId: company.id, productId: product.id, imagePath: image.filepath, adminToken: admin.token, viewerId: viewer.id }));
  } finally {
    database.getDb().close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  const sourceApp = path.resolve(options.app);
  const executableName = process.platform === 'darwin' ? 'Media Studio KH' : 'Media Studio KH';
  const sourceExecutable = path.join(sourceApp, 'Contents', 'MacOS', executableName);
  if (path.basename(sourceApp) !== APP_NAME || !fs.statSync(sourceApp).isDirectory()) throw new Error(`Expected an existing ${APP_NAME}: ${sourceApp}`);
  if (!fs.existsSync(sourceExecutable)) throw new Error(`Packaged executable not found: ${sourceExecutable}`);

  const root = await fsp.mkdtemp(path.join(ROOT, '.probe-packaged-client-server-'));
  const processes = [];
  let seed;
  try {
    const serverUserData = path.join(root, 'server-user-data');
    const clientUserData = path.join(root, 'client-user-data');
    const serverData = path.join(root, 'server-data');
    const clientData = path.join(root, 'client-data');
    const serverCache = path.join(root, 'server-cache');
    const clientCache = path.join(root, 'client-cache');
    const serverPort = await reserveLoopbackPort();
    const serverDebugPort = await reserveLoopbackPort();
    const clientDebugPort = await reserveLoopbackPort();
    const archive = path.join(sourceApp, 'Contents', 'Resources', 'app.asar');
    const executable = sourceExecutable;
    await Promise.all([serverUserData, clientUserData, serverData, clientData, serverCache, clientCache].map((dir) => fsp.mkdir(dir, { recursive: true })));
    seed = await seedWithPackagedElectron({ executable, archive, dataDir: serverData, mode: 'seed', name: '' });
    await fsp.writeFile(path.join(serverUserData, 'config.json'), JSON.stringify({
      dataDir: serverData, firstLaunchHandled: true, mode: 'server', serverPort, webViewerEnabled: false,
    }, null, 2));
    await fsp.writeFile(path.join(clientUserData, 'config.json'), JSON.stringify({
      dataDir: clientData, firstLaunchHandled: true, mode: 'client', clientServerUrl: `http://127.0.0.1:${serverPort}`, clientToken: seed.adminToken,
    }, null, 2));

    const secretList = () => [seed?.adminToken];
    const server = launchApp({ executable, userData: serverUserData, cacheDir: serverCache, debugPort: serverDebugPort, getSecrets: secretList });
    processes.push(server);
    const serverTarget = await debugTarget(serverDebugPort, server, 'server');
    const client = launchApp({ executable, userData: clientUserData, cacheDir: clientCache, debugPort: clientDebugPort, getSecrets: secretList });
    processes.push(client);
    const clientTarget = await debugTarget(clientDebugPort, client, 'client');

    const [serverUi, clientUi] = await Promise.all([
      evaluate(serverTarget, rendererReadyScript()),
      evaluate(clientTarget, rendererReadyScript()),
    ]);
    assert.equal(serverUi.version, clientUi.version, 'server and client rendered different app versions');
    if (options.expectedVersion) assert.equal(clientUi.version, options.expectedVersion, 'rendered version did not match --expected-version');
    assert.equal(serverUi.mode, 'server');
    assert.equal(clientUi.mode, 'client');
    assert.equal(serverUi.dataDir, serverData, 'server did not load its isolated data directory');
    assert.equal(clientUi.dataDir, clientData, 'client did not load its isolated data directory');
    assert.ok(serverUi.visible && clientUi.visible, 'sidebar was not visible');
    assert.match(serverUi.sidebarText, /Product Library/);
    assert.match(clientUi.sidebarText, /Product Library/);

    const clientRead = await evaluate(clientTarget, `window.api.products.get(${JSON.stringify(seed.productId)})`);
    assert.equal(clientRead.name, 'Synthetic Product');
    const editedName = 'Updated by packaged client probe';
    const clientUpdated = await evaluate(clientTarget, `window.api.products.update(${JSON.stringify(seed.productId)}, { name: ${JSON.stringify(editedName)} })`);
    assert.equal(clientUpdated.name, editedName);
    const serverObserved = await evaluate(serverTarget, `window.api.products.get(${JSON.stringify(seed.productId)})`);
    assert.equal(serverObserved.name, editedName, 'server renderer did not observe the client mutation');
    const image = await evaluate(clientTarget, `new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ loaded: true, width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ loaded: false });
      image.src = 'app-image://local/' + encodeURIComponent(${JSON.stringify(seed.imagePath)});
    })`);
    assert.ok(image.loaded && image.width > 0 && image.height > 0, 'client image protocol did not render the synthetic image');

    await quitApp(serverTarget);
    if (!(await waitForChildExit(server.child))) throw new Error('server did not exit after Browser.close');
    await seedWithPackagedElectron({ executable, archive, dataDir: serverData, mode: 'update', name: 'Updated while server was offline' });
    const restartedDebugPort = await reserveLoopbackPort();
    const serverRestarted = launchApp({ executable, userData: serverUserData, cacheDir: serverCache, debugPort: restartedDebugPort, getSecrets: secretList });
    processes.push(serverRestarted);
    await debugTarget(restartedDebugPort, serverRestarted, 'restarted server');
    const reconnected = await waitFor(async () => {
      const state = await evaluate(clientTarget, 'window.api.client.connectionState()');
      return state?.status === 'connected' ? state : null;
    }, 'client WebSocket reconnect', DEFAULT_TIMEOUT_MS);
    assert.equal(reconnected.status, 'connected');
    const refreshed = await evaluate(clientTarget, `window.api.products.get(${JSON.stringify(seed.productId)})`);
    assert.equal(refreshed.name, 'Updated while server was offline', 'client did not read refreshed product state after reconnect');

    const result = {
      pass: true,
      version: clientUi.version,
      checks: [
        'real server and client BrowserWindows/preloads rendered matching version and modes',
        'visible Product Library sidebar navigation in both real renderers',
        'client renderer read and updated synthetic product; server renderer observed it',
        'client app-image protocol fetched synthetic product image',
        'client WebSocket reconnected after server restart and read refreshed state',
      ],
      limitations: ['Server production code binds 0.0.0.0; this disposable probe uses a random port and only connects its client through 127.0.0.1. It is not physical two-Mac evidence.'],
    };
    if (options.artifacts) {
      await fsp.mkdir(options.artifacts, { recursive: true });
      await fsp.writeFile(path.join(options.artifacts, 'packaged-client-server-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await Promise.all(processes.map(stopChild));
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${redact(err.stack || err.message, [])}\n`);
  process.exitCode = 1;
});
