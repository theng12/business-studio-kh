/**
 * Helpers for distinguishing a bounded network timeout from an ordinary
 * server/network error. A timed-out write is not known to have failed: the
 * server may still be inside its handler after the client aborts its fetch.
 */

const READ_ACTIONS = new Set([
  'get', 'list', 'count', 'search', 'preview', 'last', 'presence',
  'capabilities', 'whoami', 'status', 'addresses', 'ping', 'stats',
  // Connectivity pass: whole-word reads that are not covered by the prefixes
  // below. A timed-out read must not tell the user it "may still have
  // completed" — there is nothing to complete.
  'completeness', 'estimateCost',
]);

// Read verbs used as a prefix: `getActiveId`, `listByProduct`, `listRuns`,
// `recentBrands`, `countForEntity`, `getApplyOutcome`… Every channel the app
// registers with one of these prefixes only reads (checked when this was added:
// none of `get*` / `list*` / `count*` / `recent*` writes anything).
const READ_PREFIX = /^(get|list|count|recent)[A-Z]/;
// Whole-channel exceptions: these actions have no general read meaning.
const READ_CHANNELS = new Set(['loans:project', 'loans:importColumns', 'loans:importPlan',
  'payroll:fetchSalaryTaxRate', 'kiosk:payroll', 'kiosk:loans']);

function isReadAction(action) {
  return READ_ACTIONS.has(action) || READ_PREFIX.test(action);
}

function isLikelyMutationChannel(channel) {
  if (typeof channel !== 'string') return false;
  if (READ_CHANNELS.has(channel)) return false;
  const action = channel.split(':').slice(1).join(':');
  return !!action && !isReadAction(action);
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT') return true;
  return err.name === 'AbortError' && /timeout|timed out|deadline/i.test(String(err.message || ''));
}

function mutationOutcomeUnknown(channel, cause) {
  const err = new Error(
    // §18: plain words — the channel name rides on err.channel and in the
    // log, not in the sentence the user reads.
    'The server Mac stopped answering before it confirmed this change. ' +
    'The operation may still have completed; refresh the current data before retrying.',
    { cause },
  );
  err.code = 'RPC_OUTCOME_UNKNOWN';
  err.channel = channel;
  return err;
}

module.exports = { isLikelyMutationChannel, isReadAction, isTimeoutError, mutationOutcomeUnknown };
