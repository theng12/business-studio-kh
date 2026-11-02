const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('packaging builds ONE DMG — Apple silicon — unless Intel is asked for', () => {
  // 2026-09-27, Theng: "from now on, you only need to build 1 dmg. the arm64
  // until i tell you otherwise". Before that, every release from 2026-09-22
  // built both arches. The reversal is his to make and this test pins the
  // current one, so a future session cannot quietly re-add x64 (or drop it
  // again) without the config and the rule moving together — AGENTS.md §20.
  assert.equal(pkg.scripts['dist:arm64'], 'vite build && electron-builder --arm64');
  assert.equal(pkg.scripts['dist:updater'], 'bash scripts/build-updater-dmg.sh');
  // The per-arch script stays: it is how an Intel DMG gets built if he asks for
  // one, without editing this config first.
  assert.equal(pkg.scripts['dist:x64'], 'vite build && electron-builder --x64');
  assert.equal(pkg.scripts.release, undefined);
  assert.equal(pkg.scripts['release:minor'], undefined);
  assert.equal(pkg.scripts['release:major'], undefined);
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  // Developer standard (2026-11-03): unsuffixed output filename, so the
  // existing 0.1.102 build is exactly `Business Studio KH-0.1.102.dmg`.
  assert.equal(pkg.build.productName, 'Business Studio KH');
  assert.match(pkg.build.dmg.artifactName, /^\$\{productName\}-\$\{version\}\.\$\{ext\}$/);
  const updaterSh = fs.readFileSync(path.join(root, 'scripts', 'build-updater-dmg.sh'), 'utf8');
  assert.ok(updaterSh.includes('DMG="dist/Business Studio KH-$VERSION.dmg"'),
    'the updater script builds the same unsuffixed filename');
  // Both arches' sharp binaries stay installed. arm64 is what ships; x64 is
  // kept ready so "build me an Intel one" is one command rather than a
  // surprise re-install in the middle of a release.
  assert.ok(pkg.scripts['install:sharp'].includes('@img/sharp-darwin-arm64'));
  assert.ok(pkg.scripts['install:sharp'].includes('@img/sharp-darwin-x64'));
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/release.yml')), false);
});

test('updater packaging refuses a failed app signature before creating an installer', () => {
  const { spawnSync } = require('node:child_process');
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'media-signature-test-'));
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(scratch, 'scripts'));
  fs.mkdirSync(path.join(scratch, 'node_modules', '.bin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts', 'build-updater-dmg.sh'), path.join(scratch, 'scripts', 'build.sh'));
  for (const [name, body] of Object.entries({
    node: 'echo 0.1.101',
    npm: 'exit 0',
    codesign: '[ "$1" != --verify ] || exit 19',
    hdiutil: 'touch "$PROBE_DMG_MARKER"',
  })) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(scratch, 'node_modules', '.bin', 'electron-builder'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const marker = path.join(scratch, 'created-dmg');
  try {
    const result = spawnSync('/bin/bash', [path.join(scratch, 'scripts', 'build.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, PROBE_DMG_MARKER: marker }, encoding: 'utf8',
    });
    assert.equal(result.status, 19, result.stderr);
    assert.equal(fs.existsSync(marker), false, 'a refused signature must not produce a DMG');
  } finally {
    const trash = path.join(root, '_trash', 'updater-signature-tests');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(scratch, path.join(trash, path.basename(scratch)));
  }
});
