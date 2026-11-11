/**
 * 0.1.95: the "new" dot on the sidebar's What's new item.
 *
 * The version whose changelog the user last opened is remembered on this Mac
 * (localStorage, every access wrapped — storage can be missing or throw). The
 * dot shows whenever the running version differs from it, i.e. after an
 * update, and goes away once What's new is opened. Pure, for the tests.
 */

export const WHATS_NEW_SEEN_KEY = 'whatsNew.lastSeenVersion';

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadLastSeenVersion(storage) {
  try { return storageOf(storage)?.getItem(WHATS_NEW_SEEN_KEY) || ''; } catch { return ''; }
}

export function saveLastSeenVersion(version, storage) {
  if (!version) return;
  try { storageOf(storage)?.setItem(WHATS_NEW_SEEN_KEY, String(version)); } catch { /* storage unavailable: the dot comes back next launch */ }
}

/**
 * True when there is a running version and it is not the one last opened.
 * A first-ever run has no stored version, and the KH UI conventions say the
 * What's New dot never shows on a first run (only after an upgrade).
 */
export function hasUnseenWhatsNew(version, lastSeen) {
  return Boolean(version) && Boolean(lastSeen) && String(version) !== String(lastSeen);
}
