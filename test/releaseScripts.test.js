const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('packaging builds arm64 and x64 DMGs from one config', () => {
  // v0.1.52: both architectures ship (Theng asked for an Intel DMG again), so
  // `dist` builds two DMGs and the per-arch scripts override the CLI arch.
  assert.equal(pkg.scripts['dist:arm64'], 'vite build && electron-builder --arm64');
  assert.equal(pkg.scripts['dist:x64'], 'vite build && electron-builder --x64');
  assert.equal(pkg.scripts.release, undefined);
  assert.equal(pkg.scripts['release:minor'], undefined);
  assert.equal(pkg.scripts['release:major'], undefined);
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dmg', arch: ['arm64', 'x64'] }]);
  // The x64 sharp binaries must be installed alongside arm64 or the x64 app
  // packages without a working image pipeline.
  assert.ok(pkg.scripts['install:sharp'].includes('@img/sharp-darwin-arm64'));
  assert.ok(pkg.scripts['install:sharp'].includes('@img/sharp-darwin-x64'));
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/release.yml')), false);
});
