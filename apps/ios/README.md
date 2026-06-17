# Nook iOS — the capture companion

Native **SwiftUI** phone app for Nook (the family hub). Plays sidekick to the
always-on kiosk: *add anything, anywhere*, with offline read/write.

## Architecture (see `docs/ARCHITECTURE.md` at the repo root)

- **SwiftUI** for all UI.
- **PowerSync Swift SDK** owns the on-device SQLite mirror of Postgres — the
  source of truth for everything that syncs (family, agenda, chores, meals,
  lists, stars). Reads are local; writes upload through our API. *(Phase 1.)*
- **SwiftData** is reserved for **device-only** state that never syncs (capture
  drafts typed offline, UI prefs, cached recipe-card photos before upload).
  It is *not* the sync layer — PowerSync is.
- Auth: a **local HS256 dev token** for now (mint via `just token` /
  `/api/powersync/token`); **Auth0** (Apple + Google) swaps in later — same JWT
  shape (`household_id` claim).

## Project layout

This is an **XcodeGen** project. The Xcode project file is generated from
`project.yml`, so we never hand-edit a `.pbxproj`:

```
apps/ios/
  project.yml          # source of truth — edit this, then regenerate
  Nook.xcodeproj/      # GENERATED (gitignored)
  Sources/Nook/
    App/               # @main entry + root tab navigation
    DesignSystem/      # Nook tokens + reusable SwiftUI components
    Features/          # one folder per tab/screen
    Support/           # sample data, helpers
```

## Develop

```bash
brew install xcodegen           # one-time
cd apps/ios
./Scripts/vendor-powersync.sh   # one-time: fetch + patch the PowerSync SDK (see below)
xcodegen generate               # regenerate Nook.xcodeproj after any file/yml change
open Nook.xcodeproj             # or build from the CLI:

xcodebuild -project Nook.xcodeproj -scheme Nook \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Whenever you **add or remove a Swift file**, re-run `xcodegen generate` (sources
are folder-globbed, so you don't list files individually).

### Tests

Unit tests (Swift Testing) live in `Tests/` and cover the pure sync logic —
timestamp parsing, timezone day-bucketing, agenda ordering, the CRUD-upload
shape, hex parsing. SwiftUI views are exercised manually on the sim.

```bash
xcodebuild test -project Nook.xcodeproj -scheme Nook \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

### Vendored PowerSync SDK (temporary)

PowerSync 1.14.3 doesn't compile under Xcode 26.1 / Swift 6.2 (`weak let` is now a
hard error). `Scripts/vendor-powersync.sh` clones the SDK into `Vendor/`
(gitignored) and applies a two-line patch; `project.yml` points the SPM
dependency at that local copy. Revert to the remote pin once upstream fixes it.

## Run the Phase 1 sync demo

Bring up the backend (`docker compose … up -d` / `just up`), mint a dev token
(`just token` / `nook token`), then launch the app pointed at the local stack.
Config comes from the launch environment (or the in-app Sync → Connection panel):

```bash
TOKEN=$(…/mint-token.js --sub 'dev|demo')
SIMCTL_CHILD_NOOK_API_URL=http://localhost:3000 \
SIMCTL_CHILD_NOOK_DEV_TOKEN="$TOKEN" \
  xcrun simctl launch booted ai.lorebooks.nook
```

The iOS simulator reaches the host Mac on `localhost`. Open **Family → ↻ (Sync)**
to see connection state, mirrored row counts, the pending-upload queue, and an
"Add offline test event" button. Optional headless demo switches:
`NOOK_START_TAB=family`, `NOOK_OPEN_SYNC=1`, `NOOK_DEMO_ADD_EVENT=1`.

## Status

- **Phase 0 — scaffold:** app shell, Nook design system, 5-tab navigation,
  static Today screen. ✅
- **Phase 1 — sync de-risk (roadmap M4.2):** PowerSync Swift SDK + dev-token auth,
  `persons`/`events` mirrored to local SQLite, Family people-row from the mirror,
  offline read + queued write + reconnect — verified end-to-end on the iPhone 17
  Pro sim against the live stack. ✅
- **Phase 2 — capture:** the "Add anything" sheet wired to `POST /api/capture`;
  the client commits all five intents the way the web kiosk does — events to the
  local PowerSync mirror, grocery/task/meal/list over REST. The "Nook understood"
  preview leads with a **confident one-tap glance** (icon · kind · what it heard ·
  who · a single Add button) — you confirm without ever seeing a form. A second
  **Edit** tap opens the full **editable + re-classifiable** card: an inline name
  field + per-kind fields (event = who-chips + date/time + all-day; task =
  who-chips + reward stepper + **currency picker**; grocery/list = quantity, list
  = target-list dropdown; meal = slot chips + date), a **type-switcher** chip row
  (Event·List·Grocery·Task·Meal) to correct a mis-parse, and "Edit text" to
  re-open the raw box. ✅
