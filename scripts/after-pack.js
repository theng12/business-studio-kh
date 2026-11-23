'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SHIM = process.env.KH_SPARKLE_SHIM
  || path.join(os.homedir(), 'Developer', '_orchestra', 'developer-system', 'sparkle-shim-20261123');

/** Copies Sparkle in before signing. A build without it is refused: an app that
 *  advertises an updater but cannot load it fails silently at launch. */
function copySparkleFramework(appPath) {
  const source = process.env.SPARKLE_FRAMEWORK || path.join(SHIM, 'vendor', 'Sparkle.framework');
  if (!fs.existsSync(source)) {
    throw new Error(`sparkle: no framework at ${source} (set SPARKLE_FRAMEWORK or KH_SPARKLE_SHIM)`);
  }
  const dest = path.join(appPath, 'Contents', 'Frameworks', 'Sparkle.framework');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // ditto, not fs.cpSync: cp rewrites the framework's relative version symlinks to
  // absolute paths, which leaves the bundle unsealable ("unsealed contents").
  execFileSync('/usr/bin/ditto', [source, dest]);
  if (!fs.existsSync(path.join(dest, 'Versions', 'B', 'Sparkle'))) {
    throw new Error(`sparkle: ${dest} has no Versions/B/Sparkle`);
  }
  const current = fs.readlinkSync(path.join(dest, 'Versions', 'Current'));
  if (path.isAbsolute(current)) {
    throw new Error(`sparkle: copied framework points at ${current}; the bundle must keep relative symlinks`);
  }
  console.log(`sparkle: copied framework to ${dest}`);
}

function assertSparkleAddon(appPath) {
  const addon = path.join(appPath, 'Contents', 'Resources', 'native', 'khsparkle.node');
  if (!fs.existsSync(addon)) throw new Error(`sparkle: ${addon} missing — run scripts/build-khsparkle-addon.sh`);
}

function readKey(plist, key) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function setKey(plist, key, value) {
  const operation = readKey(plist, key) === null ? 'Add' : 'Set';
  const command = operation === 'Add' ? `Add :${key} string` : `Set :${key}`;
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `${command} ${value}`, plist]);
}

function updateHelperBundles(appPath) {
  const contents = path.join(appPath, 'Contents');
  const frameworks = path.join(contents, 'Frameworks');
  if (!fs.existsSync(frameworks)) {
    console.log('Skipped helper bundles: Frameworks directory missing');
    return;
  }

  const appPlist = path.join(contents, 'Info.plist');
  const iconKey = fs.existsSync(appPlist) && readKey(appPlist, 'CFBundleIconFile');
  const iconName = iconKey ? path.basename(iconKey.endsWith('.icns') ? iconKey : `${iconKey}.icns`) : 'icon.icns';
  const iconPath = path.join(contents, 'Resources', iconName);
  const hasIcon = fs.existsSync(iconPath);
  if (!hasIcon) console.log(`Skipped helper icons: ${iconPath} missing`);

  for (const entry of fs.readdirSync(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('Business Studio KH Helper') || !entry.name.endsWith('.app')) continue;
    const helperContents = path.join(frameworks, entry.name, 'Contents');
    const plist = path.join(helperContents, 'Info.plist');
    if (!fs.existsSync(plist)) {
      console.log(`Skipped ${entry.name}: Info.plist missing`);
      continue;
    }
    const displayName = readKey(plist, 'CFBundleDisplayName');
    if (displayName) setKey(plist, 'CFBundleName', displayName);
    else console.log(`Skipped name for ${entry.name}: CFBundleDisplayName missing`);
    if (hasIcon) {
      const resources = path.join(helperContents, 'Resources');
      fs.mkdirSync(resources, { recursive: true });
      fs.copyFileSync(iconPath, path.join(resources, iconName));
      setKey(plist, 'CFBundleIconFile', iconName);
    }
  }
}

// A production bundle carries code, not test code. 0.1.116 was stopped after a clean identity check
// because zod's own test tree shipped inside app.asar with dummy e-mail fixtures in it. The `files`
// exclusions in package.json are the fix; this reads the finished asar and refuses the build if any
// test path came back, so a dependency update cannot quietly put one there again. The pattern is the
// release checker's own set (`asar-list.py`), so the build and the checker cannot disagree.
const TEST_PATH = /(^|\/)(__tests__|__mocks__|__snapshots__|tests?|specs?|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$/i;

function assertNoTestCode(appPath) {
  const asar = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  if (!fs.existsSync(asar)) throw new Error(`bundle check: no app.asar at ${asar} — cannot prove the bundle carries no test code`);
  const entries = require('@electron/asar').listPackage(asar).map((entry) => entry.replace(/^\//, ''));
  const testCode = entries.filter((entry) => TEST_PATH.test(entry));
  if (testCode.length) {
    throw new Error(`bundle check: ${testCode.length} test path(s) in app.asar, e.g. ${testCode.slice(0, 3).join(', ')}`);
  }
  console.log(`bundle check: no test paths in app.asar (${entries.length} entries)`);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  copySparkleFramework(appPath);
  assertSparkleAddon(appPath);
  updateHelperBundles(appPath);
  assertNoTestCode(appPath);
};
module.exports.updateHelperBundles = updateHelperBundles;
module.exports.assertNoTestCode = assertNoTestCode;
module.exports.copySparkleFramework = copySparkleFramework;
module.exports.assertSparkleAddon = assertSparkleAddon;
module.exports.TEST_PATH = TEST_PATH;
