#!/usr/bin/env node
/**
 * Changed HR2 screens ONLY, against an already-built reviewed integration:
 * node scripts/probe-hr2-ui.js --repo /path/to/hr2-payroll [--preflight]
 *
 * Never attaches to an existing port/profile. Seeds and launches its own
 * marked OS-temp profile, binds CDP to loopback, and retains all evidence.
 * No build, copy of node_modules, GDT request, webcam, upload or cleanup.
 * The temporary preload delegates to the ACTUAL compiled preload functions.
 * Controlled response delays/loss and one fictional FX proposal are scoped
 * and reset after each case. Workbook/PDF dialogs are one-shot, exact matches
 * confined to the marked fixture; parsing and PDF rendering use real handlers.
 * Capability cases simulate renderer roles only;
 * they do not claim RPC authorization coverage (hr2Transport owns that).
 */
/* global document, window, HTMLSelectElement, HTMLTextAreaElement, HTMLInputElement */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { createDisposable, verifyDisposable } = require('./seed-hr2');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CASE_IDS = ['screen-payroll', 'screen-staff-pay', 'screen-loans', 'screen-settings', 'draft-review', 'statutory-leave', 'run-pdf',
  'company-race', 'run-race', 'employee-race', 'loan-retry', 'opening-import', 'manual-fx', 'settings-race', 'kiosk', 'roles'];

function parseArgs(args) {
  const options = { repo: path.resolve(__dirname, '..'), preflight: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) options.repo = path.resolve(args[++i]);
    else if (args[i] === '--preflight') options.preflight = true;
    else if (['--only', '--skip'].includes(args[i]) && args[i + 1]) {
      const key = args[i].slice(2), ids = args[++i].split(',');
      if (ids.some(id => !CASE_IDS.includes(id))) throw new Error(`Unknown case ID; choose from ${CASE_IDS.join(',')}`);
      options[key] = [...new Set([...(options[key] || []), ...ids])];
    }
    else if (args[i] === '--list') options.list = true;
    else if (args[i] === '--help') options.help = true;
    else throw new Error(`Unknown option: ${args[i]}; this probe owns its port/profile`);
  }
  options.selectedCases = CASE_IDS.filter(id => (!options.only || options.only.includes(id)) && !options.skip?.includes(id));
  if (!options.selectedCases.length) throw new Error('No cases selected');
  return options;
}

