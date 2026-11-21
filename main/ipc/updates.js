const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, shell } = require('electron');
const { checkForUpdate } = require('../util/feedCheck');

// The updater reads CFBundleShortVersionString from the installed bundle, so
// the check must read the same field, not a build stamp. Outside a bundle
// (npm run dev) the package version is the fallback.
function installedVersion() {
  if (app.isPackaged) {
    try {
      const plist = path.join(path.dirname(process.execPath), '..', 'Info.plist');
      const value = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim();
      if (value) return value;
    } catch { /* fall through to the package version */ }
  }
  return app.getVersion();
}

// Machine-local in every mode: this Mac's enrolled base/config.json and feed are what
// matter, so client mode registers the same two handlers below.
function check() {
  return checkForUpdate({
    homeDir: os.homedir(),
    bundleID: 'app.businessstudiokh.desktop',
    installedVersion: installedVersion(),
    fetchImpl: (url) => fetch(url, { signal: AbortSignal.timeout(8000) }),
  });
}

async function openUpdater() {
  // Fail closed (owner 2026-11-19): an app that could not open its update-hold
  // port cannot be paused for an update, so it does not start one. Quitting it
  // first still works — the installer installs an app that is not running.
  if (!require('../updateHold').isAvailable()) {
    throw new Error('Updates are paused: this app could not open its update-hold port, so an automatic update could not pause it safely. Quit Business Studio KH and update it from Studio Launcher KH.');
  }
  for (const name of ['Studio Launcher KH', 'Update Studio KH']) {
    try {
      const error = await shell.openPath(`/Applications/${name}.app`);
      if (!error) return { ok: true, app: name };
    } catch { /* Try the other updater. */ }
  }
  throw new Error('Could not open Studio Launcher KH or Update Studio KH');
}

function register({ exposeLocal }) {
  exposeLocal('updates:check', () => check());
  exposeLocal('updates:openUpdater', () => openUpdater());
}

module.exports = { register, check, openUpdater };

