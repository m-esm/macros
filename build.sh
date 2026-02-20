#!/bin/bash
# Build script — creates a clean .zip for Chrome Web Store submission
set -euo pipefail

NAME="macros"
VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
OUT="${NAME}-${VERSION}.zip"

rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  privacy.html \
  src/ \
  icons/ \
  -x "*.DS_Store" \
  -x "icons/*.svg" \
  -x "icons/option-*"

echo ""
echo "Built: $OUT"
echo "Size:  $(du -h "$OUT" | cut -f1)"
echo ""
echo "Contents:"
unzip -l "$OUT"
