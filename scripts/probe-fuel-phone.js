// Real Chromium + the built fuel phone page (/f); a loopback fixture server, not the app server.
// Run: node scripts/probe-fuel-phone.js   (launches the installed Electron; needs no app data)
//
// Drives: QR pairing (#t= token removed from the address bar) → Khmer home →
// "Give fuel" with real camera-file uploads (shrunk to 1600 px on the page) →
// a "Dip tank" whose answer is lost (kept in IndexedDB, survives a reload,
// resent with the SAME client_ref) → "I bought fuel" with riel.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let ownedProfile;
  child.on('message', ({ profile }) => {
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('mskh-fuel-phone-profile-')) ownedProfile = profile;
  });
  const timeout = setTimeout(() => { process.stderr.write('Fuel phone probe: 90-second deadline exceeded\n'); child.kill('SIGKILL'); }, 90_000);
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

const { app, BrowserWindow, session, nativeImage } = require('electron');
if (!process.send) { process.stderr.write('Run this probe using Node.\n'); app.exit(1); return; }

const root = path.resolve(__dirname, '..');
const { buildFuelHtml } = require('./build-webclient');
const page = buildFuelHtml(root);
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-fuel-phone-artifacts-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-fuel-phone-profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
process.send({ profile });
const result = { kind: 'fuel-phone-fixture', artifacts, checks: [] };
let win;
let server;
let finished = false;
const hardTimeout = setTimeout(() => finish(new Error('Probe exceeded 80-second deadline')), 80_000);
app.on('window-all-closed', () => {});
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimeout);
  if (win && !win.isDestroyed()) win.destroy();
  if (server) { server.closeAllConnections(); server.close(); }
  result.pass = !error;
  if (error) result.error = String(error.stack || error.message);
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify({ pass: result.pass, error: result.error, checks: result.checks.map((c) => c.name), artifacts })}\n`);
  app.exit(error ? 1 : 0);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, label, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(40);
  }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const click = (selector) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); })()`);