- **Phase 3 — hub screens (in progress):**
  - **Today** dashboard widgets live (tonight's meal, chores progress, grocery
    count) from the REST domains. ✅
  - **Family hub** tiles show live counts and navigate (per-tile NavigationStack
    routing; re-tap to pop to root). ✅
  - **Lists** built out: Lists index → grocery **board** (By aisle / By meal,
    meal-color dots + meal-type tags, this-week's-meals summary, pantry-staples
    "Pantry check", collapsible sections, inline name/qty edit, swipe → Details
    editor with assignee/section, settle-into-Completed). ✅
  - **Goals** built out: list picker + All/Shared/Each, featured hero
    (shared-ring / each-together), log progress, **create**, **detail**
    (milestone ladder, by-person, recent activity, this-week, streak), **edit**
    (PATCH), and **goal-list creation** (＋ New group: name/emoji/members/private). ✅
  - **Chores** built out: by-person board (+ Up for grabs) with a date stepper,
    complete/uncomplete, up-for-grabs claim ("who did it?"), parent
    approve/reject, streaks + star rewards, and create/edit/delete chores
    (schedule, who, stars, approval). ✅
  - **Calendar** built out: Agenda + Month grid (switcher), per-person filter,
    tap any event (Today or Calendar) → editor with title / date / time +
    duration / all-day / participants / Google-calendar picker / location,
    create + delete — all offline-first writes to the synced events mirror. ✅
  - **Family per-person spotlight**: tap a person → their stars/streak, today's
    chores + a featured goal, a merged day list (events + chores, toggle/edit
    inline), whole-person category balance + AI insight, their goals, recent
    stars ledger, and reward redemptions. ✅
  - **Meals — week planner + Recipes library (started):** the Meals tab is a
    **This week / Recipes** segmented switch over one nav stack. **This week** is a
    day-by-day **planner**: each day card lists its planned meals (emoji · title ·
    slot tag for non-dinner · cook · time), with prev/next week nav + a "jump to
    this week", **＋ Plan dinner** on empty days, and a per-meal menu to **Change**
    (recipe picker) or **Remove**. Tapping a planned recipe opens its detail; plan/
    clear write via `POST`/`DELETE /api/meals/plan` and bump the refresh bus so the
    Today card stays in sync. **Recipes** is the
    household **Recipes library** — a two-column gradient card grid (emoji hero,
    cuisine · protein · cook-time · cooked-count), live `.searchable` text search
    across title/cuisine/protein/veg/tags, a sort menu (A–Z / Quickest / Most
    cooked / Recently cooked), and multi-select **facet filters** (cuisine ·
    protein · dietary) + a favorites toggle, surfaced as removable chips. Tapping
    a card opens full **recipe detail**: hero, serif title, metadata + tag chips
    (collection/cuisine/meal-type/protein/base/method/effort/dietary/veg/#tags),
    favorite toggle, **mark-cooked**, the ingredient list with a **servings
    scaler** (re-computes amounts, ½/¼/¾ fractions), an "on hand" banner, the
    numbered **method** steps, your-notes, and the source notes. **Cook mode** —
    full-screen step-by-step (big serif type, progress bar, this-step
    ingredients, an all-ingredients sheet, screen kept awake, finish →
    mark-cooked). **Phone-side editing**: add/edit a **per-step note**, your own
    **recipe notes**, and **tags + dietary** — all read-modify-write the recipe's
    `overrides` blob via `PATCH /api/recipes/:id` (web parity). Over REST
    (`GET /api/recipes`, `GET /api/recipes/:id`, `PATCH …`, `POST …/cooked`);
    weekly planner + recipe capture follow. ✅
  - Rewards / Photos / Settings: still live-summary placeholders.
- **Next:** Meals **"Plan my week ✨"** (AI `POST /api/meals/plan-week` review/accept)
  + cook-assignment on a planned slot; a hub tile (Rewards/Photos/Settings); Auth0
  login (roadmap 4.2.1) to replace the dev token.

## Known follow-ups / bugs

- **Capture → custom lists**: ✅ done. The server `list` intent landed on `main`,
  and the editable preview (type switcher + per-kind fields + list-target picker +
  "Edit text") shipped here. `commitListItem` creates the named list on the fly if
  it doesn't exist yet (web parity). The parser sometimes drops the list name
  (returns `listName: null`) — when it does, the preview defaults the picker to the
  first non-grocery list and the user re-picks; no misroute to grocery.
- **Multi-intent capture** (needs backend): the parser returns a single intent, so
  "add milk and schedule a dentist appointment" can't yet split into two cards
  (the web "Add both" affordance). Needs a server intent **array** first.
- **Capture currency picker** only appears when the household has >1 currency; the
  default reward currency is the household default (usually `stars`). Verified the
  reward currency flows through `commitTask` → `POST /api/chores` (`rewardCurrency`).
