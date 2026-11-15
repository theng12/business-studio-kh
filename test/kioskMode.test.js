/**
 * HR1: the shop Mac's attendance kiosk — the machine-local `kioskMode` switch,
 * the lock-down helpers and the wiring around them (main/kioskWindow.js,
 * main/ipc/kioskMode.js, main/client/index.js, main/config.js, the Kiosk
 * screen). Plain `npm test`: Electron is replaced by a small fake so the real
 * handlers and the real config.json code run against a temp folder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ── a fake Electron, installed before anything requires 'electron' ── */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-mode-test-'));
const calls = { relaunch: 0, exit: [], quit: 0, loginItems: [], asked: 0 };
const fakeElectron = {
  app: {
    isPackaged: true,
    getPath: () => userData,
    getName: () => 'Business Studio KH',
    relaunch: () => { calls.relaunch += 1; },
    exit: (code) => { calls.exit.push(code); },
    quit: () => { calls.quit += 1; },
    on: () => {},
    setLoginItemSettings: (s) => { calls.loginItems.push(s); },
  },
  systemPreferences: {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async () => { calls.asked += 1; return true; },
  },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} },
  powerMonitor: { on: () => {} },
  BrowserWindow: function BrowserWindow() {},
  ipcMain: { handle: () => {} },
};
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: fakeElectron };
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ dataDir: path.join(userData, 'data'), firstLaunchHandled: true }));

const kiosk = require('../main/kioskWindow');
const config = require('../main/config');
const { getValidator } = require('../main/server/validators');
const { PORTABLE_CONFIG_KEYS } = require('../main/serverBundle');

kiosk.configureKiosk({ log: () => {} });
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

/** Let the handlers' relaunch / quit timers fire. */
const flushTimers = () => new Promise((r) => setTimeout(r, 400));

/* ── config: machine-local, written only by the kioskMode:* channels ── */

test('kioskMode is a config.json key that defaults off and is never carried by a backup or bundle', () => {
  const cfg = config.loadConfig();
  assert.equal(cfg.kioskMode, false);
  assert.equal(cfg.kioskOpenAtLogin, true);
  assert.deepEqual(config.KIOSK_CONFIG_KEYS, [
    'kioskMode', 'kioskOpenAtLogin',
    'kioskRecoveryHash', 'kioskRecoverySalt', 'kioskRecoveryFailures', 'kioskRecoveryLockedUntil', 'kioskRecoveryLockCount',
  ]);
  for (const k of config.KIOSK_CONFIG_KEYS) assert.ok(k in cfg, `${k} has a default`);
  for (const k of config.KIOSK_CONFIG_KEYS) assert.ok(!PORTABLE_CONFIG_KEYS.includes(k), `${k} must not be restored onto another Mac`);
});

