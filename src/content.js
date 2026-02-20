// Macros — content.js (ISOLATED world)
// Responsibilities: state, UI, table, filtering, score, SPA navigation

// ── State ───────────────────────────────────────────────────────────────────
const S = {
  venueId: null,
  sections: [], // [{ slug, name, items[] }] in arrival order
  prodinfo: {}, // itemId → parsed prodinfo object (null = failed)
  nutritionColumns: [], // ordered list of discovered nutrient labels
  errorCount: 0,
  enabled: true, // toggled via extension popup
  filters: { search: "", ranges: {} }, // ranges: label → { min, max }
  sort: { col: "__score", dir: "desc" },
  preset: "high-protein",
  customWeights: {
    Protein: 0,
    Fiber: 0,
    Fat: 0,
    Carbohydrate: 0,
    "of which saturates": 0,
    "of which sugars": 0,
  },
  fetchQueue: new Set(),
  activeFetches: 0,
  visibleOptional: new Set(["allergens", "additives"]),
  selectedSlugs: new Set(), // which category slugs are visible in the table
  viewingProduct: false, // true while Wolt product modal is open from our table
  tableVisible: false, // explicit flag: is the table modal showing (vs the "show" button)?
  activated: false, // true once activateTable() has been called for this page
};

const MAX_CONCURRENT = 4;
const DEBOUNCE_MS = 150;
const CACHE_KEY = (venueId, itemId) => `hw:pi:v1:${venueId}:en:${itemId}`;

// Incremented on every reinit() — stale prodinfo responses from old pages are discarded.
let _reqToken = 0;

// ── Constants ────────────────────────────────────────────────────────────────
const CENTS_PER_EUR = 100;

// Canonical display order for nutrients (kcal is computed, not a raw label)
const NUTRIENT_ORDER = [
  "Protein",
  "Fat",
  "of which saturates",
  "Carbohydrate",
  "of which sugars",
  "Fiber",
  "Salt",
];

const OPTIONAL_COLS = [];

const PRESETS = {
  "high-protein": {
    label: "High Protein",
    desc: "Protein ↑↑  Fiber ↑  Sugar ↓  Sat.Fat ↓",
    weights: {
      Protein: 5,
      Fiber: 2,
      Fat: 0,
      Carbohydrate: 0,
      "of which saturates": -1,
      "of which sugars": -1,
    },
  },
  "low-carb": {
    label: "Low Carb",
    desc: "Carbs ↓↓↓  Sugar ↓↓  Protein ↑  Fiber ↑",
    weights: {
      Protein: 2,
      Fiber: 2,
      Fat: 0,
      Carbohydrate: -3,
      "of which saturates": -1,
      "of which sugars": -2,
    },
  },
  balanced: {
    label: "Balanced",
    desc: "Protein ↑↑  Fiber ↑↑  Sugar ↓↓  Sat.Fat ↓↓",
    weights: {
      Protein: 3,
      Fiber: 3,
      Fat: 0,
      Carbohydrate: -1,
      "of which saturates": -2,
      "of which sugars": -2,
    },
  },
  custom: { label: "Custom", desc: "Set your own weights", weights: null },
};

// Fixed columns definition (in display order)
const FIXED_COLS = [
  { key: "__img", header: "", sortable: false },
  { key: "name", header: "Name", sortable: true },
  { key: "__score", header: "Score", sortable: true },
  { key: "kcal", header: "kcal", sortable: true },
];

// Computed columns get a tinted background
const COMPUTED_COLS = new Set(["__score"]);

// Only these nutrients get their own column (skip sub-nutrients and micronutrients)
const VISIBLE_NUTRIENTS = new Set(["Protein", "Fat", "Carbohydrate", "of which sugars", "Fiber"]);

// ── Item normalization ───────────────────────────────────────────────────────
// Sole place that knows Wolt's raw item shape. Only update here when Wolt changes schema.
function normalizeItem(raw) {
  return {
    id: raw.id,
    name: raw.name ?? "",
    priceCents: raw.price ?? 0,
    originalPriceCents: raw.original_price ?? null,
    unitInfo: raw.unit_info ?? "",
    unitPrice: raw.unit_price ?? null,
    imageUrl: raw.images?.[0]?.url ?? null,
    productUrl: raw.url ?? null,
  };
}

// Fills productUrl nulls by matching DOM card links by position after renderSection.
function resolveProductUrls(section) {
  const slug = location.pathname.match(/venue\/([^/]+)/)?.[1];
  if (!slug) return;
  const cards = [
    ...document.querySelectorAll(`a[href*="/venue/${slug}/"]`),
  ].filter((a) => a.querySelector("img") && !a.closest("nav"));
  section.items.forEach((item, i) => {
    if (!item.productUrl && cards[i]?.href) item.productUrl = cards[i].href;
  });
}

// ── prodinfo parsing ─────────────────────────────────────────────────────────
// Sole place that knows prodinfo HTML structure. No CSS class name references here.
function parseProdinfo(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const result = { sections: {}, nutrition: {} };

  // Info sections: walk siblings after each h3 until next h3
  for (const h3 of doc.querySelectorAll("h3")) {
    const key = h3.textContent.trim();
    const texts = [];
    let sib = h3.nextElementSibling;
    while (sib && sib.tagName !== "H3") {
      const t = sib.textContent.trim();
      if (t) texts.push(t);
      sib = sib.nextElementSibling;
    }
    if (texts.length) result.sections[key] = texts.join("\n");
  }

  // Tolerant nutrition heading: case-insensitive, whitespace-normalized
  const nutritionH3 = [...doc.querySelectorAll("h3")].find((h) => {
    const t = h.textContent.trim().toLowerCase().replace(/\s+/g, " ");
    return (
      t.includes("nutrition") && (t.includes("fact") || t.includes("info"))
    );
  });
  if (!nutritionH3) return result;

  const container = nutritionH3.parentElement;

  for (const li of container.querySelectorAll("li")) {
    const spans = [...li.querySelectorAll("span")];
    if (!spans.length) continue;
    const label = spans[0].textContent.trim();
    if (!label) continue;

    // Structural: sub-nutrients always start with "of which "
    const isIndented = label.toLowerCase().startsWith("of which ");

    const rest = spans
      .slice(1)
      .map((s) => s.textContent.trim())
      .filter((t) => t && t !== "/");
    const entries = [];
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const val = parseFloat(rest[i]);
      if (!isNaN(val)) entries.push({ value: val, unit: rest[i + 1] ?? "" });
    }
    // Odd remainder: last item has no unit
    if (rest.length % 2 !== 0) {
      const val = parseFloat(rest.at(-1));
      if (!isNaN(val)) entries.push({ value: val, unit: "" });
    }
    result.nutrition[label] = { isIndented, entries };
  }

  return result;
}

const getKcal = (pi) =>
  pi.nutrition["Energy"]?.entries.find((e) => e.unit === "kcal")?.value ?? null;
const getNutrientValue = (pi, label) =>
  pi.nutrition[label]?.entries[0]?.value ?? null;

