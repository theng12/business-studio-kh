// Real Chromium + unmodified webclient HTML; loopback HTTP/RPC fixtures, not the app server.
// Run: node scripts/probe-webclient-context.js (Node 24; launches installed Electron).
// Optional --baseline loads the task's base-commit HTML as a negative control.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// The Node supervisor cleans the profile AFTER Chromium exits, so late cache
// writes cannot recreate it. It also bounds native dialogs/main-process hangs.
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let ownedProfile;
  child.on('message', ({ profile }) => {
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('mskh-webclient-context-profile-')) ownedProfile = profile;
  });
  const timeout = setTimeout(() => {
    process.stderr.write('Webclient probe supervisor: 40-second deadline exceeded\n');
    child.kill('SIGKILL');
  }, 40_000);
  child.on('error', () => { clearTimeout(timeout); process.exitCode = 1; });
  child.on('exit', (code) => {
    clearTimeout(timeout);
    setTimeout(() => {
      if (ownedProfile) fs.rmSync(ownedProfile, { recursive: true, force: true });
      process.exitCode = code === 0 ? 0 : 1;
    }, 250);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  return;
}

const { app, BrowserWindow, session } = require('electron');
if (!process.send) {
  process.stderr.write('Run this probe using Node, which supervises Electron cleanup.\n');
  app.exit(1);
  return;
}

const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const source = baseline
  ? execFileSync('git', ['show', '54616464153b4960a4e75e0f77e39f189549f0a3:webclient/index.html'], { cwd: root })
  : fs.readFileSync(path.join(root, 'webclient/index.html'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-webclient-context-artifacts-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-webclient-context-profile-'));
app.setPath('userData', profile); // Before app readiness or any BrowserWindow/session.
app.setPath('sessionData', profile);
process.send({ profile });
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
const result = { kind: 'webclient-ui-fixture', baseline, sourceSha256: sha256(source), artifacts, profile, checks: [] };
const servers = [];
const timers = new Set();
let win;
let finished = false;
const hardTimeout = setTimeout(() => finish(new Error('Probe exceeded 30-second deadline')), 30_000);
app.on('window-all-closed', () => {}); // finish() owns shutdown, including failures.
process.on('uncaughtException', finish); // Avoid a blocking native error dialog.
process.on('unhandledRejection', finish);

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimeout);
  for (const timer of timers) clearTimeout(timer);
  if (win && !win.isDestroyed()) win.destroy();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  result.pass = !error;
  if (error) result.error = String(error.message).replaceAll('synthetic-probe-token', '[dummy-token]');
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.exit(error ? 1 : 0);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read(); // Electron IPC is also bounded by the process-wide deadline.
    if (value) return value;
    await pause(25);
  }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const svg = (color) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${color}"/></svg>`);
const companies = [{ id: 'a', name: 'Company Alpha' }, { id: 'b', name: 'Company Beta' }];
const products = {
  a: [{ id: 'a1', sku: 'ALPHA-1', name: 'Alpha red', imageCount: 1 }, { id: 'a2', sku: 'ALPHA-2', name: 'Alpha blue', imageCount: 1 }],
  b: [{ id: 'b1', sku: 'BETA-1', name: 'Beta product', imageCount: 0 }],
};

async function fixture(second = false) {
  const state = { active: 'a', delayedSetters: false, calls: [], completedSetters: [], held: [], holdRed: true, heldLists: [], holdLists: !second };
  const images = { '/assets/products/red.svg': svg('#ff0000'), '/assets/products/shared.svg': svg(second ? '#00ff00' : '#0000ff') };
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/m') { res.setHeader('Content-Type', 'text/html'); res.end(source); return; }
    if (req.headers.authorization !== 'Bearer synthetic-probe-token') { res.statusCode = 401; json({ error: 'Denied' }); return; }
    if (req.url === '/api/whoami') { json({ user: { id: 'fixture-viewer', role: 'viewer' } }); return; }
    if (images[req.url]) {
      const send = () => { res.setHeader('Content-Type', 'image/svg+xml'); res.end(images[req.url]); };
      if (state.holdRed && req.url.endsWith('/red.svg')) state.held.push(send);
      else send();
      return;
    }
    if (req.url !== '/api/rpc') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let request;
      try { request = JSON.parse(body); } catch { res.statusCode = 400; json({ error: 'Invalid fixture request' }); return; }
      const { channel, args } = request;
      state.calls.push({ channel, args });
      if (channel === 'companies:list') json({ result: companies });
      else if (channel === 'companies:getActiveId') json({ result: state.active });
      else if (channel === 'companies:setActive') {
        const timer = setTimeout(() => {
          timers.delete(timer);
          state.active = args;
          state.completedSetters.push(args);
          json({ result: args });
        }, state.delayedSetters ? (args === 'b' ? 400 : 20) : 0);
        timers.add(timer);
      } else if (channel === 'products:list') json({ result: products[args.companyId] });
      else if (channel === 'images:listByProduct') {
        const send = () => json({ result: [{ productId: args, filepath: args === 'a1' ? 'products/red.svg' : 'products/shared.svg' }] });
        if (state.holdLists && args === 'a1') state.heldLists.push(send);
        else send();
      }
      else if (channel === 'categories:list' || channel === 'ai:listTasks') json({ result: [] });
      else { res.statusCode = 400; json({ error: 'Unexpected fixture RPC' }); }
    });
  });
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { state, images, url: `http://127.0.0.1:${server.address().port}` };
}

