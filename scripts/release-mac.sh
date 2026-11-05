#!/bin/bash
# Builds a release on this Mac: hardened runtime, signed with the project's own
# certificate, packed as a zip for scripts/install.sh and the update service.
#
# The certificate is self-signed, so Apple doesn't notarize these builds. People
# install with the curl line in install.sh, because a file fetched by curl has no
# quarantine flag for Gatekeeper to stop. A self-signed certificate has no Team
# ID, so library validation has to be off for the app to load its own framework.
#
# Every release must use this one certificate, or updates are refused and people
# have to allow their permissions again. So a release is signed by it or it fails.
#
#   HELPERS_DIR   use helpers already built there, instead of building for every Mac
#   BUNDLE_ID     a throwaway id, to try a release without touching the real app
#   TEST_BUILD=1  keep the test switches, to drive this build on this Mac. It is
#                 signed like a release but never packed, so it can't ship.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="$(node -p "require('./package.json').productName")"
VERSION="$(node -p "require('./package.json').version")"
SLUG="${NAME// /-}"
APP="dist/$NAME.app"
OUT="dist/release"
SIGN_DIR="$HOME/Library/Application Support/Callaside/signing"
KEYCHAIN="$SIGN_DIR/signing.keychain-db"
CERT="$(sed -n 's/^CERT="\(.*\)"$/\1/p' scripts/install.sh)"

[ -f "$KEYCHAIN" ] || { echo "The signing certificate is missing from $SIGN_DIR. Restore it from your backup."; exit 1; }
security unlock-keychain -p "$(cat "$SIGN_DIR/keychain-password")" "$KEYCHAIN"
IDENTITY="$(security find-identity -p codesigning "$KEYCHAIN" | awk '$1 == "1)" { print $2; exit }')"
[ -n "$IDENTITY" ] || { echo "No certificate found in $KEYCHAIN."; exit 1; }

sign() { # sign <target> [entitlements]
  local target="$1" ent="${2:-}"
  set -- --keychain "$KEYCHAIN"
  if [ -n "$ent" ]; then set -- "$@" --entitlements "$ent"; fi
  codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$@" "$target" 2>&1 | grep -v "replacing existing signature" || true
}

deepest_first() { awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-; }

# This Mac's own whisper-server may not load on older ones, so a release builds its own.
if [ -z "${HELPERS_DIR:-}" ]; then
  HELPERS_DIR="$PWD/dist/helpers"
  [ -x "$HELPERS_DIR/whisper-server" ] || WHISPER_PORTABLE=1 WHISPER_OUT="$HELPERS_DIR/whisper-server" bash scripts/build-whisper.sh
fi
export HELPERS_DIR
BUILD_ONLY=1 bash scripts/build-mac-app.sh
if [ "${TEST_BUILD:-}" != 1 ]; then
  # A public build refuses switches and test variables, see src/main/launch.js.
  node -e 'const fs = require("fs"), file = process.argv[1], p = JSON.parse(fs.readFileSync(file)); p.release = true; fs.writeFileSync(file, JSON.stringify(p, null, 2));' "$APP/Contents/Resources/app/package.json"
fi

echo "Signing, innermost code first"
# One by one, because --deep leaves loose tools ad-hoc.
find "$APP/Contents/Resources/app" "$APP/Contents/Frameworks" -type f \( -perm +111 -o -name '*.dylib' -o -name '*.so' -o -name '*.node' \) |
  deepest_first | while IFS= read -r file; do
    file -b "$file" | grep -q 'Mach-O' || continue
    case "$file" in
      */audiotee) sign "$file" build/entitlements.audio.plist ;;
      */calendar-helper) sign "$file" build/entitlements.calendar.plist ;;
      */ShipIt) sign "$file" build/entitlements.updater.plist ;; # it loads Squirrel's frameworks, and crashes without this
      *) sign "$file" ;;
    esac
  done
find "$APP/Contents/Frameworks" -type d -name '*.framework' | deepest_first | while IFS= read -r bundle; do
  sign "$bundle"
done
find "$APP/Contents/Frameworks" -type d -name '*.app' | deepest_first | while IFS= read -r bundle; do
  sign "$bundle" build/entitlements.helper.plist
done
sign "$APP" build/entitlements.main.plist
codesign --verify --deep --strict -R="certificate leaf = H\"$CERT\"" "$APP"
echo "Signature verified"
[ "${TEST_BUILD:-}" != 1 ] || { echo "Test build ready at $APP. Not packed."; exit 0; }

rm -rf "${OUT:?}"
mkdir -p "$OUT"
# The update service finds this by name: it needs -mac and -arm64.
ZIP="$OUT/$SLUG-$VERSION-mac-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "Built $ZIP"
echo "Try it, then make a draft release. The update service can't take a release"
echo "back, only replace it with a newer one, so check the draft before publishing:"
echo "  gh release create v$VERSION \"$ZIP\" --draft --generate-notes --title v$VERSION"