// ── Score ────────────────────────────────────────────────────────────────────
function computeScore(item) {
  const pi = S.prodinfo[item.id];
  if (!pi || !Object.keys(pi.nutrition).length) return null;
  const weights =
    S.preset === "custom" ? S.customWeights : PRESETS[S.preset].weights;
  return Object.entries(weights).reduce((total, [label, w]) => {
    const val = getNutrientValue(pi, label);
    return total + (val ?? 0) * w;
  }, 0);
}

// Returns Map<itemId, rank> for scored items within a section (rank 1 = highest score)
function computeRanks(section) {
  const scored = section.items
    .map((item) => ({ item, score: computeScore(item) }))
    .filter(({ score }) => score !== null)
    .sort((a, b) => b.score - a.score);
  return new Map(scored.map(({ item }, i) => [item.id, i + 1]));
}

// ── Cell value adapter ───────────────────────────────────────────────────────
// Sole place that knows column → value mapping. Uses NItem shape exclusively.
function getCellValue(item, col) {
  const pi = S.prodinfo[item.id];
  switch (col) {
    case "name":
      return item.name;
    case "__score":
      return computeScore(item);
    case "kcal":
      return pi ? getKcal(pi) : null;
    default:
      return pi ? getNutrientValue(pi, col) : null;
  }
}

// ── Sorting ──────────────────────────────────────────────────────────────────
function sortedItems(items) {
  const { col, dir } = S.sort;
  return [...items].sort((a, b) => {
    const va = getCellValue(a, col);
    const vb = getCellValue(b, col);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // nulls always to bottom
    if (vb === null) return -1;
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return dir === "asc" ? cmp : -cmp;
  });
}

// ── Filtering ────────────────────────────────────────────────────────────────
function itemPassesFilters(item) {
  if (S.filters.search) {
    if (!item.name.toLowerCase().includes(S.filters.search.toLowerCase()))
      return false;
  }
  const pi = S.prodinfo[item.id];
  for (const [label, { min, max }] of Object.entries(S.filters.ranges)) {
    if (!pi) continue; // still loading — keep visible
    const val = getNutrientValue(pi, label);
    if (val === null) continue; // nutrient missing → keep visible (flagged with ?)
    if (min !== undefined && val < min) return false;
    if (max !== undefined && val > max) return false;
  }
  return true;
}

// ── Column discovery ─────────────────────────────────────────────────────────
function mergeNutritionColumns(nutrition) {
  const before = S.nutritionColumns.length;
  for (const label of Object.keys(nutrition)) {
    if (label === "Energy") continue; // Skip — kcal is already a fixed column
    if (!VISIBLE_NUTRIENTS.has(label)) continue; // Only essential macros
    if (S.nutritionColumns.includes(label)) continue;
    const idx = NUTRIENT_ORDER.indexOf(label);
    if (idx === -1) {
      S.nutritionColumns.push(label);
      continue;
    }
    const insertBefore = NUTRIENT_ORDER.slice(idx + 1)
      .map((l) => S.nutritionColumns.indexOf(l))
      .find((pos) => pos !== -1);
    insertBefore !== undefined
      ? S.nutritionColumns.splice(insertBefore, 0, label)
      : S.nutritionColumns.push(label);
  }
  if (S.nutritionColumns.length !== before) {
    rebuildTableHeaders();
    rebuildRangeSliders();
  }
}

// ── Error reporting ──────────────────────────────────────────────────────────
function reportError(msg) {
  S.errorCount++;
  console.warn("HW:", msg);
  const el = document.getElementById("hw-status");
  if (el) el.textContent = `${S.errorCount} error(s) — see console`;
}

// ── Venue ID detection ───────────────────────────────────────────────────────
function detectVenueId() {
  // window.__hw_venue_id is set in MAIN world by injector.js — not accessible
  // from ISOLATED world. Parse SSR state from script elements instead.
  const tryJson = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const tryDecode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  // Extract venue slug from current URL to validate SSR data matches current venue
  const currentVenueSlug = location.pathname.match(/\/venue\/([^/]+)/)?.[1];

  for (const script of document.querySelectorAll("script")) {
    const t = script.textContent?.trim();
    if (!t) continue;
    // Check both plain and URL-encoded markers
    if (!t.includes('"queries"') && !t.includes("%22queries%22")) continue;
    for (const text of [t, tryDecode(t)]) {
      const state = tryJson(text);
      const q = state?.queries?.find(
        (q) => q.queryKey?.includes("static") || q.queryKey?.[1] === "static",
      );
      const venue = q?.state?.data?.venue;
      const id = venue?.id;
      if (!id) continue;
      // Verify SSR state matches current venue (prevents stale data after SPA navigate)
      const ssrSlug = venue?.slug ?? venue?.url_slug;
      if (currentVenueSlug && ssrSlug && ssrSlug !== currentVenueSlug) continue;
      return id;
    }
  }
  return null;
}

// Fetch venue ID from API when SSR detection fails (e.g. after SPA navigation).
// Content scripts inherit host_permissions, so we can fetch directly from consumer-api.
async function fetchVenueIdFromAPI() {
  const venueSlug = location.pathname.match(/\/venue\/([^/]+)/)?.[1];
  if (!venueSlug) return null;
  try {
    const res = await fetch(
      `https://consumer-api.wolt.com/order-xp/web/v1/venue/slug/${venueSlug}/dynamic/`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.venue?.id ?? null;
  } catch (err) {
    console.warn("HW: fetchVenueId error:", err.message);
    return null;
  }
}

// Ensures S.venueId is set — tries SSR first, then API fallback.
async function ensureVenueId() {
  if (S.venueId) return S.venueId;
  S.venueId = detectVenueId();
  if (S.venueId) return S.venueId;
  S.venueId = await fetchVenueIdFromAPI();
  return S.venueId;
}

// ── prodinfo queue ───────────────────────────────────────────────────────────
function enqueueProdinfo(item) {
  if (!S.venueId) return;
  const cacheKey = CACHE_KEY(S.venueId, item.id);
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      S.prodinfo[item.id] = JSON.parse(cached);
      mergeNutritionColumns(S.prodinfo[item.id].nutrition);
      updateRow(item.id);
    } catch {
      localStorage.removeItem(cacheKey);
    }
    return;
  }
  if (S.prodinfo[item.id] !== undefined || S.fetchQueue.has(item.id)) return;
  S.fetchQueue.add(item.id);
  drain();
}

function drain() {
  while (S.fetchQueue.size && S.activeFetches < MAX_CONCURRENT) {
    const id = S.fetchQueue.values().next().value;
    S.fetchQueue.delete(id);
    S.activeFetches++;
    fetchProdinfo(id, S.venueId);
  }
}

