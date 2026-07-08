# Waffled — repo conventions & gotchas

High-signal notes for anyone (human or AI) working in this repo. This file is
auto-loaded by Claude Code in every session. Add a bullet when a mistake bites
more than once; keep it terse.

## How we develop — TDD is not optional (repo-wide)

**Test-driven development is the way we build here, not a QA step at the end.** For every
behavior change — a new endpoint, a service function, a bug fix, a counting rule — the flow is
always: **write the failing test first → watch it fail → write the minimum logic to make it
pass → refactor.** Do not write implementation before its test exists. Retrofitting a test onto
already-written code is a fallback for closing an *existing* gap, not the workflow — and when you
do it, say so explicitly.

**Prefer integration tests, strongly; unit tests second.** For the API, integration = drive the
real HTTP routes against a throwaway Postgres (`@testcontainers/postgresql` + `runMigrations`,
`app.run(...)`), asserting on responses — the harness in `apps/api/test/*.integration.test.ts`
(e.g. `goals.integration.test.ts`, `goals-health.integration.test.ts`). Reach for a unit test
(`*.unit.test.ts`) only when the logic is genuinely isolated (pure helpers). Run with `npm test`
(vitest) in `apps/api`.

## Releasing & the changelog (repo-wide)

1. **Log every user/operator-facing change in `CHANGELOG.md` under `## [Unreleased]` as
   you land it** — grouped by Keep-a-Changelog category (Added / Changed / Fixed / Removed
   / Security). `feat:` → Added, `fix:` → Fixed, user-visible `refactor`/`perf`/`chore` →
   Changed; pure-internal churn (`test`/`docs`/internal `chore`) is omitted. Write a **bold
   lead + a plain-language sentence**, synthesizing related commits into one feature-level
   entry — a changelog is for users, not a commit log. Match the existing entries.
2. **Cut a release ONLY with `./waffled release X.Y.Z`** — never hand-bump versions or
   hand-edit the changelog heading, and never move a published tag. That one command is the
   source of truth: it reviews the `[Unreleased]` notes (and **requires ≥1 entry**), dates
   them `## [X.Y.Z]` + opens a fresh `[Unreleased]` + adds the compare link, bumps **every**
   version site (`apps/api` + `apps/web` package.json + lockfiles, `WAFFLED_VERSION` in
   `infra/compose/.env.example`, iOS `MARKETING_VERSION`), commits `release: vX.Y.Z`, tags,
   and prompts to push. Run it **locally on `main`** — the pushed `v*` tag is what triggers
   the GHCR publish workflow (+ Xcode Cloud). Miss one version site by hand and repo/images/
   `.env` silently disagree. The GitHub Release notes are set **automatically** by the
   `release` job in `publish-images.yml`, which lifts the `## [X.Y.Z]` section out of the
   tagged `CHANGELOG.md` (so the notes you approved during `./waffled release` *are* the
   release body) — no manual `gh release edit` needed. It only falls back to GitHub's
   auto-generated notes if that section is missing/empty.

## iOS app (SwiftUI, `apps/ios`)

### Reuse before you hand-roll (same rule as the web app)

Before building a custom view or control, use what already exists — in this order:

1. **A native SwiftUI control.** `List` + `.swipeActions` for swipe-to-edit/delete,
   `Menu` / `confirmationDialog` for actions, `.searchable`, `.refreshable`, etc. If a
   native control seems not to fit (e.g. `.swipeActions` needs a `List` but you have a
   `LazyVGrid`), first try **restructuring** — use a `List` — before writing a bespoke
   gesture or control.
2. **The app's shared components + tokens.** `Features/DesignSystem/Components.swift`,
   `PlanShared.swift`, `WaffledCard`, `SectionLabel`, the `WF.*` colors/radii. Match the
   neighbours; don't invent a parallel look. Two menu families exist by design — see the
   "iOS UI consistency" memory before adding a third.

Only hand-roll when a native/shared option genuinely can't do the job — and say **why**
in a comment. (This bit us: a custom pantry swipe-control drifted from the Lists' native
swipe until it was reworked to `List.swipeActions`.)

### Performance — two traps we've hit repeatedly

