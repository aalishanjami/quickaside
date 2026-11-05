#!/bin/bash
# Packs the app into "Callaside.app" in ~/Applications.
# The bundle declares the microphone and system-audio permissions macOS asks
# for, and carries whisper-server and the call detector. sign-mac-app.sh signs
# it for this Mac. release-mac.sh uses BUILD_ONLY=1 and signs it for everyone.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="Callaside"
BUNDLE_ID="${BUNDLE_ID:-ai.callaside.app}"
SRC_APP="node_modules/electron/dist/Electron.app"
HELPERS="${HELPERS_DIR:-$HOME/Library/Application Support/Callaside/bin}"

[ "$(uname)" = "Darwin" ] || { echo "Run this on macOS."; exit 1; }
[ -x node_modules/.bin/electron-fuses ] && [ -d node_modules/audiotee ] || npm install --no-fund --no-audit
[ -d "$SRC_APP" ] || node node_modules/electron/install.js

OUT="dist/$NAME.app"
rm -rf "$OUT"
mkdir -p dist
ditto "$SRC_APP" "$OUT"

RES="$OUT/Contents/Resources"
APPDIR="$RES/app"
rm -f "$RES/default_app.asar"
mkdir -p "$APPDIR/node_modules"
cp package.json "$APPDIR/"
ditto src "$APPDIR/src"
ditto node_modules/audiotee "$APPDIR/node_modules/audiotee"

# These have to be in place before signing, so the signature covers them.
HELPERS_DIR="$HELPERS" bash scripts/build-helpers.sh
mkdir -p "$APPDIR/vendor/bin"
for tool in whisper-server call-detector calendar-helper; do
  if [ -x "$HELPERS/$tool" ]; then
    cp "$HELPERS/$tool" "$APPDIR/vendor/bin/"
  else
    echo "$tool not found in $HELPERS, so the app will look for it at runtime."
  fi
done

# Electron only counts a build as packaged once the executable has its own name,
# and updates stay off until then. The helper apps keep their Electron names,
# because Electron looks for those first.
mv "$OUT/Contents/MacOS/Electron" "$OUT/Contents/MacOS/$NAME"

PLIST="$OUT/Contents/Info.plist"
plutil -replace CFBundleExecutable -string "$NAME" "$PLIST"
plutil -replace CFBundleName -string "$NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$NAME" "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace NSMicrophoneUsageDescription -string "Callaside transcribes your side of the call on this Mac." "$PLIST"
plutil -replace NSAudioCaptureUsageDescription -string "Callaside transcribes the other side of the call on this Mac." "$PLIST"
plutil -replace NSCalendarsFullAccessUsageDescription -string "Callaside reads the event you are in, to name the call and suggest the project." "$PLIST"
plutil -replace LSUIElement -bool true "$PLIST" # lives in the menu bar, no Dock icon
cp build/icon.icns "$RES/$NAME.icns" # drawn by scripts/make-icon.js
rm -f "$RES/electron.icns"
plutil -replace CFBundleIconFile -string "$NAME.icns" "$PLIST"
plutil -replace LSMinimumSystemVersion -string "14.2" "$PLIST" # AudioTee's Core Audio taps need it
VERSION="$(node -p "require('./package.json').version")"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"

# Otherwise any program could start this binary as plain Node or with a debugger,
# and use its mic and call audio permissions. Signing comes after, because this
# changes the framework.
node_modules/.bin/electron-fuses write --app "$OUT" RunAsNode=off EnableNodeOptionsEnvironmentVariable=off EnableNodeCliInspectArguments=off

xattr -cr "$OUT" 2>/dev/null || true
[ "${BUILD_ONLY:-}" = 1 ] && exit 0
bash scripts/sign-mac-app.sh "$OUT"

DEST="$HOME/Applications"
mkdir -p "$DEST"
rm -rf "$DEST/$NAME.app"
ditto "$OUT" "$DEST/$NAME.app"
echo "Installed: $DEST/$NAME.app"
