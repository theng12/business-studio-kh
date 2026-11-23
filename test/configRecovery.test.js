const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadConfig(userDataRoot) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userDataRoot } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../main/config')];
    return require('../main/config');
  } finally {
    Module._load = originalLoad;
  }
}

test('saveConfig keeps the last valid primary file when the atomic rename fails', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-config-atomic-'));
  const originalRename = fs.renameSync;
  try {
    const config = loadConfig(root);
    config.saveConfig({ dataDir: '/old/data', mode: 'server' });
    fs.renameSync = () => { throw new Error('fixture rename failure'); };
    assert.throws(() => config.saveConfig({ dataDir: '/new/data', mode: 'client' }), /fixture rename failure/);
    fs.renameSync = originalRename;

    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, 'config.json'), 'utf8')), {
      dataDir: '/old/data',
      mode: 'server',
    });
    assert.equal(fs.existsSync(path.join(root, 'config.json.tmp')), false);
  } finally {
    fs.renameSync = originalRename;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('loadConfig recovers a corrupt primary from its last-known-good copy', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-config-recovery-'));
  try {
    const configPath = path.join(root, 'config.json');
    const recoveredDataDir = path.join(root, 'recovered-data');
    await fsp.writeFile(configPath, '{broken');
    await fsp.writeFile(`${configPath}.bak`, JSON.stringify({ dataDir: recoveredDataDir, mode: 'client', clientToken: 'dummy-token' }));
    const config = loadConfig(root);
    const loaded = config.loadConfig();
    assert.equal(loaded.dataDir, recoveredDataDir);
    assert.equal(loaded.mode, 'client');
    assert.equal(loaded.clientToken, 'dummy-token');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('--data-dir points a hidden run at its own folder without saving that path', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-config-datadir-'));
  const savedArgv = process.argv;
  try {
    const config = loadConfig(root);
    const scratch = path.join(root, 'scratch-data');
    process.argv = [...savedArgv, '--data-dir', scratch];
    const cfg = config.loadConfig();
    assert.equal(cfg.dataDir, scratch);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(onDisk.dataDir, config.defaultConfig().dataDir, 'the override is never persisted');
  } finally {
    process.argv = savedArgv;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
