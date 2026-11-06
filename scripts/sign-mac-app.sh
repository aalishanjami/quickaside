#!/bin/bash
# Signs the app bundle given as the first argument.
#
# With the identity from create-signing-identity.sh, the app keeps the same
# code requirement from build to build, so macOS keeps its permissions.
# Without it the app is signed ad-hoc: everything works, but each rebuild looks
# like a new app and macOS asks for the permissions again.
set -euo pipefail

APP="$1"
SIGN_DIR="$HOME/Library/Application Support/Quickaside/signing"
KEYCHAIN="$SIGN_DIR/signing.keychain-db"
PASSWORD_FILE="$SIGN_DIR/keychain-password"

sign_adhoc() {
  codesign --force --deep --sign - "$APP"
}

find_identity() {
  security unlock-keychain -p "$(cat "$PASSWORD_FILE")" "$KEYCHAIN" || return 1
  security find-identity -p codesigning "$KEYCHAIN" | awk '$1 == "1)" { print $2; exit }'
}

if [ ! -f "$KEYCHAIN" ] || [ ! -f "$PASSWORD_FILE" ]; then
  sign_adhoc
  echo "Signed ad-hoc, so macOS will ask for permissions again after each rebuild."
  echo "To stop that, run this once:  bash scripts/create-signing-identity.sh"
  exit 0
fi

IDENTITY="$(find_identity || true)"
if [ -n "$IDENTITY" ] && codesign --force --deep --timestamp=none --keychain "$KEYCHAIN" --sign "$IDENTITY" "$APP"; then
  echo "Signed with the local identity. Permissions carry over to the next build."
else
  echo "Could not use the local signing identity, so signing ad-hoc." >&2
  echo "macOS will ask for permissions again after this build." >&2
  sign_adhoc
fi
