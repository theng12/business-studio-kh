/**
 * 0.1.95: ⌘S / Ctrl+S saves the editor on screen.
 *
 * One mechanism for every editor: an editor registers its save handler here
 * (SaveStatus does it for any editor that passes `onSave`; an editor whose
 * Save button lives elsewhere calls `useSaveShortcut`), and App's single
 * keydown listener calls the most recently registered one. A stack rather than
 * one slot, so an editor that unmounts hands ⌘S back to the one beneath it.
 *
 * Pure (no React), for test/leftovers.test.js.
 */

const handlers = [];

/** Register `fn` as the active save handler. Returns the unregister. */
export function registerSaveHandler(fn) {
  if (typeof fn !== 'function') return () => {};
  const entry = { fn };
  handlers.push(entry);
  return () => {
    const i = handlers.lastIndexOf(entry);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** The handler ⌘S would call now, or null. */
export function activeSaveHandler() {
  return handlers.length ? handlers[handlers.length - 1].fn : null;
}

/** ⌘S on a Mac, Ctrl+S elsewhere — no Shift / Alt (⌘⇧S is not "Save"). */
export function isSaveShortcut(e) {
  if (!e || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return e.key === 's' || e.key === 'S';
}

/** A field that may hold a typed value it only commits on blur. */
export function isEditableElement(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function runSave() {
  const fn = activeSaveHandler();
  if (!fn) return;
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => { /* the editor reports its own save errors */ });
  } catch { /* the editor reports its own save errors */ }
}

/**
 * Handle a keydown. Returns true when the event was ⌘S (the browser default is
 * prevented either way). Skipped while a modal dialog is open — the modal owns
 * the keyboard, and saving the page underneath it would be a surprise. Works
 * while typing in a field: that is the point of the shortcut.
 *
 * Several fields commit what was typed only on blur (LabelStudio NumberField,
 * Overlay Inspector's number fields). So when a field has focus it is blurred
 * first, the save runs on the next tick — after React has applied the commit
 * and the editor's save handler sees the new value — and focus goes back to
 * the field if it is still on the page.
 */
export function handleSaveShortcut(e, { dialogOpen = false, doc = globalThis.document, defer = (fn) => setTimeout(fn, 0) } = {}) {
  if (!isSaveShortcut(e)) return false;
  e.preventDefault?.();
  if (dialogOpen || !activeSaveHandler()) return true;
  const el = doc?.activeElement;
  if (isEditableElement(el) && typeof el.blur === 'function') {
    try { el.blur(); } catch { /* nothing to commit */ }
    defer(() => {
      runSave();
      if (el.isConnected && typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch { /* element gone */ }
      }
    });
    return true;
  }
  runSave();
  return true;
}
