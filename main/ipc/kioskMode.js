/**
 * HR1: the kiosk Mac's own switch — kioskMode:* (LOCAL channels; they act on
 * this Mac's config.json, login item, camera permission and window).
 *
 * Standalone / server half. Client mode registers the same five names with
 * handleLocal() in main/client/index.js; both build their handlers from
 * makeKioskModeHandlers() in main/kioskWindow.js, so the rules are one copy
 * (AGENTS.md §15). The difference is only where the manager PIN is checked:
 * here in-process (main/ipc/kiosk.js verifyManagerPin), there over RPC.
 *
 * The owner's own window on a standalone or server Mac is not capability-gated
 * (same as every local call), so `getCaps` is ['*'] here.
 */

const { makeKioskModeHandlers } = require('../kioskWindow');

function register({ exposeLocal }) {
  const h = makeKioskModeHandlers({
    verifyManagerPin: (args) => require('./kiosk').verifyManagerPin(args),
    getCaps: () => ['*'],
    // The data is on this Mac: the office Mac is never "unreachable" here, so
    // the recovery code is refused and a manager PIN is the way out.
    isServerReachable: () => true,
  });
  exposeLocal('kioskMode:status', () => h.status());
  exposeLocal('kioskMode:askCamera', () => h.askCamera());
  exposeLocal('kioskMode:newRecoveryCode', () => h.newRecoveryCode());
  exposeLocal('kioskMode:enable', (args) => h.enable(args || {}));
  exposeLocal('kioskMode:recover', (args) => h.recover(args));
  exposeLocal('kioskMode:leave', (args) => h.leave(args));
  exposeLocal('kioskMode:quit', (args) => h.quit(args));
}

module.exports = { register };
