// Real Chromium + the built fuel phone page (/f); a loopback fixture server, not the app server.
// Run: node scripts/probe-fuel-phone.js   (launches the installed Electron; needs no app data)
//
// Drives: QR pairing (#t= token removed from the address bar) → Khmer home →
// "Give fuel" with real camera-file uploads (shrunk to 1600 px on the page) →
// a "Dip tank" whose answer is lost (kept in IndexedDB, survives a reload,
// resent with the SAME client_ref) → "I bought fuel" with riel → delivery, send to
// farm → HR1 with an attendance-only account (attendance.self + supervise): no fuel
// call at all, clock in with a selfie (front camera, server time), a clock-out whose
// answer is lost (kept, no time shown, resent with the same client_ref), a HELD
// entry, my attendance, a leave request, "I forgot to clock out", marking the crew.
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
  const timeout = setTimeout(() => { process.stderr.write('Fuel phone probe: 170-second deadline exceeded\n'); child.kill('SIGKILL'); }, 170_000);
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
const hardTimeout = setTimeout(() => finish(new Error('Probe exceeded 160-second deadline')), 160_000);
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
  let lastError = null;
  while (Date.now() < deadline) {
    // A read during a reload rejects ("Script failed to execute"); keep polling.
    let value = null;
    try { value = await read(); } catch (err) { lastError = err; }
    if (value) return value;
    await pause(40);
  }
  if (lastError) throw new Error(`Timed out: ${label} (last error: ${lastError.message})`);
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
const state = { calls: [], saved: new Map(), loseNextDip: false, n: 0, loseNextClock: false, extraQueuedMs: 0, events: [], leaveReqs: [] };
const TOKENS = {
  'probe-pump-token': { id: 'u-pump', name: 'Pump phone', role: 'pump', caps: ['fuel.record'] },
  // HR1: a staff phone that is also a crew supervisor — no fuel capability at all.
  'probe-staff-token': { id: 'u-staff', name: 'Sophal phone', role: 'staff', caps: ['attendance.self', 'attendance.supervise'] },
};
const ppTime = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(11, 16);
const ppDate = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);

