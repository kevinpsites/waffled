# Meal Builder — plan

Status: **done** — PR1 (server + web) and PR2 (iOS parity) both landed
Design source: Claude Design project “Waffled” → `Meal Builder - Prototype.html`, plus an
iPhone mock (builder + meal detail) supplied 2026-07-23.

## The idea in one paragraph

Today a meal-plan slot holds **one** recipe. Meal Builder lets a household compose a
**plate** — a named, multi-recipe meal such as “BBQ Sunday” = BBQ Chicken (main) +
Potato Salad + Coleslaw (sides) + Peach Cobbler (dessert) — set how many it serves,
optionally **save it to reuse**, and then either **schedule** it to a day + meal slot or
**add the whole plate to the grocery list** without scheduling it at all. Downstream, the
calendar event, the grocery list and Cook Mode all learn to speak “meal” instead of
assuming a single recipe.

## Decisions

Locked with the product owner on 2026-07-23. Numbers match the question thread.

| # | Decision |
|---|---|
| 1 | **New `meals` + `meal_recipes` tables**; `meal_plan_entries` gains a nullable `meal_id`. A slot points at *either* a recipe or a meal. The `(meal_plan_id, date, meal_type)` unique index is untouched. |
| 2 | The feature is called **Meal Builder**. The phrase is currently used in prose to describe the *auto grocery build*; no code identifier, route or component uses it, so reclaiming it is a comment/doc reword only (6 hits — see *Reclaiming the name*). |
| 3 | The Main/Side/Dessert axis is called **`role`**, never `meal_type` (which already means breakfast/lunch/dinner/snack in two places). Stored as **free text, not an enum**, so Veggie/Bread/Appetizer can be added later without a migration. Roles are soft scaffolding to help people compose, not a rigid taxonomy. |
| 4 | **`servings` does not rescale ingredient quantities in v1.** It is stored and displayed only. True unit/quantity reconciliation stays on the roadmap and must be recorded in the feature table so we don’t forget. |
| 5 | On-hand counts use **real pantry matching** (generalised from `pantry/cook.ts`), not the existing staple-count proxy — which also fixes a latent bug in the recipe-detail banner. Presence only, no quantity comparison. See *Pantry on-hand*. |
| 6 | **AI pairing suggestions are deferred** to a later release (roadmap item). The empty-role slot ships without the “Peach Cobbler pairs well here” nudge. |
| 7 | Scheduling picks **any meal slot** (breakfast / lunch / dinner) on **any date**, with prev/next week navigation so meals can be planned in advance. |
| 8 | **iPhone builds meals too** — tap-to-add via the existing recipe/meal selector. Originally "*not* drag-and-drop; drag is web/iPad only", but **revised during review (2026-08-11)**: a dish already on the plate can be **dragged between roles** on iPhone and iPad too. Adding is still a tap (the ＋ opens the picker); dragging only re-files what's already there. It rides on `.onMove` over one flat run of rows — a SwiftUI `List` reorders only *within* a Section and silently refuses `.dropDestination` — see `PlateReorder`. |
| 9 | Meals stay **REST-only**; they are not added to the PowerSync offline schema (only the calendar domain syncs). |
| 10 | **Per-dish cook assignment is in scope** — a four-dish plate has up to four cooks. This addresses the orphaned roadmap item where `meal_plan_entries.cook_person_id` exists in DB + API but no UI ever assigns it. Scope note: what was agreed is the cook picker **on a plate’s dishes**. The roadmap item also wants a picker on ordinary single-recipe planner slots; that half stays open and the roadmap entry is trimmed rather than closed. |
| 11 | **A saved meal is a first-class citizen of the recipe library.** Searching all recipes returns saved meals too, and a meal can be selected anywhere a recipe can. |
| 12 | Adding a saved meal to a plate under construction **flattens** it — its recipes come in as individual, editable dishes. Meals never nest. |
| 13 | The calendar gets **no new concept**. The existing meal event is extended to show all the meal’s recipes. |
| 14 | On-hand counts respect the **`pantry` module toggle** — when pantry is off they are omitted entirely rather than falling back to the staple proxy. “N to buy” keeps working either way. |
| 15 | **Cross-plate timers ship in PR1**, not as a fast-follow — but as their own commit, landed after the rest of the feature is working. |

## Schema

