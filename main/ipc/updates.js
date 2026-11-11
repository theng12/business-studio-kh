const os = require('node:os');
const { app, shell } = require('electron');
const { checkForUpdate } = require('../util/feedCheck');

function register({ exposeLocal }) {
  exposeLocal('updates:check', () => checkForUpdate({
    homeDir: os.homedir(),
    bundleID: 'com.terranash.mediastudiokh',
    installedVersion: app.getVersion(),
    fetchImpl: (url) => fetch(url, { signal: AbortSignal.timeout(8000) }),
  }));

  exposeLocal('updates:openUpdater', async () => {
    for (const name of ['Studio Launcher KH', 'Update Studio KH']) {
      try {
        const error = await shell.openPath(`/Applications/${name}.app`);
        if (!error) return { ok: true, app: name };
      } catch { /* Try the other updater. */ }
    }
    throw new Error('Could not open Studio Launcher KH or Update Studio KH');
  });
}

module.exports = { register };