// Fetch prodinfo via background service worker (avoids CORS restrictions).
async function fetchProdinfo(itemId, venueId) {
  const token = _reqToken;
  try {
    if (!chrome.runtime?.sendMessage) throw new Error("extension context invalidated");
    const resp = await chrome.runtime.sendMessage({
      type: "hw:fetchProdinfo",
      itemId,
      venueId,
    });
    if (token !== _reqToken || venueId !== S.venueId) {
      S.activeFetches--;
      drain();
      return;
    }
    if (resp.notFound) {
      // Item has no prodinfo page (e.g. non-food items) — not an error
      S.prodinfo[itemId] = { sections: {}, nutrition: {} };
      S.activeFetches--;
      updateRow(itemId);
      drain();
      return;
    }
    if (resp.error) throw new Error(resp.error);
    const parsed = parseProdinfo(resp.html);
    S.prodinfo[itemId] = parsed;
    try {
      localStorage.setItem(CACHE_KEY(venueId, itemId), JSON.stringify(parsed));
    } catch {}
    mergeNutritionColumns(parsed.nutrition);
  } catch (err) {
    if (token !== _reqToken) {
      S.activeFetches--;
      drain();
      return;
    }
    S.prodinfo[itemId] = { sections: {}, nutrition: {} };
    reportError(`prodinfo fetch failed for ${itemId}: ${err.message}`);
  }
  S.activeFetches--;
  updateRow(itemId);
  drain();
}

// ── SSR state extraction (runs in ISOLATED world at document_idle) ───────────
function extractSSR() {
  const tryJson = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const tryDecode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  for (const script of document.querySelectorAll("script")) {
    const t = script.textContent?.trim();
    if (!t) continue;
    if (!t.includes('"queries"') && !t.includes("%22queries%22")) continue;
    for (const text of [t, tryDecode(t)]) {
      const state = tryJson(text);
      if (!state?.queries?.length) continue;

      // Venue ID
      const venueQ = state.queries.find(
        (q) => q.queryKey?.includes("static") || q.queryKey?.[1] === "static",
      );
      S.venueId = venueQ?.state?.data?.venue?.id ?? null;

      // Pre-loaded items from SSR category query
      const catQ = state.queries.find(
        (q) =>
          q.queryKey?.includes("category") || q.queryKey?.[1] === "category",
      );
      for (const page of catQ?.state?.data?.pages ?? []) {
        if (page?.items?.length) {
          handleItems({
            slug: page.category?.slug ?? "ssr",
            name: page.category?.name ?? "",
            items: page.items,
          });
        }
      }
      return;
    }
  }
}

// ── Data channel from injector.js (MAIN world → ISOLATED world via DOM) ──────
// injector.js writes <script data-hw-event="items"> elements and fires Event('hw:data').
window.addEventListener("hw:data", () => {
  for (const el of document.querySelectorAll("script[data-hw-event]")) {
    try {
      const type = el.dataset.hwEvent;
      const data = JSON.parse(el.textContent);
      el.remove(); // consume
      if (type === "items") handleItems(data);
    } catch {}
  }
});

// ── Process incoming items (from SSR or intercepted fetches) ─────────────────
function handleItems({ slug, name, items }) {
  if (!S.venueId) {
    S.venueId = detectVenueId();
    // If SSR detection fails, trigger async fallback (prodinfo will queue until ready)
    if (!S.venueId)
      ensureVenueId().then(() => {
        // Retry prodinfo for items that were skipped due to missing venueId
        if (S.venueId)
          S.sections.flatMap((s) => s.items).forEach(enqueueProdinfo);
      });
  }
  const normalized = items.map(normalizeItem);
  const existing = S.sections.find((s) => s.slug === slug);
  if (existing) {
    // Deduplicate by ID before appending (SSR + fetch may overlap)
    const existingIds = new Set(existing.items.map((i) => i.id));
    const fresh = normalized.filter((i) => !existingIds.has(i.id));
    if (!fresh.length) return;
    existing.items.push(...fresh);
    if (isTableRendered()) {
      const tbody = document.querySelector(`tbody[data-slug="${slug}"]`);
      if (tbody) {
        const ranks = computeRanks(existing);
        fresh.forEach((item) => tbody.appendChild(renderRow(item, ranks)));
      }
    }
    fresh.forEach(enqueueProdinfo);
  } else {
    const section = { slug, name, items: normalized };
    S.sections.push(section);
    S.selectedSlugs.add(slug);
    if (isTableRendered()) {
      renderSection(section);
      renderCategoryChips();
    }
    normalized.forEach(enqueueProdinfo);
  }
  tryActivateTable();
}

