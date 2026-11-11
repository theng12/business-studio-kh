const os = require('node:os');
const { app, shell } = require('electron');
const { checkForUpdate } = require('../util/feedCheck');

// Machine-local in every mode: this Mac's publisher.json and feed are what
// matter, so client mode registers the same two handlers below.
function check() {
  return checkForUpdate({
    homeDir: os.homedir(),
    bundleID: 'com.terranash.mediastudiokh',
    installedVersion: app.getVersion(),
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

