# Changelog

All notable changes to **Waffled** (the self-hosted family hub) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
  RELEASING: add bullets under [Unreleased] as work lands, then cut a release with
  `./waffled release X.Y.Z` — it dates this section, bumps every version, commits, tags,
  and pushes (see "Release process" at the bottom). The `v*` tag publishes the GHCR images.
-->

## [Unreleased]

### Added
- **Shared goals now let you choose what "who took part" means.** When you log an activity and
  tap several people, a new per-goal setting decides how it counts: **Once for the family** (a
  park visit or camping trip counts once no matter how many came — the people are recorded as
  attendance), **Full credit to each** (everyone tapped gets the full amount toward their own
  tally, e.g. an hours leaderboard, while the family goal still counts it once), or **Split
  evenly** (the amount is divided across the people, as before). New shared goals default to
  *Once for the family*; existing hours-style pools keep *Split evenly*.

- **Add a recipe from a photo or by describing it.** The recipe editor's "New recipe"
  screen can now build the whole form for you two new ways. **From a photo** — snap or
  choose photos of a recipe card, cookbook page, or handwritten note (a few pages of one
  recipe is fine) and the AI reads them into ingredients and steps. **Describe it** — say
  or type what you know in any order ("brown a pound of beef, add two cans of beans, simmer
  30 minutes…") and it's organized into a proper recipe. Either way the AI fills in the whole
  recipe — not just the title, ingredients, and steps, but the details it can infer from the
  dish (cuisine, protein, cook method, meal type), the ingredients each step uses, and a timer
  on any step with a cook or rest time. Both drop straight into the editor for you to tidy up
  before saving — nothing is stored until you do. Photo import needs a
  vision-capable AI provider (Claude, OpenAI, or a vision Ollama model, chosen in Settings →
  AI & capture); describing works with any provider. Source photos are held briefly, then
  automatically deleted.

### Changed

- **Past events on the Today agenda now fade once they're over.** On the Today
  dashboard's agenda card, an event whose time has already passed is subtly dimmed —
  the same treatment the calendar's agenda list already uses — so at a glance it's clear
  what's done and what's still ahead. All-day events aren't dimmed. Web and iPhone.
- **Recipe steps that mention a time now get a timer automatically.** Whether a recipe
  comes from a photo, a description, or pasted Markdown, a step that says something like
  "cook for 6 minutes" now attaches a cook-mode timer without needing an explicit
  `**Timer:**` line. An explicit marker still wins, and a step that lists two times uses
  the first.

### Fixed
- **Logging a shared count goal with several people no longer multiplies the total.** Marking
  a state-park visit or camping trip with the whole family used to add one for *each* person
  selected; it now counts the event once and records who was there. (Set a goal to *Full credit
  to each* if you do want everyone credited the full amount.)
- **Checklist goals can no longer be given a meaningless numeric "log".** A checklist is
  completed by ticking its items, so recording "1" against it is rejected — checklists progress
  only by checking things off.

- **Per-step timers now carry into the recipe editor when parsing.** Building a recipe
  from a photo, a description, or pasted Markdown correctly detected each step's timer but
  dropped it when filling the form, so every step showed "Add timer" even when the recipe
  clearly stated a time. The parsed timer now lands on the step.

## [0.6.1] - 2026-07-09

### Added

### Changed

### Fixed
- **A goal's activity log no longer double-lists shared sessions.** When you log time on a shared
  goal and credit more than one person, the hours are still split between them behind the scenes —
  but the goal's Recent activity now shows that as a single line with the full amount and everyone's
  avatars, instead of one half-amount row per person. Web and iPhone.

## [0.6.0] - 2026-07-09

### Added
- **Thaw reminders for planned meals.** A new Meals setting adds a same-day calendar reminder —
  at a time you choose (default 8:00 am) — to pull the protein/ingredients out of the freezer for
  that day's planned meal. It's off by default and applies to dinners out of the box (you can pick
  which meal slots), works on web, iPad, and iPhone, and pushes to Google Calendar when meal-calendar
  sync is on.
- **Auto-fill goals from Apple Health (iPhone).** Link a goal to an Apple Health / Apple Watch
  metric — steps, flights climbed, exercise minutes, active energy, **mindful minutes**, your
  **activity rings** (Move / Exercise / Stand, or all three), or **logging your mood** (iOS 17+) —
  and its progress fills in on its own. Numeric goals accumulate each day's total; a habit counts a
  day whenever it clears a daily threshold you set ("2,000 steps a day, 5 days a week"), and rings
  and mood simply count a day when the ring closes or a mood is logged. Rings and mood also work on
  a **count** goal, so "close my Exercise ring 15× this month" or "log my mood 20 days" tallies one
  per met day. Not sure what to track? Tap
  **See your Health data** to pick a goal from your live values. Opening the app catches up every day
  since it last synced — so being away for two weeks fills all fourteen days on the next open — and
  it never pulls data from before the goal existed. Turn it on per goal in the editor's Extras, next
  to auto-count-from-calendar. Includes a new **Settings → Permissions** screen for managing device
  access (Apple Health, notifications, camera, mic). iPhone-only by nature; iPad and web display the
  synced progress.
- **Personal vs family calendars.** Each connected Google calendar can now be marked
  **personal** (only its owner sees it, on their own profile or phone) or **family** (shows
  on the shared kiosk) — so a work calendar stays off the family board while still appearing
  on your own device. Toggle it per calendar in Settings → Calendars; a newly connected
  account defaults your primary calendar to family and the rest to personal. The local Nook
  calendar is always family.
- **Give a chore a due time, not just a due date (web + iOS).** The new-chore form now has an
  optional **Due time** field, so a task can be due "Wednesday at 4:30 PM" rather than just
  "Wednesday." The time shows on the chore in the Tasks view and orders the day's list by when
  things are due.

### Changed
- **The "Needs a parent's OK" option only shows when it makes sense (web + iOS).** When a chore
  is assigned to an adult, the parent-approval toggle is now hidden — a parent doesn't need
  another parent's sign-off. It still appears for kids, teens, and up-for-grabs chores.

### Fixed
- **A one-off chore due later now shows on the list right away (web + iOS).** A task you add
  today with a future due date used to vanish until the due date arrived. It now appears on the
  list from the day you create it — with a calm "due tomorrow / due Fri" hint — and only flips to
  "overdue" once its due date passes. It also counts toward the day's totals, so the list and the
  rings stay in sync.

## [0.5.0] - 2026-07-08

### Added
- **Delete a recipe on iOS.** A recipe's **⋯** menu now has a **Delete recipe** action (with a
  confirm) alongside Edit. Deleting it removes it from your library and pops you back.
