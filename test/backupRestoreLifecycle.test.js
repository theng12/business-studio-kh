const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

test('remote backups:restore schedules a server restart after returning', async () => {
  const calls = [];
  const fakeManager = { restoreBackup: async () => ({ success: true, safetyDir: '/tmp/safety' }) };
  const fakeElectron = {
    app: {
      relaunch: () => calls.push('relaunch'),
      exit: () => calls.push('exit'),
    },
    dialog: {},
    shell: {},
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === '../backupManager') return fakeManager;
    if (request === '../events') return { broadcast() {} };
    if (request === '../config') return { loadConfig: () => ({ dataDir: '/tmp/data' }), updateConfig() {} };
    if (request === '../server') return { getCurrentUserId: () => 'remote-user' };
    if (request === '../util/openPath') return { openPathOrThrow: async () => true };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { register } = require('../main/ipc/backups');
    const handlers = {};
    register({ expose: (channel, handler) => { handlers[channel] = handler; }, exposeLocal: () => {} });
    const result = await handlers['backups:restore']({ backupPath: '/tmp/fixture.iskhbackup' });
    assert.equal(result.serverRestartScheduled, true);
    await new Promise((resolve) => setTimeout(resolve, 560));
    assert.deepEqual(calls, ['relaunch', 'exit']);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/ipc/backups')];
  }
});

test('local backups:restore leaves relaunch to the local renderer', async () => {
  const calls = [];
  const fakeManager = { restoreBackup: async () => ({ success: true, safetyDir: '/tmp/safety' }) };
  const fakeElectron = {
    app: {
      relaunch: () => calls.push('relaunch'),
      exit: () => calls.push('exit'),
    },
    dialog: {},
    shell: {},
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === '../backupManager') return fakeManager;
    if (request === '../events') return { broadcast() {} };
    if (request === '../config') return { loadConfig: () => ({ dataDir: '/tmp/data' }), updateConfig() {} };
    if (request === '../server') return { getCurrentUserId: () => null };
    if (request === '../util/openPath') return { openPathOrThrow: async () => true };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { register } = require('../main/ipc/backups');
    const handlers = {};
    register({ expose: (channel, handler) => { handlers[channel] = handler; }, exposeLocal: () => {} });
    const result = await handlers['backups:restore']({ backupPath: '/tmp/fixture.iskhbackup' });
    assert.equal(result.serverRestartScheduled, undefined);
    await new Promise((resolve) => setTimeout(resolve, 560));
    assert.deepEqual(calls, []);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/ipc/backups')];
  }
});

test('client backup panel hides local Reveal and explains server reconnect', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/modules/Settings/BackupsPanel.jsx'), 'utf8');
  assert.match(source, /\{!isClient\s*&&\s*<Button variant="ghost" onClick=\{\(\) => handleReveal/);
  assert.match(source, /The server will restart automatically.*this client will reconnect/);
});
