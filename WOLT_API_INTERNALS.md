# Wolt Market Vallila — Data Fetching Internals

> Scope: how items, categories, and nutrition data are fetched for this specific store.
> Venue slug: `wolt-market-vallila` | Venue ID: `62061ac0e2f301c8956d298f`

---

## Architecture Overview

Wolt's venue pages use **React + TanStack Query (React Query)**. Data arrives in two ways:

1. **SSR dehydrated state** — all initial data is server-rendered into a `<script>` tag, decoded client-side.
2. **Client-side API calls** — subsequent fetches as the user browses (category items, pagination).

---

## 1. SSR Data — TanStack Query Dehydrated State

Every page embeds a `<script type="application/json" class="query-state">` tag.

**How to decode:**
```js
const script = document.querySelector('script.query-state');
const data = JSON.parse(decodeURIComponent(script.textContent));
// { mutations: [], queries: [...] }
```

Each query: `{ queryKey: [...], state: { data: ... } }`

### Query Keys Baked Into SSR

| Query Key | Content |
|---|---|
| `['woltCities', 'en', null]` | All ~955 cities worldwide |
| `['footer', 'en']` | Footer links |
| `['geoIpCountry']` | Detected country |
| `['translations/en']` | All ~3284 UI string keys |
| `['venue', 'static', 'wolt-market-vallila', 'en']` | Venue static info, order minimum |
| `['venue-assortment', 'category-listing', 'wolt-market-vallila', null, null, 'en', 'no-user']` | Full category tree (55 top-level categories) |
| `['venue-assortment', 'venue-content', 'wolt-market-vallila', 'no-user', 'en', null, null]` | Main page sections (Deals, Popular, etc.) with items |
| `['venue-assortment', 'category', 'wolt-market-vallila', ...subcategory_slugs..., null, null, 'en', 'no-user']` | Items for the currently viewed category |
| `['server', 'feature-flag-data']` | Feature flags |

---

## 2. API Endpoints

### 2a. Venue Dynamic (status, banners)

```
GET https://consumer-api.wolt.com/order-xp/web/v1/venue/slug/{venue_slug}/dynamic/
    ?selected_delivery_method=homedelivery
```

**Returns:** open/closed status, discount banners, delivery configs. **No items.**

**Required headers:**
```
app-language: en
platform: Web
Origin: https://wolt.com
```

---

### 2b. Category Items ← **Primary items API**

```
GET https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/{venue_slug}/assortment/categories/slug/{category_slug}
    ?language=fi
    [&page_token={next_page_token}]
```

> **Use `language=fi`** (primary language). `language=en` works but returns auto-translated names and sometimes fewer items.

**Works for both top-level categories and subcategories** (e.g., `hedelmat-50` or `sesongin-hedelmat-52`).

**Response:**
```json
{
  "category": {
    "id": "29cf7e84f28663d1027d8c60",
    "name": "Hedelmät",
    "slug": "hedelmat-50",
    "description": "..."
  },
  "categories": [
    { "id": "...", "item_ids": ["id1", "id2"] }
  ],
  "items": [ /* full item objects, ~8 per page */ ],
  "options": [],
  "variant_groups": [],
  "metadata": {
    "next_page_token": null,  // or "cursor_string" for next page
    "page": 1
  }
}
```

**Pagination:** When `next_page_token` is not null, pass `&page_token={value}` to get the next page (~8 items each).

---

### 2c. Product Info / Nutrition Facts

```
GET https://prodinfo.wolt.com/{lang}/{venue_id}/{item_id}
    ?lang={lang}
    [&themeMode=dark&themeTextPrimary=rgba(255,255,255,1)&...]
```

**Returns: HTML, not JSON.** This is an iframe embed shown inside the product modal.

**Example:**
```
https://prodinfo.wolt.com/en/62061ac0e2f301c8956d298f/8b98a77fcbe57f8f10285d33?lang=en&themeMode=dark
```

**Trigger condition:** Only fetch if `item.has_extra_info === true`.

