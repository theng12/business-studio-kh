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
 *     a manager PIN instead (kioskMode:quit) — but only for 45 s. An installer
 *     quits by the same AppleEvent a person does and nobody is there to answer,
 *     so a quit nobody answers is released, logged, at the end of that budget
 *     (an export or render in flight holds it, up to the budget). A person
 *     keeps the kiosk: dismissing the prompt (kioskMode:quitDismissed) or
 *     trying a PIN calls the release off. A system shutdown / restart / log-out
 *     is let through (powerMonitor 'shutdown'), so the shop Mac can still be
 *     turned off;
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
 * The eight `kioskMode:*` channels are LOCAL (they act on this Mac): registered
 * with exposeLocal() in main/ipc/kioskMode.js and handleLocal() in
 * main/client/index.js, both from `makeKioskModeHandlers` below, both validated
 * by main/server/hrValidators.js.
 */

const { app, BrowserWindow, Menu, powerMonitor, systemPreferences } = require('electron');
const { loadConfig, updateConfig } = require('./config');

const KIOSK_HASH = 'kiosk';
const KIOSK_WINDOW_ARG = '--mskh-kiosk-window';
const RELAUNCH_DELAY_MS = 300;

/**
 * An unattended quit (an installer's AppleEvent) waits this long for work in
 * flight, then quits anyway. Under the Updater's 60 s quit wait
 * (kh-updater Recipes.quit, `wait: 60`), so a released kiosk still finishes
 * the install instead of being reported as "the app did not quit".
 * A test shortens it with MSKH_KIOSK_UNATTENDED_QUIT_MS rather than waiting 45 s.
 */
const UNATTENDED_QUIT_BUDGET_MS = Number(process.env.MSKH_KIOSK_UNATTENDED_QUIT_MS) || 45 * 1000;
/** How often the deadline is re-checked while an export or render holds the quit. */
const UNATTENDED_QUIT_RETRY_MS = 500;

let log = (event, detail) => process.stdout.write(`[kiosk] ${event}${detail ? ` :: ${detail}` : ''}\n`);
let allowQuit = false;
let guardsInstalled = false;
let kioskWin = null;
let unattendedQuitTimer = null;

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
function kioskMenuTemplate(appName = 'Media Studio KH') {
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
    title: 'Media Studio KH — Attendance',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as the main window (main/index.js): the preload uses require().
      sandbox: false,
      webSecurity: true,
      devTools,
      spellcheck: false,
      // The renderer learns it is THE kiosk window from main, not from the URL
      // (preload → window.api.kioskMode.isKioskWindow; renderer/main.jsx).
      additionalArguments: [KIOSK_WINDOW_ARG],
    },
  };
}

/** Who may turn this Mac into the kiosk: the kiosk account, an HR manager, or the owner's own window. */
function canEnableKiosk(caps) {
  if (!Array.isArray(caps)) return false;
  return caps.includes('*') || caps.includes('attendance.kiosk') || caps.includes('hr.manage');
}

