#!/usr/bin/env bash
# Local KH Updater installer; publishing remains a separate step.
set -euo pipefail
cd "$(dirname "$0")/.."
unset ELECTRON_RUN_AS_NODE
VERSION="$(node -p "require('./package.json').version")"
APP="dist/mac-arm64/Media Studio KH.app"
DMG="dist/Media Studio KH-$VERSION.dmg"
STAGE="$(mktemp -d -t media-updater)"
trap 'npm run native:host' EXIT
npm run webclient:bundle
npm run build
./node_modules/.bin/electron-builder --dir --arm64 --publish never
# electron-builder signs nested code and the bundle via build.mac.sign (scripts/sign-mac.js).
codesign --verify --deep --strict "$APP"
codesign -dvv "$APP" 2>&1 | grep -x 'Authority=KH Studio Local Signing' >/dev/null
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = 'com.terranash.mediastudiokh'
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VERSION"
ditto "$APP" "$STAGE/Media Studio KH.app"
ln -s /Applications "$STAGE/Applications"
if [ -e "$DMG" ]; then
  mkdir -p _trash/updater-dmgs
  mv "$DMG" "_trash/updater-dmgs/$(basename "$DMG").$(date +%s)"
fi
hdiutil create -volname "Media Studio KH $VERSION" -srcfolder "$STAGE" -format UDZO "$DMG"
codesign --sign - "$DMG"
codesign --verify --strict "$DMG"
hdiutil verify "$DMG"
mkdir -p _trash/updater-staging
mv "$STAGE" "_trash/updater-staging/$(basename "$STAGE")"
# Retention runs only after installed acceptance (verify-macos-signing.py --retain-dist).
printf 'Built %s (com.terranash.mediastudiokh, %s)\n' "$DMG" "$VERSION"
