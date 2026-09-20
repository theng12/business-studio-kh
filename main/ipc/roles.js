/**
 * v0.49.51 — Roles & permissions IPC.
 *
 * Reads (list/get/capabilities) are baseline-allowed so any client can
 * resolve role names + render the matrix; writes (create/update/remove)
 * are gated to users.manage (admin by default) via permissions.js.
 */

const roles = require('../db/roles');
const { CAPABILITIES } = require('../util/capabilities');

function register({ expose }) {
  const refreshRoleConnections = (roleKey) => {
    try {
      const { closeWsClientsForUser } = require('../events');
      for (const user of require('../db/users').list()) {
        if (user.role === roleKey) closeWsClientsForUser(user.id);
      }
    } catch (_) { /* server may not be running */ }
  };

  expose('roles:list',         () => roles.list());
  expose('roles:get',          (key) => roles.get(key));
  // The capability taxonomy the matrix UI renders (key/label/description/group).
  expose('roles:capabilities', () => CAPABILITIES);

  expose('roles:create',       (input) => roles.create(input ?? {}));
  expose('roles:update',       ({ key, patch } = {}) => {
    const updated = roles.update(key, patch ?? {});
    refreshRoleConnections(key);
    return updated;
  });
  expose('roles:remove',       (key) => roles.remove(key));
}

module.exports = { register };