```sql
create table meals (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null,
  servings      int  not null default 4,
  is_saved      boolean not null default false,
  created_by    uuid references persons(id),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table meal_recipes (
  meal_id        uuid not null references meals(id) on delete cascade,
  recipe_id      uuid not null references recipes(id) on delete cascade,
  role           text not null default 'side',
  sort_order     int  not null default 0,
  cook_person_id uuid references persons(id),
  primary key (meal_id, recipe_id)
);

alter table meal_plan_entries
  add column meal_id uuid references meals(id) on delete set null;
```

Worked example — “BBQ Sunday” scheduled to Sunday dinner:

```
meals
  M1  'BBQ Sunday'  servings=6  is_saved=false

meal_recipes
  M1 → bbq-chicken   role='main'    sort=0  cook=Kevin
  M1 → potato-salad  role='side'    sort=1  cook=Sarah
  M1 → coleslaw      role='side'    sort=2  cook=null
  M1 → peach-cobbler role='dessert' sort=3  cook=null

meal_plan_entries
  P1  2026-06-07  meal_type='dinner'  recipe_id=NULL  meal_id=M1  title='BBQ Sunday'
```

Notes on why this shape:

- **Unsaved meals are one-off plates.** `is_saved=false` means the plate exists only for
  its scheduled slot / grocery contribution and never appears in the library.
- **Scheduling a saved meal copies it**, so editing next week’s BBQ Sunday does not
  rewrite the plate that already went out last week.
- **`cook_person_id` lives on the dish**, because a four-dish plate has up to four cooks.
  The existing `meal_plan_entries.cook_person_id` stays as-is for single-recipe entries.

## Pantry on-hand

Real pantry matching **does** exist: `apps/api/src/modules/pantry/cook.ts`. `tokens()`
lowercases a name, strips punctuation, drops stopwords and words shorter than 3 chars;
`matches()` then does a **token-subset** test in whichever direction is smaller. So
“ground beef” ↔ “beef, ground” and “chicken” ↔ “chicken breast” match, but there is no
stemming, no synonyms and no plural handling — “tomato” does not match “tomatoes”.
Quantities and units are **never** compared; it is a pure presence check. Pantry rows
are filtered to `used_up_at is null and deleted_at is null and is_meal = false`, so
leftovers never count as ingredients.

Three consumers today: `cookableRecipes` (`GET /api/pantry/cookable`),
`pantryMatchesForRecipe` (`GET /api/pantry/for-recipe/:id`) and `recipesUsingItem`.

**The trap: there are two different “on hand” notions in this codebase and only one is
real.**

1. **Genuinely pantry-aware** — `CookMainRecipe { have, total }` (`cook.ts:128`), rendered
   as “Have 4 of 6” in `CookFromPantry.tsx:219` / `CookFromPantrySheet.swift:280`. But it
   only exists for recipes in the `mains` bucket — gated on the recipe having a `protein`
   you have on hand, capped at 3 per protein, and only inside the Cook-from-pantry modal.
   **There is no general per-recipe on-hand count for an arbitrary recipe.**
2. **Not pantry-aware at all** — the recipe-detail “N of M on hand” banner
   (`RecipeView.tsx:260`, `RecipeDetailView.swift:360`) counts `i.isStaple` and never
   touches `pantry_items`. A household with a completely empty pantry still sees
   “4 of 9 on hand”. This is cosmetically identical to what the Meal Builder mock asks
   for, which makes it very easy to reimplement the wrong one.

**Decision (5):** the Meal Builder’s “5/6 on hand” / “all on hand” / “2 to buy” counts use
**real pantry matching**, by generalising `cook.ts`’s matcher into a reusable
“on-hand count for these recipes” helper. Since the same helper then backs the recipe
detail banner, this also **fixes the existing staple-based banner**, which is a latent bug
rather than intended behaviour. Matching stays presence-only — no quantity comparison —
consistent with the rest of the pantry loop and with decision 4.

Staples continue to be excluded from “to buy”, via the existing dual mechanism
(`recipe_ingredients.is_staple` OR a name in the household’s `pantry_staples`).

### When the pantry module is off

`pantry` is a per-household toggleable module, so on-hand counts cannot be assumed
available. Two different numbers behave differently:

- **“on hand”** (`{have, total}`) is pantry-derived. With the module **off** it is
  **omitted entirely** — the field comes back null and clients render nothing. It must
  *not* fall back to the staple proxy (the bug we’re fixing) and must *not* return
  `have: 0`, which reads as “you have none of these” — equally untrue.
