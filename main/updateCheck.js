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

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];

/* The hold's "listening" log can only run once the main thread is free — during
 * startup DB work the shim's single 5 s hold POST would time out — so this gate
 * is also the "startup is done" signal. A port that never binds starts nothing.
 * Also tracks whether the hold endpoint later answered safe:true ("settled in
 * under …"), because the shim keeps its last error across retries. */
function createHoldStartGate({ log = () => {}, startCheck = (opts) => startUpdateCheck({ log, ...opts }) } = {}) {
  let started = false;
  let holdSettled = false;
  return (message) => {
    const text = String(message);
    if (!started) {
      if (!text.startsWith('listening on ')) return false;
      started = true;
      startCheck({ isHoldGranted: () => holdSettled });
      return true;
    }
    if (text.startsWith('settled in under ')) holdSettled = true;
    return false;
  };
}

function startUpdateCheck({
  log = () => {}, packaged, addon: suppliedAddon, schedule = setTimeout,
  maxAttempts = MAX_ATTEMPTS, retryDelays = RETRY_DELAYS_MS,
  isHoldGranted = () => false,
} = {}) {
  const isPackaged = packaged ?? require('electron').app.isPackaged;
  if (!isPackaged) {
    log('kh-sparkle:skipped', 'development build');
    return null;
  }
  let addon = suppliedAddon;
  if (!addon) {
    try {
      addon = require(path.join(process.resourcesPath, 'native', 'khsparkle.node'));
    } catch (err) {
      log('kh-sparkle:unavailable', err.message);
      return null;
    }
  }

  let attempt = 0;
  let pendingReason = '';
  let pendingDelay = 0;
  let awaitingFailure = false;
  const start = () => {
    attempt += 1;
    log('kh-sparkle:started', pendingDelay || pendingReason
      ? `attempt ${attempt}/${maxAttempts} in ${pendingDelay}ms${pendingReason ? ` after ${pendingReason}` : ''}`
      : `attempt ${attempt}/${maxAttempts}`);
    try {
      awaitingFailure = true;
      const rc = addon.start();
      if (rc !== 0) {
        // A synchronous refusal is a bundle/queue problem; no hold was tried.
        awaitingFailure = false;
        log('kh-sparkle:refused', `${addon.lastError()} (rc ${rc})`);
        return;
      }
    } catch (err) {
      awaitingFailure = false;
      log('kh-sparkle:failed', `${err.message} on attempt ${attempt}`);
    }
  };

  try {
    addon.setStateCallback((state) => {
      log('kh-sparkle:state', String(state));
      if (state !== 0) {
        awaitingFailure = false; // 1 = update found, 2 = relaunching: the failure window is closed
        return;
      }
      if (!awaitingFailure) return;
      awaitingFailure = false;
      const reason = String(addon.lastError() || '').trim();
      if (!reason) return; // "no update" ends the check; only a hold failure retries
      // Only a pre-Sparkle hold refusal ("refused: …") leaves gUpdater nil so
      // another addon.start() can try again. Once the hold was granted, any
      // "refused:" string in lastError() is stale from an earlier try, and
      // post-hold errors ("updater error …") cannot be retried by addon.start().
      if (!reason.startsWith('refused:')) {
        log('kh-sparkle:error', reason);
        return;
      }
      if (isHoldGranted()) return;
      if (attempt >= maxAttempts) {
        log('kh-sparkle:giveup', `after ${attempt} tries: ${reason}`);
        return;
      }
      pendingReason = reason;
      pendingDelay = retryDelays[attempt - 1] ?? retryDelays[retryDelays.length - 1] ?? 0;
      schedule(start, pendingDelay)?.unref?.();
    });
    start();
    return addon;
  } catch (err) {
    log('kh-sparkle:failed', err.message);
    return null;
  }
}

module.exports = { createHoldStartGate, startUpdateCheck };
