/**
 * HR1: the shop Mac's attendance kiosk — window, lock-down and the machine-local
 * `kioskMode` switch (docs/PEOPLE_AND_FUEL_PLAN.md §5.2, §7a, §7b).
 *
 * When config.json says `kioskMode: true` the app opens ONE full-screen window
 * on `index.html#kiosk` (renderer/main.jsx mounts only the Kiosk screen there:
 * no sidebar, no Home) and:
 *
 *   - `kiosk: true` → macOS presentation options that hide the Dock and menu
 *     bar and disable app switching (⌘Tab), Force Quit (⌥⌘Esc), Hide and
 *     log-out-from-the-Apple-menu while the window is in front;
 *   - an application menu with no Quit / Hide / Close / Reload / DevTools item;
 *   - ⌘Q ⌘W ⌘H ⌘M ⌘R ⌘N, zoom, DevTools and every other ⌘/Ctrl chord except
 *     the text-editing ones (⌘A ⌘C ⌘V ⌘X ⌘Z) are swallowed before the page sees
 *     them (`isBlockedShortcut`);
 *   - a quit from anywhere else (Dock menu, `osascript … quit`, Activity
 *     Monitor's plain Quit) is refused in `before-quit` and the screen asks for
 *     a manager PIN instead (kioskMode:quit). A system shutdown / restart /
 *     log-out is let through (powerMonitor 'shutdown'), so the shop Mac can
 *     still be turned off;
 *   - navigation away from the page and new windows are refused;
 *   - it opens at login (`app.setLoginItemSettings`) when that box was ticked.
 *
 * What macOS does NOT let an app block (documented for the owner): the power
 * button and holding it down; Force Quit from Activity Monitor or `kill` in a
 * Terminal; ⌃⌘Q (Lock Screen) and fast user switching; the TCC camera prompt
 * itself. Those need the Mac's own account to be locked down (a standard user
 * with no admin rights, FileVault, a firmware password) — and the kiosk ACCOUNT
 * on the server only reaches kiosk:* channels, so escaping the screen does not
 * open the data (§5.2).
 *
 * The office Mac gone or unreachable: a local RECOVERY CODE (shown once when
 * kiosk mode is turned on, only its scrypt hash kept — main/util/kioskRecovery.js)
 * turns kiosk mode off, accepted only while the office Mac cannot answer.
 *
 * Leaving kiosk mode needs a manager PIN checked by the server:
 * `kioskMode:leave` calls `kiosk:verifyManagerPin` — in-process on a standalone
 * or server Mac, over RPC on a client Mac — and only then writes
 * `kioskMode: false` and relaunches. The generic settings setters refuse the
 * kiosk keys (main/config.js assertValidConfigValues), so there is no other way
 * to turn it off from the app.
 *
 * The seven `kioskMode:*` channels are LOCAL (they act on this Mac): registered
 * with exposeLocal() in main/ipc/kioskMode.js and handleLocal() in
 * main/client/index.js, both from `makeKioskModeHandlers` below, both validated
 * by main/server/hrValidators.js.
 */

const { app, BrowserWindow, Menu, powerMonitor, systemPreferences } = require('electron');
const { loadConfig, updateConfig } = require('./config');

const KIOSK_HASH = 'kiosk';
const RELAUNCH_DELAY_MS = 300;

let log = (event, detail) => process.stdout.write(`[kiosk] ${event}${detail ? ` :: ${detail}` : ''}\n`);
let allowQuit = false;
let guardsInstalled = false;
let kioskWin = null;

/** index.js hands in its crash-log writer so kiosk events land in crash.log (AGENTS.md §19). */
function configureKiosk({ log: logFn } = {}) {
  if (typeof logFn === 'function') log = logFn;
}

function isKioskMode(cfg) {
  return !!cfg && cfg.kioskMode === true;
}

/** Dev/test only: a normal-size window instead of the full-screen kiosk, so a test
 * run does not take over the screen. Ignored in a packaged build. */
function isWindowedForTesting() {
  return !app.isPackaged && process.env.MSKH_KIOSK_WINDOWED === '1';
}

/* ─── pure parts (test/kioskMode.test.js) ─────────────────────────── */

/** ⌘/Ctrl chords the kiosk keeps: text editing only. */
const ALLOWED_CHORD_KEYS = new Set(['a', 'c', 'v', 'x', 'z']);

/**
 * Should this `before-input-event` input be swallowed? Every ⌘/Ctrl chord
 * except select-all / copy / paste / cut / undo(redo), plus F11-style
 * full-screen toggles. Plain typing, digits, Enter, Escape, Backspace and the
 * arrows reach the page (the keypad and the forms need them).
 */
