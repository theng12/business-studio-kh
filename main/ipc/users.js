/**
 * v0.21.0: users:* IPC handlers, extracted from the monolithic ipc.js.
 *
 * Only relevant in server mode (and the bootstrap flow that creates
 * a default owner the first time someone flips a Mac to server).
 * Remote administration uses the server's HTTP RPC API and requires
 * the users.manage capability, just like the user-management list.
 *
 * Two safe-subset channels are exposed for clients:
 *   - users:listForAttribution → id + name + role (no tokens)
 *   - users:presence → currently-connected WebSocket users
 *
 * Tokens are returned to authorized user managers by the management
 * list and create/regenerate operations. Attribution reads omit them.
 */


function register({ expose, exposeLocal }) {
  const disconnectUser = (id) => {
    try { require('../events').closeWsClientsForUser(id); } catch (_) { /* server may not be running */ }
  };

  expose('users:list', () => {
    const users = require('../db/users');
    return users.list();
  });
  expose('users:create', ({ name, role }) => {
    const users = require('../db/users');
    return users.create({ name, role });
  });
  expose('users:update', ({ id, patch }) => {
    const users = require('../db/users');
    const updated = users.update(id, patch);
    disconnectUser(id);
    return updated;
  });
  expose('users:remove', (id) => {
    const users = require('../db/users');
    const removed = users.remove(id);
    if (removed) disconnectUser(id);
    return removed;
  });
  expose('users:regenerateToken', (id) => {
    const users = require('../db/users');
    const updated = users.regenerateToken(id);
    disconnectUser(id);
    return updated;
  });
  /* Bootstrap helper: called by Settings when the user flips into
     server mode and the users table is still empty. Creates a default
     "Owner" with admin role and returns it (including the token,
     which the UI shows for one-time copy). */
  expose('users:ensureOwner', () => {
    const users = require('../db/users');
    return users.ensureOwner();
  });

  /* v0.15.3: safe-subset user list for attribution lookups. Returns
     only id + name + role — no tokens. Clients receive this so they
     can render "Edited 2 min ago by Theng" without ever seeing
     anyone else's authentication material. */
  expose('users:listForAttribution', () => {
    const users = require('../db/users');
    return users.list().map((u) => ({ id: u.id, name: u.name, role: u.role }));
  });

  /* v0.15.3: presence — who's currently connected via WebSocket.
     Exposed to clients so the Settings page (and a future presence
     chip in the sidebar) can show "Theng is online". Returns
     [{id, name, role, connectedAt}]. */
  expose('users:presence', () => {
    const events = require('../events');
    return events.getPresence();
  });
}

module.exports = { register };