1. **Don't use `AsyncImage` for images in a `List` / `LazyVGrid`.** It re-fetches
   and re-decodes every time a cell is recreated — which happens on *every search
   keystroke and every scroll* — and saturates the main thread (felt as
   multi-second lag just tapping a search field). Use the decoded-image cache
   **`CachedImage`** (`Sources/Waffled/Features/Pantry/CachedImage.swift`):
   `NSCache`-backed, resolves OFF (absolute) + uploaded (relative) URLs via
   `MediaURL`, and serves a cache hit **synchronously at `init`** so a re-render
   doesn't reload. (`ScreensaverView` has its own `ScreensaverImageCache`.)

2. **Keep date math out of the render/sort/filter hot path.**
   `Calendar(identifier:)` allocation + `startOfDay` per call — multiplied across a
   sort comparator (O(n log n)), filters, and per-row badges, then recomputed on
   every keystroke — janks hard. Allocating a `DateFormatter` per row is the same
   trap. Precompute derived per-row data (expiry days, flags, sort keys) **once per
   data load** in the `@Observable` model (e.g. `PantryModel.daysToExpiry: [id:
   Int]`), then O(1) look it up in the view. Make `DateFormatter`s `static let`.

**General rule:** precompute per-row derived data in the model on load; don't
recompute it in computed properties the view reads N× per render.

### Project generation

The Xcode project is generated by **XcodeGen from `apps/ios/project.yml`** (the
`.xcodeproj` is gitignored). New `.swift` files are auto-included by the directory
source, **but you must run `xcodegen generate` before building** so the project
sees them. New Info.plist keys / capabilities require editing `project.yml` then
regenerating.

## Web app (React/kiosk, `apps/web`)

### Design system — REUSE, don't hand-roll (this bit us — polish it once, use it everywhere)

**Two hard rules for any web UI you build:**
1. **Always match the app's visual style** — use the existing design-system classes/
   components. Never ship raw/base HTML controls (bare `<input type="number">`,
   default `<button>`, un-backdropped divs). If it looks like an unstyled browser
   default, it's wrong.
2. **Reuse the component/pattern that already exists** before writing a new one. If a
   modal/button/toggle/timer already exists, use it — don't reinvent a worse copy.

The shared vocabulary (grep these before hand-rolling):
- **Modals:** there's no `<Modal>` wrapper — the pattern is `.modal-overlay` (fixed,
  backdrop, centers its child) wrapping `.modal-card` (white rounded card) + a
  `.modal-close` × button. Copy `components/ListsModal.tsx` / `ChoreModal.tsx`. (A
  bare `.modal`/`.modal-backdrop` are **undefined** — using them = an un-centered,
  unstyled mess.) CSS: `styles/kiosk.css`.
- **Buttons:** `className="btn btn-primary"` (purple primary — **both** classes; `btn`
  alone or `btn-primary` alone loses the pill), `btn btn-ghost` (secondary/Cancel),
  `btn-ai` (gradient). CSS: `styles/waffled.css`.
- **Toggle:** the `.toggle` pill (`<span className={`toggle ${on?'on':''}`}>` inside a
  label) — not a raw checkbox. See `Settings.tsx`.
- **Labeled inputs in modals:** the `.field` / `.field-row` pattern (`styles/kiosk.css`).
  Pill selects use `.sel`.
- **Settings cards:** plain white card = `.set-card`. `.set-tray` is the *darker beige*
  group wrapper — only use it to intentionally group multiple cards; a lone card should
  not be wrapped in a tray.
- **Cook-mode / recipe timers:** the good timer-input pattern is `StepTimerControl` in
  `RecipeEditor.tsx` with `.re-timer-*` CSS (`styles/recipe.css`); the running-timer
  dock uses `.cm-timer-*` (`styles/cookmode.css`).
- **Meal placeholders** (leftovers / eating out / try-new) are `recipe_id NULL` rows
  whose `title` is regex-classified in `components/MealsColumn.tsx` and rendered as
  cards in `components/RecipeBrowser.tsx` — clone an existing card, don't invent a type.

**Verify front-end work by driving the running kiosk with Playwright (token +
screenshot) before calling it done** — a green unit test doesn't catch "looks like
unstyled HTML." (See the memory note of the same name.)