- **Schedule a recipe onto your meal plan from iOS.** A recipe's **⋯** menu now has a
  **Schedule…** action that opens a day-and-meal picker (Breakfast / Lunch / Dinner / Snack,
  this week or next) — tap a day to drop the recipe onto the plan, matching the web.
- **Check ingredients off on iOS.** Each ingredient row now has a tap-to-tick checkbox that
  strikes it through — a quick "what's left" tracker as you shop or cook (it clears when you
  leave the recipe, the same as the web).

### Changed
- **The recipe screen leads with one clear action (web + iOS).** The detail screen was redesigned
  for hierarchy on both the web/kiosk app and native iOS/iPadOS: **Cook Mode** becomes a single
  prominent button right under the title, the toolbar/top bar collapses to small favorite / edit /
  schedule (or **⋯**) icons, tags show the first few with a **"+N more"** toggle (hashtags drop to
  a quiet line), each method step references its ingredients as a short **"Uses: …"** line with an
  inline timer instead of a wall of chips, and the on-hand banner is one calm line with an
  **Add to grocery** action. On iOS you can also tick ingredients off and **Schedule** the recipe
  onto the plan from the same screen.
- **The Lists page is cleaner and easier to use (web).** The list header is decluttered into a
  single **⋯** menu (Rename · Save as template / Move to Lists · Delete) beside the Everyone
  filter, with **Use template** kept as the primary action on templates. Item rows now behave
  the way you'd expect: **tap the checkbox to check off, tap the item to edit it**, with the
  assignee avatar (or ＋) and a delete **×** always on the right — no more accidental check-offs.
- **"Use template" lets you name the new list first (web).** Choosing **Use template** now
  opens the New-list dialog pre-pointed at that template, so you give the new list its own
  name before it's created — instead of it silently spinning up a list named after the template.
- **Pantry swipe matches the Lists swipe on iPhone.** Swiping a pantry item now reveals the
  same native **Edit** / **Delete** actions you get on a list item, instead of a one-off
  custom control.

### Fixed
- **Recipe ingredients don't get chopped up on the grocery list.** An ingredient with a
  leading modifier like "boneless, skinless chicken breast" was truncated at the first
  comma, so the auto-built grocery list showed a stray item named just "boneless". The
  importer now keeps the modifier attached to the ingredient name. Existing recipes can be
  re-normalized in place with `apps/api/scripts/reparse-ingredients.ts`.
- **Deleting a list template updates the page right away (web).** Removing a template used
  to leave it on screen until you reloaded — it now disappears from the Templates section
  the moment you delete it.
- **Goal progress numbers stay inside the ring (web + iOS).** A long or fractional total
  (for example one produced by splitting a backfill across the family) used to overflow the
  progress ring. It now fits: on the web the value scales down to sit inside the stroke and the
  detail hero no longer collapses and clips the ring on narrow browser windows; on iOS the value
  shrinks to fit and big numbers round and abbreviate (295.99 → "296", 1,234,567 → "1.2M") so
  it stays short and readable at any magnitude.

## [0.4.0] - 2026-07-07

### Added
- **The web calendar's month view now has a day panel.** Picking a day in the month grid
  shows that day's events in a sidebar — the same agenda layout as on iPad — with events
  that have already finished subtly greyed out, plus a tap-to-add empty state for open days.
- **iPad in portrait gets an iPhone-style bottom bar.** Stand the iPad up vertically and the
  side navigation rail moves to a tab bar along the bottom, with the current page filling the
  space above it; rotate back to landscape and the side rail returns. It switches automatically
  and keeps your pinned destinations and the profile switcher, so it works either way you mount
  the iPad.

### Changed
- **List templates are now live and editable, in their own section (web + iOS).** Saving a list
  as a template converts it into an editable template that lives under a new **Templates** group
  on the Lists page — instead of a frozen snapshot that drifted from the original and piled up
  duplicates every time you re-saved. Edit a template's items anytime and every list you make
  from it with **Use template** reflects the latest; **Move to Lists** undoes a convert. Shipped
  on the web/kiosk app and the native iOS/iPadOS app.
- **System Health shows friendlier backup details.** The backups card now formats the last
  backup time as a local date/time and its size in KB/MB instead of a raw UTC timestamp and
  a byte count.

