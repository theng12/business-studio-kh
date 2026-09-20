const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('updating a role evicts connected users assigned to that role', () => {
  const handlers = new Map();
  const evicted = [];
  const calls = [];
  const rolesFilename = require.resolve('../main/ipc/roles');
  const originalLoad = Module._load;
  delete require.cache[rolesFilename];
  Module._load = function (request, parent, isMain) {
    if (request === '../db/roles') {
      return {
        list: () => [], get: () => null, create: () => null, remove: () => null,
        update: (key, patch) => { calls.push({ key, patch }); return { key, ...patch }; },
      };
    }
    if (request === '../db/users') {
      return {
        list: () => [
          { id: 'editor-a', role: 'editor' },
          { id: 'viewer-a', role: 'viewer' },
          { id: 'editor-b', role: 'editor' },
        ],
      };
    }
    if (request === '../events') return { closeWsClientsForUser: (id) => evicted.push(id) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const roles = require('../main/ipc/roles');
    roles.register({ expose: (channel, handler) => handlers.set(channel, handler) });
    const result = handlers.get('roles:update')({ key: 'editor', patch: { permissions: ['images.add'] } });

    assert.deepEqual(result, { key: 'editor', permissions: ['images.add'] });
    assert.deepEqual(calls, [{ key: 'editor', patch: { permissions: ['images.add'] } }]);
    assert.deepEqual(evicted, ['editor-a', 'editor-b']);
  } finally {
    Module._load = originalLoad;
    delete require.cache[rolesFilename];
  }
});