// ── Render: table skeleton ───────────────────────────────────────────────────
function renderTableSkeleton() {
  // Remove old root if re-rendering (e.g. after SPA navigate)
  document.getElementById("hw-root")?.remove();

  const root = document.createElement("div");
  root.id = "hw-root";

  // Filter bar
  const filterBar = document.createElement("div");
  filterBar.id = "hw-filterbar";
  filterBar.innerHTML = `
    <input id="hw-search" type="search" placeholder="Filter by name…" autocomplete="off">
    <div id="hw-presets">
      ${Object.entries(PRESETS)
        .map(
          ([key, { label, desc }]) =>
            `<button class="hw-preset${key === S.preset ? " active" : ""}" data-preset="${key}" title="${desc}">${label}</button>`,
        )
        .join("")}
    </div>
    <span id="hw-preset-desc" class="hw-preset-desc">${PRESETS[S.preset]?.desc ?? ""}</span>
    <div id="hw-custom-weights" hidden>
      ${Object.keys(S.customWeights)
        .map(
          (label) => `
        <label class="hw-weight-label">
          <span>${label}</span>
          <input type="range" min="-5" max="5" step="1" value="${S.customWeights[label]}" data-weight="${label}">
          <span class="hw-weight-val" data-weight-val="${label}">${S.customWeights[label]}</span>
        </label>
      `,
        )
        .join("")}
    </div>
    <span id="hw-status"></span>
    <button id="hw-close-btn" title="Close Macros">\u00D7</button>
  `;
  root.appendChild(filterBar);

  // Category chips
  const categoryChips = document.createElement("div");
  categoryChips.id = "hw-category-chips";
  root.appendChild(categoryChips);

  // Range filters
  const rangeFilters = document.createElement("div");
  rangeFilters.id = "hw-range-filters";
  root.appendChild(rangeFilters);

  // Table
  const tableWrap = document.createElement("div");
  tableWrap.id = "hw-table-wrap";
  const table = document.createElement("table");
  table.id = "hw-table";

  // colgroup for column visibility
  const colgroup = document.createElement("colgroup");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  for (const col of FIXED_COLS) {
    const col_el = document.createElement("col");
    col_el.dataset.col = col.key;
    colgroup.appendChild(col_el);

    const th = document.createElement("th");
    th.dataset.col = col.key;
    th.textContent = col.header;
    if (col.sortable) {
      th.dataset.sort = col.key;
      if (S.sort.col === col.key) th.dataset.dir = S.sort.dir;
    }
    if (COMPUTED_COLS.has(col.key)) th.classList.add("hw-computed");
    headerRow.appendChild(th);
  }

  // Dynamic nutrition columns added by rebuildTableHeaders()
  thead.appendChild(headerRow);
  table.appendChild(colgroup);
  table.appendChild(thead);

  // No-nutrition tbody (always last)
  const noNutriTbody = document.createElement("tbody");
  noNutriTbody.id = "hw-no-nutrition";
  table.appendChild(noNutriTbody);

  tableWrap.appendChild(table);
  root.appendChild(tableWrap);

  // Backdrop
  document.getElementById("hw-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.id = "hw-backdrop";
  document.body.appendChild(backdrop);

  // Fixed modal — append to body
  document.body.appendChild(root);

  wireFilterBar();
}

// ── Render: category chips ───────────────────────────────────────────────────
function renderCategoryChips() {
  const container = document.getElementById("hw-category-chips");
  if (!container) return;
  if (S.sections.length <= 1) {
    container.innerHTML = "";
    return;
  }
  const allSelected = S.selectedSlugs.size === S.sections.length;
  let html = `<button class="hw-chip${allSelected ? " active" : ""}" data-chip="__all">All</button>`;
  for (const sec of S.sections) {
    const active = S.selectedSlugs.has(sec.slug);
    const escaped = sec.name.replace(/</g, "&lt;");
    html += `<button class="hw-chip${active ? " active" : ""}" data-chip="${sec.slug}">${escaped}</button>`;
  }
  container.innerHTML = html;
  container.onclick = (e) => {
    const btn = e.target.closest(".hw-chip");
    if (!btn) return;
    const chip = btn.dataset.chip;
    if (chip === "__all") {
      if (allSelected) {
        S.selectedSlugs.clear();
      } else {
        for (const sec of S.sections) S.selectedSlugs.add(sec.slug);
      }
    } else {
      const wasOnly = S.selectedSlugs.size === 1 && S.selectedSlugs.has(chip);
      S.selectedSlugs.clear();
      if (wasOnly) {
        // Re-select all if clicking the only active chip
        for (const sec of S.sections) S.selectedSlugs.add(sec.slug);
      } else {
        S.selectedSlugs.add(chip);
      }
    }
    renderCategoryChips();
    scheduleApply();
  };
}

// ── Render: rebuild table headers (called when new nutrition columns arrive) ─
function rebuildTableHeaders() {
  const thead = document.querySelector("#hw-table thead tr");
  const colgroup = document.querySelector("#hw-table colgroup");
  if (!thead || !colgroup) return;

  // Optional column headers (after nutrition columns)
  // Remove existing optional th/col to re-insert after nutrition
  for (const el of [
    ...thead.querySelectorAll("th[data-optional]"),
    ...colgroup.querySelectorAll("col[data-optional]"),
  ]) {
    el.remove();
  }

  // Add th for any nutrition columns not yet in thead
  const existingCols = new Set(
    [...thead.querySelectorAll("th[data-col]")].map((th) => th.dataset.col),
  );
  for (const label of S.nutritionColumns) {
    if (existingCols.has(label)) continue;
    const col_el = document.createElement("col");
    col_el.dataset.col = label;
    const noNutriCol = colgroup.querySelector("col[data-optional]");
    noNutriCol
      ? colgroup.insertBefore(col_el, noNutriCol)
      : colgroup.appendChild(col_el);

    const th = document.createElement("th");
    th.dataset.col = label;
    th.dataset.sort = label;
    th.textContent = label;
    if (S.sort.col === label) th.dataset.dir = S.sort.dir;
    const firstOptional = thead.querySelector("th[data-optional]");
    firstOptional
      ? thead.insertBefore(th, firstOptional)
      : thead.appendChild(th);
  }

  // Re-add optional column headers at end
  for (const { key, label } of OPTIONAL_COLS) {
    const col_el = document.createElement("col");
    col_el.dataset.col = key;
    col_el.dataset.optional = "1";
    if (!S.visibleOptional.has(key)) col_el.classList.add("hw-col-hidden");
    colgroup.appendChild(col_el);

    const th = document.createElement("th");
    th.dataset.col = key;
    th.dataset.optional = "1";
    th.textContent = label;
    if (!S.visibleOptional.has(key)) th.classList.add("hw-col-hidden");
    thead.appendChild(th);
  }

  // Update sort arrows
  for (const th of thead.querySelectorAll("th[data-sort]")) {
    delete th.dataset.dir;
    if (th.dataset.sort === S.sort.col) th.dataset.dir = S.sort.dir;
  }
}

// ── Render: section ──────────────────────────────────────────────────────────
function renderSection(section) {
  const table = document.getElementById("hw-table");
  if (!table) return;

  const tbody = document.createElement("tbody");
  tbody.dataset.slug = section.slug;

  // Section header row
  const headerRow = document.createElement("tr");
  headerRow.className = "hw-section-header";
  const headerCell = document.createElement("td");
  headerCell.colSpan = 9;
  const sectionName = section.name || section.slug;
  headerCell.innerHTML = `<span class="hw-section-name">${sectionName}</span><span class="hw-section-count">${section.items.length} items</span>`;
  headerRow.appendChild(headerCell);
  tbody.appendChild(headerRow);

  // Item rows (prodinfo cells show shimmer until data arrives)
  const ranks = computeRanks(section);
  for (const item of section.items) {
    tbody.appendChild(renderRow(item, ranks));
  }

  // Insert before #hw-no-nutrition
  const noNutri = document.getElementById("hw-no-nutrition");
  table.insertBefore(tbody, noNutri);

  resolveProductUrls(section);
}

function makeShimmerRow(item) {
  const tr = document.createElement("tr");
  tr.dataset.itemId = item.id;
  tr.className = "hw-loading";
  // Fill with shimmer cells — actual content added by updateRow()
  const cols = document.querySelectorAll("#hw-table thead tr th");
  const colCount = cols.length || 10;
  for (let i = 0; i < colCount; i++) {
    const td = document.createElement("td");
    td.className = "hw-shimmer";
    tr.appendChild(td);
  }
  return tr;
}

// ── Render: renderRow (builds a fully-populated tr) ─────────────────────────
function renderRow(item, ranks) {
  const tr = document.createElement("tr");
  tr.dataset.itemId = item.id;
  if (
    !S.prodinfo[item.id] ||
    !Object.keys(S.prodinfo[item.id].nutrition).length
  ) {
    tr.classList.add("hw-no-nutri");
  }

  const pi = S.prodinfo[item.id];
  const allCols = [
    ...FIXED_COLS.map((c) => c.key),
    ...S.nutritionColumns,
    ...OPTIONAL_COLS.map((c) => c.key),
  ];

  for (const col of allCols) {
    const td = document.createElement("td");
    td.dataset.col = col;
    if (COMPUTED_COLS.has(col)) td.classList.add("hw-computed");
    if (OPTIONAL_COLS.some((c) => c.key === col)) {
      td.dataset.optional = "1";
      if (!S.visibleOptional.has(col)) td.classList.add("hw-col-hidden");
    }

    switch (col) {
      case "__img": {
        if (item.imageUrl) {
          const img = document.createElement("img");
          img.src = item.imageUrl;
          img.width = 64;
          img.height = 64;
          img.loading = "lazy";
          const wrap = document.createElement("span");
          wrap.className = "hw-img-wrap";
          wrap.addEventListener("click", (e) => {
            e.stopPropagation();
            openWoltProduct(item);
          });
          wrap.appendChild(img);
          td.appendChild(wrap);
        }
        break;
      }
      case "name": {
        const nameEl = document.createElement("span");
        nameEl.className = "hw-item-name";
        nameEl.textContent = item.name;
        nameEl.addEventListener("click", (e) => {
          e.stopPropagation();
          openWoltProduct(item);
        });
        td.appendChild(nameEl);
        const price = item.priceCents / CENTS_PER_EUR;
        const priceEl = document.createElement("span");
        priceEl.className = "hw-item-price";
        priceEl.textContent = `\u20AC${price.toFixed(2)}`;
        if (item.unitInfo) priceEl.textContent += ` \u00B7 ${item.unitInfo}`;
        td.appendChild(priceEl);
        break;
      }
      case "__score": {
        const score = computeScore(item);
        if (score === null) {
          td.classList.add("hw-shimmer");
        } else {
          const rank = ranks?.get(item.id);
          const valSpan = document.createElement("span");
          valSpan.className = "hw-score-val";
          valSpan.textContent = score.toFixed(1);
          td.appendChild(valSpan);
          if (rank) {
            const rankSpan = document.createElement("span");
            rankSpan.className = "hw-score-rank";
            rankSpan.textContent = `#${rank}`;
            td.appendChild(rankSpan);
          }
        }
        break;
      }
      case "kcal": {
        if (!pi) {
          td.classList.add("hw-shimmer");
          break;
        }
        const k = getKcal(pi);
        td.textContent = k !== null ? String(k) : "—";
        break;
      }
      default: {
        // Nutrition column
        if (!pi) {
          td.classList.add("hw-shimmer");
          break;
        }
        const val = getNutrientValue(pi, col);
        if (val !== null) {
          td.textContent = val.toFixed(1);
          if (pi.nutrition[col]?.isIndented) tr.classList.add("hw-indented");
        } else {
          td.textContent = "—";
        }
        break;
      }
    }
    tr.appendChild(td);
  }

  return tr;
}

// ── Render: updateRow (in-place update after prodinfo arrives) ───────────────
function updateRow(itemId) {
  const tr = document.querySelector(`tr[data-item-id="${itemId}"]`);
  if (!tr) return;

  const pi = S.prodinfo[itemId];
  const item = S.sections.flatMap((s) => s.items).find((i) => i.id === itemId);
  if (!item) return;

  // Find which section this item belongs to (for rank computation)
  const section = S.sections.find((s) => s.items.some((i) => i.id === itemId));
  const ranks = section ? computeRanks(section) : null;

  tr.classList.remove("hw-loading", "hw-no-nutri");
  if (!pi || !Object.keys(pi.nutrition).length) tr.classList.add("hw-no-nutri");

  const allCols = [
    ...FIXED_COLS.map((c) => c.key),
    ...S.nutritionColumns,
    ...OPTIONAL_COLS.map((c) => c.key),
  ];

  for (const col of allCols) {
    let td = tr.querySelector(`td[data-col="${col}"]`);
    if (!td) {
      // Lazy cell creation for newly discovered nutrition columns
      td = document.createElement("td");
      td.dataset.col = col;
      if (COMPUTED_COLS.has(col)) td.classList.add("hw-computed");
      if (OPTIONAL_COLS.some((c) => c.key === col)) {
        td.dataset.optional = "1";
        if (!S.visibleOptional.has(col)) td.classList.add("hw-col-hidden");
      }
      tr.appendChild(td);
    }

    td.classList.remove("hw-shimmer");

    // Re-fill only prodinfo-dependent cells
    switch (col) {
      case "__score": {
        const score = computeScore(item);
        const rank = ranks?.get(item.id);
        td.textContent =
          score !== null
            ? `${score.toFixed(1)}${rank ? ` #${rank}` : ""}`
            : "—";
        break;
      }
      case "kcal": {
        const k = pi ? getKcal(pi) : null;
        td.textContent = k !== null ? String(k) : "—";
        break;
      }
      default: {
        if (FIXED_COLS.some((c) => c.key === col)) break;
        if (!pi) break;
        const val = getNutrientValue(pi, col);
        td.textContent = val !== null ? val.toFixed(1) : "—";
        break;
      }
    }
  }

  // Refresh score cells for all items in same tbody (ranks may have changed)
  const tbody = tr.closest("tbody");
  if (tbody && section) {
    const freshRanks = computeRanks(section);
    for (const row of tbody.querySelectorAll("tr[data-item-id]")) {
      const rowItemId = row.dataset.itemId;
      const rowItem = section.items.find((i) => i.id === rowItemId);
      if (!rowItem) continue;
      const scoreTd = row.querySelector('td[data-col="__score"]');
      if (!scoreTd) continue;
      const score = computeScore(rowItem);
      const rank = freshRanks.get(rowItemId);
      scoreTd.textContent =
        score !== null ? `${score.toFixed(1)}${rank ? ` #${rank}` : ""}` : "—";
    }
  }

  updateRangeSliderBounds();
  scheduleApply(); // Re-sort after score values change
}

// ── Render: sort and filter ──────────────────────────────────────────────────
let _filterTimer;
function scheduleApply() {
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(applySortAndFilter, DEBOUNCE_MS);
}

function applySortAndFilter() {
  const table = document.getElementById("hw-table");
  if (!table) return;

  // Update sort arrows in thead
  for (const th of table.querySelectorAll("th[data-sort]")) {
    delete th.dataset.dir;
    if (th.dataset.sort === S.sort.col) th.dataset.dir = S.sort.dir;
  }

  for (const tbody of table.querySelectorAll("tbody[data-slug]")) {
    const slug = tbody.dataset.slug;
    const section = S.sections.find((s) => s.slug === slug);
    if (!section) continue;

    // Hide entire section if deselected via category chips
    tbody.hidden = !S.selectedSlugs.has(slug);
    if (tbody.hidden) continue;

    const sorted = sortedItems(section.items);
    const sectionHeader = tbody.querySelector(".hw-section-header");

    for (const item of sorted) {
      const tr = tbody.querySelector(`tr[data-item-id="${item.id}"]`);
      if (!tr) continue;
      const passes = itemPassesFilters(item);
      tr.hidden = !passes;
      if (passes) tbody.appendChild(tr); // reorder via re-insertion
    }

    // Section header stays first
    if (sectionHeader) tbody.insertBefore(sectionHeader, tbody.firstChild);
  }
}

// ── Range sliders ────────────────────────────────────────────────────────────
function updateRangeSliderBounds() {
  for (const label of S.nutritionColumns) {
    const values = Object.values(S.prodinfo)
      .map((pi) => getNutrientValue(pi, label))
      .filter((v) => v !== null);
    if (!values.length) continue;
    const min = Math.min(...values),
      max = Math.max(...values);
    const wrap = document.querySelector(
      `[data-range-label="${CSS.escape(label)}"]`,
    );
    if (!wrap) continue;
    const slider = wrap.querySelector(".hw-range-slider");
    if (!slider) continue;
    const dir = wrap.dataset.rangeDir;
    const isMin = dir === "min";
    const curMax = parseFloat(slider.max);
    if (!curMax || max > curMax) {
      slider.max = max;
      // For max-direction sliders, keep at max if user hasn't touched it
      if (!isMin && !slider.dataset.userSet) slider.value = max;
    }
    if (!parseFloat(slider.min) && min >= 0) slider.min = 0;
    // For min-direction sliders, keep at 0 if user hasn't touched it
    if (isMin && !slider.dataset.userSet) slider.value = 0;
    const valEl = wrap.querySelector(".hw-range-val");
    if (valEl) {
      const v = parseFloat(slider.value);
      if (isMin) {
        valEl.textContent = v <= parseFloat(slider.min) ? "all" : `\u2265${v}`;
      } else {
        valEl.textContent = v >= parseFloat(slider.max) ? "all" : `\u2264${v}`;
      }
    }
  }
}

// Only show range filters for visible nutrients
// Direction: 'min' = show items >= threshold (higher is better), 'max' = show items <= threshold (lower is better)
const RANGE_FILTER_CONFIG = {
  Protein: "min",
  Fiber: "min",
  Fat: "max",
  Carbohydrate: "max",
};

function rebuildRangeSliders() {
  const container = document.getElementById("hw-range-filters");
  if (!container) return;

  for (const label of S.nutritionColumns) {
    const dir = RANGE_FILTER_CONFIG[label];
    if (!dir) continue;
    if (container.querySelector(`[data-range-label="${CSS.escape(label)}"]`))
      continue;

    const isMin = dir === "min";
    const wrap = document.createElement("div");
    wrap.className = "hw-range-wrap";
    wrap.dataset.rangeLabel = label;
    wrap.dataset.rangeDir = dir;
    wrap.innerHTML = `
      <span class="hw-range-name">${isMin ? "Min" : "Max"} ${label}</span>
      <input type="range" class="hw-range-slider" min="0" max="100" step="1" value="${isMin ? "0" : "100"}">
      <span class="hw-range-val">all</span>
    `;

    const slider = wrap.querySelector(".hw-range-slider");
    slider.addEventListener("input", () => {
      slider.dataset.userSet = "1";
      const v = parseFloat(slider.value);
      const minVal = parseFloat(slider.min);
      const maxVal = parseFloat(slider.max);
      const valEl = wrap.querySelector(".hw-range-val");
      if (isMin) {
        // Min filter: slider at 0 = all, dragging right sets minimum
        if (v <= minVal) {
          delete S.filters.ranges[label];
          if (valEl) valEl.textContent = "all";
        } else {
          S.filters.ranges[label] = { min: v };
          if (valEl) valEl.textContent = `\u2265${v}`;
        }
      } else {
        // Max filter: slider at max = all, dragging left sets maximum
        if (v >= maxVal) {
          delete S.filters.ranges[label];
          if (valEl) valEl.textContent = "all";
        } else {
          S.filters.ranges[label] = { max: v };
          if (valEl) valEl.textContent = `\u2264${v}`;
        }
      }
      scheduleApply();
    });

    container.appendChild(wrap);
  }
}

// ── Product click: open Wolt's product modal ────────────────────────────────
// Two-layer approach:
//   Layer 1: Find card in DOM, click via MAIN world bridge (SPA navigation)
//   Layer 2: Re-query DOM after delay and retry bridge click (virtualized cards)

/** Find the Wolt card <a> element for a given item using 3 strategies. */
function findCardElement(item) {
  const cardLinks = [...document.querySelectorAll('a[aria-haspopup="dialog"]')];

  // Strategy 1: match by item ID in href (most reliable)
  let card = cardLinks.find((a) => a.href?.includes(`itemid-${item.id}`));

  // Strategy 2: match by product name in <h3>, walk up to card link
  if (!card) {
    const nameEl = [...document.querySelectorAll("h3")].find(
      (el) => el.textContent?.trim() === item.name,
    );
    if (nameEl) {
      let parent = nameEl.parentElement;
      while (parent && parent !== document.body) {
        const link = parent.querySelector('a[aria-haspopup="dialog"]');
        if (link) { card = link; break; }
        parent = parent.parentElement;
      }
    }
  }

  // Strategy 3: match by image URL filename
  if (!card && item.imageUrl) {
    const imgFile = item.imageUrl.split("/").pop()?.split("?")[0];
    if (imgFile) {
      const img = [...document.querySelectorAll("img")].find(
        (el) => el.src?.includes(imgFile) && !el.closest("#hw-root"),
      );
      if (img) {
        let parent = img.parentElement;
        while (parent && parent !== document.body) {
          const link = parent.querySelector('a[aria-haspopup="dialog"]');
          if (link) { card = link; break; }
          parent = parent.parentElement;
        }
      }
    }
  }

  return card;
}

/** Wait for an ack event from injector.js (MAIN world). */
function waitForAck(dataKey, eventName, timeoutMs) {
  return new Promise((resolve) => {
    const handler = () => {
      clearTimeout(timer);
      const result = document.documentElement.dataset[dataKey];
      delete document.documentElement.dataset[dataKey];
      resolve(result === "ok");
    };
    const timer = setTimeout(() => {
      window.removeEventListener(eventName, handler);
      resolve(false);
    }, timeoutMs);
    window.addEventListener(eventName, handler, { once: true });
  });
}

/** Bridge a click on a card element to MAIN world via injector.js. */
function bridgeClick(card) {
  const href = card.getAttribute("href");
  if (!href) return Promise.resolve(false);
  // Set up ack listener BEFORE dispatching — cross-world events may be synchronous
  const ack = waitForAck("hwClickResult", "hw:click-ack", 500);
  document.documentElement.dataset.hwClickHref = href;
  window.dispatchEvent(new Event("hw:click"));
  return ack;
}

/** Show the "Show nutrition table" floating button. */
function showBackButton() {
  let backBtn = document.getElementById("hw-back-btn");
  if (!backBtn) {
    backBtn = document.createElement("button");
    backBtn.id = "hw-back-btn";
    backBtn.textContent = "Show nutrition table";
    backBtn.addEventListener("click", () => {
      S.viewingProduct = false;
      document.querySelector('[data-test-id="modal-close-button"]')?.click();
      backBtn.remove();
      showTable();
    });
    document.body.appendChild(backBtn);
  }
}

/** Show a brief error toast and restore the table. */
function showClickError(item) {
  reportError(`Could not open product: ${item.name}`);
  const root = document.getElementById("hw-root");
  const backdrop = document.getElementById("hw-backdrop");
  if (root) root.style.display = "";
  if (backdrop) backdrop.style.display = "";

  let toast = document.getElementById("hw-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "hw-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = `Could not open "${item.name}"`;
  toast.classList.add("hw-toast-visible");
  setTimeout(() => toast.classList.remove("hw-toast-visible"), 3000);
}

/** Open Wolt's product modal for a table item. Async with fallback layers. */
async function openWoltProduct(item) {
  const root = document.getElementById("hw-root");
  const backdrop = document.getElementById("hw-backdrop");
  if (root) root.style.display = "none";
  if (backdrop) backdrop.style.display = "none";

  // Layer 1: find card in DOM and click via MAIN world bridge
  const card = findCardElement(item);
  if (card) {
    const ok = await bridgeClick(card);
    if (ok) {
      S.viewingProduct = true;
      showBackButton();
      return;
    }
  }

  // Layer 2: re-query after a short wait and retry bridge click
  // (card may not have been in DOM yet due to virtualization, or React re-rendered)
  await new Promise((r) => setTimeout(r, 200));
  const card2 = findCardElement(item);
  if (card2) {
    card2.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 100));
    const ok2 = await bridgeClick(card2);
    if (ok2) {
      S.viewingProduct = true;
      showBackButton();
      return;
    }
  }

  // Layer 3: direct URL navigation (card not in DOM, likely virtualized away)
  // Only trust productUrl if it contains itemid- (resolveProductUrls may set wrong URL)
  const href = (item.productUrl?.includes("itemid-") ? item.productUrl : null)
    || buildProductUrl(item.id);
  if (href) {
    window.location.href = href;
    return;
  }

  // All layers failed — restore table and show error
  showClickError(item);
}

