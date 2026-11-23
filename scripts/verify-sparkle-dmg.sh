#!/bin/zsh
# Proves what the finished installer carries, from inside the mounted image:
#   - the app is signed and its entitlement disables library validation
#   - Sparkle.framework is embedded and deep-verifies
# Usage: scripts/verify-sparkle-dmg.sh <path.dmg>
set -euo pipefail
DMG="${1:?usage: $0 <path.dmg>}"
MOUNT=$(mktemp -d "${TMPDIR:-/tmp}/kh-sparkle-mount.XXXXXX")
cleanup() { hdiutil detach "$MOUNT" -quiet -force >/dev/null 2>&1 || true; }
trap cleanup EXIT

hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
APP="$MOUNT/Business Studio KH.app"
[ -d "$APP" ] || { echo "FAIL: no app inside $DMG" >&2; exit 1; }

/usr/bin/codesign --verify --deep --strict "$APP"
echo "codesign: --deep --strict OK"

ENT=$(/usr/bin/codesign -d --entitlements :- "$APP" 2>/dev/null)
echo "$ENT" | /usr/bin/plutil -p - >/dev/null 2>&1 || { echo "FAIL: no entitlements on the signed app" >&2; exit 1; }
echo "$ENT" | grep -q 'com.apple.security.cs.disable-library-validation' \
  || { echo "FAIL: disable-library-validation missing from the built app" >&2; exit 1; }
echo "entitlement: disable-library-validation present in the built app"

FW="$APP/Contents/Frameworks/Sparkle.framework"
[ -d "$FW" ] || { echo "FAIL: Sparkle.framework not embedded" >&2; exit 1; }
[ -x "$FW/Versions/B/Sparkle" ] || { echo "FAIL: Sparkle binary missing" >&2; exit 1; }
/usr/bin/codesign --verify --strict "$FW"
echo "framework: embedded and signed"
echo "PASS"
