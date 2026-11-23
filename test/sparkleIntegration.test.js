const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('the entitlement is committed, applied and asserted from the plist', () => {
  const plist = read('build/entitlements.mac.plist');
  assert.match(plist, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(plist, /com\.apple\.security\.cs\.allow-jit/);
  assert.equal(pkg.build.mac.entitlements, 'build/entitlements.mac.plist');
  assert.equal(pkg.build.mac.entitlementsInherit, 'build/entitlements.mac.plist');
  assert.equal(pkg.build.mac.hardenedRuntime, true, 'library validation only bites under the hardened runtime');
});

test('the plist carries this app\'s Sparkle keys and never the private key', () => {
  const info = pkg.build.mac.extendInfo;
  assert.ok(info.SUPublicEDKey && info.SUPublicEDKey.length >= 40, 'SUPublicEDKey');
  assert.equal(info.KHHoldURL, 'http://127.0.0.1:13181/api/maintenance/hold');
  assert.equal(info.KHHoldTokenFile, '~/Library/KHUpdater/state/hold-token');
  assert.equal(info.SUEnableAutomaticChecks, true);
  assert.equal(info.SUFeedURL, undefined, 'SUFeedURL ships only once the appcast answers 200');
  assert.doesNotMatch(read('package.json') + read('build/entitlements.mac.plist'), /private\.key|ed25519-private/);
});

test('the framework is copied before signing and signed inside-out, never deep', () => {
  const afterPack = read('scripts/after-pack.js');
  assert.match(afterPack, /copySparkleFramework\(appPath\)/);
  assert.ok(afterPack.indexOf('copySparkleFramework(appPath)') < afterPack.indexOf('updateHelperBundles(appPath)'));
  const sign = read('scripts/sign-mac.js');
  const order = sign.slice(sign.indexOf('const nested = ['), sign.indexOf('for (const target'));
  const at = (needle) => order.indexOf(needle);
  assert.ok(at('XPCServices') > 0 && at('XPCServices') < at("'Updater.app'"), 'XPCs before Updater.app');
  assert.ok(at("'Updater.app'") < at("'Autoupdate'"), 'Updater.app before Autoupdate');
  assert.ok(at("'Autoupdate'") < at('\n    versions,'), 'Autoupdate before the framework');
  assert.ok(at('\n    versions,') < at('\n    framework,'), 'framework last');
  assert.doesNotMatch(sign, /'--deep'/);
});

test('the addon builds against the shim and is shipped outside the asar', () => {
  const build = read('scripts/build-khsparkle-addon.sh');
  assert.match(build, /libkhsparkle\.a/);
  assert.match(build, /-Wl,-rpath,@loader_path\/\.\.\/\.\.\/Frameworks/);
  assert.match(pkg.scripts.predist, /build:sparkle/);
  assert.match(read('scripts/build-updater-dmg.sh'), /build:sparkle/);
  assert.ok(pkg.build.extraResources.some((r) => r.to === 'native/khsparkle.node'));
  assert.match(read('.gitignore'), /native\/khsparkle\.node/);
});

test('the check starts once, after the window/menu-bar item exists, and logs refusals', () => {
  const index = read('main/index.js');
  assert.ok(index.indexOf('installTray(') < index.indexOf('startUpdateCheck('));
  const { startUpdateCheck } = require('../main/updateCheck');
  const heard = [];
  assert.equal(startUpdateCheck({ packaged: false, log: (e, d) => heard.push(`${e} ${d}`) }), null);
  assert.match(heard[0], /kh-sparkle:skipped/);
  const missing = [];
  const saved = process.resourcesPath;
  process.resourcesPath = path.join(os.tmpdir(), 'kh-sparkle-nowhere');
  try {
    assert.equal(startUpdateCheck({ packaged: true, log: (e, d) => missing.push(`${e} ${d}`) }), null);
  } finally { process.resourcesPath = saved; }
  assert.match(missing[0], /kh-sparkle:unavailable/);
});