function preflight(repo) {
  const required = ['main/db/payroll.js', 'main/db/payrollConfig.js', 'main/db/employeeLoans.js', 'main/ipc/payroll.js', 'main/ipc/loans.js',
    'main/db/loanImports.js', 'main/ipc/files.js', 'main/fileHandler.js', 'main/util/payrollDocuments.js',
    'renderer/modules/People/PayrollModals.jsx', 'renderer/modules/People/LoansImportModal.jsx', 'renderer/modules/People/loanImportModel.js',
    'renderer/modules/People/Payroll.jsx', 'renderer/modules/People/PayrollStaffPay.jsx', 'renderer/modules/People/Loans.jsx', 'renderer/modules/People/PayrollSettings.jsx',
    'renderer/modules/Kiosk/KioskPayroll.jsx', 'dist-electron/main/index.js', 'dist-electron/preload/preload.js', 'dist-renderer/index.html', 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'];
  const missing = required.filter(file => !fs.existsSync(path.join(repo, file)));
  const stale = [];
  for (const [artifact, prefix] of [['dist-electron/main/index.js', 'main/'], ['dist-renderer/index.html', 'renderer/']]) {
    if (!missing.includes(artifact)) for (const file of required.filter(p => p.startsWith(prefix) && !missing.includes(p))) {
      if (fs.statSync(path.join(repo, file)).mtimeMs > fs.statSync(path.join(repo, artifact)).mtimeMs) stale.push(file);
    }
  }
  return { repo, ready: !missing.length && !stale.length, missing, stale, runtimeVerified: false };
}

// Loaded only in the disposable app's preload realm, before exposing the real
// API. The frozen contextBridge object is never monkey-patched in the page.
function preloadHarness(originalPreload) {
  const Module = require('node:module');
  const electron = require('electron');
  const context = electron.ipcRenderer.sendSync('hr2-probe:context');
  const rules = [], holds = new Map(), calls = [];
  let proposal = null, originalApi = null, seq = 0;
  const originalLoad = Module._load;
  const connection = { status: 'connected', user: { id: 'synthetic-ui-role', name: 'Synthetic renderer role', caps: context.uiCaps }, serverVersion: 'probe', wsOpenCount: 1 };
  const expose = (name, api) => {
    if (name !== 'api') return electron.contextBridge.exposeInMainWorld(name, api);
    originalApi = api;
    const wrapped = { ...api };
    for (const domain of ['payroll', 'loans', 'kiosk', 'files']) {
      if (!api[domain]) continue;
      wrapped[domain] = Object.fromEntries(Object.entries(api[domain]).map(([method, original]) => [method, typeof original !== 'function' ? original : async (...args) => {
        const input = args[0] || {};
        const call = { seq: ++seq, domain, method, args, status: 'started' }; calls.push(call);
        const rule = rules.find(r => !r.used && r.domain === domain && r.method === method && Object.entries(r.match || {}).every(([key, value]) => input[key] === value));
        if (rule) rule.used = true;
        try {
          if (domain === 'files' && method === 'parseWorkbook' && args[0] !== context.workbook) throw new Error('Only the marked synthetic workbook may be parsed');
          const result = domain === 'payroll' && method === 'fetchSalaryTaxRate' && proposal ? { ...proposal } : await original(...args);
          if (domain === 'kiosk' && ['signIn', 'me'].includes(method)) call.employeeContext = { id: result?.employee?.id, companyId: result?.employee?.companyId };
          call.resultId = result?.id || null; call.status = 'received';
          if (rule?.mode === 'hold') { call.status = 'held'; await new Promise(resolve => holds.set(call.seq, resolve)); }
          if (rule?.mode === 'lost') { call.status = 'lost'; throw new Error('Synthetic response lost after durable write; timeout'); }
          call.status = 'returned'; return result;
        } catch (error) { call.error = error.message; if (call.status !== 'lost') call.status = 'rejected'; throw error; }
      }]));
    }
    if (context.uiCaps) {
      // UI gating experiment only: main remains standalone and real handlers run.
      wrapped.settings = { ...api.settings, getAll: async () => ({ ...await api.settings.getAll(), mode: 'client' }) };
      wrapped.client = { ...api.client, connectionState: async () => connection };
    }
    electron.contextBridge.exposeInMainWorld(name, wrapped);
  };
  electron.contextBridge.exposeInMainWorld('__hr2', {
    profile: async () => ({ ...context, actualConfig: await originalApi.settings.getAll() }),
    inject: rule => { if (!['hold', 'lost'].includes(rule.mode) || !['payroll', 'loans', 'kiosk'].includes(rule.domain)) throw new Error('Unsupported scoped injection'); rules.push({ ...rule, used: false }); },
    release: () => { for (const resolve of holds.values()) resolve(); holds.clear(); },
    reset: async () => { for (const resolve of holds.values()) resolve(); holds.clear(); rules.length = 0; proposal = null; await electron.ipcRenderer.invoke('hr2-probe:dialog', null); },
    calls: () => calls.map(call => ({ ...call })),
    proposal: value => { proposal = value; },
    uiRole: caps => electron.ipcRenderer.invoke('hr2-probe:ui-role', caps),
    dialog: kind => electron.ipcRenderer.invoke('hr2-probe:dialog', kind),
  });
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ...electron, contextBridge: { ...electron.contextBridge, exposeInMainWorld: expose } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { require(originalPreload); } finally { Module._load = originalLoad; }
}

// Temporary entrypoint executes the original built app, with only its preload
// location replaced. Same security options; no production source/bundle edits.
function launchHarness({ repo, root, markerId, port, preload, pdfFilename }) {
  const Module = require('node:module');
  const electron = require('electron');
  const path = require('node:path');
  const fs = require('node:fs');
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.hr2-disposable.json'), 'utf8'));
  if (marker.markerId !== markerId || marker.root !== fs.realpathSync(root)) throw new Error('Wrong disposable launch marker');
  electron.app.setPath('userData', path.join(root, 'userdata'));
  electron.app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  electron.app.commandLine.appendSwitch('remote-debugging-port', String(port));
  const workbook = path.join(root, 'opening-loans.xlsx'), pdf = path.join(root, 'payroll-run.pdf');
  let uiCaps = null, armedDialog = null;
  electron.ipcMain.on('hr2-probe:context', event => { event.returnValue = { root, markerId, workbook, userDataDir: electron.app.getPath('userData'), uiCaps }; });
  electron.ipcMain.handle('hr2-probe:ui-role', (_event, caps) => { if (caps !== null && (!Array.isArray(caps) || caps.some(x => typeof x !== 'string'))) throw new Error('Invalid synthetic caps'); uiCaps = caps; });
  electron.ipcMain.handle('hr2-probe:dialog', (_event, kind) => {
    if (![null, 'openingLoans', 'runPdf'].includes(kind)) throw new Error('Unsupported synthetic dialog');
    if (kind && armedDialog) throw new Error('A synthetic dialog is already armed');
    armedDialog = kind;
  });
  const scopedDialog = (kind, args) => {
    const options = args.at(-1), expected = armedDialog; armedDialog = null;
    const bound = JSON.parse(fs.readFileSync(path.join(root, '.hr2-disposable.json'), 'utf8'));
    if (bound.markerId !== markerId || bound.root !== fs.realpathSync(root)) throw new Error('Disposable dialog marker changed');
    if (kind === 'open' && expected === 'openingLoans' && JSON.stringify(options) === JSON.stringify({
      properties: ['openFile'], filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv', 'tsv'] }],
    })) {
      if (fs.lstatSync(workbook).isSymbolicLink() || fs.realpathSync(workbook) !== path.join(bound.root, 'opening-loans.xlsx')) throw new Error('Synthetic workbook escaped its marker');
      return { canceled: false, filePaths: [workbook] };
    }
    if (kind === 'save' && expected === 'runPdf' && options?.title === 'Save payroll run' && options.defaultPath === pdfFilename
      && JSON.stringify(options.filters) === JSON.stringify([{ name: 'PDF', extensions: ['pdf'] }])) {
      if (fs.existsSync(pdf)) throw new Error('Synthetic PDF output already exists');
      return { canceled: false, filePath: pdf };
    }
    throw new Error('Unarmed or unexpected native file dialog refused by HR2 probe');
  };
  const dialog = { ...electron.dialog, showOpenDialog: async (...args) => scopedDialog('open', args), showSaveDialog: async (...args) => scopedDialog('save', args),
    showOpenDialogSync: () => { throw new Error('Native file dialog refused by HR2 probe'); }, showSaveDialogSync: () => { throw new Error('Native file dialog refused by HR2 probe'); } };
  class ProbeWindow extends electron.BrowserWindow {
    constructor(options) {
      // The real offscreen PDF window has no preload and stays sandboxed.
      super({ ...options, webPreferences: { ...options.webPreferences, ...(options.webPreferences?.preload ? { preload } : {}) } });
      this.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.webContents.session.setPermissionCheckHandler(() => false);
      this.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const allowed = ['file:', 'data:', 'blob:', 'app-image:', 'devtools:'].includes(url.protocol) || url.protocol === 'app:' && url.hostname === 'local' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
        callback({ cancel: !allowed });
      });
    }
  }
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ...electron, BrowserWindow: ProbeWindow, dialog };
    return originalLoad.call(this, request, parent, isMain);
  };
  require(path.join(repo, 'dist-electron/main/index.js'));
}

