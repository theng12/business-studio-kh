/**
 * v0.1.22: capability checks for the renderer.
 *
 * Lifted out of Sidebar.jsx because a second caller appeared. Sidebar decides
 * which nav items to show from the current user's capabilities; Settings now
 * needs the same answer for a tab ("may this user manage users?"). Two copies of
 * a permission rule is exactly how a UI ends up offering a control the server
 * will refuse, so there is one implementation and both import it.
 *
 * A capability list is an array of strings, e.g. ['images.manage', 'labels.use'].
 * The single wildcard '*' means all access — which is what the host Mac
 * (standalone / server mode) has, since it is the implicit owner.
 */

/** True when `caps` grants `key` — directly or via the '*' wildcard. */
export function hasCap(caps, key) {
  if (!Array.isArray(caps)) return false;
  return caps.includes('*') || caps.includes(key);
}

/** True when `caps` grants ANY of `keys`. An empty/absent list is ungated → true. */
export function hasAnyCap(caps, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return true; // ungated item
  return keys.some((k) => hasCap(caps, k));
}
