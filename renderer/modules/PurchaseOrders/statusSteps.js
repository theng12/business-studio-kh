/**
 * Wording for a multi-step status change that stopped part-way.
 *
 * "Close a PO that was never received" runs two steps — received, then closed
 * — because only a received PO records landed cost. When the first lands and
 * the second fails, the PO really is Received, and the toast has to say so
 * rather than a vague "Failed to change status" that reads as nothing changed.
 */
const DONE = {
  draft: 'Moved back to draft',
  ordered: 'Marked ordered',
  in_transit: 'Marked in transit',
  received: 'Marked received',
  closed: 'Closed',
};

const DOING = {
  draft: 'moving it back to draft',
  ordered: 'marking it ordered',
  in_transit: 'marking it in transit',
  received: 'marking it received',
  closed: 'closing',
};

/**
 * @param {string[]} steps   statuses applied in order
 * @param {number}   done    how many of them succeeded (0 < done < steps.length)
 * @param {Error|string} err the failure of steps[done]
 * @param {(s: string) => string} statusLabel  STATUS_LABEL from ./index.jsx
 */
export function partialStatusChangeText(steps, done, err, statusLabel = (s) => s) {
  const landed = steps[done - 1];
  const failed = steps[done];
  const reason = String(err?.message ?? err ?? 'unknown error').replace(/[.\s]+$/, '');
  return `${DONE[landed] || `Set to ${statusLabel(landed)}`}, but ${DOING[failed] || `setting ${statusLabel(failed)}`} failed: ${reason}. The PO is now ${statusLabel(landed)}.`;
}