function runChild(binary, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, options);
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Seed exit ${code}: ${output.slice(-6000)}`)));
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connect(port, child) {
  const deadline = Date.now() + 30000;
  let target;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Disposable app exited ${child.exitCode} before CDP`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      target = list.find(t => t.type === 'page' && (t.url.startsWith('file:') || t.url === 'app://local/index.html') && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* the spawned app is still booting */ }
    await delay(100);
  }
  if (!target) throw new Error('No built renderer target on owned loopback port');
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  if (wsUrl.hostname !== '127.0.0.1' && wsUrl.hostname !== 'localhost') throw new Error('Non-loopback CDP refused');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map(), events = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer); pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`)); else waiter.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') events.push(message);
  });
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Owned CDP target closed')); } pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer, method }); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  return { send, events, close: () => ws.close() };
}

// A small version of probe-ui-crawl's native-setter/Field patterns. All clicks
// use rendered controls; no store imports, private React state or fake screen.
function toolkit() {
  const all = selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const find = (selector, label) => label === '' ? all(selector)[0] : all(selector).find(el => text(el) === label || text(el).startsWith(`${label}\n`) || text(el).startsWith(`${label} `));
  const set = (el, value) => {
    if (!el || el.disabled) throw new Error('Missing or disabled field');
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  window.__hr2Ui = {
    text, all,
    click: (label, selector = 'button') => { const el = find(selector, label); if (!el || el.disabled) throw new Error(`Missing or disabled ${label}`); el.click(); },
    field: (label, value, scope = document.querySelector('[role="dialog"]') || document) => {
      const container = [...scope.querySelectorAll('.field, .setting-row')].find(el => {
        const heading = el.querySelector('.field__label, .setting-row__label');
        const ownLabel = heading?.querySelector('label, strong') || heading;
        return text(ownLabel).replace(/\s*\*$/, '').split('\n')[0] === label;
      });
      const control = container?.querySelector('input, select, textarea') || [...scope.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === label);
      set(control, value);
    },
    input: (selector, value) => set(document.querySelector(selector), value),
    body: () => document.body.innerText,
  };
}

async function main(options) {
  const ready = preflight(options.repo);
  if (options.preflight || !ready.ready) { console.log(JSON.stringify({ event: 'preflight', ...ready })); return ready.ready ? 0 : 2; }
  const disposable = createDisposable();
  const { root, markerId } = disposable;
  const report = { repo: options.repo, root, markerId, synthetic: true, runtimeVerified: false, selectedCasesVerified: false,
    selectedCases: options.selectedCases, skippedCases: CASE_IDS.filter(id => !options.selectedCases.includes(id)),
    results: [], screenshots: [], consoleErrors: [], limits: ['Renderer cap simulation is not RPC permission proof.', 'No real webcam, physical Mac client, legal-rate validation or external GDT request.'] };
  const shots = path.join(root, 'shots'); fs.mkdirSync(shots);
  console.log(JSON.stringify({ event: 'probe-start', root }));
  let child, cdp;
  try {
    const binary = path.join(options.repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    const seedOutput = await runChild(binary, [path.join(__dirname, 'seed-hr2.js'), '--repo', options.repo, '--synthetic-confirmation'], { cwd: options.repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Seeder owns a fresh root as well; launch ONLY that verified root. The
    // result root above contains the report, while fixture profile is separate.
    const seeded = seedOutput.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(row => row.event === 'truth-ready');
    if (!seeded?.ok) throw new Error(`Seeder did not produce verified truth: ${seedOutput.slice(-2000)}`);
    const truth = JSON.parse(fs.readFileSync(path.join(seeded.root, 'hr2-truth.json'), 'utf8'));
    verifyDisposable(truth.root, truth.markerId, { seeded: true });
    report.fixtureRoot = truth.root; report.expected = truth.expected;
    const openingRows = [
      { loanNo: 'SYNTH-OPEN-USD', staffCode: 'M-USD', originalPrincipalMinor: 50000, currentPrincipalMinor: 20000, unpaidInterestMinor: 500,
        currency: 'USD', installmentMinor: 5000 },
      { loanNo: 'SYNTH-OPEN-KHR', staffCode: 'D-KHR', originalPrincipalMinor: 800000, currentPrincipalMinor: 300000, unpaidInterestMinor: 7500,
        currency: 'KHR', installmentMinor: 50000 },
    ].map((row, i) => ({ ...row, balanceAsOf: '2026-05-31', disbursedOn: '2026-01-01', interestMethod: 'declining', interestPolicy: 'separate',
      ratePercent: 2, interestFreeMonths: 0, deductViaPayroll: false, purpose: 'FICTIONAL opening balance probe', rowNo: i + 2 }));
    const XLSX = require(path.join(options.repo, 'node_modules/xlsx'));
    const workbook = XLSX.utils.book_new(), keys = Object.keys(openingRows[0]).filter(key => key !== 'rowNo');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      keys.map(key => key === 'loanNo' ? 'Synthetic reference' : key), ...openingRows.map(row => keys.map(key => row[key])),
    ]), 'Loans');
    const workbookPath = path.join(truth.root, 'opening-loans.xlsx'), pdfPath = path.join(truth.root, 'payroll-run.pdf');
    fs.writeFileSync(workbookPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { flag: 'wx', mode: 0o600 });
    report.supplemental = { workbook: workbookPath, openingRows, pdf: pdfPath };
    report.limits.push('Run PDF checks real export completion and PDF bytes; page count, text and visual pagination need independent inspection.');
    const port = await freePort();
    const preload = path.join(root, 'preload.cjs'), launcher = path.join(root, 'launch.cjs');
    fs.writeFileSync(preload, `(${preloadHarness.toString()})(${JSON.stringify(path.join(options.repo, 'dist-electron/preload/preload.js'))});`, { flag: 'wx' });
    fs.writeFileSync(launcher, `(${launchHarness.toString()})(${JSON.stringify({ repo: options.repo, root: truth.root, markerId: truth.markerId, port, preload, pdfFilename: `payroll-2026-09-${truth.runs.monthly}.pdf` })});`, { flag: 'wx' });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const log = fs.openSync(path.join(root, 'app.log'), 'wx');
    child = spawn(binary, [launcher], { cwd: options.repo, env, stdio: ['ignore', log, log] }); fs.closeSync(log);
    child.on('error', error => { report.launchError = error.message; });
    cdp = await connect(port, child);
    const evaluate = async expression => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    const wait = async (expression, label = expression) => {
      const end = Date.now() + 12000;
      while (Date.now() < end) { if (await evaluate(expression)) return; await delay(100); }
      throw new Error(`Timed out: ${label}`);
    };
    await wait('!!window.__hr2 && !!window.api && !!document.querySelector(".home-tile")', 'app bootstrap');
    const profile = await evaluate('window.__hr2.profile()');
    assert.equal(profile.markerId, truth.markerId); assert.equal(profile.userDataDir, truth.userDataDir); assert.equal(profile.actualConfig.dataDir, truth.dataDir);
    await evaluate(`(${toolkit.toString()})()`);
    const click = (label, selector = 'button') => evaluate(`__hr2Ui.click(${JSON.stringify(label)}, ${JSON.stringify(selector)})`);
    const field = (label, value) => evaluate(`__hr2Ui.field(${JSON.stringify(label)}, ${JSON.stringify(value)})`);
    const api = (domain, method, input) => evaluate(`window.api[${JSON.stringify(domain)}][${JSON.stringify(method)}](${JSON.stringify(input)})`);
    const calls = () => evaluate('window.__hr2.calls()');
    const inject = rule => evaluate(`__hr2.inject(${JSON.stringify(rule)})`);
    const reset = () => evaluate('__hr2.reset()');
    const release = () => evaluate('__hr2.release()');
    const body = () => evaluate('__hr2Ui.body()');
    let currentCase;
    const shot = async name => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(shots, `${name}.png`); fs.writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' }); report.screenshots.push(file);
      const geometry = await evaluate(`({ width: innerWidth, height: innerHeight, documentOverflow: document.documentElement.scrollWidth > innerWidth + 2,
        boundary: !!document.querySelector('.page__error'), invalidMoney: /\\$NaN|undefined USD|NaN KHR/.test(document.body.innerText),
        clippedActions: [...document.querySelectorAll('.page__header button, [role="dialog"] button')].filter(el => { const r=el.getBoundingClientRect(); return el.getClientRects().length && (r.right > innerWidth+2 || r.left < -2); }).map(el => el.innerText) })`);
      report.results.push({ caseId: currentCase, name: `layout:${name}`, ...geometry, ok: !geometry.documentOverflow && !geometry.boundary && !geometry.invalidMoney && !geometry.clippedActions.length });
    };
    const bothSizes = async name => {
      for (const [width, height] of [[1280, 800], [1440, 900]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
        await shot(`${name}-${width}x${height}`);
      }
    };
    const page = async name => {
      if (await evaluate(`!!document.querySelector('.kiosk-preview-page')`)) await click('Close preview');
      await click('Home', '.sidebar button'); await wait('!!document.querySelector(".home-tile")');
      await click('People', '.home-tile');
      await wait(`!!document.querySelector('.sidebar__section[data-module="people"]')`, 'People sidebar');
      if (name !== 'Settings') await click(name, '.sidebar button'); else await click('Settings', '.sidebar button');
      await wait(`document.querySelector('.page__title')?.textContent.trim() === ${JSON.stringify(name)} && !document.body.innerText.includes('Loading ${name.toLowerCase()}…')`, name);
    };
    const settings = async () => { await page('Settings'); await click('Payroll', '.settings-tab'); await wait('!!document.querySelector(".payroll-settings .setting-row")'); };
    const selectCompany = async key => { await click('', '.company-switcher__button'); await click(`Synthetic HR2 ${key.toUpperCase()}`, '.company-switcher__option'); };
    const companySelected = key => `document.querySelector('.company-switcher__name')?.innerText === 'Synthetic HR2 ${key.toUpperCase()}'`;
    const swapCompany = async key => { await selectCompany(key); await wait(companySelected(key)); };
    const openRun = async id => {
      const run = await api('payroll', 'get', { companyId: truth.companies.a, id });
      await field('Month', run.month);
      const list = await api('payroll', 'list', { companyId: truth.companies.a, month: run.month });
      const index = list.findIndex(x => x.id === id); assert.ok(index >= 0);
      await wait(`__hr2Ui.all('.data-table tbody tr').length === ${list.length}`);
      await evaluate(`__hr2Ui.all('.data-table tbody tr')[${index}].querySelector('button').click()`);
      await wait(`__hr2Ui.body().includes('Payroll run')`);
    };
    const step = async (caseId, name, work) => {
      if (!options.selectedCases.includes(caseId)) return;
      currentCase = caseId;
      try { await work(); report.results.push({ caseId, name, ok: true }); console.log(JSON.stringify({ caseId, name, ok: true })); }
      catch (error) {
        const failure = { caseId, name, ok: false, error: error.stack || error.message };
        report.results.push(failure); console.error(JSON.stringify({ caseId, name, ok: false, error: error.message }));
        try {
          failure.screenText = await body();
          failure.apiCalls = (await calls()).map(({ seq, domain, method, status, error, employeeContext }) => ({ seq, domain, method, status, error, employeeContext }));
        } catch { /* the original failure still owns this case */ }
        try { await shot(`failure-${report.results.length}`); } catch (captureError) { report.results.at(-1).captureError = captureError.message; }
      }
      finally { await reset(); }
    };

    await step('screen-payroll', 'Payroll at both desktop sizes', async () => {
      await page('Payroll'); await wait('!!document.querySelector(".data-table")'); await bothSizes('payroll');
    });
    await step('screen-staff-pay', 'Staff pay at both desktop sizes', async () => {
      await page('Payroll'); await click('Staff pay…');
      await wait(`__hr2Ui.all('select').some(el=>!el.disabled && [...el.options].some(option=>option.value===${JSON.stringify(truth.employees.monthly)}))`, 'staff selector loaded');
      await field('Staff member', truth.employees.monthly); await wait('__hr2Ui.body().includes("Dated pay rates")'); await bothSizes('staff-pay');
    });
    await step('screen-loans', 'Loans at both desktop sizes', async () => {
      await page('Loans'); await wait('!!document.querySelector(".page--hr-loans .data-table")'); await bothSizes('loans');
    });
    await step('screen-settings', 'Payroll settings at both desktop sizes', async () => {
      await settings(); await bothSizes('payroll-settings');
    });
    await step('draft-review', 'create, calculate and review a real draft; correct invalid staff selection', async () => {
      await page('Payroll'); await click('+ New run…'); await click('Create draft');
      await wait('!!document.querySelector("[role=dialog] [role=alert]")', 'empty selection validation');
      await field('Month', '2026-06'); await field('Statutory set', truth.rateSets[truth.companies.a]);
      await field('Find staff', 'M-USD'); await click('Select matching (up to 500)'); await click('Create draft');
      await wait('__hr2Ui.body().includes("Draft created")'); await click('Calculate'); await click('Calculate draft payroll', '[role=dialog] button');
      await wait('!!document.querySelector(".data-table tbody tr")');
      // No attendance, but HR's prefilled June 18 paid holiday contributes
      // one day: 48000 monthly cents / the fixture's fixed 30-day divisor.
      const created = (await calls()).filter(c => c.domain === 'payroll' && c.method === 'create' && c.resultId).at(-1);
      const draft = await api('payroll', 'get', { companyId: truth.companies.a, id: created.resultId });
      assert.equal(draft.status, 'draft'); assert.equal(draft.lines[0].baseMinor, 1600);
      await click('Review', '.page__header button'); await click('Review payroll', '[role=dialog] button');
      await wait('!document.querySelector("[role=dialog]")');
      assert.equal((await api('payroll', 'get', { companyId: truth.companies.a, id: draft.id })).status, 'reviewed'); await shot('reviewed-draft');
    });
    await step('statutory-leave', 'run and line statutory controls, inheritance and separate frozen leave', async () => {
      const companyId = truth.companies.a, employeeId = truth.employees.monthly;
      const leaveTruth = [['probe_annual', 'Synthetic annual leave', 3], ['probe_special', 'Synthetic special leave', 1.25]];
      const leaveTypes = [];
      for (const [code, nameEn, days] of leaveTruth) {
        const type = await api('leave', 'createType', { companyId, code, nameEn, accrual: 'none', tracksBalance: true });
        leaveTypes.push(type.id);
        await api('leave', 'adjust', { companyId, employeeId, leaveTypeId: type.id, days, date: '2026-05-01', note: 'FICTIONAL probe opening leave' });
      }
      await page('Payroll'); await click('+ New run…'); await field('Month', '2026-05');
      await field('Statutory set', truth.rateSets[companyId]); await field('Find staff', 'M-USD'); await click('Select matching (up to 500)');
      await click('Advanced · run statutory treatment', 'summary');
      await field('Salary tax', 'no'); await field('NSSF', 'no'); await click('Create draft');
      await wait('document.querySelector("[role=dialog] [role=alert]")?.innerText.includes("reason")', 'run override requires a reason');
      const runOverride = { applyTax: false, applyNssf: false, reason: 'FICTIONAL run treatment for UI verification' };
      await field('Override reason', runOverride.reason); await bothSizes('run-statutory-controls'); await click('Create draft');
      await wait('__hr2Ui.body().includes("Draft created")'); await click('Calculate'); await click('Calculate draft payroll', '[role=dialog] button');
      await wait('!document.querySelector("[role=dialog]") && __hr2Ui.all(".data-table tbody tr").length === 1');
      const created = (await calls()).filter(c => c.domain === 'payroll' && c.method === 'create' && c.resultId).at(-1);
      const getRun = () => api('payroll', 'get', { companyId, id: created.resultId });
      let run = await getRun(); assert.deepEqual(run.input.statutoryOverride, runOverride);
      assert.deepEqual([run.lines[0].salaryTaxMinor, run.lines[0].nssfEmployeeMinor], [0, 0]);
      await click('Details…'); await click('Advanced · statutory treatment', '[role=dialog] summary'); await click('Edit statutory treatment…');
      await field('Salary tax', 'yes'); await click('Save decision and recalculate');
      await wait('document.querySelector("[role=dialog] [role=alert]")?.innerText.includes("reason")', 'line override requires a reason');
      const lineOverride = { applyTax: true, reason: 'FICTIONAL line treatment for UI verification' };
      await field('Override reason', lineOverride.reason); await bothSizes('line-statutory-controls'); await click('Save decision and recalculate');
      await wait('__hr2Ui.all("[role=dialog] button").some(el=>el.innerText === "Save payslip PDF…")');
      run = await getRun(); assert.deepEqual(run.lines[0].decisions.statutoryOverride, lineOverride);
      assert.deepEqual([run.lines[0].snapshot.effectivePolicy.applyTax, run.lines[0].snapshot.effectivePolicy.applyNssf], [true, false]);
      await click('Advanced · statutory treatment', '[role=dialog] summary');
      const treatmentRows = await evaluate(`__hr2Ui.all('[role=dialog] details[open] tbody tr').map(row=>[...row.querySelectorAll('th,td')].map(el=>el.innerText))`);
      assert.deepEqual(treatmentRows.find(row => row[0] === 'Run override'), ['Run override', 'Do not apply', 'Do not apply', runOverride.reason]);
      assert.deepEqual(treatmentRows.find(row => row[0] === 'Line override'), ['Line override', 'Apply', 'Inherit', lineOverride.reason]);
      assert.deepEqual(treatmentRows.find(row => row[0] === 'Effective policy').slice(0, 3), ['Effective policy', 'Apply', 'Do not apply']);
      await shot('statutory-source-precedence'); await click('Edit statutory treatment…');
      await field('Salary tax', 'inherit'); await field('NSSF', 'inherit'); await click('Save decision and recalculate');
      await wait('__hr2Ui.all("[role=dialog] button").some(el=>el.innerText === "Save payslip PDF…")');
      run = await getRun(); assert.equal(run.lines[0].decisions.statutoryOverride, null);
      assert.deepEqual([run.lines[0].snapshot.effectivePolicy.applyTax, run.lines[0].snapshot.effectivePolicy.applyNssf], [false, false]);
      await click('Close', '[role=dialog] button'); await click('Review', '.page__header button'); await click('Review payroll', '[role=dialog] button');
      await wait('!document.querySelector("[role=dialog]")'); await click('Approve'); await click('Approve payroll', '[role=dialog] button');
      await wait('!document.querySelector("[role=dialog]")'); run = await getRun(); assert.equal(run.status, 'approved');
      const frozen = run.lines[0].snapshot;
      assert.equal(frozen.leaveBalanceAsOf, '2026-05-31');
      assert.deepEqual(frozen.leaveBalances.filter(row => leaveTypes.includes(row.leaveTypeId)).map(row => [row.code, row.days]).sort(),
        leaveTruth.map(([code, , days]) => [code, days]).sort());
      const adjusted = await api('leave', 'adjust', { companyId, employeeId, leaveTypeId: leaveTypes[0], days: 9, date: '2026-05-20', note: 'FICTIONAL change after approval; frozen balance must stay 3' });
      assert.equal(adjusted.balance, 12);
      await page('Payroll'); await openRun(run.id); await click('Details…'); await click('Leave balances', '[role=dialog] summary');
      const displayed = await evaluate(`__hr2Ui.all('[role=dialog] details[open] tbody tr').map(row=>[...row.querySelectorAll('td')].map(el=>el.innerText)).filter(row=>row[1]?.startsWith('probe_'))`);
      assert.deepEqual(displayed.sort(), leaveTruth.map(([code, name, days]) => [name, code, String(days)]).sort());
      assert.deepEqual((await getRun()).lines[0].snapshot.leaveBalances, frozen.leaveBalances);
      await bothSizes('frozen-leave-separate-types'); await click('Close', '[role=dialog] button');
      report.supplemental.payroll = { runId: run.id, runOverride, lineOverride, clearedLineOverride: true, frozenLeave: leaveTruth, liveAnnualDays: 12 };
    });
    await step('run-pdf', 'whole-run PDF button uses real rendering and one marked output', async () => {
      await page('Payroll'); await openRun(truth.runs.monthly);
      await wait('__hr2Ui.all(".data-table button").filter(el=>el.innerText === "Details…").length === 3');
      await evaluate('__hr2.dialog("runPdf")'); await click('Save run PDF…');
      await wait(`__hr2.calls().some(c=>c.domain==='payroll' && c.method==='saveRunPdf' && c.args[0].id===${JSON.stringify(truth.runs.monthly)} && c.status==='returned')`, 'whole-run PDF export');
      assert.ok(fs.existsSync(pdfPath), 'real PDF was written');
      const bytes = fs.readFileSync(pdfPath);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.ok(bytes.subarray(-1024).includes(Buffer.from('%%EOF')));
      const exports = (await calls()).filter(c => c.domain === 'payroll' && c.method === 'saveRunPdf');
      assert.equal(exports.length, 1); assert.deepEqual(exports[0].args, [{ companyId: truth.companies.a, id: truth.runs.monthly }]);
      report.supplemental.pdfBytes = bytes.length; await bothSizes('whole-run-pdf-saved');
    });
    await step('company-race', 'delayed company list A → B cannot repaint A data', async () => {
      await page('Payroll'); await field('Month', '2026-09');
      await inject({ domain: 'payroll', method: 'list', mode: 'hold', match: { companyId: truth.companies.a, month: '2026-09' } });
      await click('Refresh'); await wait('__hr2.calls().some(c=>c.domain==="payroll" && c.method==="list" && c.status==="held")');
      await swapCompany('b'); await wait('__hr2Ui.all(".data-table tbody tr").length === 2');
      await release(); await delay(200); assert.equal(await evaluate('__hr2Ui.all(".data-table tbody tr").length'), 2);
      await shot('company-race-b'); await swapCompany('a');
    });
    await step('run-race', 'delayed run response is discarded after opening another run', async () => {
      await page('Payroll');
      // openRun uses get itself; arm only after locating the visible row.
      await field('Month', '2026-09'); await wait('__hr2Ui.all(".data-table tbody tr").length === 1');
      await inject({ domain: 'payroll', method: 'get', mode: 'hold', match: { id: truth.runs.monthly } });
      await click('Open run'); await wait('__hr2.calls().some(c=>c.method==="get" && c.status==="held")');
      await click('Payroll', '.page__header button'); await wait('!!document.querySelector(".toolbar input[type=month]")');
      await openRun(truth.runs.paid); await wait('__hr2Ui.body().includes("430.40")');
      await release(); await delay(200); assert.ok(!(await body()).includes('432.50')); await shot('run-race-paid');
    });
    await step('employee-race', 'employee load and in-flight save remain scoped across selection changes', async () => {
      await page('Payroll'); await click('Staff pay…');
      await inject({ domain: 'payroll', method: 'listPayRates', mode: 'hold', match: { employeeId: truth.employees.monthly } });
      await field('Staff member', truth.employees.monthly); await wait('__hr2.calls().some(c=>c.method==="listPayRates" && c.status==="held")');
      await field('Staff member', truth.employees.daily); await wait('__hr2Ui.body().includes("16,000")');
      await release(); await delay(200); assert.ok(!(await body()).includes('$480.00'));
      await field('Staff member', truth.employees.monthly); await wait('__hr2Ui.body().includes("$480.00")');
      await inject({ domain: 'payroll', method: 'setEmployeePolicy', mode: 'hold', match: { employeeId: truth.employees.monthly } });
      await field('Policy / exemption reason', 'FICTIONAL old-employee save');
      await wait('__hr2.calls().some(c=>c.method==="setEmployeePolicy" && c.status==="held")');
      await field('Staff member', truth.employees.daily); await wait('__hr2Ui.body().includes("16,000")');
      await release(); await delay(200);
      assert.notEqual((await api('payroll', 'getEmployeePolicy', { companyId: truth.companies.a, employeeId: truth.employees.daily })).reason, 'FICTIONAL old-employee save');
      assert.ok(!(await body()).includes('FICTIONAL old-employee save')); await shot('employee-save-race');
    });
    await step('loan-retry', 'loan lost-reply retry survives page unmount and reload and posts once', async () => {
      await page('Loans'); await wait('!!document.querySelector(".page--hr-loans .data-table")'); await click('+ New loan');
      await field('Staff member', truth.employees.monthly); await field('Principal', '-1'); await field('Monthly instalment', '50'); await field('Disbursement date', '2026-09-01');
      await click('Save draft'); await wait('!!document.querySelector("[role=dialog] [role=alert]")');
      await field('Principal', '200'); await click('Save draft'); await wait('!document.querySelector("[role=dialog]")'); await wait('__hr2Ui.body().includes("Approve loan")');
      const created = (await calls()).filter(c => c.domain === 'loans' && c.method === 'create' && c.resultId).at(-1);
      await click('Approve loan'); await click('Approve and disburse', '[role=dialog] button'); await wait('!document.querySelector("[role=dialog]")');
      assert.equal((await api('loans', 'get', { companyId: truth.companies.a, id: created.resultId })).principalMinor, 20000);
      await inject({ domain: 'loans', method: 'repay', mode: 'lost', match: { id: created.resultId } });
      await click('Record repayment…'); await field('Amount (USD)', '10'); await field('Payment date', '2026-10-01'); await click('Record repayment', '[role=dialog] button');
      await wait('__hr2Ui.body().includes("Retry same request")');
      const lost = (await calls()).filter(c => c.domain === 'loans' && c.method === 'repay' && c.args[0].id === created.resultId);
      assert.equal(lost.length, 1); assert.equal(lost[0].status, 'lost');
      const posted = await api('loans', 'get', { companyId: truth.companies.a, id: created.resultId });
      assert.equal(posted.principalMinor, 19000); assert.equal(posted.entries.filter(x => x.kind === 'repayment').length, 1);
      await click('Cancel', '[role=dialog] button'); await page('Payroll'); await page('Loans');
      await wait('__hr2Ui.all("button").some(el=>el.innerText === "Retry the same request")', 'pending repayment survives page unmount');
      await cdp.send('Page.reload');
      await wait('!!window.__hr2 && !!document.querySelector(".sidebar__home")'); await evaluate(`(${toolkit.toString()})()`);
      await page('Loans');
      await wait('__hr2Ui.all("button").some(el=>el.innerText === "Retry the same request")', 'pending repayment survives renderer reload');
      assert.equal(await evaluate('__hr2Ui.all("button").find(el=>el.innerText === "+ New loan")?.disabled'), true);
      await click('Retry the same request');
      await wait('!__hr2Ui.all("button").some(el=>el.innerText === "Retry the same request")', 'retained repayment resolved');
      const loan = await api('loans', 'get', { companyId: truth.companies.a, id: created.resultId });
      assert.equal(loan.principalMinor, 19000); assert.equal(loan.entries.filter(x => x.kind === 'repayment').length, 1);
      const retries = (await calls()).filter(c => c.domain === 'loans' && c.method === 'repay' && c.args[0].id === created.resultId);
      // Reload resets preload call history; the first lost request is retained
      // in this Node process, never restored into the application by the probe.
      assert.equal(retries.length, 1); assert.equal(retries[0].status, 'returned'); assert.deepEqual(lost[0].args, retries[0].args);
      assert.equal(loan.entries.find(x => x.kind === 'repayment').id, posted.entries.find(x => x.kind === 'repayment').id);
      report.supplemental.loanRetry = { loanId: loan.id, original: lost[0].args, retry: retries[0].args, principalMinor: loan.principalMinor, repayments: 1 };
      await shot('loan-retry-after-remount-reload');
    });
    await step('opening-import', 'opening-loan workbook pick, manual mapping, exact review and draft-only apply', async () => {
      await page('Loans'); await wait('!!document.querySelector(".page--hr-loans .data-table")');
      const companyId = truth.companies.a, before = await api('loans', 'list', { companyId });
      await click('Import opening balances…');
      await wait('__hr2Ui.all("[role=dialog] button").some(el=>el.innerText === "Choose a file…" && !el.disabled)');
      await evaluate('__hr2.dialog("openingLoans")'); await click('Choose a file…', '[role=dialog] button');
      await wait(`!!document.querySelector('[aria-label="Column for Synthetic reference"]')`);
      assert.equal(await evaluate(`document.querySelector('[aria-label="Column for Synthetic reference"]').value`), '');
      await field('Column for Synthetic reference', 'loanNo'); await bothSizes('opening-loans-map');
      await click('Check 2 rows', '[role=dialog] button'); await wait('__hr2Ui.body().includes("Review every row.")');
      const planned = (await calls()).filter(c => c.domain === 'loans' && c.method === 'importPlan' && c.status === 'returned').at(-1);
      assert.deepEqual(planned.args, [{ companyId, rows: openingRows }]);
      const parsed = (await calls()).filter(c => c.domain === 'files' && c.method === 'parseWorkbook');
      assert.equal(parsed.length, 1); assert.deepEqual(parsed[0].args, [workbookPath]); assert.equal(parsed[0].status, 'returned');
      assert.deepEqual(await evaluate(`__hr2Ui.all('[role=dialog] .data-table tbody tr').map(row=>[...row.querySelectorAll('td')].slice(0,7).map(el=>el.innerText))`), [
        ['2', 'create', 'SYNTH-OPEN-USD', 'USD', '$500.00', '$200.00', '$5.00'],
        ['3', 'create', 'SYNTH-OPEN-KHR', 'KHR', '៛800,000', '៛300,000', '៛7,500'],
      ]);
      assert.equal((await api('loans', 'list', { companyId })).length, before.length, 'preview must not write');
      await bothSizes('opening-loans-review'); await click('Import 2 rows', '[role=dialog] button');
      await wait('__hr2Ui.body().includes("Opening balances were recorded on drafts.")');
      const applied = (await calls()).filter(c => c.domain === 'loans' && c.method === 'importApply');
      assert.equal(applied.length, 1); assert.equal(applied[0].status, 'returned');
      assert.deepEqual(applied[0].args[0].rows, planned.args[0].rows); assert.equal(applied[0].args[0].companyId, companyId); assert.ok(applied[0].args[0].operationId);
      const after = await api('loans', 'list', { companyId }); assert.equal(after.length, before.length + 2);
      for (const expected of openingRows) {
        const matches = after.filter(loan => loan.loanNo === expected.loanNo); assert.equal(matches.length, 1);
        const loan = await api('loans', 'get', { companyId, id: matches[0].id });
        assert.deepEqual([loan.status, loan.currency, loan.originalPrincipalMinor, loan.openingPrincipalMinor, loan.openingInterestMinor, loan.balanceAsOf, loan.deductViaPayroll],
          ['draft', expected.currency, expected.originalPrincipalMinor, expected.currentPrincipalMinor, expected.unpaidInterestMinor, expected.balanceAsOf, false]);
        assert.deepEqual(loan.entries, []); assert.equal(loan.approvedAt, null);
      }
      await shot('opening-loans-applied'); await click('Done', '[role=dialog] button');
    });
    await step('manual-fx', 'manual settings persist; a fetched proposal never overwrites manual FX', async () => {
      await settings(); await field('Salary-tax conversion (KHR per USD)', '4123'); await field('Salary-tax rate source', 'FICTIONAL manual probe FX');
      await wait(`__hr2.calls().some(c=>c.method==='updateSettings' && c.status==='returned' && c.args[0].patch?.rateSource==='FICTIONAL manual probe FX')`);
      await evaluate(`__hr2.proposal(${JSON.stringify({ month: '2026-09', khrPerUsd: 4999, rateDate: '2026-09-15', referenceDate: '2026-09-15', source: 'FICTIONAL local proposal; no external request', requiresConfirmation: true })})`);
      await click('Fetch official rate'); await wait('__hr2Ui.body().includes("Proposed 4999")');
      const saved = await api('payroll', 'getSettings', { companyId: truth.companies.a }); assert.equal(saved.taxRateKhrPerUsd, 4123); assert.equal(saved.rateSource, 'FICTIONAL manual probe FX');
      await page('Payroll'); await settings();
      assert.equal(await evaluate(`document.querySelector('[aria-label="Salary-tax rate source"]').value`), 'FICTIONAL manual probe FX'); await shot('manual-fx-persisted');
    });
    await step('settings-race', 'delayed settings response after company switch stays with original company', async () => {
      await settings();
      await inject({ domain: 'payroll', method: 'updateSettings', mode: 'hold', match: { companyId: truth.companies.a } });
      await field('Salary-tax conversion (KHR per USD)', '4124'); await wait('__hr2.calls().some(c=>c.method==="updateSettings" && c.status==="held")');
      await selectCompany('b');
      // A registered save flush may intentionally hold navigation until the
      // response is known; that is safe too, and must not deadlock this probe.
      report.settingsSwitchDeferredUntilSave = !(await evaluate(companySelected('b')));
      await release(); await wait(companySelected('b')); await wait(`document.querySelector('.payroll-settings')?.innerText.includes('Pay schedule')`);
      assert.equal((await api('payroll', 'getSettings', { companyId: truth.companies.b })).taxRateKhrPerUsd, 4000); await swapCompany('a');
    });
    await step('kiosk', 'kiosk own records disappear on logout/token swap, including delayed old replies', async () => {
      await page('Settings'); await click('Multi-Mac', '.settings-tab'); await click('Preview the kiosk screen'); await wait('!!document.querySelector(".kiosk-tile")');
      await click('English');
      const signIn = async (name, pin) => {
        await evaluate(`__hr2Ui.all('.kiosk-tile').find(el=>el.getAttribute('aria-label').includes(${JSON.stringify(name)})).click()`);
        await wait('__hr2Ui.body().includes("Enter your PIN")');
        for (const key of pin) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
        await click('OK'); await wait('__hr2Ui.body().includes("View my records")');
        const signedIn = (await calls()).filter(c => c.domain === 'kiosk' && c.method === 'signIn' && c.status === 'returned').at(-1);
        assert.equal(signedIn?.employeeContext?.companyId, truth.companies.a, 'kiosk:signIn employee.companyId must satisfy the renderer kioskContext contract');
        await click('View my records');
        await wait('__hr2Ui.all(".kiosk-me").length === 1', 'kiosk own-view context loaded');
        const own = (await calls()).filter(c => c.domain === 'kiosk' && c.method === 'me' && c.status === 'returned').at(-1);
        assert.deepEqual(own?.employeeContext, signedIn.employeeContext, 'kiosk:me must preserve employee and company identity');
      };
      await signIn('Synthetic monthly USD', truth.kiosk.monthlyPin); await wait('__hr2Ui.body().includes("430.40")'); await bothSizes('kiosk-own-records');
      await click('Done'); await wait('!!document.querySelector(".kiosk-tile")'); assert.ok(!(await body()).includes('430.40'));
      await inject({ domain: 'kiosk', method: 'payroll', mode: 'hold' });
      await signIn('Synthetic monthly USD', truth.kiosk.monthlyPin); await wait('__hr2.calls().some(c=>c.domain==="kiosk" && c.method==="payroll" && c.status==="held")');
      await click('Done'); await wait('!!document.querySelector(".kiosk-tile")');
      await signIn('Synthetic daily KHR', truth.kiosk.dailyPin); await wait('__hr2Ui.body().includes("424,000")'); await release(); await delay(200);
      assert.ok(!(await body()).includes('430.40')); assert.ok(!(await body()).includes('432.50')); await shot('kiosk-token-race'); await click('Done'); await click('Close preview');
    });
    await step('roles', 'renderer financial opt-in gates and payroll manager read-only settings', async () => {
      const reloadRole = async caps => {
        await evaluate(`__hr2.uiRole(${JSON.stringify(caps)})`); await cdp.send('Page.reload');
        await wait('!!window.__hr2 && !!document.querySelector(".sidebar__home")'); await evaluate(`(${toolkit.toString()})()`);
        await click('Home', '.sidebar button'); await wait('!!document.querySelector(".home-tile")');
      };
      await reloadRole(['hr.manage', 'hr.view']); await click('People', '.home-tile');
      assert.ok(!(await evaluate(`__hr2Ui.all('.sidebar button').map(el=>el.innerText).join('|')`)).includes('Payroll')); assert.ok(!(await evaluate(`__hr2Ui.all('.sidebar button').map(el=>el.innerText).join('|')`)).includes('Loans'));
      assert.equal((await calls()).filter(c => ['payroll', 'loans'].includes(c.domain)).length, 0);
      await shot('hr-only-financial-hidden');
      await reloadRole(['payroll.manage']); await settings();
      assert.equal(await evaluate(`__hr2Ui.all('.payroll-settings input, .payroll-settings textarea').filter(el=>!el.disabled).length`), 0);
      assert.ok(!(await body()).includes('Confirm reviewed policy')); await shot('payroll-manager-read-only');
      await reloadRole(null);
    });
    report.consoleErrors = cdp.events;
    report.results.push({ name: 'no unexpected renderer console errors', ok: !cdp.events.length, count: cdp.events.length });
    report.selectedCasesVerified = report.results.every(result => result.ok);
    report.runtimeVerified = !report.skippedCases.length && report.selectedCasesVerified;
    return report.selectedCasesVerified ? 0 : 1;
  } catch (error) {
    report.results.push({ name: 'launch/profile/dependency gate', ok: false, error: error.stack || error.message }); return 1;
  } finally {
    // Stop only our own child; preserve the complete profiles and screenshots.
    if (cdp) report.consoleErrors = cdp.events;
    if (cdp) cdp.close();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 40 && child.exitCode === null; i++) await delay(100);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ event: 'probe-result', root, results: path.join(root, 'results.json'), selectedCases: report.selectedCases, skippedCases: report.skippedCases,
      passed: report.results.filter(r => r.ok).length, failed: report.results.filter(r => !r.ok).length, selectedCasesVerified: report.selectedCasesVerified, runtimeVerified: report.runtimeVerified }));
  }
}

module.exports = { parseArgs, preflight };
if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log('Usage: node scripts/probe-hr2-ui.js --repo reviewed-built-checkout [--preflight] [--only id,id] [--skip id,id] [--list]\nEach selection seeds a fresh marked profile; skipped cases are never reported as passes. No builds, external requests or cleanup.'); return; }
    if (options.list) { console.log(CASE_IDS.join('\n')); return; }
    process.exitCode = await main(options);
  })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
