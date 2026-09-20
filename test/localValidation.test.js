/**
 * v0.1.14: the local IPC path must validate too.
 *
 * `expose()` (main/ipc/helpers.js) registers every channel twice — as an
 * `ipcMain.handle` for the standalone/server app, and in the RPC registry for
 * remote clients. Validation used to run ONLY in the server dispatcher, so the
 * standalone app (the normal way this is used) accepted any shape and pushed it
 * at the database, where it surfaced later as an opaque error like
 * "datatype mismatch". Validators existed; nothing called them locally.
 *
 * These tests pin the fix on the local path specifically. They drive
 * `expose()` with a stub ipcMain, then invoke the registered handler the way
 * ipcMain would, and assert that bad args are rejected with a readable message.
 * No Electron, no DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

/**
 * Load main/ipc/helpers.js with a stubbed `electron`, capturing every channel
 * it registers. Returns { handlers, expose }.
 */
function loadHelpersWithStub() {
  const handlers = new Map();
  const electronStub = {
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: () => {},
    },
    shell: { openExternal: async () => {} },
    dialog: {},
    app: { getVersion: () => '0.0.0-test' },
  };

  const helpersPath = require.resolve('../main/ipc/helpers.js');
  delete require.cache[helpersPath];
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return 'electron';
    return originalResolve.call(this, request, ...rest);
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const helpers = require('../main/ipc/helpers.js');
    return { handlers, expose: helpers.expose };
  } finally {
    Module._resolveFilename = originalResolve;
    Module._load = originalLoad;
  }
}

test('expose() — local IPC rejects bad args with a readable message', () => {
  const { handlers, expose } = loadHelpersWithStub();
  let handlerRan = false;
  expose('products:update', () => { handlerRan = true; return 'ok'; });

  const fn = handlers.get('products:update');
  assert.equal(typeof fn, 'function', 'expose should register an ipcMain handler');

  // What ipcMain.handle gives the callback: (event, ...args). A missing `id`
  // is exactly the kind of malformed call that used to reach the DB.
  assert.throws(
    () => fn({}, { patch: { name: 'no id here' } }),
    (err) => {
      assert.match(err.message, /^Bad request: /, `unexpected message: ${err.message}`);
      assert.match(err.message, /id/i);
      return true;
    },
  );
  assert.equal(handlerRan, false, 'the handler must NOT run when args are invalid');
});

test('expose() — local IPC still accepts good args', () => {
  const { handlers, expose } = loadHelpersWithStub();
  expose('products:update', () => 'ok');
  const fn = handlers.get('products:update');
  assert.equal(fn({}, { id: 'p1', patch: { name: 'Fine' } }), 'ok');
});

test('expose() — a channel with no validator passes through unchanged', () => {
  const { handlers, expose } = loadHelpersWithStub();
  expose('some:uncoveredChannel', (a) => ({ got: a }));
  const fn = handlers.get('some:uncoveredChannel');
  // Uncovered channels keep the old behaviour so adding validation stays
  // incremental rather than turning every uncovered channel into a hard failure.
  assert.deepEqual(fn({}, 'anything'), { got: 'anything' });
});

test('expose() — the message matches the RPC wording for the same bad input', () => {
  // A caller should see one wording whether the call came from the local
  // ipcMain path or over the network.
  const { getValidator } = require('../main/server/validators');
  const { handlers, expose } = loadHelpersWithStub();
  expose('images:setMainImage', () => 'ok');
  const fn = handlers.get('images:setMainImage');

  const bad = { productId: 'p1' }; // missing filepath
  const fromValidator = getValidator('images:setMainImage')(bad);
  assert.notEqual(fromValidator, true, 'sanity: this input really is invalid');

  assert.throws(() => fn({}, bad), (err) => {
    assert.equal(err.message, `Bad request: ${fromValidator}`);
    return true;
  });
});
