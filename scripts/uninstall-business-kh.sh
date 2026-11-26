#!/bin/bash
# Owner rule 2026-11-12: uninstalling removes the app, its helper, any launchd
# job and its login item, and leaves user data alone. Media keeps every runner
# inside the bundle (Electron helpers in Contents/Frameworks) and installs no
# launchd job, so trashing the bundle removes the helper with it; the login item
# is cleared by the app itself, headlessly, before the bundle moves.
set -euo pipefail

APP="${1:-/Applications/Business Studio KH.app}"
ROTATE="${ROTATE:-$HOME/Desktop/_trash/business-studio-kh/$(date +%Y-%m-%d) uninstall}"

if [ ! -d "$APP" ]; then
  echo "Nothing to remove: $APP is not installed."
  exit 0
fi

# 1. Clear the login item from inside the bundle (no window, no UI scripting).
"$APP/Contents/MacOS/Business Studio KH" --clear-login-item >/dev/null 2>&1 || true

# 2. No launchd job exists for this app; if one ever appears, unload it.
for label in $(/bin/launchctl list 2>/dev/null | awk '{print $3}' | grep -i 'mediastudiokh' || true); do
  /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  echo "Unloaded launchd job $label"
done

# 3. Move the bundle (helpers included) to the one Desktop trash — never deleted in place.
mkdir -p "$ROTATE"
mv "$APP" "$ROTATE/Business Studio KH.app"
echo "Moved $APP to $ROTATE"

# 4. User data is untouched on purpose: ~/Pictures/Business Studio KH and the
#    app's userData folder stay where they are.
echo "User data kept: your data folder and settings were not touched."
