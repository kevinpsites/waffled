---
title: API reference
description: The Waffled HTTP API — authentication, API keys, and every endpoint by module.
---

Waffled is a REST API with three clients on top of it. The same API is available to you: build
integrations, scripts, and companion tools against your own household's data. This page covers
**authentication**, **API keys**, and a complete **endpoint reference** grouped by module.

Everything lives under **`/api`** (a handful of auth/OAuth callbacks and the public `/healthz`
are the exceptions, noted below). The API is built with lambda-api; there is currently **no
OpenAPI/Swagger document** — this page is the reference.

## Authentication

Every non-public request is authenticated at a single global gate. There are four ways in:

1. **Bearer JWT (default).** `Authorization: Bearer <token>` — how the web and iOS clients
   authenticate. The token carries a `household_id` claim; the api resolves it to a person +
   household (`sub → identity → person → household`) and re-checks per route. Get one from the
   login flow, or `./waffled token` for a dev token.
2. **API key.** `x-api-key: waffled_…` — for external tools and scripts. See below.
3. **Kiosk device token.** A paired tablet exchanges a device secret for a short-lived device
   token; tapping a profile mints a real person session. See [Kiosk & devices](/administration/kiosk/).
4. **Waffled-Bite device token.** A kid's paired Bite does the same exchange for its own token,
   which works only on the [Bite's device routes](#waffled-bites--modulewaffledbites).

**Public endpoints** (no auth): `/healthz`, `/api/auth/keys` (JWKS), the auth
status/setup/login/refresh/logout and OIDC start/callback/exchange routes, `/api/kiosk/pair`,
`/api/kiosk/device/token`, `/api/waffled-bites/pair`, `/api/waffled-bites/device/token`, and
the Google and Microsoft calendar OAuth callbacks.

Authorization beyond "signed in" is a small [capability grid](/concepts/permissions/): routes are
guarded by `tenantRoute` (any member), `adminRoute` (admin/owner), or `capRoute(<cap>)` (a
specific capability). Optional [modules](/administration/modules/) add a `moduleRoutes(key)` gate
that 403s when the module is off.

## API keys

Create and manage keys in the app (they're minted by a signed-in session, not by another key):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/api-keys/scopes` | The grantable scope catalog (for the create-key UI) |
| `GET` | `/api/api-keys` | List your keys (metadata only) |
| `POST` | `/api/api-keys` | Mint a key — **the secret is returned once** |
| `DELETE` | `/api/api-keys/:id` | Revoke one of your keys |

A key resolves to its **owner person**, and requests carry that person's role/capabilities. Keys
are **scope-limited**: a scope is `<resource>:<read|write>`, where `:read` covers `GET`/`HEAD`,
every other method needs `:write`, and holding `:write` implies `:read`. These are the only
paths a key can reach at all — the live list is also served from `GET /api/api-keys/scopes`:

| Scope resource | Paths it covers |
|---|---|
| `family` *(read-only)* | `/api/household` · `/api/persons` · `/api/family` |
| `lists` | `/api/lists` · `/api/pantry-staples` |
| `pantry` | `/api/pantry` |
| `chores` | `/api/chores` · `/api/chore-instances` · `/api/chore-proofs` |
| `rewards` | `/api/rewards` · `/api/redemptions` · `/api/balances` · `/api/currencies` · `/api/conversions` |
| `meals` | `/api/recipes` · `/api/meals` |
| `calendar` | `/api/events` |
| `goals` | `/api/goals` · `/api/goal-lists` |
| `photos` | `/api/photos` |
| `weather` *(read-only)* | `/api/weather` |

A prefix only covers a path on a `/` boundary, which is why the hyphenated siblings
(`/api/chore-instances`, `/api/chore-proofs`, `/api/goal-lists`, `/api/pantry-staples`) are
listed in their own right rather than inherited from `/api/chores`, `/api/goals` and
`/api/pantry`. Note that **`/api/pantry-staples` belongs to `lists`, not `pantry`**: staples are
part of the grocery board and the route sits behind the `lists` module gate.

Everything else always 403s for a key — auth and self-service account, household creation and
invites, api-keys, `/api/kiosk`, `/api/waffled-bites`, permissions,
powersync, capture, media, countdowns, family-night, goal-calendar, the rest of `/api/calendar`
(Google, Outlook and ICS feeds), today-layout, rhythms, weekly-planning, health and updates. Writes under a read-only
resource are refused too, so `POST /api/persons/:id/award` and
`/saving-toward` stay session-only even though they belong to the rewards feature. In-route
capability **and** module checks still apply on top of the scope, so a key can never do more
than its owner person can.

---

## Endpoint reference

Auth column: **tenant** = any signed-in member · **admin** = admin/owner · **cap:X** = requires
capability X · **module(X)** = requires module X enabled · **device** = kiosk device token ·
**bite** = Waffled-Bite device token · **public** = no auth. The two device tokens are separate:
neither works on the other's routes.

### Core

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/healthz` | Liveness + db ping + build info | public |
| GET | `/api/me` | Echo the token's `sub` | tenant |
| GET | `/api/household` | Caller's household, person, capabilities, memberships | tenant |
| POST | `/api/households` | Create an additional household | admin |

### Auth & account

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/auth/status` | Is the instance initialized + login methods | public |
| POST | `/api/auth/setup` | First-run: create first household + owner | public |
| POST | `/api/auth/login` | Email/password → access + refresh | public |
| POST | `/api/auth/refresh` | Rotate refresh → new tokens | public |
| POST | `/api/auth/switch` | Switch active household | tenant |
| POST | `/api/auth/logout` | Revoke a refresh token | public |
| GET · PUT | `/api/auth/config` | Read/update OIDC config | admin |
| POST | `/api/auth/config/test` | Test OIDC config | admin |
| GET | `/api/auth/oidc/start` · `/callback` · POST `/exchange` | OIDC login flow | public |
| PUT · DELETE | `/api/persons/:id/login` | Add/remove a member's login | admin |
| GET · PUT | `/api/account` `/account/profile` `/account/password` `/account/email` | Self-service account | tenant |
| POST · GET · DELETE | `/api/households/invites[/:id]` | Manage invites | admin |
| GET | `/api/auth/invites` · POST `/:id/accept` | Accept an invite | tenant |

### Family — persons, settings, overviews

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/household/settings` | Read household settings | tenant |
| PATCH | `/api/household` · `/household/onboarding` · `/household/modules` | Update household / onboarding / module toggles | admin |
| GET · POST | `/api/persons` | List / add members | tenant / admin |
| GET · PATCH · DELETE | `/api/persons/:id` | Get / update / remove a member | tenant / admin |
| POST | `/api/persons/:id/saving-toward` | Set a member's saving-toward reward | tenant |
| GET | `/api/family/overview` · `/api/persons/:id/overview` | Family / person overview | tenant |
| GET · PUT | `/api/permissions` | Read/update the capability grid | admin |

### Calendar & events

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST · GET | `/api/events` | Create / list events | tenant |
| GET | `/api/events/today` | Today's events | tenant |
| GET · PATCH · DELETE | `/api/events/:id` | Get / update / delete an event | tenant |
| GET · POST · PATCH · DELETE | `/api/countdowns[/:id]` · PUT `/config` | Countdowns + config | tenant |
| GET | `/api/calendar/heads-up` · `/api/events/:id/insight` | AI heads-up / insight | tenant |
| POST | `/api/calendar/google/connect` · `/api/calendar/microsoft/connect` | Start a Google / Outlook connect — returns the consent URL (501 if that provider isn't configured) | admin |
| GET | `/auth/google/calendar/callback` · `/auth/microsoft/calendar/callback` | OAuth callbacks | public |
| GET · PATCH · DELETE | `/api/calendar/google/status` · `/google/calendars/:id` · `/google/accounts/:id` | Connected accounts, calendars and feeds / map or toggle a calendar / disconnect | admin |
| GET | `/api/calendar/feeds` | List ICS feed subscriptions | tenant |
| POST · PATCH · DELETE | `/api/calendar/feeds[/:id]` | Subscribe / edit / remove an ICS feed (removing it removes its events) | admin |
| POST | `/api/calendar/feeds/:id/sync` | Poll one ICS feed now | admin |
| POST | `/api/calendar/sync` | Trigger inbound sync | tenant |

The `/google/status`, `/google/calendars/:id` and `/google/accounts/:id` paths predate Outlook
support and keep the `google` segment, but they cover accounts from **every** provider.

### Chores & rewards — `module(chores)`

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · PUT | `/api/chores/settings` | Chore settings | tenant / admin |
| POST | `/api/chores` · PATCH · DELETE `/:id` | Create / manage chores | tenant / cap:chore.manage |
| GET | `/api/chores/today` · `/api/chore-instances/today` · `/awaiting` | Today / awaiting instances | tenant |
| POST | `/api/chore-instances/:id/complete` · `/uncomplete` · `/claim` · `/assign` | Work an instance | tenant |
| POST | `/api/chore-instances/:id/approve` · `/reject` | Approve / reject | cap:chore.approve |
| GET · DELETE | `/api/chore-proofs[/:id]` | Manage proof photos | admin |
| GET · POST · PATCH · DELETE | `/api/rewards[/:id]` · `/archived` · `/:id/restore` | Rewards catalog | tenant / cap:reward.manage |
| GET | `/api/balances` · `/api/redemptions` | Balances / redemptions | tenant |
| POST | `/api/rewards/:id/redeem` | Redeem a reward | tenant (self) / cap:reward.manage (someone else) |
| POST | `/api/persons/:id/award` | Spot-award currency | cap:reward.grant |
| POST | `/api/redemptions/:id/approve` · `/deny` | Approve / deny a redemption | cap:reward.approve |
| GET · PUT | `/api/rewards/settings` | Reward settings | tenant / cap:reward.manage |
| GET · POST · PATCH · DELETE | `/api/currencies[/:id]` · `/api/conversions[/:id]` · `/:id/apply` | Currencies & conversions | tenant / admin |

*Rewards routes also require the rewards sub-flag (`settings.chores.rewards`).*

### Goals — `module(goals)`

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · POST · PATCH · DELETE | `/api/goal-lists[/:id]` | Goal lists | tenant / cap:goal.manage |
| GET · POST · PATCH · DELETE | `/api/goals[/:id]` | Goals | tenant |
| POST | `/api/goals/:id/log` · PATCH `/steps/:stepId` | Log progress / update a step | tenant |
| GET · POST · DELETE | `/api/goal-calendar/*` | Calendar→goal recap, suggestions, memory | tenant |

### Meals & recipes — `module(meals)`

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · POST · PATCH · DELETE | `/api/recipes[/:id]` · `/sections` | Recipe library | tenant |
| POST | `/api/recipes/parse-markdown` · `/suggest-metadata` · `/:id/cooked` · `/:id/ingredients` | Import / AI / cooked / ingredients | tenant |
| GET · POST · DELETE | `/api/meals/plan` · `/week` · `/plan-week` · `/plan-month` · `/entry/:id` | Meal planning | tenant |
| GET · PUT | `/api/meals/calendar-settings` | Meal→calendar settings | tenant / admin |
| GET · POST · PATCH · DELETE | `/api/meals[/:id]` · `/:id/recipes[/:recipeId]` · `/recipes/order` | Meal Builder plates + their dishes (role, cook, order) | tenant · `meals` |
| POST · DELETE | `/api/meals/:id/schedule` · `/:id/add-to-list` | Schedule a plate to a slot · put its shopping on (or take it off) the grocery list | tenant · `meals` (+ `lists`) |

### Lists & pantry

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · POST · PATCH · DELETE | `/api/lists[/:id]` · `/api/list-items/:id` | Lists & items | module(lists) tenant |
| GET · POST | `/api/lists/templates[/:id]` · `/:id/save-as-template` · `/:id/apply` | List templates | module(lists) tenant |
| GET · POST | `/api/lists/grocery` · `/board` · `/rebuild` · `/from-recipe/:id` · `/items` | Grocery board | module(lists) tenant |
| GET · POST · DELETE | `/api/pantry-staples[/:id]` | Pantry staples | module(lists) tenant |
| GET · POST · PATCH · DELETE | `/api/pantry[/:id]` · `/scan` · `/consume` · PUT `/config` | Pantry inventory | tenant |
| GET | `/api/pantry/lookup/:barcode` · `/cookable` · `/for-recipe/:id` · `/:id/recipes` | Barcode & recipe lookups | tenant |

### Rhythms — `module(rhythms)`

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · POST | `/api/rhythms` | List (with current-period state) / create | module(rhythms) tenant |
| PATCH · DELETE | `/api/rhythms/:id` | Edit the safe-to-change fields / retire (soft) | module(rhythms) tenant |
| GET | `/api/rhythms/attention?to=&from=` | What needs attention by a horizon (`to` required, `YYYY-MM-DD`) | module(rhythms) tenant |
| POST | `/api/rhythms/:id/complete` · `/skip` | Mark done / skip one period | module(rhythms) tenant |
| POST | `/api/rhythms/:id/schedule` | Book a period into a real calendar event | module(rhythms) tenant |
| GET | `/api/rhythms/:id/completions` | Completion history | module(rhythms) tenant |

`PATCH` covers `title`, `emoji`, `notes`, `personId`, `every`, `leadTime`, `bookWithin`
and `isActive` only — **not** `satisfiedBy`, `startsOn`, `autoSchedule` or `rrule`.
Re-anchoring a live rhythm would re-interpret the periods it has already skipped and point
its bookings at periods that no longer exist. `leadTime` is clamped on create and on every edit, to a ceiling that differs by shape: the
**whole** of `every` on a scheduling rhythm, **half** of it on a completion one, and
`bookWithin` wherever a booking window is set. Only the completion shape needs halving —
its attention feed has no upper bound (an overdue thing can still be done and should keep
asking), so a runway as long as its cycle would surface it the instant it was completed and
never let it go quiet. A scheduling rhythm's feed closes when its window does, so a
full-cycle runway opens on the period's first day and shuts on its last.

`bookWithin` (scheduling shape only) is the **booking window**: how much of each period a
booking counts in, measured from the period's start. Null, the default and what every
rhythm predating it carries, means the whole period. The period still owns the grid and
`rhythm_skips`' keys; the window decides satisfaction, when the runway opens, and what
`POST /:id/schedule` accepts for a claimed `periodStart`. It must be at least a day and no
longer than `every`, and it is **refused alongside `autoSchedule`** — the rule already
decides which day inside the period, and allowing both lets the rule generate its
occurrence outside the window, leaving every period unsatisfiable. Unlike the cadence and
the anchor it is editable in place: it moves no boundary and re-keys no skip.

`GET /api/rhythms` returns `currentWindowEnd` beside `currentPeriodEnd`, and the
`unscheduled` rows of `/attention` return `windowEnd` beside `periodEnd`. They differ only
when a window is set: the period end is where the **next** period starts (what the grid and
skips are keyed against), while the window end is the last moment a booking still settles
this one.

A rhythm with `autoSchedule` is refused at create if its `rrule` **skips a period** —
checked by walking the rule across the first twelve periods. `starts_on` anchors the grid
*and* seeds the series, and for a rule like `FREQ=MONTHLY;BYDAY=3SA` those disagree: third
Saturdays fall between the 15th and the 21st, so periods anchored on the 19th leave some
months with two occurrences and others with none. A period with none can never be satisfied.
Only emptiness is refused; a rule firing more than once a period over-books but always
settles it.

`POST`/`PATCH /api/events` accept `rhythmId`, which is how an event created any other way
settles a period. An **absent** `rhythm_id` always means "leave it alone" (so a client that
predates the column cannot blank a link by omission), which makes an explicit `null` the
only way to unlink.

### Family Night — `module(familyNight)`

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · PUT | `/api/family-night` · `/config` | Current night / config | tenant / admin |
| POST · DELETE | `/api/family-night/occurrence` · `/schedule` | Occurrence / schedule | tenant / admin |

### Weekly Planning — `module(weeklyPlanning)`

The session itself:

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/weekly-planning` | The week (`?weekStart=`), its session if one exists, config and steps | module(weeklyPlanning) tenant |
| GET | `/api/weekly-planning/config` | Config, the step catalog, and the lists step 1 can ask about | module(weeklyPlanning) tenant |
| PUT | `/api/weekly-planning/config` | Update config | module(weeklyPlanning) admin (`dayOfWeek`, `time`, `showOnToday`, `steps`) · cap:planning.manage (`lists`) |
| POST | `/api/weekly-planning/session` | Start the week's session (returns the existing one if it's already started) | module(weeklyPlanning) tenant |
| PATCH · DELETE | `/api/weekly-planning/session/:id` | Move to a step / set status · discard the session | module(weeklyPlanning) tenant |
| POST | `/api/weekly-planning/session/:id/step` | Mark a step `pending`, `done` or `skipped` | module(weeklyPlanning) tenant |
| POST | `/api/weekly-planning/session/:id/complete` | Save the week | module(weeklyPlanning) tenant |

Each step's own reads and writes:

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/weekly-planning/loose-ends` | Step 1: what's still open, where each item can go, what's been routed | module(weeklyPlanning) tenant |
| POST | `/api/weekly-planning/loose-ends/route` · `/resolve` · `/parked` | Send an item to a step / mark it done or drop a parked note / park a new note | module(weeklyPlanning) tenant |
| PATCH | `/api/weekly-planning/loose-ends/parked/:id` | Fix a parked note's text or tag | module(weeklyPlanning) tenant |
| GET | `/api/weekly-planning/horizon` | Step 3: the tags the park bar offers and what this session parked | module(weeklyPlanning) tenant |
| GET | `/api/weekly-planning/familyNight` | Step 4: the week's family night and its parts | module(weeklyPlanning) + module(familyNight) tenant |
| GET | `/api/weekly-planning/connection` · `/connection/slots` | Step 5: pairs ranked by time since one-on-one / free slots for people you pick | module(weeklyPlanning) tenant |
| PUT | `/api/weekly-planning/connection/links` | Link a pairing to an existing event | module(weeklyPlanning) tenant |
| GET · PUT | `/api/weekly-planning/goals` · `/goals/focus` | Step 6: goals by list / set a list's focus for the week | module(weeklyPlanning) + module(goals) tenant |
| GET · POST | `/api/weekly-planning/meals` · `/meals/fill` · `/meals/undo` | Step 7: the week's meals / fill only the empty dinners / undo that fill | module(weeklyPlanning) + module(meals) tenant |
| PUT | `/api/weekly-planning/meals/shopper` | Set the week's shopping trip (a one-off chore) | module(weeklyPlanning) + module(meals) + module(chores) tenant · cap:chore.manage to assign someone else |
| GET | `/api/weekly-planning/tasks` | Step 8: chores by member, plus the unclaimed ones | module(weeklyPlanning) + module(chores) tenant |
| GET | `/api/weekly-planning/kids` | Step 9: a card per kid with their week and options | module(weeklyPlanning) tenant |
| PUT · POST | `/api/weekly-planning/kids/answer` · `/kids/repeat` | Answer a kid's card / copy last week's answers forward | module(weeklyPlanning) tenant |
| GET | `/api/weekly-planning/recap` | Step 10: the week the session decided | module(weeklyPlanning) tenant |

`PUT /config` checks each field against its own gate, and a body that mixes admin fields with
`lists` is refused whole if the caller lacks either. Step 2 (Calendar) has no routes: it reads
and writes the real calendar through `/api/events`. The steps' writes land in the modules that
own the data — family-night changes, event creation and chore hand-outs go through those
modules' own endpoints — so discarding a session removes only the session record.

### Photos, media, capture, weather

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · POST · PATCH · DELETE | `/api/photos[/:id]` | Photos & memories | tenant |
| POST | `/api/media` | Blob upload sink | tenant |
| POST | `/api/capture` · `/capture/warm` | Parse free text / warm the LLM | tenant |
| GET · PUT | `/api/capture/config` | Capture provider config | admin |
| GET | `/api/weather` | Kiosk weather | tenant |

### Kiosk & devices

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/kiosk/pairing-code` · `/promote` | Mint code / promote device | admin |
| POST | `/api/kiosk/pair` · `/device/token` | Claim code / exchange secret | public |
| GET | `/api/kiosk/profiles` · `/display` | Profile picker / display settings | device |
| POST | `/api/kiosk/profile/:personId` · `/heartbeat` | Claim a profile / heartbeat | device |
| GET · PATCH · DELETE | `/api/kiosk/devices[/:id]` · PUT `/display` | Manage devices / display | admin |
| PUT · DELETE | `/api/persons/:id/pin` | Set/remove a kiosk PIN | tenant (self or admin) |

### Waffled-Bites — `module(waffledBites)`

The parent side, from a signed-in session:

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/persons/:id/waffled-bite/pairing-code` | Mint a pairing code for a kid's Bite (valid 10 minutes) | module(waffledBites) admin |
| GET | `/api/persons/:id/waffled-bite` | The member's paired Bite: settings, quiet/timer/wake-light state, last seen | module(waffledBites) tenant |
| PATCH | `/api/waffled-bites/:id/settings` | Update a Bite's settings (merged into what's stored) | module(waffledBites) admin |
| POST | `/api/waffled-bites/:id/quiet/start` · `/pause` · `/resume` · `/add-time` · `/end` | Run quiet time | module(waffledBites) tenant |
| POST | `/api/waffled-bites/:id/timer/start` · `/pause` · `/resume` · `/add-time` · `/end` | Run a timer | module(waffledBites) tenant |
| POST | `/api/waffled-bites/:id/nudge` | Send a message, shown on the device's next poll | module(waffledBites) tenant |
| DELETE | `/api/waffled-bites/:id` | Unpair (revoke) a Bite | module(waffledBites) admin |

The device side:

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/waffled-bites/pair` · `/device/token` | Claim a pairing code / exchange the device secret for a short-lived token | public |
| GET | `/api/waffled-bites/device/state` | The poll: the kid, their stars, today's routines by time of day, settings, quiet/timer/wake-light state, and any pending nudge (handed over once) | bite |
| POST | `/api/waffled-bites/device/tasks/:instanceId/complete` · `/uncomplete` | Tick or untick one of the kid's own chores | bite |
| PATCH | `/api/waffled-bites/device/settings` | The on-device grown-up controls — `sound` and `night` only | bite |
| POST | `/api/waffled-bites/device/timer/start` · `/end` | The kid starts or ends their own timer | bite |
| POST | `/api/waffled-bites/device/unpair` | "Forget this device" — the Bite revokes itself | bite |

Pairing follows the kiosk's shape: `/pair` returns the device secret once, and the device trades
it at `/device/token` for a token each time it needs one. The device routes authenticate on
that token alone. A kid can have one paired Bite at a
time; pairing a second returns 409. The device can start and end a timer but not pause it, add
time, or touch quiet time — those stay with the parent routes.

### Layout, sync, health, updates

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET · PUT · DELETE | `/api/today-layout` · `/today-layout/mobile` | Today card layout (web / mobile) | tenant |
| GET | `/api/auth/keys` | JWKS (PowerSync token validation) | public |
| GET · POST | `/api/powersync/token` · `/powersync/crud` | Sync token / offline write sink | tenant |
| GET | `/api/health` | Deep per-component health | admin |
| GET · PUT | `/api/updates` · `/updates/settings` | Update check / toggle | admin |

---

For the concepts behind the guards, see [Permissions & roles](/concepts/permissions/); for the
module gates, [Modules](/administration/modules/). To build against this API, mint an
[API key](#api-keys) and check the scope table above.
