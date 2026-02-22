# Macros — Chrome Extension

Nutrition grid for your grocery shopping. Injects a sortable/filterable dark-themed modal table showing nutrition facts alongside prices for all items in a category. Currently supports Wolt Market.

## Project Structure

```
macros/
├── manifest.json              # MV3 extension manifest (source of truth for version)
├── package.json               # npm metadata (version synced with manifest)
├── LICENSE                    # Non-commercial license
├── src/
│   ├── injector.js            # MAIN world: intercepts Wolt fetch API calls
│   ├── content.js             # ISOLATED world: state, table UI, prodinfo fetching
│   ├── content.css            # Dark-themed modal + table styles
│   ├── background.js          # Service worker: proxies prodinfo.wolt.com fetches (CORS)
│   ├── popup.html             # Extension popup with enable/disable toggle
│   └── popup.js               # Popup logic (chrome.storage)
├── icons/                     # Extension icons (16, 48, 128 PNG + source SVG)
├── store/                     # Chrome Web Store assets (screenshots, description)
├── scripts/
│   ├── version.sh             # Bump version in manifest + package.json
│   └── release.sh             # Tag + GitHub release with built zip
├── build.sh                   # Build .zip for Chrome Web Store
├── launch-chrome.sh           # Launch Chrome for Testing with extension + CDP
├── start-mcp.sh               # Launch Chrome + Playwright MCP server
├── privacy.html               # Privacy policy page
└── .mcp.json                  # MCP server config for Claude Code
```

## Architecture

Two content scripts injected on `https://wolt.com/*`:

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

### Internal prefixes

All internal code uses `hw-` / `hw:` prefixes (from the original "Healthy Wolt" name). These are invisible to users and intentionally kept as-is:
- `hw-*` DOM IDs and CSS classes
- `--hw-*` CSS custom properties
- `hw:*` event names and message types
- `hw:pi:v1:*` localStorage cache keys

## Versioning & Releases

**Source of truth**: `manifest.json` version field.

### Bump version
```bash
npm run version -- patch   # 1.1.0 → 1.1.1
npm run version -- minor   # 1.1.0 → 1.2.0
npm run version -- major   # 1.1.0 → 2.0.0
```
This updates both `manifest.json` and `package.json`, then builds the zip.

### Create a release
```bash
npm run release
```
This builds the zip, creates a git tag `vX.Y.Z`, pushes it, and creates a GitHub release with the zip attached.

### Build only (no version change)
```bash
npm run build
```
Outputs `macros-X.Y.Z.zip` for Chrome Web Store upload.

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
  - "Min Protein" / "Min Fiber" — drag right to set minimum threshold
  - "Max Fat" / "Max Carbohydrate" — drag left to set maximum threshold
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

3. **Navigate to a Wolt venue page**:
   ```
   https://wolt.com/en/fin/helsinki/venue/wolt-market-vallila/items/ruoanvalmistus-101
   ```

4. **Verify**: Visit `chrome://extensions` — "Macros" should appear with no errors.

### IMPORTANT: Reuse browser tabs

When testing with MCP tools, **always reuse existing tabs** instead of opening new ones. Use `browser_tabs` to list tabs and `browser_navigate` to navigate.

### Chrome caches extension files

**Chrome aggressively caches extension JS/CSS**. After editing source files, you MUST restart Chrome:

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

## Code Conventions

- Modern JS: optional chaining (`?.`), nullish coalescing (`??`), `Array.at()`, `for…of`
- No build step, no frameworks — plain vanilla JS
- Single mutable state object `S` — all mutations via explicit assignment
- `normalizeItem()` is the sole place that knows Wolt's raw item shape
- `getCellValue()` is the sole place that maps column keys to values
- Error reporting: `reportError()` increments counter + `console.warn('HW:', ...)`

## Test URLs

- `https://wolt.com/en/fin/helsinki/venue/wolt-market-vallila/items/ruoanvalmistus-101` — Cooking supplies (small, quick tests)
- `https://wolt.com/en/fin/helsinki/venue/wolt-market-vallila/items/meijerituotteet-munat-100` — Dairy & Eggs (parent category with subcategories)

## Git Conventions

- Never add `Co-Authored-By` lines to commit messages
- Commit messages: imperative mood, concise, focus on "why"