- **“N to buy”** is *not* pantry-derived and keeps working either way. Pantry on → the
  non-staple ingredients not matched in the pantry. Pantry off → simply the non-staple
  ingredients.

The same rule applies to the repointed recipe-detail banner: pantry off means no on-hand
claim at all.

## Reclaiming the name

“Meal builder” currently appears 6 times, all as prose describing grocery items generated
from the meal plan (`source = 'auto'`). No identifier, route or component uses it, so this
is a pure reword to “the meal plan” / “auto-generated from the meal plan”:

- `website/docs/src/content/docs/concepts/permissions.md:68`
- `apps/web/src/lib/api/grocery.ts:61`, `:63`
- `apps/web/src/kiosk/components/GroceryBoard.tsx:37`
- `apps/web/src/kiosk/components/GroceryBoard.test.tsx:8`, `:77`

## Surfaces

### Builder (new)
Role-grouped plate. Web/iPad: drag from the library drawer onto a role drop zone.
iPhone: tap “Add a side” → existing recipe/meal selector. Inline-editable meal name,
`servings` stepper, footer stats (serves · hands-on time · N to buy), “Save to reuse”
toggle, **Schedule** and **Add plate to list** actions.

**Library panel** gets a working **search bar** alongside the Sides / Mains / Desserts /
All segment chooser — searching across recipes *and* saved meals. The prototype’s search
box was a dead placeholder; it must be real.

### Recipe library
Unified list of recipes + saved meals with a type badge. `GET /api/recipes` stays
unchanged; a new `GET /api/meals` lists/searches saved meals and clients merge.
Recipe detail gains **“Build a meal around this.”**

### Calendar
The existing meal event extends to show every recipe on the plate.

### Grocery
Aisle-grouped as today, but the “this week’s meals” panel renders a meal as one
**expandable parent row** with child recipe rows, split into Scheduled / Unscheduled.
Provenance dots are per-meal. The existing rebuild/refresh already covers the refresh
affordance in the mock — nothing new needed there.

### Cook Mode
Multi-recipe: tabs across the plate’s dishes with **independent step progress per
recipe**. Per-recipe **Cook** buttons on the meal detail.

**Timers must be re-keyed, and this is bigger than it looks.** Timers already exist on
both platforms and both already support several running at once — but both are keyed to a
**step index only, with no recipe identifier**, and both actively assume a single-recipe
session:

- **Web** (`CookMode.tsx`): `CookTimer` is `{ id, label, stepIndex, … }` where `label` is
  literally `"Step 3"`. State is a plain `useState` **inside the route component**, so
  navigating away silently destroys every running timer. There is no store above the
  route to hoist into — that has to be created.
- **iOS** (`CookModeView.swift` / `CookSessionStore.swift`): better positioned — the
  recipe id is already threaded through the notification payload (`CookTimerLink
  { recipeId, stepIndex }`), so it only needs promoting onto the `CookTimer` struct.
  But `CookSessionStore.start()` **cancels and clears all timers when the recipe
  changes**, which is exactly what a multi-recipe plate needs to stop doing.

Neither platform persists running timers anywhere (RAM only; iOS survives backgrounding
via an absolute `fireAt` plus a time-sensitive local notification, web does not survive
even a tab throttle). No “all running timers” view exists on either platform.

So the mock’s “⏱ Timers” affordance is **new surface on top of real plumbing**: promote
`recipeId` onto the timer, relax the clear-on-recipe-switch, hoist web timer state above
the route, and add a dock listing everything running across the plate.

## Explicitly out of scope for v1

- Serves-driven quantity rescaling (decision 4) — roadmap.
- AI pairing suggestions (decision 6) — roadmap.
- **Read aloud** in Cook Mode — roadmap, future enhancement.
- Nested meals (decision 12).
- Offline meals on iOS (decision 9).
- “Send to phone” / “Order online” — pre-existing dead controls, unrelated to this work.

## Todo

