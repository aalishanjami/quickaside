#!/bin/bash
# One-time, optional step. Makes a self-signed code signing certificate so
# rebuilds of Callaside keep their macOS permissions.
#
# Everything goes in one folder of its own. The login keychain, the keychain
# search list and system trust settings are left alone. To undo it, delete
# that folder; the next build goes back to ad-hoc signing.
set -euo pipefail
umask 077

[ "$(uname)" = "Darwin" ] || { echo "Run this on macOS."; exit 1; }

SIGN_DIR="$HOME/Library/Application Support/Callaside/signing"
KEYCHAIN="$SIGN_DIR/signing.keychain-db"
PASSWORD_FILE="$SIGN_DIR/keychain-password"
# Homebrew's OpenSSL 3 writes a .p12 that `security import` cannot read.
OPENSSL="${OPENSSL:-/usr/bin/openssl}"

if [ -f "$KEYCHAIN" ]; then
  echo "Signing identity already exists: $KEYCHAIN"
  exit 0
fi

WORK="$(mktemp -d)"
FINISHED=0
cleanup() {
  rm -rf "$WORK"
  if [ "$FINISHED" != 1 ]; then
    security delete-keychain "$KEYCHAIN" 2>/dev/null || true
    rm -f "$KEYCHAIN" "$PASSWORD_FILE"
  fi
}
trap cleanup EXIT

mkdir -p "$SIGN_DIR"

cat > "$WORK/cert.conf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = Callaside

[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -sha256 -days 7300 \
  -config "$WORK/cert.conf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

P12_PASSWORD="$("$OPENSSL" rand -hex 16)"
"$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/identity.p12" -passout "pass:$P12_PASSWORD"

"$OPENSSL" rand -hex 24 > "$PASSWORD_FILE"
KEYCHAIN_PASSWORD="$(cat "$PASSWORD_FILE")"

# Creating a keychain can add it to the user's search list. Put the list back,
# so only the build ever sees this one.
SEARCH_BEFORE="$(security list-keychains -d user)"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
if [ "$(security list-keychains -d user)" != "$SEARCH_BEFORE" ]; then
  KEYCHAINS=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#\"}"
    line="${line%\"}"
    [ -n "$line" ] && KEYCHAINS+=("$line")
  done <<< "$SEARCH_BEFORE"
  if [ "${#KEYCHAINS[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${KEYCHAINS[@]}"
  fi
fi

security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$WORK/identity.p12" -k "$KEYCHAIN" -f pkcs12 -P "$P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null

FINISHED=1
echo "Created the signing identity in: $SIGN_DIR"
echo "Now rebuild with:  bash scripts/build-mac-app.sh"
echo "macOS asks for permissions once more after that build, then keeps them."