function fixture() {
  server = http.createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const url = req.url.split('?')[0];
    if (url === '/f') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return; }
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const who = TOKENS[tok];
    if (!who) { json(401, { error: 'Invalid or missing token' }); return; }
    if (url === '/api/whoami') { json(200, { user: who }); return; }
    if (url !== '/api/rpc') { json(404, { error: 'Not found' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { channel, args } = JSON.parse(body);
      state.calls.push({ channel, args, token: tok });
      if (tok === 'probe-staff-token') { hrRpc(channel, args, json, req, res); return undefined; }
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
        case 'fuel:listLocations': return ok([
          { id: 'tank1', name: 'Warehouse tank', kind: 'tank', capacityL: 5000, hasFlowMeter: false, hasChart: true, status: 'active' },
          ...(state.withFarm ? [{ id: 'farm1', name: 'Farm store', kind: 'farm_store', capacityL: 1000, hasFlowMeter: false, hasChart: false, status: 'active' }] : []),
        ]);
        case 'staff:list': return ok([
          ...(state.withFarm ? [{ id: 'emp2', nameEn: 'Aaron', nameKm: 'អារុណ', staffCode: 'W01', isDriver: false, isFuelAttendant: false, status: 'active', hasPhoto: false }] : []),
          { id: 'emp1', nameEn: 'Sok', nameKm: 'សុខ', staffCode: 'D01', isDriver: true, isFuelAttendant: false, status: 'active', hasPhoto: false },
        ]);
        case 'fuel:recordTransfer': return ok(save('transfer', { fromLocationId: args.fromLocationId, toLocationId: args.toLocationId, litresSent: args.litresSent, carriedByEmployeeId: args.carriedByEmployeeId ?? null, sentAt: Date.now() }));
        case 'staff:me': return ok({ id: 'emp1', nameEn: 'Sok', nameKm: 'សុខ', isDriver: true, isFuelAttendant: true, status: 'active' });
        case 'fuel:listStations': return ok([{ id: 's1', name: 'Tela Kampong Speu', area: null, archived: false }]);
        case 'fuel:getChart': return ok(ULLAGE);
        case 'fuel:recordFill': {
          const litres = args.litres ?? (args.cansCount ? args.cansCount * args.canSizeL : args.litresShownOnPump);
          if (args.kind === 'cash_station') {
            const out = save('fill', { kind: args.kind, assetId: args.assetId, litres, meterReading: args.meterReading ?? null, fullTank: !!args.fullTank, amountPaidMinor: args.amountPaidMinor ?? null, currency: args.currency ?? null });
            return ok({ ...out, flags: [{ ruleKey: 'C1', severity: 'red', status: 'open', resolved: false, explanation: 'SECRET-EXPLANATION paid 4,068 riel per litre', measured: 4068 }] });
          }
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

/** The attendance account's server: like main/ipc/attendance.js — server time, client_ref, pending review. */
function hrRpc(channel, args, json, req, res) {
  const ok = (r) => json(200, { result: r });
  const totals = (d) => ({ daysWorked: d, lateMin: 25, lateDays: 2, missingOutDays: 1, absentDays: 0, leaveDays: 1 });
  const clock = (employeeId, kind, source) => {
    const dup = state.saved.has(args.clientRef);
    if (!dup) {
      const queuedForMs = (args.queuedForMs || 0) + state.extraQueuedMs;
      state.extraQueuedMs = 0;
      const ev = { id: `ev-${++state.n}`, employeeId, kind, at: Date.now() - queuedForMs, queuedForMs: queuedForMs || null, source, reviewStatus: 'pending', hasPhoto: !!args.photo };
      state.saved.set(args.clientRef, ev);
      if (source === 'phone') state.events.push(ev);
    }
    return { event: state.saved.get(args.clientRef), duplicate: dup, doubleTap: false };
  };
  switch (channel) {
    case 'companies:list': return ok([{ id: 'c1', name: 'Farm' }]);
    case 'companies:getActiveId': return ok('c1');
    case 'staff:me': return ok({ id: 'emp9', nameEn: 'Sophal', nameKm: 'សុផល', staffCode: 'P1', isDriver: false, isFuelAttendant: false, status: 'active' });
    case 'attendance:mine': {
      const last = state.events[state.events.length - 1] || null;
      return ok({
        employee: { id: 'emp9', nameEn: 'Sophal' }, today: null, lastEvent: last && { kind: last.kind, at: last.at, source: 'phone' },
        thisMonth: { month: '2026-10', totals: totals(12), days: [], lateness: { lateMin: 25, lateAfterReviewMin: null, earlyLeaveMin: 0, earlyLeaveAfterReviewMin: null, reviewed: false } },
        lastMonth: { month: '2026-09', totals: totals(24), days: [], lateness: { lateMin: 25, lateAfterReviewMin: 10, earlyLeaveMin: 0, earlyLeaveAfterReviewMin: 0, reviewed: true } },
        leave: [
          { leaveTypeId: 'lt1', code: 'annual', nameEn: 'Annual leave', nameKm: 'ច្បាប់ប្រចាំឆ្នាំ', paid: true, tracksBalance: true, balance: 7.5, takenThisYear: 3, pendingDays: 0 },
          { leaveTypeId: 'lt2', code: 'sick', nameEn: 'Sick leave', nameKm: 'ច្បាប់ឈឺ', paid: true, tracksBalance: false, balance: null, takenThisYear: 2, pendingDays: 0 },
        ],
        requests: { leave: state.leaveReqs, corrections: [] },
      });
    }
    case 'attendance:clockSelf': {
      if (!args.photo) return json(400, { error: 'Bad request: photo is required' });
      const last = state.events[state.events.length - 1];
      const out = clock('emp9', last && last.kind === 'in' ? 'out' : 'in', 'phone');
      if (state.loseNextClock) {
        // Saved, but the answer is cut off mid-body (as the lost dip above).
        state.loseNextClock = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"result":{"event":');
        setTimeout(() => req.socket.destroy(), 50);
        return undefined;
      }
      return ok(out);
    }
    case 'attendance:crew': return ok([
      { id: 'emp10', nameEn: 'Piseth', nameKm: 'ពិសិដ្ឋ', hasPhoto: true, photoSha256: 'abc', status: 'active', today: { status: 'future', firstIn: null, lastOut: null }, lastEvent: null },
      // The server never lists the caller; the page filters them out anyway.
      { id: 'emp9', nameEn: 'Sophal', nameKm: 'សុផល', hasPhoto: false, status: 'active', today: null, lastEvent: null },
    ]);
    case 'attendance:markCrew': return ok(clock(args.employeeId, args.kind, 'supervisor'));
    // A crew member's face (a supervisor may read their own crew's photos).
    case 'staff:getPhoto': return args.id === 'emp10' ? ok({ bytes: { __bin: true, b64: crewFace.toString('base64') }, mime: 'image/jpeg' }) : json(500, { error: 'You can only see the photos of your own crew' });
    // Requests are keyed by client_ref like the server: a resend is the saved one.
    case 'leave:requestSelf': {
      if (!state.saved.has(args.clientRef)) {
        const r = { id: `lr-${++state.n}`, employeeId: 'emp9', ...args, toDate: args.toDate || args.fromDate, days: args.halfDay ? 0.5 : 1, status: 'pending' };
        state.leaveReqs.push(r);
        state.saved.set(args.clientRef, r);
        return ok({ ...r, duplicate: false });
      }
      return ok({ ...state.saved.get(args.clientRef), duplicate: true });
    }
    case 'attendance:requestCorrectionSelf': {
      const dup = state.saved.has(args.clientRef);
      if (!dup) state.saved.set(args.clientRef, { id: `c-${++state.n}`, employeeId: 'emp9', workDate: args.workDate, status: 'pending', requestedVia: 'phone' });
      if (state.loseNextRequest) {
        state.loseNextRequest = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"result":{"id":');
        setTimeout(() => req.socket.destroy(), 50);
        return undefined;
      }
      return ok({ ...state.saved.get(args.clientRef), duplicate: dup });
    }
    default: return json(403, { error: `Not allowed: ${channel}` });
  }
}

let crewFace = null;

function decodeJpeg(b64) {
  const buf = Buffer.from(b64, 'base64');
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
  return { bytes: buf.length, ...nativeImage.createFromBuffer(buf).getSize() };
}

app.whenReady().then(async () => {
  photoFile = cameraJpeg();
  crewFace = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 180), { width: 64, height: 64 }).toJPEG(80);
  const base = await fixture();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const u = new URL(details.url);
    callback({ cancel: u.origin !== base && !['blob:', 'data:', 'devtools:'].includes(u.protocol) });
  });
  win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });

  /* 1. pairing from the QR link; the tank charts come with the lists */
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
  assert.ok(state.calls.some((c) => c.channel === 'fuel:getChart' && c.args === 'tank1'), 'charts prefetched for offline dips');
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
  assert.equal(await exists('[data-office-check]'), true, 'a neutral "the office will check" line');
  assert.equal(await js(`document.body.textContent.includes('SECRET-EXPLANATION') || document.body.textContent.includes('4,068')`), false, 'no flag details for the recorder');
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

  /* 6. Send to farm: "Who is taking it?" — drivers first; the pick travels and is confirmed */
  state.withFarm = true;
  win.webContents.reload();
  await waitFor(() => exists('[data-flow="send"]'), 'Send to farm on home once a farm store exists');
  await click('[data-flow="send"]');
  await waitFor(() => exists('.tile[data-id="emp1"]'), 'carrier tiles (tank and farm store auto-picked)');
  assert.equal(await h1(), 'Who is taking it?');
  const carriers = await js(`Array.from(document.querySelectorAll('.tile')).map((t) => t.dataset.id)`);
  assert.deepEqual(carriers, ['emp1', 'emp2', ''], 'the driver first, then others, then "Not known"');
  await click('.tile[data-id="emp1"]');
  await waitFor(() => exists('[data-value="litres"]'), 'how much');
  await click('[data-value="litres"]');
  await waitFor(() => exists('.key[data-key="2"]'), 'litres keypad');
  await keys(['2', '0', '0']);
  await clickButton('Next');
  await waitFor(async () => (await h1()) === 'How many containers?', 'containers');
  await clickButton('Skip');
  await waitFor(() => exists('input[type=file]'), 'containers photo');
  await takePhoto();
  await waitFor(() => exists('[data-save]'), 'send review');
  assert.match(await js(`document.querySelector('.facts').textContent`), /Taken bySok/);
  await click('[data-save]');
  await waitFor(() => exists('[data-result="sent"]'), 'send saved');
  const tr = state.calls.find((c) => c.channel === 'fuel:recordTransfer').args;
  assert.deepEqual({ from: tr.fromLocationId, to: tr.toLocationId, litres: tr.litresSent, carried: tr.carriedByEmployeeId },
    { from: 'tank1', to: 'farm1', litres: 200, carried: 'emp1' });
  assert.match(await js(`document.querySelector('.facts').textContent`), /Taken bySok/, 'confirmed from the server answer');
  await screenshot('8-send-carrier');
  result.checks.push({ name: 'send-to-farm-carrier' });

  /* 7. HR1 — an attendance-only account (clock-in + crew, no fuel capability) */
  const fuelCallsBefore = state.calls.length;
  await js(`localStorage.setItem('mskh.fuel.token', 'probe-staff-token')`);
  win.webContents.reload();
  await waitFor(() => exists('[data-flow="clock"]'), 'attendance home');
  const hrHome = await js(`({ title: document.getElementById('barTitle').textContent, tiles: Array.from(document.querySelectorAll('[data-flow]')).map(b => b.dataset.flow),
    clock: document.querySelector('[data-flow="clock"]').textContent })`);
  assert.equal(hrHome.title, 'Attendance');
  assert.deepEqual(hrHome.tiles, ['clock', 'mine', 'leave', 'forgot', 'crew'], 'no fuel tiles, no fuel records');
  assert.match(hrHome.clock, /^Clock in/);
  const staffCalls = () => state.calls.slice(fuelCallsBefore).filter((c) => c.token === 'probe-staff-token');
  assert.deepEqual(staffCalls().filter((c) => /^fuel:|^staff:list$/.test(c.channel)), [], 'an attendance-only phone calls no fuel channel');
  await screenshot('9-attendance-home');

  // Clock in: the FRONT camera, no "No photo", the server's time on the result.
  await click('[data-flow="clock"]');
  await waitFor(async () => (await h1()) === 'Take a selfie (front camera)', 'selfie step');
  assert.equal(await js(`document.querySelector('input[type=file]').getAttribute('capture')`), 'user');
  assert.equal(await js(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'No photo')`), false, 'a clock-in needs its selfie');
  await takePhoto();
  await waitFor(() => exists('[data-save]'), 'clock review');
  assert.equal(await js(`document.querySelector('[data-save]').textContent`), 'Clock in');
  await click('[data-save]');
  await waitFor(() => exists('[data-result="sent"]'), 'clocked in');
  const clockIn = staffCalls().filter((c) => c.channel === 'attendance:clockSelf')[0].args;
  assert.deepEqual(Object.keys(clockIn).sort(), ['clientRef', 'photo', 'queuedForMs'], 'no time, no source, one photo');
  const selfie = decodeJpeg(clockIn.photo.b64);
  assert.equal(Math.max(selfie.width, selfie.height), 1600);
  const inAt = state.saved.get(clockIn.clientRef).at;
  assert.equal(await js(`document.querySelector('[data-result="sent"] b').textContent`), `Clocked in ${ppTime(inAt)}`);
  assert.equal(await exists('[data-held]'), false);
  await screenshot('10-clocked-in');
  await clickButton('Done');
  await waitFor(async () => /^Clock out/.test(await js(`(document.querySelector('[data-flow="clock"]') || {}).textContent || ''`)), 'the tile now says Clock out');
  assert.match(await js(`document.querySelector('[data-flow="clock"]').textContent`), new RegExp(`In since ${ppTime(inAt)}`));
  result.checks.push({ name: 'attendance-only-home-and-clock-in', at: ppTime(inAt) });

  // Clock out, answer lost: kept on the phone, NO time shown, resent after a reload with the same client_ref.
  await click('[data-flow="clock"]');
  await waitFor(() => exists('input[type=file]'), 'selfie step (out)');
  await takePhoto();
  await waitFor(() => exists('[data-save]'), 'clock-out review');
  state.loseNextClock = true;
  await click('[data-save]');
  await waitFor(() => exists('[data-result="queued"]'), 'clock-out kept on the phone', 20_000);
  assert.equal(await exists('[data-queued-clock]'), true, '"checked by the office if it is late"');
  assert.doesNotMatch(await js(`document.querySelector('main').textContent`), /\d\d:\d\d/, 'no time the phone made up');
  await screenshot('11-clock-out-queued');
  const outRef = staffCalls().filter((c) => c.channel === 'attendance:clockSelf')[1].args.clientRef;
  win.webContents.reload();
  await waitFor(() => staffCalls().filter((c) => c.channel === 'attendance:clockSelf').length === 3, 'clock-out resent after reload', 20_000);
  const resent = staffCalls().filter((c) => c.channel === 'attendance:clockSelf')[2].args;
  assert.equal(resent.clientRef, outRef, 'the same client_ref');
  assert.equal(resent.photo.b64, staffCalls().filter((c) => c.channel === 'attendance:clockSelf')[1].args.photo.b64, 'the same selfie, kept in IndexedDB');
  assert.ok(resent.queuedForMs >= 1000, `waited ${resent.queuedForMs} ms`);
  assert.equal(state.events.length, 2, 'one in, one out — no duplicate');
  await waitFor(() => js(`document.getElementById('outboxChip').hidden`), 'chip clears');
  await waitFor(async () => /^Clock in/.test(await js(`(document.querySelector('[data-flow="clock"]') || {}).textContent || ''`)), 'tile back to Clock in');
  result.checks.push({ name: 'clock-out-lost-answer-same-client-ref', waitedMs: resent.queuedForMs });

  // A clock-in the server says waited 20 minutes: HELD — the office checks it first.
  state.extraQueuedMs = 20 * 60 * 1000;
  await click('[data-flow="clock"]');
  await waitFor(() => exists('input[type=file]'), 'selfie step (held)');
  await takePhoto();
  await waitFor(() => exists('[data-save]'), 'held review');
  await click('[data-save]');
  await waitFor(() => exists('[data-held]'), 'held note');
  await screenshot('12-held');
  await clickButton('Done');
  result.checks.push({ name: 'held-entry-explained' });

  // My attendance: this month's figures and leave balances.
  await waitFor(() => exists('[data-flow="mine"]'), 'home (mine)');
  await click('[data-flow="mine"]');
  await waitFor(() => exists('[data-month="this_month"]'), 'my attendance');
  const mineText = await js(`({ month: document.querySelector('[data-month="this_month"]').textContent, last: document.querySelector('[data-month="last_month"]').textContent, leave: document.querySelector('[data-leave]').textContent })`);
  assert.match(mineText.month, /Days worked12/);
  assert.match(mineText.month, /Late25 min \(not reviewed yet\)/);
  assert.match(mineText.last, /Late25 min \(10 min after review\)/);
  assert.match(mineText.month, /Missing clock-outs1/);
  assert.match(mineText.leave, /Annual leave7\.5 days left/);
  assert.match(mineText.leave, /Sick leave2 days taken this year/);
  await screenshot('13-my-attendance');
  result.checks.push({ name: 'my-attendance' });

  // Request leave: annual, today only, morning, no reason.
  await click('#backBtn');
  await waitFor(() => exists('[data-flow="leave"]'), 'home (leave)');
  await click('[data-flow="leave"]');
  await waitFor(() => exists('.tile[data-id="lt1"]'), 'leave types');
  await click('.tile[data-id="lt1"]');
  await waitFor(() => exists('input[type=date]'), 'first day');
  assert.equal(await js(`document.querySelector('input[type=date]').value`), ppDate(Date.now()));
  await clickButton('Next');
  await waitFor(() => exists('[data-same]'), 'last day');
  await click('[data-same]');
  await waitFor(() => exists('[data-value="am"]'), 'half day?');
  await click('[data-value="am"]');
  await waitFor(async () => (await h1()) === 'Reason (if you want)', 'reason');
  await clickButton('Skip');
  await waitFor(() => exists('[data-save]'), 'leave review');
  await click('[data-save]');
  await waitFor(() => exists('[data-result="sent"]'), 'leave sent');
  const { clientRef: leaveRef, ...leaveArgs } = staffCalls().find((c) => c.channel === 'leave:requestSelf').args;
  assert.deepEqual(leaveArgs, { leaveTypeId: 'lt1', fromDate: ppDate(Date.now()), halfDay: 'am' }, 'no time, no source, no wait');
  assert.match(leaveRef, /^f:[0-9a-f]{8}:[0-9a-f-]{36}$/, 'through the outbox, with a client_ref');
  assert.match(await js(`document.querySelector('main').textContent`), /Sent to the office/);
  await clickButton('Done');
  result.checks.push({ name: 'leave-request' });

  // I forgot to clock out yesterday: 17:05, "I forgot".
  await waitFor(() => exists('[data-flow="forgot"]'), 'home (forgot)');
  await click('[data-flow="forgot"]');
  const yesterday = new Date(Date.parse(ppDate(Date.now()) + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
  await waitFor(() => exists(`.tile[data-id="${yesterday}"]`), 'which day');
  await click(`.tile[data-id="${yesterday}"]`);
  await waitFor(() => exists('[data-value="out"]'), 'what was forgotten');
  await click('[data-value="out"]');
  await waitFor(async () => (await h1()) === 'What time did you finish work?', 'out time');
  await keys(['1', '7', '0', '5']);
  assert.equal(await js(`document.querySelector('[data-readout]').textContent`), '17:05');
  await clickButton('Next');
  await waitFor(() => exists('.tile[data-id="reason_forgot"]'), 'reasons');
  await click('.tile[data-id="reason_forgot"]');
  await waitFor(() => exists('[data-save]'), 'forgot review');
  // The answer is lost: the request stays on the phone and goes again with the same client_ref.
  state.loseNextRequest = true;
  await click('[data-save]');
  await waitFor(() => exists('[data-result="queued"]'), 'request kept on the phone', 20_000);
  assert.equal(await exists('[data-queued-clock]'), false, 'the clock-in note is for clock-ins only');
  win.webContents.reload();
  await waitFor(() => staffCalls().filter((c) => c.channel === 'attendance:requestCorrectionSelf').length === 2, 'request resent after reload', 20_000);
  const fixes = staffCalls().filter((c) => c.channel === 'attendance:requestCorrectionSelf').map((c) => c.args);
  assert.equal(fixes[1].clientRef, fixes[0].clientRef, 'the same client_ref');
  const { clientRef: fixRef, ...fixArgs } = fixes[1];
  assert.ok(fixRef);
  assert.deepEqual(fixArgs, { workDate: yesterday, reason: 'I forgot', outTime: '17:05' });
  await waitFor(() => js(`document.getElementById('outboxChip').hidden`), 'chip clears after the resend');
  result.checks.push({ name: 'forgot-to-clock-out' });

  // My crew: never myself; mark Piseth in without a photo.
  await waitFor(() => exists('[data-flow="crew"]'), 'home (crew)');
  await click('[data-flow="crew"]');
  await waitFor(() => exists('.tile[data-id="emp10"]'), 'crew list');
  assert.equal(await exists('.tile[data-id="emp9"]'), false, 'never yourself');
  await waitFor(() => exists('.tile[data-id="emp10"] img'), 'the crew member\'s face');
  assert.match(await js(`document.querySelector('.tile[data-id="emp10"]').textContent`), /Not in yet/);
  await click('.tile[data-id="emp10"]');
  await waitFor(() => exists('[data-value="in"]'), 'mark in or out');
  assert.equal(await h1(), 'Mark Piseth');
  await click('[data-value="in"]');
  await waitFor(async () => (await h1()) === 'Photograph the person (if you can)', 'optional photo');
  await clickButton('No photo');
  await waitFor(() => exists('[data-save]'), 'mark review');
  await click('[data-save]');
  await waitFor(() => exists('[data-result="sent"]'), 'marked');
  const mark = staffCalls().find((c) => c.channel === 'attendance:markCrew').args;
  assert.deepEqual({ employeeId: mark.employeeId, kind: mark.kind, photo: mark.photo, at: mark.at }, { employeeId: 'emp10', kind: 'in', photo: undefined, at: undefined });
  assert.match(mark.clientRef, /^f:[0-9a-f]{8}:[0-9a-f-]{36}$/);
  assert.equal(await js(`document.querySelector('[data-result="sent"] b').textContent`), `Piseth in at ${ppTime(state.saved.get(mark.clientRef).at)}`);
  await screenshot('14-crew-marked');
  await clickButton('My crew');
  await waitFor(() => exists('.tile[data-id="emp10"]'), 'back to the crew');
  assert.deepEqual(staffCalls().filter((c) => /^fuel:|^staff:list$/.test(c.channel)), [], 'still no fuel call');
  assert.deepEqual([...new Set(staffCalls().filter((c) => c.channel === 'staff:getPhoto').map((c) => c.args.id))], ['emp10'], 'photos of the crew only');
  result.checks.push({ name: 'crew-mark-in' });

  /* 8. A refused token sends the phone back to pairing */
  await js(`localStorage.setItem('mskh.fuel.token', 'revoked')`);
  win.webContents.reload();
  await waitFor(() => js(`!!document.querySelector('.notice--bad') && document.getElementById('barTitle').textContent === 'Connect this phone'`), 'connect screen after a refused token');
  assert.equal(await js(`document.querySelector('.notice--bad').textContent`), 'The Mac did not accept this account. Scan the QR code again.');
  result.checks.push({ name: 'refused-token-shows-pairing' });
  finish();
}).catch(finish);
