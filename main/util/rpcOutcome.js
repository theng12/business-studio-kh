/**
 * Helpers for distinguishing a bounded network timeout from an ordinary
 * server/network error. A timed-out write is not known to have failed: the
 * server may still be inside its handler after the client aborts its fetch.
 */

const READ_ACTIONS = new Set([
  'get', 'list', 'count', 'search', 'preview', 'last', 'presence',
  'capabilities', 'whoami', 'status', 'addresses', 'ping', 'stats',
]);

function isLikelyMutationChannel(channel) {
  if (typeof channel !== 'string') return false;
  const action = channel.split(':').slice(1).join(':');
  return !!action && !READ_ACTIONS.has(action);
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT') return true;
  return err.name === 'AbortError' && /timeout|timed out|deadline/i.test(String(err.message || ''));
}

function mutationOutcomeUnknown(channel, cause) {
  const err = new Error(
    `The request for ${channel} timed out before the server confirmed the result. ` +
    'The operation may still have completed; refresh the current data before retrying.',
    { cause },
  );
  err.code = 'RPC_OUTCOME_UNKNOWN';
  err.channel = channel;
  return err;
}

module.exports = { isLikelyMutationChannel, isTimeoutError, mutationOutcomeUnknown };
