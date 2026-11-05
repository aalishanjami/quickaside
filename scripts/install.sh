#!/bin/bash
# Installs Callaside from the latest release on GitHub:
#
#   curl -fsSL https://raw.githubusercontent.com/aalishanjami/callaside/main/scripts/install.sh | bash
#
# The app isn't notarized by Apple. A file fetched by curl has no quarantine flag,
# so macOS opens it without the "could not verify" block a browser download gets.
# In exchange this script checks the signature itself, against the project's
# certificate. It needs no password, because it installs for this user only.
set -euo pipefail

NAME="Callaside"
BUNDLE_ID="ai.callaside.app"
REPO="aalishanjami/callaside"
CERT="d5f63df75e4fd02dcde7595b3c197ae7b4067dd2"
RELEASES="${CALLASIDE_RELEASES:-https://github.com/$REPO/releases}"
DEST="$HOME/Applications"
QUIT_WAIT_SECONDS=30

fail() {
  echo "Could not install: $*" >&2
  exit 1
}

check_mac() {
  [ "$(uname -s)" = Darwin ] || fail "$NAME runs on a Mac."
  [ "$(uname -m)" = arm64 ] || fail "$NAME needs Apple Silicon."
  local version major minor
  version="$(sw_vers -productVersion)"
  major="${version%%.*}"
  minor="$(echo "$version" | cut -s -d. -f2)"
  # Core Audio's taps, which capture the call audio, arrived in macOS 14.2.
  if [ "$major" -lt 14 ] || { [ "$major" -eq 14 ] && [ "${minor:-0}" -lt 2 ]; }; then
    fail "$NAME needs macOS 14.2 or newer. This Mac has $version."
  fi
}

is_running() {
  [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null || echo false)" = true ]
}

quit_app() {
  is_running || return 0
  echo "Quitting $NAME. A call in progress is saved first."
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  local waited=0
  while is_running; do
    [ "$waited" -lt "$QUIT_WAIT_SECONDS" ] || fail "$NAME did not quit. Quit it from the menu bar and run this again."
    sleep 1
    waited=$((waited + 1))
  done
}

main() {
  check_mac

  local latest tag version zip
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp:?}"' EXIT

  # GitHub redirects /latest to the newest release's tag.
  latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest")" || fail "could not find the latest release. Check your connection and try again."
  tag="${latest##*/}"
  case "$tag" in
    v[0-9]*) ;;
    *) fail "no release was found." ;;
  esac
  version="${tag#v}"
  zip="${NAME// /-}-$version-mac-arm64.zip"

  echo "Downloading $NAME $version"
  curl -fL --progress-bar -o "$tmp/$zip" "$RELEASES/download/$tag/$zip" || fail "the download did not finish."
  ditto -x -k "$tmp/$zip" "$tmp/unpacked" || fail "the download is damaged."

  codesign --verify --deep --strict -R="certificate leaf = H\"$CERT\"" "$tmp/unpacked/$NAME.app" 2>/dev/null ||
    fail "the download is not signed with this project's certificate, so it was not installed."

  quit_app
  mkdir -p "$DEST"
  rm -rf "${DEST:?}/$NAME.app"
  ditto "$tmp/unpacked/$NAME.app" "$DEST/$NAME.app"
  echo "Installed $NAME in $DEST"
  open "$DEST/$NAME.app"
}

# Last, so a download cut off halfway can't run half a script.
main "$@"
