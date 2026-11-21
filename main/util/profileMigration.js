/**
 * 0.1.120 — the app was renamed from Business Studio KH, and Electron names the
 * profile folder after the app. config.json inside it holds the AI key, the
 * client token and the data-folder path, so a first launch on an empty profile
 * would look like everything was lost.
 *
 * Pure of Electron so the rule can be tested with real temp folders. The
 * caller passes the Application Support root and the two names. The user's
 * data folder is never touched here — config.json keeps pointing at whatever
 * it already held.
 */
const fs = require('node:fs');
const path = require('node:path');

function adoptProfile({ base, fromName, toName, fileSystem = fs }) {
  const from = path.join(base, fromName);
  const to = path.join(base, toName);
  if (!fileSystem.existsSync(from)) return { status: 'nothing-to-do' };
  if (!fileSystem.existsSync(to)) {
    fileSystem.renameSync(from, to);
    return { status: 'moved', from, to };
  }
  // A profile already exists under the new name (an early dev run): keep it
  // and only bring the settings across when it has none of its own. Never
  // overwrite a newer config.json.
  const fromConfig = path.join(from, 'config.json');
  const toConfig = path.join(to, 'config.json');
  if (!fileSystem.existsSync(toConfig) && fileSystem.existsSync(fromConfig)) {
    fileSystem.copyFileSync(fromConfig, toConfig);
    return { status: 'config-copied', from: fromConfig, to: toConfig };
  }
  return { status: 'kept-both' };
}

module.exports = { adoptProfile };
