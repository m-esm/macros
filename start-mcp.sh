#!/bin/bash
# Start Chrome with extension, then start the Playwright MCP server connected via CDP.
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=9333

# Check if Chrome is already running on the debug port
if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
  echo "Chrome already running on port $PORT" >&2
else
  echo "Launching Chrome with extension..." >&2
  "$DIR/launch-chrome.sh" &
  # Wait for CDP to be ready
  for i in $(seq 1 30); do
    if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
      echo "Chrome ready on port $PORT" >&2
      break
    fi
    sleep 0.5
  done
fi

exec npx @playwright/mcp@latest --config "$DIR/playwright-mcp.config.ini"