### PR1 — server + web — **done**
- [x] Migration: `meals`, `meal_recipes`, `meal_plan_entries.meal_id`
- [x] Meals service + routes (CRUD, save/unsave, schedule, add-plate-to-list)
- [x] `GET /api/meals` list + search
- [x] Flatten-on-add semantics when a saved meal is added to a plate
- [x] Grocery: aggregate a meal's recipes; meal-level provenance; unscheduled meals
- [x] Calendar: extend the meal event to all recipes on the plate
- [x] Per-dish `cook_person_id` assignment + display
- [x] Web: Builder screen (drag-and-drop), library panel + working search
- [x] Web: unified recipe/meal library, "Build a meal around this"
- [x] Web: grocery expandable meal rows
- [x] Web: multi-recipe Cook Mode + timer re-keying
- [x] Docs in this PR: CHANGELOG `[Unreleased]`, features reference, roadmap moves,
      reword existing "meal builder" usages, add deferred items to roadmap

### Found during integration — fixed
- [x] **The list's "By meal" toggle drops a scheduled plate into "Other items".**
      `claim()` matched `sourceRecipeIds` against `board.meals[].recipeId`, which is
      `null` for a meal-backed slot — the dish ids live in `recipes[]` instead.

### Found while the user reviewed it on 8080 — fixed
Everything here was found by actually driving the feature, not by reading the code.
Worth remembering: each one had passing tests around it.

- [x] **＋ always filed under Sides** when the segment was "All", so "I can't drag it
      to Main" was really "＋ ignores where I am".
- [x] **A library row wouldn't drop on a plate group.** The group hardcoded
      `dropEffect = 'move'` while library rows drag as `'copy'`; a browser silently
      refuses a drop whose effects contradict, and never fires `drop`. **jsdom
      enforces none of this**, so the e2e test passed while the feature was broken —
      the real guard asserts `dropEffect` directly.
- [x] **The footer bar inverted in dark mode.** `background: var(--ink)` is the repo's
      inverted-fill idiom and flips correctly in both themes — but it had only ever
      been used on small chips and toasts, never a full-width persistent surface.
- [x] **"N to buy" named nothing.** `toBuyNames` now rides along on the plate, each
      dish and `GET /api/recipes/:id` — no extra query, the names were already loaded
      to compute the count. With the pantry ON the count is the *unmatched* subset,
      which no client could have derived from the ingredient list.
- [x] **The save toggle read like a pending action.** Reworded to "Keep in library"
      with a live state hint; it applies the moment it's flipped, and off removes the
      plate from the library without deleting or unscheduling it.
- [x] **"Add plate to list" was a one-way door.** Those rows are `source='recipe'`,
      which the weekly rebuild deliberately never wipes, so nothing anywhere could
      take them off. `DELETE /api/meals/:id/add-to-list` only deletes a row when the
      plate is its *sole* reason for existing — anything the week's own plan still
      needs survives with the plate's credit stripped.
- [x] **A fully-overlapped plate vanished from the By-meal view.** Every item it
      wanted was already claimed by an earlier meal, so its section had no rows and was
      dropped — making an added plate look un-added. It keeps its heading and says where
      its shopping went (rather than duplicating rows: one item, one checkbox).
- [x] **Cook mode for a plate shipped dark.** `/meals/meal/:id/cook` existed and worked;
      nothing in the app linked to it.