**Parsed HTML structure:**
```html
<h2>Product Name</h2>
<p class="Product-module...description">Full description text</p>

<div class="InfoItem-module...root">
  <h3>GTIN</h3>
  <p>06408430407545</p>
</div>
<div class="InfoItem-module...root">
  <h3>Country of origin</h3>
  <p>Suomi</p>
</div>
<div class="InfoItem-module...root">
  <h3>Ingredients</h3>
  <p>pastöroitu rasvaton MAITO, MAITOPROTEIINI, ...</p>
</div>
<div class="InfoItem-module...root">
  <h3>Allergens</h3>
  <p>Maito ja -tuotteet, myös laktoosi</p>
</div>

<h3>Nutrition facts</h3>
<div class="NutritionInformationTable-module...content">
  <div class="...baselineHeader">Amount per 100 g</div>
  <ul class="...nutritionTable">
    <li class="...nutritionRow">
      <span>Energy</span>
      <div class="...nutritionValueGroup">
        <div class="...nutritionValue"><span>192</span><span>kJ</span></div>
        <div class="...nutritionValue"><span>/</span><span>45</span><span>kcal</span></div>
      </div>
    </li>
    <li><span>Fat</span>            <span>0.4</span><span>g</span></li>
    <li><span class="...indented">of which saturates</span> <span>0.2</span><span>g</span></li>
    <li><span>Carbohydrate</span>   <span>4</span><span>g</span></li>
    <li><span class="...indented">of which sugars</span>    <span>4</span><span>g</span></li>
    <li><span>Protein</span>        <span>5.6</span><span>g</span></li>
    <li><span>Salt</span>           <span>0.1</span><span>g</span></li>
    <li><span>Calcium</span>        <span>160</span><span>mg</span></li>
    <!-- More nutrients possible -->
  </ul>
</div>
```

**Parsing strategy:** Use CSS selectors on `.nutritionTable li` → first `span` = label, last `span` pair = value + unit. Indented rows (class `indented`) are sub-nutrients.

---

## 3. Item Object Structure

Every item in the API response has this shape:

```typescript
interface WoltItem {
  id: string;
  name: string;                    // product name
  description: string;             // product description (Finnish)
  price: number;                   // price in CENTS (e.g., 368 = €3.68)
  original_price: number | null;   // pre-discount price, null if no sale
  lowest_price: number | null;     // lowest price in last 30 days (EU law)
  unit_info: string;               // "120 g", "1 l", "8 pcs"
  unit_price: {
    price: number;                 // per-unit price in cents
    original_price: number | null;
    unit: "kilogram" | "litre" | "piece";
    base: number;                  // usually 1
  };
  images: { url: string; blurhash: string | null }[];
  barcode_gtin: string;            // EAN barcode
  has_extra_info: boolean;         // → fetch prodinfo URL for nutrition facts
  dietary_preferences: string[];   // e.g., ["vegan", "gluten-free"]
  deposit: { amount: number; label: null } | null;  // bottle deposit in cents
  sell_by_weight_config: {         // for loose/weighted products
    grams_per_step: number;
    input_type: "number_of_items";
    price_per_kg: number;
  } | null;
  alcohol_permille: number;        // 0 for non-alcoholic
  caffeine_info: object | null;
  vat_percentage: number;          // e.g., 13
  vat_percentage_decimal: string;  // e.g., "13.5"
  product_hierarchy_tags: string[] | null;  // e.g., ["PERISHABLE"]
  tags: string[];
  options: any[];                  // for modifiable items
  is_wolt_plus_only: boolean;
  purchasable_balance: number;     // stock count (0 = sold out)
  disabled_info: { disable_text: "Sold out" } | null;
  restrictions: any[];
  allowed_delivery_methods: string[];
  consent_info: { ask_consent: boolean; blur_image: boolean };
}
```

---

## 4. Category Tree Structure

From the `category-listing` SSR query (`loading_strategy: "partial"`):