const exists = (selector) => js(`!!document.querySelector(${JSON.stringify(selector)})`);
const clickButton = (text) => js(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); })()`);
const h1 = () => js(`(document.querySelector('main h1') || {}).textContent || ''`);
async function keys(list) { for (const k of list) await click(`.key[data-key="${k}"]`); }
async function screenshot(name) {
  await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await pause(80);
  fs.writeFileSync(path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}

/* A camera-sized JPEG (3000 × 2000) the page must shrink. */
function cameraJpeg() {
  const w = 3000; const h = 2000;
  const bmp = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { bmp[i * 4] = 40; bmp[i * 4 + 1] = (i % w) % 256; bmp[i * 4 + 2] = 200; bmp[i * 4 + 3] = 255; }
  const file = path.join(artifacts, 'camera.jpg');
  fs.writeFileSync(file, nativeImage.createFromBitmap(bmp, { width: w, height: h }).toJPEG(90));
  return file;
}
let photoFile;
async function takePhoto() {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const { root: doc } = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
  const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' });
  assert.ok(nodeId, 'a camera input is on the screen');
  const before = await h1();
  await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [photoFile] });
  await waitFor(async () => (await h1()) !== before, `photo step "${before}" moves on`);
}

const ULLAGE = [{ dipCm: 0, litres: 3500 }, { dipCm: 95, litres: 2156 }, { dipCm: 100, litres: 2046 }, { dipCm: 120, litres: 1850 }, { dipCm: 200, litres: 0 }];
const state = { calls: [], saved: new Map(), loseNextDip: false, n: 0 };

function fixture() {
  server = http.createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const url = req.url.split('?')[0];
    if (url === '/f') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return; }
    if (req.headers.authorization !== 'Bearer probe-pump-token') { json(401, { error: 'Invalid or missing token' }); return; }
    if (url === '/api/whoami') { json(200, { user: { id: 'u-pump', name: 'Pump phone', role: 'pump', caps: ['fuel.record'] } }); return; }
    if (url !== '/api/rpc') { json(404, { error: 'Not found' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { channel, args } = JSON.parse(body);
      state.calls.push({ channel, args });
      const ok = (r) => json(200, { result: r });
      const save = (kind, rec) => {
        const dup = state.saved.has(args.clientRef);
        if (!dup) state.saved.set(args.clientRef, { id: `${kind}-${++state.n}`, ...rec, at: Date.now() - (args.queuedForMs || 0) });
        return { [kind]: state.saved.get(args.clientRef), duplicate: dup, flags: [] };
      };
      switch (channel) {
        case 'companies:list': return ok([{ id: 'c1', name: 'Farm' }]);
        case 'companies:getActiveId': return ok('c1');
        case 'fuel:getSettings': return ok({ canSizeL: 20, defaultCurrency: 'KHR' });
        case 'fuel:listAssets': return ok([{ id: 'truck1', name: 'Truck 1', plateOrSerial: '3A-1234', typeName: 'Truck', meterUnit: 'km', status: 'active', assignedEmployeeId: 'emp1', photoId: null }]);
        case 'fuel:listLocations': return ok([{ id: 'tank1', name: 'Warehouse tank', kind: 'tank', capacityL: 5000, hasFlowMeter: false, hasChart: true, status: 'active' }]);
        case 'staff:list': return ok([{ id: 'emp1', nameEn: 'Sok', nameKm: 'សុខ', staffCode: 'D01', isDriver: true, isFuelAttendant: false, status: 'active', hasPhoto: false }]);
        case 'staff:me': return ok({ id: 'emp1', nameEn: 'Sok', nameKm: 'សុខ', isDriver: true, isFuelAttendant: true, status: 'active' });
        case 'fuel:listStations': return ok([{ id: 's1', name: 'Tela Kampong Speu', area: null, archived: false }]);
        case 'fuel:getChart': return ok(ULLAGE);
        case 'fuel:recordFill': {
          const litres = args.litres ?? (args.cansCount ? args.cansCount * args.canSizeL : args.litresShownOnPump);
          return ok(save('fill', { kind: args.kind, assetId: args.assetId, litres, meterReading: args.meterReading ?? null, fullTank: !!args.fullTank, amountPaidMinor: args.amountPaidMinor ?? null, currency: args.currency ?? null }));
        }
        case 'fuel:recordDip': {
          const out = save('dip', { locationId: args.locationId, dipCm: args.dipCm, litres: 2090 });
          if (state.loseNextDip) {
            // Saved, but the answer is cut off mid-body (a dropped connection).
            // A reset before any byte would let Chromium silently replay the POST.
            state.loseNextDip = false;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"result":{"dip":');
            setTimeout(() => req.socket.destroy(), 50);
            return undefined;
          }
          return ok(out);
        }
        case 'fuel:recordDelivery': return ok(save('delivery', { locationId: args.locationId, litresInvoiced: args.litresInvoiced, dipBeforeId: args.dipBeforeId ?? null, dipAfterId: args.dipAfterId ?? null }));
        case 'fuel:listMyRecent': return ok({ fills: [], dips: [], deliveries: [], transfers: [] });
        default: return json(400, { error: `Unexpected fixture RPC ${channel}` });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function decodeJpeg(b64) {
  const buf = Buffer.from(b64, 'base64');
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
  return { bytes: buf.length, ...nativeImage.createFromBuffer(buf).getSize() };
}

app.whenReady().then(async () => {
  photoFile = cameraJpeg();
  const base = await fixture();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const u = new URL(details.url);
    callback({ cancel: u.origin !== base && !['blob:', 'data:', 'devtools:'].includes(u.protocol) });
  });
  win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });

  /* 1. pairing from the QR link */
  await win.loadURL(`${base}/f#t=probe-pump-token`);
  await waitFor(() => exists('[data-flow="give"]'), 'home tiles');
  const home = await js(`({ hash: location.hash, href: location.href, stored: localStorage.getItem('mskh.fuel.token'), lang: document.documentElement.lang,
    title: document.getElementById('barTitle').textContent, tiles: Array.from(document.querySelectorAll('[data-flow]')).map(b => b.dataset.flow) })`);
  assert.equal(home.hash, '');
  assert.doesNotMatch(home.href, /probe-pump-token/);
  assert.equal(home.stored, 'probe-pump-token');
  assert.equal(home.lang, 'km');
  assert.equal(home.title, 'ប្រេងឥន្ធនៈ');
  assert.deepEqual(home.tiles.slice(0, 2), ['give', 'dip']);
  result.checks.push({ name: 'pairing-and-khmer-home', home });
  await screenshot('1-home-khmer');

  /* 2. Give fuel: the single tank is picked by itself; 3 cans; two photos */
  await click('[data-flow="give"]');
  await waitFor(() => exists('.tile[data-id="truck1"]'), 'vehicle tiles (tank auto-picked)');
  await click('.tile[data-id="truck1"]');
  await waitFor(() => exists('.tile[data-id="emp1"]'), 'driver tiles');
  await click('.tile[data-id="emp1"]');
  await waitFor(() => exists('input[type=file]'), 'meter photo step');
  await takePhoto();
  await waitFor(() => exists('.key[data-key="1"]'), 'meter keypad');
  await keys(['1', '2', '3', '4', '5']);
  await screenshot('2-keypad');
  await clickButton('បន្ទាប់');
  await waitFor(() => exists('[data-value="cans"]'), 'litres or cans');
  await click('[data-value="cans"]');
  await waitFor(() => exists('.stepper'), 'cans stepper');
  await js(`document.querySelectorAll('.stepper .key')[1].click(); document.querySelectorAll('.stepper .key')[1].click();`);
  assert.match(await js(`document.querySelector('.live').textContent`), /^3 × 20 លីត្រ = 60 លីត្រ$/);
  await clickButton('បន្ទាប់');
  await waitFor(() => exists('input[type=file]'), 'fill photo step');
  await takePhoto();
  await waitFor(() => exists('[data-value="true"]'), 'full tank question');
  await click('[data-value="true"]');
  await waitFor(() => exists('[data-save]'), 'review');
  await screenshot('3-review');
  await click('[data-save]');
  await waitFor(() => exists('[data-result="sent"]'), 'saved');
  await screenshot('4-saved');
  const fill = state.calls.find((c) => c.channel === 'fuel:recordFill').args;
  assert.match(fill.clientRef, /^f:[0-9a-f]{8}:[0-9a-f-]{36}$/);
  assert.equal(fill.source, 'phone');
  assert.equal(fill.companyId, 'c1');
  assert.equal(fill.at, undefined);
  assert.ok(fill.queuedForMs >= 0 && fill.queuedForMs < 60_000, `queuedForMs ${fill.queuedForMs}`);
  assert.deepEqual({ kind: fill.kind, locationId: fill.locationId, assetId: fill.assetId, driver: fill.driverEmployeeId, meter: fill.meterReading, cans: fill.cansCount, size: fill.canSizeL, full: fill.fullTank },
    { kind: 'warehouse_tank', locationId: 'tank1', assetId: 'truck1', driver: 'emp1', meter: 12345, cans: 3, size: 20, full: true });
  const shots = fill.photos.map((p) => ({ kind: p.kind, ...decodeJpeg(p.bytes.b64) }));
  assert.deepEqual(shots.map((s) => s.kind), ['meter', 'fill']);
  for (const s of shots) {
    assert.equal(Math.max(s.width, s.height), 1600, 'shrunk to 1600 px');
    assert.ok(s.bytes < 600 * 1024, `photo is ${s.bytes} bytes`);
  }
  result.checks.push({ name: 'give-fuel-cans-photos', photos: shots, original: fs.statSync(photoFile).size });

  /* 3. Dip tank, answer lost: kept, survives a reload, resent with the same client_ref */
  await clickButton('រួចរាល់');
  await waitFor(() => exists('[data-flow="dip"]'), 'home again');
  await click('#langBtn');
  assert.equal(await js(`document.getElementById('barTitle').textContent`), 'Fuel');
  assert.equal(await js(`localStorage.getItem('mskh.fuel.lang')`), 'en');
  await click('[data-flow="dip"]');
  await waitFor(() => exists('input[type=file]'), 'stick photo (tank auto-picked)');
  await takePhoto();
  await waitFor(() => exists('.key[data-key="9"]'), 'dip keypad');
  await keys(['9', '8']);
  assert.equal(await js(`document.querySelector('.live').textContent`), '≈ 2,090 L');
  await clickButton('Next');
  await waitFor(() => exists('[data-save]'), 'dip review');
  state.loseNextDip = true;
  await click('[data-save]');
  await waitFor(() => exists('[data-result="queued"]'), 'kept on the phone', 20_000);
  const chip = await js(`document.getElementById('outboxChip').textContent`);
  assert.match(chip, /1 waiting to send/);
  await screenshot('5-queued');
  const firstRef = state.calls.filter((c) => c.channel === 'fuel:recordDip')[0].args.clientRef;
  win.webContents.reload();
  await waitFor(() => state.calls.filter((c) => c.channel === 'fuel:recordDip').length === 2, 'resent after reload', 20_000);
  const dips = state.calls.filter((c) => c.channel === 'fuel:recordDip').map((c) => c.args);
  assert.equal(dips[1].clientRef, firstRef, 'the same client_ref');
  assert.equal(dips[1].dipCm, 98);
  assert.equal(dips[1].photos.length, 1, 'the photo was kept in IndexedDB');
  assert.ok(dips[1].queuedForMs >= 4000, `waited ${dips[1].queuedForMs} ms`);
  assert.equal([...state.saved.keys()].filter((k) => k === firstRef).length, 1);
  await waitFor(() => js(`document.getElementById('outboxChip').hidden`), 'chip clears');
  const left = await js(`new Promise((res) => { const r = indexedDB.open('mskh-fuel', 1); r.onsuccess = () => { const q = r.result.transaction('outbox').objectStore('outbox').count(); q.onsuccess = () => res(q.result); }; })`);
  assert.equal(left, 0);
  result.checks.push({ name: 'lost-answer-reload-resend-same-client-ref', clientRef: firstRef, waitedMs: dips[1].queuedForMs });

  /* 4. I bought fuel: my vehicle pre-selected, riel, station from the list */
  await waitFor(() => exists('[data-flow="bought"]'), 'home after reload');
  await click('[data-flow="bought"]');
  await waitFor(() => exists('.tile.is-picked[data-id="truck1"]'), 'my vehicle pre-selected');
  await clickButton('Next');
  await waitFor(() => exists('input[type=file]'), 'pump display photo');
  await takePhoto();
  await takePhoto(); // odometer
  await keys(['5', '0', '0', '0', '0']);
  await clickButton('Next');
  await waitFor(async () => (await h1()) === 'Amount paid', 'amount');
  assert.equal(await exists('.key[data-key="."]'), false, 'riel have no decimals');
  await keys(['1', '2', '0', '0', '0', '0']);
  assert.match(await js(`document.querySelector('[data-readout]').textContent`), /^120,000៛$/);
  await clickButton('Next');
  await waitFor(async () => (await h1()) === 'Litres shown on the pump', 'litres shown');
  await keys(['2', '9', '.', '5']);
  await clickButton('Next');
  await waitFor(() => exists('.tile[data-id="s1"]'), 'stations');
  await click('.tile[data-id="s1"]');
  await waitFor(() => exists('[data-value="false"]'), 'full tank?');
  await click('[data-value="false"]');
  await waitFor(() => exists('[data-save]'), 'review');
  await click('[data-save]');
  await waitFor(() => exists('[data-result="sent"]'), 'bought saved');
  const cash = state.calls.filter((c) => c.channel === 'fuel:recordFill')[1].args;
  assert.deepEqual({ kind: cash.kind, assetId: cash.assetId, amount: cash.amountPaidMinor, currency: cash.currency, shown: cash.litresShownOnPump, station: cash.stationId, meter: cash.meterReading, full: cash.fullTank },
    { kind: 'cash_station', assetId: 'truck1', amount: 120000, currency: 'KHR', shown: 29.5, station: 's1', meter: 50000, full: false });
  assert.deepEqual(cash.photos.map((p) => p.kind), ['pump_display', 'meter']);
  assert.notEqual(cash.clientRef, fill.clientRef);
  await screenshot('6-bought-saved');
  result.checks.push({ name: 'bought-fuel-riel-station' });

  /* 5. Delivery arrived, with a dip before and after: two dips first, then the delivery linked to them */
  await clickButton('Done');
  await waitFor(() => exists('[data-flow="delivery"]'), 'home for delivery');
  await click('[data-flow="delivery"]');
  await waitFor(async () => /^Tank dip before/.test(await h1()), 'dip before photo (tank auto-picked)');
  await takePhoto();
  await keys(['1', '5', '0']);
  await clickButton('Next');
  await waitFor(async () => (await h1()) === 'Photograph the invoice', 'invoice photo');
  await takePhoto();
  await keys(['8', '0', '0']);
  await clickButton('Next');
  await waitFor(async () => (await h1()) === 'Photograph the truck', 'truck photo');
  await clickButton('No photo');
  await waitFor(async () => /^Tank dip after/.test(await h1()), 'dip after photo');
  await takePhoto();
  await keys(['1', '1', '0']);
  await clickButton('Next');
  await waitFor(() => exists('[data-save]'), 'delivery review');
  await click('[data-save]');
  await waitFor(() => exists('[data-result="sent"]'), 'delivery saved');
  const deliveryDips = state.calls.filter((c) => c.channel === 'fuel:recordDip').slice(-2).map((c) => c.args);
  assert.deepEqual(deliveryDips.map((a) => a.dipCm), [150, 110]);
  assert.notEqual(deliveryDips[0].clientRef, deliveryDips[1].clientRef);
  assert.deepEqual(deliveryDips.map((a) => a.photos.map((p) => p.kind)), [['stick'], ['stick']]);
  const del = state.calls.find((c) => c.channel === 'fuel:recordDelivery').args;
  assert.equal(del.litresInvoiced, 800);
  assert.deepEqual(del.photos.map((p) => p.kind), ['invoice']);
  assert.equal(del.dipBeforeId, state.saved.get(deliveryDips[0].clientRef).id);
  assert.equal(del.dipAfterId, state.saved.get(deliveryDips[1].clientRef).id);
  await screenshot('7-delivery-saved');
  result.checks.push({ name: 'delivery-with-linked-dips' });

  /* 6. A refused token sends the phone back to pairing */
  await js(`localStorage.setItem('mskh.fuel.token', 'revoked')`);
  win.webContents.reload();
  await waitFor(() => js(`!!document.querySelector('.notice--bad') && document.getElementById('barTitle').textContent === 'Connect this phone'`), 'connect screen after a refused token');
  result.checks.push({ name: 'refused-token-shows-pairing' });
  finish();
}).catch(finish);
