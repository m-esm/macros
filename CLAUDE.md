# Macros — Chrome Extension

Nutrition grid for your grocery shopping. Injects a sortable/filterable dark-themed modal table showing nutrition facts alongside prices for all items in a category. Currently supports Wolt Market.

## Project Structure

```
healthy-wolt/
├── manifest.json          # MV3 extension manifest
├── src/
│   ├── injector.js        # MAIN world: intercepts Wolt fetch API calls
│   ├── content.js         # ISOLATED world: state, table UI, prodinfo fetching
│   ├── content.css        # Dark-themed modal + table styles
│   ├── background.js      # Service worker: proxies prodinfo.wolt.com fetches (avoids CORS)
│   ├── popup.html         # Extension popup with enable/disable toggle
│   └── popup.js           # Popup logic (chrome.storage)
├── icons/                 # Extension icons (16, 48, 128)
├── launch-chrome.sh       # Launches Chrome for Testing with extension + CDP
├── start-mcp.sh           # Launches Chrome + Playwright MCP server
├── playwright-mcp.config.ini
└── .mcp.json              # MCP server config for Claude Code
```

## Architecture

Two content scripts injected on `https://wolt.com/*/venue/*/items/*`:

1. **injector.js** (MAIN world, `document_start`): Patches `window.fetch` to intercept Wolt's category API responses. Passes data to content.js via DOM elements (`<script data-hw-event>`), NOT via CustomEvent detail (detail doesn't cross MAIN↔ISOLATED boundary).

2. **content.js** (ISOLATED world, `document_idle`): Owns all state, UI rendering, and prodinfo fetching. Extracts SSR (TanStack dehydrated state) directly from `<script>` tags. Fetches product info via background service worker to avoid CORS. Proactively fetches all category pages via consumer API.

3. **background.js** (service worker): Proxies `prodinfo.wolt.com` fetches. Content scripts can't fetch cross-origin even with host_permissions in MV3 — only the service worker can.

### Cross-world communication

**IMPORTANT**: `CustomEvent.detail` does NOT cross the MAIN↔ISOLATED world boundary in Chrome MV3. The two worlds share the DOM but have separate JS contexts. To pass data from MAIN→ISOLATED:

- injector.js writes `<script type="application/json" data-hw-event="items">` elements to the DOM
- Dispatches `new Event('hw:data')` (empty event, no detail)
- content.js listens for `hw:data`, reads and removes the `<script>` elements

### Product click bridge

Content script (ISOLATED world) cannot trigger React event handlers directly. To open Wolt's product modal:
- content.js writes a CSS selector to `document.documentElement.dataset.hwClickTarget`
- Dispatches `new Event('hw:click')`
- injector.js (MAIN world) reads the selector and calls `.click()` on the matching element

### SSR data format

Wolt embeds TanStack Query dehydrated state in a `<script>` tag. The content may be URL-encoded (`%7B%22mutations%22...`) — must `decodeURIComponent` before `JSON.parse`. Contains venue ID, category items, etc.

## Current Features

### Table UI
- **Fixed modal** with 30px inset, dark backdrop, close button
- **Hidden by default** — "Show nutrition table" floating button reveals it
- **64x64 product thumbnails** with rounded corners
- **Price displayed under product name** (no separate price column)
- Columns: Image, Name (+ price subtitle), Score, Size, kcal, Protein, Fat, Carbohydrate, Fiber

### Scoring & Presets
- **Score presets**: High Protein, Low Carb, Balanced, Custom
- Each preset shows description text (e.g. "Protein ↑↑ Fiber ↑ Sugar ↓ Sat.Fat ↓")
- **Custom preset**: 6 weight sliders (Protein, Fiber, Fat, Carbohydrate, saturates, sugars) range -5 to +5
- Score = weighted sum of per-100g nutrient values; displayed as `score #rank` within section

### Filtering
- **Text search**: filters by product name
- **Directional range sliders**:
  - "Min Protein" / "Min Fiber" — drag right to set minimum threshold (≥X)
  - "Max Fat" / "Max Carbohydrate" — drag left to set maximum threshold (≤X)
  - All start at "all" (no filter active)

### Sorting
- Click any column header to sort; click again to reverse
- Default: Score descending
- Nulls always sort to bottom

### SPA Navigation
- URL polling every 500ms detects navigation
- `reinit()` increments `_reqToken` to discard stale in-flight prodinfo responses
- Product click hides modal, shows "Show nutrition table" button to return