### Fixed
- **Adding list items keeps the keyboard up (iPhone + iPad).** After you added an item to a
  list, the "Add item" field lost focus, so you had to tap it again for every single item. It
  now stays focused — type an item, hit Return, and keep going.

## [0.3.1] - 2026-07-07

### Added
- **Swipe a pantry item to edit or delete on iPhone.** Rows in the pantry list now swipe
  left to reveal **Edit** and **Delete** — or keep pulling to delete outright — so you no
  longer have to open an item just to change or remove it.
- **iOS shows your server version and nudges you to update it.** Settings → About now shows
  which Waffled server build the app is connected to and flags — right on the page — when a
  newer one is available, and admins also get a pop-up on launch (like the web app), both
  with the `./waffled upgrade` command and links to the changelog and upgrade guide, so a
  new release doesn't slip by unnoticed.
- **iOS points you to an App Store update.** About surfaces a tappable "update available"
  link when a newer public build of the app is live on the App Store (appears once the app
  is published there).

### Changed
- **The update pop-up's "How to upgrade" opens the docs site.** Both the web and iOS
  new-version modals now link to https://docs.waffled.app/operations/upgrading/ instead of
  a raw file on GitHub.

### Fixed

## [0.3.0] - 2026-07-07

### Added
- **Scan non-food pantry items.** Barcode scanning now falls through to Open Food Facts'
  sibling databases — Open Beauty Facts (soap, shampoo, detergent), Open Products Facts
  (paper goods, cleaning supplies), and Open Pet Food Facts — so household and personal-care
  items resolve a name, brand, and photo instead of only food. The scanner credits whichever
  database answered, food-only details (nutrition, allergens) are hidden for non-food, and an
  unrecognized barcode still adds cleanly by name. Shipped on the web/kiosk app and the
  native iOS/iPadOS app.
- **Scanning remembers what you named a barcode.** Scan a barcode that no database knows,
  name it once, and a later scan recalls your entry — pre-filled and tagged "Saved by your
  family" instead of an empty "name it" card. It's scoped to your household and still works
  when Open Food Facts is unreachable. Applies to the web and native scanners alike.
- **Delete pantry items on iOS.** The native app can now remove pantry items, not just mark
  them used up — from the "Used up" list (**＋ Shopping list** to restock, or **Remove**) and
  via a **Delete** action at the bottom of the item editor, matching the web.