function isBlockedShortcut(input) {
  if (!input || input.type !== 'keyDown') return false;
  const key = String(input.key || '').toLowerCase();
  if (input.meta || input.control) return !ALLOWED_CHORD_KEYS.has(key) || !!input.alt;
  if (key === 'f11') return true;
  return false;
}

/** The kiosk's application menu: no Quit, Hide, Close, Reload, Zoom or DevTools. */
function kioskMenuTemplate(appName = 'Business Studio KH') {
  return [
    { label: appName, submenu: [{ role: 'about' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ];
}

/** BrowserWindow options for the kiosk window. */
function kioskWindowOptions({ preloadPath, windowed = false, devTools = false }) {
  return {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    kiosk: !windowed,
    fullscreenable: true,
    minimizable: windowed,
    closable: windowed,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f8',
    title: 'Business Studio KH — Attendance',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as the main window (main/index.js): the preload uses require().
      sandbox: false,
      webSecurity: true,
      devTools,
      spellcheck: false,
    },
  };
}

/** Who may turn this Mac into the kiosk: the kiosk account, an HR manager, or the owner's own window. */
function canEnableKiosk(caps) {
  if (!Array.isArray(caps)) return false;
  return caps.includes('*') || caps.includes('attendance.kiosk') || caps.includes('hr.manage');
}

/** The URL of the kiosk screen for a given renderer URL. */
function kioskUrl(baseUrl) {
  return `${String(baseUrl).split('#')[0]}#${KIOSK_HASH}`;
}

/* ─── the window ──────────────────────────────────────────────────── */

function notifyQuitRequested() {
  try {
    if (kioskWin && !kioskWin.isDestroyed()) kioskWin.webContents.send('kioskMode:quitRequested');
  } catch (_) { /* window going away */ }
}

/**
 * Menu, quit guard and shutdown pass-through. Once per process, from the boot
 * path that creates the kiosk window (after `ready`).
 */
function installKioskGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  Menu.setApplicationMenu(Menu.buildFromTemplate(kioskMenuTemplate(app.getName())));
  app.on('before-quit', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    log('kiosk:quit-blocked', 'a manager PIN is needed to close the kiosk');
    notifyQuitRequested();
  });
  // A shutdown, restart or log-out must not be held up by the kiosk.
  try {
    powerMonitor.on('shutdown', () => { allowQuit = true; log('kiosk:shutdown'); });
  } catch (err) {
    log('kiosk:power-monitor-failed', err.message);
  }
  applyLoginItem(loadConfig().kioskOpenAtLogin !== false);
}

/**
 * Create the kiosk window. `rendererUrl` is the same URL the normal window
 * would load (dev server or app://local/index.html).
 */
function createKioskWindow({ preloadPath, rendererUrl }) {
  installKioskGuards();
  const windowed = isWindowedForTesting();
  const win = new BrowserWindow(kioskWindowOptions({ preloadPath, windowed, devTools: !app.isPackaged }));
  kioskWin = win;
  const target = kioskUrl(rendererUrl);

  win.webContents.on('before-input-event', (e, input) => {
    if (isBlockedShortcut(input)) e.preventDefault();
  });
  // A file dropped on the window, or a link, must not navigate away from the kiosk.
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] !== target.split('#')[0]) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.setVisualZoomLevelLimits(1, 1); } catch (_) { /* best-effort */ }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('kiosk:render-process-gone', JSON.stringify(details));
    // Keep the kiosk up: reload the screen rather than leave a blank window.
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(target).catch(() => {}); }, 1000);
  });
  win.on('close', (e) => {
    if (allowQuit || windowed) return;
    e.preventDefault();
    notifyQuitRequested();
  });
  // If anything takes the window out of kiosk / full screen, put it back.
  win.on('leave-full-screen', () => {
    if (!windowed && !allowQuit && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.setKiosk(true); }, 300);
  });
  win.once('ready-to-show', () => {
    win.show();
    if (!windowed) win.setKiosk(true);
    win.focus();
    log('kiosk:window-shown', `kiosk=${win.isKiosk()} windowed=${windowed}`);
  });
  win.on('closed', () => { if (kioskWin === win) kioskWin = null; });
  win.loadURL(target);
  return win;
}

/* ─── login item, camera ─────────────────────────────────────────── */

