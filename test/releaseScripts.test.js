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
  // The per-arch script stays: it is how an Intel DMG gets built if he asks for
  // one, without editing this config first.
  assert.equal(pkg.scripts['dist:x64'], 'vite build && electron-builder --x64');
  assert.equal(pkg.scripts.release, undefined);
  assert.equal(pkg.scripts['release:minor'], undefined);
  assert.equal(pkg.scripts['release:major'], undefined);
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  // Both arches' sharp binaries stay installed. arm64 is what ships; x64 is
  // kept ready so "build me an Intel one" is one command rather than a
  // surprise re-install in the middle of a release.
  assert.ok(pkg.scripts['install:sharp'].includes('@img/sharp-darwin-arm64'));
  assert.ok(pkg.scripts['install:sharp'].includes('@img/sharp-darwin-x64'));
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/release.yml')), false);
});