/** Build a product URL from the current venue page URL and item ID. */
function buildProductUrl(itemId) {
  const venueSlug = location.pathname.match(/venue\/([^/]+)/)?.[1];
  if (!venueSlug) return null;
  const prefix = location.pathname.match(/(\/[^/]+\/[^/]+\/[^/]+)\//)?.[1] ?? "";
  return `${prefix}/venue/${venueSlug}/x-itemid-${itemId}`;
}

// ── Show/hide table ──────────────────────────────────────────────────────
function showTable() {
  document.getElementById("hw-show-btn")?.remove();
  let root = document.getElementById("hw-root");
  let backdrop = document.getElementById("hw-backdrop");
  if (!root || !backdrop) {
    // DOM was wiped (e.g. translate feature) — rebuild from state
    activateTable(); // ends with hideTable() which sets tableVisible=false
    root = document.getElementById("hw-root");
    backdrop = document.getElementById("hw-backdrop");
  }
  S.tableVisible = true;
  if (root) root.style.display = "";
  if (backdrop) backdrop.style.display = "";
}

function hideTable() {
  S.tableVisible = false;
  const root = document.getElementById("hw-root");
  const backdrop = document.getElementById("hw-backdrop");
  if (root) root.style.display = "none";
  if (backdrop) backdrop.style.display = "none";
  ensureShowButton();
}

function ensureShowButton() {
  if (document.getElementById("hw-show-btn")) return;
  const btn = document.createElement("button");
  btn.id = "hw-show-btn";
  btn.textContent = "Show nutrition table";
  btn.addEventListener("click", () => {
    btn.remove();
    showTable();
  });
  document.body.appendChild(btn);
}

// ── Filter bar wiring ────────────────────────────────────────────────────────
function wireFilterBar() {
  // Close button — hides table, shows floating button
  document.getElementById("hw-close-btn")?.addEventListener("click", () => {
    hideTable();
  });

  // Backdrop click — close modal
  document.getElementById("hw-backdrop")?.addEventListener("click", () => {
    hideTable();
  });

  // Search
  document.getElementById("hw-search")?.addEventListener("input", (e) => {
    S.filters.search = e.target.value;
    scheduleApply();
  });

  // Preset buttons
  for (const btn of document.querySelectorAll(".hw-preset")) {
    btn.addEventListener("click", () => {
      S.preset = btn.dataset.preset;
      document
        .querySelectorAll(".hw-preset")
        .forEach((b) =>
          b.classList.toggle("active", b.dataset.preset === S.preset),
        );
      document.getElementById("hw-custom-weights").hidden =
        S.preset !== "custom";
      const descEl = document.getElementById("hw-preset-desc");
      if (descEl) descEl.textContent = PRESETS[S.preset]?.desc ?? "";
      scheduleApply();
      // Persist
      chrome.storage?.local?.set({ hwPreset: S.preset });
      // Refresh score cells
      document.querySelectorAll("tr[data-item-id]").forEach((tr) => {
        const itemId = tr.dataset.itemId;
        const item = S.sections
          .flatMap((s) => s.items)
          .find((i) => i.id === itemId);
        if (!item) return;
        const section = S.sections.find((s) =>
          s.items.some((i) => i.id === itemId),
        );
        const ranks = section ? computeRanks(section) : null;
        const scoreTd = tr.querySelector('td[data-col="__score"]');
        if (!scoreTd) return;
        const score = computeScore(item);
        const rank = ranks?.get(itemId);
        scoreTd.textContent =
          score !== null
            ? `${score.toFixed(1)}${rank ? ` #${rank}` : ""}`
            : "—";
      });
    });
  }

  // Custom weight sliders
  for (const input of document.querySelectorAll(
    "#hw-custom-weights input[data-weight]",
  )) {
    input.addEventListener("input", (e) => {
      const label = e.target.dataset.weight;
      S.customWeights[label] = parseFloat(e.target.value);
      const valEl = document.querySelector(`[data-weight-val="${label}"]`);
      if (valEl) valEl.textContent = S.customWeights[label];
      scheduleApply();
      chrome.storage?.local?.set({ hwCustomWeights: S.customWeights });
    });
  }

  // Sort on th click
  document.querySelector("#hw-table thead")?.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const col = th.dataset.sort;
    S.sort.dir = S.sort.col === col && S.sort.dir === "desc" ? "asc" : "desc";
    S.sort.col = col;
    scheduleApply();
  });
}