/** Open at login. Only for the packaged app: in dev it would register the bare Electron binary. */
function applyLoginItem(openAtLogin) {
  if (!app.isPackaged) { log('kiosk:login-item-skipped', `dev build (would set openAtLogin=${!!openAtLogin})`); return; }
  try {
    app.setLoginItemSettings({ openAtLogin: !!openAtLogin });
  } catch (err) {
    log('kiosk:login-item-failed', err.message);
  }
}

function cameraStatus() {
  const fake = !app.isPackaged ? process.env.MSKH_KIOSK_FAKE_CAMERA : null;
  if (fake === 'granted' || fake === 'denied') return fake;
  if (process.platform !== 'darwin') return 'granted';
  try { return systemPreferences.getMediaAccessStatus('camera'); } catch (_) { return 'unknown'; }
}

/**
 * Ask macOS for the camera (the TCC prompt — needs NSCameraUsageDescription,
 * package.json build.mac.extendInfo). Returns 'granted' | 'denied' |
 * 'restricted' | 'not-determined' | 'unknown'. MSKH_KIOSK_FAKE_CAMERA
 * (dev builds only) answers without the prompt, for tests.
 */
async function askCamera() {
  const status = cameraStatus();
  if (status !== 'not-determined') return status;
  try {
    return (await systemPreferences.askForMediaAccess('camera')) ? 'granted' : 'denied';
  } catch (err) {
    log('kiosk:camera-ask-failed', err.message);
    return 'unknown';
  }
}

function scheduleRelaunch(reason) {
  log('kiosk:relaunch', reason);
  setTimeout(() => { app.relaunch(); app.exit(0); }, RELAUNCH_DELAY_MS);
}

/* ─── the kioskMode:* handlers, shared by both registration paths ──── */

const recovery = require('./util/kioskRecovery');
const PENDING_CODE_MS = 15 * 60 * 1000;
// The code shown in the confirmation dialog, as a hash only, until kioskMode:enable commits it.
let pendingRecovery = null;
let recoveryBusy = false;

function recoveryCounters(cfg) {
  return {
    failures: Number(cfg.kioskRecoveryFailures) || 0,
    lockedUntil: Number(cfg.kioskRecoveryLockedUntil) || 0,
    lockCount: Number(cfg.kioskRecoveryLockCount) || 0,
  };
}

const CLEARED_RECOVERY = {
  kioskRecoveryHash: null, kioskRecoverySalt: null,
  kioskRecoveryFailures: 0, kioskRecoveryLockedUntil: 0, kioskRecoveryLockCount: 0,
};

/**
 * @param {object} deps
 * @param {(args: {employeeId, pin, purpose}) => Promise<any>} deps.verifyManagerPin
 *   the server's kiosk:verifyManagerPin (in-process, or over RPC on a client)
 * @param {() => Promise<string[]|null>|string[]|null} deps.getCaps
 *   this Mac's account capabilities ('*' for the owner's own window)
 * @param {() => Promise<boolean>|boolean} [deps.isServerReachable]
 *   can the office Mac answer for this account right now? The recovery code is
 *   refused while it can (a manager PIN is the way out then). Always true on a
 *   standalone / server Mac, whose data is local.
 */
