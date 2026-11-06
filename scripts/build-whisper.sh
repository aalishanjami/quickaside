#!/bin/bash
# Builds whisper.cpp's whisper-server with Metal for this Mac.
# Homebrew's whisper-cpp formula ships without the server, so we build it once.
# WHISPER_PORTABLE=1 builds for every supported Mac instead of this one, for
# releases, and WHISPER_OUT says where to put the result.
# Exit codes: 0 built, 2 no working C++ compiler setup, other = build failure.
set -euo pipefail

VERSION="${WHISPER_VERSION:-v1.9.5}"
DATA="$HOME/Library/Application Support/Quickaside"
SRC="$HOME/.quickaside/whisper.cpp-$VERSION"
CLT_CXX_DIR="/Library/Developer/CommandLineTools/usr/include/c++"

CXX_BIN="${CXX:-}"
if [ -z "$CXX_BIN" ]; then
  if [ -x /usr/bin/c++ ]; then CXX_BIN=/usr/bin/c++; else CXX_BIN=c++; fi
fi

# True when the C++ compiler finds its standard headers with the given extra flags.
cxx_ok() {
  printf '#include <array>\n#include <mutex>\n#include <string>\n#include <vector>\n#include <thread>\n#include <cmath>\n#include <cstdio>\nint main() { return 0; }\n' |
    "$CXX_BIN" -x c++ -std=c++17 -fsyntax-only "$@" - >/dev/null 2>&1
}

CXX_FIX=""
if ! cxx_ok; then
  echo "The C++ compiler can't find its standard headers (<mutex>, <array>)."
  SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
  for d in \
    "$SDK/usr/include/c++/v1" \
    /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1 \
    /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk/usr/include/c++/v1 \
    /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/include/c++/v1; do
    if [ -f "$d/mutex" ] && cxx_ok -nostdinc++ -isystem "$d"; then
      CXX_FIX="-nostdinc++ -isystem $d"
      break
    fi
  done
  if [ -z "$CXX_FIX" ]; then
    echo "No working C++ headers were found on this Mac."
    echo "  SDK: ${SDK:-not found}"
    ls -d /Library/Developer/CommandLineTools/SDKs/* 2>/dev/null | sed 's/^/  /' || true
    echo "Reinstall the Command Line Tools, then run: bash scripts/build-whisper.sh"
    echo "  sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install"
    exit 2
  fi
  echo "Using the SDK's C++ headers instead: ${CXX_FIX#-nostdinc++ -isystem }"
  if [ -d "$CLT_CXX_DIR" ]; then
    echo "Cause: a leftover $CLT_CXX_DIR from an older macOS hides them."
    echo "Optional permanent fix for other builds on this Mac:"
    echo "  sudo mv \"$CLT_CXX_DIR\" \"$CLT_CXX_DIR.old\""
  fi
fi

OUT="${WHISPER_OUT:-$DATA/bin/whisper-server}"
BUILD_DIR="$SRC/build"
PORTABLE_FLAGS=""
if [ "${WHISPER_PORTABLE:-}" = 1 ]; then
  BUILD_DIR="$SRC/build-portable"
  # GGML_NATIVE would tune for the build Mac's chip and could crash on an M1.
  PORTABLE_FLAGS="-DCMAKE_OSX_DEPLOYMENT_TARGET=14.2 -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16"
fi

mkdir -p "$(dirname "$OUT")" "$(dirname "$SRC")"

if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp "$SRC"
fi

# shellcheck disable=SC2086 (the flags are meant to split)
cmake -S "$SRC" -B "$BUILD_DIR" -Wno-dev -Wno-deprecated $PORTABLE_FLAGS \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_SDL2=OFF \
  -DGGML_CCACHE=OFF \
  "-DCMAKE_CXX_FLAGS=$CXX_FIX"

cmake --build "$BUILD_DIR" --config Release -j "$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" --target whisper-server

cp "$BUILD_DIR/bin/whisper-server" "$OUT"
chmod +x "$OUT"
if ! "$OUT" --help 2>&1 | grep -i "usage" >/dev/null; then
  echo "Warning: whisper-server was built but did not print its usage text."
fi
echo "whisper-server installed at: $OUT"
