const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadExports(hold) {
  const filename = path.resolve(__dirname, '../main/ipc/exports.js');
  const localRequire = createRequire(filename);
  const stubs = {
    '../updateHold': hold,
    '../db/companies': {}, '../db/brands': {}, '../db/exportProfiles': {},
    '../db/exportRuns': {}, '../exportRunner': {}, '../events': {}, './helpers': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => Object.hasOwn(stubs, id) ? stubs[id] : localRequire(id),
    module, exports: module.exports, Buffer, process, console,
  }, { filename });
  return module.exports;
}

test('a hold refuses new exports and duplicate IDs cannot hide active work', () => {
  const hold = { paused: false, isPaused() { return this.paused; } };
  const exports = loadExports(hold);
  exports.startRun('run-1');
  assert.throws(() => exports.startRun('run-1'), /already running/);
  assert.equal(exports.hasActiveRun(), true);
  hold.paused = true;
  assert.throws(() => exports.startRun('run-2'), /update.*paused/);
  assert.equal(exports.hasActiveRun(), true);
});
