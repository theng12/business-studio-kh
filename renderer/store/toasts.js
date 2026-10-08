// Toasts slice — single-line auto-dismissing notifications.

const TOAST_DURATION_MS = 3000;
// A toast with an action button (Undo) stays long enough to reach it.
export const ACTION_TOAST_DURATION_MS = 6000;

/** A valid `{ label, onClick }` action, or null. Pure, for tests. */
export function toastAction(action) {
  if (!action || typeof action.onClick !== 'function') return null;
  const label = String(action.label ?? '').trim();
  return label ? { label, onClick: action.onClick } : null;
}
// Tracks the auto-dismiss timer per toast id. We need this so manual
// `dismissToast(id)` clears the pending timer rather than letting it fire
// later and try to remove an already-gone toast. (Tier 2 perf fix.)
const toastTimers = new Map();

let toastSeq = 0;

// AGENTS.md §18: a toast shows the handler's own sentence. Electron prefixes
// main-process errors with "Error invoking remote method 'x': Error: ". The
// preload strips it from every invoke; this catches a message that was built
// some other way (e.g. `${err}` of an error from a path that bypassed it).
const IPC_ERROR_PREFIX = /Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/g;
export function cleanToastMessage(message) {
  if (typeof message !== 'string') return message;
  return message.replace(IPC_ERROR_PREFIX, '');
}

export function createToastsSlice(set, _get) {
  return {
    // — Toasts
    toasts: [],

    /**
     * `opts.action` (0.1.94) is an optional `{ label, onClick }` shown as one
     * small button at the end of the same single line — "Undo" after a delete.
     * A toast that carries one stays for ACTION_TOAST_DURATION_MS instead of 3s,
     * so there is time to reach it. Clicking the action dismisses the toast.
     */
    addToast(rawMessage, variant = 'info', opts = {}) {
      const id = ++toastSeq;
      const message = cleanToastMessage(rawMessage);
      const action = toastAction(opts?.action);
      set((s) => ({ toasts: [...s.toasts, { id, message, variant, ...(action ? { action } : {}) }] }));
      const timer = setTimeout(() => {
        toastTimers.delete(id);
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, action ? ACTION_TOAST_DURATION_MS : TOAST_DURATION_MS);
      toastTimers.set(id, timer);
      return id;
    },

    dismissToast(id) {
      // Clear the pending auto-dismiss so it doesn't fire after manual close.
      const timer = toastTimers.get(id);
      if (timer != null) {
        clearTimeout(timer);
        toastTimers.delete(id);
      }
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
}
