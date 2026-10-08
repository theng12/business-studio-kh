/**
 * Errors a handler throws ON PURPOSE — a refusal the person can act on ("That
 * time is in the future", "Wrong PIN", "Staff member not found") — as opposed
 * to something that broke. Over /api/rpc the first kind is answered with HTTP
 * 422 and the second stays 500, so a phone's outbox, the desktop client and
 * the logs can tell "the server said no" from "the server failed". The message
 * is the same either way; local IPC is unchanged.
 *
 * Mark an error with `userError(message, code)`, or set `err.userFacing = true`.
 * Errors carrying one of USER_ERROR_CODES (badRequest's BAD_REQUEST, the fuel /
 * HR refusal codes) count too, so existing throw sites need no change.
 */

const USER_ERROR_CODES = new Set([
  'BAD_REQUEST', 'NOT_FOUND', 'CROSS_COMPANY', 'CLIENT_REF_CONFLICT', 'HAS_HISTORY',
  'PIN_WRONG', 'PIN_LOCKED', 'KIOSK_PAUSED', 'KIOSK_SESSION_ENDED', 'NOT_LINKED', 'PHOTO_RETIRED',
]);

function userError(message, code = 'USER_ERROR') {
  const err = new Error(message);
  err.code = code;
  err.userFacing = true;
  return err;
}

function isUserFacing(err) {
  return !!err && (err.userFacing === true || USER_ERROR_CODES.has(err.code));
}

module.exports = { userError, isUserFacing, USER_ERROR_CODES, USER_ERROR_STATUS: 422 };
