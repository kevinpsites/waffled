# Mealie integration: recipes, meal plans and groceries come from Mealie

Date: 2026-11-24 · Status: draft for approval · Size: project

## Intent

The owner already keeps their recipe library in [Mealie](https://mealie.io). Mealie is a
dedicated app under active development, and it handles recipes, meal planning and shopping
lists better than Waffled's own versions. When a household connects Mealie:

- Mealie becomes the **single source of truth** for recipes, the meal plan and the shopping
  list.
- Waffled stops keeping its own copies and becomes the **family's window onto Mealie** on
  the kiosk.

Planning and recipe editing happen in Mealie's own UI. The kiosk shows what's planned,
opens recipes for cooking, and lets anyone work the shopping list. It also allows **light
planning** (put a recipe on a day) that is saved straight back to Mealie.

## Goals

- **Connect:** an admin connects Mealie in Settings with a base URL and an API token, and
  picks which Mealie shopping list the kiosk shows.
- **Today:** while connected, the existing **Tonight** and **This week** cards show meals
  from Mealie's meal plan. The **Grocery** card shows the chosen Mealie shopping list.
- **Meals page:** shows the week's Mealie meal plan and a searchable Mealie recipe library.
  - Recipes open in a large, kiosk-friendly cook view with ingredients and steps.
- **Lists page:** the Grocery board is replaced by the Mealie shopping list.
  - Any member can check items off, uncheck them, or add one, and the change goes straight
    to Mealie.
  - Custom lists (packing lists, to-dos and so on) are unchanged.
- **Calendar:** Mealie's planned meals appear on their days, read-only. Tapping one opens
  the recipe.
- **Light planning from the kiosk:**
  - Pick a recipe, or type a title.
  - Pick a day and a meal type, and it's created in Mealie's meal plan.
  - A planned entry can also be removed from the kiosk.
- **Disconnect:** removes the connection. Waffled's built-in recipe, meal and grocery
  screens return with their old data untouched.

## Non-goals (v1)

- Editing recipes, importing recipes by URL, or meal-plan rules from Waffled. Use Mealie for
  those.
- **Pantry.** The owner doesn't use it. With Mealie connected, Pantry is not integrated; see
  Design → Other consumers.
- Pushing Mealie meals to Google or Microsoft calendars.
- Offline caching. If Mealie is down, these screens say so.
- Mealie versions before 2.0, where the household API paths don't exist.
- Choosing between several Mealie shopping lists on the kiosk. One list is chosen in
  Settings.
- Recipe timers in the cook view.

## Anti-goals

- **No copy of Mealie's data in Postgres.** Nothing to sync, nothing to drift. Only the
  connection is stored.
- **The token never reaches a browser**, and it is never returned by any API response.
- **No regression for households without Mealie.** Every built-in screen behaves exactly as
  today when no connection exists.
- **No silent failure.** An unreachable Mealie or a rejected token shows a plain message, not
  a blank or stale screen.

## Constraints

- Mealie **2.0+**. The current release is about v3.29 (Oct 2026).
  - API base is `<baseUrl>/api`.
  - Auth is a long-lived user API token, created in Mealie under the user's API tokens and
    sent as `Authorization: Bearer <token>`.
  - Responses are scoped to the Mealie household of the token's user.
- **Mealie endpoints used** (verified against the current OpenAPI):

  | Endpoint | Used for | Notes |
  | --- | --- | --- |
  | `GET /api/app/about` | Version check | No auth. Returns `version`. |
  | `GET /api/users/self` | Validating the token | |
  | `GET /api/households/mealplans?start_date=&end_date=&perPage=` | Reading the plan | Items are `PlanEntryOut`. See below. |
  | `POST /api/households/mealplans` | Creating an entry | Body `{date, entryType, title?, text?, recipeId?}`. |
  | `DELETE /api/households/mealplans/{id}` | Removing an entry | |
  | `GET /api/recipes?search=&page=&perPage=&orderBy=` | Recipe library | Paginated `RecipeSummary`: `{id, slug, name, image, description, totalTime, recipeYield, tags, recipeCategory}`. |
  | `GET /api/recipes/{slug}` | Recipe detail | Adds `recipeIngredient[]` and `recipeInstructions[]`. |
  | `GET /api/households/shopping/lists` | Picking a list in Settings | |
  | `GET /api/households/shopping/lists/{id}` | Reading the shopping list | `ShoppingListOut` with `listItems[]`. |
  | `POST /api/households/shopping/items` | Adding an item | `{shoppingListId, note, display?}`. |
  | `PUT /api/households/shopping/items/{id}` | Checking or unchecking | Requires the **full item object**, so read the item, change `checked`, and PUT it back. |
  | `GET /api/media/recipes/{recipeId}/images/{min-original.webp\|original.webp\|tiny-original.webp}` | Recipe images | No auth. |

  - A `PlanEntryOut` has `{id: int, date: YYYY-MM-DD, entryType, title, text, recipeId,
    recipe: RecipeSummary|null}`.
  - A recipe ingredient has `{display, note, title}`. A recipe instruction step has
    `{title, text}`.
  - A shopping list item has `{id, display, note, quantity, checked, position, label:
    {name, color}|null}`.
- `entryType` values used by Waffled: `breakfast`, `lunch`, `dinner`, `side`, which every 2.x
  and 3.x release has. Newer Mealie adds `snack`, `drink` and `dessert`. Waffled displays any
  value it receives, but only offers the four when creating an entry.
- **Dates are computed by Waffled in the household timezone.** Never use Mealie's
  `/mealplans/today`, which uses Mealie's server clock.
- **Mealie is often on a private network** (for example `http://mealie:9000` beside Waffled
  in Docker). All calls go through Waffled's API server, never from the browser.
- **Repo conventions apply** (CLAUDE.md): TDD with integration tests first, changelog, docs
  and roadmap in the same PR, lean comments, and the design-system reuse rules.

## Approaches

### Which screens Waffled keeps (the owner picked A, with C's planning added)

- **A. Manage in Mealie, with Waffled as the family's window onto it (chosen).**
  - Waffled's own recipe, meal-plan and grocery screens hide while connected, replaced by
    Mealie-backed views.
  - It's the least code and never drifts.
- B. Waffled stays the full UI, with Mealie only as storage.
  - Every screen would be rewired to Mealie's data model (foods, units, labels).
  - This rebuilds Mealie inside Waffled, which works against the reason for the move.
- C. A plus light kiosk planning.
  - The owner wants it, so it's in this design as the last piece. It can be cut without
    affecting the rest.

### How data flows (the owner picked 1)

- **1. Live through Waffled's server (chosen).**
  - Each request calls Mealie with the stored token, behind a short in-memory cache.
  - Always fresh, nothing to sync, and the token stays server-side.
  - The trade-off: these screens are unavailable while Mealie is down.
- 2. A scheduled copy into Postgres. It survives Mealie outages, but brings a sync job,
  stale state across devices and write conflicts.
- 3. The browser calls Mealie directly. Ruled out: it exposes the token, Mealie must be
  reachable from every browser, and it hits cross-site (CORS) restrictions.

## Design

### Data (migration `0109_mealie_connections.sql`)

`mealie_connections`: one row per household; the household has a connection while a row
exists.

| Column | Type | Notes |
| --- | --- | --- |
| `household_id` | uuid PK | FK `households` on delete cascade |
| `base_url` | text not null | normalized, no trailing slash |
| `token_encrypted` | text not null | `encryptSecret` from `platform/crypto.ts` |
| `shopping_list_id` | text | null until one is chosen |
| `shopping_list_name` | text | display only |
| `public_url` | text | optional browser-facing Mealie URL for "Open in Mealie" links; see below |
| `mealie_version` | text | |
| `connected_by` | uuid | the admin who last saved the connection; `(household_id, connected_by)` composite FK to persons, `on delete set null (connected_by)`, the 0104 pattern |
| `created_at`, `updated_at` | timestamptz | |

The token is **not** stored in `households.settings`, because `presentHousehold` returns all
settings to every member.

### API: new module `apps/api/src/modules/mealie/`

#### Client (`mealie-client.ts`)

- A small `fetch` wrapper with an 8-second `AbortSignal.timeout` and a `Bearer` header,
  using JSON.
- Mealie errors map to Waffled errors:

  | Condition | Waffled error |
  | --- | --- |
  | Network failure or timeout | `MealieUnavailable` → 502 |
  | Mealie returns 401 or 403 | `MealieAuthFailed` → 502 (the household must reconnect) |
  | Mealie returns 404 | 404 |
  | Mealie returns 422 | 400, with Mealie's message |

  The 401/403 case is deliberately 502, not 401, so the web client doesn't treat it as the
  *Waffled* session expiring.
- The error body carries `{error, code}` so the web can show the right message.

#### Cache (`mealie-cache.ts`)

- A per-household in-memory TTL map, following the precedent in `integrations/weather.ts`:

  | Data | TTL |
  | --- | --- |
  | Meal-plan range | 30 s |
  | Recipe search page | 60 s |
  | Recipe detail | 5 min |
  | Shopping list | 10 s |

- Any write a household makes through Waffled clears that household's entries for the
  affected kind, and changing the connection clears all of them.
- Changes made in Mealie's own UI show up within the TTL.

#### Routes

None are behind `moduleRoutes`: Mealie is an integration, not a module.

**Connection (admin only)**
- `GET /api/mealie/connection`
  - Returns `{connected, baseUrl, shoppingListId, shoppingListName, mealieVersion}`.
  - Available to any member. It never includes the token.
- `PUT /api/mealie/connection` with body `{baseUrl, publicUrl?, token?, shoppingListId?}` (admin).
  1. Normalize the URL: http/https only, no embedded credentials, trailing slash stripped.
  2. `GET /api/app/about`, and require major version ≥ 2. Otherwise return 400 "Mealie 2.0 or
     newer is required".
  3. `GET /api/users/self` with the token. A 401 from Mealie returns 400 "Mealie rejected
     that token".
  4. Encrypt the token and upsert the row.
  - `token` may be omitted on later saves, to change only the list or URL; the stored token
    is reused.
  - If `encryptionAvailable()` is false, return 500 with a clear message.
- `GET /api/mealie/shopping-lists` (admin): `[{id, name}]` for the Settings picker.
- `DELETE /api/mealie/connection` (admin): deletes the row and clears the cache.

**Reads (any member; 409 `MealieNotConnected` without a connection)**
- `GET /api/mealie/mealplan?start=YYYY-MM-DD&end=YYYY-MM-DD`
  - Returns `[{id, date, entryType, title, recipe: {id, slug, name, imageUrl}|null}]`,
    sorted by date, then meal order, then id.
  - Meal order is breakfast, lunch, dinner, side, others.
  - `title` falls back to `recipe.name`.
  - The range is at most 62 days.
- `GET /api/mealie/recipes?search=&page=`
  - Returns `{items: [{id, slug, name, imageUrl, totalTime, description}], page, totalPages}`.
  - perPage is 24. Without a search the order is `orderBy=name`.
- `GET /api/mealie/recipes/:slug`
  - Returns `{id, slug, name, imageUrl, description, totalTime, recipeYield, ingredients:
    [{title, display}], steps: [{title, text}], mealieUrl}`.
  - `mealieUrl` (`<baseUrl>/g/<group>/r/<slug>` or similar) is for an "Open in Mealie" link.
    It is built from `public_url` when that is set, otherwise from `base_url`, because the
    base URL is often an internal Docker address a family member's browser can't open. The
    exact path is left to the builder; if the group slug isn't easily available, use
    `<url>/r/<slug>`, which redirects.
- `GET /api/mealie/images/:recipeId/:size`
  - `size` is one of `min`, `original` or `tiny`, mapped to the fixed filenames above.
  - `recipeId` must be a uuid.
  - It streams the bytes with Mealie's content-type and `Cache-Control: private, max-age=3600`.
  - Every `imageUrl` in Waffled's responses points here, never at Mealie directly.
  - A recipe with no image has `imageUrl: null`. If Mealie returns 404 for an image, the
    proxy returns 404. Either way the web shows a placeholder tile, never an error state.
- `GET /api/mealie/shopping`
  - Returns `{listId, listName, items: [{id, display, checked, label: {name, color}|null,
    position}]}`.
  - Items are sorted unchecked first, then by label name, then position.
  - Returns 409 `MealieNoShoppingList` if no list is chosen.

**Writes (any member, matching today's `tenantRoute` on meal planning and grocery)**
- `POST /api/mealie/shopping/items` with `{text}`. Creates `{shoppingListId, note: text}`.
  The text is 1–200 characters after trimming.
- `PATCH /api/mealie/shopping/items/:id` with `{checked}`. Reads the full item, sets
  `checked`, and PUTs it back.
- `POST /api/mealie/mealplan` with `{date, entryType, recipeId?, title?}`.
  - One of `recipeId` or `title` is required.
  - `entryType` must be one of the four creatable types.
- `DELETE /api/mealie/mealplan/:id`. `id` must be an integer.

**Household payload**
- `presentHousehold` gains `mealie: {connected: boolean, hasShoppingList: boolean}` so the
  web can branch without an extra call.
- It must not include the URL or token. Members don't need the URL; admins get it from
  `GET /api/mealie/connection`.

### Web

**Detection**
- A `useMealie()` hook reads `household.mealie`.
- An `apps/web/src/lib/api/mealie.ts` client exposes the routes above, plus a `'mealie'` bus
  topic.
- Mealie views refresh with `useLiveRefresh` (the existing polling pattern) and emit
  `'mealie'` after writes.

**Swapping, not gating**
- The `meals` and `lists` modules keep their meaning: they turn the pages on and off.
- When Mealie is connected and the module is on, the page renders the Mealie version instead
  of the built-in one.
- `ModuleGate` stays as it is. The swap happens inside the page components.

**Today**
- Same card keys (`tonight`, `week`, `grocery`), so saved layouts and the server's
  `TODAY_CARDS` list need no change.
- Each card renders a Mealie variant:
  - **Tonight:** today's `dinner` entries (or all of today's entries if there's no dinner).
    It shows the photo and name, and tapping opens the cook view.
  - **This week:** the next 7 days, one row per day, showing that day's entries.
  - **Grocery:** an unchecked-item count, plus the first few items. Tapping goes to `/lists`.

**Meals page (`/meals`)**
- Two tabs:
  - **This week:** a 7-day view with prev/next week. Each day lists its entries with
    photo, title and type, and each entry has a remove action that asks for confirmation. A
    **Plan a meal** button sits on top.
  - **Recipes:** a search box and a grid of photo cards, paged with "Load more".
- Recipe route `/meals/mealie/:slug` is a cook view:
  - Large type, ingredients on one side and numbered steps on the other, stacked on narrow
    screens.
  - It includes "Plan this" and "Open in Mealie" buttons.
- The built-in routes (`/meals/recipes`, `/meals/build`, `/meals/recipe/...`) redirect to
  `/meals` while connected.

**Plan a meal (modal)**
- Recipe: search Mealie, or type a free-text title.
- Day: today plus the next 13 days, as chips.
- Meal type: the four types, defaulting to dinner.
- Save calls `POST /api/mealie/mealplan`.
- It opens from the Meals page or from a recipe's "Plan this" button (recipe preselected).
- Reuse `.modal-card` and `.field`. Nothing new in the design system unless nothing fits.

**Lists page (`/lists`)**
- The Grocery entry renders a `MealieShoppingList` instead of `GroceryBoard`:
  - Items grouped by Mealie label, with label colour as an accent.
  - Tap to check or uncheck, with optimistic UI that reverts and shows inline on error.
  - An add field at the top.
  - Checked items collapse at the bottom.
- Built-in grocery affordances are hidden: rebuild from week, stores, priorities, from-recipe
  and share QR.
- Custom lists and templates are unchanged.

**Calendar**
- While connected, the Calendar fetches `GET /api/mealie/mealplan` for the visible range and
  shows entries as all-day meal chips. Tapping one opens the cook view.
- It hides existing `origin = 'meal_plan' | 'meal_prep'` events while connected, so
  leftovers from Waffled's own planner don't show twice. A client-side filter keeps them in
  the database for a later disconnect.

**Settings**
- A new **Mealie** panel in `Settings.tsx`. Admins see it; others see a read-only "Connected
  to Mealie" line.
  - Fields: base URL, optional public URL ("the address you open Mealie at in a browser, if
    different"), API token (password field, shown as "••• saved" once stored), a
    shopping-list picker that loads after a successful connect, and Save and Disconnect
    (with confirmation).
  - Inline help names where to create the token in Mealie.

**Errors**
- Each Mealie view shows a plain state on error:
  - `MealieUnavailable`: "Can't reach Mealie right now."
  - `MealieAuthFailed`: "Mealie stopped accepting Waffled's token. An admin can reconnect it
    in Settings → Mealie."
  - `MealieNoShoppingList`: "Choose a shopping list in Settings → Mealie."
- Each has a Retry button. Today cards collapse to one muted line instead of breaking the
  layout.

### Other consumers while connected (my calls)

- **Capture bar:**
  - The `grocery` chip and intent add to the Mealie shopping list, in the web chip and in the
    API capture path in `modules/capture/capture.ts`.
  - The `meal` chip is hidden, and the API `meal` intent returns a "plan it from the Meals
    page" message.
  - Matching a spoken meal to a Mealie recipe is a later improvement.
- **Weekly Planning:**
  - The Meals step is skipped while connected.
  - The Recap omits its meal lines and grocery count.
  - Reading the Mealie week there is a follow-up.
- **Pantry:** unchanged code. Settings → Modules shows a note under Pantry that it works with
  Waffled's built-in groceries and isn't connected to Mealie.
- **Event detail "View recipe"** on old meal events: hidden while connected, because those
  events are hidden.
- **Other readers of built-in meal events:**
  - Weekly Planning's kids step and recap, `kids.ts` focus and `overview` already filter
    out the meal-mirror origins through `MIRROR_ORIGINS`.
  - `calendar-ai.ts` (`isPlannedMeal`) also skips `meal_plan` and `meal_prep` events while
    connected, so the AI doesn't describe stale meals.
  - No new built-in meal events are created while connected, because the built-in planner
    is hidden, so nothing new is pushed to Google either.
  - Nothing else needs suppressing.
- **Built-in data** (Waffled recipes, meal plans, grocery items): left untouched, and visible
  again after a disconnect.
  - There is no migration from Waffled to Mealie in v1. The owner's library is already in
    Mealie.

### Scope, deployment and concurrency (settled from the builder check)

- **Mealie households and groups:** meal plans and shopping lists are scoped to the token
  user's Mealie household, while `GET /api/recipes` returns the whole Mealie group's
  recipes. A plan entry's recipe always comes from that group, so the library and plan can't
  disagree. One token per Waffled household is enough for v1.
- **Single process:** the supported deployment is one `waffled` container, which means one
  API process, so the in-memory cache and its invalidation are correct. If several replicas
  ever run, the worst case is a stale read for up to the TTL (10 s for the shopping list).
- **Checking an item off is last-write-wins**, like Mealie's own UI. The server PUTs back the
  item exactly as it just read it, with only `checked` changed. A 422 from Mealie becomes a
  400 that the web shows inline and reverts.
- **Admin** means the existing `tenant.isAdmin`: use `adminRoute` and `requireAdmin` from
  `platform/route-guards.ts`.

### Security

- Only admins can set the URL. It must be http or https, and private addresses are allowed,
  because that's the normal deployment.
- The server only ever calls fixed paths under the stored base URL. The image proxy takes a
  uuid and a fixed size name, so no request-derived URL is fetched.
- The token is AES-GCM encrypted at rest, and is never logged, returned or sent to a browser.

### Docs and changelog

- `[Unreleased]` → Added: a **Mealie integration** entry.
- New how-to page `website/docs/src/content/docs/features/mealie.md`, covering:
  - creating the token
  - the URL, when Mealie is on the same Docker network as Waffled
  - choosing the shopping list
  - what hides and what stays
  - outage behaviour
  - disconnecting
- Updates to the features reference, the meals/lists feature pages ("when Mealie is
  connected…"), and the roadmap.
- The README "How this fork differs" table gains a Mealie row, and the README feature line
  mentions it.

## Testing

TDD. API integration tests (testcontainers Postgres) use a **fake Mealie**: a node `http`
server on a random port inside the test, serving canned responses shaped like the OpenAPI
above. They cover:
- connect: the version check, a rejected token, encryption, and the token never appearing in
  any response
- reconnect without a token
- disconnect
- admin-only enforcement
- 409 when not connected
- mealplan range mapping, sorting and the title fallback
- recipe search and detail mapping
- the image proxy: size whitelist, uuid validation and streaming
- shopping list sort
- add an item
- check an item: the PUT body contains the full item with `checked` flipped
- create and delete a plan entry, including validation
- Mealie down → 502 `MealieUnavailable`
- Mealie 401 → 502 `MealieAuthFailed`
- cache hit, and invalidation after a write
- `presentHousehold` includes `mealie.connected` and never the token or URL

Web component tests (mocked API) cover:
- each Today card in its Mealie variant and its error state
- the Meals page tabs
- the cook view
- the plan modal, which posts the right body
- the shopping list: optimistic check, revert on error, and add
- the Lists page swap, with custom lists untouched
- calendar meal chips, with meal-mirror events hidden
- the Settings panel connect flow
- the capture grocery chip routing
- built-in screens unchanged when not connected

## Left to the builder

- Exact layout of the cook view and recipe grid.
- Paging details beyond perPage 24.
- How the "Open in Mealie" URL is built.
- The exact error copy, beyond the strings above.
- Whether cache TTLs need tuning.
