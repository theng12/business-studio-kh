// Owner rule 2026-11-12: every runner lives inside the app bundle, and
// uninstalling removes the app, its helper, any launchd job and the login item,
// while user data stays. Media ships no loose binary and no launchd job.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts', 'uninstall-media-kh.sh');
const INDEX = read('main/index.js');

test('the app clears its login item headlessly when asked', () => {
  assert.match(INDEX, /--clear-login-item/);
  assert.match(INDEX, /setLoginItemSettings\(\{ openAtLogin: false \}\)/);
  assert.match(INDEX, /uninstall:login-item-cleared/);
});

test('the uninstall script clears the login item, unloads any job, trashes the bundle and keeps data', () => {
  const script = read('scripts/uninstall-media-kh.sh');
  assert.match(script, /--clear-login-item/);
  assert.match(script, /launchctl list/);
  assert.match(script, /grep -i 'mediastudiokh'/);
  assert.match(script, /launchctl bootout/);
  assert.match(script, /mv "\$APP"/);
  assert.match(script, /User data kept/);
  assert.doesNotMatch(script, /\brm -rf\b/);
});

test('uninstalling a bundle moves the whole bundle (helper included) and calls the cleanup flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-uninstall-'));
  const app = path.join(root, 'Business Studio KH.app');
  const marker = path.join(root, 'flag.txt');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Frameworks', 'Business Studio KH Helper.app'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents', 'MacOS', 'Business Studio KH'),
    `#!/bin/sh\necho "$1" > "${marker}"\n`,
    { mode: 0o755 },
  );

  execFileSync('/bin/bash', [SCRIPT, app], { env: { ...process.env, ROTATE: path.join(root, 'rotate') } });

  assert.equal(fs.existsSync(app), false, 'the bundle must no longer be in place');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '--clear-login-item');
  const moved = path.join(root, 'rotate', 'Business Studio KH.app');
  assert.ok(fs.existsSync(path.join(moved, 'Contents', 'Frameworks', 'Business Studio KH Helper.app')), 'the helper moves with the bundle');
});

test('the packaged app keeps every helper inside the bundle', (t) => {
  const built = path.join(ROOT, 'dist', 'mac-arm64', 'Business Studio KH.app');
  if (!fs.existsSync(built)) { t.skip('no packaged app in dist/ to inspect'); return; }
  const contents = path.join(built, 'Contents');
  const helpers = fs.readdirSync(path.join(contents, 'Frameworks')).filter((name) => name.startsWith('Business Studio KH Helper'));
  assert.ok(helpers.length >= 1, 'the helper bundles live in Contents/Frameworks');
  assert.equal(fs.existsSync(path.join(contents, 'Helpers')), false, 'no loose Contents/Helpers runner directory');
});
