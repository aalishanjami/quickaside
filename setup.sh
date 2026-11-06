#!/bin/bash
# One-time setup for Quickaside on macOS 14.2 or later.
# Run it from Terminal.app:  bash setup.sh
# Safe to run again: finished steps are skipped or redone quickly.
set -euo pipefail
cd "$(dirname "$0")"

# Keep Homebrew quiet and quick for the one package we may install.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "This setup is for macOS."

step "1/5 Checking tools"
command -v node >/dev/null || fail "Node.js is missing. Install it with: brew install node"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is needed (you have $(node -v)). Run: brew upgrade node"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  fail "Installing Xcode Command Line Tools. Run bash setup.sh again when that finishes."
fi
if ! command -v cmake >/dev/null; then
  command -v brew >/dev/null || fail "cmake is missing. Install Homebrew (https://brew.sh) or cmake, then run this again."
  brew install cmake
fi
if command -v claude >/dev/null; then
  echo "Found Claude Code $(claude --version 2>/dev/null | head -1)"
else
  echo "Claude Code is not installed yet. Install it before your first call:"
  echo "  curl -fsSL https://claude.ai/install.sh | bash   then run: claude   and sign in"
fi

step "2/5 Installing app dependencies"
npm install --no-fund --no-audit
node node_modules/electron/install.js

step "3/5 Building whisper-server (one time, a few minutes)"
WHISPER_MODE="server"
if ! bash scripts/build-whisper.sh; then
  echo
  echo "Could not build whisper-server, so using Homebrew's whisper-cli instead."
  echo "It works the same, with about a second more delay per line."
  command -v brew >/dev/null || fail "Homebrew is needed for this fallback. Install it from https://brew.sh and run bash setup.sh again."
  brew install whisper-cpp || fail "brew install whisper-cpp failed."
  WHISPER_MODE="cli"
fi

step "4/5 Downloading the speech model"
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  MODEL="ggml-large-v3-turbo-q5_0.bin"
else
  MODEL="ggml-base.en.bin"
fi
MODELS="$HOME/Library/Application Support/Quickaside/models"
mkdir -p "$MODELS"
if [ -s "$MODELS/$MODEL" ]; then
  echo "Already have $MODEL"
else
  curl -fL --progress-bar -o "$MODELS/$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  mv "$MODELS/$MODEL.part" "$MODELS/$MODEL"
fi

step "5/5 Building Quickaside.app"
bash scripts/build-mac-app.sh

step "Done"
echo "Open it with:  open \"$HOME/Applications/Quickaside.app\""
echo "It lives in the menu bar and offers to start when a call begins."
echo "macOS will ask for microphone and system audio access on your first call."
if [ "$WHISPER_MODE" = "cli" ]; then
  echo
  echo "Transcription is using whisper-cli for now. Once the compiler issue above is fixed,"
  echo "run  bash scripts/build-whisper.sh  for the faster whisper-server. No other step is needed."
fi
