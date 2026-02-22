#!/bin/bash
# Bump version across manifest.json and package.json, then build.
# Usage: bash scripts/version.sh <major|minor|patch>
set -euo pipefail

BUMP="${1:-}"
if [[ ! "$BUMP" =~ ^(major|minor|patch)$ ]]; then
  echo "Usage: npm run version -- <major|minor|patch>"
  echo ""
  echo "Examples:"
  echo "  npm run version -- patch   # 1.1.0 → 1.1.1"
  echo "  npm run version -- minor   # 1.1.0 → 1.2.0"
  echo "  npm run version -- major   # 1.1.0 → 2.0.0"
  exit 1
fi

# Read current version from manifest.json (source of truth)
CURRENT=$(grep '"version"' manifest.json | head -1 | sed 's/.*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"

# Update manifest.json
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" manifest.json

# Update package.json
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" package.json

echo "Version: $CURRENT → $NEW"
echo ""

# Build the zip
bash build.sh
