const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Module = require('node:module');

const execFileAsync = promisify(execFile);

test('bundle import removes extracted portable credentials after a successful merge', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-bundle-credentials-'));
  const originalLoad = Module._load;
  const updates = [];
  try {
    const stageParent = await fsp.mkdtemp(path.join(root, 'stage-'));
    const bundleRoot = path.join(stageParent, 'bundle');
    await fsp.mkdir(bundleRoot, { recursive: true });
    await fsp.writeFile(path.join(bundleRoot, 'manifest.json'), JSON.stringify({
      bundleFormatVersion: 1,
      appVersion: 'test',
      createdAt: Date.now(),
      includes: ['database.sqlite', 'config.partial.json'],
    }));
    await fsp.writeFile(path.join(bundleRoot, 'database.sqlite'), 'synthetic sqlite fixture');
    await fsp.writeFile(path.join(bundleRoot, 'config.partial.json'), JSON.stringify({ kieApiKey: 'dummy-secret', falApiKey: 'dummy-secret-2' }));
    const archive = path.join(root, 'fixture.iskhbundle');
    await execFileAsync('/usr/bin/tar', ['-czf', archive, '-C', stageParent, 'bundle']);

    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { app: { getVersion: () => 'test' } };
      if (request === './util/backupSafety') {
        return {
          validateTarListing: () => ({ rootName: 'bundle' }),
          validateExtractedTree: async () => {},
          resolveSafeDest: (rootPath, rel) => path.join(rootPath, rel),
        };
      }
      if (request === './config') return { updateConfig: (patch) => updates.push(patch) };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main/serverBundle')];
    const { importBundle } = require('../main/serverBundle');
    const target = path.join(root, 'target');
    await importBundle({ bundlePath: archive, targetDataDir: target });

    assert.deepEqual(updates, [{ kieApiKey: 'dummy-secret', falApiKey: 'dummy-secret-2' }]);
    assert.equal(fs.existsSync(path.join(target, 'config.partial.json')), false);
    const names = await fsp.readdir(target);
    assert.deepEqual(names.sort(), ['database.sqlite', 'manifest.json']);
    assert.equal((await fsp.readFile(path.join(target, 'database.sqlite'), 'utf8')), 'synthetic sqlite fixture');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/serverBundle')];
    await fsp.rm(root, { recursive: true, force: true });
  }
});