### Caching
- Prodinfo cached in localStorage: `hw:pi:v1:${venueId}:en:${itemId}`
- Preset + custom weights persisted via `chrome.storage.local`

## Testing with Chrome for Testing + MCP

### Prerequisites

- Chrome for Testing installed via Playwright: `npx playwright install chromium`
  - Located at: `/Users/mohsen/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
- Node.js with playwright package: `npm install` in project root

### How to test

1. **Kill any existing Chrome for Testing**:
   ```bash
   pkill -9 -f "Google Chrome for Testing"
   ```

2. **Launch Chrome with extension loaded**:
   ```bash
   bash launch-chrome.sh &
   ```
   This starts Chrome for Testing with:
   - `--remote-debugging-port=9333` (CDP for MCP/DevTools)
   - `--load-extension=.` (loads the extension from project root)
   - `--user-data-dir=./chrome-profile` (isolated profile)

3. **Verify Chrome is running**:
   ```bash
   curl -s http://localhost:9333/json/version
   ```

4. **Navigate to a Wolt venue page** (via MCP or manually):
   ```
   https://wolt.com/en/fin/helsinki/venue/wolt-market-vallila/items/ruoanvalmistus-101
   ```

5. **Check extension is loaded**: Visit `chrome://extensions` — "Macros" should appear with no errors.

6. **Verify in DevTools console**:
   - `window.fetch.toString()` should NOT contain `[native code]` (injector.js patched it)
   - `document.getElementById('hw-root')` should return the table container
   - No `HW:` warnings in console (each is a counted error)

### IMPORTANT: Reuse browser tabs

When testing with the Playwright MCP tools, **always reuse existing tabs** instead of opening new ones. Use `browser_tabs` to list tabs and `browser_navigate` to navigate the current tab. Do NOT open a new tab for every test — this wastes resources and leaves stale tabs behind. After testing, the tab should be left on the test page for the next interaction.

### MCP-based testing (for Claude Code)

The `.mcp.json` configures a Playwright MCP server that connects to Chrome via CDP on port 9333. This allows Claude Code to:

- Take snapshots/screenshots of the page
- Evaluate JavaScript in the page context (MAIN world)
- Click, type, navigate — interact with the extension UI
- Check console messages for errors

To start the MCP server (usually done automatically by Claude Code):
```bash
bash start-mcp.sh
```

### Chrome caches extension files

**Chrome aggressively caches extension JS/CSS**. After editing extension source files, you MUST restart Chrome for changes to take effect — a page reload alone is NOT sufficient.

```bash
lsof -ti :9333 | xargs kill 2>/dev/null
sleep 1
bash launch-chrome.sh &
```

### Clean restart (when extension doesn't load)

```bash
pkill -9 -f "Google Chrome for Testing"
rm -rf chrome-profile
bash launch-chrome.sh &
```

### Common issues

- **Extension not visible in chrome://extensions**: Check `launch-chrome.sh` path, ensure `--load-extension` points to project root
- **CORS errors on prodinfo fetch**: Prodinfo must go through background.js service worker, not direct fetch from content/injector scripts
- **Table not appearing**: Check if SSR extraction found items (console: `HW:` messages). Wolt's SSR script may be URL-encoded
- **CustomEvent detail is null**: This is expected — MAIN↔ISOLATED world boundary. Use DOM elements for data transfer
- **Stale profile**: Delete `chrome-profile/` directory and restart Chrome
- **CSS specificity**: Use `#hw-table .class td` when overriding `#hw-table td` rules — the ID selector needs to be present on both sides
- **Changes not visible after reload**: Chrome caches extension files — restart Chrome entirely

## Code Conventions

- Modern JS: optional chaining (`?.`), nullish coalescing (`??`), `Array.at()`, `for…of`
- No build step, no frameworks — plain vanilla JS
- Single mutable state object `S` — all mutations via explicit assignment
- Parser (`parseProdinfo`) never touches CSS class names — structure-only
- `normalizeItem()` is the sole place that knows Wolt's raw item shape
- `getCellValue()` is the sole place that maps column keys to values
- Error reporting: `reportError()` increments counter + `console.warn('HW:', ...)`

## Test URL examples

- `https://wolt.com/en/fin/helsinki/venue/wolt-market-vallila/items/ruoanvalmistus-101` (Cooking supplies — small category, good for quick tests)
- `https://wolt.com/en/fin/helsinki/venue/wolt-market-vallila/items/meijerituotteet-munat-100` (Dairy & Eggs — parent category with subcategories)