```typescript
interface CategoryListing {
  assortment_id: string;        // "62061c1539a6c1f4234252b7"
  loading_strategy: "partial";  // item_ids always [] — must fetch separately
  primary_language: "fi";
  available_languages: [
    { language: "en"; autotranslated: true },
    { language: "fi"; autotranslated: false },
    { language: "sv"; autotranslated: true }
  ];
  categories: Category[];       // 55 top-level categories
  items: [];                    // always empty in partial mode
}

interface Category {
  id: string;
  name: string;
  slug: string;          // e.g., "hedelmat-50" (Finnish + numeric sort index)
  description: string;
  images: { url: string; blurhash: string | null }[];
  subcategories: Category[];   // nested, up to 3 levels deep
  item_ids: [];                // always empty in partial mode
}
```

**Category slug format:** `{finnish-name}-{numeric-sort-index}`
- e.g., `hedelmat-50` = Hedelmät (Fruits), position 50

---

## 5. URL Structure

```
Venue main:   /en/fin/helsinki/venue/wolt-market-vallila
Category:     /en/fin/helsinki/venue/wolt-market-vallila/items/{category_slug}
Collection:   /en/fin/helsinki/venue/wolt-market-vallila/collections/{collection_slug}
```

**Known collection slugs:** `discounted`, `popular`, `new`, `everyday-essentials`,
`fresh-picks`, `treat-yourself`, `home-and-cleaning`, `meals-in-minutes`, `drinks`

---

## 6. How Category Page Loading Works

When navigating to `/items/hedelmat-50` (Fruits):

1. **SSR** pre-renders items for the **first visible subcategory** (e.g., `tarjoukset-51`) via `category-listing` query.
2. The TanStack cache has the first subcategory's items in the dehydrated state.
3. **Client fetches** additional subcategories lazily as user scrolls:
   - `GET .../categories/slug/sesongin-hedelmat-52?language=fi`
   - `GET .../categories/slug/banaanit-trooppiset-hedelmat-53?language=fi`
   - etc.
4. Each response: ~8 items + `metadata.next_page_token` for pagination within that subcategory.

---

## 7. Main Page Sections (venue-content)

From the `venue-content` SSR query, the main venue page shows curated sections:

```typescript
interface Section {
  section_type: "tall_item_card_collection_carousel";
  name: string;       // "Deals", "Most ordered", etc.
  slug: string;       // "discounted", "popular", etc.
  parent_slug: string;  // "discover"
  categories: { id: string; item_ids: string[] }[];
  items: WoltItem[];  // full item objects (directly in SSR)
  metadata: { next_page_token: string | null };
}
```

---

## 8. Key IDs — Wolt Market Vallila

| Field | Value |
|---|---|
| Venue ID | `62061ac0e2f301c8956d298f` |
| Venue slug | `wolt-market-vallila` |
| Assortment ID | `62061c1539a6c1f4234252b7` |
| Primary language | `fi` (Finnish) |
| City | Helsinki, Finland |

---

## 9. CORS Situation

All `consumer-api.wolt.com` endpoints require:
```
Origin: https://wolt.com
```

**Browser extension:** No CORS issues — the extension runs in the context of `wolt.com`.

**Next.js app:** Must proxy all API calls through Next.js server-side routes (`/api/...`), since the browser cannot call `consumer-api.wolt.com` directly from a different origin. `prodinfo.wolt.com` appears to be more permissive.

---

## 10. Extension vs Next.js App — Trade-offs

### Browser Extension
- ✅ Zero CORS friction — runs inside `wolt.com`
- ✅ Can intercept/modify the existing Wolt UI directly
- ✅ Access to TanStack query cache (live data already fetched)
- ✅ Cart & checkout still work natively
- ✅ No hosting required
- ❌ Users must install it
- ❌ Not shareable as a URL
- ❌ Breaks if Wolt restructures their DOM/JS

### Next.js App
- ✅ Shareable URL, accessible to anyone
- ✅ Full control over table UI + nutrition focus
- ✅ Can cache data, add search/filter features
- ❌ **Requires server-side proxy** for all `consumer-api.wolt.com` calls
- ❌ `prodinfo.wolt.com` HTML must be fetched server-side and nutrition data parsed
- ❌ Wolt ToS may restrict scraping
- ❌ Data can go stale without polling

**Recommendation:** A **browser extension** is faster to ship and more reliable (no CORS, no proxy, no stale data). A **Next.js app with server-side proxy** gives a better shareable product but requires more infrastructure.
