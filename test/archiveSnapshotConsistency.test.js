const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('bundle export rejects an asset tree that changes after the database snapshot', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-bundle-snapshot-'));
  const dataDir = path.join(root, 'data');
  const asset = path.join(dataDir, 'assets', 'company', 'product.jpg');
  const archive = path.join(root, 'out.iskhbundle');
  const originalLoad = Module._load;
  try {
    await fsp.mkdir(path.dirname(asset), { recursive: true });
    await fsp.writeFile(asset, 'photo-at-snapshot');
    await fsp.writeFile(path.join(dataDir, 'database.sqlite'), 'synthetic-db');
    const fakeConfig = {
      loadConfig: () => ({ dataDir, openaiApiKey: 'dummy' }),
      configPath: () => path.join(root, 'config.json'),
    };
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { app: { getVersion: () => 'test' } };
      if (request === './config') return fakeConfig;
      if (request === './db') {
        return { getDb: () => ({
          backup: async (dest) => {
            await fsp.writeFile(dest, 'synthetic-db-snapshot');
            await fsp.rm(asset);
          },
        }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/serverBundle')];
    const { exportBundle } = require('../main/serverBundle');
    await assert.rejects(
      () => exportBundle({ outputPath: archive }),
      /changed|missing|consistent|snapshot/i,
    );
    assert.equal(fs.existsSync(archive), false);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/serverBundle')];
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('local backup rejects an asset tree that changes after the database snapshot', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-backup-snapshot-'));
  const dataDir = path.join(root, 'data');
  const asset = path.join(dataDir, 'assets', 'company', 'product.jpg');
  const backupsDir = path.join(root, 'backups');
  const originalLoad = Module._load;
  try {
    await fsp.mkdir(path.dirname(asset), { recursive: true });
    await fsp.writeFile(asset, 'photo-at-snapshot');
    await fsp.writeFile(path.join(dataDir, 'database.sqlite'), 'synthetic-db');
    const fakeConfig = {
      loadConfig: () => ({ dataDir }),
      configPath: () => path.join(root, 'config.json'),
    };
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { app: { getVersion: () => 'test' } };
      if (request === './config') return fakeConfig;
      if (request === './db') {
        return { getDb: () => ({
          backup: async (dest) => {
            await fsp.writeFile(dest, 'synthetic-db-snapshot');
            await fsp.rm(asset);
          },
        }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/serverBundle')];
    delete require.cache[require.resolve('../main/backupManager')];
    const { createBackup } = require('../main/backupManager');
    await assert.rejects(
      () => createBackup({ destDir: backupsDir }),
      /changed|missing|consistent|snapshot/i,
    );
    assert.equal(fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0, 0);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/serverBundle')];
    delete require.cache[require.resolve('../main/backupManager')];
    await fsp.rm(root, { recursive: true, force: true });
  }
});
