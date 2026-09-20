const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('packaging uses one canonical arm64 release path', () => {
  assert.equal(pkg.scripts['dist:arm64'], 'npm run dist');
  assert.equal(pkg.scripts.release, undefined);
  assert.equal(pkg.scripts['release:minor'], undefined);
  assert.equal(pkg.scripts['release:major'], undefined);
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/release.yml')), false);
});
