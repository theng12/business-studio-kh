/**
 * Sparkle update check, through the shared shim (libkhsparkle.a) bridged by
 * native/khsparkle.node. The shim takes the app's own update hold first and
 * refuses rather than checking without it; every refusal is logged with its
 * reason and changes nothing else.
 *
 * Config comes from the bundle's Info.plist: SUFeedURL, SUPublicEDKey,
 * KHHoldURL, KHHoldTokenFile. 0.1.125 is the first version to carry SUFeedURL —
 * the appcast address answers 200 anonymously, and the gate asserts it from the
 * mounted image before the build is released (lead/0.1.125/appcast-check.sh).
 * A bundle without one is still refused (rc 2) and logged, never assumed quiet.
 */

const path = require('node:path');

function startUpdateCheck({ log = () => {}, packaged } = {}) {
  const isPackaged = packaged ?? require('electron').app.isPackaged;
  if (!isPackaged) {
    log('kh-sparkle:skipped', 'development build');
    return null;
  }
  let addon;
  try {
    addon = require(path.join(process.resourcesPath, 'native', 'khsparkle.node'));
  } catch (err) {
    log('kh-sparkle:unavailable', err.message);
    return null;
  }
  try {
    addon.setStateCallback((state) => log('kh-sparkle:state', String(state)));
    const rc = addon.start();
    if (rc !== 0) log('kh-sparkle:refused', `${addon.lastError()} (rc ${rc})`);
    else log('kh-sparkle:started', '');
    return addon;
  } catch (err) {
    log('kh-sparkle:failed', err.message);
    return null;
  }
}

module.exports = { startUpdateCheck };
