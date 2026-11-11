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

// Machine-local in every mode: this Mac's publisher.json and feed are what
// matter, so client mode registers the same two handlers below.
function check() {
  return checkForUpdate({
    homeDir: os.homedir(),
    bundleID: 'com.terranash.mediastudiokh',
    installedVersion: installedVersion(),
    fetchImpl: (url) => fetch(url, { signal: AbortSignal.timeout(8000) }),
  });
}

async function openUpdater() {
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

