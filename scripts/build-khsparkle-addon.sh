#!/bin/zsh
# Builds native/khsparkle.node — the Node-API bridge to the shared Sparkle shim.
# The shim and its vendored framework live in the sparkle-shim folder; override
# KH_SPARKLE_SHIM when they move. Fails loudly rather than shipping without them.
set -euo pipefail
cd "$(dirname "$0")/.."
SHIM="${KH_SPARKLE_SHIM:-$HOME/Developer/_orchestra/developer-system/sparkle-shim-20261123}"

[ -f "$SHIM/include/khsparkle.h" ] || { echo "kh-sparkle: no shim at $SHIM (set KH_SPARKLE_SHIM)" >&2; exit 1; }
[ -f "$SHIM/dist/libkhsparkle.a" ] || { echo "kh-sparkle: no $SHIM/dist/libkhsparkle.a" >&2; exit 1; }
[ -d "$SHIM/vendor/Sparkle.framework" ] || { echo "kh-sparkle: no $SHIM/vendor/Sparkle.framework" >&2; exit 1; }

NODE_INC="$(dirname "$(command -v node)")/../include/node"
[ -f "$NODE_INC/node_api.h" ] || { echo "kh-sparkle: no node_api.h at $NODE_INC" >&2; exit 1; }

mkdir -p native
xcrun clang -arch arm64 -fobjc-arc -O2 -Wall -bundle -undefined dynamic_lookup \
  -mmacosx-version-min=12.0 \
  -I "$NODE_INC" -I "$SHIM/include" \
  -F "$SHIM/vendor" \
  -Wl,-rpath,@loader_path/../../Frameworks \
  native/khsparkle_addon.m \
  "$SHIM/dist/libkhsparkle.a" -framework Sparkle -framework Foundation -framework AppKit \
  -o native/khsparkle.node

codesign --force --sign - native/khsparkle.node
echo "built native/khsparkle.node"
