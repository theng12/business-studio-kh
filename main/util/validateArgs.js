/**
 * v0.1.17: argument validation, extracted so BOTH registration styles use it.
 *
 * Why this module exists. `expose()` (main/ipc/helpers.js) validates every
 * channel it registers, but it also publishes the channel to the RPC registry
 * for remote clients. Some channels must NEVER be reachable that way — they
 * open a native file dialog, read a path on THIS Mac, or change this Mac's
 * settings, so a remote client calling them would act on the wrong machine:
 *
 *     files:pickFolder        opens a dialog on whichever Mac runs the handler
 *     files:readImageThumb    reads an absolute path on that Mac's disk
 *     settings:changeDataFolder   moves that Mac's data folder
 *     backups:restore         overwrites that Mac's database
 *
 * Those channels were therefore registered with a bare `ipcMain.handle`, and
 * they silently got NO validation at all — 57 of them, 42 of which the screens
 * call. That is the gap this fixes: `exposeLocal()` registers local-only
 * channels that still validate.
 *
 * The validation itself lives here rather than in helpers.js for one reason:
 * helpers.js pulls in the DB and the server registry at module scope, which is
 * fine on the server/standalone but wrong in client mode. This file depends on
 * nothing but the validators, so client-mode code can use the same rule.
 *
 * Deliberately NOT a silent pass. A channel with no validator is a gap, and
 * `test/validatorCoverage.test.js` fails on it — that test is what keeps this
 * from quietly rotting back. The runtime behaviour for an uncovered channel is
 * to allow it, because failing closed here would turn a missing validator into
 * a broken feature, which is how the v0.1.14 outage happened.
 */

/**
 * Throw `Bad request: <reason>` when `args` fails the channel's shape check.
 * Returns silently when the channel is exempt or has no validator.
 *
 * The message is deliberately shaped to match what the RPC dispatcher returns
 * for the same bad input, so the caller sees one wording regardless of how it
 * was invoked. Handlers `throw new Error(...)` and the renderer shows
 * `err.message`, so this reaches the user as a readable toast.
 *
 * The validator is resolved at CALL time rather than registration time, so
 * channels registered before validators.js is reachable still get validated
 * and there is no load-order coupling between the two modules.
 */
function validateArgs(channel, args) {
  let getValidator;
  try {
    ({ getValidator } = require('../server/validators'));
  } catch (err) {
    // Could not load the validator module. Fail open so the app keeps working,
    // but record it — silently running unvalidated should not be a state we
    // can end up in without anyone noticing.
    process.stderr.write(`[ipc.validate] validator module unavailable for ${channel}: ${err.message}\n`);
    return;
  }
  const validate = getValidator(channel);
  if (!validate) return; // uncovered channel — allowed, but the coverage test fails on it
  const result = validate(args);
  // Propagate: rejecting bad input is the whole point of this function.
  if (result !== true) throw new Error(`Bad request: ${result}`);
}

module.exports = { validateArgs };