/** Only the exact kiosk URL may load in the kiosk window. */
function isKioskNavigationAllowed(url, target) {
  return String(url) === String(target);
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
 * Is a job the app must not abandon halfway through running right now? An
 * export or a client-mode render is tracked; an import or an image edit is a
 * single server call, so an unattended quit lands between rows (the database
 * is WAL and every write commits on its own) rather than inside one.
 */
function isWorkInProgress() {
  try {
    return require('./ipc/exports').hasActiveRun() || require('./renderWindow').isRendering();
  } catch (_) {
    return false;  // never hold an installer hostage to a lookup failure
  }
}

/**
 * The end of the budget: a person had UNATTENDED_QUIT_BUDGET_MS to answer the
 * PIN prompt and did not, so this quit is unattended (an installer's) and is
 * released. Work mid-task is not forced: that cycle is skipped and the Updater
 * tries again, as it does for any busy app.
 */
function releaseUnansweredQuit(deadline, reason) {
  if (allowQuit) { unattendedQuitTimer = null; return; }
  if (Date.now() < deadline) {
    unattendedQuitTimer = setTimeout(() => releaseUnansweredQuit(deadline, reason), UNATTENDED_QUIT_RETRY_MS);
    return;
  }
  unattendedQuitTimer = null;
  if (isWorkInProgress()) {
    log('kiosk:quit-skipped', `${reason}: work in flight, so this update waits for the next try`);
    return;
  }
  allowQuit = true;
  log('kiosk:unattended-quit', `${reason}: released`);
  // Quit the ordinary way, so index.js still stops the server and frees the
  // port; the hard exit below is the net for a server that will not stop.
  app.quit();
  setTimeout(() => { log('kiosk:unattended-quit-exit', 'the app did not quit in time; exiting'); app.exit(0); }, 10000).unref?.();
}

/**
 * A person at the kiosk answered the prompt (a PIN was tried, or the prompt was
 * dismissed): the kiosk stays, and the release above is called off. Nothing
 * else cancels it — an installer has nobody to press anything.
 */
function cancelUnansweredQuit(why) {
  if (!unattendedQuitTimer) return false;
  clearTimeout(unattendedQuitTimer);
  unattendedQuitTimer = null;
  log('kiosk:quit-kept', why);
  return true;
}

/**
 * Menu, quit guard and shutdown pass-through. Once per process, from the boot
 * path that creates the kiosk window (after `ready`).
 *
 * A quit (Dock, `osascript … quit`, the Updater's install) is refused and the
 * screen asks for a manager PIN — but only for UNATTENDED_QUIT_BUDGET_MS. An
 * installer's quit is the same AppleEvent a person's is, and nobody is there to
 * answer it, so refusing it forever is what made every unattended update fail
 * (the 0.1.110 updater bug). A person keeps the kiosk by dismissing the prompt
 * or trying a PIN: either calls cancelUnansweredQuit().
 */
function installKioskGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  Menu.setApplicationMenu(Menu.buildFromTemplate(kioskMenuTemplate(app.getName())));
  app.on('before-quit', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    if (!unattendedQuitTimer) {
      log('kiosk:quit-blocked', `a manager PIN is needed to close the kiosk; released in ${Math.round(UNATTENDED_QUIT_BUDGET_MS / 1000)} s if nobody answers`);
      const deadline = Date.now() + UNATTENDED_QUIT_BUDGET_MS;
      // The timer is also the poll tick: it holds while work is in flight, up to the deadline.
      unattendedQuitTimer = setTimeout(
        () => releaseUnansweredQuit(deadline, 'nobody answered the manager PIN prompt'),
        UNATTENDED_QUIT_RETRY_MS,
      );
    }
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
  // A file dropped on the window, a link or a changed hash: nothing but the exact kiosk URL.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isKioskNavigationAllowed(url, target)) e.preventDefault();
  });
  win.webContents.on('will-redirect', (e, url) => {
    if (!isKioskNavigationAllowed(url, target)) e.preventDefault();
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
 *   client Mac only: can the office Mac answer for this account right now? The
 *   recovery code is refused while it can (a manager PIN is the way out then).
 *   On a standalone / server Mac there is no office Mac, and the code works
 *   whenever no manager PIN does.
 * @param {() => Promise<number>|number} [deps.countManagersWithPin]
 *   standalone / server only (the data is local): active staff who are managers
 *   and have a PIN. Enabling is refused at 0. A client cannot see who is a
 *   manager, so it does not check.
 */
function makeKioskModeHandlers({ verifyManagerPin, getCaps, isServerReachable = () => false, countManagersWithPin = null }) {
  async function assertMayEnable() {
    const caps = await Promise.resolve().then(getCaps).catch(() => null);
    if (caps == null) throw new Error('Could not check this Mac\'s account. Connect to the office Mac first, then try again.');
    if (!canEnableKiosk(caps)) {
      throw new Error('This account cannot run the attendance kiosk. Connect this Mac with the shop kiosk account (permission "Shop kiosk") or a manager account.');
    }
    // On the Mac that holds the data, check there is a way out before locking the screen:
    // at least one active staff member who is a manager (account with hr.manage) and has a PIN.
    if (countManagersWithPin) {
      const n = await Promise.resolve().then(countManagersWithPin).catch(() => 0);
      if (!n) {
        throw new Error('No manager can leave kiosk mode yet. Link a manager\'s staff record to their account (with "Manage staff & attendance") and give them a kiosk PIN in People → Staff first.');
      }
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
        // Client: the code works only while the office Mac cannot answer. Standalone / server: always (no office Mac to lose).
        recoveryNeedsOffline: cfg.mode === 'client',
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
        // Client Mac: refused while the office Mac answers (a manager PIN is the way out then).
        // Standalone / server: there is no office Mac — the code works whenever no manager PIN does.
        if (cfg.mode === 'client') {
          const reachable = await Promise.resolve().then(isServerReachable).catch(() => false);
          if (reachable) throw new Error('The office Mac can be reached, so the recovery code is not needed: a manager uses their PIN instead.');
        }
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

    /** The kiosk screen crashed (renderer/modules/Kiosk/KioskErrorBoundary.jsx): one line to crash.log. */
    logError: ({ message, stack } = {}) => {
      log('kiosk:render-error', `${String(message || '').slice(0, 500)}${stack ? ` :: ${String(stack).split('\n').slice(0, 4).join(' | ').slice(0, 1000)}` : ''}`);
      return { ok: true };
    },

    quit: async ({ employeeId, pin } = {}) => {
      try {
        await verifyManagerPin({ employeeId, pin, purpose: 'quit' });
      } catch (err) {
        cancelUnansweredQuit('a manager PIN was tried, so someone is at the kiosk');   // wrong PIN: the kiosk stays
        throw err;
      }
      log('kiosk:quit', `manager=${employeeId}`);
      cancelUnansweredQuit('a manager PIN allowed the quit');
      allowQuit = true;
      setTimeout(() => app.quit(), RELAUNCH_DELAY_MS);
      return { ok: true };
    },

    /** A person dismissed the quit prompt: the kiosk stays (see cancelUnansweredQuit). */
    quitDismissed: async () => {
      cancelUnansweredQuit('someone dismissed the quit prompt');
      return { ok: true };
    },
  };
}

module.exports = {
  KIOSK_HASH,
  UNATTENDED_QUIT_BUDGET_MS,
  configureKiosk,
  isKioskMode,
  createKioskWindow,
  installKioskGuards,
  makeKioskModeHandlers,
  KIOSK_WINDOW_ARG,
  // pure, for tests
  isWorkInProgress,
  cancelUnansweredQuit,
  isKioskNavigationAllowed,
  isBlockedShortcut,
  kioskMenuTemplate,
  kioskWindowOptions,
  canEnableKiosk,
  kioskUrl,
};