function makeKioskModeHandlers({ verifyManagerPin, getCaps, isServerReachable = () => true }) {
  async function assertMayEnable() {
    const caps = await Promise.resolve().then(getCaps).catch(() => null);
    if (caps == null) throw new Error('Could not check this Mac\'s account. Connect to the office Mac first, then try again.');
    if (!canEnableKiosk(caps)) {
      throw new Error('This account cannot run the attendance kiosk. Connect this Mac with the shop kiosk account (permission "Shop kiosk") or a manager account.');
    }
  }

  return {
    status: async () => {
      const cfg = loadConfig();
      const caps = await Promise.resolve().then(getCaps).catch(() => null);
      return {
        enabled: isKioskMode(cfg),
        openAtLogin: cfg.kioskOpenAtLogin !== false,
        mode: cfg.mode,
        canEnable: canEnableKiosk(caps),
        camera: cameraStatus(),
        packaged: app.isPackaged,
        windowed: isWindowedForTesting(),
        hasRecoveryCode: !!cfg.kioskRecoveryHash,
        recoveryLockedUntil: recovery.lockState(recoveryCounters(cfg)).retryAt || null,
      };
    },

    askCamera: async () => ({ status: await askCamera() }),

    /** Step 1 of turning kiosk mode on: a fresh recovery code, returned ONCE; only its hash is kept. */
    newRecoveryCode: async () => {
      await assertMayEnable();
      const code = recovery.generateCode();
      pendingRecovery = { ...(await recovery.hashCode(code)), expiresAt: Date.now() + PENDING_CODE_MS };
      return { code };
    },

    /** Step 2: commit the code just shown, turn kiosk mode on, relaunch. */
    enable: async ({ openAtLogin = true } = {}) => {
      await assertMayEnable();
      if (!pendingRecovery || pendingRecovery.expiresAt < Date.now()) {
        pendingRecovery = null;
        throw new Error('Show the recovery code first (it is part of turning kiosk mode on), then try again.');
      }
      updateConfig({
        ...CLEARED_RECOVERY,
        kioskMode: true,
        kioskOpenAtLogin: openAtLogin !== false,
        kioskRecoveryHash: pendingRecovery.hash,
        kioskRecoverySalt: pendingRecovery.salt,
      });
      pendingRecovery = null;
      applyLoginItem(openAtLogin !== false);
      log('kiosk:enabled', `openAtLogin=${openAtLogin !== false} recoveryCode=set`);
      scheduleRelaunch('kiosk mode on');
      return { ok: true };
    },

    leave: async ({ employeeId, pin } = {}) => {
      if (!isKioskMode(loadConfig())) throw new Error('This Mac is not in kiosk mode.');
      await verifyManagerPin({ employeeId, pin, purpose: 'leave' });
      updateConfig({ ...CLEARED_RECOVERY, kioskMode: false });
      applyLoginItem(false);
      log('kiosk:left', `manager=${employeeId}`);
      scheduleRelaunch('kiosk mode off');
      return { ok: true };
    },

    /**
     * The way out when the office Mac is gone: the recovery code. Refused while
     * the office Mac answers; 5 wrong codes → a local cooldown (15 min, doubling).
     * One attempt at a time.
     */
    recover: async ({ code } = {}) => {
      if (recoveryBusy) throw new Error('One moment — the last code is still being checked.');
      recoveryBusy = true;
      try {
        const cfg = loadConfig();
        if (!isKioskMode(cfg)) throw new Error('This Mac is not in kiosk mode.');
        if (!cfg.kioskRecoveryHash || !cfg.kioskRecoverySalt) {
          throw new Error('No recovery code was set when this kiosk was turned on. A manager uses their PIN when the office Mac is back.');
        }
        const counters = recoveryCounters(cfg);
        const lock = recovery.lockState(counters);
        if (lock.locked) throw new Error(`Too many wrong recovery codes. Try again in ${Math.ceil(lock.retryInSeconds / 60)} min.`);
        const reachable = await Promise.resolve().then(isServerReachable).catch(() => false);
        if (reachable) throw new Error('The office Mac can be reached, so the recovery code is not needed: a manager uses their PIN instead.');
        const correct = await recovery.verifyCode(code, { hash: cfg.kioskRecoveryHash, salt: cfg.kioskRecoverySalt });
        const next = recovery.afterAttempt(counters, { correct });
        if (!correct) {
          updateConfig({ kioskRecoveryFailures: next.failures, kioskRecoveryLockedUntil: next.lockedUntil, kioskRecoveryLockCount: next.lockCount });
          log('kiosk:recovery-wrong', next.locked ? `locked ${next.lockMinutes} min (lock ${next.lockCount})` : `${next.triesLeft} tries left`);
          if (next.locked) throw new Error(`Wrong recovery code. Too many wrong recovery codes: try again in ${next.lockMinutes} min.`);
          throw new Error(`Wrong recovery code. ${next.triesLeft} ${next.triesLeft === 1 ? 'try' : 'tries'} left.`);
        }
        updateConfig({ ...CLEARED_RECOVERY, kioskMode: false });
        applyLoginItem(false);
        log('kiosk:recovery-used', 'kiosk mode turned off with the recovery code (office Mac unreachable)');
        scheduleRelaunch('kiosk mode off (recovery code)');
        return { ok: true };
      } finally {
        recoveryBusy = false;
      }
    },

    quit: async ({ employeeId, pin } = {}) => {
      await verifyManagerPin({ employeeId, pin, purpose: 'quit' });
      log('kiosk:quit', `manager=${employeeId}`);
      allowQuit = true;
      setTimeout(() => app.quit(), RELAUNCH_DELAY_MS);
      return { ok: true };
    },
  };
}

module.exports = {
  KIOSK_HASH,
  configureKiosk,
  isKioskMode,
  createKioskWindow,
  makeKioskModeHandlers,
  // pure, for tests
  isBlockedShortcut,
  kioskMenuTemplate,
  kioskWindowOptions,
  canEnableKiosk,
  kioskUrl,
};