test('the generic settings setters refuse the kiosk keys — on both paths, through the shared guard', () => {
  for (const patch of [{ kioskMode: false }, { kioskMode: true }, { kioskOpenAtLogin: false }, { theme: 'dark', kioskMode: false }, { kioskRecoveryHash: 'ab' }, { kioskRecoveryLockedUntil: 0 }, { kioskRecoveryFailures: 0 }]) {
    assert.throws(() => config.assertKnownConfigKeys(patch), /manager PIN/);
  }
  assert.doesNotThrow(() => config.assertKnownConfigKeys({ theme: 'dark' }));
  // The guard lives in main/config.js, and both modes' setters call it (AGENTS.md §15).
  const standalone = strip(read('main/ipc/settings.js'));
  const client = strip(read('main/client/index.js'));
  for (const ch of ['settings:setOne', 'settings:setMany']) {
    for (const [name, src, reg] of [['standalone', standalone, 'exposeLocal'], ['client', client, 'handleLocal']]) {
      const at = src.indexOf(`${reg}('${ch}'`);
      assert.notEqual(at, -1, `${name} has no ${ch}`);
      assert.match(src.slice(at, at + 400), /assertKnownConfigKeys\(/, `${name} ${ch} skips the shared guard`);
    }
  }
  assert.match(strip(read('main/config.js')), /function assertKnownConfigKeys[\s\S]*?assertValidConfigValues\(patch\)/);
});

/* ── the handlers (shared by both registration paths) ── */

function handlers({ caps = ['*'], verify, reachable = true, managers } = {}) {
  const seen = [];
  const h = kiosk.makeKioskModeHandlers({
    verifyManagerPin: async (args) => { seen.push(args); if (verify) return verify(args); return { ok: true, managerId: args.employeeId }; },
    getCaps: () => caps,
    isServerReachable: () => reachable,
    countManagersWithPin: managers == null ? null : () => managers,
  });
  return { h, seen };
}

test('enable: refused for an account without the kiosk or HR-manager permission, or when the account cannot be checked', async () => {
  for (const caps of [['fuel.record'], [], null]) {
    const { h } = handlers({ caps });
    await assert.rejects(h.enable({ openAtLogin: true }), caps == null ? /Connect to the office Mac/ : /cannot run the attendance kiosk/);
    await assert.rejects(h.newRecoveryCode(), caps == null ? /Connect to the office Mac/ : /cannot run the attendance kiosk/, 'no code for an account that cannot enable');
  }
  assert.equal(config.loadConfig().kioskMode, false);
  assert.equal(calls.relaunch, 0);
});

const configText = () => fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
const recovery = require('../main/util/kioskRecovery');

test('enable: needs the recovery code shown first; writes kioskMode, the code\'s hash (never the code), the login item; relaunches', async () => {
  const { h } = handlers({ caps: ['attendance.kiosk'] });
  await assert.rejects(h.enable({ openAtLogin: false }), /Show the recovery code first/);
  assert.equal(config.loadConfig().kioskMode, false);
  const { code } = await h.newRecoveryCode();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(await h.enable({ openAtLogin: false }), { ok: true });
  await assert.rejects(h.enable({ openAtLogin: false }), /Show the recovery code first/, 'a shown code is used once');
  const cfg = config.loadConfig();
  assert.match(cfg.kioskRecoveryHash, /^[0-9a-f]{64}$/);
  assert.match(cfg.kioskRecoverySalt, /^[0-9a-f]{32}$/);
  assert.equal(await recovery.verifyCode(code, { hash: cfg.kioskRecoveryHash, salt: cfg.kioskRecoverySalt }), true);
  assert.ok(!configText().includes(code.replace(/-/g, '')) && !configText().includes(code), 'the code itself is never stored');
  assert.equal(cfg.kioskMode, true);
  assert.equal(cfg.kioskOpenAtLogin, false);
  assert.deepEqual(calls.loginItems.at(-1), { openAtLogin: false });
  await flushTimers();
  assert.equal(calls.relaunch, 1);
  assert.deepEqual(calls.exit, [0]);
  const st = await h.status();
  assert.equal(st.enabled, true);
  assert.equal(st.canEnable, true);
  assert.equal(st.openAtLogin, false);
  assert.equal(st.hasRecoveryCode, true);
  assert.equal(st.recoveryLockedUntil, null);
});

test('leave: a wrong or non-manager PIN changes nothing; a manager PIN turns kiosk mode off and relaunches', async () => {
  const before = calls.relaunch;
  const bad = handlers({ verify: () => { throw new Error('Wrong PIN. 4 tries left.'); } });
  await assert.rejects(bad.h.leave({ employeeId: 'e1', pin: '1111' }), /Wrong PIN/);
  assert.deepEqual(bad.seen, [{ employeeId: 'e1', pin: '1111', purpose: 'leave' }]);
  const notManager = handlers({ verify: () => { throw new Error('Only a manager can leave kiosk mode'); } });
  await assert.rejects(notManager.h.leave({ employeeId: 'e2', pin: '2222' }), /Only a manager/);
  assert.equal(config.loadConfig().kioskMode, true, 'still a kiosk');

  const ok = handlers();
  assert.deepEqual(await ok.h.leave({ employeeId: 'm1', pin: '5820' }), { ok: true });
  assert.equal(config.loadConfig().kioskMode, false);
  assert.equal(config.loadConfig().kioskRecoveryHash, null, 'the old recovery code is dropped with kiosk mode');
  assert.deepEqual(calls.loginItems.at(-1), { openAtLogin: false });
  await flushTimers();
  assert.equal(calls.relaunch, before + 1);
  await assert.rejects(ok.h.leave({ employeeId: 'm1', pin: '5820' }), /not in kiosk mode/);
});

test('quit: needs the manager PIN (purpose quit), then quits', async () => {
  const bad = handlers({ verify: () => { throw new Error('Wrong PIN. 3 tries left.'); } });
  await assert.rejects(bad.h.quit({ employeeId: 'e1', pin: '1234' }), /Wrong PIN/);
  await flushTimers();
  assert.equal(calls.quit, 0);
  const ok = handlers();
  await ok.h.quit({ employeeId: 'm1', pin: '5820' });
  assert.equal(ok.seen[0].purpose, 'quit');
  await flushTimers();
  assert.equal(calls.quit, 1);
});

test('standalone / server: enabling is refused until an active manager has a PIN (no code is even shown)', async () => {
  const none = handlers({ managers: 0 });
  await assert.rejects(none.h.newRecoveryCode(), /No manager can leave kiosk mode yet/);
  await assert.rejects(none.h.enable({}), /No manager can leave kiosk mode yet/);
  assert.equal(config.loadConfig().kioskMode, false);
  const one = handlers({ managers: 1 });
  assert.ok((await one.h.newRecoveryCode()).code);
  // The standalone registration passes the real count; a client (which cannot see managers) does not.
  assert.match(strip(read('main/ipc/kioskMode.js')), /countManagersWithPin: \(\) => \{[\s\S]*?e\.hasPin && people\.isManagerEmployee\(e\)/);
  assert.doesNotMatch(strip(read('main/client/index.js')), /countManagersWithPin/);
});

test('standalone / server: the recovery code works without any office-Mac check (there is none)', async () => {
  config.updateConfig({ mode: 'standalone' });
  const setup = handlers({ managers: 1 });
  const { code } = await setup.h.newRecoveryCode();
  await setup.h.enable({});
  await flushTimers();
  assert.equal((await setup.h.status()).recoveryNeedsOffline, false);
  // "reachable" is never asked on a standalone Mac.
  assert.deepEqual(await handlers({ reachable: true }).h.recover({ code }), { ok: true });
  assert.equal(config.loadConfig().kioskMode, false);
  await flushTimers();
});

test('client: recovery code refused while the office Mac answers; 5 wrong → 15-min local lock; the right code turns kiosk mode off', async () => {
  config.updateConfig({ mode: 'client' });
  t_after_mode_reset();
  const setup = handlers();
  const { code } = await setup.h.newRecoveryCode();
  await setup.h.enable({ openAtLogin: true });
  await flushTimers();
  const relaunches = calls.relaunch;

  // Office Mac reachable: the code is not even checked, nothing is counted.
  const online = handlers({ reachable: true });
  await assert.rejects(online.h.recover({ code }), /office Mac can be reached/);
  assert.equal(config.loadConfig().kioskMode, true);
  assert.equal(config.loadConfig().kioskRecoveryFailures, 0);

  const offline = handlers({ reachable: false });
  for (let i = 1; i <= 4; i++) {
    await assert.rejects(offline.h.recover({ code: 'AAAA-AAAA-AAAA' }), new RegExp(`Wrong recovery code\\. ${5 - i} tr`));
  }
  await assert.rejects(offline.h.recover({ code: 'not a code' }), /try again in 15 min/);
  let cfg = config.loadConfig();
  assert.equal(cfg.kioskMode, true);
  assert.equal(cfg.kioskRecoveryLockCount, 1);
  assert.ok(cfg.kioskRecoveryLockedUntil > Date.now() + 14 * 60 * 1000);
  // Locked: even the right code waits (and a relaunch does not reset it — it is in config.json).
  await assert.rejects(offline.h.recover({ code }), /Too many wrong recovery codes\. Try again in 15 min/);
  assert.ok((await offline.h.status()).recoveryLockedUntil > Date.now());

  // The lock runs out (simulated), then the right code — typed in lower case, no dashes — works.
  config.updateConfig({ kioskRecoveryLockedUntil: Date.now() - 1 });
  assert.deepEqual(await offline.h.recover({ code: code.replace(/-/g, '').toLowerCase() }), { ok: true });
  cfg = config.loadConfig();
  assert.equal(cfg.kioskMode, false);
  assert.equal(cfg.kioskRecoveryHash, null);
  assert.equal(cfg.kioskRecoveryLockCount, 0);
  await flushTimers();
  assert.equal(calls.relaunch, relaunches + 1);
  await assert.rejects(offline.h.recover({ code }), /not in kiosk mode/);
  config.updateConfig({ mode: 'standalone' });
});

function t_after_mode_reset() { /* mode is put back at the end of the test */ }

test('recovery code: a kiosk turned on without one says so', async () => {
  config.updateConfig({ kioskMode: true, kioskRecoveryHash: null, kioskRecoverySalt: null });
  await assert.rejects(handlers({ reachable: false }).h.recover({ code: 'AAAA-AAAA-AAAA' }), /No recovery code was set/);
  config.updateConfig({ kioskMode: false });
});

test('askCamera asks macOS once when not yet decided', async () => {
  const { h } = handlers();
  assert.deepEqual(await h.askCamera(), { status: 'granted' });
  assert.equal(calls.asked, 1);
});

/* ── lock-down helpers ── */

test('isBlockedShortcut: quit, close, hide, minimise, reload, DevTools, zoom and full-screen chords are swallowed; editing chords and typing are not', () => {
  const key = (k, mods = {}) => ({ type: 'keyDown', key: k, meta: false, control: false, alt: false, shift: false, ...mods });
  for (const k of ['q', 'w', 'h', 'm', 'r', 'n', 't', ',', '=', '-', '0', 'p', 's']) assert.equal(kiosk.isBlockedShortcut(key(k, { meta: true })), true, `⌘${k}`);
  assert.equal(kiosk.isBlockedShortcut(key('Q', { meta: true, shift: true })), true, '⌘⇧Q');
  assert.equal(kiosk.isBlockedShortcut(key('i', { meta: true, alt: true })), true, '⌥⌘I DevTools');
  assert.equal(kiosk.isBlockedShortcut(key('f', { meta: true, control: true })), true, '⌃⌘F full screen');
  assert.equal(kiosk.isBlockedShortcut(key('r', { control: true })), true, 'Ctrl+R');
  for (const k of ['a', 'c', 'v', 'x', 'z']) assert.equal(kiosk.isBlockedShortcut(key(k, { meta: true })), false, `⌘${k} edits text`);
  for (const k of ['1', '0', 'Enter', 'Escape', 'Backspace', 'a', 'ក']) assert.equal(kiosk.isBlockedShortcut(key(k)), false, k);
  assert.equal(kiosk.isBlockedShortcut({ type: 'keyUp', key: 'q', meta: true }), false);
  assert.equal(kiosk.isBlockedShortcut(null), false);
});

test('the kiosk menu has no way out: no Quit, Hide, Close, Minimise, Reload, DevTools or full-screen item', () => {
  const roles = [];
  const walk = (items) => items.forEach((i) => { if (i.role) roles.push(i.role); if (i.submenu) walk(i.submenu); });
  walk(kiosk.kioskMenuTemplate('Business Studio KH'));
  for (const bad of ['quit', 'hide', 'hideOthers', 'close', 'minimize', 'reload', 'forceReload', 'toggleDevTools', 'togglefullscreen', 'zoomIn', 'resetZoom']) {
    assert.ok(!roles.includes(bad), `menu has ${bad}`);
  }
  for (const keep of ['copy', 'paste', 'cut', 'selectAll', 'undo']) assert.ok(roles.includes(keep), keep);
});

test('kiosk window options: kiosk + isolated preload; windowed only for tests', () => {
  const o = kiosk.kioskWindowOptions({ preloadPath: '/p.js', devTools: false });
  assert.equal(o.kiosk, true);
  assert.equal(o.closable, false);
  assert.equal(o.minimizable, false);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.webPreferences.devTools, false);
  assert.equal(o.webPreferences.preload, '/p.js');
  assert.equal(kiosk.kioskWindowOptions({ preloadPath: '/p.js', windowed: true }).kiosk, false);
  assert.equal(kiosk.kioskUrl('app://local/index.html'), 'app://local/index.html#kiosk');
  assert.equal(kiosk.kioskUrl('http://localhost:5173/#x'), 'http://localhost:5173/#kiosk');
  // The test-only switch is ignored in a packaged build.
  assert.match(strip(read('main/kioskWindow.js')), /!app\.isPackaged && process\.env\.MSKH_KIOSK_WINDOWED === '1'/);
  assert.match(strip(read('main/kioskWindow.js')), /const fake = !app\.isPackaged \? process\.env\.MSKH_KIOSK_FAKE_CAMERA : null/);
});

test('who may enable the kiosk', () => {
  assert.equal(kiosk.canEnableKiosk(['*']), true);
  assert.equal(kiosk.canEnableKiosk(['attendance.kiosk']), true);
  assert.equal(kiosk.canEnableKiosk(['hr.manage']), true);
  assert.equal(kiosk.canEnableKiosk(['hr.view', 'fuel.manage']), false);
  assert.equal(kiosk.canEnableKiosk(null), false);
});

/* ── wiring ── */

const KIOSK_MODE_CHANNELS = ['kioskMode:askCamera', 'kioskMode:enable', 'kioskMode:leave', 'kioskMode:logError', 'kioskMode:newRecoveryCode', 'kioskMode:quit', 'kioskMode:quitDismissed', 'kioskMode:recover', 'kioskMode:status'];

test('kioskMode:* are LOCAL on both paths (exposeLocal + handleLocal), same names, same shared handlers', () => {
  const standalone = strip(read('main/ipc/kioskMode.js'));
  const client = strip(read('main/client/index.js'));
  const local = [...standalone.matchAll(/exposeLocal\(\s*'(kioskMode:[^']+)'/g)].map((m) => m[1]).sort();
  const clientLocal = [...client.matchAll(/handleLocal\(\s*'(kioskMode:[^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(local, KIOSK_MODE_CHANNELS);
  assert.deepEqual(clientLocal, KIOSK_MODE_CHANNELS);
  assert.doesNotMatch(standalone, /\bexpose\(\s*'kioskMode:/, 'a kioskMode channel must never reach the RPC registry');
  for (const src of [standalone, client]) assert.match(src, /makeKioskModeHandlers\(/);
  // Where the manager PIN is checked: in-process on the data Mac, over RPC on a client.
  assert.match(standalone, /require\('\.\/kiosk'\)\.verifyManagerPin\(args\)/);
  assert.match(client, /rpc\('kiosk:verifyManagerPin', args\)/);
  // Recovery code: refused on the data Mac; on a client only when /api\/whoami fails.
  assert.doesNotMatch(standalone, /isServerReachable/, 'standalone has no office Mac to ask');
  assert.match(client, /isServerReachable: async \(\) => \{[\s\S]*?\/api\/whoami[\s\S]*?return res\.ok;/);
  const proxied = client.match(/PROXIED_CHANNELS\s*=\s*\[([\s\S]*?)\n\];/)[1];
  assert.ok(proxied.includes("'kiosk:verifyManagerPin'"), 'the proxied list was found');
  assert.ok(!proxied.includes("'kioskMode:"), 'kioskMode:* must not be proxied to the server');
  assert.match(strip(read('main/ipc.js')), /kioskModeDomain\.register\(helpers\)/);
});

test('kioskMode:* validators: same rule both paths, bad shapes refused', () => {
  for (const ch of KIOSK_MODE_CHANNELS) assert.ok(getValidator(ch), `${ch} has no validator`);
  assert.equal(getValidator('kioskMode:status')(undefined), true);
  assert.equal(getValidator('kioskMode:askCamera')(undefined), true);
  assert.equal(getValidator('kioskMode:enable')({ openAtLogin: true }), true);
  assert.equal(getValidator('kioskMode:enable')(undefined), true);
  assert.equal(typeof getValidator('kioskMode:enable')({ openAtLogin: 'yes' }), 'string');
  assert.equal(getValidator('kioskMode:newRecoveryCode')(undefined), true);
  assert.equal(getValidator('kioskMode:recover')({ code: 'K7QM-2XRT-H9PD' }), true);
  for (const bad of [{}, { code: '' }, { code: 7 }, { code: 'x'.repeat(65) }, 'K7QM2XRTH9PD']) {
    assert.equal(typeof getValidator('kioskMode:recover')(bad), 'string', JSON.stringify(bad));
  }
  for (const ch of ['kioskMode:leave', 'kioskMode:quit']) {
    const v = getValidator(ch);
    assert.equal(v({ employeeId: 'm1', pin: '5820' }), true);
    assert.equal(typeof v({ employeeId: 'm1' }), 'string');
    assert.equal(typeof v({ employeeId: 'm1', pin: '58a0' }), 'string');
    assert.equal(typeof v({ pin: '5820' }), 'string');
    assert.equal(typeof v('5820'), 'string');
  }
  const vm = getValidator('kiosk:verifyManagerPin');
  for (const purpose of [undefined, 'leave', 'quit']) assert.equal(vm({ employeeId: 'm', pin: '1234', purpose }), true);
  assert.equal(typeof vm({ employeeId: 'm', pin: '1234', purpose: 'no-photo' }), 'string', 'no-photo needs the signed-in session');
  assert.equal(vm({ employeeId: 'm', pin: '1234', purpose: 'no-photo', sessionToken: 'tok' }), true);
  assert.equal(vm({ employeeId: 'm', pin: '1234', preview: true }), true);
  assert.equal(typeof vm({ employeeId: 'm', pin: '1234', preview: 'yes' }), 'string');
  const vc = getValidator('kiosk:clock');
  assert.equal(vc({ sessionToken: 'tok', noPhoto: true }), true);
  assert.equal(typeof vc({ sessionToken: 'tok' }), 'string', 'a photo, or noPhoto');
  assert.equal(typeof vc({ sessionToken: 'tok', noPhoto: true, photo: new Uint8Array([1]) }), 'string', 'not both');
  assert.equal(getValidator('kiosk:signIn')({ employeeId: 'e', pin: '1234', preview: true }), true);
  assert.equal(typeof vm({ employeeId: 'm', pin: '1234', purpose: 'payroll' }), 'string');
});

test('preload: kioskMode methods, the quit-request event, and verifyManagerPin with a purpose', () => {
  const preload = read('main/preload.js');
  for (const ch of KIOSK_MODE_CHANNELS) assert.ok(preload.includes(`invoke('${ch}'`), `preload has no method for ${ch}`);
  assert.match(preload, /ipcRenderer\.on\('kioskMode:quitRequested'/);
  assert.match(read('main/kioskWindow.js'), /webContents\.send\('kioskMode:quitRequested'\)/);
  assert.match(preload, /invoke\('kiosk:verifyManagerPin', \{ employeeId, pin, purpose, sessionToken, preview \}\)/);
  assert.match(preload, /invoke\('kiosk:clock', \{ sessionToken, photo, noPhoto \}\)/);
  assert.match(preload, /invoke\('kiosk:signIn', \{ employeeId, pin, preview \}\)/);
});

test('the kiosk window replaces the normal one in kiosk mode, on both boot paths, and loads #kiosk', () => {
  const index = strip(read('main/index.js'));
  const create = index.slice(index.indexOf('function createWindow()'));
  assert.ok(create.indexOf('kioskWindow.isKioskMode(loadConfig())') < create.indexOf('new BrowserWindow('), 'kiosk check must come first');
  assert.match(create, /kioskWindow\.createKioskWindow\(/);
  assert.match(index, /kioskWindow\.configureKiosk\(\{ log: logEvent \}\)/);
  assert.equal(kiosk.KIOSK_HASH, 'kiosk');
  // The renderer learns it is the kiosk window from MAIN (additionalArguments → preload), not the hash.
  const main = strip(read('renderer/main.jsx'));
  assert.match(main, /const isKioskWindow = window\.api\?\.kioskMode\?\.isKioskWindow === true;/);
  assert.doesNotMatch(main, /location\.hash/);
  assert.match(main, /isKioskWindow \? <KioskErrorBoundary><KioskApp \/><\/KioskErrorBoundary> : <App \/>/);
  assert.match(read('main/preload.js'), /isKioskWindow: {3}process\.argv\.includes\('--mskh-kiosk-window'\)/);
  assert.equal(kiosk.KIOSK_WINDOW_ARG, '--mskh-kiosk-window');
  assert.deepEqual(kiosk.kioskWindowOptions({ preloadPath: '/p.js' }).webPreferences.additionalArguments, ['--mskh-kiosk-window']);
  // Navigation: only the exact kiosk URL.
  const target = kiosk.kioskUrl('app://local/index.html');
  assert.equal(kiosk.isKioskNavigationAllowed(target, target), true);
  for (const url of ['app://local/index.html', 'app://local/index.html#home', 'app://local/other.html#kiosk', 'file:///etc/hosts', 'https://example.com/#kiosk']) {
    assert.equal(kiosk.isKioskNavigationAllowed(url, target), false, url);
  }
});

test('a crash on the kiosk screen is logged by main', async () => {
  const lines = [];
  kiosk.configureKiosk({ log: (e, d) => lines.push(`${e} ${d}`) });
  await handlers().h.logError({ message: 'boom', stack: 'Error: boom\n at A\n at B' });
  kiosk.configureKiosk({ log: () => {} });
  assert.match(lines[0], /^kiosk:render-error boom :: Error: boom \|/);
  assert.equal(typeof getValidator('kioskMode:logError')({ message: 'x'.repeat(2001) }), 'string');
  assert.equal(getValidator('kioskMode:logError')({ message: 'boom', stack: 's' }), true);
});

test('the kiosk screen talks only to kiosk:* (the server) and kioskMode:* (this Mac)', () => {
  const dir = path.join(ROOT, 'renderer', 'modules', 'Kiosk');
  const screenFiles = ['index.jsx', 'KioskCamera.jsx', 'KioskMe.jsx', 'kioskLogic.js'];
  const used = new Set();
  for (const f of screenFiles) {
    const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of src.matchAll(/api\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) used.add(`${m[1]}.${m[2]}`);
    assert.doesNotMatch(src, /useAppStore|store\/index/, `${f} must not depend on the app store (the kiosk window has none)`);
  }
  const domains = new Set([...used].map((k) => k.split('.')[0]));
  assert.deepEqual([...domains].sort(), ['kiosk', 'kioskMode']);
  // Never an employee id after sign-in: clock / me / requests carry the session token only.
  const index = read('renderer/modules/Kiosk/index.jsx');
  assert.match(index, /api\.kiosk\.clock\(s\.session\.token, bytes \|\| null, !bytes && !!noPhotoBy\)/);
  // No client-made stand-in picture: a no-photo clock is the server's decision.
  for (const f of screenFiles) assert.doesNotMatch(read(`renderer/modules/Kiosk/${f}`), /makeNoPhotoImage|toBlob\(resolve, 'image\/jpeg', 0\.9\)/);
  assert.match(index, /api\.kiosk\.me\(token\)/);
  // No local queue of clock-ins: nothing is stored to send later.
  for (const f of screenFiles) assert.doesNotMatch(read(`renderer/modules/Kiosk/${f}`), /indexedDB|localStorage|sessionStorage/);
});

test('NSCameraUsageDescription ships in the Mac build, in Khmer and English', () => {
  const pkg = JSON.parse(read('package.json'));
  const text = pkg.build?.mac?.extendInfo?.NSCameraUsageDescription;
  assert.ok(text, 'build.mac.extendInfo.NSCameraUsageDescription is missing');
  assert.match(text, /[ក-៿]/, 'Khmer text');
  assert.match(text, /photo when you clock in and out/);
});
/* ── an unattended quit (0.1.110) ────────────────────────────────── */

/**
 * The kiosk module again, against a fake Electron that records the guard
 * handler, the exits and each quit source. `work.has` stands in for "a job is
 * running", so the release can be tested without starting a real export.
 */
function loadGuardedKiosk({ work } = {}) {
  const handlers = {};
  const exits = [];
  const fake = {
    app: {
      isPackaged: true,
      getPath: () => userData,
      getName: () => 'Business Studio KH',
      on: (event, fn) => { handlers[event] = fn; },
      exit: (code) => { exits.push(`exit:${code}`); },
      relaunch: () => {},
      quit: () => { exits.push('quit'); },
      setLoginItemSettings: () => {},
    },
    systemPreferences: fakeElectron.systemPreferences,
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} },
    powerMonitor: { on: () => {} },
    BrowserWindow: function BrowserWindow() {},
  };
  const id = require.resolve('electron');
  require.cache[id] = { id, filename: id, loaded: true, exports: fake };
  const exportsId = path.join(ROOT, 'main/ipc/exports.js');
  const renderId = path.join(ROOT, 'main/renderWindow.js');
  if (work) {
    const stub = { hasActiveRun: work.has, isRendering: work.has };
    for (const mid of [exportsId, renderId]) require.cache[mid] = { id: mid, filename: mid, loaded: true, exports: stub };
  } else {
    delete require.cache[exportsId];
    delete require.cache[renderId];
  }
  delete require.cache[require.resolve('../main/kioskWindow')];
  const fresh = require('../main/kioskWindow');
  fresh.configureKiosk({ log: () => {} });
  fresh.installKioskGuards();
  return { fresh, handlers, exits };
}

const waitUntil = async (done, timeout) => {
  const started = Date.now();
  while (!done() && Date.now() - started < timeout) await new Promise((r) => setTimeout(r, 20));
  return Date.now() - started;
};

test('a quit nobody answers is released inside the Updater wait; a person answering keeps the kiosk', async () => {
  // A short budget keeps the fast lane fast; the shipped one is asserted below.
  process.env.MSKH_KIOSK_UNATTENDED_QUIT_MS = '1200';
  try {
    const { fresh, handlers, exits } = loadGuardedKiosk();
    const wait = fresh.UNATTENDED_QUIT_BUDGET_MS;
    assert.equal(wait, 1200, 'the test budget is the one in force');
    assert.equal(fresh.isWorkInProgress(), false, 'nothing is running, so nothing holds the quit');

    // Any quit (an installer's AppleEvent is the same event a Dock click sends)
    // is refused and the kiosk screen is asked for a manager PIN.
    const ask = { prevented: false, preventDefault() { this.prevented = true; } };
    handlers['before-quit'](ask);
    assert.equal(ask.prevented, true, 'the quit is refused, not ignored');
    assert.deepEqual(exits, [], 'nothing is released yet');
    // A second ask while the release is pending is refused too: one release, one quit.
    const again = { prevented: false, preventDefault() { this.prevented = true; } };
    handlers['before-quit'](again);
    assert.equal(again.prevented, true);
    assert.deepEqual(exits, [], 'no early quit');

    // Nobody answers (an unattended install): released inside the budget, the
    // ordinary way, so index.js still stops the server and frees the port.
    const elapsed = await waitUntil(() => exits.length > 0, wait + 5000);
    assert.deepEqual(exits, ['quit'], 'the unanswered quit is released');
    assert.ok(elapsed >= wait - 200, 'not before the person had the budget to answer');
    assert.ok(elapsed < 60000, 'and inside the Updater 60 s quit wait');
  } finally {
    delete process.env.MSKH_KIOSK_UNATTENDED_QUIT_MS;
  }
});

test('a person who turns the quit down keeps the kiosk (a PIN tried, or the prompt dismissed)', async () => {
  process.env.MSKH_KIOSK_UNATTENDED_QUIT_MS = '1200';
  try {
    const build = () => loadGuardedKiosk();
    const mkHandlers = (fresh, verify) => fresh.makeKioskModeHandlers({
      verifyManagerPin: verify, getCaps: () => ['*'], isServerReachable: () => true,
    });

    // Dismissed: main calls its release off and the app stays up.
    const dismissed = build();
    dismissed.handlers['before-quit']({ preventDefault() {} });
    await mkHandlers(dismissed.fresh, async () => ({ ok: true })).quitDismissed();
    await new Promise((r) => setTimeout(r, 1600));
    assert.deepEqual(dismissed.exits, [], 'a dismissed quit never closes the kiosk');

    // A wrong PIN proves someone is there too: the kiosk stays.
    const wrong = build();
    wrong.handlers['before-quit']({ preventDefault() {} });
    await assert.rejects(mkHandlers(wrong.fresh, async () => { throw new Error('Wrong PIN'); }).quit({ employeeId: 'm1', pin: '0000' }));
    await new Promise((r) => setTimeout(r, 1600));
    assert.deepEqual(wrong.exits, [], 'a refused PIN never closes the kiosk');

    // The right PIN quits, as it always did.
    const allowed = build();
    allowed.handlers['before-quit']({ preventDefault() {} });
    await mkHandlers(allowed.fresh, async () => ({ ok: true })).quit({ employeeId: 'm1', pin: '5820' });
    await waitUntil(() => allowed.exits.length > 0, 2000);
    assert.deepEqual(allowed.exits, ['quit'], 'a manager PIN quits the kiosk');
  } finally {
    delete process.env.MSKH_KIOSK_UNATTENDED_QUIT_MS;
  }
});

test('the shipped unattended-quit budget sits under the Updater 60 s quit wait', () => {
  const src = strip(read('main/kioskWindow.js'));
  const budget = src.match(/UNATTENDED_QUIT_BUDGET_MS = [^;]+;/)[0];
  assert.match(budget, /45 \* 1000/, 'the shipped bound is 45 s, not whatever a test set');
});

test('work mid-task is not forced: that update cycle is skipped and the next try quits', async () => {
  process.env.MSKH_KIOSK_UNATTENDED_QUIT_MS = '1200';
  try {
    let busy = true;
    const lines = [];
    const { fresh, handlers, exits } = loadGuardedKiosk({ work: { has: () => busy } });
    fresh.configureKiosk({ log: (e, d) => lines.push(`${e} ${d || ''}`.trim()) });
    const wait = fresh.UNATTENDED_QUIT_BUDGET_MS;

    // An export is running: the budget runs out and the app does NOT quit.
    handlers['before-quit']({ preventDefault() {} });
    const waited = await waitUntil(() => lines.some((l) => l.startsWith('kiosk:quit-skipped')), wait + 3000);
    assert.ok(waited >= wait - 200, 'it gave the budget before deciding');
    assert.deepEqual(exits, [], 'a render or export in flight is never cut off');
    assert.ok(lines.some((l) => l.startsWith('kiosk:quit-skipped')), 'the skip is logged');

    // The next attempt, with nothing running, quits — logged as an unattended release.
    busy = false;
    const ask = { prevented: false, preventDefault() { this.prevented = true; } };
    handlers['before-quit'](ask);
    assert.equal(ask.prevented, true);
    await waitUntil(() => exits.length > 0, wait + 3000);
    assert.deepEqual(exits, ['quit'], 'the retry quits');
    assert.ok(lines.some((l) => l.startsWith('kiosk:unattended-quit')), 'the release is logged');
  } finally {
    delete process.env.MSKH_KIOSK_UNATTENDED_QUIT_MS;
  }
});
