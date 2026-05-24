#!/bin/bash
# Patch Baileys to use MACOS platform instead of WEB
# WhatsApp rejects Platform.WEB since Feb 24, 2026
# See: https://github.com/WhiskeySockets/Baileys/pull/2365

set -e

BAILEYS_FILE="node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js"

if [ ! -f "$BAILEYS_FILE" ]; then
  echo "⚠️  Baileys validate-connection.js not found — skipping patch"
  exit 0
fi

if grep -q "Platform.WEB" "$BAILEYS_FILE"; then
  # Cross-platform sed: macOS BSD sed requires `-i ''`; GNU sed allows `-i`.
  # Using a tempfile avoids the divergence entirely.
  sed "s/Platform\.WEB/Platform.MACOS/g; s/WebSubPlatform\.WEB_BROWSER/WebSubPlatform.MACOS_BROWSER/g" \
    "$BAILEYS_FILE" > "${BAILEYS_FILE}.tmp"
  mv "${BAILEYS_FILE}.tmp" "$BAILEYS_FILE"
  echo "✅ Patched Baileys: Platform.WEB → Platform.MACOS, WEB_BROWSER → MACOS_BROWSER"
else
  echo "ℹ️  Baileys already patched (Platform.MACOS)"
fi
