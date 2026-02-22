#!/bin/bash
# Create a GitHub release with the built extension zip.
# Usage: bash scripts/release.sh
# Requires: gh CLI authenticated
set -euo pipefail

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/')
TAG="v${VERSION}"
ZIP="macros-${VERSION}.zip"

# Build first
bash build.sh

# Check if tag already exists
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "Error: Tag $TAG already exists. Bump version first with: npm run version -- patch"
  exit 1
fi

# Create tag and push
git tag "$TAG"
git push origin "$TAG"

# Create GitHub release with zip attached
gh release create "$TAG" "$ZIP" \
  --title "Macros $VERSION" \
  --generate-notes

echo ""
echo "Released: $TAG"
echo "URL: https://github.com/m-esm/macros/releases/tag/$TAG"