- **New-version notice pops up instead of hiding in Settings.** When a newer Waffled is
  available, admins now see a modal — the new version, the `./waffled upgrade` command, and
  links to the changelog and upgrade guide — rather than having to dig into Settings → System
  Health. It shows once per release (dismiss and it won't return until a newer one), and only
  to admins, since only they can run the upgrade.

### Changed
- **AI calls retry transient provider failures.** A one-off provider blip — an OpenAI
  `500 server_error` ("you can retry"), a rate-limit, or a dropped connection — used to
  fail the whole action (e.g. a meal plan came back empty). Such calls now retry
  automatically (short backoff, tunable via `AI_MAX_RETRIES`); a permanent error like a
  bad key or malformed request still fails fast. Applies to every AI feature and provider.

### Fixed
- **Deleting a repeating event on iOS no longer wipes the whole series.** From an event's
  detail screen, deleting one occurrence of a recurring event removed *every* event in the
  series — past and future. It now asks whether to delete just **This event** or **This and
  all future events** (which keeps past occurrences), matching the editor. Delete never offers
  an "all events" option, so past events can't be removed by accident; editing still can, since
  changing the repeat rule needs it.
- **Editing an event updates its detail screen immediately on iOS.** After saving an edit, the
  event detail you opened it from now reflects the change right away, instead of only after you
  closed and reopened it — the reload no longer races the in-flight save.
- **Pantry items open their detail on iOS again.** Tapping a pantry item on iPhone/iPad did
  nothing — the tap couldn't reach the item detail (or its Edit screen), because the row's
  navigation used a value type the Family hub's navigation stack couldn't route. Tapping now
  opens the item.
- **A suggested new recipe explains itself instead of dumping you into the picker.** In
  "Plan my week", tapping the title of an AI-suggested dish that isn't in your library used
  to open the full recipe-selection screen. It now shows a short sheet — a new recipe whose
  ingredients aren't known yet — with a one-tap web search for the dish and a "use one of my
  recipes" option if you'd rather swap it.
- **iOS builds now ship with the real release version.** The generated Info.plist
  hardcoded `CFBundleShortVersionString` to `1.0`, so every TestFlight / App Store build
  showed as 1.0 no matter what `./waffled release` bumped `MARKETING_VERSION` to. The plist
  now maps to `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`, so builds carry the
  actual version (e.g. 0.2.3).

## [0.2.3] - 2026-07-07

### Added

### Changed
- **Redesigned the goal create/edit screen (web + iOS).** A cleaner editor with a live
  preview of how the goal will appear on the family hub, plus its own "New goal" title bar
  with Cancel/Create actions. Web and iPad use a full-screen two-pane layout (form on the
  left, live preview on the right); iPhone uses a single scrolling column with the preview
  pinned to the top and a full-width **Create goal** button pinned to the bottom. Milestones
  now derive from your target instead of fixed values — with reward text left blank to fill
  in only if you want — calendar auto-tracking is on by default, and checklists start from
  three empty steps.

### Fixed

## [0.2.2] - 2026-07-07

A reliability release for the AI features: the pluggable providers now work with a
default `.env`, failures are diagnosable, OpenAI uses its current API, and first-run
goals are no longer created broken.

### Changed
- **OpenAI now uses the Responses API with strict Structured Outputs.** The OpenAI
  provider calls `/responses` (OpenAI's current API, replacing the legacy Chat Completions
  endpoint) with `strict: true`, so the model is *forced* to return schema-valid JSON. This
  applies everywhere AI is used — the capture bar, meal planning, calendar heads-up/insights,
  and event→goal matching. Note: the OpenAI provider now requires a Responses-API-compatible
  backend (OpenAI or Azure OpenAI); use the **Ollama** provider for local models.
- **AI calls are now logged.** Every provider call records its outcome — provider, model,
  duration, and on failure the underlying error (e.g. an OpenAI quota or key problem) — so
  issues surface in `docker logs` instead of silently falling back with no trace.

### Fixed
- **AI providers work with a stock `.env`.** Adding an OpenAI or Anthropic key to a `.env`
  that still had the empty `OPENAI_BASE_URL=` / `OPENAI_MODEL=` placeholder lines used to
  fail *every* AI request with an opaque error — the empty base URL produced a hostless
  request ("Failed to parse URL") and the empty model was sent as-is. Empty/blank env vars
  now correctly fall back to their defaults, and a previously-saved blank model falls back too.
- **Setup-wizard goals are attached to a goal list.** The onboarding "Set a goal" step
  created a goal with no group and no participants, leaving it invisible and uneditable on
  the list-scoped Goals page. It now creates (or reuses) a goal list for the chosen people —
  "Everyone" means the whole family — and attaches the goal, matching the full goal editor.

## [0.2.1] - 2026-07-06

A maintenance release: a one-command upgrade path, a bulk recipe importer, and fixes
for Safari, first-run reliability, and image build provenance.

### Added
- **One-command upgrades.** `./waffled upgrade` pulls the latest release end-to-end:
  fast-forwards the repo, bumps the pinned `WAFFLED_VERSION` in your `.env` to match the
  checkout (an existing `.env` was previously left on its old version, so a plain `up`
  re-pulled the old image), **snapshots the database** as a rollback point, pulls the new
  images, and applies migrations. The in-app "Update available" notice now names the
  command, and the self-hosting docs have a rewritten [upgrading guide](https://github.com/kevinpsites/waffled/blob/main/website/docs/src/content/docs/operations/upgrading.md).
- **Bulk Markdown recipe importer.** `apps/api/scripts/import-recipes-api.mjs` mass-imports
  a folder of Markdown recipes into any running server over the API (with an API key),
  tagging each with its subfolder as the recipe's collection. Idempotent, with a `--dry-run`.

### Changed

### Fixed
- **Recipe cards render correctly in Safari.** The library card was a `<button>` acting as
  a flex container, which Safari/WebKit doesn't lay out — the image collapsed to a narrow
  strip. It's now a `<div role="button">` (keyboard-accessible), matching the other cards.
- **API key is copyable and selectable.** The "Copy" button now falls back when the
  clipboard API is unavailable (Safari over plain http), and the key text overrides the
  kiosk's global no-select rule so it can be highlighted and copied manually.
- **Published images report real build provenance.** The release workflow now bakes the
  git SHA and build time into the GHCR images, so `/healthz` and `/api/health` show the
  actual release instead of the `dev` placeholder.
- **URL-safe generated Postgres password.** First-run `.env` bootstrap now generates
  `POSTGRES_PASSWORD` as hex instead of base64, so a `/` in the password can't break the
  `postgres://` connection URL and fail the one-shot `migrate` on a fresh install.

## [0.2.0] - 2026-07-06

The **July 2026 family-hub batch** — meal-planning, cooking, lists, and rewards
improvements, shipped across the web/kiosk app and the native iOS/iPadOS app.

### Added

#### Meals & recipes
- **Try New Recipe.** Steer the AI meal-plan week toward novelty — name dishes you
  want to try and let the planner favor recipes you haven't cooked yet — plus a
  **"Try something new"** placeholder dinner you can drop on any day (alongside
  leftovers / eating out).
- **🆕 New / never-cooked tag.** Recipes you've never marked cooked are tagged in
  the library, with a one-tap filter to show only them; the tag on a recipe's detail
  deep-links back to that filtered view.
- **On-the-spot cook timers.** Add a timer to a step that doesn't have one right from
  cook mode — using the same timer controls as the rest of the app — and tap it in
  the dock to jump back to its step.
- **Recipe step timers from Markdown.** Steps can declare a timer in plain text
  (`**Timer:** 20 minutes`, or an inline `{timer:20m}`); it's parsed on import and on
  paste, and surfaces as a real countdown in cook mode.
- **A "Waffles" recipe to start with.** Fresh households are pre-seeded with a Waffles
  recipe so the library isn't empty on day one.

#### Lists
- **List templates.** Save any list as a reusable template and apply it to spin up a
  new list from the saved items — handy for recurring shops and packing lists.

#### Rewards
- **Reward Shop redesign.** The kid-facing shop is rebuilt around a wallet hero
  (balance + what they're saving toward), category chips, reward tiles with
  locked/affordable states, a redeem confirmation sheet, and a celebration burst.
- **Reward categories.** Rewards can be filed under an optional category, filterable in
  the shop and set from the reward editor.
- **Spot-award stars.** Parents can hand out ad-hoc stars on the spot — from a family
  member's profile, from a quick-tap on the **Family Chores** card on Today, and from
  the Reward Shop with a person picker. Gated by a new `reward.grant` capability
  (adults on; teens/kids off by default).

#### Countdowns
- **Birthday horizon.** Upcoming birthdays only surface within a configurable window
  (about six months by default), so distant birthdays don't crowd the countdowns; the
  horizon is adjustable in Settings.

#### iOS / iPadOS
- **Full parity for the July batch.** Everything above ships on the native app too —
  save/apply list templates (with swipe edit + delete on the list index), on-the-spot
  cook timers, the 🆕 never-cooked tag and filter, Try New Recipe, spot-award stars,
  reward categories, the birthday horizon, and the redesigned Rewards-tab shop.

### Changed
- **Unified section titles.** The Reward Shop and today's-chores headers now share the
  same large serif title styling.

### Fixed
- **Goal recap wrapping.** Long event titles in the "Review events" recap now wrap
  normally instead of breaking one word per line.

## [0.1.0] - 2026-07-05

Everything below is the initial feature surface, shipped in the first tag
(**v0.1.0**). It covers the web/kiosk app, the native iOS/iPadOS app, and the
self-hosted server + tooling. Grouped by Keep a Changelog category; most-significant
user-facing features first within each.

### Added

#### Platform & deployment
- **Self-hosted, zero-dependency deployment.** `git clone` + `./waffled up` brings up
  the whole stack (Postgres, API, PowerSync, Caddy) via Docker Compose — no host
  toolchain and no manual steps. First run auto-generates `infra/compose/.env` with
  fresh secrets.
- **Guided setup.** `./waffled up` now runs a **preflight** (Docker present + running,
  Compose v2, free ports) with fix-it messages, and prints the exact URL to open when
  it's up. `./waffled setup` configures how devices reach the server (localhost / auto-
  detected LAN IP / hostname) and writes the address vars — avoiding the "shows Offline
  on the tablet" `localhost`-sync-URL trap.
- **In-container migrations** as a one-shot compose service (the API and PowerSync
  gate on it), so the schema and PowerSync publication exist before anything starts;
  idempotent on every `up`.
- **Prebuilt GHCR images by default.** `./waffled up` now **pulls** the published multi-arch
  (`waffled-api` / `waffled-caddy` / `waffled-backup`, amd64 + arm64) images pinned to
  `WAFFLED_VERSION`, so a fresh clone starts without a local toolchain build. `./waffled up
  --build` builds from source (dev / bleeding-edge) instead. Images publish on a `v*` tag.
- **Operator CLI** (`./waffled admin …`) for break-glass and recovery without the UI:
  reset-password, list/make/revoke-admin, password-login on/off, clear-calendar-error,
  prune-sessions, regenerate-powersync-key, list/delete-household, add-member,
  list-accounts. Runs in-container (host access is the authorization).

#### Accounts, identity & auth
- **First-run setup wizard** (web/server) — create the household + admin account in
  one step; locks once initialized.
- **Built-in email/password login** with rotating single-use refresh tokens and
  transparent 401-refresh (scrypt password hashing, HS256 access JWTs).
- **OIDC SSO** — backend-mediated auth-code + PKCE flow, admin-configured in Settings
  (client secret encrypted at rest), invite-gated (a verified email must match an
  existing member). Optional "disable password login / force SSO" with a break-glass
  env override.
- **Member management** — grant any family profile a login (email ± password) from
  Settings; removing a login revokes sessions.
- **Multi-household accounts** — one human can belong to several households and switch
  between them without re-logging-in (account-scoped tokens; Settings → Households
  switcher; admin-gated additional-household creation).
- **Role-based permissions** — per-role capability grid (adult/teen/kid) for
  `chore.manage`, `chore.approve`, `reward.manage`, `reward.approve`, `goal.manage`;
  editable per household by an admin; `is_admin` stays the superuser. Enforced
  server-side and reflected as render-if-capable gating in the UI (no show-then-403).

#### Kiosk & ambient display
- **Kiosk device pairing** — pair an iPad/tablet to the household via an admin code or
  a one-tap "use this device" promote; a **Netflix-style profile picker** mints a real
  per-person session on tap.
- **Optional per-person PIN** to open a profile (throttled, lockout countdown), plus
  "switch profile", idle return to the picker, and "exit kiosk mode" on the device.
  Single-login (no pairing) stays the default.
- **Idle screensaver** — photo slideshow with crossfade, clock/date/weather/next-event
  chrome, night dimming on a schedule, keep-awake, and a live "Preview" from settings.
  Source selectable (all / favorites / a specific album), speed, and shuffle.

#### Today dashboard
- **Customizable Today dashboard** — cards for agenda, tonight's meal, this week,
  chores, and grocery. Drag-to-reorder in Customize mode, save **for me** (per-user)
  or **for everyone** (family default). iPad uses distinct layout presets
  (Balanced / Agenda / Meals / Goal-focused).
- **Recap and approval banners on Today** — "Did these happen?" goal recap queue and
  "Needs your OK" approvals surface where the family sees them.

#### Calendar & events
- **Native events** — create/edit/delete with multiple participants (per-person
  color, stacked avatars), across Month / Week / Day / Agenda views, with a live
  "now" line on the time grids and a full-screen event detail (location/Directions,
  repeats, notes, timeline).
- **Recurring events** — RRULE creation (Daily / Weekdays / Weekly+days / Monthly
  nth-weekday / Custom), per-occurrence edit scope (this / following / all), and end
  conditions (never / on a date / after N).
- **Two-way Google Calendar sync** — per-household OAuth, inbound poll + outbound
  push (idempotent, retried), per-person write-target, managed in Settings → Calendars.
- **Offline calendar** via PowerSync — local-first reads and queued writes that drain
  on reconnect (on web and iOS).
- **AI calendar cards** — a "Heads up this week" digest and per-event insight, computed
  deterministically server-side so they degrade gracefully with no provider.
- **Countdowns** — "N days until X" merged from three sources (flag an event, a
  standalone item, or member birthdays); Today card + month-grid badge + household
  "N sleeps" toggle.

#### Tasks & chores
- **Chores** — CRUD with assignee and stars/currency, daily instances, complete →
  award, family-chore rings on Today, and a Tasks/Kanban board.
- **Weekly/custom schedules**, **one-off / carry-over tasks** (roll forward until
  done, with an "overdue · since …" badge), **up-for-grabs** claim, and
  **drag-to-reassign** between columns.
- **Parent-approval step** (awaiting → approve/reject before award) and **streaks**
  (🔥 N consecutive days).
- **Photo proof** — per-chore "requires a photo"; capture on complete, a review modal
  (large photo + Approve/Not-yet), auto-delete retention (default 3 days), and a
  stored-proof review/delete gallery.

#### Rewards & economy
- **Stars earn ledger** (append-only) + per-person balances.
- **Rewards catalog** — redeem → parent-approve → ledger debit (balance-guarded).
- **Multi-currency** economy (custom currencies, symbols, colors) with
  **conversions/"Trade"** between currencies.
- **Saving-toward a reward** — pin one reward and see bar/jar progress with "X to go"
  and inline redeem.

#### Goals
- **Goals** — count / total / habit / checklist types, goal **lists** with membership
  (shared vs individual), shared-pool vs each-tracks, create/edit/delete, type-aware
  logging, and backdated logs.
- **Goal detail read-model** — milestone track, hours-by-person, streaks, recent
  activity; named checklist steps and per-type milestones (text).
- **Person profile + family overview** — per-member goals, progress, streaks, and
  balances.
- **Calendar → goal auto-counting** — tag an event "counts toward a goal"; when it
  ends, an editable recap ("Did Soccer happen?") logs progress idempotently. Includes
  recurring-event counting and **smart suggestions** ("might count toward a goal") that
  learn per family.

#### Lists & groceries
- **Custom multi-lists** — sectioned items, quantities, per-item assignees;
  create/rename/delete with cascade.
- **Auto-built grocery board** from the week's dinners — aisle grouping, quantity
  merge, By-aisle / By-meal views, pantry-staples kept off the list, and per-item
  **attribution** ("added by {name}" / "🍽 from meal plan").
- **Re-aisle** any grocery item (section chips + Auto).
- **Cross-surface live refresh** so Today ↔ Lists ↔ Rewards stay in sync without reloads.

#### Meals & recipes
- **Weekly and month meal planners** with a recipe picker and drag-to-swap.
- **Recipes library** (search-all-metadata, multi-select filters, sort) and a
  full-screen **recipe detail** (hero image, metadata chips, servings scaler,
  total/prep/cook time).
- **In-app recipe editor** — author or fully edit recipes (metadata, dietary,
  vegetables, tags, ingredient rows with sections, per-step ingredients and amounts).
- **Paste-markdown import** — paste a recipe (or LLM-generated markdown) → parse →
  review → save. (A `just import-recipes` CLI exists as a dev/seed tool.)
- **Per-recipe overrides** — substitutions and notes that survive re-import and feed
  the substitution-aware grocery build.
- **Cook mode** — step-by-step, wake-lock, recipe overview to jump to any step,
  **per-step timers** (floating dock, alarm), and finish → mark cooked.
- **AI meal features** — "Plan my week / month" (library-only, themes, gaps) and
  metadata auto-fill (cuisine, protein, grounded vegetables, tags).

#### Photos & memories
- **Family wall** — aspect-preserving grid, upload (downscaled JPEG, 10 MB cap,
  capability URLs), multi-upload with caption/album/favorite, drag-and-drop upload
  zone (web), albums, edit (caption/album/date/favorite), multi-select bulk
  move/delete, and per-tile delete.
- **Set an album as the screensaver source** and a photo-only "Play" slideshow.
- Recipe **hero images** use the same upload pipeline.

#### AI capture ("Add anything")
- **Natural-language capture** → event / task / grocery / meal, including parsed
  event recurrence.
- **Pluggable provider** per household (Anthropic / OpenAI-compatible / Ollama) with
  server-only credentials; the UI only offers providers whose key/host the server
  reports present.
- **Instant on-device parse, then upgrade to the LLM** with a provider tag, and a
  **heuristic fallback** so capture works offline / with no provider.

#### Optional modules
- **Module framework** — per-household enable flags in `households.settings.modules`
  gate Today cards, nav, and routes; a **Settings → Modules** tab toggles them
  (Chores/Goals/Meals/Lists/Rewards, plus Pantry and Family Night).
- **Pantry / on-hand inventory** — items with quantities and locations
  (fridge/freezer/pantry), quantity stepper + "used up", drag between locations,
  redesigned list (sidebar, search, sort), and an item-detail sheet.
- **Pantry Open Food Facts integration** — barcode lookup (cached) and camera scanner,
  nutrition + allergen snapshots ("may contain" traces, dietary flags), household ∪
  per-person **allergen warnings** with colored badges, running-low thresholds,
  per-location icons, and item age.
- **Pantry ↔ meals** — "Cook from your pantry" (makeable now, on-hand proteins as
  mains, leftovers, Plan-my-week seeded with soon-to-expire) and the **cook → deplete**
  loop (a "Used from your pantry" confirm sheet decrements/uses-up stock).
- **Family Night** — a recurring family gathering (default Monday) with a fully generic,
  customizable agenda of "parts" that auto-rotate among members (overridable per week),
  a Today card with per-part person pickers, an admin agenda/day/time editor, and an
  optional weekly calendar event.
- **Public API keys + scopes** — issue `waffled_…` keys (`x-api-key`) with
  `<resource>:read|write` scopes for external integrations, managed in a
  Settings → API Keys tab (generate / scope / reveal-once / revoke); layered over the
  in-route capability matrix, with sensitive paths never exposed.

#### Notifications (iOS)
- **iOS local event reminders** driven off the on-device events mirror (fire offline /
  when closed, 64-pending cap), with Snooze / View actions and per-user settings
  (lead time, all-day hour, my-events-only).

#### Weather
- **Live weather** on the kiosk topbar and Today/screensaver via Open-Meteo (no API key).

#### iOS / iPadOS app
- **Universal native app** — one binary that adapts by idiom: an iPhone
  *personal-planner* experience and an iPad *family-hub* experience (left nav rail,
  wide layouts, the counter screensaver) over a shared SyncManager/WaffledAPI data layer.
- **Native auth** — email/password + OIDC SSO (Keychain token store, 401-refresh,
  `ASWebAuthenticationSession`), and About settings (version + editable server address).
- **Offline-first calendar** via the PowerSync Swift SDK (persons/events/participants/
  households mirrored to on-device SQLite; queued writes drain on reconnect).
- **Native media** — `PHPicker` upload, a Photos tab (gallery / add / detail / edit),
  and the iPad screensaver (slideshow + Ken-Burns toggle).
- **iPad shared-kiosk mode** — profile picker + per-person PIN as an opt-in.
- **Chore photo-proof**, capability-based permission gating, and a role permissions
  matrix editor (admin).
- Shared iOS design-system primitives (loading, badges, tiles, CTAs, field cards) for
  UI consistency across screens.
- **Calendar Countdowns** — a Today card + month-grid badges counting down to flagged
  events, standalone items, and members' birthdays, with a "N sleeps" wording toggle.
- **Pantry module** — on-hand inventory (locations, quantities, "used up"), Open Food
  Facts barcode/type lookup (nutrition + allergen + dietary snapshots), allergen warnings,
  item age, **cook → decrement**, and **Cook-from-pantry** (recipes makeable now); a
  **Settings → Pantry** editor (locations, per-location icons, running-low / item-age
  thresholds, allergen avoid-list) and a Pantry Today card (honors "show on Today").
- **Family Night module** — a Today card (per-part person pickers over an auto-rotating
  agenda) + a **Settings → Family Night** editor (weekday · time · calendar toggle · parts).
- **Customizable iPad nav rail** — a per-device picker (Today + Calendar pinned, choose up
  to 5 more) with everything else in a new **"More"** hub.
- **Settings reorganized** into **Account · Family · System** tiers (mirroring web);
  "Accounts" → **Households**; **Display & Kiosk** split into "This iPad" (device-local)
  vs "Family displays" (household-wide); the Family list ordered to match Modules.
- **Kinnook app icon** + a cold-launch bouncing-logo splash on the warm-white canvas.

#### Observability & operations
- **Structured JSON logging** + per-request access log with a request id.
- **Deep `GET /api/health`** (db + pool, migrations, scheduler snapshots, calendar push
  backlog + stale calendars, media writability, build sha) and an enriched public
  `/healthz`.
- **Settings → System Health** admin panel (live, polls `/api/health`) with actionable
  hints, and **`./waffled doctor`** for an in-container health report.
- **Background job run registry** (last-run / duration / error / run count per
  scheduler) and baked **build provenance** (git sha + build time).
- **OpenTelemetry** traces + metrics (OTLP, off by default) and an all-local
  Grafana/OTEL stack via `./waffled observability up`.
- **Automatic backups (local + offsite) & restore.** A `backup` sidecar dumps the
  database nightly (`BACKUP_TIME`) into the `waffled_backups` volume — on by default,
  zero-config — pruned after `BACKUP_RETENTION_DAYS`. Optional offsite copy to any
  S3-compatible store (`BACKUP_S3_*` — AWS S3 / Backblaze B2 / Cloudflare R2 / MinIO),
  optional media archive (`BACKUP_INCLUDE_MEDIA`), and a custom target folder
  (`BACKUP_HOST_PATH`). `./waffled backup [list]` runs one on demand; `./waffled restore
  <file>` does a confirmed, app-stopped, single-transaction restore. Each run is recorded
  in `backup_runs` and surfaced by the `backup` health check (degraded when a run failed
  or the last success is >48 h old). See the Backup & restore docs.
- **CI runs the test suites.** GitHub Actions runs the api (Testcontainers) + web
  (vitest) suites and typechecks on every PR and push to `main`.
- **In-app update notifier.** Settings → System Health shows whether a newer GitHub
  release is available (`UPDATE_CHECK_REPO`, cached 6 h), with an admin toggle and an
  `UPDATE_CHECK_ENABLED` operator kill-switch (no outbound call when off).
- **Healthchecks on every default service** — added caddy + lgtm, so `docker compose ps`
  (and `./waffled status`) is all-green.
- **Release automation.** A version tag (`v*`) now cuts a GitHub Release (auto notes +
  `example.env`) and publishes all three images (api, caddy, backup) to GHCR.

### Changed
- **Licensed under AGPL-3.0** (`LICENSE`); added `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, and upgrading/troubleshooting guides.
- **Documentation site** — user/operator docs now live in a searchable Astro Starlight
  site under `website/` (moved out of `docs/`; engineering docs stay in `docs/`), deployed
  to GitHub Pages by `.github/workflows/docs.yml`.
- **Route authorization refactored** into composable per-route guard wrappers
  (`tenantRoute` / `adminRoute` / `capRoute`), replacing ~135 routes' copied
  `requireTenant` + inline capability boilerplate (net −160 lines); handlers now
  receive the resolved tenant, and guards stash `householdId` for the access log.
- **Onboarding state moved server-side** — the post-setup "Getting started" checklist
  is tracked in `households.settings.onboarding`, so it follows the household across the
  admin's devices instead of living in one browser's localStorage.

### Removed
- **Cloud/Terraform/Auth0/AWS plan dropped** in favor of the self-hosted (Immich-style)
  Docker Compose + built-in-auth/OIDC direction (2026-06-20 pivot).
- **Legacy `credentials` auth table dropped** (superseded by the accounts model); no
  unused auth table ships at GA.

### Security
- OIDC client secret and Google Calendar refresh tokens are **encrypted at rest**
  (AES-256-GCM).
- Refresh tokens are **opaque, single-use (rotating), and stored sha256-hashed**;
  passwords use scrypt.
- Media is served via **unguessable per-household capability URLs** (Caddy serves the
  blobs directly; the API is out of the read path).
- API keys are stored **sha256-at-rest**, revealed once, and scoped; only paths in the
  scope catalog are reachable by key auth (auth/kiosk/permissions/key-mgmt/PowerSync are
  never exposed).

### Deprecated
- _Nothing yet._

---

## Release process

This project keeps a **rolling `[Unreleased]` section** that is updated as PRs land, and
cuts versioned releases by tagging.

**As work lands:** add a bullet under the right category in `[Unreleased]`. A changelog
is for users and operators, not a commit log — **synthesize** related commits into one
feature-level entry, grouped by product area, and **omit pure-internal churn** (docs,
tests, tooling, and refactors with no user-visible effect).

**To cut a release:** run **`./waffled release X.Y.Z`** locally on `main`. In one commit it:
1. Reviews the `[Unreleased]` notes with you (**requires at least one entry**), dates the
   section `## [X.Y.Z] - YYYY-MM-DD`, opens a fresh `## [Unreleased]` above it, and adds the
   compare link.
2. Bumps the version to match the tag everywhere the repo, the published images, and a fresh
   clone's generated `.env` must agree: `apps/api/package.json`, `apps/web/package.json`,
   **`WAFFLED_VERSION`** in `infra/compose/.env.example` (the pinned GHCR image tag that
   `./waffled up` pulls), and iOS `MARKETING_VERSION` in `apps/ios/project.yml`.
3. Commits `release: vX.Y.Z`, tags it, and prompts to push. The pushed `v*` tag triggers
   [`.github/workflows/publish-images.yml`](.github/workflows/publish-images.yml), which builds
   and pushes the multi-arch `waffled-api` / `waffled-caddy` / `waffled-backup` images to GHCR
   (semver + `major.minor` + `latest` tags); the `main` push triggers the iOS Xcode Cloud build.

After the run, set the GitHub Release notes to the released section:
`gh release edit vX.Y.Z --notes-file <file>`. Never hand-bump versions or move a published
tag — the command is the single source of truth so nothing drifts out of sync.

**Versioning** follows [SemVer](https://semver.org/): breaking API/data-model or
self-host changes bump **MAJOR**, backward-compatible features bump **MINOR**, and
fixes bump **PATCH**. Pre-1.0, expect **MINOR** to carry the weight of feature work.

**Commit prefix → changelog category** (this repo uses conventional-commit-ish
`type(scope): summary`):

| Commit prefix                      | Changelog category                           |
| ---------------------------------- | -------------------------------------------- |
| `feat`                             | **Added**                                    |
| `fix`                              | **Fixed**                                     |
| `refactor` / `perf` / `chore`\*    | **Changed** *(only if user/operator-facing)* |
| `docs` / `test` / internal `chore` | *omit* (internal churn)                       |
| _(removals / deletions)_           | **Removed**                                   |
| _(security-relevant changes)_      | **Security**                                  |
| _(soon-to-be-removed features)_    | **Deprecated**                                |

\* Most `chore`/`refactor`/`test`/`docs` commits are omitted; include one only when a
user or operator would notice the result.

[Unreleased]: https://github.com/kevinpsites/waffled/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/kevinpsites/waffled/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/kevinpsites/waffled/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kevinpsites/waffled/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kevinpsites/waffled/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/kevinpsites/waffled/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kevinpsites/waffled/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/kevinpsites/waffled/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/kevinpsites/waffled/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/kevinpsites/waffled/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kevinpsites/waffled/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kevinpsites/waffled/releases/tag/v0.1.0
