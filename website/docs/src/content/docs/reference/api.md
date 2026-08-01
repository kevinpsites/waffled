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

Every non-public request is authenticated at a single global gate. There are three ways in:

1. **Bearer JWT (default).** `Authorization: Bearer <token>` — how the web and iOS clients
   authenticate. The token carries a `household_id` claim; the api resolves it to a person +
   household (`sub → identity → person → household`) and re-checks per route. Get one from the
   login flow, or `./waffled token` for a dev token.
2. **API key.** `x-api-key: waffled_…` — for external tools and scripts. See below.
3. **Kiosk device token.** A paired tablet exchanges a device secret for a short-lived device
   token; tapping a profile mints a real person session. See [Kiosk & devices](/administration/kiosk/).

**Public endpoints** (no auth): `/healthz`, `/api/auth/keys` (JWKS), the auth
status/setup/login/refresh/logout and OIDC start/callback/exchange routes, `/api/kiosk/pair`,
`/api/kiosk/device/token`, and the Google calendar OAuth callback.

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
are **scope-limited**: a scope is `<resource>:<read|write>`, and only these resource families are
reachable with a key — `household`, `persons`/`family` (read), `lists`, `pantry`, `chores`,
`rewards`/`redemptions`/`balances`/`currencies`, `recipes`/`meals`, `events`, `goals`, `photos`,
`weather` (read). Everything else (auth, kiosk, permissions, api-keys, powersync, capture, media,
countdowns, family-night, goal-calendar, Google calendar) always 403s for a key. In-route
capability checks still apply on top of the scope.

---

## Endpoint reference

Auth column: **tenant** = any signed-in member · **admin** = admin/owner · **cap:X** = requires
capability X · **module(X)** = requires module X enabled · **device** = kiosk device token ·
**public** = no auth.

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
| POST | `/api/calendar/google/connect` · GET `/status` · PATCH `/calendars/:id` · DELETE `/accounts/:id` | Google connect / status / config / disconnect | admin |
| GET | `/auth/google/calendar/callback` | Google OAuth callback | public |
| POST | `/api/calendar/sync` | Trigger inbound sync | tenant |

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
| POST | `/api/rewards/:id/redeem` | Redeem a reward | tenant |
| POST | `/api/persons/:id/award` | Spot-award currency | cap:reward.grant |
| POST | `/api/redemptions/:id/approve` · `/deny` | Approve / deny a redemption | cap:reward.approve |
| POST | `/api/redemptions/:id/cancel` | Cancel a pending redemption | requester or cap:reward.approve |
| POST | `/api/redemptions/:id/refund` | Refund an approved redemption | cap:reward.correct |
| POST | `/api/ledger-entries/:id/correct` | Append a reversal / corrected replacement | cap:reward.correct |
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