- [x] **Tapping a planned meal opened the slot picker.** Four surfaces decided what a tap
      meant from `entry.recipeId`, which is `null` for a meal-backed slot: the week grid,
      the month cell, the Today week list and the Tonight card (which claimed "No recipe
      attached yet" about a meal with three dishes).
- [x] **Sides and Mains listed the same recipes.** Both ran `!isDessert` — the same
      predicate — so no tagging could ever separate them. They now read `category` /
      `mealType`, with untagged recipes defaulting to mains. Tapping a slot's ＋ no longer
      moves the segment: it names a destination, and narrowing there hid the very recipe
      you meant to add.
- [x] **No 🍽️ Meals filter in the library.** Plates carry no cuisine/protein/dietary
      metadata, so every structured filter legitimately drops them — the filter that
      *selects* them has to be a type filter, or it would filter itself out.

### Found by the code review on PR #147 — fixed
- [x] **Taking a plate off the grocery list deleted rows you had added yourself.**
      Adding a plate credits it onto every off-plan row its dishes overlap, including
      rows already on the list, and removal read that credit as ownership. Credit
      (a display question) and creation (a deletion question) are now separate facts —
      `0092_list_item_created_by_meal.sql`.
- [x] **A bare re-add wiped a dish's role, cook and position.** The upsert's conflict
      branch guarded `role` against `excluded`, which is post-`VALUES`, so the guard
      could never fall through. Unreachable from the web UI; iOS is well placed to hit it.
- [x] **Deleting a scheduled plate left a ghost slot.** Nothing cleared
      `meal_plan_entries.meal_id` (the `on delete set null` never fires — the app only
      soft-deletes), so the week grid drew a nameless row and the weekly rebuild kept
      shopping for a plate that no longer existed.
- [x] **Every plate mutation failed silently.** `run()`'s catch was empty, and three
      callers paint locally before the request — a failed rename, library toggle or
      servings change stayed on screen until a reload.
- [x] **A stale snapshot could undo a newer change.** Two writes in flight, each
      answering with the whole plate; whichever landed last won. Writes are now
      sequence-stamped and an out-of-date repaint is dropped.
- [x] **The saved-meal library was N+1**, one dishes query per plate, while its two
      siblings in the same feature were already batched.
- [x] Stale status line in this file; dead `mealBuilderApi.remove` with no caller.

### PR2 — iOS — **done**
- [x] Builder (tap-to-add) on iPhone + iPad
- [x] Meal detail with per-recipe Cook
- [x] Unified recipe/meal library + search
- [x] Multi-recipe Cook Mode + timer re-keying
- [x] Grocery + calendar parity
- [x] Both view trees checked: `TodayView` (iPhone) and `KioskDashboard` (iPad)

**Calendar needed no iOS change**, which is worth recording so nobody goes looking for
it: the server already writes the plate's name into the event title and every dish into
its description, and iOS renders synced events as-is. The iOS `events` mirror carries no
recipe or meal linkage at all (see `SyncSchema.swift`), so "tap a meal event → open the
plate" would be new plumbing from the sync schema up, not a parity gap. It isn't in
scope for v1.

### Found while building the iOS parity — fixed
Each of these was a *client-side* re-derivation of "what is in this slot" that predated
plates, so none of them could have been caught by the server tests.

- [x] **A dragged plate lost its dishes.** `POST /api/meals/plan` — what every planner
      drag writes through — could only express "a recipe or free text", and the client's
      `moved(to:slot:)` rebuilt the relocated entry from the recipe fields alone. Between
      them, dragging a four-dish plate to another night left a bare title in a slot that
      pointed at nothing. The web planner has no drag, so PR1 never met this.
- [x] **The grocery "By meal" view dropped plates entirely.** Grouping matched on
      `recipeId` and skipped rows without one; a plate's items are tagged with its
      *dishes'* ids. Off-plan plates now get their own section (and can be taken back
      off from it), a fully-covered plate keeps its heading, and the provenance dots
      draw one dot per *source* rather than per recipe id.
- [x] **Tonight's card had nothing to offer on a plate night** — no View, no Cook —
      because it decided everything from `recipeId`. Both Today trees read one
      `TonightMeal`, so the iPhone and iPad cards were fixed together.
- [x] **The eating-out heuristics swallowed plates.** They fire on a recipe-less night
      whose title reads like takeout, and a plate is recipe-less too — so a plate named
      "Takeout Night" was drawn as an eating-out night on the Today card and in the
      month grid, with four dishes to cook.
- [x] **Four surfaces' taps were dead on a plate** (week grid, month grid, Tonight card,
      grocery recap). They push a placeholder plate and the detail reloads it by id —
      the same trick `RecipeSummary.placeholder` already played for recipes.
- [x] **The recipe on-hand banner counted staples, not the pantry** — the latent bug
      decision 5 called out, still live on iOS after PR1 fixed the web one. An empty
      pantry reported "4 of 9 on hand". With the pantry module off it now makes no
      on-hand claim at all, rather than a misleading "0 of 9".

### Found by the product owner driving it on a device — fixed
Every one of these was found by *using* the app, and none of them could have been: the
suites were green throughout, and `simctl` has no tap API, so the whole builder and cook
screen were unreachable to any automated check we had. Read this list before trusting a
green run on a UI change.

- [x] **The meal detail couldn't scroll to its last dish.** The tab bar floats over that
      page rather than contributing safe area, so the bottom of a long plate was simply
      unreachable.
- [x] **No way to cook a plate from the plate.** Every dish had its own Cook button, but
      the whole-meal session could only be started from tonight's card — so a plate you
      weren't cooking *tonight* couldn't be cooked at all.
- [x] **A new meal didn't focus its name.** Naming it is the first thing you do.
- [x] **"Cook the meal" wrapped mid-phrase** in the kiosk column and read as a
      mis-drawn button; shortened to "Cook meal" across all three surfaces.
