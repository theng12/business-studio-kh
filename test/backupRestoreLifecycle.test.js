const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

test('confirmed Settings and Backups operations do not request a second restart', async () => {
  for (const [file, name, argument] of [
    ['index.jsx', 'confirmChangeDataFolder', true],
    ['BackupsPanel.jsx', 'handleRestore', { backupPath: '/fixture/backup', fileName: 'fixture' }],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/modules/Settings', file), 'utf8');
    const start = source.indexOf(`  async function ${name}(`);
    const end = source.indexOf('\n  }', start) + 4;
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const context = {
      pendingDataFolder: '/fixture/new', setPendingDataFolder() {},
      isClient: false, config: { dataDir: '/fixture/live' }, setRestoringPath() {},
      formatDateTime: () => 'fixture', addToast() {},
      confirm: async () => true,
      setTimeout: (fn) => { calls.push('timer'); fn(); },
      window: { api: {
        settings: { changeDataFolder: async () => { calls.push('change'); return { restartScheduled: true }; } },
        backups: {
          preview: async () => ({ includes: [] }),
          restore: async () => { calls.push('restore'); return { restartScheduled: true }; },
        },
        app: { relaunch: async () => calls.push('relaunch') },
      } },
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}; this.run = ${name};`, context);
    await context.run(argument);
    assert.deepEqual(calls, [file === 'index.jsx' ? 'change' : 'restore']);
  }
});

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

test('local backups:restore schedules its own restart after returning', async () => {
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
    assert.equal(result.restartScheduled, true);
    await new Promise((resolve) => setTimeout(resolve, 560));
    assert.deepEqual(calls, ['relaunch', 'exit']);
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