async function connect(server) {
  const previousSetters = server.state.completedSetters.length;
  await js(`document.getElementById('srv').value = ${JSON.stringify(server.url)};
    document.getElementById('tok').value = 'synthetic-probe-token';`);
  await click('#connectBtn');
  await waitFor(() => server.state.completedSetters.length > previousSetters, 'new connection company activation');
  await waitFor(() => js(`document.querySelectorAll('#list .card').length === 2`), 'Alpha rows');
}

async function chooseCompany(name) {
  await click('#companyBtn');
  await js(`Array.from(document.querySelectorAll('#companySheetList .sheet-row')).find(row => row.querySelector('span').textContent === ${JSON.stringify(name)}).click()`);
}

async function screenshot(name) {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await pause(100); // capturePage must observe the compositor, not just updated DOM.
  fs.writeFileSync(path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}

async function gallery() {
  return js(`(async () => {
    const image = document.querySelector('#detailGallery img');
    if (!image || !image.complete || !image.naturalWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1);
    const bytes = await (await fetch(image.src)).arrayBuffer();
    return {
      sku: document.getElementById('detailSku').textContent,
      open: document.getElementById('detail').classList.contains('open'),
      paths: Array.from(document.querySelectorAll('#detailGallery figure')).map(el => el.dataset.filepath),
      pixel: Array.from(ctx.getImageData(0, 0, 1, 1).data),
      hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('')
    };
  })()`);
}

app.whenReady().then(async () => {
  assert.equal(app.getPath('userData'), profile);
  assert.equal(app.getPath('sessionData'), profile);
  const first = await fixture();
  const second = await fixture(true);
  const allowed = new Set([first.url, second.url]);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: !allowed.has(url.origin) && !['blob:', 'data:'].includes(url.protocol) });
  });
  win = new BrowserWindow({ width: 980, height: 900, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL(`${first.url}/m`);
  await connect(first);

  // A → B → A, with B taking longer than A if setters overlap.
  first.state.delayedSetters = true;
  await chooseCompany('Company Beta');
  await waitFor(() => first.state.calls.some(call => call.channel === 'companies:setActive' && call.args === 'b'), 'B setter received');
  await chooseCompany('Company Alpha');
  await waitFor(() => first.state.completedSetters.length === 3, 'all setters completed');
  await waitFor(() => js(`document.querySelectorAll('#list .card').length === 2`), 'final Alpha rows');
  const company = await js(`({ title: document.getElementById('companyBtn').title, mark: document.getElementById('companyMark').textContent,
    rows: Array.from(document.querySelectorAll('#list .card .sku')).map(el => el.textContent).sort(),
    visible: getComputedStyle(document.getElementById('app')).display !== 'none' })`);
  assert.equal(first.state.active, 'a', 'server-selected company must agree with visible Alpha');
  assert.deepEqual(company, { title: 'Company: Company Alpha — tap to switch', mark: 'CA', rows: ['ALPHA-1', 'ALPHA-2'], visible: true });
  result.checks.push({ name: 'company-A-B-A', pass: true, serverSelectedId: first.state.active, completedSetters: first.state.completedSetters, dom: company });
  await screenshot('company-alpha');

  // First delay A's image-list response, then its asset bytes, across A → B.
  await click('.card[data-id="a1"]');
  await waitFor(() => first.state.heldLists.length > 0, 'delayed A image list');
  await click('#detailClose');
  await click('.card[data-id="a2"]');
  const blue = await waitFor(gallery, 'B decoded image');
  assert.deepEqual(blue, { sku: 'ALPHA-2', open: true, paths: ['products/shared.svg'], pixel: [0, 0, 255, 255], hash: sha256(first.images['/assets/products/shared.svg']) });
  const delayedLists = first.state.heldLists.length;
  first.state.holdLists = false;
  for (const send of first.state.heldLists.splice(0)) send();
  for (let i = 0; i < 12; i++) { await pause(25); assert.deepEqual(await gallery(), blue); }
  await click('#detailClose');
  await click('.card[data-id="a1"]');
  await waitFor(() => js(`!!document.querySelector('#detailGallery figure[data-filepath="products/red.svg"]')`), 'A gallery placeholder');
  await waitFor(() => first.state.held.length > 0, 'delayed A image response');
  await click('#detailClose');
  await click('.card[data-id="a2"]');
  assert.deepEqual(await waitFor(gallery, 'B decoded image again'), blue);
  const delayedResponses = first.state.held.length;
  first.state.holdRed = false;
  for (const send of first.state.held.splice(0)) send();
  // Sample through response decoding/paint, not just before the delayed reply.
  for (let i = 0; i < 12; i++) { await pause(25); assert.deepEqual(await gallery(), blue); }
  result.checks.push({ name: 'late-A-image-keeps-B-gallery', pass: true, delayedLists, delayedResponses, dom: blue });
  await screenshot('gallery-blue-after-late-red');

  // Same document/profile/product/path; only the server and bytes change.
  await click('#detailClose');
  await js('window.confirm = () => true; void 0'); // Accept only the disconnect confirmation.
  await click('#disconnect');
  await connect(second);
  await click('.card[data-id="a2"]');
  const green = await waitFor(gallery, 'second server decoded image');
  assert.deepEqual(green, { ...blue, pixel: [0, 255, 0, 255], hash: sha256(second.images['/assets/products/shared.svg']) });
  result.checks.push({ name: 'reconnect-same-filename-new-bytes', pass: true, dom: green });
  await screenshot('gallery-green-second-server');
  if (!baseline) assert.equal(sha256(fs.readFileSync(path.join(root, 'webclient/index.html'))), result.sourceSha256, 'HTML changed during probe; rerun against stable source');
  finish();
}).catch(finish);
