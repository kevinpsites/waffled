# Fork evaluation — `dispencer17/waffled`

Assessment of the downstream personal fork at
[dispencer17/waffled](https://github.com/dispencer17/waffled), written while porting
three of its features upstream (Outlook/M365 sync, ICS feeds, Share list).

- **Merge base:** `e7552a3d` (upstream PR #127)
- **Divergence at time of review:** fork is **50 commits ahead**, upstream **29 ahead**
- **Fork last pushed:** 2026-08-08 · **reviewed:** 2026-08-11
- **Shape:** 216 files, ~16.7k insertions
- **Surfaces touched:** web + api + infra + docs. **Zero iOS changes** — every fork
  feature is web/kiosk-only, so none of it had mobile parity. (The three features we
  ported have since gained it on our side — see the iOS parity note under
  [ICS feeds](#ics-feeds--the-most-self-contained-of-the-three).)

## 1. Verdict on quality

The fork is unusually good for a personal fork, and it is safe to take code from.

- It follows our own conventions unprompted: TDD (each feature ships integration
  tests), Keep-a-Changelog entries, Starlight docs pages, `-- Up Migration` first
  lines, module gating via `moduleRoutes()`, secrets encrypted through
  `platform/crypto.ts`, comments that explain *why*.
- Migrations are deliberately numbered from **0100** so they can never collide with
  upstream's next numbers (we're at 0090). That is thoughtful fork hygiene and it
  makes porting materially easier.
- The abstractions are conservative. The calendar provider refactor wraps Google in
  a pass-through adapter and leaves `integrations/google.ts` **completely untouched**,
  explicitly to minimise upstream drift.

The main caveat is scope: the fork also carries a large, opinionated rework of the
Today dashboard that is *not* mentioned in its README and that would be a much
bigger merge than the calendar work.

## 2. What their README claims vs. what the code does

| README claim | Reality |
|---|---|
| "an always-listening wake word is **deferred** — openWakeWord spike queued" | **Stale — it shipped.** `openwakeword.ts` (+ tests) is implemented, plus a Porcupine path. 4.6 MB of model binaries are committed to `apps/web/public/models/` (three ONNX files + `porcupine_params.pv`). Commits `3aa224e9` and `b6acfdf2` graduate it from "spike" to "experimental implementation". |
| "the Walmart affiliate path was abandoned; its cart-matching code remains behind the same button but is unused without credentials" | **Accurate**, and worth knowing: the *entire* `apps/api/src/modules/shopping/` module (routes + service + types), `integrations/walmart.ts`, and migration `0101_walmart_matches.sql` are Walmart-only dead weight. The Share-list feature they actually use is ~45 lines of pure client-side formatting. |
| Everything else in the README | Accurate as described. |

## 3. What they added that the README does not mention

This is the bigger finding — roughly half the diff is unlisted.

**Substantial, opinionated (would be a large merge):**

- **FancyZones-style Today board (v2 layout model).** `today-layout.ts` (+349) plus new
  `zone-layout.ts`, `today-presets.ts`, `today-card-slot.tsx`. A zone-tree layout with
  legacy migration, live drag/resize with auto-save, layout presets, density modes,
  hide-empty-cards, per-card "quiet" settings (e.g. `maxItems`), and a full-width band.
  **This changes a shared API contract** (`/api/today-layout`) and is the single item I
  would think hardest about before adopting.
- **Week calendar card** on the Today board, with a people filter, in-progress pulse,
  and a "Separated days" option.
- **Custom member colors + household "Event style" setting** — per-person hex with
  server-side validation (`persons.ts` +72), family color for whole-family events,
  fully-tinted event chips. **Ported in full (web + iPhone/iPad).** We took the custom
  swatch + `HEX_COLOR` validation, the family color, and the `eventStyle` display setting,
  and made **solid the default**; we deliberately left their color *themes* / Appearance
  theme set behind.
- **Rewards card** on the Today dashboard.
- **Recipe editor rework** (+227/-…), clearer add-recipe flow in Meals.

**Infrastructure / ops:**

- **Per-request PowerSync URL derivation** (`2d08c2c0`) — see §5, this is a real bug fix.
- **Home Assistant compose profile** — opt-in `--profile homeassistant`, so a household
  with no HA can start one on the same box.
- **`tools/server-move/`** — PowerShell kit to migrate a Waffled server to a new Windows
  box, plus `update.ps1` (a fork-specific "update button" that rebuilds from source).
- **PWA/service-worker work**, `.well-known/assetlinks.json`, manifest changes.
- **Fork-aware versioning** — `v0.8.0-<n>-g<sha>` surfaced in About/System Health, and
  an update notifier that knows a fork merges upstream instead of running `./waffled upgrade`.
- **Event `endsAt` validation** in `events.ts` — rejects `endsAt <= startsAt` on POST and
  PATCH. Small, obviously correct, and we don't have it.

## 4. The first three features ported upstream — Outlook/M365, ICS feeds, Share list

These shipped in **PR #149** (server + web), with iPhone/iPad parity in **PR #151**. Kept
here as the record of what each actually cost:

### Outlook / Microsoft 365 sync — *medium, well-built*

A `CalendarProviderAdapter` interface with Google and Microsoft implementations, plus
`integrations/microsoft.ts` (Graph). Correctly handles the two things that make Graph
different from Google:

- **Refresh tokens rotate** on every exchange, so the sync engine re-encrypts and
  persists the replacement (`rotatingRefreshTokens` flag on the adapter).
- **Incremental sync is `/calendarView/delta`**, the cursor is the full `@odata.deltaLink`
  URL, deletions arrive as `@removed` tombstones, and a stale cursor is HTTP 410 — mapped
  onto the same `SyncTokenInvalidError` contract Google already used.
- Response times are pinned to UTC via a `Prefer: outlook.timezone="UTC"` header.

Schema change is purely additive: a `provider` column on `calendar_accounts`,
`calendars`, and `calendar_oauth_states`, defaulting to `'google'` so existing rows keep
working. The `google_*` column names are deliberately kept and re-read as "provider
external id" rather than renamed — the right call, renaming would churn every query.

> **Cannot be end-to-end verified here.** It needs an Azure app registration
> (`MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_CALENDAR_REDIRECT_URI`). The port ships with
> their integration tests, which stub Graph, so the logic is covered — but a live
> Outlook connect has not been exercised.

### ICS feeds — *the most self-contained of the three*

Read-only subscriptions to any published ICS URL. Independent of the provider refactor:
its own small `ics_feeds` table, no OAuth, no write-back, no tokens.

Design worth keeping: feed events live in `events` with `origin='ics'`, `calendar_id
NULL`, `origin_ref_id` = feed id, `google_event_id` = the VEVENT UID. Because Postgres
treats NULLs as distinct, the existing `(calendar_id, google_event_id)` unique index
cannot arbitrate these rows, so they add a partial unique index on
`(origin_ref_id, google_event_id) WHERE origin='ics'` as the `ON CONFLICT` target. That
is exactly the right fix and it is commented as such.

Recurring VEVENTs become Waffled-native masters (`rrule`/`exdate`) and go through the
existing expansion engine. Timezone handling is careful — four distinct cases including
the "bare TZID with no VTIMEZONE" that Google-published feeds emit.

**Known limitation (theirs, carried over):** `RECURRENCE-ID` exception VEVENTs — a single
moved or edited occurrence — are skipped. The base rule renders correctly; per-occurrence
edits from the feed are not applied.

**Fixed on the way in (the fork does not do this):** the fork leaves feed events fully
editable. Nothing is pushed anywhere, so an edit looks like it worked and is then restamped
by the next 15-minute poll — and because the upsert sets `deleted_at = null`, a deleted feed
event comes back. This port makes them read-only at the API (`409 ReadOnlyEvent` on
`/api/events` PATCH/DELETE, and a silent drop on the `/api/powersync/crud` offline path,
since PowerSync retries a failed transaction forever and an error would wedge the device's
upload queue). Enforcing server-side rather than only in the UI matters because sync rules
replicate `events` to iOS with no origin filter, and each client reaches events by a
different route.

**Update (iOS parity, 2026-08-11):** all three ported features now have iPhone/iPad
counterparts — Outlook connect, full ICS feed management, and Share list — and the apps
gate their own Edit/Delete on the event's origin rather than relying on the server's
refusal. Auditing those write paths also turned up a third one the read-only rule never
reached: quick-add's `reschedule`/`delete` verbs call `updateEvent`/`softDeleteEvent`
directly, bypassing the `/api/events` guard, so "move the dentist appointment to Friday"
rewrote a feed-owned row on **web too**. Fixed in the same PR.

**Security note:** the feed URL is admin-supplied and fetched server-side, which is an
SSRF surface (an admin could point a feed at an internal address and read the error).
It is admin-only and the response body is not returned to the caller, so the exposure is
limited to error-message oracles — but it is worth a follow-up allowlist/deny-private-IP
pass if we ever widen who can add feeds.

### Share list — *nearly free*

Purely client-side: `share-list.ts` is a 45-line pure formatter (unchecked items →
aisle-grouped plain text in the board's walking order) with a thorough unit test, plus a
modal offering copy / `navigator.share` / QR. The QR encodes the *text itself*, so a
phone camera grabs the list with no app and no account.

The port **drops the Walmart path entirely** — no `modules/shopping/`, no
`integrations/walmart.ts`, no `0101_walmart_matches.sql`, no `/api/shopping/*` routes,
no status probe. The button is unconditionally "Share list". Only new dependency is
`qrcode`.

## 5. Things we should take regardless

Ranked by value-to-effort. **All three have since shipped** — see §7.

1. **Per-request PowerSync URL derivation** (`2d08c2c0`). Every client was handed
   `POWERSYNC_PUBLIC_URL`, which compose defaults to `http://localhost:8090` — only
   reachable on the server itself. Kiosk tablets and phones resolved `localhost` to
   themselves, never opened a sync stream, and silently degraded to REST-only. Their fix
   derives the URL from the host each device actually used (honouring
   `x-forwarded-proto`/`host`) and applies `POWERSYNC_PORT`; an explicit
   `POWERSYNC_PUBLIC_URL` still wins. This removes a documented footgun of ours and is
   worth taking on its own.
2. **`endsAt` validation on events** — a few lines, obviously correct.
3. **Sync watchdog** — see §6.

## 6. The three features to understand (not ported)

### Smart Home (Home Assistant)

Clean, and the security model is the good part:

- Waffled **proxies every call**; the HA long-lived token never reaches a browser and is
  encrypted at rest via `platform/crypto.ts` (the same path as Google refresh tokens).
- An **entity allowlist is a real guardrail**, not UI sugar — quick controls and voice can
  only touch entities an admin explicitly pinned in Settings. Entity ids are regex-validated
  (`domain.object_id`), as are service/domain names.
- Config lives in `households.settings.homeAssistant`; `integrations/home-assistant.ts` is
  fetch-thin (info / states / call-service) so tests can point `baseUrl` at an in-process stub.
- Surfaces as a `QuickControls` card on the Today board, gated behind a `smartHome` module toggle.

**Dependency to note:** voice depends on smart home — `voice.service.ts` imports
`homeassistant.service.ts`. Taking voice means taking HA.

### Kiosk voice (push-to-talk)

- **STT** is provider-chained: an explicit `WHISPER_BASE_URL` (self-hosted faster-whisper
  via a compose `voice` profile) wins; else OpenAI `whisper-1` when `OPENAI_API_KEY` is set;
  else the voice routes 501. Any OpenAI-audio-compatible server works.
- **Intent classification** goes through the household LLM (`completeJson` with a JSON
  schema) and falls back to regex heuristics when the provider is `heuristic` or the LLM
  call throws. Five intents: `timer`, `grocery`, `smarthome`, `question`, `other`.
- Simple intents execute server-side; **anything unrecognised bounces back as `capture`**
  so the existing capture bar handles it with its visual preview + commit. That reuse is
  the smartest part of the design — voice doesn't reimplement mutation.
- Smart-home commands resolve **only against pinned entities**.
- Client side: `recorder.ts`, `tts.ts`, a `VoiceHud` component, and a `Timers` card.
- **Wake word shipped despite the README** — openWakeWord ("hey jarvis") in-browser behind
  a flag, plus a Porcupine path. Costs 4.6 MB of committed binaries and adds
  `onnxruntime-web` + two `@picovoice/*` packages. If we ever adopt voice, I'd take
  push-to-talk and leave the wake word (and its binaries) behind, at least initially.

### Sync watchdog (web)

Prompted by a real incident (2026-07-20): the PowerSync web client stopped opening sync
streams after a large server-side delete batch — no error, no reconnect, an empty replica
rendering as an empty calendar.

`sync-health.ts` is deliberately db-agnostic (`db.ts` injects the restart hooks) so all the
logic is plain and testable — 318 lines of tests. It:

- tracks the engine's status stream into a `useSyncExternalStore` snapshot;
- flags a **stall** — online + signed in but not connected+synced for 3 minutes;
- **auto-restarts** with a soft disconnect/connect, escalating to a hard client rebuild,
  with doubling backoff (2m → 16m cap) so a persistent outage self-heals without hammering;
- exposes **`isReplicaTrusted()`**, which is the genuinely valuable idea: when the replica
  is wedged or incomplete, the data hooks let REST drive, so a wedged replica never blanks
  the UI;
- distinguishes `starting` (WASM/OPFS boot takes seconds) and `failed` (with the error) from
  `off`, because users were reading the boot window as "sync is off".

This was the fork change I most wanted upstream after the calendar work — self-contained,
and it fixed a failure mode we had no defence against. **Ported in PR #156.**

## 7. Sequencing — where we actually got to

**Shipped:**

1. **Outlook/M365, ICS feeds, Share list** — PR #149 (server + web), PR #151 (iPhone/iPad).
2. **Per-request PowerSync URL derive** and **`endsAt` validation** — PRs #154 / #155.
3. **The sync watchdog + `isReplicaTrusted()` fallback** — PR #156, plus three
   recipe-editor bug fixes that came out of the same review pass.
4. **Calendar color control** — custom hex swatch, family color, and the `eventStyle`
   setting with **solid** as the default: PR #157 (server + web), and iPhone/iPad parity
   in the PR that follows it.

**Still open:**

5. **Deliberate decision needed:** the Today board v2 zone layout. It's a real improvement
   but it's a contract change and a big merge; it also has no iOS counterpart, which would
   widen the web/mobile gap.
6. **Not taken:** their color *themes* / Appearance theme set — we shipped our own dark
   mode instead, and the `eventStyle` work above covers the calendar half of it.
7. **Probably skip:** Walmart matching (dead), Android TWA (explicitly not wanted), the
   PowerShell server-move kit and `update.ps1` (fork-specific workflow), wake-word binaries.
8. **Understood but not ported** (see §6): Smart Home / Home Assistant and kiosk voice.

## 8. Note for whoever merges upstream into the fork later

The ported migrations are **renumbered** into upstream's sequence — `0093_calendar_provider.sql`
and `0094_ics_feeds.sql` — rather than keeping the fork's `0100`/`0102`. `apps/api/CLAUDE.md`
says to take the next free number, and a 0091–0099 gap in upstream would be a wart for every
self-hoster to serve one downstream fork. (They started at 0091/0092 and were renumbered again
after merging `main`, which landed the meal-builder's 0091/0092 in the meantime — exactly the
"renumber yours" case `apps/api/CLAUDE.md` calls out.)

That does mean the fork will end up carrying **two** migrations for each feature (its `0100`
and upstream's `0093`). To keep that harmless, both ported migrations are written
**idempotently** — `add column if not exists`, `create table if not exists`,
`create index if not exists`, and a `pg_constraint` guard around the uniqueness constraint —
so applying the second one after the first is a no-op instead of an error. Resolve the merge
by keeping both files; neither will break a database that already ran the other.

`0101_walmart_matches.sql` is deliberately **not** ported (Walmart matching is dropped
entirely), so nothing depends on that number.