- [x] **Drag couldn't target an empty role** — the one case where you most want it. A
      role with no dishes is a run of `moveDisabled` rows (header + ＋), and SwiftUI
      offers no drop position inside one. It now renders a movable "Drag a dish here"
      slot. **A unit test asserted this exact move and passed** — it covers the index
      arithmetic, not the drop-target behaviour, which was the broken half.
- [x] **Those slots then showed on a brand-new plate**, inviting a drag in all three
      roles with nothing anywhere to drag. Gated on the plate holding a dish.
- [x] **A fired timer stole your place with no way back** — see the "back to step N"
      pill. Worst on the dish you were *already* reading, where no tab could rescue you.

## Execution strategy — fan-out and integration

**Two PRs total.** PR1 = server + web, everything below. PR2 = iOS. The wave structure is
about *how the work gets done*; it does not split the PR.

Fan-out is decided by **file contention**, not feature boundaries. Four of the five web
surfaces would otherwise all touch `lib/api/meals.ts`, `routes.tsx`, `nav.ts` and shared
stylesheets — the files where a bad merge silently breaks several surfaces at once. So the
contention surface is landed serially first, and parallel agents only ever own leaf files.

| Wave | Mode | Work |
|---|---|---|
| 0 | serial | **API** — migration, meals service/routes, pantry helper, grocery aggregation, calendar event |
| 1 | serial | **Web foundation** — API client methods, shared types, route + nav registration, and one *empty* stylesheet per surface, all imported up front so no agent ever edits a shared file |
| 2 | **parallel ×4** | Builder · Library · Grocery · Cook Mode (see ownership map) |
| 3 | serial | **Timers** — depends on Wave 2D; own commit |
| 4 | serial | **Docs** — CHANGELOG, features reference, roadmap, permissions reword, stale-phrasing grep sweep |

### Wave 2 file ownership (strict — no agent touches another’s files)

| Agent | Owns |
|---|---|
| A · Builder | new `MealBuilder.tsx`, plate + library-panel components, `mealbuilder.css` |
| B · Library | `RecipesLibrary.tsx`, `RecipeBrowser.tsx`, `RecipeView.tsx` |
| C · Grocery | `GroceryBoard.tsx`, `GroceryCard.tsx`, `grocery.ts` — **plus** the 4 “meal builder” reword hits that live in those same files |
| D · Cook Mode | `CookMode.tsx`, `cookmode.css` — multi-recipe tabs only, timers excluded |

### Rules that make this work

- **Create the worktrees off this branch, not `origin/main`.** Agent worktree isolation
  branches from `origin/main` by default, which would give every agent a base with none of
  the Meal Builder API — their work would not merge. Create each worktree explicitly off
  the integration branch and pin the agent to its path. This has bitten the repo before.
- **Verify Wave 1 against the actually-running API before spawning Wave 2.** A wrong
  contract makes all four agents rework at once; parallelism amplifies a bad foundation.
- **Per-agent green ≠ integrated green.** Merge in dependency order, run the full
  `npm test` + `npm run build` after *each* merge, then verify with Playwright against the
  running kiosk. Integration is serial and is where the real bugs surface.
- Fresh worktrees have no `node_modules` — symlink, never commit.
- **Worktree isolation is not file isolation.** A subagent given `isolation: 'worktree'`
  gets its own checkout, but nothing stops two agents editing the same *path* in their
  own copies — the file-ownership table above is the only thing preventing a merge
  conflict, and it is enforced by nothing. Keep it strict and re-read it before spawning.
- **A green unit test is not a working feature.** Of the eleven defects the user found by
  driving this on a real stack, several sat behind passing tests — most sharply the
  library drag, where jsdom happily fires a `drop` that a real browser refuses. Drive the
  running kiosk with Playwright before calling any of this done.

### iOS (PR2)

Fan out **at most 2 ways** (builder + meal detail vs cook mode + timers). Each iOS
worktree needs its own `xcodegen generate` and a Vendor symlink, and `xcodebuild` is slow
enough that more parallel agents contend rather than compound. Both iPhone (`TodayView`)
and iPad (`KioskDashboard`) view trees must be checked for any Today/Calendar surface.

## Test plan

TDD, failing test first. API integration tests against a throwaway Postgres driving the
real routes, per repo convention.