// ── Table activation ─────────────────────────────────────────────────────────
function isTableRendered() {
  return !!document.getElementById("hw-root");
}

function activateTable() {
  S.activated = true;
  renderTableSkeleton();
  rebuildTableHeaders();
  rebuildRangeSliders();

  for (const section of S.sections) renderSection(section);
  renderCategoryChips();
  S.sections.flatMap((s) => s.items).forEach(enqueueProdinfo);

  // Start hidden — user clicks "Show nutrition table" to reveal
  hideTable();

  // Proactively fetch all pages of items for the current category
  fetchCurrentCategoryItems();
}

// ── Proactive category fetching ────────────────────────────────────────────────
// Fetches all pages of items for the current category via the consumer API.
// Uses direct fetch() — MV3 content scripts inherit host_permissions.
// Parent categories (e.g. "Fruits") return 0 items — we detect this and fetch
// each subcategory's items using slugs extracted from the sidebar DOM.
async function fetchCurrentCategoryItems() {
  const venueSlug = location.pathname.match(/venue\/([^/]+)/)?.[1];
  const categorySlug = location.pathname.match(/items\/([^/?#]+)/)?.[1];
  if (!venueSlug || !categorySlug) return;

  const token = _reqToken;

  // Ensure venue ID is available (needed for prodinfo fetches later)
  await ensureVenueId();
  if (token !== _reqToken) return;

  // Fetch all pages for a single category slug
  async function fetchCategoryPages(slug, fallbackName) {
    let pageToken = null;
    let totalItems = 0;
    do {
      try {
        const base = `https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/${venueSlug}/assortment/categories/slug/${slug}?language=en`;
        const url = pageToken
          ? `${base}&page_token=${encodeURIComponent(pageToken)}`
          : base;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (token !== _reqToken) return 0; // page changed during fetch

        const items = data.items ?? [];
        const name = fallbackName ?? data.category?.name ?? slug;
        if (items.length) handleItems({ slug, name, items });
        totalItems += items.length;

        pageToken = data.metadata?.next_page_token ?? null;
      } catch (err) {
        reportError(`Category fetch failed for ${slug}: ${err.message}`);
        break;
      }
    } while (pageToken);
    return totalItems;
  }

  // Try the current URL category first
  const itemCount = await fetchCategoryPages(categorySlug);
  if (token !== _reqToken) return;

  // If 0 items, this is a parent category — fetch each subcategory from sidebar.
  // Retry with increasing delay since sidebar may not have rendered yet.
  if (itemCount === 0) {
    let subcats = [];
    for (let attempt = 0; attempt < 4 && subcats.length === 0; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        if (token !== _reqToken) return;
      }
      subcats = getSubcategorySlugs(venueSlug, categorySlug);
    }
    for (const { slug, name } of subcats) {
      if (token !== _reqToken) return;
      await fetchCategoryPages(slug, name);
    }
  }
}

// Extract subcategory slugs from sidebar DOM. Parent categories in Wolt's sidebar
// show nested subcategory links below the active category link.
function getSubcategorySlugs(venueSlug, parentSlug) {
  const itemsBase = `/venue/${venueSlug}/items/`;
  // Find the active parent link in the sidebar
  const parentLink = [
    ...document.querySelectorAll(`a[href*="${itemsBase}${parentSlug}"]`),
  ].find(
    (a) =>
      a.getAttribute("href")?.match(/items\/([^/?#]+)/)?.[1] === parentSlug,
  );
  if (!parentLink) return [];

  // Walk up multiple levels from parent link to find a container with subcategory links.
  // Sidebar DOM structure varies — subcategories may be nested several levels up.
  let container = parentLink.parentElement;
  for (
    let level = 0;
    level < 6 && container && container !== document.body;
    level++
  ) {
    const result = [];
    for (const link of container.querySelectorAll(`a[href*="${itemsBase}"]`)) {
      const slug = link.getAttribute("href")?.match(/items\/([^/?#]+)/)?.[1];
      if (!slug || slug === parentSlug) continue;
      result.push({ slug, name: link.textContent?.trim() ?? slug });
    }
    if (result.length > 0) return result;
    container = container.parentElement;
  }
  return [];
}

function isItemsPage() {
  return /\/venue\/.+\/items\//.test(location.pathname);
}

function tryActivateTable() {
  if (!S.enabled || !isItemsPage() || isTableRendered()) return;
  activateTable();
}

// ── SPA navigation ───────────────────────────────────────────────────────────
function reinit() {
  _reqToken++; // invalidate all in-flight prodinfo responses
  S.sections = [];
  S.selectedSlugs.clear();
  S.prodinfo = {};
  S.nutritionColumns = [];
  S.fetchQueue.clear();
  S.activeFetches = 0;
  S.errorCount = 0;
  S.venueId = null;
  S.viewingProduct = false;
  S.activated = false;
  S.tableVisible = false;
  document.getElementById("hw-root")?.remove();
  document.getElementById("hw-backdrop")?.remove();
  document.getElementById("hw-back-btn")?.remove();
  document.getElementById("hw-show-btn")?.remove();
  document.getElementById("hw-toast")?.remove();
  if (S.enabled && isItemsPage()) {
    activateTable();
  }
}

function onUrlChange() {
  // When the user clicked a product from our table, Wolt navigates away from
  // /items/ to a product URL. Don't tear down — just keep the modal hidden.
  if (S.viewingProduct) return;

  if (isItemsPage()) {
    reinit();
  } else {
    document.getElementById("hw-root")?.remove();
    document.getElementById("hw-backdrop")?.remove();
    document.getElementById("hw-back-btn")?.remove();
    document.getElementById("hw-show-btn")?.remove();
  }
}

// SPA navigation detection: poll location.href since MAIN→ISOLATED event dispatch
// is unreliable. Polling every 500ms is lightweight and catches all navigation methods.
let _lastUrl = location.href;
setInterval(() => {
  if (location.href !== _lastUrl) {
    _lastUrl = location.href;
    onUrlChange();
  }
}, 500);

// ── Boot ─────────────────────────────────────────────────────────────────────
// Load persisted preferences + enabled state
chrome.storage.local.get(
  ["hwPreset", "hwCustomWeights", "hwEnabled"],
  (data) => {
    if (data.hwPreset && PRESETS[data.hwPreset]) S.preset = data.hwPreset;
    if (data.hwCustomWeights) {
      for (const [k, v] of Object.entries(data.hwCustomWeights)) {
        if (k in S.customWeights) S.customWeights[k] = v;
      }
    }
    S.enabled = data.hwEnabled !== false; // default on

    // Extract SSR items directly (content.js runs at document_idle, scripts are present)
    extractSSR();

    // Also consume any data elements injector.js may have written before we loaded
    for (const el of document.querySelectorAll("script[data-hw-event]")) {
      try {
        const type = el.dataset.hwEvent;
        const payload = JSON.parse(el.textContent);
        el.remove();
        if (type === "items") handleItems(payload);
      } catch {}
    }

    tryActivateTable();
  },
);

// Listen for popup toggle changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("hwEnabled" in changes)) return;
  S.enabled = changes.hwEnabled.newValue !== false;
  if (S.enabled) {
    tryActivateTable();
  } else {
    S.activated = false;
    S.tableVisible = false;
    document.getElementById("hw-root")?.remove();
    document.getElementById("hw-backdrop")?.remove();
    document.getElementById("hw-show-btn")?.remove();
  }
});

// Recovery: Wolt's translate feature (and similar DOM rewrites) can strip
// body-appended elements. This interval checks our state flags against
// actual DOM presence and re-injects whatever is missing.
tryActivateTable();
setInterval(() => {
  if (!S.enabled || !isItemsPage() || !S.activated) return;

  if (S.tableVisible) {
    // Table should be showing — ensure root + backdrop exist and are visible
    const root = document.getElementById("hw-root");
    const backdrop = document.getElementById("hw-backdrop");
    if (!root || !backdrop) {
      // DOM was wiped — full rebuild, then show
      activateTable();
      showTable();
    }
  } else {
    // Table is hidden — ensure the "show" button exists
    if (!document.getElementById("hw-show-btn")) {
      ensureShowButton();
    }
  }
}, 1000);
