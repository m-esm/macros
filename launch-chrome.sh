#!/bin/bash
# Launch Chrome for Testing with the Macros extension and remote debugging.
# Regular Google Chrome blocks --load-extension; Chrome for Testing allows it.
# Used by the Playwright MCP server to connect via CDP.

DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$DIR/chrome-profile"
PORT="${CDP_PORT:-9333}"

# Use Playwright's Chrome for Testing (supports --load-extension)
CHROME="/Users/mohsen/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

if [ ! -f "$CHROME" ]; then
  echo "Chrome for Testing not found. Run: npx playwright install chromium" >&2
  exit 1
fi

# Kill any existing instance on this debug port
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null
sleep 0.5

exec "$CHROME" \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE" \
  --load-extension="$DIR" \
  --disable-extensions-except="$DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-background-networking \
  --disable-component-update \
  --disable-features=Translate,MediaRouter \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --password-store=basic \
  about:blank
