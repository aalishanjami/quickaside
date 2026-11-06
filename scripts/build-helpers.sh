#!/bin/bash
# Compiles the small Swift helpers. Optional: without them everything else
# works, but calls are started by hand and the calendar stays off.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${HELPERS_DIR:-$HOME/Library/Application Support/Quickaside/bin}"
# The oldest macOS with Core Audio's process list. Without a target, swiftc
# builds for the macOS it runs on, and the result won't load on older ones.
TARGET="arm64-apple-macos14.2"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found, so call detection stays off. Install the Command Line Tools to turn it on."
  exit 0
fi

mkdir -p "$OUT_DIR"

build() { # build <name> [extra swiftc flags]
  local name="$1"
  local src="scripts/$name.swift"
  local out="$OUT_DIR/$name"
  local plist="scripts/$name.plist" # linked into the binary, so a change to it needs a rebuild too
  shift
  if [ -x "$out" ] && [ "$out" -nt "$src" ] && { [ ! -f "$plist" ] || [ "$out" -nt "$plist" ]; }; then
    return 0
  fi
  if swiftc -O -target "$TARGET" "$@" "$src" -o "$out.tmp"; then
    mv "$out.tmp" "$out"
    echo "Built $name."
  else
    rm -f "$out.tmp"
    echo "Could not build $name, so that feature stays off."
  fi
}

build call-detector
# A bare tool has no Info.plist, and macOS refuses calendar access without the
# reason it holds, so it goes inside the binary.
build calendar-helper -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker scripts/calendar-helper.plist
