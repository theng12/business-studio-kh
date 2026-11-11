'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  updateHelperBundles(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
};
module.exports.updateHelperBundles = updateHelperBundles;
